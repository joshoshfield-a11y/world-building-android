# World Building

Natural scenes for a world-building website, each implemented as the *real*
GPU technique a graphics programmer would recognise — Three.js
`WebGPURenderer` + TSL node shaders, compute-driven, static ES modules with no
build step.

## Run

```
python3 -m http.server 8093
```

then open <http://localhost:8093/> in a WebGPU browser
(Chrome / Edge 113+, Safari 18+).

The root page **is the world**: ocean, grass island and day-night sky
composed, with layer toggles. The individual scenes are indexed at
[`hub.html`](hub.html).

## Scenes

| scene | technique | docs |
|---|---|---|
| [`world/`](world/) | the composed world — hydraulically eroded volcanic island, depth-lit surf, palm groves, terrain cast shadows, one sun driving every material, two seed-generated playable figures, three viewpoints | [README](world/README.md) |
| [`ocean/`](ocean/) | spectral inverse-FFT water — 3 cascades over a 1 km patch, JONSWAP+TMA wind sea under a 280 m swell, Stockham butterflies, Jacobian foam, Beer–Lambert depth colour, Green's-law shoaling | [README](ocean/README.md) |
| [`grass/`](grass/) | 1,048,576 GPU-driven blades — indirect draws, firstInstance LOD trick, 2 compute dispatches | [README](grass/README.md) |
| [`sky/`](sky/) | day-night atmosphere — ray-marched Rayleigh/Mie baked to a LUT, earth-shadowed twilight, Beer/powder clouds, geometrically phase-lit moon | [README](sky/README.md) |

Each scene folder is independent and self-contained; `world/` composes the
other three. The only other shared code is `vendor/` (three.js r185 WebGPU
build, lil-gui, OrbitControls).

## Conventions for new scenes

- one folder per scene, `index.html` + ES modules, importmap pointing at `../vendor/`
- one sealed `config` object as the single source of truth, bound to a lil-gui panel
- all shaders authored as TSL node graphs — no raw WGSL/GLSL strings
- simulation state lives on the GPU; the CPU orchestrates submits only
- a README stating the algorithm, the parameters that matter, and the measured frame cost
- correctness scaffolding (validation gates, stats readbacks) built before the pretty parts
