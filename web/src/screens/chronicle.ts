import { rect } from '../view/cards';
import { faceTile } from '../view/cards/portrait';
import { drawText, GLYPH_H, measure } from '../view/font5x7';
import type { LandData } from '../view/land-data';
import { RoadSites } from '../view/places/road';
import { BattleView } from '../battle/battle';
import { FOG_SIGHT } from '../view/fog';
import type { App, Scene } from './app';
import type { Campaign, Chronicle } from './campaign';
import { readState } from './campaign';
import { darkCloth, RED_RULE, type Box } from './cloth';
import { sceneInput, type SceneInput } from './gestures';
import { fitCamera } from './road-common';

// The chronicle, the end of a campaign (docs/spec/01-flow.md §3.9): our commanders' faces side by side on dark cloth,
// the living in colour and the fallen in grey, in a gold frame if the campaign was won and a grey one if lost; below a
// red rule, the enemy commanders met, grey if brought down. Names under the faces (names on cards are words that
// exist in the world). It lies over the road at dusk, at the Hall; a tap goes on to the Hall of Banners.

/** A face's tile, and half of it when a row of full faces would not fit (every other pixel: still whole pixels). */
const FACE_W = 80;
const FACE_H = 96;
const GAP = 4;

export class ChronicleScene implements Scene {
  readonly name = 'chronicle';
  readonly top = 'play' as const;
  readonly play: BattleView;
  private readonly sites: RoadSites;
  private readonly input: SceneInput;
  /** The layer's size when last drawn. */
  private drawn = '';
  /** Seconds on screen: a tap goes on after the fade (chosen: 0.6 s, as the aftermath's skip). */
  private t = 0;

  constructor(
    private readonly app: App,
    land: LandData,
    campaign: Campaign,
    readonly chronicle: Chronicle,
    private readonly onDone: () => void,
  ) {
    const view = app.view;
    view.setLand(land);
    const st = readState(campaign);
    this.play = new BattleView(view, campaign.road_battle(), app.memoryWasm, { pilot: false, enemy: '', figures: app.figures });
    this.play.overrideFog(new Uint8Array(land.w * land.h).fill(FOG_SIGHT));
    this.play.showSites = false;
    this.play.follow = false;
    this.sites = new RoadSites(view, st.road.places.map((p) => ({ id: p.id, kind: p.kind, at: p.at, houses: p.houses, done: p.done })), st.road.hall, st.seed);
    this.sites.setProps(app.memory.props, st.seed);
    const h = st.road.hall;
    fitCamera(view, [{ x: h.x - 2, y: h.y - 3 }, { x: h.x + 6, y: h.y + 4 }], 5, 2);
    this.input = sceneInput(view, { tap: () => this.t >= 0.6 && this.onDone() }, { pan: false, zoom: false });
  }

  /** Goes on to the Hall (a tap does, after 0.6 s). */
  done(): void {
    this.onDone();
  }

  frame(dt: number): void {
    this.t += dt;
    this.play.frame(dt);
    this.app.view.time += dt;
    this.app.view.dayT = 0.95;
    this.sites.update();
  }

  rendered(): void {
    const L = this.app.ui;
    const key = `${L.w}x${L.h}x${L.u}`;
    if (key === this.drawn) return;
    this.drawn = key;
    L.clear();
    const g = L.ctx;
    const c = this.chronicle;
    const ours = [{ name: c.captain.name, face: c.captain.face, alive: c.captain.alive }, ...c.commanders];
    const foes = c.foes;
    // full faces if a row of them fits in four fifths of the screen's width, else half faces
    const maxW = Math.floor(L.w * 0.92) - 12;
    const fit = (n: number, w: number) => Math.max(1, Math.min(n, Math.floor((maxW + GAP) / (w + GAP))));
    let half = false;
    let cols = fit(ours.length, FACE_W);
    const rowsFull = Math.ceil(ours.length / cols) + Math.ceil(Math.max(1, foes.length) / fit(foes.length || 1, FACE_W));
    if (cols < Math.min(ours.length, 4) || rowsFull * (FACE_H + GLYPH_H + 8) > L.h - 30) {
      half = true;
      cols = fit(ours.length, FACE_W / 2);
    }
    const fw = half ? FACE_W / 2 : FACE_W;
    const fh = half ? FACE_H / 2 : FACE_H;
    const cell = fh + GLYPH_H + 5;
    const fcols = Math.max(1, fit(foes.length || 1, fw));
    const rows = Math.ceil(ours.length / cols);
    const frows = foes.length ? Math.ceil(foes.length / fcols) : 0;
    const w = Math.max(cols, Math.min(fcols, foes.length || 1)) * (fw + GAP) - GAP + 16;
    const h = rows * cell + (frows ? 9 + frows * cell : 0) + 14;
    const box: Box = { x: Math.round((L.w - w) / 2), y: Math.max(2, Math.round((L.h - h) / 2)), w, h };
    darkCloth(g, box, c.frame === 'gold' || c.won ? 'gold' : 'grey');
    let y = box.y + 7;
    const row = (list: { name: string; face: number; grey: boolean; side: 'warden' | 'blight' }[], n: number) => {
      for (let i = 0; i < list.length; i += n) {
        const part = list.slice(i, i + n);
        const rw = part.length * (fw + GAP) - GAP;
        let x = box.x + Math.round((box.w - rw) / 2);
        for (const p of part) {
          const tile = faceTile(p.face, p.side, { grey: p.grey });
          if (half) g.drawImage(tile, 0, 0, FACE_W, FACE_H, x, y, fw, fh);
          else g.drawImage(tile, x, y);
          rect(g, x, y + fh, fw, 1, p.grey ? '#4e4a44' : '#9a7a2a');
          const name = p.name.slice(0, Math.floor((fw + 1) / 6));
          drawText(g, name, x + Math.round((fw - measure(name)) / 2), y + fh + 3, p.grey ? '#8a867c' : '#f1ead6');
          x += fw + GAP;
        }
        y += cell;
      }
    };
    g.imageSmoothingEnabled = false;
    row(ours.map((o) => ({ name: o.name, face: o.face, grey: !o.alive, side: 'warden' as const })), cols);
    if (foes.length) {
      y += 2;
      rect(g, box.x + 6, y, box.w - 12, 2, RED_RULE);
      y += 7;
      row(foes.map((f) => ({ name: f.name, face: f.face, grey: f.down, side: 'blight' as const })), fcols);
    }
  }

  dispose(): void {
    this.input.dispose();
    this.sites.dispose();
    this.play.dispose();
  }
}
