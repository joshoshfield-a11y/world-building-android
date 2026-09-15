import * as THREE from 'three/webgpu';
import { buildBlob, buildHair, buildBand, buildAhoge } from './geometry.js';
import { buildRig, restPose, applyPose } from './rig.js';
import { buildBody, bindBody } from './body.js';
import { buildClips, LOOPING, HOLD } from './clips.js';
import { makeClay, makeContactShadow } from './materials.js';
import { bakeFaceAtlas, frameOffset } from './face.js';

// One playable figure, assembled from a seed. This is the standalone Clay
// Heads `character.js` rebuilt for a world rather than for a wall of portraits:
// the grid slot, the hover lift and the backdrop sticker-shadow are gone, and
// what replaces them is everything a body standing on ground needs — a known
// height in metres, an eye height for the first-person lens, and a contact
// shadow that lies flat under the feet.
//
// The character is authored with **the head's centre at the origin** and the
// body hanging below it in negative Y (see rig.js). Nothing in the world wants
// that, so the whole figure is parented under a node lifted by its own foot
// line: `group.position` is then simply where the feet are, and
// `group.rotation.y` is which way it faces.

const FACE_CENTER_Y = 0.03;

export async function buildCharacter( dna, opts = {} ) {

	const group = new THREE.Group();      // feet on the ground, +Z is forward
	const pivot = new THREE.Group();      // the figure's own space
	group.add( pivot );

	const rig = buildRig( dna );
	pivot.add( rig.root );

	// ---- head, hair and trimmings ride the head bone ----------------------
	const headGeo = buildBlob( dna.head, 60, 44 );
	headGeo.computeBoundingBox();

	// The atlas has to exist before the material does: a TSL `texture()` node is
	// part of the graph, not a uniform slot you can fill in afterwards.
	const canvas = await bakeFaceAtlas( dna, 256 );
	const faceTex = new THREE.CanvasTexture( canvas );
	faceTex.colorSpace = THREE.SRGBColorSpace;
	faceTex.anisotropy = 4;

	const skinMat = makeClay( dna.skin, { face: faceTex } );
	skinMat.u.half.value.set( headGeo.boundingBox.max.x, dna.head.ry );
	skinMat.u.faceCenter.value.set( 0, FACE_CENTER_Y );
	skinMat.u.faceSize.value.set( dna.face.scale, dna.face.scale );

	// Look-at gets its own node under the head bone rather than the bone
	// itself. Writing to the bone fights the mixer: PropertyMixer.apply() skips
	// the scene-graph write when its accumulated value has not changed (which is
	// what a clamped one-shot pose is), and a per-frame multiply then
	// accumulates without bound — the head ends up facing backwards.
	const headBone = rig.bones.head;
	const headLook = new THREE.Group();
	headBone.add( headLook );

	const head = new THREE.Mesh( headGeo, skinMat );
	headLook.add( head );

	const headBox = headGeo.boundingBox.clone();

	if ( ! dna.hair.bald ) {

		const hairGeo = buildHair( dna.head, dna.hair, 104, 26 );
		hairGeo.computeBoundingBox();
		headBox.union( hairGeo.boundingBox );
		const hairMat = makeClay( dna.hair.color );
		hairMat.u.topDark.value = 0.18;
		hairMat.side = THREE.DoubleSide;
		headLook.add( new THREE.Mesh( hairGeo, hairMat ) );

		skinMat.u.fringeY.value = dna.hair.front;
		skinMat.u.fringe.value = 0.40;

		if ( dna.hair.ahoge ) headLook.add( new THREE.Mesh( buildAhoge( dna.head, dna.seed % 5 ), hairMat ) );

	} else {

		skinMat.u.fringe.value = 0;

	}

	if ( dna.hair.band ) {

		const y = dna.hair.bald || dna.hair.capped ? 0.34 : 0.30;
		const bandGeo = buildBand( dna.head, y, 0.085, dna.hair.bald ? 0.018 : dna.hair.thick + 0.02 );
		const bandMat = makeClay( dna.hair.bandColor );
		bandMat.side = THREE.DoubleSide;
		headLook.add( new THREE.Mesh( bandGeo, bandMat ) );

	}

	// ---- skinned body -----------------------------------------------------
	const body = buildBody( dna, rig, skinMat );
	pivot.add( body );
	pivot.updateMatrixWorld( true );      // bind pose is identity everywhere here
	bindBody( body, rig.skeleton );
	applyPose( rig, restPose( dna ) );    // stance is applied only after binding

	// ---- put it on the ground ---------------------------------------------
	// The figure's own units are arbitrary; the world's are metres. Scale by the
	// foot-to-crown span so a character is the height it is asked to be however
	// the dice fell on its proportions, then lift by the foot line so
	// `group.position` means "where the feet are".
	const bottom = body.userData.bottom;
	const top = headBox.max.y;
	const span = top - bottom;
	const height = opts.height || 1.6;
	const k = height / span;
	pivot.scale.setScalar( k );
	pivot.position.y = - bottom * k;

	// ---- animation --------------------------------------------------------
	const mixer = new THREE.AnimationMixer( pivot );
	const clips = buildClips( dna, rig );
	const actions = {};
	for ( const name in clips ) {

		const action = mixer.clipAction( clips[ name ] );
		action.setLoop( LOOPING.has( name ) ? THREE.LoopRepeat : THREE.LoopOnce, Infinity );
		action.clampWhenFinished = ! LOOPING.has( name );
		actions[ name ] = action;

	}

	// crossFadeTo only moves weight on an action that is already scheduled, so
	// every looping action runs from the start at zero weight
	for ( const name of LOOPING ) actions[ name ].play().setEffectiveWeight( 0 );
	actions.idle.setEffectiveWeight( 1 );

	// ---- contact shadow ----------------------------------------------------
	const shadow = new THREE.Mesh( new THREE.PlaneGeometry( 1, 1 ), makeContactShadow() );
	shadow.geometry.rotateX( - Math.PI / 2 );
	shadow.scale.setScalar( Math.max( body.userData.halfWidth * 3.2 * k, height * 0.55 ) );
	shadow.frustumCulled = false;

	const state = {
		motion: 'idle',
		base: 'idle',
		frame: 0,
		blinkIn: 1 + Math.random() * 5,
		blinkFor: 0, talkFor: 0, joyFor: 0,
		look: new THREE.Vector2(),
		lookTarget: new THREE.Vector2(),
	};

	const actor = {
		dna, group, pivot, rig, mixer, actions, headLook, shadow, state,
		height, eyeHeight: ( - bottom + 0.10 ) * k,
		headHeight: ( - bottom ) * k,
	};

	mixer.addEventListener( 'finished', ( e ) => {

		// clampWhenFinished has already frozen the pose; only the springy
		// one-shots return to whatever was underneath them
		if ( HOLD.has( e.action.getClip().name ) ) return;
		play( actor, state.base );

	} );

	return actor;

}

