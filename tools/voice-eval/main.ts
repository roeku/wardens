// voice-eval (docs/spec/06-voice.md §9, 08-orders.md §9). Two suites, each case run N times through
// normalise → fast path → brain → resolve against a fixed field and checked against the expected result:
//   day1  the 20 commands of docs/voice-eval/cases.json on fixture.json (the default, as on day 1)
//   08    the order language: docs/voice-eval/cases-08.json on fixture-08.json, judged per category
// Reports accuracy, and brain and end-to-end latency at p50/p95. Writes every utterance and reply to
// out/voice-eval/<label>.json, and every live reply to the cache (out/voice-cache.json).
//
//   npm run voice-eval -- [--suite day1|08] [--mode prefill|chat] [--runs N] [--url http://127.0.0.1:8080]
//                         [--temp 0] [--cold] [--cached] [--only 12,cat-name,...] [--label name]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { warm, type BrainMode, type BrainOpts } from '../../web/src/voice/brain.ts';
import { enums, stateText, type Field } from '../../web/src/voice/field.ts';
import { understand, type Understood } from '../../web/src/voice/pipeline.ts';
import type { Act, Resolved } from '../../web/src/voice/resolve.ts';
import { ReplyCache, brainFor } from '../voice-cache.ts';

const DOCS = new URL('../../docs/voice-eval/', import.meta.url);
const { values: args } = parseArgs({
  options: {
    suite: { type: 'string', default: 'day1' },
    mode: { type: 'string', default: 'prefill' },
    runs: { type: 'string' },
    url: { type: 'string', default: process.env.BRAIN_URL ?? 'http://127.0.0.1:8080' },
    temp: { type: 'string', default: '0' },
    cold: { type: 'boolean', default: false },
    cached: { type: 'boolean', default: false },
    only: { type: 'string', default: '' },
    label: { type: 'string', default: '' },
  },
});

const opts: BrainOpts = { url: args.url!, mode: args.mode as BrainMode, temperature: Number(args.temp), slot: 0, timeoutMs: 60_000 };
const json = (name: string) => JSON.parse(readFileSync(new URL(name, DOCS), 'utf8'));

// ---------------------------------------------------------------------------------------------
// Day 1 (06-voice §9): who, do and target per resolved order.
// ---------------------------------------------------------------------------------------------

interface Expect1 {
  who: string[];
  do?: string;
  doIn?: string[];
  target?: string;
  side?: string;
  sideIn?: string[];
  fight?: boolean;
}
interface Case1 {
  n: number;
  said: string;
  path: 'fast' | 'brain';
  expect: Expect1[];
  unclear?: boolean;
  check?: string;
}

function whoMatches(want: string[], got: Resolved['who']): boolean {
  if (want.includes('ARMY')) return got === 'ARMY';
  return got !== 'ARMY' && got.length === want.length && want.every((w) => got.includes(w));
}

function matches1(e: Expect1, a: Resolved): boolean {
  return (
    whoMatches(e.who, a.who) &&
    (e.do === undefined || a.do === e.do) &&
    (e.doIn === undefined || e.doIn.includes(a.do)) &&
    (e.target === undefined || a.target === e.target) &&
    (e.side === undefined || a.side === e.side) &&
    (e.sideIn === undefined || e.sideIn.includes(a.side)) &&
    (e.fight === undefined || a.fight === e.fight)
  );
}

function judge1(c: Case1, u: Understood): string {
  const orders = u.resolution.orders;
  if (c.unclear) return u.reply.unclear && orders.length === 0 ? '' : 'expected unclear with no orders';
  if (c.path === 'fast' && u.path !== 'fast') return 'expected the fast path';
  if (u.reply.unclear && !orders.length) return 'answered unclear';
  if (orders.length !== c.expect.length) return `expected ${c.expect.length} orders, got ${orders.length}`;
  const left = [...orders];
  for (const e of c.expect) {
    const i = left.findIndex((a) => matches1(e, a));
    if (i < 0) return `no order matches ${JSON.stringify(e)}`;
    left.splice(i, 1);
  }
  const via = c.check?.match(/via point y < ([\d.]+)/);
  if (via && !(orders[0].via && orders[0].via.y < Number(via[1]))) return `via ${JSON.stringify(orders[0].via)} fails "${c.check}"`;
  const line = c.check?.match(/within ([\d.]+) tiles of x = ([\d.]+)/);
  if (line && !orders[0].line?.every((p) => Math.abs(p.x - Number(line[2])) <= Number(line[1]))) return `line ${JSON.stringify(orders[0].line)} fails "${c.check}"`;
  return '';
}

