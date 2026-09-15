// Hydraulic + thermal erosion on the GPU — the step that turns synthesized
// noise into terrain that looks like it has a history.
//
// Noise alone gives you hills with no drainage: every slope is equally likely
// to be a valley or a spur, and the eye reads that as fake instantly. Running
// water fixes it by *transporting* material — channels cut headward, tributaries
// join at real junctions, and the debris lands as fans where the slope eases.
// None of that can be authored per-texel; it has to emerge from the simulation.
//
// The classic pipe model, written as plain TSL over storage buffers. Per
// iteration, five dispatches (WebGPU orders them):
//
//   1. flux    — outflow to the four neighbours from hydraulic head differences
//   2. water   — flux divergence + rain − evaporation, and the velocity field
//   3. erode   — capacity C = Kc·sin(slope)·|v|; dissolve or deposit vs hardness
//   4. advect  — carry suspended sediment along v (semi-Lagrangian, bilinear)
//   5. thermal — talus relaxation: anything over the repose angle slides
//
// Buffers rotate so height always ends an iteration in hA.

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Return, instancedArray, instanceIndex, texture, textureStore, uvec2,
	float, vec2, vec4, clamp, length, min, max, smoothstep,
} from 'three/tsl';

// Calibrated for ~2 m texels. Conservative rates and per-iteration caps: this
// should carve drainage into the macro forms, not re-landscape them.
const DT = 0.03;
const RAIN = 0.012;
const EVAP = 0.02;
const KC = 0.6;     // transport capacity
const KS = 0.3;     // dissolve rate
const KD = 0.5;     // deposit rate
const G = 9.81;
const THERMAL_RATE = 0.15;
const MAX_VEL = 6;
const MAX_ERODE = 0.06;
const MAX_DEPOSIT = 0.1;

