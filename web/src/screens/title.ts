import { BattleView } from '../battle/battle';
import type { Battle } from '../sim-pkg/sim_wasm.js';
import { drawPicto, rect, type Icon } from '../view/cards';
import { ZOOMS } from '../view/camera';
import { drawText, GLYPH_H, measure } from '../view/font5x7';
import { FOG_SIGHT } from '../view/fog';
import type { LandData } from '../view/land-data';
import type { App, Scene } from './app';
import { crossbar, darkCloth, gonfalon, GOLD, inside, RAMP, WOOD, type Box } from './cloth';
import { sceneInput, type SceneInput } from './gestures';
import type { CustomSetup } from './saves';

// The title and the setup (docs/spec/01-flow.md §3.1–§3.3): the camera stands over two armies at dusk on a field;
// the choices are banners on cloth (CONTINUE if a campaign is kept, CAMPAIGN, BATTLE), every target at least 24 art
// px and carrying at most a word. The war table lies on the same field: six pieces, each a picture and one word, and
// FIGHT. The campaign cards stand over the road's hall (setup.ts).

/** 02-look.md §3: the light at dusk, as a battle's t. */
export const DUSK = 0.9;
/** The title's zoom step (ZOOMS[5] = 19 art px per tile; chosen), and the farthest it goes to fit both armies. */
const TITLE_ZOOM = 5;
const MIN_TITLE_ZOOM = 2;
/** A ground point's screen right and up per tile (02-look.md §2: RIGHT = (√½, 0, √½), UP's ground part ½·(√½, −√½)). */
const RIGHT_K = Math.SQRT1_2;
const UP_K = Math.SQRT1_2 / 2;
/** 01-flow.md §3.1: every target is at least 24 art px. */
export const MIN_TARGET_ART = 24;

/** The field under the title and the war table: two armies standing, frozen at dusk, not stepped. */
export class Field {
  readonly play: BattleView;

  constructor(
    private readonly app: App,
    battle: Battle,
    land: LandData,
  ) {
    app.view.setLand(land);
    this.play = new BattleView(app.view, battle, app.memoryWasm, { pilot: false, enemy: 'none', figures: app.figures });
    this.play.clock.paused = true;
    this.play.follow = false;
    // both armies stand in sight: the title is a picture, not a battle's fog
    this.play.overrideFog(new Uint8Array(land.w * land.h).fill(FOG_SIGHT));
    this.frameArmies(land);
  }

  /**
   * Stands the camera over both armies: the largest zoom (up to ZOOMS[5]) at which every company's middle fits in the
   * lower four fifths of the screen (the banners hang in the top fifth), centred between them.
   */
  private frameArmies(land: LandData): void {
    const cam = this.app.view.camera;
    const { aw, ah } = this.app.view.renderer.size;
    let lo = [Infinity, Infinity];
    let hi = [-Infinity, -Infinity];
    let cx = 0, cy = 0, n = 0;
    for (let j = 0; j < this.play.sim.squad_count(); j++) {
      const c = this.play.squadCentre(j);
      if (!c) continue;
      const a = (c.x + c.y) * RIGHT_K;
      const u = (c.x - c.y) * UP_K;
      lo = [Math.min(lo[0], a), Math.min(lo[1], u)];
      hi = [Math.max(hi[0], a), Math.max(hi[1], u)];
      cx += c.x;
      cy += c.y;
      n++;
    }
    if (n === 0) {
      cam.zi = TITLE_ZOOM;
      cam.focus.set(land.w / 2, land.h / 2);
      return;
    }
    const spanA = hi[0] - lo[0] + 6;
    const spanU = hi[1] - lo[1] + 6;
    // never below ZOOMS[2] (11 px/tile): on a narrow phone the armies' ends may stand past the edges rather than the
    // field shrink into the haze
    let zi = TITLE_ZOOM;
    while (zi > MIN_TITLE_ZOOM && (spanA * ZOOMS[zi] > aw || spanU * ZOOMS[zi] > ah * 0.75)) zi--;
    cam.zi = zi;
    // the middle of the armies, set a tenth of the screen below its centre: the focus goes that far up the screen
    // (north-east on the ground)
    const up = (ah * 0.1) / ZOOMS[zi] / Math.sin(Math.PI / 6);
    cam.focus.set(cx / n + up * Math.SQRT1_2, cy / n - up * Math.SQRT1_2);
  }

  frame(dt: number): void {
    this.play.frame(dt);
    this.app.view.dayT = DUSK;
    this.app.view.time += dt;
  }

  dispose(): void {
    this.play.dispose();
  }
}

export interface TitleChoices {
  continue: boolean;
  onContinue(): void;
  onCampaign(): void;
  onBattle(): void;
}

