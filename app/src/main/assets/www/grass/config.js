// Single source of truth. Sealed after creation — the GUI mutates values,
// never the shape. Uniform-backed values apply live; the rest are build-time.

function deepSeal( o ) {

	for ( const k of Object.keys( o ) ) {

		if ( o[ k ] && typeof o[ k ] === 'object' ) deepSeal( o[ k ] );

	}

	return Object.seal( o );

}

export const TILE_SIZE = 130;
const __TIER = globalThis.__WORLD_TIER__ || 'high';
export const BLADES_PER_SIDE = __TIER === 'low' ? 256 : __TIER === 'medium' ? 512 : 1024;  // mobile: 65k/262k/1M blades
export const COUNT = BLADES_PER_SIDE * BLADES_PER_SIDE; // 1,048,576
export const SPACING = TILE_SIZE / BLADES_PER_SIDE;
export const LOD_SEGMENTS = [ 8, 4, 2 ];
export const WORKGROUP_SIZE = 64;
export const BLADE_HEIGHT = 1.75;
export const BLADE_WIDTH = 0.15;
export const MIN_VISIBLE_SCALE = 0.11;
export const SCALE_PACK_MAX = 2.5;     // packing range for the 8-bit scale fields

export const config = deepSeal( {

	lod: {
		radii: [ 15, 35 ],            // metres — LOD0→1 and LOD1→2 boundaries
		debugTint: false,
	},

	thinning: {
		fullRadius: 16,               // no thinning inside this
		falloffRadius: 75,
		farDensity: 0.1,              // keep fraction at the falloff radius
		// projected blade height as a viewport fraction — follows the blade height
		// above, or a third-height blade is culled three times closer
		projMin: 0.0025,              // → keep 0
		projFull: 0.014,              // → keep 1
		hysteresis: 0.11,
	},

	wind: {
		strength: 0.32,               // base wind bend budget
		speed: 0.18,                  // gust field scroll rate
		uvScale: 0.0135,              // gust texture world scale (1/m)
		lull: 0.09,                   // wind floor between gusts
		gustCoverage: 0.6,            // fraction of the field gusting
		eddyStrength: 0.9,            // perpendicular direction wobble
		detailedRadius: 30,           // per-blade damped wind inside this
		transitionWidth: 5,           // blend band to the analytic far field
		swayAmount: 0.055,
		curveP1: 0.003,               // wind response cubic Bézier control points
		curveP2: 0.85,
		baseBending: 2.5,             // wind bend multiplier + static curl strength
		bendDrop: 1.3,                // tip drop as the blade leans
		bendControlPoint: 0.4,        // bend shape along the blade
	},

	blade: {
		// Spatial scale-noise range, in units of BLADE_HEIGHT — so this is the
		// blade's *length* in metres once multiplied by 1.75, which is not the
		// same as how tall it stands: `baseBending` lays a long blade over into
		// an arch, and a field of long arched blades is the whole reason a
		// meadow reads as soft and dense rather than as stubble.
		//
		// 0.85–2.35 — blades one and a half to four metres long — is the dense
		// look. Cutting it to 0.34–0.86 because the field "came out as bamboo"
		// treats length as height, and cutting the length that far takes the
		// overlap out of the field, and overlap *is* density. 0.52–1.30 is
		// 0.9–2.3 m of blade standing waist-deep on a 1.3 m player.
		minScale: 0.52,
		maxScale: 1.30,
		widthGainFar: 2.2,            // distant width multiplier vs aliasing
		widthGainNear: 20,            // metres, squared in shader
		widthGainFarD: 60,
		rotationRandomness: 0.05,     // random sprite roll
	},

	trample: {
		radius: 0.65,
		crushedScale: 0.15,
		downRate: 50,                 // near-instant crush
		growthRate: 1.2,              // recovery toward base scale
		bendStrength: 0.8,
	},

	color: {
		baseDark: [ 0.09, 0.15, 0.075 ],   // sRGB, converted at uniform creation
		base: [ 0.23, 0.38, 0.19 ],
		tip: [ 0.35, 0.43, 0.32 ],
		warm: [ 0.66, 0.53, 0.41 ],
		rust: [ 0.38, 0.19, 0.11 ],
		tipMixFactor: 0.4,
		variationStrength: 0.9,
		warmStrength: 0.48,
		rustStrength: 0.08,
	},

	lighting: {
		sunColor: [ 1.0, 0.79, 0.58 ],     // sRGB
		sunIntensity: 0.62,
		hemiSky: [ 0.7, 0.59, 0.52 ],
		hemiGround: [ 0.36, 0.31, 0.19 ],
		hemiIntensity: 0.38,
		bakedShadowBrightness: 0.45,
		diffuseContrast: 0.5,
		exposure: 1.15,
		highlightStrength: 0.02,
		backlightStrength: 0.13,
		rootSkyVisibility: 0.6,
		fogColor: [ 0.64, 0.6, 0.48 ],
		fogDensity: 0.0044,
	},

	ao: {
		scale: 0.5,
		rimSmoothness: 5,
		radius: 15,                   // proximity AO around the player
	},

	terrain: {
		worldScale: 400,              // metres per heightmap repeat
		heightMax: 9,
		tileSize: TILE_SIZE,          // blade tile extent — a composed scene may enlarge it
		// ...and if it does, it has to buy blades to fill it. Spacing is
		// tileSize / bladesPerSide, and spacing is the only number that decides
		// whether a meadow reads as grass or as fur with a mange: 130 m over
		// 1024 is 12.7 cm. Widening the tile alone spreads
		// the same budget over the square of the ratio.
		bladesPerSide: BLADES_PER_SIDE,
	},

	player: {
		walkSpeed: 4.5,
		sprintSpeed: 9,
		jumpSpeed: 5.2,
		gravity: 16,
	},

	sim: {
		paused: false,
	},

} );
