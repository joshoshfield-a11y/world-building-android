// One global wind source for the whole scene. A small state machine
// ( idle → direction → ramp → hold → decay ) publishes exactly two uniforms —
// direction and intensity — and every wind consumer subscribes to the same
// pair, so gusts stay coherent across everything that sways.
//
// Also bakes the tileable gust-noise texture the near-field wind samples.

import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

export function makeGustTexture( size = 128 ) {

	const data = new Uint8Array( size * size * 4 );

	let seed = 977;
	const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;

	const channels = [];

	for ( let ch = 0; ch < 4; ch ++ ) {

		const waves = [];

		for ( let i = 0; i < 9; i ++ ) {

			waves.push( {
				fx: Math.round( 1 + rand() * 4 ) * ( rand() > 0.5 ? 1 : - 1 ),
				fy: Math.round( 1 + rand() * 4 ) * ( rand() > 0.5 ? 1 : - 1 ),
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
	tex.minFilter = THREE.LinearFilter;
	tex.needsUpdate = true;
	return tex;

}

const STATES = [ 'idle', 'direction', 'ramp', 'hold', 'decay' ];

export class WindDirector {

	constructor( config ) {

		this.config = config;
		this.directionU = uniform( new THREE.Vector2( 1, 0.2 ).normalize() );
		this.intensityU = uniform( 0.35 );
		this.timeU = uniform( 0 );

		this.state = 'idle';
		this.stateT = 0;
		this.stateDur = 2;
		this.level = 0.35;          // current intensity before config.strength
		this.from = 0.35;
		this.target = 0.35;
		this.angle = Math.atan2( 0.2, 1 );
		this.angleFrom = this.angle;
		this.angleTo = this.angle;

		this.rand = ( () => {

			let s = 20260816;
			return () => ( s = ( s * 48271 ) % 2147483647 ) / 2147483647;

		} )();

	}

	_next() {

		const r = this.rand;
		const i = STATES.indexOf( this.state );
		this.state = STATES[ ( i + 1 ) % STATES.length ];
		this.stateT = 0;

		switch ( this.state ) {

			case 'idle':
				this.stateDur = 2 + r() * 5;
				break;

			case 'direction': // veer toward a new heading while calm
				this.stateDur = 1.5 + r() * 2;
				this.angleFrom = this.angle;
				this.angleTo = this.angle + ( r() - 0.5 ) * Math.PI * 0.9;
				break;

			case 'ramp':
				this.stateDur = 1 + r() * 2.5;
				this.from = this.level;
				this.target = 0.55 + r() * 0.45;
				break;

			case 'hold':
				this.stateDur = 2 + r() * 6;
				break;

			case 'decay':
				this.stateDur = 2.5 + r() * 4;
				this.from = this.level;
				this.target = 0.15 + r() * 0.25;
				break;

		}

	}

	update( dt, t ) {

		this.timeU.value = t;
		this.stateT += dt;

		const k = Math.min( this.stateT / this.stateDur, 1 );
		const ease = k * k * ( 3 - 2 * k );

		if ( this.state === 'direction' ) {

			this.angle = this.angleFrom + ( this.angleTo - this.angleFrom ) * ease;
			this.directionU.value.set( Math.cos( this.angle ), Math.sin( this.angle ) );

		} else if ( this.state === 'ramp' || this.state === 'decay' ) {

			this.level = this.from + ( this.target - this.from ) * ease;

		}

		this.intensityU.value = this.level * this.config.wind.strength;

		if ( this.stateT >= this.stateDur ) this._next();

	}

}
