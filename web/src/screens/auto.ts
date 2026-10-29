import type { App, Scene } from './app';
import { BattleScene } from './battle-scene';
import { readState } from './campaign';
import { ChronicleScene } from './chronicle';
import type { Flow } from './flow';
import { MusterScene } from './muster';
import { RoadScene } from './road';

// The campaign's debug hooks (docs/spec/01-flow.md §5): `autoMuster()`, and `autoCampaign()`, which plays a whole
// campaign through the real scenes: the card, the muster, the road's marches, every battle piloted by the commander bot
// and fast-forwarded, the honour at every camp, then the chronicle and the Hall. Frames are stepped by hand, so it runs
// the same in a hidden tab.

const STEP = 1 / 30;

/**
 * Yields to the page (promises, the land worker's messages) through a message channel: unlike a timer it is not
 * throttled in a hidden tab, so the run takes the same time seen or unseen.
 */
function yieldNow(): Promise<void> {
  return new Promise((ok) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => ok();
    ch.port2.postMessage(0);
  });
}

export interface AutoReport {
  ok: boolean;
  battles: { place: string; kind: string; won: boolean; ticks: number; ms: number }[];
  camps: number;
  honoured: string[];
  scenes: string[];
  end: string;
  /** Every error the run caused: frames that threw, console errors, uncaught errors, failed requests. */
  errors: number;
  logged?: { console: number; uncaught: number; failedRequests: number; frames: number; notes: string[] };
  seconds: number;
}

/**
 * Steps `n` frames of 1/30 s, yielding to the page after every few; a scene change in flight is waited on (its land
 * comes from the worker), never spun past.
 */
async function frames(app: App, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    if (app.pending) {
      await app.pending;
      return;
    }
    app.step(STEP);
    if (i % 4 === 3) await yieldNow();
  }
  await yieldNow();
}

/** Waits until the scene changes from `from` (stepping frames meanwhile), up to `ms`. */
async function changed(app: App, from: Scene | null, ms = 20000): Promise<Scene> {
  const t0 = performance.now();
  while (app.scene === from || app.scene === null) {
    if (performance.now() - t0 > ms) throw new Error(`the scene did not change from ${from?.name} in ${ms} ms`);
    if (app.pending) await app.pending;
    else await yieldNow();
    if (app.scene) app.step(STEP);
  }
  return app.scene;
}

export function autoMuster(app: App): string {
  const s = app.scene;
  if (s instanceof MusterScene) {
    s.autoMuster();
    const st = readState(s.campaign);
    return `planted ${st.muster.bands.filter((b) => b.commander !== null).length} of ${st.muster.banners}`;
  }
  if (app.campaign) {
    app.campaign.auto_muster();
    return 'mustered (not on screen)';
  }
  return 'no muster';
}

/** Plays a whole campaign from wherever the page is to the Hall. */
export async function autoCampaign(app: App, flow: Flow, opts: { maxBattles?: number; ffChunk?: number; maxTicks?: number; log?: boolean; brain?: boolean; stopAtCamp?: boolean } = {}): Promise<AutoReport> {
  const t0 = performance.now();
  const errors0 = app.errors;
  const rep: AutoReport = { ok: false, battles: [], camps: 0, honoured: [], scenes: [], end: '', errors: 0, seconds: 0 };
  const log = (m: string) => {
    if (opts.log !== false) console.log(`[auto] ${m}`);
  };
  const play = flow.playScenes;
  if (!play) throw new Error('no campaign scenes');
  // what the page logs as errors while it runs: console errors, uncaught errors and failed requests
  const seen = { console: 0, uncaught: 0, fetch: 0, notes: [] as string[] };
  const consoleError = console.error;
  console.error = (...a: unknown[]) => {
    seen.console++;
    if (seen.notes.length < 8) seen.notes.push(a.map(String).join(' ').slice(0, 200));
    consoleError.apply(console, a);
  };
  const onError = (e: ErrorEvent | PromiseRejectionEvent) => {
    seen.uncaught++;
    if (seen.notes.length < 8) seen.notes.push(String('message' in e ? e.message : e.reason).slice(0, 200));
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onError);
  const fetch0 = window.fetch;
  window.fetch = async (...a: Parameters<typeof fetch>) => {
    try {
      const r = await fetch0(...a);
      if (!r.ok) {
        seen.fetch++;
        if (seen.notes.length < 8) seen.notes.push(`fetch ${String(a[0])}: ${r.status}`);
      }
      return r;
    } catch (e) {
      seen.fetch++;
      throw e;
    }
  };
  const brainBefore = app.brainOff;
  const restore = () => {
    app.brainOff = brainBefore;
    console.error = consoleError;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onError);
    window.fetch = fetch0;
  };
  try {
    return await run(app, flow, opts, rep, seen, t0, errors0, log, play);
  } finally {
    restore();
  }
}

