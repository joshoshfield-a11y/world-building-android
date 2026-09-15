// ---------------------------------------------------------------------------
// Furnishings — every item modelled from primitives, sized to human scale.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { box, slab, boxGeo, cyl, softBox, railing } from './lib.js';
import { artwork } from './textures.js';

const G = 0.03;          // ground FFL
const U = 3.69;          // upper FFL

function grp(x, y, z, ry = 0) {
  const g = new THREE.Group();
  g.position.set(x, y, z); g.rotation.y = ry;
  return g;
}

/* ------------------------------- seating -------------------------------- */
function sofa(M, w = 2.6, d = 0.95, arms = true) {
  const g = new THREE.Group();
  g.add(box(w, 0.09, d, M.blackPaint, 0, 0.13, 0, 0.4));                 // plinth
  const seat = softBox(w - 0.16, 0.24, d - 0.12, 0.07, M.sofa);
  seat.position.set(0, 0.34, 0.03); g.add(seat);
  const back = softBox(w - 0.16, 0.52, 0.20, 0.07, M.sofa);
  back.position.set(0, 0.62, -d / 2 + 0.13); g.add(back);
  if (arms) {
    [-1, 1].forEach((s) => {
      const a = softBox(0.16, 0.34, d - 0.10, 0.06, M.sofa);
      a.position.set(s * (w / 2 - 0.08), 0.48, 0.02); g.add(a);
    });
  }
  const n = Math.max(2, Math.round(w / 0.85));
  for (let i = 0; i < n; i++) {
    const c = softBox(0.44, 0.42, 0.14, 0.06, M.cushion);
    c.position.set(-w / 2 + (w / n) * (i + 0.5), 0.66, -d / 2 + 0.26);
    c.rotation.x = -0.16; g.add(c);
  }
  [-1, 1].forEach((s) => {
    const p = softBox(0.36, 0.36, 0.13, 0.06, M.rug);
    p.position.set(s * (w / 2 - 0.42), 0.55, -d / 2 + 0.34);
    p.rotation.set(-0.35, s * 0.2, s * 0.1); g.add(p);
  });
  return g;
}

function armchair(M) {
  const g = new THREE.Group();
  const seat = softBox(0.66, 0.16, 0.62, 0.05, M.cushion);
  seat.position.y = 0.40; g.add(seat);
  const back = softBox(0.66, 0.50, 0.10, 0.05, M.cushion);
  back.position.set(0, 0.68, -0.27); back.rotation.x = -0.14; g.add(back);
  [-1, 1].forEach((s) => {
    const a = box(0.06, 0.20, 0.56, M.walnut, s * 0.33, 0.50, 0, 0.4); g.add(a);
  });
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => {
    const l = cyl(0.018, 0.022, 0.35, M.walnut, a * 0.27, 0.18, b * 0.24, 8);
    l.rotation.set(b * 0.06, 0, -a * 0.06); g.add(l);
  });
  return g;
}

function chair(M, tall = 0.86) {
  const g = new THREE.Group();
  g.add(box(0.44, 0.045, 0.44, M.walnut, 0, 0.44, 0, 0.4));
  const b = box(0.42, tall - 0.50, 0.04, M.walnut, 0, 0.44 + (tall - 0.50) / 2, -0.20, 0.4);
  b.rotation.x = -0.08; g.add(b);
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, c]) => {
    g.add(cyl(0.016, 0.018, 0.44, M.steelBlack, a * 0.19, 0.22, c * 0.19, 6));
  });
  return g;
}

function stool(M) {
  const g = new THREE.Group();
  g.add(box(0.36, 0.04, 0.34, M.walnut, 0, 0.66, 0, 0.3));
  g.add(box(0.34, 0.30, 0.035, M.walnut, 0, 0.84, -0.15, 0.3));
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, c]) =>
    g.add(cyl(0.013, 0.015, 0.66, M.steelBlack, a * 0.15, 0.33, c * 0.14, 6)));
  return g;
}

