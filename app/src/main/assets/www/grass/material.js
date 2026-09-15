// Blade geometry (generated, never a model) and the single material every LOD
// mesh shares. The material recovers its LOD from the firstInstance trick
// ( lod = instanceIndex / system.count ) and shades fully analytically. A
// per-vertex roll curls each blade
// (weighted by height², seeded per blade), colour and height vary in spatial
// patches, and lighting is a warm sun + hemisphere rig with grazing sheen,
// backlight transmission, rim/root occlusion and proximity AO near the player.

import * as THREE from 'three/webgpu';
import {
	Fn, storage, texture, instanceIndex, uniform, varying, bitcast,
	float, int, uint, vec2, vec3, vec4,
	abs, min, max, clamp, mix, step, smoothstep,
	sin, cos, sqrt, length, dot, normalize, pow, exp, select, fract,
	positionGeometry, positionWorld, cameraPosition,
} from 'three/tsl';

import { config, BLADE_HEIGHT, BLADE_WIDTH } from './config.js';
import { hash01, unpackScale, unpackBendX, unpackBendZ } from './blades.js';

const srgb = ( [ r, g, b ] ) => new THREE.Color().setRGB( r, g, b, THREE.SRGBColorSpace );

// single-apex blade strip: side in x (−1/+1), height fraction in y
export function makeBladeGeometry( segments, instanceCount ) {

	const vertexCount = segments * 2 + 1;
	const positions = new Float32Array( vertexCount * 3 );

	for ( let r = 0; r < segments; r ++ ) {

		const h = r / segments;
		positions.set( [ - 1, h, 0 ], r * 6 );
		positions.set( [ 1, h, 0 ], r * 6 + 3 );

	}

	positions.set( [ 0, 1, 0 ], segments * 6 ); // apex vertex, not a quad

	const indices = new Uint16Array( ( segments - 1 ) * 6 + 3 );
	let o = 0;

	for ( let r = 0; r < segments - 1; r ++ ) {

		const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
		indices.set( [ a, b, c, b, d, c ], o );
		o += 6;

	}

	indices.set( [ segments * 2 - 2, segments * 2 - 1, segments * 2 ], o );

	const geo = new THREE.InstancedBufferGeometry();
	geo.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geo.setIndex( new THREE.BufferAttribute( indices, 1 ) );
	geo.instanceCount = instanceCount;
	geo.boundingSphere = new THREE.Sphere( new THREE.Vector3(), 1e6 );

	return geo;

}

