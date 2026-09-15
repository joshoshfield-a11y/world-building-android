// ---------------------------------------------------------------------------
// The house on the island — Villa Ravine.
//
// A complete, real, procedurally modelled two-storey house: walls with
// thickness, genuine openings with piers and sills and reveals, glazing set
// back behind the outer face, expressed slabs and beams, a timber batten
// rain-screen split around every opening, a stair through a double-height
// void, and every room furnished and lit. Its modules live under
// `world/villa/` so the scene stays self-contained, and this file is only the
// *adapter*: siting, orientation, and a light rig wired to the world's own
// day cycle.
//
// The one real seam is lighting. Everything else in this scene is shaded by
// hand in TSL with `MeshBasicNodeMaterial` and reads the atmosphere directly;
// the villa is authored in `MeshStandardMaterial` and expects three's own
// lights. Both can live in one scene — three's lights only reach materials
// that ask for them — so the villa brings a sun and a hemisphere fill of its
// own, driven each frame from the same sun the terrain and the grass read.
// What it cannot bring is an environment map, and that has one consequence
// worth knowing about: metalness with nothing to reflect renders black.
// ---------------------------------------------------------------------------

import * as THREE from 'three/webgpu';

import { buildMaterials } from './villa/materials.js';
import { buildHouse } from './villa/house.js';
import { buildFurniture } from './villa/furniture.js';

const DAY_SKY = new THREE.Color( 0xbcd6f0 );
const DUSK_SKY = new THREE.Color( 0x6b5f6e );
const GROUND_BOUNCE = new THREE.Color( 0x5d5a44 );   // sunlit meadow, not tarmac

