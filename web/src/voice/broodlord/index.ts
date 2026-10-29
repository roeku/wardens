// The enemy broodlord's mind in the live battle (docs/spec/06-voice.md §8; docs/engine/contracts/campaign.md §7).
// Every 8 s of game time, and at once when one of its companies breaks or a place changes hands, the blight's field
// (its own fog) goes to the local brain on its own server slot (1) under its own cached prefix, with its way as its
// character. The answer (at most 2 orders) is resolved and checked in code (mind.ts) and queued for team 1 as
// `src: 'brain'` commands through the same order queue; the bots carry the intents out between calls
// (crates/sim/src/bots/intent.rs). Replays need no model: the intents are in the command log.
//
// Voice has priority: the broodlord skips its call while the captain holds to talk or a voice request runs, and a
// call in flight is aborted when the captain starts to hold (brain.ts `brainLock`). With `enabled: false`, with no
// brain, or when the brain fails, the bots alone play.

import type { BattleView } from '../../battle/battle';
import { EventCode, type Deed, type SimEvent } from '../../contracts';
import { BrainBusy, brainLock, complete, type BrainOpts, type LockStats } from '../brain';
import { broodGrammar, broodPrefix, broodText, broodTurn, decide, MAX_TOKENS, type BroodField, type BroodlordWay } from './mind';

export type { BroodlordWay } from './mind';

export interface BroodlordOpts {
  way: BroodlordWay;
  name: string;
  enabled: boolean;
}

/** 06-voice.md §8: the brain is called every this many seconds of game time. */
const CALL_EVERY_S = 8;
const TICK_HZ = 30;
/** How often the page looks whether a call is due, ms. */
const POLL_MS = 100;
/** A call slower than this is abandoned (the bots go on with the intents they have). */
const CALL_MS = 10_000;
/** Reading the rules and examples into the slot once, at the start. */
const WARM_MS = 90_000;
/** A brain that failed (not one that was slow or gave way to voice) is left alone this long. */
const DOWN_MS = 15_000;
const TEAM = 1;

/** One call, as logged (06-voice.md §8 "its decisions are logged like the player's"). */
export interface BroodCall {
  /** The tick the field was read at, and the tick the deeds were queued at. */
  tick: number;
  queuedAt?: number;
  why: 'every' | 'broke' | 'place' | 'retry' | 'warm';
  way: BroodlordWay;
  /** ok: deeds queued (maybe none); skipped: voice had the brain; aborted: voice took it mid-call; slow; failed. */
  outcome: 'ok' | 'aborted' | 'slow' | 'failed' | 'stale';
  ms: number;
  raw?: string;
  deeds: Deed[];
  dropped?: string[];
  refused?: string[];
  tokens?: { read: number; cached: number; written: number };
  error?: string;
  field?: string;
}

/** One deed in the command log's terms (06-voice.md §7): replays use only `deed`. */
export interface BroodLogEntry {
  tick: number;
  team: 1;
  deed: Deed;
  src: 'brain';
  reply: string;
  brain: string;
  ms: number;
}

export interface BroodStats {
  calls: number;
  ok: number;
  aborted: number;
  slow: number;
  failed: number;
  /** Ticks skipped because voice had the brain. */
  skipped: number;
  /** Latency of the answered calls, ms. */
  ms: number[];
  deeds: number;
  lock: LockStats;
}

class Mind {
  readonly calls: BroodCall[] = [];
  readonly log: BroodLogEntry[] = [];
  readonly stats: Omit<BroodStats, 'lock'> = { calls: 0, ok: 0, aborted: 0, slow: 0, failed: 0, skipped: 0, ms: [], deeds: 0 };
  private readonly brain: BrainOpts;
  private readonly prefix: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private next = 0;
  private urgent: BroodCall['why'] | null = null;
  private busy = false;
  private downUntil = 0;
  private disposed = false;
  private warmed = false;
  private readonly listen = (e: SimEvent) => this.onEvent(e);

  constructor(
    readonly play: BattleView,
    readonly opts: BroodlordOpts,
  ) {
    const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
    const where = params.get('brain') === 'hosted' ? '/brain-hosted' : '/brain';
    this.brain = { url: location.origin + where, mode: 'prefill', temperature: 0, slot: 1, timeoutMs: CALL_MS, user: 'broodlord' };
    this.prefix = broodPrefix(opts.way, opts.name.toUpperCase() || 'THE BROODLORD');
    play.listeners.push(this.listen);
    this.next = play.sim.tick() + CALL_EVERY_S * TICK_HZ;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    void this.warm();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const i = this.play.listeners.indexOf(this.listen);
    if (i >= 0) this.play.listeners.splice(i, 1);
  }

