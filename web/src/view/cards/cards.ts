import { drawText, GLYPH_H, measure } from '../font5x7';
import type { View } from '../view';
import { blitDithered, PixelLayer, rect } from './layer';
import { drawPicto, pictoWidth, PICTO_H, type Icon } from './picto';
import { faceTile } from './portrait';

// Cards (docs/engine/contracts/campaign.md §5; 01-flow.md §3 "Diegetic UI rules"): a face, a name, at most one word,
// and pictograms, on dark cloth in a frame. A card stands beside the tapped thing, never over it; it rises in 1/6 s
// and fades. Drawn at the ui-pixel scale with the 5×7 font, opaque pixels only: the rise's fade-in and the fade-out
// are the Bayer dither.

export type { Icon } from './picto';

export type PictoColour = 'gold' | 'red' | 'green' | 'grey' | 'cream';

export interface CardSpec {
  /** Drawn by `portrait()` (web/src/view/portraits), or a flat tile in the side's colour until it exists. */
  face?: { face: number; side: 'warden' | 'blight'; grey?: boolean; unit?: string };
  /** Bitmap capitals. */
  name?: string;
  /** At most one word. */
  word?: string;
  picto?: { icon: Icon; n?: number; colour?: PictoColour }[];
  frame?: 'gold' | 'grey';
}

/** 01-flow.md §3: a card rises in 1/6 s; it fades out as fast. */
export const RISE_S = 1 / 6;
/** How far it rises, ui pixels (chosen). */
const RISE_PX = 4;
/** Ui pixels between the card and the thing it stands beside (chosen), past the thing's own radius. */
const GAP = 6;
const PAD = 3;
const BORDER = 1;
const LINE = 2;
const PICTO_GAP = 3;
/** Pictograms wrap at the face's width, or this many ui pixels without a face. */
const ROW_W = 80;

export const COLOUR: Record<PictoColour, string> = {
  gold: '#e8c34a',
  red: '#e0533f',
  green: '#9fd36a',
  grey: '#8a867c',
  cream: '#f1ead6',
};
/** Dark cloth, and the frames: gold (honour) over dark gold, grey, or plain wood. */
const CLOTH = '#1c1713';
const CLOTH_LIGHT = '#2a221c';
const FRAMES = {
  gold: ['#e8c34a', '#9a7a2a'],
  grey: ['#8a867c', '#4e4a44'],
  wood: ['#7a5634', '#35231a'],
} as const;
const NAME = '#f1ead6';
const WORD = '#d8cfb4';

/** Draws a card's picture: the cloth, the frame, the face, the name, the word and the pictograms. */
export function drawCard(spec: CardSpec): HTMLCanvasElement {
  // the pictograms' rows, wrapped at the row width
  const items = (spec.picto ?? []).map((p) => {
    const num = p.n !== undefined ? String(p.n) : '';
    return { ...p, num, w: pictoWidth(p.icon) + (num ? 1 + measure(num) : 0) };
  });
  const rowW = spec.face ? 80 : Math.max(ROW_W, measure(spec.name ?? ''), measure(spec.word ?? ''));
  const rows: (typeof items)[] = [];
  let cur: typeof items = [];
  let x = 0;
  for (const it of items) {
    if (cur.length && x + it.w > rowW) {
      rows.push(cur);
      cur = [];
      x = 0;
    }
    cur.push(it);
    x += it.w + PICTO_GAP;
  }
  if (cur.length) rows.push(cur);
  const textW = Math.max(measure(spec.name ?? ''), measure(spec.word ?? ''), ...rows.map((r) => r.reduce((a, it) => a + it.w + PICTO_GAP, -PICTO_GAP)));
  const innerW = Math.max(spec.face ? 80 : 0, textW);
  const lines = (spec.name ? 1 : 0) + (spec.word ? 1 : 0) + rows.length;
  const innerH = (spec.face ? 96 + (lines ? LINE + 1 : 0) : 0) + lines * (GLYPH_H + LINE) - (lines ? LINE : 0);
  const W = innerW + 2 * (PAD + BORDER + 1);
  const H = innerH + 2 * (PAD + BORDER + 1);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  const [outer, inner] = FRAMES[spec.frame ?? 'wood'];
  rect(g, 0, 0, W, H, outer);
  rect(g, 1, 1, W - 2, H - 2, inner);
  rect(g, 2, 2, W - 4, H - 4, CLOTH);
  // a woven line every fourth row: cloth, not a panel
  for (let y = 4; y < H - 3; y += 4) rect(g, 2, y, W - 4, 1, CLOTH_LIGHT);
  let y = BORDER + 1 + PAD;
  const left = BORDER + 1 + PAD;
  if (spec.face) {
    g.drawImage(faceTile(spec.face.face, spec.face.side, { grey: spec.face.grey, unit: spec.face.unit }), left + Math.floor((innerW - 80) / 2), y);
    y += 96 + LINE + 1;
  }
  if (spec.name) {
    drawText(g, spec.name, left, y, NAME);
    y += GLYPH_H + LINE;
  }
  if (spec.word) {
    drawText(g, spec.word, left, y, WORD);
    y += GLYPH_H + LINE;
  }
  for (const row of rows) {
    let px = left;
    for (const it of row) {
      const col = COLOUR[it.colour ?? 'cream'];
      drawPicto(g, it.icon, px, y + Math.floor((GLYPH_H - PICTO_H) / 2), col);
      if (it.num) drawText(g, it.num, px + pictoWidth(it.icon) + 1, y, col);
      px += it.w + PICTO_GAP;
    }
    y += GLYPH_H + LINE;
  }
  return c;
}

