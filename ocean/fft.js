// Radix-2 Stockham inverse FFT over a stack of independent N×N complex slices,
// all living in one big storage buffer so every (cascade, field) pair shares a
// single dispatch per butterfly step. WebGPU has no memory barrier between
// dispatches inside one compute pass, so each step is its own renderer.compute()
// submit; grouping the slices is what keeps that to 2·log2(N) submits total.

import * as THREE from 'three/webgpu';
import {
	Fn, storage, instanceIndex, uniform,
	uint, int, float, vec2, vec4, select,
} from 'three/tsl';

const cmul = /*@__PURE__*/ Fn( ( [ a, b ] ) => vec2(
	a.x.mul( b.x ).sub( a.y.mul( b.y ) ),
	a.x.mul( b.y ).add( a.y.mul( b.x ) ),
) );

// Butterfly table: for each (step, column) → ( twiddle.re, twiddle.im, idxA, idxB ).
// Forward-FFT twiddles; the kernel conjugates at read time to invert.
export function makeButterflyTable( N ) {

	const logN = Math.log2( N );
	const table = new Float32Array( logN * N * 4 );

	for ( let step = 0; step < logN; step ++ ) {

		const b = N >> ( step + 1 );

		for ( let j = 0; j < N / 2; j ++ ) {

			const i = ( 2 * b * Math.floor( j / b ) + ( j % b ) ) % N;
			const X = Math.floor( j / b ) * b;
			const twRe = Math.cos( 2 * Math.PI * X / N );
			const twIm = - Math.sin( 2 * Math.PI * X / N );

			let o = ( step * N + j ) * 4;
			table[ o ] = twRe; table[ o + 1 ] = twIm; table[ o + 2 ] = i; table[ o + 3 ] = i + b;

			o = ( step * N + j + N / 2 ) * 4;
			table[ o ] = - twRe; table[ o + 1 ] = - twIm; table[ o + 2 ] = i; table[ o + 3 ] = i + b;

		}

	}

	return table;

}

export class IFFT {

	constructor( { size, slices, workgroupSize = 64 } ) {

		const N = this.size = size;
		this.slices = slices;
		this.logN = Math.log2( N );

		const texels = N * N;
		const total = slices * texels;

		this.field = new THREE.StorageBufferAttribute( new Float32Array( total * 2 ), 2 );
		this.scratch = new THREE.StorageBufferAttribute( new Float32Array( total * 2 ), 2 );
		this.butterfly = new THREE.StorageBufferAttribute( makeButterflyTable( N ), 4 );

		const fieldS = storage( this.field, 'vec2', total );
		const scratchS = storage( this.scratch, 'vec2', total );
		const butterflyS = storage( this.butterfly, 'vec4', this.logN * N );

		// One compute node per butterfly step, ping-ponging field <-> scratch.
		// 2·logN steps (an even count), so the result always lands back in `field`.
		this.stepNodes = [];

		for ( let overall = 0; overall < 2 * this.logN; overall ++ ) {

			const horizontal = overall < this.logN;
			const step = horizontal ? overall : overall - this.logN;
			const src = ( overall % 2 === 0 ) ? fieldS : scratchS;
			const dst = ( overall % 2 === 0 ) ? scratchS : fieldS;

			const node = Fn( () => {

				const id = instanceIndex;
				const slice = id.div( uint( texels ) );
				const rem = id.sub( slice.mul( uint( texels ) ) );
				const y = rem.div( uint( N ) );
				const x = rem.sub( y.mul( uint( N ) ) );

				const col = horizontal ? x : y;
				const data = butterflyS.element( uint( step * N ).add( col ) );

				// conjugate the stored forward twiddle → inverse transform
				const tw = vec2( data.x, data.y.negate() );
				const ia = uint( data.z );
				const ib = uint( data.w );

				const base = slice.mul( uint( texels ) );
				const idxA = horizontal ? base.add( y.mul( uint( N ) ) ).add( ia ) : base.add( ia.mul( uint( N ) ) ).add( x );
				const idxB = horizontal ? base.add( y.mul( uint( N ) ) ).add( ib ) : base.add( ib.mul( uint( N ) ) ).add( x );

				const a = src.element( idxA ).toVar();
				const bv = src.element( idxB ).toVar();

				dst.element( id ).assign( a.add( cmul( tw, bv ) ) );

			} )().compute( total, [ workgroupSize ] );

			node.name = `ifft_${ horizontal ? 'h' : 'v' }${ step }`;
			this.stepNodes.push( node );

		}

		// Validation impulse writer (slice 0 only). Mode is a uniform texel index.
		this.impulseIndex = uniform( 0, 'uint' );
		const impulseIndex = this.impulseIndex;

		this.impulseNode = Fn( () => {

			const hit = instanceIndex.equal( impulseIndex );
			fieldS.element( instanceIndex ).assign( select( hit, vec2( 1, 0 ), vec2( 0, 0 ) ) );

		} )().compute( texels, [ workgroupSize ] );

	}

	// One renderer.compute() submit per step — mandatory, steps race otherwise.
	dispatch( renderer ) {

		for ( const node of this.stepNodes ) renderer.compute( node );

	}

	// Mandatory correctness gate. Runs the exact runtime step nodes against
	// analytic ground truth and reports max error. The centred-spectrum sign
	// (−1)^(x+y) is folded into map assembly at runtime, so it is applied here
	// on the CPU before comparing.
	async validate( renderer ) {

		const N = this.size;
		const results = [];

		const cases = [
			{
				name: 'impulse @ centred DC → constant (1, 0)',
				index: ( N / 2 ) * N + N / 2,
				expected: ( x, y ) => [ 1, 0 ],
			},
			{
				name: `impulse @ (N/2+1, N/2) → ( cos 2πx/N, sin 2πx/N )`,
				index: ( N / 2 ) * N + N / 2 + 1,
				expected: ( x, y ) => [ Math.cos( 2 * Math.PI * x / N ), Math.sin( 2 * Math.PI * x / N ) ],
			},
		];

		for ( const c of cases ) {

			this.impulseIndex.value = c.index;
			await renderer.computeAsync( this.impulseNode );

			for ( const node of this.stepNodes ) await renderer.computeAsync( node );

			const buf = await renderer.getArrayBufferAsync( this.field, null, 0, N * N * 2 * 4 );
			const data = new Float32Array( buf );

			let maxErr = 0;

			for ( let y = 0; y < N; y ++ ) {

				for ( let x = 0; x < N; x ++ ) {

					const sign = ( ( x + y ) & 1 ) === 0 ? 1 : - 1;
					const re = sign * data[ ( y * N + x ) * 2 ];
					const im = sign * data[ ( y * N + x ) * 2 + 1 ];
					const [ er, ei ] = c.expected( x, y );
					maxErr = Math.max( maxErr, Math.abs( re - er ), Math.abs( im - ei ) );

				}

			}

			results.push( { name: c.name, maxErr, pass: maxErr < 1e-3 } );

		}

		// leave the buffers clean for the real simulation
		this.impulseIndex.value = 0xffffffff;
		await renderer.computeAsync( this.impulseNode );

		return { pass: results.every( r => r.pass ), results };

	}

}
