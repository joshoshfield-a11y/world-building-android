// Single source of truth for the whole ocean. Sealed after creation — the GUI
// mutates values, never the shape. Anything that changes spectrum shape gets
// re-baked into h0 by OceanSim.updateSpectrum(); everything else is a live uniform.

function deepSeal( o ) {

	for ( const k of Object.keys( o ) ) {

		if ( o[ k ] && typeof o[ k ] === 'object' ) deepSeal( o[ k ] );

	}

	return Object.seal( o );

}

export const config = deepSeal( {

	sim: {
		size: ( globalThis.__WORLD_TIER__ === 'low' ? 128 : globalThis.__WORLD_TIER__ === 'medium' ? 192 : 256 ),                     // N — grid resolution per cascade (256 or 512)
		// Metres per cascade patch. The largest one is the whole sea's period —
		// it has to be several times the longest wave we ask for, or the swell
		// cannot exist and the wind sea has too few modes near its peak to form
		// groups, and the ocean comes out a uniform quilt repeating every patch.
		// Each patch must also resolve its own shortest wave: the band ends at
		// lengthScales[i+1] / boundaryFactor, which has to stay above the patch
		// Nyquist 2·lengthScales[i]/size.
		lengthScales: [ 1000, 80, 7 ],
		boundaryFactor: 6,             // wavenumber band boundary multiplier
		timeScale: 1.0,
		paused: false,
	},

	waves: {
		g: 9.81,
		depth: 500,                    // metres
		lambda: 1.3,                   // horizontal displacement (choppiness)

		local: {                       // wind sea
			scale: 1.0,
			windSpeed: 9,              // m/s
			windDirection: 45,         // degrees
			fetch: 100000,             // metres
			spreadBlend: 0.9,
			swell: 0.2,
			peakEnhancement: 3.3,      // JONSWAP gamma
			shortWavesFade: 0.01,
		},

		swell: {                       // long rollers from a distant storm
			scale: 0.12,
			windSpeed: 14,             // the storm's wind, not the local one
			windDirection: 70,
			fetch: 800000,             // ~280 m peak wavelength: what breaks on a beach
			spreadBlend: 1.0,
			swell: 1.0,
			peakEnhancement: 3.3,
			shortWavesFade: 0.01,
		},
	},

	foam: {
		threshold: 0.4,
		scale: 2.5,
		decay: 0.4,
		// the surf zone's memory (../ocean/breaker-foam.js). `life` is the 1/e
		// fade of a band of whitewater in seconds, `drift` how fast it runs up
		// the bed in m/s, `reach` how far out to sea the field is carried.
		life: 6.0,
		drift: 3.2,
		reach: 90,
	},

	shading: {
		deepColor: 0x0a2432,      // what the water body settles to below ~20 m
		scatterColor: 0x2f7d6d,   // upwelling scatter of a sunlit shallow column
		foamColor: 0xe9efe6,      // warm off-white foam
		seabed: 0x8a7d64,         // wet sand under the shallows — matched to the
		                          // beach it continues, so the waterline has no seam
		detail: 0.1,              // sub-grid normal perturbation strength
		sssStrength: 0.55,
		// Beer–Lambert extinction of sea water, per metre per channel: red is
		// gone within a couple of metres and blue runs for tens. This one line
		// is what makes shallows turquoise and depth navy.
		absorb: [ 0.42, 0.085, 0.033 ],
		caustics: 0.9,            // wave-focused light on the seabed
	},

	// ---- day-night atmosphere (shared implementation: ../sky/atmosphere.js)

	time: {
		hour: 23.2,
		autoPlay: true,
		speed: 0.035,             // hours of sky time per real second
	},

	sun: {
		maxElevation: 58,
		discRadius: 0.9,
	},

	moon: {
		offsetHours: 11.0,
		maxElevation: 54,
		angularRadius: 1.3,
		brightness: 1.0,
		// The moon's regolith is a dark neutral grey and photographs near white
		// against a black sky — but nobody has ever *looked* at one and called it
		// white. Every metre of air it is seen through takes the blue out, and the
		// eye's night response takes the rest, so the remembered moon is cream.
		// This tint is the disc, its corona and the glitter path on the water, so
		// they cannot drift apart.
		tint: [ 1.00, 0.87, 0.62 ],
		// how hard the moon writes its glitter path onto the sea
		seaGlint: 1.0,
	},

	atmosphere: {
		turbidity: 2.4,
		rayleigh: 1.15,
		mieCoefficient: 0.0032,
		mieDirectionalG: 0.8,
		exposure: 0.85,
	},

	sky: {
		intensity: 28,        // solar irradiance driving the scattering integral
		haze: 1.0,            // aerial-perspective aerosol multiplier
	},

	stars: {
		density: 0.984,
		brightness: 1.5,
	},

	// The aurora. `intensity` 0 turns the march off entirely — it is not a fade,
	// the compute pass is skipped — so a world that does not want one pays
	// nothing for it.
	aurora: {
		intensity: 1.0,
		speed: 0.65,
		seed: 19.6,
		colorBase: '#b026ff',
		colorHigh: '#ffd166',
	},

	clouds: {
		coverage: 0.38,
		scale: 1.0,
		speed: 1.0,
		opacity: 0.9,
	},

} );
