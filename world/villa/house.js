// ---------------------------------------------------------------------------
// VILLA RAVINE — procedural architectural model.
// Hierarchy:  house
//   ├ structure/  (slabs, plinth, hipped roof, columns, beams)
//   ├ envelope/   (exterior walls per elevation, each with real openings)
//   ├ partitions/ (interior walls per level)
//   ├ glazing/    (curtain walls, punched windows, doors)
//   ├ circulation/(stair, balustrades, gallery)
//   ├ terraces/   (decks, railings, pergola, steps)
//   └ fixtures/   (fixed lighting, joinery cores)
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { box, slab, boxGeo, wallGroup, frame, glazing, railing, stair, cyl, softBox } from './lib.js';
import { hipRoof } from './roof.js';

// ---- dimensional scheme (metres) ------------------------------------------
export const D = {
  grade: -0.45,
  fl0: 0.03,          // ground finished floor level
  slab0: [-0.60, 0],  // ground slab
  h0: 3.30,           // underside of upper slab
  slab1: [3.30, 3.66],
  fl1: 3.69,
  h1: 6.56,           // underside of roof slab
  roof: [6.56, 6.92],
  // envelopes
  g: { x0: -9, x1: 9, z0: -5, z1: 5, t: 0.34 },
  u: { x0: -6, x1: 9, z0: -5, z1: 7, t: 0.30 },
  ti: 0.12,           // interior partition, ground
  ti1: 0.14,
};

const INSET = 0.10;   // how deep glazing sits behind the outer face

function faceMats(outer, inner, outerIsPlus) {
  const o = outer, i = inner;
  return outerIsPlus ? [o, o, o, o, o, i] : [o, o, o, o, i, o];
}

/**
 * Build a wall + all its units (glazing / doors) from one data description.
 * axis 'x' -> spans X at z=at ; axis 'z' -> spans Z at x=at.
 * outer: +1 if the exterior face is on the +normal side.
 */
function buildWall(cfg, M, store) {
  const { axis, from, to, at, t, base, height, outer, openings = [] } = cfg;
  const len = to - from;
  const mats = cfg.mats || faceMats(M.concrete, M.plaster, axis === 'x' ? outer > 0 : outer < 0);
  const g = wallGroup({
    length: len, height, thickness: t, mat: mats, tile: cfg.tile ?? 2.2,
    openings: openings.map((o) => ({ x0: o.a - from, x1: o.b - from, y0: o.y0, y1: o.y1 })),
  });
  if (axis === 'z') { g.rotation.y = -Math.PI / 2; g.position.set(at, base, from); }
  else g.position.set(from, base, at);
  store.walls.add(g);

  // --- units inside the openings ---
  for (const o of openings) {
    if (!o.type || o.type === 'void') continue;
    const w = (o.b - o.a) - 0.02, h = (o.y1 - o.y0) - 0.02;
    const cu = (o.a + o.b) / 2;                       // centre along the wall
    const cy = base + (o.y0 + o.y1) / 2;
    const depth = o.depth ?? 0.10;
    const n = at + outer * (t / 2 - (o.inset ?? INSET) - depth / 2);
    let unit;
    if (o.type === 'glass') {
      unit = glazing({
        w, h, sec: o.sec ?? 0.06, depth, panels: o.panels ?? Math.max(1, Math.round(w / 1.5)),
        transom: o.transom ?? null, frameMat: o.frameMat || M.steelDark, glassMat: M.glass,
        horizontalBars: o.bars ?? 0,
      });
      if (o.frosted) unit.userData.glass.material = M.frostedGlass;
    } else if (o.type === 'door') {
      unit = doorUnit(w, h, depth, M, o);
    }
    if (!unit) continue;
    if (axis === 'z') { unit.rotation.y = Math.PI / 2; unit.position.set(n, cy, cu); }
    else unit.position.set(cu, cy, n);
    store.glazing.add(unit);
    if (o.tag) store.tagged[o.tag] = unit;
    // reveal lining (thin plaster/timber return around the opening)
    if (o.lining !== false) {
      const lm = o.liningMat || cfg.liningMat || M.plaster;
      const lg = new THREE.Group();
      const d2 = t - 0.02;
      const ow = o.b - o.a, oh = o.y1 - o.y0;
      lg.add(box(0.02, oh, d2, lm, -ow / 2 + 0.01, 0, 0, 1));
      lg.add(box(0.02, oh, d2, lm, ow / 2 - 0.01, 0, 0, 1));
      lg.add(box(ow, 0.02, d2, lm, 0, oh / 2 - 0.01, 0, 1));
      lg.add(box(ow, 0.02, d2, lm, 0, -oh / 2 + 0.01, 0, 1));
      if (axis === 'z') { lg.rotation.y = Math.PI / 2; lg.position.set(at, cy, cu); }
      else lg.position.set(cu, cy, at);
      store.walls.add(lg);
    }
  }
  return g;
}

/** door leaf + frame, optional glazed panel */
function doorUnit(w, h, depth, M, o) {
  const g = new THREE.Group();
  const f = frame(w, h, 0.05, depth, o.frameMat || M.steelDark, 0.4);
  g.add(f);
  const lw = w - 0.12, lh = h - 0.08;
  const leaf = new THREE.Group();
  if (o.glazedDoor) {
    const fr = frame(lw, lh, 0.07, 0.055, o.leafMat || M.steelDark, 0.4);
    leaf.add(fr);
    const gl = new THREE.Mesh(boxGeo(lw - 0.14, lh - 0.14, 0.012, 0), M.glass);
    gl.renderOrder = 3; leaf.add(gl);
  } else {
    leaf.add(box(lw, lh, 0.05, o.leafMat || M.walnut, 0, 0, 0, 1.1));
  }
  // handle
  const hd = cyl(0.011, 0.011, 0.16, M.steelBlack, lw / 2 - 0.10, -0.02, 0.05, 8);
  hd.rotation.x = Math.PI / 2; leaf.add(hd);
  // +lw/2, so the leaf's *left* edge lands on the pivot and the leaf fills the
  // opening. At -lw/2 its right edge lands there instead and a shut door hangs
  // entirely beside its own doorway — 1.9 m clear of it at this scene's scale,
  // which reads as a hole in the wall with a plank next to it.
  leaf.position.x = lw / 2;                      // hinge at left jamb
  const pivot = new THREE.Group();
  pivot.position.x = -w / 2 + 0.06;
  pivot.add(leaf);
  pivot.rotation.y = o.open ? -0.7 : 0;
  g.add(pivot);
  g.userData.pivot = pivot;
  return g;
}

