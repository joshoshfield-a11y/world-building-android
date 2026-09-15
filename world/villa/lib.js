// ---------------------------------------------------------------------------
// Geometry helpers: world-scaled box UVs, wall builder with real openings,
// frames, extrusions. All geometry authored here from primitives.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const geoCache = new Map();

/** Box geometry whose UVs are scaled in metres (so textures keep a constant
 *  density no matter the box size). tile = metres per texture repeat. */
export function boxGeo(w, h, d, tile = 1) {
  const key = `b${w.toFixed(3)}_${h.toFixed(3)}_${d.toFixed(3)}_${tile}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const g = new THREE.BoxGeometry(w, h, d);
  if (tile > 0) {
    const uv = g.attributes.uv;
    // face order: +x, -x, +y, -y, +z, -z  (4 verts each)
    const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) {
      const [du, dv] = dims[f];
      for (let i = 0; i < 4; i++) {
        const k = f * 4 + i;
        uv.setXY(k, uv.getX(k) * du / tile, uv.getY(k) * dv / tile);
      }
    }
    uv.needsUpdate = true;
  }
  geoCache.set(key, g);
  return g;
}

/** Mesh from a world-scaled box, centred at (x,y,z). */
export function box(w, h, d, mat, x = 0, y = 0, z = 0, tile = 1) {
  const m = new THREE.Mesh(boxGeo(w, h, d, tile), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

/** Box specified by min/max corner (like a solid in space). */
export function slab(x0, x1, y0, y1, z0, z1, mat, tile = 1) {
  return box(x1 - x0, y1 - y0, z1 - z0, mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, tile);
}

/**
 * WALL with true openings. Built as vertical strips split at every opening
 * boundary, then each strip split vertically -> piers, sills and lintels.
 * Local space: runs along +X from 0..length, thickness centred on Z, y 0..height.
 * openings: [{x0,x1,y0,y1}]
 */
export function wallGroup({ length, height, thickness, openings = [], mat, tile = 1, y0 = 0 }) {
  const g = new THREE.Group();
  const xs = new Set([0, length]);
  openings.forEach((o) => { xs.add(Math.max(0, o.x0)); xs.add(Math.min(length, o.x1)); });
  const X = [...xs].sort((a, b) => a - b);
  for (let i = 0; i < X.length - 1; i++) {
    const a = X[i], b = X[i + 1];
    if (b - a < 1e-4) continue;
    const mid = (a + b) / 2;
    // openings covering this strip
    const os = openings.filter((o) => o.x0 <= mid && o.x1 >= mid)
      .sort((p, q) => p.y0 - q.y0);
    let yc = 0;
    for (const o of os) {
      if (o.y0 > yc + 1e-4) g.add(slab(a, b, y0 + yc, y0 + o.y0, -thickness / 2, thickness / 2, mat, tile));
      yc = Math.max(yc, o.y1);
    }
    if (height > yc + 1e-4) g.add(slab(a, b, y0 + yc, y0 + height, -thickness / 2, thickness / 2, mat, tile));
  }
  return g;
}

/** Place a wall group along a world axis.
 *  axis 'x': runs +X starting at (a, z). axis 'z': runs +Z starting at (x, a). */
export function placeWall(opts) {
  const g = wallGroup(opts);
  if (opts.axis === 'z') {
    g.rotation.y = -Math.PI / 2;
    g.position.set(opts.at, opts.base || 0, opts.from);
  } else {
    g.position.set(opts.from, opts.base || 0, opts.at);
  }
  return g;
}

/** Rectangular frame (4 members) in the XY plane, depth d along Z. */
export function frame(w, h, sec, d, mat, tile = 0.5) {
  const g = new THREE.Group();
  g.add(box(w, sec, d, mat, 0, -h / 2 + sec / 2, 0, tile));         // sill
  g.add(box(w, sec, d, mat, 0, h / 2 - sec / 2, 0, tile));          // head
  g.add(box(sec, h - sec * 2, d, mat, -w / 2 + sec / 2, 0, 0, tile));
  g.add(box(sec, h - sec * 2, d, mat, w / 2 - sec / 2, 0, 0, tile));
  return g;
}

/**
 * Glazed unit: outer frame + vertical mullions + optional transom + glass.
 * Returned group is centred at origin in its own XY plane, depth along Z.
 */
export function glazing({ w, h, sec = 0.06, depth = 0.09, panels = 1, transom = null,
  frameMat, glassMat, tile = 0.4, horizontalBars = 0 }) {
  const g = new THREE.Group();
  const f = frame(w, h, sec, depth, frameMat, tile);
  g.add(f);
  const iw = w - sec * 2, ih = h - sec * 2;
  for (let i = 1; i < panels; i++) {
    const x = -iw / 2 + (iw / panels) * i;
    g.add(box(sec * 0.85, ih, depth * 0.92, frameMat, x, 0, 0, tile));
  }
  if (transom !== null) {
    g.add(box(iw, sec * 0.8, depth * 0.92, frameMat, 0, -h / 2 + transom, 0, tile));
  }
  for (let i = 0; i < horizontalBars; i++) {
    const y = -ih / 2 + (ih / (horizontalBars + 1)) * (i + 1);
    g.add(box(iw, sec * 0.5, depth * 0.5, frameMat, 0, y, 0, tile));
  }
  const glass = new THREE.Mesh(boxGeo(iw, ih, 0.014, 0), glassMat);
  glass.renderOrder = 3;
  g.add(glass);
  g.userData.glass = glass;
  return g;
}

/** Thin-profile railing: top rail + posts + glass infill or vertical bars. */
export function railing({ length, height = 1.06, mat, glassMat, style = 'glass', postEvery = 1.6 }) {
  const g = new THREE.Group();
  const top = box(length, 0.045, 0.05, mat, length / 2, height, 0, 0.4);
  g.add(top);
  if (style === 'glass') {
    const n = Math.max(1, Math.round(length / postEvery));
    for (let i = 0; i <= n; i++) {
      g.add(box(0.05, height, 0.05, mat, (length / n) * i, height / 2, 0, 0.4));
    }
    const panel = new THREE.Mesh(boxGeo(length - 0.08, height - 0.14, 0.012, 0), glassMat);
    panel.position.set(length / 2, height / 2 - 0.02, 0);
    panel.renderOrder = 3;
    g.add(panel);
  } else {
    g.add(box(length, 0.03, 0.03, mat, length / 2, 0.06, 0, 0.4));
    const n = Math.max(2, Math.round(length / 0.12));
    const geo = boxGeo(0.018, height - 0.06, 0.018, 0.3);
    const inst = new THREE.InstancedMesh(geo, mat, n + 1);
    const m = new THREE.Matrix4();
    for (let i = 0; i <= n; i++) {
      m.makeTranslation((length / n) * i, height / 2, 0);
      inst.setMatrixAt(i, m);
    }
    inst.castShadow = inst.receiveShadow = true;
    g.add(inst);
  }
  return g;
}

/** Straight stair flight: treads (+ risers if closed), local origin at bottom
 *  front edge, rising along -Z (i.e. towards decreasing z) by default. */
export function stair({ steps, rise, run, width, mat, open = true, dir = -1, treadMat }) {
  const g = new THREE.Group();
  const tm = treadMat || mat;
  for (let i = 0; i < steps; i++) {
    const t = box(width, 0.06, run + 0.03, tm, 0, rise * (i + 1) - 0.03, dir * (run * i + run / 2), 0.6);
    g.add(t);
    if (!open) g.add(box(width, rise - 0.06, 0.04, mat, 0, rise * i + (rise - 0.06) / 2, dir * (run * i) + dir * 0.02, 0.6));
  }
  return g;
}

/** Rounded box via subdivided box + spherify-ish smoothing (for cushions). */
export function softBox(w, h, d, r, mat, seg = 3) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  const p = g.attributes.position;
  const hw = w / 2 - r, hh = h / 2 - r, hd = d / 2 - r;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const c = new THREE.Vector3(
      THREE.MathUtils.clamp(v.x, -hw, hw),
      THREE.MathUtils.clamp(v.y, -hh, hh),
      THREE.MathUtils.clamp(v.z, -hd, hd));
    const d2 = v.clone().sub(c);
    if (d2.length() > 1e-6) v.copy(c).add(d2.normalize().multiplyScalar(r));
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** Cylinder helper */
export function cyl(rt, rb, h, mat, x = 0, y = 0, z = 0, seg = 16) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** Extruded profile from 2D points (XY) along Z. */
export function extrude(points, depth, mat, bevel = 0) {
  const s = new THREE.Shape(points.map((p) => new THREE.Vector2(p[0], p[1])));
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, steps: 1 });
  g.center();
  const m = new THREE.Mesh(g, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}
