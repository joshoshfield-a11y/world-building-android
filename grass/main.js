// Boot: WebGPU check → indirect-first-instance gate → build the field →
// walk around in it. Third-person player (WASD + shift sprint + space jump)
// tramples the grass; the tile re-centres on the player every frame.

import * as THREE from 'three/webgpu';
import { positionWorldDirection, normalWorld, Fn, vec3, mix, dot, max } from 'three/tsl';
import { OrbitControls } from '../vendor/OrbitControls.js';
import GUI from 'lil-gui';

import { config, COUNT, LOD_SEGMENTS, TILE_SIZE } from './config.js';
import { makeTerrain, makeGround } from './terrain.js';
import { makeSky } from './sky.js';
import { WindDirector, makeGustTexture } from './wind.js';
import { GrassSystem } from './blades.js';
import { makeBladeGeometry, makeBladeMaterial } from './material.js';

const hud = document.getElementById( 'hud' );

function showOverlay( title, message ) {

	const el = document.getElementById( 'overlay' );
	el.innerHTML = `<h1>${ title }</h1><p>${ message }</p>`;
	el.style.display = 'grid';

}

init().catch( ( err ) => {

	console.error( err );
	showOverlay( 'Grass failed to start', err.message );

} );

async function init() {

	if ( ! navigator.gpu ) {

		throw new Error( 'This scene needs WebGPU. Use Chrome / Edge 113+, or Safari 18+ with WebGPU enabled.' );

	}

	const renderer = new THREE.WebGPURenderer( { antialias: true, trackTimestamp: true } );
	renderer.setPixelRatio( Math.min( window.devicePixelRatio, 1.5 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 2.0; // the grass rig is tuned for ACES at 2.0
	document.body.appendChild( renderer.domElement );

	await renderer.init();

	// GPU-driven LOD needs firstInstance in indirect draws; collapse to a
	// single 4-segment draw when the feature is missing rather than failing
	const device = renderer.backend.device;
	const hasFirstInstance = !! ( device && device.features.has( 'indirect-first-instance' ) );
	const lodCount = hasFirstInstance ? 3 : 1;

	if ( ! hasFirstInstance ) console.warn( '[grass] indirect-first-instance unavailable — falling back to a single LOD draw' );

	// ---- world

	const scene = new THREE.Scene();
	const sky = makeSky();
	scene.backgroundNode = sky.sample( positionWorldDirection );

	const terrain = makeTerrain( config );
	const ground = makeGround( terrain, sky, config );
	scene.add( ground.mesh );

	const windDirector = new WindDirector( config );
	const gustTex = makeGustTexture();

	const system = new GrassSystem( terrain, windDirector, gustTex, lodCount );
	system.init( renderer ); // one-time GPU pass: spatial scale + colour-noise patches

	const { material, debugTintU } = makeBladeMaterial( system, sky, lodCount );

	const tile = new THREE.Group();
	scene.add( tile );

	for ( let lod = 0; lod < lodCount; lod ++ ) {

		const geo = makeBladeGeometry( system.segments[ lod ], system.count );
		geo.setIndirect( system.indirect, lod * 5 * 4 ); // byte offset into shared args
		const mesh = new THREE.Mesh( geo, material );
		mesh.frustumCulled = false;
		tile.add( mesh );

	}

	// ---- player

	const player = {
		pos: new THREE.Vector3( 0, 0, 0 ),
		vy: 0,
		grounded: true,
		keys: new Set(),
	};

	player.pos.y = terrain.heightAt( 0, 0 );

	const playerMat = new THREE.MeshBasicNodeMaterial();
	playerMat.colorNode = Fn( () => {

		const N = normalWorld;
		const sun = max( dot( N, sky.sunDir ), 0.0 );
		return mix( vec3( 0.10, 0.11, 0.13 ), vec3( 0.72, 0.30, 0.16 ), sun.mul( 0.8 ).add( 0.2 ) );

	} )();

	const playerMesh = new THREE.Mesh( new THREE.CapsuleGeometry( 0.26, 0.75, 6, 14 ), playerMat );
	scene.add( playerMesh );

	const camera = new THREE.PerspectiveCamera( 55, window.innerWidth / window.innerHeight, 0.3, 900 );
	camera.position.set( - 5, player.pos.y + 3.2, - 7 );

	const controls = new OrbitControls( camera, renderer.domElement );
	controls.target.copy( player.pos ).add( new THREE.Vector3( 0, 1.1, 0 ) );
	controls.maxPolarAngle = Math.PI * 0.495;
	controls.minDistance = 2.5;
	controls.maxDistance = 60;
	controls.enableDamping = true;
	controls.enablePan = false;

	window.addEventListener( 'keydown', ( e ) => {

		if ( e.target.tagName === 'INPUT' ) return;
		player.keys.add( e.code );
		if ( e.code === 'Space' ) e.preventDefault();

	} );

	window.addEventListener( 'keyup', ( e ) => player.keys.delete( e.code ) );

	function updatePlayer( dt ) {

		const k = player.keys;
		const speed = ( k.has( 'ShiftLeft' ) || k.has( 'ShiftRight' ) ) ? config.player.sprintSpeed : config.player.walkSpeed;

		const fwd = new THREE.Vector3().subVectors( player.pos, camera.position );
		fwd.y = 0; fwd.normalize();
		const rightv = new THREE.Vector3( - fwd.z, 0, fwd.x );

		const move = new THREE.Vector3();
		if ( k.has( 'KeyW' ) || k.has( 'ArrowUp' ) ) move.add( fwd );
		if ( k.has( 'KeyS' ) || k.has( 'ArrowDown' ) ) move.sub( fwd );
		if ( k.has( 'KeyA' ) || k.has( 'ArrowLeft' ) ) move.sub( rightv );
		if ( k.has( 'KeyD' ) || k.has( 'ArrowRight' ) ) move.add( rightv );

		if ( move.lengthSq() > 0 ) move.normalize().multiplyScalar( speed * dt );

		player.pos.x += move.x;
		player.pos.z += move.z;

		const groundY = terrain.heightAt( player.pos.x, player.pos.z );

		if ( player.grounded && ( k.has( 'Space' ) ) ) {

			player.vy = config.player.jumpSpeed;
			player.grounded = false;

		}

		if ( ! player.grounded ) {

			player.vy -= config.player.gravity * dt;
			player.pos.y += player.vy * dt;

			if ( player.pos.y <= groundY ) {

				player.pos.y = groundY;
				player.vy = 0;
				player.grounded = true;

			}

		} else {

			player.pos.y = groundY;

		}

		playerMesh.position.copy( player.pos ).add( new THREE.Vector3( 0, 0.64, 0 ) );

		// camera rig follows
		const target = player.pos.clone().add( new THREE.Vector3( 0, 1.1, 0 ) );
		const dtgt = target.clone().sub( controls.target );
		camera.position.add( dtgt );
		controls.target.copy( target );

	}

	// ---- GUI

	const gui = new GUI( { title: 'grass' } );

	const fWind = gui.addFolder( 'wind' );
	fWind.add( config.wind, 'strength', 0, 1, 0.01 );
	fWind.add( config.wind, 'gustCoverage', 0, 1, 0.01 );
	fWind.add( config.wind, 'eddyStrength', 0, 2, 0.01 );
	fWind.add( config.wind, 'swayAmount', 0, 0.2, 0.002 );
	fWind.add( config.wind, 'baseBending', 0, 5, 0.05 );
	fWind.add( config.wind, 'speed', 0.02, 1, 0.01 );

	const fBlade = gui.addFolder( 'blades' );
	fBlade.add( config.blade, 'minScale', 0.2, 1.5, 0.01 );
	fBlade.add( config.blade, 'maxScale', 1, 3, 0.01 );
	fBlade.close();

	const fThin = gui.addFolder( 'thinning' );
	fThin.add( config.thinning, 'fullRadius', 5, 100, 1 );
	fThin.add( config.thinning, 'falloffRadius', 40, 200, 1 );
	fThin.add( config.thinning, 'farDensity', 0.05, 1, 0.01 );
	fThin.add( config.thinning, 'projMin', 0, 0.02, 0.0005 );
	fThin.add( config.thinning, 'projFull', 0.005, 0.08, 0.0005 );
	fThin.add( config.thinning, 'hysteresis', 0, 0.25, 0.005 );
	fThin.close();

	const fLod = gui.addFolder( 'lod' );
	fLod.add( config.lod.radii, '0', 5, 80, 1 ).name( 'lod0 → lod1 (m)' );
	fLod.add( config.lod.radii, '1', 20, 120, 1 ).name( 'lod1 → lod2 (m)' );
	fLod.add( config.lod, 'debugTint' ).onChange( v => debugTintU.value = v ? 1 : 0 );

	const fTrample = gui.addFolder( 'trample' );
	fTrample.add( config.trample, 'radius', 0.2, 4, 0.05 );
	fTrample.add( config.trample, 'crushedScale', 0.05, 0.6, 0.01 );
	fTrample.add( config.trample, 'growthRate', 0.02, 5, 0.01 );
	fTrample.close();

	gui.add( config.sim, 'paused' );

	// ---- loop

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
	let statsLine = 'stats…';
	let gpuLine = '';

	window.__grass = { config, system, renderer, windDirector, camera, controls, player, debugTintU };

	renderer.setAnimationLoop( async () => {

		const dt = Math.min( clock.getDelta(), 1 / 30 );
		const t0 = performance.now();

		controls.update();

		if ( ! config.sim.paused ) {

			t += dt;
			updatePlayer( dt );
			windDirector.update( dt, t );

			// tile follows the player; blades wrap by the same delta
			tile.position.set( player.pos.x, 0, player.pos.z );
			ground.follow( player.pos.x, player.pos.z );

			const u = system.u;
			u.playerDelta.value.set( player.pos.x - prevPlayerXZ.x, player.pos.z - prevPlayerXZ.y );
			u.playerXZ.value.set( player.pos.x, player.pos.z );
			u.tramplePos.value.set( player.pos.x, player.pos.z );
			u.playerGrounded.value = player.grounded ? 1 : 0;
			prevPlayerXZ.set( player.pos.x, player.pos.z );

			camera.updateMatrixWorld();
			system.syncUniforms( camera );

			system.update( renderer, dt, t ); // exactly two dispatches

		}

		renderer.render( scene, camera );

		const cpu = performance.now() - t0;
		cpuAvg += ( cpu - cpuAvg ) * 0.05;
		fpsAvg += ( 1 / Math.max( dt, 1e-4 ) - fpsAvg ) * 0.05;

		frame ++;

		// async readback — the CPU learns the counts late and only for the HUD
		if ( frame % 30 === 0 && ! statsPending ) {

			statsPending = true;

			renderer.getArrayBufferAsync( system.indirect ).then( ( buf ) => {

				const args = new Uint32Array( buf );
				const counts = [];
				let blades = 0, tris = 0;

				for ( let lod = 0; lod < lodCount; lod ++ ) {

					const n = args[ lod * 5 + 1 ];
					counts.push( n );
					blades += n;
					tris += n * TRIS[ lod ];

				}

				statsLine =
					`rendered ${ blades.toLocaleString() } / ${ COUNT.toLocaleString() } blades · ` +
					`${ tris.toLocaleString() } tris<br>per LOD: ${ counts.map( ( n, i ) => `L${ i } ${ n.toLocaleString() }` ).join( ' · ' ) }`;
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

			hud.innerHTML =
				`${ fpsAvg.toFixed( 0 ) } fps · cpu ${ cpuAvg.toFixed( 2 ) } ms<br>` +
				gpuLine +
				`${ statsLine }<br>` +
				`${ lodCount } draw calls · 2 compute dispatches · tile ${ config.terrain.tileSize } m` +
				( hasFirstInstance ? '' : ' · <b>fallback: no indirect-first-instance</b>' );

		}

	} );

}
