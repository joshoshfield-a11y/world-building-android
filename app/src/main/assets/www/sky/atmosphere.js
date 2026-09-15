// The atmosphere — a real single-scattering integral, not an analytic fit.
//
// Every frame a compute pass ray-marches Rayleigh + Mie single scattering
// through a spherical atmosphere and bakes the result into a small storage
// texture indexed by view direction. Secondary rays are earth-shadow tested, so
// twilight is the real thing: the lower atmosphere goes dark while the upper
// air is still lit, which is what makes the belt of Venus and the long red
// horizon happen on their own instead of being painted in.
//
// Baking is what makes it affordable. The background, every water reflection
// and the aerial perspective on the land all want the sky in some direction;
// as an integral that is 128 exp() per query, as a LUT it is one bilinear
// fetch. 512 × 160 texels, re-marched each frame the sun moves.
//
// On top of the LUT — all analytic, all sharper than a LUT texel: the sun disc
// (radiance = the CPU's sun-path transmittance, so it reddens through the same
// physics), a Beer/powder-lit cloud layer, a geometrically lit moon and a
// hashed star sphere.

import * as THREE from 'three/webgpu';
import { makeAurora } from './aurora.js';
import {
	Fn, If, Loop, uniform, texture, textureStore, instanceIndex, uvec2,
	cameraPosition,
	float, vec2, vec3, vec4,
	normalize, dot, cross, pow, exp, acos, asin, atan, cos, sin, sqrt, floor, fract, sign, step,
	mix, max, min, clamp, smoothstep, abs, length,
} from 'three/tsl';

const PI = Math.PI;

// ---- the physical constants (metres). Earth, near enough.
const R_PLANET = 6371e3;
const R_ATMOS = 6471e3;
const H_RAYLEIGH = 8e3;             // scale heights
const H_MIE = 1.2e3;
const BETA_R = [ 5.5e-6, 13.0e-6, 22.4e-6 ]; // sea-level scattering, per channel
const BETA_M = 21e-6;
const EYE_ALT = 600;                // where the LUT's rays start
const I_STEPS = 16;                 // primary samples along the view ray
const J_STEPS = 6;                  // secondary samples along the sun ray

const LUT_W = 512;                  // azimuth
const LUT_H = 160;                  // elevation, sqrt-warped toward the horizon

// ---- the water. One coefficient vector, exported, because the medium is one
// thing: `aerial()` extinguishes the view ray with it, the island extinguishes
// the light that reaches the seabed with it, and if the two ever disagree the
// bed stops belonging to the water above it.
//
// The *open* ocean measures (0.026, 0.0085, 0.005)/m — ~250 m of visibility —
// and a breaking shore measures (0.25, 0.04, 0.02)/m, where red is gone in
// four metres. Both are
// right about their own water and neither is right about this one. Everywhere
// a swimmer can actually get under the surface here is the shelf: a few metres
// over sand, a couple of hundred out. On the open-ocean figure that column is
// optically nothing — five metres down the sand still looks like a dry beach,
// which is exactly what the first dive rendered — and on the coastal figure the
// seabed is dark green mud before you have finished the dive. This is the
// shelf's own number, and it is not a compromise between them so much as the
// third case: ~35 m of blue-green visibility, red gone by twenty.
export const AQUATIC_EXTINCTION = /*@__PURE__*/ vec3( 0.115, 0.028, 0.016 );

// hour → direction on a simple solar arc: rise east at 6h, set west at 18h
export function celestialDir( hour, maxElevationDeg, out ) {

	const el = maxElevationDeg * PI / 180 * Math.sin( ( hour - 6 ) / 12 * PI );
	const az = ( 90 + ( hour - 6 ) * 15 ) * PI / 180;
	return out.set( Math.cos( el ) * Math.sin( az ), Math.sin( el ), Math.cos( el ) * Math.cos( az ) );

}

