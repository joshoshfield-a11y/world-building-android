// Flowers, in patches.
//
// An eight-species table — petal counts 5/6/8/9 plus a per-variant delta, the
// profile pairs and the twist table kept exactly, because that table is what
// makes eight *species* rather than eight scalings of one flower. A petal is a
// parametric surface with **analytic derivatives** — `∂P/∂along × ∂P/∂across`
// gives the normal directly, so a curling petal lights correctly without a
// normal map and without finite differences. Stems are crossed ribbons: two
// quads at right angles, which from any angle is a stem and from no angle is a
// billboard.
//
// The petal surface runs once per species-variant on the CPU
// and becomes a small geometry, and everything per
// candidate — stem bend, wind, the head basis from the terminal
// tangent — is recomputed per vertex in TSL from per-instance attributes. The
// contract that matters is that a flower head sits on a *bent* stem and looks
// where the stem points, which is what stops a field of flowers reading as
// lollipops stuck in the ground.
//
// **They are not everywhere.** A flower field is a place, not a texture: the
// scatter picks a few dozen patch centres on gentle, well-grassed, unwooded
// ground and ragged them out with a two-octave organic
// field, so a patch has an edge that wanders and a middle that is dense.

import * as THREE from 'three/webgpu';
import {
	Fn, attribute, uniform, varying, texture, uv,
	float, vec2, vec3, vec4,
	normalize, dot, cross, mix, smoothstep, max, min, clamp, sin, cos, pow, length, abs, sqrt,
	positionGeometry, positionLocal, positionWorld, cameraPosition,
} from 'three/tsl';

const ATLAS = /*@__PURE__*/ new URL( '../assets/flowers/petals.png', import.meta.url ).href;

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// The species table. Eight species; the profile
// pairs are (radial growth, width, lift power term, lift sine term) and
// (angle variation, bend, twist, unused). Petal counts and the per-variant
// shape multipliers are what make one species read as a daisy and the next as
// a poppy, so none of it is "tuned" here.
// ---------------------------------------------------------------------------

const basePetalCount = ( s ) => ( s === 1 || s === 2 || s === 5 || s === 7 ) ? 5 : s === 3 ? 6 : s === 6 ? 9 : 8;
const variantDelta = ( v ) => v === 0 ? 0 : v === 2 ? 2 : 1;

const profileA = ( s ) =>
	( s === 1 || s === 7 ) ? [ 0.35, 0.16, 0.13, 0.055 ] :
		s === 3 ? [ 0.42, 0.13, 0.015, 0.04 ] :
			( s === 2 || s === 5 ) ? [ 0.34, 0.15, - 0.015, 0.07 ] :
				s === 6 ? [ 0.36, 0.09, 0.06, 0.045 ] : [ 0.37, 0.105, 0.005, 0.055 ];

const profileB = ( s ) =>
	( s === 1 || s === 7 ) ? [ 0.075, 0.095, 0.13 ] :
		s === 3 ? [ 0.055, 0.085, 0.07 ] :
			( s === 2 || s === 5 ) ? [ 0.085, 0.065, 0.16 ] :
				s === 6 ? [ 0.065, 0.10, 0.12 ] : [ 0.055, 0.05, 0.09 ];

const variantShape = ( v ) =>
	v === 1 ? [ 0.95, 1.06, 1.18, 0.88 ] :
		v === 2 ? [ 1.04, 1.02, 0.72, 1.18 ] :
			v === 3 ? [ 0.98, 1.03, 1.24, 1.10 ] :
				v === 4 ? [ 0.94, 1.08, 0.86, 0.84 ] : [ 1, 1, 1, 1 ];

const variantTwist = ( v ) => v === 1 ? 1.28 : v === 2 ? 0.76 : v === 3 ? 1.42 : v === 4 ? 1.16 : 1.0;

