// The brain's reply, the fast path that answers common words without it (docs/spec/06-voice.md §5), and the
// name canonicalising both use. Pure.

import { KIND_WORDS, type Field } from './field.ts';
import { sounds } from './normalise.ts';

export type Do = 'move' | 'attack' | 'take' | 'front' | 'hold' | 'recall' | 'rally';
export type Side = 'none' | 'left' | 'right' | 'front' | 'back';

export interface ModelOrder {
  who: string[];
  do: Do;
  target: string;
  side: Side;
  fight: boolean;
}

export interface Reply {
  orders: ModelOrder[];
  unclear: boolean;
}

/** Spoken kind words and the schema's kind enums. */
const KIND_SYNONYMS: Record<string, string> = {
  horse: 'HORSE', horses: 'HORSE', rider: 'HORSE', riders: 'HORSE', cavalry: 'HORSE', horsemen: 'HORSE',
  archer: 'ARCHER', archers: 'ARCHER', bow: 'ARCHER', bows: 'ARCHER', bowmen: 'ARCHER',
  spear: 'SPEAR', spears: 'SPEAR', pike: 'SPEAR', pikes: 'SPEAR', pikemen: 'SPEAR',
  shield: 'SHIELD', shields: 'SHIELD',
};

/** Common words that must never be heard as a name, even when they sound like one (WIL / "will"). */
const NOT_NAMES = new Set(['will', 'well', 'wall', 'hold', 'march', 'rally', 'back', 'all', 'old', 'run', 'ran', 'bars', 'boss', 'odd', 'rain', 'ford', 'mill']);

const RALLY = new Set(['rally', 'to me', 'on me', 'everyone to me', 'follow me']);
const HOLD = new Set(['hold', 'halt', 'stop', 'stand', 'hold position']);
const BACK = new Set(['come back', 'back', 'return', 'back to me', 'to me']);
const ALL_BACK = new Set(['everyone back', 'all back']);
const CHARGE = new Set(['charge', 'attack']);

/** The company name a spoken word stands for, if any. */
export function nameFor(word: string, f: Field): string | undefined {
  if (NOT_NAMES.has(word)) return undefined;
  return f.ours.find((c) => sounds(word, c.name))?.name;
}

/** Spoken company names replaced by their exact names, so "boris" reaches the brain as BORS. */
export function canonicalNames(norm: string, f: Field): string {
  return norm
    .split(' ')
    .map((w) => nameFor(w, f) ?? w)
    .join(' ');
}

function who(words: string[], f: Field): string[] | undefined {
  const out: string[] = [];
  for (const w of words) {
    const name = KIND_SYNONYMS[w] ?? nameFor(w, f);
    if (name) out.push(name);
    else if (!['the', 'and'].includes(w)) return undefined;
  }
  return out.length ? out : undefined;
}

const order = (who: string[], d: Do, target = 'NONE', fight = false): ModelOrder => ({ who, do: d, target, side: 'none', fight });

/** Whole-utterance patterns that skip the model. `pause` is returned on its own. */
export function fastPath(norm: string, f: Field): Reply | 'pause' | undefined {
  if (norm === 'pause') return 'pause';
  if (RALLY.has(norm)) return { orders: [order(['ARMY'], 'rally')], unclear: false };
  if (HOLD.has(norm)) return { orders: [order(['ARMY'], 'hold')], unclear: false };
  if (ALL_BACK.has(norm)) return { orders: [order(['ARMY'], 'recall')], unclear: false };
  if (CHARGE.has(norm)) {
    const near = nearestFoe(f, f.captain);
    return near ? { orders: [order(['ARMY'], 'attack', near.id, true)], unclear: false } : undefined;
  }
  const words = norm.split(' ');
  for (let k = 1; k < words.length; k++) {
    if (!BACK.has(words.slice(k).join(' '))) continue;
    const names = who(words.slice(0, k), f);
    if (names) return { orders: [order(names, 'recall')], unclear: false };
  }
  return undefined;
}

export function nearestFoe(f: Field, at: { x: number; y: number }) {
  let best: Field['foesSeen'][number] | undefined;
  let bestD = Infinity;
  for (const e of f.foesSeen) {
    const d = Math.hypot(e.x - at.x, e.y - at.y);
    if (d < bestD) [best, bestD] = [e, d];
  }
  return best;
}

export { KIND_WORDS };
