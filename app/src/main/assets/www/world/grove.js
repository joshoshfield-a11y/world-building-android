// The island's interior: a wood of ash, and the leaves the wind pulls off it.
//
// The trees are grown by the structured ash generator in
// ./ash/ — four orders of branch with a terminal continuation at every level,
// which is the thing that gives an ash its sparse, irregular crown rather than
// the candelabra a lateral-only generator produces. What that module hands
// back is one indexed geometry per *variant*, in local space; this file is
// about the two questions it does not answer: how 430 of them get onto the
// island for the price of five, and what they look like once the sun is on
// them.
//
// **Instanced, not merged.** Every previous tree in this world — the palms,
// the wood this replaces — is pre-transformed into merged buffers, on the
// stated grounds that a custom `positionNode` on an InstancedMesh discards the
// instance transform. That is true of `positionGeometry` and false of
// `positionLocal`: three applies instancing *into* `positionLocal` and only
// then lets `positionNode` overwrite it, so a wind shader that reads
// `positionLocal` and adds to it keeps the instance matrix. Measured, with two
// boxes and one node, before any of this was written. It is worth the check —
// merged, this wood is 6 M triangles of geometry uploaded and held; instanced
// it is five trees' worth, and the tree count stops being a memory decision.
//
// The per-tree variation that merging used to buy for free now has to be
// carried explicitly, and it is: `aInst` gives every instance its own wind
// phase, its own canopy tint and its own scale, so five geometries do not read
// as five clones stamped 86 times each.
//
// Trees are bucketed on a 170 m grid so three's frustum culling can drop the
// half of the wood behind the camera — an InstancedMesh is one bounding sphere
// and one draw, so a single mesh for the island would submit every tree from
// every angle.

import * as THREE from 'three/webgpu';
import {
	Fn, attribute, uniform, varying, texture, uv,
	float, vec2, vec3, vec4,
	normalize, dot, cross, mix, smoothstep, step, max, min, clamp, sin, cos, pow, sign, floor, fract, length, abs,
	positionLocal, positionWorld, cameraPosition, normalWorld,
} from 'three/tsl';

import { growAsh } from './ash/tree-system.js';
import { woodVariants } from './ash/preset.js';

const LEAF_TEXTURE = /*@__PURE__*/ new URL( '../assets/ash/leaf.png', import.meta.url ).href;

const srgb = ( r, g, b ) => {

	const c = new THREE.Color().setRGB( r, g, b, THREE.SRGBColorSpace );
	return vec3( c.r, c.g, c.b );

};

// Value noise on a 2D lattice. The sky has its own copy of this and they are
// better apart: that one is a cloud field in five octaves on a rotating domain,
// this one is three octaves of bark, and sharing them would mean an interface
// wide enough to satisfy both.
const hash2 = /*@__PURE__*/ Fn( ( [ p ] ) => fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ).mul( 43758.5453123 ) ) );

const noise2 = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const i = floor( p ).toVar(), f = fract( p ).toVar();
	const w = f.mul( f ).mul( float( 3.0 ).sub( f.mul( 2.0 ) ) );
	const a = hash2( i );
	const b = hash2( i.add( vec2( 1.0, 0.0 ) ) );
	const c = hash2( i.add( vec2( 0.0, 1.0 ) ) );
	const d = hash2( i.add( vec2( 1.0, 1.0 ) ) );
	return mix( mix( a, b, w.x ), mix( c, d, w.x ), w.y );

} );

// ---------------------------------------------------------------------------

