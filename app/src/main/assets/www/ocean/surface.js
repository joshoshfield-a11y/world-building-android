// The water surface — a power-warped grid reaching RADIUS metres from the
// origin: vertex density is ~0.3 m at the centre (where cascade-2 ripples live)
// and ~20 m at the rim, so the visible ocean spans kilometres for fewer
// vertices than a uniform 400 m plane. Displaced by the three cascade maps in
// the vertex stage and shaded manually in the fragment stage (fresnel ·
// analytic-sky reflection · height-gated subsurface scatter · Jacobian foam).
// Unlit base material: we are compositing water, not running a PBR pass.

import * as THREE from 'three/webgpu';
import {
	Fn, If, uniform, varying, texture,
	float, vec2, vec3, vec4,
	positionGeometry, positionWorld, cameraPosition,
	normalize, dot, reflect, refract, exp, clamp, sqrt, pow, mix, abs, max, smoothstep, length,
} from 'three/tsl';

const DEEP = 140;   // metres of water assumed where no seabed map is bound

// Metres of sea one pixel spans per metre of range — ~55° vertical fov over
// ~760 CSS pixels. Only used to decide which wave bands are still resolved.
const PX_PER_METRE = 1.3e-3;

const RADIUS = 3800;        // half-extent of the patch, metres
const GRID = 768;           // segments per side
const CENTER_GAIN = 0.045;  // cubic warp: centre spacing ≈ GAIN·RADIUS·(2/GRID)

// axis-wise cubic warp x = R·u·(a + (1−a)u²) — ~0.3 m cells at the centre,
// ~20 m at the rim
function makeWarpedGrid() {

	const geometry = new THREE.PlaneGeometry( 2, 2, GRID, GRID );
	geometry.rotateX( - Math.PI / 2 );

	const pos = geometry.attributes.position;
	const a = CENTER_GAIN;

	for ( let i = 0; i < pos.count; i ++ ) {

		const u = pos.getX( i ), v = pos.getZ( i );
		pos.setX( i, RADIUS * u * ( a + ( 1 - a ) * u * u ) );
		pos.setZ( i, RADIUS * v * ( a + ( 1 - a ) * v * v ) );

	}

	return geometry;

}

// small tileable noise, baked once — sub-grid normal detail + foam brightness
function makeDetailNoise( size = 128 ) {

	const data = new Uint8Array( size * size * 4 );

	// per-channel sums of integer-frequency sines → seamless tiling
	let seed = 7;
	const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;

	const channels = [];

	for ( let ch = 0; ch < 4; ch ++ ) {

		const waves = [];

		for ( let i = 0; i < 10; i ++ ) {

			waves.push( {
				fx: Math.round( 1 + rand() * 5 ) * ( rand() > 0.5 ? 1 : - 1 ),
				fy: Math.round( 1 + rand() * 5 ) * ( rand() > 0.5 ? 1 : - 1 ),
				phase: rand() * Math.PI * 2,
				amp: 0.5 + rand(),
			} );

		}

		channels.push( waves );

	}

	for ( let y = 0; y < size; y ++ ) {

		for ( let x = 0; x < size; x ++ ) {

			for ( let ch = 0; ch < 4; ch ++ ) {

				let v = 0, norm = 0;

				for ( const w of channels[ ch ] ) {

					v += w.amp * Math.sin( 2 * Math.PI * ( w.fx * x + w.fy * y ) / size + w.phase );
					norm += w.amp;

				}

				data[ ( y * size + x ) * 4 + ch ] = Math.round( ( v / norm * 0.5 + 0.5 ) * 255 );

			}

		}

	}

	const tex = new THREE.DataTexture( data, size, size, THREE.RGBAFormat );
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.magFilter = THREE.LinearFilter;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.generateMipmaps = true;
	tex.needsUpdate = true;
	return tex;

}

