// The surf zone's memory.
//
// Everything else about this ocean is a *function of now*: the FFT gives the
// displacement at time t, the shading asks whether the crest standing here is
// tall for the water under it, and paints it white if it is. That is a correct
// description of where a wave is breaking and a completely wrong description of
// where the whitewater is, because whitewater is the one thing on a sea that has
// a past. A breaker throws its crest forward, aerates a band of water and then
// *moves on*; the band it left keeps drifting shoreward for several seconds and
// fades. Painted as a function of now, it vanishes the instant the crest passes,
// and the surf reads as a white line stuck to the front of every wave — which
// is exactly the difference between a wave field and a shore.
//
// So: one scalar field over the coast, advanced once a frame. New foam is
// written wherever the depth-limited breaking criterion fires — the same
// criterion the surface shades with, so the two agree about what a breaker is —
// and then it drifts up the bed gradient and decays. The surface reads it in
// place of its own instantaneous surf term.
//
// Three decisions worth keeping:
//
//  * **World-fixed, not camera-following.** A camera-following buffer carries
//    a reprojection every frame, a previous-centre uniform and an edge fade,
//    because a coast can be unbounded. This island's whole coastline fits in a
//    square a
//    kilometre and a half on a side, measured at boot from the terrain itself,
//    so the field can simply *be* that square: no reprojection, no previous
//    centre, no edge fade, and the foam behind you is still there when you turn
//    around.
//  * **Ping-pong by offset, not by binding.** WebGPU will not let one texture be
//    a sampled source and a storage destination in the same pass, and swapping
//    bindings per frame means rebuilding the node. One storage buffer of twice
//    the texels, with the read and write halves picked by two uniforms that
//    swap, is the whole of the double buffer. The pass also writes a plain
//    storage *texture* on the way out, which is what the surface samples — one
//    stable binding, and filtering for free.
//  * **Advection is a bilinear read, not an integer shift.** At two metres a
//    texel and a frame at 120 Hz the drift is a hundredth of a texel; rounded to
//    whole texels it is zero and the field never moves at all.

import * as THREE from 'three/webgpu';
import {
	Fn, texture, textureStore, uniform, storage, instanceIndex,
	float, vec2, vec4, uvec2, uint,
	max, clamp, smoothstep, exp, length, floor, fract, mix, If,
} from 'three/tsl';

// The field, in metres of world per texel, is span/size. Foam *bands* are ten
// to thirty metres wide and the lace inside them comes from the shader's noise,
// so a couple of metres a texel is the right resolution: finer buys detail the
// field is not carrying and costs texels quadratically.
const SIZE = 640;

// ...and it is stepped at 30 Hz, not at frame rate. Whitewater's fastest
// timescale is its own decay, seconds; there is nothing in the field that a
// 33 ms step misses, and at 120 fps this is three frames in four that do not
// dispatch a quarter-million texels. The step integrates the accumulated dt, so
// the drift and the decay are frame-rate independent either way.
const HZ = 30;

/**
 * Where the coast is. Scanning the terrain beats hard-coding a square: the
 * field then fits whatever island the generator made, and if the coastline ever
 * moves the foam moves with it.
 *
 * @param heightAt  (x, z) → signed terrain height, metres
 * @param reach     how far out to sea the surf zone runs, metres
 * @param extent    half-width of the region to scan
 */
function coastSquare( heightAt, reach, extent ) {

	let x0 = Infinity, x1 = - Infinity, z0 = Infinity, z1 = - Infinity;
	const STEP = extent / 64;

	for ( let z = - extent; z <= extent; z += STEP ) {

		for ( let x = - extent; x <= extent; x += STEP ) {

			if ( heightAt( x, z ) <= 0 ) continue;
			if ( x < x0 ) x0 = x;
			if ( x > x1 ) x1 = x;
			if ( z < z0 ) z0 = z;
			if ( z > z1 ) z1 = z;

		}

	}

	if ( ! isFinite( x0 ) ) return { center: [ 0, 0 ], span: extent };

	// square, because the field is: the longer side sets it, and both get the
	// surf margin on each end
	const span = Math.max( x1 - x0, z1 - z0 ) + reach * 2;
	return { center: [ ( x0 + x1 ) / 2, ( z0 + z1 ) / 2 ], span };

}

