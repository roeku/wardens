import type { P } from '../contracts';

// Polylines as the input sends them (01-flow.md §2 "Strokes"): Ramer–Douglas–Peucker simplification at a
// tolerance in tiles, and the length the front's tap test reads.

/** Arc length of a polyline, tiles. */
export function lengthOf(pts: readonly P[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return l;
}

/** Distance from p to the segment ab. */
function segDist(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

/** Ramer–Douglas–Peucker: the fewest points within `eps` tiles of the line as drawn; the ends are kept. */
export function simplify(pts: readonly P[], eps: number): P[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let best = -1;
    let bd = eps;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(pts[k], pts[i], pts[j]);
      if (d > bd) {
        bd = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i, best], [best, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}
