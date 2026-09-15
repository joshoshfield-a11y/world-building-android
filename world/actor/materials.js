import * as THREE from 'three/webgpu';
import {
	Fn, uniform, texture, varying,
	float, vec2, vec3,
	normalize, dot, mix, max, clamp, pow, smoothstep, step, fract, asin,
	positionGeometry, normalGeometry, positionWorld, normalWorld, cameraPosition, faceDirection,
} from 'three/tsl';

// The clay look, in TSL — the world runs on WebGPURenderer and a GLSL
// `ShaderMaterial` cannot be compiled by it.
//
// Two choices carry the figures into this world:
//
//   * The rig is the *world's*. A fixed three-colour studio ENV is right for
//     a portrait on a flat backdrop and wrong the moment the figure stands on
//     a beach at sunset. So
//     the key is the atmosphere's own sun-path transmittance, the fill is the
//     sky it is standing under, the moon is the same second key the terrain and
//     the wood take after dark, and the whole thing goes through
//     `atmosphere.aerial()` — the character reddens at dusk and turns silver at
//     night for the same reason the island does.
//   * Skinning is three's. A NodeMaterial on a SkinnedMesh gets
//     `<skinning_vertex>` for free, which is why
//     there is no vertex program here at all.
//
// What does *not* change is the face: the SVG atlas is composited into the
// albedo **before** lighting, sampled in the mesh's own bind-pose space. That
// is what makes it read as printed on the head rather than stuck in front of
// it, and it is why `positionGeometry` (the raw attribute, pre-skinning) is
// used rather than anything in world space.

let W = null;

// Called once, before any character is built: the light rig every clay
// material shades against. `rig` is the island's uniform block — the same one
// the palms and the wood read — so nothing here can drift out of sync with it.
export function configure( env ) {

	W = env;

}

