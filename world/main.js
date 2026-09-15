// The world — ocean, grass island and day-night sky composed into one scene.
// The sky is always on; the FFT ocean and the island are layers you can turn
// on and off. Each subsystem keeps its own config module; this file owns only
// the composition: the island terrain the grass tile is pinned to, the light
// bridging that keeps the grass rig (authored for ACES @ 2.0) correct
// under the atmosphere's exposure, and the layer toggles.

import * as THREE from 'three/webgpu';
import { positionWorldDirection, uniform, Fn, vec3, mix, dot, max, pow, smoothstep } from 'three/tsl';
import { OrbitControls } from '../vendor/OrbitControls.js';
import GUI from 'lil-gui';

import { config as oceanCfg } from '../ocean/config.js';
import { makeBreakerFoam } from '../ocean/breaker-foam.js';
import { OceanSim } from '../ocean/sim.js';
import { makeOceanSurface } from '../ocean/surface.js';
import { makeAtmosphere } from '../sky/atmosphere.js';

import { config as grassCfg, COUNT, TILE_SIZE } from '../grass/config.js';
import { WindDirector, makeGustTexture } from '../grass/wind.js';
import { GrassSystem } from '../grass/blades.js';
import { makeBladeGeometry, makeBladeMaterial } from '../grass/material.js';

import { world } from './config.js';
import { makeIslandTerrain, makeIslandMesh, makeTerrainShadow } from './island.js';
import { makeShore } from './shore.js';
import { makePalms } from './trees.js';
import { makeGrove, makeDriftingLeaves } from './grove.js';
import { makeFlowers } from './flowers.js';
import { makeVilla } from './villa.js';
import { makeIndoors } from './indoors.js';
import { makeGulls } from './birds.js';
import { makeCalmSea } from './water.js';
import { makeViewpoint } from './viewpoint.js';
import { makeDna } from './actor/dna.js';
import { configure as configureClay } from './actor/materials.js';
import { buildCharacter, updateCharacter, play, cheer } from './actor/character.js';

const hud = document.getElementById( 'hud' );
const bootEl = document.getElementById( 'boot' );
const bootStage = document.getElementById( 'boot-stage' );
const bootBar = document.querySelector( '#boot-bar i' );
const promptEl = document.getElementById( 'prompt' );
let promptText = '';

function showOverlay( title, message ) {

	const el = document.getElementById( 'overlay' );
	el.innerHTML = `<h1>${ title }</h1><p>${ message }</p>`;
	el.style.display = 'grid';
	bootEl.style.display = 'none';

}

init().catch( ( err ) => {

	console.error( err );
	showOverlay( 'World failed to start', err.message );

} );

