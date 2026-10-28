import * as THREE from 'three';
import { DARK_GOLD, DEVICE, GOLD, GRIME, HERALDRY, LINEN_DEVICE, rgb } from './palette';
import { hash32 } from './hash';

// docs/spec/02-look.md §6: the banner texture (16×26 gonfalons, drawn lazily into one atlas) and the shield
// atlas (12×14 heater faces). Patterns are ASCII arrays; '#' is ink.

export const BW = 16;
export const BH = 26;
export const SW = 12;
export const SH = 14;

export const FLEUR = ['...#...', '..###..', '..###..', '#.###.#', '##.#.##', '#..#..#', '#######', '..###..', '.#...#.'];

export type Mark = 'none' | 'spear' | 'shield' | 'bow' | 'horseshoe' | 'crown';
/** The shield device, 5×5. */
export const SHIELD_FLEUR = ['..#..', '.###.', '#.#.#', '#####', '.#.#.'];

/** Heraldry ramp: 0 blue, 1 red, 2 the freed villages' linen. */
export type Ramp = 0 | 1 | 2;

/** A gonfalon layout: the spec's 16×26 ("near"), and a 12×20 drawn 1:1 when the near one would be minified ("far"). */
interface Layout {
  w: number;
  h: number;
  emblem: string[];
  emblemAt: readonly [number, number];
  marks: Record<Exclude<Mark, 'none'>, string[]>;
  /** The kind mark's centre row. */
  markCy: number;
  /** Swallowtail rows, and the dark (ramp[1]) columns at the right. */
  tail: number;
  dark: number;
  /** The mark is centred on this column. */
  cx: number;
}

export const NEAR: Layout = {
  w: BW,
  h: BH,
  emblem: FLEUR,
  emblemAt: [4, 4],
  // kind marks, 5–7 px wide, centred at y = 15
  marks: {
    spear: ['..#..', '.###.', '.###.', '..#..', '..#..'],
    shield: ['#####', '#####', '#####', '.###.', '..#..'],
    bow: ['.#.....', '..#..#.', '#######', '..#..#.', '.#.....'],
    horseshoe: ['.###.', '#...#', '#...#', '#...#', '##.##'],
    crown: ['#..#..#', '##.#.##', '#######', '#######'],
  },
  markCy: 15,
  tail: 5,
  dark: 3,
  cx: 7,
};

export const FAR: Layout = {
  w: 12,
  h: 20,
  emblem: ['..#..', '.###.', '#.#.#', '#####', '..#..', '.#.#.'],
  emblemAt: [3, 3],
  marks: {
    spear: ['.#.', '###', '.#.', '.#.'],
    shield: ['###', '###', '.#.'],
    bow: ['.#..#', '#####', '.#..#'],
    horseshoe: ['###', '#.#', '#.#'],
    crown: ['#.#.#', '#####', '#####'],
  },
  markCy: 12,
  tail: 4,
  dark: 2,
  cx: 5,
};

export interface BannerLook {
  ramp: Ramp;
  mark: Mark;
  /** 0..3, from men lost / company size (02-look.md §6). */
  tatter: number;
  captain: boolean;
  /** Which holes and tears (a hash of the squad id). */
  variant: number;
}

/** Tatter stage from men lost: lost/size < 0.2, < 0.6, < 1.2, and beyond. */
export function tatterStage(lost: number, size: number): number {
  const k = size > 0 ? lost / size : 0;
  return k < 0.2 ? 0 : k < 0.6 ? 1 : k < 1.2 ? 2 : 3;
}

type RGBA = [number, number, number, number];
const toRGBA = (hex: number, a = 255): RGBA => {
  const [r, g, b] = rgb(hex);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), a];
};
const CLEAR: RGBA = [0, 0, 0, 0];

