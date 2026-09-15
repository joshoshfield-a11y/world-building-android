// The waterline — one model, two consumers.
//
// The sea and the beach are separate meshes with separate shaders, and each
// used to animate its own idea of where the water was: the ocean lifted its
// surface with one swash function keyed on shore distance and a scrolling noise
// tap, the sand darkened with a different one keyed on an analytic phase. Two
// independent animations of the same event. So the dark wet tongue was never
// where the sheet that supposedly left it had been, the foam residue sat on dry
// sand, and the water's edge came out as a knife cut: bright silver on one side,
// dry sand on the other, with nothing in between.
//
// This is the shared model. Its central idea is that **everything at the shore
// keys on the still-water
// depth** rather than on distance from the waterline. That one choice buys a
// lot:
//
//   * the bands follow the bathymetry for free — they bend around every cove,
//     headland and longshore bar, because those *are* depth contours, where a
//     distance-keyed band can only ever be a ribbon of constant width;
//   * both sides can compute it. The sea knows the seabed under it and the sand
//     knows its own elevation, and they are the same number, so the two shaders
//     agree without either having to read the other's geometry;
//   * it dies out offshore on its own (`exp(−d/decay)`), so nothing has to
//     decide where "the shore" stops.
//
// Two details matter as much as the keying:
//
//   * **The phase skew.** `sin(p + cos(p)·(1 − mag))` — as the water thins, the
//     wave's own phase is bent by its amplitude, so the front steepens into a
//     face and the back drains out as a long tail. A plain sine gives a sheet
//     that slides up and down like a lift.
//   * **The foam trails the crest by 0.85π.** Foam is not *on* the wave, it is
//     what the bore left behind after passing — offset it and the aerated sheet
//     sits behind the front where it belongs, instead of glowing along the crest
//     like a drawn line.

import {
	texture, uniform, float, vec2,
	mix, max, smoothstep, sin, cos, sqrt, exp, pow, clamp,
} from 'three/tsl';

// radians of wave phase per metre of still depth. 2π/KD ≈ 2 m of depth between
// bands, which on this island's 1:35 beach face and gentler shelf puts them
// roughly 20–70 m apart — the spacing of real swash lines, and wide enough that
// the phase jitter below bends them rather than shredding them.
const KD = 3.1;
const KT = 1.30;      // rad/s — one wave every ~4.8 s
const DECAY = 1.45;   // e-folding still depth of the shoreline train (m)
// Full swing of the sheet, trough to peak. Read it as a *horizontal* number: the
// beach face here runs about 1:42, so a tenth of a metre of water level is four
// metres of travelling waterline. 0.42 as a peak looked reasonable as a height
// and flooded seventeen metres of beach — enough that the wet sand it left
// filled the whole frame and stopped reading as a band at all.
const RUNUP = 0.36;
// **The backwash does not stop at the still line, it pulls past it.** `sw` runs
// 0..1, so without this bias the sheet could only ever *rise* above mean water:
// the beach never bares between waves, it only gets less wet, and what that
// renders as is a permanent film of water lying on the sand. A real beach face
// is exposed below mean water between waves, and that moment — sand, not thinner
// water — is what makes a swash read as water leaving rather than dimming.
//
// It belongs to the **beach face and nowhere else**, which is what `DRAW_DEPTH`
// is for. Applied wherever the shoreline train reaches — which is the whole
// shallow shelf — it lowers the surface under a seabed that out there is nearly
// flat, and a nearly flat bed converts ten centimetres of level into tens of
// metres of bared bar and trough. That is not a backwash, it is a hole in the
// sea with water on both sides of it. Keyed on still depth instead: full at the
// waterline, gone under a hand's depth of water.
const DRAW = 0.30;
const DRAW_DEPTH = 0.22;   // still depth (m) over which the drawdown dies out

