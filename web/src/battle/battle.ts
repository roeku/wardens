import { EVENT_WORDS, EventCode, squadBits, SOLDIER_F32, SQUAD_F32, soldierBits, TICK_HZ, Views, type Deed, type P, type SimEvent, type Source, type Team } from '../contracts';
import type { Oval } from '../input/hit';
import type { Battle } from '../sim-pkg/sim_wasm.js';
import { Figures, type BannerRecord } from '../view/figures';
import { setFog } from '../view/fog';
import { groundAt } from '../view/land-data';
import { Marks } from '../view/marks';
import type { View } from '../view/view';
import { Clock, FALL_FOES_S, FALL_OURS_S } from './clock';
import { installFigureFog } from './figure-fog';
import { changed, drawGiven, OrderMarks } from './order-marks';
import { Perf } from './perf';
import { Records } from './records';
import { BattleUi, type OrdersView, type SitesView, type SquadInfo } from './ui';

// A live battle on the game page: the 30 Hz accumulator (04-battle.md §1), the sim stepped with its bots, the
// packed buffers read without a copy, the figures driven from them (§9), the fog fed to every material
// (02-look.md §3), the marks (02-look.md §7), and the camera following the captain until the player pans
// (02-look.md §2). The view only reads the sim; the only way in is a Command through `issue` (AGENTS.md rule 1).

