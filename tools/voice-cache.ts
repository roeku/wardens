// The brain's replies, cached by hash(prompt prefix + field state + words) (docs/spec/06-voice.md §7), so `say`
// and the eval replay without a GPU, and a resolution change can be re-judged on the very same replies.
// Kept in out/voice-cache.json; `--live` refreshes an entry.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ask, type BrainOpts } from '../web/src/voice/brain.ts';
import { stateText, type Field } from '../web/src/voice/field.ts';
import { replyOf } from '../web/src/voice/orders.ts';
import type { BrainAnswer } from '../web/src/voice/pipeline.ts';
import { PREFIX } from '../web/src/voice/prompt.ts';

const FILE = new URL('../out/voice-cache.json', import.meta.url);

interface Entry {
  raw: string;
  ms: number;
  promptTokens: number;
  cachedTokens: number;
  genTokens: number;
  said: string;
  at: string;
}

export class ReplyCache {
  private entries: Record<string, Entry> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};

  key(o: BrainOpts, field: Field, heard: string): string {
    return createHash('sha256').update(JSON.stringify([o.mode, o.temperature, PREFIX, stateText(field), heard])).digest('hex').slice(0, 20);
  }

  get(o: BrainOpts, field: Field, heard: string): BrainAnswer | undefined {
    const e = this.entries[this.key(o, field, heard)];
    return e && { reply: replyOf(JSON.parse(e.raw)), raw: e.raw, ms: e.ms, promptTokens: e.promptTokens, cachedTokens: e.cachedTokens, genTokens: e.genTokens, from: 'cache' };
  }

  put(o: BrainOpts, field: Field, heard: string, a: BrainAnswer): void {
    this.entries[this.key(o, field, heard)] = {
      raw: a.raw, ms: Math.round(a.ms), promptTokens: a.promptTokens ?? 0, cachedTokens: a.cachedTokens ?? 0, genTokens: a.genTokens ?? 0, said: heard, at: new Date().toISOString(),
    };
  }

  save(): void {
    mkdirSync(new URL('./', FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(this.entries, null, 1));
  }
}

/**
 * The brain for the pipeline: `live` always asks the server (and refreshes the cache), `cached` answers only from
 * the cache, `prefer-cache` asks the server only for words it has not seen.
 */
export function brainFor(o: BrainOpts, field: Field, cache: ReplyCache, use: 'live' | 'cached' | 'prefer-cache', nonce = () => ''): (heard: string) => Promise<BrainAnswer> {
  return async (heard) => {
    if (use !== 'live') {
      const hit = cache.get(o, field, heard);
      if (hit) return hit;
      if (use === 'cached') throw new Error(`no cached reply for "${heard}" on this field and prompt; run with --live`);
    }
    const r = await ask(o, field, heard, nonce());
    const a: BrainAnswer = { ...r, from: 'live' };
    if (!nonce()) cache.put(o, field, heard, a);
    return a;
  };
}
