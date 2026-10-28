// The brain client (docs/spec/06-voice.md §2). Two modes:
// - prefill (llama.cpp): the chat template rendered once, the answer turn opened as `to=user` so Glimmer
//   writes the JSON at once instead of thinking first, and a whitespace-free grammar (DECISIONS.md D-03, D-07);
// - chat: the OpenAI-compatible /v1/chat/completions with response_format = the per-battle schema.
// Uses fetch only, so the same code runs in the browser and in Node.

import { orderGrammar, orderSchema, type Field } from './field.ts';
import { replyOf, type Reply } from './orders.ts';
import { PREFIX, userTurn } from './prompt.ts';

export type BrainMode = 'prefill' | 'chat';

export interface BrainOpts {
  url: string;
  mode: BrainMode;
  temperature: number;
  /** The server slot for voice; the broodlord uses the other (§8). */
  slot: number;
  /** Abandon a request after this many ms (§2: 2.5 s in play). */
  timeoutMs: number;
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
  const res = await fetch(o.url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(o.timeoutMs),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** The rendered chat template around the user turn, fetched once per server. */
async function template(o: BrainOpts): Promise<[string, string]> {
  const cached = templates.get(o.url);
  if (cached) return cached;
  const messages = [
    { role: 'system', content: PREFIX },
    { role: 'user', content: SENTINEL },
  ];
  const { prompt } = await post(o, '/apply-template', { messages, chat_template_kwargs: TEMPLATE_KWARGS });
  const [before, after] = (prompt as string).split(SENTINEL);
  const parts: [string, string] = [before, after];
  templates.set(o.url, parts);
  return parts;
}

/** Reads the field into the voice slot's cache while the captain is still speaking, so only the words remain. */
export async function warm(o: BrainOpts, field: Field): Promise<void> {
  if (o.mode !== 'prefill') return;
  const [before] = await template(o);
  const turn = userTurn(field, '');
  await post(o, '/completion', { prompt: before + turn, n_predict: 0, cache_prompt: true, id_slot: o.slot });
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
