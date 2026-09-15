// The landmass. Three stages, in order:
//
//   1. macro synthesis (CPU) — a domain-warped coastline that is never a circle:
//      an elliptical base mask warped by three scales of noise plus four octaves
//      of lobes, rolling meadow country and an anisotropic ridge spine.
//   2. erosion (GPU) — rain, flow, dissolve, deposit, talus. This is the stage
//      that makes it read as *terrain* rather than as noise: valleys arrive with
//      tributaries, spurs sharpen between them, and the debris lands as fans
//      where the gradient eases. See ./erosion.js.
//   3. fields + scatter (CPU) — grass density, shore distance, palms, all read
//      off the *eroded* height, so vegetation follows the drainage it grew in.
//
// The bake ships four textures:
//   map       RGBA16F — R clamp(h,0,span)/span (the channel grass reads),
//                       G grass density, B canopy/ambient occlusion, A noise
//   heightTex RG16F   — R signed height (m), G signed shore distance (m)
//   fields    RGBA16F — R flow strength, G sediment depth, B concavity, A slope
//   detail    RGBA16F — the sand's own tileable relief tile, see ./sand.js
//
// plus a live sun-shadow texture re-marched whenever the sun moves.

import * as THREE from 'three/webgpu';
import {
	Fn, texture, uniform, varying,
	float, vec2, vec3,
	positionGeometry, positionWorld, cameraPosition,
	normalize, dot, mix, smoothstep, length, max, min, abs, clamp, sin, floor, pow, reflect, exp,
} from 'three/tsl';

import { makeOctave } from '../grass/terrain.js';
import { runErosion, makeSunShadow } from './erosion.js';
import { makeSandDetail, beachSurface } from './sand.js';
import { AQUATIC_EXTINCTION } from '../sky/atmosphere.js';

const SIZE = 1024;

