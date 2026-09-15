// OceanSim — owns every GPU resource of the wave simulation and the per-frame
// dispatch sequence. The CPU evolves nothing: it only bumps two uniforms (t, dt)
// and issues the submits.
//
// Per frame:  1 evolve  +  2·log2(N) butterfly steps (one submit each, mandatory)
//             + 1 assembly submit (3 cascade nodes sharing a pass — they read the
//               same FFT output and write disjoint textures).
// The (−1)^(x+y) centred-spectrum permute is folded into assembly.

import * as THREE from 'three/webgpu';
import {
	Fn, storage, instanceIndex, uniform, textureStore,
	uint, int, float, vec2, vec4, uvec2,
	cos, sin, min, max,
} from 'three/tsl';

import { IFFT } from './fft.js';
import {
	makeGaussianNoise, makeLayerUniforms, syncLayerUniforms,
	makeSpectrumNode, makePackNode, cascadeCutoffs,
} from './spectrum.js';

const FIELDS = 4; // DxDz, DyDxz, DyxDyz, DxxDzz — 8 real fields on 4 IFFTs

const cmul = /*@__PURE__*/ Fn( ( [ a, b ] ) => vec2(
	a.x.mul( b.x ).sub( a.y.mul( b.y ) ),
	a.x.mul( b.y ).add( a.y.mul( b.x ) ),
) );

// pack two real spatial fields A, B as the complex signal A + iB
const packAB = /*@__PURE__*/ Fn( ( [ a, b ] ) => vec2(
	a.x.sub( b.y ),
	a.y.add( b.x ),
) );

export class OceanSim {

	constructor( config ) {

		const N = this.size = config.sim.size;
		this.cascades = config.sim.lengthScales.length;
		this.config = config;

		const texels = N * N;
		const total = this.cascades * texels;

		// ------------------------------------------------------------ uniforms

		this.timeU = uniform( 0 );
		this.dtU = uniform( 0 );
		this.lambdaU = uniform( config.waves.lambda );
		this.foamDecayU = uniform( config.foam.decay );
		this.gU = uniform( config.waves.g );
		this.depthU = uniform( config.waves.depth );

		this.localU = makeLayerUniforms();
		this.swellU = makeLayerUniforms();

		this.cascadeU = [];

		for ( let i = 0; i < this.cascades; i ++ ) {

			this.cascadeU.push( {
				index: i,
				dk: uniform( 0 ),
				cutLow: uniform( 0 ),
				cutHigh: uniform( 0 ),
			} );

		}

		// ------------------------------------------------------------- buffers

		this.noiseBuf = new THREE.StorageBufferAttribute( makeGaussianNoise( N ), 2 );
		this.h0kBuf = new THREE.StorageBufferAttribute( new Float32Array( total * 2 ), 2 );
		this.h0Buf = new THREE.StorageBufferAttribute( new Float32Array( total * 4 ), 4 );
		this.wavesBuf = new THREE.StorageBufferAttribute( new Float32Array( total * 4 ), 4 );

		const turbInit = new Float32Array( total ).fill( 1.0 );
		this.turbBuf = new THREE.StorageBufferAttribute( turbInit, 1 );

		this.ifft = new IFFT( { size: N, slices: this.cascades * FIELDS } );

		const noiseS = storage( this.noiseBuf, 'vec2', texels );
		const h0kS = storage( this.h0kBuf, 'vec2', total );
		const h0S = storage( this.h0Buf, 'vec4', total );
		const wavesS = storage( this.wavesBuf, 'vec4', total );
		const turbS = storage( this.turbBuf, 'float', total );
		const fieldS = storage( this.ifft.field, 'vec2', this.cascades * FIELDS * texels );

		// ------------------------------------------------------------ textures

		this.displacementMaps = [];
		this.derivativeMaps = [];

		for ( let i = 0; i < this.cascades; i ++ ) {

			this.displacementMaps.push( this._makeMap( N ) );
			this.derivativeMaps.push( this._makeMap( N ) );

		}

		// ------------------------------------------------- initial spectrum pass

		const shared = { g: this.gU, depth: this.depthU, local: this.localU, swell: this.swellU, noiseS, h0kS, h0S, wavesS };

		this.spectrumNodes = this.cascadeU.map( ( c ) => makeSpectrumNode( c, N, shared ) );
		this.packNode = makePackNode( N, this.cascades, shared );

		// ------------------------------------------------------- evolve to time t

		const timeU = this.timeU;

		this.evolveNode = Fn( () => {

			const id = instanceIndex;
			const c = id.div( uint( texels ) );
			const rem = id.sub( c.mul( uint( texels ) ) );

			const h0v = h0S.element( id ).toVar();
			const wd = wavesS.element( id ).toVar();

			const kx = wd.x, invK = wd.y, kz = wd.z, omega = wd.w;

			const phase = omega.mul( timeU );
			const e = vec2( cos( phase ), sin( phase ) ).toVar();

			const h = cmul( h0v.xy, e ).add( cmul( h0v.zw, vec2( e.x, e.y.negate() ) ) ).toVar();
			const ih = vec2( h.y.negate(), h.x ).toVar();

			const Dx = ih.mul( kx.mul( invK ) ).toVar();
			const Dz = ih.mul( kz.mul( invK ) ).toVar();
			const dDyx = ih.mul( kx ).toVar();
			const dDyz = ih.mul( kz ).toVar();
			const nH = h.negate().toVar();
			const dDxx = nH.mul( kx.mul( kx ).mul( invK ) ).toVar();
			const dDzz = nH.mul( kz.mul( kz ).mul( invK ) ).toVar();
			const dDzx = nH.mul( kx.mul( kz ).mul( invK ) ).toVar();

			const base = c.mul( uint( FIELDS * texels ) ).add( rem );

			fieldS.element( base ).assign( packAB( Dx, Dz ) );
			fieldS.element( base.add( uint( texels ) ) ).assign( packAB( h, dDzx ) );
			fieldS.element( base.add( uint( 2 * texels ) ) ).assign( packAB( dDyx, dDyz ) );
			fieldS.element( base.add( uint( 3 * texels ) ) ).assign( packAB( dDxx, dDzz ) );

		} )().compute( total, [ 64 ] );

		this.evolveNode.name = 'evolve';

		// --------------------------------------- map assembly + foam turbulence

		const lambdaU = this.lambdaU;
		const foamDecayU = this.foamDecayU;
		const dtU = this.dtU;

		this.assemblyNodes = [];

		for ( let ci = 0; ci < this.cascades; ci ++ ) {

			const dispTex = this.displacementMaps[ ci ];
			const derivTex = this.derivativeMaps[ ci ];

			const node = Fn( () => {

				const id = instanceIndex;
				const y = id.div( uint( N ) );
				const x = id.sub( y.mul( uint( N ) ) );

				// centred-spectrum permute, folded in here
				const sign = float( 1.0 ).sub( float( x.add( y ).bitAnd( uint( 1 ) ) ).mul( 2.0 ) );

				const base = uint( ci * FIELDS * texels ).add( id );

				const f0 = fieldS.element( base ).mul( sign ).toVar();                          // Dx, Dz
				const f1 = fieldS.element( base.add( uint( texels ) ) ).mul( sign ).toVar();    // Dy, dDz/dx
				const f2 = fieldS.element( base.add( uint( 2 * texels ) ) ).mul( sign ).toVar(); // dDy/dx, dDy/dz
				const f3 = fieldS.element( base.add( uint( 3 * texels ) ) ).mul( sign ).toVar(); // dDx/dx, dDz/dz

				// breaking-wave foam from the displacement Jacobian
				const jxx = f3.x.mul( lambdaU ).add( 1.0 );
				const jzz = f3.y.mul( lambdaU ).add( 1.0 );
				const jxz = f1.y.mul( lambdaU );
				const J = jxx.mul( jzz ).sub( jxz.mul( jxz ) ).toVar();

				const turbIdx = uint( ci * texels ).add( id );
				const prev = turbS.element( turbIdx );
				const turb = min( J, prev.add( dtU.mul( foamDecayU ).div( max( J, 0.5 ) ) ) ).toVar();
				turbS.element( turbIdx ).assign( turb );

				textureStore( dispTex, uvec2( x, y ), vec4( f0.x.mul( lambdaU ), f1.x, f0.y.mul( lambdaU ), turb ) );
				textureStore( derivTex, uvec2( x, y ), vec4( f2.x, f2.y, f3.x.mul( lambdaU ), f3.y.mul( lambdaU ) ) );

			} )().compute( texels, [ 64 ] );

			node.name = `assembly_c${ ci }`;
			this.assemblyNodes.push( node );

		}

		this.syncSpectrumUniforms();

	}