export async function makeGrove( trees, rig, windDirector, atmosphere, shadow, worldScale ) {

	const timeU = rig.time;
	const windDirU = windDirector.directionU;
	const windU = uniform( 0.3 );

	// The leaf card is not a leaf — it is a whole compound ash shoot with its
	// own rachis, which is why sixteen of them along a twig fills a crown and
	// why the card is a third of a metre rather than a few centimetres. It is
	// also why the canopy colour comes out of the image: replacing it with a
	// procedural green throws away the one thing a photographed spray has, which
	// is that no two leaflets on it are the same green.
	const leafTex = await new THREE.TextureLoader().loadAsync( LEAF_TEXTURE );
	leafTex.colorSpace = THREE.SRGBColorSpace;
	leafTex.anisotropy = 4;

	// ---- grow the variants --------------------------------------------------

	const variants = woodVariants.map( ( v ) => growAsh( v.preset, { height: v.height } ) );

	// ---- place ---------------------------------------------------------------

	const CELL = 170;
	const buckets = new Map();
	const crowns = [];

	const _m = new THREE.Matrix4();
	const _q = new THREE.Quaternion();
	const _e = new THREE.Euler();
	const _p = new THREE.Vector3();
	const _s = new THREE.Vector3();
	const _crown = new THREE.Vector3();

	for ( const t of trees ) {

		const vi = Math.min( variants.length - 1, Math.floor( t.seed * variants.length ) );
		const variant = variants[ vi ];

		// The scatter's own `scale` runs 1.05–1.8 and was sized for a generator
		// whose output height was a free parameter. Here the height is baked into
		// the variant, so the field is re-read as a modest ±15% on top of it —
		// enough that neighbours differ, not so much that the five variants stop
		// being five sizes of tree.
		const s = 0.82 + ( t.scale - 1.05 ) * 0.40;

		// lean, about the horizontal axis perpendicular to its own direction
		_e.set( 0, t.rot, 0 );
		_q.setFromEuler( _e );
		_q.multiply( new THREE.Quaternion().setFromAxisAngle(
			new THREE.Vector3( Math.cos( t.leanDir ), 0, Math.sin( t.leanDir ) ).cross( new THREE.Vector3( 0, 1, 0 ) ).normalize(),
			t.lean ) );

		// sink the root a little so a trunk on a slope does not stand on a heel
		_p.set( t.x, t.h - 0.25 * s, t.z );
		_s.setScalar( s );
		_m.compose( _p, _q, _s );

		const key = `${ Math.floor( t.x / CELL ) },${ Math.floor( t.z / CELL ) }`;
		let bucket = buckets.get( key );
		if ( ! bucket ) buckets.set( key, bucket = variants.map( () => [] ) );

		// aInst — (wind phase, canopy tint, instance scale, spare). The phase is
		// the whole reason a wood of five geometries does not pulse in unison.
		bucket[ vi ].push( {
			matrix: _m.clone(),
			inst: [ ( t.seed * 37.1 + t.rot * 5.3 ) % ( Math.PI * 2 ), ( t.seed * 7.3 ) % 1, s, 0 ],
		} );

		_crown.set( variant.crown.x, variant.crown.y, variant.crown.z ).applyMatrix4( _m );
		crowns.push( { x: _crown.x, y: _crown.y, z: _crown.z, r: variant.crown.r * s } );

	}

	// ---- material ------------------------------------------------------------

	const material = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );
	material.alphaTest = 0.5;

	const wind = attribute( 'aWind', 'vec4' );     // sway, unused, flutter, part
	const surf = attribute( 'aSurf', 'vec2' );     // wood (along, around) · leaf (rand, outwardness)
	const inst = attribute( 'aInst', 'vec4' );     // phase, tint, scale, spare
	const leaf = surf;

	material.positionNode = Fn( () => {

		// `positionLocal`, not `positionGeometry` — see the note at the top of
		// this file. By the time a positionNode runs, this holds the vertex with
		// its instance matrix already applied, and the mesh itself sits at the
		// origin, so everything below is in world metres.
		const p = positionLocal.toVar();
		const phase = inst.x;
		const sway = sin( timeU.mul( 0.78 ).add( phase ) ).mul( 0.62 )
			.add( sin( timeU.mul( 0.29 ).add( phase.mul( 1.7 ) ) ).mul( 0.48 ) )
			.mul( windU ).mul( inst.z );

		p.x.addAssign( windDirU.x.mul( wind.x ).mul( sway ) );
		p.z.addAssign( windDirU.y.mul( wind.x ).mul( sway ) );

		// leaf flutter: fast, out of phase with itself on the two axes, so a
		// spray twists as well as bounces. Perpendicular to the wind rather than
		// along it, because a shoot on a twig pivots — it does not surge. The
		// weight is the card's own v, so the rachis stays on its branch and the
		// tip is what moves.
		const r = phase.add( leaf.x.mul( 41.0 ) );
		const amp = wind.z.mul( windU.mul( 1.6 ).add( 0.25 ) ).mul( 0.16 ).mul( inst.z );
		p.y.addAssign( sin( timeU.mul( 4.4 ).add( r ) ).mul( amp ) );
		p.x.addAssign( windDirU.y.mul( sin( timeU.mul( 3.3 ).add( r.mul( 1.7 ) ) ).mul( amp ) ) );
		p.z.addAssign( windDirU.x.negate().mul( sin( timeU.mul( 3.3 ).add( r.mul( 1.7 ) ) ).mul( amp ) ) );

		return p;

	} )();

	const vPart = varying( wind.w );
	const vRand = varying( leaf.x );
	const vOut = varying( leaf.y );
	const vTint = varying( inst.y );

	material.colorNode = Fn( () => {

		const L = rig.sunDir;
		const eye = cameraPosition.sub( positionWorld ).toVar();
		const toEye = length( eye ).toVar();
		const V = eye.div( toEye );

		// A leaf is a two-sided sheet: which way its baked normal happens to face
		// is meaningless, so flip it toward the viewer before lighting it. Wood
		// keeps its own normal.
		const raw = normalize( normalWorld ).toVar();
		const N = mix( raw, raw.mul( sign( dot( raw, V ) ) ), vPart ).toVar();

		const ndl = dot( N, L );
		const diffuse = max( ndl, 0.0 ).add( max( ndl.negate(), 0.0 ).mul( 0.28 ) );

		// ---- the spray. One texture read does albedo and silhouette both.
		const spray = texture( leafTex, uv() ).toVar();

		// ---- bark. Bark is *fissured*, and a fissure is a crease, not a wave, so
		// the field is folded through `abs`: a hard valley wherever it crosses
		// zero, which is what a crack looks like.
		//
		// What it is a field *of* is the part that took three tries. It was a sum
		// of three sines of world position — and a sum of plane waves is a moiré
		// pattern, not a texture. On the trunk it came out as corduroy, two and a
		// half regular stripes around the bole; on the branches, where two of the
		// waves cut across a thin cylinder at different angles, it interfered
		// into a cross-hatch that read unmistakably as *braided rope*. No amount
		// of retuning the frequencies fixes that, because the periodicity is the
		// artifact.
		//
		// So: aperiodic value noise, in the limb's own surface frame rather than
		// in world space. `aSurf` carries metres along the limb and metres around
		// it, measured in the generator where the tube was built, and the domain
		// is squashed 18:1 along the limb — which is the one thing that actually
		// makes bark look like bark, because fissures run the way the tree grew.
		// A world-space field cannot do this: a branch and the trunk it leaves
		// point different ways, and orientation is not recoverable from a vertex
		// normal on a cylinder. (This is also why the generator's own bark UV —
		// a ring index and an alternating 0/1 — was replaced: it carries no
		// direction at all.)
		const bq = vec2( surf.y, surf.x.mul( 0.055 ) ).toVar();
		// Band-limiting, by hand. There is no mip chain on a procedural field,
		// and a 3 cm crack on a trunk forty metres away is a quarter of a pixel:
		// left alone the far half of the wood crawls with speckle every time the
		// camera moves. The fine octaves fade out with distance and the crease
		// settles to its own mean, which is what a mip level *is*.
		const detail = smoothstep( 44.0, 12.0, toEye ).toVar();
		// Two crack *sets*, not two octaves of one field. Summing octaves and
		// taking `abs` of the total sounds equivalent and is not: wherever the
		// coarse octave sits far from zero the sum can never reach it, so the
		// cracks bunch into scribbled patches with bare wood between them. Each
		// set folded separately and combined with `min` puts cracks everywhere,
		// deep ones sparse and shallow ones between — which is how bark divides.
		// The domain wanders first, so they meander up the trunk instead of
		// running dead straight.
		const warp = noise2( bq.mul( vec2( 6.0, 26.0 ) ) ).sub( 0.5 ).mul( 0.022 );
		const bw = vec2( bq.x.add( warp ), bq.y ).toVar();
		const deep = smoothstep( 0.010, 0.150, abs( noise2( bw.mul( 30.0 ) ).sub( 0.5 ) ) ).toVar();
		const fine = smoothstep( 0.020, 0.190, abs( noise2( bw.mul( 66.0 ).add( 11.3 ) ).sub( 0.5 ) ) ).toVar();
		// ...and one set the other way up. Cracks that all run vertically and
		// nothing else is corduroy: what makes bark read as *plated* is that the
		// ridges are broken across at intervals, so each plate has a length.
		const across = smoothstep( 0.030, 0.230,
			abs( noise2( vec2( bw.x.mul( 0.25 ), bw.y.mul( 3.0 ) ).mul( 30.0 ).add( 41.0 ) ).sub( 0.5 ) ) ).toVar();
		const shallow = ( c, d ) => c.mul( detail.mul( d ) ).add( detail.mul( - d ).add( 1.0 ) );
		const crease = mix( float( 0.72 ),
			min( deep, min( shallow( fine, 0.42 ), shallow( across, 0.34 ) ) ), detail ).toVar();
		// a plate of bark also varies in tone between its neighbours, and the
		// grain inside one plate keeps the ridges from reading as flat paint
		const plate = noise2( bq.mul( 4.5 ).add( 31.7 ) );
		const grain = noise2( bq.mul( vec2( 210.0, 34.0 ) ).add( 63.1 ) ).sub( 0.5 ).mul( detail.mul( 0.16 ) );
		// Ash bark is pale grey and finely ridged — greyer and lighter than the
		// warm brown a generic trunk gets painted, and almost all of the colour a
		// real trunk shows is the light on it rather than the wood.
		const bark = mix( srgb( 0.155, 0.148, 0.134 ), srgb( 0.575, 0.558, 0.512 ),
			crease.mul( plate.mul( 0.30 ).add( 0.70 ) ).add( grain ) ).toVar();
		// the ridges catch a little sky the crevices never see
		bark.mulAssign( crease.mul( 0.14 ).add( 0.92 ) );

		// ---- foliage. The image already carries the within-spray variation, so
		// what is left is variation *between* trees: one ash is olive, the one
		// beside it nearly yellow, and correlating that with a per-instance
		// random is what stops 430 trees reading as 86 clones of five.
		const green = spray.rgb.toVar();
		green.assign( mix( green, green.mul( srgb( 1.28, 1.14, 0.62 ) ), pow( vTint, 1.6 ) ) );
		green.mulAssign( vRand.mul( 0.22 ).add( 0.89 ) );

		const albedo = mix( bark, green, vPart ).toVar();

		// The crown shades itself, and this is the term that gives a canopy an
		// inside. iq's rainforest gets it for free out of the ray-march — the
		// occlusion there is how deep into the ellipsoid the hit was — and the
		// same number here is how far the spray sits from the crown's centroid.
		// It only works if the denominator is the crown's *real* extent: with a
		// too-small one every leaf clamps to fully-lit and the tree flattens.
		const canopyAO = mix( float( 0.22 ), float( 1.0 ), pow( vOut, 1.5 ) );
		// wood is occluded by its own fissures, foliage by the crown around it
		const occ = mix( crease.mul( 0.20 ).add( 0.80 ), canopyAO, vPart ).toVar();

		const lit = shadow
			? texture( shadow.tex, positionWorld.xz.div( worldScale ) ).level( 0 ).x
			: float( 1.0 );

		const sunRad = rig.sunColor.mul( rig.sunStrength ).toVar();
		const skyRad = atmosphere.inscatter( vec3( 0.0, 1.0, 0.0 ) ).mul( rig.skyStrength )
			.add( rig.moonFill ).toVar();

		// Transmission is the whole look of a broadleaf at golden hour: the sun
		// behind a leaf lights it from the far side and it glows warmer and
		// yellower than it does in reflection.
		const back = clamp( dot( V.negate(), L ), 0.0, 1.0 );
		const through = pow( back, 2.6 ).mul( vPart ).mul( lit ).mul( vOut.mul( 0.75 ).add( 0.25 ) );

		// Sky is a hemisphere, so a leaf presenting its face upward sees a great
		// deal more of it than one hanging edge-on under the crown. Applying the
		// fill flat was worth several stops of contrast inside the canopy.
		const skyView = N.y.mul( 0.5 ).add( 0.5 ).mul( 0.7 ).add( 0.3 );

		// the moon as a second directional light — see island.js
		const moonRad = rig.moonRad.mul( smoothstep( - 0.35, 1.0, dot( N, rig.moonDir ) ) );

		const shaded = albedo.mul( sunRad.mul( diffuse.mul( lit ).add( 0.05 ) )
			.add( moonRad ).add( skyRad.mul( skyView ) ) )
			.mul( occ )
			.add( mix( green, green.mul( srgb( 1.35, 1.20, 0.45 ) ), 0.35 ).mul( sunRad ).mul( through ).mul( 1.15 ) )
			.toVar();

		// A grazing view of a leaf is mostly its waxy cuticle, and every canopy
		// picture that reads as foliage rather than as paint has this edge on it.
		// Rainforest spends a whole light on it (`1.10 · pow(fre, 5) · occ`); one
		// term of sky is enough here because the crown is real geometry.
		const fre = clamp( float( 1.0 ).add( dot( N, V.negate() ) ), 0.0, 1.0 );
		shaded.addAssign( skyRad.mul( pow( fre, 4.0 ).mul( 0.55 ) ).mul( occ ).mul( vPart ) );

		// Wood is opaque; the spray is a photograph of a shoot with a great deal
		// of sky in it, and the alpha test is what turns that rectangle into a
		// silhouette. 0.5 is the contract's value and it is the right one here
		// too: lower and the cards show their corners as a grey haze.
		const alpha = mix( float( 1.0 ), spray.a, vPart );

		return vec4( atmosphere.aerial( shaded, positionWorld, cameraPosition ), alpha );

	} )();

	// ---- meshes --------------------------------------------------------------

	const group = new THREE.Group();
	let tris = 0;

	for ( const bucket of buckets.values() ) {

		for ( let vi = 0; vi < variants.length; vi ++ ) {

			const list = bucket[ vi ];
			if ( list.length === 0 ) continue;

			const variant = variants[ vi ];

			// One geometry per variant, shared by every bucket that plants it —
			// the attribute objects are reused by reference, so only the tiny
			// per-instance buffer is new. `geometry.clone()` would deep-copy a
			// megabyte of positions per bucket for nothing.
			const geometry = new THREE.BufferGeometry();
			for ( const name of [ 'position', 'normal', 'uv', 'aWind', 'aSurf' ] ) {

				geometry.setAttribute( name, variant.geometry.getAttribute( name ) );

			}

			geometry.setIndex( variant.geometry.index );

			const instData = new Float32Array( list.length * 4 );
			for ( let i = 0; i < list.length; i ++ ) instData.set( list[ i ].inst, i * 4 );
			geometry.setAttribute( 'aInst', new THREE.InstancedBufferAttribute( instData, 4 ) );

			const mesh = new THREE.InstancedMesh( geometry, material, list.length );
			for ( let i = 0; i < list.length; i ++ ) mesh.setMatrixAt( i, list[ i ].matrix );
			mesh.instanceMatrix.needsUpdate = true;
			mesh.computeBoundingSphere();
			// the crowns move in the wind and the bounds are baked from the rest
			// pose, so give them room rather than letting a gust clip a tree out
			mesh.boundingSphere.radius *= 1.12;

			group.add( mesh );
			tris += variant.triangles * list.length;

		}

	}

	function setWind( level ) {

		windU.value = 0.18 + level * 0.55;

	}

	return { group, setWind, triangles: tris, material, crowns };

}