function table(M, w, d, h = 0.75, top = null) {
  const g = new THREE.Group();
  g.add(box(w, 0.045, d, top || M.walnut, 0, h, 0, 1.2));
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) =>
    g.add(box(0.06, h - 0.05, 0.06, M.steelBlack, a * (w / 2 - 0.14), (h - 0.05) / 2, b * (d / 2 - 0.12), 0.4)));
  return g;
}

function bed(M, w = 1.8, l = 2.05) {
  const g = new THREE.Group();
  g.add(box(w + 0.1, 0.22, l + 0.06, M.walnut, 0, 0.20, 0, 1.0));        // base
  g.add(box(w + 0.14, 0.62, 0.09, M.cushion, 0, 0.62, -l / 2 - 0.03, 0.5)); // headboard
  const mat = softBox(w, 0.24, l, 0.05, M.bed);
  mat.position.y = 0.43; g.add(mat);
  const duvet = softBox(w + 0.07, 0.16, l * 0.68, 0.06, M.bed);
  duvet.position.set(0, 0.53, l * 0.14); g.add(duvet);
  const fold = softBox(w + 0.08, 0.07, 0.26, 0.04, M.bed);
  fold.position.set(0, 0.615, l * 0.14 - l * 0.34 + 0.05); g.add(fold);
  const np = Math.round(w / 0.75);
  for (let i = 0; i < np; i++) {
    const p = softBox(0.64, 0.17, 0.34, 0.07, M.bed);
    p.position.set(-w / 2 + (w / np) * (i + 0.5), 0.635, -l / 2 + 0.30);
    p.rotation.x = 0.26; g.add(p);
  }
  const throwb = softBox(w * 0.86, 0.05, 0.5, 0.025, M.rug);
  throwb.position.set(0, 0.545, l / 2 - 0.14); throwb.rotation.y = 0.015; g.add(throwb);
  const drape = softBox(w * 0.86, 0.30, 0.05, 0.025, M.rug);
  drape.position.set(0, 0.40, l / 2 + 0.10); g.add(drape);
  return g;
}

/* ------------------------------- storage -------------------------------- */
function cabinetRun(M, len, h, d, doors = true, handles = true) {
  const g = new THREE.Group();
  g.add(box(len, h - 0.06, d, M.walnut, 0, (h - 0.06) / 2 + 0.06, 0, 1.1));
  g.add(box(len - 0.06, 0.06, d - 0.06, M.blackPaint, 0, 0.03, 0, 0.4));
  if (doors) {
    const n = Math.max(1, Math.round(len / 0.6));
    for (let i = 0; i < n; i++) {
      const x = -len / 2 + (len / n) * (i + 0.5);
      g.add(box((len / n) - 0.012, h - 0.09, 0.02, M.walnut, x, (h - 0.06) / 2 + 0.06, d / 2 + 0.01, 1.1));
      if (handles) g.add(box((len / n) - 0.2, 0.012, 0.02, M.steelBlack, x, h - 0.13, d / 2 + 0.03, 0.2));
    }
  }
  return g;
}

function shelfUnit(M, w, h, d, shelves = 4) {
  const g = new THREE.Group();
  g.add(box(0.035, h, d, M.walnut, -w / 2, h / 2, 0, 0.9));
  g.add(box(0.035, h, d, M.walnut, w / 2, h / 2, 0, 0.9));
  for (let i = 0; i <= shelves; i++)
    g.add(box(w, 0.032, d, M.walnut, 0, (h / shelves) * i, 0, 0.9));
  // books & objects
  for (let i = 0; i <= shelves - 1; i++) {
    let x = -w / 2 + 0.08;
    while (x < w / 2 - 0.2) {
      const bw = 0.03 + Math.random() * 0.09, bh = 0.17 + Math.random() * 0.08;
      const c = new THREE.Color().setHSL(0.05 + Math.random() * 0.12, 0.16 + Math.random() * 0.3, 0.28 + Math.random() * 0.45);
      const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 });
      const b = box(bw, bh, d * 0.68, m, x + bw / 2, (h / shelves) * i + bh / 2 + 0.02, 0, 0);
      if (Math.random() > 0.85) { b.rotation.z = 0.16; b.position.y -= 0.01; }
      g.add(b); x += bw + 0.006 + Math.random() * 0.07;
    }
  }
  return g;
}