export function makeClay( color, opts = {} ) {

	const m = new THREE.MeshBasicNodeMaterial();

	const u = {
		color: uniform( new THREE.Color( color ) ),
		frame: uniform( new THREE.Vector2( 0, 0.5 ) ),
		faceCenter: uniform( new THREE.Vector2() ),
		faceSize: uniform( new THREE.Vector2( 1, 1 ) ),
		half: uniform( new THREE.Vector2( 1, 1 ) ),
		wrap: uniform( 0.45 ),
		fringeY: uniform( 99 ),
		fringe: uniform( 0 ),
		stripe: uniform( new THREE.Color( '#ffffff' ) ),
		stripeFreq: uniform( 3 ),
		stripeMix: uniform( 0 ),
		topDark: uniform( 0 ),
	};

	m.colorNode = Fn( () => {

		const vObj = varying( positionGeometry, 'vObj' );
		const vObjN = varying( normalGeometry, 'vObjN' );

		const base = vec3( u.color ).toVar();

		// stripes are drawn in the shirt's own space, so they do not swim when
		// the bones move — same reason as the face
		if ( opts.stripe ) {

			const band = smoothstep( 0.46, 0.54, fract( vObj.y.mul( u.stripeFreq ) ) );
			base.assign( mix( base, u.stripe, band.mul( u.stripeMix ) ) );

		}

		if ( opts.face ) {

			const nx = clamp( vObj.x.div( u.half.x ), - 1.0, 1.0 ).toVar();
			// flat projection blended with a spherical unwrap, so features near
			// the silhouette compress instead of smearing
			const px = mix( nx, asin( nx ).div( Math.PI / 2 ), u.wrap ).mul( u.half.x );
			const fuv = vec2( px, vObj.y ).sub( u.faceCenter ).div( u.faceSize ).add( 0.5 ).toVar();
			const facing = smoothstep( 0.02, 0.42, vObjN.z );
			// the atlas is 2×2, so a uv off the edge would land in a neighbouring
			// expression rather than off the texture — clamp, then mask
			const inside = step( 0.0, fuv.x ).mul( step( fuv.x, 1.0 ) )
				.mul( step( 0.0, fuv.y ) ).mul( step( fuv.y, 1.0 ) );
			const f = texture( opts.face, clamp( fuv, 0.0, 1.0 ).mul( 0.5 ).add( u.frame ) );
			base.assign( mix( base, f.xyz, f.w.mul( facing ).mul( inside ) ) );

		}

		// soft occlusion under the hairline, and inside the hair shell
		const sh = smoothstep( u.fringeY.sub( 0.10 ), u.fringeY.add( 0.22 ), vObj.y );
		base.mulAssign( mix( float( 1.0 ), float( 0.66 ), sh.mul( u.fringe ) ) );
		base.mulAssign( mix( float( 1.0 ), float( 0.80 ),
			u.topDark.mul( clamp( vObj.y.negate(), 0.0, 1.0 ) ) ) );

		// ---- the world's light, not a studio's
		const N = normalize( normalWorld ).mul( faceDirection ).toVar();
		const V = normalize( cameraPosition.sub( positionWorld ) );
		const L = W.rig.sunDir;

		const lit = W.shadow
			? texture( W.shadow.tex, positionWorld.xz.div( W.worldScale ) ).level( 0 ).x
			: float( 1.0 );

		const sunRad = W.rig.sunColor.mul( W.rig.sunStrength ).toVar();
		const skyRad = W.atmosphere.inscatter( vec3( 0.0, 1.0, 0.0 ) ).mul( W.rig.skyStrength )
			.add( W.rig.moonFill ).toVar();
		const moonRad = W.rig.moonRad.mul( smoothstep( - 0.35, 1.0, dot( N, W.rig.moonDir ) ) );

		// Wrapped diffuse is the whole clay look: light carries a long way round
		// the terminator, so a matte figure has no hard shadow line on it. Keep
		// it — this is the one thing that must survive the change of rig, or the
		// character stops matching the drawing it came from.
		const diff = pow( clamp( dot( N, L ).mul( 0.5 ).add( 0.5 ), 0.0, 1.0 ), 1.4 );
		const hemi = N.y.mul( 0.5 ).add( 0.5 );

		const col = base.mul(
			sunRad.mul( diff.mul( lit ).add( 0.06 ) )
				.add( moonRad )
				.add( skyRad.mul( hemi.mul( 0.55 ).add( 0.45 ) ) ) ).toVar();

		// the rim, taken from whatever is actually behind the figure
		const rim = pow( max( dot( N, V ), 0.0 ).oneMinus(), 3.4 );
		col.addAssign( base.mul( rim ).mul( sunRad.mul( 0.22 ).add( skyRad.mul( 0.55 ) ) ) );

		return W.atmosphere.aerial( col, positionWorld, cameraPosition );

	} )();

	m.u = u;
	return m;

}

// A flat blob under the feet. The island's cast-shadow map is baked from the
// terrain alone and a character cannot write into it, so without this the
// figure hovers: there is nothing anywhere in the frame tying it to the ground
// it is standing on.
export function makeContactShadow() {

	const m = new THREE.MeshBasicNodeMaterial( { transparent: true, depthWrite: false } );
	const alpha = uniform( 0.5 );

	m.colorNode = vec3( 0.0 );
	m.opacityNode = Fn( () => {

		// `xz`, not `xy`: the quad is laid flat by `rotateX` on the geometry, and
		// that bakes into the position attribute — so the plane's own two axes
		// are x and z by the time the shader sees them. Read xy and the blob
		// comes out a stripe.
		// `d` is the radius normalised so the plane's edge is 1.0. The plateau
		// has to be most of that: a blob that is only dark in the middle 25%
		// averages out to a grey smudge, which at seven metres — the distance
		// this is actually seen from — reads as a dirty patch of sand rather
		// than as the figure touching the ground.
		const d = positionGeometry.xz.length().mul( 2.0 );
		return smoothstep( 1.0, 0.45, d ).mul( alpha );

	} )();

	m.u = { alpha };
	return m;

}