// ---------------------------------------------------------------------------
// Leaves adrift in the air.
//
// Four things separate a shot with leaves in it from a shot with a few dark
// specks drifting past.
//
//  * **A leaf comes off a tree.** Leaves in a box
//    that follows the camera, *gated* on how wooded the ground under
//    them is, answer the wrong question. A gate can say "there are trees near
//    here"; what you see standing in a wood is not leaves near trees, it is
//    leaves coming off *that* tree — they appear in a crown, they leave it, they
//    go downwind. A field is a blur over a stand and the eye reads it as weather.
//    So each leaf is baked onto a measured crown and falls from it, and the
//    density dial is a real per-tree count.
//  * **A falling leaf is the brightest thing in a wood.** Olive-brown vanishes
//    into the grass. A leaf is a thin translucent sheet with light
//    coming through it as well as off it, and against dark trunks it reads as a
//    bright yellow-green fleck. Gold is the wrong read — it says autumn, and
//    beside a summer wood it looks like litter — so the albedo runs chartreuse
//    to pale yellow-green, lighter than the canopy it fell out of at both ends,
//    and the transmission term does most of the lighting.
//  * **One tumble axis for the whole field flips every leaf in sync.** A frame
//    built from
//    a fixed horizontal `right` and one rotating vector makes the whole field
//    flip together in the plane of the wind. Each leaf gets its own tumble
//    axis and a second rotation about its own length, so it flashes broad, then
//    edge-on, then broad again on nobody else's schedule.
//  * **A leaf a hand's width from the lens is not in focus.** A soft glowing
//    blob is most of why a near leaf reads as
//    something that flew past rather than as a card stuck to the screen. There
//    is no depth of field in this renderer and it does not need one: the quad
//    already carries its own leaf-space coordinate, so feathering the alpha from
//    the rim inward — with a feather width that opens up as the leaf approaches
//    the camera — is a convincing bokeh for one `smoothstep`.
// ---------------------------------------------------------------------------