/**
 * @param sim     the FFT ocean sim — displacement maps and cascade scales
 * @param config  the ocean config (foam threshold/scale, sim length scales)
 * @param opts    { shoreTex, shoreScale, heightAt }
 */
export function makeBreakerFoam( sim, config, opts ) {

	const cascades = sim.cascades;
	const lengthScales = config.sim.lengthScales;
	const cfg = config.foam;

	const { center, span } = coastSquare( opts.heightAt, cfg.reach, opts.shoreScale * 0.5 );

	const texels = SIZE * SIZE;
	const stateBuf = new THREE.StorageBufferAttribute( new Float32Array( texels * 2 ), 1 );
	const stateS = storage( stateBuf, 'float', texels * 2 );

	const tex = new THREE.StorageTexture( SIZE, SIZE );
	tex.type = THREE.HalfFloatType;
	tex.format = THREE.RGBAFormat;
	tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
	tex.magFilter = tex.minFilter = THREE.LinearFilter;

	const uniforms = {
		dt: uniform( 0 ),
		center: uniform( new THREE.Vector2( center[ 0 ], center[ 1 ] ) ),
		span: uniform( span ),
		// seconds for the whitewater to fade by 1/e. Long enough that a band
		// outlives the crest that made it by most of a wave period, short enough
		// that the surf zone is not permanently white.
		life: uniform( cfg.life ),
		// metres a second the band travels up the bed gradient. Broken water
		// keeps a good fraction of the wave's celerity; in three metres of water
		// that is about 5 m/s, and it is bleeding energy the whole way.
		drift: uniform( cfg.drift ),
		threshold: uniform( config.foam.threshold ),
		scale: uniform( config.foam.scale ),
		src: uniform( 0, 'uint' ),
		dst: uniform( texels, 'uint' ),   // ping-pong halves of one buffer
	};

	const ws = opts.shoreScale;
	const bedAt = ( xz ) => texture( opts.shoreTex, xz.div( ws ) ).level( 0 ).xy;

	const step = Fn( () => {

		const u = uniforms;
		const id = instanceIndex;
		const iy = id.div( uint( SIZE ) );
		const ix = id.sub( iy.mul( uint( SIZE ) ) );

		// texel centre → world
		const cell = u.span.div( SIZE );
		const uv = vec2( float( ix ).add( 0.5 ), float( iy ).add( 0.5 ) ).div( SIZE ).toVar();
		const world = uv.sub( 0.5 ).mul( u.span ).add( u.center ).toVar();

		const hd = bedAt( world ).toVar();
		const depth = max( hd.x.negate(), 0.0 ).toVar();

		const out = float( 0 ).toVar();

		// Only the surf zone has a memory. Past nine metres of water nothing is
		// breaking on the bottom and the sim's own whitecap decay already covers
		// the folding kind; more than a few metres inland there is no water. The
		// dispatch walks a row at a time, so a workgroup is 64 neighbouring
		// texels and this branch is coherent nearly everywhere.
		If( depth.lessThan( 8.5 ).and( hd.y.lessThan( 14.0 ) ), () => {

			// ---- what is breaking here, right now.
			//
			// The same numbers the surface shades with, reached the long way
			// round: it has the displaced vertex in hand and this does not, so
			// the cascades are re-summed and the shoaling gain re-applied. That
			// duplication is deliberate and it is the small one — if the two
			// criteria ever disagree the foam appears where nothing is breaking,
			// so they are written to be read side by side (`../ocean/surface.js`,
			// the `steep`/`brk` pair).
			const dy = float( 0 ).toVar();
			const turb = float( 0 ).toVar();

			for ( let c = 0; c < cascades; c ++ ) {

				const d = texture( sim.displacementMaps[ c ], world.div( lengthScales[ c ] ) ).level( 0 );
				dy.addAssign( d.y );
				if ( c < cascades - 1 ) {

					turb.addAssign( u.threshold.sub( d.w ).mul( u.scale ).clamp( 0, 1 ) );

				}

			}

			const gain = smoothstep( 17.0, 3.5, depth ).mul( 0.55 ).add( 1.0 );
			const steep = dy.mul( gain ).add( 0.3 ).div( max( depth, 0.35 ) ).toVar();
			// depth-limited breaking, and the folding kind held to the shallows —
			// out in the open the sim's own turbulence channel already carries
			// the whitecaps and their decay
			// Both thresholds sit *above* the surface's, and that is the point of
			// the field rather than an accident of tuning. The surface's `brk` is
			// asking "is this crest steep enough to be shaded white" and it
			// answers per fragment, so it can afford to be generous — whatever it
			// paints is gone next frame. This is asking "did a wave *break* here",
			// and the answer is written into a field that will still be there in
			// three seconds: generous here means the whole surf zone latches white
			// and stays that way, which is what the first tuning did.
			const gen = max(
				smoothstep( 0.42, 0.90, steep ).mul( smoothstep( 6.5, 0.4, depth ) ),
				smoothstep( 0.30, 0.90, turb ).mul( smoothstep( 7.5, 1.2, depth ) ) ).toVar();

			// ---- where the band was a frame ago.
			//
			// Up the bed gradient: broken water runs shoreward, and the seabed's
			// own slope is the only thing on hand that knows which way that is.
			// Four taps, and only for the texels that got this far.
			const e = cell.mul( 1.5 );
			const gx = bedAt( world.add( vec2( e, 0 ) ) ).x.sub( bedAt( world.sub( vec2( e, 0 ) ) ).x );
			const gz = bedAt( world.add( vec2( 0, e ) ) ).x.sub( bedAt( world.sub( vec2( 0, e ) ) ).x );
			const up = vec2( gx, gz ).toVar();
			const dir = up.div( max( length( up ), 1e-4 ) ).toVar();

			const back = uv.sub( dir.mul( u.drift.mul( u.dt ).div( u.span ) ) )
				.mul( SIZE ).sub( 0.5 ).toVar();
			const b0 = floor( back ).toVar();
			const f = fract( back ).toVar();
			const at = ( ox, oy ) => {

				const cx = clamp( b0.x.add( ox ), 0.0, SIZE - 1 );
				const cy = clamp( b0.y.add( oy ), 0.0, SIZE - 1 );
				return stateS.element( u.src.add( uint( cy.mul( SIZE ).add( cx ) ) ) );

			};
			const prev = mix(
				mix( at( 0, 0 ), at( 1, 0 ), f.x ),
				mix( at( 0, 1 ), at( 1, 1 ), f.x ), f.y ).toVar();

			out.assign( max( prev.mul( exp( u.dt.div( u.life ).negate() ) ), gen ) );

		} );

		stateS.element( u.dst.add( id ) ).assign( out );
		textureStore( tex, uvec2( ix, iy ), vec4( out, 0, 0, 1 ) );

	} )().compute( texels, [ 64 ] );

	step.name = 'breaker_foam';

	let flip = false;
	let pending = 0;

	return {

		tex,
		uniforms,
		center,
		span,

		/**
		 * Accumulate time, and step whenever a 30 Hz tick has gone by. `dt` is
		 * clamped on the way in: a tab that was hidden for a minute must advance
		 * the field by one step, not teleport it.
		 */
		update( renderer, dt ) {

			pending += Math.min( dt, 0.2 );
			if ( pending < 1 / HZ ) return;

			uniforms.dt.value = pending;
			pending = 0;
			uniforms.src.value = flip ? texels : 0;
			uniforms.dst.value = flip ? 0 : texels;
			flip = ! flip;
			renderer.compute( step );

		},

	};

}
