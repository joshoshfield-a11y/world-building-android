import * as THREE from 'three/webgpu';

// Three ways to look at the same world, and one place that owns the camera so
// they cannot fight each other.
//
//   third  — the orbit rig the scene shipped with: the lens circles the figure
//            and the figure walks where the lens is pointing.
//   first  — the lens *is* the figure's eyes. Mouse turns the head, and the
//            same yaw drives walking, so there is no second source of truth.
//   fly    — the lens leaves the body behind and flies. The figure stays where
//            it was standing, which is the point: it is how you go and look at
//            the island you were standing on.
//
// The whole module is about one hazard. OrbitControls re-derives its own
// spherical coordinates from `camera.position` on every `update()`, so any
// other writer of the camera transform is in a fight with it that neither wins
// — the camera stutters between the two. So OrbitControls is switched *off*
// outside `third`, and switching back re-seeds it from the yaw/pitch the free
// modes were using. Nothing is ever driven by both.

const HALF_PI = Math.PI / 2 - 0.001;
const FOLLOW_DIST = 12;   // over-the-shoulder distance, in metres
// Radians of turn per pixel of mouse, the same in every mode. It has to be this
// brisk because without a pointer lock the turn stops at the edge of the window:
// at 0.0022 a full screen width was barely a third of a turn, and a camera you
// cannot swing round in one sweep reads as stuck. 0.004 is ~230 degrees across a
// 1400 px window, and is an ordinary first-person sensitivity besides.
const LOOK = 0.004;

