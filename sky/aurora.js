// Aurora curtains.
//
// A slab of volume from 50 m to 125 m, warped by three octaves of 3-D value
// noise, with a `pow(0.55/d, 12)` radiance falloff and two line-noise wobbles
// for the vertical striations. Every one of those numbers is doing something
// you notice: drop the exponent and the curtain becomes fog, drop the
// `cos(0.13 · x)` and it loses the gaps that make it a curtain rather than a
// sheet.
//
// **A LUT, not a full-screen pass.** Marched per pixel it would own the
// screen, and the sky here is a function of direction that the ocean also
// calls, per pixel, for reflections — a 75-step three-octave march evaluated
// twice per pixel is not a thing you can afford on top of an FFT ocean. So
// the march runs once per frame into a 512 × 160 direction LUT, the same
// shape and the same azimuth/elevation warp the scattering LUT already uses,
// and everything that wants aurora reads one texel. The sky gets it, the sea
// reflects it, and the aerial perspective carries it, all for one texture
// fetch.
//
// What that costs is the finest striations: a texel is about 0.7° and the real
// thing has structure below that. What it buys is that the aurora is *in the
// world* rather than composited over it — a curtain that lights the water is
// worth more than one with sharper edges, and on a dark ocean the reflection
// is most of the shot.
//
// The march is skipped entirely whenever the aurora is not visible, so a
// daylight frame pays nothing at all.

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uniform, instanceIndex, textureStore, uvec2,
	float, int, vec2, vec3, vec4,
	dot, cos, sin, sign, floor, fract, abs, min, max, mix, clamp, pow, length, mod,
} from 'three/tsl';

const PI = Math.PI;
const LUT_W = 512, LUT_H = 160;

// The volume, in metres above and around a viewer standing at the origin. It
// is deliberately flat and wide: 500 m of curtain over 75 m of depth, which is
// what puts the vanishing point of the bands near the horizon.
const Y_BOTTOM = 50.0, DEPTH = 75.0;
const LOW = [ - 250.0, Y_BOTTOM, - 500.0 ];
const HIGH = [ 250.0, Y_BOTTOM + DEPTH, 500.0 ];

export const AURORA_PRESET = {
	steps: 48,
	speed: 0.65,
	seed: 19.6,
	intensity: 1.0,
	colorBase: '#59ff03',
	colorHigh: '#00aaff',
};

// ---------------------------------------------------------------------------
// noise
// ---------------------------------------------------------------------------

const hash1 = /*@__PURE__*/ Fn( ( [ v ] ) => {

	const p = fract( vec3( v, v, v ).mul( 0.1031 ) ).toVar();
	p.addAssign( dot( p, p.yzx.add( 19.19 ) ) );
	return fract( p.x.add( p.y ).mul( p.z ) );

} );

const hash3 = /*@__PURE__*/ Fn( ( [ v ] ) => {

	const p = fract( v.mul( vec3( 0.1031, 0.1030, 0.0973 ) ) ).toVar();
	p.addAssign( dot( p, p.yxz.add( 33.33 ) ) );
	return fract( p.xxy.add( p.yxx ).mul( p.zyx ) ).x;

} );

const valueNoise3 = /*@__PURE__*/ Fn( ( [ c ] ) => {

	const g = floor( c ).toVar();
	const f = fract( c ).toVar();
	f.assign( f.mul( f ).mul( float( 3.0 ).sub( f.mul( 2.0 ) ) ) );

	const n = ( dx, dy, dz ) => hash3( g.add( vec3( dx, dy, dz ) ) );

	return mix(
		mix( mix( n( 0, 0, 0 ), n( 1, 0, 0 ), f.x ), mix( n( 0, 1, 0 ), n( 1, 1, 0 ), f.x ), f.y ),
		mix( mix( n( 0, 0, 1 ), n( 1, 0, 1 ), f.x ), mix( n( 0, 1, 1 ), n( 1, 1, 1 ), f.x ), f.y ),
		f.z );

} );

