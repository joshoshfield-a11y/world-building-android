// Boot: WebGPU check → atmosphere as the scene background + a still mirror
// lake that reflects the same function. One hour slider drives the whole
// day-night cycle; sun and moon ride their arcs, the moon's phase follows
// from where the sun actually is.

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, float, vec2, vec3,
	positionWorldDirection, positionWorld, cameraPosition,
	normalize, dot, reflect, pow, mix, max, sin, length, smoothstep,
} from 'three/tsl';
import { OrbitControls } from '../vendor/OrbitControls.js';
import GUI from 'lil-gui';

import { config } from './config.js';
import { makeAtmosphere } from './atmosphere.js';

const hud = document.getElementById( 'hud' );

function showOverlay( title, message ) {

	const el = document.getElementById( 'overlay' );
	el.innerHTML = `<h1>${ title }</h1><p>${ message }</p>`;
	el.style.display = 'grid';

}

init().catch( ( err ) => {

	console.error( err );
	showOverlay( 'Sky failed to start', err.message );

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

	// ---- scene

	const scene = new THREE.Scene();

	const atmosphere = makeAtmosphere( config );
	atmosphere.setTime( config.time.hour );
	scene.backgroundNode = atmosphere.background( positionWorldDirection );

	// still mirror lake — reflects the identical sky function
	const rippleU = uniform( config.water.ripple );
	const timeU = atmosphere.uniforms.time;

	const lakeMat = new THREE.MeshBasicNodeMaterial();

	lakeMat.colorNode = Fn( () => {

		const pos = positionWorld;
		const V = normalize( pos.sub( cameraPosition ) );

		// gentle analytic ripple
		const nx = sin( pos.x.mul( 0.11 ).add( timeU.mul( 0.70 ) ) )
			.add( sin( pos.x.mul( 0.041 ).sub( timeU.mul( 0.31 ) ) ).mul( 0.7 ) )
			.add( sin( pos.z.mul( 0.067 ).add( timeU.mul( 0.23 ) ) ).mul( 0.5 ) );
		const nz = sin( pos.z.mul( 0.093 ).add( timeU.mul( 0.53 ) ) )
			.add( sin( pos.z.mul( 0.037 ).add( timeU.mul( 0.41 ) ) ).mul( 0.7 ) )
			.add( sin( pos.x.mul( 0.052 ).sub( timeU.mul( 0.19 ) ) ).mul( 0.5 ) );

		// ripple lives near the camera; far water settles to a true mirror so the
		// regular sine pattern can never band at grazing angles
		const rippleFalloff = float( 1.0 ).div( length( pos.xz.sub( cameraPosition.xz ) ).mul( 0.007 ).add( 1.0 ) );
		const N = normalize( vec3( nx.mul( rippleU ).mul( rippleFalloff ), 1.0, nz.mul( rippleU ).mul( rippleFalloff ) ) );

		const R = reflect( V, N ).toVar();
		R.y.assign( max( R.y.abs(), 0.012 ) );

		const reflection = atmosphere.sample( R );
		const fresnel = pow( float( 1.0 ).sub( max( dot( N, V.negate() ), 0.0 ) ), 5.0 ).mul( 0.96 ).add( 0.04 );

		const body = vec3( 0.004, 0.009, 0.013 );
		const water = mix( body, reflection.mul( 0.94 ), fresnel ).toVar();

		// let the far quad edge dissolve into the sky along the view ray
		const fade = smoothstep( 5000.0, 10500.0, length( pos.xz.sub( cameraPosition.xz ) ) );
		return mix( water, atmosphere.sample( V ), fade );

	} )();

	const lakeGeo = new THREE.PlaneGeometry( 24000, 24000 );
	lakeGeo.rotateX( - Math.PI / 2 );
	const lake = new THREE.Mesh( lakeGeo, lakeMat );
	lake.frustumCulled = false;
	scene.add( lake );

	// ---- camera

	const camera = new THREE.PerspectiveCamera( 60, window.innerWidth / window.innerHeight, 0.5, 30000 );
	camera.position.set( 46, 7, 9 ); // faces the default-hour sunset

	const controls = new OrbitControls( camera, renderer.domElement );
	controls.target.set( 0, 9, 0 );
	controls.minDistance = 4;
	controls.maxDistance = 400;
	controls.enablePan = false;
	controls.enableDamping = true;

	// let the camera pitch all the way up to the zenith, limited only by the
	// water: the polar clamp is recomputed from the current radius so the
	// camera can never dip below the lake
	function clampToLake() {

		const r = camera.position.distanceTo( controls.target );
		const c = THREE.MathUtils.clamp( ( 0.8 - controls.target.y ) / Math.max( r, 0.001 ), - 1, 1 );
		controls.maxPolarAngle = Math.acos( c );

	}

	// ---- GUI

	const gui = new GUI( { title: 'sky' } );

	const applyAtmos = () => atmosphere.syncConfig();
	const applyTime = () => atmosphere.setTime( config.time.hour );

	const fTime = gui.addFolder( 'time' );
	const hourCtrl = fTime.add( config.time, 'hour', 0, 24, 0.01 ).onChange( applyTime ).listen();
	fTime.add( config.time, 'autoPlay' ).name( 'auto cycle' );
	fTime.add( config.time, 'speed', 0.005, 1, 0.005 ).name( 'hours / second' );

	const fSky = gui.addFolder( 'atmosphere' );
	fSky.add( config.atmosphere, 'turbidity', 1, 12, 0.1 ).onChange( applyAtmos );
	fSky.add( config.atmosphere, 'rayleigh', 0.2, 4, 0.05 ).onChange( applyAtmos );
	fSky.add( config.atmosphere, 'mieCoefficient', 0.0005, 0.05, 0.0005 ).onChange( applyAtmos );
	fSky.add( config.atmosphere, 'mieDirectionalG', 0.5, 0.99, 0.01 ).onChange( applyAtmos );
	fSky.add( config.atmosphere, 'exposure', 0.2, 2, 0.01 ).onChange( v => renderer.toneMappingExposure = v );
	fSky.add( config.sun, 'maxElevation', 15, 88, 1 ).name( 'solar noon alt.' ).onChange( applyTime );

	const fMoon = gui.addFolder( 'moon' );
	fMoon.add( config.moon, 'offsetHours', 0, 24, 0.1 ).name( 'phase offset (h)' ).onChange( applyTime );
	fMoon.add( config.moon, 'angularRadius', 0.26, 3, 0.02 ).name( 'apparent size°' ).onChange( applyAtmos );
	fMoon.add( config.moon, 'brightness', 0, 3, 0.05 ).onChange( applyAtmos );
	fMoon.add( config.moon, 'maxElevation', 15, 85, 1 ).onChange( applyTime );

	const fStars = gui.addFolder( 'stars' );
	fStars.add( config.stars, 'density', 0.97, 0.999, 0.0005 ).name( 'sparsity' ).onChange( applyAtmos );
	fStars.add( config.stars, 'brightness', 0, 3, 0.05 ).onChange( applyAtmos );

	gui.add( config.water, 'ripple', 0, 0.15, 0.002 ).name( 'lake ripple' ).onChange( v => rippleU.value = v );

	window.__sky = { config, atmosphere, renderer, camera, controls };

	// ---- loop

	window.addEventListener( 'resize', () => {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );

	} );

	const clock = new THREE.Clock();
	let frame = 0, t = 0;
	let fpsAvg = 0;
	let gpuLine = '';

	renderer.setAnimationLoop( async () => {

		const dt = Math.min( clock.getDelta(), 1 / 30 );
		t += dt;

		if ( controls.enabled ) {

			clampToLake();
			controls.update();

		}

		if ( config.time.autoPlay ) {

			config.time.hour = ( config.time.hour + dt * config.time.speed ) % 24;
			atmosphere.setTime( config.time.hour );
			hourCtrl.updateDisplay();

		}

		atmosphere.uniforms.time.value = t;

		atmosphere.update( renderer ); // re-march the scattering LUT if the sun moved

		renderer.render( scene, camera );

		fpsAvg += ( 1 / Math.max( dt, 1e-4 ) - fpsAvg ) * 0.05;
		frame ++;

		if ( frame % 30 === 0 ) {

			try {

				await renderer.resolveTimestampsAsync( 'render' );
				const r = renderer.info.render.timestamp;
				if ( r ) gpuLine = ` · gpu ${ r.toFixed( 2 ) } ms`;

			} catch ( e ) { /* unsupported */ }

			const h = Math.floor( config.time.hour );
			const m = Math.floor( ( config.time.hour - h ) * 60 );
			const sunEl = Math.asin( atmosphere.uniforms.sunDir.value.y ) * 180 / Math.PI;
			const moonEl = Math.asin( atmosphere.uniforms.moonDir.value.y ) * 180 / Math.PI;
			const s = atmosphere.uniforms.sunDir.value, mn = atmosphere.uniforms.moonDir.value;
			const illum = Math.round( ( 1 - s.dot( mn ) ) * 50 );

			hud.innerHTML =
				`${ String( h ).padStart( 2, '0' ) }:${ String( m ).padStart( 2, '0' ) } · ${ fpsAvg.toFixed( 0 ) } fps${ gpuLine }<br>` +
				`sun ${ sunEl.toFixed( 1 ) }° · moon ${ moonEl.toFixed( 1 ) }° (${ illum }% lit)<br>` +
				`ray-marched Rayleigh+Mie · earth-shadowed twilight · geometric moon phase`;

		}

	} );

}
