# World — Ocean · Island · Sky

A WebGPU nature world: an FFT ocean, an eroded volcanic island you can walk,
swim and enter a house on, a full day-night atmosphere, a million-blade grass
field, palms, an ash wood, flowers, gulls and two playable characters. All
rendering is Three.js `WebGPURenderer` + TSL node shaders; there is no game
engine and no framework beyond a thin React mount that injects each page's
static layout.

**Language:** the site's language follows the user's query language. The
on-page text is English; if the user writes in another language, offer to
translate the visible copy (titles, hub cards, control hints) accordingly.

## Before you serve or change anything — ask the user

Use the `ask_user` tool first. Ask at most these:

1. **(Required) Full-stack?** "Do you need this site to become a full-stack
   application — i.e. a backend with persistent data storage (a database), so
   things like user accounts, saved settings, high scores or user-created
   content survive across sessions? The site is currently 100% static:
   nothing is saved between visits."
2. **Purpose.** "Do you just want to explore the world as it is, or should it
   be adapted — rebranded (titles, hub copy, names), repurposed (portfolio
   backdrop, game demo, relaxation page, teaching reference), or used as the
   base for something new?"
3. **Content.** "Keep everything (ocean + island + sky scenes, the house you
   can enter, the two characters, flowers, gulls), or strip it down — e.g.
   pure landscape with no house or characters, or one single scene instead of
   all four?"
4. **Look.** "Keep the full automatic day-night cycle, or pin one signature
   mood — golden hour, midday, or an aurora night? Any colour/biome
   preference (most of it lives in the sealed `config.js` objects)?"

If the user gives no answers, load the default site files exactly as they
are. If the user only wants to see the site, load it directly and change
nothing.

## Running it

- Dev: `npm run dev` (Vite) from the repo root, then open the served
  `index.html` (the composed world) or `hub.html` (scene picker).
- Static: `dist/` is a prebuilt bundle of the same five pages — serve that
  directory with any static file server.
- Requires a WebGPU browser (Chrome/Edge 113+, Safari 18+).

Controls on the world page: WASD walk · shift run · space jump · F opens a
door · X cheer · V cycles third person / first person / free flight · mouse
looks, click captures the pointer, esc releases it · layer toggles and the
time-of-day slider live in the settings panel.

## File map (repo-relative)

```
index.html            the composed world (root page)
hub.html              scene picker
src/                  React mount layer: mount.jsx + one entry per page
                      (world.jsx, hub.jsx, ocean.jsx, grass.jsx, sky.jsx)
world/                the composition — owns what only exists because scenes combine
  main.js             boot ladder, layer toggles, light bridging, player/swim controller
  config.js           world config (actors, trees, grove, flowers, homestead, grass overrides)
  island.js           terrain bake: macro synthesis, coastal deposition, fields, beach shading
  erosion.js          GPU pipe-model hydraulic erosion (TSL over storage buffers)
  shore.js            the shared swash/waterline model (sea and sand both read it)
  sand.js             the beach's own Perlin detail tile + beachSurface()
  water.js            calm mirror sea used when the FFT layer is off
  trees.js            palms, merged into one static draw
  grove.js            ash wood (instanced buckets) + 129k drifting leaves
  flowers.js          flower patches (species table, petal atlas, instancing)
  birds.js            ~50 gulls, one draw, vertex-stage flight
  viewpoint.js        third person / first person / free flight camera
  indoors.js          derived collision, floors and doors for the house
  villa.js            house adapter: siting, scale, the house's own light rig
  villa/              the house model itself: house.js, roof.js, furniture.js,
                      materials.js, textures.js, lib.js
  actor/              playable characters: dna.js, geometry.js, body.js, rig.js,
                      clips.js, face.js, materials.js, character.js, rng.js
  ash/                tree growth: tree-system.js, preset.js (the species table)
ocean/                spectral FFT water: sim.js, fft.js, spectrum.js,
                      surface.js, breaker-foam.js, config.js, main.js, index.html
grass/                1M GPU-driven blades: blades.js, material.js, terrain.js,
                      wind.js, sky.js, config.js, main.js, index.html
sky/                  day-night atmosphere: atmosphere.js, aurora.js, config.js,
                      main.js, index.html
vendor/               three.js r185 WebGPU build, three.tsl, OrbitControls, lil-gui
assets/               texture slots (see Known gaps)
dist/                 prebuilt static bundle of the five pages
README.md             repo overview; each scene dir has its own README.md with
                      the algorithm, the parameters that matter and measured costs
```

Optional: You can use image and video generation tools if it suits user's query.

## What this can become

- **Just viewed** — serve and hand over; nothing to do.
- **Rebranded / re-themed** — page titles and hub cards are plain HTML in
  `index.html` / `hub.html` / each scene's `index.html`; character names and
  seeds are in `world/config.js`; palettes live in the sealed configs.
- **A relaxation / terrarium page** — pin the hour in the sky config, hide
  the lil-gui panel, let the camera drift.
- **A hero background or menu scene** — embed one scene folder; each is
  self-contained except `world/`, which composes the other three.
