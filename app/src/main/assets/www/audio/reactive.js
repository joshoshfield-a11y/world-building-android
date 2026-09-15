// audio/reactive.js — drive the world's live knobs from the audio engine.
// Every target is a verified live uniform / config value the lil-gui handlers
// in world/main.js already mutate at runtime. No h0 rebakes — the ocean
// spectrum stays stable while everything else breathes.

export class ReactiveWorld {
  constructor(world, audio) {
    this.w = world; this.a = audio;
    this.pulse = 0; this.smooth = { sub: 0, bass: 0, mid: 0, high: 0 };
    this.baseFov = world.camera.fov;
    this.baseWind = world.grassCfg.wind.strength;
    this.baseTimeScale = world.oceanCfg.sim.timeScale;
    this.t = 0;
  }

  frame(dt) {
    const b = this.a.bands, s = this.smooth, w = this.w;
    const env = (v, cur, atk, rel) => v > cur ? cur + (v - cur) * atk : cur + (v - cur) * rel;
    s.sub = env(b.sub, s.sub, 0.6, 0.06); s.bass = env(b.bass, s.bass, 0.5, 0.08);
    s.mid = env(b.mid, s.mid, 0.3, 0.05); s.high = env(b.high, s.high, 0.4, 0.04);
    this.t += dt;

    // ocean: sub+bass surge the sea's clock; kicks chop the surface
    const surge = 1 + s.sub * 2.2 + s.bass * 0.8;
    w.oceanCfg.sim.timeScale = this.baseTimeScale * (this.a.playing ? surge : 1);
    w.sim.lambdaU.value = 1.3 + s.bass * 0.7 + (this.a.beat ? 0.25 : 0);

    // aurora: mids open the curtains, highs speed the shimmer
    w.atmosphere.aurora.uniforms.gain.value = 0.6 + s.mid * 2.4;
    w.atmosphere.aurora.uniforms.speed.value = 0.4 + s.high * 2.2;

    // wind: mid band breathes through grass and palms
    w.grassCfg.wind.strength = Math.min(1, this.baseWind + s.mid * 0.55 + s.sub * 0.25);

    // camera: sub-bass lands as a small FOV thump
    if (this.a.beat) this.pulse = Math.min(this.pulse + 0.5, 1);
    this.pulse *= Math.exp(-dt * 7);
    const fov = this.baseFov - this.pulse * (2.5 + s.sub * 3);
    if (Math.abs(w.camera.fov - fov) > 0.01) { w.camera.fov = fov; w.camera.updateProjectionMatrix(); }

    const el = document.getElementById('vuflo');
    if (el) el.style.setProperty('--vu', `${Math.round((s.sub + s.bass + s.mid + s.high) / 4 * 100)}%`);
  }
}