/* ------------------------------ accessories ----------------------------- */
function plant(M, h = 1.3, pot = 0.26) {
  const g = new THREE.Group();
  g.add(cyl(pot, pot * 0.82, pot * 1.5, M.terracotta, 0, pot * 0.75, 0, 16));
  g.add(cyl(pot * 0.9, pot * 0.9, 0.05, M.plasterDark, 0, pot * 1.46, 0, 14));
  const n = 9 + Math.floor(Math.random() * 4);
  const leafGeo = new THREE.SphereGeometry(0.125, 7, 5);
  leafGeo.scale(1, 0.16, 1.55);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.6;
    const r = 0.03 + Math.random() * 0.07;
    const len = h * (0.42 + Math.random() * 0.58);
    const tilt = 0.18 + Math.random() * 0.3;
    const dir = new THREE.Vector3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
    const base = new THREE.Vector3(Math.cos(a) * r, pot * 1.5, Math.sin(a) * r);
    const st = cyl(0.007, 0.011, len, M.greenery, 0, 0, 0, 5);
    st.position.copy(base).add(dir.clone().multiplyScalar(len / 2));
    st.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    g.add(st);
    const tip = base.clone().add(dir.clone().multiplyScalar(len));
    const nl = 1 + (Math.random() > 0.55 ? 1 : 0);
    for (let j = 0; j < nl; j++) {
      const sc = (0.72 + Math.random() * 0.5) * Math.min(1.35, h);
      const leaf = new THREE.Mesh(leafGeo, Math.random() > 0.45 ? M.foliage : M.foliage2);
      leaf.scale.setScalar(sc);
      const out = new THREE.Vector3(Math.cos(a + (j - 0.5) * 0.9), 0.25, Math.sin(a + (j - 0.5) * 0.9)).normalize();
      leaf.position.copy(tip).add(out.clone().multiplyScalar(0.14 * sc)).add(new THREE.Vector3(0, -0.02, 0));
      leaf.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), out);
      leaf.rotateOnAxis(new THREE.Vector3(0, 0, 1), Math.random() * 3);
      leaf.rotateOnAxis(new THREE.Vector3(1, 0, 0), -0.25 - Math.random() * 0.3);
      leaf.castShadow = true;
      g.add(leaf);
    }
  }
  return g;
}

function rugMesh(M, w, d) {
  const m = box(w, 0.014, d, M.rug, 0, 0.007, 0, 1.4);
  m.castShadow = false;
  return m;
}

function lampFloor(M, store) {
  const g = new THREE.Group();
  g.add(cyl(0.14, 0.16, 0.025, M.steelBlack, 0, 0.012, 0, 14));
  g.add(cyl(0.012, 0.012, 1.5, M.steelBlack, 0, 0.75, 0, 8));
  const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.19, 0.26, 18, 1, true), M.lampShade);
  sh.position.y = 1.56; g.add(sh);
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), M.lampWarm);
  b.position.y = 1.5; g.add(b);
  store.emissives.push(sh, b);
  return g;
}

function tableLamp(M, store, s = 1) {
  const g = new THREE.Group();
  g.add(cyl(0.05, 0.07, 0.02, M.brass, 0, 0.01, 0, 12));
  g.add(cyl(0.014, 0.014, 0.26 * s, M.brass, 0, 0.14 * s, 0, 8));
  const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.10 * s, 0.13 * s, 0.17 * s, 16, 1, true), M.lampShade);
  sh.position.y = 0.34 * s; g.add(sh);
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), M.lampWarm);
  b.position.y = 0.32 * s; g.add(b);
  store.emissives.push(sh, b);
  return g;
}

let artSeed = 0;
function art(M, w, h) {
  const g = new THREE.Group();
  g.add(box(w, h, 0.035, M.blackPaint, 0, 0, 0, 0.6));
  const m = new THREE.MeshStandardMaterial({ map: artwork(++artSeed).map, roughness: 0.92 });
  g.add(box(w - 0.09, h - 0.09, 0.012, m, 0, 0, 0.026, 0));
  return g;
}

