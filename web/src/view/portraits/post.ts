// The portraits' post-process (docs/spec/01-flow.md §7 "Post-processing"), shared by both ways of making a face:
// one shared palette per side built by k-means in Lab with no dithering, the grey of the fallen, and the checks the
// faces lab prints (the eyes' row, the head's middle). Images are 80×96 arrays of 0xRRGGBB, rows top-down.

export const W = 80;
export const H = 96;
/** 01-flow §7: the eyes on row 40, the middle of the head on column 40. */
export const EYE_Y = 40;
export const MID_X = 40;
/** At most this many colours per side (01-flow §7 step 4). */
export const PALETTE_MAX = 64;

export type Img = Uint32Array;

// ------------------------------------------------------------------------------------------------- colour

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

/** sRGB hex → CIE Lab (D65). */
export function lab(hex: number): [number, number, number] {
  const r = lin((hex >> 16) & 255), g = lin((hex >> 8) & 255), b = lin(hex & 255);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const unlin = (v: number) => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};
const finv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

/** CIE Lab → sRGB hex. */
export function fromLab(L: number, a: number, b: number): number {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const x = finv(fx) * 0.95047, y = finv(fy), z = finv(fz) * 1.08883;
  const r = 3.2406 * x - 1.5372 * y - 0.4986 * z;
  const g = -0.9689 * x + 1.8758 * y + 0.0415 * z;
  const bb = 0.0557 * x - 0.204 * y + 1.057 * z;
  return (unlin(r) << 16) | (unlin(g) << 8) | unlin(bb);
}

/** Scales a hex colour (clamped), for ramps. */
export function mulHex(hex: number, k: number): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return (c((hex >> 16) & 255) << 16) | (c((hex >> 8) & 255) << 8) | c(hex & 255);
}

