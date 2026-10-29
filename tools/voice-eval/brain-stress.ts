// Brain stability under the broodlord (docs/spec/06-voice.md §8; DECISIONS.md D-20 "brain stability"): does
// llama-server stay up, and stay quick, when the page aborts the broodlord's call for a voice order, and when two
// requests reach it at once (two tabs, or the eval beside a page, which the page's lock cannot prevent)?
//
//   node tools/voice-eval/brain-stress.ts [--aborts 30] [--pairs 10] [--same 0] [--url http://127.0.0.1:8080] [--label x]
//
// aborts  the game's own path: a broodlord call on slot 1 (brain.ts `complete`, a field from the broodlord
//         situations), aborted after a random 50–2500 ms by the voice's claim (`brainLock.claim()`), then at once a
//         voice order on slot 0 (`ask`, a Day 1 sentence). Measures the voice order's latency, whether slot 1 is still
//         processing after the abort (the server did not drop the cancelled task), and /health.
// pairs   a voice request and a broodlord request sent together, outside the lock (two tabs).
// same    two voice requests sent together on slot 0 (the case that crashed the server on day 4). Off by default.
// Writes out/voice-eval/<label>.json.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ask, brainLock, complete, type BrainOpts } from '../../web/src/voice/brain.ts';
import { broodGrammar, broodPrefix, broodTurn, MAX_TOKENS, type BroodField } from '../../web/src/voice/broodlord/mind.ts';
import { orderGrammar, type Field } from '../../web/src/voice/field.ts';
import { PREFIX, userTurn } from '../../web/src/voice/prompt.ts';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string', default: '12' },
    idle: { type: 'string', default: '12' },
    aborts: { type: 'string', default: '30' },
    pairs: { type: 'string', default: '10' },
    same: { type: 'string', default: '0' },
    stagger: { type: 'string', default: '0' },
    /** The game's own path to the hang: a broodlord warm aborted by voice, then its next call on the same slot. */
    rewarm: { type: 'string', default: '0' },
    /** In the staggered rounds, the first request only reads (a warm, n_predict 0), as at hold start. */
    warmfirst: { type: 'boolean', default: false },
    /** The first request goes to this slot (1: a broodlord warm while the voice orders on 0). */
    firstslot: { type: 'string', default: '0' },
    url: { type: 'string', default: process.env.BRAIN_URL ?? 'http://127.0.0.1:8080' },
    label: { type: 'string', default: 'brain-stress' },
  },
});
const url = args.url!;
const DOCS = new URL('../../docs/voice-eval/', import.meta.url);
const field = JSON.parse(readFileSync(new URL('fixture.json', DOCS), 'utf8')) as Field;
const situations = (JSON.parse(readFileSync(new URL('broodlord-situations.json', DOCS), 'utf8')) as { situations: { field: BroodField }[] }).situations;
const SAID = ['bors take the riders round the left to the mill', 'archers onto the ridge', 'shields block the ford', 'attack the drakes', 'fall back to the woods', 'spears on the trolls'];
const voice: BrainOpts = { url, mode: 'prefill', temperature: 0, slot: 0, timeoutMs: 60_000, user: 'voice' };
const brood: BrainOpts = { url, mode: 'prefill', temperature: 0, slot: 1, timeoutMs: 60_000, user: 'broodlord' };
const prefix = broodPrefix('reckless', 'GRAX');
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : NaN);

async function health(): Promise<{ ok: boolean; slots: boolean[] }> {
  try {
    const h = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    const s = (await (await fetch(`${url}/slots`, { signal: AbortSignal.timeout(5000) })).json()) as { is_processing: boolean }[];
    return { ok: h.ok, slots: s.map((x) => x.is_processing) };
  } catch {
    return { ok: false, slots: [] };
  }
}

/** Waits until slot 1 is idle (the cancelled task gone); returns how long that took, or -1 after 30 s. */
async function slotIdle(slot: number): Promise<number> {
  const t0 = performance.now();
  while (performance.now() - t0 < 30_000) {
    const h = await health();
    if (h.ok && !h.slots[slot]) return Math.round(performance.now() - t0);
    await sleep(50);
  }
  return -1;
}

