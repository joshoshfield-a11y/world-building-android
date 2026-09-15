// Procedural coconut palms — trunk + drooping leaflet fronds, no models, no
// textures. All palms are baked into ONE merged geometry (a custom
// positionNode on an InstancedMesh would discard the instance transform —
// three applies instancing to positionLocal and then lets positionNode
// overwrite it — so instancing is off the table, and at ~700 tris a palm,
// 150 palms merge into a single cheap static draw anyway). Per-vertex
// attributes carry what the wind needs: sway weight, per-tree phase, part
// (trunk/frond), rib position and a per-frond random.

import * as THREE from 'three/webgpu';
import {
	Fn, attribute, uniform, varying, texture,
	float, vec3,
	normalize, dot, mix, smoothstep, max, clamp, sin, pow,
	positionGeometry, positionWorld, cameraPosition, normalWorld,
} from 'three/tsl';

const TRUNK_H = 7.0;
const UP = /*@__PURE__*/ new THREE.Vector3( 0, 1, 0 );

// one palm's vertices appended into the shared arrays, pre-transformed
function appendPalm( p, out, rand2 ) {

	const { positions, normals, parts, alongs, rands, sways, phases, indices } = out;

	const m = new THREE.Matrix4();
	const q = new THREE.Quaternion();
	const qy = new THREE.Quaternion();
	const axis = new THREE.Vector3( Math.cos( p.leanDir ), 0, Math.sin( p.leanDir ) )
		.cross( new THREE.Vector3( 0, 1, 0 ) ).normalize();

	q.setFromAxisAngle( axis, p.lean );
	qy.setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), p.rot );
	q.multiply( qy );
	m.compose( new THREE.Vector3( p.x, p.h - 0.15, p.z ), q, new THREE.Vector3().setScalar( p.scale ) );

	const nm = new THREE.Matrix3().getNormalMatrix( m );
	const phase = ( p.rot * 7.13 ) % ( Math.PI * 2 );

	const v = new THREE.Vector3();
	const n = new THREE.Vector3();

	const vert = ( pos, nor, part, along, frand ) => {

		const hFrac = Math.min( Math.max( pos.y / TRUNK_H, 0 ), 1.25 );
		v.copy( pos ).applyMatrix4( m );
		n.copy( nor ).applyMatrix3( nm ).normalize();
		positions.push( v.x, v.y, v.z );
		normals.push( n.x, n.y, n.z );
		parts.push( part );
		alongs.push( along );
		rands.push( frand );
		sways.push( hFrac * hFrac * 0.38 * p.scale );
		phases.push( phase );
		return positions.length / 3 - 1;

	};

	// ---- trunk: bent tapered tube
	const RINGS = 9, SIDES = 7;
	const bendX = 1.1;

	const ringCenter = ( t ) => new THREE.Vector3( bendX * t * t, TRUNK_H * t, 0 );
	const ringRadius = ( t ) => 0.15 * ( 1 - t * 0.45 ) + 0.09 * Math.max( 0, 1 - t * 8 );

	const base = positions.length / 3;

	for ( let ri = 0; ri <= RINGS; ri ++ ) {

		const t = ri / RINGS;
		const c = ringCenter( t );
		const rad = ringRadius( t );

		for ( let si = 0; si < SIDES; si ++ ) {

			const a = si / SIDES * Math.PI * 2;
			vert(
				new THREE.Vector3( c.x + Math.cos( a ) * rad, c.y, c.z + Math.sin( a ) * rad ),
				new THREE.Vector3( Math.cos( a ), 0, Math.sin( a ) ),
				0, t, 0 );

		}

	}

	for ( let ri = 0; ri < RINGS; ri ++ ) {

		for ( let si = 0; si < SIDES; si ++ ) {

			const a = base + ri * SIDES + si;
			const b = base + ri * SIDES + ( si + 1 ) % SIDES;
			indices.push( a, a + SIDES, b, b, a + SIDES, b + SIDES );

		}

	}

	// ---- fronds. A coconut frond is *pinnate*: a drooping rachis carrying
	// dozens of narrow leaflets that sweep back and hang. Building each side as
	// one continuous quad — the cheap way — is exactly what makes a palm read as
	// a paper toy, because the silhouette becomes a solid chevron with no light
	// through it. Individual leaflets cost ~3 tris each and buy the whole look.
	// A coconut palm carries twenty to thirty fronds four to six metres long on
	// a trunk twice that. Fourteen fronds of three metres gave a crown you could
	// see the sky through from every angle — the tree read as a sapling with a
	// few feathers on it. This is the cheapest thing in the scene to make more
	// of: a leaflet is three triangles and the whole grove is one draw.
	const FRONDS = 18, STATIONS = 24;
	const crown = ringCenter( 1 );
	const dir = new THREE.Vector3();
	const across = new THREE.Vector3();
	const nrm = new THREE.Vector3();
	const tip = new THREE.Vector3();
	const mid = new THREE.Vector3();
	const tmp = new THREE.Vector3();

	for ( let f = 0; f < FRONDS; f ++ ) {

		const az = f / FRONDS * Math.PI * 2 + ( f % 2 ) * 0.27 + rand2() * 0.25;
		const frondRand = ( f * 0.6180339887 + rand2() * 0.1 ) % 1;
		const L = 3.7 + frondRand * 1.35;
		// a crown holds fronds at every age at once: young ones stand up, old
		// ones have folded down past horizontal
		const age = ( f * 0.37 + rand2() * 0.3 ) % 1;
		const el0 = 0.95 - age * 0.95;
		const droop = 1.15 + age * 1.5;

		const dirH = new THREE.Vector2( Math.cos( az ), Math.sin( az ) );

		const rib = [ new THREE.Vector3( crown.x, crown.y, crown.z ) ];

		for ( let s = 1; s <= STATIONS; s ++ ) {

			const t = s / STATIONS;
			const el = el0 - droop * t * t;
			const step = L / STATIONS;
			const prev = rib[ s - 1 ].clone();
			prev.x += Math.cos( el ) * dirH.x * step;
			prev.z += Math.cos( el ) * dirH.y * step;
			prev.y += Math.sin( el ) * step;
			rib.push( prev );

		}

		const perp = new THREE.Vector3( - dirH.y, 0, dirH.x );

		// the rachis itself — a thin spine so the frond has a stem, not a gap
		for ( let s = 0; s < STATIONS; s ++ ) {

			const t = s / STATIONS;
			const w = 0.032 * ( 1 - t * 0.8 );
			const a = rib[ s ], b = rib[ s + 1 ];
			const off = perp.clone().multiplyScalar( w );

			const i0 = vert( tmp.copy( a ).sub( off ), UP, 1, t, frondRand );
			const i1 = vert( tmp.copy( a ).add( off ), UP, 1, t, frondRand );
			const i2 = vert( tmp.copy( b ).sub( off ), UP, 1, t + 1 / STATIONS, frondRand );
			const i3 = vert( tmp.copy( b ).add( off ), UP, 1, t + 1 / STATIONS, frondRand );
			indices.push( i0, i2, i1, i1, i2, i3 );

		}

		for ( let s = 1; s < STATIONS; s ++ ) {

			const t = s / STATIONS;
			const a = rib[ s ];

			// leaflets are longest a third of the way out and shrink to nothing
			// at the tip, where they fuse into a point
			const len = ( 0.40 + 0.92 * Math.sin( Math.min( t * 3.4, Math.PI * 0.86 ) ) )
				* ( 0.85 + frondRand * 0.3 );

			dir.subVectors( rib[ s + 1 ] || rib[ s ], rib[ s - 1 ] ).normalize();

			for ( const side of [ - 1, 1 ] ) {

				// sweep back toward the frond tip and hang: the two rotations that
				// make a leaflet look grown rather than glued on
				const jitter = ( ( s * 7 + ( side + 1 ) * 3 + f * 13 ) % 11 ) / 11;
				const sweep = 0.34 + jitter * 0.16;
				const drop = ( 0.30 + jitter * 0.35 ) * len * ( 0.4 + t );

				across.copy( perp ).multiplyScalar( side ).multiplyScalar( 1 - sweep )
					.addScaledVector( dir, sweep ).normalize();

				tip.copy( a ).addScaledVector( across, len );
				tip.y -= drop;
				mid.copy( a ).addScaledVector( across, len * 0.52 );
				mid.y -= drop * 0.20;

				nrm.crossVectors( across, dir ).normalize();
				if ( nrm.y < 0 ) nrm.negate();

				const wr = 0.055 + jitter * 0.018;
				const wm = wr * 0.72;

				const r0 = vert( tmp.copy( a ).addScaledVector( dir, - wr ), nrm, 1, t, frondRand );
				const r1 = vert( tmp.copy( a ).addScaledVector( dir, wr ), nrm, 1, t, frondRand );
				const m0 = vert( tmp.copy( mid ).addScaledVector( dir, - wm ), nrm, 1, t + 0.03, frondRand );
				const m1 = vert( tmp.copy( mid ).addScaledVector( dir, wm ), nrm, 1, t + 0.03, frondRand );
				const tp = vert( tip, nrm, 1, t + 0.06, frondRand );

				indices.push( r0, m0, r1, r1, m0, m1, m0, tp, m1 );

			}

		}

	}

	// ---- the nuts. Six triangles apiece and they are most of what tells you
	// which palm this is; a crown with nothing hanging under it reads as a fern
	// on a pole. They sit in the axils, tucked under the frond bases.
	const NUTS = 3 + Math.floor( rand2() * 4 );

	for ( let k = 0; k < NUTS; k ++ ) {

		const az = rand2() * Math.PI * 2;
		const r = 0.20 + rand2() * 0.16;
		const c = new THREE.Vector3(
			crown.x + Math.cos( az ) * r, crown.y - 0.18 - rand2() * 0.28, crown.z + Math.sin( az ) * r );
		const R = 0.14 + rand2() * 0.05;
		const first = positions.length / 3;
		// an octahedron, smoothed by its own normals — a coconut at fifteen
		// metres does not need latitude rings
		const dirs = [ [ 0, 1, 0 ], [ 1, 0, 0 ], [ 0, 0, 1 ], [ - 1, 0, 0 ], [ 0, 0, - 1 ], [ 0, - 1, 0 ] ];

		for ( const [ dx, dy, dz ] of dirs ) {

			vert( tmp.set( c.x + dx * R, c.y + dy * R * 1.15, c.z + dz * R ),
				new THREE.Vector3( dx, dy, dz ), 2, 0, 0 );

		}

		for ( let e = 0; e < 4; e ++ ) {

			const a = first + 1 + e, b = first + 1 + ( e + 1 ) % 4;
			indices.push( first, a, b, first + 5, b, a );

		}

	}

}

