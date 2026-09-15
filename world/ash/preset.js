// The ash species table, plus the variants this island plants.
//
// The numbers in `ashMedium` are a contract, not suggestions: the uneven
// angles, the per-level child counts and the 0.23/0.33 emergence starts are
// the species identity. Reproduce them before tuning anything; any divergence
// belongs in the recorded-divergences note below.

export const ashMedium = {
	seed: 36330,
	branchLevels: 3,
	bark: { tint: 13552830, textureScaleX: 0.5, textureScaleY: 5 },
	branch: {
		angle: [ 0, 48, 75, 60 ],
		children: [ 7, 4, 3, 0 ],
		forceDirection: [ 0, 1, 0 ],
		forceStrength: 0.01,
		gnarliness: [ 0.03, 0.25, 0.2, 0.09 ],
		length: [ 43.47, 27.14, 9.51, 4.6 ],
		radius: [ 2, 0.63, 0.76, 0.7 ],
		sections: [ 12, 8, 6, 4 ],
		segments: [ 12, 6, 4, 3 ],
		start: [ 0, 0.23, 0.33, 0 ],
		taper: [ 0.7, 0.7, 0.7, 0.7 ],
		twist: [ 0.09, - 0.07, 0, 0 ],
	},
	leaves: { angle: 55, count: 16, start: 0, size: 2.67, sizeVariance: 0.72, alphaTest: 0.5 },
};

// ---------------------------------------------------------------------------
// Recorded divergences: none in the table.
//
// The contract ash is a specimen tree on its own. This is a wood
// of 430 of them on an island that also carries an FFT ocean, a quarter of a
// million grass blades and a 1 600-part house, and the contract costs ~17.7k
// triangles a tree — 8.6 M for the whole wood. The obvious saving is
// `leaves.count`, and it is not worth taking: 8.6 M is the number *before*
// culling and the wood is
// never all on screen at once, the frustum leaves ~1.3 M of it visible, and
// nothing is gained between 11 and 16. Thinning the canopy costs silhouette
// for nothing, so the species table below stands unaltered — level
// table, continuation branch, emergence starts, the 55° leaf tilt, the ±0.72
// size variance, and the double perpendicular card, which is the cheap-looking
// saving and the wrong one (a single card per leaf makes the canopy flicker as
// it turns).
//
// What this world *does* change is everything around the table: one merged
// geometry instead of two, bark coordinates in metres rather than ring indices,
// per-vertex wind attributes and a crown bound for occlusion. Those are in
// ./tree-system.js, at the head of the file.
// ---------------------------------------------------------------------------

const woodLeaves = { ...ashMedium.leaves };

// Five trees, not one repeated. A wood of one clone is instantly readable as
// one clone however you rotate it, and the cheapest fix is the seed: the
// species table stays fixed and the RNG walks a different path through it, so
// every variant is the same species and a different tree. The heights spread
// the same way a stand does — a couple of emergents, most of them mid-storey.
export const woodVariants = [
	{ seed: 36330, height: 19.5 },
	{ seed: 51207, height: 16.0 },
	{ seed: 8891, height: 14.2 },
	{ seed: 74413, height: 17.8 },
	{ seed: 22056, height: 12.6 },
].map( ( v ) => ( {
	height: v.height,
	preset: { ...ashMedium, seed: v.seed, leaves: woodLeaves },
} ) );
