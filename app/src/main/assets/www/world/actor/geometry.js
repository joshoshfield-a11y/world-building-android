import * as THREE from 'three/webgpu';

// ---------------------------------------------------------------- head ---
// The skull is a superellipsoid: p=2 is a ball, p>4 slides toward the rounded
// cube heads on the sheet. taper/bulge shape the chin and cheeks.
export function headPoint(dx, dy, dz, h, pad = 0, out = new THREE.Vector3()) {
  const p = h.p;
  const k = Math.pow(
    Math.pow(Math.abs(dx), p) + Math.pow(Math.abs(dy), p) + Math.pow(Math.abs(dz), p),
    -1 / p,
  );
  const x = dx * k, y = dy * k, z = dz * k;
  const s = 1 + h.taper * y + h.bulge * (1 - y * y);
  return out.set(x * (h.rx + pad) * s, y * (h.ry + pad), z * (h.rz + pad) * s);
}

function dirFrom(phi, th, out = new THREE.Vector3()) {
  const sp = Math.sin(phi);
  return out.set(sp * Math.sin(th), Math.cos(phi), sp * Math.cos(th));
}

function gridGeometry(pos, cols, rows) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const idx = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export function buildBlob(h, segs = 72, rings = 52) {
  const pos = [];
  const v = new THREE.Vector3(), d = new THREE.Vector3();
  for (let j = 0; j <= rings; j++) {
    const phi = (j / rings) * Math.PI;
    for (let i = 0; i <= segs; i++) {
      dirFrom(phi, (i / segs) * Math.PI * 2, d);
      headPoint(d.x, d.y, d.z, h, 0, v);
      pos.push(v.x, v.y, v.z);
    }
  }
  const geo = gridGeometry(pos, segs, rings);
  geo.computeBoundingBox();
  return geo;
}


// ------------------------------------------------------- tubes & merge ---
// Sweep a ring along a curve with a per-t radius. Used for hair curls and limbs.
export function buildTube(curve, radiusAt, along = 20, radial = 9) {
  const pos = [];
  const up = new THREE.Vector3(0, 0, 1);
  const tan = new THREE.Vector3(), nx = new THREE.Vector3(), ny = new THREE.Vector3();
  const pt = new THREE.Vector3();
  for (let s = 0; s <= along; s++) {
    const t = s / along;
    curve.getPoint(t, pt);
    curve.getTangent(t, tan).normalize();
    nx.crossVectors(tan, up);
    if (nx.lengthSq() < 1e-6) nx.set(1, 0, 0);
    nx.normalize();
    ny.crossVectors(nx, tan).normalize();
    const r = radiusAt(t);
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const cx = Math.cos(a) * r, cy = Math.sin(a) * r;
      pos.push(
        pt.x + nx.x * cx + ny.x * cy,
        pt.y + nx.y * cx + ny.y * cy,
        pt.z + nx.z * cx + ny.z * cy,
      );
    }
  }
  return gridGeometry(pos, radial, along);
}

// Minimal geometry merge (three's BufferGeometryUtils lives in examples/).
// Carries skin attributes through so limb pieces can be merged after weighting.
export function mergeGeos(list) {
  const skinned = list.length > 0 && list.every((g) => g.attributes.skinIndex);
  const pos = [], idx = [], si = [], sw = [];
  let base = 0;
  for (const g of list) {
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i++) pos.push(p[i]);
    if (skinned) {
      const a = g.attributes.skinIndex.array, b = g.attributes.skinWeight.array;
      for (let i = 0; i < a.length; i++) { si.push(a[i]); sw.push(b[i]); }
    }
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i++) idx.push(ix[i] + base);
    base += p.length / 3;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (skinned) {
    out.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    out.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  }
  out.setIndex(idx);
  out.computeVertexNormals();
  return out;
}

// Every vertex rides one bone (hands, shoes, torso).
export function skinConst(geo, bone) {
  const n = geo.attributes.position.count;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { si[i * 4] = bone; sw[i * 4] = 1; }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  return geo;
}

// Two bones blended across a joint height -- this is what makes elbows and
// knees bend smoothly instead of shearing apart.
export function skinSplitY(geo, jointY, blend, above, below) {
  const p = geo.attributes.position.array;
  const n = geo.attributes.position.count;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    let t = (p[i * 3 + 1] - (jointY - blend)) / (2 * blend);
    t = Math.min(1, Math.max(0, t));
    const wa = t * t * (3 - 2 * t);
    si[i * 4] = above; sw[i * 4] = wa;
    si[i * 4 + 1] = below; sw[i * 4 + 1] = 1 - wa;
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  return geo;
}

// ---------------------------------------------------------------- hair ---
// Hem height per azimuth (0 = front / +Z, pi = back). Everything above this
// line is scalp-hugging shell; everything below drapes.
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function hemAt(hair, th) {
  // a = 0 straight ahead, PI = back of the head
  let a = th % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  if (a > Math.PI) a = Math.PI * 2 - a;

  // wide flat fringe across the front, then it falls away over the temples
  let y = hair.front + (hair.side - hair.front) * smoothstep(0.30 * Math.PI, 0.56 * Math.PI, a);
  y += (hair.back - y) * smoothstep(0.62 * Math.PI, 0.94 * Math.PI, a);

  if (hair.dipSide > 0) {
    for (const at of [Math.PI / 2, -Math.PI / 2]) {
      let dd = th - at;
      while (dd > Math.PI) dd -= Math.PI * 2;
      while (dd < -Math.PI) dd += Math.PI * 2;
      y -= hair.dipSide * Math.exp(-(dd * dd) / (2 * 0.26 * 0.26));
    }
  }
  if (hair.part > 0) {
    let dd = th;
    while (dd > Math.PI) dd -= Math.PI * 2;
    while (dd < -Math.PI) dd += Math.PI * 2;
    y += hair.part * Math.exp(-(dd * dd) / (2 * 0.26 * 0.26));
  }
  const w = hair.spiky
    ? Math.abs(Math.sin(th * hair.waveFreq + hair.wavePhase))
    : Math.sin(th * hair.waveFreq + hair.wavePhase) * 0.5 + 0.5;
  // fringe tips bite deeper than the back hem
  const front = Math.max(0, Math.cos(th)) ** 2;
  y -= hair.waveAmp * w * (0.55 + 0.95 * front);
  return y + hair.slant * Math.sin(th) * front;   // side-swept parting
}