export function makeDriftingLeaves( crowns, perTree, rig, windDirector, atmosphere, terrain, shadow, worldScale ) {

	const SIZE = 0.072;
	const DRIFT = 16;       // metres downwind a leaf is carried on the way down
	const FADE = [ 86, 62 ];// out past this, in inside it

	// ---- where a leaf starts.
	//
	// Leaves in a box that follows the camera, *gated* on how wooded the ground
	// under them is, answer the wrong question. A gate can say "there are trees
	// near here", and
	// what you see when you stand in a wood is not leaves near trees, it is
	// leaves coming off *that* tree: they appear in a crown, they leave it, and
	// they go downwind. A field is a blur over a stand and the eye reads it as
	// weather, not as shedding.
	//
	// So there is no field and no box. The tree builder already measures every
	// crown's centroid and radius — it needs them for the canopy occlusion — and
	// each leaf is baked onto one of them, at a point on the crown's outer shell
	// where leaves actually grow. `perTree` is then a real per-tree count, the
	// whole island has leaves in it wherever there are trees, and standing in a
	// meadow you see them over the wood and none around you, for the honest
	// reason rather than because a texture said so.
	const count = crowns.length * perTree;

	const bases = new Float32Array( count * 4 * 4 );   // shed x, shed z, phase, shed y
	const corners = new Float32Array( count * 4 * 2 );
	const seeds = new Float32Array( count * 4 * 4 );   // rand, tumble axis, size, style
	const indices = new Uint32Array( count * 6 );

	let seed = 20260820;
	const rnd = () => ( seed = ( seed * 48271 ) % 2147483647 ) / 2147483647;

	// a rhombus, not a rectangle: a tumbling quad reads as confetti, and the
	// silhouette is the only thing at this size that says "leaf"
	const C = [ [ 0, - 1 ], [ 0.8, - 0.15 ], [ 0, 1 ], [ - 0.8, - 0.15 ] ];

	let i = 0;

	for ( const c of crowns ) {

		for ( let n = 0; n < perTree; n ++, i ++ ) {

			// on the shell rather than through the volume: the leaves that let go
			// are the ones on the outside, and a leaf starting at the centroid
			// appears out of solid wood
			const th = rnd() * Math.PI * 2;
			const ph = Math.acos( 2 * rnd() - 1 );
			const rr = c.r * ( 0.55 + 0.45 * rnd() );
			const sx = c.x + rr * Math.sin( ph ) * Math.cos( th );
			const sz = c.z + rr * Math.sin( ph ) * Math.sin( th );
			const sy = c.y + rr * Math.cos( ph ) * 0.85;

			const phase = rnd();
			const r = rnd();
			const axis = rnd();
			// squared, so most leaves are ordinary and a few are big — and the big
			// ones are the only ones that ever fill any of the frame
			const size = 0.6 + rnd() * rnd() * 1.3;
			// 0 = flutters (rocks, swings wide, descends slowly), 1 = tumbles (turns
			// end over end and tracks the wind). Real leaves do one or the other
			// depending on how their inertia compares with the air they push.
			const style = rnd();

			for ( let k = 0; k < 4; k ++ ) {

				const j = i * 4 + k;
				bases[ j * 4 ] = sx;
				bases[ j * 4 + 1 ] = sz;
				bases[ j * 4 + 2 ] = phase;
				bases[ j * 4 + 3 ] = sy;
				corners[ j * 2 ] = C[ k ][ 0 ];
				corners[ j * 2 + 1 ] = C[ k ][ 1 ];
				seeds[ j * 4 ] = r;
				seeds[ j * 4 + 1 ] = axis;
				seeds[ j * 4 + 2 ] = size;
				seeds[ j * 4 + 3 ] = style;

			}

			const b = i * 4;
			indices.set( [ b, b + 1, b + 2, b, b + 2, b + 3 ], i * 6 );

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( new Float32Array( count * 12 ), 3 ) );
	geometry.setAttribute( 'aBase', new THREE.Float32BufferAttribute( bases, 4 ) );
	geometry.setAttribute( 'aCorner', new THREE.Float32BufferAttribute( corners, 2 ) );
	geometry.setAttribute( 'aSeed', new THREE.Float32BufferAttribute( seeds, 4 ) );
	geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );

	const windU = uniform( 0.3 );
	const timeU = rig.time;
	const windDirU = windDirector.directionU;

	const material = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide, transparent: true } );
	material.depthWrite = false;

	const bse = attribute( 'aBase', 'vec4' );
	const corner = attribute( 'aCorner', 'vec2' );
	const sd = attribute( 'aSeed', 'vec4' );

	const rand = sd.x, axisA = sd.y, sizeM = sd.z, style = sd.w;

	// The vertex work is written once, out here, and referenced by both stages.
	// Wrapping it in an Fn and calling it twice would build two copies in two
	// scopes and the fragment stage would read a value the vertex stage never
	// wrote — the same trap the gull and blade shaders hit.

	// each leaf falls at its own rate — a synchronised field pulses
	const life = bse.z.add( timeU.mul( rand.mul( 0.045 ).add( 0.030 ) ) );
	const k = fract( life );                             // 0 just shed, 1 at the grass
	const spin = rand.mul( 1.9 ).add( 0.6 );

	// A falling leaf does not drop, it slaloms — and a fluttering one slaloms
	// much wider than a tumbling one, which mostly goes where the wind sends it.
	const swing = sin( timeU.mul( 1.15 ).add( rand.mul( 29.0 ) ) ).mul( 1.7 )
		.add( sin( timeU.mul( 0.43 ).add( rand.mul( 11.0 ) ) ).mul( 2.6 ) );
	const glide = swing.mul( mix( float( 1.5 ), float( 0.45 ), style ) );

	// downwind of the branch it left, and further the longer it has been falling
	const carry = k.mul( DRIFT ).mul( windU.mul( 0.8 ).add( 0.55 ) );
	const wx = bse.x.add( windDirU.x.mul( carry ) ).add( windDirU.y.mul( glide ) );
	const wz = bse.y.add( windDirU.y.mul( carry ) ).add( windDirU.x.negate().mul( glide ) );

	// the ground it is heading for — one vertex texture read away
	const uv = vec2( wx, wz ).div( worldScale );
	const ground = texture( terrain.heightTex, uv ).level( 0 ).x;
	// the stall a fluttering leaf makes on each swing, so it does not descend on rails
	const bob = sin( timeU.mul( 1.9 ).add( rand.mul( 17.0 ) ) ).mul( 0.26 ).mul( style.oneMinus() );
	// from the branch it left down to the grass, over one cycle. Clamped to the
	// ground because the terrain it drifts over is not the terrain it left.
	const wy = max( mix( bse.w, ground.add( 0.22 ), k ).add( bob.mul( k.oneMinus() ) ),
		ground.add( 0.10 ) );

	// ---- orientation. Two rotations on a per-leaf axis: end-over-end about a
	// horizontal axis this leaf picked for itself, and a roll about its own
	// length. One axis for the whole field made every leaf flip in sync.
	const aa = axisA.mul( 6.28318 );
	const axis = vec2( cos( aa ), sin( aa ) );

	// a tumbler turns continuously; a flutterer rocks about level and hardly
	// turns over at all
	const ang = timeU.mul( spin.mul( style.mul( 1.5 ).add( 0.18 ) ) ).add( rand.mul( 37.0 ) )
		.add( sin( timeU.mul( 1.7 ).add( rand.mul( 13.0 ) ) ).mul( style.oneMinus().mul( 1.15 ) ) );
	const roll = timeU.mul( spin.mul( 0.75 ) ).add( rand.mul( 53.0 ) );

	const Lv = vec3( axis.x.mul( cos( ang ) ), sin( ang ), axis.y.mul( cos( ang ) ) ).toVar();
	const P = vec3( axis.y.negate(), 0.0, axis.x );
	const W = P.mul( cos( roll ) ).add( cross( Lv, P ).mul( sin( roll ) ) ).toVar();

	const centre = vec3( wx, wy, wz );
	const toCam = length( centre.sub( cameraPosition ) );

	// Fake defocus. `soft` is how close the leaf is to the lens; the fragment
	// stage turns it into a feather width, so a leaf that swings past your face
	// resolves as a soft bright blob rather than as a hard card.
	const vSoft = varying( smoothstep( 7.0, 0.6, toCam ), 'vLeafSoft' );
	const vNrm = varying( normalize( cross( Lv, W ) ), 'vLeafN' );
	// fade in as it lets go, out as it reaches the grass, and out with distance —
	// a leaf is 27 cm and past eighty metres it is a crawling speck
	const fade = smoothstep( 0.0, 0.06, k ).mul( smoothstep( 1.0, 0.90, k ) )
		.mul( smoothstep( FADE[ 0 ], FADE[ 1 ], toCam ) ).toVar();
	const vFade = varying( fade, 'vLeafFade' );
	const vRand = varying( rand, 'vLeafRand' );
	const vCorner = varying( corner, 'vLeafCorner' );

	// Leaves belong to trees now, so the whole island's worth is submitted every
	// frame and most of them are behind you or over the hill. Collapsing a faded
	// one to a point costs a `step` and takes its four fragments to zero — the
	// vertex stage still runs, but nothing downstream of it does.
	const size = float( SIZE ).mul( sizeM ).mul( step( 0.002, fade ) );
	material.positionNode = centre
		.add( W.mul( corner.x.mul( size ) ) )
		.add( Lv.mul( corner.y.mul( size.mul( 1.9 ) ) ) );

	material.colorNode = Fn( () => {

		const L = rig.sunDir;
		const eye = cameraPosition.sub( positionWorld ).toVar();
		const toEye = length( eye ).toVar();
		const V = eye.div( toEye );
		const N = normalize( vNrm ).toVar();
		const flipped = N.mul( sign( dot( N, V ) ) ).toVar();

		const ndl = dot( flipped, L );
		const diffuse = max( ndl, 0.0 );

		// **The same wood's greens.** These were a chartreuse-to-pale-yellow pair
		// picked to read against a dark trunk, and they did — as a different
		// plant. The drift's darkest was brighter than the canopy's brightest, so
		// a leaf changed material the instant it let go and the air filled with
		// yellow confetti falling past a green wood. The range now starts inside
		// the canopy's own and ends on the olive a few of its leaves have already
		// turned; a shed leaf is a leaf off *this* tree, and what actually
		// separates it from the crown is that you see it lit from behind.
		const albedo = mix( srgb( 0.20, 0.33, 0.10 ), srgb( 0.47, 0.48, 0.13 ), pow( vRand, 0.9 ) ).toVar();

		// ...and it stands in the same shadow. Without this a leaf drifting
		// through a hillside's shade stays in full sun, which is the other half
		// of why it did not belong to the wood around it.
		const lit = shadow
			? texture( shadow.tex, positionWorld.xz.div( worldScale ) ).level( 0 ).x
			: float( 1.0 );

		const sunRad = rig.sunColor.mul( rig.sunStrength ).toVar();
		const skyRad = atmosphere.inscatter( vec3( 0.0, 1.0, 0.0 ) ).mul( rig.skyStrength )
			.add( rig.moonFill ).toVar();

		// Transmission is most of the lighting on a leaf this thin, and the test
		// is per-leaf rather than per-view: the sun is behind *this* leaf when it
		// is on the far side of the face turned toward us. Looking into the sun
		// as well makes it glow harder, but it glows either way.
		const behind = max( dot( flipped, L ).negate(), 0.0 );
		const viewAlign = pow( clamp( dot( V.negate(), L ), 0.0, 1.0 ), 1.5 );
		const through = behind.mul( viewAlign.mul( 0.95 ).add( 0.4 ) ).mul( lit );

		const moonRad = rig.moonRad.mul( smoothstep( - 0.35, 1.0, dot( N, rig.moonDir ) ) );

		// Sky is a hemisphere here too: a leaf turned face-up sees all of it, one
		// turned edge-on sees half. The flat 1.15 was another stop and a half of
		// fill the canopy never gets, on top of everything else.
		const skyView = flipped.y.mul( 0.5 ).add( 0.5 ).mul( 0.7 ).add( 0.45 );

		const shaded = albedo.mul( sunRad.mul( diffuse.mul( lit ).add( 0.08 ) )
			.add( moonRad ).add( skyRad.mul( skyView ) ) )
			.add( mix( albedo, srgb( 0.58, 0.56, 0.16 ), 0.45 ).mul( sunRad ).mul( through ) )
			.toVar();

		// a leaf on its way past the lens is over-exposed in every photograph of
		// one, and the bloom is what sells the near miss
		shaded.mulAssign( vSoft.mul( 0.7 ).add( 1.0 ) );

		// ---- the fake bokeh. `vCorner` is the leaf's own coordinate, 0 at the
		// centre and 1 at the rim, so feathering inward from 1 rounds the
		// silhouette off exactly the way a defocused highlight rounds off. The
		// feather never goes fully to zero width: a 3-pixel alpha quad with a
		// hard edge aliases, and a hand's worth of softness is free anti-aliasing.
		const d = length( vec2( vCorner.x, vCorner.y.mul( 0.92 ) ) );
		const w = vSoft.mul( 0.72 ).add( 0.30 );
		const edge = smoothstep( 1.0, float( 1.0 ).sub( w ), d );

		return vec4( atmosphere.aerial( shaded, positionWorld, cameraPosition ), vFade.mul( edge ) );

	} )();

	const mesh = new THREE.Mesh( geometry, material );
	mesh.frustumCulled = false;
	mesh.renderOrder = 3;

	function update( level ) {

		windU.value = 0.18 + level * 0.55;

	}

	return { mesh, update, count };

}
