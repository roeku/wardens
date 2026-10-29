// Typed orders (docs/spec/06-voice.md §3, 08-orders.md §9): Enter opens a single line drawn in the 5×7 bitmap font at
// the bottom edge; Enter sends its words through the voice pipeline without speech-to-text; Escape closes it. While
// it is open it takes every key, so Space types a space instead of pausing.

import { ADVANCE, GLYPH_H, drawText, hasGlyph } from '../../view/font5x7';
import type { View } from '../../view/view';

/** The line's height in art pixels: the glyphs and a 2-pixel margin above and below. */
const LINE_H = GLYPH_H + 4;
const MARGIN_X = 3;
const INK = '#16120f';
const CREAM = '#f1ead6';
const DIM = '#8a8170';
/** The prompt mark before the words. */
const PROMPT = '>';

export class TypedLine {
  /** Whether the line is open and taking keys. */
  isOpen = false;
  text = '';
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private drawn = '';

  constructor(
    private readonly view: View,
    private readonly hooks: { open(): void; submit(text: string): void; close(): void },
    private readonly enabled: boolean,
  ) {
    const s = this.canvas.style;
    s.position = 'fixed';
    s.left = '0';
    s.imageRendering = 'pixelated';
    s.pointerEvents = 'none';
    s.display = 'none';
    this.ctx = this.canvas.getContext('2d')!;
    document.body.appendChild(this.canvas);
    window.addEventListener('keydown', (e) => this.key(e), { capture: true });
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.text = '';
    this.canvas.style.display = 'block';
    this.hooks.open();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.canvas.style.display = 'none';
    this.hooks.close();
  }

  private key(e: KeyboardEvent): void {
    if (!this.isOpen) {
      if (this.enabled && e.key === 'Enter' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.open();
      }
      return;
    }
    // the line takes every key while open: no pause, no pan, no V
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Enter') {
      const words = this.text.trim();
      this.close();
      if (words) this.hooks.submit(words);
    } else if (e.key === 'Escape') this.close();
    else if (e.key === 'Backspace') this.text = this.text.slice(0, -1);
    else if (e.key.length === 1 && (e.key === ' ' || hasGlyph(e.key)) && this.text.length < this.room()) this.text += e.key.toUpperCase();
  }

  /** Characters that fit on the line. */
  private room(): number {
    return Math.max(8, Math.floor((this.view.renderer.size.aw - 2 * MARGIN_X) / ADVANCE) - 2);
  }

  /** Redraws the line when it changed or the caret blinks (call once per frame). */
  draw(): void {
    if (!this.isOpen) return;
    const { aw, ah, px } = this.view.renderer.size;
    const caret = Math.floor(performance.now() / 500) % 2 === 0;
    const key = `${aw}x${ah}x${px}|${this.text}|${caret}`;
    if (key === this.drawn) return;
    this.drawn = key;
    if (this.canvas.width !== aw || this.canvas.height !== LINE_H) {
      this.canvas.width = aw;
      this.canvas.height = LINE_H;
    }
    const s = this.canvas.style;
    s.width = `${aw * px}px`;
    s.height = `${LINE_H * px}px`;
    s.top = `${(ah - LINE_H) * px}px`;
    const c = this.ctx;
    c.fillStyle = INK;
    c.fillRect(0, 0, aw, LINE_H);
    drawText(c, PROMPT, MARGIN_X, 2, DIM);
    drawText(c, this.text, MARGIN_X + ADVANCE * 2, 2, CREAM);
    if (caret) drawText(c, '_', MARGIN_X + ADVANCE * (2 + this.text.length), 2, CREAM);
  }
}
