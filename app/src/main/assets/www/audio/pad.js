// audio/pad.js — the secret. Hold CHEER 3s -> pentatonic pad slides up.
// Play the five-tone motif (D E C C G) and the world answers: aurora blows
// open, the villa door opens itself, beacon state persists for later content.

const SEQ = [293.66, 329.63, 261.63, 261.63, 196.00]; // D4 E4 C4 C4 G3
const PAD_NOTES = [261.63, 293.66, 329.63, 392.00, 440.00]; // C D E G A
let entry = [], holdTimer = null, ctx = null;

function tone(freq, dur = 0.9) {
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
  const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
  o.type = 'sine'; o.frequency.value = freq; f.type = 'lowpass'; f.frequency.value = 1800;
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(f).connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur + 0.1);
}

export function armSecretPad(worldProvider) {
  const cheer = document.getElementById('btn-cheer');
  const pad = document.getElementById('pad');
  if (!cheer || !pad) return;
  const open = () => { pad.classList.add('open'); tone(130.8, 1.4); };
  const close = () => pad.classList.remove('open');
  cheer.addEventListener('pointerdown', () => { holdTimer = setTimeout(open, 3000); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(e =>
    cheer.addEventListener(e, () => clearTimeout(holdTimer)));
  document.getElementById('pad-close').addEventListener('click', close);

  pad.querySelectorAll('.pad-key').forEach((k, i) => {
    k.addEventListener('pointerdown', () => {
      if (ctx && ctx.state === 'suspended') ctx.resume();
      tone(PAD_NOTES[i]);
      k.classList.add('hit'); setTimeout(() => k.classList.remove('hit'), 220);
      entry.push(PAD_NOTES[i]); if (entry.length > SEQ.length) entry.shift();
      if (entry.length === SEQ.length && entry.every((f, j) => Math.abs(f - SEQ[j]) < 0.01)) unlock(worldProvider);
    });
  });
}

function unlock(worldProvider) {
  const w = worldProvider(); if (!w) return;
  window.__BEACON__ = { unlocked: true, at: Date.now() };
  try { localStorage.setItem('beacon_unlocked', '1'); } catch (e) {}
  w.atmosphere.aurora.uniforms.gain.value = 3.0;
  w.atmosphere.aurora.uniforms.speed.value = 2.0;
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', bubbles: true }));
  setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyF', bubbles: true })), 120);
  const el = document.getElementById('pad');
  el.classList.add('unlocked');
  document.querySelectorAll('.np-title').forEach(e => e.textContent = 'BEACON // CONTACT');
  setTimeout(() => el.classList.remove('open', 'unlocked'), 4000);
}