function bowl(M, r = 0.14) {
  const g = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 8, 0, Math.PI * 2, Math.PI * 0.52, Math.PI * 0.48), M.whitePaint);
  g.position.y = r * 0.5; g.castShadow = true;
  return g;
}

/* ------------------------------ bathroom -------------------------------- */
function vanity(M, w = 1.6) {
  const g = new THREE.Group();
  g.add(box(w, 0.5, 0.5, M.walnut, 0, 0.62, 0, 1.0));
  g.add(box(w + 0.04, 0.045, 0.54, M.marble, 0, 0.89, 0, 1.0));
  g.add(box(w - 0.1, 0.012, 0.02, M.steelBlack, 0, 0.62, 0.26, 0.2));
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.16, 0.11, 20), M.whitePaint);
  basin.position.set(0, 0.965, 0); basin.castShadow = true; g.add(basin);
  const tap = cyl(0.011, 0.011, 0.26, M.alu, 0, 1.04, -0.19, 8); g.add(tap);
  g.add(box(0.02, 0.012, 0.13, M.alu, 0, 1.16, -0.13, 0.2));
  return g;
}

function wc(M) {
  const g = new THREE.Group();
  g.add(box(0.36, 1.0, 0.22, M.marble, 0, 0.5, -0.11, 0.8));
  const p = softBox(0.36, 0.36, 0.56, 0.1, M.whitePaint);
  p.position.set(0, 0.42, 0.2); g.add(p);
  g.add(box(0.36, 0.05, 0.5, M.whitePaint, 0, 0.42, 0.22, 0));
  return g;
}

function tub(M) {
  const g = new THREE.Group();
  const outer = softBox(0.82, 0.56, 1.75, 0.16, M.whitePaint);
  outer.position.y = 0.30; g.add(outer);
  const inner = softBox(0.66, 0.4, 1.58, 0.12, M.plasterDark);
  inner.position.y = 0.44; g.add(inner);
  const water = box(0.64, 0.02, 1.56, M.water, 0, 0.5, 0, 0);
  g.add(water);
  g.add(cyl(0.012, 0.012, 0.5, M.alu, 0, 0.55, -0.95, 8));
  return g;
}

function shower(M, w, d) {
  const g = new THREE.Group();
  g.add(box(w, 0.03, d, M.stonePaving, 0, 0.015, 0, 0.9));
  const pane = new THREE.Mesh(boxGeo(w, 2.1, 0.012, 0), M.glassBalustrade);
  pane.position.set(0, 1.05, d / 2); pane.renderOrder = 3; g.add(pane);
  g.add(box(w, 0.04, 0.04, M.steelBlack, 0, 2.1, d / 2, 0.4));
  const head = box(0.22, 0.02, 0.22, M.alu, 0, 2.12, -d / 2 + 0.35, 0.2); g.add(head);
  g.add(cyl(0.01, 0.01, 0.3, M.alu, 0, 2.12, -d / 2 + 0.2, 6).rotateZ(0));
  return g;
}