// ---------------------------------------------------------------------------------------------
// 08 (08-orders §9): the resolved acts, one per company, against the expected ones.
// ---------------------------------------------------------------------------------------------

interface Want {
  who: string[];
  do?: string;
  doIn?: string[];
  target?: string;
  targetIn?: string[];
  how?: Record<string, unknown>;
  when?: Record<string, unknown>;
  anyWhen?: boolean;
  at?: { x?: [number, number]; y?: [number, number] };
  via?: boolean;
  side?: string;
  fight?: boolean;
  work?: string;
  n?: number;
  from?: string;
}
interface Case08 {
  n: number;
  cat: string;
  said: string;
  path?: 'fast' | 'brain';
  expect?: Want[];
  none?: boolean;
  why?: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const within = (v: number, r?: [number, number]) => !r || (v >= r[0] && v <= r[1]);

/** Empty if the act is what the single-company want asks for, else the first difference. */
function differs(w: Want & { who: [string] }, a: Act): string {
  if (a.who !== w.who[0]) return 'who';
  if (w.do !== undefined && a.do !== w.do) return `do ${a.do}`;
  if (w.doIn && !w.doIn.includes(a.do)) return `do ${a.do}`;
  if (w.target !== undefined && a.target !== w.target) return `target ${a.target}`;
  if (w.targetIn && !w.targetIn.includes(a.target ?? '')) return `target ${a.target}`;
  if (w.how && !Object.entries(w.how).every(([k, v]) => same((a.how as Record<string, unknown> | undefined)?.[k], v))) return `how ${JSON.stringify(a.how ?? {})}`;
  if (w.when) {
    if (!a.when || !Object.entries(w.when).every(([k, v]) => same((a.when as Record<string, unknown>)[k], v))) return `when ${JSON.stringify(a.when ?? null)}`;
  } else if (!w.anyWhen && a.when) return `when ${JSON.stringify(a.when)} not asked for`;
  if (w.at && !(a.to && within(a.to.x, w.at.x) && within(a.to.y, w.at.y))) return `at ${JSON.stringify(a.to)}`;
  if (w.via && !a.via?.length) return 'no via';
  if (w.side !== undefined && a.side !== w.side) return `side ${a.side}`;
  if (w.fight !== undefined && a.fight !== w.fight) return `fight ${a.fight}`;
  if (w.work !== undefined && a.work !== w.work) return `work ${a.work}`;
  if (w.n !== undefined && a.n !== w.n) return `n ${a.n}`;
  if (w.from !== undefined && a.from !== w.from) return `from ${a.from}`;
  return '';
}

/** Every expected act must match a distinct act, and there must be no others (a small exact matching). */
function judge08(c: Case08, u: Understood): string {
  const acts = u.resolution.orders.flatMap((o) => o.acts);
  if (c.path === 'fast' && u.path !== 'fast') return 'expected the fast path';
  if (c.none) {
    if (acts.length) return `expected no orders, got ${acts.length} acts`;
    if (c.why && !u.resolution.refused.some((r) => r.why.includes(c.why!)) && !u.reply.unclear) return `refused without "${c.why}"`;
    return '';
  }
  if (!acts.length) {
    const why = u.resolution.refused.map((r) => r.why).join('; ');
    return u.reply.unclear ? 'answered unclear' : `refused: ${why}`;
  }
  const wants = (c.expect ?? []).flatMap((w) => w.who.map((who) => ({ ...w, who: [who] as [string] })));
  if (wants.length !== acts.length) return `expected ${wants.length} acts, got ${acts.length}`;
  const used = new Array(acts.length).fill(false);
  const fit = (i: number): boolean => {
    if (i === wants.length) return true;
    for (let j = 0; j < acts.length; j++) {
      if (used[j] || differs(wants[i], acts[j])) continue;
      used[j] = true;
      if (fit(i + 1)) return true;
      used[j] = false;
    }
    return false;
  };
  if (fit(0)) return '';
  // Say why for the first want that matches nothing.
  for (const w of wants) {
    const near = acts.filter((a) => a.who === w.who[0]).map((a) => differs(w, a));
    if (!near.includes('')) return `${w.who[0]} ${w.do ?? w.doIn}: ${near.length ? near.join(' / ') : 'no act'}`;
  }
  return 'acts do not pair up';
}

// ---------------------------------------------------------------------------------------------

interface Row {
  n: number;
  cat: string;
  run: number;
  said: string;
  heard: string;
  path: Understood['path'];
  pass: boolean;
  why: string;
  brainMs?: number;
  e2eMs: number;
  from?: string;
  promptTokens?: number;
  cachedTokens?: number;
  genTokens?: number;
  raw?: string;
  acts: Omit<Act, 'deed'>[];
  refused: string[];
  stalled: number;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function main(): Promise<void> {
  const day1 = args.suite === 'day1';
  const suite = day1 ? json('cases.json') : json('cases-08.json');
  const field = json(day1 ? 'fixture.json' : suite.fixture) as Field & { stateText: string };
  const runs = Number(args.runs ?? suite.runsPerCase ?? 1);

  if (day1) {
    // The Day 1 state text and schema (fixture.json, schema.json) are the Day 1 reply format, kept as records.
    // What ships now is the order-language format, so check only that every Day 1 name is still an enum.
    const old = json('schema.json').properties.orders.items.properties;
    const e = enums(field);
    const missing = [...old.who.items.enum.filter((w: string) => !e.who.includes(w)), ...old.target.enum.filter((t: string) => !['NONE'].includes(t) && !e.target.includes(t))];
    if (missing.length) throw new Error(`Day 1 names missing from the schema: ${missing.join(', ')}`);
  } else if (stateText(field) !== field.stateText) {
    throw new Error(`stateText differs from ${suite.fixture}:\n${stateText(field)}`);
  }

  const only = args.only ? args.only.split(',') : [];
  const cases = (suite.cases as (Case1 & Case08)[]).filter((c) => !only.length || only.includes(String(c.n)) || only.includes(c.cat));
  const cache = new ReplyCache();
  let tag = 0;
  const nonce = () => (args.cold ? `NOTE ${tag}.${Date.now()}\n` : '');
  const brain = brainFor(opts, field, cache, args.cached ? 'prefer-cache' : 'live', nonce);
  console.log(`voice-eval ${args.suite}: ${cases.length} cases × ${runs} runs, mode ${opts.mode}, ${opts.url}, temp ${opts.temperature}${args.cold ? ', cold state' : ''}${args.cached ? ', cached replies' : ''}`);
  if (!args.cached) await warm(opts, field);

  const log: Row[] = [];
  for (const c of cases) {
    const rows: Row[] = [];
    for (let run = 1; run <= runs; run++) {
      tag++;
      // A request the loaded machine stalls on (the weights paged out) is retried once, and counted as a stall.
      let stalled = 0;
      let u: Understood | undefined;
      while (!u) {
        try {
          u = await understand(field, c.said, brain);
        } catch (e) {
          if (++stalled > 1) throw e;
          console.log(`      stalled: ${(e as Error).message}; retrying`);
        }
      }
      const why = day1 ? judge1(c, u) : judge08(c, u);
      rows.push({
        n: c.n, cat: c.cat ?? 'day1', run, said: c.said, heard: u.heard, path: u.path, pass: !why, why, e2eMs: u.ms, stalled,
        brainMs: u.brain?.ms, from: u.brain?.from, promptTokens: u.brain?.promptTokens, cachedTokens: u.brain?.cachedTokens, genTokens: u.brain?.genTokens,
        raw: u.brain?.raw, acts: u.resolution.orders.flatMap((o) => o.acts.map(({ deed: _, ...a }) => a)), refused: u.resolution.refused.map((r) => r.why),
      });
    }
    cache.save();
    log.push(...rows);
    const passes = rows.filter((r) => r.pass).length;
    const ms = rows.map((r) => Math.round(r.brainMs ?? r.e2eMs)).join('/');
    const fail = rows.find((r) => !r.pass);
    const raw = fail ? (fail.raw ?? JSON.stringify(fail.acts)) : '';
    console.log(
      `${String(c.n).padStart(3)} ${passes}/${runs} ${(c.cat ?? '').padEnd(15).slice(0, 15)} ${rows[0].path.padEnd(5)} ${ms.padStart(12)} ms  ${c.said}` +
        (fail ? `\n      FAIL: ${fail.why}\n      reply: ${raw}${fail.refused.length ? `\n      refused: ${fail.refused.join('; ')}` : ''}` : ''),
    );
  }

  const live = log.filter((r) => r.brainMs !== undefined && r.from === 'live');
  const brainMs = live.map((r) => r.brainMs!);
  const gen = live.filter((r) => r.genTokens).map((r) => r.genTokens!);
  const fresh = live.filter((r) => r.promptTokens).map((r) => r.promptTokens!);
  const fastMs = log.filter((r) => r.path === 'fast').map((r) => r.e2eMs);
  const cats = [...new Set(log.map((r) => r.cat))];
  const perCat = cats.map((cat) => {
    const rows = log.filter((r) => r.cat === cat);
    const pass = rows.filter((r) => r.pass).length;
    return { cat, cases: rows.length / runs, accuracy: pass / rows.length, failed: [...new Set(rows.filter((r) => !r.pass).map((r) => r.n))] };
  });
  const passes = log.filter((r) => r.pass).length;
  const summary = {
    suite: args.suite,
    mode: opts.mode,
    cold: args.cold,
    temperature: opts.temperature,
    cases: cases.length,
    runs,
    accuracy: passes / log.length,
    perCategory: perCat,
    liveBrainCalls: live.length,
    stalls: log.reduce((s, r) => s + r.stalled, 0),
    brainP50: pct(brainMs, 50),
    brainP95: pct(brainMs, 95),
    genTokensP50: pct(gen, 50),
    genTokensP95: pct(gen, 95),
    newPromptTokensP50: pct(fresh, 50),
    fastP50: pct(fastMs, 50),
    fastMax: fastMs.length ? Math.max(...fastMs) : NaN,
  };
  console.log('');
  if (!day1) {
    console.log('category         cases  accuracy  failed');
    for (const p of perCat) console.log(`${p.cat.padEnd(16)} ${String(p.cases).padStart(5)}  ${(p.accuracy * 100).toFixed(0).padStart(7)}%  ${p.failed.join(', ')}`);
  }
  const t = suite.targets;
  console.log(
    `\naccuracy ${(summary.accuracy * 100).toFixed(1)}% (${passes}/${log.length})` +
      (day1 ? ` = ${(passes / runs).toFixed(2)}/20 (target ${t.accuracy})` : ` (gate ≥ ${t.perCategory * 100}% in every category)`) +
      `\nbrain p50 ${Math.round(summary.brainP50)} ms, p95 ${Math.round(summary.brainP95)} ms over ${live.length} live calls (${summary.stalls} stalled and retried)` +
      (day1 ? ` (Mac target ${t.brainP50MsMac})` : ` (gate ≤ ${t.brainP50MsMax})`) +
      `\ntokens: ${summary.genTokensP50} written (p50), ${summary.genTokensP95} (p95); ${summary.newPromptTokensP50} new prompt tokens read (p50)` +
      `\nfast path p50 ${summary.fastP50.toFixed(2)} ms, max ${summary.fastMax.toFixed(2)} ms`,
  );
  const label = args.label || `${args.suite}-${opts.mode}${args.cold ? '-cold' : ''}`;
  mkdirSync(new URL('../../out/voice-eval/', import.meta.url), { recursive: true });
  writeFileSync(new URL(`../../out/voice-eval/${label}.json`, import.meta.url), JSON.stringify({ summary, log }, null, 2));
  console.log(`log: out/voice-eval/${label}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
