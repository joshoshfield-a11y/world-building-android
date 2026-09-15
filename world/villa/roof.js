// ---------------------------------------------------------------------------
// Hipped roof — the element that decides what kind of building this is.
//
// A flat-slab, parapet-edged modernist box is a perfectly good house and the
// wrong one for a wet volcanic island: the whole
// tropical vernacular, from a Balinese pavilion to a Queenslander to a plantation
// house, is a broad low-pitched roof with eaves deep enough to keep the sun off
// the glass and the rain off the verandah, carried well past the walls. That
// roof changes the typology in one move; everything the
// model does well — real openings, expressed structure, furnished rooms
// — is untouched underneath it.
//
// Geometry: one outline rectangle and one pitch. Equal pitch on all four planes
// puts the ridge inset from each end by half the plan depth, so the plan decides
// the ridge length rather than the ridge being authored — a nearly square plan
// gives a nearly pyramidal roof, which is what it should give. Faking a longer
// ridge means steepening the hip ends, and a roof whose ends do not match its
// sides is the thing that reads as a game asset.
//
// The build is a solid, not a surface: top planes, the same planes dropped by
// the roof thickness as a boarded soffit, and a fascia band closing the eave.
// The soffit is the part you actually see from underneath a deep overhang, and
// leaving it open — or worse, leaving the top plane single-sided — is what makes
// a roof look like a sheet of paper laid on a house.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const V = ( x, y, z ) => new THREE.Vector3( x, y, z );

// One planar polygon, fanned from vertex 0, with UVs measured in metres in the
// polygon's own plane — so a board texture keeps its width whatever the slope.
function face( out, pts, tile, flip ) {

	const n = new THREE.Vector3().subVectors( pts[ 1 ], pts[ 0 ] )
		.cross( new THREE.Vector3().subVectors( pts[ 2 ], pts[ 0 ] ) ).normalize();
	if ( flip ) n.negate();

	// in-plane basis: u runs up the slope (steepest ascent), v across it
	const up = Math.abs( n.y ) > 0.999 ? V( 1, 0, 0 ) : V( 0, 1, 0 );
	const vAxis = new THREE.Vector3().crossVectors( n, up ).normalize();
	const uAxis = new THREE.Vector3().crossVectors( vAxis, n ).normalize();

	const base = out.pos.length / 3;

	for ( const p of pts ) {

		out.pos.push( p.x, p.y, p.z );
		out.nrm.push( n.x, n.y, n.z );
		out.uv.push( p.dot( uAxis ) / tile, p.dot( vAxis ) / tile );

	}

	for ( let i = 1; i < pts.length - 1; i ++ ) {

		if ( flip ) out.idx.push( base, base + i + 1, base + i );
		else out.idx.push( base, base + i, base + i + 1 );

	}

}

function mesh( out, mat ) {

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( out.pos, 3 ) );
	g.setAttribute( 'normal', new THREE.Float32BufferAttribute( out.nrm, 3 ) );
	g.setAttribute( 'uv', new THREE.Float32BufferAttribute( out.uv, 2 ) );
	g.setIndex( out.idx );
	const m = new THREE.Mesh( g, mat );
	m.castShadow = true;
	m.receiveShadow = true;
	return m;

}

const bag = () => ( { pos: [], nrm: [], uv: [], idx: [] } );

/**
 * @param x0,x1,z0,z1  the eave outline in plan (already including overhangs)
 * @param eaveY        underside of the eave — the roof sits above this
 * @param pitch        radians
 * @param thickness    roof build-up depth, seen at the fascia
 */
export function hipRoof( { x0, x1, z0, z1, eaveY, pitch = 0.35, thickness = 0.34,
	matTop, matSoffit, matFascia, matRidge, tileTop = 0.42, tileSoffit = 0.30 } ) {

	const g = new THREE.Group();
	g.name = 'hip-roof';

	const d = z1 - z0, zc = ( z0 + z1 ) / 2, xc = ( x0 + x1 ) / 2;
	const rise = ( d / 2 ) * Math.tan( pitch );
	const top = eaveY + thickness + rise;
	const eave = eaveY + thickness;

	// equal pitch ⇒ the hip runs in at 45° in plan, so the ridge is inset by
	// half the depth. On a plan deeper than it is wide that collapses to a point,
	// which is a pyramid roof and perfectly legitimate.
	const ra = Math.min( x0 + d / 2, xc ), rb = Math.max( x1 - d / 2, xc );

	const eNW = V( x0, eave, z0 ), eNE = V( x1, eave, z0 );
	const eSE = V( x1, eave, z1 ), eSW = V( x0, eave, z1 );
	const rA = V( ra, top, zc ), rB = V( rb, top, zc );

	const planes = [
		[ eNE, eNW, rA, rB ],   // north slope
		[ eSW, eSE, rB, rA ],   // south slope
		[ eNW, eSW, rA ],       // west hip
		[ eSE, eNE, rB ],       // east hip
	];

	const t = bag();
	for ( const p of planes ) face( t, p, tileTop, false );
	g.add( mesh( t, matTop ) );

	// the soffit is the same roof dropped by its own thickness, seen from below
	const s = bag();
	const drop = ( p ) => p.map( ( q ) => V( q.x, q.y - thickness, q.z ) );
	for ( const p of planes ) face( s, drop( p ), tileSoffit, true );
	g.add( mesh( s, matSoffit ) );

	// fascia: the vertical band that closes the eave. Without it you see the
	// paper edge of a zero-thickness plane from every low angle, which is most
	// of them when the eave is three metres over your head.
	const f = bag();
	const band = [ [ eNW, eNE ], [ eNE, eSE ], [ eSE, eSW ], [ eSW, eNW ] ];
	for ( const [ a, b ] of band ) {

		face( f, [ V( a.x, a.y - thickness, a.z ), V( b.x, b.y - thickness, b.z ),
			V( b.x, b.y, b.z ), V( a.x, a.y, a.z ) ], 0.5, false );

	}

	g.add( mesh( f, matFascia ) );

	// ridge cap
	if ( rb - ra > 0.05 ) {

		const cap = new THREE.Mesh( new THREE.BoxGeometry( rb - ra + 0.5, 0.10, 0.34 ), matRidge || matFascia );
		cap.position.set( ( ra + rb ) / 2, top + 0.05, zc );
		cap.castShadow = true;
		g.add( cap );

	}

	return g;

}