interface Shown {
  id: number;
  img: HTMLCanvasElement;
  at: { x: number; y: number; r: number };
  beside: 'left' | 'right';
  age: number;
  /** Seconds left before it fades by itself (Infinity: until hidden). */
  life: number;
  /** Fading out: seconds into the fade. */
  out: number;
  scratch: { c?: HTMLCanvasElement; d?: ImageData; key?: HTMLCanvasElement };
  /** Where it was last drawn (ui pixels), for taps on it. */
  box: { x: number; y: number; w: number; h: number };
}

/** The cards on screen, on a pixel layer of their own over the view. */
export class Cards {
  private readonly layer: PixelLayer;
  private readonly shown: Shown[] = [];
  private next = 1;
  private dirty = true;

  constructor(view: View, z = 20) {
    this.layer = new PixelLayer(view, z);
  }

  /**
   * Shows a card beside the CSS point `at` (canvas top-left origin; `r`: the thing's own radius in CSS pixels, kept
   * clear), on the side asked for if it fits, else the other. `life`: seconds before it fades by itself.
   */
  show(spec: CardSpec, at: { x: number; y: number; r?: number }, beside: 'left' | 'right', opts: { life?: number } = {}): number {
    const id = this.next++;
    this.shown.push({
      id, img: drawCard(spec), at: { x: at.x, y: at.y, r: at.r ?? 0 }, beside, age: 0, life: opts.life ?? Infinity, out: -1, scratch: {},
      box: { x: 0, y: 0, w: 0, h: 0 },
    });
    this.dirty = true;
    return id;
  }

  /** Redraws a card in place (a tally counting), without rising again. */
  update(id: number, spec: CardSpec): void {
    const s = this.shown.find((c) => c.id === id);
    if (!s) return;
    s.img = drawCard(spec);
    s.scratch = {};
    this.dirty = true;
  }

  /** Moves a card's anchor (the thing moved). */
  move(id: number, at: { x: number; y: number }): void {
    const s = this.shown.find((c) => c.id === id);
    if (s && (s.at.x !== at.x || s.at.y !== at.y)) {
      s.at.x = at.x;
      s.at.y = at.y;
      this.dirty = true;
    }
  }

  /** Fades one card out, or every card. */
  hide(id?: number): void {
    for (const s of this.shown) if ((id === undefined || s.id === id) && s.out < 0) s.out = 0;
    this.dirty = true;
  }

  /** Whether a card is on screen (not fading out). */
  has(id: number): boolean {
    return this.shown.some((s) => s.id === id && s.out < 0);
  }

  /** The card under a CSS point, if any. */
  at(x: number, y: number): number | null {
    const p = this.layer.toUi(x, y);
    for (let i = this.shown.length - 1; i >= 0; i--) {
      const b = this.shown[i].box;
      if (p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h) return this.shown[i].id;
    }
    return null;
  }

  get count(): number {
    return this.shown.filter((s) => s.out < 0).length;
  }

  frame(dt: number): void {
    let moving = this.layer.fit() || this.dirty;
    for (const s of this.shown) {
      const was = s.age;
      s.age += dt;
      if (was < RISE_S) moving = true;
      if (s.out < 0 && s.age >= s.life) s.out = 0;
      if (s.out >= 0) {
        s.out += dt;
        moving = true;
      }
    }
    for (let i = this.shown.length - 1; i >= 0; i--) if (this.shown[i].out >= RISE_S) this.shown.splice(i, 1);
    if (!moving) return;
    this.dirty = false;
    const L = this.layer;
    L.clear();
    for (const s of this.shown) {
      const rise = Math.min(1, s.age / RISE_S);
      const k = s.out >= 0 ? Math.max(0, 1 - s.out / RISE_S) : rise;
      const { x, y } = this.place(s);
      const dy = Math.round((1 - rise) * RISE_PX);
      s.box = { x, y, w: s.img.width, h: s.img.height };
      blitDithered(L.ctx, s.img, x, y + dy, k, s.scratch);
    }
  }

  /** Beside the point, on its side if it fits, else the other; held on screen; never over the point itself. */
  private place(s: Shown): { x: number; y: number } {
    const L = this.layer;
    const k = L.k;
    const ax = s.at.x / k;
    const ay = s.at.y / k;
    const gap = GAP + s.at.r / k;
    const w = s.img.width;
    const h = s.img.height;
    const right = Math.round(ax + gap);
    const left = Math.round(ax - gap - w);
    const fitsRight = right + w <= L.w - 1;
    const fitsLeft = left >= 1;
    let x = s.beside === 'right' ? (fitsRight || !fitsLeft ? right : left) : fitsLeft || !fitsRight ? left : right;
    x = Math.max(1, Math.min(L.w - w - 1, x));
    let y = Math.round(ay - h / 2);
    y = Math.max(1, Math.min(L.h - h - 1, y));
    // squeezed off both sides (a narrow phone): stand above or below the point instead of over it
    if (!fitsRight && !fitsLeft && x < ax + gap && x + w > ax - gap) {
      const above = Math.round(ay - gap - h);
      y = above >= 1 ? above : Math.min(L.h - h - 1, Math.round(ay + gap));
    }
    return { x, y };
  }

  dispose(): void {
    this.shown.length = 0;
    this.layer.dispose();
  }
}