const FADE = 0.20;

export function play( actor, name ) {

	const s = actor.state;
	const next = actor.actions[ name ];
	const prev = actor.actions[ s.motion ];
	if ( ! next || next === prev ) return;

	next.enabled = true;
	next.setEffectiveWeight( 1 );
	next.reset();
	next.play();
	if ( prev && prev.isRunning() ) prev.crossFadeTo( next, FADE, false );
	else next.fadeIn( FADE );

	s.motion = name;
	if ( LOOPING.has( name ) || HOLD.has( name ) ) s.base = name;

}

export function setFrame( actor, i ) {

	actor.state.frame = i;
	const [ x, y ] = frameOffset( i );
	// every part shares one skin material, and the face lives on it
	actor.pivot.traverse( ( o ) => {

		if ( o.material && o.material.u && o.material.u.frame ) o.material.u.frame.value.set( x, y );

	} );

}

const _lookE = new THREE.Euler();

export function updateCharacter( actor, dt ) {

	const s = actor.state;

	if ( s.joyFor > 0 ) {

		s.joyFor -= dt;
		if ( s.joyFor <= 0 ) setFrame( actor, 0 );

	} else if ( s.blinkFor > 0 ) {

		s.blinkFor -= dt;
		if ( s.blinkFor <= 0 ) setFrame( actor, 0 );

	} else if ( s.talkFor > 0 ) {

		s.talkFor -= dt;
		if ( s.talkFor <= 0 ) setFrame( actor, 0 );

	} else {

		s.blinkIn -= dt;
		if ( s.blinkIn <= 0 ) {

			s.blinkIn = 2.4 + Math.random() * 5.5;
			if ( Math.random() < 0.16 ) {

				s.talkFor = 0.16;
				setFrame( actor, 2 );

			} else {

				s.blinkFor = 0.11;
				setFrame( actor, 1 );

			}

		}

	}

	actor.mixer.update( dt );

	// layered on top of whatever the clip wrote to the head bone
	s.look.x += ( s.lookTarget.x - s.look.x ) * Math.min( 1, dt * 5 );
	s.look.y += ( s.lookTarget.y - s.look.y ) * Math.min( 1, dt * 5 );
	actor.headLook.quaternion.setFromEuler( _lookE.set( s.look.y, s.look.x, 0 ) );

}

export function cheer( actor ) {

	actor.state.joyFor = 1.0;
	setFrame( actor, 3 );
	play( actor, 'cheer' );

}