// A 1D noise whose gradient is *chosen* rather than interpolated: the sign of
// each lattice slope comes from a hash parity, which gives a kinked, folded
// line instead of a smooth wave. That kink is what the curtain's edge wobble
// is made of, so a smooth 1D noise here reads as a flag rather than as plasma.
const pickGradient = /*@__PURE__*/ Fn( ( [ h, posVal ] ) => {

	const even = mod( floor( h.mul( 1e4 ) ), 2.0 ).lessThan( 0.5 );
	return posVal.mul( even.select( float( 1.0 ), float( - 1.0 ) ) );

} );

const lineNoise = /*@__PURE__*/ Fn( ( [ pt ] ) => {

	const i = floor( pt ).toVar();
	const f = pt.sub( i ).toVar();
	const w = f.mul( f ).mul( f ).mul( f.mul( f.mul( 6.0 ).sub( 15.0 ) ).add( 10.0 ) );
	return mix( pickGradient( hash1( i ), f ), pickGradient( hash1( i.add( 1.0 ) ), f.sub( 1.0 ) ), w ).mul( 2.0 );

} );

const fractalVolume = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const accum = float( 0.0 ).toVar();
	const weightSum = float( 0.0 ).toVar();
	const w = float( 1.0 ).toVar();
	const freq = float( 1.0 ).toVar();

	Loop( { start: 0, end: 3, type: 'int' }, () => {

		accum.addAssign( float( 1.0 ).sub( valueNoise3( p.mul( freq ) ) ).mul( w ) );
		weightSum.addAssign( w );
		w.mulAssign( 0.5 );
		freq.mulAssign( 2.0 );

	} );

	return clamp( accum.div( weightSum ), 0.0, 1.0 );

} );

// ---------------------------------------------------------------------------

