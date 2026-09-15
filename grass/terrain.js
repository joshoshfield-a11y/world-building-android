// Terrain — one tileable heightmap baked once on the CPU into a half-float
// RGBA texture ( R height, G grass density, B baked shadow, A position noise ),
// a CPU-side bilinear sampler for the player controller, and the ground mesh
// that reads the same texture so grass roots and soil always agree.

import * as THREE from 'three/webgpu';
import {
	Fn, texture, uniform, varying,
	float, vec2, vec3, vec4,
	positionGeometry, positionWorld, cameraPosition,
	normalize, dot, mix, pow, smoothstep, length, max, exp,
} from 'three/tsl';

const SIZE = 512;

// periodic value noise (wrapping lattice, smoothstep interpolation)
export function makeOctave( lattice, seedFn ) {

	const grid = new Float32Array( lattice * lattice );
	for ( let i = 0; i < grid.length; i ++ ) grid[ i ] = seedFn();

	return ( u, v ) => {

		const x = ( ( u % 1 ) + 1 ) % 1 * lattice;
		const y = ( ( v % 1 ) + 1 ) % 1 * lattice;
		const x0 = Math.floor( x ) % lattice, y0 = Math.floor( y ) % lattice;
		const x1 = ( x0 + 1 ) % lattice, y1 = ( y0 + 1 ) % lattice;
		let fx = x - Math.floor( x ), fy = y - Math.floor( y );
		fx = fx * fx * ( 3 - 2 * fx ); fy = fy * fy * ( 3 - 2 * fy );
		const a = grid[ y0 * lattice + x0 ], b = grid[ y0 * lattice + x1 ];
		const c = grid[ y1 * lattice + x0 ], d = grid[ y1 * lattice + x1 ];
		return a + ( b - a ) * fx + ( c + ( d - c ) * fx - ( a + ( b - a ) * fx ) ) * fy;

	};

}

export function makeTerrain( config ) {

	let seed = 42;
	const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;

	const h1 = makeOctave( 6, rand ), h2 = makeOctave( 13, rand ), h3 = makeOctave( 29, rand );
	const d1 = makeOctave( 9, rand ), d2 = makeOctave( 21, rand );
	const s1 = makeOctave( 7, rand );
	const p1 = makeOctave( 17, rand );

	const height = new Float32Array( SIZE * SIZE );          // 0..1
	const half = new Uint16Array( SIZE * SIZE * 4 );
	const toHalf = THREE.DataUtils.toHalfFloat;

	for ( let y = 0; y < SIZE; y ++ ) {

		for ( let x = 0; x < SIZE; x ++ ) {

			const u = x / SIZE, v = y / SIZE;

			const h = 0.62 * h1( u, v ) + 0.28 * h2( u, v ) + 0.10 * h3( u, v );
			height[ y * SIZE + x ] = h;

			// density: rolling patches, thinning to bare soil in the low spots —
			// wide transition band so bald patches get a rim of shortening grass
			let den = 0.55 * d1( u, v ) + 0.45 * d2( u, v );
			den = Math.min( 1, Math.max( 0, ( den - 0.26 ) * 1.9 ) );

			// baked shadow: broad soft darkening
			const sh = 0.62 + 0.38 * Math.min( 1, s1( u, v ) * 1.6 );

			const i = ( y * SIZE + x ) * 4;
			half[ i ] = toHalf( h );
			half[ i + 1 ] = toHalf( den );
			half[ i + 2 ] = toHalf( sh );
			half[ i + 3 ] = toHalf( p1( u, v ) );

		}

	}

	const map = new THREE.DataTexture( half, SIZE, SIZE, THREE.RGBAFormat, THREE.HalfFloatType );
	map.wrapS = map.wrapT = THREE.RepeatWrapping;
	map.magFilter = THREE.LinearFilter;
	map.minFilter = THREE.LinearFilter;
	map.needsUpdate = true;

	// CPU bilinear height for the player controller — must match the GPU sample
	function heightAt( wx, wz ) {

		const u = ( ( wx / config.terrain.worldScale ) % 1 + 1 ) % 1;
		const v = ( ( wz / config.terrain.worldScale ) % 1 + 1 ) % 1;
		const x = u * SIZE - 0.5, y = v * SIZE - 0.5;
		const x0 = ( Math.floor( x ) + SIZE ) % SIZE, y0 = ( Math.floor( y ) + SIZE ) % SIZE;
		const x1 = ( x0 + 1 ) % SIZE, y1 = ( y0 + 1 ) % SIZE;
		const fx = x - Math.floor( x ), fy = y - Math.floor( y );
		const a = height[ y0 * SIZE + x0 ], b = height[ y0 * SIZE + x1 ];
		const c = height[ y1 * SIZE + x0 ], d = height[ y1 * SIZE + x1 ];
		return ( a + ( b - a ) * fx + ( c - a + ( d - c - b + a ) * fx ) * fy ) * config.terrain.heightMax;

	}

	return { map, heightAt };

}

