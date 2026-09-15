// The beach material — what sand *is*.
//
// island.js owns where sand lands on the landmass and how the whole terrain is
// lit, and ./shore.js owns how wet it is; this module owns the surface itself:
// the detail texture sand is made of, its ripples, and the albedo / normal /
// roughness that come out of them.
//
// Everything here follows from one idea: **a beach needs real frequency
// content, all the way down to the pixel.** The terrain bake's noise channel is
// a single 76 m value-noise octave stored at 2.15 m texels, and the shading
// used to tap it at 11× / 37× / 143× as if that were three levels of detail.
// It is not. Tiling one texture does not manufacture detail — it repeats one
// field of smooth *square-lattice* blobs at 6.9 m, 2.05 m and 0.53 m, on a
// grid that comes back round every 200 / 59 / 15 metres. Those 2 m and 0.5 m
// lattice cells are the "voxel game" look, and above 0.5 m the map holds no
// energy at all, which is why the same beach that is camouflage at a grazing
// sun is a flat cream card at noon: every scrap of its structure lives in a
// normal, and the normal only shows up when the sun is low.
//
// So sand gets its own texture, and three properties it needs and the terrain
// map cannot have:
//
//   * **Perlin, not value noise.** A value-noise lattice reads as squares
//     however many octaves are stacked on it; gradient noise does not.
//   * **Octaves down to four texels.** Tiled at a 0.55 m period the texel is
//     1.07 mm, so the texture genuinely carries grain — and the mip chain
//     band-limits it *per pixel*, which is the only way grain can be grain
//     underfoot and quiet at forty metres instead of moiré.
//   * **Analytic derivatives baked in, not a height to difference.** A normal
//     then costs one tap, and it *filters correctly*: averaging slope flattens
//     a surface, which is exactly what distance does to sand. A height map
//     differenced in the shader gets louder as it undersamples.
//
// Channels: R,G = ∂h/∂u, ∂h/∂v of the relief fbm · B = the relief itself
// (grain-scale albedo) · A = a broad decorrelated fbm (metre-scale patches).

import * as THREE from 'three/webgpu';
import {
	texture, float, vec2, vec3,
	normalize, dot, mix, smoothstep, max, length, sin, pow, floor, fract,
} from 'three/tsl';

const DETAIL = 512;

// Periodic Perlin with an analytic gradient. `lattice` must divide DETAIL or
// the texture stops tiling.
function perlinOctave( lattice, rand ) {

	const gx = new Float32Array( lattice * lattice );
	const gy = new Float32Array( lattice * lattice );

	for ( let i = 0; i < lattice * lattice; i ++ ) {

		const a = rand() * Math.PI * 2;
		gx[ i ] = Math.cos( a );
		gy[ i ] = Math.sin( a );

	}

	// → [ n, dn/du, dn/dv ] for u,v ∈ [0,1)
	return ( u, v, out ) => {

		const X = u * lattice, Y = v * lattice;
		const ix = Math.floor( X ), iy = Math.floor( Y );
		const fx = X - ix, fy = Y - iy;

		const x0 = ( ( ix % lattice ) + lattice ) % lattice;
		const y0 = ( ( iy % lattice ) + lattice ) % lattice;
		const x1 = ( x0 + 1 ) % lattice, y1 = ( y0 + 1 ) % lattice;

		const i00 = y0 * lattice + x0, i10 = y0 * lattice + x1;
		const i01 = y1 * lattice + x0, i11 = y1 * lattice + x1;

		const a = gx[ i00 ] * fx + gy[ i00 ] * fy;
		const b = gx[ i10 ] * ( fx - 1 ) + gy[ i10 ] * fy;
		const c = gx[ i01 ] * fx + gy[ i01 ] * ( fy - 1 );
		const d = gx[ i11 ] * ( fx - 1 ) + gy[ i11 ] * ( fy - 1 );

		// quintic fade, so the second derivative is continuous too — a cubic
		// fade leaves a visible crease along every lattice line once the field
		// is differentiated, which is precisely what this texture is for
		const su = fx * fx * fx * ( fx * ( fx * 6 - 15 ) + 10 );
		const sv = fy * fy * fy * ( fy * ( fy * 6 - 15 ) + 10 );
		const du = 30 * fx * fx * ( fx * ( fx - 2 ) + 1 );
		const dv = 30 * fy * fy * ( fy * ( fy - 2 ) + 1 );

		const nx0 = a + su * ( b - a );
		const nx1 = c + su * ( d - c );

		const dx0 = gx[ i00 ] + su * ( gx[ i10 ] - gx[ i00 ] ) + du * ( b - a );
		const dx1 = gx[ i01 ] + su * ( gx[ i11 ] - gx[ i01 ] ) + du * ( d - c );

		const dy0 = gy[ i00 ] + su * ( gy[ i10 ] - gy[ i00 ] );
		const dy1 = gy[ i01 ] + su * ( gy[ i11 ] - gy[ i01 ] );

		out[ 0 ] = nx0 + sv * ( nx1 - nx0 );
		out[ 1 ] = ( dx0 + sv * ( dx1 - dx0 ) ) * lattice;
		out[ 2 ] = ( dy0 + sv * ( dy1 - dy0 ) + dv * ( nx1 - nx0 ) ) * lattice;

	};

}

