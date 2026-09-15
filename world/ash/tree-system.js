// Structured ash growth — the branch generator.
//
// The species
// contract — the level table, the continuation model, section evolution,
// taper, stratification and the interpolation quirk where orientation slerps
// from B *toward* A — is reproduced exactly, because that table is what makes
// the silhouette read as an ash rather than as a generic fractal tree. Change
// a number there and you get a candelabra.
//
// What is specific to this world:
//
//   * **One geometry, not two.** Branch and leaf geometries are merged into a
//     single buffer and told apart by `aWind.w`, because this world lights
//     everything through one rig (sun/sky/moon + shadow + aerial perspective)
//     rather than two Phong materials.
//   * **Real bark coordinates.** A ring index and an
//     alternating 0/1 V — fine for a tiling photo, useless for a procedural
//     fissure field, which needs to know which way the limb grew. Every vertex
//     carries metres *along* and *around* its own limb instead, so the cracks
//     run with the grain on a branch that points sideways.
//   * **Wind attributes.** The whole tree bends, not
//     just the leaf cards: `aWind` carries a height-weighted sway,
//     a flutter weight and the part flag, and the phase arrives per *instance*
//     so 430 trees off one geometry do not breathe in unison.
//   * **Crown occlusion.** Leaves carry how far they sit from the crown
//     centroid, which is what gives a canopy an inside when it is lit.
//
// The generator itself is CPU-side and runs at bake time. It is called a
// handful of times — one geometry per variant — and every tree in the wood is
// an instance of one of those.

import * as THREE from 'three/webgpu';

class SeededRandom {

	constructor( seed ) {

		this.w = ( 123456789 + seed ) | 0;
		this.z = ( 987654321 - seed ) | 0;

	}

	value( max = 1, min = 0 ) {

		this.z = ( 36969 * ( this.z & 65535 ) + ( this.z >> 16 ) ) | 0;
		this.w = ( 18000 * ( this.w & 65535 ) + ( this.w >> 16 ) ) | 0;
		const normalized = ( ( ( this.z << 16 ) + ( this.w & 65535 ) ) >>> 0 ) / 4294967296;
		return min + ( max - min ) * normalized;

	}

	shuffledIndices( count ) {

		const values = Array.from( { length: count }, ( _, index ) => index );
		for ( let index = count - 1; index > 0; index -= 1 ) {

			const swap = Math.floor( this.value() * ( index + 1 ) );
			[ values[ index ], values[ swap ] ] = [ values[ swap ], values[ index ] ];

		}

		return values;

	}

}

// Interpolate a stored section. The orientation starts at B and slerps toward
// A — the reverse of the obvious A→B — and that is deliberate: it
// is what sets the characteristic roll of an emerging branch. Keep it.
function interpolateSection( sections, normalizedDistance ) {

	const scaled = normalizedDistance * ( sections.length - 1 );
	const indexA = Math.min( Math.floor( scaled ), sections.length - 1 );
	const indexB = Math.min( indexA + 1, sections.length - 1 );
	const alpha = scaled - indexA;
	const sectionA = sections[ indexA ];
	const sectionB = sections[ indexB ];
	const qA = new THREE.Quaternion().setFromEuler( sectionA.orientation );
	const qB = new THREE.Quaternion().setFromEuler( sectionB.orientation );

	return {
		origin: new THREE.Vector3().lerpVectors( sectionA.origin, sectionB.origin, alpha ),
		radius: THREE.MathUtils.lerp( sectionA.radius, sectionB.radius, alpha ),
		orientation: new THREE.Euler().setFromQuaternion( qB.slerp( qA, alpha ) ),
	};

}

/**
 * Grow one tree and return it as a single indexed BufferGeometry, in local
 * space with the root at the origin and +Y up, scaled so the tree is exactly
 * `height` metres tall.
 *
 * Attributes:
 *   position, normal, uv   — uv is the leaf card's 0..1 on foliage; bark's own
 *                            ring uv on wood, where nothing reads it
 *   aWind  vec4            — (sway, phaseOffset, flutter, part)
 *   aSurf  vec2            — wood: (metres along limb, metres around limb)
 *                            leaf: (per-leaf random, outwardness in the crown)
 */