/* ============================== ROOM SETS ============================== */
export function buildFurniture(M, store) {
  const F = new THREE.Group(); F.name = 'furnishings';
  const up = new THREE.Group(); up.name = 'furnishings-upper';
  F.add(up);

  /* ---------------- LIVING ROOM (x -8.7..-1.5, z -4.7..4.8) ------------- */
  const liv = grp(0, G, 0);
  const sf = sofa(M, 2.9, 1.0); sf.position.set(-5.4, 0, -3.3); liv.add(sf);
  const sf2 = sofa(M, 2.0, 0.95, false); sf2.position.set(-7.5, 0, -1.5); sf2.rotation.y = Math.PI / 2; liv.add(sf2);
  liv.add(rugMesh(M, 3.9, 3.2).translateX(-5.5).translateZ(-1.4));
  const ct = table(M, 1.3, 0.66, 0.36); ct.position.set(-5.3, 0, -1.35); liv.add(ct);
  liv.add(bowl(M, 0.13).translateX(-5.5).translateY(0.4).translateZ(-1.35));
  const bk = box(0.24, 0.05, 0.3, M.paper, -4.95, 0.395, -1.4, 0); bk.rotation.y = 0.4; liv.add(bk);
  const ac1 = armchair(M); ac1.position.set(-4.3, 0, -0.4); ac1.rotation.y = Math.PI + 0.5; liv.add(ac1);
  const ac2 = armchair(M); ac2.position.set(-6.6, 0, 0.1); ac2.rotation.y = Math.PI - 0.4; liv.add(ac2);
  liv.add(lampFloor(M, store).translateX(-8.1).translateZ(-3.9));
  const sh1 = shelfUnit(M, 1.7, 2.1, 0.32, 5); sh1.position.set(-2.05, 0, 1.6); sh1.rotation.y = -Math.PI / 2; liv.add(sh1);
  const sb = cabinetRun(M, 2.2, 0.55, 0.42); sb.position.set(-5.0, 0, 4.2); liv.add(sb);
  liv.add(plant(M, 1.5, 0.3).translateX(-8.25).translateZ(4.35));
  liv.add(plant(M, 0.9, 0.2).translateX(-2.1).translateZ(4.2));
  // artwork on the west blade wall
  const a1 = art(M, 1.5, 1.05, 0.07); a1.position.set(-8.6, 1.75, -3.0); a1.rotation.y = Math.PI / 2; liv.add(a1);
  F.add(liv);

  /* ---------------- HALL ---------------- */
  const hall = grp(0, G, 0);
  const cons = cabinetRun(M, 1.5, 0.72, 0.36, true, true); cons.position.set(2.28, 0, -1.4);
  cons.rotation.y = -Math.PI / 2; hall.add(cons);
  hall.add(tableLamp(M, store).translateX(2.28).translateY(0.72).translateZ(-1.9));
  const a2 = art(M, 0.9, 1.3, 0.55); a2.position.set(2.32, 1.75, -1.2); a2.rotation.y = -Math.PI / 2; hall.add(a2);
  hall.add(plant(M, 1.1, 0.24).translateX(1.9).translateZ(-4.1));
  const bnc = bench(M, 1.3); bnc.position.set(-0.6, 0, -4.28); hall.add(bnc);
  F.add(hall);

  /* ---------------- KITCHEN + DINING (x 2.6..8.7) ---------------- */
  const k = grp(0, G, 0);
  // tall units + base run along the north wall
  const tall = cabinetRun(M, 2.6, 2.35, 0.62); tall.position.set(4.2, 0, -4.35); k.add(tall);
  const base = cabinetRun(M, 2.4, 0.9, 0.62); base.position.set(7.3, 0, -4.35); k.add(base);
  k.add(box(2.5, 0.04, 0.66, M.marble, 7.3, 0.92, -4.35, 1.2));
  k.add(box(2.5, 0.5, 0.03, M.marble, 7.3, 1.2, -4.65, 1.2));            // splashback
  const upper = cabinetRun(M, 2.4, 0.72, 0.36); upper.position.set(7.3, 1.55, -4.5); k.add(upper);
  // island
  const isl = grp(5.9, 0, 1.7);
  isl.add(box(3.0, 0.86, 1.05, M.walnut, 0, 0.47, 0, 1.1));
  isl.add(box(3.16, 0.055, 1.18, M.marble, 0, 0.92, 0, 1.4));
  isl.add(box(0.44, 0.012, 0.34, M.steelDark, -0.7, 0.945, 0, 0.3));      // hob
  isl.add(box(0.34, 0.008, 0.28, M.alu, 0.6, 0.947, -0.05, 0.3));         // sink
  isl.add(cyl(0.014, 0.014, 0.34, M.alu, 0.6, 1.1, -0.3, 8));
  isl.add(bowl(M, 0.12).translateX(0.05).translateY(0.95));
  k.add(isl);
  for (let i = 0; i < 3; i++) {
    const s = stool(M); s.position.set(5.0 + i * 0.9, 0, 2.55); s.rotation.y = Math.PI; k.add(s);
  }
  // dining
  const dt = table(M, 2.3, 1.0, 0.75); dt.position.set(6.5, 0, 3.9); k.add(dt);
  for (let i = 0; i < 3; i++) {
    const c1 = chair(M); c1.position.set(5.7 + i * 0.8, 0, 3.3); c1.rotation.y = Math.PI; k.add(c1);
    const c2 = chair(M); c2.position.set(5.7 + i * 0.8, 0, 4.5); k.add(c2);
  }
  k.add(bowl(M, 0.16).translateX(6.5).translateY(0.78).translateZ(3.9));
  k.add(plant(M, 1.2, 0.26).translateX(8.2).translateZ(4.2));
  const ka = art(M, 0.7, 0.95); ka.position.set(8.78, 1.7, 1.4); ka.rotation.y = -Math.PI / 2; k.add(ka);
  F.add(k);

  /* ---------------- POWDER ROOM (2.6..4.55, 2.7..4.8) ---------------- */
  const pr = grp(0, G, 0);
  const v0 = vanity(M, 1.0); v0.position.set(3.55, 0, 2.95); pr.add(v0);
  const mir = box(0.9, 1.0, 0.02, M.mirror, 3.55, 1.65, 2.74, 0); pr.add(mir);
  const w0 = wc(M); w0.position.set(4.25, 0, 4.45); w0.rotation.y = Math.PI; pr.add(w0);
  F.add(pr);

  /* ================= UPPER: MASTER SUITE ================= */
  const ms = grp(0, U, 0);
  const bd = bed(M, 1.9, 2.1); bd.position.set(5.2, 0, 2.55); ms.add(bd);
  ms.add(rugMesh(M, 3.6, 3.0).translateX(5.2).translateZ(3.4));
  [3.85, 6.55].forEach((x) => {
    const ns = box(0.5, 0.42, 0.42, M.walnut, x, 0.21, 1.6, 0.8); ms.add(ns);
    ms.add(tableLamp(M, store, 0.85).translateX(x).translateY(0.42).translateZ(1.6));
  });
  const bnch = bench(M, 1.5); bnch.position.set(5.2, 0, 4.95); ms.add(bnch);
  const wr = cabinetRun(M, 3.4, 2.4, 0.6); wr.position.set(3.6, 0, 2.05);
  wr.rotation.y = Math.PI / 2; wr.position.set(2.1, 0, 3.6); ms.add(wr);
  const ac3 = armchair(M); ac3.position.set(7.9, 0, 5.7); ac3.rotation.y = -2.3; ms.add(ac3);
  ms.add(plant(M, 1.3, 0.26).translateX(8.2).translateZ(2.0));
  const a3 = art(M, 1.6, 0.9, 0.1); a3.position.set(5.2, 1.55, 1.2); ms.add(a3);
  up.add(ms);

  /* ================= UPPER: ENSUITE (1.74..8.7, -4.85..0.9) ============ */
  const es = grp(0, U, 0);
  const tb = tub(M); tb.position.set(7.9, 0, -3.0); es.add(tb);
  const v1 = vanity(M, 1.9); v1.position.set(4.4, 0, 0.55); v1.rotation.y = Math.PI; es.add(v1);
  es.add(box(1.7, 1.1, 0.02, M.mirror, 4.4, 1.65, 0.79, 0));
  const sw = shower(M, 1.5, 1.5); sw.position.set(2.7, 0, -4.0); es.add(sw);
  const w1 = wc(M); w1.position.set(2.15, 0, -1.55); w1.rotation.y = Math.PI / 2; es.add(w1);
  es.add(plant(M, 0.8, 0.18).translateX(8.2).translateZ(-0.4));
  up.add(es);

  /* ================= UPPER: BEDROOM 2 (south-west) ==================== */
  const b2 = grp(0, U, 0);
  const bd2 = bed(M, 1.6, 2.0); bd2.position.set(-3.9, 0, 3.9); b2.add(bd2);
  b2.add(rugMesh(M, 3.0, 2.4).translateX(-3.9).translateZ(4.6));
  b2.add(box(0.44, 0.4, 0.4, M.walnut, -2.8, 0.2, 3.05, 0.8));
  b2.add(tableLamp(M, store, 0.8).translateX(-2.8).translateY(0.4).translateZ(3.05));
  const wr2 = cabinetRun(M, 2.2, 2.2, 0.58); wr2.position.set(-1.4, 0, 5.4); wr2.rotation.y = -Math.PI / 2; b2.add(wr2);
  const ac4 = armchair(M); ac4.position.set(-5.0, 0, 6.1); ac4.rotation.y = 0.5; b2.add(ac4);
  const dsk = table(M, 1.2, 0.55, 0.73); dsk.position.set(-5.0, 0, 2.95); b2.add(dsk);
  const cu2 = curtainPanel(M, 1.15, 2.42); cu2.position.set(-5.15, 1.24, 6.58); b2.add(cu2);
  b2.add(box(4.3, 0.05, 0.05, M.steelBlack, -3.6, 2.5, 6.6, 0.4));
  up.add(b2);

  /* ================= UPPER: BEDROOM 3 (north-west) ==================== */
  const b3 = grp(0, U, 0);
  const bd3 = bed(M, 1.4, 2.0); bd3.position.set(-4.4, 0, 1.2); bd3.rotation.y = Math.PI; up.add(bd3.translateY(U));
  b3.add(rugMesh(M, 2.4, 2.0).translateX(-4.4).translateZ(0.4));
  const dsk2 = table(M, 1.4, 0.6, 0.73); dsk2.position.set(-3.6, 0, -1.05); b3.add(dsk2);
  const c3 = chair(M); c3.position.set(-3.6, 0, -0.35); c3.rotation.y = Math.PI; b3.add(c3);
  b3.add(shelfUnit(M, 1.0, 1.2, 0.28, 3).translateX(-1.7).translateZ(-0.6));
  b3.add(tableLamp(M, store, 0.8).translateX(-3.1).translateY(0.75).translateZ(-1.15));
  up.add(b3);

  /* ================= UPPER: BATH 2 (north-west) ==================== */
  const b4 = grp(0, U, 0);
  const v2 = vanity(M, 1.2); v2.position.set(-4.9, 0, -2.75); v2.rotation.y = Math.PI; b4.add(v2);
  b4.add(box(1.0, 1.0, 0.02, M.mirror, -4.9, 1.6, -2.51, 0));
  const sw2 = shower(M, 1.3, 1.3); sw2.position.set(-1.85, 0, -4.1); b4.add(sw2);
  const w2 = wc(M); w2.position.set(-2.2, 0, -3.0); w2.rotation.y = -Math.PI / 2; b4.add(w2);
  up.add(b4);

  /* ================= UPPER: LANDING ==================== */
  const ld = grp(0, U, 0);
  const ac5 = armchair(M); ac5.position.set(0.9, 0, 5.9); ac5.rotation.y = -0.7; ld.add(ac5);
  ld.add(shelfUnit(M, 1.5, 1.5, 0.28, 4).translateX(0.4).translateZ(4.75).rotateY(Math.PI));
  ld.add(plant(M, 1.15, 0.22).translateX(1.3).translateZ(4.9));
  up.add(ld);

  /* ================= ROOF TERRACE (x -8.8..-6.1) ==================== */
  const rt = grp(0, 3.71, 0);
  for (let i = 0; i < 2; i++) {
    const lg = lounger(M); lg.position.set(-7.4, 0, -2.4 + i * 2.0); lg.rotation.y = -Math.PI / 2 + 0.06; rt.add(lg);
  }
  rt.add(box(0.5, 0.36, 0.5, M.deck, -8.2, 0.18, -1.4, 0.5));
  rt.add(planterBox(M, 2.4, 0.5));
  const pbx = planterBox(M, 2.0, 0.45); pbx.position.set(-7.4, 0, 3.5); rt.add(pbx);
  store.roofTerraceFurniture = rt; F.add(rt);

  /* ================= MAIN TERRACE ==================== */
  const tr = grp(0, 0, 0);
  const odt = table(M, 2.6, 1.1, 0.75, M.deck); odt.position.set(4.6, 0, 6.5); tr.add(odt);
  for (let i = 0; i < 3; i++) {
    const c1 = chair(M); c1.position.set(3.85 + i * 0.78, 0, 5.85); c1.rotation.y = Math.PI; tr.add(c1);
    const c2 = chair(M); c2.position.set(3.85 + i * 0.78, 0, 7.15); tr.add(c2);
  }
  // lounge cluster under the pergola
  const os = sofa(M, 2.4, 0.95, false); os.position.set(-5.6, 0, 6.35); tr.add(os);
  const os2 = sofa(M, 1.7, 0.9, false); os2.position.set(-7.9, 0, 7.8); os2.rotation.y = Math.PI / 2; tr.add(os2);
  const oct = table(M, 1.1, 0.7, 0.34, M.stonePaving); oct.position.set(-5.7, 0, 8.0); tr.add(oct);
  tr.add(bowl(M, 0.14).translateX(-5.7).translateY(0.38).translateZ(8.0));
  for (let i = 0; i < 2; i++) {
    const lg = lounger(M); lg.position.set(-4.9 + i * 1.7, 0, 10.2); lg.rotation.y = Math.PI; tr.add(lg);
  }
  const pl1 = planterBox(M, 3.0, 0.55); pl1.position.set(1.0, 0, 10.6); tr.add(pl1);
  const pl2 = planterBox(M, 2.2, 0.55); pl2.position.set(8.0, 0, 8.4); pl2.rotation.y = Math.PI / 2; tr.add(pl2);
  tr.add(plant(M, 1.3, 0.3).translateX(2.3).translateZ(5.8));
  F.add(tr);

  store.upperFurniture = up;
  return F;
}