async function init() {

	if ( ! navigator.gpu ) {

		throw new Error( 'This scene needs WebGPU. Use Chrome / Edge 113+, or Safari 18+ with WebGPU enabled.' );

	}

	// the grass modules read their config at construction — shape it for the
	// landmass before anything is built
	const landCfg = world.land;
	grassCfg.terrain.worldScale = landCfg.worldScale;              // blades sample the terrain map
	grassCfg.terrain.heightMax = landCfg.heightSpan;               // R-channel decode range
	grassCfg.terrain.tileSize = world.grassOverrides.tileSize;     // wider field...
	grassCfg.terrain.bladesPerSide = world.grassOverrides.bladesPerSide;   // ...and the blades to fill it
	grassCfg.thinning.fullRadius = world.grassOverrides.fullRadius;
	grassCfg.thinning.falloffRadius = world.grassOverrides.falloffRadius;
	grassCfg.thinning.farDensity = world.grassOverrides.farDensity;
	grassCfg.player.jumpSpeed = world.grassOverrides.jumpSpeed;

	// keep the blades close to the turf greens so the tile edge doesn't read
	// as a different material at the transition
	grassCfg.color.warmStrength = 0.34;

	// the field's warm haze is tuned for a camera inside the grass; across a
	// 1.5 km landmass it would swallow the ridge line. Marine air: much
	// thinner, tinted by the light bridge instead of a fixed warm colour.
	grassCfg.lighting.fogDensity = 0.0007;

	const renderer = new THREE.WebGPURenderer( { antialias: true, trackTimestamp: true } );
	renderer.setPixelRatio( Math.min( window.devicePixelRatio, 1.5 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.toneMappingExposure = oceanCfg.atmosphere.exposure;   // tone curve set after init
	document.body.appendChild( renderer.domElement );

	await renderer.init();

	// ---- the scotopic toe.
	//
	// A moonlit world renders *correct* and looks dead, and the reason is the
	// bottom of the transfer function. sRGB's dark end is a straight line: a
	// surface at a thousandth of daylight comes out at a thousandth of the
	// display's range, which is one code value, which is black. The eye has no
	// such straight line — it re-adapts, and what it does to a night scene is
	// mostly *compression*: the darks come up a long way, the highlights barely
	// move, and colour drains out of both because the rods carry it.
	//
	// A power curve under one is that compression, and it is one line if it goes
	// where tone mapping already lives instead of into every land shader. `pow`
	// with a pivot leaves anything at 0.5 exactly where it was and lifts a
	// thousandth by four stops. It rides *in front of* three's ACES rather than
	// replacing it, because ACES is what the whole project's daylight is graded
	// against and this must not touch daylight at all — hence the gate below,
	// which only opens once the sun is properly down, well past the sunset the
	// sky module is tuned for.
	//
	// The second half of it is colour. Lifting the darks and leaving them the
	// hue they had gives a beach that reads as an overcast afternoon, because a
	// grey-green world at low level is exactly what an overcast afternoon is.
	// Rods carry no colour, and below about a hundredth of daylight they carry
	// most of the signal — so the dim end of a night frame drains toward a
	// blue-grey while anything bright enough to still work the cones keeps its
	// hue. That level dependence is the whole point: apply it flat and the
	// stars, the moon and the galaxy go grey with the sand.
	const nightToe = uniform( 0 );
	const TOE = 0.80, PIVOT = 0.5;
	const ROD_TINT = /*@__PURE__*/ vec3( 0.74, 0.92, 1.32 );   // where the rods put a grey
	const acesFn = renderer.library.getToneMappingFunction( THREE.ACESFilmicToneMapping );
	renderer.library.addToneMapping(
		Fn( ( [ color, exposure ] ) => {

			const c = mix( color, pow( max( color, 1e-5 ), TOE ).mul( Math.pow( PIVOT, 1 - TOE ) ), nightToe ).toVar();
			const lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ).toVar();
			const rod = nightToe.mul( smoothstep( 0.26, 0.015, lum ) ).mul( 0.62 );
			return acesFn( mix( c, lum.mul( ROD_TINT ), rod ), exposure );

		} ),
		THREE.CustomToneMapping );
	renderer.toneMapping = THREE.CustomToneMapping;

	const device = renderer.backend.device;
	const hasFirstInstance = !! ( device && device.features.has( 'indirect-first-instance' ) );
	const lodCount = hasFirstInstance ? 3 : 1;

	// ---- ocean simulation + FFT gate

	const sim = new OceanSim( oceanCfg );
	const gate = await sim.validateFFT( renderer );

	for ( const r of gate.results ) {

		console[ r.pass ? 'info' : 'error' ]( `[FFT gate] ${ r.name } — max error ${ r.maxErr.toExponential( 2 ) } — ${ r.pass ? 'PASS' : 'FAIL' }` );

	}

	if ( ! gate.pass ) throw new Error( 'FFT validation gate failed — refusing to start.' );

	sim.computeInitialSpectrum( renderer );

	// ---- sky (always on) — arrive twenty seconds before sunset

	oceanCfg.time.hour = 17.15;

	const scene = new THREE.Scene();

	const atmosphere = makeAtmosphere( oceanCfg );
	atmosphere.setTime( oceanCfg.time.hour );
	scene.backgroundNode = atmosphere.background( positionWorldDirection );

	const oceanSky = {
		sample: atmosphere.sample,
		inscatter: atmosphere.inscatter,
		distantSea: atmosphere.distantSea,
		aerial: atmosphere.aerial,
		sunDir: atmosphere.uniforms.sunDir,
		sunColor: atmosphere.uniforms.sunColor,
		bodyLight: uniform( 1 ),
		moonDir: atmosphere.uniforms.moonDir,
		// the moon's own colour, already faded by how high and how full it is and
		// by how much daylight is left — so the water shader is one multiply and
		// the day/night logic stays on the CPU with the rest of it
		moonLight: uniform( new THREE.Color( 0, 0, 0 ) ),
	};

	// ---- land + grass + palms (terrain first — the ocean samples its bake)

	// ---- boot progress.
	//
	// The world takes a few seconds to exist — a 1024² synthesis, 130 GPU
	// erosion iterations with a readback, a distance transform, three scatters
	// and a wood's worth of geometry — and a page that sits on one static line
	// for that long reads as broken rather than as busy. `stage` names what is
	// happening and times it; the timings go to the console, which is the only
	// honest way to know where a boot budget actually goes.
	const boot = performance.now();
	let stageT = boot, stageName = 'startup';
	const timings = [];

	// What each stage roughly costs, in milliseconds, measured on this machine.
	// A bar driven by *stage count* is worse than none: the wood alone is longer
	// than the fourteen stages before it, so an even bar would crawl to 90% and
	// then sit there for a second and a half — which is exactly the "is it
	// hung?" the bar exists to answer. These only have to be approximately
	// right, and a stage missing from the table just gets the default.
	const COST = {
		'baking the landmass': 5, synthesis: 550, eroding: 200, packing: 120,
		fields: 105, 'shore distance': 72, 'sand detail': 50, 'palm scatter': 23,
		'woodland scatter': 17, homestead: 7, 'terrain shadows': 10,
		'terrain mesh': 42, 'ocean surface': 46, coast: 30, palms: 66, grass: 92,
		gulls: 9, cast: 38, 'first frame': 190,
		'planting the wood': 770, 'shedding leaves': 40, 'raising the house': 1070,
	};
	const TOTAL = Object.values( COST ).reduce( ( a, b ) => a + b, 0 );
	let done = 0;

	// `await stage(...)` rather than `stage(...)`: the whole boot is one long
	// synchronous run between awaits, so without a yield the browser never gets
	// a chance to paint and every progress line written here is overwritten
	// before it is ever seen. One rAF per stage costs a frame and is the whole
	// difference between a page that looks busy and one that looks hung.
	const stage = ( name ) => {

		const now = performance.now();
		timings.push( [ stageName, now - stageT ] );
		done += COST[ stageName ] || 20;
		stageT = now; stageName = name;
		bootStage.textContent = `${ name }…`;
		bootBar.style.width = `${ Math.min( 99, ( done / TOTAL ) * 100 ).toFixed( 1 ) }%`;
		return new Promise( ( r ) => requestAnimationFrame( r ) );

	};

	await stage( 'baking the landmass' );
	const terrain = await makeIslandTerrain( renderer, grassCfg, landCfg, world.trees, world.grove, world.homestead, stage );

	await stage( 'terrain shadows' );
	// ridges cast their own shadows; re-marched whenever the sun has moved
	const shadow = makeTerrainShadow( terrain, landCfg, atmosphere.uniforms.sunDir );
	shadow.update( renderer, true );

	// The waterline both the sea and the sand read. Built here, before either, so
	// there is exactly one of it — and on its own clock, because the ocean sim's
	// timer stops when the ocean layer is switched off and a wet band running on
	// a stopped clock is worse than no wet band at all.
	const shore = makeShore( terrain.detail );

	await stage( 'terrain mesh' );
	const islandGround = makeIslandMesh( terrain, atmosphere, grassCfg, landCfg, shadow, shore );
	scene.add( islandGround.mesh );

	// ---- water: FFT ocean or calm mirror sea

	await stage( 'ocean surface' );
	// The whitewater's memory, built before the surface that reads it. It is a
	// world-fixed field over the coast rather than anything the surface owns,
	// because foam outlives the wave that made it and a fragment shader cannot
	// remember anything.
	const breakerFoam = makeBreakerFoam( sim, oceanCfg, {
		shoreTex: terrain.heightTex,
		shoreScale: landCfg.worldScale,
		heightAt: terrain.heightAt,
	} );
	const surface = makeOceanSurface( sim, oceanSky, oceanCfg,
		{ shoreTex: terrain.heightTex, shoreScale: landCfg.worldScale, shore, breakerFoam } );
	scene.add( surface.mesh );

	const calm = makeCalmSea( atmosphere );
	scene.add( calm.mesh );

	const windDirector = new WindDirector( grassCfg );
	const gustTex = makeGustTexture();

	await stage( 'palms' );
	const trees = makePalms( terrain.palms, islandGround.uniforms, windDirector,
		atmosphere, shadow, landCfg.worldScale );
	scene.add( trees.mesh );

	// ---- the interior, built after the first frame is rendered but before the
	// boot screen comes down.
	//
	// The wood is 430 trees of CPU-grown geometry and the house is ~1 600 parts;
	// together they were 3.3 of the boot's 5.7 seconds — well over half of it
	// spent on the two things the opening shot cannot see. The shot is the beach
	// at golden hour, looking out to sea; the wood is over the ridge behind you
	// and the house is a kilometre inland.
	//
	// Building them last is still right — the renderer is already presenting, so
	// the opening shot's pipelines compile while this runs. What is *not* right
	// is letting the world be interactive while it happens: 1.6 s of main thread
	// goes into this, and a world that is on screen and does not answer the mouse
	// for a second and a half reads as a hang, not as a load. So it is inside the
	// boot screen and the world is handed over when it is genuinely finished.
	//
	// Everything downstream still has to tolerate their absence, which is three
	// guards and a build function — one the villa needed anyway, since it is
	// a self-contained subsystem that is allowed to fail on its own without
	// taking the world
	// down with it.
	let grove = null, drift = null, flowers = null, villa = null, indoors = null;

	async function buildInterior() {

		const t0 = performance.now();

		await stage( 'planting the wood' );
		grove = await makeGrove( terrain.grove, islandGround.uniforms, windDirector,
			atmosphere, shadow, landCfg.worldScale );
		scene.add( grove.group );

		// The leaves are shed from the crowns the tree builder just measured, so
		// this has to follow `makeGrove` — see grove.js.
		await stage( 'shedding leaves' );
		drift = makeDriftingLeaves( grove.crowns, world.grove.leavesPerTree,
			islandGround.uniforms, windDirector, atmosphere, terrain, shadow, landCfg.worldScale );
		scene.add( drift.mesh );

		// Flowers go in after the wood because they are placed *against* it: the
		// scatter reads the bake's grass density, which already carries the
		// canopy shade the trees stamped into it, so a patch never lands under a
		// crown.
		await stage( 'sowing flowers' );
		flowers = await makeFlowers( terrain, islandGround.uniforms, windDirector,
			atmosphere, shadow, landCfg.worldScale, world.flowers );
		scene.add( flowers.group );
		console.info( `[flowers] ${ flowers.count } in ${ flowers.patches } patches` );

		await stage( 'raising the house' );

		// The house is sited by the bake.
		// It is the one thing in the scene lit by three's own lights rather than
		// by hand in TSL, so it brings a sun and a fill of its own — see
		// villa.js. It is also the most self-contained subsystem in the scene,
		// so it is
		// allowed to fail on its own. A world with no house is a worse world; a
		// world that will not start is no world at all.
		if ( terrain.homestead ) {

			try {

				villa = makeVilla( terrain.homestead, atmosphere, world.homestead );
				scene.add( villa.group );
				scene.add( villa.lights );
				renderer.shadowMap.enabled = true;
				renderer.shadowMap.type = THREE.PCFSoftShadowMap;

				// The building as something to walk into rather than through. It
				// is derived from the model that was just built, so it goes here
				// and not a line earlier — see indoors.js.
				indoors = makeIndoors( villa );
				console.info( `[villa] ${ indoors.count } solids, ${ indoors.doors.length } doors` );

			} catch ( err ) {

				console.error( '[villa] failed to build — carrying on without it', err );
				villa = null;
				indoors = null;

			}

		}

		applyLayers();
		syncLights();
		console.info( `[boot] interior (wood + house) ${ ( performance.now() - t0 ).toFixed( 0 ) } ms` );

	}

	// the island is far larger than one grass tile, so the tile follows the
	// player exactly as in the standalone field; the island mesh turf carries
	// the green beyond blade range
	await stage( 'grass' );
	const system = new GrassSystem( terrain, windDirector, gustTex, lodCount );
	system.init( renderer );

	const bladeSky = {
		sunDir: atmosphere.uniforms.sunDir,
		moonDir: atmosphere.uniforms.moonDir,
		shadowTex: shadow.tex,
		terrainScale: landCfg.worldScale,
	};
	const { material: bladeMaterial, uniforms: mu, debugTintU } = makeBladeMaterial( system, bladeSky, lodCount );

	const tile = new THREE.Group();
	scene.add( tile );

	for ( let lod = 0; lod < lodCount; lod ++ ) {

		const geo = makeBladeGeometry( system.segments[ lod ], system.count );
		geo.setIndirect( system.indirect, lod * 5 * 4 );
		const mesh = new THREE.Mesh( geo, bladeMaterial );
		mesh.frustumCulled = false;
		tile.add( mesh );

	}

	// ---- player

	const player = {
		// the palm-grove beach on the south-west coast — chosen by scanning the
		// bake for a grass bank near the sand with open water toward the sunset
		pos: new THREE.Vector3( landCfg.spawn[ 0 ], 0, landCfg.spawn[ 1 ] ),
		vy: 0,
		grounded: true,
		// Swimming is a *state*, not a test run per frame, because the two
		// conditions that start and end it are different: you start swimming when
		// the bed drops away under you, and you stop when it comes back up under
		// your feet. Testing one depth both ways puts the figure in a loop at the
		// exact depth where it is neither, treading and stepping alternately.
		swimming: false,
		tilt: 0,          // how prone the body is, eased
		keys: new Set(),
	};

	player.pos.y = terrain.heightAt( player.pos.x, player.pos.z );

	// The opening camera sits behind the player and looks back along the offset.
	// It is declared here, above both users, because two of the gull groups are
	// deliberately flown into that view (see birds.js) and a flock aimed at a
	// direction written down twice would quietly drift out of frame the first
	// time the shot is re-aimed.
	const CAM_OFFSET = new THREE.Vector3( ...landCfg.spawnEye );

	await stage( 'gulls' );
	const gulls = makeGulls( terrain, islandGround.uniforms, atmosphere, shadow, landCfg, {
		eye: player.pos.clone().add( CAM_OFFSET ),
		dir: new THREE.Vector2( - CAM_OFFSET.x, - CAM_OFFSET.z ).normalize(),
	}, world.birds );
	scene.add( gulls.mesh );

	// ---- the cast.
	//
	// Both figures are built at boot and one is shown, rather than rebuilding on
	// every swap: a character is a face atlas rasterised out of SVG plus a
	// skinned body, which is a few tens of milliseconds and an await, and paying
	// that mid-walk stalls the frame. Two of them cost about a megabyte of
	// geometry between them and nothing per frame while hidden.
	await stage( 'cast' );
	configureClay( {
		atmosphere,
		rig: islandGround.uniforms,
		shadow,
		worldScale: landCfg.worldScale,
	} );

	const cast = [];
	for ( const spec of world.actors ) {

		// the seed → the single number the character generator actually takes;
		// changing it changes who walks out.
		const actor = await buildCharacter( makeDna( spec.seed ),
			{ height: spec.height } );
		actor.name = spec.name;
		actor.group.visible = false;
		actor.shadow.visible = false;
		scene.add( actor.group, actor.shadow );
		cast.push( actor );

	}

	let hero = cast[ 0 ];
	hero.group.visible = true;
	hero.shadow.visible = true;

	function setHero( name ) {

		const next = cast.find( ( a ) => a.name === name ) || cast[ 0 ];
		if ( next === hero ) return;
		hero.group.visible = false;
		hero.shadow.visible = false;
		next.group.position.copy( hero.group.position );
		next.group.rotation.y = hero.group.rotation.y;
		next.group.visible = view.mode !== 'first' && world.layers.island;
		next.shadow.visible = next.group.visible;
		play( next, hero.state.base );
		hero = next;

	}

	// ---- camera

	const camera = new THREE.PerspectiveCamera( 55, window.innerWidth / window.innerHeight, 0.5, 9000 );
	// opening shot: looking along the shoreline at golden hour — surf on the
	// left, the beach sweeping away in a diagonal, the palm grove climbing the
	// grass bank on the right, open water to the horizon
	camera.position.copy( player.pos ).add( CAM_OFFSET );

	const controls = new OrbitControls( camera, renderer.domElement );
	controls.target.copy( player.pos ).add( new THREE.Vector3( 0, 1.8, 0 ) );
	// the figure is 3.1 m and most of that is head — zoom closer than this and
	// the lens is inside it
	const CAM_NEAR = 4.5;
	controls.minDistance = CAM_NEAR;
	controls.maxDistance = 2800;
	controls.enablePan = false;
	controls.enableDamping = true;
	// Brisker than the 0.05 default because the mouse now drives this rig
	// continuously rather than in drag bursts: at 0.05 a turn keeps arriving for
	// most of a second after the hand has stopped, which reads as lag, not weight.
	controls.dampingFactor = 0.25;

	// Pitch freely to the zenith; the polar clamp keeps the camera above the
	// waves whatever the orbit radius.
	//
	// That clamp is a *global* floor, though — it says "never below y = 3", which
	// is the right rule for the sea and useless everywhere else. Orbit round the
	// player while they stand at the foot of the grass bank and the lens swings
	// into the hillside at three metres of altitude with twelve metres of dirt
	// over it: the terrain is a heightfield drawn one-sided, so from inside you
	// get the sky through the ground, the grass rooted above you hanging in it,
	// and the sea's underside filling the bottom of the frame.
	//
	// So the floor follows the ground the player walks on, out of the same bake.
	// A height clamp is the whole fix and it is worth being clear why: against a
	// heightfield, "above h(x, z)" *is* "outside the solid", and h does not depend
	// on where the camera ends up — so the correction is a plain continuous
	// function of the camera's ground position and cannot oscillate. Pulling the
	// orbit in along the view ray instead (the other standard answer) shortens
	// the radius, which moves the ray, which may no longer hit — and a camera
	// that pops in and out every other frame is worse than one that clips.
	//
	// It runs *before* controls.update(), not after: OrbitControls re-derives its
	// spherical from the actual camera position each update, so correcting first
	// lets it re-aim from the corrected spot in the same frame. Correcting after
	// leaves the orientation a frame stale, which reads as a lurch.
	const CAM_CLEAR = 1.6;   // metres of air kept under the lens

	// Indoors the same job is done by the house instead of the ground, and it is
	// the difference between the building being enterable and not: a rig that
	// orbits 12 m out puts the lens through the wall behind the figure and films
	// plaster, so from inside you cannot see yourself at all.
	//
	// The follow distance therefore has to be *owned* here. OrbitControls
	// re-derives its radius from the camera's position every update, so a rig
	// pushed in by a wall would simply stay pushed in once the wall was gone.
	// `camDist` is what the radius would be with nothing in the way: adopted
	// from the rig on any frame it was not overridden — which is what keeps the
	// scroll wheel working — and held across the frames it was.
	const CAM_STEPS = 18;
	let camDist = null, camClamped = false, camInsideHead = false;
	const _cdir = new THREE.Vector3();

	// The figure is hidden from the inside of its own head — a chibi skull is
	// most of the frame at that range, and looking through it is worse. Indoors
	// the orbit rig gets squeezed against the wall behind the figure and arrives
	// at exactly the same place, so that is the same rule with a second trigger
	// rather than a second rule, and it lives in one function because two
	// writers of one flag is how a figure ends up invisible on a beach.
	function syncCast() {

		const show = world.layers.island && view.mode !== 'first' && ! camInsideHead;
		for ( const a of cast ) {

			a.group.visible = show && a === hero;
			// No shadow on open water. The disc fades with height already, but a
			// swimmer's feet are *at* the seabed's depth below them and the fade
			// never triggers — what that renders as is a sand-coloured ellipse
			// following the swimmer around, which reads as a sandbank that moves.
			a.shadow.visible = a.group.visible && ! player.swimming;

		}

	}

	function clampCamera() {

		const r = camera.position.distanceTo( controls.target );
		const c = THREE.MathUtils.clamp( ( 3 - controls.target.y ) / Math.max( r, 0.001 ), - 1, 1 );
		controls.maxPolarAngle = Math.acos( c );

		const floor = terrain.heightAt( camera.position.x, camera.position.z ) + CAM_CLEAR;
		if ( camera.position.y < floor ) camera.position.y = floor;

		if ( ! indoors ) return;

		const t = controls.target;
		const len = _cdir.subVectors( camera.position, t ).length();
		if ( len < 0.001 ) return;
		_cdir.divideScalar( len );

		if ( ! camClamped || camDist === null ) camDist = len;

		let free = camDist;

		for ( let i = 1; i <= CAM_STEPS; i ++ ) {

			const d = camDist * i / CAM_STEPS;
			if ( ! indoors.solidAt( t.x + _cdir.x * d, t.y + _cdir.y * d, t.z + _cdir.z * d, 0.22 ) ) continue;
			free = d - 0.35;
			break;

		}

		const want = Math.max( 1.1, Math.min( camDist, free ) );
		camClamped = want < camDist - 0.001;
		// `CAM_NEAR` is already the distance below which the lens is inside the
		// figure — the wheel is not allowed past it. A wall pushing the rig past
		// it is the same event, so it gets the same answer.
		camInsideHead = want < CAM_NEAR;
		// ...and the rig's own floor has to move with it, or the next update
		// pushes the lens straight back out through the wall we just stopped at
		controls.minDistance = Math.min( CAM_NEAR, want );
		if ( Math.abs( want - len ) > 0.001 ) camera.position.copy( t ).addScaledVector( _cdir, want );

	}

	// The eye the first-person lens sits at, and the point the orbit rig aims
	// at: the same place, so switching modes does not move the shot sideways.
	const UP = new THREE.Vector3( 0, 1, 0 );
	const EYE = new THREE.Vector3();
	const _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
	const _move = new THREE.Vector3(), _dtgt = new THREE.Vector3();

	function eyePoint() {

		// The eye is in the head, and a swimmer's head is not two and a half
		// metres above their feet — it is a hand's width above the water with the
		// body trailing behind it. Interpolated on the same tilt the figure uses,
		// so the lens sinks as the body goes prone instead of stepping.
		const t = Math.min( 1, Math.max( 0, - player.tilt / 1.15 ) );
		const stand = hero ? hero.eyeHeight : 1.1;
		return EYE.copy( player.pos ).addScaledVector( UP, stand * ( 1 - t ) + 0.55 * t );

	}

	const view = makeViewpoint( {
		camera, controls, dom: renderer.domElement, keys: player.keys, follow: eyePoint,
		ground: ( x, z ) => terrain.heightAt( x, z ),
	} );

	// bound to V; the real one is defined with the panel it has to keep in sync
	let cycleView = () => view.setMode( { third: 'first', first: 'fly', fly: 'third' }[ view.mode ] );

	window.addEventListener( 'keydown', ( e ) => {

		if ( e.target.tagName === 'INPUT' ) return;
		player.keys.add( e.code );
		if ( e.code === 'Space' ) e.preventDefault();
		if ( e.code === 'KeyV' ) cycleView();
		if ( e.code === 'KeyX' && hero ) cheer( hero );
		if ( e.code === 'KeyF' && indoors ) indoors.toggle( indoors.nearestDoor( player.pos ) );

	} );

	window.addEventListener( 'keyup', ( e ) => player.keys.delete( e.code ) );

	// The figure as a cylinder, in metres. The clay figure is 1.85 m across the
	// arms and 1.11 m across the torso, and the cylinder is deliberately
	// narrower than either: it is what the *building* is allowed to stop, not
	// what the figure looks like. A collision radius set to the torso reads as
	// correct and plays as a figure too fat for its own house — the villa's
	// front door has 1.86 m of clear opening and the landing at the foot of the
	// stair 2.2 m, and at 0.55 those leave 38 cm of aim either side, which is a
	// doorway you fight rather than walk through. 0.42 lets a shoulder overlap
	// plaster by 13 cm, which nobody sees, and doubles the room to aim.
	// FOOT_R is smaller again: the feet want a narrow probe so a wall beside you
	// cannot lift you. BODY_H stops short of the full 3.1 m so a door head or a
	// beam is a lintel to walk under rather than something to duck.
	const BODY_R = 0.42, BODY_H = 2.6, FOOT_R = 0.24;
	const STEP_DOWN = 0.5;   // drop tolerated before it becomes a fall

	// Mean sea level. The FFT surface moves around this and the swash runs well
	// past it, but the *body* is not going to ride a wave — a figure whose feet
	// track a two-metre swell reads as a bug, not as buoyancy — so everything
	// about swimming is keyed on the still level and the wave is left to the
	// water shader.
	const SEA_Y = 0;
	const SWIM_ENTER = 1.15;   // water column that takes the feet off the bottom
	const SWIM_EXIT = 0.95;    // ...and the shallower one that puts them back
	const FLOAT_Y = 0.42;      // how far the eyes sit above the still surface

	function canStand( x, z ) {

		// The sea stopped being a wall when the figure learned to swim: the only
		// thing that blocks a step now is the building.
		if ( ! indoors ) return true;

		// Measured from where the figure would be *standing*, not from where it
		// is. On a stair those are different by a tread, and the difference is
		// the whole flight: test from the step below and the step two above is
		// a wall reaching past your head, so every riser refuses to be climbed.
		const floor = Math.max( terrain.heightAt( x, z ), indoors.floorAt( x, z, player.pos.y, FOOT_R ) );
		return ! indoors.blocked( x, z, Math.max( player.pos.y, floor ), BODY_R, BODY_H );

	}

	function updatePlayer( dt ) {

		const k = player.keys;
		const sprint = k.has( 'ShiftLeft' ) || k.has( 'ShiftRight' );

		// ---- in or out of the water ------------------------------------------
		//
		// Hysteresis on the water column, and the two thresholds are 20 cm apart:
		// with one threshold a figure standing at exactly that depth alternates
		// between treading and standing every frame, which reads as a seizure.
		// This runs before the step is taken rather than after, so the stroke and
		// the step are never both charged for the same frame.
		const bedY = terrain.heightAt( player.pos.x, player.pos.z );
		const column = SEA_Y - bedY;
		if ( player.swimming ) {

			if ( column < SWIM_EXIT ) player.swimming = false;

		} else if ( column > SWIM_ENTER && player.pos.y < SEA_Y + 0.35 ) {

			player.swimming = true;
			player.vy = 0;

		}

		const speed = player.swimming ? ( sprint ? 3.4 : 2.1 )
			: sprint ? grassCfg.player.sprintSpeed : grassCfg.player.walkSpeed;

		// Forward comes from the viewpoint, not from the camera's position: in
		// first person the lens is *inside* the figure, so "the way the camera is
		// offset from the player" is a zero-length vector and every step would be
		// taken in whatever direction the normalize happened to produce.
		const fwd = view.forward( _fwd );
		const rightv = _right.set( - fwd.z, 0, fwd.x );

		const move = _move.set( 0, 0, 0 );
		const walking = view.mode !== 'fly';   // in free flight the lens leaves, the body stays

		if ( walking ) {

			if ( k.has( 'KeyW' ) || k.has( 'ArrowUp' ) ) move.add( fwd );
			if ( k.has( 'KeyS' ) || k.has( 'ArrowDown' ) ) move.sub( fwd );
			if ( k.has( 'KeyA' ) || k.has( 'ArrowLeft' ) ) move.sub( rightv );
			if ( k.has( 'KeyD' ) || k.has( 'ArrowRight' ) ) move.add( rightv );

		}

		const moving = move.lengthSq() > 0;
		if ( moving ) move.normalize().multiplyScalar( speed * dt );

		// The sea is one boundary and the house is the other, and they are the
		// same test: is there anywhere to put a foot. Trying all three of
		// (both axes, x alone, z alone) is what lets a figure that has walked
		// into a wall at an angle keep sliding along it instead of stopping
		// dead — without it, a corridor is unusable.
		if ( canStand( player.pos.x + move.x, player.pos.z + move.z ) ) {

			player.pos.x += move.x;
			player.pos.z += move.z;

		} else if ( canStand( player.pos.x + move.x, player.pos.z ) ) {

			player.pos.x += move.x; // slide along the waterline, or along the wall

		} else if ( canStand( player.pos.x, player.pos.z + move.z ) ) {

			player.pos.z += move.z;

		}

		// The house's floors win over the terrain wherever it offers one, which
		// is what makes a deck a deck and a stair a stair. `floorAt` returns
		// -Infinity everywhere else, so outdoors this is the terrain unchanged.
		const groundY = indoors
			? Math.max( terrain.heightAt( player.pos.x, player.pos.z ),
				indoors.floorAt( player.pos.x, player.pos.z, player.pos.y, FOOT_R ) )
			: terrain.heightAt( player.pos.x, player.pos.z );

		if ( player.swimming ) {

			// Swimming, in four rules. Horizontal drive comes from the same
			// forward the walk uses; up and down are the two keys free flight
			// already uses for the same thing, so there is nothing new to learn.
			// Everything else is buoyancy.
			const rise = ( k.has( 'Space' ) ? 1 : 0 ) - ( k.has( 'KeyC' ) ? 1 : 0 );

			if ( rise !== 0 ) {

				player.vy += rise * 9.0 * dt;

			} else {

				// Buoyancy toward a float line, damped rather than sprung: a real
				// body bobs once and settles, and an undamped spring gives a cork
				// that never stops. The pull weakens with depth so a dive holds
				// instead of being yanked back the moment you stop kicking.
				const want = SEA_Y - FLOAT_Y;
				const sink = Math.max( 0, want - player.pos.y );
				player.vy += ( want - player.pos.y ) * ( 2.4 / ( 1 + sink * 0.22 ) ) * dt;

			}

			player.vy *= Math.pow( 0.06, dt );          // water is thick
			player.pos.y += player.vy * dt;

			// the bottom is still the bottom
			const floorY = bedY + 0.55;
			if ( player.pos.y < floorY ) {

				player.pos.y = floorY;
				player.vy = Math.max( player.vy, 0 );

			}

			// ...and the surface is a ceiling you can break through but not fly
			// out of: without this, holding Space in the shallows launches the
			// figure two metres into the air off nothing.
			if ( player.pos.y > SEA_Y + 0.15 ) {

				player.pos.y = SEA_Y + 0.15;
				player.vy = Math.min( player.vy, 0 );

			}

			player.grounded = false;

		} else {

		if ( player.grounded && walking && k.has( 'Space' ) ) {

			player.vy = grassCfg.player.jumpSpeed;
			player.grounded = false;
			if ( hero ) play( hero, 'jump' );

		}

		if ( ! player.grounded ) {

			player.vy -= grassCfg.player.gravity * dt;
			player.pos.y += player.vy * dt;

			if ( player.pos.y <= groundY ) {

				player.pos.y = groundY;
				player.vy = 0;
				player.grounded = true;

			}

		} else if ( player.pos.y - groundY > STEP_DOWN ) {

			// walked off the terrace edge, or off the top of the stair — fall
			// rather than teleport down, which is the same rule as the jump and
			// is why this is a branch here and not a clamp.
			player.grounded = false;
			player.vy = 0;

		} else {

			// Eased rather than set, because the house's floor is a staircase:
			// snapping to each tread makes the figure strobe up the flight. The
			// terrain is smooth enough that the ease is invisible on it.
			player.pos.y += ( groundY - player.pos.y ) * Math.min( 1, dt * 18 );
			if ( Math.abs( groundY - player.pos.y ) < 0.002 ) player.pos.y = groundY;

		}

		}

		// ---- the figure follows the physics, and turns to face where it walked
		if ( hero ) {

			hero.group.position.copy( player.pos );

			if ( moving ) {

				// +Z is the figure's forward (see actor/character.js), so this is
				// atan2(x, z) and not the atan2(y, x) reflex. Turning is damped:
				// a body that snaps to a new heading in one frame reads as a
				// sprite being flipped, not as someone changing direction.
				const want = Math.atan2( move.x, move.z );
				const d = ( ( want - hero.group.rotation.y + Math.PI * 3 ) % ( Math.PI * 2 ) ) - Math.PI;
				hero.group.rotation.y += d * Math.min( 1, dt * 12 );

			}

			// Gait: the clip is chosen from what the body is actually doing, so
			// there is no walk cycle playing while standing still. It has to
			// stand back for a deliberate one-shot, though — this runs every
			// frame, and without the guard it re-asserted `idle` on the frame
			// after X and the cheer never got past its first pose.
			if ( player.swimming ) {

				play( hero, 'swim' );

			} else if ( player.grounded && hero.state.motion !== 'cheer' ) {

				play( hero, moving ? ( sprint ? 'run' : 'walk' ) : 'idle' );

			}

			// Prone in the water, upright out of it, eased between the two — a
			// body that snaps flat the instant its feet leave the bottom reads as
			// a model being rotated. The clip has no tilt in it precisely so that
			// this can also steepen on a dive: hold C and the body noses down,
			// which is the difference between swimming and sliding.
			const wantTilt = player.swimming
				? - 1.15 - THREE.MathUtils.clamp( - player.vy * 0.16, - 0.3, 0.45 )
				: 0;
			player.tilt += ( wantTilt - player.tilt ) * Math.min( 1, dt * 5 );
			hero.group.rotation.x = player.tilt;
			// ...and the body rides at the waterline rather than at its feet: the
			// figure's origin is between the soles, so a prone swimmer pivoted
			// about it hangs half a body below the surface.
			if ( player.tilt < - 0.02 ) {

				hero.group.position.y += Math.sin( - player.tilt ) * 0.24;

			}

			hero.shadow.position.set( player.pos.x, groundY + 0.04, player.pos.z );
			// the shadow belongs to the ground, not to the body: it stays put and
			// fades as the jump takes the feet away from it, and there is no
			// shadow on water at all
			hero.shadow.material.u.alpha.value = 0.55
				* Math.max( 0, 1 - ( player.pos.y - groundY ) / 2.4 )
				* Math.max( 0, 1 - Math.max( 0, SEA_Y - groundY ) / 0.6 );

		}

		const target = eyePoint();

		if ( view.mode === 'third' ) {

			// the orbit rig is a relative one — move its target and the lens has
			// to travel with it, or walking slowly winds the camera in
			camera.position.add( _dtgt.copy( target ).sub( controls.target ) );
			controls.target.copy( target );

		}

	}

	// ---- light bridging: sun/moon → water scalar + grass/island rigs
	//
	// The grass rig is authored for ACES at exposure 2.0; the atmosphere runs at
	// oceanCfg.atmosphere.exposure. ACES exposure multiplies radiance before the
	// curve, so scaling the rig's own light by 2.0/exposure reproduces the
	// standalone look exactly — then daylight fades it through the cycle.

	const lin = ( r, g, b ) => new THREE.Color().setRGB( r, g, b, THREE.SRGBColorSpace );

	const FOG_DAY = lin( 0.62, 0.68, 0.75 );  // pale marine haze
	const FOG_DUSK = lin( 0.72, 0.55, 0.38 );
	const DEEP_SKIRT = new THREE.Color( 0.022, 0.048, 0.068 ); // linear radiance ≈ lit deep water
	const fogNow = new THREE.Color();

	// The blades carry no directional moonlight — a blade is thin enough that
	// its hemisphere *is* its lighting after dark — but the hemisphere it gets
	// during the day is a warm afternoon sky, and a dark green albedo under a
	// dim warm fill is black. Two things have to change together at night: the
	// colour, to the blue a dark-adapted eye reads moonlight as, and the level.
	const HEMI_SKY_DAY = lin( ...grassCfg.lighting.hemiSky );
	const HEMI_GROUND_DAY = lin( ...grassCfg.lighting.hemiGround );
	const HEMI_SKY_NIGHT = lin( 0.42, 0.56, 0.85 );
	const HEMI_GROUND_NIGHT = lin( 0.17, 0.21, 0.31 );

	const smoothstep01 = ( x, a, b ) => THREE.MathUtils.smoothstep( x, a, b );
	const tmpColor = new THREE.Color();

	function syncLights() {

		const s = atmosphere.uniforms.sunDir.value;
		const m = atmosphere.uniforms.moonDir.value;

		const dayF = smoothstep01( s.y, - 0.06, 0.18 );
		const illum = ( 1 - s.dot( m ) ) * 0.5;
		const moonF = smoothstep01( m.y, 0.0, 0.3 ) * illum;
		const lightLevel = 0.035 + 0.965 * dayF + 0.16 * moonF * ( 1 - dayF );
		// full only once the sun is 8° down — past civil twilight, so the sunset
		// the sky module is graded for never sees it
		nightToe.value = 1 - smoothstep01( s.y, - 0.14, - 0.02 );

		oceanSky.bodyLight.value = lightLevel;
		if ( villa ) villa.setTime( s, atmosphere.sunLight.color, atmosphere.sunLight.level, dayF, moonF );
		oceanSky.moonLight.value.copy( atmosphere.uniforms.moonColor.value )
			.multiplyScalar( moonF * ( 1 - dayF ) * oceanCfg.moon.seaGlint );

		const comp = 2.0 / oceanCfg.atmosphere.exposure;
		const high = smoothstep01( s.y, 0.04, 0.5 );

		// The sun's colour and strength are not authored anywhere: they are the
		// transmittance the atmosphere integrated along the sun path this frame.
		// The grass reddens at dusk for the same reason the sky does.
		const sl = atmosphere.sunLight;
		tmpColor.copy( sl.color );

		mu.sunRadiance.value.copy( tmpColor ).multiplyScalar( 0.62 * sl.level );
		mu.sunColor.value.copy( tmpColor );
		const moonUp = moonF * ( 1 - dayF );
		mu.hemiIntensity.value = grassCfg.lighting.hemiIntensity * ( lightLevel + 0.35 * moonUp );
		mu.hemiSky.value.copy( HEMI_SKY_DAY ).lerp( HEMI_SKY_NIGHT, 1 - dayF );
		mu.hemiGround.value.copy( HEMI_GROUND_DAY ).lerp( HEMI_GROUND_NIGHT, 1 - dayF );
		mu.moonRadiance.value.setRGB( 0.34, 0.44, 0.62 ).multiplyScalar( 0.11 * moonUp );
		mu.exposure.value = grassCfg.lighting.exposure * comp;

		fogNow.copy( FOG_DUSK ).lerp( FOG_DAY, high ).multiplyScalar( 0.05 + 0.95 * dayF );
		mu.fogColor.value.copy( fogNow );

		// the ground and palms read atmosphere.uniforms.sunColor directly; only
		// the underwater skirt still needs a day-night scalar
		islandGround.uniforms.deepTint.value.copy( DEEP_SKIRT ).multiplyScalar( lightLevel );
		// Night. The moon is a light, not a floor: `moonFill` is the skyglow the
		// whole hemisphere pours in, `moonRad` is the moon itself, from
		// `moonDir`, and it is the one that puts a shape back on the island. Both
		// are cool on purpose — moonlight is very slightly *warm* in a photometer
		// and unmistakably blue to a dark-adapted eye, and the eye is what this
		// is for. The values are linear radiance, so they are small numbers.
		islandGround.uniforms.moonFill.value.setRGB( 0.024, 0.031, 0.054 )
			.multiplyScalar( ( 0.40 + moonF ) * ( 1 - dayF ) );
		islandGround.uniforms.moonRad.value.setRGB( 0.34, 0.44, 0.62 )
			.multiplyScalar( 0.38 * moonUp );

	}

	syncLights();

	// ---- layers

	function applyLayers() {

		const L = world.layers;

		surface.mesh.visible = L.ocean;
		calm.mesh.visible = ! L.ocean;
		surface.uniforms.bedMix.value = L.island ? 1 : 0;

		islandGround.mesh.visible = L.island;
		tile.visible = L.island;
		trees.mesh.visible = L.island;
		if ( grove ) grove.group.visible = L.island && L.woods;
		if ( drift ) drift.mesh.visible = L.island && L.woods;
		if ( flowers ) flowers.group.visible = L.island && L.flowers;
		if ( villa ) {

			villa.group.visible = L.island && L.woods;
			villa.lights.visible = L.island && L.woods;

		}
		gulls.mesh.visible = L.birds;
		syncCast();

		if ( L.island ) {

			controls.maxDistance = 2800;
			controls.target.copy( eyePoint() );

		} else {

			controls.target.set( 0, 1, 0 );

		}

	}

	applyLayers();

	// ---- GUI

	const gui = new GUI( { title: 'world' } );

	const fLayers = gui.addFolder( 'layers' );
	fLayers.add( world.layers, 'ocean' ).name( 'FFT ocean' ).onChange( applyLayers ).listen();
	fLayers.add( world.layers, 'island' ).name( 'land' ).onChange( applyLayers ).listen();
	fLayers.add( world.layers, 'birds' ).name( 'gulls' ).onChange( applyLayers ).listen();
	fLayers.add( world.layers, 'woods' ).name( 'woods + house' ).onChange( applyLayers ).listen();
	fLayers.add( world.layers, 'flowers' ).name( 'flowers' ).onChange( applyLayers ).listen();

	const ui = { character: hero.name, view: 'third person' };
	const VIEWS = { 'third person': 'third', 'first person': 'first', 'free flight': 'fly' };

	const fPlayer = gui.addFolder( 'player' );
	fPlayer.add( ui, 'character', cast.map( ( a ) => a.name ) ).onChange( setHero );
	const viewCtrl = fPlayer.add( ui, 'view', Object.keys( VIEWS ) ).onChange( ( v ) => setView( VIEWS[ v ] ) );

	function setView( mode ) {

		view.setMode( mode );
		ui.view = Object.keys( VIEWS ).find( ( k ) => VIEWS[ k ] === view.mode );
		viewCtrl.updateDisplay();
		applyLayers();   // the figure is visible in two modes out of three

	}

	cycleView = () => setView( { third: 'first', first: 'fly', fly: 'third' }[ view.mode ] );

	const applyTime = () => { atmosphere.setTime( oceanCfg.time.hour ); syncLights(); };

	const fTime = gui.addFolder( 'time' );
	const hourCtrl = fTime.add( oceanCfg.time, 'hour', 0, 24, 0.01 ).onChange( applyTime ).listen();
	fTime.add( oceanCfg.time, 'autoPlay' ).name( 'auto cycle' );
	fTime.add( oceanCfg.time, 'speed', 0.005, 1, 0.005 ).name( 'hours / second' );

	const fAtmos = gui.addFolder( 'atmosphere' );
	fAtmos.add( oceanCfg.atmosphere, 'turbidity', 1, 12, 0.1 ).onChange( () => atmosphere.syncConfig() );
	fAtmos.add( oceanCfg.atmosphere, 'rayleigh', 0.2, 4, 0.05 ).onChange( () => atmosphere.syncConfig() );
	fAtmos.add( oceanCfg.atmosphere, 'exposure', 0.2, 2, 0.01 ).onChange( ( v ) => {

		renderer.toneMappingExposure = v;
		syncLights();

	} );
	fAtmos.add( oceanCfg.clouds, 'coverage', 0, 0.8, 0.01 ).name( 'cloud cover' ).onChange( () => atmosphere.syncConfig() );
	fAtmos.add( oceanCfg.clouds, 'scale', 0.3, 3, 0.05 ).name( 'cloud scale' ).onChange( () => atmosphere.syncConfig() );
	fAtmos.add( oceanCfg.moon, 'offsetHours', 0, 24, 0.1 ).name( 'moon phase (h)' ).onChange( applyTime );
	fAtmos.add( oceanCfg.aurora, 'intensity', 0, 3, 0.05 ).name( 'aurora' )
		.onChange( ( v ) => { atmosphere.aurora.uniforms.gain.value = v; } );
	fAtmos.add( oceanCfg.aurora, 'speed', 0, 2, 0.01 ).name( 'aurora speed' )
		.onChange( ( v ) => { atmosphere.aurora.uniforms.speed.value = v; } );
	fAtmos.close();

	const rebake = () => sim.computeInitialSpectrum( renderer );

	const fOcean = gui.addFolder( 'ocean' );
	fOcean.add( oceanCfg.waves, 'lambda', 0, 2, 0.01 ).name( 'choppiness λ' ).onChange( v => sim.lambdaU.value = v );
	fOcean.add( oceanCfg.waves.local, 'windSpeed', 0.1, 40, 0.1 ).onChange( rebake );
	fOcean.add( oceanCfg.waves.swell, 'scale', 0, 2, 0.01 ).name( 'swell' ).onChange( rebake );
	fOcean.add( oceanCfg.foam, 'threshold', - 1, 1, 0.01 ).onChange( v => surface.uniforms.foamThreshold.value = v );
	fOcean.add( oceanCfg.foam, 'life', 0.2, 12, 0.1 ).name( 'surf memory (s)' )
		.onChange( v => breakerFoam.uniforms.life.value = v );
	fOcean.add( oceanCfg.foam, 'drift', 0, 10, 0.1 ).name( 'foam drift (m/s)' )
		.onChange( v => breakerFoam.uniforms.drift.value = v );
	fOcean.close();

	const fGrass = gui.addFolder( 'grass' );
	fGrass.add( grassCfg.wind, 'strength', 0, 1, 0.01 ).name( 'wind strength' );
	fGrass.add( grassCfg.wind, 'gustCoverage', 0, 1, 0.01 );
	fGrass.add( grassCfg.wind, 'swayAmount', 0, 0.2, 0.002 );
	fGrass.add( grassCfg.trample, 'radius', 0.2, 4, 0.05 ).name( 'trample radius' );
	fGrass.close();

	gui.add( oceanCfg.sim, 'paused' );

	await stage( 'first frame' );

	window.__world = { world, oceanCfg, grassCfg, sim, system, renderer, atmosphere, camera, controls, player, terrain, trees, gulls, islandGround, shore, breakerFoam, applyLayers, applyTime, debugTintU,
		view, setView, cast, setHero, get hero() { return hero; },
		get grove() { return grove; }, get drift() { return drift; }, get villa() { return villa; },
		get flowers() { return flowers; },
		get indoors() { return indoors; } };

	// ---- resize + loop

	window.addEventListener( 'resize', () => {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );

	} );

	const TRIS = system.segments.map( s => ( s - 1 ) * 2 + 1 );
	const prevPlayerXZ = new THREE.Vector2( player.pos.x, player.pos.z );
	const clock = new THREE.Clock();

	let t = 0, frame = 0;
	let cpuAvg = 0, fpsAvg = 0;
	let statsPending = false;
	let bladesLine = '';
	let gpuLine = '';

	renderer.setAnimationLoop( async () => {

		const dt = Math.min( clock.getDelta(), 1 / 30 );
		const t0 = performance.now();

		// Ordering matters and is the reason these are three statements rather
		// than a branch: the height clamp has to correct the camera *before* the
		// orbit rig re-derives its spherical from it, and the viewpoint's turn
		// has to be in before that same update, or the mouse is a frame stale.
		if ( controls.enabled ) clampCamera();
		else camInsideHead = false;
		syncCast();
		view.update( dt, eyePoint() );
		if ( controls.enabled ) controls.update();

		// the water's dense tessellation rides under the camera
		surface.follow( camera.position.x, camera.position.z );

		if ( oceanCfg.time.autoPlay ) {

			oceanCfg.time.hour = ( oceanCfg.time.hour + dt * oceanCfg.time.speed ) % 24;
			atmosphere.setTime( oceanCfg.time.hour );
			hourCtrl.updateDisplay();

		}

		atmosphere.uniforms.time.value += dt;
		shore.timeU.value += dt;

		// Which medium the lens is in. Driven from the *camera*, not the player:
		// in third person the figure can be a metre under while the lens is still
		// in the air, and what the frame should look like is decided by where the
		// lens is. The 0.35 m ramp is the thickness of the surface as far as this
		// is concerned — a hard switch pops, and a wider one leaves the frame
		// half-fogged while the lens is clearly in the air.
		atmosphere.uniforms.submerged.value = THREE.MathUtils.clamp(
			( SEA_Y - camera.position.y ) / 0.35, 0, 1 );
		atmosphere.update( renderer ); // re-march the scattering LUT if the sun moved

		// ---- the aurora.
		//
		// One dial, computed here rather than in the sky module, because "is it
		// night" already has an owner: the sun's elevation drives the stars, the
		// airglow and the scotopic toe, and a second definition would show up as
		// an aurora that arrives before the stars do. It fades in over the same
		// few degrees of sun and it is *skipped* — not faded — the moment it
		// contributes nothing, so a daylight frame does not march a volume.
		//
		// The window starts at *nautical* twilight, not at sunset. A real aurora
		// is there all evening and simply loses to the sky; started at sunset,
		// this one lays a green band across the orange while the west is still
		// lit, which reads as a bug rather than as an aurora. −0.06 to −0.20 in
		// sun elevation is roughly 3.5° to 11.5° below the horizon: the curtains
		// arrive with the stars, which is when anyone has ever seen one.
		{
			const sunY = atmosphere.uniforms.sunDir.value.y;
			const level = oceanCfg.aurora.intensity <= 0 ? 0
				: THREE.MathUtils.clamp( ( - 0.06 - sunY ) / 0.14, 0, 1 );
			const au = atmosphere.aurora;
			au.uniforms.level.value = level;
			if ( level > 0.002 ) {

				au.uniforms.time.value += dt;
				renderer.compute( au.bake );

			}
		}
		if ( world.layers.island ) shadow.update( renderer );
		syncLights();

		if ( ! oceanCfg.sim.paused ) {

			t += dt;

			if ( world.layers.island ) {

				updatePlayer( dt );
				if ( hero ) updateCharacter( hero, dt );
				windDirector.update( dt, t );
				trees.setWind( windDirector.level );
				if ( grove ) grove.setWind( windDirector.level );
				if ( drift ) drift.update( windDirector.level );
				if ( flowers ) flowers.update( player.pos, windDirector.level );
				if ( villa ) villa.update( camera.position );
				if ( indoors ) {

					indoors.update( dt );
					const near = indoors.nearestDoor( player.pos );
					const label = near
						? `press F to ${ near.open ? 'close' : 'open' } the ${ near.label }` : '';
					if ( label !== promptText ) {

						promptText = label;
						promptEl.textContent = label;
						promptEl.classList.toggle( 'on', label !== '' );

					}

				}

				// the tile follows the CAMERA's ground point, not the player —
				// orbiting away from the player must not leave the view bald.
				// Trample stays at the player's actual feet via tramplePos.
				tile.position.set( camera.position.x, 0, camera.position.z );

				// ...and it grows with the lens. A fixed 200 m tile is the right
				// field to stand in and the wrong one to look down on: from a
				// hundred metres up the blades stopped a hundred metres out and
				// the meadow read as a patch of grass laid on the hillside with
				// the rest of the island shaded as turf. Blade count is fixed, so
				// reach is bought with spacing — which is exactly the trade the
				// altitude that asked for it also pays for, since a blade at that
				// range is a fraction of a pixel wide. `setTileScale` quantises
				// and hystereses the ask; this is only the ask.
				const camAlt = Math.max( 0, camera.position.y
					- terrain.heightAt( camera.position.x, camera.position.z ) );
				system.setTileScale( renderer, world.grassOverrides.tileSize * ( 1 + camAlt / 50 ) );

				const u = system.u;
				u.playerDelta.value.set( camera.position.x - prevPlayerXZ.x, camera.position.z - prevPlayerXZ.y );
				u.playerXZ.value.set( camera.position.x, camera.position.z );
				u.tramplePos.value.set( player.pos.x, player.pos.z );
				u.playerGrounded.value = player.grounded ? 1 : 0;
				prevPlayerXZ.set( camera.position.x, camera.position.z );

				camera.updateMatrixWorld();
				system.syncUniforms( camera );
				system.update( renderer, dt, t );

			}

			if ( world.layers.ocean ) {

				sim.update( renderer, dt * oceanCfg.sim.timeScale );
				// after the sim, because the field's source term reads this
				// frame's displacement maps; and only with the island in the
				// scene, since without a seabed nothing can break on it
				if ( world.layers.island ) breakerFoam.update( renderer, dt * oceanCfg.sim.timeScale );

			}

		}

		renderer.render( scene, camera );

		const cpu = performance.now() - t0;
		cpuAvg += ( cpu - cpuAvg ) * 0.05;
		fpsAvg += ( 1 / Math.max( dt, 1e-4 ) - fpsAvg ) * 0.05;

		frame ++;

		if ( frame % 30 === 0 && world.layers.island && ! statsPending ) {

			statsPending = true;

			renderer.getArrayBufferAsync( system.indirect ).then( ( buf ) => {

				const args = new Uint32Array( buf );
				let blades = 0, tris = 0;

				for ( let lod = 0; lod < lodCount; lod ++ ) {

					blades += args[ lod * 5 + 1 ];
					tris += args[ lod * 5 + 1 ] * TRIS[ lod ];

				}

				bladesLine = ` · ${ blades.toLocaleString() } blades / ${ tris.toLocaleString() } tris`;
				statsPending = false;

			} ).catch( () => statsPending = false );

		}

		if ( frame % 30 === 0 ) {

			try {

				await renderer.resolveTimestampsAsync( 'compute' );
				await renderer.resolveTimestampsAsync( 'render' );
				const c = renderer.info.compute.timestamp;
				const r = renderer.info.render.timestamp;
				if ( c || r ) gpuLine = `gpu compute ${ c.toFixed( 2 ) } ms · gpu render ${ r.toFixed( 2 ) } ms<br>`;

			} catch ( e ) { /* unsupported */ }

			const hh = Math.floor( oceanCfg.time.hour );
			const mm = Math.floor( ( oceanCfg.time.hour - hh ) * 60 );
			const L = world.layers;
			const layerLine = [ 'sky', L.ocean ? 'FFT ocean' : 'calm sea', L.island ? 'island' : null ].filter( Boolean ).join( ' + ' );

			hud.innerHTML =
				`${ String( hh ).padStart( 2, '0' ) }:${ String( mm ).padStart( 2, '0' ) } · ${ fpsAvg.toFixed( 0 ) } fps · cpu ${ cpuAvg.toFixed( 2 ) } ms<br>` +
				gpuLine +
				`${ layerLine }${ L.island ? bladesLine : '' }` +
				( hasFirstInstance ? '' : '<br><b>fallback: no indirect-first-instance</b>' );

		}

	} );

	// two frames of headroom so the first one is genuinely presented — and so
	// the pipelines the opening shot needs are compiled — before the CPU
	// disappears into the wood for a second
	await new Promise( ( r ) => requestAnimationFrame( () => requestAnimationFrame( r ) ) );
	await buildInterior();
	await stage( 'ready' );

	// ...and only now is the world handed over.
	bootBar.style.width = '100%';
	bootEl.classList.add( 'done' );
	setTimeout( () => { bootEl.style.display = 'none'; }, 600 );

	console.info( `[boot] ${ ( performance.now() - boot ).toFixed( 0 ) } ms —\n` +
		timings.filter( ( t ) => t[ 1 ] > 3 ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] )
			.map( ( [ n, ms ] ) => `  ${ ms.toFixed( 0 ).padStart( 6 ) } ms  ${ n }` ).join( '\n' ) );

}
