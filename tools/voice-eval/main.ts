// voice-eval (docs/spec/06-voice.md §9): the 20 commands of docs/voice-eval/cases.json, each run N times
// through normalise → fast path → brain → resolve against the fixed field, checked against the expected
// orders, with accuracy and latency p50/p95. Writes every utterance and reply to out/voice-eval/<label>.json.
//
//   npm run voice-eval -- [--mode prefill|chat] [--runs 3] [--url http://127.0.0.1:8080] [--temp 0]
//                         [--cold] [--label name]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ask, warm, type BrainMode, type BrainOpts } from '../../web/src/voice/brain.ts';
import { orderSchema, stateText, type Field } from '../../web/src/voice/field.ts';
import { normalise } from '../../web/src/voice/normalise.ts';
import { canonicalNames, fastPath, type Reply } from '../../web/src/voice/orders.ts';
import { resolve, type Resolved } from '../../web/src/voice/resolve.ts';

interface Expect {
  who: string[];
  do?: string;
  doIn?: string[];
  target?: string;
  side?: string;
  sideIn?: string[];
  fight?: boolean;
}
interface Case {
  n: number;
  said: string;
  path: 'fast' | 'brain';
  expect: Expect[];
  unclear?: boolean;
  check?: string;
}
interface Run {
  n: number;
  run: number;
  said: string;
  heard: string;
  path: 'fast' | 'brain';
  pass: boolean;
  why: string;
  brainMs?: number;
  e2eMs: number;
  promptTokens?: number;
  cachedTokens?: number;
  genTokens?: number;
  raw?: string;
  orders: Omit<Resolved, 'deeds'>[];
}

const DOCS = new URL('../../docs/voice-eval/', import.meta.url);
const { values: args } = parseArgs({
  options: {
    mode: { type: 'string', default: 'prefill' },
    runs: { type: 'string', default: '3' },
    url: { type: 'string', default: process.env.BRAIN_URL ?? 'http://127.0.0.1:8080' },
    temp: { type: 'string', default: '0' },
    cold: { type: 'boolean', default: false },
    label: { type: 'string', default: '' },
  },
});

const fixture = JSON.parse(readFileSync(new URL('fixture.json', DOCS), 'utf8')) as Field & { stateText: string };
const suite = JSON.parse(readFileSync(new URL('cases.json', DOCS), 'utf8')) as { targets: Record<string, number>; cases: Case[] };
const schema = JSON.parse(readFileSync(new URL('schema.json', DOCS), 'utf8'));

// The builders must reproduce the documented state text and schema exactly.
if (stateText(fixture) !== fixture.stateText) throw new Error(`stateText differs from fixture.json:\n${stateText(fixture)}`);
if (JSON.stringify(orderSchema(fixture)) !== JSON.stringify(schema)) throw new Error('orderSchema differs from schema.json');

const opts: BrainOpts = { url: args.url!, mode: args.mode as BrainMode, temperature: Number(args.temp), slot: 0, timeoutMs: 120_000 };

function whoMatches(want: string[], got: Resolved['who']): boolean {
  if (want.includes('ARMY')) return got === 'ARMY';
  return got !== 'ARMY' && got.length === want.length && want.every((w) => got.includes(w));
}

