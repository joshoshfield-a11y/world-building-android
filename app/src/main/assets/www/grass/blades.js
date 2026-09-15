// GrassSystem — the GPU-driven heart of the field. 1024×1024 blades in one
// storage-buffer soup; per frame exactly two compute dispatches (reset the
// atomic instance counters, then the big per-blade update) fill an indirect
// draw-args buffer that three LOD meshes consume. The CPU never learns how
// many blades survived — the counts go straight into drawIndexedIndirect.
//
// Wind, trail and scale dynamics: a gust field
// with coverage + lull advected diagonally along the wind, per-blade critical
// damping, a cubic-Bézier response over blade scale (tall blades ride the
// wind, short ones barely move), and spatial scale/colour noise so the meadow
// grows in patches instead of salt-and-pepper.
//
// bladeState  vec4 : x offsetX · y offsetZ · z bendX|bendZ (12b|12b, ±6)
//                    w scale|origScale|cacheValid|visible (8b|8b|1b|1b)
// bladeTerrain f32 : positionNoise|offsetY|bakedShadow (4b|16b|4b)
// windState   vec2 : per-blade damped wind        density f32 : terrain cache

import * as THREE from 'three/webgpu';
import {
	Fn, If, Return, storage, instanceIndex, uniform, texture, bitcast,
	atomicAdd, atomicStore,
	float, int, uint, vec2, vec3, vec4,
	abs, min, max, clamp, mix, step, smoothstep, floor, fract,
	sin, cos, sqrt, length, dot, normalize, pow, select,
} from 'three/tsl';

import {
	config, TILE_SIZE, BLADES_PER_SIDE, SPACING,
	LOD_SEGMENTS, WORKGROUP_SIZE, BLADE_HEIGHT, MIN_VISIBLE_SCALE, SCALE_PACK_MAX,
} from './config.js';

// ---------------------------------------------------------------- TSL helpers

const pcg = /*@__PURE__*/ Fn( ( [ n ] ) => {

	const state = n.mul( uint( 747796405 ) ).add( uint( 2891336453 ) ).toVar();
	const word = state.shiftRight( state.shiftRight( uint( 28 ) ).add( uint( 4 ) ) ).bitXor( state ).mul( uint( 277803737 ) ).toVar();
	return word.shiftRight( uint( 22 ) ).bitXor( word );

} );

export const hash01 = ( n ) => float( pcg( n ) ).div( 4294967295.0 );

const hashCell = ( c ) => fract( sin( c.x.mul( 12.9898 ).add( c.y.mul( 78.233 ) ) ).mul( 43758.5453123 ) );

// lazily-built pack/unpack helpers
const q12 = ( v ) => uint( clamp( v.add( 6.0 ).div( 12.0 ), 0.0, 1.0 ).mul( 4095.0 ).add( 0.5 ) );
const un12 = ( bits ) => float( bits.bitAnd( uint( 4095 ) ) ).div( 4095.0 ).mul( 12.0 ).sub( 6.0 );
const packBend = ( bx, bz ) => bitcast( q12( bx ).shiftLeft( uint( 12 ) ).bitOr( q12( bz ) ), 'float' );

const q8 = ( v ) => uint( clamp( v.div( SCALE_PACK_MAX ), 0.0, 1.0 ).mul( 255.0 ).add( 0.5 ) );
const un8 = ( bits ) => float( bits.bitAnd( uint( 255 ) ) ).div( 255.0 ).mul( SCALE_PACK_MAX );

export const unpackScale = ( wBits ) => un8( wBits );
export const unpackOrigScale = ( wBits ) => un8( wBits.shiftRight( uint( 8 ) ) );
export const unpackBendX = ( zBits ) => un12( zBits.shiftRight( uint( 12 ) ) );
export const unpackBendZ = ( zBits ) => un12( zBits );

export class GrassSystem {