export function makePalms( palms, rig, windDirector, atmosphere, shadow, worldScale ) {

	const srgb = ( r, g, b ) => {

		const c = new THREE.Color().setRGB( r, g, b, THREE.SRGBColorSpace );
		return vec3( c.r, c.g, c.b );

	};

	const out = { positions: [], normals: [], parts: [], alongs: [], rands: [], sways: [], phases: [], indices: [] };

	let seed = 4242;
	const rand2 = () => ( seed = ( seed * 48271 ) % 2147483647 ) / 2147483647;

	for ( const p of palms ) appendPalm( p, out, rand2 );

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( out.positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( out.normals, 3 ) );
	geometry.setAttribute( 'aPart', new THREE.Float32BufferAttribute( out.parts, 1 ) );
	geometry.setAttribute( 'aAlong', new THREE.Float32BufferAttribute( out.alongs, 1 ) );
	geometry.setAttribute( 'aRand', new THREE.Float32BufferAttribute( out.rands, 1 ) );
	geometry.setAttribute( 'aSway', new THREE.Float32BufferAttribute( out.sways, 1 ) );
	geometry.setAttribute( 'aPhase', new THREE.Float32BufferAttribute( out.phases, 1 ) );
	geometry.setIndex( out.indices );

	const timeU = rig.time;
	const windDirU = windDirector.directionU;
	const windU = uniform( 0.3 );

	const material = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );

	const part = attribute( 'aPart', 'float' );
	const along = attribute( 'aAlong', 'float' );
	const frondRand = attribute( 'aRand', 'float' );
	const swayW = attribute( 'aSway', 'float' );
	const phase = attribute( 'aPhase', 'float' );

	// wind: whole-crown sway (world-space wind direction) + frond tip flutter
	material.positionNode = Fn( () => {

		const p = positionGeometry.toVar();

		const sway = sin( timeU.mul( 1.15 ).add( phase ) ).mul( 0.5 )
			.add( sin( timeU.mul( 0.37 ).add( phase.mul( 1.7 ) ) ) ).mul( windU );

		p.x.addAssign( windDirU.x.mul( swayW.mul( sway ) ) );
		p.z.addAssign( windDirU.y.mul( swayW.mul( sway ) ) );

		const flutter = sin( timeU.mul( 5.2 ).add( frondRand.mul( 31.0 ) ).add( along.mul( 9.0 ) ).add( phase ) )
			.mul( along.mul( along ) ).mul( 0.10 ).mul( windU.mul( 2.5 ).add( 0.35 ) ).mul( part );
		p.y.addAssign( flutter );

		return p;

	} )();

	const vPart = varying( part );
	const vAlong = varying( along );
	const vRand = varying( frondRand );

	material.colorNode = Fn( () => {

		const N = normalize( normalWorld );
		const L = rig.sunDir;

		// two-sided foliage lighting
		const ndl = dot( N, L );
		const diffuse = max( ndl, 0.0 ).add( max( ndl.negate(), 0.0 ).mul( 0.35 ) );

		// trunk: fibre bands and the ring scars a palm leaves as it grows
		const trunkTone = sin( positionWorld.y.mul( 14.0 ) ).mul( 0.08 )
			.add( sin( positionWorld.y.mul( 3.1 ) ).mul( 0.06 ) ).add( 1.0 );
		const trunkCol = srgb( 0.40, 0.34, 0.27 ).mul( trunkTone );

		// fronds: deep green, dry tips, per-frond variation. Real crowns are not
		// one green — the old outer fronds have yellowed while the middle is dark.
		const frondCol = mix( srgb( 0.09, 0.21, 0.07 ), srgb( 0.26, 0.36, 0.11 ), vRand.mul( 0.85 ) )
			.mul( mix( 1.0, 0.66, smoothstep( 0.45, 1.0, vAlong ) ) )
			.toVar();

		// a coconut is part 2 — husk brown, and it is the one thing in the crown
		// that is not translucent
		const nutCol = srgb( 0.30, 0.22, 0.11 ).mul( vRand.mul( 0.2 ).add( 0.9 ) );
		const isFrond = clamp( vPart, 0.0, 1.0 ).sub( clamp( vPart.sub( 1.0 ), 0.0, 1.0 ) ).toVar();
		const isNut = clamp( vPart.sub( 1.0 ), 0.0, 1.0 ).toVar();

		// the middle of a crown sits in its own shade all day — the fronds above
		// it are the densest thing on the tree
		const crownAO = mix( float( 0.52 ), float( 1.0 ), smoothstep( 0.0, 0.55, vAlong ) );
		const albedo = mix( mix( trunkCol, frondCol, isFrond ), nutCol, isNut )
			.mul( mix( float( 1.0 ), crownAO, isFrond ) );

		// the terrain's own cast shadow reaches the trunks too
		const lit = shadow
			? texture( shadow.tex, positionWorld.xz.div( worldScale ) ).level( 0 ).x
			: float( 1.0 );

		const sunRad = rig.sunColor.mul( rig.sunStrength ).toVar();
		const skyRad = atmosphere.inscatter( vec3( 0.0, 1.0, 0.0 ) ).mul( rig.skyStrength )
			.add( rig.moonFill ).toVar();

		// canopy transmission: sun behind a frond glows through it
		const V = normalize( cameraPosition.sub( positionWorld ) );
		const backAlign = clamp( dot( V.negate(), L ), 0.0, 1.0 );
		const transmission = pow( backAlign, 3.0 ).mul( isFrond ).mul( 0.85 ).mul( lit )
			.mul( smoothstep( 0.05, 0.6, vAlong ) );

		// the moon as a second directional light — see island.js. Without it the
		// palms are flat black cut-outs on a moonlit sky.
		const moonRad = rig.moonRad.mul( smoothstep( - 0.35, 1.0, dot( N, rig.moonDir ) ) );

		const shaded = albedo.mul( sunRad.mul( diffuse.mul( lit ).add( 0.06 ) )
			.add( moonRad ).add( skyRad.mul( 0.85 ) ) )
			.add( frondCol.mul( sunRad ).mul( transmission ) );

		return atmosphere.aerial( shaded, positionWorld, cameraPosition );

	} )();

	const mesh = new THREE.Mesh( geometry, material );
	mesh.frustumCulled = false;

	function setWind( level ) {

		windU.value = 0.16 + level * 0.5;

	}

	return { mesh, setWind };

}
