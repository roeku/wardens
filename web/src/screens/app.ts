import type { BattleView } from '../battle/battle';
import { Perf } from '../battle/perf';
import { Cards, dithered, PixelLayer } from '../view/cards';
import type { Figures } from '../view/figures';
import type { View } from '../view/view';
import type { Campaign, Phase } from './campaign';
import { Lands } from './lands';
import { clearNames } from './road-common';
import { emptyMemory, type ScreensMemory } from './saves';

// The scene manager (docs/spec/01-flow.md §3 "Structure"): the top level is title | setup | play, and within play the
// campaign's phase. Every scene change is followed by a 0.45 s fade from black, without a page reload. The View and
// its renderer, the figure layer and every material persist; lands are swapped (made in the worker, kept by key);
// each battle gets a BattleView of its own, disposed after (01-flow.md §8 Performance 1–2).

export type Top = 'title' | 'setup' | 'play';

/** 01-flow.md §3: the fade from black after every scene change. */
export const FADE_S = 0.45;

export interface Scene {
  /** title, setup, muster, road, battle, chronicle, hall (the dev hooks and the shots read it). */
  readonly name: string;
  readonly top: Top;
  /** The battle on screen, if the scene has one (a battle, or the road's peaceful battle). */
  readonly play?: BattleView | null;
  /** Once a frame, before the view renders. */
  frame(dt: number): void;
  /** After the view rendered: the scene's own pixel layer, its perf marks. */
  rendered?(dt: number): void;
  dispose(): void;
}

/** Makes a scene, once whatever it waits for (a land in the worker) is ready. */
export type SceneMaker = () => Promise<() => Scene> | (() => Scene);

/** The fade from black: black ui pixels where the Bayer dither is not yet lit, none after 0.45 s. */
class Fade {
  private readonly layer: PixelLayer;
  /** 0 black … 1 clear. */
  private k = 1;
  private t = FADE_S;
  private drawn = -1;

  constructor(view: View) {
    this.layer = new PixelLayer(view, 40);
  }

  black(): void {
    this.t = -1;
    this.k = 0;
    this.draw(true);
  }

  start(): void {
    this.t = 0;
  }

  get active(): boolean {
    return this.k < 1;
  }

  frame(dt: number): void {
    const resized = this.layer.fit();
    if (this.t >= 0 && this.t < FADE_S) {
      this.t = Math.min(FADE_S, this.t + dt);
      this.k = this.t / FADE_S;
    }
    this.draw(resized);
  }

  private draw(force: boolean): void {
    // 16 dither levels: redraw only when the level changes
    const level = Math.min(16, Math.floor(this.k * 16));
    if (level === this.drawn && !force) return;
    this.drawn = level;
    const L = this.layer;
    if (level >= 16) {
      L.show(false);
      return;
    }
    L.show(true);
    if (L.w <= 0 || L.h <= 0) return;
    const img = L.ctx.createImageData(L.w, L.h);
    const d = img.data;
    const k = level / 16;
    for (let y = 0; y < L.h; y++) {
      for (let x = 0; x < L.w; x++) {
        if (dithered(x, y, k)) continue;
        const o = (y * L.w + x) * 4;
        d[o] = 0x16;
        d[o + 1] = 0x12;
        d[o + 2] = 0x0f;
        d[o + 3] = 255;
      }
    }
    L.ctx.putImageData(img, 0, 0);
  }
}

export class App {
  scene: Scene | null = null;
  /** Cards beside things (contract §5), on their own layer over every scene. */
  readonly cards: Cards;
  /** The scenes' pixel layer: the title's banners, the war table, place names, the chronicle. */
  readonly ui: PixelLayer;
  readonly perf = new Perf();
  readonly lands: Lands;
  /** The campaign being played, if any, and the screens' memory of its road. */
  campaign: Campaign | null = null;
  memory: ScreensMemory = emptyMemory();
  /** Scene changes so far; a change in flight is dropped if another starts. */
  private goes = 0;
  private readonly fade: Fade;
  private last = performance.now();
  private running = false;
  /** Called after every scene change (dev hooks, logs). */
  readonly onScene: ((s: Scene) => void)[] = [];
  /** Uncaught errors in a frame, for the gate's check. */
  errors = 0;
  /** The commander bot plays our side in every battle (`?pilot=1`, or the dev hook `pilot()`). */
  pilot = false;
  /** No brain in the battles that follow: no voice, and the broodlords' minds off, so the bots alone play (`?brain=off`,
   * or autoCampaign's fast-forwarded battles, which a brain could not keep up with). */
  brainOff = false;

  constructor(
    readonly view: View,
    readonly figures: Figures,
    readonly memoryWasm: WebAssembly.Memory,
    readonly params: URLSearchParams,
  ) {
    this.lands = new Lands(params.get('land') === 'inline');
    this.pilot = params.get('pilot') === '1';
    this.brainOff = params.get('brain') === 'off';
    this.ui = new PixelLayer(view, 10);
    this.cards = new Cards(view, 20);
    this.fade = new Fade(view);
    window.addEventListener('resize', () => view.resize());
  }

  get top(): Top {
    return this.scene?.top ?? 'title';
  }

  /** The campaign's phase, when one is being played. */
  phase(): Phase | null {
    if (!this.campaign) return null;
    try {
      return (JSON.parse(this.campaign.state_json()) as { phase: Phase }).phase;
    } catch {
      return null;
    }
  }

  /** Whether a scene change is fading in. */
  get fading(): boolean {
    return this.fade.active;
  }

  /**
   * Changes scene: whatever the new one waits for is made while the old one still runs; then the old one is
   * disposed, the screen goes black, the new one is built and fades in over 0.45 s.
   */
  go(make: SceneMaker): Promise<Scene | null> {
    const p = this.change(make);
    this.pending = p;
    void p.finally(() => {
      if (this.pending === p) this.pending = null;
    });
    return p;
  }

  /** A scene change in flight, if one is (the dev hooks wait on it rather than spin). */
  pending: Promise<Scene | null> | null = null;

  private async change(make: SceneMaker): Promise<Scene | null> {
    const token = ++this.goes;
    const build = await make();
    if (token !== this.goes) return null;
    this.fade.black();
    this.cards.hide();
    const old = this.scene;
    this.scene = null;
    old?.dispose();
    clearNames(this.ui);
    this.ui.clear();
    const scene = build();
    this.scene = scene;
    this.fade.start();
    this.perf.reset();
    console.log(`[scene] ${scene.top}/${scene.name}`);
    for (const f of this.onScene) f(scene);
    return scene;
  }

  /** Starts the animation-frame loop. */
  run(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.step(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** One frame of `dt` real seconds: the scene, the render, the cards and the fade. */
  step(dt: number): void {
    const p = this.perf;
    p.begin();
    const s = this.scene;
    try {
      s?.frame(dt);
      p.mark('step');
      this.view.render();
      p.mark('render');
      this.ui.fit();
      s?.rendered?.(dt);
      this.cards.frame(dt);
      this.fade.frame(dt);
      p.mark('figures');
    } catch (e) {
      this.errors++;
      console.error('[scene] frame failed', e);
    }
    p.end();
  }
}
