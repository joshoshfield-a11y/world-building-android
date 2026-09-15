# Grass — one million GPU-driven blades

Real-time field of 1,048,576 generated blades (no model, no textures on the
blade) with GPU-driven indirect rendering. Three.js `WebGPURenderer` + TSL
only; the CPU never learns how many blades survived culling — instance counts
go straight from the update kernel into `drawIndexedIndirect`.

The look, the wind model and the lighting rig rest on four ideas: spatial
noise patches for height and colour, per-vertex blade curl, a coverage/lull
gust field with rare wind events, and a warm sun + hemisphere recipe rendered
through ACES at exposure 2.0.

Static ES modules, no build step: serve the parent folder and open
`grass/index.html` (needs WebGPU). WASD move · shift sprint · space jump ·
drag to orbit.

## Spacing is the number that matters

`tileSize / bladesPerSide` is the blade spacing, and it is the only figure that
decides whether a field reads as grass or as a moth-eaten rug. This scene is
130 m over 1024 — **12.7 cm**. Both halves are overridable, and the trap is
raising `tileSize` alone: spread the same
1024 blades over 288 m and 28 cm spacing is what leaves hillsides bald. If
the tile grows, the blade count has to grow with it.

Blade **length** is the other half of it, and the trap there is reading
`blade.minScale`/`maxScale` as a height. They are a length in units of
`BLADE_HEIGHT`, and `wind.baseBending` then lays a long blade over into an
arch, so a 2 m blade stands about a metre tall. The range 0.85–2.35 —
one and a half to four metres of blade — is what a soft, dense field looks
like. Cutting that range because the field
"came out as bamboo" is cutting the overlap between neighbouring blades, and
the overlap *is* the density: shortening the blades to a third made the same
1024² field read as stubble with bare ground showing through it. If the field
looks too tall, the fix is the range's ceiling, not its whole scale.

`MIN_VISIBLE_SCALE` and the projected-size window (`thinning.projMin/projFull`)
are in the same units and have to move with the length, or the far half of the
tile culls itself the moment the blades get shorter.

**Count the survivors, do not eyeball them.** `renderer.getArrayBufferAsync`
on the indirect buffer gives the exact instance count per LOD, and it is the
only honest measure of "dense enough" — a wide tile can be rendering
48k blades out of 1.6M with nothing obviously wrong on screen, and every guess
about why is wrong until the number is on the table. Frustum culling accounts for most of any such gap and
should. What should be checked after it is `thinning.farDensity`, which takes
the field to a fraction of full density by `falloffRadius`: the default 0.1 at
75 m is tuned for this scene's 130 m tile, and on a wider tile it lands in the
middle distance a meadow is actually judged on. Far blades are LOD2, three
triangles each, so keeping them is nearly free.

## Architecture

- **1024 × 1024 blades over a 130 m tile** (`config.terrain.tileSize` and
  `config.terrain.bladesPerSide`, both overridable so a composed scene can pick
  its own budget and area — see the note on spacing below) that re-centres on
  the anchor every frame; blade offsets wrap inside the compute pass by the
  accumulated anchor delta, so the world is arbitrarily large for free. The
  wrap is a **floored** wrap built on `fract()`, not `mod()` — WGSL `%`
  truncates toward zero, so a mod-wrap silently fails on the negative edge
  and leaks blades out of the tile whenever the anchor moves that way.
- **3 LOD tiers** (8 / 4 / 2 segments) → **3 draw calls, 2 compute
  dispatches** per frame, total. One `IndirectStorageBufferAttribute` holds
  all three `[indexCount, instanceCount, firstIndex, baseVertex,
  firstInstance]` records; each mesh differs only by
  `setIndirect( attr, lod · 5 · 4 )`.
- **The firstInstance trick:** `firstInstance[lod] = lod · COUNT`, so the one
  shared material recovers its LOD as `instanceIndex / COUNT` — no extra
  binding, no per-LOD material. Gated on the `indirect-first-instance`
  feature; without it the field collapses to a single 4-segment draw instead
  of failing.
- **Bit-packed state** (bandwidth is the bottleneck at a million instances):
  `bladeState.z` carries bendX|bendZ at 12 bits each (±6), `.w` carries
  scale|originalScale|cacheValid|visible (8|8|1|1); `bladeTerrain` packs
  positionNoise|offsetY|bakedShadow (4|16|4) into one float via bitcast.

## The per-blade update (dispatch 2), in order

1. **Wrap** around the anchor; a wrap further than half a tile is a teleport →
   terrain cache invalidated.
2. **Terrain cache** — heightmap/density/shadow/noise are re-sampled the
   moment the cache bit is invalid (i.e. the blade wrapped to a new world
   position), and *before* any visibility early-out. In steady state almost
   no blade touches a texture; this is the single largest performance win.
   The ordering is load-bearing: refreshing only *visible* blades dead-locks
   — a stale zero density crushes the scale, zero scale fails the
   projected-size keep, and the invisible blade never reaches the refresh
   again, leaving permanently bald ground wherever the tile once crossed a
   zero-density zone.