  private onEvent(e: SimEvent): void {
    if (e.code === EventCode.Rout && this.play.squadInfo[e.a]?.team === TEAM) this.urgent = 'broke';
    else if (e.code === EventCode.SiteTaken) this.urgent ??= 'place';
  }

  /** The field as the blight sees it now. */
  field(): BroodField {
    return JSON.parse(broodApi(this.play).broodlord_field()) as BroodField;
  }

  /** Reads the rules, the examples and the way into slot 1 once, so the first call is not the slow one. */
  private async warm(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    const t0 = performance.now();
    const field = this.field();
    try {
      const r = await complete({ ...this.brain, timeoutMs: WARM_MS }, this.prefix, broodTurn(field), '', 0);
      this.warmed = true;
      this.calls.push({ tick: field.tick ?? 0, why: 'warm', way: this.opts.way, outcome: 'ok', ms: Math.round(r.ms), deeds: [], tokens: { read: r.promptTokens, cached: r.cachedTokens, written: 0 } });
    } catch (e) {
      // given way to voice, or no brain: the first call reads the prefix itself
      this.calls.push({ tick: field.tick ?? 0, why: 'warm', way: this.opts.way, outcome: e instanceof BrainBusy || isAbort(e) ? 'aborted' : 'failed', ms: Math.round(performance.now() - t0), deeds: [], error: String(e) });
      if (!(e instanceof BrainBusy) && !isAbort(e)) this.downUntil = performance.now() + DOWN_MS;
    } finally {
      this.busy = false;
    }
  }

  private async poll(): Promise<void> {
    if (this.disposed || this.busy || !this.opts.enabled) return;
    const play = this.play;
    if (play.outcome || play.clock.paused) return;
    const tick = play.sim.tick();
    const why = this.urgent ?? (tick >= this.next ? 'every' : null);
    if (!why) return;
    if (performance.now() < this.downUntil) {
      this.next = tick + CALL_EVERY_S * TICK_HZ;
      this.urgent = null;
      return;
    }
    // Voice has priority: this tick is skipped (an urgent call waits until the brain is free).
    if (brainLock.voiceActive || brainLock.busy) {
      if (why === 'every' && !this.urgent) {
        this.next = tick + CALL_EVERY_S * TICK_HZ;
        this.stats.skipped++;
      }
      return;
    }
    this.next = tick + CALL_EVERY_S * TICK_HZ;
    this.urgent = null;
    await this.call(why);
  }

  /** One call: the field, the brain, the deeds into the queue. */
  private async call(why: BroodCall['why']): Promise<void> {
    const field = this.field();
    if (!field.ours.some((c) => c.state !== 'routing')) return;
    this.busy = true;
    this.stats.calls++;
    const c: BroodCall = { tick: field.tick ?? this.play.sim.tick(), why, way: this.opts.way, outcome: 'ok', ms: 0, deeds: [], field: broodText(field) };
    const t0 = performance.now();
    try {
      const r = await complete(this.brain, this.prefix, broodTurn(field), broodGrammar(field), MAX_TOKENS);
      c.ms = Math.round(r.ms);
      c.raw = r.raw;
      c.tokens = { read: r.promptTokens, cached: r.cachedTokens, written: r.genTokens };
      if (this.disposed || this.play.outcome) {
        c.outcome = 'stale';
        return;
      }
      const d = decide(r.raw, field);
      c.dropped = d.dropped.map((x) => x.why);
      c.refused = d.resolution.refused.map((x) => x.why);
      c.queuedAt = this.play.sim.tick();
      const note = { brain: 'local', way: this.opts.way, why, ms: c.ms, field: c.tick };
      for (const deed of d.deeds) {
        // the order queue, as every input: applied at the next tick, when the bots have thought, as in a replay
        this.play.sim.apply(JSON.stringify({ tick: c.queuedAt, team: TEAM, deed, src: 'brain', note }));
        this.log.push({ tick: c.queuedAt, team: TEAM, deed, src: 'brain', reply: r.raw, brain: 'local', ms: c.ms });
      }
      c.deeds = d.deeds;
      this.stats.ok++;
      this.stats.deeds += d.deeds.length;
      this.stats.ms.push(c.ms);
      if (!this.warmed) this.warmed = true;
    } catch (e) {
      c.ms = Math.round(performance.now() - t0);
      c.error = e instanceof Error ? e.message : String(e);
      // given way to voice: refused at once, or aborted by the lock (the only one that aborts it)
      if (e instanceof BrainBusy || isAbort(e)) {
        c.outcome = 'aborted';
        this.stats.aborted++;
        // try again as soon as the brain is free
        this.urgent ??= why === 'every' ? 'retry' : why;
      } else if (isTimeout(e)) {
        c.outcome = 'slow';
        this.stats.slow++;
      } else {
        c.outcome = 'failed';
        this.stats.failed++;
        this.downUntil = performance.now() + DOWN_MS;
      }
    } finally {
      this.busy = false;
      this.record(c);
    }
  }