interface Target {
  box: Box;
  word: string;
  go: () => void;
}

/** The title: three banners on cloth hanging from a bar over the field. */
export class TitleScene implements Scene {
  readonly name = 'title';
  readonly top = 'title' as const;
  readonly field: Field;
  private readonly input: SceneInput;
  private targets: Target[] = [];
  private pressed: Target | null = null;
  private dirty = true;
  private gen = -1;

  constructor(
    private readonly app: App,
    battle: Battle,
    land: LandData,
    private readonly choices: TitleChoices,
  ) {
    this.field = new Field(app, battle, land);
    this.input = sceneInput(app.view, {
      press: (x, y) => {
        const p = app.ui.toUi(x, y);
        this.pressed = this.targets.find((t) => inside(t.box, p.x, p.y, 2)) ?? null;
        this.dirty = true;
      },
      tap: (x, y) => {
        const p = app.ui.toUi(x, y);
        const t = this.targets.find((t) => inside(t.box, p.x, p.y, 2));
        this.pressed = null;
        this.dirty = true;
        t?.go();
      },
      dragEnd: () => {
        this.pressed = null;
        this.dirty = true;
      },
      cancel: () => {
        this.pressed = null;
        this.dirty = true;
      },
    }, { pan: false, zoom: false });
  }

  get play(): BattleView {
    return this.field.play;
  }

  frame(dt: number): void {
    this.field.frame(dt);
  }

  /** The words, for the dev hooks: each choice's box in CSS pixels. */
  choicesOnScreen(): { word: string; x: number; y: number }[] {
    const k = this.app.ui.k;
    return this.targets.map((t) => ({ word: t.word, x: (t.box.x + t.box.w / 2) * k, y: (t.box.y + t.box.h / 2) * k }));
  }

  rendered(): void {
    const L = this.app.ui;
    if (!this.dirty && this.targets.length && this.gen === L.gen) return;
    this.dirty = false;
    this.gen = L.gen;
    L.clear();
    const g = L.ctx;
    const words: [string, () => void][] = [];
    if (this.choices.continue) words.push(['CONTINUE', () => this.choices.onContinue()]);
    words.push(['CAMPAIGN', () => this.choices.onCampaign()], ['BATTLE', () => this.choices.onBattle()]);
    // each banner the word and 6 px a side, at least 24 art px wide and 34 ui px tall (01-flow.md §3.1)
    const minW = Math.ceil(MIN_TARGET_ART / L.u);
    const ws = words.map(([w]) => Math.max(minW, measure(w) + 14));
    const gap = 6;
    const total = ws.reduce((a, b) => a + b, 0) + gap * (ws.length - 1);
    const h = Math.max(34, Math.ceil(MIN_TARGET_ART / L.u) + 10);
    let x = Math.round((L.w - total) / 2);
    const y = Math.max(8, Math.round(L.h * 0.08));
    crossbar(g, x - 6, x + total + 6, y - 3);
    this.targets = [];
    words.forEach(([word, go], i) => {
      const t: Target = { box: { x, y, w: ws[i], h }, word, go };
      const box = gonfalon(g, x, y, ws[i], h, word, { lit: true, down: this.pressed?.word === word });
      t.box = box;
      this.targets.push(t);
      x += ws[i] + gap;
    });
  }

  dispose(): void {
    this.input.dispose();
    this.field.dispose();
  }
}

// ------------------------------------------------------------------------------------------------ the war table

/** 01-flow.md §3.3. */
const KINDS: CustomSetup['kind'][] = ['field', 'night', 'keep', 'hold', 'village', 'ford'];
const SIZES: CustomSetup['size'][] = [4, 6, 9];
const STRENGTHS: CustomSetup['strength'][] = ['easy', 'fair', 'hard'];
/** The first campaign's lands (03-land.md §6 "Choosing lands along the road"), and ANY. */
export const LANDS = ['any', 'meadow', 'moor', 'birch', 'autumn', 'marsh'] as const;
/** Each land's grass, for its picture (03-land.md §6). */
const LAND_GRASS: Record<string, [string, string]> = {
  any: ['#4b742c', '#a07f50'],
  meadow: ['#5d8a33', '#88b347'],
  moor: ['#7a7442', '#997f8c'],
  birch: ['#6c9638', '#acd061'],
  autumn: ['#9a4318', '#d27c22'],
  marsh: ['#34502a', '#5c8640'],
};

interface Piece {
  key: 'ours' | 'theirs' | 'land' | 'kind' | 'size' | 'strength';
  word: string;
  /** Fixed pieces (the two sides of The Wardens) take no tap. */
  fixed: boolean;
  box: Box;
}