export async function runErosion( renderer, heightIn, hardnessIn, opts ) {

	const { res, texel, iters } = opts;
	const N = res * res;

	const hA = instancedArray( N, 'float' );
	const hB = instancedArray( N, 'float' );
	const wA = instancedArray( N, 'float' );
	const wB = instancedArray( N, 'float' );
	const sA = instancedArray( N, 'float' );
	const sB = instancedArray( N, 'float' );
	const sTmp = instancedArray( N, 'float' );
	const flux = instancedArray( N, 'vec4' );
	const vel = instancedArray( N, 'vec2' );
	const depo = instancedArray( N, 'float' );
	const hard = instancedArray( N, 'float' );

	hA.value.array.set( heightIn );
	hard.value.array.set( hardnessIn );

	const kernel = ( body ) => Fn( () => {

		If( instanceIndex.greaterThanEqual( N ), () => {

			Return();

		} );

		body();

	} )().compute( N );

	const cell = () => {

		const i = instanceIndex.toInt();
		return { x: i.mod( res ), y: i.div( res ), i };

	};

	// clamped neighbour index — the map edge is open ocean, so clamping is the
	// right boundary: nothing flows in from outside
	const at = ( x, y, ox, oy ) => {

		const cx = clamp( float( x ).add( ox ), 0, res - 1 ).toInt();
		const cy = clamp( float( y ).add( oy ), 0, res - 1 ).toInt();
		return cy.mul( res ).add( cx );

	};

	const isBorder = ( x, y ) => float( x ).lessThan( 1 )
		.or( float( x ).greaterThan( res - 2 ) )
		.or( float( y ).lessThan( 1 ) )
		.or( float( y ).greaterThan( res - 2 ) );

	// ---- the four water kernels, parameterised by which buffers are source ----

	const makeHydraulic = ( wSrc, sSrc, wDst, sDst ) => {

		const fluxK = kernel( () => {

			const { x, y, i } = cell();
			const head = hA.element( i ).add( wSrc.element( i ) ).toVar();
			const headOf = ( ox, oy ) => {

				const j = at( x, y, ox, oy );
				return hA.element( j ).add( wSrc.element( j ) );

			};

			const fOld = flux.element( i ).toVar();
			const k = float( DT * G / texel );

			const f = vec4(
				max( 0, fOld.x.add( head.sub( headOf( - 1, 0 ) ).mul( k ) ) ),
				max( 0, fOld.y.add( head.sub( headOf( 1, 0 ) ).mul( k ) ) ),
				max( 0, fOld.z.add( head.sub( headOf( 0, - 1 ) ).mul( k ) ) ),
				max( 0, fOld.w.add( head.sub( headOf( 0, 1 ) ).mul( k ) ) ) ).toVar();

			// never drain a cell below empty in one step
			const total = f.x.add( f.y ).add( f.z ).add( f.w ).max( 1e-6 );
			flux.element( i ).assign( f.mul( min( 1, wSrc.element( i ).div( total.mul( DT ) ) ) ) );

		} );

		const waterK = kernel( () => {

			const { x, y, i } = cell();

			const f = flux.element( i ).toVar();
			const fL = flux.element( at( x, y, - 1, 0 ) ).toVar();
			const fR = flux.element( at( x, y, 1, 0 ) ).toVar();
			const fD = flux.element( at( x, y, 0, - 1 ) ).toVar();
			const fU = flux.element( at( x, y, 0, 1 ) ).toVar();

			const inflow = fL.y.add( fR.x ).add( fD.w ).add( fU.z );
			const outflow = f.x.add( f.y ).add( f.z ).add( f.w );

			const w0 = wSrc.element( i ).toVar();
			const w1 = max( 0, w0.add( inflow.sub( outflow ).mul( DT ) ) ).toVar();
			const w2 = w1.mul( 1 - EVAP * DT ).add( RAIN * DT ).toVar();

			If( isBorder( x, y ), () => {

				w2.assign( 0 );

			} );

			wDst.element( i ).assign( w2 );

			const wAvg = w0.add( w1 ).mul( 0.5 ).max( 1e-4 );
			const v = vec2(
				fL.y.sub( f.x ).add( f.y ).sub( fR.x ).mul( 0.5 ).div( wAvg.mul( texel ) ),
				fD.w.sub( f.z ).add( f.w ).sub( fU.z ).mul( 0.5 ).div( wAvg.mul( texel ) ) ).toVar();

			const speed = v.length().max( 1e-5 );
			vel.element( i ).assign( v.mul( min( 1, float( MAX_VEL ).div( speed ) ) ) );

		} );

		const erodeK = kernel( () => {

			const { x, y, i } = cell();

			const h0 = hA.element( i ).toVar();
			const grad = vec2(
				hA.element( at( x, y, 1, 0 ) ).sub( hA.element( at( x, y, - 1, 0 ) ) ),
				hA.element( at( x, y, 0, 1 ) ).sub( hA.element( at( x, y, 0, - 1 ) ) ) ).div( 2 * texel );

			const slope = grad.length();
			const sinA = slope.div( slope.mul( slope ).add( 1 ).sqrt() ).max( 0.012 );

			// a millimetre of water carries nothing — without this the whole map
			// erodes uniformly instead of only where flow concentrates
			const shallowFade = clamp( wDst.element( i ).mul( 4 ), 0, 1 );
			const cap = float( KC ).mul( sinA ).mul( vel.element( i ).length() ).mul( shallowFade ).toVar();

			const s0 = sSrc.element( i ).toVar();
			const soft = float( 1 ).sub( hard.element( i ).mul( 0.92 ) );

			const cut = min( MAX_ERODE, max( 0, cap.sub( s0 ) ).mul( KS * DT ).mul( soft ) );
			const lay = min( MAX_DEPOSIT, max( 0, s0.sub( cap ) ).mul( KD * DT ) );

			hB.element( i ).assign( h0.add( lay ).sub( cut ) );
			sTmp.element( i ).assign( s0.add( cut ).sub( lay ) );
			depo.element( i ).assign( depo.element( i ).add( lay ) );

		} );

		const advectK = kernel( () => {

			const { x, y, i } = cell();

			const back = vec2( float( x ), float( y ) ).sub( vel.element( i ).mul( DT / texel ) );
			const bx = clamp( back.x, 0, res - 1 );
			const by = clamp( back.y, 0, res - 1 );

			const x0f = bx.floor(), y0f = by.floor();
			const fx = bx.sub( x0f ), fy = by.sub( y0f );
			const x0 = x0f.toInt(), y0 = y0f.toInt();
			const x1 = min( x0f.add( 1 ), res - 1 ).toInt();
			const y1 = min( y0f.add( 1 ), res - 1 ).toInt();

			const s00 = sTmp.element( y0.mul( res ).add( x0 ) );
			const s10 = sTmp.element( y0.mul( res ).add( x1 ) );
			const s01 = sTmp.element( y1.mul( res ).add( x0 ) );
			const s11 = sTmp.element( y1.mul( res ).add( x1 ) );

			const top = s00.mul( fx.oneMinus() ).add( s10.mul( fx ) );
			const bot = s01.mul( fx.oneMinus() ).add( s11.mul( fx ) );

			sDst.element( i ).assign( top.mul( fy.oneMinus() ).add( bot.mul( fy ) ) );

		} );

		return [ fluxK, waterK, erodeK, advectK ];

	};

	// ---- talus relaxation, hB → hA (gather form, symmetric pair transfers) ----

	const thermalK = kernel( () => {

		const { x, y, i } = cell();

		const h0 = hB.element( i ).toVar();
		const hard0 = hard.element( i ).toVar();

		// hard rock holds near-cliff angles; soft soil relaxes to ~30°
		const talus0 = float( 0.55 ).add( hard0.mul( hard0 ).mul( 2.6 ) );
		const rate0 = float( 1 ).sub( hard0 ).pow( 1.5 ).mul( THERMAL_RATE * DT * texel );

		const net = float( 0 ).toVar();
		const offs = [ [ - 1, 0 ], [ 1, 0 ], [ 0, - 1 ], [ 0, 1 ], [ - 1, - 1 ], [ 1, 1 ], [ - 1, 1 ], [ 1, - 1 ] ];

		for ( const [ ox, oy ] of offs ) {

			const dist = texel * Math.hypot( ox, oy );
			const j = at( x, y, ox, oy );
			const hn = hB.element( j );
			const hardN = hard.element( j );
			const talusN = float( 0.55 ).add( hardN.mul( hardN ).mul( 2.6 ) );
			const rateN = float( 1 ).sub( hardN ).pow( 1.5 ).mul( THERMAL_RATE * DT * texel );

			net.addAssign( max( 0, hn.sub( h0 ).div( dist ).sub( talusN ) ).mul( rateN ) );
			net.subAssign( max( 0, h0.sub( hn ).div( dist ).sub( talus0 ) ).mul( rate0 ) );

		}

		hA.element( i ).assign( h0.add( clamp( net, - 0.22, 0.22 ) ) );

	} );

	const even = makeHydraulic( wA, sA, wB, sB );
	const odd = makeHydraulic( wB, sB, wA, sA );

	const BATCH = 10;
	let done = 0;

	while ( done < iters ) {

		const nodes = [];
		const n = Math.min( BATCH, iters - done );

		for ( let k = 0; k < n; k ++ ) nodes.push( ...( ( done + k ) % 2 === 0 ? even : odd ), thermalK );

		await renderer.computeAsync( nodes );
		done += n;

	}

	const finalW = iters % 2 === 1 ? wB : wA;

	const [ hOut, wOut, dOut ] = await Promise.all( [
		renderer.getArrayBufferAsync( hA.value ),
		renderer.getArrayBufferAsync( finalW.value ),
		renderer.getArrayBufferAsync( depo.value ),
	] );

	return {
		height: new Float32Array( hOut, 0, N ),
		water: new Float32Array( wOut, 0, N ),
		sediment: new Float32Array( dOut, 0, N ),
	};

}

