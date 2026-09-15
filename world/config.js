// World composition config — the layer toggles and the landmass parameters.
// Ocean, grass and sky keep their own configs (imported per page); this file
// only owns what exists because the scenes are combined.

function deepSeal( o ) {

	for ( const k of Object.keys( o ) ) {

		if ( o[ k ] && typeof o[ k ] === 'object' ) deepSeal( o[ k ] );

	}

	return Object.seal( o );

}

export const world = deepSeal( {

	layers: {
		ocean: true,      // FFT ocean ↔ calm mirror sea
		island: true,     // landmass + grass + player + palms
		birds: true,      // gulls working the surf line
		woods: true,      // the interior — the ash wood, drifting leaves, homestead
		flowers: true,    // meadow patches
	},

	land: {
		worldScale: 2200, // metres the terrain map spans (land centred inside)
		heightSpan: 340,  // R-channel encode range — must cover the tallest ridge
		seaFloor: - 22,   // the seabed skirt bottoms out here
		meshSpan: 2000,   // visible terrain mesh extent (sea floor beyond is deep)
		sandTop: 3.3,     // beach → meadow transition height
		wadeDepth: 0.55,  // the player can wade this deep before the sea stops them
		treeLine: 190,    // grass gives out to rock above this
		// The opening shot, in one place: where the player stands, and where the
		// lens sits relative to them. The palm scatter keeps a corridor clear
		// between the two, because clearing only the player's feet still leaves
		// the grove growing over the lens, and a grove over the lens is not a
		// grove, it is a curtain.
		// 别墅前那片草坡：海在左、房子在右上，人物站在齐腰高的草里。
		spawn: [ - 297.8, - 143.4 ],
		spawnEye: [ - 8, 4.6, 8.9 ],
		spawnClear: 13,
	},

	birds: {
		count: 52,        // gulls in the air
		groups: 9,        // circles they share — gulls wheel in loose company
	},

	// Who you play as. The character generator is entirely seed-driven — no
	// meshes, no textures, no files — so a character is one integer and nothing
	// else. `seed` is that integer, handed to `makeDna`
	// as it stands; `grid` beside it is only a label.
	//
	// Height is in metres and is not read as a person's height: chibi
	// proportions put a third of the body in the head, so the figure reads about
	// half as tall as the number says. 3.1 m is what it takes for the character
	// to hold the frame against this island — the meadow blades alone are waist
	// high, the palms are twenty metres, and at a realistic 1.55 m the protagonist
	// was a detail in a landscape rather than the thing the landscape is for.
	actors: [
		{ name: 'Pim', seed: 8460, grid: 4, height: 3.1 },
		{ name: 'Juno', seed: 9115, grid: 9, height: 3.1 },
	],

	trees: {
		// The scatter is area-limited, not count-limited: palms only take the
		// coastal band under 17 m, and the grove noise confines them to about
		// half of that. This is roughly what the island can actually hold at
		// `spacing` — asking for more only burns rejection samples.
		count: 160,
		spacing: 6.5,     // min distance between palms (m)
		inlandFraction: 0.14,
	},

	// the interior woodland — broadleaves with a clear bole, not palms
	grove: {
		count: 430,
		// `spacing` is the *baseline* minimum between trunks; the scatter scales
		// it from ~11 m in thin ground down to ~4.5 m inside a stand. A flat
		// minimum everywhere gives an orchard however the stand noise is tuned.
		spacing: 7.5,
		// Leaves in the air *per tree*, shed from that tree's own crown — not a
		// field around the camera, which is what it was and which read as
		// weather rather than as shedding. The wood is open — about 400 m² of
		// ground to a tree — so a per-tree count has to be generous to fill the
		// air the way a camera-following box did: 300 in flight over a ~20 s
		// fall is a leaf leaving each crown every 70 ms. With 430 trees that is
		// 129 000 quads, and because they are pinned to the island rather than
		// to the lens, the far ones collapse to a point in the vertex stage.
		leavesPerTree: 300,
	},

	// Flowers, in patches rather than everywhere. `patches` is how many places
	// on the island grow them; `perPatch` is how many candidates each one tries,
	// of which the organic keep-field keeps roughly half — so the real
	// count lands near patches × perPatch × 0.5, plus five around the house.
	flowers: {
		patches: 34,
		perPatch: 300,
		radius: 11,
	},

	// The house — Villa Ravine — on a levelled
	// shelf the bake picks out of the terrain itself. The pad has to hold the
	// whole footprint including the terraces (about 21 x 18 m, centred a little
	// forward of the building), or the south terrace ends up cantilevered over
	// a hillside.
	homestead: {
		enabled: true,
		// The villa is authored at a scale where it is 23 m across
		// and 10.8 m tall — a house for a 1.7 m person, six storeys' worth of
		// figure to the ridge. Standing a 3.1 m protagonist next to it makes it
		// a doll's house: the figure's head reaches the ground-floor ceiling.
		// This puts the ratio back where a person-to-house ratio belongs, and
		// everything that has a size in metres — the levelled pad below, the
		// shadow box, the light rig — is derived from it rather than restated.
		//
		// 1.75 was the arithmetic answer and it is not the right one. It makes
		// the *building* correct against a 3.1 m figure — 3.1/1.7 is 1.82, so
		// 1.75 is within a hand's breadth of a literal match — and the interior
		// still reads tight, because a room is not judged by the ratio a tape
		// measure gives. This protagonist is a stylised figure: a third of its
		// height is head, its eye sits at 2.40 m rather than the 2.9 m a real
		// body of that height would have, and the eye is what the room is judged
		// from. Standing in the hall at 1.75 the eye is 42% of the way up a
		// 5.7 m room with a bookcase towering over it, and it reads as a
		// corridor. 2.10 puts 6.9 m of air overhead and moves every doorway,
		// landing and worktop with it — including the stair landing below, which
		// is why the going does not have to be cut again.
		scale: 2.10,
		// The plot, in the house's own frame **at scale 1**: half-width across
		// the front, then back and front along its axis (+ is toward the water).
		// It is a rectangle rather than a radius because the ground is cut and
		// the blades cleared to *this*, and a circular pad is a circle — the one
		// shape this island has been told twice it should not have.
		plot: [ 12.5, - 9.5, 13.5 ],
		shoreRange: [ 95, 300 ], // how far inland the site may sit (m from surf)
		shadowRange: 150,     // past this the villa's own shadow map switches off
	},

	// the grass tile follows the player (the land is far larger than one tile);
	// the terrain turf carries the green beyond blade range
	grassOverrides: {
		// Spacing is tileSize / bladesPerSide and it is the only number that
		// decides whether a meadow reads as grass or as a moth-eaten rug. The
		// standalone field is 130 m over 1024 — 12.7 cm. 288 m over the
		// same 1024 is 28 cm: the same budget spread over five times the area,
		// and hillsides go bald. 200 over 1600 is 12.5 cm, and the tile still
		// reaches a hundred metres out
		// where the terrain turf takes over.
		tileSize: 200,
		bladesPerSide: 1600,
		// ...and then it has to *keep* them. Counting the survivors out of the
		// indirect buffer is the only honest way to tune this: standing in the
		// meadow, 1.64M blades in the tile were rendering 48k. Frustum culling
		// accounts for most of that and should, but the distance thinning was
		// taking the field to 30% by 100 m — inside the tile — which is exactly
		// the middle distance a meadow is judged on. Far blades are LOD2, three
		// triangles each, so keeping them is nearly free.
		fullRadius: 30,
		falloffRadius: 104,
		farDensity: 0.85,
		// The grass demo's protagonist and this one are not the same size, so
		// the jump does not belong in `grass/config.js` where the rest of the
		// player numbers live. 5.2 m/s against g = 16 is a 0.85 m hop — 27% of
		// a 3.1 m figure's height, which is what a real person manages and
		// exactly the wrong target: the island is a 340 m volcano with a metre
		// of shore break and a terrace to hop onto, and a realistic vertical
		// leap on that reads as heavy. 7.0 clears 1.53 m — half the figure's
		// own height — with 0.9 s of air. Gravity is left alone deliberately;
		// dropping it would buy the same height as a float, and the weight of
		// the fall is most of what makes the jump feel like a jump.
		jumpSpeed: 7.0,
	},

} );
