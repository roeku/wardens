// The voice pipeline as one call (docs/spec/06-voice.md §1, 08-orders.md §9): normalise → fast path → brain →
// resolve. Voice, typed orders, `say` and the eval all go through it, so what is measured is what ships.

import type { Field } from './field.ts';
import { normalise } from './normalise.ts';
import { canonicalNames, fastPath, type Reply } from './orders.ts';
import { resolve, type Resolution } from './resolve.ts';

/** What the brain gave for the words, however it was reached (live, cached or replayed). */
export interface BrainAnswer {
  reply: Reply;
  raw: string;
  ms: number;
  promptTokens?: number;
  cachedTokens?: number;
  genTokens?: number;
  /** Where the answer came from: 'live' or 'cache'. */
  from?: string;
}

export interface Understood {
  said: string;
  norm: string;
  /** The words as the brain reads them, names made exact. */
  heard: string;
  path: 'fast' | 'brain' | 'pause';
  reply: Reply;
  brain?: BrainAnswer;
  resolution: Resolution;
  /** End to end, and the resolve step alone. */
  ms: number;
  resolveMs: number;
}

/** `ask` is the brain: absent means fast path only (`?brain=off`). */
export async function understand(field: Field, said: string, ask?: (heard: string) => Promise<BrainAnswer>): Promise<Understood> {
  const t0 = performance.now();
  const norm = normalise(said);
  const heard = canonicalNames(norm, field);
  const fast = fastPath(norm, field);
  let path: Understood['path'];
  let reply: Reply;
  let brain: BrainAnswer | undefined;
  if (fast === 'pause') [path, reply] = ['pause', { orders: [], unclear: false }];
  else if (fast) [path, reply] = ['fast', fast];
  else if (ask) {
    brain = await ask(heard);
    [path, reply] = ['brain', brain.reply];
  } else [path, reply] = ['brain', { orders: [], unclear: true }];
  const t1 = performance.now();
  const resolution = resolve(reply, field);
  const t2 = performance.now();
  return { said, norm, heard, path, reply, brain, resolution, ms: t2 - t0, resolveMs: t2 - t1 };
}
