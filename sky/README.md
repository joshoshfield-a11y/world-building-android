# Sky — day-night atmosphere with a realistic sun and moon

One TSL direction→colour function drives everything: the scene background and
the mirror-lake reflection sample the identical atmosphere, so they can never
disagree. Three.js `WebGPURenderer` + TSL only; static ES modules, no build
step. Serve the parent folder and open `sky/index.html` (needs WebGPU).

Drag the **hour** slider (0–24) or let the cycle auto-play.

## What is in the sky

- **Daylight — a scattering integral, not a fit.** A compute pass ray-marches
  Rayleigh + Mie single scattering through a spherical atmosphere (16 primary
  × 6 secondary samples) and stores the result in a **512 × 160 LUT** indexed
  by view direction, elevation sqrt-warped so half the rows sit within 20° of
  the horizon. Secondary rays are **earth-shadow tested**, which is what makes
  twilight real: the lower air goes dark while the upper air is still lit, so
  the belt of Venus and the long red horizon happen on their own. A small
  phase-free share of the same integral is folded back in as cheap multiple
  scattering — single scatter alone leaves the twilight zenith brown instead
  of blue.

  Baking is what makes it affordable. The background, every water reflection
  and the aerial perspective on the land all want the sky in some direction;
  as an integral that is ~130 `exp()` per query, as a LUT it is one bilinear
  fetch. The march re-runs only when the sun has moved.
- **Aerial perspective** — `aerial(colour, worldPos, cameraPos)` applies
  per-channel extinction toward the in-scatter in the *view* direction, with
  the haze thinning by altitude. Distance goes blue at noon and amber at
  sunset, and the horizon matches the sky exactly because it *is* the sky.
  This is what other scenes use instead of a fog colour.
- **Clouds** — an fbm slab on a curved shell (1/y pulled in by a quadratic so
  the layer converges at the horizon), eroded by a finer octave for
  cauliflower edges, and lit by marching the same noise up-sun: Beer
  transmittance plus a powder term, an HG silver lining, and ambient taken
  from the sky the cloud actually sits in — so a low cloud over a burning
  horizon is lit orange from below. Low clouds dissolve into the horizon
  haze. The whole block sits behind a branch: clear sky costs nothing.
- **The sun** — a true angular disc whose radiance *is* the sun-path
  transmittance, integrated on the CPU each frame (24 steps, ~nothing). It
  reddens and dims through exactly the same physics that reddens the sky, and
  the same value lights every material in the composed world — there is no
  separate sunset ramp anywhere in the codebase. Angular radius is
  configurable (`sun.discRadius`, default 0.9° — slightly cinematic vs the
  real 0.27°). Elevation/azimuth follow a simple solar arc from the hour
  (rise 06:00 east, set 18:00 west; noon altitude on the panel).

  **The shoulder, and why the disc is composited last.** A sunset is the one
  time of day when the brightest thing in frame is also the most saturated,
  and ACES cannot have both — it desaturates toward white as a channel runs
  past 1, which is exactly what makes it filmic everywhere else. Measured
  three degrees above the horizon, the sky ran (8.0, 5.0, 2.4): red four times
  over the knee while blue was still on the curve, rendering (255, 247, 229).
  The physics was producing a deep amber and the tone curve was painting it
  cream — over most of the frame, because the whole sky sat between 1.4 and 8
  and the curve maps all of that into its top two percent.

  So the sky carries a shoulder of its own, before the renderer's: the triple
  is scaled by a single factor taken from its brightest channel, which
  compresses the range without touching the ratios, so hue survives by
  construction. The same (8.0, 5.0, 2.4) leaves as (4.3, 2.7, 1.3) and renders
  amber; clipping across the frame drops from 4% to under 1%. It lives in the
  atmosphere rather than in the renderer's exposure because it has to apply to
  the sky and nothing else — the land at sunset is *supposed* to be dark, and
  pulling the whole frame down is how a sunset becomes a grey evening. What
  everything outside the module sees (`inscatter`, for aerial perspective and
  reflections) is shouldered; `sample` and `distantSea` compose from the raw
  LUT and shoulder once at the end, so nothing is compressed twice.

  The disc then goes on top of that, last, because it can be on neither side
  of the shoulder as it stands. Under it, the disc flattens into the horizon
  it sits on and the sun vanishes at exactly the hour you most want to see it.
  Before it, borrowing `sky.intensity` for its brightness — and those are not
  the same quantity — it sits four times over the top of the
  curve at every hour of the day, which is a white dot whatever colour the
  physics says it is. So: the disc keeps `sunColor`'s *hue* and takes its
  brightness from the shoulder's own ceiling, pinned just above it. A fixed
  gain cannot work at both ends of the day — too low and the disc goes *darker*
  than the sky behind it as the red channel collapses, rendering the sun as a
  notch cut out of its own sunset. Pinned to the ceiling it is always the
  brightest thing in frame and always the colour the transmittance says:
  white at noon (255, 248, 240), gold at 17:50 (255, 240, 209), deep orange in
  the last minutes (255, 226, 158) against a (243, 160, 65) horizon. The
  aureole around it is the one term that *does* carry the raw attenuation —
  glare is scattered sunlight, and it is what genuinely dies as the sun
  reddens, which is why you can look at a setting sun and not at a noon one.