/** Continuous curtain-wall / sliding-door system. */
function curtainWall({ from, to, at, y0, y1, axis, outer, panels, M, slide = -1, depth = 0.12 }) {
  const g = new THREE.Group();
  const len = to - from, h = y1 - y0;
  const sec = 0.075;
  const fm = M.steelDark;
  const inner = new THREE.Group();
  inner.add(box(len, 0.07, depth, fm, len / 2, 0.035, 0, 0.5));            // sill track
  inner.add(box(len, 0.09, depth, fm, len / 2, h - 0.045, 0, 0.5));        // head track
  const bay = len / panels;
  for (let i = 0; i <= panels; i++) {
    const wm = (i === 0 || i === panels) ? sec * 1.25 : sec;
    inner.add(box(wm, h - 0.16, depth, fm, from === undefined ? 0 : bay * i, h / 2, 0, 0.5));
  }
  for (let i = 0; i < panels; i++) {
    if (i === slide) continue;
    const gl = new THREE.Mesh(boxGeo(bay - sec, h - 0.17, 0.016, 0), M.glass);
    gl.position.set(bay * (i + 0.5), h / 2, 0);
    gl.renderOrder = 3;
    inner.add(gl);
  }
  if (slide >= 0) {
    const sp = new THREE.Group();
    const sw = bay - sec * 0.5, sh = h - 0.19;
    sp.add(frame(sw, sh, 0.07, 0.06, fm, 0.4));
    const gl = new THREE.Mesh(boxGeo(sw - 0.14, sh - 0.14, 0.014, 0), M.glass);
    gl.renderOrder = 3; sp.add(gl);
    const hd = box(0.03, 0.5, 0.03, M.steelBlack, -sw / 2 + 0.16, 0, 0.05, 0.3);
    sp.add(hd);
    sp.position.set(bay * (slide + 0.5), h / 2, depth * 0.42);
    g.userData.slider = sp;
    g.userData.slideRange = bay - 0.1;
    inner.add(sp);
  }
  g.add(inner);
  if (axis === 'z') { g.rotation.y = -Math.PI / 2; g.position.set(at, y0, from); }
  else g.position.set(from, y0, at);
  return g;
}