/** The player's side. */
export const PLAYER: Team = 0;
/** 02-look.md §2: easeTo's rate. */
const FOLLOW_RATE = 3;
/** The day's light changes in steps of this much, so the shadow map re-fits now and then, not every frame. */
const DAY_STEP = 1 / 256;
/** Seconds the drawn state jumps by after a fast-forward (e^−16 of the old easing remains). */
const SETTLE_S = 1;
/** The selection ellipse's margin round the formation, tiles (chosen; order-marks.ts draws it). */
const OVAL_MARGIN = 0.7;
const OVAL_MIN = 0.9;
const NO_ORDERS: OrdersView = { captain: null, held: false, squads: [], army: [] };

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
  /** The side the player commands. */
  readonly team: Team = PLAYER;
  /** The marks on the field (02-look.md §7); `issue` draws an order's, voice may draw its own. */
  readonly marks: Marks;
  /** The input's state the marks read: the selection, the stroke, the hover. */
  readonly ui = new BattleUi();
  /** Real seconds since the battle opened, for the marks' breathing and blinking (runs on while paused). */
  uiTime = 0;
  /** Our orders as last read from the sim (every tick, and at once after an order is given). */
  orders: OrdersView = NO_ORDERS;
  sites: SitesView = { r: 1.8, sites: [] };
  /** Every company's fixed traits, by id. */
  squadInfo: SquadInfo[] = [];
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
  private readonly orderMarks: OrderMarks;
  /** The tick the orders were last read at. */
  private ordersTick = -1;
  /** Our refusals drained since this was last cleared (an order given checks it). */
  private refusedNow = 0;

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
    this.marks = new Marks(view.land);
    view.scene.add(this.marks.group);
    this.orderMarks = new OrderMarks(this);
    this.marks.drawers.push(this.orderMarks.draw);
    view.beforeDraw = () => this.drawFigures();
    this.pilot(opts.pilot);
    this.bot(opts.enemy);
    this.sync();
    this.build(0);
    this.readOrders();
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
    this.uiTime += dt;
    this.marks.tick(dt);
    if (this.sim.tick() !== this.ordersTick) this.readOrders(true);
    p.mark('records');
    if (this.follow) {
      const cap = this.captain();
      if (cap) this.view.camera.easeTo(cap.x, cap.y, dt, FOLLOW_RATE);
    }
    // the light is the clock (02-look.md §3): battle time over the sim's daylight, in steps
    this.view.dayT = Math.min(1, Math.floor(this.sim.tick() / TICK_HZ / this.daySeconds / DAY_STEP) * DAY_STEP);
    this.pendingDt = this.clock.paused ? 0 : dt;
  }

  /**
   * Gives an order: the Command goes through the WASM `apply`, is applied at once (`flush`, so it works and shows
   * while paused too), and leaves its marks (order-marks.ts `drawGiven`); a refusal shows a red X where the sim
   * refused it. Every input goes through here: taps, strokes, voice. Returns whether it was refused.
   */
  issue(deed: Deed, src: Source): { refused: boolean } {
    const before = this.orders;
    this.sim.apply(JSON.stringify({ tick: this.sim.tick(), team: this.team, deed, src }));
    this.refusedNow = 0;
    this.sim.flush();
    this.sync();
    this.drainEvents();
    this.build(0);
    this.readOrders(false);
    const refused = this.refusedNow > 0;
    drawGiven(this, this.marks, deed, before, this.orders, refused);
    // giving the army an order re-follows the captain (01-flow.md §2 "Camera follow")
    if (!refused && orderedArmy(deed)) this.follow = true;
    return { refused };
  }

  /** The ground's height at sim (x, y). */
  groundH(x: number, y: number): number {
    return this.ground(x, y);
  }

  /** A company's banner as drawn this frame, if it is. */
  bannerOf(id: number): BannerRecord | null {
    for (const b of this.records.banners) if (b.id === id) return b;
    return null;
  }

  /** The middle of a company's living men (sim tiles), if any live. */
  squadCentre(id: number): P | null {
    return this.records.centre(id);
  }

  /**
   * The ground oval of a company: an ellipse fitted to its formation along its facing, the selection's mark and
   * where a selected company answers a tap (01-flow.md §2 "Hit-testing").
   */
  oval(id: number): Oval | null {
    const v = this.views;
    if (id < 0 || id >= this.sim.squad_count()) return null;
    const face = v.squadF32[id * SQUAD_F32.FIELDS + SQUAD_F32.FACE];
    const f = Math.cos(face);
    const g = Math.sin(face);
    let n = 0;
    let lo = Infinity, hi = -Infinity, lo2 = Infinity, hi2 = -Infinity;
    for (const m of this.records.men) {
      if (!m.alive || soldierBits.squad(v.u32[m.id]) !== id) continue;
      const u = m.x * f + m.y * g;
      const w = -m.x * g + m.y * f;
      lo = Math.min(lo, u);
      hi = Math.max(hi, u);
      lo2 = Math.min(lo2, w);
      hi2 = Math.max(hi2, w);
      n++;
    }
    if (n === 0) return null;
    const cu = (lo + hi) / 2;
    const cw = (lo2 + hi2) / 2;
    return {
      c: { x: cu * f - cw * g, y: cu * g + cw * f },
      a: Math.max(OVAL_MIN, (hi - lo) / 2 + OVAL_MARGIN),
      b: Math.max(OVAL_MIN, (hi2 - lo2) / 2 + OVAL_MARGIN),
      face,
    };
  }

  /**
   * Reads our orders, the sites and (when the companies change) their traits. Once the sim has stepped, a company
   * whose waiting order fired gets the marks of an order given: the faint mark brightens (08-orders.md §6).
   */
  private readOrders(stepped = false): void {
    const before = this.orders;
    this.orders = JSON.parse(this.sim.orders_json(this.team)) as OrdersView;
    this.sites = JSON.parse(this.sim.sites_json()) as SitesView;
    if (this.squadInfo.length !== this.sim.squad_count()) this.squadInfo = JSON.parse(this.sim.squads_json()) as SquadInfo[];
    this.ordersTick = this.sim.tick();
    if (!stepped || before === NO_ORDERS) return;
    const fired = new Set<number>();
    const waits = new Map(before.squads.map((o) => [o.id, o.waits.length]));
    for (const o of this.orders.squads) if (o.waits.length < (waits.get(o.id) ?? 0)) fired.add(o.id);
    if (this.orders.army.length < before.army.length) {
      // an army order fired: the captain and every company whose verb changed with it
      const verbs = new Map(before.squads.map((o) => [o.id, o.order]));
      for (const o of this.orders.squads) if (o.id === this.orders.captain || verbs.get(o.id) !== o.order) fired.add(o.id);
    }
    if (fired.size) changed(this, this.marks, before, this.orders, fired);
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
    // the selected company's banner stands taller, the one under the mouse a little (figures' poseBanner)
    const { selected, hoverSquad } = this.ui;
    for (const b of this.records.banners) {
      b.selected = b.id === selected;
      b.hover = b.id === hoverSquad;
    }
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
      case EventCode.Refused:
        // a refused order of ours: a red cross at the spot, no words (01-flow.md §2; 08-orders.md §1)
        if (e.a === this.team) {
          this.marks.cross({ x: e.x, y: e.y });
          this.refusedNow++;
        }
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
    this.marks.draw(cam.s);
    p.mark('figures');
  }
}

/** Whether a deed orders the whole army (its captain): a tap, a front, a rally, a march along the captain's path. */
function orderedArmy(d: Deed): boolean {
  if (d.do === 'with') return orderedArmy(d.deed);
  if (d.do === 'front' || d.do === 'rally') return true;
  return 'who' in d && d.who.t === 'army';
}
