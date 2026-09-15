// mobile/main.js — touch input + adaptive quality for world-building
// Runs BEFORE world/main.js: sets tier globals, then dynamic-imports the scene
// (dynamic import = this module's globals are visible to the configs it loads).

const TIER = (() => {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
  if (!mobile) return 'high';
  if (cores <= 4 || mem <= 4) return 'low';
  return 'medium';
})();
window.__WORLD_TIER__ = TIER;
document.getElementById('tier-tag').textContent = `quality: ${TIER}`;
if (TIER !== 'high') Object.defineProperty(window, 'devicePixelRatio', { value: 1.0 });

const KEYS = { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', run: 'ShiftLeft' };
const press = (code, down) => window.dispatchEvent(
  new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));

// ---- joystick: writes directly into player.keys (verified contract) ----
const joy = document.getElementById('joy'), knob = document.getElementById('joy-knob');
let joyId = null;
const setKeys = (active, run) => {
  const w = window.__world; if (!w) return;
  for (const k of Object.values(KEYS)) {
    if (active.has(k)) w.player.keys.add(k); else w.player.keys.delete(k);
  }
  if (run) w.player.keys.add(KEYS.run); else w.player.keys.delete(KEYS.run);
};
joy.addEventListener('pointerdown', e => {
  joyId = e.pointerId; joy.setPointerCapture(joyId); moveJoy(e);
});
joy.addEventListener('pointermove', e => { if (e.pointerId === joyId) moveJoy(e); });
const endJoy = e => {
  if (e.pointerId !== joyId) return;
  joyId = null; knob.style.transform = 'translate(-50%,-50%)'; setKeys(new Set(), false);
};
joy.addEventListener('pointerup', endJoy); joy.addEventListener('pointercancel', endJoy);
function moveJoy(e) {
  const r = joy.getBoundingClientRect();
  let dx = (e.clientX - r.left - r.width / 2) / (r.width / 2);
  let dy = (e.clientY - r.top - r.height / 2) / (r.height / 2);
  const m = Math.hypot(dx, dy), cap = Math.min(m, 1);
  dx = m ? dx / m * cap : 0; dy = m ? dy / m * cap : 0;
  knob.style.transform = `translate(calc(-50% + ${dx * 38}px), calc(-50% + ${dy * 38}px))`;
  const a = new Set();
  if (dy < -0.35) a.add(KEYS.up); if (dy > 0.35) a.add(KEYS.down);
  if (dx < -0.35) a.add(KEYS.left); if (dx > 0.35) a.add(KEYS.right);
  setKeys(a, cap > 0.92);   // push to edge = run (ShiftLeft)
}

// ---- look: right-half drag -> synthesized pointer events into OrbitControls ----
let lookId = null, lx = 0, ly = 0;
addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch') return;
  if (e.clientX < innerWidth * 0.45 || e.target.closest('#joy,.btns,#panel-btn')) return;
  const w = window.__world; if (!w) return;
  lookId = e.pointerId; lx = e.clientX; ly = e.clientY;
  const c = w.renderer.domElement;
  c.dispatchEvent(new PointerEvent('pointerdown',
    { pointerId: 9, clientX: lx, clientY: ly, bubbles: true, button: 0, buttons: 1 }));
});
addEventListener('pointermove', e => {
  if (e.pointerId !== lookId) return;
  const w = window.__world; if (!w) return;
  lx = e.clientX; ly = e.clientY;
  w.renderer.domElement.dispatchEvent(new PointerEvent('pointermove',
    { pointerId: 9, clientX: lx, clientY: ly, bubbles: true, buttons: 1 }));
});
const endLook = e => {
  if (e.pointerId !== lookId) return;
  lookId = null;
  window.__world?.renderer.domElement.dispatchEvent(new PointerEvent('pointerup',
    { pointerId: 9, clientX: lx, clientY: ly, bubbles: true, button: 0, buttons: 0 }));
};
addEventListener('pointerup', endLook); addEventListener('pointercancel', endLook);

// ---- action buttons: reuse the scene's own keydown handler ----
const tap = (id, code) => {
  const el = document.getElementById(id);
  el.addEventListener('pointerdown', e => { e.preventDefault(); press(code, true); });
  el.addEventListener('pointerup', () => press(code, false));
  el.addEventListener('pointercancel', () => press(code, false));
};
tap('btn-jump', 'Space'); tap('btn-door', 'KeyF');
tap('btn-cheer', 'KeyX'); tap('btn-view', 'KeyV');

// ---- panel toggle (lil-gui starts hidden on small screens) ----
document.getElementById('panel-btn').addEventListener('click', () =>
  document.querySelector('.lil-gui.root')?.classList.toggle('hidden'));

// ---- boot the world (skips the broken React/JSX mount chain) ----
import('../world/main.js');

// ---- album demo layer: reactive audio + secret pad, world-driven ----
import('../audio/engine.js').then(async ({ engine }) => {
  const { ReactiveWorld } = await import('../audio/reactive.js');
  const { armSecretPad } = await import('../audio/pad.js');
  await engine.init();
  const t = setInterval(() => {
    if (!window.__world) return;
    clearInterval(t);
    const rw = new ReactiveWorld(window.__world, engine);
    armSecretPad(() => window.__world);
    (function loop() { engine.sample(); rw.frame(1 / 60); requestAnimationFrame(loop); })();
  }, 250);
  document.getElementById('np-play')?.addEventListener('click', () =>
    engine.playing ? engine.pause() : engine.play());
  document.getElementById('np-next')?.addEventListener('click', () => engine.next());
});