function matches(e: Expect, a: Resolved): boolean {
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

/** Empty string on a pass, else why it failed. */
function judge(c: Case, path: Run['path'], reply: Reply, orders: Resolved[]): string {
  if (c.unclear) return reply.unclear && orders.length === 0 ? '' : 'expected unclear with no orders';
  if (c.path === 'fast' && path !== 'fast') return 'expected the fast path';
  // Orders given alongside unclear=true are still carried out; unclear alone gives the query horn.
  if (reply.unclear && !orders.length) return 'answered unclear';
  if (orders.length !== c.expect.length) return `expected ${c.expect.length} orders, got ${orders.length}`;
  const left = [...orders];
  for (const e of c.expect) {
    const i = left.findIndex((a) => matches(e, a));
    if (i < 0) return `no order matches ${JSON.stringify(e)}`;
    left.splice(i, 1);
  }
  const via = c.check?.match(/via point y < ([\d.]+)/);
  if (via && !(orders[0].via && orders[0].via.y < Number(via[1]))) return `via ${JSON.stringify(orders[0].via)} fails "${c.check}"`;
  const line = c.check?.match(/within ([\d.]+) tiles of x = ([\d.]+)/);
  if (line && !orders[0].line?.every((p) => Math.abs(p.x - Number(line[2])) <= Number(line[1]))) return `line ${JSON.stringify(orders[0].line)} fails "${c.check}"`;
  return '';
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function main(): Promise<void> {
  const runs = Number(args.runs);
  console.log(`voice-eval: ${suite.cases.length} cases × ${runs} runs, mode ${opts.mode}, ${opts.url}, temp ${opts.temperature}${args.cold ? ', cold state' : ''}`);
  await warm(opts, fixture);
  const log: Run[] = [];
  for (const c of suite.cases) {
    const results: Run[] = [];
    for (let run = 1; run <= runs; run++) {
      const t0 = performance.now();
      const norm = normalise(c.said);
      const fast = fastPath(norm, fixture);
      let reply: Reply;
      let path: Run['path'];
      let brain: Awaited<ReturnType<typeof ask>> | undefined;
      const heard = canonicalNames(norm, fixture);
      if (fast && fast !== 'pause') {
        reply = fast;
        path = 'fast';
      } else {
        brain = await ask(opts, fixture, heard, args.cold ? `NOTE ${c.n}.${run}.${Date.now()}\n` : '');
        reply = brain.reply;
        path = 'brain';
      }
      const { orders } = resolve(reply, fixture);
      const e2eMs = performance.now() - t0;
      const why = judge(c, path, reply, orders);
      results.push({
        n: c.n, run, said: c.said, heard, path, pass: !why, why, e2eMs,
        brainMs: brain?.ms, promptTokens: brain?.promptTokens, cachedTokens: brain?.cachedTokens, genTokens: brain?.genTokens, raw: brain?.raw,
        orders: orders.map(({ deeds: _, ...o }) => o),
      });
    }
    log.push(...results);
    const passes = results.filter((r) => r.pass).length;
    const ms = results.map((r) => Math.round(r.e2eMs)).join('/');
    const fail = results.find((r) => !r.pass);
    console.log(`${String(c.n).padStart(2)} ${passes}/${runs} ${results[0].path.padEnd(5)} ${ms.padStart(16)} ms  ${c.said}${fail ? `\n     FAIL: ${fail.why}\n     reply: ${fail.raw ?? JSON.stringify(fail.orders)}` : ''}`);
  }

  const brainMs = log.filter((r) => r.brainMs !== undefined).map((r) => r.brainMs!);
  const brainE2e = log.filter((r) => r.path === 'brain').map((r) => r.e2eMs);
  const gen = log.filter((r) => r.genTokens).map((r) => r.genTokens!);
  const fresh = log.filter((r) => r.promptTokens).map((r) => r.promptTokens!);
  const passes = log.filter((r) => r.pass).length;
  const allRuns = suite.cases.filter((c) => log.filter((r) => r.n === c.n).every((r) => r.pass)).length;
  const t = suite.targets;
  const summary = {
    mode: opts.mode,
    cold: args.cold,
    temperature: opts.temperature,
    accuracy: passes / runs,
    casesPassingEveryRun: allRuns,
    brainP50: pct(brainMs, 50),
    brainP95: pct(brainMs, 95),
    e2eBrainP50: pct(brainE2e, 50),
    e2eBrainP95: pct(brainE2e, 95),
    genTokensP50: pct(gen, 50),
    newPromptTokensP50: pct(fresh, 50),
  };
  console.log(
    `\naccuracy ${summary.accuracy.toFixed(2)}/20 (target ${t.accuracy}); ${allRuns}/20 cases pass every run\n` +
      `brain p50 ${Math.round(summary.brainP50)} ms, p95 ${Math.round(summary.brainP95)} ms (Mac target ${t.brainP50MsMac})\n` +
      `end to end (brain cases) p50 ${Math.round(summary.e2eBrainP50)} ms, p95 ${Math.round(summary.e2eBrainP95)} ms (Mac target ${t.endToEndP50MsMac})\n` +
      `tokens: ${summary.genTokensP50} written, ${summary.newPromptTokensP50} new prompt tokens read (p50)`,
  );
  const label = args.label || `${opts.mode}${args.cold ? '-cold' : ''}`;
  mkdirSync(new URL('../../out/voice-eval/', import.meta.url), { recursive: true });
  writeFileSync(new URL(`../../out/voice-eval/${label}.json`, import.meta.url), JSON.stringify({ summary, log }, null, 2));
  console.log(`log: out/voice-eval/${label}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