// ---- terrain self-shadowing -------------------------------------------------
//
// A heightfield the size of a landmass has to cast its own shadows or low sun
// looks painted on. Marching every texel toward the sun costs a millisecond, so
// it is re-run only when the sun has actually moved — a few times a second in
// the auto-cycle, never in a still frame.

export function makeSunShadow( heightTex, res, worldScale, sunDirU ) {

	const tex = new THREE.StorageTexture( res, res );
	tex.format = THREE.RGBAFormat;
	tex.type = THREE.HalfFloatType;
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.magFilter = tex.minFilter = THREE.LinearFilter;
	tex.generateMipmaps = false;

	const STEPS = 56;
	const GROWTH = 1.075;  // geometric steps: 2 m near, ~90 m far, ~1.4 km reach
	const START = 2.5;

	const kernel = Fn( () => {

		const x = instanceIndex.mod( res );
		const y = instanceIndex.div( res );
		const uv = vec2( float( x ).add( 0.5 ).div( res ), float( y ).add( 0.5 ).div( res ) ).toVar();

		const h0 = texture( heightTex, uv ).level( 0 ).x.toVar();

		// horizontal bearing of the sun, and how fast the ray climbs along it
		const sd = sunDirU;
		const hLen = max( length( vec2( sd.x, sd.z ) ), 1e-3 ).toVar();
		const bearing = vec2( sd.x, sd.z ).div( hLen ).toVar();
		const climb = max( sd.y, 0.009 ).div( hLen ).toVar();   // ≥ ~0.5° so shadows stay finite

		const t = float( START ).toVar();
		const step = float( START ).toVar();
		const horizon = float( - 10.0 ).toVar();   // steepest skyline along the bearing

		Loop( STEPS, () => {

			const p = uv.add( bearing.mul( t.div( worldScale ) ) );
			const hs = texture( heightTex, p ).level( 0 ).x;
			horizon.assign( max( horizon, hs.sub( h0 ).div( t ) ) );

			step.mulAssign( GROWTH );
			t.addAssign( step );

		} );

		// A texel is lit when the sun stands above the skyline it can see. Note
		// this is an *angle* test, not a height one: biasing in metres — a bias
		// that has to grow with the step length, since far samples are coarse —
		// is either metres of slack next to the texel or none of it far away,
		// and near the terminator, where the two are comparable, neighbouring
		// texels flip either side of it and the shadow edge breaks into speckle.
		// Magnified over a beach that is camouflage. A slope threshold is scale
		// free: one bias, one soft window, both in radians of sun elevation.
		const lit = float( 1.0 ).sub( smoothstep( climb.add( 0.012 ), climb.add( 0.062 ), horizon ) );

		textureStore( tex, uvec2( x, y ), vec4( lit, 0.0, 0.0, 1.0 ) ).toStack();

	} )().compute( res * res );

	let lastX = 9, lastY = 9, lastZ = 9;

	function update( renderer, force = false ) {

		const s = sunDirU.value;

		// half a degree of sun motion is the visible threshold; below the horizon
		// nothing is lit anyway
		if ( ! force && Math.abs( s.x - lastX ) + Math.abs( s.y - lastY ) + Math.abs( s.z - lastZ ) < 0.009 ) return;

		lastX = s.x; lastY = s.y; lastZ = s.z;
		renderer.compute( kernel );

	}

	return { tex, update };

}
