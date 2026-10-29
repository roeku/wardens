// The brain client (docs/spec/06-voice.md §2). Two modes:
// - prefill (llama.cpp): the chat template rendered once, the answer turn opened as `to=user` so Glimmer
//   writes the JSON at once instead of thinking first, and a whitespace-free grammar (DECISIONS.md D-03, D-07);
// - chat: the OpenAI-compatible /v1/chat/completions with response_format = the per-battle schema.
// Uses fetch only, so the same code runs in the browser and in Node.
//
// Every request goes through one lock (`brainLock`), so a page never has two requests at the brain server at once:
// llama-server with the DFlash drafter crashed and hung when two arrived together (D-20 "brain stability"). Voice
// has priority over the broodlord (06-voice.md §8): while the captain holds to talk, or a voice request runs or
// waits, the broodlord's request in flight is aborted and new ones are refused at once.

import { orderGrammar, orderSchema, type Field } from './field.ts';
import { replyOf, type Reply } from './orders.ts';
import { PREFIX, userTurn } from './prompt.ts';

export type BrainMode = 'prefill' | 'chat';
/** Who asks: the captain's voice, or the enemy broodlord (06-voice.md §8). */
export type BrainUser = 'voice' | 'broodlord';

export interface BrainOpts {
  url: string;
  mode: BrainMode;
  temperature: number;
  /** The server slot for voice; the broodlord uses the other (§8). */
  slot: number;
  /** Abandon a request after this many ms (§2: 2.5 s in play), counted from when it holds the lock. */
  timeoutMs: number;
  /** Whose request it is (voice when absent). */
  user?: BrainUser;
  /** Aborts the request from outside. */
  signal?: AbortSignal;
}

/** A broodlord request refused or dropped because voice has the brain. */
export class BrainBusy extends Error {
  readonly why: string;
  constructor(why: string) {
    super(`the brain is busy: ${why}`);
    this.why = why;
  }
}

/** What the lock has seen, for the measurements (D5 broodlord). */
export interface LockStats {
  /** Requests run, by user. */
  voice: number;
  broodlord: number;
  /** Voice requests that had to wait for a broodlord request (running or queued ahead), and how long each waited. */
  voiceWaited: number;
  voiceWaitMs: number[];
  /** Broodlord requests aborted because voice wanted the brain. */
  aborted: number;
  /** Broodlord requests refused at once, or dropped from the queue, because voice had the brain. */
  refused: number;
  /** The most requests the page ever had at the server at once (must stay 1). */
  maxInFlight: number;
}

/** The page's one line to the brain server: one request at a time, voice first. */
export class BrainLock {
  private tail: Promise<unknown> = Promise.resolve();
  private current: { user: BrainUser; ctl: AbortController } | null = null;
  private queued: BrainUser[] = [];
  private claims = 0;
  private inFlight = 0;
  readonly stats: LockStats = { voice: 0, broodlord: 0, voiceWaited: 0, voiceWaitMs: [], aborted: 0, refused: 0, maxInFlight: 0 };

  /** A request runs or waits. */
  get busy(): boolean {
    return this.current !== null || this.queued.length > 0;
  }

  /** The captain holds to talk, or a voice request runs or waits. */
  get voiceActive(): boolean {
    return this.claims > 0 || this.current?.user === 'voice' || this.queued.includes('voice');
  }

  /** Who holds the lock now. */
  get holder(): BrainUser | null {
    return this.current?.user ?? null;
  }

  /** The voice will need the brain (the captain starts to hold): the broodlord's request is aborted, and none starts
   * until the returned release is called. */
  claim(): () => void {
    this.claims++;
    this.abortBroodlord();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.claims--;
    };
  }

  private abortBroodlord(): void {
    if (this.current?.user !== 'broodlord' || this.current.ctl.signal.aborted) return;
    this.current.ctl.abort(new DOMException('voice has priority', 'AbortError'));
    this.stats.aborted++;
  }

  /** Runs `f` holding the lock; `signal` aborts it (only a broodlord request is ever aborted by the lock). */
  run<T>(user: BrainUser, f: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (user === 'broodlord' && this.voiceActive) {
      this.stats.refused++;
      return Promise.reject(new BrainBusy('voice has it'));
    }
    const behindBroodlord = user === 'voice' && (this.current?.user === 'broodlord' || this.queued.includes('broodlord'));
    if (user === 'voice') this.abortBroodlord();
    this.queued.push(user);
    const t0 = performance.now();
    const go = async (): Promise<T> => {
      this.queued.splice(this.queued.indexOf(user), 1);
      if (user === 'broodlord' && this.voiceActive) {
        this.stats.refused++;
        throw new BrainBusy('voice came first');
      }
      if (user === 'voice' && behindBroodlord) {
        this.stats.voiceWaited++;
        this.stats.voiceWaitMs.push(Math.round(performance.now() - t0));
      }
      const ctl = new AbortController();
      this.current = { user, ctl };
      this.stats[user]++;
      this.inFlight++;
      this.stats.maxInFlight = Math.max(this.stats.maxInFlight, this.inFlight);
      try {
        return await f(ctl.signal);
      } finally {
        this.inFlight--;
        this.current = null;
      }
    };
    const run = this.tail.then(go, go);
    this.tail = run.catch(() => {});
    return run;
  }
}

