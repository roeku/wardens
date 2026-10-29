import { rect } from '../view/cards';
import { drawText, GLYPH_H, measure } from '../view/font5x7';

// Cloth for the screens (docs/spec/01-flow.md §3: "choices are banners on cloth"; 02-look.md §4, §6): hanging
// gonfalons with a swallowtail, in the heraldry ramps, with a gold edge where a choice is offered (gold means honour
// and choice), and the dark cloth the chronicle and the war table lie on. Whole ui pixels, opaque, the 5×7 font.

export const RAMP = {
  blue: ['#153a5c', '#1f5a8e', '#2f78b8', '#6fb0e0'],
  red: ['#4a1614', '#86281f', '#b83a2b', '#e8765c'],
  linen: ['#6b5a40', '#a8946c', '#d2c29c', '#ece2c6'],
} as const;
export const GOLD = '#e8c34a';
export const GOLD_DARK = '#9a7a2a';
export const DEVICE = '#f3ecd8';
export const INK = '#16120f';
export const WOOD = ['#35231a', '#56391f', '#7a5634'] as const;
export const CREAM = '#f1ead6';
export const RED_RULE = '#d8463a';
export const DARK_CLOTH = ['#1c1713', '#2a221c'] as const;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Swallowtail rows at the bottom of a gonfalon. */
const TAIL = 6;

/**
 * A gonfalon hanging from a crossbar at (x, y): `w` wide, `h` tall with its swallowtail, its word (or none) in the
 * device's cream at `scale`. `lit`: gold edge (a choice). `down`: pressed (it sways down a pixel, its edge brighter).
 * Returns the cloth's box, the tap target.
 */
export function gonfalon(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  word: string,
  o: { ramp?: keyof typeof RAMP; lit?: boolean; down?: boolean; scale?: number; device?: string } = {},
): Box {
  const R = RAMP[o.ramp ?? 'blue'];
  const yy = y + (o.down ? 1 : 0);
  // rings on the bar
  rect(g, x + 2, y - 2, 2, 3, WOOD[0]);
  rect(g, x + w - 4, y - 2, 2, 3, WOOD[0]);
  for (let j = 0; j < h; j++) {
    // the swallowtail: a notch cut up the middle of the last rows
    const t = j - (h - TAIL);
    const notch = t > 0 ? Math.round((t / TAIL) * (w / 2 - 1)) : 0;
    const left = notch > 0 ? Math.floor(w / 2) - notch : w;
    const right = notch > 0 ? Math.ceil(w / 2) + notch : w;
    if (left > 0) rect(g, x, yy + j, left, 1, R[2]);
    if (right < w) rect(g, x + right, yy + j, w - right, 1, R[2]);
    // the border: the outer pixel ramp[0] (gold for a choice), the last 3 columns ramp[1]
    const edge = o.lit ? (o.down ? '#fffbe8' : GOLD) : R[0];
    rect(g, x, yy + j, 1, 1, edge);
    rect(g, x + w - 1, yy + j, 1, 1, edge);
    if (t <= 0) rect(g, x + w - 4, yy + j, 3, 1, R[1]);
  }
  rect(g, x, yy, w, 1, o.lit ? (o.down ? '#fffbe8' : GOLD) : R[0]);
  // the fold row
  rect(g, x + 1, yy + 1, w - 2, 1, R[3]);
  // the tail's cut edges
  for (let t = 1; t <= TAIL; t++) {
    const notch = Math.round((t / TAIL) * (w / 2 - 1));
    const jy = yy + h - TAIL + t - 1;
    rect(g, x + Math.floor(w / 2) - notch - 1, jy, 1, 1, o.lit ? GOLD_DARK : R[0]);
    rect(g, x + Math.ceil(w / 2) + notch, jy, 1, 1, o.lit ? GOLD_DARK : R[0]);
  }
  if (word) {
    const s = o.scale ?? 1;
    const tw = measure(word) * s;
    drawText(g, word, x + Math.round((w - 3 - tw) / 2), yy + Math.round((h - TAIL - GLYPH_H * s) / 2) + 1, o.device ?? DEVICE, s);
  }
  return { x, y, w, h };
}

/** A crossbar (a pole laid across) from x0 to x1 at y, with knobs. */
export function crossbar(g: CanvasRenderingContext2D, x0: number, x1: number, y: number): void {
  rect(g, x0, y, x1 - x0, 2, WOOD[1]);
  rect(g, x0, y + 2, x1 - x0, 1, WOOD[0]);
  rect(g, x0 - 2, y - 1, 3, 4, WOOD[2]);
  rect(g, x1 - 1, y - 1, 3, 4, WOOD[2]);
}

/** Dark cloth with a woven line every fourth row, in a frame (wood, gold or grey). */
export function darkCloth(g: CanvasRenderingContext2D, b: Box, frame: 'wood' | 'gold' | 'grey' = 'wood'): void {
  const F = frame === 'gold' ? [GOLD, GOLD_DARK] : frame === 'grey' ? ['#8a867c', '#4e4a44'] : [WOOD[2], WOOD[0]];
  rect(g, b.x, b.y, b.w, b.h, F[0]);
  rect(g, b.x + 1, b.y + 1, b.w - 2, b.h - 2, F[1]);
  rect(g, b.x + 2, b.y + 2, b.w - 4, b.h - 4, DARK_CLOTH[0]);
  for (let y = b.y + 4; y < b.y + b.h - 3; y += 4) rect(g, b.x + 2, y, b.w - 4, 1, DARK_CLOTH[1]);
}

export const inside = (b: Box, x: number, y: number, slack = 0): boolean =>
  x >= b.x - slack && x < b.x + b.w + slack && y >= b.y - slack && y < b.y + b.h + slack;
