// The "sticker" half of the technique: every face is an SVG document generated at
// runtime, rasterised into one 2x2 texture atlas (idle / blink / talk / joy).
// The shader then picks a frame and projects it onto the front of the 3D head.

const n = (v) => (Math.round(v * 100) / 100).toString();

/* ---------------------------------------------------------------- eyes --- */

function eyeOpen(style, cx, cy, rx, ry, ink, id) {
  const w = rx, h = ry;
  switch (style) {
    case 'dot':
      return `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(w * 0.82)}" ry="${n(h)}" fill="${ink}"/>`;

    case 'screen':
      return `<rect x="${n(cx - w)}" y="${n(cy - h)}" width="${n(w * 2)}" height="${n(h * 2)}" rx="${n(w * 0.5)}"
        fill="#ffffff" stroke="${ink}" stroke-width="1.5"/>
        <rect x="${n(cx - w * 0.58)}" y="${n(cy - h * 0.62)}" width="${n(w * 1.16)}" height="${n(h * 1.05)}"
        rx="${n(w * 0.32)}" fill="${ink}"/>`;

    case 'sparkle':
      return `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(w)}" ry="${n(h)}" fill="#ffffff" stroke="${ink}" stroke-width="1.4"/>
        <ellipse cx="${n(cx)}" cy="${n(cy + h * 0.08)}" rx="${n(w * 0.66)}" ry="${n(h * 0.7)}" fill="${ink}"/>
        <circle cx="${n(cx - w * 0.32)}" cy="${n(cy - h * 0.38)}" r="${n(w * 0.26)}" fill="#ffffff"/>
        <circle cx="${n(cx + w * 0.3)}" cy="${n(cy + h * 0.3)}" r="${n(w * 0.14)}" fill="#ffffff"/>`;

    case 'wide':
      return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(Math.max(w, h) * 0.95)}" fill="#ffffff" stroke="${ink}" stroke-width="1.5"/>
        <circle cx="${n(cx)}" cy="${n(cy)}" r="${n(Math.max(w, h) * 0.34)}" fill="${ink}"/>`;

    case 'happy':
      return `<path d="M ${n(cx - w)} ${n(cy + h * 0.32)} Q ${n(cx)} ${n(cy - h * 0.8)} ${n(cx + w)} ${n(cy + h * 0.32)}"
        fill="none" stroke="${ink}" stroke-width="2.6" stroke-linecap="round"/>`;

    case 'sleepy':
      return `<path d="M ${n(cx - w)} ${n(cy - h * 0.15)} Q ${n(cx)} ${n(cy + h * 0.6)} ${n(cx + w)} ${n(cy - h * 0.15)}"
        fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M ${n(cx - w * 1.05)} ${n(cy - h * 0.5)} L ${n(cx - w * 0.75)} ${n(cy - h * 0.12)}"
        fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/>`;

    case 'angry': {
      const lid = `M ${n(cx - w * 1.2)} ${n(cy - h * 1.3)} L ${n(cx + w * 1.2)} ${n(cy - h * 1.3)}
                   L ${n(cx + w * 1.2)} ${n(cy - h * 0.05)} L ${n(cx - w * 1.2)} ${n(cy - h * 0.5)} Z`;
      return `<defs><clipPath id="c${id}"><ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(w)}" ry="${n(h)}"/></clipPath></defs>
        <ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(w)}" ry="${n(h)}" fill="#ffffff" stroke="${ink}" stroke-width="1.4"/>
        <ellipse cx="${n(cx)}" cy="${n(cy + h * 0.14)}" rx="${n(w * 0.6)}" ry="${n(h * 0.64)}" fill="${ink}"/>
        <path d="${lid}" fill="${ink}" clip-path="url(#c${id})"/>`;
    }

    case 'line':
      return `<path d="M ${n(cx - w)} ${n(cy)} L ${n(cx + w)} ${n(cy)}"
        fill="none" stroke="${ink}" stroke-width="2.8" stroke-linecap="round"/>`;

    case 'cross':
      return `<g stroke="${ink}" stroke-width="2.6" stroke-linecap="round">
        <path d="M ${n(cx - w * 0.8)} ${n(cy - h * 0.7)} L ${n(cx + w * 0.8)} ${n(cy + h * 0.7)}"/>
        <path d="M ${n(cx + w * 0.8)} ${n(cy - h * 0.7)} L ${n(cx - w * 0.8)} ${n(cy + h * 0.7)}"/></g>`;

    case 'heart':
      return `<path d="M ${n(cx)} ${n(cy + h * 0.8)}
        C ${n(cx - w * 1.35)} ${n(cy - h * 0.1)} ${n(cx - w * 0.5)} ${n(cy - h * 1.15)} ${n(cx)} ${n(cy - h * 0.3)}
        C ${n(cx + w * 0.5)} ${n(cy - h * 1.15)} ${n(cx + w * 1.35)} ${n(cy - h * 0.1)} ${n(cx)} ${n(cy + h * 0.8)} Z"
        fill="${ink}"/>`;

    default: // round
      return `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(w)}" ry="${n(h)}" fill="#ffffff" stroke="${ink}" stroke-width="1.5"/>
        <ellipse cx="${n(cx)}" cy="${n(cy + h * 0.06)}" rx="${n(w * 0.62)}" ry="${n(h * 0.68)}" fill="${ink}"/>
        <circle cx="${n(cx - w * 0.28)}" cy="${n(cy - h * 0.36)}" r="${n(w * 0.22)}" fill="#ffffff"/>`;
  }
}

function eyeClosed(cx, cy, rx, ry, ink) {
  return `<path d="M ${n(cx - rx)} ${n(cy - ry * 0.1)} Q ${n(cx)} ${n(cy + ry * 0.72)} ${n(cx + rx)} ${n(cy - ry * 0.1)}"
    fill="none" stroke="${ink}" stroke-width="2.6" stroke-linecap="round"/>`;
}

// Styles that are already shut never blink — they just squash a little.
const ALWAYS_SHUT = new Set(['happy', 'sleepy', 'cross', 'line']);

/* --------------------------------------------------------------- brows --- */

function brow(style, cx, by, w, side, ink) {
  if (style === 'none') return '';
  const s = side; // -1 left, +1 right; inner edge is toward the centre
  switch (style) {
    case 'angry':
      return `<path d="M ${n(cx - w * s)} ${n(by - 1.4)} L ${n(cx + w * s)} ${n(by + 3.2)}"
        stroke="${ink}" stroke-width="2.4" stroke-linecap="round" fill="none"/>`;
    case 'worried':
      return `<path d="M ${n(cx - w * s)} ${n(by + 3.0)} L ${n(cx + w * s)} ${n(by - 1.2)}"
        stroke="${ink}" stroke-width="2.2" stroke-linecap="round" fill="none"/>`;
    case 'flat':
      return `<path d="M ${n(cx - w)} ${n(by)} L ${n(cx + w)} ${n(by)}"
        stroke="${ink}" stroke-width="2.2" stroke-linecap="round" fill="none"/>`;
    case 'thick':
      return `<path d="M ${n(cx - w)} ${n(by + 1.6)} Q ${n(cx)} ${n(by - 2.6)} ${n(cx + w)} ${n(by + 1.2)}"
        stroke="${ink}" stroke-width="3.6" stroke-linecap="round" fill="none"/>`;
    default: // thin
      return `<path d="M ${n(cx - w)} ${n(by + 1.8)} Q ${n(cx)} ${n(by - 2.4)} ${n(cx + w)} ${n(by + 1.4)}"
        stroke="${ink}" stroke-width="2.0" stroke-linecap="round" fill="none"/>`;
  }
}

/* -------------------------------------------------------------- mouths --- */

function mouth(style, my, ink) {
  const cx = 50;
  switch (style) {
    case 'line':
      return `<path d="M ${cx - 4.5} ${n(my)} L ${cx + 4.5} ${n(my)}" stroke="${ink}" stroke-width="2.2" stroke-linecap="round" fill="none"/>`;
    case 'smile':
      return `<path d="M ${cx - 6.5} ${n(my - 1.5)} Q ${cx} ${n(my + 5)} ${cx + 6.5} ${n(my - 1.5)}"
        stroke="${ink}" stroke-width="2.2" stroke-linecap="round" fill="none"/>`;
    case 'o':
      return `<ellipse cx="${cx}" cy="${n(my)}" rx="3" ry="3.6" fill="${ink}"/>`;
    case 'grit':
      return `<g><rect x="${cx - 8}" y="${n(my - 3.2)}" width="16" height="6.4" rx="1.8" fill="#ffffff" stroke="${ink}" stroke-width="1.5"/>
        <g stroke="${ink}" stroke-width="1.1">
        <path d="M ${cx - 8} ${n(my)} L ${cx + 8} ${n(my)}"/>
        <path d="M ${cx - 3.6} ${n(my - 3.2)} L ${cx - 3.6} ${n(my + 3.2)}"/>
        <path d="M ${cx + 1.2} ${n(my - 3.2)} L ${cx + 1.2} ${n(my + 3.2)}"/></g></g>`;
    case 'smirk':
      return `<path d="M ${cx - 5.5} ${n(my + 0.5)} Q ${cx + 1} ${n(my + 4)} ${cx + 6.5} ${n(my - 3)}"
        stroke="${ink}" stroke-width="2.2" stroke-linecap="round" fill="none"/>`;
    case 'pout':
      return `<path d="M ${cx - 3.4} ${n(my - 1.6)} L ${cx} ${n(my + 2.4)} L ${cx + 3.4} ${n(my - 1.6)}"
        stroke="${ink}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
    case 'open':
      return `<g><path d="M ${cx - 5.5} ${n(my - 3)} Q ${cx} ${n(my + 7)} ${cx + 5.5} ${n(my - 3)} Z" fill="${ink}"/>
        <path d="M ${cx - 2.6} ${n(my + 2.2)} Q ${cx} ${n(my + 5.4)} ${cx + 2.6} ${n(my + 2.2)} Z" fill="#e07a86"/></g>`;
    case 'flat':
      return `<path d="M ${cx - 5} ${n(my + 1)} Q ${cx} ${n(my - 2.2)} ${cx + 5} ${n(my + 1)}"
        stroke="${ink}" stroke-width="2.2" stroke-linecap="round" fill="none"/>`;
    default: // w  (the little cat mouth)
      return `<path d="M ${cx - 6.4} ${n(my - 1.2)} Q ${cx - 3.2} ${n(my + 3.2)} ${cx} ${n(my - 0.6)}
        Q ${cx + 3.2} ${n(my + 3.2)} ${cx + 6.4} ${n(my - 1.2)}"
        stroke="${ink}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
  }
}

/* ---------------------------------------------------------------- misc --- */

function marks(f, L, R, ey, ink) {
  const s = f.side;
  switch (f.mark) {
    case 'glassesRound': {
      const r = Math.max(f.eyeRx, f.eyeRy) * 1.28;
      return `<g fill="none" stroke="${ink}" stroke-width="2.1">
        <circle cx="${n(L)}" cy="${n(ey)}" r="${n(r)}"/><circle cx="${n(R)}" cy="${n(ey)}" r="${n(r)}"/>
        <path d="M ${n(L + r)} ${n(ey)} L ${n(R - r)} ${n(ey)}"/>
        <path d="M ${n(L - r)} ${n(ey - 1)} L ${n(L - r - 6)} ${n(ey - 3)}"/>
        <path d="M ${n(R + r)} ${n(ey - 1)} L ${n(R + r + 6)} ${n(ey - 3)}"/></g>`;
    }
    case 'glassesSquare': {
      const w = f.eyeRx * 1.4, h = f.eyeRy * 1.25;
      return `<g fill="none" stroke="${ink}" stroke-width="2.1">
        <rect x="${n(L - w)}" y="${n(ey - h)}" width="${n(w * 2)}" height="${n(h * 2)}" rx="2.4"/>
        <rect x="${n(R - w)}" y="${n(ey - h)}" width="${n(w * 2)}" height="${n(h * 2)}" rx="2.4"/>
        <path d="M ${n(L + w)} ${n(ey)} L ${n(R - w)} ${n(ey)}"/>
        <path d="M ${n(L - w)} ${n(ey - 1)} L ${n(L - w - 6)} ${n(ey - 3)}"/>
        <path d="M ${n(R + w)} ${n(ey - 1)} L ${n(R + w + 6)} ${n(ey - 3)}"/></g>`;
    }
    case 'plaster': {
      const px = 50 + s * 21, py = ey + 12, rot = s * 28;
      return `<g transform="rotate(${n(rot)} ${n(px)} ${n(py)})">
        <rect x="${n(px - 7)}" y="${n(py - 3.2)}" width="14" height="6.4" rx="3.2" fill="#f2d5b8" stroke="${ink}" stroke-width="1.1"/>
        <rect x="${n(px - 2.6)}" y="${n(py - 2.4)}" width="5.2" height="4.8" rx="1" fill="#e0b78f"/></g>`;
    }
    case 'freckles': {
      let out = `<g fill="${ink}" opacity="0.5">`;
      for (let i = -2; i <= 2; i++) {
        if (i === 0) continue;
        out += `<circle cx="${n(50 + i * 6)}" cy="${n(ey + 9 + (i % 2 ? 1.6 : 0))}" r="0.95"/>`;
        out += `<circle cx="${n(50 + i * 7.6)}" cy="${n(ey + 12.4)}" r="0.8"/>`;
      }
      return out + '</g>';
    }
    case 'mole':
      return `<circle cx="${n(50 + s * 8)}" cy="${n(ey + 17)}" r="1.15" fill="${ink}"/>`;
    case 'blushLines': {
      let out = `<g stroke="${ink}" stroke-width="1.3" stroke-linecap="round" opacity="0.75">`;
      for (const sd of [-1, 1]) for (let i = 0; i < 3; i++)
        out += `<path d="M ${n(50 + sd * (18 + i * 3.6))} ${n(ey + 7)} L ${n(50 + sd * (16 + i * 3.6))} ${n(ey + 12)}"/>`;
      return out + '</g>';
    }
    case 'diamond':
      return `<path d="M 50 ${n(ey - 22)} L ${n(53.4)} ${n(ey - 17)} L 50 ${n(ey - 12)} L ${n(46.6)} ${n(ey - 17)} Z" fill="${ink}"/>`;
    case 'eyepatch': {
      const px = 50 + s * f.eyeGap;
      return `<g><path d="M ${n(px - 30 * s)} ${n(ey - 11)} L ${n(px + 26 * s)} ${n(ey - 13)}" stroke="${ink}" stroke-width="1.8"/>
        <rect x="${n(px - f.eyeRx * 1.5)}" y="${n(ey - f.eyeRy * 1.35)}" width="${n(f.eyeRx * 3)}" height="${n(f.eyeRy * 2.7)}"
        rx="${n(f.eyeRx * 0.8)}" fill="${ink}"/></g>`;
    }
    case 'tear':
      return `<path d="M ${n(50 + s * f.eyeGap)} ${n(ey + f.eyeRy + 2)} q -3.4 5 0 7 q 3.4 -2 0 -7 Z" fill="#7bb8e0" opacity="0.9"/>`;
    default:
      return '';
  }
}

function nose(style, ny, ink) {
  if (style === 'dot') return `<ellipse cx="50" cy="${n(ny)}" rx="1.5" ry="1.1" fill="${ink}" opacity="0.7"/>`;
  if (style === 'line') return `<path d="M 48.6 ${n(ny - 1.2)} L 50 ${n(ny + 1)} L 51.4 ${n(ny - 0.6)}"
    fill="none" stroke="${ink}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>`;
  return '';
}

