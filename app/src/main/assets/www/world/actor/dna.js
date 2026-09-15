import { makeRng } from './rng.js';

// Palettes: soft clay skins, matte felt hair.
export const SKINS = [
  { base: '#f6ded8', ink: '#3a2b26' },
  { base: '#f7e6d2', ink: '#3a2b26' },
  { base: '#f2cfb2', ink: '#3a2823' },
  { base: '#e6b48d', ink: '#33231d' },
  { base: '#d19a6d', ink: '#2e1f19' },
  { base: '#b3784c', ink: '#241812' },
  { base: '#8d5a37', ink: '#1e1310' },
  { base: '#6d4227', ink: '#1a100c' },
];

export const HAIRS = [
  '#b0a2cf', '#a5a099', '#6b4c39', '#4a3527', '#2b2426',
  '#bd8551', '#cfb173', '#e7e0d1', '#79608e', '#c2939f',
  '#8a8c74', '#55432f', '#dcc08c', '#bcbab2',
];

export const CAPS = ['#5eb0dd', '#4f9fd0', '#7fc0e2'];

// Dusty, sun-bleached clothing so the bodies sit in the same warm palette.
export const SHIRTS = [
  '#7d93a8', '#8ba57f', '#c2795e', '#e2d7c2', '#cfa95e', '#8d7396',
  '#5f6670', '#c58f9c', '#6f9c9a', '#b0665f', '#d8c691', '#4f5f6e', '#a8a08f',
];
export const PANTS = ['#4a5460', '#5c5245', '#3f4a3e', '#6b5a49', '#4b4550', '#2f3640', '#776854'];
export const SHOES = ['#33302c', '#4a3f36', '#e2ddd2', '#5b4a52', '#2c3540'];

const HAIR_KINDS = [
  // hem levels are in head-local Y. front = fringe line, side/back = how far it drapes.
  { id: 'bob',    front: 0.30, side: -0.52, back: -0.70, flare: 0.03, thick: 0.075, w: 22 },
  { id: 'bowl',   front: 0.34, side: -0.16, back: -0.34, flare: 0.01, thick: 0.085, w: 16 },
  { id: 'crop',   front: 0.44, side: 0.02,  back: -0.14, flare: 0.0,  thick: 0.07,  w: 12 },
  { id: 'long',   front: 0.31, side: -1.45, back: -1.70, flare: 0.09, thick: 0.08,  w: 11 },
  { id: 'veil',   front: 0.27, side: -1.95, back: -2.15, flare: 0.12, thick: 0.085, w: 5 },
  { id: 'lob',    front: 0.30, side: -0.95, back: -1.12, flare: 0.06, thick: 0.078, w: 10 },
  { id: 'pixie',  front: 0.38, side: -0.34, back: -0.50, flare: 0.02, thick: 0.072, w: 12 },
  { id: 'cap',    front: 0.52, side: 0.44,  back: 0.38,  flare: 0.0,  thick: 0.055, w: 7 },
  { id: 'bald',   front: 1.10, side: 1.10,  back: 1.10,  flare: 0.0,  thick: 0.0,   w: 5 },
];

const EYES = [
  ['round', 22], ['dot', 17], ['screen', 9], ['sparkle', 9], ['wide', 8],
  ['happy', 8], ['sleepy', 7], ['angry', 7], ['line', 5], ['cross', 3], ['heart', 3],
];
const BROWS = [['none', 34], ['thin', 24], ['angry', 16], ['worried', 10], ['flat', 10], ['thick', 6]];
const MOUTHS = [['w', 18], ['line', 16], ['smile', 14], ['o', 10], ['grit', 9], ['smirk', 9], ['pout', 8], ['open', 8], ['flat', 8]];
const MARKS = [['none', 58], ['glassesRound', 6], ['glassesSquare', 5], ['plaster', 8], ['freckles', 7],
               ['mole', 6], ['blushLines', 5], ['diamond', 4], ['eyepatch', 3], ['tear', 3]];