/** Mixes two hex colours. */
export function mixHex(a: number, b: number, k: number): number {
  const m = (s: number) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

// ------------------------------------------------------------------------------------------------- k-means

/**
 * One palette of at most `k` colours for these (weighted) colours, by k-means in Lab (01-flow §7 step 4).
 * Deterministic: the first centre is the heaviest colour, each next one the colour farthest (weighted) from the
 * centres so far, then Lloyd's iterations; centres snap to the nearest input colour, so a palette colour is always
 * one the painter used. With `k` or fewer distinct colours, the palette is those colours.
 */
export function kmeans(colours: Map<number, number>, k: number, keep: readonly number[] = []): number[] {
  const hexes = [...colours.keys()].sort((a, b) => a - b);
  if (hexes.length <= k) return hexes;
  const pts = hexes.map(lab);
  const wts = hexes.map((h) => colours.get(h)!);
  const d2 = (p: number[] | [number, number, number], q: number[] | [number, number, number]) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  // fixed centres (the background, the outline) first, then farthest-point picks
  const centres: number[][] = [...new Set(keep)].filter((h) => colours.has(h)).map((h) => [...lab(h)]);
  const fixedN = centres.length;
  if (centres.length === 0) {
    let best = 0;
    for (let i = 1; i < hexes.length; i++) if (wts[i] > wts[best]) best = i;
    centres.push([...pts[best]]);
  }
  const near = new Float64Array(hexes.length).fill(Infinity);
  while (centres.length < k) {
    const c = centres[centres.length - 1];
    let far = -1, farD = -1;
    for (let i = 0; i < pts.length; i++) {
      near[i] = Math.min(near[i], d2(pts[i], c));
      const score = near[i] * Math.sqrt(wts[i]);
      if (score > farD) {
        farD = score;
        far = i;
      }
    }
    centres.push([...pts[far]]);
  }
  const assign = new Int32Array(pts.length);
  for (let it = 0; it < 24; it++) {
    for (let i = 0; i < pts.length; i++) {
      let bj = 0, bd = Infinity;
      for (let j = 0; j < centres.length; j++) {
        const d = d2(pts[i], centres[j]);
        if (d < bd) {
          bd = d;
          bj = j;
        }
      }
      assign[i] = bj;
    }
    let moved = false;
    for (let j = fixedN; j < centres.length; j++) {
      let sw = 0;
      const s = [0, 0, 0];
      for (let i = 0; i < pts.length; i++) {
        if (assign[i] !== j) continue;
        sw += wts[i];
        for (let c = 0; c < 3; c++) s[c] += pts[i][c] * wts[i];
      }
      if (sw === 0) {
        // an empty centre takes the colour worst served by its own (the first such, for determinism)
        let far = -1, farD = 0;
        for (let i = 0; i < pts.length; i++) {
          const d = d2(pts[i], centres[assign[i]]) * wts[i];
          if (d > farD) {
            farD = d;
            far = i;
          }
        }
        if (far >= 0) {
          centres[j] = [...pts[far]];
          assign[far] = j;
          moved = true;
        }
        continue;
      }
      for (let c = 0; c < 3; c++) {
        const v = s[c] / sw;
        if (Math.abs(v - centres[j][c]) > 1e-6) moved = true;
        centres[j][c] = v;
      }
    }
    if (!moved) break;
  }
  // each centre becomes the member colour nearest to it (the heaviest on a tie): no new, muddy colours
  const out = new Set<number>();
  for (let j = 0; j < centres.length; j++) {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (assign[i] !== j) continue;
      const d = d2(pts[i], centres[j]) - wts[i] * 1e-9;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    if (bi >= 0) out.add(hexes[bi]);
  }
  return [...out].sort((a, b) => a - b);
}

/** Maps an image onto a palette: every pixel takes its nearest palette colour in Lab. No dithering. */
export class Quantiser {
  private readonly labs: [number, number, number][];
  private readonly memo = new Map<number, number>();
  constructor(readonly palette: readonly number[]) {
    this.labs = palette.map(lab);
  }
  map(hex: number): number {
    let m = this.memo.get(hex);
    if (m !== undefined) return m;
    const p = lab(hex);
    let bd = Infinity;
    m = this.palette[0];
    for (let j = 0; j < this.labs.length; j++) {
      const q = this.labs[j];
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (d < bd) {
        bd = d;
        m = this.palette[j];
      }
    }
    this.memo.set(hex, m);
    return m;
  }
  /**
   * The picture on the palette. With `bgMask`, the background keeps its own colour `bg` and nothing else may take it
   * (a shadowed cheek mapped onto the ground colour would read as a hole in the face).
   */
  apply(img: Img, bgMask?: Uint8Array, bg?: number): Img {
    const out = new Uint32Array(img.length);
    if (!bgMask || bg === undefined) {
      for (let i = 0; i < img.length; i++) out[i] = this.map(img[i]);
      return out;
    }
    const rest = this.without(bg);
    for (let i = 0; i < img.length; i++) out[i] = bgMask[i] ? bg : rest.map(img[i]);
    return out;
  }

  private rest: Quantiser | null = null;
  private without(bg: number): Quantiser {
    this.rest ??= new Quantiser(this.palette.filter((c) => c !== bg));
    return this.rest;
  }
}

// ------------------------------------------------------------------------------------------------- grey

/**
 * The fallen's greys: twelve neutral steps from the ink to the cream line (02-look.md §4 mark colours), by
 * lightness. A grey portrait keeps the colour portrait's values, so the face reads the same.
 */
const GREY_STEPS = 12;
export const GREYS: number[] = (() => {
  const lo = lab(0x16120f)[0], hi = lab(0xf1ead6)[0];
  const out: number[] = [];
  for (let i = 0; i < GREY_STEPS; i++) out.push(fromLab(lo + ((hi - lo) * i) / (GREY_STEPS - 1), 0, 0));
  return out;
})();

const GREY_LIFT = 0.12;
const GREY_GAMMA = 0.7;

export function grey(img: Img): Img {
  const lo = lab(GREYS[0])[0], hi = lab(GREYS[GREYS.length - 1])[0];
  const memo = new Map<number, number>();
  const out = new Uint32Array(img.length);
  for (let i = 0; i < img.length; i++) {
    let g = memo.get(img[i]);
    if (g === undefined) {
      // lifted and flattened a little, so a dark face still shows its features in the grey of the fallen
      const t = Math.max(0, Math.min(1, (lab(img[i])[0] - lo) / (hi - lo)));
      const k = Math.round((GREY_LIFT + (1 - GREY_LIFT) * t ** GREY_GAMMA) * (GREY_STEPS - 1));
      g = GREYS[Math.max(0, Math.min(GREY_STEPS - 1, k))];
      memo.set(img[i], g);
    }
    out[i] = g;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- canvas

export function toCanvas(img: Img): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const data = ctx.createImageData(W, H);
  for (let i = 0; i < img.length; i++) {
    const v = img[i];
    data.data[i * 4] = (v >> 16) & 255;
    data.data[i * 4 + 1] = (v >> 8) & 255;
    data.data[i * 4 + 2] = v & 255;
    data.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

/** Adds a one-pixel outline in `ink` round everything that is not the background. */
export function outline(img: Img, bg: number, ink: number): void {
  const edge: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (img[i] === bg) continue;
      const out = (dx: number, dy: number) => {
        const xx = x + dx, yy = y + dy;
        // the bottom edge cuts the shoulders off: no outline along it
        if (yy >= H) return false;
        return xx < 0 || xx >= W || yy < 0 || img[yy * W + xx] === bg;
      };
      if (out(1, 0) || out(-1, 0) || out(0, 1) || out(0, -1)) edge.push(i);
    }
  }
  for (const i of edge) img[i] = ink;
}

// ------------------------------------------------------------------------------------------------- checks

/**
 * The checks the faces lab prints, and the crop of 01-flow §7 step 3, read from the pixels: the eyes' row is the mean
 * row of the eye pixels (`eye(x, y)`), the eyes' column their mean column; the head's middle is the middle of the
 * head's own run of pixels (`head`, the skull and face as painted, under any hair or helmet) on the eyes' row.
 */
export function measure(eye: (x: number, y: number) => boolean, head: Uint8Array): { eyeY: number; midX: number; eyes: number } | null {
  let n = 0, sy = 0, sx = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!eye(x, y)) continue;
      n++;
      sy += y;
      sx += x;
    }
  }
  if (n === 0) return null;
  const ey = Math.round(sy / n);
  let l = Math.round(sx / n), r = l;
  if (!head[ey * W + l]) return { eyeY: sy / n, midX: NaN, eyes: n };
  while (l > 0 && head[ey * W + l - 1]) l--;
  while (r < W - 1 && head[ey * W + r + 1]) r++;
  return { eyeY: sy / n, midX: (l + r) / 2, eyes: n };
}

/** Moves a picture by whole pixels (01-flow §7 step 3's crop); uncovered pixels take the edge's. */
export function shift(img: Img, dx: number, dy: number): Img {
  if (dx === 0 && dy === 0) return img;
  const out = new Uint32Array(img.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.max(0, Math.min(W - 1, x - dx)), sy = Math.max(0, Math.min(H - 1, y - dy));
      out[y * W + x] = img[sy * W + sx];
    }
  }
  return out;
}