export function makeShore( detailTex ) {

	// Its own clock, advanced by main.js. Both consumers must be on the *same*
	// one: the ocean sim's timer only ticks while the ocean layer is on, and a
	// wet band running on a clock that stops is worse than no wet band at all.
	const timeU = uniform( 0 );

	// A slow, smooth field, sampled for *phase* and never for position. The
	// distinction is the one this codebase keeps relearning: a tap fine enough to
	// see its own texels facets the pattern it warps instead of bending it. The
	// detail tile's A channel is a four-octave Perlin at 2..16 lattice, read at a
	// 96 m period, so its features run 12–48 m — comfortably wider than the bands
	// it is bending.
	const field = ( xz ) => texture( detailTex, xz.div( 96.0 ) );

	/**
	 * The water at a point. Takes the terrain bake's two channels directly, so
	 * both consumers hand over the same numbers and cannot drift apart.
	 *
	 * @param xz      world position (vec2 node)
	 * @param bedH    signed seabed / ground height in metres
	 * @param dS      signed shore distance, + inland
	 * @param tOff    seconds; negative looks into the past
	 * @returns { level, trail, envelope, fray } — surface elevation above still
	 *          water (m); the aerated sheet the bore left behind (0..1); the
	 *          highest the sheet ever reaches here, which is what decides how far
	 *          up the sand stays damp between waves; and a small signed *depth*
	 *          offset (m) that both consumers subtract wherever they decide
	 *          water-or-not, so the last centimetre of the edge frays the same way
	 *          on the sea and on the sand
	 */
	function sample( xz, bedH, dS, tOff = 0 ) {

		// Still-water depth is zero everywhere above the waterline, which is what
		// lets the sheet keep running up dry sand instead of stopping at h = 0.
		// That also means elevation alone cannot bound it — a hollow 200 m inland
		// sitting near sea level would fill up — so the reach is bounded by
		// *distance from the water*, which is the one thing a swash actually is.
		const dd = max( bedH.negate(), 0.0 ).toVar();
		const near = smoothstep( 45.0, 3.0, dS ).toVar();
		const n = field( xz ).toVar();

		// **The tongues.** A bore does not arrive parallel to the beach and a
		// swash sheet does not have a straight front: it breaks into tongues five
		// to twenty-five metres across, each running up to its own line, and each
		// arriving a moment before or after its neighbours. This is the term that
		// decides whether the waterline reads as running water or as a drawn
		// curve. A *static* patch field scallops every wave along the same
		// lines, so the edge comes out smooth with a permanent, unchanging
		// wobble in it.
		//
		// It has to drift. Half a metre a second alongshore is enough that a
		// tongue reaching furthest on this wave does not on the next, which is
		// what stops the eye finding the pattern.
		const dr = timeU.add( tOff ).mul( 0.55 ).toVar();
		const tn = texture( detailTex,
			vec2( xz.x.add( dr ), xz.y.sub( dr.mul( 0.62 ) ) ).div( 43.0 ) ).toVar();

		const mag = exp( dd.div( - DECAY ) ).toVar();
		// **Jitter the arrival time, but only a little.** Without any, every point
		// on the beach is on the same beat and the front stays a drawn line however
		// ragged its run-up is. With too much there is no front at all: at ±3 rad —
		// which is what 4.4 and 1.9 came to — every phase of the cycle is present
		// somewhere on the beach at every instant, so patches drain while their
		// neighbours fill and the swash zone never clears. It stops reading as a
		// wave and starts reading as a permanent film of water on the sand, which
		// is exactly what it looked like. ±0.8 rad is an eighth of a cycle: enough
		// that the front arrives crooked, little enough that it is still a front.
		const p = dd.mul( KD ).add( timeU.add( tOff ).mul( KT ) )
			.add( n.w.sub( 0.5 ).mul( 0.9 ) )
			.add( tn.w.sub( 0.5 ).mul( 0.75 ) ).toVar();

		// the shoaling skew — steep face, long drain
		const sw = sin( p.add( cos( p ).mul( mag.oneMinus() ) ) ).mul( - 0.5 ).add( 0.5 );

		// How far each tongue runs. The `pow` is what makes them *fingers*: a
		// linear map gives evenly scalloped bays, and a swash edge is mostly slack
		// with the occasional thin run pushed well past it. 0.30–1.20 is a
		// four-fold spread in run-up, which on this beach face is eight metres of
		// waterline between one scallop and the next.
		const shape = pow( mix( tn.z, n.z, 0.32 ), 1.35 );
		const patch = mix( float( 0.24 ), float( 1.28 ), shape ).toVar();

		// The envelope — the peak of `level` over a cycle — is what the sand needs.
		// A beach has three tones, not two: bright dry back-beach, a damp mid-tone
		// that never dries between waves, and the moving wet strip under the sheet
		// itself. Taking the damp zone from a delayed sample instead only works if
		// the delay is a good fraction of the swash period; take it from the
		// envelope and it is exact, costs nothing, and cannot drift.
		// `swing` is the full trough-to-peak travel; `envelope` stays what it has
		// always been — the highest the sheet ever reaches — so the sand's damp band
		// needs no adjusting for the drawdown.
		const swing = sqrt( mag ).mul( patch ).mul( near ).mul( RUNUP ).toVar();
		const envelope = swing.mul( 1.0 - DRAW ).toVar();

		const level = sw.sub( smoothstep( DRAW_DEPTH, 0.0, dd ).mul( DRAW ) ).mul( swing );
		const trail = sin( p.sub( Math.PI * 0.85 ) ).mul( 0.5 ).add( 0.5 )
			.mul( mag ).mul( patch ).mul( near );

		// **The last centimetre.** Even one tongue does not end on a curve: the
		// film thins until surface tension breaks it into rivulets and lobes a
		// metre or two across, and at ten paces that fraying *is* what a waterline
		// looks like. Given as a depth offset, because both consumers already test
		// a water column — five centimetres of column is nearly a metre of
		// waterline on this face.
		//
		// Deliberately kept out of `level`: the ocean reads `level` in the vertex
		// stage, and a metre-wavelength wiggle put into geometry is a wiggle the
		// mesh stops resolving a few tens of metres out, where it turns into a
		// shimmer running along the whole coast. No `toVar()` either, so the
		// vertex path never builds the tap it does not use.
		const fray = texture( detailTex,
			vec2( xz.x.sub( dr.mul( 1.4 ) ), xz.y.add( dr.mul( 0.4 ) ) ).div( 7.0 ) )
			.z.sub( 0.5 ).mul( 0.075 ).mul( near );

		return { level, trail, envelope, fray };

	}

	/**
	 * The lip at the water's edge. A tongue of water a centimetre deep is not a
	 * wedge tapering to nothing — surface tension holds a rounded bead at the
	 * front, and that bead is most of what the eye reads as *water* rather than
	 * as a coloured region. A circular arc over the last ~20 cm of depth builds
	 * it; the arc costs one sqrt and it is the difference between a rolling
	 * tongue and a cut edge.
	 *
	 * The arc has to be gated in deep water — an unbounded +8 cm would be a
	 * global sea-level shift — so it fades out past half a metre
	 * of depth, leaving a bead that peaks a hand's width behind the tip.
	 *
	 * @param dh  water column thickness at this point (m)
	 */
	function lip( dh ) {

		const e = clamp( float( 1.0 ).sub( dh.add( 0.02 ).mul( 5.0 ) ), 0.0, 1.0 ).toVar();
		// Gated below zero as well as above. The upper gate was there from the
		// start; without the lower one the bead adds a flat 8.5 cm to every part of
		// the sheet that is *under* the sand, which is the whole dry beach — and
		// 8.5 cm of lift is exactly what shoves the water mesh up through the
		// terrain's 2.6 m triangles and leaves a rim of sea showing along the coast.
		return sqrt( max( float( 1.0 ).sub( e.mul( e ) ), 0.0 ) )
			.mul( smoothstep( 0.55, 0.12, dh ) ).mul( smoothstep( - 0.07, 0.015, dh ) )
			.mul( 0.085 );

	}

	/**
	 * Foam coverage at the shore: the sheet the bore left behind, plus the
	 * leading edge itself, where the film is thinnest and most aerated.
	 */
	function foam( trail, dh ) {

		// Both terms have to stay *narrow*, and narrow on **both** sides. Foam
		// over every centimetre of water shallower than a
		// third of a metre is most of the shallows on a 1:35 beach, and what that
		// renders as is not surf, it is frosted glass laid over the whole shore.
		//
		// A leading edge of `clamp(1 − dh/0.1)` is a half-space:
		// it saturates at 1 for *every* negative column and never comes back down,
		// so every fragment where the surface sits below the sand — the whole dry
		// beach — asks for full foam: a permanent white ribbon along the coast
		// that no backwash can drain. It is a band: a hand's width of aerated film
		// at the
		// tip and nothing on the sand behind it. The trailing sheet is gated the
		// same way, for the same reason.
		const dry = smoothstep( - 0.045, 0.012, dh ).toVar();
		const edge = dry.mul( smoothstep( 0.13, 0.03, dh ) );
		return max( trail.mul( smoothstep( 0.45, 0.03, dh ) ).mul( dry ).mul( 0.55 ), edge )
			.clamp( 0.0, 1.0 );

	}

	return { timeU, sample, lip, foam };

}
