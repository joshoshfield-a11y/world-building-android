import * as THREE from 'three/webgpu';
import { restPose } from './rig.js';

// Every clip is generated as QuaternionKeyframeTracks over the bone names in
// rig.js, so three's AnimationMixer drives them exactly like an imported glTF.
//
// Sign conventions (bones point down -Y in bind pose):
//   +X rotation swings a limb BACKWARD, so forward is negative.
//   Knees flex backward  -> +X.   Elbows flex forward -> -X.
//   +Z rotation swings a limb toward +X, so the left arm spreads with -Z.

const TAU = Math.PI * 2;
const pos = (x) => Math.max(0, x);
const gauss = (x, at, w) => Math.exp(-((x - at) ** 2) / (2 * w * w));

function clipFromKeys(name, duration, keys, rest, hipsBase) {
  const names = new Set();
  for (const k of keys) for (const n in k.pose) names.add(n);

  const times = keys.map((k) => k.t);
  const tracks = [];
  const q = new THREE.Quaternion(), e = new THREE.Euler();

  for (const n of names) {
    const vals = [];
    for (const k of keys) {
      const p = k.pose[n] || rest[n] || [0, 0, 0];
      e.set(p[0], p[1], p[2]);
      q.setFromEuler(e);
      vals.push(q.x, q.y, q.z, q.w);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, vals));
  }

  if (keys.some((k) => k.dy !== undefined || k.dx !== undefined)) {
    const vals = [];
    for (const k of keys) vals.push(hipsBase.x + (k.dx || 0), hipsBase.y + (k.dy || 0), hipsBase.z);
    tracks.push(new THREE.VectorKeyframeTrack('hips.position', times, vals));
  }
  return new THREE.AnimationClip(name, duration, tracks);
}

function cyclic(name, duration, steps, fn, rest, hipsBase) {
  const keys = [];
  for (let i = 0; i <= steps; i++) {
    const p = i / steps;
    keys.push({ t: p * duration, ...fn(p % 1) });
  }
  return clipFromKeys(name, duration, keys, rest, hipsBase);
}

/* ------------------------------------------------------------- gaits --- */

function gait(rest, o) {
  return (p) => {
    const c = Math.cos(TAU * p);
    const swingL = pos(Math.sin(TAU * (p - 0.5)));
    const swingR = pos(Math.sin(TAU * p));
    const pose = {
      hips: [0, o.pelvis * c, 0],
      spine: [0, 0, 0],
      chest: [o.lean, -o.twist * c, 0],
      neck: [0, 0, 0],
      head: [-o.lean * 0.7, 0.04 * c, 0],

      legL0: [-o.thigh * c, 0, rest.legL0[2]],
      legL1: [o.kneeBase + o.knee * swingL + 0.22 * gauss(p, 0.12, 0.08), 0, 0],
      legL2: [-o.ankle * c, 0, 0],
      legR0: [o.thigh * c, 0, rest.legR0[2]],
      legR1: [o.kneeBase + o.knee * swingR + 0.22 * gauss((p + 0.5) % 1, 0.12, 0.08), 0, 0],
      legR2: [o.ankle * c, 0, 0],

      armL0: [o.arm * c, 0, rest.armL0[2] * o.tuck],
      armL1: [-(o.elbow + o.elbowSwing * pos(c)), 0, rest.armL1[2]],
      armR0: [-o.arm * c, 0, rest.armR0[2] * o.tuck],
      armR1: [-(o.elbow + o.elbowSwing * pos(-c)), 0, rest.armR1[2]],
    };
    return { pose, dy: -o.bob * (0.5 + 0.5 * Math.cos(2 * TAU * p)) + o.rise, dx: o.sway * c };
  };
}

/* ------------------------------------------------------------- clips --- */

