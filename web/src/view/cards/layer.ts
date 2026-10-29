import type { View } from '../view';

// A pixel layer over the view (docs/spec/01-flow.md §3 "Diegetic UI rules"; 02-look.md §9): a canvas of whole "ui
// pixels", each an integer number of art pixels, scaled up with hard edges like the scene. No browser font, and no
// alpha blending: every pixel is opaque or empty, and anything see-through is the 4×4 Bayer dither.

/** The 4×4 Bayer matrix, 0..15 (02-look.md §1). */
export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Whether ui pixel (x, y) is lit at dither level k (0 none … 1 all). */
export const dithered = (x: number, y: number, k: number): boolean => (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 < k;

/**
 * Art pixels per ui pixel: 2 on a screen whose art pixel is one CSS pixel (a phone), else 1, so the 5×7 glyphs stand
 * 14 CSS pixels or more everywhere (chosen; out/decisions-d5-screens.md "The ui pixel").
 */
export function uiScale(px: number): number {
  return px >= 2 ? 1 : 2;
}

export class PixelLayer {
  readonly canvas = document.createElement('canvas');
  readonly ctx: CanvasRenderingContext2D;
  /** The layer in ui pixels. */
  w = 0;
  h = 0;
  /** Art pixels per ui pixel, and CSS pixels per art pixel. */
  u = 1;
  px = 1;
  /** Bumped whenever the layer is resized (and so blanked): a drawing made for an older one must be redone. */
  gen = 0;

  constructor(
    private readonly view: View,
    z: number,
  ) {
    const s = this.canvas.style;
    s.position = 'fixed';
    s.left = '0';
    s.top = '0';
    s.imageRendering = 'pixelated';
    s.pointerEvents = 'none';
    s.zIndex = String(z);
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;
    document.body.appendChild(this.canvas);
    this.fit();
  }

  /** Follows the view's size; returns whether it changed (the layer is then blank). */
  fit(): boolean {
    const { px, aw, ah } = this.view.renderer.size;
    const u = uiScale(px);
    const w = Math.max(1, Math.ceil(aw / u));
    const h = Math.max(1, Math.ceil(ah / u));
    if (w === this.w && h === this.h && u === this.u && px === this.px) return false;
    this.w = w;
    this.h = h;
    this.u = u;
    this.px = px;
    this.gen++;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${w * u * px}px`;
    this.canvas.style.height = `${h * u * px}px`;
    this.ctx.imageSmoothingEnabled = false;
    return true;
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  /** CSS pixels per ui pixel. */
  get k(): number {
    return this.u * this.px;
  }

  /** The ui pixel under a CSS point (canvas top-left origin). */
  toUi(x: number, y: number): { x: number; y: number } {
    return { x: Math.floor(x / this.k), y: Math.floor(y / this.k) };
  }

  show(on: boolean): void {
    this.canvas.style.display = on ? 'block' : 'none';
  }

  dispose(): void {
    this.canvas.remove();
  }
}

/** Fills a rectangle of whole ui pixels. */
export function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, colour: string): void {
  ctx.fillStyle = colour;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/**
 * Draws `src` onto `ctx` at (x, y) showing only the pixels the Bayer dither lights at level k (0..1): a fade with no
 * alpha blending. `src`'s own pixels must be opaque or empty.
 */
export function blitDithered(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, x: number, y: number, k: number, scratch: { c?: HTMLCanvasElement; d?: ImageData; key?: HTMLCanvasElement }): void {
  if (k >= 1) {
    ctx.drawImage(src, x, y);
    return;
  }
  if (k <= 0) return;
  const w = src.width;
  const h = src.height;
  if (scratch.key !== src || !scratch.d) {
    scratch.d = src.getContext('2d')!.getImageData(0, 0, w, h);
    scratch.key = src;
  }
  scratch.c ??= document.createElement('canvas');
  const c = scratch.c;
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const out = c.getContext('2d')!.createImageData(w, h);
  const a = scratch.d.data;
  const b = out.data;
  // the dither is fixed to the screen's ui pixels, so a card fading as it rises doesn't crawl
  const ox = Math.round(x);
  const oy = Math.round(y);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 4;
      if (a[o + 3] === 0 || !dithered(i + ox, j + oy, k)) continue;
      b[o] = a[o];
      b[o + 1] = a[o + 1];
      b[o + 2] = a[o + 2];
      b[o + 3] = 255;
    }
  }
  c.getContext('2d')!.putImageData(out, 0, 0);
  ctx.drawImage(c, ox, oy);
}