/** The war table (01-flow.md §3.3): six pieces on dark cloth over the field, and FIGHT. */
export class WarTable implements Scene {
  readonly name = 'table';
  readonly top = 'setup' as const;
  readonly field: Field;
  private readonly input: SceneInput;
  private pieces: Piece[] = [];
  private fight: Box = { x: 0, y: 0, w: 0, h: 0 };
  private back: Box = { x: 0, y: 0, w: 0, h: 0 };
  private dirty = true;
  private gen = -1;
  private pressed = '';

  constructor(
    private readonly app: App,
    battle: Battle,
    land: LandData,
    readonly setup: CustomSetup,
    private readonly on: { fight(setup: CustomSetup): void; back(): void; changed(setup: CustomSetup): void },
  ) {
    this.field = new Field(app, battle, land);
    const hitAt = (x: number, y: number): string => {
      const p = app.ui.toUi(x, y);
      if (inside(this.fight, p.x, p.y, 2)) return 'fight';
      if (inside(this.back, p.x, p.y, 2)) return 'back';
      return this.pieces.find((q) => !q.fixed && inside(q.box, p.x, p.y, 1))?.key ?? '';
    };
    this.input = sceneInput(app.view, {
      press: (x, y) => {
        this.pressed = hitAt(x, y);
        this.dirty = true;
      },
      tap: (x, y) => {
        const what = hitAt(x, y);
        this.pressed = '';
        this.dirty = true;
        this.choose(what);
      },
      dragEnd: () => {
        this.pressed = '';
        this.dirty = true;
      },
      cancel: () => {
        this.pressed = '';
        this.dirty = true;
      },
    }, { pan: false, zoom: false });
  }

  get play(): BattleView {
    return this.field.play;
  }

  /** A tap on a piece turns it to its next value; FIGHT goes to the field. */
  choose(what: string): void {
    const s = this.setup;
    const next = <T,>(all: readonly T[], v: T): T => all[(all.indexOf(v) + 1) % all.length];
    switch (what) {
      case 'fight':
        this.on.fight({ ...s });
        return;
      case 'back':
        this.on.back();
        return;
      case 'land':
        s.land = next(LANDS, s.land as (typeof LANDS)[number]);
        break;
      case 'kind':
        s.kind = next(KINDS, s.kind);
        break;
      case 'size':
        s.size = next(SIZES, s.size);
        break;
      case 'strength':
        s.strength = next(STRENGTHS, s.strength);
        break;
      default:
        return;
    }
    this.on.changed({ ...s });
    this.dirty = true;
  }

  frame(dt: number): void {
    this.field.frame(dt);
  }

  /** Each piece's word and its middle in CSS pixels, and FIGHT's (the dev hooks). */
  piecesOnScreen(): { key: string; word: string; x: number; y: number }[] {
    const k = this.app.ui.k;
    const mid = (b: Box) => ({ x: (b.x + b.w / 2) * k, y: (b.y + b.h / 2) * k });
    return [...this.pieces.map((p) => ({ key: p.key, word: p.word, ...mid(p.box) })), { key: 'fight', word: 'FIGHT', ...mid(this.fight) }];
  }