/** The page's lock: every request to the brain server goes through it. */
export const brainLock = new BrainLock();

/** Slots (`url#slot`) the page gave up a request on, which the server may still be working on. */
const unsettled = new Set<string>();
/** How long a request waits for such a slot to come free, and how often it looks. */
const SETTLE_MS = 20_000;
const SETTLE_POLL_MS = 100;

/**
 * Waits until the server has finished with a request this page abandoned on the slot (aborted, or timed out),
 * before sending it another. llama-server goes on with an abandoned request (to its end, or to its next streamed
 * token), and with the DFlash drafter a request queued on a slot that is still reading a prompt for nothing
 * (`n_predict` 0, a warm) hangs the slot for good (reproduced 3 of 3; 0 of 12 without the drafter; D-20).
 */
async function settle(o: BrainOpts, lock: AbortSignal): Promise<void> {
  const key = `${o.url}#${o.slot}`;
  if (!unsettled.has(key)) return;
  const t0 = performance.now();
  while (performance.now() - t0 < SETTLE_MS) {
    lock.throwIfAborted();
    let busy = false;
    try {
      const slots = (await (await fetch(o.url + '/slots', { signal: AbortSignal.timeout(1000) })).json()) as { id: number; is_processing: boolean }[];
      busy = !!slots.find((x) => x.id === o.slot)?.is_processing;
    } catch {
      busy = false; // no /slots (a hosted server): nothing to wait for
    }
    if (!busy) {
      unsettled.delete(key);
      return;
    }
    await new Promise((ok) => setTimeout(ok, SETTLE_POLL_MS));
  }
  throw new Error(`slot ${o.slot} still busy ${SETTLE_MS} ms after a request was given up`);
}

/** Marks the slot unsettled when the page gives up a request on it. */
function abandoned(o: BrainOpts, e: unknown): void {
  if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')) unsettled.add(`${o.url}#${o.slot}`);
}

export interface BrainResult {
  reply: Reply;
  raw: string;
  ms: number;
  promptTokens: number;
  cachedTokens: number;
  genTokens: number;
}

const ANSWER_TURN = ' to=user<|message|>';
const SENTINEL = '\u0001USER\u0001';
const MAX_TOKENS = 200;
const TEMPLATE_KWARGS = { reasoning_strength: 'low' };

const templates = new Map<string, [string, string]>();

async function post(o: BrainOpts, path: string, body: unknown): Promise<any> {
  return brainLock.run(o.user ?? 'voice', async (lock) => {
    const slotted = path === '/completion';
    if (slotted) await settle(o, lock);
    const signals = [AbortSignal.timeout(o.timeoutMs), lock];
    if (o.signal) signals.push(o.signal);
    try {
      const res = await fetch(o.url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return await res.json();
    } catch (e) {
      if (slotted) abandoned(o, e);
      throw e;
    }
  });
}

/** The rendered chat template around the user turn, fetched once per server and system prompt. */
async function template(o: BrainOpts, system = PREFIX): Promise<[string, string]> {
  const key = `${o.url}\u0000${system}`;
  const cached = templates.get(key);
  if (cached) return cached;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: SENTINEL },
  ];
  const { prompt } = await post(o, '/apply-template', { messages, chat_template_kwargs: TEMPLATE_KWARGS });
  const [before, after] = (prompt as string).split(SENTINEL);
  const parts: [string, string] = [before, after];
  templates.set(key, parts);
  return parts;
}

