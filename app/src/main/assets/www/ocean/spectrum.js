// Initial spectrum h₀(k) — JONSWAP · TMA · Donelan-Banner directional spreading
// · short-wave fade, for a two-layer sea (local wind sea + travelled swell).
// Runs once at start-up and again whenever a spectrum parameter changes.
//
// Numerical rule from the spec: evaluate everything on kSafe = max(|k|, cutoffLow)
// and apply the in-band mask afterwards — the DC texel would otherwise mint a NaN
// that the following IFFT spreads across the entire surface. All piecewise
// branches are written with mix/step, never `if`.

import * as THREE from 'three/webgpu';
import {
	Fn, storage, instanceIndex, uniform,
	uint, int, float, vec2, vec4,
	exp, sin, cos, sqrt, pow, abs, min, max, atan, tanh, cosh, mix, step, clamp, select,
} from 'three/tsl';

const PI = Math.PI;

// ---------------------------------------------------------------- CPU helpers

// Deterministic Box-Muller gaussian pairs, shared by every cascade so the
// cascades stay phase-coherent.
export function makeGaussianNoise( N, seed = 1337 ) {

	let s = seed >>> 0;
	const rand = () => {

		// mulberry32
		s |= 0; s = ( s + 0x6D2B79F5 ) | 0;
		let t = Math.imul( s ^ ( s >>> 15 ), 1 | s );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

	const out = new Float32Array( N * N * 2 );

	for ( let i = 0; i < N * N; i ++ ) {

		const u1 = Math.max( rand(), 1e-9 );
		const u2 = rand();
		const r = Math.sqrt( - 2 * Math.log( u1 ) );
		out[ i * 2 ] = r * Math.cos( 2 * PI * u2 );
		out[ i * 2 + 1 ] = r * Math.sin( 2 * PI * u2 );

	}

	return out;

}

export function jonswapAlpha( g, fetch, windSpeed ) {

	return 0.076 * Math.pow( g * fetch / ( windSpeed * windSpeed ), - 0.22 );

}

export function jonswapPeakOmega( g, fetch, windSpeed ) {

	return 22 * Math.pow( windSpeed * fetch / ( g * g ), - 0.33 );

}

// Disjoint wavenumber bands per cascade.
export function cascadeCutoffs( lengthScales, boundaryFactor ) {

	const n = lengthScales.length;
	const cutoffs = [];

	for ( let i = 0; i < n; i ++ ) {

		const low = i === 0 ? 1e-4 : 2 * PI / lengthScales[ i ] * boundaryFactor;
		const high = i === n - 1 ? 1e6 : 2 * PI / lengthScales[ i + 1 ] * boundaryFactor;
		cutoffs.push( { low, high } );

	}

	return cutoffs;

}

// ---------------------------------------------------------------- TSL pieces

// finite-depth dispersion → ( ω, dω/dk ), transcendental inputs clamped
const dispersion = /*@__PURE__*/ Fn( ( [ k, g, depth ] ) => {

	const kd = min( k.mul( depth ), 20.0 );
	const th = tanh( kd );
	const omega = sqrt( g.mul( k ).mul( th ) );
	const ch = cosh( kd );
	const dOmega = g.mul( depth.mul( k ).div( ch.mul( ch ) ).add( th ) ).div( omega.mul( 2 ) );

	return vec2( omega, dOmega );

} );

// TMA finite-depth correction
const tmaCorrection = /*@__PURE__*/ Fn( ( [ omega, g, depth ] ) => {

	const omegaH = omega.mul( sqrt( depth.div( g ) ) );
	const t1 = omegaH.mul( omegaH ).mul( 0.5 );
	const t2 = float( 1.0 ).sub( float( 2.0 ).sub( omegaH ).pow( 2 ).mul( 0.5 ) );

	return mix( t1, mix( t2, 1.0, step( 2.0, omegaH ) ), step( 1.0, omegaH ) );

} );

// Donelan-Banner normalisation factor — quartic fits, switching at s = 5
const normalisationFactor = /*@__PURE__*/ Fn( ( [ s ] ) => {

	const s2 = s.mul( s );
	const s3 = s2.mul( s );
	const s4 = s3.mul( s );

	const below = s4.mul( - 5.64e-4 ).add( s3.mul( 7.76e-3 ) ).sub( s2.mul( 4.4e-2 ) ).add( s.mul( 0.192 ) ).add( 0.163 );
	const above = s4.mul( - 4.8e-8 ).add( s3.mul( 1.07e-5 ) ).sub( s2.mul( 9.53e-4 ) ).add( s.mul( 5.9e-2 ) ).add( 0.393 );

	return mix( below, above, step( 5.0, s ) );

} );

// A spectrum layer's uniforms — CPU-derived α and ω_p included, so the kernel
// never re-derives them.
export function makeLayerUniforms() {

	return {
		scale: uniform( 1 ),
		alpha: uniform( 0.01 ),
		peakOmega: uniform( 1 ),
		gamma: uniform( 3.3 ),
		spreadBlend: uniform( 1 ),
		swell: uniform( 0 ),
		windDirRad: uniform( 0 ),
		fade: uniform( 0.01 ),
	};

}

export function syncLayerUniforms( u, layer, g ) {

	u.scale.value = layer.scale;
	u.alpha.value = jonswapAlpha( g, layer.fetch, layer.windSpeed );
	u.peakOmega.value = jonswapPeakOmega( g, layer.fetch, layer.windSpeed );
	u.gamma.value = layer.peakEnhancement;
	u.spreadBlend.value = layer.spreadBlend;
	u.swell.value = layer.swell;
	u.windDirRad.value = layer.windDirection * PI / 180;
	u.fade.value = layer.shortWavesFade;

}

// directionless JONSWAP·TMA power spectrum S(ω)
const jonswapTma = /*@__PURE__*/ Fn( ( [ omega, g, depth, alpha, peakOmega, gamma ] ) => {

	const sigma = mix( 0.07, 0.09, step( peakOmega, omega ) );
	const dw = omega.sub( peakOmega );
	const r = exp( dw.mul( dw ).negate().div( sigma.mul( sigma ).mul( peakOmega ).mul( peakOmega ).mul( 2 ) ) );

	const jonswap = alpha.mul( g ).mul( g )
		.mul( pow( omega, - 5.0 ) )
		.mul( exp( pow( peakOmega.div( omega ), 4.0 ).mul( - 1.25 ) ) )
		.mul( pow( gamma, r ) );

	return jonswap.mul( tmaCorrection( omega, g, depth ) );

} );

// Donelan-Banner directional spreading D(θ, ω)
const directionalSpread = /*@__PURE__*/ Fn( ( [ theta, omega, peakOmega, spreadBlend, swell, windDirRad ] ) => {

	const ratio = omega.div( peakOmega );
	const sLow = pow( ratio, 5.0 ).mul( 6.97 );
	const sHigh = pow( ratio, - 2.5 ).mul( 9.77 );
	const spreadPower = mix( sLow, sHigh, step( 1.0, ratio ) );

	const s = clamp( spreadPower.add( tanh( min( ratio, 20.0 ) ).mul( 16.0 ).mul( swell ).mul( swell ) ), 0.0, 60.0 );

	const cosHalf = abs( cos( theta.sub( windDirRad ).mul( 0.5 ) ) );
	const powered = normalisationFactor( s ).mul( pow( max( cosHalf, 1e-5 ), s.mul( 2.0 ) ) );

	const cosT = cos( theta );
	const base = cosT.mul( cosT ).mul( 2.0 / PI );

	return mix( base, powered, spreadBlend );

} );

// ------------------------------------------------------- initial spectrum pass

// Builds one compute node per cascade: writes h0k (pre-conjugate) and wavesData.
// `shared` carries g/depth uniforms + the two layer uniform bags + buffers.
export function makeSpectrumNode( cascade, N, shared ) {

	const texels = N * N;
	const { g, depth, noiseS, h0kS, wavesS } = shared;
	const dkU = cascade.dk, cutLowU = cascade.cutLow, cutHighU = cascade.cutHigh;
	const sliceBase = cascade.index * texels;

	const node = Fn( () => {

		const id = instanceIndex;
		const y = id.div( uint( N ) );
		const x = id.sub( y.mul( uint( N ) ) );

		const nx = float( int( x ) ).sub( N / 2 );
		const nz = float( int( y ) ).sub( N / 2 );

		const kx = nx.mul( dkU );
		const kz = nz.mul( dkU );
		const kLen = sqrt( kx.mul( kx ).add( kz.mul( kz ) ) );

		const inBand = step( cutLowU, kLen ).mul( float( 1.0 ).sub( step( cutHighU, kLen ) ) );

		// evaluate the whole spectrum on kSafe, mask afterwards
		const kSafe = max( kLen, cutLowU );

		const disp = dispersion( kSafe, g, depth ).toVar();
		const omega = disp.x;
		const dOmegaDk = disp.y;

		// guard atan(0,0) at the DC texel
		const degenerate = kLen.lessThan( 1e-6 );
		const theta = atan( select( degenerate, float( 0.0 ), kz ), select( degenerate, float( 1.0 ), kx ) );

		const fadeSq = kSafe.mul( kSafe );

		const layerS = ( u ) => jonswapTma( omega, g, depth, u.alpha, u.peakOmega, u.gamma )
			.mul( directionalSpread( theta, omega, u.peakOmega, u.spreadBlend, u.swell, u.windDirRad ) )
			.mul( exp( fadeSq.mul( u.fade ).mul( u.fade ).negate() ) )
			.mul( u.scale );

		const S = layerS( shared.local ).add( layerS( shared.swell ) );

		const amplitude = sqrt( S.mul( 2.0 ).mul( abs( dOmegaDk ) ).div( kSafe ) ).mul( dkU );

		const xi = noiseS.element( id );
		h0kS.element( uint( sliceBase ).add( id ) ).assign( xi.mul( amplitude ).mul( inBand ) );

		// ( kx, 1/|k|, kz, ω ) — invK guarded so the DC texel cannot mint Inf·0
		wavesS.element( uint( sliceBase ).add( id ) ).assign( vec4( kx, float( 1.0 ).div( max( kLen, 1e-6 ) ), kz, omega ) );

	} )().compute( texels, [ 64 ] );

	node.name = `spectrum_c${ cascade.index }`;
	return node;

}

// Hermitian conjugate packing: h0 = ( h₀(k), conj(h₀(−k)) ), all cascades in one node.
export function makePackNode( N, cascades, shared ) {

	const texels = N * N;
	const { h0kS, h0S } = shared;
	const total = cascades * texels;

	const node = Fn( () => {

		const id = instanceIndex;
		const slice = id.div( uint( texels ) );
		const rem = id.sub( slice.mul( uint( texels ) ) );
		const y = rem.div( uint( N ) );
		const x = rem.sub( y.mul( uint( N ) ) );

		const cx = uint( N ).sub( x ).mod( uint( N ) );
		const cy = uint( N ).sub( y ).mod( uint( N ) );
		const conjIdx = slice.mul( uint( texels ) ).add( cy.mul( uint( N ) ) ).add( cx );

		const a = h0kS.element( id ).toVar();
		const b = h0kS.element( conjIdx ).toVar();

		h0S.element( id ).assign( vec4( a.x, a.y, b.x, b.y.negate() ) );

	} )().compute( total, [ 64 ] );

	node.name = 'h0_pack';
	return node;

}