function bench(M, w) {
  const g = new THREE.Group();
  const c = softBox(w, 0.13, 0.42, 0.05, M.cushion);
  c.position.y = 0.42; g.add(c);
  [-1, 1].forEach((s) => {
    g.add(box(0.045, 0.36, 0.38, M.walnut, s * (w / 2 - 0.06), 0.18, 0, 0.4));
  });
  g.add(box(w - 0.2, 0.035, 0.05, M.walnut, 0, 0.12, 0, 0.4));
  return g;
}

function curtainPanel(M, w, h, folds = 7) {
  const g = new THREE.PlaneGeometry(w, h, folds * 4, 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    p.setZ(i, Math.sin((x / w) * Math.PI * 2 * folds) * 0.045);
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, M.curtain);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

function lounger(M) {
  const g = new THREE.Group();
  g.add(box(0.66, 0.10, 1.95, M.deck, 0, 0.30, 0, 0.9));
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) =>
    g.add(box(0.05, 0.26, 0.05, M.deck, a * 0.28, 0.14, b * 0.85, 0.4)));
  const cush = softBox(0.62, 0.10, 1.3, 0.04, M.bed);
  cush.position.set(0, 0.40, 0.3); g.add(cush);
  const bk = softBox(0.62, 0.09, 0.72, 0.04, M.bed);
  bk.position.set(0, 0.56, -0.62); bk.rotation.x = -0.55; g.add(bk);
  return g;
}

function planterBox(M, len, h) {
  const g = new THREE.Group();
  g.add(box(len, h, 0.55, M.concreteDark, 0, h / 2, 0, 1.2));
  g.add(box(len - 0.12, 0.08, 0.44, M.plasterDark, 0, h - 0.02, 0, 0.6));
  const n = Math.round(len / 0.34);
  for (let i = 0; i < n; i++) {
    const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2 + Math.random() * 0.11, 0), Math.random() > 0.5 ? M.foliage : M.foliageDark);
    s.position.set(-len / 2 + (len / n) * (i + 0.5) + (Math.random() - 0.5) * 0.1, h + 0.12 + Math.random() * 0.1, (Math.random() - 0.5) * 0.22);
    s.scale.y = 0.8; s.castShadow = true; g.add(s);
    if (Math.random() > 0.5) {
      const gr = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.55, 4), M.foliage2);
      gr.position.copy(s.position).add(new THREE.Vector3(0.1, 0.22, 0.05));
      gr.rotation.z = (Math.random() - 0.5) * 0.5; g.add(gr);
    }
  }
  return g;
}