export function makeVilla( site, atmosphere, cfg = {} ) {

	const M = buildMaterials();

	// There is no image-based lighting here, so a metal has nothing to reflect
	// and a `metalness: 0.9` surface resolves to black. This scene's sky is a
	// TSL LUT with no CPU-side cube to filter into a PMREM.
	// Bringing the metals down to where the hemisphere fill can still describe
	// them is the honest fix — a dark steel window frame is what these are
	// meant to be anyway.
	for ( const k of [ 'steelDark', 'steelBlack', 'brass', 'alu', 'mirror' ] )
		if ( M[ k ] ) M[ k ].metalness = Math.min( M[ k ].metalness, 0.28 );

	// ...and glass with no reflection is just a dim window, so it leans on its
	// own tint instead of on `envMapIntensity`.
	M.glass.opacity = 0.34;
	M.glass.color.setHex( 0xcbdfe4 );

	const house = buildHouse( M );
	const store = house.userData;
	const furniture = buildFurniture( M, store );

	const group = new THREE.Group();
	group.name = 'villa';
	group.add( house, furniture );

	// The site's `rot` is the world direction the front should face, and the
	// villa's front — the glazed south elevation onto the terrace — is its
	// local +z. A rotation of θ about Y sends +z to (sin θ, 0, cos θ), so
	// θ = π/2 − rot.
	// The model is authored for a 1.7 m person. Everything below that has a size
	// in metres —
	// the shadow box, the sun's stand-off, the hemisphere's height — is written
	// against that scale, so it all multiplies by the same number.
	const S = cfg.scale ?? 1;

	group.position.set( site.x, site.y, site.z );
	group.rotation.y = Math.PI / 2 - site.rot;
	group.scale.setScalar( S );

	let triangles = 0, parts = 0;

	group.traverse( ( o ) => {

		if ( ! o.isMesh ) return;
		parts ++;

		// The model already carries its own shadow flags, deliberately — some
		// meshes are marked *not* to cast — so they are left alone. The one
		// blanket rule is that transparent things do not cast: a fully glazed
		// south elevation throwing a solid shadow across its own floor is the
		// kind of thing that only shows up once the sun is on it.
		if ( o.material && o.material.transparent ) o.castShadow = false;

		const g = o.geometry;
		const n = ( g.index ? g.index.count : g.attributes.position.count ) / 3;
		triangles += n * ( o.isInstancedMesh ? o.count : 1 );

	} );

	// ---- the light rig
	//
	// One directional sun and one hemisphere fill, both parked on the villa.
	// The shadow camera is a 48 m box around the building rather than anything
	// scene-wide: the only things in this scene that cast into a shadow map are
	// the villa's own meshes (everything else is `castShadow: false`, and the
	// terrain and grass read a separate TSL shadow texture), so a tight box
	// spends its whole resolution on the one object that needs it.
	const sun = new THREE.DirectionalLight( 0xffffff, 3 );
	sun.castShadow = true;
	sun.shadow.mapSize.set( 2048, 2048 );

	const sc = sun.shadow.camera;
	sc.left = - 24 * S; sc.right = 24 * S; sc.top = 24 * S; sc.bottom = - 24 * S;
	sc.near = 1; sc.far = 170 * S;
	sc.updateProjectionMatrix();
	// ...and a box that has grown spends the same 2048 texels over more ground,
	// so the depth offsets that stopped it self-shadowing have to grow with it.
	sun.shadow.bias = - 0.0006 * S;
	sun.shadow.normalBias = 0.05 * S;

	sun.target.position.set( site.x, site.y + 3 * S, site.z );

	const hemi = new THREE.HemisphereLight( DAY_SKY.getHex(), GROUND_BOUNCE.getHex(), 0.6 );
	hemi.position.set( site.x, site.y + 10 * S, site.z );

	const lights = new THREE.Group();
	lights.name = 'villa-lights';
	lights.add( sun, sun.target, hemi );

	const SHADOW_RANGE = ( cfg.shadowRange ?? 150 ) * S;
	const centre = new THREE.Vector3( site.x, site.y + 3 * S, site.z );
	const warm = new THREE.Color( 0xfff2e2 );

	// Interior fixtures double as bounce fill by day and become lamplight after
	// dark — the thing that makes a
	// glazed house read as lived in from outside at dusk.
	function setTime( sunDir, sunColor, sunLevel, dayF, moonF ) {

		sun.position.set(
			centre.x + sunDir.x * 80 * S,
			centre.y + Math.max( 0.04, sunDir.y ) * 80 * S,
			centre.z + sunDir.z * 80 * S );
		sun.color.copy( sunColor );
		sun.intensity = 3.8 * Math.max( 0, sunLevel );

		hemi.color.copy( DUSK_SKY ).lerp( DAY_SKY, dayF );
		hemi.intensity = 0.10 + 0.62 * dayF + 0.14 * moonF * ( 1 - dayF );

		const interior = 1 - dayF;

		for ( const o of store.lights ) {

			if ( ! o.warm ) o.warm = o.light.color.clone();

			if ( o.kind === 'exterior' ) o.light.intensity = o.base * Math.max( 0, interior * 1.2 - 0.15 );
			else if ( o.kind === 'fire' ) o.light.intensity = o.base * ( 0.35 + 0.65 * interior );
			else {

				o.light.intensity = o.base * ( 0.30 + 0.70 * interior ) * ( 1 - dayF * 0.35 );
				o.light.color.copy( o.warm ).lerp( warm, dayF * 0.6 );

			}

		}

		for ( const m of store.emissives )
			m.material.emissiveIntensity =
				( m.material === M.lampWarm ? 1.1 : 0.32 ) * ( 0.06 + interior * 1.5 );

	}

	// A shadow map that nothing is close enough to see is 6 000 draw calls a
	// frame for nothing, so it switches off past `shadowRange`.
	function update( cameraPosition ) {

		sun.castShadow = cameraPosition.distanceToSquared( centre ) < SHADOW_RANGE * SHADOW_RANGE;

	}

	return { group, lights, setTime, update, store, triangles, parts };

}