// One 512² RGBA16F tile, mip-mapped. ~180 ms of the bake.
export function makeSandDetail() {

	let seed = 90210;
	const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;

	// Relief: amplitude ∝ 1/f, which makes the *slope* spectrum flat — every
	// octave tilts the surface by the same few degrees, so sand is equally
	// rough at every distance it is looked at, and each mip level simply hands
	// the next octave down. The top octave stops at four texels a cell: a
	// stored derivative any finer aliases into its own mip chain.
	const RELIEF = [ 8, 16, 32, 64, 128 ];
	// Patches: only the broad octaves, decorrelated from the relief, so the
	// metre-scale colour variation is not the grain seen from further away.
	const PATCH = [ 2, 4, 8, 16 ];

	const N = DETAIL * DETAIL;
	const raw = new Float32Array( N * 4 );
	const out = [ 0, 0, 0 ];

	const accumulate = ( lattices, write ) => {

		for ( const lattice of lattices ) {

			const oct = perlinOctave( lattice, rand );
			const amp = 1 / lattice;

			for ( let y = 0; y < DETAIL; y ++ ) {

				const v = y / DETAIL;

				for ( let x = 0; x < DETAIL; x ++ ) {

					oct( x / DETAIL, v, out );
					write( ( y * DETAIL + x ) * 4, amp, out );

				}

			}

		}

	};

	accumulate( RELIEF, ( i, amp, o ) => {

		raw[ i ] += o[ 1 ] * amp;
		raw[ i + 1 ] += o[ 2 ] * amp;
		raw[ i + 2 ] += o[ 0 ] * amp;

	} );

	accumulate( PATCH, ( i, amp, o ) => {

		raw[ i + 3 ] += o[ 0 ] * amp;

	} );

	// Normalise: derivatives against 3σ (so the knobs in the shader read as
	// peak slope and the tail clamps rather than the bulk), values against
	// their own range.
	let sum2 = 0, hMin = Infinity, hMax = - Infinity, pMin = Infinity, pMax = - Infinity;

	for ( let i = 0; i < N; i ++ ) {

		const k = i * 4;
		sum2 += raw[ k ] * raw[ k ] + raw[ k + 1 ] * raw[ k + 1 ];
		if ( raw[ k + 2 ] < hMin ) hMin = raw[ k + 2 ];
		if ( raw[ k + 2 ] > hMax ) hMax = raw[ k + 2 ];
		if ( raw[ k + 3 ] < pMin ) pMin = raw[ k + 3 ];
		if ( raw[ k + 3 ] > pMax ) pMax = raw[ k + 3 ];

	}

	const dScale = 1 / ( 3 * Math.sqrt( sum2 / ( 2 * N ) ) );
	const hScale = 1 / Math.max( 1e-6, hMax - hMin );
	const pScale = 1 / Math.max( 1e-6, pMax - pMin );

	const toHalf = THREE.DataUtils.toHalfFloat;
	const data = new Uint16Array( N * 4 );
	const clamp1 = ( v ) => v < - 1 ? - 1 : v > 1 ? 1 : v;

	for ( let i = 0; i < N; i ++ ) {

		const k = i * 4;
		data[ k ] = toHalf( clamp1( raw[ k ] * dScale ) );
		data[ k + 1 ] = toHalf( clamp1( raw[ k + 1 ] * dScale ) );
		data[ k + 2 ] = toHalf( ( raw[ k + 2 ] - hMin ) * hScale );
		data[ k + 3 ] = toHalf( ( raw[ k + 3 ] - pMin ) * pScale );

	}

	const tex = new THREE.DataTexture( data, DETAIL, DETAIL, THREE.RGBAFormat, THREE.HalfFloatType );
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.magFilter = THREE.LinearFilter;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.generateMipmaps = true;
	// every ground shot from eye height is a grazing one, and without this the
	// grain smears into streaks along the view instead of filtering
	tex.anisotropy = 16;
	tex.needsUpdate = true;

	return tex;

}