function mix(a: number, b: number, k: number): number {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const c = (x: number, y: number) => Math.round((x + (y - x) * k) * 255);
  return (c(ar, br) << 16) | (c(ag, bg) << 8) | c(ab, bb);
}

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** Paints one gonfalon (row 0 at the top) in the given layout. */
export function paintBanner(look: BannerLook, L: Layout = NEAR): RGBA[][] {
  const { w: W, h: H } = L;
  const ramp = HERALDRY[look.ramp];
  const linen = look.ramp === 2;
  const device = look.captain ? GOLD : linen ? LINEN_DEVICE : DEVICE;
  // the kind mark: 0.6 × device + 0.4 × ramp[3]
  const markCol = mix(device, ramp[3], 0.4);
  const g: (number | null)[][] = [];
  for (let y = 0; y < H; y++) {
    const row: (number | null)[] = [];
    for (let x = 0; x < W; x++) row.push(x >= W - 1 - L.dark ? ramp[1] : ramp[2]);
    g.push(row);
  }
  const fold = look.captain ? 2 : 1;
  for (let x = 0; x < W; x++) g[fold][x] = ramp[3];

  // the swallowtail notch in the bottom rows
  for (let y = H - L.tail; y < H; y++) {
    const half = (y - (H - L.tail)) * ((W / 2 - 2.2) / (L.tail - 1)) + 0.5;
    for (let x = 0; x < W; x++) if (Math.abs(x + 0.5 - W / 2) <= half) g[y][x] = null;
  }

  // the device and the kind mark, remembered (with a margin) so holes never touch them
  const keep = new Set<number>();
  const stamp = (pat: string[], x0: number, y0: number, col: number) => {
    pat.forEach((line, dy) =>
      [...line].forEach((ch, dx) => {
        if (ch !== '#') return;
        g[y0 + dy][x0 + dx] = col;
        for (const [ox, oy] of [[0, 0], ...N4]) keep.add((y0 + dy + oy) * W + x0 + dx + ox);
      }),
    );
  };
  stamp(L.emblem, L.emblemAt[0], L.emblemAt[1], device);
  if (look.mark !== 'none') {
    const pat = L.marks[look.mark];
    stamp(pat, L.cx - Math.floor(pat[0].length / 2), L.markCy - Math.floor(pat.length / 2), markCol);
  }

  // tatters: 1 the tail is eaten, 2 the fly is torn, 3 holes beside the device and grime
  const h = (salt: number) => hash32(look.variant, salt, 77);
  if (look.tatter >= 1) {
    for (let x = 0; x < W; x++) {
      const bite = Math.round(L.tail * 0.4) + (h(x) % 3 === 0 ? 1 : 0);
      for (let y = H - bite; y < H; y++) g[y][x] = null;
    }
  }
  if (look.tatter >= 2) {
    const span = Math.round(H * 0.27);
    const y0 = Math.round(H * 0.35) + (h(31) % Math.round(H * 0.22));
    for (let y = y0; y < Math.min(H - L.tail, y0 + span); y++) {
      const depth = 1 + Math.round((W / 6.4) * Math.sin(((y - y0) / (span - 1)) * Math.PI)) + (h(y) % 2);
      for (let x = W - depth; x < W; x++) if (!keep.has(y * W + x)) g[y][x] = null;
    }
  }
  if (look.tatter >= 3) {
    let made = 0;
    for (let k = 0; k < 60 && made < 3; k++) {
      const x = 1 + (h(100 + k) % (W - 4));
      const y = 3 + (h(200 + k) % (H - L.tail - 4));
      if (keep.has(y * W + x) || keep.has(y * W + x + 1) || g[y][x] === null || g[y][x + 1] === null) continue;
      g[y][x] = null;
      if (h(300 + k) % 2) g[y][x + 1] = null;
      made++;
    }
  }

  // the outline: every cloth pixel on the edge or next to a cut is ramp[0] (dark gold for the captain), and
  // the captain's banner has a gold ring just inside it
  const edge = (x: number, y: number) =>
    x === 0 || y === 0 || x === W - 1 || y === H - 1 || N4.some(([dx, dy]) => g[y + dy]?.[x + dx] == null);
  const out: RGBA[][] = g.map((row) => row.map((c) => (c === null ? CLEAR : toRGBA(c))));
  const outer = new Set<number>();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y][x] !== null && edge(x, y)) {
    out[y][x] = toRGBA(look.captain ? DARK_GOLD : ramp[0]);
    outer.add(y * W + x);
  }
  if (look.captain) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (g[y][x] === null || outer.has(y * W + x)) continue;
      if (g[y][x] === device || g[y][x] === markCol) continue;
      if (N4.some(([dx, dy]) => outer.has((y + dy) * W + x + dx))) out[y][x] = toRGBA(GOLD);
    }
  }
  if (look.tatter >= 3) {
    for (const row of out) for (const p of row) if (p[3]) {
      p[0] = Math.round(p[0] * GRIME[0]);
      p[1] = Math.round(p[1] * GRIME[1]);
      p[2] = Math.round(p[2] * GRIME[2]);
    }
  }
  return out;
}

