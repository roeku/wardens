import type { P } from '../contracts';
import { RIGHT, UP } from '../view/camera';
import { groundAt } from '../view/land-data';
import type { View } from '../view/view';

// Screen ↔ world for the input, as the last frame was drawn (02-look.md §2 "Picking"). The camera puts world
// point W at art pixel S = (W·RIGHT, W·UP)·s; the scene target is centred on the camera's whole-pixel origin and
// POST adds back the leftover fraction `sub`, so the CSS pixel (from the canvas's top-left) is
//   x = (S.x − origin.x − sub.x + aw/2)·px,   y = (ah/2 − (S.y − origin.y − sub.y))·px.

const SQRT2 = Math.SQRT2;
const COS_PITCH = Math.sqrt(3) / 2;
/** 02-look.md §2: groundAt walks the ray down from 6 tiles up in 0.08 steps, then bisects 8 times. */
const RAY_TOP = 6;
const RAY_STEP = 0.08;
const RAY_BOTTOM = -4;
const BISECT = 8;

export class Screen {
  constructor(private readonly view: View) {}

  /** Art pixels per tile now. */
  get s(): number {
    return this.view.camera.s;
  }

  /** CSS pixels per art pixel. */
  get px(): number {
    return this.view.renderer.size.px;
  }

  /** The CSS pixel (canvas top-left origin) of world (x east, h up, y south). */
  project(x: number, h: number, y: number, out: { x: number; y: number }): { x: number; y: number } {
    const s = this.view.camera.s;
    return this.fromArt((x * RIGHT.x + h * RIGHT.y + y * RIGHT.z) * s, (x * UP.x + h * UP.y + y * UP.z) * s, out);
  }

  /** The CSS pixel of art pixel coordinates (whole pixels from the world origin, as `snapFigure` gives). */
  fromArt(ax: number, ay: number, out: { x: number; y: number }): { x: number; y: number } {
    const c = this.view.camera;
    const { px, aw, ah } = this.view.renderer.size;
    out.x = (ax - c.origin.x - c.sub.x + aw / 2) * px;
    out.y = (ah / 2 - (ay - c.origin.y - c.sub.y)) * px;
    return out;
  }

  /** Screen-up of `h` tiles of height, in CSS pixels. */
  rise(h: number): number {
    return h * COS_PITCH * this.view.camera.s * this.view.renderer.size.px;
  }

  /** CSS pixels per tile along the screen's right. */
  get tilePx(): number {
    return this.view.camera.s * this.view.renderer.size.px;
  }

  /** CSS pixel (canvas top-left origin) of a client point. */
  local(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.view.canvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  /** The canvas's size in CSS pixels. */
  size(): { w: number; h: number } {
    const { px, aw, ah } = this.view.renderer.size;
    return { w: aw * px, h: ah * px };
  }

  /**
   * The ground point (sim x, y) under the CSS pixel (x, y): the pixel's ray walked down from 6 tiles up in 0.08
   * steps until it passes under the land, then bisected 8 times (02-look.md §2 "Picking").
   */
  ground(x: number, y: number): P {
    const c = this.view.camera;
    const { px, aw, ah } = this.view.renderer.size;
    const s = c.s;
    const a = (x / px - aw / 2 + c.origin.x + c.sub.x) / s;
    const u = (ah / 2 - y / px + c.origin.y + c.sub.y) / s;
    const land = this.view.land;
    // the point on the ray at height h: P·RIGHT = a, P·UP = u
    const at = (h: number): [number, number] => {
      const sa = SQRT2 * a;
      const d = 2 * SQRT2 * (u - COS_PITCH * h);
      return [(sa + d) / 2, (sa - d) / 2];
    };
    const above = (h: number) => {
      const [px2, pz] = at(h);
      return h > groundAt(land, px2, pz);
    };
    let hi = RAY_TOP;
    let lo = hi;
    while (lo > RAY_BOTTOM) {
      lo = hi - RAY_STEP;
      if (!above(lo)) break;
      hi = lo;
    }
    for (let i = 0; i < BISECT; i++) {
      const mid = (hi + lo) / 2;
      if (above(mid)) hi = mid;
      else lo = mid;
    }
    const [gx, gy] = at((hi + lo) / 2);
    return { x: gx, y: gy };
  }
}