export function makeDna(seed) {
  const r = makeRng(seed);
  const skinIdx = r.weighted([[0, 20], [1, 18], [2, 15], [3, 12], [4, 11], [5, 9], [6, 8], [7, 5]]);
  const skin = SKINS[skinIdx];

  const kind = { ...r.weighted(HAIR_KINDS.map((k) => [k, k.w])) };
  const bald = kind.id === 'bald';
  const capped = kind.id === 'cap' && r.chance(0.55);

  // head silhouette: p=2 is a sphere, p>4 heads toward a rounded cube
  const head = {
    p: r.weighted([[2.0, 34], [2.3, 22], [2.8, 18], [3.6, 16], [4.6, 10]]),
    rx: r.range(0.94, 1.06),
    ry: r.range(0.94, 1.08),
    rz: r.range(0.88, 0.98),
    taper: r.range(0.0, 0.14),     // positive = narrower chin
    bulge: r.range(0.0, 0.07),     // cheek fullness
  };

  const hair = {
    ...kind,
    bald,
    color: bald ? null : r.pick(capped ? CAPS : HAIRS),
    dipSide: kind.id === 'bob' || kind.id === 'lob' ? (r.chance(0.45) ? r.range(0.30, 0.75) : 0) : 0,
    part: r.chance(0.22) ? r.range(0.05, 0.13) : 0,
    waveAmp: capped ? 0 : r.range(0.02, 0.07) * (kind.id === 'long' || kind.id === 'veil' || kind.id === 'lob' ? 2.2 : 1),
    waveFreq: Math.round(r.range(7, 13)),
    strandAmp: capped ? 0 : r.range(0.016, 0.042),
    wavePhase: r.range(0, Math.PI * 2),
    spiky: r.chance(0.25),
    slant: r.chance(0.45) ? r.range(-0.12, 0.12) : 0,   // side-swept fringe
    ahoge: !capped && r.chance(0.2),
    band: bald || capped ? r.chance(0.55)
      : ['crop', 'pixie', 'bowl'].includes(kind.id) ? r.chance(0.10) : false,
    bandColor: r.pick(CAPS),
    capped,
  };

  const eyes = r.weighted(EYES);
  const face = {
    ink: skin.ink,
    eyes,
    wink: (eyes === 'round' || eyes === 'dot' || eyes === 'sparkle') && r.chance(0.14),
    brows: r.weighted(BROWS),
    mouth: r.weighted(MOUTHS),
    mark: r.weighted(MARKS),
    blush: r.chance(0.62),
    nose: r.weighted([['none', 62], ['dot', 22], ['line', 16]]),
    eyeGap: r.range(14.5, 19.5),
    eyeY: r.range(45, 53),
    eyeRx: r.range(6.2, 8.9),
    eyeRy: r.range(6.6, 9.8),
    mouthOff: r.range(16, 21),
    tilt: r.range(-4, 4),
    side: r.chance(0.5) ? 1 : -1,   // which side asymmetric marks land on
  };
  // keep the sticker inside the visible front of the head
  face.scale = r.range(2.30, 2.58);

  const shirt = r.pick(SHIRTS);
  // Limb sizes derive from the torso rather than rolling independently, so no
  // combination comes out with stub arms or a torso the legs cannot carry.
  const width = r.range(0.52, 0.68);
  const height = r.range(0.58, 0.76);
  const body = {
    shirt,
    pants: r.pick(PANTS),
    shoe: r.pick(SHOES),
    stripe: r.chance(0.26),
    stripeCol: r.pick(SHIRTS),
    stripeFreq: r.weighted([[2.2, 10], [3.4, 10], [4.6, 6]]),
    // torso silhouette (a superellipsoid, same primitive as the skull)
    p: r.range(2.6, 4.2),
    width,
    height,
    depth: width * r.range(0.62, 0.74),
    taper: r.range(-0.20, 0.08),   // negative = broad shoulders
    bulge: r.range(0.0, 0.10),
    armLen: height * 1.52 + r.range(0.06, 0.24),
    armR: width * r.range(0.24, 0.29),
    spread: r.range(0.30, 0.62),
    sleeve: r.chance(0.45) ? r.range(0.54, 0.70) : r.range(0.15, 0.26),
    legLen: height * 1.95 + r.range(0.0, 0.28),
    legR: width * r.range(0.25, 0.30),
    stance: r.range(0.44, 0.58),
    footLift: r.range(0.11, 0.16),
  };

  return {
    seed,
    skin: skin.base,
    ink: skin.ink,
    head,
    hair,
    face,
    body,
    scale: r.range(0.93, 1.05),
    tilt: r.range(-0.07, 0.07),
  };
}