	constructor( terrain, windDirector, gustTex, lodCount ) {

		this.lodCount = lodCount; // 3, or 1 when indirect-first-instance is missing
		this.segments = lodCount === 3 ? LOD_SEGMENTS : [ 4 ];
		this.windDirector = windDirector;

		// tile extent is config so a composed scene can spread the same blade
		// budget over a larger field (config.terrain.tileSize defaults TILE_SIZE)
		this.tileSize = this.baseTile = config.terrain.tileSize || TILE_SIZE;
		this.bladesPerSide = config.terrain.bladesPerSide || BLADES_PER_SIDE;
		this.count = this.bladesPerSide * this.bladesPerSide;
		this.spacing = this.tileSize / this.bladesPerSide;

		// ------------------------------------------------------------ uniforms

		const u = this.u = {
			dt: uniform( 0 ),
			time: uniform( 0 ),
			playerXZ: uniform( new THREE.Vector2() ),   // tile anchor — the point the field wraps around
			tramplePos: uniform( new THREE.Vector2() ), // where feet actually are (== playerXZ unless the tile is pinned)
			playerDelta: uniform( new THREE.Vector2() ),
			playerGrounded: uniform( 1 ),
			camPos: uniform( new THREE.Vector3() ),
			vp: uniform( new THREE.Matrix4() ),
			p00: uniform( 1 ),
			p11: uniform( 1 ),

			lodR0Sq: uniform( 0 ),
			lodR1Sq: uniform( 0 ),

			thinFullSq: uniform( 0 ),
			thinFalloffSq: uniform( 0 ),
			farDensity: uniform( 0.1 ),
			projMin: uniform( 0.004 ),
			projFull: uniform( 0.022 ),
			hysteresis: uniform( 0.11 ),

			windDir: windDirector.directionU,
			windEvent: uniform( 0 ),       // strong-gust event, 0..1
			windStrength: uniform( 0.32 ),
			windSpeed: uniform( 0.18 ),
			windUvScale: uniform( 0.0135 ),
			windLull: uniform( 0.09 ),
			gustCoverage: uniform( 0.6 ),
			eddyStrength: uniform( 0.9 ),
			detailedRadius: uniform( 30 ),
			transitionWidth: uniform( 5 ),
			sway: uniform( 0.055 ),
			curveP1: uniform( 0.003 ),
			curveP2: uniform( 0.85 ),
			baseBending: uniform( 2.5 ),

			minScale: uniform( config.blade.minScale ),
			maxScale: uniform( config.blade.maxScale ),

			trampleRSq: uniform( 1 ),
			trampleR: uniform( 0.65 ),
			crushedScale: uniform( 0.15 ),
			downRate: uniform( 50 ),
			growthRate: uniform( 1.2 ),
			trailBendStrength: uniform( 0.8 ),

			terrainScale: uniform( config.terrain.worldScale ),
			heightMax: uniform( config.terrain.heightMax ),

			// The tile extent is a uniform, not a constant, because a fixed one
			// is only ever right for one viewing distance. See `setTileScale`.
			tileSize: uniform( this.tileSize ),
			halfTile: uniform( this.tileSize / 2 ),
			spacing: uniform( this.spacing ),
			rescale: uniform( 1 ),
		};

		// ------------------------------------------------------------- buffers

		this.bladeState = new THREE.StorageBufferAttribute( this._initialState(), 4 );
		this.bladeTerrain = new THREE.StorageBufferAttribute( new Float32Array( this.count ), 1 );
		this.windState = new THREE.StorageBufferAttribute( new Float32Array( this.count * 2 ), 2 );
		this.density = new THREE.StorageBufferAttribute( new Float32Array( this.count ), 1 );
		this.visibleIndices = new THREE.StorageBufferAttribute( new Uint32Array( this.count * this.lodCount ), 1 );

		// LOD_COUNT × [ indexCount, instanceCount, firstIndex, baseVertex, firstInstance ]
		const indirectInit = new Uint32Array( this.lodCount * 5 );

		for ( let lod = 0; lod < this.lodCount; lod ++ ) {

			const seg = this.segments[ lod ];
			indirectInit[ lod * 5 ] = ( seg - 1 ) * 6 + 3;   // indexCount — never cleared
			indirectInit[ lod * 5 + 4 ] = lod * this.count;       // firstInstance — the LOD trick

		}

		this.indirect = new THREE.IndirectStorageBufferAttribute( indirectInit, 1 );

		const stateS = storage( this.bladeState, 'vec4', this.count );
		const terrainS = storage( this.bladeTerrain, 'float', this.count );
		const windS = storage( this.windState, 'vec2', this.count );
		const densityS = storage( this.density, 'float', this.count );
		const visS = storage( this.visibleIndices, 'uint', this.count * this.lodCount );
		const countersA = storage( this.indirect, 'uint', this.lodCount * 5 ).toAtomic();

		// -------------------------------------------------- one-time GPU init:
		// spatial patches — scale and position noise come from a tileable noise
		// texture sampled in tile space, so tall/short and colour variation grow
		// in coherent patches instead of per-blade salt-and-pepper

		this.initNode = Fn( () => {

			const i = instanceIndex;
			const state = stateS.element( i );

			const tuv = vec2( state.x, state.y ).add( this.tileSize / 2 ).div( this.tileSize );
			const n = texture( gustTex, tuv.mul( 2.0 ) ).level( 0 ).toVar();

			const posNoise = n.g;
			const shaped = n.b.mul( n.b );
			const scale = mix( u.minScale, u.maxScale, shaped );

			state.w = bitcast(
				q8( scale ).bitOr( q8( scale ).shiftLeft( uint( 8 ) ) ),
				'float' );

			// posNoise into bladeTerrain bits 0..3 (offsetY/shadow filled at cache)
			terrainS.element( i ).assign( bitcast(
				uint( clamp( posNoise, 0.0, 1.0 ).mul( 15.0 ).add( 0.5 ) ), 'float' ) );

		} )().compute( this.count, [ WORKGROUP_SIZE ] );

		this.initNode.name = 'grass_init';

		// ------------------------------------------- dispatch 1: counter reset

		this.resetNode = Fn( () => {

			// unrolled at graph-build time; indexCount / firstInstance survive
			for ( let lod = 0; lod < this.lodCount; lod ++ ) {

				atomicStore( countersA.element( uint( lod * 5 + 1 ) ), uint( 0 ) );

			}

		} )().compute( 1, [ 1 ] );

		this.resetNode.name = 'grass_reset';

		// ------------------------------------------ tile rescale (rare, on demand)
		//
		// Offsets are stored in metres, so growing the tile means moving every
		// blade — one multiply, and then the terrain cache is void, because a
		// blade's cached height/shadow/density is a function of where it stands.
		// Invalidating is the whole cost and it is one frame of texture fetches,
		// which is why the scale is quantised and hysteretic rather than
		// continuous: a tile that resized every frame would refetch the bake for
		// two and a half million blades every frame.
		this.rescaleNode = Fn( () => {

			const state = stateS.element( instanceIndex );
			state.x = state.x.mul( u.rescale );
			state.y = state.y.mul( u.rescale );

			const wBits = bitcast( state.w, 'uint' );
			state.w = bitcast( wBits.bitAnd( uint( 0xfffeffff ) ), 'float' );   // clear cacheValid

		} )().compute( this.count, [ WORKGROUP_SIZE ] );

		this.rescaleNode.name = 'grass_rescale';

		// -------------------------------------------------------- wind helpers

		// cubic Bézier (P0=0, P3=1) over normalised blade scale — tall blades
		// respond to wind, short ones stay planted
		const windResponse = Fn( ( [ scaleY ] ) => {

			const t = clamp( scaleY.div( u.maxScale ), 0.0, 1.0 );
			const inv = float( 1.0 ).sub( t );
			return inv.mul( inv ).mul( t ).mul( 3.0 ).mul( u.curveP1 )
				.add( inv.mul( t ).mul( t ).mul( 3.0 ).mul( u.curveP2 ) )
				.add( t.mul( t ).mul( t ) );

		} );

		// gust field with coverage + lull, advected diagonally along the wind;
		// per-blade critical damping toward the veered target
		const computeWind = Fn( ( [ prevWind, worldXZ, posNoise, resetWind ] ) => {

			const baseDir = u.windDir;
			const perp = vec2( baseDir.y.negate(), baseDir.x );

			const scrollDir = perp.mul( 0.3717 ).sub( baseDir );
			const guv = worldXZ.mul( u.windUvScale ).add( scrollDir.mul( u.windSpeed.mul( u.time ) ) );
			const n = texture( gustTex, guv ).level( 0 ).toVar();

			const fastGust = sin( n.g.mul( 18.85 ) ).mul( 0.5 ).add( 0.5 );
			const gustField = mix( n.r, fastGust, u.windEvent );
			const gustStart = float( 1.0 ).sub( u.gustCoverage );
			const gust = smoothstep( gustStart, gustStart.add( 0.25 ), gustField ).toVar();

			const windFactor = u.windStrength
				.mul( mix( u.windLull, 1.0, gust ) )
				.mul( mix( 1.0, 4.0, u.windEvent ) );

			const veer = n.g.sub( 0.5 ).mul( 2.0 ).mul( u.eddyStrength );
			const target = baseDir.add( perp.mul( veer ) ).mul( windFactor );

			const rate = mix( 3.5, 11.0, posNoise ).mul( mix( 0.3, 1.0, gust ) );
			const damped = prevWind.add( target.sub( prevWind ).mul( min( rate.mul( u.dt ), 1.0 ) ) );

			return vec3( mix( damped, target, resetWind ), gust );

		} );

		// near-field deformation: damped wind + enveloped ambient sway + flutter
		const bladeDeformation = Fn( ( [ windXZ, gust, worldXZ, scaleY, seed ] ) => {

			const instanceNoise = seed.mul( 0.25 ).sub( 0.125 );
			const spriteNoise = fract( seed.mul( 31.7 ) ).mul( 2.0 ).sub( 1.0 );
			const resp = windResponse( scaleY ).toVar();

			const windBend = clamp( dot( windXZ, windXZ ).mul( 3.5 ), 0.0, 1.0 );
			const windNoiseShade = smoothstep( 0.2, 1.0, gust );
			const windNoiseFactor = max( windBend, windNoiseShade.mul( 0.45 ) ).toVar();
			const swayEnvelope = mix( 0.75, 1.35, windNoiseFactor ).toVar();

			const randomPhase = instanceNoise.mul( 25.13 );
			const heightPhase = swayEnvelope.mul( 0.55 );
			const swayRate = spriteNoise.mul( 0.375 ).add( 1.075 ); // remap −1..1 → 0.7..1.45

			const swayA = sin( u.time.mul( swayRate.mul( 1.35 ) ).add( randomPhase ).add( heightPhase ) );
			const swayB = sin( u.time.mul( swayRate.mul( 2.15 ) )
				.add( worldXZ.x.mul( 0.17 ) ).add( worldXZ.y.mul( 0.11 ) )
				.add( randomPhase.mul( 1.7 ) ).add( heightPhase.mul( 1.6 ) ) ).mul( 0.45 );

			const ambientAngle = fract( seed.mul( 53.3 ) ).mul( 6.28318 );
			const ambientOffset = vec2( cos( ambientAngle ), sin( ambientAngle ) )
				.mul( swayA.add( swayB ).mul( u.sway ).mul( swayEnvelope ) );

			const perpWind = vec2( u.windDir.y.negate(), u.windDir.x );
			const bendStrength = u.baseBending.mul( resp );

			const flutterPhase = fract( seed.mul( 97.13 ) ).mul( 6.28318 )
				.add( worldXZ.x.mul( 0.13 ) ).add( worldXZ.y.mul( 0.07 ) );
			const flutter = sin( u.time.mul( u.windSpeed.mul( 1.7 ) )
				.add( flutterPhase.mul( 1.3 ) ).add( heightPhase.mul( 2.2 ) ) )
				.mul( 0.025 ).mul( windNoiseFactor ).mul( bendStrength );

			return windXZ.mul( bendStrength )
				.add( ambientOffset.mul( resp ) )
				.add( perpWind.mul( flutter ) );

		} );

		// far field: pure analytic — no buffer read, no state
		const distantWind = Fn( ( [ worldXZ ] ) => {

			const phase = worldXZ.x.mul( 0.035 ).add( worldXZ.y.mul( 0.025 ) ).add( u.time.mul( u.windSpeed.mul( 2.2 ) ) );
			const gust = sin( phase ).mul( 0.5 ).add( 0.5 );
			const windFactor = u.windStrength
				.mul( mix( u.windLull, 1.0, gust ) )
				.mul( mix( 1.0, 4.0, u.windEvent ) );

			return vec3( u.windDir.mul( windFactor ), gust );

		} );

		const distantDeformation = Fn( ( [ windXZ, gust, scaleY ] ) => {

			const resp = windResponse( scaleY );
			const perpWind = vec2( u.windDir.y.negate(), u.windDir.x );
			const broadSway = gust.sub( 0.5 ).mul( u.sway.mul( 0.7 ) );

			return windXZ.mul( u.baseBending.mul( resp ) )
				.add( perpWind.mul( broadSway.mul( resp ) ) );

		} );

		// ----------------------------------------- dispatch 2: per-blade update

		const terrainMap = terrain.map;

		this.updateNode = Fn( () => {

			const i = instanceIndex;
			const state = stateS.element( i );

			// -------- unpack
			const zBits = bitcast( state.z, 'uint' ).toVar();
			const wBits = bitcast( state.w, 'uint' ).toVar();

			const scale = un8( wBits ).toVar();
			const origScale = un8( wBits.shiftRight( uint( 8 ) ) ).toVar();
			const cacheValid = wBits.shiftRight( uint( 16 ) ).bitAnd( uint( 1 ) ).toVar();
			const prevVisible = wBits.shiftRight( uint( 17 ) ).bitAnd( uint( 1 ) ).toVar();

			const off = vec2( state.x, state.y ).toVar();

			// -------- 1. wrap the tile around the player. Floored wrap via
			// fract(), NOT mod(): WGSL % truncates toward zero, so a mod-wrap
			// never folds blades crossing the negative edge back to the far
			// side — they leak out of the tile and edge-cull forever, thinning
			// the field on whichever side the anchor moves toward
			const HALF = u.halfTile;
			const preWrap = off.sub( u.playerDelta ).toVar();
			off.assign( preWrap.add( HALF ).div( u.tileSize ).fract().mul( u.tileSize ).sub( HALF ) );

			const teleported = max( abs( off.x.sub( preWrap.x ) ), abs( off.y.sub( preWrap.y ) ) ).greaterThan( HALF );
			cacheValid.assign( select( teleported, uint( 0 ), cacheValid ) );

			const tBits = bitcast( terrainS.element( i ), 'uint' ).toVar();
			const offsetY = float( tBits.shiftRight( uint( 4 ) ).bitAnd( uint( 65535 ) ) ).div( 65535.0 ).mul( u.heightMax ).toVar();

			const worldXZ = off.add( u.playerXZ ).toVar();
			const world = vec3( worldXZ.x, offsetY, worldXZ.y ).toVar();

			// -------- 1b. terrain cache — refreshed the moment a blade wraps to
			// a new world position, BEFORE any visibility early-out. Gating the
			// refresh on visibility dead-locks: a stale zero density crushes the
			// scale, zero scale fails the projected-size keep, and the invisible
			// blade never reaches the refresh again — permanently bald ground
			// wherever the tile once crossed water or sand. Cache data is a pure
			// function of world position, so wrap is the only invalidation, and
			// steady state still touches no texture.
			const posNoise = float( tBits.bitAnd( uint( 15 ) ) ).div( 15.0 ).toVar();
			const bakedShadow = float( tBits.shiftRight( uint( 20 ) ).bitAnd( uint( 15 ) ) ).div( 15.0 ).toVar();

			If( cacheValid.equal( uint( 0 ) ), () => {

				const tuv = worldXZ.div( u.terrainScale );
				const tv = texture( terrainMap, tuv ).level( 0 ).toVar();

				offsetY.assign( tv.x.mul( u.heightMax ) );
				world.y.assign( offsetY );
				bakedShadow.assign( tv.z );
				densityS.element( i ).assign( tv.y );

				tBits.assign(
					uint( clamp( posNoise, 0.0, 1.0 ).mul( 15.0 ).add( 0.5 ) )
						.bitOr( uint( clamp( tv.x, 0.0, 1.0 ).mul( 65535.0 ).add( 0.5 ) ).shiftLeft( uint( 4 ) ) )
						.bitOr( uint( clamp( bakedShadow, 0.0, 1.0 ).mul( 15.0 ).add( 0.5 ) ).shiftLeft( uint( 20 ) ) ) );

				terrainS.element( i ).assign( bitcast( tBits, 'float' ) );
				cacheValid.assign( uint( 1 ) );

			} );

			const storeState = ( visibleU ) => {

				state.assign( vec4(
					off.x, off.y,
					packBend( un12( zBits.shiftRight( uint( 12 ) ) ), un12( zBits ) ),
					bitcast(
						q8( scale )
							.bitOr( q8( origScale ).shiftLeft( uint( 8 ) ) )
							.bitOr( cacheValid.shiftLeft( uint( 16 ) ) )
							.bitOr( visibleU.shiftLeft( uint( 17 ) ) ),
						'float' ),
				) );

			};

			// -------- 2. frustum cull (bounding sphere in clip space)
			const radius = float( BLADE_HEIGHT * 1.4 ).add( 1.2 ).toVar();
			const center = world.add( vec3( 0.0, BLADE_HEIGHT * 0.8, 0.0 ) );
			const c = u.vp.mul( vec4( center, 1.0 ) ).toVar();

			const padX = radius.mul( u.p00 );
			const padY = radius.mul( u.p11 );
			const wPos = max( c.w, 1e-4 );

			const inFrustum = c.w.greaterThan( radius.negate() )
				.and( abs( c.x ).lessThan( wPos.add( padX ) ) )
				.and( c.y.greaterThan( wPos.negate().sub( padY.mul( 2.0 ) ) ) )
				.and( c.y.lessThan( wPos.add( padY ) ) )
				.and( c.z.lessThan( wPos.add( radius ) ) );

			If( inFrustum.not(), () => {

				storeState( uint( 0 ) );
				Return();

			} );

			// -------- 3. stochastic thinning with hysteresis
			const toCam = world.sub( u.camPos ).toVar();
			const d2 = dot( toCam, toCam ).toVar();
			const dist = sqrt( d2 ).toVar();

			const distanceKeep = mix( 1.0, u.farDensity,
				clamp( d2.sub( u.thinFullSq ).div( u.thinFalloffSq.sub( u.thinFullSq ) ), 0.0, 1.0 ) );

			// projected height as a viewport fraction, using the POTENTIAL scale
			// (orig × fresh density) — the current scale can be transiently
			// crushed (trample, growth) and must not gate visibility. Floored
			// for near blades: seen from above a vertical blade subtends ~zero
			// height — without the floor an elevated camera strips the ground
			// directly beneath it bald
			const baseScale = origScale.mul( densityS.element( i ) ).toVar();
			const projected = u.p11.mul( baseScale.mul( BLADE_HEIGHT ) ).div( dist );
			const nearKeep = float( 1.0 ).sub( smoothstep( 30.0, 60.0, dist ) );
			const screenKeep = max( smoothstep( u.projMin, u.projFull, projected ), nearKeep );

			// Fade the field out at the tile boundary — and the shape of that
			// boundary is the whole point. `max(|off.x|, |off.y|)` is the square
			// the blades are actually stored in, and a square edge seen in
			// perspective is a pair of straight lines converging to a vanishing
			// point: from any raised camera the meadow ended along a hard
			// diagonal and the field read as a triangular patch of grass laid on
			// the hillside. A *radial* boundary is a circle centred on the lens,
			// which is what a draw distance looks like — it has no corners to
			// find and does not turn when you do. It costs the corners of the
			// tile (21% of the blades) and is worth every one of them.
			//
			// The fade is a wide band, and `keep` is
			// resolved against a per-cell hash below, so the boundary dissolves
			// stochastically instead of stepping.
			const edge = length( off );
			const edgeKeep = float( 1.0 ).sub( smoothstep( HALF.mul( 0.70 ), HALF, edge ) );

			const keep = distanceKeep.mul( screenKeep ).mul( edgeKeep ).toVar();

			const cell = floor( worldXZ.div( u.spacing ) );
			const threshold = hashCell( cell ).mul( 0.999 ).toVar();
			const wasVisible = prevVisible.equal( uint( 1 ) ).and( teleported.not() );
			const enter = step( clamp( threshold.add( u.hysteresis ), 0.0, 1.0 ), keep );
			const stay = step( clamp( threshold.sub( u.hysteresis ), 1e-4, 1.0 ), keep );
			const visNow = select( wasVisible, stay, enter ).greaterThan( 0.5 ).toVar();

			If( visNow.not(), () => {

				storeState( uint( 0 ) );
				Return();

			} );

			// -------- 5. density mask
			If( baseScale.lessThan( MIN_VISIBLE_SCALE ), () => {

				storeState( uint( 0 ) );
				Return();

			} );

			// -------- 6. scale dynamics: recovery + trampling
			const didAppear = select( prevVisible.equal( uint( 0 ) ), 1.0, 0.0 );
			const shouldReset = max( select( teleported, 1.0, 0.0 ), didAppear ).toVar();

			const recovered = mix( scale, baseScale, min( u.growthRate.mul( u.dt ), 1.0 ) );
			const scaleBeforeTrail = mix( recovered, baseScale, shouldReset );

			const toPlayer = worldXZ.sub( u.tramplePos ).toVar();
			const dp2 = dot( toPlayer, toPlayer ).toVar();
			const contact = float( 1.0 ).sub( smoothstep( 0.0, u.trampleRSq, dp2 ) ).mul( u.playerGrounded );

			const crushed = min( baseScale, u.crushedScale );
			scale.assign( mix( scaleBeforeTrail, crushed, min( u.downRate.mul( contact ).mul( u.dt ), 1.0 ) ) );

			const trailDir = toPlayer.mul( u.trampleR ).div( max( dp2, u.trampleRSq ) );
			const trailAmount = clamp( float( 1.0 ).sub( scale.div( max( baseScale, MIN_VISIBLE_SCALE ) ) ), 0.0, 1.0 );
			const trailBend = trailDir.mul( trailAmount ).mul( u.trailBendStrength );

			// -------- 7. wind — damped near field, analytic far field, blended band
			const seed = hash01( i );
			const bendXZ = vec2( 0.0 ).toVar();

			const inner = u.detailedRadius;
			const innerSq = inner.mul( inner );
			const outer = inner.add( u.transitionWidth );
			const outerSq = outer.mul( outer );

			If( d2.greaterThan( outerSq ), () => {

				const far = distantWind( worldXZ ).toVar();
				bendXZ.assign( distantDeformation( clamp( far.xy, - 2.0, 2.0 ), far.z, scale ) );

			} ).Else( () => {

				const nw = computeWind( windS.element( i ), worldXZ, posNoise, shouldReset ).toVar();
				const windXZ = clamp( nw.xy, - 2.0, 2.0 );
				windS.element( i ).assign( windXZ );

				const detailed = bladeDeformation( windXZ, nw.z, worldXZ, scale, seed ).toVar();

				If( d2.greaterThan( innerSq ), () => {

					const far = distantWind( worldXZ ).toVar();
					const farBend = distantDeformation( clamp( far.xy, - 2.0, 2.0 ), far.z, scale );
					detailed.assign( mix( detailed, farBend, smoothstep( innerSq, outerSq, d2 ) ) );

				} );

				bendXZ.assign( detailed );

			} );

			const bend = bendXZ.add( trailBend );
			zBits.assign( bitcast( packBend( clamp( bend.x, - 6.0, 6.0 ), clamp( bend.y, - 6.0, 6.0 ) ), 'uint' ) );

			// -------- 8. LOD select, branchlessly
			const lodF = step( u.lodR0Sq, d2 ).add( step( u.lodR1Sq, d2 ) );
			const lod = ( this.lodCount === 3 ? uint( lodF ) : uint( 0 ) ).toVar();

			// -------- 9. append to this LOD's visible list
			const slot = atomicAdd( countersA.element( lod.mul( uint( 5 ) ).add( uint( 1 ) ) ), uint( 1 ) ).toVar();
			visS.element( lod.mul( uint( this.count ) ).add( slot ) ).assign( i );

			storeState( uint( 1 ) );

		} )().compute( this.count, [ WORKGROUP_SIZE ] );

		this.updateNode.name = 'grass_update';

	}

