// The 5×7 bitmap font (docs/spec/01-flow.md §6 "Fonts and words"): capitals, digits and a few marks as ASCII data,
// drawn in whole art pixels and scaled by integer factors only. Never a browser font. Lower case is drawn as
// capitals; a character the font lacks is drawn as a blank.

/** Each glyph is 7 rows of 5 columns, '#' lit. */
const GLYPHS: Record<string, string> = {
  A: '.###. #...# #...# ##### #...# #...# #...#',
  B: '####. #...# #...# ####. #...# #...# ####.',
  C: '.###. #...# #.... #.... #.... #...# .###.',
  D: '####. #...# #...# #...# #...# #...# ####.',
  E: '##### #.... #.... ####. #.... #.... #####',
  F: '##### #.... #.... ####. #.... #.... #....',
  G: '.###. #...# #.... #.### #...# #...# .####',
  H: '#...# #...# #...# ##### #...# #...# #...#',
  I: '.###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.',
  J: '..### ...#. ...#. ...#. ...#. #..#. .##..',
  K: '#...# #..#. #.#.. ##... #.#.. #..#. #...#',
  L: '#.... #.... #.... #.... #.... #.... #####',
  M: '#...# ##.## #.#.# #.#.# #...# #...# #...#',
  N: '#...# #...# ##..# #.#.# #..## #...# #...#',
  O: '.###. #...# #...# #...# #...# #...# .###.',
  P: '####. #...# #...# ####. #.... #.... #....',
  Q: '.###. #...# #...# #...# #.#.# #..#. .##.#',
  R: '####. #...# #...# ####. #.#.. #..#. #...#',
  S: '.#### #.... #.... .###. ....# ....# ####.',
  T: '##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..',
  U: '#...# #...# #...# #...# #...# #...# .###.',
  V: '#...# #...# #...# #...# #...# .#.#. ..#..',
  W: '#...# #...# #...# #.#.# #.#.# #.#.# .#.#.',
  X: '#...# #...# .#.#. ..#.. .#.#. #...# #...#',
  Y: '#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..',
  Z: '##### ....# ...#. ..#.. .#... #.... #####',
  0: '.###. #...# #..## #.#.# ##..# #...# .###.',
  1: '..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.',
  2: '.###. #...# ....# ...#. ..#.. .#... #####',
  3: '####. ....# ....# .###. ....# ....# ####.',
  4: '...#. ..##. .#.#. #..#. ##### ...#. ...#.',
  5: '##### #.... ####. ....# ....# #...# .###.',
  6: '..##. .#... #.... ####. #...# #...# .###.',
  7: '##### ....# ...#. ..#.. .#... .#... .#...',
  8: '.###. #...# #...# .###. #...# #...# .###.',
  9: '.###. #...# #...# .#### ....# ...#. .##..',
  ' ': '..... ..... ..... ..... ..... ..... .....',
  '.': '..... ..... ..... ..... ..... .##.. .##..',
  ',': '..... ..... ..... ..... .##.. ..#.. .#...',
  "'": '..#.. ..#.. .#... ..... ..... ..... .....',
  '"': '.#.#. .#.#. ..... ..... ..... ..... .....',
  '!': '..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..',
  '?': '.###. #...# ....# ...#. ..#.. ..... ..#..',
  '-': '..... ..... ..... .###. ..... ..... .....',
  '_': '..... ..... ..... ..... ..... ..... #####',
  ':': '..... .##.. .##.. ..... .##.. .##.. .....',
  ';': '..... .##.. .##.. ..... .##.. ..#.. .#...',
  '/': '....# ....# ...#. ..#.. .#... #.... #....',
  '>': '.#... ..#.. ...#. ....# ...#. ..#.. .#...',
  '<': '...#. ..#.. .#... #.... .#... ..#.. ...#.',
  '(': '...#. ..#.. .#... .#... .#... ..#.. ...#.',
  ')': '.#... ..#.. ...#. ...#. ...#. ..#.. .#...',
  '+': '..... ..#.. ..#.. ##### ..#.. ..#.. .....',
  '=': '..... ..... ##### ..... ##### ..... .....',
  '&': '.##.. #..#. #.#.. .#... #.#.# #..#. .##.#',
};

export const GLYPH_W = 5;
export const GLYPH_H = 7;
/** Art pixels from one glyph's left edge to the next. */
export const ADVANCE = GLYPH_W + 1;

const ROWS = new Map<string, number[]>();
for (const [ch, art] of Object.entries(GLYPHS)) {
  ROWS.set(ch, art.split(' ').map((row) => [...row].reduce((bits, c, i) => bits | (c === '#' ? 1 << (GLYPH_W - 1 - i) : 0), 0)));
}

/** Whether the font draws `ch` (lower case counts as its capital). */
export const hasGlyph = (ch: string): boolean => ROWS.has(ch.toUpperCase());

/** The width of `text` in font pixels at scale 1 (no trailing gap). */
export function measure(text: string): number {
  return text.length ? text.length * ADVANCE - 1 : 0;
}

/**
 * Draws `text` with its top-left at (x, y) in the canvas's own pixels, each font pixel a `scale` × `scale` square
 * of `colour`. Integer positions and scales only, so every pixel is whole.
 */
export function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, colour: string, scale = 1): void {
  const s = Math.max(1, Math.round(scale));
  ctx.fillStyle = colour;
  let cx = Math.round(x);
  const top = Math.round(y);
  for (const ch of text) {
    const rows = ROWS.get(ch.toUpperCase());
    if (rows) {
      for (let r = 0; r < GLYPH_H; r++) {
        const bits = rows[r];
        for (let c = 0; c < GLYPH_W; c++) {
          if (bits & (1 << (GLYPH_W - 1 - c))) ctx.fillRect(cx + c * s, top + r * s, s, s);
        }
      }
    }
    cx += ADVANCE * s;
  }
}
