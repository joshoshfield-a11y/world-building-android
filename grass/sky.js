// Analytic summer sky shared by the background, ground fade and blade shading.

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, vec3, float,
	normalize, dot, pow, mix, abs, smoothstep, max,
} from 'three/tsl';

export function makeSky() {

	const sunDir = uniform( new THREE.Vector3( 0.4, 0.55, 0.6 ).normalize() );

	const zenithColor = vec3( 0.16, 0.34, 0.62 );
	const horizonColor = vec3( 0.68, 0.77, 0.85 );
	const groundHaze = vec3( 0.52, 0.58, 0.55 );
	const sunTint = vec3( 1.0, 0.94, 0.82 );

	const sample = Fn( ( [ rayDir ] ) => {

		const dir = normalize( rayDir );
		const y = dir.y;

		const grad = mix( horizonColor, zenithColor, pow( y.clamp( 0, 1 ), 0.55 ) );
		const base = mix( groundHaze, grad, smoothstep( - 0.12, 0.02, y ) ).toVar();

		base.addAssign( vec3( 0.7, 0.72, 0.7 ).mul( pow( float( 1.0 ).sub( abs( y ) ), 9.0 ) ).mul( 0.22 ) );

		const sd = max( dot( dir, sunDir ), 0.0 );
		base.addAssign( sunTint.mul( pow( sd, 6.0 ).mul( 0.05 ) ) );
		base.addAssign( sunTint.mul( pow( sd, 120.0 ).mul( 0.25 ) ) );
		base.addAssign( sunTint.mul( pow( sd, 2600.0 ).mul( 40.0 ) ) );

		// the grass rig runs ACES at exposure 2.0 — pre-dim the sky so it
		// stays a sky instead of clipping to white
		return base.mul( 0.55 );

	} );

	function setSunAngles( elevationDeg, azimuthDeg ) {

		const el = elevationDeg * Math.PI / 180;
		const az = azimuthDeg * Math.PI / 180;
		sunDir.value.set( Math.cos( el ) * Math.sin( az ), Math.sin( el ), Math.cos( el ) * Math.cos( az ) ).normalize();

	}

	setSunAngles( 29, 215 ); // warm late-afternoon light, matching the grass rig

	return { sample, sunDir, setSunAngles };

}