// species 5 is the one whose five variants differ enough in outline that a
// single length/width pair makes two of them look torn
const speciesCalibration = ( s, v ) => s !== 5 ? [ 1, 1 ]
	: [ [ 1.04, 0.90, 1.14, 0.98, 1.12 ][ v ], [ 0.72, 0.56, 0.64, 0.78, 0.90 ][ v ] ];

// A point on one petal, and its normal from the analytic derivatives of the
// same surface. Doing the normal by differencing neighbouring grid samples
// would be a lot cheaper and visibly wrong at the tip, where the surface turns
// hardest and the grid is coarsest.
function petalSurface( species, variant, slot, petalCount, along, across ) {

	const a = profileA( species ), b = profileB( species );
	const shape = variantShape( variant );
	const cal = speciesCalibration( species, variant );

	const phase = slot * 12.9898 + petalCount * 4.1414 + variant * 7.31;
	const variation = Math.sin( phase ) * b[ 0 ];
	const bendNoise = Math.sin( phase * 1.731 + 0.8 );
	const twistNoise = Math.sin( phase * 0.913 - 0.4 );
	const twistCoefficient = twistNoise * b[ 2 ] * variantTwist( variant );

	const angle = slot / petalCount * TAU + variation * 0.45 + twistCoefficient * Math.pow( along, 1.35 );
	const ax = Math.cos( angle ), az = Math.sin( angle );
	const tx = - az, tz = ax;

	const radialGrowth = a[ 0 ] * shape[ 0 ] * cal[ 0 ] * 0.84 + variation * 0.18;
	const radius = 0.004 + along * radialGrowth;
	const bend = bendNoise * b[ 1 ] * shape[ 3 ];
	const liftFloor = - 0.032 * Math.pow( along, 1.5 );
	const rawLift = a[ 2 ] * shape[ 2 ] * Math.pow( along, 1.55 )
		+ a[ 3 ] * shape[ 3 ] * Math.sin( Math.PI * along ) + bend * Math.pow( along, 1.7 );
	const lift = Math.max( liftFloor, rawLift );
	const width = a[ 1 ] * shape[ 1 ] * cal[ 1 ] * 1.32;
	const cup = ( 1 - across * across ) * 0.014 * Math.sin( Math.PI * along );

	const position = [
		ax * radius + tx * across * width,
		lift + cup,
		az * radius + tz * across * width,
	];

	const safeAlong = Math.max( along, 0.0001 );
	const angleDerivative = twistCoefficient * 1.35 * Math.pow( safeAlong, 0.35 );
	const floorDerivative = - 0.048 * Math.sqrt( Math.max( along, 0 ) );
	const rawDerivative = a[ 2 ] * shape[ 2 ] * 1.55 * Math.pow( safeAlong, 0.55 )
		+ a[ 3 ] * shape[ 3 ] * Math.PI * Math.cos( Math.PI * along )
		+ bend * 1.7 * Math.pow( safeAlong, 0.7 );
	const liftDerivative = rawLift > liftFloor ? rawDerivative : floorDerivative;
	const transverseAlong = ( 1 - across * across ) * 0.014 * Math.PI * Math.cos( Math.PI * along );
	const transverseAcross = - 2 * across * 0.014 * Math.sin( Math.PI * along );

	const dAlong = [
		ax * ( radialGrowth - angleDerivative * across * width ) + tx * angleDerivative * radius,
		liftDerivative + transverseAlong,
		az * ( radialGrowth - angleDerivative * across * width ) + tz * angleDerivative * radius,
	];
	const dAcross = [ tx * width, transverseAcross, tz * width ];

	// n = dAcross × dAlong
	const n = [
		dAcross[ 1 ] * dAlong[ 2 ] - dAcross[ 2 ] * dAlong[ 1 ],
		dAcross[ 2 ] * dAlong[ 0 ] - dAcross[ 0 ] * dAlong[ 2 ],
		dAcross[ 0 ] * dAlong[ 1 ] - dAcross[ 1 ] * dAlong[ 0 ],
	];
	const nl = Math.hypot( n[ 0 ], n[ 1 ], n[ 2 ] ) || 1;

	return { position, normal: [ n[ 0 ] / nl, n[ 1 ] / nl, n[ 2 ] / nl ] };

}

