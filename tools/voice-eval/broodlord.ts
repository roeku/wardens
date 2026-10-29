// The broodlord eval (docs/spec/06-voice.md §8): the enemy's brain on the situations of
// docs/voice-eval/broodlord-situations.json — the blight's field as it saw it at moments of real harness battles,
// each with a way. Every answer goes through the game's own code (mind.ts: prompt, grammar, decide), and is judged:
//   valid     it parses, has at most 2 orders, every order resolves (nothing refused) and every deed passes the check;
//   sensible  it fits the way (the rules below, recorded in out/decisions-d5-broodlord.md).
// Prints accuracy and the brain's latency at p50/p95; writes out/voice-eval/<label>.json. Replies are cached in
// out/broodlord-cache.json, so `--cached` re-judges without a GPU.
//
//   npm run voice-eval -- --suite broodlord [--set heldout] [--runs N] [--cached] [--only 3,7] [--label name] [--url …]
// `--set heldout` runs docs/voice-eval/broodlord-heldout.json: other battles, never used to tune the prompt.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { P } from '../../web/src/contracts.ts';
import { complete, type BrainOpts } from '../../web/src/voice/brain.ts';
import {
  broodGrammar, broodPrefix, broodTurn, decide, MAX_ORDERS, MAX_TOKENS, type BroodField, type BroodlordWay, type Decision,
} from '../../web/src/voice/broodlord/mind.ts';
import type { Act } from '../../web/src/voice/resolve.ts';

const DOCS = new URL('../../docs/voice-eval/', import.meta.url);
const CACHE = new URL('../../out/broodlord-cache.json', import.meta.url);
/** The broodlord's name in the eval's prompts. */
const NAME = 'GRAX';
/** A target farther than this from the blight's home (its keep or town, or the broodlord on the field) is far. */
const FAR = 14;
/** …unless it is within this of a place the blight holds. */
const NEAR_HELD = 8;

interface Situation {
  n: number;
  map: string;
  seed: number;
  s: number;
  way: BroodlordWay;
  field: BroodField;
}

interface Entry {
  raw: string;
  ms: number;
  promptTokens: number;
  cachedTokens: number;
  genTokens: number;
  at: string;
}

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

/** Where the blight is at home: its keep or town, else the broodlord himself. */
function home(f: BroodField): P {
  const keep = f.places.find((p) => (p.type === 'keep' || p.type === 'town') && p.holder === 'ours');
  return keep ? { x: keep.x, y: keep.y } : { x: f.captain.x, y: f.captain.y };
}

/** Giving ground: a withdraw or regroup, or a move without fighting that ends nearer home than the company stands. */
const pullback = (a: Act, f: BroodField, at: P) => {
  if (a.do === 'withdraw' || a.do === 'regroup') return true;
  if (a.do !== 'move' || a.fight !== false || !a.to) return false;
  const c = f.ours.find((x) => x.name === a.who);
  return !c || dist(a.to, at) < dist(c, at) - 2;
};
const aggressive = (a: Act) => a.do === 'attack' || a.do === 'charge' || a.do === 'take';

/** A company with nothing to do: it can obey and is neither fighting nor going after anything. */
function free(f: BroodField): string[] {
  return f.ours
    .filter((c) => c.state !== 'routing' && c.state !== 'fighting' && !/^(attacking|charging|taking)/.test(c.doing))
    .map((c) => c.name);
}