async function main(): Promise<void> {
  const out: Record<string, unknown> = { url, at: new Date().toISOString() };
  console.log(`brain stress at ${url}: health ${JSON.stringify(await health())}`);
  // the voice prefix and the broodlord prefix read once
  await ask(voice, field, 'hold the ridge');
  await complete(brood, prefix, broodTurn(situations[0].field), '', 0);

  // 0a. The voice alone: its latency with nothing else on the server.
  const base: number[] = [];
  for (let i = 0; i < Number(args.base); i++) {
    const t0 = performance.now();
    await ask(voice, field, SAID[i % SAID.length]);
    base.push(Math.round(performance.now() - t0));
  }
  out.base = { rounds: base.length, voiceP50: pct(base, 50), voiceP95: pct(base, 95), rows: base };
  console.log(`voice alone: p50 ${pct(base, 50)} ms, p95 ${pct(base, 95)} ms over ${base.length}`);

  // 0b. How long the server goes on with a broodlord call after the page aborts it (nothing else sent).
  const idle: { delay: number; ms: number }[] = [];
  for (let i = 0; i < Number(args.idle); i++) {
    const f = situations[(i * 11 + 1) % situations.length].field;
    const delay = 50 + Math.round((i * 613) % 2451);
    const call = complete(brood, prefix, broodTurn(f), broodGrammar(f), MAX_TOKENS).catch(() => null);
    await sleep(delay);
    const release = brainLock.claim();
    await call;
    idle.push({ delay, ms: await slotIdle(1) });
    release();
  }
  out.idle = { rounds: idle.length, p50: pct(idle.map((x) => x.ms), 50), max: Math.max(...idle.map((x) => x.ms)), rows: idle };
  console.log(`after an abort, slot 1 idle in p50 ${pct(idle.map((x) => x.ms), 50)} ms, max ${Math.max(...idle.map((x) => x.ms))} ms`);

  // 1. Aborts, as the game does them.
  const n = Number(args.aborts);
  const rows: { delay: number; aborted: boolean; voiceMs: number; voiceOk: boolean; stillBusyMs: number; healthy: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const f = situations[(i * 7) % situations.length].field;
    const delay = 50 + Math.round(((i * 997) % 2451));
    const call = complete(brood, prefix, broodTurn(f), broodGrammar(f), MAX_TOKENS).then(
      () => false,
      (e) => e instanceof DOMException && e.name === 'AbortError',
    );
    await sleep(delay);
    const release = brainLock.claim();
    const aborted = await call;
    // the moment the abort lands, is the server still working on the cancelled task?
    const busy = (await health()).slots[1] ?? false;
    const t0 = performance.now();
    let ok = true;
    try {
      await ask(voice, field, SAID[i % SAID.length]);
    } catch {
      ok = false;
    }
    const voiceMs = Math.round(performance.now() - t0);
    release();
    const stillBusyMs = busy ? await slotIdle(1) : 0;
    const h = await health();
    rows.push({ delay, aborted, voiceMs, voiceOk: ok, stillBusyMs, healthy: h.ok });
    console.log(`abort ${String(i + 1).padStart(2)}: after ${delay} ms ${aborted ? 'aborted' : 'had finished'}; slot 1 ${busy ? `still busy (idle after ${stillBusyMs} ms)` : 'idle'}; voice ${ok ? 'ok' : 'FAILED'} ${voiceMs} ms; health ${h.ok ? 'ok' : 'DOWN'}`);
    if (!h.ok) break;
  }
  const ab = rows.filter((r) => r.aborted);
  out.aborts = {
    rounds: rows.length,
    aborted: ab.length,
    voiceFailed: rows.filter((r) => !r.voiceOk).length,
    voiceP50: pct(ab.map((r) => r.voiceMs), 50),
    voiceP95: pct(ab.map((r) => r.voiceMs), 95),
    slot1StillBusy: ab.filter((r) => r.stillBusyMs !== 0).length,
    unhealthy: rows.filter((r) => !r.healthy).length,
    rows,
  };

  // 2. Pairs: a voice and a broodlord request together, outside the lock.
  const pairs: { voiceMs: number; broodMs: number; ok: boolean }[] = [];
  for (let i = 0; i < Number(args.pairs); i++) {
    const f = situations[(i * 5 + 3) % situations.length].field;
    const t0 = performance.now();
    const raw = (body: unknown) => fetch(`${url}/completion`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }).then((r) => r.ok);
    const [v, b] = await Promise.allSettled([
      ask({ ...voice, user: 'voice' }, field, SAID[i % SAID.length]).then(() => performance.now() - t0),
      // the second request bypasses this process's lock, as a second tab would
      (async () => {
        const tpl = await fetch(`${url}/apply-template`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'system', content: prefix }, { role: 'user', content: '\u0001' }], chat_template_kwargs: { reasoning_strength: 'low' } }) }).then((r) => r.json());
        const [before, after] = (tpl.prompt as string).split('\u0001');
        await raw({ prompt: before + broodTurn(f) + after + ' to=user<|message|>', grammar: broodGrammar(f), n_predict: MAX_TOKENS, temperature: 0, cache_prompt: true, id_slot: 1 });
        return performance.now() - t0;
      })(),
    ]);
    const ok = v.status === 'fulfilled' && b.status === 'fulfilled';
    pairs.push({ voiceMs: v.status === 'fulfilled' ? Math.round(v.value) : -1, broodMs: b.status === 'fulfilled' ? Math.round(b.value) : -1, ok });
    const h = await health();
    console.log(`pair ${i + 1}: voice ${pairs[i].voiceMs} ms, broodlord ${pairs[i].broodMs} ms, ${ok ? 'ok' : 'FAILED'}; health ${h.ok ? 'ok' : 'DOWN'}`);
    if (!h.ok) break;
  }
  out.pairs = { rounds: pairs.length, failed: pairs.filter((p) => !p.ok).length, voiceP50: pct(pairs.map((p) => p.voiceMs), 50), broodP50: pct(pairs.map((p) => p.broodMs), 50), rows: pairs };

  // 3. Same slot: two voice requests together on slot 0 (outside the lock).
  const same: { ok: boolean; ms: number }[] = [];
  for (let i = 0; i < Number(args.same); i++) {
    const t0 = performance.now();
    const body = (said: string) => ({ prompt: `NOTE ${Date.now()} ${said}`, n_predict: 32, temperature: 0, cache_prompt: true, id_slot: 0 });
    // a pair of 32-token answers takes ~5 s; 20 s without an answer is a hung slot
    const go = (s: string) => fetch(`${url}/completion`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(s)), signal: AbortSignal.timeout(20_000) }).then((r) => r.ok);
    const r = await Promise.allSettled([go(SAID[0]), go(SAID[1])]);
    const ok = r.every((x) => x.status === 'fulfilled' && x.value);
    same.push({ ok, ms: Math.round(performance.now() - t0) });
    const h = await health();
    console.log(`same slot ${i + 1}: ${ok ? 'ok' : 'FAILED'} ${same[i].ms} ms; health ${h.ok ? 'ok' : 'DOWN'}; slots ${JSON.stringify(h.slots)}`);
    if (!h.ok || !ok) break;
  }
  out.same = { rounds: same.length, failed: same.filter((s) => !s.ok).length, rows: same };

  // 3b. The broodlord's warm (a read for nothing) aborted by the voice's claim 200–1000 ms in, then at once the
  // broodlord's next call on the same slot, through the page's own code (brain.ts settles the slot first).
  const rewarm: { gap: number; ok: boolean; ms: number }[] = [];
  for (let i = 0; i < Number(args.rewarm); i++) {
    const f = situations[(i * 3 + 2) % situations.length].field;
    const gap = 200 + Math.round((i * 271) % 801);
    const long = broodTurn({ ...f, ours: f.ours.map((c) => ({ ...c, x: c.x + i + 1 })) }) + '\n' + 'The blight stirs. '.repeat(120);
    const warmCall = complete(brood, prefix, long, '', 0).catch((e) => e);
    await sleep(gap);
    const release = brainLock.claim();
    await warmCall;
    release();
    const t0 = performance.now();
    let ok = true;
    try {
      await complete({ ...brood, timeoutMs: 30_000 }, prefix, broodTurn(f), broodGrammar(f), MAX_TOKENS);
    } catch {
      ok = false;
    }
    rewarm.push({ gap, ok, ms: Math.round(performance.now() - t0) });
    const h = await health();
    console.log(`rewarm ${i + 1}: warm aborted after ${gap} ms, next call ${ok ? 'ok' : 'FAILED'} ${rewarm[i].ms} ms; health ${h.ok ? 'ok' : 'DOWN'}; slots ${JSON.stringify(h.slots)}`);
    if (!h.ok || !ok) break;
  }
  out.rewarm = { rounds: rewarm.length, failed: rewarm.filter((r) => !r.ok).length, msP50: pct(rewarm.map((r) => r.ms), 50), rows: rewarm };

  // 4. Staggered on one slot: a voice order on slot 0, and a second one 200–1500 ms later while the first is still
  // reading or writing (the day-4 crash and hang: two warms 1 s apart; a tab warming while another ordered).
  const stagger: { gap: number; ok: boolean; ms: number }[] = [];
  if (Number(args.stagger) > 0) {
    const tpl = await fetch(`${url}/apply-template`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'system', content: PREFIX }, { role: 'user', content: '\u0001' }], chat_template_kwargs: { reasoning_strength: 'low' } }) }).then((r) => r.json());
    const [before, after] = (tpl.prompt as string).split('\u0001');
    for (let i = 0; i < Number(args.stagger); i++) {
      const gap = 200 + Math.round((i * 389) % 1301);
      const order = (said: string, warm = false, slot = 0) =>
        fetch(`${url}/completion`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // a field moved by a few tiles each time, so the slot reads some 100 new tokens, as in play
          body: JSON.stringify(
            warm
              ? { prompt: before + userTurn({ ...field, captain: { ...field.captain, x: field.captain.x + i + 50 } }, ''), n_predict: 0, cache_prompt: true, id_slot: slot }
              : { prompt: before + userTurn({ ...field, captain: { ...field.captain, x: field.captain.x + i } }, said) + after + ' to=user<|message|>', grammar: orderGrammar(field, said), n_predict: 64, temperature: 0, cache_prompt: true, id_slot: slot },
          ),
          signal: AbortSignal.timeout(30_000),
        }).then((r) => r.ok);
      const t0 = performance.now();
      const a = order(SAID[i % SAID.length], args.warmfirst, Number(args.firstslot));
      await sleep(gap);
      const b = order(SAID[(i + 1) % SAID.length]);
      const r = await Promise.allSettled([a, b]);
      const ok = r.every((x) => x.status === 'fulfilled' && x.value);
      stagger.push({ gap, ok, ms: Math.round(performance.now() - t0) });
      const h = await health();
      console.log(`stagger ${i + 1}: second after ${gap} ms: ${ok ? 'ok' : 'FAILED'} ${stagger[i].ms} ms; health ${h.ok ? 'ok' : 'DOWN'}; slots ${JSON.stringify(h.slots)}`);
      if (!h.ok || !ok) break;
    }
  }
  out.stagger = { rounds: stagger.length, failed: stagger.filter((s) => !s.ok).length, rows: stagger };
  out.healthAtEnd = await health();
  out.lock = brainLock.stats;
  console.log(JSON.stringify({ base: { ...(out.base as object), rows: undefined }, idle: { ...(out.idle as object), rows: undefined }, aborts: { ...(out.aborts as object), rows: undefined }, pairs: { ...(out.pairs as object), rows: undefined }, same: { ...(out.same as object), rows: undefined }, stagger: { ...(out.stagger as object), rows: undefined }, rewarm: { ...(out.rewarm as object), rows: undefined }, healthAtEnd: out.healthAtEnd }, null, 1));
  mkdirSync(new URL('../../out/voice-eval/', import.meta.url), { recursive: true });
  writeFileSync(new URL(`../../out/voice-eval/${args.label}.json`, import.meta.url), JSON.stringify(out, null, 2));
  console.log(`log: out/voice-eval/${args.label}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
