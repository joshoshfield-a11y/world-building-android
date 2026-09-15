// audio/engine.js — album demo engine for the living-world build.
// Playlist: assets/audio/manifest.json (real album) with a synth fallback.
// Publishes band energies + beat events on window.__AUDIO__.

class AudioEngine {
  constructor() {
    this.ctx = null; this.analyser = null; this.master = null;
    this.bands = { sub: 0, bass: 0, mid: 0, high: 0 };
    this.beat = false; this._bassHist = []; this._track = 0; this.playlist = [];
    this.playing = false; this._src = null; this._synth = null;
  }

  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain(); this.master.gain.value = 0.9;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048; this.analyser.smoothingTimeConstant = 0.55;
    this.master.connect(this.analyser); this.analyser.connect(this.ctx.destination);
    this._fft = new Float32Array(this.analyser.frequencyBinCount);
    try {
      const m = await (await fetch('./assets/audio/manifest.json')).json();
      if (Array.isArray(m) && m.length) this.playlist = m;
    } catch (e) { /* no manifest — synth demo */ }
    if (!this.playlist.length) this.playlist = [{ title: 'DEMO // NIGHT RUN', synth: true }];
    window.__AUDIO__ = { engine: this, bands: this.bands, nowPlaying: () => this.playlist[this._track] };
    return this;
  }

  async play(i = 0) {
    if (this.ctx.state === 'suspended') await this.ctx.resume();   // mobile gesture gate
    this._track = ((i % this.playlist.length) + this.playlist.length) % this.playlist.length;
    this.stopSource();
    const t = this.playlist[this._track];
    if (t.synth) this._synth = new DemoBeat(this.ctx, this.master);
    else {
      this._src = this.ctx.createBufferSource();
      this._src.buffer = await this._load(t.src);
      this._src.connect(this.master); this._src.start();
    }
    this.playing = true; this._emitHud();
  }

  next() { this.play(this._track + 1); }
  pause() { this.stopSource(); this.playing = false; this._emitHud(); }

  stopSource() {
    if (this._src) { try { this._src.stop(); } catch (e) {} this._src = null; }
    if (this._synth) { this._synth.stop(); this._synth = null; }
  }

  async _load(src) {
    const ab = await (await fetch(src)).arrayBuffer();
    return await this.ctx.decodeAudioData(ab);
  }

  _emitHud() {
    const t = this.playlist[this._track];
    document.querySelectorAll('.np-title').forEach(el => el.textContent = t.title);
    document.querySelectorAll('.np-state').forEach(el => el.textContent = this.playing ? 'LIVE' : 'PAUSED');
  }

  sample() {
    if (!this.analyser) return;
    this.analyser.getFloatFrequencyData(this._fft);
    const band = (lo, hi) => {
      const bin = f => Math.max(0, Math.round(f * this._fft.length / this.ctx.sampleRate));
      let s = 0, n = 0;
      for (let i = bin(lo); i <= Math.min(bin(hi), this._fft.length - 1); i++) { s += this._fft[i]; n++; }
      const db = n ? s / n : -100;
      return Math.max(0, Math.min(1, (db + 70) / 50));
    };
    this.bands.sub = band(20, 90); this.bands.bass = band(90, 250);
    this.bands.mid = band(250, 2000); this.bands.high = band(2000, 8000);
    this._bassHist.push(this.bands.bass); if (this._bassHist.length > 43) this._bassHist.shift();
    const avg = this._bassHist.reduce((a, b) => a + b, 0) / this._bassHist.length;
    this.beat = this.playing && this.bands.bass > avg * 1.35 && this.bands.bass > 0.45;
  }
}

// Procedural fallback beat — 92 BPM trap sketch so the demo runs bare.
class DemoBeat {
  constructor(ctx, out) {
    this.ctx = ctx; this.out = out; this.alive = true;
    this.bpm = 92; this.step = 60 / this.bpm / 4; this.bar = 0;
    this._noise = this._noiseBuf(); this._timer = setInterval(() => this._step(), this.step * 1000);
  }
  _noiseBuf() {
    const b = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.5, this.ctx.sampleRate);
    const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  _env(g, t, a, peak, dec) {
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
  }
  _kick808(t) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    this._env(g, t, 0.004, 1.0, 0.42); o.connect(g).connect(this.out); o.start(t); o.stop(t + 0.5);
  }
  _hat(t, open) {
    const s = this.ctx.createBufferSource(); s.buffer = this._noise;
    const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7500;
    const g = this.ctx.createGain(); this._env(g, t, 0.002, open ? 0.22 : 0.13, open ? 0.28 : 0.05);
    s.connect(f).connect(g).connect(this.out); s.start(t); s.stop(t + 0.35);
  }
  _sub(t, semi, len) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.value = 55 * Math.pow(2, semi / 12);
    this._env(g, t, 0.01, 0.5, len); o.connect(g).connect(this.out); o.start(t); o.stop(t + len + 0.1);
  }
  _step() {
    if (!this.alive) return;
    const t = this.ctx.currentTime + 0.02, s = (this.bar++) % 16;
    if (s === 0 || s === 7 || s === 10) this._kick808(t);
    if (s % 2 === 0) this._hat(t, false); if (s === 14) this._hat(t, true);
    const line = { 0: 0, 3: 0, 6: -2, 8: -4, 11: -5, 14: -7 };
    if (s in line) this._sub(t, line[s], this.step * 3.2);
  }
  stop() { this.alive = false; clearInterval(this._timer); }
}

export const engine = new AudioEngine();
