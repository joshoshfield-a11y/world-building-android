// Boot sequence: WebGPU check → FFT correctness gate (blocks rendering on
// failure) → initial spectrum bake → render loop. The debug panel is bound to
// the single config object; spectrum-shaping edits re-bake h₀ on the GPU.

import * as THREE from 'three/webgpu';
import { positionWorldDirection } from 'three/tsl';
import { OrbitControls } from '../vendor/OrbitControls.js';
import GUI from 'lil-gui';

import { uniform } from 'three/tsl';

import { config } from './config.js';
import { OceanSim } from './sim.js';
import { makeAtmosphere } from '../sky/atmosphere.js';
import { makeOceanSurface } from './surface.js';

const hud = document.getElementById( 'hud' );

function showOverlay( title, message ) {

	const el = document.getElementById( 'overlay' );
	el.innerHTML = `<h1>${ title }</h1><p>${ message }</p>`;
	el.style.display = 'grid';

}

init().catch( ( err ) => {

	console.error( err );
	showOverlay( 'Ocean failed to start', err.message );

} );

async function init() {

	if ( ! navigator.gpu ) {

		throw new Error( 'This scene needs WebGPU. Use Chrome / Edge 113+, or Safari 18+ with WebGPU enabled.' );

	}

	const renderer = new THREE.WebGPURenderer( { antialias: true, trackTimestamp: true } );
	renderer.setPixelRatio( Math.min( window.devicePixelRatio, 1.5 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = config.atmosphere.exposure;
	document.body.appendChild( renderer.domElement );

	await renderer.init();

	// ---- simulation + mandatory FFT correctness gate (before anything renders)

	const sim = new OceanSim( config );

	const gate = await sim.validateFFT( renderer );

	for ( const r of gate.results ) {

		console[ r.pass ? 'info' : 'error' ]( `[FFT gate] ${ r.name } — max error ${ r.maxErr.toExponential( 2 ) } — ${ r.pass ? 'PASS' : 'FAIL' }` );

	}

	if ( ! gate.pass ) {

		showOverlay( 'FFT validation failed', gate.results.map( r =>
			`${ r.name }: max error ${ r.maxErr.toExponential( 2 ) }` ).join( '<br>' ) );
		throw new Error( 'FFT validation gate failed — refusing to start.' );

	}

	sim.computeInitialSpectrum( renderer );

	// ---- scene

	const scene = new THREE.Scene();

	const camera = new THREE.PerspectiveCamera( 55, window.innerWidth / window.innerHeight, 0.5, 9000 );
	camera.position.set( - 42, 18, - 52 );

	const controls = new OrbitControls( camera, renderer.domElement );
	controls.target.set( 0, 1, 0 );
	controls.minDistance = 5;
	controls.maxDistance = 1600;
	controls.enablePan = false; // vertex density is centred on the origin
	controls.enableDamping = true;

	// pitch freely up to the zenith (moon, stars) — the polar clamp is derived
	// from the orbit radius so the camera never dips into the waves
	function clampAboveSea() {

		const r = camera.position.distanceTo( controls.target );
		const c = THREE.MathUtils.clamp( ( 4 - controls.target.y ) / Math.max( r, 0.001 ), - 1, 1 );
		controls.maxPolarAngle = Math.acos( c );

	}

	// the full day-night atmosphere (shared with the sky scene); the water reads
	// it through a slim adapter — reflections, sun direction and a scalar light
	// level that darkens the water body at night
	const atmosphere = makeAtmosphere( config );
	atmosphere.setTime( config.time.hour );
	scene.backgroundNode = atmosphere.background( positionWorldDirection );

	const sky = {
		sample: atmosphere.sample,
		inscatter: atmosphere.inscatter,
		distantSea: atmosphere.distantSea,
		aerial: atmosphere.aerial,
		sunDir: atmosphere.uniforms.sunDir,
		sunColor: atmosphere.uniforms.sunColor,
		bodyLight: uniform( 1 ),
		moonDir: atmosphere.uniforms.moonDir,
		moonLight: uniform( new THREE.Color( 0, 0, 0 ) ),
	};

	const syncBodyLight = () => {

		const s = atmosphere.uniforms.sunDir.value;
		const m = atmosphere.uniforms.moonDir.value;
		const dayF = THREE.MathUtils.smoothstep( s.y, - 0.06, 0.18 );
		const illum = ( 1 - s.dot( m ) ) * 0.5;
		const moonF = THREE.MathUtils.smoothstep( m.y, 0.0, 0.3 ) * illum;
		sky.bodyLight.value = 0.035 + 0.965 * dayF + 0.16 * moonF * ( 1 - dayF );
		sky.moonLight.value.copy( atmosphere.uniforms.moonColor.value )
			.multiplyScalar( moonF * ( 1 - dayF ) * config.moon.seaGlint );

	};

	syncBodyLight();

	const surface = makeOceanSurface( sim, sky, config );
	scene.add( surface.mesh );

	// ---- debug panel

	const gui = new GUI( { title: 'ocean' } );

	const rebake = () => sim.computeInitialSpectrum( renderer );

	const fWaves = gui.addFolder( 'waves' );
	fWaves.add( config.waves, 'lambda', 0, 2, 0.01 ).name( 'choppiness λ' );
	fWaves.add( config.waves, 'depth', 5, 2000, 1 ).onChange( rebake );

	for ( const [ key, label ] of [ [ 'local', 'wind sea' ], [ 'swell', 'swell' ] ] ) {

		const f = fWaves.addFolder( label );
		f.add( config.waves[ key ], 'scale', 0, 2, 0.01 ).onChange( rebake );
		f.add( config.waves[ key ], 'windSpeed', 0.1, 40, 0.1 ).onChange( rebake );
		f.add( config.waves[ key ], 'windDirection', 0, 360, 1 ).onChange( rebake );
		f.add( config.waves[ key ], 'fetch', 1000, 1000000, 1000 ).onChange( rebake );
		f.add( config.waves[ key ], 'spreadBlend', 0, 1, 0.01 ).onChange( rebake );
		f.add( config.waves[ key ], 'swell', 0, 1, 0.01 ).onChange( rebake );
		f.add( config.waves[ key ], 'peakEnhancement', 1, 10, 0.1 ).onChange( rebake );
		f.add( config.waves[ key ], 'shortWavesFade', 0, 0.1, 0.001 ).onChange( rebake );
		if ( key === 'swell' ) f.close();

	}

	const fFoam = gui.addFolder( 'foam' );
	fFoam.add( config.foam, 'threshold', - 1, 1, 0.01 ).onChange( v => surface.uniforms.foamThreshold.value = v );
	fFoam.add( config.foam, 'scale', 0, 10, 0.1 ).onChange( v => surface.uniforms.foamScale.value = v );
	fFoam.add( config.foam, 'decay', 0, 5, 0.01 );

	const fShade = gui.addFolder( 'shading' );
	fShade.addColor( config.shading, 'deepColor' ).onChange( v => surface.uniforms.deepColor.value.set( v ) );
	fShade.addColor( config.shading, 'scatterColor' ).onChange( v => surface.uniforms.scatterColor.value.set( v ) );
	fShade.addColor( config.shading, 'foamColor' ).onChange( v => surface.uniforms.foamColor.value.set( v ) );
	fShade.add( config.shading, 'detail', 0, 0.5, 0.005 ).onChange( v => surface.uniforms.detail.value = v );
	fShade.add( config.shading, 'sssStrength', 0, 2, 0.01 ).onChange( v => surface.uniforms.sssStrength.value = v );

	const applyTime = () => { atmosphere.setTime( config.time.hour ); syncBodyLight(); };

	const fTime = gui.addFolder( 'time' );
	const hourCtrl = fTime.add( config.time, 'hour', 0, 24, 0.01 ).onChange( applyTime ).listen();
	fTime.add( config.time, 'autoPlay' ).name( 'auto cycle' );
	fTime.add( config.time, 'speed', 0.005, 1, 0.005 ).name( 'hours / second' );

	const fAtmos = gui.addFolder( 'atmosphere' );
	fAtmos.add( config.atmosphere, 'turbidity', 1, 12, 0.1 ).onChange( () => atmosphere.syncConfig() );
	fAtmos.add( config.atmosphere, 'rayleigh', 0.2, 4, 0.05 ).onChange( () => atmosphere.syncConfig() );
	fAtmos.add( config.atmosphere, 'mieCoefficient', 0.0005, 0.05, 0.0005 ).onChange( () => atmosphere.syncConfig() );
	fAtmos.add( config.atmosphere, 'exposure', 0.2, 2, 0.01 ).onChange( v => renderer.toneMappingExposure = v );
	fAtmos.add( config.moon, 'offsetHours', 0, 24, 0.1 ).name( 'moon phase (h)' ).onChange( applyTime );
	fAtmos.close();

	const fSim = gui.addFolder( 'sim' );
	fSim.add( config.sim, 'timeScale', 0, 3, 0.01 );
	fSim.add( config.sim, 'paused' );

	// lambda is read by the assembly pass each frame
	fWaves.controllers.find( c => c.property === 'lambda' ).onChange( v => sim.lambdaU.value = v );
	fFoam.controllers.find( c => c.property === 'decay' ).onChange( v => sim.foamDecayU.value = v );

	// console handle for poking the sim while debugging
	window.__ocean = { config, sim, renderer, rebake, camera, controls, atmosphere, applyTime };

	// ---- resize + loop

	window.addEventListener( 'resize', () => {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );

	} );

	const clock = new THREE.Clock();
	let frame = 0;
	let cpuAvg = 0, fpsAvg = 0;

	renderer.setAnimationLoop( async () => {

		const dt = Math.min( clock.getDelta(), 1 / 30 );
		const t0 = performance.now();

		if ( controls.enabled ) {

			clampAboveSea();
			controls.update();

		}

		surface.follow( camera.position.x, camera.position.z );

		if ( config.time.autoPlay ) {

			config.time.hour = ( config.time.hour + dt * config.time.speed ) % 24;
			atmosphere.setTime( config.time.hour );
			syncBodyLight();
			hourCtrl.updateDisplay();

		}

		atmosphere.uniforms.time.value += dt;

		atmosphere.update( renderer ); // re-march the scattering LUT if the sun moved

		if ( ! config.sim.paused ) sim.update( renderer, dt * config.sim.timeScale );

		renderer.render( scene, camera );

		const cpu = performance.now() - t0;
		cpuAvg += ( cpu - cpuAvg ) * 0.05;
		fpsAvg += ( 1 / Math.max( dt, 1e-4 ) - fpsAvg ) * 0.05;

		frame ++;

		if ( frame % 30 === 0 ) {

			let gpuLine = '';

			try {

				await renderer.resolveTimestampsAsync( 'compute' );
				await renderer.resolveTimestampsAsync( 'render' );
				const c = renderer.info.compute.timestamp;
				const r = renderer.info.render.timestamp;
				if ( c || r ) gpuLine = `gpu compute ${ c.toFixed( 2 ) } ms · gpu render ${ r.toFixed( 2 ) } ms<br>`;

			} catch ( e ) { /* timestamp-query unsupported */ }

			const hh = Math.floor( config.time.hour );
			const mm = Math.floor( ( config.time.hour - hh ) * 60 );

			hud.innerHTML =
				`${ String( hh ).padStart( 2, '0' ) }:${ String( mm ).padStart( 2, '0' ) } · ${ fpsAvg.toFixed( 0 ) } fps · cpu ${ cpuAvg.toFixed( 2 ) } ms<br>` +
				gpuLine +
				`3 cascades @ ${ sim.size }² · ${ config.sim.lengthScales.join( ' / ' ) } m patches · 18 compute submits/frame<br>` +
				`FFT gate: PASS (${ gate.results.map( r => r.maxErr.toExponential( 1 ) ).join( ', ' ) })`;

		}

	} );

}