// the soil under the grass — displaced by the same map the compute pass samples
export function makeGround( terrain, sky, config ) {

	const worldScale = config.terrain.worldScale;
	const heightMax = uniform( config.terrain.heightMax );

	// the mesh recentres on the player in snapped steps; this uniform carries the
	// same snapped offset so vertices always sample identical world positions
	const offset = uniform( new THREE.Vector2() );

	const material = new THREE.MeshBasicNodeMaterial();

	const vXZ = varying( positionGeometry.xz.add( offset ) );

	material.positionNode = Fn( () => {

		const uv = positionGeometry.xz.add( offset ).div( worldScale );
		const h = texture( terrain.map, uv ).level( 0 ).x.mul( heightMax );
		return vec3( positionGeometry.x, h, positionGeometry.z );

	} )();

	// colours authored in sRGB, converted once — tuned for the ACES/2.0 rig the
	// blades use, so soil, turf and fogged grass all live in the same palette
	const srgb = ( r, g, b ) => {

		const c = new THREE.Color().setRGB( r, g, b, THREE.SRGBColorSpace );
		return vec3( c.r, c.g, c.b );

	};

	const cl = config.lighting;
	const fogColor = srgb( ...cl.fogColor );
	const fogDensity = float( cl.fogDensity );

	material.colorNode = Fn( () => {

		const uv = vXZ.div( worldScale );
		const t = texture( terrain.map, uv );

		// normal from height differences
		const e = float( 1.5 / worldScale );
		const hx = texture( terrain.map, uv.add( vec2( e, 0 ) ) ).x.sub( texture( terrain.map, uv.sub( vec2( e, 0 ) ) ).x ).mul( heightMax );
		const hz = texture( terrain.map, uv.add( vec2( 0, e ) ) ).x.sub( texture( terrain.map, uv.sub( vec2( 0, e ) ) ).x ).mul( heightMax );
		const N = normalize( vec3( hx.negate(), 3.0, hz.negate() ) );

		// soil mottling from the noise channel at two scales — bare patches read
		// as dirt, not as missing texture
		const coarse = t.w;
		const fine = texture( terrain.map, uv.mul( 7.3 ) ).w;
		const mottle = coarse.mul( 0.6 ).add( fine.mul( 0.4 ) );

		const soil = mix( srgb( 0.31, 0.23, 0.13 ), srgb( 0.47, 0.37, 0.22 ), mottle );
		const turf = mix( srgb( 0.16, 0.16, 0.075 ), srgb( 0.27, 0.28, 0.12 ), fine.mul( 0.5 ).add( coarse.mul( 0.2 ) ) );
		const base = mix( soil, turf, smoothstep( 0.05, 0.6, t.y ) ).toVar();

		const sun = max( dot( N, sky.sunDir ), 0.0 ).mul( 0.7 ).add( 0.35 );
		base.mulAssign( sun );
		base.mulAssign( t.z.mul( 0.5 ).add( 0.5 ) ); // baked shadow, softened

		// same exponential-squared fog as the blades, then the horizon fade
		const pos = positionWorld;
		const V = normalize( pos.sub( cameraPosition ) );
		const dCam = length( pos.sub( cameraPosition ) );
		const fogAmount = float( 1.0 ).sub( exp( dCam.mul( fogDensity ).pow( 2 ).negate() ) );
		base.assign( mix( base, fogColor, fogAmount ) );

		const fade = smoothstep( 190.0, 340.0, length( pos.xz.sub( cameraPosition.xz ) ) );

		return mix( base, sky.sample( V ), fade );

	} )();

	const geometry = new THREE.PlaneGeometry( 700, 700, 220, 220 );
	geometry.rotateX( - Math.PI / 2 );

	const mesh = new THREE.Mesh( geometry, material );
	mesh.frustumCulled = false;

	const step = 700 / 220;

	function follow( x, z ) {

		const sx = Math.round( x / step ) * step;
		const sz = Math.round( z / step ) * step;
		mesh.position.set( sx, 0, sz );
		offset.value.set( sx, sz );

	}

	return { mesh, material, follow };

}
