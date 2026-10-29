import { H, W, fromLab, lab } from './post';

// The painter of fallback (b): procedural pixel faces from layered parts. Each part is a shape with a pseudo-3D
// normal, lit from the upper left and front (01-flow.md §7 "soft light from the upper left") into the steps of its
// material's ramp, drawn back to front, with a dark contour of the ramp's darkest step where asked. No blending:
// every pixel is one ramp colour. Deterministic: shapes and textures follow from the person's seed through hash32.

/** The light, toward it: from the upper left, in front. */
const LX = -0.55, LY = -0.62, LZ = 0.56;
const LN = Math.hypot(LX, LY, LZ);
const L = [LX / LN, LY / LN, LZ / LN] as const;

/** Ramp steps, dark → light: Lab offsets (lightness, a, b). Shadows lean cool, light warm (pixel-art hue shift). */
const STEPS: readonly (readonly [number, number, number])[] = [
  [-30, 2, -9],
  [-17, 1, -5],
  [-7, 0, -2],
  [0, 0, 0],
  [9, -1, 5],
];
export const RAMP_N = STEPS.length;
/** The base colour sits at this step. */
export const BASE = 3;

const rampMemo = new Map<number, number[]>();
/** A material's five steps, dark → light, from its base colour (the base itself at step 3). */
export function ramp(hex: number): number[] {
  let r = rampMemo.get(hex);
  if (r) return r;
  const [l0, a0, b0] = lab(hex);
  r = STEPS.map(([dl, da, db], i) => (i === BASE ? hex : fromLab(Math.max(2, Math.min(98, l0 + dl)), a0 + da, b0 + db)));
  rampMemo.set(hex, r);
  return r;
}

/** Light on a unit normal → a ramp step (0..4), shifted by `bias` steps. */
export function level(nx: number, ny: number, nz: number, bias = 0): number {
  const d = nx * L[0] + ny * L[1] + nz * L[2];
  const k = d < -0.05 ? 0 : d < 0.28 ? 1 : d < 0.58 ? 2 : d < 0.86 ? 3 : 4;
  return Math.max(0, Math.min(RAMP_N - 1, k + bias));
}

/** A shape's answer at a pixel: null outside, else its unit normal there; `box` bounds it (x0, y0, x1, y1). */
export type Shape = ((x: number, y: number) => readonly [number, number, number] | null) & { box?: readonly [number, number, number, number] };

/** Gives a shape its bounding box (painting looks only inside it). */
export function boxed(f: Shape, x0: number, y0: number, x1: number, y1: number): Shape {
  f.box = [x0, y0, x1, y1];
  return f;
}
const FULL = [0, 0, W, H] as const;
/** The pixel rows and columns a shape can touch. */
function span(f: Shape): [number, number, number, number] {
  const b = f.box ?? FULL;
  return [Math.max(0, Math.floor(b[0]) - 1), Math.max(0, Math.floor(b[1]) - 1), Math.min(W, Math.ceil(b[2]) + 1), Math.min(H, Math.ceil(b[3]) + 1)];
}

const N: [number, number, number] = [0, 0, 1];
/** An ellipsoid seen face on: centre, radii; `tilt` turns its normals toward +x (a head turned right). */
export function ellipsoid(cx: number, cy: number, rx: number, ry: number, p = 2, tilt = 0): Shape {
  return boxed((x, y) => {
    const u = (x - cx) / rx, v = (y - cy) / ry;
    const d = p === 2 ? u * u + v * v : Math.abs(u) ** p + Math.abs(v) ** p;
    if (d > 1) return null;
    const nz = Math.sqrt(Math.max(0, 1 - Math.min(1, u * u + v * v)));
    let nx = u, ny = v, z = nz;
    if (tilt) {
      const c = Math.cos(tilt), s = Math.sin(tilt);
      [nx, z] = [nx * c + z * s, z * c - nx * s];
    }
    const n = Math.hypot(nx, ny, z) || 1;
    N[0] = nx / n;
    N[1] = ny / n;
    N[2] = z / n;
    return N;
  }, cx - rx, cy - ry, cx + rx, cy + ry);
}