/** Paints one heater shield face, 12×14: two-tone halves, an edge in ramp[0], and the 5×5 device. */
export function paintShield(ramp: Ramp, device: boolean): RGBA[][] {
  const r = HERALDRY[ramp];
  const inside = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= SW || y >= SH) return false;
    if (y < 7) return true;
    const t = (y + 0.5 - 6.5) / 7.6;
    const hw = (SW / 2) * Math.sqrt(Math.max(0, 1 - t * t));
    return Math.abs(x + 0.5 - SW / 2) < hw;
  };
  const out: RGBA[][] = [];
  for (let y = 0; y < SH; y++) {
    const row: RGBA[] = [];
    for (let x = 0; x < SW; x++) {
      if (!inside(x, y)) row.push(CLEAR);
      else if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !inside(x + dx, y + dy))) row.push(toRGBA(r[0]));
      else row.push(toRGBA(x < SW / 2 ? r[2] : r[1]));
    }
    out.push(row);
  }
  if (device) {
    const col = toRGBA(ramp === 2 ? LINEN_DEVICE : DEVICE);
    SHIELD_FLEUR.forEach((line, dy) => [...line].forEach((ch, dx) => {
      if (ch === '#') out[3 + dy][4 + dx - 1] = [...col] as RGBA;
    }));
  }
  return out;
}

/** A texture of fixed-size cells, filled on demand. Cells keep a 1-pixel clear gutter so nearest sampling never bleeds. */
class CellAtlas {
  readonly texture: THREE.DataTexture;
  private readonly data: Uint8Array;
  private readonly cols: number;
  private readonly keys = new Map<string, number>();
  private readonly W: number;
  private readonly H: number;

  constructor(private readonly cw: number, private readonly ch: number, cols: number, rows: number) {
    this.cols = cols;
    this.W = cols * (cw + 1);
    this.H = rows * (ch + 1);
    this.data = new Uint8Array(this.W * this.H * 4);
    this.texture = new THREE.DataTexture(this.data, this.W, this.H, THREE.RGBAFormat);
    this.texture.magFilter = this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;
  }

  /** The tile `(u0, v0, du, dv)` for a key, painting it on first use. */
  tile(key: string, paint: () => RGBA[][], out: Float32Array | number[], o = 0): void {
    let i = this.keys.get(key);
    if (i === undefined) {
      i = this.keys.size;
      const capacity = this.cols * Math.floor(this.H / (this.ch + 1));
      if (i >= capacity) i = capacity - 1; // a full atlas reuses its last cell rather than failing
      else this.keys.set(key, i);
      const px = paint();
      const x0 = (i % this.cols) * (this.cw + 1);
      const y0 = Math.floor(i / this.cols) * (this.ch + 1);
      for (let y = 0; y < this.ch; y++) {
        for (let x = 0; x < this.cw; x++) {
          // DataTexture row 0 is v = 0 (the bottom); the painted row 0 is the top
          const k = ((y0 + this.ch - 1 - y) * this.W + x0 + x) * 4;
          this.data.set(px[y][x], k);
        }
      }
      this.texture.needsUpdate = true;
    }
    const x0 = (i % this.cols) * (this.cw + 1);
    const y0 = Math.floor(i / this.cols) * (this.ch + 1);
    out[o] = x0 / this.W;
    out[o + 1] = y0 / this.H;
    out[o + 2] = this.cw / this.W;
    out[o + 3] = this.ch / this.H;
  }
}

/** All banner gonfalons in play, near (16×26) and far (12×20), painted lazily. */
export class BannerAtlas extends CellAtlas {
  private readonly far = new FarAtlas();
  get farTexture(): THREE.DataTexture {
    return this.far.texture;
  }
  constructor() {
    super(BW, BH, 24, 12);
  }
  get(look: BannerLook, far: boolean, out: Float32Array | number[], o = 0): void {
    const v = look.tatter >= 2 ? look.variant & 3 : 0;
    const key = `${look.ramp}|${look.mark}|${look.tatter}|${look.captain ? 1 : 0}|${v}`;
    if (far) this.far.tile(key, () => paintBanner({ ...look, variant: v }, FAR), out, o);
    else this.tile(key, () => paintBanner({ ...look, variant: v }, NEAR), out, o);
  }
}

class FarAtlas extends CellAtlas {
  constructor() {
    super(FAR.w, FAR.h, 24, 12);
  }
}

/** Heater shield faces: per heraldry ramp, with and without the device. */
export class ShieldAtlas extends CellAtlas {
  constructor() {
    super(SW, SH, 6, 1);
    for (const ramp of [0, 1, 2] as Ramp[]) for (const d of [false, true]) this.get(ramp, d, [0, 0, 0, 0]);
  }
  get(ramp: Ramp, device: boolean, out: Float32Array | number[], o = 0): void {
    this.tile(`${ramp}|${device ? 1 : 0}`, () => paintShield(ramp, device), out, o);
  }
}
