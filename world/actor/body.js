import * as THREE from 'three/webgpu';
import { buildBlob, buildTube, mergeGeos, skinConst, skinSplitY } from './geometry.js';
import { makeClay } from './materials.js';

// Everything here is authored in BIND pose (limbs hanging straight down from
// their joints) and then skinned. Bones do the posing; the geometry only has
// to describe anatomy: deltoid swell, forearm taper, calf, ankle, mitten hand,
// two-part shoe.

const ARM_RINGS = 20, LEG_RINGS = 20, RADIAL = 10;

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const bump = (t, at, w) => Math.exp(-((t - at) ** 2) / (2 * w * w));

function straight(x, yTop, yBot, z) {
  return new THREE.LineCurve3(new THREE.Vector3(x, yTop, z), new THREE.Vector3(x, yBot, z));
}

export function buildBody(dna, rig, skinMat) {
  const b = dna.body, m = rig.metrics, ix = rig.index;
  const g = new THREE.Group();
  g.userData.kind = 'body';

  const armRadius = (t) =>
    b.armR * (1 + 0.13 * (1 - smooth(0, 0.24, t))) * (1 - 0.30 * t) * (1 + 0.10 * bump(t, 0.62, 0.13));
  const legRadius = (t) =>
    b.legR * (1 + 0.17 * (1 - smooth(0, 0.34, t))) * (1 - 0.32 * t) * (1 + 0.22 * bump(t, 0.60, 0.12));

  const shirt = [], skin = [], pants = [], shoes = [];

  // ---- torso ------------------------------------------------------------
  shirt.push(skinConst(
    buildBlob({ p: b.p, rx: b.width, ry: b.height, rz: b.depth, taper: b.taper, bulge: b.bulge }, 40, 30)
      .translate(0, m.torsoY, 0),
    ix.spine,
  ));

  const armBlend = m.upperArm * 0.34;
  const legBlend = m.thigh * 0.32;

  for (const [tag, side] of [['L', -1], ['R', 1]]) {
    const x = side * m.shoulderX;
    const hr = b.armR * 0.86;

    // arm: shoulder -> wrist, bending at the elbow
    skin.push(skinSplitY(
      buildTube(straight(x, m.shoulderY, m.wristY, m.armZ), armRadius, ARM_RINGS, RADIAL),
      m.elbowY, armBlend, ix[`arm${tag}0`], ix[`arm${tag}1`],
    ));

    // mitten hand + thumb, rigid on the wrist
    skin.push(skinConst(
      buildBlob({ p: 2.4, rx: hr * 1.15, ry: hr * 1.52, rz: hr * 0.82, taper: 0.12, bulge: 0.06 }, 22, 16)
        .translate(x, m.wristY - hr * 1.18, m.armZ),
      ix[`arm${tag}2`],
    ));
    skin.push(skinConst(
      buildBlob({ p: 2.2, rx: hr * 0.40, ry: hr * 0.70, rz: hr * 0.40, taper: 0, bulge: 0 }, 16, 12)
        .translate(x - side * hr * 0.92, m.wristY - hr * 0.85, m.armZ + hr * 0.32),
      ix[`arm${tag}2`],
    ));

    // sleeve shell over the top of the arm, closed off by a shoulder cap --
    // an open tube ring poking past the torso reads as a flap, not a sleeve
    const sleeveY = m.shoulderY - (m.shoulderY - m.wristY) * b.sleeve;
    const capR = armRadius(0) * 1.12;
    shirt.push(skinConst(
      buildBlob({ p: 2.3, rx: capR, ry: capR * 1.02, rz: capR, taper: 0, bulge: 0 }, 20, 14)
        .translate(x, m.shoulderY, m.armZ),
      ix[`arm${tag}0`],
    ));
    shirt.push(skinSplitY(
      buildTube(straight(x, m.shoulderY, sleeveY, m.armZ),
        (t) => armRadius(t * b.sleeve) * 1.12 + 0.008, 12, RADIAL),
      m.elbowY, armBlend, ix[`arm${tag}0`], ix[`arm${tag}1`],
    ));

    // leg: hip -> ankle, bending at the knee
    const lx = side * m.hipX;
    const ar = legRadius(1);
    pants.push(skinSplitY(
      buildTube(straight(lx, m.hipJointY + b.legR * 0.4, m.ankleY, 0), legRadius, LEG_RINGS, RADIAL),
      m.kneeY, legBlend, ix[`leg${tag}0`], ix[`leg${tag}1`],
    ));

    // shoe: flat sole + rounded upper
    const fh = b.footLift;
    shoes.push(skinConst(
      buildBlob({ p: 3.4, rx: ar * 1.22, ry: fh * 0.60, rz: ar * 2.10, taper: 0, bulge: 0 }, 22, 16)
        .translate(lx, m.ankleY - fh * 0.62, ar * 0.66),
      ix[`leg${tag}2`],
    ));
    shoes.push(skinConst(
      buildBlob({ p: 2.6, rx: ar * 1.15, ry: fh * 1.10, rz: ar * 1.28, taper: 0.10, bulge: 0 }, 22, 16)
        .translate(lx, m.ankleY - fh * 0.14, ar * 0.20),
      ix[`leg${tag}2`],
    ));
  }

  const shirtMat = makeClay(b.shirt, { stripe: b.stripe });
  if (b.stripe) {
    shirtMat.u.stripe.value.set(b.stripeCol);
    shirtMat.u.stripeFreq.value = b.stripeFreq;
    shirtMat.u.stripeMix.value = 0.9;
  }

  const meshes = [
    new THREE.SkinnedMesh(mergeGeos(shirt), shirtMat),
    new THREE.SkinnedMesh(mergeGeos(skin), skinMat),
    new THREE.SkinnedMesh(mergeGeos(pants), makeClay(b.pants)),
    new THREE.SkinnedMesh(mergeGeos(shoes), makeClay(b.shoe)),
  ];
  for (const mesh of meshes) {
    mesh.userData.kind = 'body';
    mesh.frustumCulled = false;   // bones can push vertices past the bind bounds
    g.add(mesh);
  }

  g.userData.meshes = meshes;
  g.userData.bottom = m.ankleY - b.footLift * 1.3;
  g.userData.halfWidth = m.shoulderX + b.armR * 2.2;
  return g;
}

// Must run after the meshes and bones share a parent, with that parent at
// identity -- Skeleton snapshots world matrices, SkinnedMesh snapshots its own.
export function bindBody(body, skeleton) {
  for (const mesh of body.userData.meshes) mesh.bind(skeleton);
}
