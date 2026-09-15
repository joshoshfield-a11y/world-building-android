# Ocean — GPU spectral FFT water

Real-time inverse-FFT ocean. Three.js `WebGPURenderer` + TSL only (no raw
WGSL/GLSL); the wave field lives entirely on the GPU — the CPU evolves nothing
per frame, it bumps a time uniform and issues submits.

Static ES modules, no build step: serve the parent folder and open
`ocean/index.html` (needs a WebGPU browser).

The scene shares the sky scene's day–night atmosphere (`../sky/atmosphere.js`):
a ray-marched Rayleigh/Mie scattering LUT, a geometrically lit moon, hashed
stars, and a time-of-day control (clock HUD, auto-play). Reflections, subsurface
scatter and foam all follow the sun — golden at sunset, moonlit silver at night.
The water dims through a single `bodyLight` scalar driven by sun/moon elevation,
so the ocean shading works unchanged under a moving sky.

## Algorithm

- **3 cascades at N = 256** covering disjoint wavenumber bands
  (`lengthScales = [1000, 80, 7]` m, boundary factor 6), summed at shading time.
  **The largest patch is the sea's period, and it decides whether the ocean
  reads as an ocean.** At 250 m it was three wavelengths wide at the JONSWAP
  peak: ~19 modes near the peak, no room for the beating between neighbouring
  wavenumbers that makes wave *groups*, and the identical field repeating every
  250 m across a 3.8 km view. The result is a uniform quilt of same-size cells —
  the single most common way a spectral ocean goes wrong. The constraint on
  going bigger is sampling: a band ends at `lengthScales[i+1] / 6`, which has to
  stay above its own patch Nyquist `2·lengthScales[i] / N`, so the whole ladder
  moves together.
- **Spectrum**: two layers (local wind sea + travelled swell), each
  `JONSWAP · TMA depth correction · Donelan-Banner directional spreading ·
  short-wave fade`, finite-depth dispersion. Evaluated branchlessly on
  `kSafe = max(|k|, cutoffLow)` with the band mask applied afterwards, so the
  DC texel can never mint a NaN. One shared Box-Muller gaussian field keeps the
  cascades phase-coherent. The swell layer is a *distant storm* — 14 m/s over
  800 km of fetch, peaking near 280 m — not a light local breeze; a swell shorter
  than the wind sea on top of it is just more chop, and one longer than the
  largest patch cannot exist at all.
- **8 real fields packed as 4 complex signals** (`A + iB`) per cascade —
  displacement x/y/z plus the four derivatives ride on 4 IFFTs instead of 8.
- **Stockham radix-2 inverse FFT** from a precomputed butterfly table, forward
  twiddles conjugated at read time. All 12 (cascade, field) slices live in one
  storage buffer, so every butterfly step is a single dispatch across all of
  them — and each step is its own `renderer.compute()` submit, because WebGPU
  has no memory barrier between dispatches inside one compute pass.
- **Foam from the displacement Jacobian** with a persistent per-texel
  turbulence value that snaps down on a fold and recovers at `foamDecay` —
  whitecaps appear with the crash and dissipate over seconds instead of
  flickering. Stored in `displacement.w`; the finest cascade is excluded from
  coverage (its Jacobian sits permanently near-folding and reads as speckle).
- **Surface**: a power-warped grid (axis-wise cubic warp, 768² segments)
  spanning **3.8 km**, ~0.3 m cells at the centre where the finest cascade's
  ripples live and ~20 m at the rim — so the sea reads as boundless from any
  zoom for fewer vertices than a uniform 400 m plane. The dense centre **follows
  the camera** (world-space lookups add the offset back, so the waves stay put);
  anchored at the origin it gives a shoreline 500 m away 4 m polygons and the
  surf line turns into a staircase.
