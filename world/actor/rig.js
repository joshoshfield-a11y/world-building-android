import * as THREE from 'three/webgpu';

// A real bone skeleton, so limbs bend at joints instead of being one rigid
// sausage, and so three's AnimationMixer has something to drive.
//
//   hips - spine - chest - neck - head
//                        - armL0 - armL1 - armL2   (shoulder, elbow, wrist)
//                        - armR0 - armR1 - armR2
//        - legL0 - legL1 - legL2                   (hip, knee, ankle)
//        - legR0 - legR1 - legR2

export function buildRig(dna) {
  const h = dna.head, b = dna.body;

  const torsoY = -(h.ry + b.height * 0.80);
  const pelvisY = torsoY - b.height * 0.84;
  const shoulderY = torsoY + b.height * 0.50;

  // shoulder joint on the torso's real surface, not its bounding box
  const sy = 0.50;
  const xr = Math.pow(Math.max(0, 1 - Math.abs(sy) ** b.p), 1 / b.p);
  const shoulderX = b.width * xr * (1 + b.taper * sy + b.bulge * (1 - sy * sy)) * 0.84;

  const upperArm = b.armLen * 0.47;
  const foreArm = b.armLen * 0.40;
  const handLen = b.armLen * 0.13;

  const hipJointY = torsoY - b.height * 0.60;
  const hipX = b.width * b.stance * 0.82;
  const thigh = b.legLen * 0.50;
  const shin = b.legLen * 0.50;

  const bones = [];
  const byName = {};
  const make = (name, parent, wx, wy, wz) => {
    const bone = new THREE.Bone();
    bone.name = name;
    const w = parent ? parent.userData.w : [0, 0, 0];
    bone.position.set(wx - w[0], wy - w[1], wz - w[2]);
    bone.userData.w = [wx, wy, wz];
    if (parent) parent.add(bone);
    bones.push(bone);
    byName[name] = bone;
    return bone;
  };

  const hips = make('hips', null, 0, pelvisY, 0);
  const spine = make('spine', hips, 0, torsoY - b.height * 0.18, 0);
  const chest = make('chest', spine, 0, torsoY + b.height * 0.30, 0);
  const neck = make('neck', chest, 0, torsoY + b.height * 0.86, 0);
  make('head', neck, 0, 0, 0);          // head centre is the character origin

  const armZ = 0.02;
  for (const [tag, side] of [['L', -1], ['R', 1]]) {
    const s0 = make(`arm${tag}0`, chest, side * shoulderX, shoulderY, armZ);
    const s1 = make(`arm${tag}1`, s0, side * shoulderX, shoulderY - upperArm, armZ);
    make(`arm${tag}2`, s1, side * shoulderX, shoulderY - upperArm - foreArm, armZ);
  }
  for (const [tag, side] of [['L', -1], ['R', 1]]) {
    const l0 = make(`leg${tag}0`, hips, side * hipX, hipJointY, 0);
    const l1 = make(`leg${tag}1`, l0, side * hipX, hipJointY - thigh, 0);
    make(`leg${tag}2`, l1, side * hipX, hipJointY - thigh - shin, 0);
  }

  // Bind pose must be resolved before the skeleton snapshots its inverses.
  hips.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  const index = {};
  bones.forEach((bone, i) => { index[bone.name] = i; });

  return {
    root: hips,
    skeleton,
    bones: byName,
    index,
    metrics: {
      torsoY, pelvisY, shoulderY, shoulderX, armZ,
      upperArm, foreArm, handLen,
      hipJointY, hipX, thigh, shin,
      elbowY: shoulderY - upperArm,
      wristY: shoulderY - upperArm - foreArm,
      kneeY: hipJointY - thigh,
      ankleY: hipJointY - thigh - shin,
    },
  };
}

// Rest pose: what the character looks like when no clip is playing. Clips are
// authored as deviations from this, so per-character stance survives.
export function restPose(dna) {
  const b = dna.body;
  const spread = 0.22 + b.spread * 0.48;
  return {
    hips: [0, 0, 0],
    spine: [0, 0, 0],
    chest: [0, 0, 0],
    neck: [0, 0, 0],
    head: [0, 0, 0],
    armL0: [0.04, 0, -spread],
    armL1: [0.10, 0, -0.05],
    armL2: [0, 0, 0],
    armR0: [0.04, 0, spread],
    armR1: [0.10, 0, 0.05],
    armR2: [0, 0, 0],
    legL0: [0, 0, -0.03],
    legL1: [0.05, 0, 0],
    legL2: [0, 0, 0],
    legR0: [0, 0, 0.03],
    legR1: [0.05, 0, 0],
    legR2: [0, 0, 0],
  };
}

export function applyPose(rig, pose) {
  const e = new THREE.Euler();
  for (const name in pose) {
    const bone = rig.bones[name];
    if (!bone) continue;
    e.set(pose[name][0], pose[name][1], pose[name][2]);
    bone.quaternion.setFromEuler(e);
  }
}