export function makeAurora( config = {} ) {

	const preset = { ...AURORA_PRESET, ...config };

	const u = {
		time: uniform( 0 ),
		speed: uniform( preset.speed ),
		seed: uniform( preset.seed ),
		gain: uniform( preset.intensity ),
		colorBase: uniform( new THREE.Color( preset.colorBase ) ),
		colorHigh: uniform( new THREE.Color( preset.colorHigh ) ),
		// how much of the aurora is showing. Driven from outside: the sky owns
		// what "night" means and this module should not have a second opinion.
		level: uniform( 0 ),
	};

	const lut = new THREE.StorageTexture( LUT_W, LUT_H );
	lut.format = THREE.RGBAFormat;
	lut.type = THREE.HalfFloatType;
	lut.wrapS = THREE.RepeatWrapping;      // azimuth is periodic
	lut.wrapT = THREE.ClampToEdgeWrapping;
	lut.magFilter = lut.minFilter = THREE.LinearFilter;
	lut.generateMipmaps = false;

	// The domain warp. `0.225` on z against `1.0` on x is what stretches the
	// bands along one axis so they read as curtains hanging in a line rather
	// than as a cloud, and the `5.5 · cos(0.005 z)` is the slow arc that keeps
	// the whole display from being straight.
	const warp = /*@__PURE__*/ Fn( ( [ p, t ] ) => {

		const nh = p.y.sub( Y_BOTTOM ).div( DEPTH );
		const w = vec3( p.x, t.mul( 2.0 ), p.z.mul( 0.225 ).add( t.mul( 0.5 ) ) ).mul( 0.04 ).toVar();
		w.x.addAssign( u.seed.mul( 17.3 ) );
		w.z.addAssign( u.seed.mul( 29.1 ) );
		w.x.addAssign( nh.mul( 0.3 ).add( cos( p.z.mul( 0.005 ) ).mul( 5.5 ) ) );
		w.x.addAssign( lineNoise( p.z.mul( 0.1 ).add( t.mul( 2.0 ) ) ).mul( 0.02 ) );
		return w;

	} );

	// Density at a point. The trick worth naming: the curtain's *shape* is not
	// a function of position, it is a function of the noise value — `shape` puts
	// the fbm result into x and z and the height into y, then squashes y by
	// 0.006 so that the distance to the origin is dominated by how far the noise
	// is from its own centre. A `pow(0.55/d, 12)` on that distance is a very
	// thin shell in noise space, and a thin shell in noise space drawn through
	// 3D is a sheet with folds in it.
	const density = /*@__PURE__*/ Fn( ( [ p ] ) => {

		const t = u.time.mul( u.speed ).toVar();
		const sp = warp( p, t ).toVar();
		const base = fractalVolume( sp ).toVar();

		const sq = vec3( base, p.y.sub( Y_BOTTOM ), base ).mul( vec3( 1.0, 0.006, 1.0 ) ).toVar();
		sq.y.addAssign( 0.48 );
		sq.y.addAssign( lineNoise( t.add( sp.z ) ).mul( 0.015 ) );
		sq.y.addAssign( lineNoise( t.mul( - 2.0 ).add( sp.z ) ).mul( 0.015 ) );

		const thickness = pow( float( 0.55 ).div( max( length( sq ), 1e-7 ) ), 12.0 )
			.mul( cos( sp.x.mul( 0.13 ) ) );

		return max( thickness, 0.0 );

	} );

	const march = /*@__PURE__*/ Fn( ( [ dir, jitter ] ) => {

		const origin = vec3( 0.0, 10.0, 0.0 ).add( dir.mul( 10.0 ) ).toVar();

		const inv = vec3( 1.0 ).div( dir ).toVar();
		const tA = vec3( LOW[ 0 ], LOW[ 1 ], LOW[ 2 ] ).sub( origin ).mul( inv ).toVar();
		const tB = vec3( HIGH[ 0 ], HIGH[ 1 ], HIGH[ 2 ] ).sub( origin ).mul( inv ).toVar();
		const tmin = min( tA, tB ).toVar();
		const tmax = max( tA, tB ).toVar();
		const near = max( max( tmin.x, tmin.y ), tmin.z ).toVar();
		const far = min( min( tmax.x, tmax.y ), tmax.z ).toVar();

		const out = vec3( 0.0 ).toVar();

		If( near.greaterThan( 0.0 ).and( near.lessThan( far ) ), () => {

			const stepLength = far.sub( near ).div( preset.steps ).toVar();
			const travel = near.add( stepLength.mul( jitter ).mul( 0.25 ) ).toVar();

			Loop( { start: 0, end: preset.steps, type: 'int' }, () => {

				const p = origin.add( dir.mul( travel ) ).toVar();
				const d = density( p ).toVar();
				const heightRatio = p.y.sub( Y_BOTTOM ).div( DEPTH );
				out.addAssign( mix( u.colorBase, u.colorHigh, heightRatio ).mul( d ).mul( stepLength ) );
				travel.addAssign( stepLength );

			} );

		} );

		return out.mul( 0.05 ).mul( u.gain );

	} );

	// The bake. Same azimuth/elevation parameterisation as the scattering LUT so
	// one `dirToUV` serves both — see atmosphere.js, where that warp is
	// explained (half the rows in the 20° around the horizon).
	const bake = /*@__PURE__*/ Fn( () => {

		const x = instanceIndex.mod( LUT_W );
		const y = instanceIndex.div( LUT_W );

		const az = float( x ).add( 0.5 ).div( LUT_W ).sub( 0.5 ).mul( 2 * PI );
		const s = float( y ).add( 0.5 ).div( LUT_H ).sub( 0.5 ).mul( 2.0 ).toVar();
		const el = s.mul( s ).mul( sign( s ) ).mul( PI / 2 );

		const ce = cos( el );
		const dir = vec3( ce.mul( cos( az ) ), sin( el ), ce.mul( sin( az ) ) );

		// A per-texel dither on the march start. Without it the first sample of
		// every ray lands on the same plane and the curtain grows a set of
		// concentric rings — the classic ray-march banding, and it survives into
		// the LUT where it is much harder to explain than to prevent.
		const jitter = hash3( vec3( float( x ), float( y ), u.time.mul( 13.0 ) ) );

		textureStore( lut, uvec2( x, y ), vec4( march( dir, jitter ), 1.0 ) ).toStack();

	} )().compute( LUT_W * LUT_H );

	return { lut, bake, uniforms: u, LUT_W, LUT_H };

}