- **A graphics reference** — each scene README already documents one real GPU
  technique end to end.
- **A game demo or interactive product** — characters, swimming, doors and
  viewpoints are in; quests, inventories, scores or accounts are exactly the
  point where the full-stack question above becomes relevant.

If a need implies persistent storage (saves, accounts, shared state,
leaderboards), treat it as a full-stack build; otherwise stay static.

## Technical field guide (3D & shaders)

Everything is TSL node graphs on Three.js `WebGPURenderer` — no raw
WGSL/GLSL, and the CPU only orchestrates submits; simulation state lives on
the GPU. The practices worth stealing:

- **Bake expensive truth into LUTs.** The atmosphere ray-marches Rayleigh +
  Mie single scattering with earth-shadow-tested secondary rays (that is what
  makes twilight real) and bakes it into a 512×160 direction LUT, re-run only
  when the sun moves. Background, water reflections and aerial perspective all
  read the same LUT, so they can never disagree. The aurora marches once per
  frame into the same LUT instead of owning a full-screen pass.
- **One sun, every material.** Sun-path transmittance is integrated on the
  CPU each frame and *is* the sun disc, the terrain light, the palm light and
  the grass rig's radiance — there is no sunset ramp anywhere to drift out of
  sync. Ambient is a three-tap sky hemisphere, not one zenith fetch.
- **One medium function.** `atmosphere.aerial()` is the only fog/aquatic
  extinction in the project; going underwater just changes its coefficients
  and adds the Snell window in `background()`. Never introduce a second fog
  colour.
- **Ocean as real spectral water.** Three cascades (1 km / 80 m / 7 m) of
  inverse FFT — Stockham radix-2, 16 butterfly submits total because all 12
  (cascade, field) slices ride in one buffer; 8 real fields packed as 4
  complex signals. JONSWAP·TMA wind sea + a 280 m distant-storm swell with
  Donelan-Banner spreading. Foam is the displacement Jacobian with a
  persistent per-texel turbulence value, and the surf zone gets a memory: a
  world-fixed 640² field stepped at 30 Hz that decays over ~6 s and advects up
  the bed gradient (ping-pong by buffer offset, bilinear advection). Waves
  shoal by Green's law, crests pitch shoreward, and troughs are limited by a
  cnoidal curve so the FFT never digs through the seabed.
- **GPU-driven grass.** 1024²–1600² blades, two compute dispatches, three
  LOD meshes fed by one indirect buffer; the `firstInstance = lod·COUNT`
  trick recovers LOD as `instanceIndex / COUNT` with one shared material.
  State is bit-packed (bend 12+12 bits, scale/cache/visibility 8+8+1+1).
  Terrain cache refreshes *before* the visibility early-out — the other
  order dead-locks into permanently bald ground. Thinning is stochastic with
  hysteresis, the tile boundary is radial, and the tile rescales in
  half-octave steps with camera altitude (reach is bought with spacing).
- **Terrain with a history.** CPU macro synthesis (domain-warped ellipse +
  lobe octaves + anisotropic ridged massifs), then 130 iterations of GPU
  pipe-model hydraulic erosion — the stage that makes it read as terrain, not
  noise. Coastal deposition **fills, never cuts**; one wrapping flood fill
  keeps a single island and drowns the rest to a shading-decided depth.
- **The waterline is one model, two consumers.** Sea and sand both evaluate
  `world/shore.js`, keyed on *still-water depth* (bands follow bathymetry for
  free). Phase skew steepens the bore's front; the run-up envelope hands the
  sand "where the water was" with no tuned delay; tongues and metre-scale
  fraying keep the edge from ever being a curve. Both sides test the *signed*
  water column — a clamped one paints the whole dry beach as foam.
- **Instancing trap.** A custom `positionNode` on an `InstancedMesh`
  discards the instance transform unless it starts from `positionLocal`
  (three applies instancing there, then lets `positionNode` overwrite) — that
  is why palms and gulls are merged single draws while the ash wood instancing
  works. Per-variant geometries share `BufferAttribute` objects by reference,
  so a bucket costs only its instance buffer.
- **Nature is tables, not tweaks.** The ash is a species contract (level
  table, continuation branch, stratified children, parent→child slerp);
  flowers are an eight-species table with analytic petal normals
  (`∂P/∂along × ∂P/∂across`); characters are one integer seed into a
  superellipsoid-skull + SVG-face-atlas + 18-bone-clip generator.
- **Measure, don't eyeball.** The FFT validates itself against analytic
  impulses before first pixel; grass density is tuned by async indirect-buffer
  readback (48k visible of 1.6M is invisible until counted); the boot is a
  staged ladder with `[boot]` timings and a cost-weighted progress bar whose
  sweep animates `transform` only. Every scene README records frame costs.

## Known gaps

`assets/flowers/petals.png` and `assets/ash/leaf.png` are referenced by
`world/flowers.js` and `world/grove.js` but are not present in the repo, so
flower petals and ash foliage currently have no texture. Do not patch the
code or fabricate replacements on your own; if the user cares, ask first.
