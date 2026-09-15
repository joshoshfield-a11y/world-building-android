// Single source of truth. Sealed after creation — the GUI mutates values,
// never the shape. Everything here is uniform-backed and applies live.

function deepSeal( o ) {

	for ( const k of Object.keys( o ) ) {

		if ( o[ k ] && typeof o[ k ] === 'object' ) deepSeal( o[ k ] );

	}

	return Object.seal( o );

}

export const config = deepSeal( {

	time: {
		hour: 16.9,           // 0–24 — the control
		autoPlay: true,
		speed: 0.035,         // hours of sky time per real second (~11 min/day)
	},

	sun: {
		maxElevation: 62,     // solar noon altitude, degrees
		discRadius: 0.9,      // apparent radius, degrees — real is 0.27; bigger reads as the remembered sun
	},

	moon: {
		offsetHours: 11.0,    // hours behind the sun — sets the phase geometrically
		maxElevation: 54,
		angularRadius: 1.3,   // degrees (real moon is 0.26°; slightly cinematic)
		brightness: 1.0,
		// The disc, its corona and the glitter path all read this, so they cannot
		// drift apart. It was missing here while `ocean/config.js` carried it, and
		// `makeAtmosphere` spreads it — `...config.moon.tint` — so the standalone
		// sky page threw before its first frame while the composed world, which
		// builds the atmosphere from the ocean config, was fine.
		tint: [ 1.00, 0.87, 0.62 ],
	},

	atmosphere: {
		turbidity: 2.2,
		rayleigh: 1.15,
		mieCoefficient: 0.0032,
		mieDirectionalG: 0.8,
		exposure: 0.62,
	},

	sky: {
		intensity: 28,        // solar irradiance driving the scattering integral
		haze: 1.0,            // aerial-perspective aerosol multiplier
	},

	stars: {
		density: 0.984,       // sparsity — higher = fewer stars, 0.984 is the tuned look
		brightness: 1.5,
	},

	// The aurora. `intensity` 0 turns the march off entirely — it is not a fade,
	// the compute pass is skipped — so a world that does not want one pays
	// nothing for it.
	aurora: {
		intensity: 1.0,
		speed: 0.65,
		seed: 19.6,
		colorBase: '#59ff03',
		colorHigh: '#00aaff',
	},

	clouds: {
		coverage: 0.38,       // 0 = clear sky, ~0.7 = broken cover
		scale: 1.0,           // fbm feature size
		speed: 1.0,           // drift rate
		opacity: 0.9,
	},

	water: {
		ripple: 0.04,         // mirror-lake normal perturbation
	},

} );