  private record(c: BroodCall): void {
    this.calls.push(c);
    const said = c.raw ?? c.error ?? '';
    console.log(`[broodlord] ${c.why} t${c.tick} ${c.outcome} ${c.ms} ms: ${said}${c.deeds.length ? ` → ${c.deeds.length} deeds` : ''}${c.refused?.length ? `, refused: ${c.refused.join('; ')}` : ''}`);
    if (import.meta.env?.DEV) {
      const { field: _, ...line } = c;
      fetch('/__voicelog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ broodlord: line }) }).catch(() => {});
    }
  }

  report(): BroodStats {
    return { ...this.stats, ms: [...this.stats.ms], lock: { ...brainLock.stats, voiceWaitMs: [...brainLock.stats.voiceWaitMs] } };
  }
}

/** The WASM battle's broodlord exports (crates/sim-wasm/src/broodlord_api.rs). */
interface BroodApi {
  broodlord_field(): string;
  replay_json(setup: string, bot0: string, bot1: string): string;
}
const broodApi = (play: BattleView) => play.sim as unknown as BroodApi;

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'TimeoutError';
}

/** The broodlord's mind for each battle on screen. */
const minds = new WeakMap<BattleView, Mind>();
/** The one on screen now, for the dev hooks. */
let current: Mind | null = null;

/**
 * Installs the broodlord's mind for this battle (docs/engine/contracts/campaign.md §7). The battle scene calls it for
 * every battle against a broodlord; with `enabled: false` (or no brain) the bots alone play. A second call for the
 * same battle replaces the first.
 */
export function installBroodlord(play: BattleView, opts: BroodlordOpts): { dispose(): void } {
  minds.get(play)?.dispose();
  minds.delete(play);
  if (!opts.enabled) return { dispose() {} };
  const mind = new Mind(play, opts);
  minds.set(play, mind);
  current = mind;
  if (import.meta.env?.DEV) installDev();
  return {
    dispose() {
      mind.dispose();
      if (minds.get(play) === mind) minds.delete(play);
      if (current === mind) current = null;
    },
  };
}

/** `?broodlord=reckless|steady|stubborn|veteran` (or `1`, reckless) installs the mind on a battle with no foe given,
 * until every battle scene passes its broodlord (the dev path's `?kind=` battle). */
export function broodlordFromUrl(play: BattleView): { dispose(): void } | null {
  const params = new URLSearchParams(location.search);
  const flag = params.get('broodlord');
  if (!flag || flag === '0' || minds.has(play)) return null;
  const way = (['stubborn', 'reckless', 'steady', 'veteran'].includes(flag) ? flag : 'reckless') as BroodlordWay;
  return installBroodlord(play, { way, name: params.get('broodname') ?? 'GRAX', enabled: params.get('brain') !== 'off' });
}

/** `__v.broodlord()`: the mind's calls, log and counts; `__v.broodField()`: the blight's field and its text. */
function installDev(): void {
  const w = window as unknown as { __v?: Record<string, unknown> };
  w.__v = Object.assign(w.__v ?? {}, {
    broodlord(): { calls: BroodCall[]; log: BroodLogEntry[]; stats: BroodStats } | null {
      return current && { calls: current.calls, log: current.log, stats: current.report() };
    },
    broodField(): { field: BroodField; text: string } | null {
      if (!current) return null;
      const f = current.field();
      return { field: f, text: broodText(f) };
    },
    /** The battle so far as a replay (seed, map, tick, the log less the bots' orders, the bots by name): with the
     * brain's intents in the log it re-runs without a model (`harness hashes`). */
    broodReplay(setup = ''): string | null {
      if (!current) return null;
      const bots = current.play.bots;
      return broodApi(current.play).replay_json(setup, bots.pilot ? 'commander' : 'none', bots.enemy);
    },
  });
}