- **Shoaling** where a seabed is bound: a wave running into shallow water does
  not fade out, it slows and *grows* (Green's law) until it breaks. Damping the
  displacement to nothing on approach — the obvious thing — leaves a glassy
  turquoise strip between the chop and the sand with a painted white line lying
  on top of it. Gain on the way in, collapse over the last couple of metres, and
  the breaking criterion below has real crests to light.

  **And a trough cannot dig into the seabed.** The FFT knows nothing about the
  bottom, and that shoaling gain multiplies its *vertical* displacement by up to
  1.55 exactly where the bed rises — so over a shelf three metres down, a
  two-metre trough becomes three and a half and the surface passes clean through
  the sand. What that renders as is a hole in the sea: a lagoon of bare bed tens
  of metres across, with water on every side, sitting where you could swim.
  Nothing in the shoreline model can fix it, because the sea floor is not in the
  wave's equation at all.

  Limiting it is also the right shape rather than a patch. A deep-water wave is
  near sinusoidal; as it shoals the bottom crowds the trough while the crest is
  free to peak — cnoidal asymmetry, sharp crests over long flat troughs.
  `room·(e^(d/room) − 1)` is that curve exactly: its slope at zero is 1, so small
  excursions and therefore deep water pass through untouched, and it is
  asymptotic to −`room` however far the wave tries to go, with `room` set to a
  fraction of the still depth. Crests are left alone, and the whole term is
  blended out past nine metres of water where it has nothing left to do.
- **Swash — the thing that stops the shore being a drawn line.** A broken wave
  does not stop at the still waterline; it runs up the sand as a thin sheet and
  drains back. Collapse the surface to a flat plane there and the water's edge
  is frozen on the terrain's `h = 0` contour — perfectly steady, perfectly
  smooth, and no amount of foam painted along it will hide that. So the FFT
  collapses over the last couple of metres and the sheet that runs up past it is
  added on top, in metres of water level, from the **shared shoreline model**
  (`world/shore.js`) rather than guessed at here. That is the whole point of it
  living elsewhere: the *sand* evaluates the same function, so the wet tongue is
  left by the sheet that was actually there instead of by a lookalike running on
  its own phase. See the world README for the model itself.

  The model also hands back a small signed **depth offset** — its
  last-centimetre fraying — and the alpha test and the shore foam both subtract
  it before deciding water-or-not. Without it the sheet still has a smooth front,
  because everything here keys on still-water depth and a smooth beach face has
  a smooth depth contour. The sand subtracts the identical number, so the wet
  strip breaks into the same rivulets the water does.
- **Moonlight on water is a lobe, not a reflection.** Everything else the sky
  puts on this surface arrives through the mirror reflection, and for the sun
  that is enough. For the moon it is not: a moon is about a degree across, so a
  mirror hands it back only where a wave facet happens to point within half a
  degree of right, and what comes back is a scatter of hard specks. The column
  you actually see is made by roughness this mesh does not have — capillary
  ripples a centimetre across, spreading one small source over a broad sheet of
  light. So the moon gets an explicit two-lobe highlight (tight for the sparkle,
  wide for the sheet running out to the horizon), tinted with the sky's own
  `moon.tint` so the water and the disc agree, and premultiplied on the CPU by
  how high and how full the moon is and how much daylight is left — one uniform,
  one multiply, and the day/night logic stays next to `bodyLight` rather than
  being re-derived in the shader.
- **A soft edge, which needs transparency.** Rendered opaque, the sea ends on
  its mesh's intersection with the terrain, and that is a knife cut: bright
  silver one side, dry sand the other. The surface fades out over the first
  ~18 cm of water column — the fade has to cover that much, because a runnel wall
  takes the column from nothing to a hand's depth over one polygon — and both
  sides of the seam become the same pixels. Foam brings the opacity back, since
  an aerated sheet a centimetre deep is white and you cannot see through it.
  Depth writes stay **on**: alpha is 1 over all but the last centimetres, so the
  sea still occludes itself, and the only fragments that blend are the ones with
  nothing behind them but beach.

  **All of which needs a signed water column, and for a long time there was only
  a clamped one.** Every optical term integrates along the column, so `depth` is
  `max(surface − bed, 0)` and has to be. Feed that same number to the code that
  decides *where the sea stops* and "the surface is thirty centimetres under the
  sand" becomes indistinguishable from "the surface is exactly at the sand" —
  both are zero — so the entire dry beach asked for full leading-edge foam and
  alpha 1. The terrain mesh is 2.6 m quads while the water reads the bake per
  fragment, so along the whole coast the sea pokes a few centimetres through the
  sand's coarse triangles; every one of those slivers painted itself white and
  stayed put. That was the permanent ribbon hugging the beach that never drained
  back with the wave — not a swash at all, but two meshes disagreeing, dressed as
  foam. The fix is to keep both numbers: the clamped one for the optics, the
  signed one for the edge. Two more half-space terms had to become bands for the
  same reason — the shoreline model's leading-edge foam (`clamp(1 − dh/0.1)`
  saturates at 1 for *every* negative column and never comes back down) and its
  surface-tension lip, which was adding a flat 8.5 cm of lift to every part of
  the sheet lying under the sand, which is precisely what shoved the water up
  through the terrain in the first place.

## Water shading

Displaced in the vertex stage, shaded manually. The list, in the order it
matters:

- **Depth.** The composed world binds its terrain heightfield here, so every
  water pixel knows how deep it is. Beer–Lambert extinction down the column and
  back to the eye — `absorb = [0.42, 0.085, 0.033] /m`, red gone in a couple of
  metres, blue running for tens — is the one line that makes shallows turquoise
  and depth navy. The path length carries the view slant, which is why water
  read at a grazing angle is darker and bluer than the same water read from
  above. The whole seabed path is gated on one `bedMix` uniform, because the
  bake describes an island that a layer toggle can remove: read it anyway with
  the land hidden and the ocean paints the island's outline onto open water as a
  shallow, surf-ringed patch.
