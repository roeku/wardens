import { BattleView } from '../battle/battle';
import { installInput, inputHooks, type Input } from '../input';
import type { Battle } from '../sim-pkg/sim_wasm.js';
import type { CardSpec } from '../view/cards';
import type { LandData } from '../view/land-data';
import { installPlaces, type Places } from '../view/places';
import type { Tier } from '../view/renderer';
import { installVoice } from '../voice/live/live';
import type { App, Scene } from './app';

// A battle on screen (docs/spec/01-flow.md §3.6–§3.7): the camera opens on the captain; the input, the places, voice,
// the portraits' face moments and, against a broodlord, its mind are installed for the battle and disposed after it.
// When the battle is decided the field is left quiet: no more orders, and the scene goes on by itself after 3.2 s (a
// tap after 0.6 s skips). There is no victory text.

/** 01-flow.md §3.7. */
export const AFTERMATH_S = 3.2;
export const SKIP_AFTER_S = 0.6;

type Disposable = { dispose(): void };
type FacesFn = (play: BattleView, view: App['view']) => Disposable;
type BroodlordFn = (play: BattleView, opts: { way: 'stubborn' | 'reckless' | 'steady' | 'veteran'; name: string; enabled: boolean }) => Disposable;

// Other parts' installers, looked for with lazy globs so the battle builds and runs before (and whether) they land,
// and a half-written one leaves the battle without it instead of breaking the page. `loadParts()` loads them once.
const faceMods = import.meta.glob<{ installFaces?: FacesFn }>('../battle/faces.ts');
const broodMods = import.meta.glob<{ installBroodlord?: BroodlordFn }>('../voice/broodlord/index.ts');
const parts: { faces: FacesFn | null; broodlord: BroodlordFn | null } = { faces: null, broodlord: null };
let partsLoading: Promise<void> | null = null;

export function loadParts(): Promise<void> {
  const take = async <T,>(mods: Record<string, () => Promise<Record<string, unknown>>>, name: string, set: (f: T) => void) => {
    for (const load of Object.values(mods)) {
      try {
        const m = await load();
        if (typeof m[name] === 'function') set(m[name] as T);
      } catch (e) {
        console.warn(`[battle] ${name} did not load; the battle goes on without it`, e);
      }
    }
  };
  partsLoading ??= Promise.all([
    take<FacesFn>(faceMods, 'installFaces', (f) => (parts.faces = f)),
    take<BroodlordFn>(broodMods, 'installBroodlord', (f) => (parts.broodlord = f)),
  ]).then(() => {});
  return partsLoading;
}

export interface BattleSceneOpts {
  battle: Battle;
  land: LandData;
  tier: Tier;
  pilot: boolean;
  enemy: string;
  /** What follows the aftermath; null keeps the field (the `?kind=` dev path, as before). */
  then: ((scene: BattleScene) => void) | null;
  /** The broodlord holding the place, if any (06-voice.md §8). */
  foe?: { way: 'stubborn' | 'reckless' | 'steady' | 'veteran'; name: string } | null;
  /** The card a tap on one of our companies shows, by squad id (null: none). */
  companyCard?: (squad: number) => CardSpec | null;
  /** Voice: installed when its installer can be disposed, or always on the dev path's single battle. */
  voice: 'always' | 'if-disposable' | 'off';
  /** A name for the shots and logs. */
  name?: string;
}

export class BattleScene implements Scene {
  readonly name: string;
  readonly top = 'play' as const;
  readonly play: BattleView;
  input: Input | null;
  readonly places: Places;
  private readonly extras: Disposable[] = [];
  /** Seconds since the battle was decided (−1 before). */
  quiet = -1;
  private ended = false;
  private skipTap: ((e: PointerEvent) => void) | null = null;
  private card = -1;

  constructor(
    private readonly app: App,
    private readonly opts: BattleSceneOpts,
  ) {
    this.name = opts.name ?? 'battle';
    const view = app.view;
    view.setLand(opts.land);
    this.play = new BattleView(view, opts.battle, app.memoryWasm, { pilot: opts.pilot, enemy: opts.enemy, figures: app.figures });
    this.input = installInput(view, this.play);
    this.places = installPlaces(view, this.play, app.memoryWasm, opts.tier);
    if (opts.voice !== 'off' && !app.brainOff) {
      const v = installVoice(this.play) as unknown as Partial<Disposable>;
      if (typeof v.dispose === 'function') this.extras.push(v as Disposable);
      else if (opts.voice === 'if-disposable') console.warn('[battle] voice cannot be disposed yet: it stays with this battle');
    }
    if (parts.faces) this.extras.push(parts.faces(this.play, view));
    if (opts.foe && parts.broodlord) {
      this.extras.push(parts.broodlord(this.play, { way: opts.foe.way, name: opts.foe.name, enabled: !app.brainOff }));
    }
    inputHooks.onCompanyTap = (squad) => this.showCompany(squad);
  }

  /** The commander's card beside their banner (01-flow.md §2: shown on release). */
  private showCompany(squad: number): void {
    const spec = this.opts.companyCard?.(squad);
    if (!spec) return;
    this.app.cards.hide(this.card);
    const at = this.bannerScreen(squad);
    if (!at) return;
    this.card = this.app.cards.show(spec, at, at.x < this.app.view.renderer.size.aw * this.app.view.renderer.size.px / 2 ? 'right' : 'left', { life: 3.5 });
  }

  /** A company's banner on screen, CSS pixels from the canvas's top-left. */
  bannerScreen(squad: number): { x: number; y: number; r: number } | null {
    const b = this.play.bannerOf(squad);
    const s = this.input?.screen;
    if (!b || !s) return null;
    const p = s.project(b.x, b.h + 1, b.y, { x: 0, y: 0 });
    return { x: p.x, y: p.y, r: s.tilePx * 0.8 };
  }

  frame(dt: number): void {
    const play = this.play;
    play.frame(dt);
    if (!play.clock.paused) this.app.view.time += dt;
    this.input?.frame(dt);
    if (play.outcome && this.quiet < 0 && this.opts.then) this.beginQuiet();
    if (this.quiet >= 0) {
      this.quiet += dt;
      if (this.quiet >= AFTERMATH_S) this.end();
    }
  }

  rendered(): void {
    this.play.perf.mark('render');
    this.play.perf.end();
  }

  /** The field goes quiet: no more orders; a tap after 0.6 s goes on. */
  private beginQuiet(): void {
    this.quiet = 0;
    this.input?.dispose();
    this.input = null;
    inputHooks.onCompanyTap = () => {};
    this.play.ui.selected = null;
    this.play.ui.stroke = null;
    this.skipTap = () => {
      if (this.quiet >= SKIP_AFTER_S) this.end();
    };
    this.app.view.canvas.addEventListener('pointerdown', this.skipTap);
  }

  /** Skips the aftermath now (the dev hooks' autoCampaign), as a tap would. */
  skip(): void {
    if (this.quiet < 0 && this.play.outcome) this.beginQuiet();
    if (this.quiet >= 0) this.end();
  }

  private end(): void {
    if (this.ended || !this.opts.then) return;
    this.ended = true;
    this.opts.then(this);
  }

  dispose(): void {
    if (this.skipTap) this.app.view.canvas.removeEventListener('pointerdown', this.skipTap);
    inputHooks.onCompanyTap = () => {};
    this.input?.dispose();
    for (const e of this.extras) {
      try {
        e.dispose();
      } catch (err) {
        console.error('[battle] an installer failed to dispose', err);
      }
    }
    this.places.dispose();
    this.play.dispose();
  }
}
