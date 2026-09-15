import * as THREE from 'three/webgpu';

// The house as a place you can be *in*, rather than a picture of one.
//
// Until this existed the player walked through the villa's walls and stood on
// the terrain under its floor — the building was scenery that happened to be in
// the way of nothing. Three things had to be true to fix that, and they are one
// problem rather than three: you cannot pass through it, you can stand on the
// parts of it that are floors, and the parts that open, open.
//
// **The collision is derived, not authored.** The villa is 1 600 meshes
// that this folder did not draw and should not have to
// re-describe; a hand-written box list would be a second copy of the building
// that goes stale the moment the model changes. So the boxes *are* the
// building: one box per mesh, binned into a grid.
//
// **The boxes have to be oriented.** The house is sited facing the view, which
// puts its whole model 247° off the world axes — and measured against that,
// 1 572 of its 1 603 meshes have an axis-aligned bounding box more than 1.4×
// their true volume, half of them more than 3×. Axis-aligned collision on this
// model is not a rough fit, it is a different building: the stair's two 8.3 m
// stringers alone become a solid 8 × 3.4 m slab covering the entire flight, so
// the stair cannot be climbed at all. Each box therefore keeps its own
// horizontal axis and is tested in its own frame — exact for anything the model
// rotates about Y, which is all of it but the roof slopes, and a tight
// footprint for those.
//
// **A floor is a box top you can reach.** There is no separate notion of storey.
// Standing is "the highest box top under me that is no more than a step above my
// feet", and that one rule gives the deck, the treads of the stair, the upper
// slab and the roof terrace without any of them being special-cased — and gives
// the underside of the house for free, because from below every one of those
// tops is far more than a step away and the terrain wins.

// Metres of rise taken without jumping. It has to clear the villa's 0.35 m
// treads and stay under 2 of them, or the figure takes the flight two steps at
// a time from wherever a toe happens to reach.
const STEP_UP = 0.55;
const CELL = 3.0;        // grid bin, metres
const MIN_PART = 0.30;   // ignore anything whose longest side is under this

// Meshes the player should not be stopped by. The *building* is solid — walls,
// glazing, slabs, stair, structure — and the furniture is not, which is a line
// drawn on measurement rather than on taste. With the furnishings in, a flood
// fill of the whole house from the entry pad never reaches the stair at all:
// the ground-floor route to it closes, and a planter at the head of the flight
// closes the top as well. Walking through a sofa is a small lie. A house you
// cannot go upstairs in is a bigger one.
const SKIP_GROUPS = new Set( [ 'furnishings', 'furnishings-upper', 'roofTerraceFurniture' ] );

// The openings, in the order they are offered. Hinged doors carry a `pivot`
// they swing about, curtain walls a `slider` they run along — both are the
// model's own, so nothing here has to know how a door is built.
const DOORS = [
	{ tag: 'frontDoor', label: 'front door' },
	{ tag: 'slideA', label: 'terrace doors' },
	{ tag: 'slideB', label: 'west doors' },
	{ tag: 'powderDoor', label: 'door' },
	{ tag: 'roofDoor', label: 'roof door' },
];

const OPEN_TIME = 0.55;  // seconds a leaf takes to swing or run
const SWING = - 1.35;    // radians a hinged leaf opens through

// One box is eight numbers: centre in world xz, its own horizontal axis, the
// half-extents along that axis and across it, and the two heights.
const STRIDE = 8;
const CX = 0, CZ = 1, AX = 2, AZ = 3, HU = 4, HV = 5, Y0 = 6, Y1 = 7;

