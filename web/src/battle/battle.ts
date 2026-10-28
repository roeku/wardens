import { EVENT_WORDS, EventCode, squadBits, SOLDIER_F32, soldierBits, TICK_HZ, Views, type SimEvent, type Team } from '../contracts';
import type { Battle } from '../sim-pkg/sim_wasm.js';
import { Figures } from '../view/figures';
import { setFog } from '../view/fog';
import { groundAt } from '../view/land-data';
import type { View } from '../view/view';
import { Clock, FALL_FOES_S, FALL_OURS_S } from './clock';
import { installFigureFog } from './figure-fog';
import { Perf } from './perf';
import { Records } from './records';

// A live battle on the game page: the 30 Hz accumulator (04-battle.md §1), the sim stepped with its bots, the
// packed buffers read without a copy, the figures driven from them (§9), the fog fed to every material
// (02-look.md §3), and the camera following the captain until the player pans (02-look.md §2).
// The view only reads the sim; the only way in is a Command through `apply` (AGENTS.md rule 1).

/** The player's side. */
export const PLAYER: Team = 0;
/** 02-look.md §2: easeTo's rate. */
const FOLLOW_RATE = 3;
/** The day's light changes in steps of this much, so the shadow map re-fits now and then, not every frame. */
const DAY_STEP = 1 / 256;
/** Seconds the drawn state jumps by after a fast-forward (e^−16 of the old easing remains). */
const SETTLE_S = 1;

export interface BattleOpts {
  /** The commander bot plays our side. */
  pilot: boolean;
  /** The enemy's bot: garrison, general0..2, charge, idle or none. */
  enemy: string;
}

export class BattleView {
  readonly clock = new Clock();
  readonly figures = new Figures();
  readonly records = new Records();
  readonly views: Views;
  readonly perf = new Perf();
  /** The camera follows the captain until the player pans; F follows again. */
  follow = true;
  /** Events drained this frame, for whoever listens (sound comes later). */
  readonly listeners: ((e: SimEvent) => void)[] = [];
  outcome: { winner: number; why: string; tick: number } | null = null;
  /** A fog set by hand (the dev hook `__v.fog`), drawn and obeyed instead of the sim's until cleared. */
  fogOverride: Uint8Array | null = null;
  private pilotOn = false;
  private enemyBot = 'none';
  /** Real seconds for the figures' next update; shots and the shimmer test re-pose with 0. */
  private pendingDt = 0;
  private readonly ev: SimEvent = { code: EventCode.Hit, tick: 0, x: 0, y: 0, a: 0, b: 0 };
  private readonly ground: (x: number, y: number) => number;
  private readonly cap = { x: 0, y: 0 };
  private readonly daySeconds: number;

  constructor(
    readonly view: View,
    readonly sim: Battle,
    memory: WebAssembly.Memory,
    opts: BattleOpts,
  ) {
    installFigureFog();
    this.views = new Views(memory, sim);
    this.daySeconds = sim.day_s();
    this.ground = (x, y) => groundAt(view.land, x, y);
    view.scene.add(this.figures.group);
    view.beforeDraw = () => this.drawFigures();
    this.pilot(opts.pilot);
    this.bot(opts.enemy);
    this.sync();
    this.build(0);
    const cap = this.captain();
    if (cap) view.camera.focus.set(cap.x, cap.y);
  }

  /** The commander bot plays our side (on), or nobody does (off). */
  pilot(on: boolean): void {
    this.sim.set_bot(PLAYER, on ? 'commander' : 'none');
    this.pilotOn = on;
  }

  /** The enemy's bot. */
  bot(kind: string): void {
    this.sim.set_bot(1 - PLAYER, kind);
    this.enemyBot = kind;
  }

  get bots(): { pilot: boolean; enemy: string } {
    return { pilot: this.pilotOn, enemy: this.enemyBot };
  }

  /** Pause (Space or P): the sim stops, the world greys, and every clock but the camera's stands still. */
  setPaused(on: boolean): void {
    this.clock.paused = on;
    this.view.grey = on ? 1 : 0;
  }

  /** Draws and obeys a fog given by hand, or the sim's again (null). */
  overrideFog(levels: Uint8Array | null): void {
    this.fogOverride = levels;
    this.views.refresh();
    setFog(levels ?? this.views.fog);
    this.build(0);
  }

  /** Steps the sim `ticks` at once (the dev hook `ff`), then re-reads it. Returns the ms it took. */
  fastForward(ticks: number): number {
    const t0 = performance.now();
    this.sim.step(ticks);
    const ms = performance.now() - t0;
    this.sync();
    this.drainEvents();
    return ms;
  }