export async function makeIslandTerrain( renderer, gConfig, land, treesCfg, groveCfg, homeCfg, onProgress ) {

	const worldScale = land.worldScale;
	const heightSpan = land.heightSpan;
	const texelM = worldScale / SIZE;

	let seed = 1337;
	const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;

	// uv-periodic value noise; lattice n ↔ wavelength worldScale/n metres
	const w1x = makeOctave( 3, rand ), w1z = makeOctave( 3, rand );   // coast meander (~730 m)
	const w2x = makeOctave( 9, rand ), w2z = makeOctave( 9, rand );   // coast wobble (~240 m)
	const w3x = makeOctave( 27, rand ), w3z = makeOctave( 27, rand ); // coast fringe (~80 m)
	const c1 = makeOctave( 4, rand ), c2 = makeOctave( 7, rand ), c3 = makeOctave( 13, rand ), c4 = makeOctave( 26, rand );
	const h1 = makeOctave( 8, rand ), h2 = makeOctave( 16, rand ), h3 = makeOctave( 33, rand ), h4 = makeOctave( 67, rand );
	const r1 = makeOctave( 5, rand ), r2 = makeOctave( 11, rand ), r3 = makeOctave( 23, rand ), r4 = makeOctave( 47, rand );
	makeOctave( 11, rand ); makeOctave( 29, rand );  // retired grass-density lattice — see dp1..dp4
	const k1 = makeOctave( 9, rand ), k2 = makeOctave( 23, rand );     // bedrock hardness
	const p1 = makeOctave( 29, rand );
	const g1 = makeOctave( 16, rand );                                 // palm grove clusters
	const b1 = makeOctave( 21, rand );                                 // rip channels through the bar (~105 m)
	// declared last on purpose: makeOctave draws from the same stream, so a new
	// octave inserted above this line re-rolls every field below it
	const w1 = makeOctave( 7, rand ), w2 = makeOctave( 19, rand );     // broadleaf woodland
	// grass-density fbm — four octaves from 51 m down to 6 m, so the field has
	// no cell size to read as a shape. `d1`/`d2` above are kept, unused, purely
	// to hold the random stream in place for everything declared after them.
	const dp1 = makeOctave( 43, rand ), dp2 = makeOctave( 89, rand );
	const dp3 = makeOctave( 181, rand ), dp4 = makeOctave( 349, rand );
	// canopy dapple — breaks the outline of every crown stamped into occlusion
	const cd1 = makeOctave( 257, rand );

	const height = new Float32Array( SIZE * SIZE );  // signed metres — CPU physics
	const hardness = new Float32Array( SIZE * SIZE );
	const inlandM = new Float32Array( SIZE * SIZE );
	const density = new Float32Array( SIZE * SIZE );
	const ao = new Float32Array( SIZE * SIZE );
	const posNoise = new Float32Array( SIZE * SIZE );
	const coastS = new Float32Array( SIZE * SIZE );  // signed coast field, kept for the beach pass
	const bayF = new Float32Array( SIZE * SIZE );    // 1 where the coast collects sand

	const smooth = ( a, b, x ) => {

		const t = Math.min( 1, Math.max( 0, ( x - a ) / ( b - a ) ) );
		return t * t * ( 3 - 2 * t );

	};

	// ellipse orientation + ridge-noise anisotropy
	const ca0 = Math.cos( - 0.55 ), sa0 = Math.sin( - 0.55 );
	const car = Math.cos( 0.62 ), sar = Math.sin( 0.62 );

	// the massifs: x/z centre, r outer radius, core where the zone mask saturates,
	// p falloff exponent, h ridged amplitude, dome the smooth cone under it
	const peaks = [
		{ x: 330, z: - 140, r: 720, core: 120, p: 1.25, h: 300, dome: 78 },
		{ x: - 80, z: 300, r: 480, core: 90, p: 1.5, h: 150, dome: 34 },
	];

	await ( onProgress && onProgress( 'synthesis' ) );
	// ---- stage 1: macro synthesis ------------------------------------------

	for ( let y = 0; y < SIZE; y ++ ) {

		for ( let x = 0; x < SIZE; x ++ ) {

			const u = x / SIZE, v = y / SIZE;

			// texel → world, land centred on the uv wrap corner
			const wx = ( u < 0.5 ? u : u - 1 ) * worldScale;
			const wz = ( v < 0.5 ? v : v - 1 ) * worldScale;

			// ---- coast field: a warped elliptical base plus fractal lobes; land
			// where cS > 0. Three warp scales — meander, wobble, fringe — so the
			// coast is fractal at every scale instead of an ellipse with a texture
			// on it (a smooth profile survives a domain warp nearly intact, since
			// the warp mostly translates shapes smaller than its own wavelength).
			const px = wx + ( w1x( u, v ) - 0.5 ) * 480 + ( w2x( u, v ) - 0.5 ) * 340 + ( w3x( u, v ) - 0.5 ) * 130;
			const pz = wz + ( w1z( u, v ) - 0.5 ) * 480 + ( w2z( u, v ) - 0.5 ) * 340 + ( w3z( u, v ) - 0.5 ) * 130;

			const ex = ( px * ca0 - pz * sa0 ) / 860;
			const ez = ( px * sa0 + pz * ca0 ) / 590;
			const base = 1 - Math.hypot( ex, ez );

			// hoisted: c1/c2 are read twice (lobes, then the cove field) and h4
			// three times. At 1024² a duplicated octave is a million extra
			// lattice fetches — this loop is the single biggest item in the boot
			// budget, so the free ones are worth taking.
			const c1v = c1( u, v ), c2v = c2( u, v ), h4v = h4( u, v );

			const c = base
				+ ( 0.40 * c1v + 0.26 * c2v + 0.20 * c3( u, v ) + 0.14 * c4( u, v ) - 0.5 ) * 0.78;

			const cS = c - 0.18;

			// ---- where the coast collects sand
			// Wave refraction focuses energy on headlands and spreads it in the
			// coves between them, so the coves are where sediment ends up: a wide
			// beach over a gently shelving bottom, while the headlands keep deep
			// water and bare rock. The low lobe octaves are what cut the coves in
			// the first place, so reading the same field back is causal rather
			// than decorative. A coast with one profile all the way round is the
			// thing that makes the surf line a ribbon of constant width.
			const cove = 0.62 * c1v + 0.38 * c2v;
			const bayK = smooth( 0.53, 0.33, cove );

			// ---- height: seabed ramp → beach blend → plains + hills + ridge
			// The shelf: gentle in the bays — waves feel the bottom far out, so
			// the surf zone is wide — and steep off the headlands.
			const shelf = - 1.5 + cS * ( 145 - 88 * bayK );

			// A longshore bar: the sand a breaking wave drags back seaward piles
			// into a ridge a little way out. Waves break over it, re-form in the
			// trough behind and break again at the beach, and the rip channels cut
			// through it are what stop the foam being one unbroken line.
			const barT = ( cS + 0.052 ) / 0.030;
			const bar = 2.2 * bayK * Math.exp( - barT * barT ) * smooth( 0.30, 0.62, b1( u, v ) );

			const hSea = Math.max( land.seaFloor, shelf + bar );

			const inland = smooth( 0.0, 0.14, cS );

			const h01 = 0.52 * h1( u, v ) + 0.27 * h2( u, v ) + 0.14 * h3( u, v ) + 0.07 * h4v;
			const hn = 1 - Math.pow( 1 - Math.min( 1, Math.max( 0, h01 ) ), 1.7 ); // shallow dales
			const hills = 46 * hn * ( 0.35 + 0.65 * inland );

			// A volcanic island is not a hill. Two massifs — a main summit and a
			// lower shoulder — built from anisotropic ridged noise `(1-|n|)²`, at
			// a scale that actually towers over the beach: 1:2 flanks over a few
			// hundred metres is what makes a coastline read as an island rather
			// than as a sandbar with a lawn.
			const sq = ( o ) => { const n = 1 - Math.abs( 2 * o - 1 ); return n * n; };
			const ru = ( wx * car + wz * sar ) / worldScale * 0.75 + 0.31;
			const rv = ( - wx * sar + wz * car ) / worldScale * 2.4 + 0.77;

			let ridgeH = 0, ridgePow = - 1;

			for ( const peak of peaks ) {

				const zone = Math.pow( smooth( peak.r, peak.core, Math.hypot( px - peak.x, pz - peak.z ) ), peak.p );
				if ( zone <= 0.003 ) continue;

				// the ridged field is a function of (ru, rv) alone — it does not
				// depend on which peak is being accumulated — so it is evaluated
				// once per texel, and only where some peak's zone actually reaches
				if ( ridgePow < 0 ) {

					const ridge = ( 0.48 * sq( r1( ru, rv ) ) + 0.28 * sq( r2( ru, rv ) )
						+ 0.16 * sq( r3( ru, rv ) ) + 0.08 * sq( r4( ru, rv ) ) );
					ridgePow = Math.pow( ridge, 1.35 );

				}

				ridgeH = Math.max( ridgeH, zone * ( ridgePow * peak.h + zone * peak.dome ) );

			}

			const hLand = 2.3 + 4.5 * inland + hills + ridgeH * inland
				+ ( h4v - 0.5 ) * 2.4 * ( 0.3 + 0.7 * inland );

			const shoreBlend = smooth( - 0.018, 0.042, cS );
			const h = Math.max( hSea + ( hLand - hSea ) * shoreBlend, land.seaFloor );

			const i = y * SIZE + x;
			height[ i ] = h;
			inlandM[ i ] = inland;
			posNoise[ i ] = p1( u, v );
			coastS[ i ] = cS;
			bayF[ i ] = bayK;

			// bedrock hardness: the ridge is a resistant intrusion, the plains are
			// soft sediment, and the seabed is frozen so erosion cannot eat the
			// coastline out from under the beach
			hardness[ i ] = Math.min( 1, Math.max( 0.05,
				0.10 + 0.66 * smooth( 40, 210, h ) + 0.3 * ( 0.6 * k1( u, v ) + 0.4 * k2( u, v ) ) - 0.15
					+ smooth( 2.0, - 3.0, h ) ) );

		}

	}

	// ---- stage 2: erosion ---------------------------------------------------

	await ( onProgress && onProgress( 'eroding' ) );

	const original = Float32Array.from( height );
	const eroded = await runErosion( renderer, height, hardness, {
		res: SIZE, texel: texelM, iters: 130,
	} );

	const flow = new Float32Array( SIZE * SIZE );
	const sediment = new Float32Array( SIZE * SIZE );

	{

		let maxW = 1e-6, maxS = 1e-6;

		for ( let i = 0; i < SIZE * SIZE; i ++ ) {

			if ( eroded.water[ i ] > maxW ) maxW = eroded.water[ i ];
			if ( eroded.sediment[ i ] > maxS ) maxS = eroded.sediment[ i ];

		}

		for ( let i = 0; i < SIZE * SIZE; i ++ ) {

			// hold the designed sea floor and let erosion own the land, blending
			// across the intertidal so river mouths still reach the water
			const k = smooth( - 3.0, 1.5, original[ i ] );
			let h = original[ i ] + ( eroded.height[ i ] - original[ i ] ) * k;

			height[ i ] = h;
			flow[ i ] = Math.min( 1, eroded.water[ i ] / ( maxW * 0.18 ) );
			sediment[ i ] = Math.min( 1, eroded.sediment[ i ] / ( maxS * 0.35 ) );

		}

	}

	// One island. The lobe noise that keeps the coast fractal at every scale also
	// pinches the odd fragment off it, and an isolated rock a hundred metres
	// offshore reads as a mistake rather than as scenery. Label the land, keep
	// the largest body and drown everything else. The map wraps, so the
	// neighbour walk has to wrap with it — the land is centred on the uv wrap
	// corner, and a non-wrapping fill would split the island into its four
	// quadrants and then keep one of them.
	//
	// What a drowned cell becomes matters as much as which cells drown, and the
	// bank has to go down with the rock standing on it. A fragment is a local
	// *high* of the coast field, so anything keyed back to that field — stage
	// 1's own `hSea`, or the field reflected across the waterline — rebuilds the
	// same mound a metre lower, and a bank a hand's depth under the surface is a
	// turquoise shoal with surf breaking over it: the same object, minus the
	// sand on top.
	{

		const wrap = ( x, y ) => ( ( y + SIZE ) % SIZE ) * SIZE + ( x + SIZE ) % SIZE;
		const label = new Int32Array( SIZE * SIZE ).fill( - 1 );
		const stack = [];
		let next = 0, best = - 1, bestN = 0;

		for ( let s = 0; s < SIZE * SIZE; s ++ ) {

			if ( height[ s ] <= 0 || label[ s ] >= 0 ) continue;

			const id = next ++;
			let n = 0;
			stack.push( s );

			while ( stack.length ) {

				const i = stack.pop();
				if ( label[ i ] >= 0 || height[ i ] <= 0 ) continue;
				label[ i ] = id; n ++;

				const x = i % SIZE, y = ( i / SIZE ) | 0;
				stack.push( y * SIZE + ( x + 1 ) % SIZE );
				stack.push( y * SIZE + ( x + SIZE - 1 ) % SIZE );
				stack.push( ( y + 1 ) % SIZE * SIZE + x );
				stack.push( ( y + SIZE - 1 ) % SIZE * SIZE + x );

			}

			if ( n > bestN ) { bestN = n; best = id; }

		}

		// 18 m is the depth the bottom has to reach, and it is set by the shading
		// rather than by geology: the seabed tint saturates at 8.4 m and the
		// water column is not opaque until the mid teens, so a bank left between
		// the two reads as a black slab lying on the water — too deep to be sand,
		// too shallow to be hidden. Fade the cut out and take the minimum, so it
		// only ever digs and the seabed keeps whatever shape it already had.
		//
		// The fade has to be wider than the bank, or the cut digs the middle out
		// and leaves the crown standing as a ring: these banks measure 60–90 m
		// across, and a 40 m fade drew two crop circles offshore. It cannot run
		// away with the coast either, but that needs no second rule — the target
		// ramps back to zero faster than the shelf shallows, so by the time the
		// cut reaches the beach it is already asking for water deeper than what
		// is there, and the minimum keeps the beach.
		const HIDE = - 18;
		const BLEND = 55;   // texels ≈ 118 m

		const patch = [];
		const step = new Int16Array( SIZE * SIZE ).fill( - 1 );

		for ( let i = 0; i < SIZE * SIZE; i ++ ) {

			if ( label[ i ] < 0 || label[ i ] === best ) continue;
			step[ i ] = 0; patch.push( i );

		}

		for ( let q = 0; q < patch.length; q ++ ) {

			const i = patch[ q ];
			if ( step[ i ] >= BLEND ) continue;

			const x = i % SIZE, y = ( i / SIZE ) | 0;

			for ( const j of [ wrap( x + 1, y ), wrap( x - 1, y ), wrap( x, y + 1 ), wrap( x, y - 1 ) ] ) {

				if ( step[ j ] >= 0 || label[ j ] === best ) continue;   // never cut into the island
				step[ j ] = step[ i ] + 1; patch.push( j );

			}

		}

		for ( const i of patch ) {

			height[ i ] = Math.min( height[ i ], HIDE * ( 1 - smooth( 0, BLEND, step[ i ] ) ) );

		}

	}

	// The sea is one plane at y = 0, so any hollow that erosion left below zero
	// and that the sea cannot reach renders as a perfectly round pond of ocean
	// sitting in a meadow. Flood-fill the real sea inward from the map border;
	// anything under water and unreachable is a pit, and gets filled.
	{

		const SEA = 0.25;
		const reach = new Uint8Array( SIZE * SIZE );
		const stack = [];

		for ( let x = 0; x < SIZE; x ++ ) {

			stack.push( x, ( SIZE - 1 ) * SIZE + x );

		}

		for ( let y = 0; y < SIZE; y ++ ) {

			stack.push( y * SIZE, y * SIZE + SIZE - 1 );

		}

		while ( stack.length ) {

			const i = stack.pop();
			if ( reach[ i ] || height[ i ] >= SEA ) continue;
			reach[ i ] = 1;

			const x = i % SIZE, y = ( i / SIZE ) | 0;
			if ( x > 0 ) stack.push( i - 1 );
			if ( x < SIZE - 1 ) stack.push( i + 1 );
			if ( y > 0 ) stack.push( i - SIZE );
			if ( y < SIZE - 1 ) stack.push( i + SIZE );

		}

		for ( let i = 0; i < SIZE * SIZE; i ++ ) {

			// Compressing the hollow is not enough on its own: a 3 m pit still
			// comes out below y = 0 and the sea plane draws a round pond in it.
			// Keep a hint of the dip, but never below the waterline.
			if ( height[ i ] < SEA && ! reach[ i ] ) {

				height[ i ] = Math.max( 0.12, SEA + ( height[ i ] - SEA ) * 0.10 );

			}

		}

	}

	await ( onProgress && onProgress( 'coast' ) );
	// ---- coastal deposition: the actual beaches ------------------------------
	// The pipe model carries sediment downhill. It has no longshore drift, so it
	// cannot build a beach — left alone it gullies the shore like any other
	// slope, and every coast comes out the same steep profile with a two-metre
	// sand ribbon along it. So the depositional coast is laid on afterwards: in
	// the bays, pull the first tens of metres of land down onto a ~1:35 sand
	// ramp, and let the sand end where the land it is filling against rises out
	// of reach.
	for ( let i = 0; i < SIZE * SIZE; i ++ ) {

		const h0 = height[ i ];
		// The ramp's gradient *is* the beach's width: the sand shows wherever the
		// deposited surface is still under `land.sandTop`, so halving the rise per
		// unit of coast field doubles how far inland that reaches. 14 gave a strip
		// you could cross in four paces.
		const ramp = 0.15 + 9.0 * Math.max( 0, coastS[ i ] );
		if ( h0 <= ramp ) continue;   // fills, never cuts — and never raises the seabed

		// deposition builds *against* the slope behind it: it cannot plane a
		// hillside down, so it fades out as the natural land rises away from the
		// profile. Height, not distance, is the right bound — the coast field's
		// gradient varies twenty-fold around the island, so a window measured in
		// it would flatten a headland here and do nothing there.
		const k = bayF[ i ] * smooth( 17.0, 3.0, h0 );
		if ( k <= 0.002 ) continue;

		height[ i ] = h0 + ( ramp - h0 ) * k;

	}

	await ( onProgress && onProgress( 'fields' ) );
	// ---- stage 3: fields off the eroded height ------------------------------

	const slopeF = new Float32Array( SIZE * SIZE );
	const concav = new Float32Array( SIZE * SIZE );

	for ( let y = 0; y < SIZE; y ++ ) {

		for ( let x = 0; x < SIZE; x ++ ) {

			const i = y * SIZE + x;
			const u = x / SIZE, v = y / SIZE;
			const h = height[ i ];

			const xm = ( x - 1 + SIZE ) % SIZE, xp = ( x + 1 ) % SIZE;
			const ym = ( y - 1 + SIZE ) % SIZE, yp = ( y + 1 ) % SIZE;

			const hxm = height[ y * SIZE + xm ], hxp = height[ y * SIZE + xp ];
			const hym = height[ ym * SIZE + x ], hyp = height[ yp * SIZE + x ];

			const slope = Math.hypot( hxp - hxm, hyp - hym ) / ( 2 * texelM );
			slopeF[ i ] = Math.min( 1, slope / 2.2 );

			// Laplacian: positive in hollows (gullies, valley floors), negative on
			// spurs. This is the field that makes creases read as creases.
			concav[ i ] = Math.max( - 1, Math.min( 1, ( hxm + hxp + hym + hyp - 4 * h ) / ( texelM * 1.6 ) ) );

			// **This is a mask, not a lushness dial**, and the difference is the
			// whole reason a meadow reads as dense or as moth-eaten. The blade compute
			// uses it as a *scale* multiplier — `baseScale = origScale × density`,
			// and anything under MIN_VISIBLE_SCALE is dropped — so one number
			// decides both how tall a blade is and whether it exists at all. At
			// `0.3 + 0.7·patches` times a wetness factor floored at 0.6, ordinary
			// dry meadow comes out at 0.18–0.6: every blade under half height, and
			// the low end of the patch noise culled outright. Patchiness is worth a
			// few tens of percent. What decides where the meadow *ends* is the
			// gates below, and those stay exactly as sharp as they were.
			//
			// **And it must not be a lattice.** `0.78 + 0.22·smooth(0.34, 0.62,
			// 0.55·d1 + 0.45·d2)` was two single value-noise octaves on 11² and
			// 29² grids — 200 m and 76 m cells — and a single octave of value
			// noise is a field of smooth rounded bumps. The contrast stretch then
			// turned each bump into a disc with a readable rim. That is the same
			// mistake this file already documents for the `t.w` shading channel
			// one paragraph down, and it printed the same artefact: pale ellipses
			// fifteen to twenty metres across scattered over open meadow, paler
			// *and* shorter than the grass around them, because density sets blade
			// height and the turf colour reads it as well.
			//
			// The replacement is a four-octave fbm, so the field has no
			// characteristic size for the eye to lock onto, and its large-scale
			// variation is causal instead: a hillside thins on convex shoulders
			// where the soil is shallow and thickens in the hollows water runs
			// through, both of which are already measured.
			const fb = 0.44 * dp1( u, v ) + 0.28 * dp2( u, v ) + 0.18 * dp3( u, v ) + 0.10 * dp4( u, v );
			let den = 0.87 + 0.13 * smooth( 0.30, 0.70, fb );
			den *= 1 - 0.14 * Math.max( 0, - concav[ i ] );   // shoulders and spurs run thin
			// out of the sand — tied to the same number the shading uses, so
			// widening the beach moves the grass line with it
			den *= smooth( land.sandTop - 0.6, land.sandTop + 1.1, h );
			// Grass holds banks; true cliffs go bare — and the numbers decide which
			// is which. At 0.88–1.30 this called every slope past 52 degrees a
			// cliff, which is **28% of the island's land**, and it printed as a
			// bare band right where the beach berm rises into the meadow: the
			// shore bank runs 54–58 degrees, so the whole of it came out at zero.
			// A grassed bank on a wet island goes to 60 and past it; what goes
			// bare is rock, and rock here starts around 65. 1.60–2.50 leaves 10%
			// of the land bare, and it is the massif's flanks and the sea cliffs.
			den *= 1 - smooth( 1.60, 2.50, slope );
			den *= 1 - smooth( land.treeLine, land.treeLine * 1.45, h ); // thins out up the massif
			// Scoured stream beds — but water scours where it *moves*, not where it
			// pools. Keyed on flow alone this fired hardest on the flat basins the
			// pipe model drains into, which is where flow accumulates and where
			// grass in fact grows best, and it stamped bald ellipses twenty metres
			// across onto otherwise lush hillsides. Flow × gradient is the channel.
			den *= 1 - 0.55 * smooth( 0.48, 0.95, flow[ i ] ) * smooth( 0.10, 0.34, slopeF[ i ] );
			den *= 0.96 + 0.06 * smooth( 0.02, 0.25, flow[ i ] ) + 0.10 * sediment[ i ]; // damp ground is lusher
			density[ i ] = Math.min( 1, den );

			// ambient occlusion from the local relief: hollows and the feet of
			// cliffs sit in their own shade all day
			ao[ i ] = Math.min( 1, 0.80 + 0.20 * ( 1 - slopeF[ i ] ) - 0.22 * Math.max( 0, concav[ i ] ) );

		}

	}

	await ( onProgress && onProgress( 'shore distance' ) );
	// ---- signed shore distance (m) — chamfer transform. The land is centred
	// on the wrap corner, so run the transform on an fftshifted copy (land in
	// the image centre) or the scanline passes would treat the island's middle
	// as a map edge.
	const dShore = new Float32Array( SIZE * SIZE );

	{

		const HALF = SIZE / 2;
		const shifted = ( i ) => {

			const x = ( i % SIZE + HALF ) % SIZE;
			const y = ( ( i / SIZE | 0 ) + HALF ) % SIZE;
			return y * SIZE + x;

		};

		const BIG = 1e9;
		const dLand = new Float32Array( SIZE * SIZE );  // distance to nearest land
		const dWater = new Float32Array( SIZE * SIZE ); // distance to nearest water

		for ( let i = 0; i < SIZE * SIZE; i ++ ) {

			const isLand = height[ shifted( i ) ] > 0;
			dLand[ i ] = isLand ? 0 : BIG;
			dWater[ i ] = isLand ? BIG : 0;

		}

		const chamfer = ( d ) => {

			for ( let y = 0; y < SIZE; y ++ ) {

				for ( let x = 0; x < SIZE; x ++ ) {

					const i = y * SIZE + x;
					let m = d[ i ];
					if ( x > 0 ) m = Math.min( m, d[ i - 1 ] + 1 );
					if ( y > 0 ) {

						m = Math.min( m, d[ i - SIZE ] + 1 );
						if ( x > 0 ) m = Math.min( m, d[ i - SIZE - 1 ] + 1.4142 );
						if ( x < SIZE - 1 ) m = Math.min( m, d[ i - SIZE + 1 ] + 1.4142 );

					}

					d[ i ] = m;

				}

			}

			for ( let y = SIZE - 1; y >= 0; y -- ) {

				for ( let x = SIZE - 1; x >= 0; x -- ) {

					const i = y * SIZE + x;
					let m = d[ i ];
					if ( x < SIZE - 1 ) m = Math.min( m, d[ i + 1 ] + 1 );
					if ( y < SIZE - 1 ) {

						m = Math.min( m, d[ i + SIZE ] + 1 );
						if ( x < SIZE - 1 ) m = Math.min( m, d[ i + SIZE + 1 ] + 1.4142 );
						if ( x > 0 ) m = Math.min( m, d[ i + SIZE - 1 ] + 1.4142 );

					}

					d[ i ] = m;

				}

			}

		};

		chamfer( dLand );
		chamfer( dWater );

		for ( let i = 0; i < SIZE * SIZE; i ++ ) {

			const s = shifted( i );
			dShore[ s ] = ( height[ s ] > 0 ? dWater[ i ] : - dLand[ i ] ) * texelM;

		}

	}

	// wrap-aware bilinear over any baked array
	const bilinear = ( arr, wxq, wzq ) => {

		const u = ( ( wxq / worldScale ) % 1 + 1 ) % 1;
		const v = ( ( wzq / worldScale ) % 1 + 1 ) % 1;
		const x = u * SIZE - 0.5, y = v * SIZE - 0.5;
		const x0 = ( Math.floor( x ) + SIZE ) % SIZE, y0 = ( Math.floor( y ) + SIZE ) % SIZE;
		const x1 = ( x0 + 1 ) % SIZE, y1 = ( y0 + 1 ) % SIZE;
		const fx = x - Math.floor( x ), fy = y - Math.floor( y );
		const a = arr[ y0 * SIZE + x0 ], b = arr[ y0 * SIZE + x1 ];
		const c = arr[ y1 * SIZE + x0 ], d = arr[ y1 * SIZE + x1 ];
		return a + ( b - a ) * fx + ( c - a + ( d - c - b + a ) * fx ) * fy;

	};

	const heightAt = ( x, z ) => bilinear( height, x, z );
	const shoreAt = ( x, z ) => bilinear( dShore, x, z );
	const densityAt = ( x, z ) => bilinear( density, x, z );

	const texelsPerM = SIZE / worldScale;

	// A canopy writes exactly one thing into the terrain fields: its own shade.
	//
	// Stamping anything else under a trunk — a disc of thinned grass at its
	// foot — prints a circle, and every shape of the stamp prints one:
	//
	//   1. clear density to zero  → a disc of bare soil under every trunk
	//   2. thin density by 30%    → still a disc, because the turf shading keys
	//      dryness *and* brightness off density: thin ground reads drier and
	//      lighter, so a thinned disc is a **tan** disc on green grass
	//   3. thin, but bounded      → same disc, one shade weaker
	//
	// The mistake is upstream of the tuning. Grass density is not a private
	// channel — the turf colour reads it too — so anything stamped into it in a
	// circle shows up as a circle no matter how gently it is stamped. A tree in
	// a meadow does not need a mown ring around it; the blades intersecting the
	// bole are invisible from any distance the discs were visible from. So the
	// scatter writes nothing into density at all, and the only shaped thing left
	// in that channel is the homestead yard, which is one place and is *meant*
	// to read as cleared.
	//
	// The occlusion it does write accumulates into its own field and is applied
	// to `ao` once, at the end. Multiplied into `ao` in place, with the wood at
	// 7.5 m spacing under 11 m crowns, every texel would take six or eight of
	// those multiplies: 0.6^7 is 0.03, a hole of pure black on the hillside.
	// Occlusion is bounded — however many
	// canopies are over you, the ground under them is shaded, not extinguished.
	const canopyOcc = new Float32Array( SIZE * SIZE );
	const OCC_MAX = 0.30;

	const stampCanopy = ( x, z, shadeM, shade ) => {

		const tx = Math.round( ( ( x / worldScale ) % 1 + 1 ) % 1 * SIZE );
		const tz = Math.round( ( ( z / worldScale ) % 1 + 1 ) % 1 * SIZE );
		const shadeR = Math.max( 2.5, shadeM * texelsPerM );
		const R = Math.ceil( shadeR * 1.35 );
		// two things stop this reading as a disc, and it needed both. The dome
		// falloff (below) gives the shade no rim to find — but a dome is still
		// radially symmetric, so its *outline* is a circle however soft it is.
		// So the radius itself is lobed, at two angular frequencies with a phase
		// drawn from where the tree stands, and the whole thing is then dappled
		// by a fine noise field. A crown seen from underneath is a scatter of
		// gaps, not a shadow with a boundary.
		const ph = ( x * 0.41 + z * 0.27 ) % 6.283;

		for ( let dz = - R; dz <= R; dz ++ ) {

			for ( let dx = - R; dx <= R; dx ++ ) {

				const d = Math.hypot( dx, dz );
				const a = Math.atan2( dz, dx );
				const lobe = 1 + 0.26 * Math.sin( 3 * a + ph ) + 0.15 * Math.sin( 5 * a - ph * 1.7 );
				const rr = shadeR * lobe;
				if ( d > rr ) continue;

				// A *dome*, not a plateau with a soft edge. The falloff used to
				// start at 35% of the radius, which leaves the inner third at
				// full strength and puts a readable rim where it lets go —
				// i.e. a disc. Falling off the whole way from the trunk keeps
				// the shade deepest where the crown is and gives it no edge to
				// find.
				const i = ( ( tz + dz + SIZE ) % SIZE ) * SIZE + ( ( tx + dx + SIZE ) % SIZE );
				const dapple = 0.45 + 0.55 * cd1( ( tx + dx ) / SIZE, ( tz + dz ) / SIZE );
				canopyOcc[ i ] = Math.min( OCC_MAX,
					canopyOcc[ i ] + shade * dapple * ( 1 - smooth( 0.0, rr, d ) ) );

			}

		}

	};

	await ( onProgress && onProgress( 'homestead' ) );
	// ---- the homestead site. Chosen rather than authored: score every coarse
	// cell on how level it is, how far inland it sits and whether it is meadow,
	// and take the best one. Then cut a level pad — a cabin standing on a 1:6
	// hillside reads as a mistake, and levelling the ground is the first thing
	// anyone building there would have done. Chosen *before* the tree scatters
	// so both can simply refuse to grow in the yard.
	let homestead = null;

	if ( homeCfg && homeCfg.enabled !== false ) {

		// The plot is a **rectangle aligned to the building**, not a disc: a
		// circle of levelled, grassless ground is the loudest possible shape on
		// an island. Nothing in a landscape is round; a building platform least
		// of all.
		// These are metres in the house's own frame: `u` across the front,
		// `v` along the axis with +v toward the water, wide enough to hold the
		// terraces as well as the envelope.
		// ...and they are the plot at scale 1, so the building's own scale applies
		// here too. The pad is what the house stands on; if the two disagree the
		// terraces cantilever off the edge of the cut.
		const S = homeCfg.scale ?? 1;
		const HU = homeCfg.plot[ 0 ] * S;
		const V0 = homeCfg.plot[ 1 ] * S, V1 = homeCfg.plot[ 2 ] * S;
		const VC = ( V0 + V1 ) * 0.5, VH = ( V1 - V0 ) * 0.5;
		const plotR = Math.hypot( HU, VH );

		const rT = Math.ceil( plotR * texelsPerM );
		let best = null;

		for ( let z = 0; z < SIZE; z += 4 ) {

			for ( let x = 0; x < SIZE; x += 4 ) {

				const i = z * SIZE + x;
				const h = height[ i ], d = dShore[ i ];

				if ( h < land.sandTop + 3 || h > 70 ) continue;
				if ( d < homeCfg.shoreRange[ 0 ] || d > homeCfg.shoreRange[ 1 ] ) continue;
				if ( density[ i ] < 0.55 ) continue;

				let lo = 1e9, hi = - 1e9;

				for ( let dz = - rT; dz <= rT; dz ++ ) {

					for ( let dx = - rT; dx <= rT; dx ++ ) {

						if ( dx * dx + dz * dz > rT * rT ) continue;
						const hh = height[ ( ( z + dz + SIZE ) % SIZE ) * SIZE + ( ( x + dx + SIZE ) % SIZE ) ];
						if ( hh < lo ) lo = hh;
						if ( hh > hi ) hi = hh;

					}

				}

				// level ground first, meadow second, and a mild pull toward the
				// middle of the allowed shore band so it is neither on the dunes
				// nor lost in the interior
				const mid = ( homeCfg.shoreRange[ 0 ] + homeCfg.shoreRange[ 1 ] ) * 0.5;
				const score = ( hi - lo ) * - 1.0 + density[ i ] * 3 - Math.abs( d - mid ) * 0.006;

				if ( ! best || score > best.score ) best = { x, z, score, h };

			}

		}

		if ( best ) {

			const hx = ( best.x / SIZE - ( best.x / SIZE > 0.5 ? 1 : 0 ) ) * worldScale;
			const hz = ( best.z / SIZE - ( best.z / SIZE > 0.5 ? 1 : 0 ) ) * worldScale;

			// Face the house down the shore gradient — toward the water, the way
			// anyone who built there would have wanted to sit. This has to be
			// settled *before* the ground is cut, because the cut is aligned to
			// the building.
			const gx = shoreAt( hx + 3, hz ) - shoreAt( hx - 3, hz );
			const gz = shoreAt( hx, hz + 3 ) - shoreAt( hx, hz - 3 );
			const rot = Math.atan2( - gz, - gx );
			const cs = Math.cos( rot ), sn = Math.sin( rot );

			// signed distance to the plot rectangle, in metres — negative inside
			const plotDist = ( wx, wz ) => {

				const dx = wx - hx, dz = wz - hz;
				const u = dx * sn - dz * cs;
				const v = dx * cs + dz * sn;
				const qu = Math.abs( u ) - HU, qv = Math.abs( v - VC ) - VH;
				return Math.hypot( Math.max( qu, 0 ), Math.max( qv, 0 ) )
					+ Math.min( Math.max( qu, qv ), 0 );

			};

			const R = Math.ceil( ( plotR + 32 ) * texelsPerM );
			const mPerTexel = 1 / texelsPerM;

			// the floor level is the mean of the ground the building stands on
			let sum = 0, n = 0;

			for ( let dz = - R; dz <= R; dz ++ ) {

				for ( let dx = - R; dx <= R; dx ++ ) {

					if ( plotDist( hx + dx * mPerTexel, hz + dz * mPerTexel ) > 0 ) continue;
					sum += height[ ( ( best.z + dz + SIZE ) % SIZE ) * SIZE + ( ( best.x + dx + SIZE ) % SIZE ) ];
					n ++;

				}

			}

			const padY = sum / Math.max( 1, n );

			// cut the terrace, blending out over 30 m so it reads as a shelf
			// somebody graded rather than as a plateau dropped on the hill —
			// and clear the blades only where the building's own paving covers
			// the ground, with a 4 m feather back into meadow
			for ( let dz = - R; dz <= R; dz ++ ) {

				for ( let dx = - R; dx <= R; dx ++ ) {

					const d = plotDist( hx + dx * mPerTexel, hz + dz * mPerTexel );
					const i = ( ( best.z + dz + SIZE ) % SIZE ) * SIZE + ( ( best.x + dx + SIZE ) % SIZE );
					height[ i ] += ( padY - height[ i ] ) * smooth( 30.0, 2.0, d );
					density[ i ] *= 1 - 0.95 * smooth( 2.5, - 1.5, d );

				}

			}

			homestead = { x: hx, z: hz, y: padY, rot, radius: plotR + 5 };

		}

	}

	// nothing grows in the yard — or in the clearing the scene opens on
	const inYard = ( x, z ) => {

		if ( land.spawn ) {

			// distance to the segment from the player to the opening lens
			const ax = land.spawn[ 0 ], az = land.spawn[ 1 ];
			const bx = ax + land.spawnEye[ 0 ], bz = az + land.spawnEye[ 2 ];
			const dx = bx - ax, dz = bz - az;
			const t = Math.max( 0, Math.min( 1,
				( ( x - ax ) * dx + ( z - az ) * dz ) / ( dx * dx + dz * dz ) ) );
			const px = x - ( ax + dx * t ), pz = z - ( az + dz * t );
			if ( px * px + pz * pz < land.spawnClear * land.spawnClear ) return true;

		}

		if ( ! homestead ) return false;
		const dx = homestead.x - x, dz = homestead.z - z;
		return dx * dx + dz * dz < ( homestead.radius * 1.35 ) ** 2;

	};

	await ( onProgress && onProgress( 'palm scatter' ) );
	// ---- palm scatter: grove-clustered along the coast, a few inland stands,
	// leaning seaward, then stamped into the density + occlusion channels
	const palms = [];

	if ( treesCfg && treesCfg.count > 0 ) {

		const EXT = worldScale * 0.48;
		let attempts = 0;

		while ( palms.length < treesCfg.count && attempts < treesCfg.count * 500 ) {

			attempts ++;

			const x = ( rand() * 2 - 1 ) * EXT;
			const z = ( rand() * 2 - 1 ) * EXT;
			const h = heightAt( x, z );
			const dS = shoreAt( x, z );
			const grove = g1( ( ( x / worldScale ) % 1 + 1 ) % 1, ( ( z / worldScale ) % 1 + 1 ) % 1 );

			const inlandTree = rand() < treesCfg.inlandFraction;

			if ( inlandTree ) {

				if ( dS < 100 || h < 3 || h > 34 || grove < 0.55 ) continue;

			} else {

				// The height band is the binding gate, not the distance one: after
				// the beach ramp was widened only ~1% of the map sits between 0.6
				// and 9 m, and a `count` of 420 was quietly delivering 41 palms.
				if ( dS < 7 || dS > 135 || h < 0.6 || h > 17 || grove < 0.28 ) continue;

			}

			// palms grow on sand and gentle ground, not on eroded cliff faces
			const bx = ( ( x / worldScale ) % 1 + 1 ) % 1 * SIZE | 0;
			const bz = ( ( z / worldScale ) % 1 + 1 ) % 1 * SIZE | 0;
			if ( slopeF[ bz * SIZE + bx ] > 0.42 ) continue;
			if ( inYard( x, z ) ) continue;

			let ok = true;

			for ( const p of palms ) {

				const dx = p.x - x, dz = p.z - z;

				if ( dx * dx + dz * dz < treesCfg.spacing * treesCfg.spacing ) { ok = false; break; }

			}

			if ( ! ok ) continue;

			// lean seaward (down the shore-distance gradient), harder near the surf
			const gx = shoreAt( x + 2, z ) - shoreAt( x - 2, z );
			const gz = shoreAt( x, z + 2 ) - shoreAt( x, z - 2 );
			const seaward = Math.atan2( - gz, - gx ) + ( rand() - 0.5 ) * 0.9;

			palms.push( {
				x, z, h,
				rot: rand() * Math.PI * 2,
				scale: 0.85 + rand() * 0.65,
				lean: 0.04 + rand() * 0.13 + 0.10 * smooth( 25, 8, dS ),
				leanDir: seaward,
			} );

		}

		for ( const p of palms ) stampCanopy( p.x, p.z, 5.5 * p.scale, 0.26 );

	}

	await ( onProgress && onProgress( 'woodland scatter' ) );
	// ---- broadleaf woodland: the island's interior. Palms hold the coast, but
	// inland the soil is deep enough for trees with a bole you can walk under.
	// Two noise octaves cluster them into stands with real clearings between —
	// an evenly spread scatter reads as an orchard, and it is the clearings that
	// make a wood look like somewhere you could walk.
	const grove = [];

	if ( groveCfg && groveCfg.count > 0 ) {

		const EXT = worldScale * 0.46;
		let attempts = 0;

		while ( grove.length < groveCfg.count && attempts < groveCfg.count * 200 ) {

			attempts ++;

			const x = ( rand() * 2 - 1 ) * EXT;
			const z = ( rand() * 2 - 1 ) * EXT;
			const h = heightAt( x, z );
			const dS = shoreAt( x, z );

			if ( dS < 40 || h < land.sandTop + 1.5 || h > land.treeLine * 0.92 ) continue;
			if ( inYard( x, z ) ) continue;

			const u = ( ( x / worldScale ) % 1 + 1 ) % 1;
			const v = ( ( z / worldScale ) % 1 + 1 ) % 1;
			const stand = 0.64 * w1( u, v ) + 0.36 * w2( u, v );
			if ( stand < 0.32 ) continue;

			const i = ( v * SIZE | 0 ) * SIZE + ( u * SIZE | 0 );
			// timber wants gentle, drained ground: not the cliff faces, not the
			// channel bottoms the erosion pass keeps scouring
			// 0.30 is 17°, which on a volcanic island is nearly nowhere: it kept the
			// whole wood in the coastal apron and left the interior empty. 0.72
			// is 36° — steep, but forest grows on 36° all over the tropics, and
			// the interior here *is* ridges, so anything gentler leaves them bald.
			if ( slopeF[ i ] > 0.72 || flow[ i ] > 0.7 ) continue;

			// Spacing varies with the stand field instead of being flat. A single
			// minimum distance everywhere gives an orchard however the noise is
			// tuned — every tree the same distance from its neighbours. Letting
			// thick ground pack to ~4.5 m and thin ground open out to ~11 m is
			// what makes a thicket a thicket and a clearing a clearing.
			const sp = groveCfg.spacing * ( 1.45 - 0.85 * Math.min( 1, ( stand - 0.32 ) / 0.5 ) );

			let ok = true;

			for ( const t of grove ) {

				const dx = t.x - x, dz = t.z - z;
				if ( dx * dx + dz * dz < sp * sp ) { ok = false; break; }

			}

			if ( ! ok ) continue;

			for ( const p of palms ) {

				const dx = p.x - x, dz = p.z - z;
				if ( dx * dx + dz * dz < 81 ) { ok = false; break; }

			}

			if ( ! ok ) continue;

			// how crowded the stand is decides the shape: trees in the middle of
			// a wood run up narrow reaching for light, edge trees spread wide
			const crowd = smooth( 0.40, 0.82, stand );

			grove.push( {
				x, z, h,
				rot: rand() * Math.PI * 2,
				scale: 1.05 + rand() * 0.55 + ( 1 - crowd ) * 0.20,
				spread: 1.18 - crowd * 0.42 + ( rand() - 0.5 ) * 0.16,
				lean: ( rand() - 0.5 ) * 0.11,
				leanDir: rand() * Math.PI * 2,
				seed: rand(),
			} );

		}

		for ( const t of grove ) stampCanopy( t.x, t.z, 8.5 * t.scale, 0.24 );

	}

	for ( let i = 0; i < SIZE * SIZE; i ++ ) ao[ i ] *= 1 - canopyOcc[ i ];

	await ( onProgress && onProgress( 'packing' ) );
	// ---- pack the textures
	const toHalf = THREE.DataUtils.toHalfFloat;

	const rgba = new Uint16Array( SIZE * SIZE * 4 );
	const rg = new Uint16Array( SIZE * SIZE * 2 );
	const fld = new Uint16Array( SIZE * SIZE * 4 );

	for ( let i = 0; i < SIZE * SIZE; i ++ ) {

		rgba[ i * 4 ] = toHalf( Math.min( 1, Math.max( 0, height[ i ] / heightSpan ) ) );
		rgba[ i * 4 + 1 ] = toHalf( density[ i ] );
		rgba[ i * 4 + 2 ] = toHalf( ao[ i ] );
		rgba[ i * 4 + 3 ] = toHalf( posNoise[ i ] );

		rg[ i * 2 ] = toHalf( height[ i ] );
		rg[ i * 2 + 1 ] = toHalf( dShore[ i ] );

		fld[ i * 4 ] = toHalf( flow[ i ] );
		fld[ i * 4 + 1 ] = toHalf( sediment[ i ] );
		fld[ i * 4 + 2 ] = toHalf( concav[ i ] * 0.5 + 0.5 );
		fld[ i * 4 + 3 ] = toHalf( slopeF[ i ] );

	}

	const wrapLinear = ( t, mips = false ) => {

		t.wrapS = t.wrapT = THREE.RepeatWrapping;
		t.magFilter = THREE.LinearFilter;
		t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
		t.generateMipmaps = mips;
		if ( mips ) t.anisotropy = 8;
		t.needsUpdate = true;
		return t;

	};

	// The map is the *noise* source, and the shader taps it at up to 143× — an
	// effective texel of 1.5 cm. Bilinear with no mip chain means every one of
	// those taps is undersampled past ten metres or so, and an undersampled
	// noise texture does not go quiet, it returns moiré: broad organic blotches
	// with hard edges that turn a beach into camouflage. Mipmaps are the answer
	// rather than fading the term out, because the band-limited average of sand
	// grain *is* sand — flattening it to a constant is how the beach became felt
	// in the first place. Anisotropy keeps it from smearing at grazing angles,
	// which is every ground shot from eye height.
	const map = wrapLinear( new THREE.DataTexture( rgba, SIZE, SIZE, THREE.RGBAFormat, THREE.HalfFloatType ), true );
	// Not the heightfield: the mesh and the player read exact metres off it, and
	// a mip chain would move the waterline with the camera.
	const heightTex = wrapLinear( new THREE.DataTexture( rg, SIZE, SIZE, THREE.RGFormat, THREE.HalfFloatType ) );
	const fields = wrapLinear( new THREE.DataTexture( fld, SIZE, SIZE, THREE.RGBAFormat, THREE.HalfFloatType ), true );

	// The sand's own detail tile. Nothing in the maps above can stand in for it:
	// they are terrain fields at 2.15 m texels, and a beach needs energy down to
	// the pixel. See ./sand.js.
	await ( onProgress && onProgress( 'sand detail' ) );
	const detail = makeSandDetail();

	return { map, heightTex, fields, detail, heightAt, shoreAt, densityAt, heightSpan, palms, grove, homestead, size: SIZE };

}

