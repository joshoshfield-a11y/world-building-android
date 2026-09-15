// ---------------------------------------------------------------------------
// Material library built on the procedural textures.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import * as T from './textures.js';

function set(o, rep) {
  const out = {};
  for (const k in o) {
    const t = o[k].clone();
    t.needsUpdate = true;
    t.repeat.set(rep, rep);
    out[k] = t;
  }
  return out;
}

export function buildMaterials() {
  const M = {};

  // ---- concrete family (UV already metric: repeat 1 == tile metres) ----
  const cA = T.concrete({ boards: 12, tint: [214, 208, 195] });
  M.concrete = new THREE.MeshStandardMaterial({ ...set(cA, 1), roughness: 0.92, metalness: 0, color: 0xffffff });
  M.concreteSoffit = new THREE.MeshStandardMaterial({ ...set(cA, 1), roughness: 0.94, color: 0xf2f0ec });
  const cB = T.concrete({ boards: 6, tint: [206, 199, 184] });
  M.concretePaving = new THREE.MeshStandardMaterial({ ...set(cB, 1), roughness: 0.88, color: 0xf0ebe0 });
  M.concreteDark = new THREE.MeshStandardMaterial({ ...set(cA, 1), roughness: 0.9, color: 0x7d7669 });

  // ---- plaster (interior) ----
  const p = T.plaster({ tint: [240, 236, 228] });
  M.plaster = new THREE.MeshStandardMaterial({ ...set(p, 1), roughness: 0.96 });
  M.ceiling = new THREE.MeshStandardMaterial({ ...set(p, 1), roughness: 0.98, color: 0xf6f4ef });
  const p2 = T.plaster({ tint: [96, 92, 86], mottle: 0.16 });
  M.plasterDark = new THREE.MeshStandardMaterial({ ...set(p2, 1), roughness: 0.9 });

  // ---- timber ----
  //
  // The palette moved with the roof. The villa arrived dressed for a northern
  // suburb — black-stained board behind an orange-pine batten screen — and read
  // as a dark slab dropped on a green hill, which is exactly what it looked like
  // from the far shore. An island house is the other way round: a pale, lime-
  // washed body that holds the light under a deep eave, timber gone silver in
  // the salt air, and the dark saved for the roof and the frames so the building
  // has a hat and a set of lines rather than being one tone all over.
  const clad = T.timber({ planks: 14, light: [186, 158, 122], dark: [140, 112, 82], gap: 0.035, rough: 165 });
  M.cladding = new THREE.MeshStandardMaterial({ ...set(clad, 1), roughness: 0.78 });
  // lime-washed backing board behind the timber batten screen
  const cd = T.timber({ planks: 4, light: [232, 226, 212], dark: [206, 199, 185], gap: 0.03, rough: 210, nstrength: 0.55 });
  M.claddingDark = new THREE.MeshStandardMaterial({ ...set(cd, 1), roughness: 0.93 });
  // battens: teak weathered to driftwood grey, not fresh pine
  const bat = T.timber({ planks: 1, light: [162, 148, 130], dark: [116, 104, 90], gap: 0.0, rough: 150, nstrength: 0.4 });
  M.batten = new THREE.MeshStandardMaterial({ ...set(bat, 1), roughness: 0.78 });
  // roof: boarded shingle, weathered to a dark green-grey. Tiled fine so the
  // boards read as courses up the slope rather than as one flat plane.
  const rb = T.timber({ planks: 16, light: [96, 100, 92], dark: [58, 62, 58], gap: 0.05, rough: 195, nstrength: 0.8 });
  M.roofBoard = new THREE.MeshStandardMaterial({ ...set(rb, 1), roughness: 0.9 });
  const fa = T.timber({ planks: 2, light: [74, 66, 56], dark: [46, 40, 34], gap: 0.02, rough: 190, nstrength: 0.6 });
  M.fascia = new THREE.MeshStandardMaterial({ ...set(fa, 1), roughness: 0.85 });
  const pt = T.timber({ planks: 2, light: [118, 92, 68], dark: [76, 58, 42], gap: 0.012, rough: 140, nstrength: 0.5 });
  M.postTimber = new THREE.MeshStandardMaterial({ ...set(pt, 1), roughness: 0.7 });
  const floor = T.timber({ planks: 5, light: [198, 164, 122], dark: [158, 120, 80], gap: 0.014, rough: 96, nstrength: 0.5 });
  M.oakFloor = new THREE.MeshStandardMaterial({ ...set(floor, 1), roughness: 0.66, metalness: 0.0 });
  const deck = T.timber({ planks: 7, light: [158, 132, 104], dark: [110, 88, 66], gap: 0.05, rough: 185 });
  M.deck = new THREE.MeshStandardMaterial({ ...set(deck, 1), roughness: 0.82 });
  const wal = T.timber({ planks: 3, light: [136, 94, 60], dark: [92, 58, 34], gap: 0.01, rough: 110, nstrength: 0.45 });
  M.walnut = new THREE.MeshStandardMaterial({ ...set(wal, 1), roughness: 0.45 });

  // ---- stone ----
  const st = T.stone({ rows: 4, base: [200, 186, 162] });
  M.stone = new THREE.MeshStandardMaterial({ ...set(st, 1), roughness: 0.86 });
  M.stone.map.repeat.set(0.62, 0.62); M.stone.normalMap.repeat.set(0.62, 0.62);
  const st2 = T.stone({ rows: 2, base: [196, 190, 176] });
  M.stonePaving = new THREE.MeshStandardMaterial({ ...set(st2, 1), roughness: 0.8 });
  M.marble = new THREE.MeshStandardMaterial({ ...set(T.marble(), 1), roughness: 0.24, metalness: 0.02 });

  // ---- ground ----
  const gr = T.grass();
  M.grass = new THREE.MeshStandardMaterial({ map: gr.map.clone(), normalMap: gr.normalMap.clone(), roughness: 0.95 });
  M.grass.map.repeat.set(26, 26); M.grass.normalMap.repeat.set(26, 26);
  const gv = T.gravel();
  M.gravel = new THREE.MeshStandardMaterial({ map: gv.map.clone(), normalMap: gv.normalMap.clone(), roughness: 0.95 });
  M.gravel.map.repeat.set(9, 9); M.gravel.normalMap.repeat.set(9, 9);

  // ---- metal ----
  M.steelDark = new THREE.MeshStandardMaterial({ color: 0x3a3128, roughness: 0.46, metalness: 0.8 });
  M.steelBlack = new THREE.MeshStandardMaterial({ color: 0x231e18, roughness: 0.52, metalness: 0.68 });
  M.brass = new THREE.MeshStandardMaterial({ color: 0xb08a4e, roughness: 0.32, metalness: 0.95 });
  M.alu = new THREE.MeshStandardMaterial({ color: 0x8e9296, roughness: 0.3, metalness: 0.9 });

  // ---- glass ----
  M.glass = new THREE.MeshPhysicalMaterial({
    color: 0xd8e6e8, metalness: 0, roughness: 0.02, transparent: true, opacity: 0.30,
    envMapIntensity: 2.2, side: THREE.DoubleSide, depthWrite: false,
    clearcoat: 1, clearcoatRoughness: 0.04,
  });
  M.glassBalustrade = new THREE.MeshPhysicalMaterial({
    color: 0xcfe2e6, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.22,
    side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.4,
  });
  M.mirror = new THREE.MeshStandardMaterial({ color: 0xbfc8cc, roughness: 0.05, metalness: 1 });

  // ---- fabrics ----
  M.sofa = new THREE.MeshStandardMaterial({ ...set(T.fabric({ tint: [150, 143, 130], repeat: 1 }), 0.12), roughness: 0.95 });
  M.cushion = new THREE.MeshStandardMaterial({ ...set(T.fabric({ tint: [136, 114, 92], repeat: 1 }), 0.09), roughness: 0.95 });
  M.rug = new THREE.MeshStandardMaterial({ ...set(T.fabric({ tint: [150, 140, 124], repeat: 1 }), 0.16), roughness: 1 });
  M.bed = new THREE.MeshStandardMaterial({ ...set(T.fabric({ tint: [228, 224, 216], repeat: 1 }), 0.12), roughness: 0.96 });
  M.curtain = new THREE.MeshStandardMaterial({
    ...set(T.fabric({ tint: [232, 226, 214], repeat: 1 }), 0.6), roughness: 1,
    transparent: true, opacity: 0.82, side: THREE.DoubleSide,
  });

  // ---- vegetation ----
  M.foliage = new THREE.MeshStandardMaterial({ color: 0x4a6b34, roughness: 0.92, flatShading: true });
  M.foliage2 = new THREE.MeshStandardMaterial({ color: 0x5c7a3c, roughness: 0.92, flatShading: true });
  M.foliageDark = new THREE.MeshStandardMaterial({ color: 0x37502a, roughness: 0.94, flatShading: true });
  M.bark = new THREE.MeshStandardMaterial({ ...set(T.timber({ planks: 2, light: [122, 108, 92], dark: [56, 48, 40], gap: 0.02, rough: 200 }), 0.8), roughness: 0.95 });

  // ---- water ----
  M.water = new THREE.MeshPhysicalMaterial({
    color: 0x1c5060, roughness: 0.05, metalness: 0.15, transparent: true, opacity: 0.62,
    envMapIntensity: 1.6, clearcoat: 1, clearcoatRoughness: 0.02,
  });
  M.poolLiner = new THREE.MeshStandardMaterial({ color: 0x8fb3bc, roughness: 0.35 });
  // animated wave normal map for the pool
  {
    const S = 256, h = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      h[y * S + x] = T.fbm(x / 9, y / 22, 4, 28, 3) + Math.sin(x / 7 + T.fbm(x / 30, y / 30, 3, 9, 5) * 6) * 0.25;
    }
    const nt = new THREE.CanvasTexture(T.normalFromHeight(h, S, 0.55));
    nt.wrapS = nt.wrapT = THREE.RepeatWrapping;
    nt.repeat.set(4, 4);
    M.water.normalMap = nt;
    M.water.normalScale = new THREE.Vector2(0.55, 0.55);
  }

  // ---- emissive / lights ----
  M.lampWarm = new THREE.MeshStandardMaterial({ color: 0xfff0d8, emissive: 0xffd9a0, emissiveIntensity: 1.2, roughness: 0.6 });
  M.lampShade = new THREE.MeshStandardMaterial({ color: 0xf2ece0, emissive: 0xffcf96, emissiveIntensity: 0.35, roughness: 0.85, side: THREE.DoubleSide });
  M.screen = new THREE.MeshStandardMaterial({ color: 0x0a0c0e, emissive: 0x2c3a4a, emissiveIntensity: 0.25, roughness: 0.25 });
  M.blackPaint = new THREE.MeshStandardMaterial({ color: 0x24252a, roughness: 0.62 });
  M.whitePaint = new THREE.MeshStandardMaterial({ color: 0xecebe6, roughness: 0.5 });
  M.greenery = new THREE.MeshStandardMaterial({ color: 0x50703c, roughness: 0.9, flatShading: true });
  M.terracotta = new THREE.MeshStandardMaterial({ color: 0xa66a4c, roughness: 0.8 });
  M.paper = new THREE.MeshStandardMaterial({ color: 0xdedad0, roughness: 0.95 });

  return M;
}