// ---------------------------------------------------------------------------

const srgb = ( r, g, b ) => {

	const c = new THREE.Color().setRGB( r, g, b, THREE.SRGBColorSpace );
	return vec3( c.r, c.g, c.b );

};

// The three world periods the detail tile is read at, each rotated against the
// others so no two ever line up and the repeat has no axis to sit on.
const P_FINE = 0.55, P_MID = 9.0, P_PATCH = 67.0;    // metres
const A_MID = 0.61, A_PATCH = - 0.29;                 // radians

const rot = ( p, a ) => {

	const c = Math.cos( a ), s = Math.sin( a );
	return vec2( p.x.mul( c ).sub( p.y.mul( s ) ), p.x.mul( s ).add( p.y.mul( c ) ) );

};

// a gradient sampled in a rotated frame comes back out through R(−a)
const unrot = ( d, a ) => {

	const c = Math.cos( a ), s = Math.sin( a );
	return vec2( d.x.mul( c ).add( d.y.mul( s ) ), d.y.mul( c ).sub( d.x.mul( s ) ) );

};

// Ripple profile. A ripple is not a sine: a long gentle stoss slope up to a
// sharp crest and a short lee, so `(1 − |sin|)^1.5` gives
// narrow crests over broad troughs where a sine gives even corrugations.
const crest = ( p ) => sin( p ).abs().oneMinus().pow( 1.5 ).sub( 0.27 );

/**
 * The beach surface at one point. Takes the terrain's own geometry and hands
 * back a material; the caller lights it.
 *
 * ctx: { detail, xz, h, dS, wetness, shoreDir, dCam, N }
 * →    { albedo, N, roughness, facetN, facetMask }
 *
 * Two things are deliberately *not* decided here. Where sand goes is island.js's
 * call — it owns the material classes. And how wet it is belongs to the shared
 * waterline (./shore.js), because the sea's own surface is standing on the same
 * function: a beach whose wet band runs on its own phase is a beach where the
 * dark tongue is never where the sheet that left it was.
 */