3. **Frustum cull** against a clip-space bounding sphere with separate padding
   for x, the screen bottom (tall roots below the frame still show tips) and
   the top.
4. **Stochastic thinning** by distance *and projected screen height* — the
   screen-height term is what removes sub-pixel blades (distant shimmer)
   while keeping tall grass on hillsides, computed from the blade's
   *potential* scale (orig × density) and floored inside 30–60 m (seen from
   above, a vertical blade subtends ~zero height — without the floor an
   elevated camera strips the ground beneath it). **Hysteresis** (enter/stay
   thresholds around a per-blade hash) stops the field boiling as the camera
   moves. Density also tapers to zero at the tile boundary so the wrap edge
   never draws a hard line.
5. **Density mask** folds the terrain's grass-density channel into the base
   scale; below 0.15 the blade drops out (bare patches).
6. **Trampling** — contact eases the scale toward `crushedScale`, recovery
   climbs back at `growthRate`, and the deficit bends the blade radially away
   from the player; walking carves a trail that heals over ~10 s.
7. **Wind** — a gust texture is advected along
   `perp·0.37 − windDir`; coverage/lull shaping (`smoothstep` over the noise
   with a floor between gusts) makes wind arrive as travelling fronts instead
   of uniform waving, and rare **wind events** swap in a faster-scrolling
   field at 4× strength. Blade response runs through a cubic **Bézier over
   scale** — tall blades bend disproportionately more. Inside 30 m this
   drives a **critically damped per-blade target** (`rate = mix(3.5, 11,
   noise) · mix(0.3, 1, gust)`) — the lag is what makes it read as grass, not
   a sine field — plus sway and perpendicular flutter. Beyond the band, a
   pure analytic sine with no buffer read; the two blend over a 5 m
   `smoothstep` band so no ring follows the camera.
8. **LOD select branchlessly**, then **append**:
   `slot = lod·COUNT + atomicAdd(instanceCount[lod], 1)`.

One global wind director (idle → direction → ramp → hold → decay state
machine) publishes exactly two uniforms that every wind consumer shares.

A composed scene can pass `sky.shadowTex` / `sky.terrainScale` to the material;
the blade then multiplies its *sun* terms (diffuse, sheen, transmission — never
the hemisphere) by that terrain cast-shadow map. When a ridge shadow sweeps the
meadow at golden hour the blades have to go out with the ground under them, or
the field floats.

## Blade geometry & shading

Generated strip: `segments·2 + 1` vertices with a single apex, width profile
`halfBase · min(1, 0.28 + 0.72·(t/0.26)) · (1−t)^1.22` (fast flare, long
taper). Cylindrically billboarded to the camera. Distant blades widen
(`widthGain`) so they cannot alias away. A **per-vertex roll** — random
sprite rotation plus a height²-weighted curl seeded per blade — bows every
blade differently instead of leaving the field standing at attention. Bend
follows a Bézier-style response over height (roots planted, tips travel) and
the tip pulls *down* as it leans so bending never stretches the blade.

Height and colour vary in **spatial patches**, not per blade: a one-time GPU
init pass samples terrain-scale noise, so tall golden stands and short dark
hollows form over metres (per-blade hashes only ever produce salt-and-pepper).
Scale runs 0.85–2.35 with the patch noise squared toward tall outliers.

Shading is a warm rig, fully analytic: sun `sRGB(1.0, 0.79, 0.58)` ×
0.62 with softened two-sided diffuse, a warm-sky/dry-ground hemisphere with a
root-to-tip sky-visibility ramp, grazing sheen and backlight transmission
gated by view/sun alignment, baked terrain shadow, rim×root AO scaled by
player proximity (contact darkening only where you can see it), patch colour
with rust and warm washes plus a tip ramp, and exponential-squared fog toward
a warm haze — all through ACES film tone mapping at exposure 2.0 (the numbers
only work as a set; at exposure 1 the same rig reads as mud). A LOD debug
mode tints by tier. Indices are Uint16 — WebGPU has no 8-bit index format.

There is a second key, `moonRadiance`, black unless a composing scene drives it
(`sky.moonDir` supplies the direction). It exists because a night meadow lit by
the hemisphere alone is a flat black mass — grass at 5% albedo has nothing else
to fall back on — and it deliberately takes no sheen and no transmission, which
are the sun's and at that level would be inventing light that is not there. The
standalone field never sets it and is unchanged.

## Measured cost (Apple M-series, 1280×760 @ dpr 1.5)

GPU compute 0.3–0.6 ms + GPU render 3–7 ms at ~120 fps (display-limited);
CPU ≈ 0.15 ms. Typically 120k–360k blades / 0.7–1.8 M triangles survive
culling, reported per-LOD by the async indirect-buffer readback in the HUD.