  /** One frame of `dt` real seconds: step, read, build the records, follow. The view renders afterwards. */
  frame(dt: number): void {
    const p = this.perf;
    p.begin();
    const n = this.clock.advance(dt);
    if (n > 0) this.sim.step(n);
    p.mark('step');
    this.sync();
    this.drainEvents();
    this.build(this.clock.paused ? 0 : dt);
    p.mark('records');
    if (this.follow) {
      const cap = this.captain();
      if (cap) this.view.camera.easeTo(cap.x, cap.y, dt, FOLLOW_RATE);
    }
    // the light is the clock (02-look.md §3): battle time over the sim's daylight, in steps
    this.view.dayT = Math.min(1, Math.floor(this.sim.tick() / TICK_HZ / this.daySeconds / DAY_STEP) * DAY_STEP);
    this.pendingDt = this.clock.paused ? 0 : dt;
  }

  /** Our captain's sim position, if he lives (the same object every call). */
  captain(): { x: number; y: number } | null {
    const v = this.views;
    const n = this.sim.soldier_count();
    for (let k = 0; k < n; k++) {
      const w = v.u32[k];
      if (soldierBits.captain(w) && soldierBits.team(w) === PLAYER && soldierBits.alive(w)) {
        this.cap.x = v.f32[k * SOLDIER_F32.FIELDS + SOLDIER_F32.X];
        this.cap.y = v.f32[k * SOLDIER_F32.FIELDS + SOLDIER_F32.Y];
        return this.cap;
      }
    }
    return null;
  }

  /**
   * After a jump in the sim (a fast-forward): the banners, the figures and a following camera catch up at once on
   * the next draw, as if a whole second had passed for them (topples finish, blows end).
   */
  settle(): void {
    this.build(SETTLE_S);
    this.pendingDt = SETTLE_S;
    if (this.follow) {
      const cap = this.captain();
      if (cap) this.view.camera.focus.set(cap.x, cap.y);
    }
  }

  private sync(): void {
    const flags = this.sim.sync();
    this.views.refresh();
    if (flags & 1 && !this.fogOverride) setFog(this.views.fog);
  }

  private build(dt: number): void {
    const v = this.views;
    v.refresh();
    this.records.build({
      views: v,
      fog: this.fogOverride ?? v.fog,
      soldiers: this.sim.soldier_count(),
      squads: this.sim.squad_count(),
      tick: this.sim.tick(),
      acc: this.clock.acc,
      dt,
      mapW: this.view.land.w,
      mapH: this.view.land.h,
      team: PLAYER,
      ground: this.ground,
    });
  }

  private drainEvents(): void {
    const n = this.sim.drain_events();
    if (n === 0) return;
    const v = this.views;
    v.refresh();
    const e = this.ev;
    for (let i = 0; i < n; i++) {
      const o = i * EVENT_WORDS;
      e.code = v.events[o];
      e.tick = v.events[o + 1];
      e.x = v.eventsF32[o + 2];
      e.y = v.eventsF32[o + 3];
      e.a = v.events[o + 4];
      e.b = v.events[o + 5];
      this.onEvent(e);
      for (const l of this.listeners) l(e);
    }
  }

  private onEvent(e: SimEvent): void {
    switch (e.code) {
      case EventCode.CommanderFall: {
        const team = e.a < this.sim.squad_count() ? squadBits.team(this.views.squadU32[e.a]) : PLAYER;
        this.clock.holdSlow(team === PLAYER ? FALL_OURS_S : FALL_FOES_S);
        break;
      }
      case EventCode.FoeCommanderFall:
        this.clock.holdSlow(FALL_FOES_S);
        break;
      case EventCode.Outcome:
        if (!this.outcome) {
          this.outcome = { winner: e.a, why: String(e.b), tick: e.tick };
          console.log(`[battle] decided at tick ${e.tick}: team ${e.a} wins (reason ${e.b})`);
        }
        break;
    }
  }

  /** Called by the view just before it draws: poses the figures for the camera as it is now. */
  private drawFigures(): void {
    const p = this.perf;
    const { aw, ah } = this.view.renderer.size;
    const sc = this.view.sun.light.shadow.camera;
    const cam = this.view.camera;
    this.figures.update({
      men: this.records.men,
      banners: this.records.banners,
      dt: this.pendingDt,
      time: this.view.time,
      zoom: cam.s,
      screen: { origin: cam.origin, halfW: (aw + 2) / 2, halfH: (ah + 2) / 2 },
      shadowTexel: (sc.right - sc.left) / this.view.sun.light.shadow.mapSize.x,
    });
    this.pendingDt = 0;
    p.mark('figures');
  }
}