export function makeAtmosphere( config ) {

	const cloudsCfg = config.clouds || { coverage: 0.38, scale: 1.0, speed: 1.0, opacity: 0.9 };
	const skyCfg = config.sky || {};
	const sunIntensity = skyCfg.intensity !== undefined ? skyCfg.intensity : 20;
	const hazeCfg = skyCfg.haze !== undefined ? skyCfg.haze : 1.0;

	const u = {
		sunDir: uniform( new THREE.Vector3( 0, 0.3, 1 ).normalize() ),
		moonDir: uniform( new THREE.Vector3( 0, - 0.4, - 1 ).normalize() ),
		betaR: uniform( new THREE.Vector3( ...BETA_R ).multiplyScalar( config.atmosphere.rayleigh ) ),
		betaM: uniform( BETA_M ),
		mieG: uniform( config.atmosphere.mieDirectionalG ),
		sunI: uniform( sunIntensity ),
		multiScatter: uniform( skyCfg.multiScatter !== undefined ? skyCfg.multiScatter : 0.6 ),
		// sun-path transmittance at the ground, integrated on the CPU each frame:
		// the colour of direct sunlight, and of the disc itself
		sunColor: uniform( new THREE.Color( 1, 1, 1 ) ),
		sunCosR: uniform( Math.cos( ( config.sun.discRadius || 0.9 ) * PI / 180 ) ),
		moonCosR: uniform( Math.cos( config.moon.angularRadius * PI / 180 ) ),
		moonBrightness: uniform( config.moon.brightness ),
		moonColor: uniform( new THREE.Color().setRGB( ...config.moon.tint, THREE.SRGBColorSpace ) ),
		moonLevel: uniform( 0 ),   // lit fraction × elevation fade
		starThreshold: uniform( config.stars.density ),
		starBrightness: uniform( config.stars.brightness ),
		starRot: uniform( 0 ),
		time: uniform( 0 ),
		cloudCoverage: uniform( cloudsCfg.coverage ),
		cloudScale: uniform( cloudsCfg.scale ),
		cloudSpeed: uniform( cloudsCfg.speed ),
		cloudOpacity: uniform( cloudsCfg.opacity ),
		haze: uniform( hazeCfg ),  // aerial-perspective aerosol multiplier
		// The medium the camera is standing in. 0 = air, 1 = water. It is one
		// number and it changes what `aerial` and `background` mean, which is
		// exactly the right seam: everything in the world is already lit through
		// those two, so going under the surface does not need a second copy of
		// any shader — see the aquatic block in `aerial` below.
		submerged: uniform( 0 ),
		seaLevel: uniform( 0 ),
	};

	// ---- the aurora ---------------------------------------------------------
	//
	// Its own module and its own LUT, on the same direction parameterisation as
	// the scattering LUT below so `dirToUV` serves both. It is added into
	// `sample`, which means it is in the sky, in the sea's reflection and in the
	// aerial perspective — an aurora that is only in the background plate is a
	// wallpaper, and on a dark ocean the reflection is most of what you see.
	const aurora = makeAurora( config.aurora );

	// ---- the LUT ------------------------------------------------------------

	const lut = new THREE.StorageTexture( LUT_W, LUT_H );
	lut.format = THREE.RGBAFormat;
	lut.type = THREE.HalfFloatType;
	lut.wrapS = THREE.RepeatWrapping;          // azimuth is periodic — filter across the seam
	lut.wrapT = THREE.ClampToEdgeWrapping;
	lut.magFilter = lut.minFilter = THREE.LinearFilter;
	lut.generateMipmaps = false;

	// direction → LUT uv. Elevation is stored sqrt-warped so half the rows sit
	// in the 20° around the horizon, where all the gradient is.
	const dirToUV = /*@__PURE__*/ Fn( ( [ dir ] ) => {

		const az = atan( dir.z, dir.x );
		const el = asin( clamp( dir.y, - 1.0, 1.0 ) );
		const s = sqrt( abs( el ).div( PI / 2 ) ).mul( sign( el ) );
		return vec2( az.div( 2 * PI ).add( 0.5 ), s.mul( 0.5 ).add( 0.5 ) );

	} );

	// ray ↔ sphere at the origin: returns (discriminant, tNear, tFar)
	const rsi = ( r0, rd, radius ) => {

		const b = dot( rd, r0 ).mul( 2.0 );
		const c = dot( r0, r0 ).sub( radius * radius );
		const disc = b.mul( b ).sub( c.mul( 4.0 ) ).toVar();
		const q = sqrt( max( disc, 0.0 ) );
		return { disc, t0: b.negate().sub( q ).mul( 0.5 ), t1: b.negate().add( q ).mul( 0.5 ) };

	};

	// the integral itself: in-scattered radiance arriving from `rayDir`
	const scatter = /*@__PURE__*/ Fn( ( [ rayDir ] ) => {

		const r = normalize( rayDir ).toVar();
		const r0 = vec3( 0.0, R_PLANET + EYE_ALT, 0.0 );
		const sun = u.sunDir;

		// the view ray runs to the top of the atmosphere, or to the ground if it
		// looks down far enough to hit it
		const air = rsi( r0, r, R_ATMOS );
		const tEnd = air.t1.toVar();

		const ground = rsi( r0, r, R_PLANET );
		const gHit = step( 0.0, ground.disc ).mul( step( 0.0, ground.t0 ) );
		tEnd.assign( mix( tEnd, min( tEnd, max( ground.t0, 0.0 ) ), gHit ) );

		const iStep = tEnd.div( I_STEPS ).toVar();

		const totalR = vec3( 0.0 ).toVar();
		const totalM = vec3( 0.0 ).toVar();
		const odR = float( 0.0 ).toVar();
		const odM = float( 0.0 ).toVar();
		const t = iStep.mul( 0.5 ).toVar();

		Loop( I_STEPS, () => {

			const p = r0.add( r.mul( t ) ).toVar();
			const h = length( p ).sub( R_PLANET );

			const dR = exp( h.div( - H_RAYLEIGH ) ).mul( iStep ).toVar();
			const dM = exp( h.div( - H_MIE ) ).mul( iStep ).toVar();
			odR.addAssign( dR );
			odM.addAssign( dM );

			// optical depth from this sample toward the sun
			const jStep = rsi( p, sun, R_ATMOS ).t1.div( J_STEPS ).toVar();
			const jodR = float( 0.0 ).toVar();
			const jodM = float( 0.0 ).toVar();
			const tj = jStep.mul( 0.5 ).toVar();

			Loop( J_STEPS, () => {

				const hj = length( p.add( sun.mul( tj ) ) ).sub( R_PLANET );
				jodR.addAssign( exp( hj.div( - H_RAYLEIGH ) ).mul( jStep ) );
				jodM.addAssign( exp( hj.div( - H_MIE ) ).mul( jStep ) );
				tj.addAssign( jStep );

			} );

			// earth shadow — the whole reason twilight looks like twilight. The
			// sun ray's impact parameter against the planet, softened over a few
			// km so 16 samples don't band.
			const proj = dot( p, sun );
			const perp = length( p.sub( sun.mul( proj ) ) );
			const lit = mix( float( 1.0 ),
				smoothstep( R_PLANET * 0.9986, R_PLANET * 1.0022, perp ),
				step( proj, 0.0 ) );

			const attn = exp( u.betaR.mul( odR.add( jodR ) )
				.add( u.betaM.mul( odM.add( jodM ) ) ).negate() ).mul( lit );

			totalR.addAssign( dR.mul( attn ) );
			totalM.addAssign( dM.mul( attn ) );
			t.addAssign( iStep );

		} );

		// phase functions
		const mu = dot( r, sun ).toVar();
		const mumu = mu.mul( mu );
		const g = u.mieG;
		const gg = g.mul( g );
		const pR = float( 3.0 / ( 16.0 * PI ) ).mul( mumu.add( 1.0 ) );
		const pM = float( 3.0 / ( 8.0 * PI ) )
			.mul( float( 1.0 ).sub( gg ).mul( mumu.add( 1.0 ) ) )
			.div( pow( float( 1.0 ).add( gg ).sub( mu.mul( g ).mul( 2.0 ) ), 1.5 ).mul( gg.add( 2.0 ) ) );

		// A single-scatter integral is always too dark and too neutral where the
		// sun isn't: real air scatters light that has already bounced. Folding a
		// phase-free (isotropic) share of the same integral back in is the cheap
		// stand-in — it keeps the twilight zenith blue instead of letting it go
		// brown, because totalR is still three times larger in blue.
		const iso = u.betaR.mul( totalR ).add( u.betaM.mul( totalM ) ).mul( u.multiScatter.div( 4 * PI ) );

		return u.sunI.mul( u.betaR.mul( totalR ).mul( pR ).add( u.betaM.mul( totalM ).mul( pM ) ).add( iso ) );

	} );

	const bake = Fn( () => {

		const x = instanceIndex.mod( LUT_W );
		const y = instanceIndex.div( LUT_W );

		const az = float( x ).add( 0.5 ).div( LUT_W ).sub( 0.5 ).mul( 2 * PI );
		const s = float( y ).add( 0.5 ).div( LUT_H ).sub( 0.5 ).mul( 2.0 ).toVar();
		const el = s.mul( s ).mul( sign( s ) ).mul( PI / 2 );

		const ce = cos( el );
		const dir = vec3( ce.mul( cos( az ) ), sin( el ), ce.mul( sin( az ) ) );

		textureStore( lut, uvec2( x, y ), vec4( scatter( dir ), 1.0 ) ).toStack();

	} )().compute( LUT_W * LUT_H );

	// ---- analytic detail on top of the LUT ----------------------------------

	const hash3 = /*@__PURE__*/ Fn( ( [ p ] ) => fract( sin( dot( p, vec3( 12.9898, 78.233, 37.719 ) ) ).mul( 43758.5453123 ) ) );

	const hash2 = /*@__PURE__*/ Fn( ( [ p ] ) => fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ).mul( 43758.5453123 ) ) );

	const noise2 = /*@__PURE__*/ Fn( ( [ p ] ) => {

		const i = floor( p );
		const f = fract( p );
		const ff = f.mul( f ).mul( float( 3.0 ).sub( f.mul( 2.0 ) ) );

		const a = hash2( i );
		const b = hash2( i.add( vec2( 1.0, 0.0 ) ) );
		const c = hash2( i.add( vec2( 0.0, 1.0 ) ) );
		const d = hash2( i.add( vec2( 1.0, 1.0 ) ) );

		return mix( mix( a, b, ff.x ), mix( c, d, ff.x ), ff.y );

	} );

	// 5-octave value-noise fbm, rotated per octave
	const fbm = /*@__PURE__*/ Fn( ( [ p0 ] ) => {

		const p = p0.toVar();
		const f = float( 0.0 ).toVar();
		const rot = ( q, s ) => vec2( q.x.mul( 0.8 ).sub( q.y.mul( 0.6 ) ), q.x.mul( 0.6 ).add( q.y.mul( 0.8 ) ) ).mul( s );

		f.addAssign( noise2( p ).mul( 0.5 ) ); p.assign( rot( p, 2.02 ) );
		f.addAssign( noise2( p ).mul( 0.25 ) ); p.assign( rot( p, 2.03 ) );
		f.addAssign( noise2( p ).mul( 0.125 ) ); p.assign( rot( p, 2.01 ) );
		f.addAssign( noise2( p ).mul( 0.0625 ) ); p.assign( rot( p, 2.04 ) );
		f.addAssign( noise2( p ).mul( 0.03125 ) );

		return f.div( 0.96875 );

	} );

	// ---- the night sky ------------------------------------------------------
	//
	// This was one hashed lattice on the celestial sphere — 1.6% of cells
	// carrying a white dot — and it read as *static*, because a real night sky
	// is not a uniform scatter of identical points. It is a magnitude
	// distribution (a handful you could name, a few hundred you can see, a haze
	// of thousands you cannot resolve), the points are *coloured*, and above all
	// there is a galaxy lying across it.
	//
	// Four lattices at different cell sizes give the magnitudes: the coarse ones
	// carry a few bright stars with a visible halo, the fine ones a dust of
	// pinpricks. Cell size is in radians of sky, and the two corrections that
	// make a lattice on (θ, φ) behave like a sphere are worth naming, because
	// without them the poles are a knot: the local coordinate is scaled by sinθ
	// so a cell is square rather than a sliver, and each star survives with
	// probability sinθ, because the lattice packs 1/sinθ too many cells per
	// steradian up there.
	//
	// The shape of this — layered lattices in spherical coordinates, a galaxy
	// built out of a band times an fbm. Two choices set it apart. The galaxy is
	// in the celestial frame rather than in screen space, so it turns with the
	// stars it belongs to instead of being painted on the lens. And the star
	// colour is a three-anchor ramp rather than a blackbody fit — at two pixels
	// the accuracy of any one star is worth nothing and the *spread* is worth
	// everything.
	const LAYERS = 4;

	// The night sky is thirty-odd hashes per pixel, and `hash2` above spends a
	// `sin` on each — a transcendental, quarter rate, and by far the largest
	// single cost in the frame after dark. A sin-free hash: same statistics, no
	// transcendental. It stays local to the night sky rather
	// than replacing `hash2`, because the moon's maria and the cloud field are
	// drawn with that one and would change pattern under it.
	const starHash = /*@__PURE__*/ Fn( ( [ p ] ) => {

		const q = fract( vec3( p.x, p.y, p.x ).mul( 0.1031 ) ).toVar();
		q.addAssign( dot( q, vec3( q.y, q.z, q.x ).add( 33.33 ) ) );
		return fract( q.x.add( q.y ).mul( q.z ) );

	} );

	const starNoise = /*@__PURE__*/ Fn( ( [ p ] ) => {

		const i = floor( p );
		const f = fract( p );
		const ff = f.mul( f ).mul( float( 3.0 ).sub( f.mul( 2.0 ) ) );

		return mix(
			mix( starHash( i ), starHash( i.add( vec2( 1.0, 0.0 ) ) ), ff.x ),
			mix( starHash( i.add( vec2( 0.0, 1.0 ) ) ), starHash( i.add( vec2( 1.0, 1.0 ) ) ), ff.x ),
			ff.y );

	} );

	const starTint = ( t ) => mix(
		mix( vec3( 1.00, 0.55, 0.28 ), vec3( 1.00, 0.96, 0.92 ), clamp( t.mul( 2.2 ), 0.0, 1.0 ) ),
		vec3( 0.55, 0.70, 1.00 ), clamp( t.mul( 2.4 ).sub( 1.4 ), 0.0, 1.0 ) );

	// The galactic frame, fixed in the celestial one: pole, centre, and the
	// third axis. The band therefore arcs to 63° at its highest and the bulge
	// sits 44° up, which is the sky you get on a good night at this latitude.
	const GAL_N = /*@__PURE__*/ vec3( 0.641, 0.451, - 0.621 );
	const GAL_C = /*@__PURE__*/ vec3( 0.179, 0.699, 0.692 );
	const GAL_A = /*@__PURE__*/ vec3( 0.746, - 0.555, 0.367 );

	const nightSky = /*@__PURE__*/ Fn( ( [ dir ] ) => {

		// the celestial frame: everything below turns with the sky, not with you
		const ca = cos( u.starRot ), sa = sin( u.starRot );
		const d = vec3( dir.x.mul( ca ).add( dir.z.mul( sa ) ), dir.y,
			dir.z.mul( ca ).sub( dir.x.mul( sa ) ) ).toVar();

		const theta = acos( clamp( d.y, - 1.0, 1.0 ) ).toVar();
		const phi = atan( d.z, d.x ).toVar();
		const sinT = max( sin( theta ), 0.04 ).toVar();

		// Galactic latitude, needed here rather than down with the Galaxy itself
		// because the stars want it: they crowd along the band, and that matters
		// more than the glow does. The Milky Way *is* stars — a band drawn as a
		// smooth wash with the same star density either side of it reads as fog
		// lying over the sky rather than as part of it.
		const lat = asin( clamp( dot( d, GAL_N ), - 1.0, 1.0 ) ).toVar();
		const band = exp( lat.mul( lat ).mul( - 20.0 ) ).toVar();

		const col = vec3( 0.0 ).toVar();

		// `starThreshold` was the cut-off a cell's hash had to clear back when
		// there was one lattice; each lattice carries its own rarity now, so the
		// control scales all four together. 0.984 is the density this was drawn
		// at, and is 1 here.
		const dens = u.starThreshold.oneMinus().mul( 1 / 0.016 ).clamp( 0.0, 2.0 ).toVar();

		// A real star field **clumps**. However well a lattice is jittered, one
		// star per cell means no cell can ever hold two and none can be empty
		// across a run — the spacing has a floor and a ceiling, and the eye reads
		// that regularity as a grid even when it cannot point at one. So a single
		// slow noise, shared by all four lattices, crowds some regions and thins
		// others. Sampled off the direction vector rather than off (phi, theta):
		// phi wraps at ±π and any noise taken on it draws a seam down the sky.
		const clump = starNoise( vec2( d.x.add( d.y.mul( 0.6 ) ),
			d.z.sub( d.y.mul( 0.4 ) ) ).mul( 2.4 ) ).mul( 0.90 ).add( 0.55 ).toVar();

		// ---- stars, four lattices from bright-and-sparse to faint-and-dense
		for ( let i = 0; i < LAYERS; i ++ ) {

			const s = i / ( LAYERS - 1 );
			const dim = ( 0.055 - 0.0475 * s ) * PI;   // radians a cell spans
			// Core and halo, per radian. A star is a *point*, and what sells one
			// is that its core is a couple of pixels across with a faint glow
			// around it. A single exponential cannot be both: at a tightness that
			// gives the glow, a magnitude-5 star's visible disc runs to eighteen
			// pixels and the sky fills with soft round blobs — bokeh, not stars.
			// Two terms cost one extra `exp` and separate the two jobs.
			const KC = 1500 + 1900 * s;
			const KH = 300 + 240 * s;
			// The odds a cell holds a star. Written as a *keep* probability
			// rather than a rejection threshold because the band has to be able
			// to add stars: as a threshold the faint lattices sit at 98% kept —
			// saturated, with no headroom for the one place in the sky that
			// should be crowded. So the plain sky is thinned instead and the
			// band brings it back, hardest on the faint lattices, because what
			// the Milky Way is made of is stars too faint to pick out singly.
			const keepP = dens.mul( clump.mul( 0.42 + 0.30 * s )
				.add( band.mul( 0.12 + 0.34 * s ) ) ).clamp( 0.0, 1.0 ).toVar();

			const q = vec2( theta.div( dim ).add( i * 0.37 ), phi.div( dim ).add( i * 0.91 ) ).toVar();
			const cell = floor( q );
			const local = fract( q ).sub( 0.5 ).toVar();

			const hx = starHash( cell.add( 11.0 + i * 17.3 ) );
			const hy = starHash( cell.add( vec2( 91.7, 43.1 ) ).add( i * 5.0 ) );
			const hp = starHash( cell.add( vec2( 311.0, 157.0 ) ).add( i * 3.0 ) );
			const ht = starHash( cell.add( vec2( 57.3, 233.9 ) ).add( i * 7.0 ) );
			// Brightness gets its own draw. Sharing `hy` with the jitter tied a
			// star's magnitude to where in its cell it sat, which is a faint
			// diagonal order through the whole field once you have seen it.
			const hm = starHash( cell.add( vec2( 613.0, 71.9 ) ).add( i * 11.0 ) );

			// the two spherical corrections, and the presence roll. The jitter is
			// nearly a whole cell wide — anything less and the lattice shows.
			const dd = local.sub( vec2( hx, hy ).sub( 0.5 ).mul( 0.94 ) ).toVar();
			const l = length( vec2( dd.x, dd.y.mul( sinT ) ) ).mul( dim );
			const keep = step( hp, sinT ).mul( step( ht, keepP ) );

			// Magnitudes are steep on purpose. `pow(h, 5)` puts one star in
			// twenty above half brightness and leaves the rest as pinpricks,
			// which is the actual distribution: a sky is a few dozen stars you
			// could name and several thousand you could not.
			const mag = mix( pow( hm, 5.0 ).mul( 8.5 ).add( 0.22 ),
				pow( hm, 4.0 ).mul( 0.75 ).add( 0.03 ), s );
			const tw = sin( u.time.mul( hx.mul( 3.0 ).add( 1.4 ) ).add( hp.mul( 39.0 ) ) )
				.mul( 0.16 ).add( 0.86 );

			const shape = exp( l.mul( - KC ) ).add( exp( l.mul( - KH ) ).mul( 0.055 ) );

			col.addAssign( starTint( hx.mul( hx ) )
				.mul( shape.mul( mag ).mul( tw ).mul( keep ) ) );

		}

		// a bright moon washes the faint sky out, and that is most of what makes
		// a moonlit night look different from a dark one
		col.mulAssign( u.moonLevel.mul( - 0.45 ).add( 1.0 ) );

		// ---- the Galaxy.
		//
		// Both coordinates are *radians*, and that is the whole difference
		// between this and a smear: measured across the band in sin(latitude)
		// and along it in longitude, the noise domain is five times finer
		// across than along and the clouds come out as long thin streaks
		// parallel to the band — which reads as contrails, or as an aurora, but
		// never as the Galaxy. Isotropic domain, and the structure is blobs the
		// way it is in every photograph.
		const gu = atan( dot( d, GAL_A ), dot( d, GAL_C ) ).toVar();  // 0 at the centre

		const gp = vec2( gu, lat ).toVar();

		// Every octave is *rotated*, and that is not a detail either. Value noise
		// lives on an integer lattice, so its extrema sit on a grid; stack three
		// unrotated octaves at high contrast and the eye finds that grid
		// immediately — the band came out visibly quilted, little squares of
		// light about a degree across. Turning each octave by an irrational-ish
		// angle leaves the same statistics with no axis to lock onto.
		const turn = ( q, c, s, k ) => vec2( q.x.mul( c ).sub( q.y.mul( s ) ),
			q.x.mul( s ).add( q.y.mul( c ) ) ).mul( k );
		// One warp pass first: clouds are not lumps of noise, they are lumps of
		// noise whose *coordinates* are themselves lumpy.
		const gw = gp.add( vec2( starNoise( turn( gp, 0.80, 0.60, 2.3 ) ),
			starNoise( turn( gp, 0.28, - 0.96, 2.6 ).add( 19.0 ) ) ).sub( 0.5 ).mul( 0.30 ) ).toVar();
		const clouds = starNoise( gw.mul( 3.1 ) ).mul( 0.50 )
			.add( starNoise( turn( gw, 0.62, 0.78, 7.7 ).add( 11.0 ) ).mul( 0.31 ) )
			.add( starNoise( turn( gw, - 0.31, 0.95, 17.3 ).add( 29.0 ) ).mul( 0.19 ) ).toVar();

		// The band is a soft Gaussian ~30° across, not an exponential spike: it
		// has to have a *width* you can see structure inside.
		const prof = exp( pow( lat.mul( 5.0 ), 2.0 ).negate() ).toVar();
		// ...and it is brightest toward the centre and thins away from it
		const lon = exp( gu.mul( gu ).mul( - 0.55 ) ).mul( 0.62 ).add( 0.38 ).toVar();
		// The Great Rift: a dark lane that wanders along the band, and the single
		// feature that makes a Milky Way recognisable rather than a light smudge.
		const riftY = lat.sub( sin( gu.mul( 1.7 ) ).mul( 0.030 ) ).mul( 22.0 );
		const rift = exp( pow( riftY, 2.0 ).negate() ).mul( - 0.78 ).add( 1.0 ).toVar();
		// the bulge — the one part that is warm, because it is old stars seen
		// through the whole thickness of the disc
		const bulge = exp( gu.mul( gu ).mul( - 2.6 ) ).mul( exp( pow( lat.mul( 8.0 ), 2.0 ).negate() ) ).toVar();
		// granular, because it is unresolved stars — but *gently*. This was a
		// ±0.5 modulation and it was the loudest thing in the sky; the grid it
		// drew read as compression blocking, not as starlight.
		const grain = starNoise( turn( gp, 0.71, - 0.71, 46.0 ).add( 7.0 ) ).mul( 0.30 ).add( 0.85 );

		// The cloud field goes through a contrast curve before it is used. Raw
		// fBm has a Gaussian-ish histogram — most of it sits near the middle, so
		// the band comes out an even wash with a gentle mottle on it. What a
		// photograph shows is the opposite: bright star clouds and near-black
		// dust between them, with not much in between.
		const cs = smoothstep( 0.22, 0.84, clouds ).toVar();

		const glow = prof.mul( lon ).mul( rift ).mul( cs.mul( 1.55 ).add( 0.14 ) ).mul( 0.072 )
			.add( bulge.mul( 0.17 ) ).mul( grain );
		// Dust is warm and star clouds are cool. Taking the tint off the cloud
		// field rather than off the bulge alone is what stops the band reading as
		// grey smoke: a dark lane is dust reddening the light coming through it,
		// not an absence of light, and a Milky Way photographed in colour is
		// brown and blue long before it is bright.
		const dust = mix( vec3( 0.90, 0.68, 0.50 ), vec3( 0.60, 0.72, 1.00 ), cs );
		col.addAssign( mix( dust, vec3( 1.00, 0.86, 0.64 ), bulge )
			.mul( glow ).mul( u.moonLevel.mul( - 0.62 ).add( 1.0 ) ) );

		return col;

	} );

	// the raw in-scatter, straight off the LUT — what aerial perspective blends
	// toward, with no sun disc or clouds in it
	// Below the horizon the honest answer is "a short ray into the ground", which
	// is dark — and correct only if you actually model the ground. In a world
	// whose ocean patch stops a few kilometres out, that dark band draws a hard
	// ring around the water. Clamping the lookup to the horizon makes the sky
	// under the horizon read as more distant sea, which is what is really there.
	const lutAt = /*@__PURE__*/ Fn( ( [ dir ] ) => {

		const d = normalize( dir ).toVar();
		return texture( lut, dirToUV( vec3( d.x, max( d.y, - 0.012 ), d.z ) ) ).level( 0 ).xyz;

	} );

	// ---- the shoulder -------------------------------------------------------
	//
	// A sunset is the one time of day when the brightest thing in frame is also
	// the most saturated, and ACES cannot have both: it desaturates toward white
	// as a channel runs past 1, which is exactly what makes it filmic everywhere
	// else. Measured at the horizon three degrees below solar noon, the sky ran
	// (8.0, 5.0, 2.4) — red four times over the knee while blue was still on the
	// curve — and rendered (255, 247, 229). The physics was producing a deep
	// amber and the tone curve was painting it cream.
	//
	// So the sky gets a shoulder of its own *first*, and the whole triple is
	// scaled by one factor taken from its brightest channel, which compresses
	// the range without touching the ratios. Hue survives by construction: the
	// same (8.0, 5.0, 2.4) leaves here as (4.3, 2.7, 1.3) and renders as amber.
	// It is not a second tone curve so much as the local adaptation an eye does
	// when it looks at a sunset — the reason you can see the colour at all.
	//
	// It belongs here rather than in the renderer because it must apply to the
	// sky and to nothing else: the land at sunset is *supposed* to be dark, and
	// pulling the whole frame down is how a sunset becomes a grey evening.
	const SKY_KNEE = 0.75;  // radiance under this is passed through untouched
	const SKY_MAX = 2.4;    // ...and nothing above it is ever handed more

	const shoulder = /*@__PURE__*/ Fn( ( [ c ] ) => {

		const m = max( max( c.x, c.y ), c.z ).toVar();
		const over = max( m.sub( SKY_KNEE ), 0.0 );
		const soft = min( m, SKY_KNEE ).add( float( SKY_MAX - SKY_KNEE )
			.mul( float( 1.0 ).sub( exp( over.div( - ( SKY_MAX - SKY_KNEE ) ) ) ) ) );
		return c.mul( soft.div( max( m, 1e-5 ) ) );

	} );

	// the sky as anything outside this module should see it: aerial perspective,
	// ambient fill, water reflections. Everything that composes its own view of
	// the sky (`sample`, `distantSea`) builds on `lutAt` and applies the shoulder
	// once at the end instead, so nothing is compressed twice.
	const inscatter = /*@__PURE__*/ Fn( ( [ dir ] ) => shoulder( lutAt( dir ) ) );

	// What sea looks like from far enough away that it is only a mirror: the sky
	// it reflects, hazed over the range the ray travelled to reach it. That range
	// is eyeHeight / |dir.y|, which runs to infinity as the ray flattens, so this
	// meets the sky exactly at the horizon — no seam, wherever the eye is.
	//
	// Something has to answer for below-horizon rays, because a water patch is
	// finite: from 600 m up, the wedge between a 3.8 km patch and the true
	// horizon is 9° of screen. Answering it with the clamped horizon colour
	// paints that whole wedge one flat tone with a hard edge along the top, and
	// what you see is a band lying across the sky.
	const distantSea = /*@__PURE__*/ Fn( ( [ dir ] ) => {

		const d = normalize( dir ).toVar();
		const down = max( d.y.negate(), 1e-4 ).toVar();
		const range = max( cameraPosition.y, 0.5 ).div( down );
		const seen = exp( range.div( - 26000.0 ) );
		const mirror = texture( lut, dirToUV( vec3( d.x, down, d.z ) ) ).level( 0 ).xyz;

		return shoulder( mix( lutAt( vec3( d.x, 0.0, d.z ) ), mirror.mul( 0.92 ), seen ) );

	} );

	// ---- the one function everything samples --------------------------------

	const sample = Fn( ( [ rayDir ] ) => {

		const dir = normalize( rayDir ).toVar();
		const sunDir = u.sunDir;
		const moonDir = u.moonDir;

		const col = lutAt( dir ).toVar();

		const cosS = dot( dir, sunDir ).toVar();
		const cosM = dot( dir, moonDir ).toVar();

		// how dark the sky is — drives stars, airglow and moon visibility
		const night = smoothstep( 0.04, - 0.14, sunDir.y ).toVar();

		// ---- night sky: airglow + stars, extinguished near the horizon. Behind a
		// branch — by day this is thirty hashes of nothing.
		const horizonExt = smoothstep( - 0.05, 0.22, dir.y ).toVar();

		If( night.greaterThan( 0.003 ), () => {

			// Airglow. It is brightest *at* the horizon — it is a thin emitting
			// shell seen edge-on, so the path through it is longest where you look
			// along it — and a flat term gets that the wrong way round, which
			// leaves the night with no ground to it.
			const glowY = exp( max( dir.y, 0.0 ).mul( - 3.0 ) );
			col.addAssign( vec3( 0.0026, 0.0044, 0.0060 )
				.mul( glowY.mul( 0.85 ).add( 0.30 ) ).mul( night ) );
			col.addAssign( nightSky( dir ).mul( u.starBrightness ).mul( night ).mul( horizonExt ) );

			// The aurora, one texel of it. `level` is set from outside so the sky
			// keeps one definition of night and this does not invent a second.
			col.addAssign( texture( aurora.lut, dirToUV( dir ) ).rgb
				.mul( aurora.uniforms.level ).mul( night ) );

			// moonlight in-scatter: a cheap cool Rayleigh copy, no march needed.
			// It stays blue however warm the moon is — Rayleigh is blue whatever
			// colour goes into it, which is the whole reason a moonlit night reads
			// cold while the moon in it reads warm.
			col.addAssign( vec3( 0.055, 0.075, 0.13 )
				.mul( float( 1.0 ).add( cosM.mul( cosM ) ) )
				.mul( pow( max( moonDir.y, 0.0 ), 0.4 ) )
				.mul( horizonExt.mul( 0.8 ).add( 0.2 ) )
				.mul( u.moonLevel ).mul( night ).mul( 0.09 ) );

			// ...and the aureole, which is Mie rather than Rayleigh: forward
			// scattering off the same haze that rings the sun, so it carries the
			// moon's own colour and dies within a few degrees of the disc. Without
			// it a warm moon sits in a cold halo and reads as a sticker.
			//
			// Both exponents are deliberately high. The first attempt used 6 for
			// the outer lobe, which is half-strength thirteen degrees out and still
			// visible at forty: that is not an aureole, it is fog lit from behind,
			// and it swallowed the stars across a third of the sky. 220/26 puts the
			// bright ring at ~4° and the soft one at ~13°, which is what a moon in
			// clean marine air actually has.
			const cm = max( cosM, 0.0 ).toVar();
			col.addAssign( u.moonColor
				.mul( pow( cm, 220.0 ).mul( 0.90 ).add( pow( cm, 26.0 ).mul( 0.055 ) ) )
				.mul( u.moonLevel ).mul( night ).mul( 0.38 ) );

		} );

		// ---- the moon: a sphere lit by the actual sun direction
		const alphaM = smoothstep( u.moonCosR, u.moonCosR.add( 0.00012 ), cosM );

		const t1 = normalize( cross( moonDir, vec3( 0.0, 1.0, 0.0 ).add( 0.0001 ) ) );
		const t2 = cross( t1, moonDir );

		const sinR = sqrt( float( 1.0 ).sub( u.moonCosR.mul( u.moonCosR ) ) );
		const q = dir.sub( moonDir.mul( cosM ) );
		const mu = dot( q, t1 ).div( sinR );
		const mv = dot( q, t2 ).div( sinR );
		const r2 = clamp( mu.mul( mu ).add( mv.mul( mv ) ), 0.0, 1.0 );
		const mw = sqrt( float( 1.0 ).sub( r2 ) );

		// sphere normal facing the viewer; the terminator is geometry, not paint
		const n = t1.mul( mu ).add( t2.mul( mv ) ).sub( moonDir.mul( mw ) );
		const lit = max( dot( n, sunDir ), 0.0 );

		const maria = float( 0.72 ).add( noise2( vec2( mu, mv ).mul( 3.1 ).add( 7.3 ) ).mul( 0.28 ) )
			.mul( float( 0.86 ).add( noise2( vec2( mu, mv ).mul( 8.7 ).add( 2.1 ) ).mul( 0.14 ) ) );

		// Sunlit face + earthshine. The gain stays under 1, because past it the
		// moon comes out white however warm the tint is set: ACES desaturates
		// toward white as a channel goes past 1, and 1.5 × the tint clipped the red
		// and green while the blue was still on the curve — the colour was being
		// tone-mapped out of it. Under 1 the whole triple stays on the chromatic
		// part of the curve and the disc keeps its cream. It is not dimmer for it:
		// against a night sky three orders of magnitude below this, headroom is
		// what is scarce, not light.
		const moonSurface = u.moonColor
			.mul( lit.mul( 0.80 ).add( 0.015 ) )
			.mul( maria ).mul( u.moonBrightness )
			.mul( smoothstep( - 0.04, 0.06, dir.y ) );

		col.assign( mix( col, moonSurface, alphaM ) );
		// The corona sits on top of the disc, so it counts against the same
		// headroom: at 0.25 it pushed the sum past 1 and handed the clipping — and
		// the white — straight back.
		col.addAssign( u.moonColor.mul( pow( max( cosM, 0.0 ), 900.0 ).mul( u.moonLevel ).mul( 0.12 ) ) );

		// ---- the sun disc. Its radiance is the sun-path transmittance the CPU
		// integrated this frame, so it reddens and dims through exactly the same
		// physics that reddens the sky — no separate sunset curve anywhere.
		//
		// It is measured here and *composited at the end*, after the shoulder,
		// for two reasons that pull in opposite directions. It cannot go before:
		// the shoulder would flatten it into the horizon it sits on and the sun
		// would disappear at exactly the hour you most want to see it. And it
		// cannot keep using `sunI` for its brightness: that number drives a
		// scattering integral, and the disc borrowing it sat four times over the
		// top of the tone curve at every hour of the day, which is a white dot
		// whatever colour the physics says it is. Its own gain instead, chosen so
		// a horizon sun lands just above the sky it sits in and a noon sun goes
		// off the top — which is the right way round, and is what lets the disc
		// keep the deep orange `sunColor` has been carrying all along.
		// The disc keeps `sunColor`'s *hue* and takes its brightness from the
		// shoulder's own ceiling — a fixed gain cannot work at both ends of the
		// day. Too high and a horizon sun is white; too low and it goes darker
		// than the sky behind it as the red channel collapses, which renders the
		// sun as a notch cut out of its own sunset. Pinned just over the ceiling
		// it is always the brightest thing in frame, and always the colour the
		// sun-path transmittance says it is: white at noon, gold at six, and a
		// deep orange in the last minutes.
		const DISC_OVER = 1.9;    // how far over the sky's ceiling the disc sits
		const peak = max( max( u.sunColor.x, u.sunColor.y ), u.sunColor.z ).toVar();
		const tint = u.sunColor.div( max( peak, 1e-4 ) );
		const disc = smoothstep( u.sunCosR, u.sunCosR.add( 0.00010 ), cosS ).toVar();
		const aboveH = smoothstep( - 0.012, 0.004, sunDir.y ).toVar();
		const sunRad = tint.mul( SKY_MAX * DISC_OVER ).mul( aboveH ).toVar();

		// ---- clouds: an fbm slab on a curved shell, lit by marching the same
		// noise toward the sun (Beer) with a powder term for the bright edges
		// Where the ray pierces a slab at cloud altitude, in units of cloud
		// feature size — 1/y for a flat layer, pulled in by the quadratic term so
		// the horizon converges instead of stretching to infinite streaks.
		const cy = max( dir.y, 0.012 );
		const shell = min( float( 1.0 ).div( cy.add( cy.mul( cy ).mul( 0.9 ) ) ), 30.0 ).toVar();
		const drift = vec2( u.time.mul( u.cloudSpeed ).mul( 0.006 ), u.time.mul( u.cloudSpeed ).mul( 0.0023 ) );
		const cuv = dir.xz.mul( shell.mul( u.cloudScale.mul( 3.2 ) ) ).add( drift ).toVar();

		// billows minus a finer erosion pass — the subtraction is what gives
		// cauliflower edges instead of a single smooth blob
		// erosion lowers the mean density by ~0.1, so the coverage threshold sits
		// that much lower than the naive 1 − coverage
		const thr = float( 0.90 ).sub( u.cloudCoverage ).toVar();
		const dens = ( p ) => fbm( p ).sub( fbm( p.mul( 3.7 ).add( 5.1 ) ).mul( 0.22 ) );

		const den = dens( cuv ).toVar();
		const cover = smoothstep( thr, thr.add( 0.20 ), den )
			.mul( smoothstep( 0.0, 0.055, dir.y ) )
			.mul( u.cloudOpacity ).toVar();

		// Everything below is skipped for clear sky, which is most of the frame
		// most of the time — worth a branch, because it is four more fbm.
		const cloudCol = vec3( 0.0 ).toVar();

		If( cover.greaterThan( 0.004 ), () => {

			// self-shadow: two taps up-sun through the slab (plain fbm — the
			// erosion octave costs as much as the tap and never shows in a shadow)
			const sunUV = normalize( vec2( sunDir.x, sunDir.z ).add( 1e-4 ) );
			const d1 = smoothstep( thr, thr.add( 0.20 ), fbm( cuv.add( sunUV.mul( 0.20 ) ) ) );
			const d2 = smoothstep( thr, thr.add( 0.20 ), fbm( cuv.add( sunUV.mul( 0.52 ) ) ) );
			const along = d1.mul( 0.62 ).add( d2.mul( 0.38 ) ).toVar();

			// Beer–Powder: transmitted light plus the dark-edge/bright-edge term
			// that makes a flat slab read as a volume
			const beer = exp( along.mul( - 2.6 ) ).toVar();
			const powder = float( 1.0 ).sub( exp( cover.mul( - 3.0 ) ) );
			const hg = pow( max( cosS, 0.0 ), 6.0 ).mul( 0.8 ).add( pow( max( cosS, 0.0 ), 48.0 ).mul( 2.6 ) );

			const cloudLit = u.sunColor.mul( u.sunI ).mul( aboveH )
				.mul( beer.mul( powder.mul( 0.6 ).add( 0.4 ) ).mul( hg.add( 0.9 ) ) ).mul( 0.058 );
			// ambient: the sky the cloud actually sits in, not the zenith — a
			// cloud low over a burning horizon is lit orange from below
			const cloudAmb = lutAt( vec3( dir.x, max( dir.y, 0.09 ), dir.z ) ).mul( 0.7 )
				.add( vec3( 0.03, 0.04, 0.07 ).mul( u.moonLevel ).mul( night ).mul( 0.4 ) );

			cloudCol.assign( cloudLit.add( cloudAmb.mul( beer.mul( 0.4 ).add( 0.6 ) ) ) );

			// distant clouds sit behind kilometres of air: let the low ones
			// dissolve into the horizon instead of hanging there as dark streaks
			cloudCol.assign( mix( cloudCol, col, smoothstep( 0.30, 0.015, dir.y ).mul( 0.85 ) ) );

		} );

		const sky = shoulder( mix( col, cloudCol, cover ) ).toVar();
		const clear = cover.oneMinus().toVar();

		// the photosphere is opaque — the air in front of it contributes nothing
		sky.assign( mix( sky, sunRad, disc.mul( clear ) ) );
		// The aureole the LUT's 1.4°-wide texels cannot resolve. Unlike the disc
		// this one *does* carry the raw attenuation: glare is scattered sunlight,
		// and it is the thing that genuinely dies as the sun reddens — which is
		// why you can look at a setting sun and not at a midday one.
		sky.addAssign( sunRad.mul( peak ).mul( pow( max( cosS, 0.0 ), 2200.0 ) ).mul( clear.mul( 0.55 ) ) );
		sky.addAssign( sunRad.mul( peak ).mul( pow( max( cosS, 0.0 ), 180.0 ) ).mul( clear.mul( 0.07 ) ) );

		return sky;

	} );

	// What the camera sees with nothing in the way: sky above the horizon, sea
	// below it. Kept apart from sample() because sample() is also what every
	// water pixel calls for its reflection — always an upward ray — and a branch
	// carrying two more texture fetches costs that path whether it is taken or
	// not.
	// ---- Snell's window ------------------------------------------------------
	//
	// Everything above the water arrives through a cone. Water's refractive
	// index is 1.333, so the critical angle is 48.6° from vertical: the entire
	// sky — horizon to horizon, 180° of it — is squeezed into that cone, and
	// outside it the surface is a mirror looking back down at the sea.
	//
	// It is worth doing properly rather than as a tinted vignette, because it is
	// the single strongest cue that you are underwater. The mapping is the one
	// line `sin(air) = 1.333 · sin(water)`, run backwards.
	const N_WATER = 1.333;
	const snell = /*@__PURE__*/ Fn( ( [ d ] ) => {

		const cosW = clamp( d.y, - 1.0, 1.0 ).toVar();
		const sinW = sqrt( max( float( 1.0 ).sub( cosW.mul( cosW ) ), 0.0 ) ).toVar();
		const sinA = sinW.mul( N_WATER ).toVar();

		const body = vec3( 0.012, 0.055, 0.075 ).toVar();
		const out = body.toVar();

		If( cosW.greaterThan( 0.0 ).and( sinA.lessThan( 1.0 ) ), () => {

			// inside the window: the sky, refracted outward and dimmed by Fresnel
			// transmission at a steep angle
			const cosA = sqrt( max( float( 1.0 ).sub( sinA.mul( sinA ) ), 0.0 ) );
			const horiz = normalize( vec3( d.x, 0.0, d.z ).add( vec3( 1e-5, 0.0, 0.0 ) ) );
			const refr = normalize( vec3( horiz.x.mul( sinA ), cosA, horiz.z.mul( sinA ) ) );
			// the rim of the window is where the transmitted cone runs out, and
			// it is bright: every grazing ray in the sky lands on that circle
			const rim = smoothstep( 0.72, 0.995, sinA );
			out.assign( sample( refr ).mul( rim.mul( 0.9 ).add( 0.55 ) ) );

		} );

		// ...and outside it, or below the horizontal, the water body itself,
		// darkening downward the way a column of water does
		const deep = smoothstep( 0.15, - 0.8, d.y );
		return mix( out, body.mul( 0.45 ), deep );

	} );

	const background = /*@__PURE__*/ Fn( ( [ rayDir ] ) => {

		const d = normalize( rayDir ).toVar();
		const col = vec3( 0.0 ).toVar();

		If( d.y.lessThan( 0.0 ), () => {

			col.assign( distantSea( d ) );

		} ).Else( () => {

			col.assign( sample( d ) );

		} );

		col.assign( mix( col, snell( d ), u.submerged ) );

		return col;

	} );

	// ---- aerial perspective -------------------------------------------------
	//
	// Distance haze as extinction toward the sky in the *view* direction, not a
	// lerp toward one fog colour: far land goes blue at noon, amber at sunset,
	// and the horizon matches the sky exactly because it *is* the sky.

	const aerial = Fn( ( [ colour, worldPos, cameraPos ] ) => {

		const delta = worldPos.sub( cameraPos ).toVar();
		const dist = length( delta ).toVar();
		const dir = delta.div( max( dist, 1e-4 ) ).toVar();

		// haze thins with altitude — the mean height of the segment stands in for
		// the integral, which is exact enough below a kilometre
		const meanY = max( cameraPos.y.add( worldPos.y ).mul( 0.5 ), 0.0 );
		const rho = exp( meanY.div( - 900.0 ) ).mul( 0.86 ).add( 0.14 ).toVar();

		// molecular extinction is per-channel (that is why distance goes blue),
		// aerosol is grey. Both are scaled up from sea-level truth: at the couple
		// of kilometres this world spans, honest coefficients would be invisible.
		const beta = u.betaR.mul( 4.0 ).add( vec3( u.betaM.mul( 5.0 ).mul( u.haze ) ) );
		const trans = exp( beta.mul( dist.mul( rho ) ).negate() ).toVar();

		const skyDir = normalize( vec3( dir.x, max( dir.y, 0.0 ), dir.z ) );
		const air = colour.mul( trans ).add( inscatter( skyDir ).mul( float( 1.0 ).sub( trans ) ) );

		// ---- and the same integral through water.
		//
		// The shape: a per-channel extinction that eats red an order of
		// magnitude faster than blue — which is why distance under water goes
		// blue-green rather than grey — and two in-scatter colours, a dark one
		// for looking down and a bright one for looking up, because the light
		// in water all comes from one direction and a single ambient makes a
		// flat aquarium.
		//
		// Two departures from a screen-space pass, both because this is a
		// per-fragment term: the sun's forward-scatter lobe is
		// dropped (it needs the view ray, which a fragment already has, but it
		// double-counts against the specular the water materials do themselves),
		// and the whole thing is faded toward air above the surface so a fragment
		// on the beach seen from underwater is not fogged as if it were wet.
		const aqua = float( 1.0 ).sub( smoothstep( 0.0, 1.2, worldPos.y.sub( u.seaLevel ) ) )
			.mul( u.submerged ).toVar();

		const wTrans = exp( AQUATIC_EXTINCTION.mul( dist ).negate() ).toVar();
		const upness = smoothstep( - 0.5, 0.75, dir.y );
		const dim = exp( min( cameraPos.y.sub( u.seaLevel ), 0.0 ).mul( 0.055 ) );
		const inWater = mix( vec3( 0.010, 0.075, 0.140 ), vec3( 0.100, 0.320, 0.370 ), upness )
			.mul( dim ).mul( u.sunColor.mul( u.sunI ).length().mul( 0.12 ).add( 0.04 ) );

		const water = colour.mul( wTrans ).add( inWater.mul( float( 1.0 ).sub( wTrans.g ) ) );

		return mix( air, water, aqua );

	} );

	// ---- CPU side -----------------------------------------------------------

	// optical depth from the ground toward the sun, integrated in JS — the
	// colour of direct sunlight on everything, and of the disc
	const sunLight = { color: new THREE.Color( 1, 1, 1 ), level: 1 };

	function updateSunLight() {

		const s = u.sunDir.value;
		const dirY = s.y, dirH = Math.hypot( s.x, s.z );

		// march the sun ray from eye altitude to the top of the atmosphere
		const r0y = R_PLANET + EYE_ALT;
		const b = 2 * r0y * dirY;
		const c = r0y * r0y - R_ATMOS * R_ATMOS;
		const tEnd = ( - b + Math.sqrt( Math.max( b * b - 4 * c, 0 ) ) ) / 2;

		const N = 24, dt = tEnd / N;
		let odR = 0, odM = 0;

		for ( let i = 0; i < N; i ++ ) {

			const t = ( i + 0.5 ) * dt;
			const py = r0y + dirY * t, px = dirH * t;
			const h = Math.hypot( px, py ) - R_PLANET;
			odR += Math.exp( - h / H_RAYLEIGH ) * dt;
			odM += Math.exp( - h / H_MIE ) * dt;

		}

		const bR = u.betaR.value;
		const bM = u.betaM.value;
		const tr = [
			Math.exp( - ( bR.x * odR + bM * odM ) ),
			Math.exp( - ( bR.y * odR + bM * odM ) ),
			Math.exp( - ( bR.z * odR + bM * odM ) ),
		];

		// below the horizon the disc is gone; ~0 before the geometric sunset so
		// the last sliver still lights the scene
		const below = THREE.MathUtils.smoothstep( dirY, - 0.02, 0.01 );
		const peak = Math.max( tr[ 0 ], 1e-6 );

		u.sunColor.value.setRGB( tr[ 0 ] / peak, tr[ 1 ] / peak, tr[ 2 ] / peak ).multiplyScalar( peak * below );

		sunLight.color.setRGB( tr[ 0 ] / peak, tr[ 1 ] / peak, tr[ 2 ] / peak );
		sunLight.level = peak * below;

		// moon: lit fraction × how high it is
		const m = u.moonDir.value;
		const illum = THREE.MathUtils.clamp( ( 1 - s.dot( m ) ) * 0.5, 0, 1 );
		u.moonLevel.value = illum * THREE.MathUtils.smoothstep( m.y, - 0.02, 0.25 );

	}

	function setTime( hour ) {

		celestialDir( hour, config.sun.maxElevation, u.sunDir.value );
		celestialDir( hour - config.moon.offsetHours, config.moon.maxElevation, u.moonDir.value );

		// small azimuth twist so sun and moon never share the exact same arc
		const twist = 9 * PI / 180;
		const m = u.moonDir.value;
		const c = Math.cos( twist ), s = Math.sin( twist );
		m.set( m.x * c + m.z * s, m.y, m.z * c - m.x * s );

		u.starRot.value = hour / 24 * PI * 2;

		updateSunLight();
		dirty = true;

	}

	function syncConfig() {

		u.betaR.value.set( ...BETA_R ).multiplyScalar( config.atmosphere.rayleigh );
		// turbidity × the Mie slider drive the aerosol load; defaults land on the
		// textbook 21e-6
		u.betaM.value = config.atmosphere.mieCoefficient * config.atmosphere.turbidity * 1.95e-3;
		u.mieG.value = config.atmosphere.mieDirectionalG;
		u.sunCosR.value = Math.cos( ( config.sun.discRadius || 0.9 ) * PI / 180 );
		u.moonCosR.value = Math.cos( config.moon.angularRadius * PI / 180 );
		u.moonBrightness.value = config.moon.brightness;
		u.moonColor.value.setRGB( ...config.moon.tint, THREE.SRGBColorSpace );
		u.starThreshold.value = config.stars.density;
		u.starBrightness.value = config.stars.brightness;

		if ( config.clouds ) {

			u.cloudCoverage.value = config.clouds.coverage;
			u.cloudScale.value = config.clouds.scale;
			u.cloudSpeed.value = config.clouds.speed;
			u.cloudOpacity.value = config.clouds.opacity;

		}

		updateSunLight();
		dirty = true;

	}

	// re-march only when the sun actually moved — a paused clock costs nothing
	let dirty = true;

	function update( renderer ) {

		if ( ! dirty ) return;
		renderer.compute( bake );
		dirty = false;

	}

	syncConfig();

	return { sample, background, inscatter, distantSea, aerial, uniforms: u, sunLight, setTime, syncConfig, update, lut, aurora };

}