export function beachSurface( ctx ) {

	const { detail, xz, h, dS, wetness, shoreDir, dCam, N } = ctx;

	// ---- detail taps -------------------------------------------------------
	const dF = texture( detail, xz.div( P_FINE ) ).toVar();
	const dM = texture( detail, rot( xz, A_MID ).div( P_MID ) ).toVar();
	const dP = texture( detail, rot( xz, A_PATCH ).div( P_PATCH ) ).toVar();

	// ---- ripples -----------------------------------------------------------
	// Two families, because one alone is corduroy: the swash builds
	// shore-parallel ridges metres apart, the wind combs its own set across them
	// at a hand's width. Both flatten under water — the sand
	// normal noise scales by `1 − wetness²`, since a swash sheet fills the
	// micro-relief
	// and planes the surface, which is why the wet strip is the one glassy part
	// of a beach.
	const onSand = smoothstep( 3.4, 0.9, h ).mul( wetness.mul( wetness ).mul( 0.85 ).oneMinus() ).toVar();

	// Coarse: shore-parallel ridge and runnel, ~13 m, bent by the 67 m patch
	// field. Phase warps have to come from a field *smoother* than the pattern
	// they bend, or they facet it instead — the trap in warping a 30 cm comb
	// with a tap whose own texels are 5.8 cm.
	const ridge = crest( dS.mul( 0.48 ).add( dP.z.sub( 0.5 ).mul( 4.4 ) ) )
		.mul( smoothstep( 220.0, 40.0, dCam ).mul( 0.10 ).mul( onSand ) ).toVar();

	// Fine: wind-combed, ~26 cm. Three things keep it from reading as one
	// straight diagonal corduroy across the whole
	// beach: wind ripples come in **patches** (the wind does not comb a beach
	// uniformly), the crest lines **meander** over a few metres, and they are
	// sub-pixel within tens of metres so they need their own short leash.
	const windDir = vec2( 0.80, 0.60 );
	const combMask = smoothstep( 0.28, 0.60, dP.w ).toVar();
	const comb = crest( dot( xz, windDir ).mul( 24.0 )
		.add( dM.z.sub( 0.5 ).mul( 5.2 ) )        // metres-scale meander
		.add( dP.z.sub( 0.5 ).mul( 3.0 ) ) )      // the long bend
		.mul( smoothstep( 48.0, 6.0, dCam ).mul( 0.105 ).mul( onSand ).mul( combMask ) ).toVar();

	// ---- normal ------------------------------------------------------------
	// Grain relief straight off the stored derivatives. This is the term that
	// carries its own LOD: the mip chain averages *slope*, so the surface
	// flattens with distance exactly as sand does, instead of turning to moiré
	// the way a fixed-frequency noise tap does.
	// Grain does not fall evenly over a beach — it clumps, and coarse patches sit
	// next to fine ones. Without that the fine octaves read as one even sheet of
	// static laid over the whole frame instead of as a material.
	const clump = dM.w.mul( 0.9 ).add( 0.55 ).toVar();

	const gradF = vec2( dF.x, dF.y ).mul( clump.mul( 0.24 ) );
	const gradM = unrot( vec2( dM.x, dM.y ), A_MID ).mul( 0.17 );
	const relief = gradF.add( gradM ).mul( onSand.mul( 0.75 ).add( 0.25 ) ).toVar();

	const sandN = normalize( N
		.add( vec3( relief.x, 0.0, relief.y ) )
		.add( vec3( shoreDir.x, 0.0, shoreDir.y ).mul( ridge ) )
		.add( vec3( windDir.x, 0.0, windDir.y ).mul( comb ) ) ).toVar();

	// ---- albedo ------------------------------------------------------------
	// Sand is a *mixture*, and dry quartz beach sand is genuinely bright —
	// reflectance a third or better, quartz near `0.9/0.8/0.6`. The grey
	// belongs in the dark heavies in the mix, not in the quartz.
	//
	// The grain speckle is what keeps the beach from being a cream card at
	// noon: without it *all* of the structure lives in a
	// normal, and a normal shows nothing under a high sun. Albedo variation at
	// grain scale reads at every hour, and mips fade it out honestly.
	const quartz = srgb( 0.78, 0.715, 0.595 );
	const dark = srgb( 0.44, 0.36, 0.26 );
	const shellW = srgb( 0.94, 0.91, 0.84 );

	const heavies = dP.z.mul( 0.55 ).add( dM.z.mul( 0.45 ) ).toVar();
	const sandDry = mix( quartz, dark, smoothstep( 0.34, 0.90, heavies ).mul( 0.32 ) ).toVar();
	sandDry.mulAssign( dF.z.sub( 0.5 ).mul( clump.mul( 0.17 ) ).add( 1.0 ) );   // grain
	sandDry.mulAssign( dM.z.sub( 0.5 ).mul( 0.24 ).add( 1.0 ) );               // drift

	// Shell fragments and quartz facets ride a scattered-point lattice rather
	// than a cell hash: a hash is constant across its cell, so the beach comes
	// out sprinkled with axis-aligned pixels. Carry the cell's fractional
	// coordinate too, jitter a centre inside it and shade by distance to that
	// centre — same one hash per cell, round grains, no grid. Shell has to stay
	// *rare*: at one cell in five it stops being shell and becomes salt.
	const GS = 26.0;                                    // ~3.8 cm cells
	const gCell = floor( xz.mul( GS ) ).toVar();
	const gFrac = fract( xz.mul( GS ) ).toVar();
	const gHash = ( o ) => fract( sin( dot( gCell.add( o ), vec2( 127.1, 311.7 ) ) ).mul( 43758.5453 ) );
	const g1 = gHash( 0.0 ).toVar(), g2 = gHash( 5.3 ).toVar(), grain = gHash( 11.7 ).toVar();
	const gD = length( gFrac.sub( vec2( g1, g2 ).mul( 0.66 ).add( 0.17 ) ) ).toVar();

	const shell = smoothstep( 0.34, 0.12, gD ).mul( smoothstep( 0.90, 0.98, grain ) )
		.mul( smoothstep( 30.0, 4.0, dCam ) ).toVar();
	// ...and they go quiet below the waterline. Not because a seabed has fewer
	// shells — it has more — but because the wetness power below darkens the
	// sand around a fragment by a factor of two and leaves a near-white fragment
	// near-white. The same sprinkle that reads as shell grit underfoot on a dry
	// beach reads, from a swimmer's eye a metre off the bed, as a disc of hard
	// white specks that stops dead on the ring where the 30 m near-field fade
	// runs out. Wet chips on a sand bed are grey.
	const drowned = smoothstep( 0.05, - 0.5, h ).toVar();
	sandDry.assign( mix( sandDry, shellW, shell.mul( mix( float( 0.5 ), float( 0.12 ), drowned ) ) ) );

	// Wet sand is `albedo^(1 + wetness)`, not `albedo × grey`. The
	// difference is not brightness, it is *saturation*: a power darkens the weak
	// channels far more than the strong one, which is what water in the pores
	// actually does — more internal bounces, more absorption in the bands the
	// mineral already absorbs. A neutral multiply gives washed-out mud.
	const albedo = pow( sandDry, vec3( wetness.add( 1.0 ) ) ).mul( wetness.mul( 0.05 ).oneMinus() )
		// packing gaps between grains sit in their own shadow
		.mul( smoothstep( 0.5, 0.15, gD ).mul( 0.09 ).mul( smoothstep( 90.0, 10.0, dCam ) ).add( 0.965 ) )
		.mul( ridge.add( comb ).mul( 0.8 ).add( 1.0 ) ).toVar();

	// ---- specular ----------------------------------------------------------
	// One roughness, driving one lobe, instead of the three hand-rolled powers
	// this used to carry. Dry sand is as rough as a surface gets; a swash sheet
	// takes it to near-glass, and that is the loudest cue on the whole beach at
	// a low sun — the reason the strip the last wave covered reads as a sheet of
	// light rather than as darker sand.
	//
	// ...and the sheet's gloss belongs to the *film*, not to the sand. A swash
	// leaves a millimetre of water lying on the beach and it is that film's own
	// top surface — flat, unbroken, optically glass — that mirrors the sky.
	// Below the waterline there is no film: the interface is the grain surface
	// itself, and it is as rough as sand ever is, a little smoother than dry
	// only because the pores are full. Carrying 0.09 down there gives a GGX
	// lobe with a peak of ~5000, which is why the first dive put a searchlight
	// on the seabed a metre from the swimmer's mask however far the Fresnel
	// term was pushed down: at that roughness even 0.3% reflectance blows out.
	const roughness = mix(
		mix( float( 0.95 ), float( 0.09 ), pow( wetness, float( 0.65 ) ) ),
		float( 0.62 ), drowned ).toVar();

	// Every quartz grain is a little mirror, and the handful whose faces line up
	// sun-to-eye return a hard point of light — sparse and sharp, which is what
	// separates sand from felt. No smooth lobe gives it, so the facet normal is
	// tilted per grain and handed back for its own very tight highlight.
	const facetN = normalize( sandN.add(
		vec3( g1.sub( 0.5 ), 0.0, g2.sub( 0.5 ) ).mul( 0.9 ) ) ).toVar();
	const facetMask = smoothstep( 0.42, 0.16, gD ).mul( wetness.oneMinus() )
		.mul( smoothstep( 90.0, 12.0, dCam ) ).toVar();

	return { albedo, N: sandN, roughness, facetN, facetMask };

}
