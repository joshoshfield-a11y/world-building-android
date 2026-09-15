// Herring gulls — procedural, no models, no textures, no CPU work per frame.
//
// Same shape as the palms: every gull is baked into ONE merged geometry and the
// whole flock is a single static draw, because a custom `positionNode` on an
// InstancedMesh would discard the instance transform (three applies instancing
// to `positionLocal`, then lets `positionNode` overwrite it). Per-vertex
// attributes carry the flight: which bird this vertex belongs to, where its
// circle is, how fast it goes round, and where on a wing the vertex sits. The
// vertex stage does the rest from one clock, so the flock costs nothing but the
// draw.
//
// Three things separate a gull from a flapping paper dart, and none of them are
// the model:
//
//   * **Gulls glide.** A bird that beats its wings continuously reads as a
//     pigeon in a hurry. The beat comes in bursts of a few seconds with long
//     stiff-winged glides between them, and the glide is the default.
//   * **The wing is a travelling wave, not a hinge.** `sin(ωt − k·span)` — the
//     tip lags the shoulder by most of a radian, so the wing rolls the beat
//     outwards and the tip traces a flattened figure of eight. Rotate the whole
//     wing rigidly and it reads as a toy however good the silhouette is.
//   * **They bank into the turn.** Lift acts along the bird's own up, so a bird
//     on a circle rolls until that vector tilts toward the centre. Fly a turn
//     wings-level and the eye reads it as a sprite on rails immediately.
//
// The wing planform does the rest: swept leading edge, pointed tip, chord down
// to a fifth of the root — plus the black outer primaries, which is the one
// marking that says *gull* at any distance where the bird is more than a speck.

import * as THREE from 'three/webgpu';
import {
	Fn, attribute, varying, texture,
	float, vec3,
	normalize, cross, dot, mix, smoothstep, max, abs, clamp, sign, sin, cos, pow,
	positionGeometry, normalGeometry, positionWorld, cameraPosition,
} from 'three/tsl';

// local frame: +x right wing, +y up, +z forward. Span runs to ±1, so a scale of
// 0.62 is a 1.24 m wingspan — a herring gull.
const SPAN_STATIONS = 7;

function appendGull( g, out ) {

	const { positions, normals, shapes, orbits, flights, drifts, indices } = out;

	const vert = ( px, py, pz, nx, ny, nz, side, span, part ) => {

		positions.push( px, py, pz );
		normals.push( nx, ny, nz );
		shapes.push( side, span, part );
		orbits.push( g.cx, g.cz, g.radius, g.alt );
		flights.push( g.omega, g.phase, g.flapOff, g.scale );
		drifts.push( g.driftR, g.driftW, g.driftP, g.bob );
		return positions.length / 3 - 1;

	};

	// ---- body: a spindle, head forward, tail root aft
	const RINGS = [
		// u,     z,      r
		[ 0.00, - 0.34, 0.010 ],
		[ 0.14, - 0.26, 0.038 ],
		[ 0.32, - 0.14, 0.064 ],
		[ 0.50, - 0.02, 0.074 ],
		[ 0.66, 0.09, 0.068 ],
		[ 0.80, 0.18, 0.050 ],
		[ 0.91, 0.25, 0.038 ],
		[ 1.00, 0.32, 0.012 ],
	];
	const SIDES = 7;
	const ringStart = [];

	for ( const [ , z, r ] of RINGS ) {

		const base = positions.length / 3;
		ringStart.push( base );

		for ( let s = 0; s < SIDES; s ++ ) {

			const a = ( s / SIDES ) * Math.PI * 2;
			const cx = Math.cos( a ), sy = Math.sin( a );
			// a gull's body is wider than it is deep, and it sits a touch below
			// the wing root so the wings read as coming off the top of it
			vert( cx * r * 1.15, sy * r * 0.86 - 0.012, z, cx, sy, 0.0, 0.0, 0.0, 0.0 );

		}

	}

	for ( let i = 0; i < RINGS.length - 1; i ++ ) {

		const a = ringStart[ i ], b = ringStart[ i + 1 ];

		for ( let s = 0; s < SIDES; s ++ ) {

			const s2 = ( s + 1 ) % SIDES;
			indices.push( a + s, b + s, a + s2, a + s2, b + s, b + s2 );

		}

	}

	// ---- wings: a quad strip per side, swept and tapered to a point
	for ( const side of [ - 1, 1 ] ) {

		const le = [], te = [];

		for ( let i = 0; i < SPAN_STATIONS; i ++ ) {

			const t = i / ( SPAN_STATIONS - 1 );
			const x = side * ( 0.055 + 0.945 * Math.pow( t, 0.98 ) );
			const leZ = 0.115 - 0.30 * Math.pow( t, 1.35 );
			const chord = 0.245 * ( 1 - 0.80 * Math.pow( t, 1.25 ) );
			// the shoulder sits a little above the body's centreline
			const y = 0.026 * ( 1 - t );

			le.push( vert( x, y, leZ, 0, 1, 0, side, t, 1.0 ) );
			te.push( vert( x, y, leZ - chord, 0, 1, 0, side, t, 1.0 ) );

		}

		for ( let i = 0; i < SPAN_STATIONS - 1; i ++ ) {

			if ( side > 0 ) indices.push( le[ i ], te[ i ], le[ i + 1 ], le[ i + 1 ], te[ i ], te[ i + 1 ] );
			else indices.push( le[ i ], le[ i + 1 ], te[ i ], te[ i ], le[ i + 1 ], te[ i + 1 ] );

		}

	}

	// ---- tail: a short fan behind the body
	const tRoot = vert( 0, - 0.006, - 0.28, 0, 1, 0, 0, 0, 2.0 );
	const tL = vert( - 0.085, - 0.006, - 0.53, 0, 1, 0, 0, 0, 2.0 );
	const tR = vert( 0.085, - 0.006, - 0.53, 0, 1, 0, 0, 0, 2.0 );
	const tM = vert( 0, - 0.006, - 0.56, 0, 1, 0, 0, 0, 2.0 );
	indices.push( tRoot, tL, tM, tRoot, tM, tR );

}