export function buildHair(h, hair, AZ = 128, M = 30) {
  const SCALP = 34, DROP = 26, PHI_MAX = Math.PI * 0.66, MAX_FALL = 3.2;
  const pos = [];
  const v = new THREE.Vector3(), d = new THREE.Vector3();
  const rs = new Float64Array(SCALP + DROP + 1);
  const ys = new Float64Array(SCALP + DROP + 1);
  const arc = new Float64Array(SCALP + DROP + 1);

  for (let i = 0; i <= AZ; i++) {
    const th = (i / AZ) * Math.PI * 2;
    const cth = Math.cos(th), sth = Math.sin(th);
    // vertical strand lobes: a shallow ripple in the shell radius
    const rip = hair.strandAmp * Math.cos(th * hair.waveFreq + hair.wavePhase);

    // 1. silhouette polyline for this azimuth: over the scalp, then straight down
    for (let k = 0; k <= SCALP; k++) {
      dirFrom((k / SCALP) * PHI_MAX, th, d);
      headPoint(d.x, d.y, d.z, h, hair.thick, v);
      rs[k] = Math.hypot(v.x, v.z);
      ys[k] = v.y;
    }
    const rEnd = rs[SCALP], yEnd = ys[SCALP];
    for (let k = 1; k <= DROP; k++) {
      const f = k / DROP;
      rs[SCALP + k] = rEnd * (1 + hair.flare * f);
      ys[SCALP + k] = yEnd - f * MAX_FALL;
    }

    // 2. arc length along it
    arc[0] = 0;
    for (let k = 1; k < rs.length; k++) {
      arc[k] = arc[k - 1] + Math.hypot(rs[k] - rs[k - 1], ys[k] - ys[k - 1]);
    }

    // 3. where the hem cuts it
    const hem = Math.min(hemAt(hair, th), ys[0] - 0.02);
    let sEnd = arc[arc.length - 1];
    for (let k = 1; k < ys.length; k++) {
      if (ys[k] <= hem) {
        const t = (ys[k - 1] - hem) / (ys[k - 1] - ys[k] || 1);
        sEnd = arc[k - 1] + t * (arc[k] - arc[k - 1]);
        break;
      }
    }

    // 4. resample M+1 evenly spaced points along [0, sEnd]
    let cur = 0;
    for (let m = 0; m <= M; m++) {
      const target = (m / M) * sEnd;
      while (cur < arc.length - 2 && arc[cur + 1] < target) cur++;
      const seg = arc[cur + 1] - arc[cur] || 1;
      const t = Math.min(1, Math.max(0, (target - arc[cur]) / seg));
      const f = m / M;
      const r = (rs[cur] + (rs[cur + 1] - rs[cur]) * t) * (1 + rip * smoothstep(0.10, 0.55, f));
      const y = ys[cur] + (ys[cur + 1] - ys[cur]) * t;
      pos.push(sth * r, y, cth * r);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const idx = [];
  for (let i = 0; i < AZ; i++) {
    for (let m = 0; m < M; m++) {
      const a = i * (M + 1) + m, b = a + 1, c = a + (M + 1), dd = c + 1;
      idx.push(a, b, c, b, dd, c);
    }
  }
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// --------------------------------------------------------------- extras ---
function phiForY(target, th, h, pad) {
  let lo = 0, hi = Math.PI;
  const d = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    dirFrom(mid, th, d);
    headPoint(d.x, d.y, d.z, h, pad, v);
    if (v.y > target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// A flat band hugging the skull (the swim-cap headbands on the sheet).
export function buildBand(h, y, halfH, pad, AZ = 96) {
  const pos = [];
  const d = new THREE.Vector3(), v = new THREE.Vector3();
  for (let i = 0; i <= AZ; i++) {
    const th = (i / AZ) * Math.PI * 2;
    for (let j = 0; j <= 1; j++) {
      const ty = y + (j === 0 ? halfH : -halfH);
      dirFrom(phiForY(ty, th, h, pad), th, d);
      headPoint(d.x, d.y, d.z, h, pad, v);
      pos.push(v.x, ty, v.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const idx = [];
  for (let i = 0; i < AZ; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d2 = a + 3;
    idx.push(a, b, c, b, d2, c);
  }
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// The little standing curl (ahoge) several characters have.
export function buildAhoge(h, seed = 0) {
  const d = new THREE.Vector3(), root = new THREE.Vector3();
  dirFrom(0.28, seed * 0.8, d);
  headPoint(d.x, d.y, d.z, h, 0.05, root);
  const curve = new THREE.CatmullRomCurve3([
    root.clone(),
    root.clone().add(new THREE.Vector3(0.03, 0.20, 0.02)),
    root.clone().add(new THREE.Vector3(-0.13, 0.34, 0.0)),
    root.clone().add(new THREE.Vector3(-0.04, 0.44, -0.03)),
    root.clone().add(new THREE.Vector3(0.11, 0.41, -0.02)),
  ]);
  return buildTube(curve, (t) => 0.075 * Math.pow(1 - t, 0.55) + 0.006, 22, 8);
}