/** An ellipse turned by `ang` radians (clockwise on screen), lit as an ellipsoid. */
export function oval(cx: number, cy: number, rx: number, ry: number, ang: number): Shape {
  const c = Math.cos(ang), s = Math.sin(ang);
  const r = Math.max(rx, ry);
  return boxed((x, y) => {
    const dx = x - cx, dy = y - cy;
    const u = (dx * c + dy * s) / rx, v = (-dx * s + dy * c) / ry;
    const d = u * u + v * v;
    if (d > 1) return null;
    // the normal back in screen axes
    const nx = u * c - v * s, ny = u * s + v * c;
    const nz = Math.sqrt(1 - d);
    N[0] = nx;
    N[1] = ny;
    N[2] = nz;
    return N;
  }, cx - r, cy - r, cx + r, cy + r);
}

/** A polygon (screen points), lit as a gentle dome over its box, or with a fixed normal. */
export function poly(pts: readonly (readonly [number, number])[], normal?: readonly [number, number, number]): Shape {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max(1, (x1 - x0) / 2), ry = Math.max(1, (y1 - y0) / 2);
  return boxed((x, y) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (!inside) return null;
    if (normal) return normal;
    const u = ((x - cx) / rx) * 0.7, v = ((y - cy) / ry) * 0.7;
    const nz = Math.sqrt(Math.max(0.05, 1 - u * u - v * v));
    const n = Math.hypot(u, v, nz);
    N[0] = u / n;
    N[1] = v / n;
    N[2] = nz / n;
    return N;
  }, x0, y0, x1, y1);
}

/** A tapering stroke along a polyline (horns, nasal bars, tails): radius r0 → r1, lit as a tube. */
export function stroke(pts: readonly (readonly [number, number])[], r0: number, r1: number): Shape {
  const lens: number[] = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = lens[lens.length - 1] || 1;
  const rm = Math.max(r0, r1);
  return boxed((x, y) => {
    let best = Infinity, bt = 0, bnx = 0, bny = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      const px = ax + dx * t, py = ay + dy * t;
      const d = Math.hypot(x - px, y - py);
      const s = (lens[i - 1] + t * Math.sqrt(l2)) / total;
      const r = r0 + (r1 - r0) * s;
      if (d / r < best) {
        best = d / r;
        bt = s;
        bnx = (x - px) / (d || 1);
        bny = (y - py) / (d || 1);
      }
    }
    void bt;
    if (best > 1) return null;
    const nz = Math.sqrt(Math.max(0, 1 - best * best));
    N[0] = bnx * best;
    N[1] = bny * best;
    N[2] = nz;
    return N;
  }, Math.min(...pts.map((p) => p[0])) - rm, Math.min(...pts.map((p) => p[1])) - rm, Math.max(...pts.map((p) => p[0])) + rm, Math.max(...pts.map((p) => p[1])) + rm);
}

export const union = (...s: Shape[]): Shape => {
  const bs = s.map((f) => f.box ?? FULL);
  return boxed(
    (x, y) => {
      for (const f of s) {
        const n = f(x, y);
        if (n) return n;
      }
      return null;
    },
    Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3])),
  );
};
export const minus = (a: Shape, b: Shape): Shape => boxed((x, y) => (b(x, y) ? null : a(x, y)), ...(a.box ?? FULL));
export const clip = (a: Shape, keep: (x: number, y: number) => boolean): Shape => boxed((x, y) => (keep(x, y) ? a(x, y) : null), ...(a.box ?? FULL));

