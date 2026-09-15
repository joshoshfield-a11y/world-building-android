// Calm mirror sea — the water the world falls back to when the FFT ocean
// layer is off. Same construction as the sky scene's lake: analytic ripple
// normals fading to a true mirror with distance, reflecting the atmosphere.

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, float, vec3,
	positionWorld, cameraPosition,
	normalize, dot, reflect, pow, mix, max, sin, length, smoothstep,
} from 'three/tsl';

export function makeCalmSea( atmosphere ) {

	const rippleU = uniform( 0.045 );
	const timeU = atmosphere.uniforms.time;

	const material = new THREE.MeshBasicNodeMaterial();

	material.colorNode = Fn( () => {

		const pos = positionWorld;
		const V = normalize( pos.sub( cameraPosition ) );

		const nx = sin( pos.x.mul( 0.11 ).add( timeU.mul( 0.70 ) ) )
			.add( sin( pos.x.mul( 0.041 ).sub( timeU.mul( 0.31 ) ) ).mul( 0.7 ) )
			.add( sin( pos.z.mul( 0.067 ).add( timeU.mul( 0.23 ) ) ).mul( 0.5 ) );
		const nz = sin( pos.z.mul( 0.093 ).add( timeU.mul( 0.53 ) ) )
			.add( sin( pos.z.mul( 0.037 ).add( timeU.mul( 0.41 ) ) ).mul( 0.7 ) )
			.add( sin( pos.x.mul( 0.052 ).sub( timeU.mul( 0.19 ) ) ).mul( 0.5 ) );

		const rippleFalloff = float( 1.0 ).div( length( pos.xz.sub( cameraPosition.xz ) ).mul( 0.007 ).add( 1.0 ) );
		const N = normalize( vec3( nx.mul( rippleU ).mul( rippleFalloff ), 1.0, nz.mul( rippleU ).mul( rippleFalloff ) ) );

		const R = reflect( V, N ).toVar();
		R.y.assign( max( R.y.abs(), 0.012 ) );

		const reflection = atmosphere.sample( R );
		const fresnel = pow( float( 1.0 ).sub( max( dot( N, V.negate() ), 0.0 ) ), 5.0 ).mul( 0.96 ).add( 0.04 );

		const body = vec3( 0.005, 0.010, 0.014 );
		const water = mix( body, reflection.mul( 0.94 ), fresnel ).toVar();

		const fade = smoothstep( 5000.0, 10500.0, length( pos.xz.sub( cameraPosition.xz ) ) );
		return mix( water, atmosphere.sample( V ), fade );

	} )();

	const geometry = new THREE.PlaneGeometry( 24000, 24000 );
	geometry.rotateX( - Math.PI / 2 );

	const mesh = new THREE.Mesh( geometry, material );
	mesh.frustumCulled = false;

	return { mesh, rippleU };

}
