// The flicker checks. Every change of the art-pixel image must be explained by whole-pixel shifts:
// - camera drift: the whole picture moves by the camera's own whole-pixel step;
// - figure drift: the figures (and what they draw on the ground: outlines, shadows) move by their own
//   whole-pixel step over a picture of the field without them.
// A frame with any pixel those shifts don't explain is a flicker frame.

export interface Img {
  data: Uint8Array;
  w: number;
  h: number;
}

/** The largest channel difference seen by the last mismatch count (1 = a 1/255 rounding, invisible). */
export let lastDelta = 0;
function delta(a: number, b: number): number {
  let m = 0;
  for (let k = 0; k < 24; k += 8) m = Math.max(m, Math.abs(((a >>> k) & 255) - ((b >>> k) & 255)));
  return m;
}

/** Pixels in the interior (a `margin` from the edges) where cur differs from prev shifted by (dx, dy): cur[x, y] vs prev[x + dx, y + dy]. */
export function shiftMismatch(cur: Img, prev: Img, dx: number, dy: number, margin = 3): number {
  const a = new Uint32Array(cur.data.buffer, cur.data.byteOffset, cur.w * cur.h);
  const b = new Uint32Array(prev.data.buffer, prev.data.byteOffset, prev.w * prev.h);
  const { w, h } = cur;
  let bad = 0;
  lastDelta = 0;
  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) {
      const u = a[y * w + x], v = b[(y + dy) * w + x + dx];
      if (u !== v) {
        bad++;
        lastDelta = Math.max(lastDelta, delta(u, v));
      }
    }
  }
  return bad;
}

/**
 * Pixels where cur differs from what the figure layer predicts: the previous frame's figure pixels (those that
 * differ from the empty field `emptyPrev`) moved by (dx, dy) over the current empty field `emptyCur`.
 */
export function figureMismatch(cur: Img, prev: Img, emptyPrev: Img, emptyCur: Img, dx: number, dy: number, margin = 3): number {
  lastDelta = 0;
  const n = cur.w * cur.h;
  const c = new Uint32Array(cur.data.buffer, cur.data.byteOffset, n);
  const p = new Uint32Array(prev.data.buffer, prev.data.byteOffset, n);
  const ep = new Uint32Array(emptyPrev.data.buffer, emptyPrev.data.byteOffset, n);
  const ec = new Uint32Array(emptyCur.data.buffer, emptyCur.data.byteOffset, n);
  const { w, h } = cur;
  let bad = 0;
  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) {
      const q = (y - dy) * w + x - dx;
      const want = p[q] !== ep[q] ? p[q] : ec[y * w + x];
      if (c[y * w + x] !== want) {
        bad++;
        lastDelta = Math.max(lastDelta, delta(c[y * w + x], want));
      }
    }
  }
  return bad;
}

export function same(a: Img, b: Img): boolean {
  if (a.data.length !== b.data.length) return false;
  const x = new Uint32Array(a.data.buffer, a.data.byteOffset, a.w * a.h);
  const y = new Uint32Array(b.data.buffer, b.data.byteOffset, b.w * b.h);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** How many pixels of `a` differ from the uniform background `bg` (an image of the empty field). */
export function coverage(a: Img, bg: Img): number {
  const x = new Uint32Array(a.data.buffer, a.data.byteOffset, a.w * a.h);
  const y = new Uint32Array(bg.data.buffer, bg.data.byteOffset, bg.w * bg.h);
  let n = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) n++;
  return n;
}