- **The seabed through the surface**, offset by the wave normal so the bottom
  wobbles, and lit like the beach it continues so the waterline has no seam.
- **Caustics for free**: the wave field's own horizontal compression is exactly
  where the refracted sun converges, and the derivative maps already carry it
  (`d.z`, `d.w` are ∂Dx/∂x and ∂Dz/∂z). No second pass, no projector.
- **Distance normal flattening**, applied **per band**. The
  argument is right — the honest average of sub-pixel chop *is* flat, and
  without some form of this the far field is a boiling mess of aliased
  highlights — but it is an argument about the *wave*, not about the range.
  Rolling the whole normal flat by distance takes the 300 m swell out along with
  the ripples and turns everything past a few hundred metres into a sheet, which
  is the other half of why an ocean reads as one uniform texture. Each cascade
  fades out where *its own* longest wave (`lengthScales[c]/6`) stops covering a
  pixel, so the ripples go first, the chop next, and the swell survives to the
  horizon; a much gentler global roll mops up what is left.
- **Crest scatter** driven by the *refracted* view ray (Snell at 1/1.33), so
  the green glow only fires where the sun really is behind the water in front
  of you, plus a height-gated term so crests glow and troughs stay dark.
- **Surf from the breaking criterion** — a wave breaks when its height is a
  good fraction of the depth under it. That one ratio puts the foam line
  exactly where the bottom shoals, following every cove and headland without
  anyone drawing it, with a lace of spent foam drifting behind on the same
  criterion at a lower threshold. Never on depth alone: foam is what a wave
  *left behind*, so keyed to depth it becomes a collar of constant width
  hugging the entire coast whether anything is breaking there or not. What
  makes the surf line ragged and alive is the bottom it is breaking over —
  see the bars and bays in [world/README](../world/README.md).
- Schlick fresnel over a full sky reflection (the sky's own sun disc supplies
  the glitter path), foam shaded near-Lambertian with noise-modulated
  *brightness* (never coverage), and **aerial perspective** from the atmosphere
  module rather than a fog colour. The rim hands over to the atmosphere's
  `distantSea()` — the same term the background uses below the horizon, so the
  handover is invisible wherever the patch happens to end. It uses a *square*
  norm: the patch is a square, and a radial fade leaves the four corners
  unblended.

## Per-frame GPU work

| stage | submits |
|---|---|
| spectrum evolve → time t (all cascades) | 1 |
| butterfly steps (2·log₂ 256, all slices per step) | 16 |
| map assembly + permute + foam (3 nodes, one pass) | 1 |

18 submits total. The centred-spectrum `(−1)^(x+y)` permute is folded into map
assembly rather than spent on its own pass. Naive per-(cascade, field)
dispatching would cost 3 × 4 × 16 ≈ 200 submits.

## Correctness gate

`fft.js` validates the exact runtime step nodes before anything renders:
impulse at centred DC → constant (1, 0), and impulse one texel off-DC →
`(cos 2πx/N, sin 2πx/N)`, asserted to max error < 1e-3 (measured ~3e-8).
Failure blocks start-up with an overlay. NaN probes over the FFT field and
turbulence buffers stay clean across the full debug-panel range (wind 0.1–40
m/s, fetch 1–1000 km, depth 5–2000 m).

## Parameters that matter

- `sim.lengthScales` — the cascade patch sizes. The first one is the sea's
  period: too small and no wave groups form and the field visibly repeats. Any
  change has to keep `lengthScales[i+1]/6 > 2·lengthScales[i]/size`.
- `waves.local` / `waves.swell` — wind speed, fetch and direction shape the
  JONSWAP peak; `spreadBlend`/`swell` steer directional focus. All re-bake h₀.
  Note that a properly-resolved spectrum is *bigger* than an under-resolved one
  at the same wind speed — the discrete sum finally covers the peak — so wind
  speeds tuned against a short patch will read as a gale on a long one.
- `lambda` — choppiness; also sharpens the Jacobian, so more foam.
- `foam.threshold/scale/decay` — where whitecaps start, how hard, how long.
- `shading.detail` — sub-grid normal noise; the difference between "grid
  between crests" and water.
- `shading.absorb` — per-channel extinction of the water body. Raise the red
  term for coastal/turbid water, lower all three for gin-clear tropics.

## Measured cost (Apple M-series, 1280×760 @ dpr 1.5)

GPU compute 0.9 ms + GPU render 6 ms, ~120 fps (display-limited).
CPU < 0.7 ms/frame.
