# World — ocean + landmass + wood + house + day-night sky, composed

The main scene (served as the site's root `index.html`): the standalone scenes
running together in one WebGPU frame. The sky is always on; the FFT ocean, the
landmass (meadows + beaches + palms + ridge + the figure you play), the gulls
and the interior (broadleaf wood + drifting leaves + the house) are layers you
can combine or view alone. Each subsystem keeps its own config and modules
— this folder owns only what exists *because* they are combined.

The opening shot is authored by scanning the bake for a grass bank near the
sand with open water toward the sunset: surf on the left, the beach sweeping
away in a diagonal, the palm grove climbing the bank on the right, open water
to the horizon.

**Controls.** WASD walks, shift runs, space jumps, X cheers, **F opens the door
you are standing at** — the house is solid, and the way in is through it. `V`
cycles the three viewpoints — third person, first person, free flight — and the
panel's `player` folder has the same switch plus the choice of which of the two
figures you are. The mouse turns the view in every mode with no button held;
the wheel sets the third-person distance, and in the two free modes a click
captures the pointer so the turn does not stop at the edge of the window.

## Composition

- **Sky** — `sky/atmosphere.js`: a ray-marched Rayleigh/Mie scattering
  integral baked to a LUT each time the sun moves, earth-shadow tested for
  real twilight, plus a Beer/powder-lit cloud layer, a sun disc whose
  radiance is the sun-path transmittance, a geometric moon, four lattices of
  magnitude-sorted stars and the Milky Way in its own galactic frame.
  See [sky/README](../sky/README.md).
- **Land** ([island.js](./island.js)) — three stages.

  **1 · macro synthesis (CPU).** A ~1.5 km landmass in a 2.2 km heightmap:
  an elliptical base mask warped by
  three scales of noise plus four octaves of lobes, so the coast is fractal —
  headlands, coves, peninsulas — never a circle. Inland: fbm hills with
  compressed lows so dales stay shallow, and
  **two massifs** of anisotropic ridged noise `(1-|n|)²` rising past 300 m. A
  volcanic island is not a hill; 1:2 flanks over a few hundred metres is what
  separates an island from a sandbar with a lawn on it.

  **2 · erosion (GPU, [erosion.js](./erosion.js)).** Pipe-model hydraulic
  erosion + thermal talus, written as plain
  TSL over storage buffers: 130 iterations × 5 dispatches at 1024², then read
  back for the CPU fields. This is the stage that makes it read as *terrain*
  rather than as noise — channels cut headward, tributaries join at real
  junctions, spurs sharpen between them and debris lands as fans where the
  gradient eases. None of that can be authored per texel. Bedrock hardness
  varies with height and noise, so the massif keeps its crest while the
  plains gully.

  **2b · coastal deposition (CPU).** The pipe model moves sediment downhill;
  it has no longshore drift, so it cannot build a beach — left alone it
  gullies the shore like any other slope and every coast comes out the same
  profile, which is what makes the surf a white ribbon of constant width all
  the way round and leaves nowhere a beach you could actually walk on. So the
  depositional coast is laid on after erosion. Wave refraction focuses energy
  on headlands and spreads it in the coves between them, so **the coves are
  where the sand goes**: there the shelf ramps gently (waves feel the bottom
  far out, so the surf zone is wide), a **longshore bar** sits offshore with
  rip channels cut through it — waves break over the bar, re-form in the
  trough and break again at the beach — and the first tens of metres of land
  are pulled down onto a ~1:55 sand ramp. Headlands keep deep water and bare
  rock. The low lobe octaves are what carve the coves in the first place, so
  reading the same field back to decide where sand lands is causal rather than
  decorative. One rule keeps it honest: deposition **fills, never cuts** — it
  can raise nothing and plane no hillside, and the pull fades out as the land
  rises away from the profile, bounded by height rather than by distance,
  because the coast field's gradient varies twenty-fold around the island.

  **2c · one island (CPU).** The lobe noise that keeps the coast fractal at
  every scale also pinches the odd fragment off it, and an isolated rock a
  hundred metres offshore reads as a mistake rather than as scenery. So the
  land is labelled with a wrapping flood fill — the island is centred on the uv
  wrap corner, and a non-wrapping fill splits it into four quadrants and then
  keeps one — the largest body kept and the rest drowned. What a drowned cell
  becomes matters as much as which cells drown, and **the bank has to go down
  with the rock standing on it**: a fragment is a local *high* of the coast
  field, so anything keyed back to that field rebuilds the same mound a metre
  lower, and a bank a hand's depth under the surface is a turquoise shoal with
  surf breaking over it — the same object, minus the sand on top. The cut goes
  to 18 m, a depth set by the shading rather than by geology (the seabed tint
  saturates at 8.4 m and the water column is not opaque until the mid teens, so
  a bank left between the two is a black slab lying on the water), and fades
  out over 118 m under a `min`, so it only ever digs. The fade has to be wider
  than the bank or the cut hollows the middle and leaves the crown standing as
  a ring: these banks run 60–90 m across, and a 40 m fade drew two crop circles
  offshore. It needs no separate rule to stay off the coast — the target ramps
  back to zero faster than the shelf shallows, so by the time the cut reaches
  the beach it is asking for deeper water than is there, and the `min` keeps
  the beach.

  **3 · fields + scatter (CPU).** Grass density, shore distance, palms — all
  read off the *eroded* height, so vegetation follows the drainage it grew
  in. The sea is one plane at y = 0, so a flood fill from the map border
  finds hollows the sea cannot reach and fills them; otherwise erosion's
  endorheic pits render as perfectly round ponds of ocean sitting in a
  meadow. Compressing the hollow is not enough on its own — a 3 m pit still
  comes out under y = 0 and the pond is back — so the fill also clamps above
  the waterline.

  The bake ships four textures: an RGBA map (grass-compatible clamped
  height, grass density, occlusion, shading noise), an RG16F heightfield
  (signed height in metres + signed shore distance from a chamfer distance
  transform, run on an fftshifted copy because the land is centred on the uv
  wrap corner), and an RGBA fields map (flow strength, sediment, concavity,
  slope). Mesh vertices, grass blades and the CPU player controller all read
  the same bake; the player wades until the water is waist-deep (h < −0.55 m),
  whatever shape the coastline takes.

  **The orbit camera reads it too.** A polar-angle floor
  — a *global* "never below y = 3" — is
  the right rule for the sea and useless everywhere else: orbit round a player
  standing at the foot of the grass bank and the camera swings into the
  hillside at three metres of altitude with twelve metres of dirt over it. A
  heightfield is drawn one-sided, so from inside you get the sky through the
  ground, the grass rooted above you hanging in it, and the sea's underside
  filling the bottom of the frame. Clamping the camera's height to the terrain
  under it is the whole fix, and it is worth being clear why *that* and not the
  other standard answer: against a heightfield "above h(x, z)" **is** "outside
  the solid", and h does not depend on where the camera ends up, so the
  correction is a continuous function of the camera's ground position and cannot
  oscillate. Pulling the orbit in along the view ray instead shortens the
  radius, which moves the ray, which may then miss — and a camera that pops in
  and out on alternate frames is worse than one that clips. It runs *before*
  `controls.update()`, because OrbitControls re-derives its spherical from the
  actual camera position each update, so correcting first lets it re-aim from
  the corrected spot in the same frame.
- **Ground cover** — six classes blended continuously in the terrain's
  `colorNode`: meadow, scrub, bare soil, scree, gravel, bedrock. Naive
  thresholds over-fire every one of them, and the symptom is the interior
  reading as somewhere nobody had finished.

  `slope` here is a gradient magnitude, so 0.34 is 19° and 0.72 is 36°.
  Thresholds with bedrock from 19°, scree over everything between 12° and
  32°, and gravel wherever the flow field is high print pale grey discs across
  level meadow, because flow accumulates in
  *flat basins*. Each class has to earn its ground: rock is steep enough that soil will not
  stay on it (or above the tree line); scree needs the **concavity** gate as
  well as the slope, because talus only piles in the hollow at the foot of a
  face and without it the term paints whole flanks; gravel needs flow **and** a
  gradient, which is what makes it a channel rather than a puddle.

  And what sits under the blades where the blades give out is **scrub, not bare
  earth**. Blade density drops on anything over about 40°, and taking that
  straight to soil painted every hillside brown — from the air the interior
  read as badlands, which is not what a wet volcanic island looks like at 25°.
  Ground only goes bare where nothing could root: too steep to hold soil, above
  the tree line, or scoured by a wash.

  **"Too steep to hold soil" is easy to set too low.** A slope gate fading
  density out between 0.88 and 1.30 — gradient magnitudes, so everything past
  about 52° counts as a cliff — marks **28.4% of the
  land** on this island. The visible result is the seaside banks: the whole 6–8 m band above
  the beach comes out **51.5% bare**, a ring of dirt between the sand and the
  meadow exactly where an island is wettest and most sheltered. Real cliffs are
  the massif's flanks and the sea walls, not every bank you can walk up, so the
  gate is **1.60 to 2.50** — 58° to 68°, leaving **10.4%** of the land over
  it. Measured across the island, that takes bare ground from 33.7% to **11.5%**, and
  the shore band from 51.5% bare to **9.7%**, mean density 0.347 → 0.754. The
  number matters more than it looks: density below `MIN_VISIBLE_SCALE` culls the
  blade outright *and* drives the turf colour, so a slope gate is not a grass
  setting, it is where the island stops being green.

  **Canopy occlusion is dappled and lobed, not a disc.** A dome falloff gives the
  shade no rim to find, but a dome is still radially symmetric — its *outline* is
  a circle however soft the falloff is. So the stamp radius is modulated at two
  angular frequencies with a phase drawn from where the tree stands, and the
  whole thing is multiplied by a fine noise field: a crown seen from underneath
  is a scatter of gaps, not a shadow with a boundary.

  **Canopy occlusion accumulates with a cap.** Every palm and every broadleaf
  stamps shade into the bake's occlusion channel as it is scattered. Multiplying
  is the trap: seven overlapping crowns over one texel give
  `0.6⁷ ≈ 0.03`, which is a hole in the world.
  Adding into a bounded accumulator capped at
  0.42 and applying it once at the end gives shade that deepens under a stand
  and never goes black.

  **And a canopy writes nothing into the density channel.**
  Clearing density to zero
  under a trunk leaves a disc of bare soil; thinning it by 30% leaves a disc
  that is tan instead of bare, because the turf shading keys both its dryness and
  its brightness off density, so thin ground reads drier *and* lighter; capping
  the accumulation leaves the same disc one shade weaker. The answer is upstream
  of all that tuning: **grass density is not a private channel** — the terrain
  colour reads it too — so anything stamped into it in a circle comes out as a
  circle however gently it is stamped. A tree in a meadow does not need a mown
  ring around it, and the blades intersecting the bole are invisible from any
  distance the discs are visible from. The only shaped thing left in that
  channel is the house's plot, which is one place, is *meant* to read as
  cleared, and is a rectangle.
- **Cast shadows** — a compute pass marches every texel toward the sun over
  the heightfield (56 geometric steps, ~1.4 km reach) recording the steepest
  skyline it sees, and lights the texel when the sun stands above it. The test
  is an *angle*, not a height: a height bias has to grow with the step length,
  since far samples are coarse, so it is either metres of slack next to the
  texel or none of it far away, and near the terminator — where the two are
  comparable — neighbouring texels flip either side of it and the shadow edge
  breaks into speckle. A slope threshold is scale free: one bias, one soft
  window, both in radians of sun elevation. Written into a storage texture,
  re-run only when the sun has actually moved: a few times a second in the
  auto-cycle, never in a still frame. Terrain, palms and grass blades all
  read it, so a ridge shadow crossing the meadow at golden hour takes the
  blades with it.
- **Water** — the `ocean/` FFT surface when the layer is on; a calm mirror
  sea ([water.js](./water.js)) when it's off. The ocean binds this scene's
  heightfield, which gives it **shoaling** (waves grow and break where the
  bottom rises, so surf follows every cove and headland) plus the Beer–Lambert
  depth colour, seabed refraction and breaking-criterion surf described in
  [ocean/README](../ocean/README.md). One `bedMix` uniform carries the *land*
  layer into both stages of the water shader, because a heightfield is not the
  seabed when the island it describes has been switched off — bound
  unconditionally, hiding the land leaves its outline stamped on open water as a
  shallow, surf-ringed patch.
- **The waterline is shared, so both sides have to agree on it.**
  If the sea lifts its surface with one swash function
  keyed on shore distance and a scrolling noise tap while the sand darkens with
  a different one keyed on its own analytic phase — two independent animations
  of the same event — the dark wet tongue is never where the sheet that
  supposedly left it had been, and the residue foam sits on dry sand.

  [shore.js](./shore.js) is the one model both read.
  Its central idea is that **everything at the shore
  keys on the still-water depth**, not on distance from the waterline, and that
  one choice buys three things: the bands follow the bathymetry for free (they
  bend round every cove, headland and longshore bar, because those *are* depth
  contours, where a distance-keyed band can only be a ribbon of constant width);
  both shaders can compute it, since the sea knows the seabed under it and the
  sand knows its own elevation and those are the same number; and it dies out
  offshore on its own, so nothing has to decide where "the shore" stops. Two
  details matter as much as the keying — the **phase skew**
  `sin(p + cos(p)·(1 − mag))`, which bends the wave by its own amplitude so the
  front steepens into a face and the back drains as a long tail where a plain
  sine slides up and down like a lift; and **foam trailing the crest by 0.85π**,
  because foam is not *on* a wave, it is what the bore left after passing.

  **The edge of the water is not a curve, and getting it to stop being one took
  two terms at two scales.** Everything above keys on the still-water depth, so
  the waterline it produces is a *bathymetry contour* — and a smooth beach face
  has a smooth contour. A patchiness term fixed in world space does vary the
  run-up
  alongshore, but every wave then scallops the
  beach along exactly the same lines: the edge comes out as a clean arc with a
  permanent, unchanging wobble in it, which the eye reads as a drawn shape rather
  than as running water. What is missing:

  - **Tongues, 5–25 m, drifting.** A bore does not arrive parallel to the beach.
    Its front breaks into tongues that each run up to their own line and each
    arrive a moment before or after their neighbours — so the run-up field *and*
    the arrival phase are modulated alongshore, and the whole field drifts at
    half a metre a second. The drift is the part that matters: a tongue reaching
    furthest on this wave does not on the next, and the eye stops finding the
    pattern. The run-up modulation is raised to a power rather than used
    linearly, because a linear map gives evenly scalloped bays and a real swash
    edge is mostly slack with the occasional thin finger pushed well past it.
  - **Fraying, 0.5–3 m.** Even one tongue does not end on a curve: the film thins
    until surface tension breaks it into rivulets and lobes a metre or two
    across, and at ten paces that fraying *is* what a waterline looks like. It is
    handed back as a small signed **depth** offset, because both consumers
    already test a water column, and both subtract the identical number — so the
    sea's alpha and the sand's wet strip break along the same rivulets instead of
    each drawing its own outline a hand's width apart. It is deliberately kept
    out of the surface *elevation*: the ocean reads that in the vertex stage, and
    a metre-wavelength wiggle put into geometry is one the mesh stops resolving a
    few tens of metres out, where it becomes a shimmer running along the whole
    coast.

  One failure that looked like a shoreline bug was not one at all: bare lagoons
  of seabed appearing offshore in water metres deep. That is the FFT's own trough
  cutting through the bottom under the shoaling gain — see
  [ocean/README](../ocean/README.md). Worth recording because the shoreline model
  is the obvious suspect and cannot possibly be the cause: it never lowers water
  where there is still depth to lower it into.

  **And the front has to stay a front.** The arrival time is jittered alongshore
  so the bore does not land parallel to the beach — but at ±3 radians
  *every phase of the cycle is present
  somewhere on the beach at every instant*. Patches drain while their neighbours
  fill, the swash zone never clears anywhere at once, and what that renders as is
  not a wave: it is a permanent film of water lying on the sand that no backwash
  ever takes away. ±0.8 rad — an eighth of a cycle — is enough for the front to
  arrive crooked and little enough that it is still a front.

  The other half of the same complaint is that `sw` runs 0..1, so the sheet could
  only ever rise *above* mean water. Between waves a real beach face is exposed
  **below** it; without that the beach never bares, it only gets less wet. The
  level is biased down by 30% of its swing so the trough goes under the still
  line, and `RUNUP` carries the full trough-to-peak travel with `envelope` still
  reporting the true high-water mark, so the sand's damp band needed no
  adjusting.

  And none of it is visible if the consumer cannot tell *dry* from *at the
  waterline*. A water column clamped at zero — correct for the
  optics, which integrate along it — cannot decide where
  the water ends: every fragment lying under the sand reads as waterline and
  comes back as foam, a white ribbon pinned to the beach that no
  backwash can drain. It is the ocean mesh showing through the terrain's 2.6 m
  triangles, not water. The leading-edge and lip terms carry the same
  shape of trap — half-spaces that saturate below zero and never return. All
  three key on the *signed* column. See
  [ocean/README](../ocean/README.md).

  Two numbers are worth getting right. **Run-up is a horizontal quantity read
  as a vertical one**: this coast ramps at 1:42 in the coves and 1:18 on the
  steeper faces, so 0.42 m of water level is seventeen metres of travelling
  waterline in one place and eight in another — enough that the wet sand it leaves
  fills the whole frame and stops reading as a band at all. And **the wet
  bands live above the current sheet, not around it**: the sand a swash has just
  left is uphill of it, so a band centred on the waterline is a band you never
  see, because it is under water. Both check out fastest by rendering the term
  straight to the screen rather than reasoning from a slope figure that only
  holds in one cove.

  The wet sand is where the water **was**,
  not where it is. Sampling a delayed waterline and taking the
  max only works if the delay is a good fraction of the swash period;
  the model hands back its own **run-up envelope**, the peak of the level over a
  cycle. That is exact, costs nothing, and cannot drift. A beach then has the
  three tones it needs: the moving strip the sheet has just drained off, the
  damp zone standing above the highest the sheet ever reaches, and dry
  back-beach — plus a fourth for the sand around whatever a wave left standing
  in the runnels, since sand with a pool in it is soaked rather than damp.

  The wave trough bares a few metres of bed on every backwash. That bed is the
  *terrain* mesh, not the ocean's own seabed, so the terrain's submerged tint has
  to start below the shoaling zone: fade it to deep-water blue from the waterline
  instead and a dark wedge flickers along the whole coast every time a wave draws
  back. Bare bed is wet sand.
- **Beach** — shaded in the terrain's `colorNode`, with every phase driven by
  the baked *shore distance* instead of radius: shore-parallel sand ripples,
  per-grain noise and sparkle glints, a wet band, and foam drying on the sand
  between waves. The *running* sheet is the ocean surface itself — it surges up
  the beach and drains back (see the swash in [ocean/README](../ocean/README.md))
  — so the terrain paints only the residue, inside the swash's reach; painted
  wider it reads as blobs sitting on dry sand next to a waterline that does not
  move. It still carries the whole waterline when the FFT layer is off and the
  calm sea is standing in.

  The sand itself is four things, and getting any of them wrong is what makes a
  beach read as brown felt:

  - **A mineral mixture, and a bright one.** Quartz, shell and dark heavies,
    varying at grain and fifteen-metre scale. Dry quartz sand reflects a third
    of the light that hits it and sits near `srgb 0.9/0.8/0.6`;
    a "light warm grey" at `0.63/0.585/0.505` comes out felt at noon and
    mud at sunset. The grey belongs in the dark fraction, not in the quartz.
    Both minor fractions are easy to overdo: shell at one cell in five stops
    being shell and becomes salt scattered on the beach, and it needs its own
    short distance fade, because a 3 cm cell is sub-pixel by forty metres and
    what survives there is static, not sparkle.
  - **Oren–Nayar, not Lambert.** Sand is the textbook rough surface — a dense
    field of grains that shadow and inter-reflect each other — and Lambert has
    no retro-reflection, so the beach goes flat exactly where a real one lights
    up. The `tan β` term is unbounded when sun *and* eye graze, which is
    precisely the beach-at-sunset case, so it is capped; the model is
    normalised on its head-on response so it only ever adds what Lambert was
    missing rather than re-tuning the noon exposure.
  - **Ripples at both of the scales a beach has** — swash-built ridges metres
    apart, wind-combed ripples at a hand's width across them, the fine set on
    its own short fade since it is sub-pixel within tens of metres. The profile
    is `(1 − |sin|)^1.5` — a long stoss slope to a sharp crest —
    where a sine gives evenly rounded corrugations. Amplitude is the trap: a
    ripple field lights up hard at a grazing sun, and what looks reasonable at
    noon is a brain coral at golden hour.
  - **Sparkle, which no amount of diffuse tuning gives.** Every quartz grain is
    a mirror, and the few whose faces line up sun-to-eye return a hard point of
    light: a per-cell jittered normal under a very tight lobe. The cell is
    ~4 cm rather than grain-sized, because what the eye resolves at ten metres
    is a patch of aligned grains, and a sub-pixel cell would only alias.

  And one thing that outranks all four: **where the detail comes from.**
  `terrain.map`'s alpha channel, tapped at 11× / 37× /
  143×, looks like three levels of detail and is not. That channel is a
  *single* value-noise octave on a 29×29 lattice stored at 2.15 m texels, so
  tiling it does not manufacture detail — it repeats one field of smooth,
  axis-aligned, square lattice cells at 6.9 m, 2.05 m and 0.53 m, coming back
  round every 200 / 59 / 15 metres. Those 2 m and 0.5 m cells *are* the "looks
  like a voxel game" complaint, and above 0.5 m the map holds no energy at all
  — which is how a beach can be camouflage at a grazing sun and a flat cream
  card at noon: every scrap of its structure lives in a normal, and a normal
  shows nothing under a high sun. When a surface goes
  blotchy only at a grazing sun, suspect a normal — and when the blotches are
  square, suspect the noise it is made of. Bisect it by rendering the terms
  (`lit`, `sandF`, `ripple`, `micro`) straight to the screen rather than
  reasoning about which one it must be.

  So sand has its own tile, baked in [sand.js](./sand.js): 512² RGBA16F,
  ~250 ms of the boot, read at three world periods (0.55 m, 9 m, 67 m) rotated
  against each other so the repeat has no axis to sit on. Three properties
  matter, and the terrain map has none of them:

  - **Perlin, not value noise.** A value-noise lattice reads as squares however
    many octaves are stacked on it; gradient noise does not.
  - **Octaves down to four texels.** At the 0.55 m period a texel is 1.07 mm, so
    the tile genuinely carries grain, and the mip chain band-limits it *per
    pixel* — the only way grain can be grain underfoot and quiet at forty metres
    instead of moiré. `heightTex` is still deliberately left without a mip
    chain: the mesh and the player read exact metres off it, and a mip chain
    would move the waterline with the camera.
  - **Analytic derivatives baked into RG, not a height to difference.** The
    normal is then one tap, and it *filters correctly*: averaging slope flattens
    a surface, which is exactly what distance does to sand. A height map
    differenced in the shader gets louder as it undersamples.

  Two consequences fall out. Detail now lives in the **albedo** as well as the
  normal — grain-scale speckle modulated by a clumping mask, because grain does
  not fall evenly over a beach — so there is something to see at noon. And the
  wind ripples are not one straight 37° / 30 cm corduroy laid across the
  whole frame: they come in patches keyed to the 67 m field, meander over a few
  metres, and fade on their own short leash.

  The specular is **one GGX lobe driven by
  one roughness**: 0.95 dry, 0.09 under a swash sheet — separate hand-rolled
  powers (a glint, a sheen, a sparkle), each with its own mask, would each need
  a re-tune every time the sun moved. The wet strip then mirrors
  the sky at a low sun and goes quiet at noon without being told to. Only the
  sparkle survives separately, because a sub-pixel population of aligned grain
  facets is not a roughness and no smooth lobe will produce it.

  **Wetness — four ideas:**

  - **The wet sand is where the water *was*, not where it is.**
    Reading the waterline at a delay and taking the max with the
    current one needs the delay tuned to the swash period; the shared shoreline
    model's run-up envelope (see above) needs no delay to tune. A swash sheet runs
    up, drains back, and leaves a dark tongue shrinking behind it. Keyed to the
    *present* waterline instead, a wet band can only slide up and down rigidly,
    which is exactly what a painted band does.
    **The tongues have to be long, and this is the trap.** `terrain.map.w` is a
    76 m noise octave, so tiling it 37× or 60× hands back a *two metre*
    wavelength. Feed that into the **position** of a high-contrast boundary —
    ±3.5 m of shore distance, ±0.17 m of run-up, which is ±6 m of waterline on
    a 1:35 face — and the beach comes out in metre-wide slabs, the exact look
    of a blocky voxel game. A real swash tongue is ten to thirty metres of
    shoreline across. So the meander runs *along* the shore analytically at
    that wavelength, and nothing here samples a texture for a position. This is
    the same failure as the ripple phase one paragraph up: a texture tap
    facets a pattern at its own texel size instead of bending it.
  - **A static high-water line ORed in on top**, because a beach has three
    tones, not two: bright dry back-beach, a damp mid-tone that never dries
    between waves, and the moving wet strip. Drop the mid-tone and the strip has
    nothing to sit against and the whole beach flattens to one note.
  - **Wet sand is `albedo^(1 + wetness)`, not `albedo × grey`.** The difference
    is *saturation*: a power darkens the weak channels far more than the strong
    one, which is what water in the pores does — more internal bounces, more
    absorption where the mineral already absorbs. A neutral multiply darkens
    every channel equally and gives washed-out mud.
  - **Ripples flatten under water** (`1 − wetness²` on the normal noise):
    the sheet fills the micro-relief, which is why the wet strip is
    the one glassy part of a beach — and it is glassy, so a Fresnel sky
    reflection rides over the diffuse there. At a low sun that reflection is the
    loudest cue on the beach, the reason the strip the last wave covered reads
    as a sheet of light rather than as darker sand.

  Lighting on sand is a **wrapped diffuse**, `smoothstep(-0.2, 1, N·L)`
  instead of `max(N·L, 0)` — grains are translucent quartz a fraction of a
  millimetre across, light enters one and leaves the next, so the terminator
  does not land on zero, it wraps past it. It *replaces* Oren–Nayar on sand
  rather than stacking with it: laid over the retro-reflection term it
  brightens the beach twice and flattens every shadow on it.

  Distance haze is the atmosphere's own aerial perspective, not a fog colour.
- **Palms** ([trees.js](./trees.js)) — ~120 procedural coconut palms scattered
  in grove clusters along the coast band (plus a few inland stands), leaning
  seaward down the shore-distance gradient, each stamping occlusion and a
  grass clearing into the map before it becomes a texture. A coconut frond is
  **pinnate**: a drooping rachis carrying dozens of narrow leaflets that sweep
  back and hang. Building each side as one continuous quad — the cheap way —
  is exactly what makes a palm read as a paper toy, because the silhouette
  becomes a solid chevron with no light through it. Individual leaflets cost
  ~3 triangles each and buy the whole look; each is rotated twice (swept
  toward the frond tip, dropped) so it looks grown rather than glued on, and
  the crown holds fronds at every age at once — young ones standing up, old
  ones folded past horizontal.

  The crown also has to be *big enough*. A coconut palm carries twenty to thirty
  fronds four to six metres long; fourteen fronds of three metres left a crown
  you could see the sky through from every angle, and the tree read as a sapling
  with a few feathers on it. Eighteen fronds of nearly four metres, with wider
  leaflets, is the cheapest quality in the scene — a leaflet is three triangles
  and the whole grove is one draw. The middle of the crown is shaded by the
  fronds above it, so transmission and albedo both fade toward the rachis base;
  and there are **coconuts**, six triangles apiece, because a crown with nothing
  hanging under it reads as a fern on a pole. All palms are merged into **one**
  static draw:
  a custom TSL `positionNode` on an `InstancedMesh` would discard the instance
  transform (three applies instancing to `positionLocal`, then lets
  `positionNode` overwrite it), so per-vertex attributes carry the wind
  instead — whole-crown sway in the wind director's world direction plus
  per-frond tip flutter. Fronds get two-sided diffuse and a
  sun-behind-the-canopy transmission glow.
- **Broadleaf wood** ([grove.js](./grove.js)) — the island's interior. Palms
  hold the coast; inland the ground is deep enough for trees with a bole you
  can walk under, so ~430 broadleaves are scattered on the drained meadow above
  the sand and below the tree line, clustered by two noise octaves into stands
  with real clearings between them.

  Two numbers decide whether that reads as a wood. A slope gate of 0.30 —
  17°, which on a volcanic island is nearly nowhere — keeps the whole
  wood in the coastal apron and leaves the interior, which is *all* ridges,
  bald; 36° is steep but forest grows on 36° all over the tropics, so the gate
  sits there. And the
  minimum spacing **varies with the stand field** instead of being flat: a
  single minimum distance everywhere gives an orchard however the noise is
  tuned, since every tree ends up the same distance from its neighbours.
  Letting thick ground pack to ~4.5 m and thin ground open out to ~11 m is
  what makes a thicket a thicket and a clearing a clearing.

  **The trees grow from a species table, not a pile of decisions.** The
  generator lives in
  [ash/tree-system.js](./ash/tree-system.js) and [ash/preset.js](./ash/preset.js),
  and what matters is not in any one
  feature — it is that the growth is a *system*. The table in `preset.js` is a
  contract: four branch levels,
  uneven angles (48°/75°/60°), child counts 7/4/3, emergence starting a quarter
  and a third of the way along the parent, gnarliness inversely proportional to
  the square root of the limb radius, and a force term that bends a thin twig
  much harder than a thick one because it is divided by the same radius. Those
  numbers *are* the ash. Reproducing them before tuning anything is the whole
  method, and the recorded-divergences block at the top of `preset.js` says which
  ones this world changed: none of them.

  Three things the table gets right:

  - **The trunk continues past every whorl.** Each level emits its children
    *plus* a terminal continuation of itself, so the bole climbs and thins
    through all four levels instead of forking away at the top. That single rule
    is the difference between a rounded crown with depth and a flat umbrella on
    a pole — and it is a rule, not a tuning, which is why it survives changing
    every other number.
  - **Children are stratified along the parent, not clustered at a node.** Level
    *n*'s children start at `start[n]` of the parent's length and are spread over
    the rest of it, each rotated against the last, so the whorls interleave and
    the crown has an inside.
  - **Orientation slerps from parent to child.** A limb leaves its parent
    pointing nearly the parent's way and turns to its own bearing over its first
    sections. Set instantly, the junction reads as a branch glued on; slerped, it
    reads as a branch that grew out.

  Everything *around* the table is this world's own, and it is all
  recorded at the head of `tree-system.js`. Bark and leaves are
  **one merged geometry** with `aWind` and `aSurf` per vertex, so a tree is one
  buffer and a bucket of trees is one draw. `aSurf` carries **metres along and
  metres around the limb**, measured on the CPU where the tube is built —
  which matters because the bark below is
  procedural and fissures have to run the way the tree grew. And the crown's
  centroid and radius are measured on the way out, because the canopy
  self-occlusion divides by them.

  **The wood is 430 of five trees, not 430 clones.** The species table is fixed
  and the seed is not: five seeds walk five different paths through the same
  grammar, at heights spread the way a stand spreads — a couple of emergents near
  20 m, most of the storey between 12 and 18. A wood of one clone is readable as
  one clone however you rotate it, and the seed is the cheapest possible fix.

  Instancing them took one non-obvious thing to get right. With `positionNode`
  set — which every wind-animated material here needs — the instance transform
  looks like it should be lost, because `positionNode` replaces the position the
  pipeline would otherwise have used. It is not: three applies instancing *into*
  `positionLocal`, so a `positionNode` that starts from `positionLocal` and adds
  its wind offsets keeps the matrix, while one that starts from
  `positionGeometry` silently stacks all 430 trees at the origin. Every tree's
  phase, tint and scale ride an `InstancedBufferAttribute` read back as
  `attribute('aInst', 'vec4')`, and the per-bucket geometries **share their
  vertex `BufferAttribute` objects by reference**, so a bucket costs its
  instance buffer and nothing else.

  **Foliage is a photographed compound shoot, not built geometry.** An ash leaf
  is pinnate — seven to thirteen leaflets on a rachis — and there is no honest
  way to build that as geometry at 160 terminal branches a tree. It is an alpha
  card ([assets/ash/leaf.png](../assets/ash/leaf.png)) on a double perpendicular
  pair: a single card per
  leaf makes the canopy flicker as it turns. `alphaTest`, not blending, so the
  canopy needs no sorting.

  Bark is this world's own: aperiodic value noise folded through `abs` in the
  limb's own surface frame, two crack sets combined with `min` plus a third
  running the other way to break the ridges into plates, band-limited by hand
  because there is no mip chain to do it. The long version of why a *sum of
  sines* cannot be bark — it is a moiré pattern, and on a thin branch it
  interferes into something that reads unmistakably as braided rope — is worth
  keeping in mind for any procedural surface on a curved limb.

  Wind is the palms' model with a second term: whole-crown sway weighted by
  height squared and branch order, plus a fast per-leaf flutter applied
  **perpendicular** to the wind rather than along it, because a leaf on a stalk
  pivots — it does not surge. Shading is two-sided diffuse with the normal
  flipped toward the viewer (a leaf is one card thick, so which way its baked
  normal faces is meaningless), a canopy self-occlusion term keyed on how far out
  of the measured crown the leaf sits, and a transmission lobe that is the whole
  look of a broadleaf at golden hour — the sun behind a leaf lights it from the
  far side, warmer and yellower than it ever is in reflection.

  The wood is **bucketed into a 170 m spatial grid**, one instanced mesh per
  bucket sharing one material and one geometry. The ash costs ~17.7k triangles
  a tree, so the whole wood is
  **8.6 M triangles** — and that number is the one to
  ignore, because it is the number *before* culling. Per bucket, three's own
  frustum culling submits only what is in front of you: measured, ~1.3 M
  triangles at 87–119 fps standing in the wood. One mesh for the island would
  submit all 8.6 M every frame regardless of where the camera looks.
  Trees do not write into the sun-shadow field — only the terrain does — so
  what grounds them is the occlusion each canopy stamps into the bake, the
  same channel the palms use.
- **Flowers** ([flowers.js](./flowers.js)) — ~2 700 blooms in ~39 patches, and
  the point of them is that they are *not* everywhere. Grass covers the island;
  flowers are an event. Patches are chosen where the meadow is already thick
  (density > 0.72), the ground is flat enough to hold soil (slope < 0.42), the
  sea is far enough away not to salt it (> 14 m of shore distance) and the
  elevation is between the beach and the tree line — plus five that are simply
  *around the house*, because a garden is a thing people make and it should not
  have to win an argument with a noise field.

  The species table is what makes eight *species* rather than eight scalings of
  one flower: eight
  species × five painted variants, with the petal counts (5/6/8/9 plus a
  per-variant delta), the profile pairs and the twist table kept exactly.
  A petal is a parametric surface with **analytic derivatives** —
  `∂P/∂along × ∂P/∂across` gives the normal directly, so a curling petal lights
  correctly without a normal map and without finite differences. Stems are
  crossed ribbons: two quads at right angles, which from any angle is a stem and
  from no angle is a billboard.

  There is no GPU culling machine around them: at this count it would cost more
  than it saves — the patches are bucketed
  on a 260 m grid like the wood and three's frustum culling does the rest, 55
  meshes, ~360k triangles, ~1 ms.

  Two traps are worth knowing. The atlas is addressed with
  **v = 0 at the top**, and three's default `flipY = true` therefore hands every
  petal its own image upside down — which does not read as "flipped", it reads
  as torn slivers, because the petal's alpha silhouette no longer matches its
  shape. And a keep probability written as a hand-expanded smoothstep keeps the
  wrong share of candidates if the expansion is off.
  Both are the same lesson — a bug in a *mapping* shows up as a
  quality problem, not as an error.

  Wind is three terms that must not be one: a static lean ∝ `along^curvePower`
  that is the flower's own posture, a wind sway ∝ `along²` that is the gust, and
  a contact bend ∝ `influence · along²` where the player walks. Only the head
  scales with the bloom; the stem's bend is the stem's.
- **Aurora** ([sky/aurora.js](../sky/aurora.js)) — an option for the night, not
  a fixture: `aurora.intensity` in the sky config is 0 for a plain starfield and
  1 for curtains, and it fades itself in as the sun drops below −0.02 and out
  again at dawn, so it never has to be switched.

  The curtains are a slab
  of volume from 50 m to 125 m, a radiance shell `pow(0.55/|squished|, 12)` that
  is what makes a curtain an *edge* rather than a cloud, three octaves of 3-D
  value noise warping it, and a `lineNoise` with hash-parity gradients for the
  vertical striations. Marched honestly, per pixel, it is a full-screen effect
  and costs like one.

  It is not marched per pixel here. It is baked once a frame into the **same
  512 × 160 direction LUT the atmosphere already uses**, with the same
  sqrt-warped azimuth/elevation mapping, and added into `sample()`'s night
  branch. That buys three things for one texture fetch: the sky costs the same
  as it did, every water reflection ray gets the aurora for free because it
  calls the same `sample()`, and the aerial-perspective term does too. A
  full-screen pass would have given the sky and nothing else — and an aurora
  that is not in the sea is half an aurora.
- **Swimming, and the seabed** ([main.js](./main.js), [island.js](./island.js),
  [sky/atmosphere.js](../sky/atmosphere.js)) — the sea is not scenery: walk out
  past chest depth and the player switches to a breaststroke
  and a floating attitude (hysteresis at 1.15 m in, 0.95 m out, so a passing
  trough cannot toggle it), Space rises, C dives, and the bed is a floor you can
  stand a metre off. The eye height interpolates with the body's pitch, because a
  swimmer's eye is 20 cm above the water and not 1.6 m; the cast shadow is hidden
  outright while swimming, since a shadow ellipse on the bed under a prone
  swimmer reads as a sand-coloured disc following you around.

  **The water itself is one medium, in one place.** Rather than a post-processing
  pass, the aquatic term lives in `atmosphere.aerial()` — the same function every
  material already calls for aerial perspective — so the moment the camera goes
  under, every surface in the scene fogs through water instead of air with no
  per-material change anywhere. `background()` gets the Snell window: below the
  critical angle (48.6° for water) the sky is compressed into a bright disc
  overhead and everything outside it is total internal reflection.

  The extinction coefficient has to match the water you are in.
  The open ocean measures
  (0.026, 0.0085, 0.005)/m, ~250 m of visibility — and on that figure five
  metres of water is optically nothing: a dive renders a seabed that
  looks like a dry beach. A breaking shore measures
  (0.25, 0.04, 0.02)/m — and on that the bed is dark green before the dive
  finishes. Everywhere a swimmer can actually get under here is the shelf, so
  `AQUATIC_EXTINCTION` is the shelf's own number, (0.115, 0.028, 0.016)/m, and
  it is exported from `atmosphere.js` because the island multiplies the *down*-
  welling light by the same vector: `aerial()` covers the ray from a point back
  to the eye, and nothing else covers the column the light came down.

  Caustics: two capillary samples at
  incommensurate scales, drifting at different speeds, summed and folded about
  zero so the web rides the zero crossings — reading the sand-detail tile,
  and reading its **derivative** channel rather
  than its height. That is not a detail: the tile's height is 1/f, so its lowest
  octave has four times the amplitude of the next and the zero crossings come out
  as three broad blobs across the screen. Its slope spectrum is flat by
  construction, and a flat spectrum is exactly what a caustic web is.

  Two terms on the seabed share one shape — a term that is right about the
  beach being asked about the sea floor:

  - The wet-sand specular put a **searchlight** on the bed a metre from the
    swimmer's mask. `roughness = mix(0.95, 0.09, wetness)` is a correct model of
    a *swash sheet*, whose flat unbroken top surface really is near-glass — but
    below the waterline there is no sheet, the interface is the grain surface,
    and 0.09 gives a GGX lobe with a peak near 5 000 that blows out however far
    the Fresnel term is pushed down. Under water the roughness goes back up to
    0.62, and `F0` drops from 0.025 to 0.003 because the far side of the
    interface is water, not air (1.54:1.33 instead of 1.54:1).
  - Shell fragments read as a **disc of hard white specks** ending on the ring
    where their 30 m near-field fade runs out. Same sprinkle as the dry beach;
    what changes is that `pow(albedo, 1 + wetness)` halves the sand around them
    and leaves a near-white chip near-white. They are cut to a quarter under
    water, where a wet chip is grey.

  And the deep-water skirt that fades the far bed to navy is the *eye's*, not
  the bed's: it is multiplied by `1 − submerged`, because seen from above it is
  nearly free accuracy and seen from below it erases the floor you are swimming
  over. Under water `aerial()` computes the same loss honestly, along the real
  ray.
- **The surf zone's memory** ([ocean/breaker-foam.js](../ocean/breaker-foam.js))
  — a deep-water spectral sea is the wrong sea at the
  shore. The two differences that matter are both about *time*
  and *asymmetry* rather than about shading.

  **Forward pitch.** Green's law already makes a shoaling wave taller and the
  trough limiter already crowds its trough — but a wave that is taller and
  flatter-bottomed is still symmetric, and a breaker is not. Its crest sits in
  deeper, faster water than the trough ahead of it, overtakes its own front, and
  turns a sine into a wall with a long flat back. So the crest is displaced
  shoreward — up the bed gradient, taken from the terrain bake with two taps — by
  a fraction of its own height, ramped in as the water shallows. The fraction is
  0.55 and not 1.0 because at 1.0 the grid folds through itself and a plunging
  lip renders as a torn one.

  **Whitewater has a past, and a fragment shader has none.** Painted as a
  function of now, foam is a white line glued to the front of every wave: the
  instant the crest passes, the water it aerated goes clear again. So there is
  one scalar field over the whole coast — a 640² buffer over a 1.4 km square
  measured from the terrain at boot — stepped at 30 Hz. Wherever the
  depth-limited breaking criterion fires it writes foam; every step the field
  decays with a ~6 s time constant and drifts up the bed gradient at ~3 m/s. The
  surface reads it in place of its own instantaneous surf term.

  Three implementation notes worth keeping. It is **world-fixed, not
  camera-following** — a camera-following buffer reprojects every frame and
  fades at its edges; this island's whole coastline fits
  in one square, which deletes the reprojection, the previous-centre uniform and
  the edge fade, and means the foam behind you is still there when you turn
  round. It **ping-pongs by offset, not by binding**: WebGPU will not let one
  texture be a sampled source and a storage destination in the same pass, so the
  state is one storage buffer of twice the texels with read and write halves
  picked by two uniforms, and the pass writes a plain storage texture on the way
  out for the surface to sample. And **advection is a bilinear read, not an
  integer shift** — at two metres a texel and 120 fps the per-frame drift is a
  hundredth of a texel, which rounds to zero and never moves at all.

  The generation thresholds sit deliberately *above* the surface's own. The
  surface's `brk` asks "is this crest steep enough to shade white" and answers
  per fragment, so it can afford to be generous — whatever it paints is gone next
  frame. The field asks "did a wave *break* here", and writes an answer that will
  still be there in six seconds; generous there and the whole surf zone latches
  white and stays.
- **Drifting leaves** ([grove.js](./grove.js)) — 129 000 free quads that fall,
  tumble and blow past the camera in one draw, 300 to a tree.

  Five things decide whether the shot reads as a wood in golden-hour light or
  as a handful of props, and none of them is the motion curve:

  *A leaf comes off a tree.* Leaves in a box that
  follows the camera, *gated* on how wooded the ground under them is,
  answer the wrong question. A gate can say "there are trees near here";
  what you see standing in a wood is not leaves near trees, it is leaves coming
  off *that* tree — they appear in a crown, they leave it, they go downwind. A
  field is a blur over a stand and the eye reads it as weather rather than as
  shedding. So there is no field and no box: the tree builder already measures
  every crown's centroid and radius (it needs them for the canopy occlusion),
  and each leaf is baked onto one of them, at a point on the crown's *outer
  shell* where leaves actually grow — start at the centroid and the leaf
  appears out of solid wood. It then descends from that branch to the grass
  over one cycle and is carried downwind as it goes.

  The cost of pinning them to the island instead of to the lens is that the
  whole island's worth is submitted every frame. That is fine and it is worth
  saying why: a faded leaf collapses to a point in the vertex stage, so the
  ~90% that are behind you or over the hill cost one `step` each and nothing
  downstream. Measured in the wood, toggling all 129 000 off moves GPU render
  from 12.3 ms to 11.9 ms.

  *Depth.* A shallow box around the camera puts every leaf within reading
  distance, and the effect reads as a handful of
  props near the lens with clear air behind them. A real shot fills the whole
  depth — a few big leaves close, a haze of specks two tree-lengths
  out. With leaves belonging to trees, depth comes for free from where the
  trees are; the only distance number left is where they fade out (86 m, below
  which a 27 cm leaf is a crawling speck).

  *Two flight styles, not one.* `style` picks between a flutterer — rocks about
  level, swings wide, stalls on each swing, hardly turns over — and a tumbler,
  which turns end over end and mostly goes where the wind sends it. Real leaves
  do one or the other depending on how their inertia compares with the air they
  push, and a field where every leaf does the average of the two reads as
  debris. The tumble axis is **per leaf**: one axis for the whole field makes
  every leaf flip in sync, which is the single most artificial thing a particle
  system can do.

  *Colour.* Gold is wrong. It says autumn, and next to a summer wood it looks
  like litter. The palette is chartreuse through pale yellow-green, *lighter
  than the canopy it fell out of at both ends*, with a transmission lobe on top
  — the one thing a leaf in the air has that a leaf on the tree does not is
  that you see it lit from behind.

  *Defocus.* `vCorner` is the leaf's own coordinate, 0 at the centre and 1 at
  the rim, and the fragment stage feathers inward from 1 by an amount that
  grows as the leaf approaches the lens. A leaf that swings past your face
  resolves as a soft bright blob rather than as a hard card, and the feather
  never goes fully to zero width, so a three-pixel alpha quad gets free
  anti-aliasing instead of crawling edges. They are **rhombi, not rectangles**
  for the same reason — a tumbling rectangle reads as confetti, and at that
  size the silhouette is the only thing that says *leaf*.

  Height comes from a vertex tap of the heightfield, so they land on the grass
  rather than through it — and it is clamped, because the terrain a leaf drifts
  over is not the terrain it left.
- **The house** ([villa.js](./villa.js) + [villa/](./villa)) — *Villa Ravine*,
  a complete procedurally modelled two-storey house, built at
  1.75x. It is authored at a scale for a 1.7 m person — 23 m across, 10.8 m to
  the ridge — and this island's protagonist is 3.1 m,
  which at 1:1 is a doll's house: the figure's head reaches the ground-floor
  ceiling. Everything with a size in metres derives from that one number rather
  than restating it — the levelled pad the bake cuts, the shadow box, the sun's
  stand-off, the hemisphere's height, the range past which the shadow map
  switches off. Two of those are not obvious and both bite: the pad, because a
  building and the ground it stands on that disagree leave the terraces
  cantilevered off the edge of the cut; and the shadow bias, because the same
  2048 texels now cover 1.75x the ground and the offsets that stopped it
  self-shadowing have to grow with the box.

  It is a complete two-storey house: a
  board-formed concrete pavilion under a cantilevered timber-clad sleeping
  volume, 215 000 triangles, every room modelled and furnished and lit.

  Its modules — `textures / lib / materials / house /
  furniture` — live under `world/villa/`, so the scene stands up on its own;
  there is no `site.js`, since the island supplies the ground. That
  leaves ~51 000 triangles over ~1 600 parts. [villa.js](./villa.js) is only the
  adapter: siting, orientation, and lights.

  **Dressed for the right island.** A flat-slab,
  parapet-edged modernist box in black-stained board behind an orange-pine batten
  screen is a perfectly good house, and from the far shore it reads as a dark slab
  dropped on a green hill. Two changes, and neither touches what the model does
  well (real openings, expressed structure, furnished rooms):

  *Form.* The parapet ring, the pale roof finish, the PV array and the plant
  enclosure are replaced by a broad low **hipped roof** ([villa/roof.js](./villa/roof.js))
  carried well past every wall. The eave is the whole point of the type — from a
  Balinese pavilion to a Queenslander, the tropical vernacular is a big roof with
  overhangs deep enough to keep the sun off the glass and the rain off the
  verandah — and one outline rectangle plus one pitch produces it. Equal pitch on
  all four planes puts the ridge inset from each end by half the plan depth, so
  the *plan* decides the ridge length rather than the ridge being authored; a
  nearly square plan gives a nearly pyramidal roof, which is what it should give.
  Faking a longer ridge means steepening the hip ends, and a roof whose ends do
  not match its sides is the thing that reads as a game asset. It is built as a
  solid — top planes, the same planes dropped by the roof build-up as a boarded
  soffit, a fascia band closing the eave — because the soffit is what you
  actually see from under a two-metre overhang. And the south cantilever now
  stands on a **verandah colonnade**, which is the honest reading of that
  overhang on an island and the other half of the type.

  *Colour.* An island house is the inverse of a northern one: a pale, lime-washed
  body that holds the light under a deep eave, timber gone silver in the salt
  air, and the dark saved for the roof and the window frames so the building has
  a hat and a set of lines instead of being one tone all over. The backing board
  behind the batten screen is limewash, the battens
  driftwood grey, the concrete warmer and paler, the frames
  dark bronze, and the roof a weathered green-grey board. One tuning note
  worth keeping: the roof texture at 0.42 m per repeat over 16 boards is
  2.6 cm courses, which mip straight to a flat grey sheet; 2.4 m gives 15 cm
  courses that survive to the distance the house is usually seen from.

  **One thing it does not get is a shadow on the meadow.** The terrain and the
  grass read a TSL shadow texture marched off the heightfield, and the villa is
  not in the heightfield, so the building shadows itself but casts nothing onto
  the ground around it.

  **Lighting is the one real seam.** Everything else in this scene is shaded by
  hand in TSL on `MeshBasicNodeMaterial` and reads the atmosphere directly; the
  villa is `MeshStandardMaterial` and wants three's own lights. Both can share a
  scene — a light only reaches a material that asks for one — so the villa
  brings a directional sun and a hemisphere fill of its own, driven each frame
  from the same sun everything else reads, and its interior fixtures cross-fade
  from cool daylight bounce to warm lamplight.
  What it cannot bring is an environment map: this sky is a TSL LUT with no
  CPU-side cube to filter, and **metalness with nothing to reflect renders
  black**, so the metals come down to where the hemisphere fill can still
  describe them.

  The shadow map is a 48 m box on the building rather than anything scene-wide.
  Nothing else in the scene casts into it — the terrain, palms and grass read a
  separate TSL shadow texture — so the pass draws only the villa's own meshes,
  and it switches off entirely past 150 m, where six thousand draw calls buy a
  shadow nobody can see.

  **The plot is a rectangle, not a radius.** The site is *chosen* rather
  than authored — the bake scores every coarse cell on how level it is, how far
  inland it sits and whether it is meadow — but the ground is cut and the blades
  cleared to a rectangle aligned with the building, blended out over 30 m. A
  circular pad is a disc of levelled, grassless ground, the loudest shape an
  island can have.
- **The house you can go into** ([indoors.js](./indoors.js)) — three things
  have to be true and they are one
  problem, not three — you cannot pass through it, you can stand on the parts of
  it that are floors, and the parts that open, open on **F**.

  **The collision is derived, not authored.** A hand-written box list would be a
  second copy of a 1 600-mesh building that goes stale the moment the model
  changes, so the boxes *are* the building: one box per mesh, binned into a 3 m
  grid. Everything else here is what that decision costs, and each of the three
  costs shows up by flood-filling the house with the walk rules and asking what
  the figure can actually reach.

  *The boxes have to be oriented.* The house faces the view, which puts its model
  247 degrees off the world axes — and measured against that, **1 572 of its 1 603
  meshes have an axis-aligned bounding box more than 1.4x their true volume**,
  half of them more than 3x. Axis-aligned collision on this model is not a rough
  fit, it is a different building. So each box keeps its own horizontal axis and
  is tested in its own frame: exact for anything rotated about Y, which is all of
  it but the roof planes, and a tight footprint for those.

  *A sloped part is not a wall as tall as its slope.* The stair's stringer is a
  34 cm steel edge beam raking up 3.4 m; as one box it fenced the entire flight
  off from the room it starts in, floor to ceiling. Sloped parts are cut into
  segments along whichever of their own axes climbs, each carrying only the
  height it actually occupies — which at the foot of a flight is a few
  centimetres, and steppable.

  *An instanced mesh is many placements, not one.* Taking the bounding box of the
  upper storey's batten rain-screen — 700-odd instances behind one matrix — gave
  a solid **10 x 24 m block filling the whole floor it clads**. Each instance now
  gets its own box.

  **A floor is a box top you can reach**, and that one rule gives the deck, the
  treads, the upper slab and the roof terrace with nothing special-cased — plus
  the underside of the house for free, because from below every one of those tops
  is far more than a step away and the terrain wins. The step has to be measured
  from where the figure *would be standing*, not where it is: test a stair from
  the tread below and the tread two above is a wall reaching past your head, so
  every riser refuses to be climbed.

  **The furniture is not solid.** With the furnishings in, a flood fill from the
  entry pad never reaches the stair at all — the ground-floor route to it closes,
  and a planter at the head of the flight closes the top. Walking through a sofa
  is a small lie; a house you cannot go upstairs in is a bigger one.

  **Three defects had to be fixed**, all of them things
  you only find by trying to walk through the building rather than look at it.
  The door leaf hung on the wrong side of its hinge (`leaf.position.x = -lw/2`
  puts the leaf's *right* edge on the pivot), so a shut door sat 1.9 m clear of
  its own doorway. A fourth panel across the entry portal — two jambs and a head
  make a portal; a fourth side makes a box — boarded the front door up, which is
  why the figure stopped a metre short of a door that opened perfectly well
  behind it. And the stair void's guardrail ran across the head of the flight, so
  you climbed eighteen treads and arrived at a sheet of glass.

  **Then the parts that are passable but not walkable** —
  the difference between a route existing and a route you can find with a
  keyboard. A collision radius of 0.55 m is a 1.1 m-wide body trying
  to pass a 1.2 m clear doorway: geometrically possible, and it leaves 0.1 m of
  centres to aim at, so every doorway has to be threaded rather than walked
  through. At **0.42 m** (feet 0.24) the front door has 0.75 m of centres and
  the terrace door 1.0 m. Nothing about the building changes; the body stops
  being a barrel.

  A stair going of 0.28 m over eighteen treads pushes the bottom
  riser to within **1.29 m** of the room's far wall — a landing you have to
  already be standing on to use, since arriving at it takes more floor than it
  has. At 0.25 m the flight is 0.54 m shorter and the landing is **1.26 m
  local, 2.2 m built**, which is a stair you walk up to. The bottom riser is
  derived from the stair void (`V.z0 + 0.24 + 17.5 * run`) instead of being a
  literal, so the two facts cannot drift apart.

  And an even 2.55 m colonnade rhythm of its own
  puts a post at x −3.05 and another at 7.15 — **dead centre of both sliding
  leaves** (bays −4.12..−2.52 and 6.05..7.49). Posts land on the glazing's
  own mullion lines, so each door gets a post at its jamb and none in its
  opening. That is why the bay grid is named (`gzA`, `gzB`) rather than inlined
  into the two `curtainWall` calls: it is one fact, and the colonnade is its
  second reader.

  Cost, measured with 1 400 boxes and the player inside the house: `blocked`
  0.40 us, `floorAt` 0.45 us, `solidAt` 0.06 us per call, and 0.02 us anywhere
  outside the building's footprint. The frame makes about twenty of them.

  The camera gets the same treatment, because a rig orbiting 12 m out puts the
  lens through the wall behind the figure and films plaster. It marches the ray
  from the figure to the lens and stops at the first solid — and it has to *own*
  the follow distance to do it, since OrbitControls re-derives its radius from
  the camera's position every update, so a rig pushed in by a wall would simply
  stay pushed in once the wall was gone. Squeezed inside 4.5 m the figure hides
  itself, which is not a new rule: that is already the distance the wheel is not
  allowed past because the lens ends up inside a 1.7 m-wide head, and a wall
  pushing the rig there is the same event. Indoors the default view quietly
  becomes first person, which is the only one you can see anything in.
- **Grass** — the `grass/` system on a 200 m tile of 1600x1600 blades that
  follows the **camera's** ground point, not the player — orbiting away from
  the player must not leave the view bald (the separate `tramplePos` uniform
  keeps trails at the player's actual feet).

  **The tile is a square and the field must not be.** A fixed-extent tile stops
  somewhere, and a boundary along `max(|off.x|, |off.y|)` — the square
  the blades are stored in — is two straight lines
  converging on a vanishing point in perspective, so from any raised camera the
  meadow ends on
  a hard diagonal and the grass reads as a triangular patch laid on the hillside
  with the rest of the island shaded as turf. The boundary is **radial**:
  `length(off)`, faded from 0.7 to 1.0 of the half-tile and resolved against the
  same per-cell hash the thinning uses, so it dissolves rather than steps. A
  circle centred on the lens is what a draw distance looks like — it has no
  corners to find and it does not turn when you do. It costs the corners of the
  tile, a fifth of the blades, and is worth every one of them.

  **And the tile grows with the lens.** 200 m is the right field to stand in and
  the wrong one to look down on: from a hundred metres up the blades still
  stopped a hundred metres out. `GrassSystem.setTileScale` rescales the whole
  field — one multiply over the offsets in a compute pass, plus a terrain-cache
  invalidation, since a blade's cached height and shadow are functions of where
  it stands. Blade count is fixed, so reach is bought with **spacing**, and that
  is exactly the right trade: the altitude that asks for the reach is also the
  altitude at which a blade is a fraction of a pixel wide. The ask is
  `tileSize · (1 + camAlt/50)`, snapped to half-octave steps with a deadband on
  either side — a continuous resize would re-cache 2.56M blades every frame, so
  the field settles on a small set of sizes and stops resizing the moment the
  camera stops climbing. At walking height it is the base 200 m at 12.5 cm; from
  150 m up it is 566 m at 35 cm.

  Getting a meadow to read as dense is three separate numbers, and only
  the first is the obvious one.

  **Spacing.** `tileSize / bladesPerSide` is the only number that decides
  whether a field reads as grass or as a moth-eaten rug. The standalone scene
  is 130 m over 1024 — 12.7 cm. The same 1024 blades over 288 m
  is 28 cm: one budget spread over five times the area, and hillsides
  go bald. This tile is 200 m over 1600 — 12.5 cm, at 2.56M
  blades.

  **Blade length is not blade height.** `blade.minScale/maxScale` is a length
  in units of `BLADE_HEIGHT`, and `baseBending` then lays a long blade over
  into an arch — a 2 m blade stands about a metre tall. Read
  0.85–2.35 as a height and cut it to 0.34–0.86 and you remove the *overlap*
  between neighbouring blades, and overlap is what density looks like: the
  field comes out as short straight stubble with ground showing between it.
  0.52–1.30 is 0.9–2.3 m of blade, waist-deep on a 1.3 m player.

  **Count the survivors.** Reading the indirect buffer back is the only honest
  measure — a tile can be
  rendering **48k blades out of 1.64M** and no amount of looking will say why.
  Frustum culling accounts for most of any such gap and should; what to check
  after it is `thinning.farDensity`. 0.1 by 75 m is a figure tuned
  for a 130 m tile, and on a 200 m one it lands squarely in the middle distance
  a meadow is judged on. At 0.85 out to the tile edge the same view renders
  ~430k blades. Far blades are LOD2, three triangles each, so they are nearly
  free.

  **Density is a mask, not a scatter.** The product of every
  field the bake has is a small
  number nearly everywhere — six numbers under one — and the meadow ends up
  thinned before a blade is placed.
  It starts at 0.87 and multiplies only by the gates that mean *no grass
  here* — sand, true cliff, alpine crest, and active scour. The scour gate is
  crossed with **slope** as well as flow, because the pipe model pools
  water in flat basins, so a flow-only gate fires hardest on exactly the level
  ground a meadow wants.

  **And its patchiness must not come off a lattice.** A base of
  `0.78 + 0.22·smooth(0.34, 0.62, 0.55·d1 + 0.45·d2)` with `d1`/`d2` two
  *single* octaves of value noise on 11² and 29² grids is 200 m and 76 m cells.
  A single octave of value noise is a field of smooth rounded bumps, and a
  contrast stretch turns each bump into a disc with a readable rim:
  pale ellipses fifteen to twenty metres
  across scattered over open meadow — paler *and* shorter than the grass around
  them, because density sets blade height and the turf colour reads it too.

  Two changes, and both are needed. The noise is a four-octave fbm from
  51 m down to 6 m, so there is no cell size for the eye to lock onto, and the
  large-scale variation is **causal** instead: a hillside runs thin on the convex
  shoulders where soil will not stay and thickens in the hollows water runs
  through, both already measured in the fields map. And the turf's own
  brightness ramp — the term that darkens the ground where blades stand over it
  — **saturates before the meadow's density range begins** (0.05→0.55, where
  meadow density is 0.84–1.0) instead of running 0.25→0.85 straight through it.
  Left on the steep part of its own curve, that ramp is a 2.2× lever: a 15%
  wobble in density comes out as a 25% swing in ground brightness, which is what
  makes an otherwise gentle field printable at all.

  The terrain turf uses the blade palette's own greens, lit by the unwhitened
  warm sun and striated at blade-clump scale, so the far meadow is the near
  meadow's colour and texture rather than a different material. Turf dryness
  follows low blade density, so any bladeless patch reads as short dry grass
  instead of lush felt — and the floor *under* a standing canopy is darkened
  by it, because without that the ground keeps its open-field brightness
  between the blades and every gap in a dense meadow still reads as a bald
  patch of dry earth.
- **Gulls** ([birds.js](./birds.js)) — ~50 procedural herring gulls wheeling
  over the surf line, built like the palms: one merged geometry, one static
  draw, everything animated in the vertex stage from per-vertex attributes
  (which circle, how fast, where on the wing this vertex sits), for the same
  reason — a custom `positionNode` on an `InstancedMesh` throws the instance
  transform away.

  Three things separate a gull from a flapping paper dart, and none of them is
  the model. **Gulls glide**: continuous beating reads as a pigeon in a hurry,
  so the beat comes in bursts of a few seconds with long stiff-winged glides
  between, and the glide is the default. **The wing is a travelling wave, not
  a hinge**: `sin(ωt − k·span)` lags the tip behind the shoulder by most of a
  radian and a pitch twist driven by the flap's own velocity feathers it into
  the downstroke, so the tip traces a flattened figure of eight. **They bank
  into the turn**, because lift acts along the bird's own up — fly a circle
  wings-level and the eye reads a sprite on rails immediately. The planform
  does the rest: swept leading edge, chord down to a fifth of the root, and
  the black outer primaries, which are the one marking that still says *gull*
  at a distance where the bird is a dozen pixels.

  Two things matter before any of that is visible at all, and
  both are about **being seen** rather than about birds:

  - **Placement is measured from the lens, not from the player.** The opening
    shot orbits from behind the figure, so a flock "40 m from the player" can be
    a hundred metres from the camera, and a 1.4 m wingspan at 90 m is seven
    pixels of a 514-line frame — physically correct and completely invisible.
    The flock is aimed at `spawn + spawnEye`, so it re-aims itself whenever that
    shot is re-framed rather than needing the distance written down twice. Two groups are
    deliberately flown into the opening frustum (±55° of the view direction,
    20–42 m and 70–140 m out) and carry a double share of the flock; the rest
    work the whole coast by rejection sampling on the bake's own shore
    distance, so they follow every cove and headland instead of ringing the
    centroid. The wingspan itself stays honest — an oversized gull gives
    itself away the first time one crosses a palm.
  - **The ambient has to know which way a surface faces.** A flat sky term
    makes a white bird exactly as bright as the sky behind it and the flock
    dissolves into it. Half the sphere over a gull is sky
    and half is water and sand; splitting the two by N·up drops the underwing
    to a middle grey, which is how a gull actually reads from below. The
    normal is flipped toward the viewer first, since the wing is a
    double-sided single triangle thick.

- **The cast** ([actor/](./actor)) — two playable figures from a seed-driven
  character generator, which builds a whole person — superellipsoid skull, SVG
  face rasterised into a 2x2 expression atlas, 18-bone skinned body, procedural
  walk/run/jump/crouch/cheer clips — out of **one integer**. A character here is
  therefore one number in [config.js](./config.js) and no asset files at all.

  `seed` goes to `makeDna` as it stands; `grid` beside it is only a label.

  The geometry, rig, body,
  clip and face modules are plain three.js and renderer-agnostic. **The material
  is not**: a GLSL `ShaderMaterial` is something a `WebGPURenderer` cannot
  compile at all, so `actor/materials.js` is a TSL material. That is the chance
  to do the thing that matters most: the figure is lit by *this
  world's* rig — the sun's own transmittance, the sky it is standing under, the
  moon after dark, the terrain's cast-shadow map, and `atmosphere.aerial()` on
  the way out. A studio ENV would make it a sticker on a photograph. What
  survives exactly is the **wrapped diffuse** (light carries a long
  way round a matte terminator, which is the whole clay look) and the face
  compositing into albedo **before** lighting, in bind-pose object space, which
  is why the expression sits *on* the skull and does not swim when the head
  turns.

  Two things the world needs that a wall of portraits does not have. The figure is
  authored with the head's centre at the origin and the body hanging below it in
  negative Y, so it is parented under a node lifted by its own foot line —
  `group.position` then simply means "where the feet are". And it gets a
  **contact shadow**, a flat blob under the feet that fades as a jump takes the
  feet off it: the island's cast-shadow map is baked from the terrain alone and
  a character cannot write into it, so without something there the figure hovers.

  Two details it took measuring to get right. The quad is laid flat with
  `geometry.rotateX`, and that **bakes into the position attribute** — so the
  plane's own two axes are x and z by the time the shader sees them, and reading
  `xy` turns the blob into a stripe. And the falloff's plateau has to be most of
  the radius, not a quarter of it: a blob that is only dark in the middle 25%
  averages out to a grey smudge, which at seven metres — the distance this is
  actually seen from — reads as a dirty patch of sand rather than as the figure
  touching the ground.

- **Three viewpoints** ([viewpoint.js](./viewpoint.js)) — third person, first
  person, free flight; `V` cycles them, and the panel has a dropdown.

  One module owns the camera because two owners is the failure mode.
  OrbitControls re-derives its spherical coordinates from `camera.position` on
  every `update()`, so anything else writing the transform is in a fight with it
  that neither side wins and the picture stutters between the two. So the orbit
  rig is switched **off** outside third person, and switching back re-seeds it
  from the yaw and pitch the free modes were using — nothing is ever driven
  twice.

  - Walking asks the viewpoint which way is forward, rather than deriving it
    from where the camera is standing. In first person the lens is *inside* the
    figure, so `player.pos − camera.position` is a zero-length vector and
    every step goes wherever the normalize happens to land.
  - Entering first person clamps the inherited pitch to about 16 degrees. The
    look direction is otherwise carried over so the cut does not jump, but the
    orbit rig is usually looking *down* at the figure and a flier is often
    diving, and the lens is only 2.4 m off the ground: even 30 degrees down puts
    the horizon in the top tenth of the frame and the shot is a photograph of
    sand.
  - Coming back to third person clamps the remembered radius to 12 m, which is
    also where the opening shot sits. Arriving back at whatever radius a flight
    ended on reads as the mode having done nothing.
  - Free flight travels along the *view ray*, pitch included, or you cannot dive
    at anything; `Space`/`C` are world up and down and `Shift` is a 4x boost.
    Its one limit is the same one the orbit rig has: stay above the ground and
    the sea. A heightfield is one-sided and the sea is a single plane, so from
    underneath either you get sky through the world and its back faces, which
    reads as a broken build rather than as having flown somewhere.
  - **Mouse look needs no button held, in every mode.** `movementX/Y` is
    reported whether or not the pointer is locked, so one `mousemove` listener
    covers both states and the view turns as soon as the mouse does. Third person
    is the one that cannot simply write the camera — the orbit rig owns the
    radius, the damping and the polar floor that keeps the lens out of the sea —
    so it accumulates the delta and hands it over once a frame through
    `controls.rotateLeft/rotateUp`, which is the same path the rig's own drag
    handler takes. Left-drag rotation is then switched off on the rig: left as a
    second path to the same thing, every drag would turn the camera twice.
    Damping goes to 0.25 for the same reason — at the 0.05 default a turn keeps
    arriving for most of a second after the hand has stopped, which reads as lag
    rather than as weight. The listener is on the canvas, not the window, so
    crossing onto the settings panel stops the camera instead of spinning it on
    the way to a slider — measured, that drift is exactly zero.
  - **A click captures the pointer, esc hands the mouse back.** Free mouse-look
    has one hard limit: the pointer reaches the edge of the window and the turn
    stops dead. There is no way to keep turning from there — the mouse has to
    come back, which turns the view back — so a screen width is the most that can
    ever be swung in one direction, and wherever the pointer happened to be
    becomes the centre of that range. It reads as a camera that will not come
    round. Pointer lock cannot be the *only* way in, though: a lock asked for
    outside a user gesture is refused outright, and a camera you cannot turn at
    all reads as a broken build rather than as a refused permission.

    Esc has to hand back more than the cursor. A visible cursor that still drags
    the camera everywhere it goes is not a mouse you can use, so Esc disarms the
    steering too, and clicking the world arms it again. Both exits are covered:
    when the pointer is locked the browser eats Esc itself and `pointerlockchange`
    is what fires; when it never was, the keydown is. And a **mode change asks
    for no lock at all** — grabbing the cursor as a side effect of pressing `V`,
    or of picking from a dropdown, is exactly the surprise Esc exists to undo.
    One rule, two gestures: click the world to look, esc to use the mouse.

## Light bridging — one sun, every material

**Nothing authors the sunlight.** The atmosphere integrates the
transmittance along the sun path on the CPU every frame; that colour *is* the
sun disc, the light on the terrain, the light on the palms and the grass rig's
`sunRadiance`. The grass reddens at dusk for the same reason the sky does, and
there is no separate sunset ramp anywhere in the codebase to drift out of sync.
Ambient is the real sky too, and it has to be the **hemisphere**, not the
zenith: `inscatter(up)` alone is one tap, and one tap cannot
describe a sky whose brightness *distribution* changes shape through the day:
at noon it is roughly even, at a low sun nearly all of it sits in the glow band
along the horizon while the zenith has already gone deep blue. So a zenith tap
under-lights the ground by several times exactly at golden hour, leaving the
sun's own deep red with nothing to balance it — which is how a beach ends up
rust-brown at sunset while looking fine at noon. Three taps instead: the zenith,
the glow band ~9° above the horizon toward the sun, and the counter-glow at
~30° away, weighted 0.42 / 0.34 / 0.24. **The weights sum to one**, so a uniform
sky reads exactly as it did before — this changes the fill's shape, not its
level, and noon is unchanged by construction. The sun-side tap has to be low:
at 25° it is already out of the glow band and hands back nearly the zenith's own
colour, which is the same mistake one step smaller. The moon's glitter path on
the water is an explicit two-lobe highlight rather than a mirror reflection of a
one-degree disc, which only ever came back as hard specks (see
[ocean/README](../ocean/README.md)).

The grass rig is authored for ACES at exposure 2.0 while the atmosphere
runs at ~0.85; ACES exposure multiplies radiance *before* the curve, so scaling
the rig's own light by `2.0 / exposure` reproduces the standalone look exactly
under the darker tone mapping. Distance haze is `atmosphere.aerial()` for
terrain, palms and water — per-channel extinction toward the sky in the view
direction, so the horizon matches because it *is* the sky.

## Night — the moon is a light, and the display has no toe

A moonlit world rendered *correctly* looks dead, for three separate reasons.

**The moon needs a direction.** A flat ambient floor (`moonFill`)
lifts the land off black and leaves it **shapeless** — every slope the same
value, the whole island one silhouette. That is what "the night is dull" turns
out to mean most of the time. So the rig carries `moonRad` from `moonDir` as
well: the same shape as the sun's term, one stop softer in the wrap
(`smoothstep(-0.35, 1)`, because at this level the terminator is all the eye has
and a hard one reads as a cut-out), and no shadow map — a cast shadow at this
radiance is below the noise floor and would cost a second bake. The terrain, the
palms, the wood and the airborne leaves all take it. The blades take their own
`moonRadiance`, because a blade is thin enough that its hemisphere *is* its
lighting after dark, and a dark green albedo under a dim **warm** afternoon
hemisphere is black — the hemisphere has to turn blue at night as well as rise.
The sea rides `bodyLight`'s moon term.

**The display's dark end is a straight line and the eye's is not.** sRGB's toe
is linear: a surface at a thousandth of daylight comes out at one code value,
which is black. A power curve under one is the compression the eye actually
applies, and it belongs *once*, where tone mapping already lives, rather than in
every land shader — `renderer.library.addToneMapping(...)` with a custom
constant, wrapping three's own ACES rather than replacing it, since ACES is what
the whole project's daylight is graded against. `pow` with a pivot at 0.5 leaves
mid-tones alone and lifts a thousandth by four stops. It is gated on the sun
being 8° down, past civil twilight, so the sunset the sky module is tuned for
never sees it.

**Rods carry no colour.** Lifting the darks and leaving them their hue gives a
grey-green world at low level, which is exactly what an *overcast afternoon*
looks like — a beach reads as a dull day, not as moonlight. So the dim end of a
night frame drains toward blue-grey, and the amount depends on **level**:
anything bright enough to still work the cones keeps its hue. That last part is
the whole point — applied flat, the stars, the moon and the galaxy go grey along
with the sand. The same shift is why the sand takes only 42% of the moon's key
in `island.js`: a beach three times the turf's brightness at noon comes much
closer to it after dark, and rendered photopically it is the only thing in the
frame.

Measured at 01:00 with the moon up: turf 10, blades 18,
sand 58 (sRGB code values, green channel). Daylight is unchanged to within
a couple of code values, which is the check that matters.

## Measured cost (Apple M-series, 1280×760 @ dpr 1.5)

Everything on: GPU compute ~0.9–3.5 ms (18 FFT submits + 2 grass dispatches +
the sky LUT / shadow march when the sun moves) + GPU render ~4–11 ms at ~120 fps
(display-limited). The terrain mesh is 768²-segment static geometry (~2.6 m
quads — coarser and the erosion channels never reach the silhouette, finer and
most triangles are sub-pixel). The ~120 merged palms are a single draw, and so
are the ~50 gulls (6.4k triangles, flown entirely in the vertex stage) and the
villa (~51k over ~1 600 parts — the building and its furnishings,
plus its own shadow pass inside 150 m). The ash wood is the one thing here big enough to need
splitting: 430 trees is ~8.6M triangles, bucketed into a 170 m grid so three's
frustum culling submits only the buckets in view — measured, ~1.3M of it from
inside the wood at 87–119 fps. The ~2 700 flowers are 55 more instanced draws
and ~360k triangles, ~1 ms. The surf-foam field is one 640² compute dispatch at
30 Hz — ~0.5 ms averaged over a 120 fps frame — and the aurora is one 512×160
bake folded into the sky LUT the atmosphere already runs, so a night with
curtains costs the same as a night without them everywhere except the bake.
The 129 000 drifting leaves are one more draw and cost ~0.4 ms: they are
pinned to the trees rather than to the lens, so the whole island's worth is
submitted every frame, but a faded one collapses to a point in the vertex
stage and never reaches a fragment.

The two figures are built at boot — a face atlas rasterised out of SVG plus a
skinned body each — and that whole stage measures ~20 ms of a ~1.2 s boot. Only
one is in the scene graph at a time; a hidden one costs nothing per frame, and
the visible one is ~22k triangles across seven draws with an 18-bone mixer, which
does not move the frame time.

Night costs the same as day, which is not free by accident: the star lattices
and the galaxy are ~30 hashes per pixel and they run for every *water* pixel
too, since a reflection ray calls the same `sample()`. Sin-free hashing brought
the night premium from 4.4 ms to 0.2 ms — see [sky/README](../sky/README.md).
The scotopic tone curve is two extra instructions on the output and does not
move the number.

Standing in the meadow the grass renders ~320k blades / ~1.4M triangles, and
it is the dominant cost by a wide margin: toggling `woods + house` off
moves the frame by ~2 ms, hiding the grass tile by ~8. Both are layer toggles
in the panel, and `grassOverrides` in [config.js](./config.js) is where to
trade density for frame time.

**Boot is staged, and the stages are measured.** `[boot]` in the console prints
the whole ladder every time; the figures below are from one machine and are here
to show the shape, not the absolute numbers.

Two thirds of the boot is work the opening shot
cannot see — the wood (430 trees of CPU-grown geometry, ~1.0 s) and the house
(~1 600 parts, ~2.3 s) — while the shot itself is the beach at golden hour
looking out to sea, with the wood over the ridge behind you and the house a
kilometre inland. Both are built **after the first frame is presented**, so the
renderer is already running — and the opening shot's pipelines are already
compiling — while they are made. Everything downstream tolerates their absence:
three guards and a build function, a cheaper contract than it looks, and one the
villa already needed since it is a self-contained subsystem allowed to fail on
its own.

What they are *not* allowed to do is happen in front of the player: a world
that appears and then stops answering the mouse for a second and a half reads
as a hang, not as a load. So the boot screen stays
up through them and the world is handed over when it is genuinely finished.

The 1024² macro synthesis is the largest single item. Two
free wins: `c1`/`c2` are each evaluated once per texel, not twice, and
`h4` once, not three times, and the ridged massif field — which does not depend on which
peak is being accumulated — is evaluated once, not once *per peak*. At a million
texels a duplicated octave is a million extra lattice fetches.

Time to a running world is ~2.0 s:

```
   783 ms  synthesis          164 ms  fields
   238 ms  eroding            120 ms  grass
   169 ms  packing            114 ms  shore distance
                              ~250 ms  everything else
```

with the wood and the house arriving ~2.6 s later, off the clock.

Two things about the loading screen, which are presentation rather than
performance:

- One long synchronous stretch between awaits never lets the
  browser paint, and every progress line written is
  overwritten before it is ever seen. `stage()` yields one animation frame. It
  costs a frame per stage and is the whole difference between a page that looks
  busy and one that looks hung.
- The bar is weighted by **measured** stage cost, not by stage count. An even
  bar is worse than none here: the wood and the house together are longer than
  the eighteen stages before them, so it would crawl to 90% and then sit there
  for two seconds — which is exactly the "is it stuck?" the bar exists to
  answer. And the sweep that runs along it animates `transform` and nothing
  else, because that runs on the compositor: a bar animating `width` or
  `background-position` freezes with the main thread, at precisely the moment
  the page most needs to look alive.

One perf trap worth recording: the sky's cloud and star layers are ~120 hash
evaluations, and calling the full sky function twice per water
pixel alone costs 34 ms/frame. Gating both layers behind an `If` and giving
the rim fade the cheap LUT-only path takes it to 8 ms.