export function makeBladeMaterial( system, sky, lodCount ) {

	const u = system.u;
	const cc = config.color;
	const cl = config.lighting;

	const mu = {
		debugTint: uniform( 0 ),

		baseColorDark: uniform( srgb( cc.baseDark ) ),
		baseColor: uniform( srgb( cc.base ) ),
		tipColor: uniform( srgb( cc.tip ) ),
		warmColor: uniform( srgb( cc.warm ) ),
		rustColor: uniform( srgb( cc.rust ) ),
		tipMixFactor: uniform( cc.tipMixFactor ),
		variationStrength: uniform( cc.variationStrength ),
		warmStrength: uniform( cc.warmStrength ),
		rustStrength: uniform( cc.rustStrength ),

		sunRadiance: uniform( srgb( cl.sunColor ).multiplyScalar( cl.sunIntensity ) ),
		sunColor: uniform( srgb( cl.sunColor ) ),
		moonRadiance: uniform( new THREE.Color( 0, 0, 0 ) ),
		hemiSky: uniform( srgb( cl.hemiSky ) ),
		hemiGround: uniform( srgb( cl.hemiGround ) ),
		hemiIntensity: uniform( cl.hemiIntensity ),
		bakedShadowBrightness: uniform( cl.bakedShadowBrightness ),
		diffuseContrast: uniform( cl.diffuseContrast ),
		exposure: uniform( cl.exposure ),
		highlightStrength: uniform( cl.highlightStrength ),
		backlightStrength: uniform( cl.backlightStrength ),
		rootSkyVisibility: uniform( cl.rootSkyVisibility ),
		fogColor: uniform( srgb( cl.fogColor ) ),
		fogDensity: uniform( cl.fogDensity ),

		aoScale: uniform( config.ao.scale ),
		aoRimSmoothness: uniform( config.ao.rimSmoothness ),
		aoRadiusSq: uniform( config.ao.radius ** 2 ),

		rotationRandomness: uniform( config.blade.rotationRandomness ),
		baseBending: uniform( config.wind.baseBending ),
		bendControlPoint: uniform( config.wind.bendControlPoint ),
		bendDrop: uniform( config.wind.bendDrop ),
		widthFarGain: uniform( config.blade.widthGainFar ),
	};

	const material = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );
	material.precision = 'lowp';
	material.transparent = false;
	material.forceSinglePass = true;
	material.stencilWrite = false;

	const visS = storage( system.visibleIndices, 'uint', system.count * lodCount ).toReadOnly();
	const stateS = storage( system.bladeState, 'vec4', system.count ).toReadOnly();
	const terrainS = storage( system.bladeTerrain, 'float', system.count ).toReadOnly();

	// shared per-instance nodes — built once, reused by position and varyings
	const lodIdx = lodCount === 3 ? instanceIndex.div( uint( system.count ) ) : uint( 0 );
	const bladeIndex = visS.element( instanceIndex ).toVar( 'bladeIndex' );
	const state = stateS.element( bladeIndex );

	const zBits = bitcast( state.z, 'uint' );
	const wBits = bitcast( state.w, 'uint' );
	const tBits = bitcast( terrainS.element( bladeIndex ), 'uint' );

	const scale = unpackScale( wBits );
	const bend = vec2( unpackBendX( zBits ), unpackBendZ( zBits ) );
	const offsetY = float( tBits.shiftRight( uint( 4 ) ).bitAnd( uint( 65535 ) ) ).div( 65535.0 ).mul( u.heightMax );
	const posNoise = float( tBits.bitAnd( uint( 15 ) ) ).div( 15.0 );
	const bakedShadow = float( tBits.shiftRight( uint( 20 ) ).bitAnd( uint( 15 ) ) ).div( 15.0 );

	const bladeHash = hash01( bladeIndex );

	const rootLocal = vec3( state.x, offsetY, state.y );
	const rootWorld = rootLocal.add( vec3( u.playerXZ.x, 0.0, u.playerXZ.y ) );

	const side = positionGeometry.x;
	const h = positionGeometry.y;
	const bendWeight = h.mul( h );

	// cylindrical billboard basis
	const toCam = rootWorld.sub( cameraPosition );
	const right = normalize( vec3( toCam.z, 0.0, toCam.x.negate() ) );

	const d2 = dot( toCam, toCam );
	const toTrample = rootWorld.xz.sub( u.tramplePos );
	const playerD2 = dot( toTrample, toTrample ); // player distance (== tile offset when the tile follows the player)

	// width: flare-and-taper profile, per-blade variation, far anti-alias gain
	const widthGain = mix( 1.0, mu.widthFarGain,
		smoothstep( config.blade.widthGainNear ** 2, config.blade.widthGainFarD ** 2, d2 ) );
	const widthVariation = posNoise.add( 0.5 );
	const widthProfile = min( 1.0, h.div( 0.26 ).mul( 0.72 ).add( 0.28 ) ).mul( pow( float( 1.0 ).sub( h ), 1.22 ) );
	const halfWidth = widthProfile.mul( BLADE_WIDTH * 0.5 ).mul( widthVariation ).mul( scale ).mul( widthGain );

	// per-vertex roll — random sprite rotation plus a height²-weighted curl, so
	// every blade bows differently instead of standing straight
	const instanceNoise = bladeHash.mul( 0.25 ).sub( 0.125 );
	const spriteNoise = fract( bladeHash.mul( 31.7 ) ).mul( 2.0 ).sub( 1.0 );
	const roll = spriteNoise.mul( mu.rotationRandomness )
		.add( posNoise.sub( 0.5 ).mul( 0.25 ).add( instanceNoise ).mul( bendWeight ).mul( mu.baseBending ) );

	const bladeLen = max( scale.mul( BLADE_HEIGHT ), 1e-3 );
	const px = side.mul( halfWidth );
	const py = h.mul( bladeLen );
	const cr = cos( roll ), sr = sin( roll );
	const rx = px.mul( cr ).sub( py.mul( sr ) );
	const ry = px.mul( sr ).add( py.mul( cr ) );

	// wind/trail bend along the blade; tip pulls down as it leans
	const bendShape = mu.bendControlPoint.mul( 2.0 ).mul( h ).mul( float( 1.0 ).sub( h ) ).add( bendWeight );
	const bendDrop = dot( bend, bend ).div( scale.mul( BLADE_HEIGHT * 2 ) ).mul( mu.bendDrop );
	const bendOffset = vec3( bend.x, bendDrop.negate(), bend.y ).mul( bendShape );

	material.positionNode = rootLocal
		.add( right.mul( rx ) )
		.add( vec3( bendOffset.x, ry.add( bendOffset.y ), bendOffset.z ) );

	// resting normal from a per-blade hash angle
	const bladeAngle = fract( bladeHash.mul( 53.3 ) ).mul( 6.28318 );
	const restingNormal = vec3( cos( bladeAngle ), 0.0, sin( bladeAngle ) );

	// ---- vertex-stage lighting shared through varyings

	const L = sky.sunDir; // pointing toward the sun
	const viewDirection = normalize( cameraPosition.sub( rootWorld ) );

	const twoSidedNdotL = abs( dot( restingNormal, L ) );
	const grazing = float( 1.0 ).sub( clamp( abs( dot( restingNormal, viewDirection ) ), 0.0, 1.0 ) );
	const localBacklight = clamp( dot( restingNormal, L ).negate(), 0.0, 1.0 );
	const viewSunAlignment = clamp(
		normalize( viewDirection.xz ).dot( normalize( L.xz ).negate() ).mul( 0.5 ).add( 0.5 ), 0.0, 1.0 );

	const diffuseFacing = mix( 0.65, twoSidedNdotL, mu.diffuseContrast );
	const sunDiffuse = mu.sunRadiance.mul( mix( 0.35, 1.0, diffuseFacing ) );
	const skyVisibility = mix( mu.rootSkyVisibility, 1.0, h );
	const hemisphere = mix( mu.hemiGround, mu.hemiSky, skyVisibility.mul( 0.5 ) ).mul( mu.hemiIntensity );

	// A second key, for whoever is up when the sun is not. `moonRadiance` is
	// black unless a composing scene drives it, so the standalone field is
	// untouched — but a night meadow lit by hemisphere alone is a flat black
	// mass, and grass at 5% albedo has no other light to fall back on. It gets
	// no sheen and no transmission: those are the sun's, and at this level they
	// would be inventing light that is not there.
	const M = sky.moonDir || vec3( 0.0, 1.0, 0.0 );
	const moonFacing = mix( 0.65, abs( dot( restingNormal, M ) ), mu.diffuseContrast );
	const moonDiffuse = mu.moonRadiance.mul( mix( 0.35, 1.0, moonFacing ) );

	// proximity AO — contact darkening only where you can see it
	const proximityMask = float( 1.0 ).sub( smoothstep( 0.0, mu.aoRadiusSq, playerD2 ) );

	// a composed scene can hand us the terrain's own cast-shadow map: when a
	// ridge shadow sweeps the meadow at golden hour the blades have to go out
	// with the ground under them, or the field floats
	const terrainLit = sky.shadowTex
		? texture( sky.shadowTex, rootWorld.xz.div( sky.terrainScale ) ).level( 0 ).x
		: float( 1.0 );

	const vSunLit = varying( terrainLit );
	const vLighting = varying( hemisphere.add( sunDiffuse.mul( terrainLit ) ).add( moonDiffuse ).mul( mu.exposure ) );
	const vGrazing = varying( grazing );
	const vBacklight = varying( localBacklight );
	const vAlignment = varying( viewSunAlignment );
	const vProximityAo = varying( mu.aoScale.mul( 0.25 ).mul( proximityMask ) );
	const vShadow = varying( mix( mu.bakedShadowBrightness, 1.0, bakedShadow ) );
	const vH = varying( h );
	const vSide = varying( side );
	const vPosNoise = varying( posNoise );
	const vLod = varying( float( lodIdx ) );

	// spatial colour patches (positionNoise is terrain noise, not a hash)
	const colorVariation = mix( 1.0, posNoise, mu.variationStrength );
	const green = mix( mu.baseColorDark, mu.baseColor, colorVariation );
	const rustMask = posNoise.mul( float( 1.0 ).sub( posNoise ) ).mul( 4.0 ).mul( mu.rustStrength );
	const warmMask = clamp( posNoise.sub( 0.6 ).mul( 2.5 ), 0.0, 1.0 ).mul( mu.warmStrength );
	const vBladeColor = varying( mix( mix( green, mu.rustColor, rustMask ), mu.warmColor, warmMask ) );

	material.colorNode = Fn( () => {

		const albedo = mix( vBladeColor, mu.tipColor, smoothstep( 0.25, 1.0, vH ).mul( mu.tipMixFactor ) );

		// occlusion: blade rim × root, scaled by player proximity
		const edgeDistance = abs( vSide );
		const edgeMask = smoothstep( mu.aoRimSmoothness.negate(), mu.aoRimSmoothness, edgeDistance );
		const rootMask = float( 1.0 ).sub( smoothstep( 0.1, 0.85, vH ) );
		const occlusion = float( 1.0 ).sub( vProximityAo.mul( edgeMask ).mul( rootMask ) );

		const detailStrength = smoothstep( 0.1, 0.9, vH ).mul( vShadow ).mul( vSunLit );

		const grazingSheen = vGrazing.mul( vGrazing )
			.mul( mix( 0.25, 1.0, vAlignment ) )
			.mul( mu.highlightStrength );

		const transmission = vAlignment
			.mul( mix( 0.35, 1.0, vBacklight ) )
			.mul( mu.backlightStrength );

		const diffuseColor = albedo.mul( vShadow ).mul( occlusion ).mul( vLighting );
		const sheenColor = mu.sunRadiance.mul( grazingSheen.mul( detailStrength ) );
		const transmittedColor = mix( albedo, mu.sunColor, 0.55 ).mul( transmission.mul( detailStrength ) );

		const shaded = diffuseColor.add( sheenColor ).add( transmittedColor ).toVar();

		// exponential-squared fog toward a warm haze
		const dCam = length( positionWorld.sub( cameraPosition ) );
		const fogAmount = float( 1.0 ).sub( exp( dCam.mul( mu.fogDensity ).pow( 2 ).negate() ) );
		shaded.assign( mix( shaded, mu.fogColor, fogAmount ) );

		// LOD debug tint
		const tint = mix(
			mix( vec3( 0.1, 0.9, 0.2 ), vec3( 0.95, 0.8, 0.1 ), clamp( vLod, 0.0, 1.0 ) ),
			vec3( 0.9, 0.15, 0.1 ), clamp( vLod.sub( 1.0 ), 0.0, 1.0 ) );

		return mix( shaded, tint, mu.debugTint.mul( 0.85 ) );

	} )();

	return { material, uniforms: mu, debugTintU: mu.debugTint };

}