/** Why the answer does not fit the way, or '' if it does. */
export function sensible(way: BroodlordWay, f: BroodField, d: Decision): string {
  const acts = d.resolution.orders.flatMap((o) => o.acts);
  const at = home(f);
  const held = f.places.filter((p) => p.holder === 'ours');
  const far = (a: Act) => !!a.to && dist(a.to, at) > FAR && !held.some((p) => dist(a.to!, p) <= NEAR_HELD);
  const placeLost = f.places.some((p) => p.holder === 'foe' && ['village', 'shrine', 'tower'].includes(p.type));
  switch (way) {
    case 'reckless': {
      if (acts.some((a) => pullback(a, f, at))) return 'reckless pulled back';
      const something = f.foesSeen.length > 0 || f.places.some((p) => p.holder !== 'ours' && ['village', 'shrine', 'tower'].includes(p.type));
      if (something && free(f).length && !acts.some(aggressive)) return `reckless left ${free(f).join(' ')} idle`;
      return '';
    }
    case 'steady': {
      if (acts.some((a) => a.do === 'charge')) return 'steady charged';
      const out = new Set(acts.filter((a) => aggressive(a) && far(a)).map((a) => a.who));
      if (out.size > 1) return `steady sent ${out.size} companies far out (${[...out].join(' ')})`;
      return '';
    }
    case 'stubborn': {
      if (acts.some((a) => pullback(a, f, at))) return 'stubborn gave ground';
      const away = acts.filter((a) => aggressive(a) && far(a) && !(a.do === 'take' && placeLost));
      if (away.length) return `stubborn went far from what it holds (${away.map((a) => `${a.who} ${a.do} ${a.target}`).join(', ')})`;
      return '';
    }
    case 'veteran': {
      const weak = f.foesSeen.filter((e) => e.kind === 'archer' || e.id === 'CAPTAIN' || e.state === 'routing' || (e.morale ?? 1) < 0.5 || e.men <= 3).map((e) => e.id);
      const strikes = acts.filter((a) => a.do === 'attack' || a.do === 'charge');
      if (!weak.length || !strikes.length) return '';
      if (strikes.some((a) => weak.includes(a.target ?? '') || a.target === 'WEAKEST')) return '';
      return `veteran struck ${strikes.map((a) => a.target).join(', ')} with ${weak.join(', ')} to hand`;
    }
  }
}

/** Why the answer is not valid, or '' if it is. */
function valid(raw: string, f: BroodField): { why: string; d?: Decision } {
  let d: Decision;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { why: 'not an array' };
    if (parsed.length > MAX_ORDERS) return { why: `${parsed.length} orders` };
    d = decide(raw, f);
  } catch (e) {
    return { why: `does not parse: ${(e as Error).message}` };
  }
  if (d.resolution.refused.length) return { why: `refused: ${d.resolution.refused.map((r) => r.why).join('; ')}`, d };
  if (d.dropped.length) return { why: `dropped: ${d.dropped.map((x) => x.why).join('; ')}`, d };
  return { why: '', d };
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