	// grid-anchored offsets with deterministic jitter; scale patches are filled
	// in by the GPU init pass
	_initialState() {

		const buf = new ArrayBuffer( this.count * 4 * 4 );
		const view = new DataView( buf );

		let seed = 8675309;
		const rand = () => ( seed = ( seed * 48271 ) % 2147483647 ) / 2147483647;

		const HALF = this.tileSize / 2;
		const SP = this.spacing;
		const zeroBend = ( 2048 << 12 ) | 2048;

		for ( let i = 0; i < this.count; i ++ ) {

			const gx = i % this.bladesPerSide;
			const gz = Math.floor( i / this.bladesPerSide );

			const ox = ( gx + 0.5 ) * SP - HALF + ( rand() - 0.5 ) * SP * 1.4;
			const oz = ( gz + 0.5 ) * SP - HALF + ( rand() - 0.5 ) * SP * 1.4;

			const o = i * 16;
			view.setFloat32( o, ox, true );
			view.setFloat32( o + 4, oz, true );
			view.setUint32( o + 8, zeroBend, true );
			view.setUint32( o + 12, 0, true );

		}

		return new Float32Array( buf );

	}

	init( renderer ) {

		renderer.compute( this.initNode );

	}

	// Grow or shrink the field. `want` is the extent in metres the caller would
	// like; it is snapped to the nearest half-octave step so the field settles
	// on a small set of sizes and stops resizing the moment the camera stops
	// climbing. Returns the size actually in force.
	//
	// Blade count is fixed, so this trades spacing for reach: at the base size
	// 12.5 cm, four steps up 50 cm — invisible from the altitude
	// that asked for it, and the alternative is a field that stops in mid-air.
	setTileScale( renderer, want ) {

		// one step up only once the ask is comfortably past the current size, and
		// back down only once it is comfortably under: the deadband is what keeps
		// a camera hovering on a boundary from rescaling — and re-caching — the
		// whole field on alternate frames
		const step = Math.SQRT2;
		let size = this.tileSize;
		if ( want > size * 1.25 ) size = Math.min( this.baseTile * 8, size * step );
		else if ( want < size / ( step * 1.25 ) ) size = Math.max( this.baseTile, size / step );

		if ( Math.abs( size - this.tileSize ) < 1e-3 ) return this.tileSize;

		this.u.rescale.value = size / this.tileSize;
		renderer.compute( this.rescaleNode );

		this.tileSize = size;
		this.spacing = size / this.bladesPerSide;
		this.u.tileSize.value = size;
		this.u.halfTile.value = size / 2;
		this.u.spacing.value = this.spacing;

		return size;

	}