export function makeIndoors( villa, { reach = 4.5 } = {} ) {

	const _b = new THREE.Box3();
	const _v = new THREE.Vector3();
	const boxes = [];        // STRIDE numbers per entry
	const owner = [];        // index into `doors`, or -1
	const flat = [];         // is the top level enough to stand on?

	// ---- the doors first, so a mesh can be recognised as part of one ----------

	const doors = [];

	for ( const d of DOORS ) {

		const unit = villa.store.tagged[ d.tag ];
		if ( ! unit ) continue;

		const moving = unit.userData.pivot || unit.userData.slider;
		if ( ! moving ) continue;

		unit.updateWorldMatrix( true, true );

		// Where the *opening* is, which is not where the assembly's bounding box
		// is. A hinged unit is built about the centre of its reveal, so its own
		// origin is the gap; a curtain wall is built from one end and only one
		// of its bays slides, so the gap is wherever that leaf happens to be.
		// Taking the bbox centre instead put the front door's prompt 1 m into
		// the wall beside it and the terrace doors' several metres away.
		const anchor = new THREE.Vector3();
		( unit.userData.pivot ? unit : moving ).getWorldPosition( anchor );

		doors.push( {
			tag: d.tag,
			label: d.label,
			unit,
			moving,
			anchor,
			hinged: !! unit.userData.pivot,
			// The model builds a curtain wall with its panels already spaced
			// for a slide; `slideRange` is how far the leaf may run.
			range: unit.userData.slideRange ?? 0,
			rest: moving.position.x,
			open: false,
			t: 0,             // 0 shut, 1 open
		} );

	}

	const doorOf = new Map();   // mesh → door index, for the moving parts only

	doors.forEach( ( door, i ) => {

		door.moving.traverse( ( o ) => {

			if ( o.isMesh ) doorOf.set( o, i );

		} );

	} );

	// ---- and then every solid in the building --------------------------------

	villa.group.updateWorldMatrix( true, true );

	// The part's own X axis, flattened, is the box's horizontal axis: the model
	// is built axis-aligned and then placed, so a part's local frame *is* the
	// frame it is a tidy box in. A part rotated so that its X points straight up
	// has no flattened X to use, so its Z stands in, and world x for the pair
	// that manages neither.
	function axisOf( m, out ) {

		const e = m.elements;
		let ax = e[ 0 ], az = e[ 2 ];
		let n = Math.hypot( ax, az );

		if ( n < 1e-5 ) { ax = e[ 8 ]; az = e[ 10 ]; n = Math.hypot( ax, az ); }
		if ( n < 1e-5 ) { ax = 1; az = 0; n = 1; }

		out.set( ax / n, 0, az / n );
		return out;

	}

	// A sloped part — a stair stringer, a raking balustrade, a roof plane — has a
	// vertical extent that is almost all *slope* and almost none of it thickness.
	// Taken as one box it becomes a wall as tall as the flight is high: the
	// villa's stringer is a 34 cm edge beam, and as a single box it fenced the
	// whole stair off from the room it starts in, floor to ceiling. So a sloped
	// part is cut into segments along whichever of its own axes climbs, and each
	// segment carries only the height it actually occupies — which at the foot of
	// a flight is a few centimetres, and steppable, as it should be.
	const RISE_PER_SEG = 0.45;
	const MAX_SEG = 16;

	const _axis = new THREE.Vector3();
	const _m = new THREE.Matrix4();
	const _im = new THREE.Matrix4();

	function emit( x0, y0, z0, x1, y1, z1, m, o, isFlat, sized ) {

		const a = axisOf( m, _axis );
		let u0 = Infinity, u1 = - Infinity, v0 = Infinity, v1 = - Infinity;
		let wy0 = Infinity, wy1 = - Infinity;

		for ( let c = 0; c < 8; c ++ ) {

			_v.set( c & 1 ? x1 : x0, c & 2 ? y1 : y0, c & 4 ? z1 : z0 ).applyMatrix4( m );

			const u = _v.x * a.x + _v.z * a.z;
			const v = _v.z * a.x - _v.x * a.z;
			if ( u < u0 ) u0 = u;
			if ( u > u1 ) u1 = u;
			if ( v < v0 ) v0 = v;
			if ( v > v1 ) v1 = v;
			if ( _v.y < wy0 ) wy0 = _v.y;
			if ( _v.y > wy1 ) wy1 = _v.y;

		}

		const hu = ( u1 - u0 ) / 2, hv = ( v1 - v0 ) / 2;
		if ( sized && Math.max( hu * 2, hv * 2, wy1 - wy0 ) < MIN_PART ) return;

		const uc = ( u0 + u1 ) / 2, vc = ( v0 + v1 ) / 2;
		boxes.push( uc * a.x - vc * a.z, uc * a.z + vc * a.x, a.x, a.z, hu, hv, wy0, wy1 );
		owner.push( doorOf.has( o ) ? doorOf.get( o ) : - 1 );
		flat.push( isFlat ? 1 : 0 );

	}

	// One placement of one geometry: `m` is the world matrix it sits at, which is
	// the mesh's own for an ordinary mesh and the mesh's times the instance's for
	// an instanced one.
	function addBox( lb, m, o ) {

		const e = m.elements;
		const un = Math.hypot( e[ 4 ], e[ 5 ], e[ 6 ] );
		const isFlat = un > 1e-6 && Math.abs( e[ 5 ] ) / un > 0.999;

		if ( isFlat ) { emit( lb.min.x, lb.min.y, lb.min.z, lb.max.x, lb.max.y, lb.max.z, m, o, true, true ); return; }

		// How much of the world-space height is slope rather than the part's own
		// depth? Each horizontal axis contributes its own extent times how far
		// that axis tips out of level; the steeper one is the axis to cut along.
		const cx = _axis.set( 1, 0, 0 ).transformDirection( m ).y * ( lb.max.x - lb.min.x );
		const cz = _axis.set( 0, 0, 1 ).transformDirection( m ).y * ( lb.max.z - lb.min.z );
		const climb = Math.max( Math.abs( cx ), Math.abs( cz ) ) * m.getMaxScaleOnAxis();

		if ( climb < RISE_PER_SEG ) { emit( lb.min.x, lb.min.y, lb.min.z, lb.max.x, lb.max.y, lb.max.z, m, o, false, true ); return; }

		const n = Math.min( MAX_SEG, Math.ceil( climb / RISE_PER_SEG ) );
		const alongX = Math.abs( cx ) >= Math.abs( cz );
		const a0 = alongX ? lb.min.x : lb.min.z, a1 = alongX ? lb.max.x : lb.max.z;

		for ( let i = 0; i < n; i ++ ) {

			const s0 = a0 + ( a1 - a0 ) * i / n, s1 = a0 + ( a1 - a0 ) * ( i + 1 ) / n;
			if ( alongX ) emit( s0, lb.min.y, lb.min.z, s1, lb.max.y, lb.max.z, m, o, false, false );
			else emit( lb.min.x, lb.min.y, s0, lb.max.x, lb.max.y, s1, m, o, false, false );

		}

	}

	function push( o ) {

		if ( ! o.geometry.boundingBox ) o.geometry.computeBoundingBox();
		const lb = o.geometry.boundingBox;
		if ( ! lb ) return;

		// An instanced mesh is many placements behind one matrix. Taking the
		// union of them — which is what a bounding box of the object is — turned
		// the upper storey's batten rain-screen into one solid 10 × 24 m block
		// filling the whole floor it clads.
		if ( o.isInstancedMesh ) {

			for ( let i = 0; i < o.count; i ++ ) {

				o.getMatrixAt( i, _im );
				addBox( lb, _m.multiplyMatrices( o.matrixWorld, _im ), o );

			}

			return;

		}

		addBox( lb, o.matrixWorld, o );

	}

	( function collect( node, skipped ) {

		const skip = skipped || SKIP_GROUPS.has( node.name );
		if ( node.isMesh && ! skip ) push( node );
		for ( const c of node.children ) collect( c, skip );

	} )( villa.group, false );

	const count = owner.length;
	const B = new Float32Array( boxes );
	const O = new Int16Array( owner );
	const F = new Uint8Array( flat );

	// ---- the grid ------------------------------------------------------------
	//
	// A flat scan of 1 600 boxes per query would be 1 600 comparisons several
	// times a frame, which is affordable and still the wrong shape: it makes the
	// cost of the house's *detail* the cost of walking near it. Binning by xz
	// makes a query proportional to what is actually underfoot.

	const grid = new Map();
	const key = ( cx, cz ) => cx * 73856093 ^ cz * 19349663;

	// the world-axis half-extents of an oriented box — exactly the rotated
	// rectangle's own bounding box, used for binning and for the cheap reject
	const spanX = ( o ) => Math.abs( B[ o + AX ] ) * B[ o + HU ] + Math.abs( B[ o + AZ ] ) * B[ o + HV ];
	const spanZ = ( o ) => Math.abs( B[ o + AZ ] ) * B[ o + HU ] + Math.abs( B[ o + AX ] ) * B[ o + HV ];

	for ( let i = 0; i < count; i ++ ) {

		const o = i * STRIDE;
		const ex = spanX( o ), ez = spanZ( o );
		const x0 = Math.floor( ( B[ o + CX ] - ex ) / CELL ), x1 = Math.floor( ( B[ o + CX ] + ex ) / CELL );
		const z0 = Math.floor( ( B[ o + CZ ] - ez ) / CELL ), z1 = Math.floor( ( B[ o + CZ ] + ez ) / CELL );

		for ( let cx = x0; cx <= x1; cx ++ ) {

			for ( let cz = z0; cz <= z1; cz ++ ) {

				const k = key( cx, cz );
				let list = grid.get( k );
				if ( ! list ) grid.set( k, list = [] );
				list.push( i );

			}

		}

	}

	// the whole building's footprint, so a player nowhere near it pays nothing
	const bounds = new THREE.Box3().setFromObject( villa.group );
	bounds.expandByScalar( 2 );

	// ---- queries -------------------------------------------------------------

	// Every query walks the same cells; `visit` is the one place that knows how.
	function visit( x, z, r, fn ) {

		const x0 = Math.floor( ( x - r ) / CELL ), x1 = Math.floor( ( x + r ) / CELL );
		const z0 = Math.floor( ( z - r ) / CELL ), z1 = Math.floor( ( z + r ) / CELL );

		for ( let cx = x0; cx <= x1; cx ++ ) {

			for ( let cz = z0; cz <= z1; cz ++ ) {

				const list = grid.get( key( cx, cz ) );
				if ( ! list ) continue;

				for ( let n = 0; n < list.length; n ++ ) {

					const i = list[ n ];
					// an open leaf is not there — see the note on `update`
					if ( O[ i ] >= 0 && doors[ O[ i ] ].t > 0.35 ) continue;
					if ( fn( i * STRIDE, i ) === false ) return false;

				}

			}

		}

		return true;

	}

	// Is (x, z) within `r` of the box's footprint? Measured in the box's own
	// frame, where the footprint is an ordinary rectangle. The radius becomes a
	// square rather than a circle, which over-reaches by at most 41% of it at
	// the corners and is not worth a square root per box per query.
	function overlaps( o, x, z, r ) {

		const dx = x - B[ o + CX ], dz = z - B[ o + CZ ];
		const du = dx * B[ o + AX ] + dz * B[ o + AZ ];
		if ( du > B[ o + HU ] + r || du < - B[ o + HU ] - r ) return false;
		const dv = dz * B[ o + AX ] - dx * B[ o + AZ ];
		return dv <= B[ o + HV ] + r && dv >= - B[ o + HV ] - r;

	}

	const near = ( x, z ) => x >= bounds.min.x && x <= bounds.max.x
		&& z >= bounds.min.z && z <= bounds.max.z;

	// The surface to stand on, or -Infinity where the building offers none.
	// `feetY` is where the player is now: a box top more than a step above that
	// is a thing to walk into, not a thing to stand on, and one below the feet is
	// only a floor if nothing higher qualifies. Sloped parts — the roof planes —
	// are not offered at all: their top is one high corner, and standing on the
	// corner of a pitched roof is not a thing this asks of anybody.
	function floorAt( x, z, feetY, r = 0.25 ) {

		if ( ! near( x, z ) ) return - Infinity;

		let best = - Infinity;
		const ceiling = feetY + STEP_UP;

		visit( x, z, r, ( o, i ) => {

			const top = B[ o + Y1 ];
			if ( top > ceiling || top <= best || ! F[ i ] ) return;
			if ( overlaps( o, x, z, r ) ) best = top;

		} );

		return best;

	}

	// Can a cylinder of radius `r` standing with its feet at `feetY` occupy
	// (x, z)? A box is only in the way if it reaches above the step the player
	// can take *and* starts below their head — otherwise it is a floor or a
	// lintel and they pass over or under it.
	function blocked( x, z, feetY, r, height ) {

		if ( ! near( x, z ) ) return false;

		const low = feetY + STEP_UP;
		const high = feetY + height;

		return ! visit( x, z, r, ( o ) => {

			if ( B[ o + Y1 ] <= low || B[ o + Y0 ] >= high ) return;
			if ( overlaps( o, x, z, r ) ) return false;

		} );

	}

	// Is a point inside the building's fabric? Used by the camera, which needs a
	// point test rather than a cylinder one: an orbit rig indoors has to stop at
	// the wall behind the player instead of sitting outside it filming plaster.
	function solidAt( x, y, z, pad = 0.0 ) {

		if ( ! near( x, z ) ) return false;

		return ! visit( x, z, pad, ( o ) => {

			if ( y < B[ o + Y0 ] - pad || y > B[ o + Y1 ] + pad ) return;
			if ( overlaps( o, x, z, pad ) ) return false;

		} );

	}

	// ---- doors ---------------------------------------------------------------

	const _d = new THREE.Vector3();

	function nearestDoor( pos ) {

		let best = null, bestD = reach * reach;

		for ( const d of doors ) {

			const dd = _d.copy( d.anchor ).sub( pos ).lengthSq();
			if ( dd < bestD ) { bestD = dd; best = d; }

		}

		return best;

	}

	function toggle( door ) {

		if ( ! door ) return null;
		door.open = ! door.open;
		return door;

	}

	// A leaf that is *moving* is neither open nor shut, and the collision has to
	// pick one. It picks open, at a third of the way: a door you have asked to
	// open should not shove you back out of the opening for the half second it
	// takes to swing, and one you have asked to close should let you step clear.
	function update( dt ) {

		for ( const d of doors ) {

			const want = d.open ? 1 : 0;
			if ( d.t === want ) continue;

			const step = dt / OPEN_TIME;
			d.t = want > d.t ? Math.min( want, d.t + step ) : Math.max( want, d.t - step );

			// ease, so a door does not arrive at the stop at full speed
			const e = d.t * d.t * ( 3 - 2 * d.t );

			if ( d.hinged ) d.moving.rotation.y = SWING * e;
			else d.moving.position.x = d.rest + d.range * e;

		}

	}

	return { floorAt, blocked, solidAt, nearestDoor, toggle, update, doors, count, bounds, STEP_UP };

}