/** Reads the field into the voice slot's cache while the captain is still speaking, so only the words remain. */
export async function warm(o: BrainOpts, field: Field): Promise<void> {
  if (o.mode !== 'prefill') return;
  const [before] = await template(o);
  const turn = userTurn(field, '');
  await post(o, '/completion', { prompt: before + turn, n_predict: 0, cache_prompt: true, id_slot: o.slot });
}

/**
 * A prefilled completion under another system prompt and grammar (the broodlord's, 06-voice.md §8): the raw reply
 * and the server's timings. `turn` is the user turn; with `maxTokens` 0 it only reads the prompt into the slot.
 * Streamed, so an abort reaches the server: llama-server drops a streamed request at its next token when the client
 * has gone, but finishes a plain one to the end (measured: 14–17 s of work left after an abort, against 2.4–3.5 s
 * streamed, the rest of the prompt it was reading).
 */
export async function complete(
  o: BrainOpts,
  system: string,
  turn: string,
  grammar: string,
  maxTokens: number,
): Promise<{ raw: string; ms: number; promptTokens: number; cachedTokens: number; genTokens: number }> {
  const t0 = performance.now();
  const [before, after] = await template(o, system);
  const prompt = maxTokens > 0 ? before + turn + after + ANSWER_TURN : before + turn;
  const body = { prompt, ...(maxTokens > 0 ? { grammar } : {}), n_predict: maxTokens, temperature: o.temperature, cache_prompt: true, id_slot: o.slot, stream: true };
  const r = await brainLock.run(o.user ?? 'voice', async (lock) => {
    await settle(o, lock);
    const signals = [AbortSignal.timeout(o.timeoutMs), lock];
    if (o.signal) signals.push(o.signal);
    try {
      const res = await fetch(o.url + '/completion', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any(signals) });
      if (!res.ok || !res.body) throw new Error(`/completion: ${res.status} ${await res.text()}`);
      return await readStream(res.body);
    } catch (e) {
      abandoned(o, e);
      throw e;
    }
  });
  const t: { prompt_n?: number; cache_n?: number; predicted_n?: number } = r.timings ?? {};
  return { raw: r.content, ms: performance.now() - t0, promptTokens: t.prompt_n ?? 0, cachedTokens: t.cache_n ?? 0, genTokens: t.predicted_n ?? 0 };
}

/** A llama-server stream (server-sent events, `data: {content, stop, timings}`) read to its end. */
async function readStream(stream: ReadableStream<Uint8Array>): Promise<{ content: string; timings?: Record<string, number> }> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let timings: Record<string, number> | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let at: number;
    while ((at = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, at).trim();
      buf = buf.slice(at + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      const ev = JSON.parse(data) as { content?: string; stop?: boolean; timings?: Record<string, number> };
      content += ev.content ?? '';
      if (ev.timings) timings = ev.timings;
    }
    if (done) break;
  }
  return { content, timings };
}

export async function ask(o: BrainOpts, field: Field, said: string, nonce = ''): Promise<BrainResult> {
  const turn = nonce + userTurn(field, said);
  const t0 = performance.now();
  let raw: string;
  let timings: { prompt_n?: number; cache_n?: number; predicted_n?: number } = {};
  if (o.mode === 'prefill') {
    const [before, after] = await template(o);
    const r = await post(o, '/completion', {
      prompt: before + turn + after + ANSWER_TURN,
      // The said words go into the grammar, so a group can only be named by a word the captain spoke.
      grammar: orderGrammar(field, said),
      n_predict: MAX_TOKENS,
      temperature: o.temperature,
      cache_prompt: true,
      id_slot: o.slot,
    });
    raw = r.content;
    timings = r.timings ?? {};
  } else {
    const r = await post(o, '/v1/chat/completions', {
      messages: [
        { role: 'system', content: PREFIX },
        { role: 'user', content: turn },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'orders', schema: orderSchema(field, said) } },
      chat_template_kwargs: TEMPLATE_KWARGS,
      temperature: o.temperature,
      max_tokens: 2048,
    });
    raw = r.choices[0].message.content;
    timings = r.timings ?? {};
  }
  const ms = performance.now() - t0;
  return {
    reply: replyOf(JSON.parse(raw)),
    raw,
    ms,
    promptTokens: timings.prompt_n ?? 0,
    cachedTokens: timings.cache_n ?? 0,
    genTokens: timings.predicted_n ?? 0,
  };
}