- **The moon — geometric phase.** The moon is a sphere: for every pixel of the
  disc the surface normal is reconstructed and lit by the *actual* sun
  direction, plus earthshine and two octaves of maria mottling. Full, gibbous,
  quarter and crescent — and the terminator's orientation — are therefore
  consequences of where the sun really is, never a painted texture. The
  `phase offset (h)` slider moves the moon along its own arc relative to the
  sun, which is what sets the phase (12 h ≈ full, 3 h ≈ crescent). The disc
  passes through the same extinction as the sun, so a rising moon comes up
  amber. Apparent size defaults slightly cinematic (1.3° vs the real 0.26°).

  Its colour is one config value (`moon.tint`, default cream) shared by the
  disc, its corona, the aureole and the glitter path on the sea, so the four
  cannot drift apart. Near-white is what a photograph of the moon looks like,
  and not what anyone has ever seen looking up: the
  regolith is a dark neutral grey, and every metre of air it is seen through
  plus the eye's own night response take the blue out of it.
- **Moonlit nights** — the same in-scattering runs a second, faint, cooler
  pass driven by the moon (scaled by its lit fraction), so a full-moon night
  is deep blue while a new-moon night is black. That pass stays blue however
  warm the moon is set, because Rayleigh scattering is blue whatever colour
  goes into it — which is exactly why a moonlit night reads cold while the moon
  standing in it reads warm.

  Close in it is Mie, not Rayleigh: a warm **aureole** carrying the moon's own
  colour, forward-scattered off the same haze that rings the sun and gone
  within a few degrees of the disc. Without it a warm moon sits inside a cold
  halo and reads as a sticker pasted on the sky.
- **Stars** — four lattices on the celestial sphere, coarse-and-bright through
  fine-and-faint, rotating with the hour, faded in as the sun drops and dimmed
  by the same extinction: stars redden and vanish into the horizon like the sun
  does. See *The night sky* below for why it is four and not one.
- **The Galaxy** — a band in its own fixed galactic frame, so it turns with the
  stars it belongs to rather than being painted on the lens. Gaussian across,
  brightest toward the centre, with a warm bulge and a dark rift wandering
  along it.
- **The lake** — a still mirror with analytic ripple that decays with
  distance (far water is a true mirror, so the regular ripple pattern can
  never band at grazing angles). Reflection ray clamped just above the
  horizon; fresnel blend to a dark water body.

The camera's polar clamp is recomputed every frame from the orbit radius so
you can pitch all the way up to the zenith without the camera ever dipping
below the water.

## The night sky

The night sky is not one hashed lattice on the sphere — about 1.6% of cells
carrying a white dot, which reads as *static*. A real night sky is not a
uniform scatter of identical points. It is a **magnitude distribution** (a
handful you could name, a few hundred you can see, a haze of thousands you
cannot resolve), the points are **coloured**, and above all there is a **galaxy
lying across it**.

Four lattices at different cell sizes give the magnitudes: the coarse ones
carry a few bright stars with a visible halo, the fine ones a dust of
pinpricks. Cell size is in radians of sky, and the two corrections that make a
lattice on (θ, φ) behave like a sphere are worth naming, because without them
the poles are a knot — the local coordinate is scaled by sin θ so a cell is
square rather than a sliver, and each star survives with probability sin θ,
because the lattice packs 1/sin θ too many cells per steradian up there.

Three things separate that from a field of soft dots, and all three are easy
to get wrong:

- **A star is a point with a glow, not a ball.** One exponential cannot be
  both. At a tightness that gives a visible halo, a magnitude-5 star's disc runs
  to eighteen pixels and the sky fills with round fuzzy blobs — bokeh, not
  stars. Two terms, a tight core and a wide faint halo at 5% of it, cost one
  extra `exp` and separate the two jobs.
- **Magnitudes have to be steep.** `pow(h, 5)` puts one star in twenty above
  half brightness and leaves the rest as pinpricks. That is the actual
  distribution: a sky is a few dozen stars you could name and several thousand
  you could not. It also wants its own hash — sharing the jitter's draw ties a
  star's brightness to where in its cell it sits, and that is a faint diagonal
  order running through the whole field once you have seen it.
