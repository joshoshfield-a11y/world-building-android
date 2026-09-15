// ---------------------------------------------------------------------------
// Procedural texture library. Everything is drawn into <canvas> at runtime:
// no image files are loaded anywhere in this project.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const cache = new Map();

function cv(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/* ---------- value noise / fbm ---------- */
function hash(x, y, s) {
  let h = x * 374761393 + y * 668265263 + s * 1442695040;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}
function smooth(t) { return t * t * (3 - 2 * t); }
// tileable value noise on a grid of `per` cells
function vnoise(x, y, per, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const m = (v) => ((v % per) + per) % per;
  const x0 = m(xi), x1 = m(xi + 1), y0 = m(yi), y1 = m(yi + 1);
  const a = hash(x0, y0, s), b = hash(x1, y0, s);
  const c = hash(x0, y1, s), d = hash(x1, y1, s);
  return (a + (b - a) * xf) * (1 - yf) + (c + (d - c) * xf) * yf;
}
function fbm(x, y, oct, per, s, gain = 0.5) {
  let v = 0, a = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    v += a * vnoise(x * f, y * f, per * f, s + i * 17);
    norm += a; a *= gain; f *= 2;
  }
  return v / norm;
}

/* ---------- height field -> normal map ---------- */
function normalFromHeight(h, size, strength) {
  const c = cv(size), ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      img.data[i] = (nx / l * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz / l * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function tex(canvas, repeat = 1, srgb = false) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------- palette helper ---------- */
function lerpRGB(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// =====================  BOARD-FORMED CONCRETE  =============================
export function concrete(opts = {}) {
  const key = 'conc' + JSON.stringify(opts);
  if (cache.has(key)) return cache.get(key);
  const S = 512, boards = opts.boards ?? 12, tint = opts.tint ?? [188, 185, 178];
  const c = cv(S), ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const h = new Float32Array(S * S);
  const bh = S / boards;
  for (let y = 0; y < S; y++) {
    const bi = Math.floor(y / bh);
    const inBoard = (y % bh) / bh;
    const bt = hash(bi, 3, 11) * 0.05 - 0.025;
    for (let x = 0; x < S; x++) {
      let n = fbm(x / 40, y / 40, 5, 13, 7) - 0.5;
      n += (fbm(x / 6, y / 6, 3, 85, 21) - 0.5) * 0.45;
      const grain = (fbm(x / 120, y / 4.5, 3, 4, 31 + bi * 5) - 0.5);
      let seam = 0;
      const e = Math.min(inBoard, 1 - inBoard);
      if (e < 0.028) seam = -(1 - e / 0.028);
      let v = 0.80 + n * 0.17 + bt + grain * 0.05 + seam * 0.14;
      const tx = Math.floor(x / (S / 3)), ty = bi;
      if (hash(tx, ty, 91) > 0.93) {
        const cxp = (tx + 0.5) * (S / 3), cyp = (ty + 0.5) * bh;
        const d = Math.hypot(x - cxp, y - cyp);
        if (d < 6) v -= (1 - d / 6) * 0.16;
      }
      v = Math.max(0.05, Math.min(1.1, v));
      h[y * S + x] = v * 0.5 + seam * 0.9 + grain * 0.5;
      const col = lerpRGB([tint[0] * 0.42, tint[1] * 0.42, tint[2] * 0.44], tint, v);
      const i = (y * S + x) * 4;
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const rc = cv(S), rx = rc.getContext('2d');
  const rimg = rx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = 210 + (h[i] - 0.5) * 40;
    rimg.data[i * 4] = rimg.data[i * 4 + 1] = rimg.data[i * 4 + 2] = v; rimg.data[i * 4 + 3] = 255;
  }
  rx.putImageData(rimg, 0, 0);
  const out = { map: tex(c, opts.repeat ?? 1, true), normalMap: tex(normalFromHeight(h, S, 0.9), opts.repeat ?? 1), roughnessMap: tex(rc, opts.repeat ?? 1) };
  cache.set(key, out);
  return out;
}

// =====================  TIMBER (planks / cladding / floor)  ================
export function timber(opts = {}) {
  const key = 'tim' + JSON.stringify(opts);
  if (cache.has(key)) return cache.get(key);
  const S = 512;
  const planks = opts.planks ?? 6;
  const light = opts.light ?? [186, 138, 88];
  const dark = opts.dark ?? [104, 68, 38];
  const gap = opts.gap ?? 0.02;
  const c = cv(S), ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const h = new Float32Array(S * S);
  const pw = S / planks;
  for (let x = 0; x < S; x++) {
    const pi = Math.floor(x / pw);
    const inP = (x % pw) / pw;
    const tone = hash(pi, 5, 43) * 0.30 - 0.15;
    const off = hash(pi, 9, 77) * 400;
    const scale = 0.75 + hash(pi, 13, 55) * 0.6;
    for (let y = 0; y < S; y++) {
      // grain: stretched noise along y with ring-like banding
      const g1 = fbm((x * 3.2) / 90, (y + off) / 420, 4, 12, 61 + pi);
      const rings = Math.abs(Math.sin((g1 * 4.2 + (y + off) / 62) * scale * Math.PI));
      let v = 0.42 + rings * 0.44 + tone;
      v += (fbm(x / 2.2, (y + off) / 18, 2, 200, 5) - 0.5) * 0.14;
      // knots
      const kx = (pi + 0.5) * pw, ky = (hash(pi, 21, 3) * S);
      const kd = Math.hypot(x - kx, (y - ky) * 0.55);
      if (hash(pi, 31, 8) > 0.62 && kd < 13) v -= (1 - kd / 13) * 0.45;
      let height = v;
      // plank joint
      const e = Math.min(inP, 1 - inP);
      if (e < gap) { v *= 0.30 + e / gap * 0.5; height -= 1.1 * (1 - e / gap); }
      v = Math.max(0.03, Math.min(1, v));
      h[y * S + x] = height;
      const col = lerpRGB(dark, light, v);
      const i = (y * S + x) * 4;
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const rc = cv(S), rx = rc.getContext('2d');
  const rimg = rx.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = (opts.rough ?? 150) + (0.5 - h[i]) * 70;
    rimg.data[i * 4] = rimg.data[i * 4 + 1] = rimg.data[i * 4 + 2] = Math.max(20, Math.min(250, v));
    rimg.data[i * 4 + 3] = 255;
  }
  rx.putImageData(rimg, 0, 0);
  const rep = opts.repeat ?? 1;
  const out = { map: tex(c, rep, true), normalMap: tex(normalFromHeight(h, S, opts.nstrength ?? 1.1), rep), roughnessMap: tex(rc, rep) };
  cache.set(key, out);
  return out;
}

// =====================  STONE (split-face / travertine)  ==================
export function stone(opts = {}) {
  const key = 'stn' + JSON.stringify(opts);
  if (cache.has(key)) return cache.get(key);
  const S = 512, rows = opts.rows ?? 4;
  const base = opts.base ?? [196, 182, 160];
  const c = cv(S), ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const h = new Float32Array(S * S);
  const rh = S / rows;
  const rowSeeds = [];
  for (let r = 0; r < rows; r++) rowSeeds.push({ off: hash(r, 1, 5) * S, n: 2 + Math.floor(hash(r, 2, 9) * 2) });
  for (let y = 0; y < S; y++) {
    const r = Math.floor(y / rh), inR = (y % rh) / rh;
    const rs = rowSeeds[r];
    const bw = S / rs.n;
    for (let x = 0; x < S; x++) {
      const bi = Math.floor(((x + rs.off) % S) / bw);
      const inB = (((x + rs.off) % S) % bw) / bw;
      const bt = hash(bi, r, 27) * 0.16 - 0.08;
      // travertine: stretched horizontal striation
      const stri = fbm(x / 70, y / 6, 4, 8, 3 + r * 3);
      let v = 0.72 + bt + (stri - 0.5) * 0.24 + (fbm(x / 26, y / 26, 4, 19, 12) - 0.5) * 0.16;
      v += (fbm(x / 3, y / 3, 2, 170, 12) - 0.5) * 0.07;
      let height = (stri - 0.5) * 0.7 + (fbm(x / 12, y / 12, 4, 42, 19) - 0.5) * 0.5;
      // small pitting
      if (fbm(x / 5, y / 5, 2, 100, 77) > 0.72) { height -= 0.5; v -= 0.05; }
      const eB = Math.min(inB, 1 - inB), eR = Math.min(inR, 1 - inR);
      const joint = Math.min(eB * bw, eR * rh);
      if (joint < 2.0) { v *= 0.80; height -= 1.1; }
      v = Math.max(0.05, Math.min(1.15, v));
      h[y * S + x] = height;
      const warm = hash(bi, r, 61) * 0.10 - 0.03;
      const col = lerpRGB([base[0] * 0.62, base[1] * 0.58, base[2] * 0.54], [base[0] * (1.06 + warm), base[1] * (1.03 + warm * 0.7), base[2] * (0.97 + warm * 0.4)], v);
      const i = (y * S + x) * 4;
      img.data[i] = Math.min(255, col[0]); img.data[i + 1] = Math.min(255, col[1]);
      img.data[i + 2] = Math.min(255, col[2]); img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const rep = opts.repeat ?? 1;
  const out = { map: tex(c, rep, true), normalMap: tex(normalFromHeight(h, S, 1.5), rep) };
  cache.set(key, out);
  return out;
}

// =====================  PLASTER / MICROCEMENT  ============================
export function plaster(opts = {}) {
  const key = 'pl' + JSON.stringify(opts);
  if (cache.has(key)) return cache.get(key);
  const S = 512, tint = opts.tint ?? [238, 234, 226];
  const c = cv(S), ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const h = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    // trowel strokes
    const s = fbm(x / 60, y / 42, 4, 9, 4);
    let v = 0.86 + (s - 0.5) * (opts.mottle ?? 0.10) + (fbm(x / 2.4, y / 2.4, 2, 200, 66) - 0.5) * 0.05;
    h[y * S + x] = s * 0.7 + (fbm(x / 4, y / 4, 2, 120, 8) - 0.5) * 0.3;
    const col = [tint[0] * v, tint[1] * v, tint[2] * v];
    const i = (y * S + x) * 4;
    img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const rep = opts.repeat ?? 1;
  const out = { map: tex(c, rep, true), normalMap: tex(normalFromHeight(h, S, 0.55), rep) };
  cache.set(key, out);
  return out;
}

// =====================  GRASS / LAWN  =====================================
export function grass(opts = {}) {
  if (cache.has('grass')) return cache.get('grass');
  const S = 512, c = cv(S), ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const h = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const big = fbm(x / 70, y / 70, 4, 7, 2);          // mow bands + patches
    const bands = Math.sin(x / 46) * 0.5 + 0.5;
    const fine = fbm(x / 2.0, y / 2.0, 3, 250, 44);
    const clump = fbm(x / 11, y / 11, 3, 46, 17);
    let g = 0.32 + big * 0.32 + bands * 0.045 + clump * 0.22;
    const dry = Math.max(0, fbm(x / 40, y / 40, 3, 13, 91) - 0.62) * 1.6;
    let col = lerpRGB([42, 62, 34], [92, 122, 56], g);
    col = lerpRGB(col, [132, 130, 82], dry);
    col = col.map((v) => v * (0.72 + fine * 0.5));
    h[y * S + x] = fine * 0.8 + clump * 0.4;
    const i = (y * S + x) * 4;
    img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const out = { map: tex(c, 22, true), normalMap: tex(normalFromHeight(h, S, 0.9), 22) };
  cache.set('grass', out);
  return out;
}

// =====================  GRAVEL  ===========================================
export function gravel(opts = {}) {
  if (cache.has('grav')) return cache.get('grav');
  const S = 512, c = cv(S), ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const h = new Float32Array(S * S);
  // scatter pebbles as a distance field
  const pts = [];
  let sd = 12345;
  const rr = () => (sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 1100; i++) pts.push([rr() * S, rr() * S, 3 + rr() * 6, rr()]);
  const gcell = 64, grid = new Map();
  const gk = (a, b) => a + ',' + b;
  pts.forEach((p, i) => {
    const a = Math.floor(p[0] / gcell), b = Math.floor(p[1] / gcell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const k = gk((a + dx + 8) % 8, (b + dy + 8) % 8);
      if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
    }
  });
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const cand = grid.get(gk(Math.floor(x / gcell), Math.floor(y / gcell))) || [];
    let best = 1e9, tone = 0.5;
    for (const i of cand) {
      const p = pts[i];
      let dx = Math.abs(x - p[0]), dy = Math.abs(y - p[1]);
      dx = Math.min(dx, S - dx); dy = Math.min(dy, S - dy);
      const d = Math.hypot(dx, dy) / p[2];
      if (d < best) { best = d; tone = p[3]; }
    }
    const inside = best < 1 ? Math.sqrt(1 - best * best) : 0;
    let v = 0.34 + inside * 0.45 + tone * 0.22 + (fbm(x / 2, y / 2, 2, 250, 5) - 0.5) * 0.14;
    h[y * S + x] = inside;
    const col = lerpRGB([84, 80, 74], [196, 190, 178], Math.min(1, v));
    const i2 = (y * S + x) * 4;
    img.data[i2] = col[0]; img.data[i2 + 1] = col[1]; img.data[i2 + 2] = col[2]; img.data[i2 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const out = { map: tex(c, 16, true), normalMap: tex(normalFromHeight(h, S, 2.2), 16) };
  cache.set('grav', out);
  return out;
}

// =====================  FABRIC  ===========================================
export function fabric(opts = {}) {
  const key = 'fab' + JSON.stringify(opts);
  if (cache.has(key)) return cache.get(key);
  const S = 256, tint = opts.tint ?? [150, 143, 130];
  const c = cv(S), ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const h = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const weave = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 ? 0.975 : 1.02;
    const n = fbm(x / 3, y / 3, 2, 90, 6);
    const v = weave * (0.94 + n * 0.12);
    h[y * S + x] = weave + n * 0.3;
    const i = (y * S + x) * 4;
    img.data[i] = tint[0] * v; img.data[i + 1] = tint[1] * v; img.data[i + 2] = tint[2] * v; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const rep = opts.repeat ?? 4;
  const out = { map: tex(c, rep, true), normalMap: tex(normalFromHeight(h, S, 0.8), rep) };
  cache.set(key, out);
  return out;
}

// =====================  MARBLE  ===========================================
export function marble(opts = {}) {
  if (cache.has('marb')) return cache.get('marb');
  const S = 512, c = cv(S), ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const w = fbm(x / 120, y / 120, 5, 5, 9);
    let v = Math.sin((x / 90 + w * 3.4) * Math.PI * 2) * 0.5 + 0.5;
    v = Math.pow(v, 4);
    const vein = Math.pow(Math.abs(Math.sin((y / 200 + w * 4) * Math.PI * 3)), 22);
    let g = 236 - v * 46 - vein * 60;
    const col = [g, g * 0.995, g * 0.975];
    const i = (y * S + x) * 4;
    img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const out = { map: tex(c, 1, true) };
  cache.set('marb', out);
  return out;
}

// =====================  ABSTRACT ARTWORK  =================================
export function artwork(seed = 1) {
  const key = 'art' + seed;
  if (cache.has(key)) return cache.get(key);
  const S = 256, c = cv(S), ctx = c.getContext('2d');
  const bg = 226 + hash(seed, 1, 3) * 22;
  ctx.fillStyle = `rgb(${bg},${bg - 3},${bg - 9})`;
  ctx.fillRect(0, 0, S, S);
  const pal = [[188, 158, 120], [96, 106, 112], [172, 96, 66], [64, 74, 86], [206, 190, 160], [122, 132, 104]];
  const n = 2 + Math.floor(hash(seed, 2, 7) * 4);
  for (let i = 0; i < n; i++) {
    const col = pal[Math.floor(hash(seed, i + 3, 11) * pal.length)];
    ctx.globalAlpha = 0.24 + hash(seed, i + 9, 13) * 0.5;
    ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
    const x = hash(seed, i + 21, 17) * S, y = hash(seed, i + 31, 19) * S;
    const w = 30 + hash(seed, i + 41, 23) * S * 0.6, h = 30 + hash(seed, i + 51, 29) * S * 0.7;
    if (hash(seed, i + 61, 31) > 0.5) { ctx.fillRect(x - w / 2, y - h / 2, w, h); }
    else { ctx.beginPath(); ctx.ellipse(x, y, w / 2, h / 2, hash(seed, i, 3) * 3, 0, 7); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
  const t = tex(c, 1, true);
  const out = { map: t };
  cache.set(key, out);
  return out;
}

// =====================  SKY (equirect gradient for env + background) ======
export function skyTexture(sunY = 0.6, hazeCol = '#cfe0ee') {
  const w = 1024, h = 512;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0.0, '#1e4a86');
  g.addColorStop(0.42, '#8fb6dc');
  g.addColorStop(0.5, hazeCol);
  g.addColorStop(0.52, '#8b8779');
  g.addColorStop(1.0, '#3b3a36');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// =====================  small helpers used by materials ===================
export function noiseCanvas(S, fn) {
  const c = cv(S), ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const [r, g, b] = fn(x, y, fbm, hash);
    const i = (y * S + x) * 4;
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
export { tex, fbm, hash, normalFromHeight };