// ===========================================================================
export function buildHouse(M) {
  const house = new THREE.Group();
  house.name = 'house';
  const store = {
    structure: new THREE.Group(), walls: new THREE.Group(), glazing: new THREE.Group(),
    circulation: new THREE.Group(), terraces: new THREE.Group(), fixtures: new THREE.Group(),
    upper: new THREE.Group(),           // upper level (toggleable)
    roof: new THREE.Group(),            // main roof (toggleable)
    roofTerrace: new THREE.Group(),     // roof over the west wing + its deck
    tagged: {}, lights: [], emissives: [], animated: [],
  };
  ['structure', 'walls', 'glazing', 'circulation', 'terraces', 'fixtures', 'upper', 'roof', 'roofTerrace'].forEach((k) => {
    store[k].name = k; house.add(store[k]);
  });
  const S = store.structure, G = D.g, U = D.u;

  // frosted glass for bathrooms
  M.frostedGlass = new THREE.MeshPhysicalMaterial({
    color: 0xdfe8e6, roughness: 0.55, metalness: 0, transparent: true, opacity: 0.62,
    side: THREE.DoubleSide,
  });

  // =========================== STRUCTURE ==================================
  // plinth + ground slab (edge stepped for a shadow gap)
  S.add(slab(G.x0 - 0.28, G.x1 + 0.28, D.slab0[0], -0.12, G.z0 - 0.28, G.z1 + 0.28, M.concreteDark, 2.4));
  S.add(slab(G.x0 - 0.14, G.x1 + 0.14, -0.12, 0, G.z0 - 0.14, G.z1 + 0.14, M.concrete, 2.4));
  // interior floor finishes, ground
  const oakG = [
    [G.x0 + G.t, -1.5, G.z0 + G.t, G.z1 - 0.10],       // living
    [-1.5, 2.5, G.z0 + G.t, G.z1 - 0.10],              // hall
    [2.5, G.x1 - G.t, G.z0 + G.t, 2.6],                // kitchen north
    [4.6, G.x1 - G.t, 2.6, G.z1 - 0.10],               // dining bay
  ];
  oakG.forEach((r) => S.add(slab(r[0], r[1], 0, 0.03, r[2], r[3], M.oakFloor, 1.9)));
  S.add(slab(2.5, 4.6, 2.6, 0.03 + 0.0, D.fl0 - 0.03, 0, M.stonePaving)); // (placeholder replaced below)
  S.children.pop();
  S.add(slab(2.5, 4.6, 0, 0.03, 2.6, G.z1 - 0.10, M.stonePaving, 1.2));   // powder room floor

  // ---- upper floor slab (with stair void) ----
  // The stair void, and `z0` is the one number the whole flight hangs off:
  // the top tread has to land at the void's north edge, so the bottom riser is
  // derived from it (see CIRCULATION below) and moving this edge north moves
  // the whole flight north with it, metre for metre, out of the landing.
  //
  // It was -1.1, which left 1.29 m between the bottom riser and the glass. That
  // is a flight you arrive at facing a wall of glass with no room to turn into
  // it — the second thing anyone said about this house both times they walked
  // in. The going was already cut once to buy landing (0.28 -> 0.25) and cutting
  // it again just makes the stair steep. -1.85 buys the same 0.75 m out of the
  // upper corridor instead, which is 2.9 m long afterwards and does not miss it.
  const V = { x0: -1.0, x1: 0.5, z0: -1.85, z1: 3.9 };   // stair void
  const s1 = D.slab1;
  const upMat = [M.concrete, M.concrete, M.concrete, M.ceiling, M.concrete, M.concrete];
  const UP = store.upper, RF = store.roof, RT = store.roofTerrace;
  UP.add(slab(U.x0, V.x0, s1[0], s1[1], U.z0, U.z1, upMat, 2.4));
  UP.add(slab(V.x1, U.x1, s1[0], s1[1], U.z0, U.z1, upMat, 2.4));
  UP.add(slab(V.x0, V.x1, s1[0], s1[1], U.z0, V.z0, upMat, 2.4));
  UP.add(slab(V.x0, V.x1, s1[0], s1[1], V.z1, U.z1, upMat, 2.4));
  // timber-lined soffit under the cantilever + entry canopy
  UP.add(slab(U.x0 + 0.02, U.x1 + 0.16, s1[0] - 0.025, s1[0] + 0.001, G.z1, U.z1 + 0.14, M.batten, 0.42));
  S.add(slab(-2.5, 3.3, 2.585, 2.605, G.z0 - 3.2, G.z0 - 0.02, M.batten, 0.42));
  // slab edge shadow reveal on the cantilever
  UP.add(slab(U.x0 - 0.06, U.x1 + 0.06, s1[0] + 0.04, s1[1] - 0.04, U.z1, U.z1 + 0.06, M.concreteDark, 2));
  // ground-floor roof west of the upper volume  = roof terrace structure
  RT.add(slab(G.x0 - 0.14, U.x0, s1[0], s1[1], G.z0 - 0.14, G.z1 + 0.14, upMat, 2.4));
  // upper floor finishes
  const oakU = [
    [U.x0 + U.t, -1.0, U.z0 + U.t, -1.6],    // bath 2 (stone below)
    [U.x0 + U.t, -1.0, -1.6, U.z1 - U.t],    // bedroom 3 + 2
    [-1.0, 1.6, U.z0 + U.t, V.z0],           // corridor
    [0.5, 1.6, V.z0, V.z1],                  // gallery
    [-1.0, 1.6, V.z1, U.z1 - U.t],           // south landing
    [1.6, U.x1 - U.t, 1.0, U.z1 - U.t],      // master bedroom
  ];
  oakU.forEach((r) => UP.add(slab(r[0], r[1], s1[1], s1[1] + 0.03, r[2], r[3], M.oakFloor, 1.9)));
  UP.add(slab(1.6, U.x1 - U.t, s1[1], s1[1] + 0.03, U.z0 + U.t, 1.0, M.marble, 1.4));   // ensuite
  UP.add(slab(U.x0 + U.t, -1.0, s1[1], s1[1] + 0.03, U.z0 + U.t, -2.4, M.marble, 1.4)); // bath2

  // ---- roof slab with skylight ----
  const SK = { x0: -0.9, x1: 0.4, z0: 0.1, z1: 2.7 };
  const rf = D.roof;
  const rfMat = [M.concrete, M.concrete, M.concrete, M.ceiling, M.concrete, M.concrete];
  const rx0 = U.x0 - 0.16, rx1 = U.x1 + 0.16, rz0 = U.z0 - 0.16, rz1 = U.z1 + 0.16;
  RF.add(slab(rx0, SK.x0, rf[0], rf[1], rz0, rz1, rfMat, 2.4));
  RF.add(slab(SK.x1, rx1, rf[0], rf[1], rz0, rz1, rfMat, 2.4));
  RF.add(slab(SK.x0, SK.x1, rf[0], rf[1], rz0, SK.z0, rfMat, 2.4));
  RF.add(slab(SK.x0, SK.x1, rf[0], rf[1], SK.z1, rz1, rfMat, 2.4));
  // skylight: kerb + glass
  const kerb = new THREE.Group();
  kerb.add(slab(SK.x0 - 0.08, SK.x1 + 0.08, rf[1], rf[1] + 0.16, SK.z0 - 0.08, SK.z0, M.alu, 1));
  kerb.add(slab(SK.x0 - 0.08, SK.x1 + 0.08, rf[1], rf[1] + 0.16, SK.z1, SK.z1 + 0.08, M.alu, 1));
  kerb.add(slab(SK.x0 - 0.08, SK.x0, rf[1], rf[1] + 0.16, SK.z0, SK.z1, M.alu, 1));
  kerb.add(slab(SK.x1, SK.x1 + 0.08, rf[1], rf[1] + 0.16, SK.z0, SK.z1, M.alu, 1));
  const skg = new THREE.Mesh(boxGeo(SK.x1 - SK.x0 + 0.1, 0.02, SK.z1 - SK.z0 + 0.1, 0), M.glass);
  skg.position.set((SK.x0 + SK.x1) / 2, rf[1] + 0.15, (SK.z0 + SK.z1) / 2);
  kerb.add(skg);
  for (let i = 1; i < 4; i++) kerb.add(box(0.05, 0.06, SK.z1 - SK.z0, M.alu, SK.x0 + (SK.x1 - SK.x0) * i / 4, rf[1] + 0.13, (SK.z0 + SK.z1) / 2, 0.5));
  RF.add(kerb);
  // ---- the pavilion roof ----
  //
  // A parapet ring, a pale roof finish, a PV array
  // and a plant enclosure: the correct kit for a flat-roofed modernist villa in
  // a temperate suburb, and the wrong building for a wet volcanic island. The
  // roof is a broad low hip carried well past every wall — the eave is the
  // whole point of the type, since it is what keeps the sun off a fully glazed
  // south elevation and the rain off the verandah under it. See ./roof.js.
  //
  // Overhangs are deliberately unequal: deepest on the glazed south face, and
  // clipped on the west so the roof only just reaches over the roof terrace and
  // shades its edge instead of roofing it.
  RF.add(hipRoof({
    x0: rx0 - 0.90, x1: rx1 + 1.50, z0: rz0 - 1.30, z1: rz1 + 2.10,
    eaveY: rf[1], pitch: 0.35, thickness: 0.34,
    matTop: M.roofBoard, matSoffit: M.batten, matFascia: M.fascia, matRidge: M.fascia,
    // 2.4 m per texture repeat over 16 boards ≈ 15 cm courses. The first pass
    // ran 0.42 m, i.e. 2.6 cm boards, which mips straight to a flat grey sheet.
    tileTop: 2.4, tileSoffit: 1.6,
  }));

  // ---- expressed slab / day-joint reveals in the concrete (shadow lines) ----
  const rev = (x0, x1, z0, z1, y) => S.add(slab(x0, x1, y, y + 0.05, z0, z1, M.concreteDark, 1.2));
  rev(G.x0 - 0.02, G.x0 + 0.06, G.z0 - 0.06, G.z1 + 0.06, 3.24);     // west
  rev(G.x1 - 0.06, G.x1 + 0.02, G.z0 - 0.06, G.z1 + 0.06, 3.24);     // east
  rev(G.x0 - 0.06, G.x1 + 0.06, G.z0 - 0.02, G.z0 + 0.06, 3.24);     // north

  // ---- rooftop: PV array, upstands, plant ----
  {
    const R = new THREE.Group();
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
      const x = 1.4 + c * 1.72, z = -4.2 + r * 1.5;
      const p1 = box(1.62, 0.04, 1.0, M.steelBlack, x, rf[1] + 0.30, z, 0);
      p1.rotation.x = -0.34; R.add(p1);
      const pv = box(1.56, 0.012, 0.94, new THREE.MeshStandardMaterial({ color: 0x101828, roughness: 0.22, metalness: 0.5 }), x, rf[1] + 0.325, z, 0);
      pv.rotation.x = -0.34; R.add(pv);
      [-1, 1].forEach((sg) => R.add(box(0.05, 0.30, 0.05, M.steelDark, x + sg * 0.7, rf[1] + 0.15, z + 0.3, 0)));
    }
    // plant enclosure + vents
    R.add(slab(-4.9, -3.3, rf[1], rf[1] + 0.75, -4.2, -2.6, M.alu, 1.2));
    R.add(slab(-4.95, -3.25, rf[1] + 0.75, rf[1] + 0.80, -4.25, -2.55, M.steelDark, 1));
    [[-5.6, -0.9], [-5.6, 1.4]].forEach(([x, z]) => {
      R.add(cyl(0.19, 0.19, 0.34, M.alu, x, rf[1] + 0.17, z, 14));
      R.add(cyl(0.23, 0.23, 0.05, M.steelDark, x, rf[1] + 0.36, z, 14));
    });
    RF.add(R);
  }

  // ---- structural columns in the glass line + cantilever soffit ----
  [-4.6, 0.1, 6.9].forEach((x) => {
    const c = box(0.16, D.h0 - 0.05, 0.16, M.steelBlack, x, D.h0 / 2, G.z1 - 0.17, 0.4);
    S.add(c);
  });
  // downstand edge beam over the south glazing
  S.add(slab(G.x0, U.x0, D.h0 - 0.22, D.h0, G.z1 - 0.34, G.z1, M.concrete, 2));

  // =========================== ENVELOPE, GROUND ===========================
  const cw = { t: G.t, base: D.fl0 - 0.03, height: D.h0 - 0.03, liningMat: M.concrete };
  // NORTH elevation (entry) — mostly solid board-formed concrete
  buildWall({
    axis: 'x', from: G.x0, to: G.x1, at: G.z0 + G.t / 2, outer: -1, ...cw,
    openings: [
      { a: -7.7, b: -5.3, y0: 0.95, y1: 2.55, type: 'glass', panels: 2, sec: 0.055 },
      { a: 0.15, b: 1.35, y0: 0, y1: 2.55, type: 'door', tag: 'frontDoor', leafMat: M.walnut, depth: 0.12 },
      { a: 1.50, b: 2.30, y0: 0, y1: 2.55, type: 'glass', panels: 1, sec: 0.05 },
      { a: 4.60, b: 7.40, y0: 1.55, y1: 2.45, type: 'glass', panels: 2, sec: 0.055 },
    ],
  }, M, store);
  // WEST elevation — solid blade with a tall slot
  buildWall({
    axis: 'z', from: G.z0, to: G.z1, at: G.x0 + G.t / 2, outer: -1, ...cw,
    openings: [
      { a: -3.7, b: -2.4, y0: 0.65, y1: 2.95, type: 'glass', panels: 1, sec: 0.055 },
      { a: -0.65, b: 0.65, y0: 0.65, y1: 2.95, type: 'glass', panels: 1, sec: 0.055 },
      { a: 2.4, b: 3.7, y0: 0.65, y1: 2.95, type: 'glass', panels: 1, sec: 0.055 },
    ],
  }, M, store);
  // EAST elevation
  buildWall({
    axis: 'z', from: G.z0, to: G.z1, at: G.x1 - G.t / 2, outer: 1, ...cw,
    openings: [
      { a: 0.4, b: 3.4, y0: 0.95, y1: 2.55, type: 'glass', panels: 2, sec: 0.055 },
      { a: -4.2, b: -2.8, y0: 1.6, y1: 2.45, type: 'glass', panels: 1, sec: 0.05 },
    ],
  }, M, store);
  // SOUTH — stone-clad service box between the two glazed bays
  buildWall({
    axis: 'x', from: 2.3, to: 4.6, at: G.z1 - G.t / 2, outer: 1, ...cw,
    mats: faceMats(M.stone, M.plaster, true), tile: 1.5, liningMat: M.stone,
    openings: [{ a: 3.1, b: 3.8, y0: 2.5, y1: 3.0, type: 'glass', panels: 1, sec: 0.045, frosted: true }],
  }, M, store);
  // SOUTH glazed bays. The bay grid is named rather than inlined because the
  // verandah colonnade further down stands on these same lines — that is the
  // only thing keeping a post from landing in front of a sliding leaf.
  const gzA = { from: G.x0 + 0.06, to: 2.3, panels: 7, slide: 3 };
  const gzB = { from: 4.6, to: G.x1 - 0.06, panels: 3, slide: 1 };
  const cwA = curtainWall({ ...gzA, at: G.z1 - 0.20, y0: D.fl0, y1: D.h0 - 0.24, axis: 'x', outer: 1, M });
  const cwB = curtainWall({ ...gzB, at: G.z1 - 0.20, y0: D.fl0, y1: D.h0 - 0.24, axis: 'x', outer: 1, M });
  store.glazing.add(cwA, cwB);
  store.tagged.slideA = cwA; store.tagged.slideB = cwB;

  // =========================== PARTITIONS, GROUND =========================
  const pw = { t: D.ti, base: D.fl0, height: D.h0 - 0.03, mats: M.plaster, tile: 1.6 };
  // living / hall spine wall carrying the fireplace + joinery
  buildWall({ axis: 'z', from: G.z0 + G.t, to: -0.2, at: -1.5, outer: -1, ...pw, t: 0.30 }, M, store);
  // hall / kitchen wall
  buildWall({
    axis: 'z', from: G.z0 + G.t, to: G.z1 - G.t, at: 2.5, outer: 1, ...pw,
    openings: [
      { a: 0.0, b: 1.9, y0: 0, y1: 2.70, type: 'void' },
      { a: 3.2, b: 4.0, y0: 0, y1: 2.35, type: 'door', tag: 'powderDoor', leafMat: M.walnut, depth: 0.10, frameMat: M.plaster },
    ],
  }, M, store);
  // powder-room box
  buildWall({ axis: 'x', from: 2.5, to: 4.6, at: 2.6, outer: -1, ...pw }, M, store);
  buildWall({ axis: 'z', from: 2.6, to: G.z1 - G.t, at: 4.6, outer: 1, ...pw }, M, store);

  // =========================== ENVELOPE, UPPER ============================
  const uw = { t: U.t, base: D.slab1[1], height: D.h1 - D.slab1[1], liningMat: M.batten };
  const cladMats = (plus) => faceMats(M.claddingDark, M.plaster, plus);
  const UW = store.upper;
  const before = store.walls.children.length, beforeG = store.glazing.children.length;
  const upperElevs = [
    { axis: 'x', from: U.x0, to: U.x1, at: U.z0 + U.t / 2, outer: -1, ...uw,
      mats: cladMats(false), tile: 1.3,
      openings: [
        { a: -4.7, b: -2.7, y0: 0.85, y1: 2.45, type: 'glass', panels: 2, sec: 0.055 },
        { a: -0.5, b: 0.9, y0: 1.35, y1: 2.35, type: 'glass', panels: 1, sec: 0.05, frosted: true },
        { a: 4.2, b: 5.4, y0: 1.45, y1: 2.35, type: 'glass', panels: 1, sec: 0.05, frosted: true },
        { a: 6.6, b: 8.2, y0: 1.55, y1: 2.35, type: 'glass', panels: 1, sec: 0.05 },
      ] },
    { axis: 'x', from: U.x0, to: U.x1, at: U.z1 - U.t / 2, outer: 1, ...uw,
      mats: cladMats(true), tile: 1.3,
      openings: [
        { a: -5.5, b: -1.5, y0: 0.05, y1: 2.45, type: 'glass', panels: 3, sec: 0.06, transom: 2.05 },
        { a: -0.7, b: 0.7, y0: 0.65, y1: 2.45, type: 'glass', panels: 1, sec: 0.05 },
        { a: 2.0, b: 8.5, y0: 0.05, y1: 2.45, type: 'glass', panels: 4, sec: 0.06, transom: 2.05 },
      ] },
    { axis: 'z', from: U.z0, to: U.z1, at: U.x0 + U.t / 2, outer: -1, ...uw,
      mats: cladMats(true), tile: 1.3,
      openings: [
        { a: -4.4, b: -3.4, y0: 1.5, y1: 2.4, type: 'glass', panels: 1, sec: 0.05, frosted: true },
        { a: 1.1, b: 2.2, y0: 0.02, y1: 2.4, type: 'door', tag: 'roofDoor', glazedDoor: true, depth: 0.1 },
        { a: 4.3, b: 6.2, y0: 0.85, y1: 2.45, type: 'glass', panels: 2, sec: 0.055 },
      ] },
    { axis: 'z', from: U.z0, to: U.z1, at: U.x1 - U.t / 2, outer: 1, ...uw,
      mats: cladMats(false), tile: 1.3,
      openings: [
        { a: 2.8, b: 5.8, y0: 0.35, y1: 2.45, type: 'glass', panels: 2, sec: 0.055 },
        { a: -3.7, b: -2.3, y0: 1.5, y1: 2.4, type: 'glass', panels: 1, sec: 0.05, frosted: true },
      ] },
  ];
  upperElevs.forEach((e) => buildWall(e, M, store));
  // move the newly created upper walls + glazing into the toggleable group
  store.walls.children.slice(before).forEach((c) => UW.add(c));
  store.glazing.children.slice(beforeG).forEach((c) => UW.add(c));

  // vertical batten rain-screen on the timber volume (instanced)
  addBattens(UW, M, upperElevs.map((e) => ({
    axis: e.axis, from: e.from, to: e.to, at: e.at, nrm: (e.axis === 'x' ? e.outer : e.outer),
    face: e.at + e.outer * (U.t / 2), y0: e.base, h: e.height, openings: e.openings,
  })));

  // =========================== PARTITIONS, UPPER ==========================
  const pw1 = { t: D.ti1, base: D.slab1[1], height: D.h1 - D.slab1[1], mats: M.plaster, tile: 1.6 };
  const b2 = store.walls.children.length, b2g = store.glazing.children.length;
  buildWall({
    axis: 'z', from: U.z0 + U.t, to: U.z1 - U.t, at: -1.0, outer: 1, ...pw1,
    openings: [
      { a: -4.2, b: -3.3, y0: 0, y1: 2.3, type: 'door', leafMat: M.walnut, frameMat: M.plaster, depth: 0.1 },
      { a: -2.25, b: -1.35, y0: 0, y1: 2.3, type: 'door', leafMat: M.walnut, frameMat: M.plaster, depth: 0.1, open: true },
      { a: 5.0, b: 5.9, y0: 0, y1: 2.3, type: 'door', leafMat: M.walnut, frameMat: M.plaster, depth: 0.1 },
    ],
  }, M, store);
  buildWall({
    axis: 'z', from: U.z0 + U.t, to: U.z1 - U.t, at: 1.6, outer: -1, ...pw1,
    openings: [
      { a: -2.2, b: -1.3, y0: 0, y1: 2.3, type: 'door', leafMat: M.walnut, frameMat: M.plaster, depth: 0.1 },
      { a: 2.2, b: 3.1, y0: 0, y1: 2.3, type: 'door', leafMat: M.walnut, frameMat: M.plaster, depth: 0.1, open: true },
    ],
  }, M, store);
  buildWall({ axis: 'x', from: 1.6, to: U.x1 - U.t, at: 1.0, outer: 1, ...pw1 }, M, store);
  buildWall({ axis: 'x', from: U.x0 + U.t, to: -1.0, at: -2.4, outer: -1, ...pw1 }, M, store);
  buildWall({ axis: 'x', from: U.x0 + U.t, to: -1.0, at: 2.4, outer: 1, ...pw1 }, M, store);
  store.walls.children.slice(b2).forEach((c) => UW.add(c));
  store.glazing.children.slice(b2g).forEach((c) => UW.add(c));

  // =========================== CIRCULATION ================================
  const C = store.circulation;
  // The going was 0.28, which put the bottom riser 0.74 m from the glass wall:
  // enough for a drawing and not enough to stand in, let alone turn round in and
  // start climbing. The flight's *length* is what decides that — the top has to
  // land at the void's north edge whatever happens, so every centimetre taken
  // off the going moves the bottom seventeen centimetres further into the room.
  // 0.25 gives a 39-degree pitch, and 2R+G lands at 0.656, which is still an
  // ordinary domestic stair. It is the floor under it and not the going that
  // was short, though, so the rest came from moving `V.z0` (above): the landing
  // is 2.04 m in the model, and at the villa's 2.10 scale that is 4.3 m of floor
  // to arrive in and turn round in.
  const rise = (D.slab1[1] - D.fl0) / 18, run = 0.25, sw = 1.4;
  const sx = (V.x0 + V.x1) / 2;
  const fl = stair({ steps: 18, rise, run, width: sw, mat: M.concreteDark, treadMat: M.walnut, open: true });
  // ...and so the bottom riser is *derived* from where the top has to arrive
  // rather than authored, or the two drift apart the moment the going changes.
  const SB = V.z0 + 0.24 + 17.5 * run;   // bottom riser, front edge
  fl.position.set(sx, D.fl0, SB);
  C.add(fl);
  // steel stringers
  const slope = Math.atan2(rise * 18, run * 17), sl = Math.hypot(run * 17, rise * 18);
  [-1, 1].forEach((s) => {
    const st = box(0.028, 0.34, sl, M.steelBlack, sx + s * (sw / 2 + 0.02), D.fl0 + rise * 9 - 0.10, SB - run * 8.5, 0.5);
    st.rotation.x = -slope + Math.PI; st.rotation.y = Math.PI;
    st.rotation.set(slope, 0, 0);
    C.add(st);
  });
  // inclined glass balustrade along the open (east) side of the flight
  const bal = new THREE.Mesh(boxGeo(0.014, 0.95, sl, 0), M.glassBalustrade);
  bal.position.set(sx + sw / 2 + 0.03, D.fl0 + rise * 9 + 0.52, SB - run * 8.5);
  bal.rotation.x = slope; bal.renderOrder = 3;
  C.add(bal);
  const handrail = box(0.05, 0.045, sl, M.walnut, sx + sw / 2 + 0.03, D.fl0 + rise * 9 + 1.02, SB - run * 8.5, 0.6);
  handrail.rotation.x = slope; C.add(handrail);
  // void edge railings at upper level
  const r1 = railing({ length: V.z1 - V.z0, mat: M.steelBlack, glassMat: M.glassBalustrade });
  r1.rotation.y = -Math.PI / 2; r1.position.set(V.x1 - 0.04, D.slab1[1] + 0.03, V.z0);
  const r2 = railing({ length: V.x1 - V.x0, mat: M.steelBlack, glassMat: M.glassBalustrade });
  r2.position.set(V.x0, D.slab1[1] + 0.03, V.z1 - 0.04);
  // No railing on the V.z0 edge. The flight arrives there — the top tread is
  // level with the slab and its far edge is 0.15 m short of it — so a guard
  // across that edge is a guard across the way off the stair. r1 takes the
  // void's long side and r2 the far end, where you really can fall in.
  UW.add(r1, r2);

  // =========================== TERRACES ===================================
  const T = store.terraces;
  // main south terrace slab
  T.add(slab(G.x0 - 0.6, G.x1 + 0.6, -0.24, 0, G.z1 + 0.14, 11.2, M.concretePaving, 2.6));
  T.add(slab(G.x0 - 0.6, G.x1 + 0.6, -0.42, -0.24, G.z1 + 0.14, 11.0, M.concreteDark, 2.6));
  // step down to the lawn
  T.add(slab(G.x0 - 0.6, G.x1 + 0.6, -0.42, -0.20, 11.2, 11.55, M.concretePaving, 2));
  // timber deck inlay under the cantilever
  for (let i = 0; i < 31; i++) {
    const zz = 5.32 + i * 0.204;
    T.add(box(11.4, 0.05, 0.194, M.deck, -3.0, 0.025, zz, 0.5));
  }
  // ---- verandah colonnade ----
  //
  // The south cantilever already made a covered outdoor room; standing it on
  // posts turns it into a verandah, which is the other half of the tropical
  // type the new roof commits to. It is also the honest reading of a two-metre
  // overhang on an island: nothing here is trying to look like it defies
  // gravity. The posts land on the deck at the cantilever line, clear of the
  // glazing behind them.
  //
  // They stand on the glazing's own mullion lines, not on an even rhythm of
  // their own. An even 2.55 m rhythm put a post at x -3.05 and another at
  // 7.15 — dead centre of both sliding leaves (bays -4.12..-2.52 and
  // 6.05..7.49). Nothing about that reads as a colonnade; it reads as a
  // post someone forgot to move out of the doorway, and you had to sidestep
  // round it every time you walked out onto the terrace. Landing on mullions
  // makes the two doorways the widest gaps in the row instead of the
  // narrowest, which is what a verandah in front of sliding doors should do.
  {
    const vz = U.z1 - 0.22, vTop = D.slab1[0] - 0.03;
    const beam = slab(U.x0 - 0.1, U.x1 + 0.16, vTop - 0.30, vTop, vz - 0.10, vz + 0.10, M.postTimber, 1.2);
    T.add(beam);
    const mull = (b, i) => b.from + (b.to - b.from) / b.panels * i;
    // gzA bays 2/4/6 and gzB bays 0/2 — 4 and 2 are the jambs of the two
    // sliding leaves, so each door gets a post at its edge and none in it.
    for (const x of [mull(gzA, 2), mull(gzA, 4), mull(gzA, 6), mull(gzB, 0), mull(gzB, 2)]) {
      T.add(box(0.17, vTop - 0.30, 0.17, M.postTimber, x, (vTop - 0.30) / 2 + 0.03, vz, 0.9));
      // a bracket at the head — the joint is what makes a post read as timber
      // framing rather than as a pipe holding up a slab
      [-1, 1].forEach((sg) => {
        const br = box(0.34, 0.09, 0.09, M.postTimber, x + sg * 0.20, vTop - 0.44, vz, 0.6);
        br.rotation.z = sg * 0.62;
        T.add(br);
      });
    }
  }

  // expressed movement joints in the terrace paving
  const jm = M.concreteDark;
  for (let x = -7.2; x <= 8.0; x += 2.4) T.add(slab(x - 0.012, x + 0.012, -0.035, 0.002, G.z1 + 0.14, 11.2, jm, 1));
  [7.0, 9.0].forEach((z) => T.add(slab(G.x0 - 0.6, G.x1 + 0.6, -0.035, 0.002, z - 0.012, z + 0.012, jm, 1)));

  // entry pad + steps (north)
  T.add(slab(-2.6, 3.4, -0.20, 0, G.z0 - 2.9, G.z0 - 0.1, M.concretePaving, 2.4));
  T.add(slab(-2.2, 3.0, -0.42, -0.20, G.z0 - 3.35, G.z0 - 2.9, M.concretePaving, 2));
  // entry canopy (cantilevered blade)
  const can = slab(-2.6, 3.4, 2.60, 2.86, G.z0 - 3.3, G.z0 + 0.1, [M.concrete, M.concrete, M.concrete, M.concreteSoffit, M.concrete, M.concrete], 2.4);
  S.add(can);
  S.add(slab(-2.66, -2.6, 2.56, 2.86, G.z0 - 3.36, G.z0 + 0.1, M.concreteDark, 1));
  S.add(slab(3.4, 3.46, 2.56, 2.86, G.z0 - 3.36, G.z0 + 0.1, M.concreteDark, 1));
  S.add(slab(-2.66, 3.46, 2.56, 2.86, G.z0 - 3.36, G.z0 - 3.3, M.concreteDark, 1));
  // timber-lined entry portal projecting from the concrete
  const por = new THREE.Group();
  por.add(slab(-0.55, -0.15, 0, 2.72, G.z0 - 0.26, G.z0 + 0.02, M.cladding, 1.1));
  por.add(slab(2.42, 2.82, 0, 2.72, G.z0 - 0.26, G.z0 + 0.02, M.cladding, 1.1));
  por.add(slab(-0.55, 2.82, 2.72, 2.94, G.z0 - 0.26, G.z0 + 0.02, M.cladding, 1.1));
  // No fourth panel here: two jambs and a head make a portal; a fourth
  // side makes a box. A panel across the front face of the reveal boards the
  // front door up — it reads as timber where the doorway should be, and it
  // stops the figure a metre short of a door that opens perfectly well
  // behind it.
  S.add(por);
  // west blade wall extending into the garden
  S.add(slab(G.x0 + 0.02, G.x0 + G.t + 0.02, -0.4, 3.05, G.z1, 7.3, M.concrete, 2.4));
  // pergola over the west terrace
  const pg = new THREE.Group();
  pg.add(box(0.16, 0.30, 4.2, M.steelBlack, -2.2, 0, 7.4, 0.5).translateY(1.5 + 0.15));
  const pcol = box(0.14, 3.05, 0.14, M.steelBlack, -2.2, 1.52, 5.9, 0.5);
  const pcol2 = box(0.14, 3.05, 0.14, M.steelBlack, -2.2, 1.52, 8.9, 0.5);
  pg.add(pcol, pcol2);
  pg.add(box(0.10, 0.26, 3.3, M.steelBlack, -2.2, 2.92, 7.4, 0.5));
  pg.add(box(0.10, 0.26, 3.3, M.steelBlack, -8.7, 2.92, 7.4, 0.5));
  for (let i = 0; i <= 17; i++) {
    const zz = 5.85 + i * (3.1 / 17);
    pg.add(box(6.6, 0.125, 0.05, M.batten, -5.45, 2.86, zz, 1.4));
  }
  T.add(pg);
  // roof-terrace deck + railing (above the living wing)
  const rtY = D.slab1[1];
  for (let i = 0; i < 48; i++) {
    RT.add(box(2.72, 0.05, 0.194, M.deck, -7.5, rtY + 0.028, G.z0 + 0.22 + i * 0.204, 0.5));
  }
  const rr1 = railing({ length: 9.6, mat: M.steelBlack, glassMat: M.glassBalustrade, height: 1.06 });
  rr1.rotation.y = -Math.PI / 2; rr1.position.set(U.x0 - 2.9, rtY, G.z0 + 0.1);
  const rr2 = railing({ length: 3.0, mat: M.steelBlack, glassMat: M.glassBalustrade });
  rr2.position.set(G.x0, rtY, G.z1 - 0.1);
  const rr3 = railing({ length: 3.0, mat: M.steelBlack, glassMat: M.glassBalustrade });
  rr3.position.set(G.x0, rtY, G.z0 + 0.1);
  RT.add(rr1, rr2, rr3);
  // parapet upstand on the west edge of the roof terrace
  RT.add(slab(G.x0 - 0.14, G.x0 + 0.20, rtY, rtY + 1.05, G.z0 - 0.14, G.z1 + 0.14, M.concrete, 2.2));
  RT.add(slab(G.x0 - 0.18, G.x0 + 0.24, rtY + 1.05, rtY + 1.09, G.z0 - 0.18, G.z1 + 0.18, M.alu, 1));

  // =========================== FIXED FITTINGS =============================
  const F = store.fixtures;
  // fireplace core in the living / hall spine wall
  const fpW = 1.6, fpZ = -2.4;
  F.add(slab(-1.82, -1.5, 0.03, D.h0 - 0.03, fpZ - fpW / 2 - 0.25, fpZ + fpW / 2 + 0.25, M.plasterDark, 1.6));
  F.add(slab(-1.86, -1.78, 0.58, 1.02, fpZ - fpW / 2, fpZ + fpW / 2, M.steelBlack, 0.8));
  const fire = new THREE.Mesh(boxGeo(0.02, 0.30, fpW - 0.12, 0), new THREE.MeshStandardMaterial({
    color: 0x2a1408, emissive: 0xff7a22, emissiveIntensity: 2.4, roughness: 1,
  }));
  fire.position.set(-1.80, 0.76, fpZ);
  F.add(fire);
  store.animated.push({ type: 'fire', mesh: fire });
  const fl2 = new THREE.PointLight(0xff8a34, 0, 6, 2);
  fl2.position.set(-2.1, 0.9, fpZ);
  F.add(fl2);
  store.lights.push({ light: fl2, base: 3.2, kind: 'fire' });

  // linear cove lighting: recessed strips
  const strips = [
    [-5.4, D.h0 - 0.06, 2.2, 6.0, 'x'], [-5.4, D.h0 - 0.06, -3.0, 6.0, 'x'],
    [5.8, D.h0 - 0.06, -2.0, 4.4, 'z'], [0.5, D.h0 - 0.06, -3.6, 3.2, 'x'],
    [4.4, D.h1 - 0.06, 4.0, 3.6, 'x'], [-3.4, D.h1 - 0.06, 4.6, 3.4, 'x'],
  ];
  strips.forEach((s) => {
    const [x, y, z, len, ax] = s;
    const m = ax === 'x' ? box(len, 0.035, 0.09, M.lampWarm, x, y, z, 0) : box(0.09, 0.035, len, M.lampWarm, x, y, z, 0);
    m.castShadow = false;
    (y > 4 ? UW : F).add(m);
    store.emissives.push(m);
  });

  // downlights: small recessed rings
  const dl = [];
  for (let i = 0; i < 7; i++) dl.push([-7.6 + i * 1.1, D.h0 - 0.02, 3.9]);
  for (let i = 0; i < 5; i++) dl.push([3.4 + i * 1.2, D.h0 - 0.02, 3.9]);
  dl.forEach((p) => {
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.02, 12), M.lampWarm);
    r.position.set(p[0], p[1], p[2]);
    F.add(r); store.emissives.push(r);
  });

  // interior point lights (no shadows – cheap, warm)
  const lampSpots = [
    [-5.5, 2.4, 1.2, 0xffca80, 13, 12],   // living
    [-6.4, 2.4, -3.2, 0xffca80, 9, 10],   // living north
    [0.5, 2.3, -3.0, 0xffd0a0, 7, 9],     // hall
    [5.8, 2.4, 0.2, 0xffd8b0, 11, 11],    // kitchen
    [6.6, 2.3, 3.8, 0xffc890, 10, 10],    // dining
    [5.4, 2.3 + D.slab1[1], 4.2, 0xffc890, 10, 10],  // master
    [-3.6, 2.3 + D.slab1[1], 4.6, 0xffc890, 8, 9],   // bedroom 2
    [-3.6, 2.3 + D.slab1[1], 0.4, 0xffc890, 7, 8],   // bedroom 3
    [4.6, 2.3 + D.slab1[1], -2.4, 0xe8f0ff, 6, 8],   // ensuite
    [0.4, 2.2 + D.slab1[1], -2.6, 0xffd0a0, 5, 7],   // corridor
    [0.0, 2.8, 1.4, 0xffd0a0, 8, 11],                // stair hall
  ];
  lampSpots.forEach((p) => {
    const L = new THREE.PointLight(p[3], 0, p[5], 2);
    L.position.set(p[0], p[1], p[2]);
    (p[1] > 4 ? UW : F).add(L);
    store.lights.push({ light: L, base: p[4], kind: 'interior' });
  });
  // exterior: recessed step + soffit lights
  const ext = [[-6.0, 0.14, 10.6], [1.0, 0.14, 10.6], [7.0, 0.14, 10.6], [0.9, 2.5, -6.6], [-9.6, -0.3, 7.0], [10.4, -0.3, 3.0]];
  ext.forEach((p) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 10), M.lampWarm);
    m.position.set(p[0], p[1], p[2]); T.add(m); store.emissives.push(m);
    const L = new THREE.PointLight(0xffb870, 0, 5, 2);
    L.position.set(p[0], p[1] + 0.3, p[2]); T.add(L);
    store.lights.push({ light: L, base: 1.6, kind: 'exterior' });
  });

  // pendant over the dining table
  const pend = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const x = 5.6 + i * 0.9;
    pend.add(cyl(0.006, 0.006, 1.05, M.steelBlack, x, D.h0 - 0.55, 3.9, 6));
    const sh = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.20, 18, 1, true), M.lampShade);
    sh.position.set(x, D.h0 - 1.12, 3.9); sh.rotation.x = Math.PI;
    pend.add(sh);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), M.lampWarm);
    bulb.position.set(x, D.h0 - 1.2, 3.9); pend.add(bulb);
    store.emissives.push(sh, bulb);
  }
  F.add(pend);

  house.userData = store;
  return house;
}