  rendered(): void {
    const L = this.app.ui;
    if (!this.dirty && this.pieces.length && this.gen === L.gen) return;
    this.dirty = false;
    this.gen = L.gen;
    L.clear();
    const g = L.ctx;
    const s = this.setup;
    const words: [Piece['key'], string, boolean][] = [
      ['ours', 'WARDENS', true],
      ['theirs', 'BLIGHT', true],
      ['land', s.land.toUpperCase(), false],
      ['kind', s.kind.toUpperCase(), false],
      ['size', String(s.size), false],
      ['strength', s.strength.toUpperCase(), false],
    ];
    // a 3 × 2 table, or 2 × 3 on a narrow screen; each piece a 48 × 34 picture over its word
    const cols = L.w >= 3 * 56 + 16 ? 3 : 2;
    const rows = Math.ceil(words.length / cols);
    const pw = 52;
    const ph = 30 + GLYPH_H + 6;
    const gap = 4;
    const tw = cols * pw + (cols - 1) * gap + 12;
    const th = rows * ph + (rows - 1) * gap + 12;
    const fightH = Math.max(30, Math.ceil(MIN_TARGET_ART / L.u) + 6);
    const top = Math.max(4, Math.round((L.h - th - fightH - 14) / 2));
    const tx = Math.round((L.w - tw) / 2);
    darkCloth(g, { x: tx, y: top, w: tw, h: th }, 'wood');
    this.pieces = words.map(([key, word, fixed], i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const box = { x: tx + 6 + c * (pw + gap), y: top + 6 + r * (ph + gap), w: pw, h: ph };
      const down = this.pressed === key;
      rect(g, box.x, box.y + (down ? 1 : 0), box.w, box.h, fixed ? '#3a302a' : '#4a3a2c');
      rect(g, box.x, box.y + (down ? 1 : 0), box.w, 1, fixed ? '#4e4a44' : down ? '#fffbe8' : GOLD);
      this.picture(g, key, box.x + 2, box.y + 2 + (down ? 1 : 0), pw - 4, 26);
      drawText(g, word, box.x + Math.round((pw - measure(word)) / 2), box.y + 30 + (down ? 1 : 0), fixed ? '#b0a693' : '#f1ead6');
      return { key, word, fixed, box };
    });
    // FIGHT hangs under the table; a small linen banner goes back to the title
    const fw = Math.max(Math.ceil(MIN_TARGET_ART / L.u), measure('FIGHT') + 18);
    const fx = Math.round((L.w - fw) / 2);
    const fy = top + th + 8;
    crossbar(g, fx - 4, fx + fw + 4, fy - 3);
    this.fight = gonfalon(g, fx, fy, fw, fightH, 'FIGHT', { lit: true, down: this.pressed === 'fight' });
    const bw = Math.max(Math.ceil(MIN_TARGET_ART / L.u), 16);
    this.back = gonfalon(g, tx, fy, bw, Math.max(24, Math.ceil(MIN_TARGET_ART / L.u)), '<', { ramp: 'linen', device: '#6b5a40', down: this.pressed === 'back' });
  }

  /** A piece's picture, `w × h` at (x, y). */
  private picture(g: CanvasRenderingContext2D, key: Piece['key'], x: number, y: number, w: number, h: number): void {
    const s = this.setup;
    rect(g, x, y, w, h, '#2a221c');
    const mid = x + Math.floor(w / 2);
    const icons = (list: Icon[], colour: string) => {
      const iw = list.length * 8 - 1;
      list.forEach((ic, i) => drawPicto(g, ic, mid - Math.floor(iw / 2) + i * 8, y + Math.floor((h - 7) / 2), colour));
    };
    switch (key) {
      case 'ours':
        gonfalon(g, mid - 6, y + 4, 12, 20, '', { ramp: 'blue' });
        break;
      case 'theirs':
        icons(['broodlord'], '#c84a1c');
        rect(g, mid - 1, y + 2, 2, h - 4, WOOD[0]);
        icons(['broodlord'], '#e8765c');
        break;
      case 'land': {
        const [a, b] = LAND_GRASS[s.land] ?? LAND_GRASS.any;
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (((i + j) & 3) === 0 || (j > h / 2 && (i * 7 + j * 3) % 5 === 0)) rect(g, x + i, y + j, 1, 1, b);
        for (let j = Math.floor(h / 2); j < h; j++) rect(g, x, y + j, w, 1, j % 2 ? a : b);
        if (s.land === 'any') drawText(g, '?', mid - 2, y + 4, '#f1ead6');
        break;
      }
      case 'kind': {
        const ic: Record<CustomSetup['kind'], Icon> = { field: 'swords', night: 'heart-empty', keep: 'hall', hold: 'shield', village: 'hall', ford: 'pennant' };
        if (s.kind === 'night') {
          rect(g, x, y, w, h, '#151a2c');
          rect(g, mid - 3, y + 6, 7, 7, '#d2dcea');
          rect(g, mid - 1, y + 5, 7, 7, '#151a2c');
        } else if (s.kind === 'ford') {
          for (let j = 0; j < h; j += 3) rect(g, x, y + j, w, 1, '#4d8a96');
          icons(['pennant'], '#f1ead6');
        } else icons([ic[s.kind]], s.kind === 'village' ? '#e0533f' : '#f1ead6');
        break;
      }
      case 'size':
        for (let i = 0; i < s.size; i++) {
          const bx = x + 3 + (i % 5) * 9;
          const by = y + 2 + Math.floor(i / 5) * 12;
          rect(g, bx, by, 1, 11, WOOD[0]);
          rect(g, bx + 1, by, 5, 6, RAMP.blue[2]);
          rect(g, bx + 1, by + 6, 2, 2, RAMP.blue[2]);
          rect(g, bx + 4, by + 6, 2, 2, RAMP.blue[2]);
        }
        break;
      case 'strength': {
        const n = STRENGTHS.indexOf(s.strength) + 1;
        icons(Array.from({ length: n }, () => 'troll' as Icon), '#e0533f');
        break;
      }
    }
  }

  dispose(): void {
    this.input.dispose();
    this.field.dispose();
  }
}