async function run(
  app: App,
  flow: Flow,
  opts: { maxBattles?: number; ffChunk?: number; maxTicks?: number; log?: boolean; brain?: boolean; stopAtCamp?: boolean },
  rep: AutoReport,
  seen: { console: number; uncaught: number; fetch: number; notes: string[] },
  t0: number,
  errors0: number,
  log: (m: string) => void,
  play: NonNullable<Flow['playScenes']>,
): Promise<AutoReport> {
  // fast-forwarded battles: the bots alone play (a brain could not keep up, and none need be running)
  const brainWas = app.brainOff;
  app.brainOff = opts.brain !== true;
  const over = app.phase() === 'won' || app.phase() === 'lost';
  if (!app.campaign || app.scene?.top !== 'play' || over) {
    const from = app.scene;
    await flow.campaignCards();
    await changed(app, from);
  }
  for (let guard = 0; guard < 200; guard++) {
    const s = app.scene;
    if (!s) {
      await yieldNow();
      continue;
    }
    rep.scenes.push(s.name);
    await frames(app, 16);
    if (s.name === 'cards') {
      await play.muster();
      await changed(app, s);
      continue;
    }
    if (s instanceof MusterScene) {
      log(autoMuster(app));
      await frames(app, 20);
      const st = readState(s.campaign);
      const place = pick(st);
      log(`setting out for ${st.road.places.find((p) => p.id === place)?.name}`);
      s.setOut(place);
      await changed(app, s);
      continue;
    }
    if (s instanceof RoadScene) {
      if (s.mode === 'hall') {
        rep.end = 'hall';
        break;
      }
      // the tally counts first; a march runs to its place
      let n = 0;
      while ((s.tallying || s.mode === 'march') && app.scene === s && n++ < 3000) await frames(app, 4);
      if (app.scene !== s) continue;
      if (s.mode === 'camp' && opts.stopAtCamp && s.honoured === null) {
        rep.end = 'camp';
        break;
      }
      if (s.mode === 'camp') {
        rep.camps++;
        const c = s.honoured === null ? s.state.warband.companies[0] : undefined;
        if (c) {
          s.honour(c);
          rep.honoured.push(c.name);
          log(`honoured ${c.name} at camp`);
        }
        await frames(app, 30);
      }
      const place = pick(s.state, opts.stopAtCamp);
      if (place < 0) throw new Error(`no reachable place in phase ${s.state.phase}`);
      log(`setting out for ${s.state.road.places.find((p) => p.id === place)?.name}`);
      s.setOut(place);
      // the march: on to a battle (the scene changes), or into camp on this same road
      let m = 0;
      while (app.scene === s && s.mode === 'march' && m++ < 4000) await frames(app, 4);
      if (app.pending) await app.pending;
      continue;
    }
    if (s instanceof BattleScene) {
      if (opts.maxBattles !== undefined && rep.battles.length >= opts.maxBattles) {
        rep.end = 'stopped';
        break;
      }
      const b = s.play;
      b.pilot(true);
      const tb = performance.now();
      const chunk = opts.ffChunk ?? 300;
      const max = opts.maxTicks ?? 30 * 1500;
      while (!b.outcome && b.sim.tick() < max) {
        b.fastForward(chunk);
        await yieldNow();
      }
      b.settle();
      await frames(app, 4);
      const st = readState(app.campaign!);
      const place = st.road.places.find((p) => p.id === st.at);
      const won = b.outcome?.winner === 0;
      rep.battles.push({ place: place?.name ?? '?', kind: place?.kind ?? '?', won, ticks: b.sim.tick(), ms: Math.round(performance.now() - tb) });
      log(`battle ${rep.battles.length} at ${place?.name} (${place?.kind}): ${won ? 'won' : 'lost'} at tick ${b.sim.tick()}`);
      if (!b.outcome) throw new Error('a battle did not end');
      await frames(app, 20);
      s.skip();
      await changed(app, s);
      continue;
    }
    if (s instanceof ChronicleScene) {
      await frames(app, 24);
      s.done();
      await changed(app, s);
      continue;
    }
    throw new Error(`autoCampaign: no rule for the scene ${s.name}`);
  }
  app.brainOff = brainWas;
  rep.errors = app.errors - errors0 + seen.console + seen.uncaught + seen.fetch;
  rep.logged = { console: seen.console, uncaught: seen.uncaught, failedRequests: seen.fetch, frames: app.errors - errors0, notes: seen.notes };
  rep.ok = rep.end === 'hall' && rep.errors === 0;
  rep.seconds = Math.round((performance.now() - t0) / 100) / 10;
  log(`done: ${rep.end}, ${rep.battles.length} battles, ${rep.camps} camps, ${rep.seconds} s`);
  return rep;
}

/** The place to go: a reachable camp if the warband is hurt, else the reachable place of the lowest lane. */
function pick(st: ReturnType<typeof readState>, campFirst = false): number {
  const r = st.road.places.filter((p) => p.reachable);
  if (r.length === 0) return -1;
  const hurt = campFirst || st.warband.companies.some((c) => c.men < c.full * 0.6);
  const camp = r.find((p) => p.kind === 'camp');
  if (hurt && camp) return camp.id;
  return r.sort((a, b) => a.lane - b.lane || a.id - b.id)[0].id;
}