export function makeOceanSurface( sim, sky, config, opts = {} ) {

	const cascades = sim.cascades;
	const lengthScales = config.sim.lengthScales;

	const uniforms = {
		deepColor: uniform( new THREE.Color( config.shading.deepColor ) ),
		scatterColor: uniform( new THREE.Color( config.shading.scatterColor ) ),
		foamColor: uniform( new THREE.Color( config.shading.foamColor ) ),
		seabedColor: uniform( new THREE.Color( config.shading.seabed || 0xa08a63 ) ),
		absorb: uniform( new THREE.Vector3( ...( config.shading.absorb || [ 0.42, 0.085, 0.033 ] ) ) ),
		caustics: uniform( config.shading.caustics !== undefined ? config.shading.caustics : 0.9 ),
		detail: uniform( config.shading.detail ),
		sssStrength: uniform( config.shading.sssStrength ),
		foamThreshold: uniform( config.foam.threshold ),
		foamScale: uniform( config.foam.scale ),
		// 1 = the terrain bake bound in opts.shoreTex *is* the seabed here, so the
		// water shoals over it and takes its colour from the depth. 0 = open
		// ocean: with the land layer hidden there is no seabed to read, and
		// reading it anyway stamps the island's outline onto the water as a
		// shallow, surf-ringed patch.
		bedMix: uniform( 0 ),
		offset: uniform( new THREE.Vector2() ), // where the dense centre of the patch sits
	};

	const noiseTex = makeDetailNoise();
	const timeU = sim.timeU;

	// Transparent so the shore edge can dissolve into the sand under it. Depth
	// writes stay on: alpha is 1 over all but the last centimetres of the swash,
	// so the sea still occludes itself properly, and the only fragments that
	// blend are the ones that have nothing behind them but beach.
	const material = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );
	material.transparent = true;

	// The grid is 0.3 m at its centre and 20 m at its rim, so the centre has to
	// be under the *camera*: anchored at the origin, a shoreline 500 m away gets
	// 4 m water polygons and the surf line turns into a staircase. The patch
	// slides with the view and every world-space lookup adds the offset back, so
	// the waves themselves never move.
	const vLocal = varying( positionGeometry.xz );
	const vXZ = varying( positionGeometry.xz.add( uniforms.offset ) );

	material.positionNode = Fn( () => {

		const local = positionGeometry.xz;
		const xz = local.add( uniforms.offset );
		const disp = vec3( 0 ).toVar();

		for ( let c = 0; c < cascades; c ++ ) {

			const uv = xz.div( lengthScales[ c ] );
			disp.addAssign( texture( sim.displacementMaps[ c ], uv ).level( 0 ).xyz );

		}

		// flatten displacement toward the rim so the patch edge can't silhouette
		// a jagged ridge against the sky
		const geoFade = float( 1.0 ).sub( smoothstep( RADIUS * 0.70, RADIUS * 0.93, length( local ) ) ).toVar();

		// Shoaling. A wave running into shallow water does not fade out — it
		// slows, shortens and *grows* (Green's law, H ∝ d^−¼) until the crest
		// outruns the trough and it breaks. Damping it to nothing on approach is
		// what leaves a glassy turquoise strip between the chop and the sand
		// with a painted white line lying on top of it. So: gain on the way in,
		// collapse over the last couple of metres, and let the fragment stage's
		// breaking criterion light the crests that are now actually there. The
		// map wraps every shoreScale metres, so it only speaks for the first
		// tile — beyond that it is open ocean.
		// the vertical gain rides separately, because the swash below applies to
		// it and not to the horizontal choppiness
		const lift = geoFade.toVar();
		const surge = float( 0 ).toVar();   // the swash sheet, in metres of water level
		// still-water depth under this vertex; open ocean until the bake says
		// otherwise, so the trough limiter below is a no-op away from the island
		const stillD = float( 1e4 ).toVar();
		// the shoreward unit vector and how hard to lean into it — see the
		// forward-pitch note below
		const pitchDir = vec2( 0 ).toVar();
		const pitchK = float( 0 ).toVar();

		if ( opts.shoreTex ) {

			const ws = opts.shoreScale;
			const hd = texture( opts.shoreTex, xz.div( ws ) ).level( 0 ).xy.toVar(); // height, shore distance
			const stillDepth = max( hd.x.negate(), 0.0 ).toVar();
			const shoal = smoothstep( 17.0, 3.5, stillDepth ).mul( 0.55 ).add( 1.0 );
			const collapse = smoothstep( 0.25, 2.6, stillDepth );

			const inTile = smoothstep( ws * 0.5, ws * 0.44, max( abs( xz.x ), abs( xz.y ) ) );
			const shore = ( g ) => mix( 1.0, mix( 1.0, g, inTile ), uniforms.bedMix );

			// The FFT owns the swell and collapses over the last couple of metres;
			// what runs up the sand past that is the *swash*, and it is the shared
			// shoreline model's job (../world/shore.js) rather than a second guess
			// made here. A broken wave does not stop at the still waterline — it
			// runs up as a thin sheet and drains back, so the water's edge moves,
			// and on a 1:35 beach ±0.4 m of water level is ±14 m of travelling
			// waterline. The point of taking it from the shared model is that the
			// *sand* evaluates the same function: the wet tongue is then left by
			// the sheet that was actually there, instead of by a lookalike running
			// on its own phase.
			geoFade.mulAssign( shore( shoal.mul( collapse ) ) );
			lift.mulAssign( shore( shoal.mul( collapse ) ) );
			stillD.assign( mix( float( 1e4 ), stillDepth, inTile.mul( uniforms.bedMix ) ) );

			// **The forward pitch.** Green's law above makes a shoaling wave
			// taller; it does not make it a *breaker*. What the eye reads as a
			// wave coming ashore is the asymmetry: the crest is in deeper — and
			// so faster — water than the trough ahead of it, it overtakes its own
			// front, and the face goes from a sine to a wall while the back
			// stretches out flat. The trough limiter below shapes that
			// vertically, and it is only half the story; the crest also has to
			// physically move shoreward relative to the water under it. Without
			// this the swell arrives as symmetric humps that get taller and then
			// simply stop, which was the difference between a wave field and a
			// shore.
			//
			// Shoreward is up the bed gradient — the same direction the foam
			// field drifts along, taken from the same texture, so the pitch and
			// the whitewater it makes agree about which way the beach is. Two
			// taps, and only inside the tile that has a seabed.
			//
			// The gain is fractional on purpose: at 1.0 the crest travels a full
			// wave height and the grid folds through itself, which renders as a
			// torn lip rather than a plunging one. 0.55 leans the face to about
			// 60° at the break, which is as far as a triangle mesh can carry it.
			const g = float( 4.0 );
			const gx = texture( opts.shoreTex, xz.add( vec2( g, 0 ) ).div( ws ) ).level( 0 ).x
				.sub( texture( opts.shoreTex, xz.sub( vec2( g, 0 ) ).div( ws ) ).level( 0 ).x );
			const gz = texture( opts.shoreTex, xz.add( vec2( 0, g ) ).div( ws ) ).level( 0 ).x
				.sub( texture( opts.shoreTex, xz.sub( vec2( 0, g ) ).div( ws ) ).level( 0 ).x );
			const up = vec2( gx, gz ).toVar();
			pitchDir.assign( up.div( max( length( up ), 1e-4 ) ) );
			pitchK.assign( smoothstep( 11.0, 1.2, stillDepth ).mul( inTile ).mul( uniforms.bedMix ).mul( 0.55 ) );

			if ( opts.shore ) {

				const w = opts.shore.sample( xz, hd.x, hd.y );
				surge.assign( w.level.mul( inTile ).mul( uniforms.bedMix ) );

			}

		}

		// **A trough cannot dig into the seabed.** The FFT knows nothing about the
		// bottom, and the shoaling gain above multiplies its vertical displacement
		// by up to 1.55 where the bed rises — so over a shelf three metres down, a
		// two-metre trough becomes three and a half and the surface passes clean
		// through the sand. What that renders as is a hole in the sea: a lagoon of
		// bare bed tens of metres across with water on every side, sitting in water
		// deep enough to swim in. It is not a swash and no shoreline model can fix
		// it, because the sea floor is simply not in the wave's equation.
		//
		// Limiting it is also the right shape: a deep-water wave is near
		// sinusoidal, and as it shoals the bottom crowds the trough while the crest
		// is free to peak — cnoidal asymmetry, sharp crests over long flat troughs.
		// `room·(e^(d/room) − 1)` is that curve exactly: identical to `d` for small
		// excursions (its slope at zero is 1, so deep water is untouched to first
		// order) and asymptotic to −room however far the wave tries to go. Crests
		// pass through unchanged, and the whole thing is blended out past nine
		// metres of depth where it has nothing left to do.
		const dy = disp.y.mul( lift ).toVar();
		const room = stillD.mul( 0.62 ).add( 0.04 ).toVar();
		const pos = max( dy, 0.0 ).toVar();
		const flat = pos.add( room.mul( exp( dy.sub( pos ).div( room ) ).sub( 1.0 ) ) );

		const y = mix( dy, flat, smoothstep( 9.0, 0.4, stillD ) ).add( surge ).toVar();

		// the bead at the tongue's front, once the final surface height is known
		if ( opts.shoreTex && opts.shore ) {

			const bed = texture( opts.shoreTex, xz.div( opts.shoreScale ) ).level( 0 ).x;
			y.addAssign( opts.shore.lip( y.sub( bed ) ).mul( uniforms.bedMix ) );

		}

		// crest-only: a trough has nothing to pitch forward, and leaning it too
		// would shear the whole water column shoreward instead of curling it
		const lean = max( y, 0.0 ).mul( pitchK ).toVar();

		return positionGeometry.add( vec3(
			disp.x.mul( geoFade ).add( pitchDir.x.mul( lean ) ),
			y,
			disp.z.mul( geoFade ).add( pitchDir.y.mul( lean ) ) ) );

	} )();

	material.colorNode = Fn( () => {

		const pos = positionWorld;
		const toCam = cameraPosition.sub( pos ).toVar();
		const dist = length( toCam ).toVar();
		const V = toCam.div( max( dist, 1e-3 ) ).toVar();

		// Summed fold-aware slopes from the derivative maps, each band faded out
		// once its own waves stop covering a pixel. Sub-pixel chop averaged
		// honestly *is* flat — but that argument is about the
		// wave, not the distance, and rolling the whole normal flat by range
		// takes the 300 m swell out with the ripples and leaves the far sea a
		// sheet. Each band carries waves no longer than lengthScales[c]/6, so
		// that is what has to outlive the pixel.
		const px = dist.mul( PX_PER_METRE ).toVar();
		const d = vec4( 0 ).toVar();
		const turbSum = float( 0 ).toVar();

		for ( let c = 0; c < cascades; c ++ ) {

			const uv = vXZ.div( lengthScales[ c ] );
			const band = lengthScales[ c ] / 6;
			d.addAssign( texture( sim.derivativeMaps[ c ], uv ).mul( smoothstep( band * 0.5, band * 0.1, px ) ) );

			// finest cascade excluded from foam — its Jacobian is permanently
			// near-folding and reads as static speckle
			if ( c < cascades - 1 ) {

				const turb = texture( sim.displacementMaps[ c ], uv ).w;
				turbSum.addAssign( uniforms.foamThreshold.sub( turb ).mul( uniforms.foamScale ).clamp( 0, 1 ) );

			}

		}

		const slopeX = d.x.div( d.z.add( 1.0 ) ).toVar();
		const slopeZ = d.y.div( d.w.add( 1.0 ) ).toVar();

		// sub-grid detail: one baked noise, two scrolling world scales. Faded out
		// with distance — past a few hundred metres a pixel spans many
		// wavelengths and this is pure shimmer.
		const nearK = smoothstep( 900.0, 90.0, dist ).toVar();
		const n1 = texture( noiseTex, vXZ.mul( 0.06 ).add( vec2( timeU.mul( 0.014 ), timeU.mul( 0.011 ) ) ) ).toVar();
		const n2 = texture( noiseTex, vXZ.mul( 0.17 ).add( vec2( timeU.mul( - 0.021 ), timeU.mul( 0.017 ) ) ) ).toVar();

		slopeX.addAssign( n1.x.sub( 0.5 ).add( n2.x.sub( 0.5 ) ).mul( uniforms.detail ).mul( nearK ) );
		slopeZ.addAssign( n1.y.sub( 0.5 ).add( n2.y.sub( 0.5 ) ).mul( uniforms.detail ).mul( nearK ) );

		const N = normalize( vec3( slopeX.negate(), 1.0, slopeZ.negate() ) ).toVar();

		// A residual roll toward vertical on top of the per-band fade: even the
		// longest band's shortest waves eventually go sub-pixel, and there is no
		// finer split left to fade them with.
		const flat = clamp( sqrt( dist.div( 2600.0 ) ).mul( 0.55 ), 0.0, 0.6 ).toVar();
		N.assign( normalize( mix( N, vec3( 0.0, 1.0, 0.0 ), flat ) ) );

		// ---- how deep the water is here ---------------------------------------
		// **Two numbers, and the difference between them is the whole waterline.**
		// `depth` is the water column and is clamped at zero, because every optical
		// term below integrates along it and a negative path length is nonsense.
		// `column` is the same quantity *signed*, and it is what decides where the
		// sea stops.
		//
		// There was only the clamped one for a long time, and it made the sea's
		// edge permanent. Clamped, "the surface is thirty centimetres under the
		// sand" reads as exactly the same number as "the surface is at the sand" —
		// zero — so the whole dry beach came back as waterline: full leading-edge
		// foam, alpha forced to one. The terrain mesh is 2.6 m quads and the water
		// reads the bake per fragment, so along the entire coast the sea pokes
		// through the sand's coarse triangles by a few centimetres; every one of
		// those slivers painted itself white and stayed. That is the ribbon that
		// hugged the sand and never drained back with the wave — it was never a
		// swash at all, it was the two meshes disagreeing, dressed as foam.
		const depth = float( DEEP ).toVar();
		const column = float( DEEP ).toVar();
		const bedHD = vec2( 0.0, 1e4 ).toVar();   // seabed height + shore distance
		const shoreK = float( 0 ).toVar();   // 1 where this bake really is the seabed

		if ( opts.shoreTex ) {

			// Signed seabed height straight out of the terrain bake, but only
			// where there *is* a seabed: outside the first tile the map has
			// wrapped, and with the land layer hidden the bake describes an
			// island that is no longer in the scene.
			const ws = opts.shoreScale;
			const hd = texture( opts.shoreTex, pos.xz.div( ws ) ).level( 0 ).xy.toVar();
			const inTile = smoothstep( ws * 0.5, ws * 0.44, max( abs( pos.x ), abs( pos.z ) ) );
			shoreK.assign( inTile.mul( uniforms.bedMix ) );
			bedHD.assign( hd );
			column.assign( mix( float( DEEP ), pos.y.sub( hd.x ), shoreK ) );
			depth.assign( max( column, 0.0 ) );

		}

		// Beer–Lambert down the column and back to the eye. The slant term is why
		// water read at a grazing angle is darker and bluer than water read from
		// straight above — same depth, three times the path.
		const pathLen = depth.mul( float( 1.0 ).add( float( 1.0 ).div( max( abs( V.y ), 0.22 ) ) ) ).toVar();
		const trans = exp( uniforms.absorb.mul( pathLen ).negate() ).toVar();

		// ---- the seabed, seen through the refracting surface -------------------
		const bedUV = pos.xz.add( N.xz.mul( depth.mul( 0.5 ) ) ).toVar();
		const bedN = texture( noiseTex, bedUV.mul( 0.055 ) ).x.mul( 0.55 )
			.add( texture( noiseTex, bedUV.mul( 0.21 ) ).y.mul( 0.45 ) );

		// Caustics for free: the wave field's own horizontal compression is
		// exactly where the refracted sun converges, and the derivative maps
		// already carry it (d.z, d.w are ∂Dx/∂x and ∂Dz/∂z).
		const focus = max( float( 1.0 ).sub( d.z.add( d.w ).mul( 2.6 ) ), 0.0 );
		const caustic = clamp( pow( focus, 3.0 ).sub( 0.9 ), - 0.3, 1.6 ).mul( uniforms.caustics )
			.mul( smoothstep( 14.0, 1.0, depth ) ).mul( max( sky.sunDir.y, 0.0 ) );

		// Lit like the beach it continues, or the waterline shows a seam where
		// one sand ends and the other begins.
		const bedLight = sky.sunColor.mul( max( sky.sunDir.y, 0.0 ).mul( 0.9 ).add( 0.1 ) )
			.add( sky.inscatter( vec3( 0.0, 1.0, 0.0 ) ).mul( 0.5 ) );
		const bedCol = uniforms.seabedColor.mul( bedN.mul( 0.5 ).add( 0.7 ) )
			.mul( caustic.add( 1.0 ) ).mul( bedLight );

		// ---- the water body ----------------------------------------------------
		// bottom seen through the column + the column's own upwelling scatter,
		// which is a lit green-cyan in the surf zone and settles to the deep
		// colour once the bottom is out of reach
		const shallowK = exp( depth.div( - 7.0 ) );
		const volume = mix( uniforms.deepColor, uniforms.scatterColor, shallowK ).mul( float( 1.0 ).sub( trans ) );
		const body = bedCol.mul( trans ).add( volume.mul( sky.bodyLight ) ).toVar();

		// crest scatter: light that entered a wave's back and comes out its face.
		// Driven by the *refracted* view ray (Snell at 1/1.33), so it only fires
		// where the sun really is behind the water in front of you.
		const RF = refract( V.negate(), N, 0.75 );
		const through = pow( max( dot( RF, sky.sunDir ), 0.0 ), 14.0 )
			.mul( smoothstep( - 0.02, 0.25, sky.sunDir.y ) );
		const crest = pos.y.mul( 0.42 ).add( 0.38 ).clamp( 0.0, 1.0 );
		body.addAssign( vec3( 0.28, 0.62, 0.55 ).mul( sky.sunColor )
			.mul( through.mul( uniforms.sssStrength ).mul( 1.8 ).add( crest.mul( 0.10 ) ) )
			.mul( sky.bodyLight ) );

		// ---- surface ------------------------------------------------------------
		const fresnel = pow( float( 1.0 ).sub( max( dot( N, V ), 0.0 ) ), 5.0 ).mul( 0.98 ).add( 0.02 ).toVar();

		const R = reflect( V.negate(), N ).toVar();
		const reflection = sky.sample( vec3( R.x, max( abs( R.y ), 0.015 ), R.z ) ).toVar();

		const water = mix( body, reflection, fresnel ).toVar();

		// **The glitter path.** The reflection above already contains the moon
		// disc, and that is exactly the problem: a moon is a degree across, so a
		// mirror hands it back only where a facet points within half a degree of
		// right — a scatter of hard specks, which is what a moonlit sea came out
		// as. The column you actually see is made by the roughness *below* this
		// mesh: capillary ripples a centimetre across that no FFT tile of this
		// size resolves, spreading one small source over a broad sheet of light.
		// So the moon gets an explicit two-lobe highlight — a tight one for the
		// sparkle, a wide one for the sheet running out to the horizon — and the
		// sun does not, because a sun disc is bright enough that the mirror path
		// reads on its own.
		//
		// Fresnel is kept but flattened: a pure Fresnel multiply is right for a
		// mirror and wrong for a rough lobe, and it deletes the near half of the
		// column, which is the half you are standing in.
		const Hm = normalize( sky.moonDir.add( V ) ).toVar();
		const nh = max( dot( N, Hm ), 0.0 ).toVar();
		const glint = pow( nh, 240.0 ).mul( 1.30 ).add( pow( nh, 16.0 ).mul( 0.085 ) );
		water.addAssign( sky.moonLight.mul( glint ).mul( fresnel.mul( 0.75 ).add( 0.25 ) ) );

		// ---- foam ---------------------------------------------------------------
		const coverage = smoothstep( 0.2, 0.9, turbSum ).toVar();

		// The running edge of the swash breaks into fingers and islands as the
		// sheet thins — the one place where carving foam *coverage* with noise is
		// the truth rather than the lazy option. Without it the sheet arrives as
		// a solid white band with a ruled edge, and a beach under a hand's depth
		// of water reads as spilt milk. The persistent surf field below wants the
		// same treatment for the same reason, so it is computed here rather than
		// where it is first used.
		const sheet = smoothstep( 0.35, 0.72, n2.x.mul( 0.6 ).add( n1.y.mul( 0.4 ) ) ).toVar();

		// Surf, from the actual breaking criterion: a wave breaks when its height
		// is a good fraction of the water depth under it. That single ratio puts
		// the foam line exactly where the bottom shoals — it follows every cove
		// and headland without anyone drawing it.
		const steep = pos.y.add( 0.3 ).div( max( depth, 0.35 ) ).toVar();
		const brk = smoothstep( 0.30, 0.85, steep );
		const surf = brk.mul( smoothstep( 7.0, 0.5, depth ) )
			.mul( mix( 0.5, 1.0, n1.w.mul( 0.5 ).add( n2.z.mul( 0.5 ) ) ) ).toVar();

		// ...and the same breaker a few seconds ago. `surf` above is the crest
		// that is breaking *now* and nothing else, which is why on its own it
		// reads as a white line glued to the front of every wave: the moment the
		// crest passes, the water it aerated goes clear again. The band it
		// actually left is in the foam field (../ocean/breaker-foam.js), which
		// ran the same criterion into a buffer and has been decaying and drifting
		// it shoreward ever since. Taken as a max, not a sum — foam does not
		// stack, and where the live crest and its own wake overlap the answer is
		// still "white".
		if ( opts.breakerFoam ) {

			const f = opts.breakerFoam;
			const fuv = pos.xz.sub( f.uniforms.center ).div( f.uniforms.span ).add( 0.5 );
			// Carved, not painted. The field is a couple of metres a texel and
			// bilinear on top of that, so read straight it is a soft blob of
			// coverage — the shape of the buffer rather than the shape of foam.
			// Holed with the same lace the swash sheet uses, the blob becomes a
			// raft of bubbles with water showing through it, and the texel grid
			// stops being visible at any range.
			const raft = texture( f.tex, fuv ).x.mul( 1.35 ).clamp( 0.0, 1.0 );
			surf.assign( max( surf, raft.mul( shoreK ).mul( mix( 0.42, 1.0, sheet ) ) ) );

		}
		// and the lace of spent foam drifting in the shallows behind it — on the
		// same criterion at a lower threshold, never on depth alone: foam is what
		// a wave left behind, so keyed to depth it becomes a collar of constant
		// width that hugs the whole coast whether anything is breaking or not
		// ...and it has to die on the dry side, not merely thin out: keyed to the
		// clamped column it is at full strength everywhere the surface sits under
		// the sand, which is most of the beach.
		const lace = smoothstep( 0.10, 0.48, steep ).mul( smoothstep( 2.6, 0.05, depth ) )
			.mul( smoothstep( - 0.02, 0.07, column ) )
			.mul( smoothstep( 0.34, 0.78, n2.w ) ).mul( 0.55 );
		// far whitecaps are a texel of aliased Jacobian, not a wave — thin them
		// out or the distance fills with white scratches
		coverage.assign( max( coverage, max( surf, lace ) ).clamp( 0.0, 1.0 )
			.mul( mix( 1.0, 0.5, smoothstep( 350.0, 2200.0, dist ) ) ) );

		coverage.mulAssign( mix( sheet, 1.0, smoothstep( 0.05, 0.45, depth ) ) );

		// ...and the swash's own foam, from the shared shoreline model: the sheet
		// the bore left behind (phase-offset 0.85π from the crest, because foam is
		// what a wave *has passed*, not what it is made of) plus the leading edge
		// itself, where the film is thinnest and most aerated.
		const shoreFoam = float( 0 ).toVar();
		// the water column the *edge* is decided by: the true one, frayed by the
		// shoreline model's last-centimetre term (see ../world/shore.js). The sand
		// subtracts the identical number, so both sides of the waterline break up
		// along exactly the same rivulets instead of each drawing its own outline.
		const edgeDepth = column.toVar();

		if ( opts.shore ) {

			const w = opts.shore.sample( pos.xz, bedHD.x, bedHD.y );
			edgeDepth.subAssign( w.fray.mul( shoreK ) );
			shoreFoam.assign( opts.shore.foam( w.trail, edgeDepth ).mul( shoreK ).mul( sheet ) );
			coverage.assign( max( coverage, shoreFoam ) );

		}

		// brightness modulated by noise — never carve coverage with it
		const foamNoise = mix( 0.62, 1.0, n1.z.mul( 0.5 ).add( n2.w.mul( 0.5 ) ) );
		const NdL = max( dot( N, sky.sunDir ), 0.0 );
		const foamLit = uniforms.foamColor.mul( NdL.mul( 0.6 ).add( 0.55 ) ).mul( foamNoise ).mul( sky.bodyLight );

		const shaded = mix( water, foamLit, coverage ).toVar();

		// ---- aerial perspective + rim fade ---------------------------------------
		// Extinction toward the sky along this exact view ray, so the water melts
		// into the horizon it is standing under instead of into a fog colour.
		const withAir = sky.aerial( shaded, pos, cameraPosition ).toVar();

		// The patch ends kilometres before the real horizon does, so its rim hands
		// over to the atmosphere's distant-sea term — the same one the background
		// uses for every below-horizon ray, so the handover is invisible wherever
		// the patch happens to end. The patch is a square, so the rim has to be
		// measured with a square norm: a radial fade leaves the four corners
		// unblended and the ocean reads as a giant flat card. Behind a branch: it
		// is two more LUT fetches and the outer ring is a thin slice of the frame.
		const rim = smoothstep( RADIUS * 0.70, RADIUS * 0.97, max( abs( vLocal.x ), abs( vLocal.y ) ) ).toVar();

		If( rim.greaterThan( 0.002 ), () => {

			withAir.assign( mix( withAir, sky.distantSea( V.negate() ), rim ) );

		} );

		// The last few centimetres of a swash sheet are not water-coloured — they
		// are *transparent*, and what you read there is the wet sand underneath.
		// Rendered opaque, the sheet ends on the mesh's intersection with the
		// terrain, which is a knife cut: bright silver on one side, dry sand on
		// the other, and no amount of foam painted along it hides that it is a
		// line rather than an edge. Fading the surface out over the last 9 cm of
		// column costs one smoothstep and removes the seam entirely, because both
		// sides of it become the same pixels. Foam brings the opacity back: an
		// aerated sheet a centimetre deep is white and you cannot see through it.
		// The fade has to cover the first ~18 cm, not the first few: a runnel wall
		// takes the column from nothing to a hand's depth over one polygon, and a
		// fade narrower than that still ends on a drawn line.
		const alpha = max( smoothstep( 0.0, 0.18, edgeDepth ), shoreFoam ).clamp( 0.0, 1.0 );

		return vec4( withAir, alpha );

	} )();

	const mesh = new THREE.Mesh( makeWarpedGrid(), material );
	mesh.frustumCulled = false;

	function follow( x, z ) {

		mesh.position.set( x, 0, z );
		uniforms.offset.value.set( x, z );

	}

	return { mesh, material, uniforms, follow };

}
