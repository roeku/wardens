import type { Land } from '../sim-pkg/sim_wasm.js';

// The land as the sim makes it (docs/spec/03-land.md §4–§5), in plain typed arrays: no three.js here, so the land
// worker can import it.

/** Heights are sampled every half tile (03-land.md §1). */
export const HEIGHT_STEP = 0.5;
/** The water surface, below the land's mean (03-land.md §1). */
export const WATER_Y = -0.22;

export const PARTS = ['wood', 'leaf', 'tier', 'stone', 'hay'] as const;
export type PartName = (typeof PARTS)[number];

export interface PartData {
  /** 16 floats per instance, column-major. */
  mat: Float32Array;
  /** 3 floats per instance, 0..1 RGB, the palette's hex values unconverted. */
  col: Float32Array;
}

export interface LandData {
  /** The map's size in tiles. */
  w: number;
  h: number;
  /** Tiles of country past every edge; the extended grid starts at map (−border, −border). */
  border: number;
  /** Texels per tile. */
  tex: number;
  /** The extended grid in tiles. */
  ew: number;
  eh: number;
  /** `(2ew+1) × (2eh+1)` samples every half tile, row-major from the north. Inside the map, the map's own. */
  heights: Float32Array;
  /** `ew·tex × eh·tex` RGBA texels, row-major from the north. */
  rgba: Uint8Array;
  /** Per extended tile, 1 where a water quad goes. */
  water: Uint8Array;
  parts: Record<PartName, PartData>;
  /** How long the sim took to make it, in ms, and where. */
  ms: number;
  where: 'inline' | 'worker';
}

/** Moves every buffer out of a WASM `Land` and frees it. */
export function takeLand(l: Land, ms: number, where: LandData['where']): LandData {
  const parts = {} as Record<PartName, PartData>;
  for (const p of PARTS) parts[p] = { mat: l.take_mat(p), col: l.take_col(p) };
  const out: LandData = {
    w: l.map_w,
    h: l.map_h,
    border: l.border,
    tex: l.tex,
    ew: l.ew,
    eh: l.eh,
    heights: l.take_heights(),
    rgba: l.take_rgba(),
    water: l.take_water(),
    parts,
    ms,
    where,
  };
  l.free();
  return out;
}

/**
 * The ground's height at sim (x, y), on the same two triangles per half-tile cell as the terrain mesh (corners
 * a=(i,j), b=(i,j+1), c=(i+1,j+1), d=(i+1,j); triangles abd and bcd), so things stand exactly on the drawn ground.
 */
export function groundAt(land: LandData, x: number, y: number): number {
  const hw = land.ew * 2 + 1;
  const hh = land.eh * 2 + 1;
  const u = Math.max(0, Math.min(hw - 1, (x + land.border) / HEIGHT_STEP));
  const v = Math.max(0, Math.min(hh - 1, (y + land.border) / HEIGHT_STEP));
  const i = Math.min(Math.floor(u), hw - 2);
  const j = Math.min(Math.floor(v), hh - 2);
  const fu = u - i;
  const fv = v - j;
  const H = land.heights;
  const a = H[j * hw + i];
  const b = H[(j + 1) * hw + i];
  const c = H[(j + 1) * hw + i + 1];
  const d = H[j * hw + i + 1];
  return fu + fv <= 1 ? a + (d - a) * fu + (b - a) * fv : c + (b - c) * (1 - fu) + (d - c) * (1 - fv);
}