export function growAsh( preset, { height = 16 } = {} ) {

	const random = new SeededRandom( preset.seed );
	const forceDirection = new THREE.Vector3( ...preset.branch.forceDirection ).normalize();

	const positions = [], normals = [], uvs = [], winds = [], surfs = [], indices = [];

	// leaf bookkeeping: outwardness needs the crown centroid, which is not known
	// until every leaf exists, so the vertex range of each leaf is recorded and
	// back-filled once
	const leafOrigins = [];
	const leafVertexStart = [];

	const jobs = [ {
		origin: new THREE.Vector3(),
		orientation: new THREE.Euler(),
		length: preset.branch.length[ 0 ],
		radius: preset.branch.radius[ 0 ],
		level: 0,
		sectionCount: preset.branch.sections[ 0 ],
		segmentCount: preset.branch.segments[ 0 ],
		continuation: true,
	} ];

	const push = ( p, n, u, v, wind, surf ) => {

		positions.push( p.x, p.y, p.z );
		normals.push( n.x, n.y, n.z );
		uvs.push( u, v );
		winds.push( wind[ 0 ], wind[ 1 ], wind[ 2 ], wind[ 3 ] );
		surfs.push( surf[ 0 ], surf[ 1 ] );
		return positions.length / 3 - 1;

	};

	// ---- leaves ------------------------------------------------------------

	function emitLeaf( origin, orientation, level ) {

		const size = preset.leaves.size *
			( 1 + random.value( preset.leaves.sizeVariance, - preset.leaves.sizeVariance ) );
		const rand = random.value();

		leafOrigins.push( origin.clone() );
		leafVertexStart.push( positions.length / 3 );

		for ( const cardRotation of [ 0, Math.PI * 0.5 ] ) {

			const base = positions.length / 3;
			const localVertices = [
				new THREE.Vector3( - size * 0.5, size, 0 ),
				new THREE.Vector3( - size * 0.5, 0, 0 ),
				new THREE.Vector3( size * 0.5, 0, 0 ),
				new THREE.Vector3( size * 0.5, size, 0 ),
			];
			const uv = [ [ 0, 1 ], [ 0, 0 ], [ 1, 0 ], [ 1, 1 ] ];
			// Both perpendicular cards use the *unrotated* card normal
			// before adding the vertex direction. It is a quirk and it is
			// also what keeps a leaf pair from lighting as two separate flags, so
			// it stays.
			const cardNormal = new THREE.Vector3( 0, 0, 1 ).applyEuler( orientation ).normalize();

			for ( let vertexIndex = 0; vertexIndex < 4; vertexIndex ++ ) {

				const vertex = localVertices[ vertexIndex ]
					.applyAxisAngle( new THREE.Vector3( 0, 1, 0 ), cardRotation )
					.applyEuler( orientation )
					.add( origin );
				const roundedNormal = cardNormal.clone().add( vertex.clone().sub( origin ) ).normalize();
				// The wind slots are filled in twice: here the first two hold the
				// vertex's raw height and its branch order, and the back-fill turns
				// them into a sway weight. `flutter` is the card's own v — 0 at the
				// twig it hangs off, 1 at the tip — so the flutter is rooted at
				// the stalk.
				push( vertex, roundedNormal, uv[ vertexIndex ][ 0 ], uv[ vertexIndex ][ 1 ],
					[ vertex.y, preset.branchLevels, uv[ vertexIndex ][ 1 ], 1 ], [ rand, 0 ] );

			}

			indices.push( base, base + 1, base + 2, base, base + 2, base + 3 );

		}

	}

	function emitLeavesAlongFinalBranch( sections, level ) {

		const count = preset.leaves.count;
		const radialOffset = random.value();
		const angularSlots = random.shuffledIndices( count );
		const step = ( 1 - preset.leaves.start ) / count;

		for ( let slot = 0; slot < count; slot ++ ) {

			const along = preset.leaves.start + ( slot + random.value() ) * step;
			const parent = interpolateSection( sections, along );
			const azimuth = Math.PI * 2 *
				( radialOffset + ( angularSlots[ slot ] + random.value( 0.5, - 0.5 ) ) / count );
			const localTilt = new THREE.Quaternion().setFromAxisAngle(
				new THREE.Vector3( 1, 0, 0 ), THREE.MathUtils.degToRad( preset.leaves.angle ) );
			const localAzimuth = new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), azimuth );
			const parentQuaternion = new THREE.Quaternion().setFromEuler( parent.orientation );
			const orientation = new THREE.Euler().setFromQuaternion(
				parentQuaternion.multiply( localAzimuth.multiply( localTilt ) ) );
			emitLeaf( parent.origin, orientation, level );

		}

	}

	// ---- lateral children --------------------------------------------------

	function enqueueLateralChildren( parentLevel, sections ) {

		const level = parentLevel + 1;
		const count = preset.branch.children[ parentLevel ];
		const start = preset.branch.start[ level ];
		const radialOffset = random.value();
		const angularSlots = random.shuffledIndices( count );
		const step = ( 1 - start ) / count;

		for ( let slot = 0; slot < count; slot ++ ) {

			const along = start + ( slot + random.value() ) * step;
			const parent = interpolateSection( sections, along );
			const azimuth = Math.PI * 2 *
				( radialOffset + ( angularSlots[ slot ] + random.value( 0.5, - 0.5 ) ) / count );
			const localTilt = new THREE.Quaternion().setFromAxisAngle(
				new THREE.Vector3( 1, 0, 0 ), THREE.MathUtils.degToRad( preset.branch.angle[ level ] ) );
			const localAzimuth = new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3( 0, 1, 0 ), azimuth );
			const parentQuaternion = new THREE.Quaternion().setFromEuler( parent.orientation );
			const orientation = new THREE.Euler().setFromQuaternion(
				parentQuaternion.multiply( localAzimuth.multiply( localTilt ) ) );

			jobs.push( {
				origin: parent.origin,
				orientation,
				// a lateral child's radius is the species factor times the *parent's
				// interpolated* radius at the point it leaves, so thickness follows
				// emergence height rather than being a per-level constant
				length: preset.branch.length[ level ],
				radius: preset.branch.radius[ level ] * parent.radius,
				level,
				sectionCount: preset.branch.sections[ level ],
				segmentCount: preset.branch.segments[ level ],
				continuation: false,
			} );

		}

	}

	// ---- the growth loop ---------------------------------------------------

	while ( jobs.length > 0 ) {

		const branch = jobs.shift();
		const indexOffset = positions.length / 3;
		const orientation = branch.orientation.clone();
		const origin = branch.origin.clone();
		const sectionLength = branch.length / branch.sectionCount;
		const sections = [];
		const wrapsX = Math.max( 1, Math.round( branch.radius * preset.bark.textureScaleX ) );

		for ( let sectionIndex = 0; sectionIndex <= branch.sectionCount; sectionIndex ++ ) {

			let sectionRadius = branch.radius *
				( 1 - preset.branch.taper[ branch.level ] * ( sectionIndex / branch.sectionCount ) );
			if ( sectionIndex === branch.sectionCount && branch.level === preset.branchLevels ) {

				sectionRadius = 0.001;

			}

			const along = sectionIndex * sectionLength;   // metres up this limb
			const circumference = 2 * Math.PI * Math.max( sectionRadius, 0.02 );

			let firstVertex, firstNormal;

			for ( let radialIndex = 0; radialIndex < branch.segmentCount; radialIndex ++ ) {

				const angle = ( Math.PI * 2 * radialIndex ) / branch.segmentCount;
				const radial = new THREE.Vector3( Math.cos( angle ), 0, Math.sin( angle ) );
				const vertex = radial.clone().multiplyScalar( sectionRadius ).applyEuler( orientation ).add( origin );
				const normal = radial.clone().applyEuler( orientation ).normalize();
				if ( radialIndex === 0 ) {

					firstVertex = vertex.clone();
					firstNormal = normal.clone();

				}

				push( vertex, normal,
					( radialIndex / branch.segmentCount ) * wrapsX, sectionIndex % 2 === 0 ? 0 : 1,
					[ vertex.y, branch.level, 0, 0 ],
					[ along, ( radialIndex / branch.segmentCount ) * circumference ] );

			}

			// seam: the first radial vertex again, so the bark coordinate can run
			// past the wrap instead of folding back on itself
			push( firstVertex, firstNormal, wrapsX, sectionIndex % 2 === 0 ? 0 : 1,
				[ firstVertex.y, branch.level, 0, 0 ], [ along, circumference ] );

			sections.push( { origin: origin.clone(), orientation: orientation.clone(), radius: sectionRadius } );

			origin.add( new THREE.Vector3( 0, sectionLength, 0 ).applyEuler( orientation ) );

			// gnarliness is amplified on thin limbs — 1/sqrt(radius) — which is why
			// twigs wander and the bole does not
			const safeRadius = Math.max( sectionRadius, 0.001 );
			const gnarliness = Math.max( 1, 1 / Math.sqrt( safeRadius ) ) * preset.branch.gnarliness[ branch.level ];
			orientation.x += random.value( gnarliness, - gnarliness );
			orientation.z += random.value( gnarliness, - gnarliness );

			const sectionQuaternion = new THREE.Quaternion().setFromEuler( orientation );
			sectionQuaternion.multiply( new THREE.Quaternion().setFromAxisAngle(
				new THREE.Vector3( 0, 1, 0 ), preset.branch.twist[ branch.level ] ) );

			// ...and then the whole section is turned back toward the growth force
			// by an angle that also scales as 1/radius. Phototropism, cheaply.
			const sectionUp = new THREE.Vector3( 0, 1, 0 ).applyQuaternion( sectionQuaternion );
			const forceAxis = new THREE.Vector3().crossVectors( sectionUp, forceDirection );
			const sine = forceAxis.length();
			if ( sine > 1e-6 ) {

				forceAxis.divideScalar( sine );
				const fullAngle = Math.atan2( sine, sectionUp.dot( forceDirection ) );
				const step = preset.branch.forceStrength / safeRadius;
				sectionQuaternion.premultiply( new THREE.Quaternion().setFromAxisAngle(
					forceAxis, THREE.MathUtils.clamp( step, - fullAngle, fullAngle ) ) );

			}

			orientation.setFromQuaternion( sectionQuaternion );

		}

		const ringSize = branch.segmentCount + 1;
		for ( let sectionIndex = 0; sectionIndex < branch.sectionCount; sectionIndex ++ ) {

			for ( let radialIndex = 0; radialIndex < branch.segmentCount; radialIndex ++ ) {

				const a = indexOffset + sectionIndex * ringSize + radialIndex;
				const b = a + 1, c = a + ringSize, d = b + ringSize;
				indices.push( a, c, b, b, c, d );

			}

		}

		const finalSection = sections.at( - 1 );

		if ( branch.level < preset.branchLevels ) {

			// The terminal continuation. Without it the crown is a candelabra:
			// every limb would end where its laterals begin. It inherits the
			// parent's section and segment counts rather than the next level's.
			jobs.push( {
				origin: finalSection.origin,
				orientation: finalSection.orientation,
				length: preset.branch.length[ branch.level + 1 ],
				radius: finalSection.radius,
				level: branch.level + 1,
				sectionCount: branch.sectionCount,
				segmentCount: branch.segmentCount,
				continuation: true,
			} );
			enqueueLateralChildren( branch.level, sections );

		} else {

			emitLeaf( finalSection.origin, finalSection.orientation, branch.level );
			emitLeavesAlongFinalBranch( sections, branch.level );

		}

	}

	// ---- back-fill: scale to metres, crown occlusion, sway weight -----------

	// the generator works in the species table's own units (a table ash is
	// about 84 units tall); everything is scaled once, here, so the table stays
	// readable in its own terms
	let maxY = 0;
	for ( let i = 1; i < positions.length; i += 3 ) if ( positions[ i ] > maxY ) maxY = positions[ i ];
	const k = height / maxY;

	for ( let i = 0; i < positions.length; i ++ ) positions[ i ] *= k;
	for ( let i = 0; i < surfs.length; i ++ ) surfs[ i ] *= k;   // metres along/around, and
	// ...then undo it on the leaves, whose two slots are not lengths
	// (done below, where the leaf vertex ranges are known)

	// crown centroid and radius, from the leaf origins
	const crown = new THREE.Vector3();
	for ( const o of leafOrigins ) crown.add( o );
	if ( leafOrigins.length ) crown.multiplyScalar( 1 / leafOrigins.length );
	let crownR = 0;
	for ( const o of leafOrigins ) crownR = Math.max( crownR, o.distanceTo( crown ) );
	crown.multiplyScalar( k );
	crownR = Math.max( crownR * k, 0.001 );

	for ( let li = 0; li < leafOrigins.length; li ++ ) {

		const o = leafOrigins[ li ].multiplyScalar( k );
		const outward = Math.min( 1, o.distanceTo( crown ) / crownR );
		const start = leafVertexStart[ li ];
		for ( let v = start; v < start + 8; v ++ ) {

			surfs[ v * 2 ] /= k;              // per-leaf random, not a length
			surfs[ v * 2 + 1 ] = outward;

		}

	}

	// Sway weight is the whole wind model in one number: how far this vertex
	// travels when the crown leans. Quadratic in height so the bole barely
	// moves, plus a term for branch order so a twig outruns the limb holding
	// it. The phase is *not* here — it arrives per instance, because one
	// geometry stands in for every tree of this variant in the wood.
	for ( let v = 0; v < winds.length / 4; v ++ ) {

		const hFrac = Math.min( 1, Math.max( 0, winds[ v * 4 ] * k / height ) );
		const order = winds[ v * 4 + 1 ];
		winds[ v * 4 ] = hFrac * hFrac * ( 0.26 + order * 0.13 );
		winds[ v * 4 + 1 ] = 0;

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );
	geometry.setAttribute( 'uv', new THREE.Float32BufferAttribute( uvs, 2 ) );
	geometry.setAttribute( 'aWind', new THREE.Float32BufferAttribute( winds, 4 ) );
	geometry.setAttribute( 'aSurf', new THREE.Float32BufferAttribute( surfs, 2 ) );
	geometry.setIndex( indices );
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();

	return {
		geometry,
		triangles: indices.length / 3,
		leaves: leafOrigins.length,
		crown: { x: crown.x, y: crown.y, z: crown.z, r: crownR },
		height,
	};

}