/* --------------------------------------------------------------- build --- */

export function faceSVG(dna, mode, size) {
  const f = dna.face;
  const ink = f.ink;
  const ey = f.eyeY;
  const L = 50 - f.eyeGap, R = 50 + f.eyeGap;
  const by = ey - f.eyeRy - 3.6;
  const my = ey + f.mouthOff;

  const shut = ALWAYS_SHUT.has(f.eyes);
  const blinking = mode === 'blink' && !shut;
  const joyful = mode === 'joy';

  let eyesSvg;
  if (joyful) {
    eyesSvg = eyeOpen('happy', L, ey, f.eyeRx * 1.05, f.eyeRy, ink, 'jl')
            + eyeOpen('happy', R, ey, f.eyeRx * 1.05, f.eyeRy, ink, 'jr');
  } else if (blinking) {
    eyesSvg = eyeClosed(L, ey, f.eyeRx, f.eyeRy, ink) + eyeClosed(R, ey, f.eyeRx, f.eyeRy, ink);
  } else {
    const left = f.wink ? eyeClosed(L, ey, f.eyeRx, f.eyeRy, ink) : eyeOpen(f.eyes, L, ey, f.eyeRx, f.eyeRy, ink, 'l');
    eyesSvg = left + eyeOpen(f.eyes, R, ey, f.eyeRx, f.eyeRy, ink, 'r');
  }

  let mouthSvg;
  if (joyful) {
    mouthSvg = `<g><path d="M ${50 - 8.5} ${n(my - 2.5)} Q 50 ${n(my + 9)} ${50 + 8.5} ${n(my - 2.5)} Z" fill="${ink}"/>
      <path d="M ${50 - 4} ${n(my + 3)} Q 50 ${n(my + 7.2)} ${50 + 4} ${n(my + 3)} Z" fill="#e07a86"/></g>`;
  } else if (mode === 'talk') {
    mouthSvg = `<g><ellipse cx="50" cy="${n(my + 1)}" rx="4.2" ry="5.6" fill="${ink}"/>
      <ellipse cx="50" cy="${n(my + 3.8)}" rx="2.4" ry="1.9" fill="#e07a86"/></g>`;
  } else {
    mouthSvg = mouth(f.mouth, my, ink);
  }

  const blushSvg = f.blush || joyful
    ? `<ellipse cx="${n(L - 6)}" cy="${n(ey + 11)}" rx="8.4" ry="5.6" fill="url(#bl)"/>
       <ellipse cx="${n(R + 6)}" cy="${n(ey + 11)}" rx="8.4" ry="5.6" fill="url(#bl)"/>` : '';

  const browsSvg = brow(f.brows, L, by, f.eyeRx * 0.95, -1, ink) + brow(f.brows, R, by, f.eyeRx * 0.95, 1, ink);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
<defs><radialGradient id="bl" cx="0.5" cy="0.5" r="0.5">
<stop offset="0" stop-color="#d4795a" stop-opacity="0.42"/>
<stop offset="0.55" stop-color="#d4795a" stop-opacity="0.28"/>
<stop offset="1" stop-color="#d97a52" stop-opacity="0"/></radialGradient></defs>
<g transform="rotate(${n(f.tilt)} 50 ${n(ey)})">
${blushSvg}
${browsSvg}
${eyesSvg}
${nose(f.nose, ey + f.mouthOff * 0.5, ink)}
${mouthSvg}
${marks(f, L, R, ey, ink)}
</g></svg>`;
}

export const FRAMES = ['idle', 'blink', 'talk', 'joy'];

function rasterise(svg, size) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

// One character -> one 2x2 atlas. Frame i lives at (i%2, floor(i/2)).
export async function bakeFaceAtlas(dna, cell = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = cell * 2;
  const ctx = canvas.getContext('2d');
  const imgs = await Promise.all(FRAMES.map((m) => rasterise(faceSVG(dna, m, cell), cell)));
  imgs.forEach((img, i) => ctx.drawImage(img, (i % 2) * cell, Math.floor(i / 2) * cell, cell, cell));
  return canvas;
}

// UV offset for frame i, accounting for three.js flipping canvas textures vertically.
export function frameOffset(i) {
  return [(i % 2) * 0.5, 0.5 - Math.floor(i / 2) * 0.5];
}
