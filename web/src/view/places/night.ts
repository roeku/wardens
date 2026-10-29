import { RIGHT, UP } from '../camera';
import { MAX_LIGHTS } from '../shaders';
import type { Tier } from '../renderer';
import type { View } from '../view';

// The night (docs/spec/02-look.md §3 "Night", "Lights"): the darkness is done in the CELL pass, a moonlight tint
// with banded pools round each light. The lights come from the sim (lit torches, burning houses, smouldering ruins,
// the shrines' and the wagons' fires), each a world point with a reach in tiles and a strength. They are projected to
// cell pixels from their world-fixed screen position less the camera's whole-pixel origin, so a pool moves by whole
// pixels with the view; sorted nearest the screen's centre first and capped by tier: 48, 24 or 12.

export const LIGHT_CAP: Record<Tier, number> = { high: 48, mid: 24, low: 12 };

/** Light records as the sim packs them (places_api.rs `LIGHTS`). */
export const LIGHT = { X: 0, Y: 1, REACH: 2, STRENGTH: 3, KIND: 4, OF: 5, FIELDS: 6 } as const;
export const LIGHT_KIND = { torch: 0, house: 1, ruin: 2, fire: 3 } as const;

/** How high above the ground each kind of light burns, tiles (chosen: a torch at hand height, a roof's fire). */
const LIFT = [0.75, 0.9, 0.2, 0.3] as const;

interface Lit {
  x: number;
  y: number;
  r: number;
  s: number;
  d: number;
}

export class NightLights {
  private readonly pool: Lit[] = Array.from({ length: 256 }, () => ({ x: 0, y: 0, r: 0, s: 0, d: 0 }));
  private readonly order: Lit[] = [];
  /** The sim's level last written to the view (a dev's own `night(k)` stands until the sim's level changes). */
  private written = -1;

  constructor(
    private readonly view: View,
    private readonly cap: number,
  ) {}

  /**
   * Sets the view's night level from the sim's (already eased there, 02-look.md §3) and fills the CELL pass's
   * lights from `lights` (`n` records). `at(k, out)` may move a torch to where its bearer is drawn.
   */
  update(level: number, lights: Float32Array, n: number, ground: (x: number, y: number) => number, at: (bearer: number) => { x: number; z: number } | null): void {
    const v = this.view;
    if (level !== this.written) {
      v.nightK = level;
      this.written = level;
    }
    if (v.nightK <= 0) {
      v.lightN = 0;
      return;
    }
    const s = v.camera.s;
    const { aw, ah } = v.renderer.size;
    const hx = (aw + 2) / 2;
    const hy = (ah + 2) / 2;
    const ox = v.camera.origin.x;
    const oy = v.camera.origin.y;
    this.order.length = 0;
    const m = Math.min(n, this.pool.length);
    for (let i = 0; i < m; i++) {
      const o = i * LIGHT.FIELDS;
      let x = lights[o + LIGHT.X];
      let z = lights[o + LIGHT.Y];
      const kind = lights[o + LIGHT.KIND];
      if (kind === LIGHT_KIND.torch) {
        const drawn = at(lights[o + LIGHT.OF]);
        if (drawn) {
          x = drawn.x;
          z = drawn.z;
        }
      }
      const y = ground(x, z) + (LIFT[kind] ?? 0.5);
      // World-fixed screen pixels, less the camera's whole-pixel origin: the pool shifts by whole pixels.
      const sx = Math.round((x * RIGHT.x + y * RIGHT.y + z * RIGHT.z) * s) - ox + hx - 0.5;
      const sy = Math.round((x * UP.x + y * UP.y + z * UP.z) * s) - oy + hy - 0.5;
      const r = lights[o + LIGHT.REACH] * s;
      // Off the screen by more than its reach: no pool on it.
      if (sx < -r || sy < -r || sx > aw + 2 + r || sy > ah + 2 + r) continue;
      const l = this.pool[i];
      l.x = sx;
      l.y = sy;
      l.r = r;
      l.s = lights[o + LIGHT.STRENGTH];
      l.d = (sx - hx) * (sx - hx) + (sy - hy) * (sy - hy);
      this.order.push(l);
    }
    this.order.sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y);
    const k = Math.min(this.order.length, this.cap, MAX_LIGHTS);
    for (let i = 0; i < k; i++) {
      const l = this.order[i];
      v.lights[i * 4] = l.x;
      v.lights[i * 4 + 1] = l.y;
      v.lights[i * 4 + 2] = l.r;
      v.lights[i * 4 + 3] = l.s;
    }
    v.lightN = k;
  }
}