export function buildClips(dna, rig) {
  const rest = restPose(dna);
  const hipsBase = rig.root.position.clone();
  const scale = dna.body.legLen + dna.body.height;   // taller figures move bigger

  const walk = cyclic('walk', 1.02, 16, gait(rest, {
    thigh: 0.42, knee: 0.95, kneeBase: 0.10, ankle: 0.12,
    arm: 0.30, elbow: 0.22, elbowSwing: 0.16, tuck: 1,
    pelvis: 0.09, twist: 0.09, lean: 0.05,
    bob: 0.055 * scale, rise: 0, sway: 0.018,
  }), rest, hipsBase);

  const run = cyclic('run', 0.60, 16, gait(rest, {
    thigh: 0.78, knee: 1.55, kneeBase: 0.30, ankle: 0.24,
    arm: 0.62, elbow: 1.05, elbowSwing: 0.30, tuck: 0.45,
    pelvis: 0.13, twist: 0.15, lean: 0.26,
    bob: 0.10 * scale, rise: 0.05 * scale, sway: 0.012,
  }), rest, hipsBase);

  const idle = cyclic('idle', 3.6, 12, (p) => {
    const s = Math.sin(TAU * p), s2 = Math.sin(TAU * p * 2);
    return {
      pose: {
        chest: [0.012 * s2, 0.02 * s, 0],
        head: [-0.02 * s2, 0.05 * s, 0.02 * s],
        armL0: [0.03 * s, 0, rest.armL0[2] - 0.02 * s],
        armR0: [0.03 * s, 0, rest.armR0[2] + 0.02 * s],
        armL1: rest.armL1,
        armR1: rest.armR1,
      },
      dy: 0.012 * s2,
    };
  }, rest, hipsBase);

  // one-shots ------------------------------------------------------------
  // A squat read dead-on is nearly invisible if the knees only travel forward,
  // so `splay` swings them outward too -- that is what sells it to the camera.
  const dip = (t, thigh, knee, ankle, dy, lean, arm, elbow, splay = 0) => ({
    t,
    pose: {
      hips: [0, 0, 0],
      chest: [lean, 0, 0],
      head: [-lean * 1.05, 0, 0],
      legL0: [thigh, 0, rest.legL0[2] - splay], legR0: [thigh, 0, rest.legR0[2] + splay],
      legL1: [knee, 0, 0], legR1: [knee, 0, 0],
      legL2: [ankle, 0, 0], legR2: [ankle, 0, 0],
      armL0: [arm, 0, rest.armL0[2]], armR0: [arm, 0, rest.armR0[2]],
      armL1: [elbow, 0, rest.armL1[2]], armR1: [elbow, 0, rest.armR1[2]],
    },
    dy: dy * scale,
  });

  const jump = clipFromKeys('jump', 1.25, [
    dip(0.00, 0, rest.legL1[0], 0, 0, 0, rest.armL0[0], rest.armL1[0], 0),
    dip(0.18, -0.55, 1.10, -0.50, -0.30, 0.22, 0.60, -0.35, 0.32),
    dip(0.34, -0.02, 0.02, 0.38, 0.22, 0.02, -1.45, -0.20, 0.04),
    dip(0.55, -0.42, 0.86, 0.12, 0.42, -0.06, -2.05, -0.35, 0.26),
    dip(0.78, -0.10, 0.22, -0.10, 0.14, 0.03, -0.85, -0.30, 0.08),
    dip(0.94, -0.50, 1.00, -0.34, -0.26, 0.20, 0.30, -0.45, 0.30),
    dip(1.10, -0.12, 0.24, -0.06, -0.05, 0.06, rest.armL0[0], rest.armL1[0], 0.08),
    dip(1.25, 0, rest.legL1[0], 0, 0, 0, rest.armL0[0], rest.armL1[0], 0),
  ], rest, hipsBase);

  const crouch = clipFromKeys('crouch', 0.55, [
    dip(0.00, 0, rest.legL1[0], 0, 0, 0, rest.armL0[0], rest.armL1[0], 0),
    dip(0.34, -0.86, 1.52, -0.62, -0.56, 0.20, 0.10, -1.05, 0.46),
    dip(0.55, -0.80, 1.44, -0.58, -0.52, 0.17, 0.14, -1.00, 0.42),
  ], rest, hipsBase);

  const cheerPose = (t, z, dy, lean, wrist) => ({
    t,
    pose: {
      chest: [lean, 0, 0],
      head: [-lean, 0, 0],
      armL0: [-0.25, 0, -z], armR0: [-0.25, 0, z],
      armL1: [-0.30, 0, 0], armR1: [-0.30, 0, 0],
      armL2: [0, 0, -wrist], armR2: [0, 0, wrist],
      legL1: [rest.legL1[0], 0, 0], legR1: [rest.legR1[0], 0, 0],
    },
    dy: dy * scale,
  });

  const cheer = clipFromKeys('cheer', 1.15, [
    { t: 0.00, pose: {}, dy: 0 },
    { t: 0.14, pose: { legL1: [0.55, 0, 0], legR1: [0.55, 0, 0], chest: [0.2, 0, 0] }, dy: -0.16 * scale },
    cheerPose(0.34, 2.05, 0.22, -0.10, 0.35),
    cheerPose(0.56, 1.90, 0.02, -0.04, -0.30),
    cheerPose(0.78, 2.05, 0.06, -0.08, 0.30),
    { t: 1.15, pose: {}, dy: 0 },
  ], rest, hipsBase);


  // Swimming — a breaststroke, cycled. The *prone* orientation is not in here:
  // the physics pitches the whole group, so the same clip covers level
  // swimming and a head-down dive, and the tilt can be damped without the
  // animation fighting it. What is in here is the stroke — arms extended and
  // swept out, legs a beat behind them in a frog kick, because the thing that
  // reads as swimming rather than as flailing is that the kick lands *after*
  // the pull, not with it.
  const swim = cyclic('swim', 1.55, 16, (p) => {
    const s = Math.sin(TAU * p);
    const pull = Math.sin(TAU * p);
    const kick = Math.sin(TAU * p + 1.9);
    const kp = pos(kick);
    return {
      pose: {
        hips: [0.05 * Math.cos(TAU * p), 0, 0],
        chest: [-0.12 + 0.07 * s, 0, 0],
        head: [0.40 + 0.12 * s, 0, 0],
        armL0: [-1.62 + 0.95 * pull, 0, rest.armL0[2] - 0.62],
        armR0: [-1.62 + 0.95 * pull, 0, rest.armR0[2] + 0.62],
        armL1: [-0.22 - 0.80 * pos(pull), 0, rest.armL1[2]],
        armR1: [-0.22 - 0.80 * pos(pull), 0, rest.armR1[2]],
        legL0: [0.08 + 0.26 * kick, 0, rest.legL0[2] - 0.30 * kp],
        legR0: [0.08 + 0.26 * kick, 0, rest.legR0[2] + 0.30 * kp],
        legL1: [0.12 + 1.00 * kp, 0, 0],
        legR1: [0.12 + 1.00 * kp, 0, 0],
        legL2: [-0.12 * kick, 0, 0],
        legR2: [-0.12 * kick, 0, 0],
      },
      dy: 0.03 * s,
    };
  }, rest, hipsBase);

  return { idle, walk, run, jump, crouch, cheer, swim };
}

export const LOOPING = new Set(['idle', 'walk', 'run', 'swim']);
// One-shots that stay on their last frame instead of springing back.
export const HOLD = new Set(['crouch']);