export async function broodlordEval(args: { url: string; temp: number; runs?: number; cached: boolean; only: string; label: string; set?: string }): Promise<void> {
  const file = args.set === 'heldout' ? 'broodlord-heldout.json' : 'broodlord-situations.json';
  const doc = JSON.parse(readFileSync(new URL(file, DOCS), 'utf8')) as { situations: Situation[] };
  const only = args.only ? args.only.split(',') : [];
  const cases = doc.situations.filter((c) => !only.length || only.includes(String(c.n)) || only.includes(c.way) || only.includes(c.map));
  const runs = args.runs ?? 1;
  const brain: BrainOpts = { url: args.url, mode: 'prefill', temperature: args.temp, slot: 1, timeoutMs: 120_000, user: 'broodlord' };
  const cache: Record<string, Entry> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
  console.log(`broodlord eval (${file}): ${cases.length} situations × ${runs} runs, ${args.url}, slot 1, temp ${args.temp}${args.cached ? ', cached replies' : ''}`);

  // the first way's prefix read once, so the first case is not the cold one (each way's prefix differs only at its end)
  if (!args.cached && cases.length) {
    const r = await complete(brain, broodPrefix(cases[0].way, NAME), broodTurn(cases[0].field), '', 0);
    console.log(`warm: read ${r.promptTokens} tokens in ${Math.round(r.ms)} ms`);
  }

  interface Row {
    n: number;
    way: BroodlordWay;
    map: string;
    run: number;
    raw: string;
    ms: number;
    from: 'live' | 'cache';
    promptTokens: number;
    cachedTokens: number;
    genTokens: number;
    orders: number;
    deeds: number;
    /** Orders that named only broken companies: nothing to do. */
    moot: number;
    valid: string;
    sensible: string;
    pass: boolean;
    acts: string[];
  }
  const rows: Row[] = [];
  for (const c of cases) {
    const prefix = broodPrefix(c.way, NAME);
    const turn = broodTurn(c.field);
    const grammar = broodGrammar(c.field);
    const key = createHash('sha256').update(JSON.stringify([args.temp, prefix, turn, grammar])).digest('hex').slice(0, 20);
    for (let run = 1; run <= runs; run++) {
      let e = args.cached ? cache[key] : undefined;
      let from: Row['from'] = 'cache';
      if (!e) {
        if (args.cached) throw new Error(`no cached reply for situation ${c.n}; run without --cached`);
        const r = await complete(brain, prefix, turn, grammar, MAX_TOKENS);
        e = { raw: r.raw, ms: Math.round(r.ms), promptTokens: r.promptTokens, cachedTokens: r.cachedTokens, genTokens: r.genTokens, at: new Date().toISOString() };
        cache[key] = e;
        from = 'live';
      }
      const v = valid(e.raw, c.field);
      const s = v.d && !v.why ? sensible(c.way, c.field, v.d) : '';
      const acts = v.d ? v.d.resolution.orders.flatMap((o) => o.acts.map((a) => `${a.who} ${a.do}${a.target ? ' ' + a.target : ''}${a.fight === false ? ' nofight' : ''}`)) : [];
      rows.push({
        n: c.n, way: c.way, map: c.map, run, raw: e.raw, ms: e.ms, from, promptTokens: e.promptTokens, cachedTokens: e.cachedTokens, genTokens: e.genTokens,
        orders: v.d?.reply.orders.length ?? 0, deeds: v.d?.deeds.length ?? 0, moot: v.d?.moot.length ?? 0, valid: v.why, sensible: s, pass: !v.why && !s, acts,
      });
      const row = rows[rows.length - 1];
      console.log(
        `${String(c.n).padStart(3)} ${c.way.padEnd(8)} ${`${c.map} ${c.seed} t${c.s}`.padEnd(14)} ${row.pass ? 'PASS' : 'FAIL'} ${String(e.ms).padStart(6)} ms ${e.raw}` +
          (row.valid ? `\n      invalid: ${row.valid}` : '') + (row.sensible ? `\n      not ${c.way}: ${row.sensible}` : ''),
      );
    }
  }
  mkdirSync(new URL('./', CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(cache, null, 1));

  const live = rows.filter((r) => r.from === 'live');
  const ms = (live.length ? live : rows).map((r) => r.ms);
  const ways = [...new Set(rows.map((r) => r.way))];
  const passes = rows.filter((r) => r.pass).length;
  const summary = {
    situations: cases.length,
    runs,
    accuracy: passes / rows.length,
    valid: rows.filter((r) => !r.valid).length / rows.length,
    perWay: ways.map((w) => {
      const rs = rows.filter((r) => r.way === w);
      return { way: w, cases: rs.length, accuracy: rs.filter((r) => r.pass).length / rs.length, failed: [...new Set(rs.filter((r) => !r.pass).map((r) => r.n))] };
    }),
    empty: rows.filter((r) => r.orders === 0).length,
    moot: rows.reduce((n, r) => n + r.moot, 0),
    maxOrders: Math.max(0, ...rows.map((r) => r.orders)),
    liveCalls: live.length,
    brainP50: pct(ms, 50),
    brainP95: pct(ms, 95),
    genTokensP50: pct(live.map((r) => r.genTokens), 50),
    newPromptTokensP50: pct(live.map((r) => r.promptTokens), 50),
  };
  console.log('\nway       cases  accuracy  failed');
  for (const p of summary.perWay) console.log(`${p.way.padEnd(9)} ${String(p.cases).padStart(5)}  ${(p.accuracy * 100).toFixed(0).padStart(7)}%  ${p.failed.join(', ')}`);
  console.log(
    `\naccuracy ${(summary.accuracy * 100).toFixed(1)}% (${passes}/${rows.length}); valid ${(summary.valid * 100).toFixed(1)}%; ${summary.empty} answers were [] (carry on), ${summary.moot} orders named only broken companies; at most ${summary.maxOrders} orders` +
      `\nbrain p50 ${Math.round(summary.brainP50)} ms, p95 ${Math.round(summary.brainP95)} ms over ${live.length ? `${live.length} live calls` : `${rows.length} cached replies (their recorded times)`}` +
      `\ntokens: ${summary.genTokensP50} written (p50), ${summary.newPromptTokensP50} new prompt tokens read (p50)`,
  );
  const label = args.label || 'broodlord';
  mkdirSync(new URL('../../out/voice-eval/', import.meta.url), { recursive: true });
  writeFileSync(new URL(`../../out/voice-eval/${label}.json`, import.meta.url), JSON.stringify({ summary, rows }, null, 2));
  console.log(`log: out/voice-eval/${label}.json`);
}