	syncUniforms( camera ) {

		const u = this.u;

		u.lodR0Sq.value = config.lod.radii[ 0 ] ** 2;
		u.lodR1Sq.value = config.lod.radii[ 1 ] ** 2;

		u.thinFullSq.value = config.thinning.fullRadius ** 2;
		u.thinFalloffSq.value = config.thinning.falloffRadius ** 2;
		u.farDensity.value = config.thinning.farDensity;
		u.projMin.value = config.thinning.projMin;
		u.projFull.value = config.thinning.projFull;
		u.hysteresis.value = config.thinning.hysteresis;

		u.windStrength.value = config.wind.strength;
		u.windSpeed.value = config.wind.speed;
		u.windUvScale.value = config.wind.uvScale;
		u.windLull.value = config.wind.lull;
		u.gustCoverage.value = config.wind.gustCoverage;
		u.eddyStrength.value = config.wind.eddyStrength;
		u.detailedRadius.value = config.wind.detailedRadius;
		u.transitionWidth.value = config.wind.transitionWidth;
		u.sway.value = config.wind.swayAmount;
		u.curveP1.value = config.wind.curveP1;
		u.curveP2.value = config.wind.curveP2;
		u.baseBending.value = config.wind.baseBending;
		u.minScale.value = config.blade.minScale;
		u.maxScale.value = config.blade.maxScale;

		// strong director phases double as directional wind events
		u.windEvent.value = THREE.MathUtils.smoothstep( this.windDirector.level, 0.6, 0.98 );

		u.trampleRSq.value = config.trample.radius ** 2;
		u.trampleR.value = config.trample.radius;
		u.crushedScale.value = config.trample.crushedScale;
		u.downRate.value = config.trample.downRate;
		u.growthRate.value = config.trample.growthRate;
		u.trailBendStrength.value = config.trample.bendStrength;

		u.camPos.value.copy( camera.position );
		u.vp.value.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse );
		u.p00.value = camera.projectionMatrix.elements[ 0 ];
		u.p11.value = camera.projectionMatrix.elements[ 5 ];

	}

	// the whole per-frame simulation: exactly two dispatches
	update( renderer, dt, t ) {

		this.u.dt.value = dt;
		this.u.time.value = t;

		renderer.compute( this.resetNode );
		renderer.compute( this.updateNode );

	}

}