export interface FillOpts {
  /** Steps added to the light (−1 a step darker). */
  bias?: number;
  /** Per-pixel extra steps (textures: mail rings, hair strands). */
  tex?: (x: number, y: number) => number;
  /** Contour colour on the shape's edge pixels (where a 4-neighbour is outside), or none. */
  edge?: number | null;
  /** Which sides get the contour: all by default; 'out' only where the neighbour is background. */
  edgeOn?: 'all' | 'out';
  /** A single colour for every step (flat parts: eyes, mouths). */
  flat?: number;
  /** The shape is the head itself (skull, face, jaw): marked in `head`, for the crop and the checks. */
  head?: boolean;
}

/** The picture being painted: colours, and which pixels are still background. */
export class Pic {
  readonly col: Uint32Array;
  readonly bgMask: Uint8Array;
  /** The head's own pixels (FillOpts.head), whatever was painted over them. */
  readonly head = new Uint8Array(W * H);
  private readonly mask = new Uint8Array(W * H);
  private readonly lv = new Int8Array(W * H);
  constructor(readonly bg: number) {
    this.col = new Uint32Array(W * H).fill(bg);
    this.bgMask = new Uint8Array(W * H).fill(1);
  }

  /** Paints a shape in a ramp, lit, with an optional contour. Returns how many pixels it covered. */
  fill(shape: Shape, r: readonly number[], o: FillOpts = {}): number {
    const m = this.mask;
    m.fill(0);
    let n = 0;
    const lv = this.lv;
    const [bx0, by0, bx1, by1] = span(shape);
    for (let y = by0; y < by1; y++) {
      for (let x = bx0; x < bx1; x++) {
        const nn = shape(x + 0.5, y + 0.5);
        if (!nn) continue;
        const i = y * W + x;
        m[i] = 1;
        n++;
        const k = Math.max(0, Math.min(r.length - 1, level(nn[0], nn[1], nn[2], o.bias ?? 0) + (o.tex ? o.tex(x, y) : 0)));
        lv[i] = k;
      }
    }
    for (let y = by0; y < by1; y++) {
      for (let x = bx0; x < bx1; x++) {
        const i = y * W + x;
        if (!m[i]) continue;
        let c = o.flat ?? r[lv[i]];
        if (o.edge != null) {
          const outside = (xx: number, yy: number) => {
            if (yy >= H) return false;
            if (xx < 0 || xx >= W || yy < 0) return true;
            const j = yy * W + xx;
            return !m[j] && (o.edgeOn !== 'out' || this.bgMask[j] === 1);
          };
          if (outside(x + 1, y) || outside(x - 1, y) || outside(x, y + 1) || outside(x, y - 1)) c = o.edge;
        }
        this.col[i] = c;
        this.bgMask[i] = 0;
        if (o.head) this.head[i] = 1;
      }
    }
    return n;
  }

  /** One pixel. */
  px(x: number, y: number, c: number): void {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y | 0) * W + (x | 0);
    this.col[i] = c;
    this.bgMask[i] = 0;
  }

  /** A one-pixel line (Bresenham). */
  line(x0: number, y0: number, x1: number, y1: number, c: number): void {
    let x = Math.round(x0), y = Math.round(y0);
    const xe = Math.round(x1), ye = Math.round(y1);
    const dx = Math.abs(xe - x), dy = -Math.abs(ye - y);
    const sx = x < xe ? 1 : -1, sy = y < ye ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.px(x, y, c);
      if (x === xe && y === ye) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** Darkens (or lightens) the pixels of a shape that already hold one of `from`'s steps, by `by` steps. */
  shadeOver(shape: Shape, from: readonly number[], by: number): void {
    const [bx0, by0, bx1, by1] = span(shape);
    for (let y = by0; y < by1; y++) {
      for (let x = bx0; x < bx1; x++) {
        if (!shape(x + 0.5, y + 0.5)) continue;
        const i = y * W + x;
        const k = from.indexOf(this.col[i]);
        if (k >= 0) this.col[i] = from[Math.max(0, Math.min(from.length - 1, k + by))];
      }
    }
  }

  get(x: number, y: number): number {
    return this.col[y * W + x];
  }
}