// the live terrain shadow — its own module-level helper so main.js can drive it
export function makeTerrainShadow( terrain, land, sunDirU ) {

	return makeSunShadow( terrain.heightTex, terrain.size, land.worldScale, sunDirU );

}

// The visible terrain mesh. Vertices ride the eroded heightfield; the shading
// walks the material classes the erosion produced — bedrock on scoured faces,
// scree at their feet, gravel in the channels, meadow on the interfluves, sand
// where the coast can pile it.
export function makeIslandMesh( terrain, atmosphere, gConfig, land, shadow, shore ) {

	const worldScale = land.worldScale;

	const srgb = ( r, g, b ) => {

		const c = new THREE.Color().setRGB( r, g, b, THREE.SRGBColorSpace );
		return vec3( c.r, c.g, c.b );

	};

	const uniforms = {
		sunDir: atmosphere.uniforms.sunDir,
		sunColor: atmosphere.uniforms.sunColor,
		time: atmosphere.uniforms.time,
		sunStrength: uniform( 2.0 ),   // sun radiance → this rig's units
		// Once `skyRad` is a genuine hemisphere *average* rather than the zenith,
		// this coefficient is physical: for a Lambertian surface the reflected
		// radiance under an irradiance E = π·L̄ is albedo·L̄, so the right number
		// is 1 — and the number below is well under it, because `inscatter` returns
		// the sky *with* its aerial perspective and the LUT's glow band is already
		// generous. It is tuned so noon lands where it did before the fill changed
		// shape, which is the only honest way to compare the two at dusk.
		skyStrength: uniform( 0.45 ),  // hemisphere fill taken from the real sky
		// the LUT's night sky is genuinely near-black; without a moonlight floor
		// the island disappears rather than turning silver
		moonFill: uniform( new THREE.Color( 0, 0, 0 ) ),
		// ...and a floor is only half of it. An ambient term alone lifts the land
		// off black but leaves it *shapeless* — every slope the same value, the
		// whole island one flat silhouette, which is what "the night is dull"
		// actually means. The moon is a light with a direction; give it one and
		// the ridges model again. It is the same rig the sun uses, one stop of
		// wrap softer, and it carries no shadow map: a cast shadow at this
		// radiance is below the noise floor and costs a second bake.
		moonDir: atmosphere.uniforms.moonDir,
		moonRad: uniform( new THREE.Color( 0, 0, 0 ) ),
		bounce: uniform( new THREE.Color( 0.16, 0.13, 0.09 ) ), // ground-to-ground
		deepTint: uniform( new THREE.Color( 0.02, 0.045, 0.065 ) ),
		// Shared with the sky rig: 1 while the eye is under the surface. The
		// seabed is shaded differently from the two sides of the interface —
		// from above it is a hint of colour through a metre of green water, from
		// below it is the floor you are swimming over — and the same triangles
		// serve both.
		submerged: atmosphere.uniforms.submerged,
		seaLevel: atmosphere.uniforms.seaLevel,
	};

	const material = new THREE.MeshBasicNodeMaterial();

	// signed height + shore distance ride in the same RG texel, so one fetch
	// serves both — worth doing, because the shading needs nine taps of it
	const HD = Fn( ( [ xz ] ) => texture( terrain.heightTex, xz.div( worldScale ) ).level( 0 ).xy );
	const H = Fn( ( [ xz ] ) => HD( xz ).x );

	const vXZ = varying( positionGeometry.xz );

	material.positionNode = Fn( () => {

		return vec3( positionGeometry.x, H( positionGeometry.xz ), positionGeometry.z );

	} )();

	material.colorNode = Fn( () => {

		const xz = vXZ;
		const here = HD( xz ).toVar();
		const h = here.x.toVar();
		const dS = here.y.toVar();       // shore distance, + inland
		const uv = xz.div( worldScale );

		const dCam = length( positionWorld.sub( cameraPosition ) ).toVar();
		const detailFade = smoothstep( 220.0, 40.0, dCam ).toVar();

		// ---- surface frame. Four neighbour taps give both the surface normal
		// and the shore-distance gradient the beach runs on.
		const e = float( 2.2 );
		const px = HD( xz.add( vec2( e, 0 ) ) ).toVar();
		const mx = HD( xz.sub( vec2( e, 0 ) ) ).toVar();
		const pz = HD( xz.add( vec2( 0, e ) ) ).toVar();
		const mz = HD( xz.sub( vec2( 0, e ) ) ).toVar();

		const N = normalize( vec3( mx.x.sub( px.x ), e.mul( 2.0 ), mz.x.sub( pz.x ) ) ).toVar();

		const t = texture( terrain.map, uv ).toVar();
		const f = texture( terrain.fields, uv ).toVar();
		const flow = f.x.toVar(), sed = f.y.toVar();
		const concav = f.z.mul( 2.0 ).sub( 1.0 ).toVar();
		const slope = f.w.toVar();

		const fine = texture( terrain.map, uv.mul( 11.0 ) ).w.toVar();
		const fine2 = texture( terrain.map, uv.mul( 37.0 ) ).w.toVar();
		const micro = texture( terrain.map, uv.mul( 143.0 ) ).w.toVar();
		const mottle = fine.mul( 0.5 ).add( fine2.mul( 0.32 ) ).add( micro.mul( 0.18 ) ).toVar();

		// sand accumulates where the coast is gentle; a scoured headland is rock
		// to the waterline. Decided here rather than in sand.js: which material
		// class a texel belongs to is this file's job.
		const sandF = smoothstep( land.sandTop + 0.7, land.sandTop - 0.6, h )
			.mul( smoothstep( 0.55, 0.28, slope ) ).toVar();

		// Near the camera the 2 m mesh is not enough: bump the normal with the
		// same noise the colour uses, so ground reads as ground underfoot.
		//
		// The amplitude here is the single most destructive number in this file.
		// `micro` is a raw value noise, full range, with half-metre features, so
		// 0.55 of it tilts the normal by ±25° from one blob to the next — and
		// under a low sun `NdL` then swings from nothing to a half between
		// neighbours, which is why the beach came out as camouflage at golden
		// hour and looked fine at noon. Ground meso-detail is a few degrees.
		//
		// **Sand is excluded.** It gets its own relief from a texture that
		// genuinely carries grain and mips down honestly; laying a 0.5 m
		// value-noise lattice over that puts the square blobs straight back.
		N.assign( normalize( N.add( vec3(
			fine2.sub( 0.5 ).add( micro.sub( 0.5 ).mul( 0.7 ) ),
			0.0,
			micro.sub( 0.5 ).add( fine2.sub( 0.5 ).mul( 0.7 ) ) )
			.mul( detailFade.mul( 0.16 ).mul( sandF.oneMinus() ) ) ) ) );

		// ---- meadow
		//
		// **Nothing here reads `t.w` at 1x.** That channel is a *single*
		// value-noise octave on a 29x29 lattice: at 1x its cells are 76 m
		// across and each one is a smooth rounded bump, so using it for
		// large-scale colour — as both the green/dry mix and the dryness
		// threshold used to — prints a field of soft ellipses over the whole
		// island. This was the last and the most stubborn of the "why are
		// there so many circles" bugs, and the only one that was not a stamp:
		// the two before it were discs written into the density channel under
		// every trunk, and fixing those left this one standing, because a round
		// *field* draws round patches however gently it is used. Tiled at 11x,
		// 37x and 143x the same channel is fine — at those scales it is texture,
		// not shape.
		//
		// The large-scale variation is causal instead. A hillside dries where
		// the ground is convex and steep — ridges, shoulders, the crowns
		// between gullies — and stays green in the hollows the water runs
		// through. That is already in the fields map, and it has the shape of
		// the terrain rather than the shape of a lattice.
		const convex = smoothstep( 0.03, 0.30, concav.negate() ).toVar();
		const turf = mix( srgb( 0.10, 0.16, 0.08 ), srgb( 0.24, 0.38, 0.19 ),
			fine.mul( 0.44 ).add( fine2.mul( 0.22 ) ).add( convex.mul( 0.16 ) ) ).toVar();
		// dryness follows the relief, a little fine breakup, AND low blade
		// density, so a bladeless patch reads as short dry grass — never lush
		// felt with no blades standing in it. Damp ground (flow, sediment,
		// hollows) stays green.
		const dry = convex.mul( 0.32 )
			.add( smoothstep( 0.14, 0.64, slope ).mul( 0.14 ) )
			.add( smoothstep( 30.0, 140.0, h ).mul( 0.12 ) )
			.add( fine.sub( 0.5 ).mul( 0.26 ) )
			.add( smoothstep( 0.30, 0.04, t.y ).mul( 0.30 ) )
			.sub( flow.mul( 0.45 ) ).sub( sed.mul( 0.25 ) ).clamp( 0.0, 1.0 );
		turf.assign( mix( turf, srgb( 0.46, 0.42, 0.22 ), dry ) );
		// blade-clump-scale striation so far turf reads as grass, not felt
		turf.mulAssign( micro.sub( 0.5 ).mul( 0.32 ).add( 1.0 ) );
		// ...and the floor *under* a standing canopy is in its shadow. Without
		// this the ground keeps its open-field brightness between the blades, so
		// every gap in a dense meadow still reads as a bald patch of dry earth.
		// **and the ramp has to finish before the meadow's own range starts.**
		// Meadow density runs roughly 0.84–1.0; ramping the floor's brightness
		// across 0.25→0.85 puts that entire range on the steep part of the
		// curve, so a 15% wobble in density came out as a 25% swing in ground
		// brightness — which is how every gentle patch in the density field got
		// printed on the hillside as a pale blotch. Saturating by 0.55 keeps the
		// whole effect (bare ground bright, grown-over ground shaded) and makes
		// it flat everywhere blades actually stand.
		turf.mulAssign( mix( float( 1.0 ), float( 0.50 ), smoothstep( 0.05, 0.55, t.y ) ) );

		const soil = mix( srgb( 0.21, 0.175, 0.10 ), srgb( 0.32, 0.27, 0.15 ), mottle );
		// What sits under the blades where the blades give out is **scrub**, not
		// bare earth. Blade density drops on anything over about 40°, and taking
		// that straight to soil painted every hillside on the island brown —
		// from the air the interior read as badlands, which is not what a wet
		// volcanic island looks like at 25°. Ground only goes bare where nothing
		// could root: too steep to hold soil, above the tree line, or scoured by
		// a wash.
		const scrub = mix( srgb( 0.105, 0.145, 0.075 ), srgb( 0.20, 0.26, 0.115 ),
			fine2.mul( 0.55 ).add( mottle.mul( 0.45 ) ) ).toVar();
		const bareW = max( max( smoothstep( 0.58, 0.98, slope ),
			smoothstep( land.treeLine * 0.85, land.treeLine * 1.15, h ) ),
			smoothstep( 0.45, 0.85, flow ).mul( smoothstep( 0.10, 0.30, slope ) ) ).toVar();
		// soil only where there is genuinely no grass — a partly thinned patch is
		// still meadow, and showing bare earth at half density is what turned the
		// foot of every tree into a tan disc
		const land_ = mix( mix( scrub, soil, bareW ), turf,
			smoothstep( 0.015, 0.26, t.y ) ).toVar();

		// ---- bedrock: strata banded by height, with the band phase warped by
		// noise at three scales so long walls never read as a layer cake
		const strataPhase = h.mul( 0.085 )
			.add( fine.sub( 0.5 ).mul( 5.4 ) )
			.add( t.w.sub( 0.5 ).mul( 3.1 ) )
			.add( fine2.sub( 0.5 ).mul( 1.7 ) );
		const strata = sin( strataPhase ).mul( 0.5 ).add( 0.5 ).mul( 0.55 ).add( 0.25 ).toVar();
		const rock = mix( srgb( 0.20, 0.185, 0.165 ), srgb( 0.44, 0.40, 0.35 ), strata ).toVar();
		// iron staining on long-exposed faces, lichen in the damp
		rock.assign( mix( rock, srgb( 0.34, 0.21, 0.13 ), smoothstep( 0.55, 0.85, fine ).mul( 0.45 ) ) );
		rock.assign( mix( rock, srgb( 0.16, 0.20, 0.12 ), smoothstep( 0.25, 0.7, flow ).mul( 0.35 ) ) );
		rock.mulAssign( micro.mul( 0.22 ).add( 0.89 ) );

		// scree: what the talus pass shed, piled at the foot of every face
		const scree = mix( srgb( 0.30, 0.28, 0.25 ), srgb( 0.46, 0.43, 0.38 ), fine2 )
			.mul( micro.mul( 0.3 ).add( 0.85 ) );

		// gravel in the channels the water actually cut
		const gravel = mix( srgb( 0.36, 0.34, 0.30 ), srgb( 0.52, 0.49, 0.44 ), micro );

		// ---- class weights, all continuous so everything filters cleanly.
		//
		// `slope` here is a gradient magnitude, so 0.34 is 19° and 0.72 is 36°.
		// These thresholds were all far too low and it is what made the island's
		// interior read as a quarry: bedrock from 19°, scree over every slope
		// between 12° and 32°, and gravel wherever the flow field was high
		// regardless of gradient. A 25° hillside is a meadow. Each class now has
		// to earn its ground:
		//
		//   rock   — steep enough that soil will not stay on it, or above the
		//            tree line
		//   scree  — the *hollow at the foot* of such a face, which is the only
		//            place talus actually piles; the concavity gate is what
		//            stops it painting whole flanks
		//   gravel — a channel, which means flow AND a gradient. Flow alone
		//            fires hardest in the flat basins the pipe model drains
		//            into, and it printed grey discs across level meadow.
		const rockW = max( smoothstep( 0.72, 1.18, slope ),
			smoothstep( land.treeLine, land.treeLine * 1.5, h ) ).toVar();
		const screeW = smoothstep( 0.42, 0.62, slope ).mul( smoothstep( 1.05, 0.75, slope ) )
			.mul( smoothstep( 8.0, 40.0, h ) )
			.mul( smoothstep( 0.05, 0.35, concav ) )
			.mul( rockW.oneMinus() ).toVar();
		const gravelW = smoothstep( 0.50, 0.92, flow )
			.mul( smoothstep( 0.06, 0.22, slope ) ).mul( smoothstep( 0.60, 0.34, slope ) )
			.mul( rockW.oneMinus() ).toVar();

		land_.assign( mix( land_, gravel, gravelW.mul( 0.7 ) ) );
		land_.assign( mix( land_, scree, screeW ) );
		land_.assign( mix( land_, rock, rockW ) );

		// damp margins darken — stream banks, seeps, the feet of gullies
		const wet = smoothstep( 0.25, 0.75, flow ).mul( 0.45 )
			.add( smoothstep( 0.1, 0.6, concav ).mul( 0.15 ) ).clamp( 0.0, 0.55 );
		land_.mulAssign( wet.mul( 0.5 ).oneMinus() );

		// ---- the beach — every phase runs on shore distance, not radius.
		// What sand *is* lives in ./sand.js: one tileable Perlin detail tile with
		// baked derivatives, read at three rotated world periods, plus the swash
		// wetness and the two ripple families. Tapping the terrain map's single
		// 76 m value-noise octave at 11×/37×/143×
		// is not three levels of detail — it is one field of square lattice
		// blobs repeated at 6.9 m, 2.05 m and 0.53 m, and those cells are the
		// blocky look a beach fights.
		const shoreDir = normalize( vec2( px.y.sub( mx.y ), pz.y.sub( mz.y ) ).add( 1e-5 ) );

		// The waterline, from the model the sea's own surface is standing on
		// (./shore.js). The wet sand is not where the water *is*, it is where the
		// water **was** — a sheet runs up, drains back in a second and leaves a
		// dark tongue shrinking behind it. One way to get that is reading the
		// waterline at a delay and taking the max with the current one; here the
		// same thing falls out of the model's own run-up envelope,
		// which is exact rather than tuned to a delay.
		const w = shore.sample( xz, h, dS );

		// A beach has *three* tones, not two: bright dry back-beach, a damp
		// mid-tone that never dries between waves, and the moving wet strip under
		// the sheet itself. Drop the mid-tone and the strip has nothing to sit
		// against and the whole beach flattens to one note. Both come off the same
		// function the sea's surface is standing on — the dark tongue shrinks as
		// the sheet drains because it *is* the sheet, and the damp zone reaches
		// exactly as far as the water ever does.
		// Both bands live *above* the current sheet, and both are narrow. Two
		// mistakes were worth making here. A band centred on the waterline is a
		// band you never see — the sand a swash has just left is uphill of it, so
		// it is all under water. And the widths are in *metres of elevation*, which
		// is a trap on a surface whose gradient varies twentyfold: the coves ramp
		// at 1:42 and the steeper faces at 1:18, so the same 0.26 m is seventeen
		// metres of beach in one place and five in another. Render the term
		// straight to the screen and set the widths off *that*, rather than
		// reasoning from a slope figure that only holds in one cove.
		// The sheet's own edge is frayed by the shoreline model's last-centimetre
		// term, and the ocean's alpha subtracts the identical number — so the dark
		// wet strip breaks into the same rivulets the water does, rather than each
		// drawing its own smooth outline a hand's width apart.
		const lvl = w.level.sub( w.fray ).toVar();
		const wetNow = smoothstep( lvl.add( 0.14 ), lvl.sub( 0.02 ), h );
		const wetDamp = smoothstep( w.envelope.add( 0.22 ), w.envelope.add( 0.01 ), h ).mul( 0.6 );
		// ...and the sand around whatever the last wave left standing. Runnels and
		// hollows near sea level hold water between swashes, and sand that has a
		// pool sitting in it is soaked, not damp. Bounded by shore distance, not
		// by elevation, or every low patch inland comes out wet.
		const wetPool = smoothstep( 0.14, - 0.02, h ).mul( smoothstep( 45.0, 6.0, dS ) );
		const wetness = max( max( wetNow, wetDamp ), wetPool ).toVar();

		const beach = beachSurface( {
			detail: terrain.detail,
			xz, h, dS, wetness, shoreDir, dCam, N,
		} );

		N.assign( normalize( mix( N, beach.N, sandF ) ) );

		const base = mix( land_, beach.albedo, sandF ).toVar();

		// ---- lighting: the physical sun colour + the real sky as a hemisphere
		const V = normalize( cameraPosition.sub( positionWorld ) ).toVar();
		const NdL = max( dot( N, uniforms.sunDir ), 0.0 ).toVar();
		const lit = shadow ? texture( shadow.tex, uv ).level( 0 ).x : float( 1.0 );

		// Oren–Nayar. Sand is the textbook rough surface — a dense field of
		// grains that shadow and inter-reflect — and Lambert has no answer for
		// it: no retro-reflection, so the moment the sun drops the beach goes
		// flat and muddy, exactly where a real one lights up. The `tan β` term
		// is unbounded when sun *and* eye both graze, which is precisely the
		// beach-at-sunset case, so it is capped; and the whole thing is
		// normalised on the head-on response, so this only ever adds what
		// Lambert was missing instead of re-tuning the noon exposure.
		const NdV = max( dot( N, V ), 0.0 ).toVar();
		const sig2 = mix( float( 0.12 ), float( 0.56 ), sandF ).toVar();   // σ², rock → sand
		const onA = float( 1.0 ).sub( sig2.mul( 0.5 ).div( sig2.add( 0.33 ) ) ).toVar();
		const onB = sig2.mul( 0.45 ).div( sig2.add( 0.09 ) ).toVar();
		const retro = min( max( dot( uniforms.sunDir, V ).sub( NdL.mul( NdV ) ), 0.0 )
			.div( max( max( NdL, NdV ), 0.05 ) ), 1.2 ).mul( onB.div( onA ) );

		const sunRad = uniforms.sunColor.mul( uniforms.sunStrength ).toVar();

		// Hemisphere fill, not zenith radiance — and this is the other half of why
		// the beach came out rust. A flat beach sees the *whole* sky, and the sky's
		// brightness distribution changes shape through the day: at noon it is
		// roughly even, at a low sun almost all of it is in the glow band along the
		// horizon while the zenith has already gone deep blue. One zenith tap
		// cannot describe both, and at golden hour it under-lights the ground
		// several times over, leaving the sun's own deep red with nothing to
		// balance it. Three taps can: the zenith plus the glow band toward and away
		// from the sun, weighted for the cosine a horizontal surface actually sees.
		// The sun-side tap sits low, at ~9°, because that is where the glow band
		// *is* — a tap at 25° is already out of it and hands back nearly the
		// zenith's own colour, which is the same failure one step smaller. The
		// anti-sun tap stays at 30°, where the counter-glow lives. The weights sum
		// to one, so a uniform sky reads exactly as it did before: this changes the
		// fill's *shape* through the day, not its overall level.
		const bear = normalize( vec2( uniforms.sunDir.x, uniforms.sunDir.z ).add( 1e-4 ) ).toVar();
		const SY = 0.16, SH = Math.sqrt( 1 - 0.16 * 0.16 );   // ~9° — the glow band
		const AY = 0.50, AH = Math.sqrt( 1 - 0.50 * 0.50 );   // ~30° — counter-glow
		const skyRad = atmosphere.inscatter( vec3( 0.0, 1.0, 0.0 ) ).mul( 0.42 )
			.add( atmosphere.inscatter( vec3( bear.x.mul( SH ), SY, bear.y.mul( SH ) ) ).mul( 0.34 ) )
			.add( atmosphere.inscatter( vec3( bear.x.mul( - AH ), AY, bear.y.mul( - AH ) ) ).mul( 0.24 ) )
			.mul( uniforms.skyStrength ).add( uniforms.moonFill ).toVar();

		// ...and on top of it, light *leaking through* the sand: `smoothstep(-0.2,
		// 1, N·L)` instead of `max(N·L, 0)`. Grains
		// are translucent quartz a fraction of a millimetre across, so light
		// enters one and leaves the next, and the terminator does not land on
		// zero — it wraps past it. That soft shoulder is most of why a beach
		// looks like sand and a Lambert one looks like painted card.
		// It *replaces* the rough-surface term on sand rather than stacking with
		// it — the wrap is the whole model of what grains do to light, and
		// laying it over Oren–Nayar's retro-reflection brightens the beach twice
		// and flattens every shadow on it.
		const diffuse = mix( NdL.mul( retro.add( 1.0 ) ),
			smoothstep( - 0.2, 1.0, dot( N, uniforms.sunDir ) ), sandF ).toVar();

		const ao = t.z.toVar();
		// wrapped, because at this level the terminator is the only thing the eye
		// has to go on and a hard one reads as a cut-out
		const moonLit = smoothstep( - 0.35, 1.0, dot( N, uniforms.moonDir ) );
		// ...and less of it on the sand. Rods barely see the warm end of the
		// spectrum, so a beach that is three times the turf's brightness at noon
		// comes much closer to it after dark. Rendered photopically the sand is
		// the only thing in a night frame — a pale plane filling the bottom half,
		// which reads as an overcast afternoon rather than as moonlight.
		const shade = sunRad.mul( diffuse.mul( lit ) )
			.add( uniforms.moonRad.mul( moonLit ).mul( mix( 1.0, 0.42, sandF ) ).mul( ao ) )
			.add( skyRad.mul( N.y.mul( 0.5 ).add( 0.5 ) ).mul( ao ) )
			.add( uniforms.bounce.mul( sunRad ).mul( ao ) );

		base.mulAssign( shade );

		// ---- specular: one microfacet lobe, one roughness.
		// Three hand-rolled powers — a `pow(·,60)` glint, a
		// Schlick sheen and a `pow(·,900)` sparkle — would each carry their own
		// mask and need re-tuning every time the sun moves. Sand's whole specular
		// story is a single number: dry sand is as rough as a surface gets, and a
		// swash sheet takes it to near-glass. Drive GGX with that and the wet
		// strip mirrors the sky at a low sun and goes quiet at noon on its own.
		const rough = mix( mix( float( 0.88 ), float( 0.42 ), wet ), beach.roughness, sandF ).toVar();

		// Fresnel describes an *interface*, and below the waterline the far side
		// of this one is water, not air. Quartz against air returns 4.5% head-on;
		// quartz against water returns 0.5%, because the index contrast collapses
		// from 1.54:1 to 1.54:1.33. Every specular term on this surface — the GGX
		// lobe, the sky mirror, the grain sparkle — is that number times some
		// geometry, so the one factor retires all three. It is also the fix for
		// the first thing wrong with the first dive: the sun sat on the seabed as
		// a bright disc a metre from the swimmer's mask, which is the wet-sand
		// mirror doing its job in the wrong medium. A seabed is matte; the swash
		// strip a metre inshore of it is a mirror; the only difference between
		// them is which fluid is touching the grains.
		const drowned = smoothstep( 0.05, - 0.5, h ).toVar();
		const F0 = mix( float( 0.025 ), float( 0.003 ), drowned ).toVar();

		const Hv = normalize( uniforms.sunDir.add( V ) ).toVar();
		const NdH = max( dot( N, Hv ), 0.0 ).toVar();
		const a2 = pow( rough, 4.0 ).toVar();                     // α = rough², α²
		const dn = NdH.mul( NdH ).mul( a2.sub( 1.0 ) ).add( 1.0 ).toVar();
		const D = a2.div( dn.mul( dn ).mul( Math.PI ) );
		const F = F0.add( F0.oneMinus().mul( pow( max( dot( V, Hv ), 0.0 ).oneMinus(), 5.0 ) ) );
		// Smith visibility, the Schlick-k form — cheap and stable at grazing,
		// which is every beach shot at golden hour
		const kv = pow( rough, 2.0 ).mul( 0.5 ).toVar();   // k = α/2, α = rough²
		const Vis = float( 0.5 ).div( max(
			NdL.mul( NdV.mul( kv.oneMinus() ).add( kv ) ).add( NdV.mul( NdL.mul( kv.oneMinus() ).add( kv ) ) ), 1e-4 ) );
		base.addAssign( sunRad.mul( D.mul( F ).mul( Vis ).mul( NdL ).mul( lit ) ) );

		// ...and the sky in it. Wet sand *mirrors* the sky, and that is the
		// loudest cue on the whole beach at a low sun — the reason the strip the
		// last wave covered reads as a sheet of light rather than as darker sand.
		const R = reflect( V.negate(), N ).toVar();
		const envF = F0.add( F0.oneMinus().mul( pow( NdV.oneMinus(), 5.0 ) ) )
			.mul( pow( rough.oneMinus(), 2.0 ) );
		base.addAssign( atmosphere.inscatter( R ).mul( uniforms.skyStrength ).mul( envF ) );

		// Every quartz grain is a little mirror, and the handful whose faces line
		// up sun-to-eye return a hard point of light. No smooth lobe gives that —
		// it is a sub-pixel population, not a roughness — so it rides its own
		// per-grain facet normal on the scattered-point lattice.
		const sparkle = pow( max( dot( reflect( V.negate(), beach.facetN ), uniforms.sunDir ), 0.0 ), 900.0 )
			.mul( beach.facetMask ).mul( sandF ).mul( lit ).mul( drowned.oneMinus() );
		base.addAssign( sunRad.mul( sparkle ).mul( 2.4 ) );

		// ---- foam drying on the sand between waves. The *running* sheet is the
		// ocean surface itself — it surges up the beach and drains back — so this
		// is only the residue, and it is the same `trail` term the sea paints its
		// own foam with, held to the strip the sheet has just left: still wet, but
		// no longer under water. Painted any wider it reads as blobs sitting on
		// dry sand next to a waterline that does not move.
		// carved by the detail tile at ~2.6 m, because drying foam is a lace of
		// bubble rafts and holes, never a painted shape
		const lace = texture( terrain.detail, xz.div( 2.6 ) ).z;
		const drying = w.trail.mul( smoothstep( w.envelope.add( 0.02 ), w.envelope.sub( 0.22 ), h ) )
			.mul( smoothstep( lvl.sub( 0.05 ), lvl.add( 0.10 ), h ) )   // above the sheet, not under it
			.mul( smoothstep( 0.36, 0.76, lace ) ).mul( 0.8 );
		base.assign( mix( base, sunRad.add( skyRad ).mul( 0.5 ), drying.clamp( 0.0, 1.0 ) ) );

		// ---- the bed. The same triangles have two jobs, because the surface has
		// two sides: from above, a hint of colour a metre down through green
		// water; from below, the floor you are swimming over. Both start from
		// the fact that the light down there arrived through a water column.

		const column = max( uniforms.seaLevel.sub( h ), 0.0 ).toVar();

		// Downwelling extinction. Water eats red an order of magnitude faster
		// than blue, so sand goes green-grey with depth whichever side it is
		// watched from — and this is *not* the same loss `aerial()` applies,
		// which only covers the ray from here back to the eye. Same coefficient
		// vector, because there is one ocean.
		base.mulAssign( exp( AQUATIC_EXTINCTION.mul( column ).negate() ) );

		// Caustics. The surface is a lens: every wave slope bends the sun into
		// the bed, and where neighbouring rays cross they leave the bright
		// filaments that make a shallow bottom read as *under water* rather
		// than as brown ground. The recipe: two
		// capillary samples at incommensurate scales, drifting at different
		// speeds and summed, then folded about zero so the web rides the zero
		// crossings — reading the sand-detail tile for the capillaries.
		//
		// The *derivative* channel, not the height channel, and that is the
		// whole difference between a caustic and a stain. The tile's height is
		// 1/f, so its lowest octave carries four times the amplitude of the one
		// above and the zero crossings come out as three broad blobs across the
		// screen. Its slope spectrum is flat by construction — the octave
		// amplitudes are 1/f and differentiating multiplies by f — so every
		// scale from 7 cm to a metre contributes equally, which is exactly the
		// spectrum of a caustic web: a coarse mesh with finer filaments strung
		// through it, all of it moving at once.
		const capA = texture( terrain.detail, xz.div( 7.0 )
			.add( vec2( 0.023, 0.011 ).mul( uniforms.time ) ) ).x;
		const capB = texture( terrain.detail, xz.div( 4.6 )
			.add( vec2( - 0.017, 0.019 ).mul( uniforms.time ) ) ).x;
		const web = pow( max( float( 1.0 ).sub( abs( capA.add( capB ) ).mul( 2.6 ) ), 0.0 ), 4.0 );
		// Depth defocuses them — the further the refracted rays travel the wider
		// the caustic cell spreads and the shallower its contrast — and they
		// stop at the waterline, because a caustic needs water over it.
		const focus = exp( column.mul( - 0.12 ) ).mul( smoothstep( 0.03, 0.30, column ) ).mul( lit );
		base.addAssign( sunRad.mul( web.mul( focus ).mul( 0.22 ) ) );

		// Submerged skirt fades to deep-water radiance — glimpsed through wave
		// troughs it must read as sea, not as a black slab. It starts *below*
		// the shoaling zone on purpose: the backwash of every wave bares a few
		// metres of bed, and bare bed is wet sand. Fading to navy from the
		// waterline paints a dark wedge along the whole coast every time a
		// trough passes.
		//
		// It is also a cheat that only works from one side. Seen from above, a
		// distant bed is mostly the water above it and painting it navy is
		// nearly free accuracy; seen from *below* it is the floor, a metre from
		// the swimmer's face, and the same navy erases it. So the skirt is the
		// eye's, not the bed's: `aerial()` takes over the moment the head goes
		// under, and it computes the same loss honestly, along the real ray.
		const sub = clamp( h.negate().sub( 1.4 ).div( 7.0 ), 0.0, 1.0 )
			.mul( uniforms.submerged.oneMinus() );
		base.assign( mix( base, uniforms.deepTint.mul( skyRad.add( 0.2 ) ), sub ) );

		// ---- aerial perspective: extinction toward the sky along this view ray
		return atmosphere.aerial( base, positionWorld, cameraPosition );

	} )();

	// ~2.6 m quads across the landmass: coarser and the erosion channels exist in
	// the heightfield but never reach the silhouette; finer and most triangles
	// are sub-pixel, which costs far more than it shows
	const geometry = new THREE.PlaneGeometry( land.meshSpan, land.meshSpan, 768, 768 );
	geometry.rotateX( - Math.PI / 2 );

	const mesh = new THREE.Mesh( geometry, material );
	mesh.frustumCulled = false;

	return { mesh, uniforms };

}