/**
 * @param terrain  the island bake — used to scatter the flock along the coast
 * @param rig      the terrain material's light uniforms (sun, sky, moon fill)
 * @param opening  { eye, dir } — where the opening camera stands and which way
 *                 it looks (xz, normalised). Some of the flock is flown into
 *                 that view on purpose (see below). It is the *camera* and not
 *                 the player: the shot orbits from 46 m back, so a group placed
 *                 forty metres from the player is ninety from the lens, which
 *                 is the difference between a bird and a speck.
 * @param cfg      { count, groups }
 */
export function makeGulls( terrain, rig, atmosphere, shadow, land, opening, cfg ) {

	const eye = opening.eye;
	const view = Math.atan2( opening.dir.y, opening.dir.x );

	const srgb = ( r, g, b ) => {

		const c = new THREE.Color().setRGB( r, g, b, THREE.SRGBColorSpace );
		return vec3( c.r, c.g, c.b );

	};

	let seed = 20260818;
	const rand = () => ( seed = ( seed * 48271 ) % 2147483647 ) / 2147483647;
	const rng = ( a, b ) => a + rand() * ( b - a );

	// ---- scatter: gulls work the surf line, so the circles are centred on it.
	// Rejection sampling on the bake's own shore distance rather than on a
	// radius, for the same reason everything else on this coast is: the shore is
	// fractal, and a ring of birds round the island's centroid would sit over the
	// ridge on one side and half a kilometre out to sea on the other.
	//
	// **Two groups are flown into the opening shot deliberately.** Scattered
	// evenly, nine circles over four kilometres of coast leave a ~250 m gap, and
	// a 1.3 m bird at 250 m is two pixels: the beach you actually stand on comes
	// out empty and the flock reads as "there are no birds here". Where the
	// camera starts is authored everywhere else in this scene — the opening shot,
	// the palm grove, the grass bank — and the gulls are no different.
	//
	// Near the player is not enough on its own: the first pass put both groups
	// eighty metres *behind* the camera, which is as empty as no birds at all.
	// They have to be inside the opening frustum, so the arc is ±55° of the view
	// direction — wide enough that the two groups do not read as a matched pair,
	// narrow enough that both are on screen at 55° of field.
	const centres = [];
	const wanted = Math.max( 2, Math.round( cfg.groups ) );

	const near = ( r0, r1 ) => {

		for ( let guard = 0; guard < 600; guard ++ ) {

			const a = view + rng( - 0.96, 0.96 ), r = rng( r0, r1 );
			const x = eye.x + Math.cos( a ) * r, z = eye.z + Math.sin( a ) * r;
			const dS = terrain.shoreAt( x, z );
			// A far wider band than the coastal scatter uses, and on purpose: the
			// camera stands *on* the beach, so the tightest radii are all inland of
			// the waterline. Holding them to the surf line pushed the near group out
			// to seventy metres, which is where the whole distance problem started.
			// Gulls loaf over the back-beach; only the ridge is out of bounds.
			if ( dS > 130 || dS < - 160 ) continue;
			return { x, z };

		}

		return null;

	};

	// Distance is the whole game, and it is distance *from the lens*, which on
	// this shot is 46 m behind the player. A herring gull's wingspan is 1.4 m: at
	// ninety metres that is seven pixels of a 514-line frame — physically
	// correct, and invisible; at twenty it is forty and unmistakably a bird. The
	// wingspan stays honest and the circle comes to the camera instead, because
	// an oversized gull is obvious the moment it passes a palm. So the first
	// group works the surf close in, the second sits well behind it, and the
	// flock does not read as one flat decal.
	for ( const [ r0, r1 ] of [ [ 20, 42 ], [ 70, 140 ] ] ) {

		const c = near( r0, r1 );
		if ( c ) centres.push( c );

	}

	// the rest work the whole coast, kept apart so they read as separate flocks
	for ( let guard = 0; guard < 6000 && centres.length < wanted; guard ++ ) {

		const x = rng( - 820, 820 ), z = rng( - 820, 820 );
		const dS = terrain.shoreAt( x, z );
		// from ~170 m offshore to ~50 m inland: the band a gull actually patrols
		if ( dS > 50 || dS < - 170 ) continue;
		if ( centres.some( ( c ) => ( c.x - x ) ** 2 + ( c.z - z ) ** 2 < 140 * 140 ) ) continue;
		centres.push( { x, z } );

	}

	if ( centres.length === 0 ) centres.push( { x: eye.x, z: eye.z } );

	const out = { positions: [], normals: [], shapes: [], orbits: [], flights: [], drifts: [], indices: [] };

	// Gulls wheel in loose groups, so most of the flock shares a centre with a
	// few others and differs only in phase, height and radius. Scattering every
	// bird independently gives an even sprinkle that reads as wallpaper.
	//
	// The two on-camera groups draw a double share, because the rest of the coast
	// is scenery and these two are the ones anybody actually watches: six birds
	// spread over a circle is often two in frame at once, and two birds is a
	// coincidence rather than a flock.
	const bag = [];
	centres.forEach( ( c, i ) => bag.push( i, ...( i < 2 ? [ i ] : [] ) ) );

	for ( let i = 0; i < cfg.count; i ++ ) {

		const gi = bag[ i % bag.length ];
		const c = centres[ gi ];
		const home = gi < 2;                     // the two groups on the opening shot
		const sgn = rand() < 0.5 ? - 1 : 1;
		const radius = home ? rng( 8, 19 ) : rng( 16, 62 );
		const speed = rng( 8.5, 13.0 );          // m/s — a gull cruises about 11
		// the near group's own spread has to shrink with it, or half of it lands
		// behind the camera
		const jit = home ? 10 : 26;

		appendGull( {
			cx: c.x + rng( - jit, jit ),
			cz: c.z + rng( - jit, jit ),
			radius,
			// A gull at eye level is a gull against the sea, where a white bird on
			// white surf disappears. Six metres up is the bottom of the sky.
			alt: Math.max( 0, terrain.heightAt( c.x, c.z ) ) + ( home ? rng( 6, 21 ) : rng( 7, 46 ) ),
			omega: sgn * speed / radius,           // v = ωr, so the turn stays flyable
			phase: rng( 0, Math.PI * 2 ),
			flapOff: rng( 0, 1 ),
			// local span is ±1, so this is half the wingspan: 1.24–1.56 m, which is
			// a herring gull to the centimetre. It is tempting to cheat it upward
			// when the birds read small; a gull the size of an albatross is obvious
			// the first time one crosses a palm.
			scale: rng( 0.62, 0.78 ),
			driftR: rng( 8, 34 ),
			driftW: rng( 0.020, 0.055 ) * ( rand() < 0.5 ? - 1 : 1 ),
			driftP: rng( 0, Math.PI * 2 ),
			bob: rng( 0.8, 3.4 ),
		}, out );

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( out.positions, 3 ) );
	geometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( out.normals, 3 ) );
	geometry.setAttribute( 'aShape', new THREE.Float32BufferAttribute( out.shapes, 3 ) );
	geometry.setAttribute( 'aOrbit', new THREE.Float32BufferAttribute( out.orbits, 4 ) );
	geometry.setAttribute( 'aFlight', new THREE.Float32BufferAttribute( out.flights, 4 ) );
	geometry.setAttribute( 'aDrift', new THREE.Float32BufferAttribute( out.drifts, 4 ) );
	geometry.setIndex( out.indices );

	const material = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );

	const shape = attribute( 'aShape', 'vec3' );
	const orbit = attribute( 'aOrbit', 'vec4' );
	const flight = attribute( 'aFlight', 'vec4' );
	const drift = attribute( 'aDrift', 'vec4' );

	const timeU = rig.time;
	const side = shape.x, span = shape.y;
	const omega = flight.x, phase = flight.y, flapOff = flight.z, scale = flight.w;

	// The whole flight, built ONCE as plain node expressions. It was a `Fn()`
	// called from both the position and the normal path to begin with, and the
	// flock rendered nothing at all: two invocations of the same helper in two
	// different function scopes, each declaring its own `toVar()` locals, and the
	// graph that came out was not the graph either of them described. Shared
	// vertex work in TSL wants to be one expression referenced twice, not one
	// function called twice — the compiler commons it up either way, and only the
	// expression form is unambiguous about which scope the variables live in.

	// ---- where the bird is: a circle whose centre is itself slowly circling,
	// which is what turns a carousel into soaring. Two incommensurate rates, so
	// the path never closes.
	const cx = orbit.x.add( drift.x.mul( cos( drift.y.mul( timeU ).add( drift.z ) ) ) );
	const cz = orbit.y.add( drift.x.mul( sin( drift.y.mul( timeU ).mul( 0.83 ).add( drift.z.mul( 1.7 ) ) ) ) );
	const R = orbit.z.mul( sin( timeU.mul( 0.11 ).add( phase ) ).mul( 0.18 ).add( 1.0 ) );

	const ang = phase.add( omega.mul( timeU ) );
	const ca = cos( ang ), sa = sin( ang );

	const bobPh = timeU.mul( 0.37 ).add( phase.mul( 2.1 ) );
	const alt = orbit.w.add( drift.w.mul( sin( bobPh ) ) )
		.add( sin( timeU.mul( 0.13 ).add( phase ) ).mul( 0.6 ) );

	const centre = vec3( cx.add( R.mul( ca ) ), alt, cz.add( R.mul( sa ) ) );

	// ---- which way it is pointing: the circle's horizontal tangent, plus the
	// climb rate of the bob, so a rising gull actually noses up.
	const sgn = clamp( omega.mul( 1e4 ), - 1.0, 1.0 );
	const climb = drift.w.mul( 0.37 ).mul( cos( bobPh ) ).div( max( abs( omega ).mul( R ), 0.5 ) );
	const fwd = normalize( vec3( sa.negate().mul( sgn ), climb, ca.mul( sgn ) ) );

	// `right` comes out as the outward radial for a positive turn and the inward
	// one for a negative turn, which is exactly why the bank angle carries the
	// sign of ω: lift has to tilt toward the centre either way.
	const right0 = normalize( cross( vec3( 0.0, 1.0, 0.0 ), fwd ) );
	const up0 = cross( fwd, right0 );

	const bank = sgn.mul( sin( timeU.mul( 0.29 ).add( phase ) ).mul( 0.13 ).add( 0.40 ) );
	const cb = cos( bank ), sb = sin( bank );
	const right = right0.mul( cb ).add( up0.mul( sb ) );
	const up = up0.mul( cb ).sub( right0.mul( sb ) );

	// ---- the wing: bursts of beating separated by glides, and inside a burst a
	// travelling wave down the span so the tip lags the shoulder.
	const burst = smoothstep( 0.52, 0.86,
		sin( timeU.mul( 0.21 ).add( flapOff.mul( 6.3 ) ) ).mul( 0.5 ).add( 0.5 ) );
	const beat = timeU.mul( 17.0 ).add( flapOff.mul( 11.0 ) ).sub( span.mul( 1.5 ) );

	// resting shape: a shallow dihedral at the shoulder easing into the
	// downturned hand that gives a gliding gull its kinked silhouette
	const flapA = float( 0.13 ).sub( span.mul( span ).mul( 0.30 ) )
		.add( burst.mul( 0.62 ).mul( sin( beat ) ) ).mul( side );

	// ...and a pitch twist driven by the flap's *velocity*, which is what stops
	// the beat looking like a hinge: the wing feathers into its own downstroke
	const twistA = burst.mul( 0.34 ).mul( cos( beat ) ).mul( span ).negate();

	// rotate about +x (twist) then about +z (flap) — the order the wing works in
	const deform = ( v ) => {

		const cw = cos( twistA ), sw = sin( twistA );
		const y1 = v.y.mul( cw ).sub( v.z.mul( sw ) );
		const z1 = v.y.mul( sw ).add( v.z.mul( cw ) );

		const cf = cos( flapA ), sf = sin( flapA );
		return vec3( v.x.mul( cf ).sub( y1.mul( sf ) ), v.x.mul( sf ).add( y1.mul( cf ) ), z1 );

	};

	const toWorld = ( d ) => right.mul( d.x ).add( up.mul( d.y ) ).add( fwd.mul( d.z ) );

	material.positionNode = centre.add( toWorld( deform( positionGeometry ) ).mul( scale ) );

	const vN = varying( normalize( toWorld( deform( normalGeometry ) ) ) );
	const vShape = varying( shape );

	material.colorNode = Fn( () => {

		const part = vShape.z, sp = vShape.y;

		// A herring gull: white body and tail, pale grey mantle over the inner
		// wing, black outer primaries. The black tip is the whole recognition cue
		// — drop it and a white bird at two hundred metres is a gull-shaped gap.
		const white = srgb( 0.92, 0.92, 0.90 );
		const mantle = srgb( 0.58, 0.62, 0.66 );
		const tip = srgb( 0.10, 0.10, 0.11 );

		const wing = mix( white, mantle, smoothstep( 0.10, 0.55, sp ) ).toVar();
		wing.assign( mix( wing, tip, smoothstep( 0.76, 0.90, sp ) ) );

		// part: 0 body, 1 wing, 2 tail — only the wing carries the markings
		const isWing = smoothstep( 0.5, 1.0, part ).mul( smoothstep( 1.5, 1.2, part ) );
		const albedo = mix( white, wing, isWing ).toVar();

		// ---- lit by the same rig as everything else on this island
		const V = normalize( cameraPosition.sub( positionWorld ) );

		// A wing is one triangle thick and drawn double-sided, so half the flock
		// is showing its back face and the baked normal points away. Flip it to
		// the viewer and every gull shades by the side you are actually looking
		// at — which is the whole point of what follows.
		const N = normalize( vN ).mul( sign( dot( normalize( vN ), V ) ) ).toVar();
		const L = rig.sunDir;
		const ndl = dot( N, L );

		// A wing is also thin enough to light from both sides — sun on the back,
		// sky underneath — so it never goes to black the way an opaque surface
		// would.
		const diffuse = max( ndl, 0.0 ).add( max( ndl.negate(), 0.0 ).mul( 0.30 ) );

		const lit = shadow
			? texture( shadow.tex, positionWorld.xz.div( land.worldScale ) ).level( 0 ).x
			: float( 1.0 );

		const sunRad = rig.sunColor.mul( rig.sunStrength ).toVar();
		const skyRad = atmosphere.inscatter( vec3( 0.0, 1.0, 0.0 ) ).mul( rig.skyStrength )
			.add( rig.moonFill ).toVar();

		// **The ambient has to know which way the surface faces.** A flat sky term
		// makes a white bird exactly as bright as the sky behind it, and the flock
		// dissolves — which is what the first pass did: the gulls were rendering
		// the whole time and simply could not be seen. Half the sphere over a gull
		// is sky and half is water and sand, and at any hour but noon those are
		// nothing like as bright. Split the two by N·up and the underwing drops to
		// a middle grey, which is exactly how a gull reads from below.
		const groundRad = skyRad.mul( 0.26 ).toVar();
		const ambient = mix( groundRad, skyRad, N.y.mul( 0.5 ).add( 0.5 ) );

		// the sun through a spread primary — thin, translucent, and the reason a
		// backlit gull flares rather than silhouettes
		const through = pow( clamp( dot( V.negate(), L ), 0.0, 1.0 ), 4.0 )
			.mul( isWing ).mul( 0.7 ).mul( lit );

		const shaded = albedo.mul( sunRad.mul( diffuse.mul( lit ).add( 0.05 ) ).add( ambient ) )
			.add( albedo.mul( sunRad ).mul( through ) );

		return atmosphere.aerial( shaded, positionWorld, cameraPosition );

	} )();

	const mesh = new THREE.Mesh( geometry, material );
	// every gull moves in the vertex stage, so the CPU has no idea where the
	// bounding box is — and one draw of a couple of thousand triangles is not
	// worth culling anyway
	mesh.frustumCulled = false;

	return { mesh, material };

}