	_makeMap( N ) {

		const tex = new THREE.StorageTexture( N, N );
		tex.type = THREE.HalfFloatType;
		tex.format = THREE.RGBAFormat;
		tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
		tex.magFilter = THREE.LinearFilter;
		tex.minFilter = THREE.LinearMipmapLinearFilter;
		tex.generateMipmaps = true;
		return tex;

	}

	// CPU-side derived values → uniforms (α, ω_p, cascade bands)
	syncSpectrumUniforms() {

		const cfg = this.config;
		const g = cfg.waves.g;

		this.gU.value = g;
		this.depthU.value = cfg.waves.depth;
		this.lambdaU.value = cfg.waves.lambda;
		this.foamDecayU.value = cfg.foam.decay;

		syncLayerUniforms( this.localU, cfg.waves.local, g );
		syncLayerUniforms( this.swellU, cfg.waves.swell, g );

		const cuts = cascadeCutoffs( cfg.sim.lengthScales, cfg.sim.boundaryFactor );

		for ( let i = 0; i < this.cascades; i ++ ) {

			this.cascadeU[ i ].dk.value = 2 * Math.PI / cfg.sim.lengthScales[ i ];
			this.cascadeU[ i ].cutLow.value = cuts[ i ].low;
			this.cascadeU[ i ].cutHigh.value = cuts[ i ].high;

		}

	}

	// h₀ bake — start-up and on any spectrum parameter change
	computeInitialSpectrum( renderer ) {

		this.syncSpectrumUniforms();
		renderer.compute( this.spectrumNodes );
		renderer.compute( this.packNode );

	}

	// the per-frame pipeline — 18 submits total at N = 256
	update( renderer, dt ) {

		this.timeU.value += dt;
		this.dtU.value = dt;

		renderer.compute( this.evolveNode );   // 1 submit
		this.ifft.dispatch( renderer );        // 2·log2(N) submits, one per step
		renderer.compute( this.assemblyNodes );// 1 submit

	}

	validateFFT( renderer ) {

		return this.ifft.validate( renderer );

	}

}