- **Star fields clump.** One star per cell means no cell holds two and none is
  empty across a run: the spacing has a floor *and* a ceiling, and the eye reads
  that regularity as a grid however hard the jitter works. A single slow noise,
  shared by all four lattices, crowds some regions and thins others. Take it off
  the direction vector, not off (θ, φ) — φ wraps at ±π and any noise on it draws
  a seam down the sky.

And the stars know where the Galaxy is. The band's own latitude thins the plain
sky and crowds the band, hardest on the faint lattices, because what the Milky
Way is made of is stars too faint to pick out singly. Written as a *keep*
probability rather than a rejection threshold, which is not cosmetic: as a
threshold the faint lattices sat at 98% kept — saturated, with no headroom left
for the one part of the sky that should be crowded.

The Galaxy is a band in a galactic frame fixed inside the celestial one: a
Gaussian profile across it, a longitude falloff away from the centre, a warm
bulge, a dark Great Rift that wanders along it, and fbm clouds inside. The
clouds go through a contrast curve before they are used and take the band's
colour with them: raw fBm has a Gaussian-ish histogram, so most of it sits near
the middle and the band comes out an even wash with a gentle mottle. A
photograph is the opposite — bright star clouds and near-black dust between
them, warm where the dust is and cool where the stars are, because a dark lane
is dust reddening what comes through it rather than an absence of light. Two
mistakes are worth avoiding:

- **Measure both axes in the same unit.** Measuring across the band in
  sin(latitude) and along it in longitude makes the noise domain ~5× finer
  across than along, and the clouds come out as long thin streaks parallel to
  the band — which reads as contrails, or as an aurora, but never as the
  Galaxy. Radians in both axes, and the structure is blobs, the way it is in
  every photograph.
- **Rotate every octave.** Value noise lives on an integer lattice, so its
  extrema sit on a grid. Three unrotated octaves at high contrast, plus a ±0.5
  grain on top, and the eye finds that grid instantly: the band came out
  visibly *quilted*, little squares of light about a degree across, looking
  exactly like compression blocking. Turning each octave by an irrational-ish
  angle keeps the statistics and removes the axis to lock onto.

One performance note, because it was worth 4 ms: the night sky is thirty-odd
hashes per pixel, and it runs for every *water* pixel too, since `sample()` is
what a reflection ray calls. The module's general `hash2` spends a `sin` on each
— a transcendental at quarter rate — so the night sky uses a sin-free hash
instead, local to itself so the moon's maria and the cloud field
keep the pattern they were tuned with. Night is 0.2 ms more expensive than day
instead of 4.4 ms.

The construction is layered lattices in spherical coordinates with a galaxy
built as a band times an fbm. Two choices matter most. The galaxy is in the
celestial frame rather than in screen space, so it turns with the stars it
belongs to instead of being painted on the lens. And star colour is a
three-anchor ramp rather than a blackbody fit — at two pixels across, the
accuracy of any one star is worth nothing and the *spread* is worth everything.

## Gotcha: the sky below the horizon

The honest answer for a downward ray is "a short path into the ground", which
is dark — and only correct if you actually model the ground. Any scene whose
water patch stops a few kilometres out then gets a hard black ring drawn around
it at the patch edge. `inscatter()` therefore clamps the lookup at the horizon,
which is right for aerial perspective (the direction there is a view ray to
nearby geometry) but is not an answer for what is *behind* everything.

Clamping alone just trades a black ring for a flat one. Every ray between the
true horizon and the edge of the water returns the same frozen colour, and from
600 m up that wedge is 9° of screen: a light band lying across the sky with a
hard edge along its top, exactly where the clamp starts. So `distantSea()`
answers those rays properly. At grazing angles water is a mirror, so a down-ray
shows **the sky it reflects**, hazed over the range it crossed to get there —
`eyeHeight / |dir.y|`, which runs to infinity as the ray flattens. The two
hemispheres therefore meet exactly at the horizon with nothing to blend, from
any altitude. The water patch's own rim fade calls the same function, so the
seam at the patch edge disappears too.

It lives in `background()` rather than in `sample()` because `sample()` is also
what every water pixel calls for its reflection — always an upward ray — and a
branch carrying two more texture fetches costs that path whether it is taken or
not (≈3 ms/frame when it was inside).

## Measured cost (Apple M-series, 1280×720 @ dpr 1.5)

GPU ≈ 3–6 ms total at ~120 fps (display-limited). The LUT bake is 82k threads ×
~130 exp() and re-runs only when the sun moves; each sky query afterwards is one
texture fetch plus the analytic sun/moon/star/cloud layer.