export function makeViewpoint( { camera, controls, dom, keys, follow, ground } ) {

	const state = {
		mode: 'third',
		yaw: 0,
		pitch: 0,
		dist: FOLLOW_DIST,   // third-person distance remembered across mode changes
		locked: false,
		steer: true,         // does moving the mouse turn the view?
	};

	const e = new THREE.Euler( 0, 0, 0, 'YXZ' );
	const v = new THREE.Vector3(), _right = new THREE.Vector3(), _move = new THREE.Vector3();
	const pend = new THREE.Vector2();   // third-person mouse delta, flushed once a frame

	// Rotation has exactly one source, and it is the mouse moving. Left-drag is
	// switched off on the orbit rig rather than left as a second path to the same
	// thing: kept, every drag would turn the camera twice, once through this
	// module and once through OrbitControls' own handler.
	controls.mouseButtons.LEFT = null;

	// ---- looking around ----------------------------------------------------

	function seedFromCamera() {

		e.setFromQuaternion( camera.quaternion, 'YXZ' );
		state.yaw = e.y;
		state.pitch = THREE.MathUtils.clamp( e.x, - HALF_PI, HALF_PI );

	}

	function look( dx, dy ) {

		state.yaw -= dx * LOOK;
		state.pitch = THREE.MathUtils.clamp( state.pitch - dy * LOOK, - HALF_PI, HALF_PI );

	}

	// The mouse steers in every mode, with no button held. `movementX/Y` is
	// reported whether or not the pointer is locked, so this one listener covers
	// both states, and it is on the canvas rather than the window so that
	// crossing onto the settings panel stops the camera instead of spinning it on
	// the way to a slider. Third person accumulates instead of turning here,
	// because its turn goes through the orbit rig and that wants one call a frame.
	dom.addEventListener( 'mousemove', ( ev ) => {

		if ( ! state.steer ) return;
		const dx = ev.movementX || 0, dy = ev.movementY || 0;
		if ( state.mode === 'third' ) pend.set( pend.x + dx, pend.y + dy );
		else look( dx, dy );

	} );

	// ...and a pointer lock on top of it, in every mode, because free mouse-look
	// has one hard limit: the pointer reaches the edge of the window and the turn
	// stops dead. There is no way to keep turning from there — the mouse has to
	// come back, which turns the view back — so a whole screen width is the most
	// you can ever swing in one direction, and wherever the pointer happened to
	// be becomes the centre of that range. That reads as a camera that will not
	// come round. A click is a user gesture, which is exactly what the lock
	// wants, so one click buys unlimited turning.
	//
	// **Esc hands the mouse back**, and it has to hand back more than the cursor:
	// a visible cursor that still drags the camera everywhere it goes is not a
	// mouse you can use. So Esc disarms the steering as well, and clicking the
	// world arms it again. One rule, two gestures, no modes to remember: click
	// the world to look, esc to use the mouse.
	dom.addEventListener( 'mousedown', () => {

		state.steer = true;
		applyCursor();
		if ( state.locked || ! dom.requestPointerLock ) return;
		try {

			const p = dom.requestPointerLock();
			if ( p && p.catch ) p.catch( () => {} );

		} catch ( err ) { /* free mouse-look already works */ }

	} );

	document.addEventListener( 'pointerlockchange', () => {

		const wasLocked = state.locked;
		state.locked = document.pointerLockElement === dom;
		// Leaving the lock is only ever Esc or a call from here, and both mean
		// the same thing: the mouse is wanted for something other than looking.
		if ( wasLocked && ! state.locked ) state.steer = false;
		applyCursor();

	} );

	// ...and the same key when the pointer was never locked in the first place.
	// When it *is* locked the browser eats Esc itself and this never fires; the
	// pointerlockchange above is what covers that path.
	window.addEventListener( 'keydown', ( ev ) => {

		if ( ev.code !== 'Escape' ) return;
		state.steer = false;
		applyCursor();

	} );

	// ---- modes -------------------------------------------------------------

	function setMode( mode ) {

		if ( mode === state.mode ) return;

		if ( state.mode === 'third' ) {

			state.dist = camera.position.distanceTo( controls.target );
			seedFromCamera();

		}

		// No pointer lock is asked for here. A lock wanted outside a user gesture
		// is refused anyway, this is reached from a panel dropdown as often as
		// from a keypress, and grabbing the cursor as a side effect of changing
		// view is exactly the surprise Esc exists to undo. Capture is a click.

		if ( mode === 'first' ) {

			// The orbit rig is usually looking *down* at the figure, and a flier
			// is often diving; carried straight over, first person opens staring
			// at the sand. Continuity of the look direction is worth keeping for
			// ordinary angles and not worth keeping for that one, so the
			// inherited pitch is clamped to about what a standing head does. The
			// number is small on purpose: the lens is 1.6 m off the ground, so
			// even 30 degrees down puts the horizon in the top tenth of the
			// frame and the shot is still a photograph of sand.
			state.pitch = THREE.MathUtils.clamp( state.pitch, - 0.28, 0.28 );

		}

		if ( mode === 'third' ) {

			// The lock is deliberately *not* released here. Releasing it means
			// disarming the steering — that is what leaving a lock now means —
			// and switching from flight back over the figure's shoulder should
			// not quietly take the mouse away from the camera.
			// re-seed the orbit rig from where the free camera was looking, so
			// the shot does not jump when the mode changes
			const t = follow();
			controls.target.copy( t );
			v.set( Math.sin( state.yaw ) * Math.cos( state.pitch ),
				Math.sin( state.pitch ),
				Math.cos( state.yaw ) * Math.cos( state.pitch ) );
			// Coming *back* to third person means coming back to the figure, so
			// the remembered radius is capped at a following distance. The
			// opening shot is 46 m out on purpose — it is a landscape — but
			// arriving there again after a flight would read as the mode having
			// done nothing.
			const d = THREE.MathUtils.clamp( state.dist, controls.minDistance, FOLLOW_DIST );
			camera.position.copy( t ).addScaledVector( v, d );
			controls.enabled = true;

		} else {

			controls.enabled = false;

		}

		state.mode = mode;
		applyCursor();

	}

	// The cursor is only in the way once it stops being able to reach anything:
	// locked, the browser hides it anyway; in the two free modes it sits in the
	// middle of the shot doing nothing. Third person keeps it, because that is
	// the mode you go to the settings panel from.
	function applyCursor() {

		dom.style.cursor = state.locked
			|| ( state.steer && state.mode !== 'third' ) ? 'none' : '';

	}

	// ---- what "forward" means to whoever is walking ------------------------

	function forward( out = new THREE.Vector3() ) {

		if ( state.mode === 'third' ) {

			out.subVectors( controls.target, camera.position );
			out.y = 0;
			return out.normalize();

		}

		return out.set( - Math.sin( state.yaw ), 0, - Math.cos( state.yaw ) ).normalize();

	}

	// ---- per-frame ---------------------------------------------------------

	const FLY_SPEED = 22;

	function update( dt, eye ) {

		if ( state.mode === 'third' ) {

			// Hand the turn to the orbit rig rather than writing the camera here.
			// It owns the radius, the damping and the polar floor that keeps the
			// lens out of the sea, and two writers of one transform is the exact
			// failure this module exists to prevent.
			if ( pend.x !== 0 || pend.y !== 0 ) {

				controls.rotateLeft( pend.x * LOOK );
				controls.rotateUp( pend.y * LOOK );
				pend.set( 0, 0 );

			}

			return;

		}

		e.set( state.pitch, state.yaw, 0, 'YXZ' );
		camera.quaternion.setFromEuler( e );

		if ( state.mode === 'first' ) {

			camera.position.copy( eye );
			return;

		}

		// fly: W/S along the *view* ray including its pitch, because a free
		// camera that can only travel level is not free — you cannot dive at
		// anything with it.
		const boost = keys.has( 'ShiftLeft' ) || keys.has( 'ShiftRight' ) ? 4 : 1;
		const slow = keys.has( 'ControlLeft' ) || keys.has( 'ControlRight' ) ? 0.2 : 1;
		const step = FLY_SPEED * boost * slow * dt;

		const fwd = v.set( 0, 0, - 1 ).applyQuaternion( camera.quaternion );
		const right = _right.set( 1, 0, 0 ).applyQuaternion( camera.quaternion );
		const move = _move.set( 0, 0, 0 );

		if ( keys.has( 'KeyW' ) || keys.has( 'ArrowUp' ) ) move.add( fwd );
		if ( keys.has( 'KeyS' ) || keys.has( 'ArrowDown' ) ) move.sub( fwd );
		if ( keys.has( 'KeyA' ) || keys.has( 'ArrowLeft' ) ) move.sub( right );
		if ( keys.has( 'KeyD' ) || keys.has( 'ArrowRight' ) ) move.add( right );
		if ( keys.has( 'Space' ) ) move.y += 1;
		if ( keys.has( 'KeyC' ) ) move.y -= 1;

		if ( move.lengthSq() > 0 ) camera.position.addScaledVector( move.normalize(), step );

		// The one limit on a free camera, and it is the same one the orbit rig
		// has: stay out of the solid. A heightfield is drawn one-sided and the
		// sea is a single plane, so from underneath either you get sky through
		// the ground and the world's back faces — which reads as the build
		// having broken, not as having flown somewhere. Skimming the waves is
		// still allowed; going under them is not.
		const floor = Math.max( ground( camera.position.x, camera.position.z ), 0 ) + 1.2;
		if ( camera.position.y < floor ) camera.position.y = floor;

	}

	return {
		state,
		get mode() {

			return state.mode;

		},
		setMode,
		forward,
		update,
	};

}