// vertical timber battens as a rain-screen over the upper volume.
// Battens are split vertically so they run above and below every opening.
function addBattens(parent, M, elevs) {
  const W = 0.062, DPT = 0.055, PITCH = 0.115;
  const geo = boxGeo(W, 1, DPT, 0);
  elevs.forEach((e) => {
    const items = [];
    const n = Math.floor((e.to - e.from) / PITCH);
    for (let i = 0; i <= n; i++) {
      const u = e.from + 0.05 + i * PITCH;
      if (u > e.to - 0.03) break;
      // vertical free segments = wall height minus openings (+ margin) covering u
      const os = e.openings.filter((o) => u > o.a - 0.055 - W / 2 && u < o.b + 0.055 + W / 2)
        .sort((p, q) => p.y0 - q.y0);
      let y = 0;
      const segs = [];
      for (const o of os) {
        const oy0 = Math.max(0, o.y0 - 0.055), oy1 = Math.min(e.h, o.y1 + 0.055);
        if (oy0 > y + 0.10) segs.push([y, oy0]);
        y = Math.max(y, oy1);
      }
      if (e.h > y + 0.10) segs.push([y, e.h]);
      segs.forEach((sg) => items.push([u, sg[0], sg[1]]));
    }
    const inst = new THREE.InstancedMesh(geo, M.batten, items.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), tr = new THREE.Vector3();
    const col = new THREE.Color();
    items.forEach((it, i) => {
      const [u, s0, s1] = it;
      const hh = s1 - s0;
      sc.set(1, hh, 1);
      if (e.axis === 'x') { tr.set(u, e.y0 + s0 + hh / 2, e.face + e.nrm * (DPT / 2 + 0.004)); q.identity(); }
      else { tr.set(e.face + e.nrm * (DPT / 2 + 0.004), e.y0 + s0 + hh / 2, u); q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2); }
      m.compose(tr, q, sc);
      inst.setMatrixAt(i, m);
      const v = 0.82 + ((Math.sin(u * 12.9898 + s0 * 4.1414) * 43758.5453) % 1 + 1) % 1 * 0.30;
      col.setRGB(v, v * (0.97 + (v - 0.9) * 0.2), v * 0.93);
      inst.setColorAt(i, col);
    });
    inst.castShadow = inst.receiveShadow = true;
    inst.frustumCulled = false;
    parent.add(inst);
  });
}