// ---------------------------------------------------------------------------
// One flower's geometry: a stem of two crossed ribbons and a head of petals.
//
// Nothing here is in world space and nothing here is bent. The stem's vertices
// carry only (along, side, plane) and get their curve in the vertex stage,
// because the curve depends on per-flower lean and on the wind, and a bent
// stem baked into a geometry is a stem that cannot move.
// ---------------------------------------------------------------------------

const RADIAL = 4, LATERAL = 2, STEM_SEG = 5;

function buildFlower( species, variant ) {

	const positions = [], normals = [], uvs = [], parts = [], stems = [], indices = [];
	const petalCount = basePetalCount( species ) + variantDelta( variant );

	const push = ( p, n, u, part, stem ) => {

		positions.push( p[ 0 ], p[ 1 ], p[ 2 ] );
		normals.push( n[ 0 ], n[ 1 ], n[ 2 ] );
		uvs.push( u[ 0 ], u[ 1 ] );
		parts.push( part );
		stems.push( stem[ 0 ], stem[ 1 ], stem[ 2 ] );
		return positions.length / 3 - 1;

	};

	// ---- stem: two ribbons at right angles, five segments each
	for ( let plane = 0; plane < 2; plane ++ ) {

		for ( let seg = 0; seg < STEM_SEG; seg ++ ) {

			const a0 = seg / STEM_SEG, a1 = ( seg + 1 ) / STEM_SEG;
			const base = positions.length / 3;
			for ( const [ along, side ] of [ [ a0, - 1 ], [ a0, 1 ], [ a1, - 1 ], [ a1, 1 ] ] ) {

				push( [ 0, along, 0 ], [ 0, 0, 1 ], [ 0, along ], 0, [ along, side, plane ] );

			}

			indices.push( base, base + 1, base + 2, base + 1, base + 3, base + 2 );

		}

	}

	// ---- head: one curved grid per petal, in head space
	for ( let slot = 0; slot < petalCount; slot ++ ) {

		for ( let r = 0; r < RADIAL; r ++ ) {

			for ( let l = 0; l < LATERAL; l ++ ) {

				const base = positions.length / 3;
				const cells = [
					[ r / RADIAL, l / LATERAL ],
					[ ( r + 1 ) / RADIAL, l / LATERAL ],
					[ r / RADIAL, ( l + 1 ) / LATERAL ],
					[ ( r + 1 ) / RADIAL, ( l + 1 ) / LATERAL ],
				];

				for ( const [ along, lat ] of cells ) {

					const across = lat * 2 - 1;
					const s = petalSurface( species, variant, slot, petalCount, along, across );
					// The atlas cell is inset a little on every side: a petal that
					// runs to the very edge of its cell picks up its neighbour's
					// colour along one seam as soon as a mip is used.
					const localU = 0.03 + ( across * 0.5 + 0.5 ) * 0.94;
					const localV = 0.025 + ( 1 - along ) * 0.95;
					// Only the species *column* is baked. The painted row travels
					// per instance — the separation between
					// the variant that decides a petal's shape and the one that
					// decides its picture — and it is what lets eight geometries
					// carry forty petal images.
					push( s.position, s.normal, [ ( species + localU ) / 8, localV ], 1, [ 1, 0, 0 ] );

				}

				indices.push( base, base + 1, base + 2, base + 1, base + 3, base + 2 );

			}

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );
	geometry.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
	geometry.setAttribute( 'aPart', new THREE.Float32BufferAttribute( parts, 1 ) );
	geometry.setAttribute( 'aStem', new THREE.Float32BufferAttribute( stems, 3 ) );
	geometry.setIndex( indices );

	return { geometry, triangles: indices.length / 3, petalCount };

}

// ---------------------------------------------------------------------------
// Where they grow
// ---------------------------------------------------------------------------

// Two rotated octaves of value noise. Rotating each one is the whole point:
// unrotated, the interpolation grid of a value-noise field is visible as
// axis-aligned diamonds the moment you use it as a density, and a meadow with
// a grid in it reads as a bug.
function organic( x, z, frequency, seed ) {

	const oct = ( fx, fz, rot, w ) => {

		const c = Math.cos( rot ), s = Math.sin( rot );
		const px = ( fx * c - fz * s ), pz = ( fx * s + fz * c );
		const ix = Math.floor( px ), iz = Math.floor( pz );
		const tx = px - ix, tz = pz - iz;
		const ux = tx * tx * ( 3 - 2 * tx ), uz = tz * tz * ( 3 - 2 * tz );
		const h = ( a, b ) => {

			const n = Math.sin( ( a * 127.1 + b * 311.7 + seed ) ) * 43758.5453123;
			return n - Math.floor( n );

		};

		return w * ( ( h( ix, iz ) * ( 1 - ux ) + h( ix + 1, iz ) * ux ) * ( 1 - uz )
			+ ( h( ix, iz + 1 ) * ( 1 - ux ) + h( ix + 1, iz + 1 ) * ux ) * uz );

	};

	const f = frequency;
	return oct( x * f, z * f, 0.0, 0.56 )
		+ oct( x * f * 2.07, z * f * 2.07, 0.9, 0.29 )
		+ oct( x * f * 2.07 * 1.91, z * f * 2.07 * 1.91, 2.1, 0.15 );

}

/**
 * @param terrain  the island bake — heightAt / densityAt / shoreAt / homestead
 * @param rig      islandGround.uniforms (sun, sky, moon, time)
 */
export async function makeFlowers( terrain, rig, windDirector, atmosphere, shadow, worldScale, config ) {

	const cfg = { patches: 34, perPatch: 130, radius: 11, ...( config || {} ) };

	const atlas = await new THREE.TextureLoader().loadAsync( ATLAS );
	atlas.colorSpace = THREE.SRGBColorSpace;
	atlas.anisotropy = 4;
	// The atlas is addressed with v = 0 at the *top*, the opposite of three's
	// default. Left
	// flipped, row 0 lands on row 4 and every petal wears its own image upside
	// down — wide end at the tip, which reads as a torn petal rather than as a
	// wrong one, so it is easy to mistake for a tessellation problem.
	atlas.flipY = false;

	const timeU = rig.time;
	const windDirU = windDirector.directionU;
	const windU = uniform( 0.4 );
	const contactU = uniform( new THREE.Vector3( 1e6, 0, 1e6 ) );

	// ---- geometries: eight species, two variants apiece -----------------------
	// One geometry per species, not per species-variant. A variant changes the
	// petal count and the outline, and eight more geometries would double the
	// draw calls to buy a difference the atlas row already carries; variant 1 is
	// the middle of the five shapes, so it is the one that stands for all of
	// them. Recorded divergence.
	const kinds = [];
	for ( let species = 0; species < 8; species ++ ) kinds.push( { species, ...buildFlower( species, 1 ) } );

	// ---- patches --------------------------------------------------------------

	let seed = 60817;
	const rnd = () => ( seed = ( seed * 48271 ) % 2147483647 ) / 2147483647;

	const half = worldScale / 2;
	const slopeAt = ( x, z ) => {

		const d = 3;
		const gx = terrain.heightAt( x + d, z ) - terrain.heightAt( x - d, z );
		const gz = terrain.heightAt( x, z + d ) - terrain.heightAt( x, z - d );
		return Math.hypot( gx, gz ) / ( 2 * d );

	};

	// A patch wants the conditions that actually grow a meadow: open ground the
	// grass already likes, gentle enough to hold soil, off the beach, and out
	// from under the wood. `densityAt` is the bake's grass density and it
	// already folds in canopy shade, so it is doing most of the work here.
	const centres = [];
	for ( let attempt = 0; attempt < cfg.patches * 400 && centres.length < cfg.patches; attempt ++ ) {

		const x = ( rnd() * 2 - 1 ) * half * 0.82;
		const z = ( rnd() * 2 - 1 ) * half * 0.82;
		const h = terrain.heightAt( x, z );
		if ( h < 3.5 || h > 78 ) continue;
		if ( terrain.densityAt( x, z ) < 0.72 ) continue;
		if ( slopeAt( x, z ) > 0.42 ) continue;
		if ( terrain.shoreAt( x, z ) < 14 ) continue;

		let clear = true;
		for ( const c of centres ) if ( ( c.x - x ) ** 2 + ( c.z - z ) ** 2 < ( cfg.radius * 3.2 ) ** 2 ) clear = false;
		if ( ! clear ) continue;

		// One patch, one dominant species, with a minority mixed through it.
		// Independent per-flower species selection keeps colour from ever
		// exposing the density field — right for a continent-sized field, and
		// wrong for a garden: a real stand of
		// one flower is a stand of one flower. So dominance is per *patch*, which
		// is a place you can walk to, and the 30% minority keeps the edge honest.
		// Three species to a patch, not eight. Partly because that is what a
		// stand looks like — a dominant with two companions through it — and
		// partly because species is what a draw call is keyed on here: mixing all
		// eight into every patch put five near-empty InstancedMeshes on screen
		// per cell for 4% of the flowers, and cost about 3 ms of CPU for it.
		const dominant = Math.floor( rnd() * 8 );
		centres.push( {
			x, z, r: cfg.radius * ( 0.7 + rnd() * 0.8 ),
			mix: [ dominant, ( dominant + 1 + Math.floor( rnd() * 3 ) ) % 8, ( dominant + 4 + Math.floor( rnd() * 3 ) ) % 8 ],
		} );

	}

	// ...plus the garden. A house with a terrace and no flowers anywhere near it
	// is a house nobody lives in.
	if ( terrain.homestead ) {

		const { x: hx, z: hz, radius } = terrain.homestead;
		for ( let i = 0; i < 5; i ++ ) {

			const a = rnd() * TAU, d = radius * ( 0.72 + rnd() * 0.5 );
			const x = hx + Math.cos( a ) * d, z = hz + Math.sin( a ) * d;
			if ( terrain.heightAt( x, z ) < 2 ) continue;
			const dominant = [ 3, 4, 7, 0, 6 ][ i ];
			centres.push( { x, z, r: 7 + rnd() * 4, mix: [ dominant, ( dominant + 3 ) % 8, ( dominant + 5 ) % 8 ] } );

		}

	}

	// ---- scatter ---------------------------------------------------------------

	const perKind = kinds.map( () => [] );
	const _m = new THREE.Matrix4();
	const _p = new THREE.Vector3();

	for ( const patch of centres ) {

		for ( let i = 0; i < cfg.perPatch; i ++ ) {

			const a = rnd() * TAU;
			const d = Math.sqrt( rnd() ) * patch.r;
			const x = patch.x + Math.cos( a ) * d, z = patch.z + Math.sin( a ) * d;

			// the meadow probability, which is what gives a patch a
			// ragged edge and a dense middle instead of a disc of confetti
			const broad = organic( x, z, 0.024, 307 );
			const detail = organic( x, z, 0.071, 401 );
			const t = Math.min( 1, Math.max( 0, ( broad * 0.78 + detail * 0.22 - 0.31 ) / ( 0.73 - 0.31 ) ) );
			const keep = 0.10 + 0.82 * ( t * t * ( 3 - 2 * t ) );
			// cubed rather than squared: a patch with a squared falloff is a
			// gradient, and what a stand of flowers has is a middle and an edge
			const falloff = 1 - ( d / patch.r ) ** 3;
			if ( rnd() > keep * falloff ) continue;

			const h = terrain.heightAt( x, z );
			if ( h < 1.6 ) continue;
			if ( terrain.densityAt( x, z ) < 0.42 ) continue;
			if ( slopeAt( x, z ) > 0.62 ) continue;

			const roll = rnd();
			const species = patch.mix[ roll < 0.70 ? 0 : roll < 0.87 ? 1 : 2 ];
			const painted = Math.floor( rnd() * 5 );        // which atlas row this one wears
			const ki = species;

			// the per-flower parameters
			const vigor = 0.68 + rnd() * 0.32;
			const scale = 0.72 + rnd() * 0.56;
			const height = ( 1.12 + ( vigor - 0.68 ) / 0.32 * 0.36 ) * scale * 0.78;
			const lean = ( 0.12 + Math.pow( rnd(), 0.72 ) * 0.50 ) * ( 0.72 + vigor * 0.33 ) * scale * 0.5;
			const curvePower = 1.72 + rnd() * 0.76;
			const leanAngle = rnd() * TAU;

			_p.set( x, h, z );
			_m.makeTranslation( _p.x, _p.y, _p.z );

			perKind[ ki ].push( {
				matrix: _m.clone(),
				a: [ height, lean, curvePower, leanAngle ],
				b: [ rnd() * TAU, scale * 0.86, rnd(), painted ],
			} );

		}

	}

	// ---- material ---------------------------------------------------------------

	const material = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );
	material.alphaTest = 0.34;

	const part = attribute( 'aPart', 'float' );
	const stem = attribute( 'aStem', 'vec3' );     // along, side, plane
	const fa = attribute( 'aFlowerA', 'vec4' );    // height, lean, curvePower, leanAngle
	const fb = attribute( 'aFlowerB', 'vec4' );    // phase, headScale, tint, spare

	// The stem curve, evaluated wherever it is needed — at a stem vertex, and
	// twice more at the tip to get the tangent the head is hung on. Static lean
	// rises as along^curvePower, wind as along², so the root never moves.
	const stemPoint = Fn( ( [ along, root ] ) => {

		const leanDir = vec2( cos( fa.w ), sin( fa.w ) );
		const staticLean = leanDir.mul( fa.y ).mul( pow( along, fa.z ) );
		const signal = sin( timeU.mul( 1.1 ).add( fb.x ) )
			.add( sin( timeU.mul( 0.63 ).add( fb.x.mul( 0.4 ) ) ).mul( 0.32 ) );
		const windOffset = windDirU.mul( signal ).mul( windU ).mul( 0.16 ).mul( along ).mul( along );

		// ...and the contact bend, which is the detail that makes walking through
		// a patch feel like walking through a patch. Same rooted along² weight,
		// pushing away from the feet.
		const delta = root.xz.sub( contactU.xz ).toVar();
		const dist = length( delta ).toVar();
		const away = delta.div( max( dist, 0.001 ) );
		const influence = float( 1.0 ).sub( smoothstep( 0.34, 1.35, dist ) ).mul( along ).mul( along );

		return vec3(
			staticLean.x.add( windOffset.x ).add( away.x.mul( influence ).mul( 0.62 ) ),
			fa.x.mul( along ).sub( influence.mul( 0.22 ) ),
			staticLean.y.add( windOffset.y ).add( away.y.mul( influence ).mul( 0.62 ) ) );

	} );

	material.positionNode = Fn( () => {

		// `positionLocal` already carries the instance translation and
		// `positionGeometry` does not, so their difference is this flower's root
		// — which is how a shader that rebuilds the vertex from scratch keeps the
		// instance transform it never reads. (See grove.js for why reading
		// `positionLocal` rather than `positionGeometry` matters at all.)
		const root = positionLocal.sub( positionGeometry ).toVar();

		const along = stem.x;
		const centre = stemPoint( along, root ).toVar();
		const ribbonAngle = fa.w.add( stem.z.mul( 1.5707963 ) );
		const side = vec2( sin( ribbonAngle ).negate(), cos( ribbonAngle ) )
			.mul( float( 0.029 ).mul( fb.y ).mul( mix( 1.12, 0.44, along ) ).mul( stem.y ) );
		const stemPos = centre.add( vec3( side.x, 0.0, side.y ) );

		// the head: the terminal tangent, an arbitrary but stable yaw, and the
		// petal surface carried into that frame
		const p0 = stemPoint( float( 0.92 ), root ).toVar();
		const p1 = stemPoint( float( 1.0 ), root ).toVar();
		const up = normalize( p1.sub( p0 ) ).toVar();
		const seedAxis = vec3( cos( fb.z.mul( 6.2831853 ) ), 0.0, sin( fb.z.mul( 6.2831853 ) ) );
		const axisX = normalize( seedAxis.sub( up.mul( dot( seedAxis, up ) ) ) ).toVar();
		const axisZ = normalize( cross( up, axisX ) ).toVar();
		const local = positionGeometry.mul( fb.y ).mul( 0.50 );
		const headPos = p1.add( axisX.mul( local.x ).add( up.mul( local.y ) ).add( axisZ.mul( local.z ) ) );

		return root.add( mix( stemPos, headPos, part ) );

	} )();

	// The petal normal has to make the same trip as the petal did.
	const petalNormal = Fn( () => {

		const root = positionLocal.sub( positionGeometry ).toVar();
		const p0 = stemPoint( float( 0.92 ), root ).toVar();
		const p1 = stemPoint( float( 1.0 ), root ).toVar();
		const up = normalize( p1.sub( p0 ) ).toVar();
		const seedAxis = vec3( cos( fb.z.mul( 6.2831853 ) ), 0.0, sin( fb.z.mul( 6.2831853 ) ) );
		const axisX = normalize( seedAxis.sub( up.mul( dot( seedAxis, up ) ) ) ).toVar();
		const axisZ = normalize( cross( up, axisX ) ).toVar();
		const n = attribute( 'normal', 'vec3' );
		return normalize( axisX.mul( n.x ).add( up.mul( n.y ) ).add( axisZ.mul( n.z ) ) );

	} );

	const vN = varying( petalNormal() );
	const vPart = varying( part );
	const vAlong = varying( stem.x );
	const vTint = varying( fb.z );
	const vAtlas = varying( fb.w );

	material.colorNode = Fn( () => {

		const L = rig.sunDir;
		const eye = cameraPosition.sub( positionWorld ).toVar();
		const V = eye.div( length( eye ) );

		// uv.x already holds the species column; uv.y is the petal's own 0..1 and
		// the row it lands in is this instance's.
		const cell = vec2( uv().x, vAtlas.add( uv().y ).div( 5.0 ) );
		const petal = texture( atlas, cell ).toVar();

		// Stem colour is a desaturated meadow green that pales
		// toward the head, matched to this island's own grass and light rather
		// than read out of a painted atlas.
		const stemCol = mix( vec3( 0.055, 0.135, 0.020 ), vec3( 0.10, 0.20, 0.035 ),
			smoothstep( 0.0, 0.72, vAlong ) );

		const albedo = mix( stemCol, petal.rgb, vPart ).toVar();
		// a patch of one species is still not one colour — the same flower opens
		// paler in its second week
		albedo.mulAssign( vTint.mul( 0.18 ).add( 0.91 ) );

		// A petal is a thin translucent sheet, so which way its normal happens to
		// point is not worth defending: flip it to the viewer and let the
		// transmission term do the rest.
		const N = mix( vec3( 0.0, 1.0, 0.0 ), vN, vPart ).toVar();

		const ndl = dot( N, L );
		const diffuse = max( ndl, 0.0 ).add( max( ndl.negate(), 0.0 ).mul( 0.34 ) );

		const lit = shadow
			? texture( shadow.tex, positionWorld.xz.div( worldScale ) ).level( 0 ).x
			: float( 1.0 );

		const sunRad = rig.sunColor.mul( rig.sunStrength ).toVar();
		const skyRad = atmosphere.inscatter( vec3( 0.0, 1.0, 0.0 ) ).mul( rig.skyStrength )
			.add( rig.moonFill ).toVar();
		const moonRad = rig.moonRad.mul( smoothstep( - 0.35, 1.0, dot( N, rig.moonDir ) ) );

		const back = clamp( dot( V.negate(), L ), 0.0, 1.0 );
		const through = pow( back, 2.2 ).mul( vPart ).mul( lit ).mul( 0.9 );

		const shaded = albedo.mul( sunRad.mul( diffuse.mul( lit ).add( 0.06 ) )
			.add( moonRad ).add( skyRad.mul( 0.85 ) ) )
			.add( albedo.mul( sunRad ).mul( through ) )
			.toVar();

		return vec4( atmosphere.aerial( shaded, positionWorld, cameraPosition ),
			mix( float( 1.0 ), petal.a, vPart ) );

	} )();

	// ---- meshes -------------------------------------------------------------

	const group = new THREE.Group();
	let tris = 0, count = 0;

	// Bucketed the same way the wood is, so an InstancedMesh is a patch of
	// ground rather than the whole island — one bounding sphere over 4 000
	// flowers scattered across a kilometre is a sphere that is never off screen.
	const CELL = 260;
	const byCell = new Map();

	for ( let ki = 0; ki < kinds.length; ki ++ ) {

		for ( const f of perKind[ ki ] ) {

			const key = `${ ki }|${ Math.floor( f.matrix.elements[ 12 ] / CELL ) },${ Math.floor( f.matrix.elements[ 14 ] / CELL ) }`;
			let list = byCell.get( key );
			if ( ! list ) byCell.set( key, list = { ki, items: [] } );
			list.items.push( f );

		}

	}

	for ( const { ki, items } of byCell.values() ) {

		const kind = kinds[ ki ];
		const geometry = new THREE.BufferGeometry();
		for ( const name of [ 'position', 'normal', 'uv', 'aPart', 'aStem' ] ) {

			geometry.setAttribute( name, kind.geometry.getAttribute( name ) );

		}

		geometry.setIndex( kind.geometry.index );

		const A = new Float32Array( items.length * 4 ), B = new Float32Array( items.length * 4 );
		for ( let i = 0; i < items.length; i ++ ) {

			A.set( items[ i ].a, i * 4 );
			B.set( items[ i ].b, i * 4 );

		}

		geometry.setAttribute( 'aFlowerA', new THREE.InstancedBufferAttribute( A, 4 ) );
		geometry.setAttribute( 'aFlowerB', new THREE.InstancedBufferAttribute( B, 4 ) );

		const mesh = new THREE.InstancedMesh( geometry, material, items.length );
		for ( let i = 0; i < items.length; i ++ ) mesh.setMatrixAt( i, items[ i ].matrix );
		mesh.instanceMatrix.needsUpdate = true;
		mesh.computeBoundingSphere();
		// the baked bounds know nothing about the stem it is about to grow
		mesh.boundingSphere.radius += 2.2;

		group.add( mesh );
		tris += kind.triangles * items.length;
		count += items.length;

	}

	function update( playerPos, windLevel ) {

		contactU.value.copy( playerPos );
		windU.value = 0.22 + windLevel * 0.5;

	}

	return { group, update, triangles: tris, count, patches: centres.length, material };

}
