// The brain's reply, the fast path that answers common words without it (docs/spec/06-voice.md §5,
// 08-orders.md §9), and the name canonicalising both use. Pure.

import { KIND_WORDS, seenFoeKinds, type Field } from './field.ts';
import { sounds } from './normalise.ts';

export type Do =
  | 'move' | 'hold' | 'take' | 'attack' | 'charge' | 'front' | 'recall' | 'rally' | 'guard' | 'screen' | 'withdraw'
  | 'regroup' | 'reserve' | 'commit' | 'face' | 'advance' | 'signal' | 'build' | 'set' | 'name';
export type Side = 'none' | 'left' | 'right' | 'front' | 'back';

/** One order as the model writes it (08-orders §2–§7). Only `who` and `do` are always there. */
export interface ModelOrder {
  who: string[];
  do: Do;
  to?: string;
  rel?: 'behind' | 'front' | 'across' | 'beside' | 'between' | 'left' | 'right';
  and?: string;
  from?: string;
  round?: Exclude<Side, 'none'>;
  by?: string;
  work?: 'stakes' | 'barricade' | 'bridge' | 'watchtower';
  as?: string;
  stance?: 'aggressive' | 'defensive' | 'hold_fire' | 'fire_at_will' | 'skirmish' | 'chase' | 'no_chase';
  shape?: 'line' | 'column' | 'wedge' | 'square' | 'shield_wall' | 'loose' | 'tight' | 'thin' | 'deep';
  pace?: 'walk' | 'quick' | 'double';
  fight?: boolean;
  /** done | mark | attacked | night | dawn | after:N | near:X | breaks:X */
  when?: string;
  /** Day 1 replies (docs/voice-eval/schema.json) named the target and route this way. */
  target?: string;
  side?: Side;
}

export interface Reply {
  orders: ModelOrder[];
  /** No orders: the words did not say what to do. */
  unclear: boolean;
}

/** The model's raw array as a Reply. A Day 1 object reply ({orders, unclear}) is read as well. */
export function replyOf(raw: unknown): Reply {
  if (Array.isArray(raw)) return { orders: raw as ModelOrder[], unclear: raw.length === 0 };
  const r = raw as Reply;
  return { orders: r.orders ?? [], unclear: !!r.unclear || !(r.orders ?? []).length };
}

/** Spoken kind words and the schema's kind enums. */
const KIND_SYNONYMS: Record<string, string> = {
  horse: 'HORSE', horses: 'HORSE', rider: 'HORSE', riders: 'HORSE', cavalry: 'HORSE', horsemen: 'HORSE',
  archer: 'ARCHER', archers: 'ARCHER', bow: 'ARCHER', bows: 'ARCHER', bowmen: 'ARCHER',
  spear: 'SPEAR', spears: 'SPEAR', pike: 'SPEAR', pikes: 'SPEAR', pikemen: 'SPEAR',
  shield: 'SHIELD', shields: 'SHIELD',
  levy: 'LEVY', levies: 'LEVY', militia: 'LEVY',
};
const ARMY_WORDS = new Set(['everyone', 'everybody', 'all', 'army']);

/** Common words that must never be heard as a name, even when they sound like one (WIL / "will", REN / "men"). */
const NOT_NAMES = new Set([
  'will', 'well', 'wall', 'fill', 'hold', 'march', 'rally', 'back', 'all', 'old', 'run', 'ran', 'bars', 'boss', 'boys',
  'odd', 'rain', 'ford', 'mill', 'men', 'ten', 'then', 'when', 'tell', 'yell', 'rest',
]);

const RALLY = new Set(['rally', 'to me', 'on me', 'everyone to me', 'follow me']);
const HOLD = new Set(['hold', 'halt', 'stop', 'stand', 'hold position']);
/** "<who> stop": a company, a kind or a group halts where it is (08-orders §9). */
const STOP = new Set(['stop', 'halt', 'hold', 'stand', 'hold position', 'stand fast', 'hold there', 'stay there']);
const BACK = new Set(['come back', 'back', 'return', 'back to me', 'to me']);
const ALL_BACK = new Set(['everyone back', 'all back']);
const CHARGE = new Set(['charge', 'attack']);
/** Words that release waiting orders when any are waiting (08-orders §6 "signals"). */
const SIGNAL = new Set(['now', 'go', 'loose', 'charge', 'go go go', 'now now', 'go go', 'now go', 'go now', 'fire']);
const HOLD_FIRE = new Set(['hold fire', 'hold your fire', 'cease fire', 'stop shooting']);
const FIRE_AT_WILL = new Set(['fire at will', 'loose at will', 'open fire', 'shoot at will']);

/** The company name a spoken word stands for, if any. */
export function nameFor(word: string, f: Field): string | undefined {
  // A kind word is never a name: "bows" is the archers, not BORS (one letter away).
  if (NOT_NAMES.has(word) || KIND_SYNONYMS[word] || ARMY_WORDS.has(word)) return undefined;
  return f.ours.find((c) => c.name.toLowerCase() === word)?.name ?? f.ours.find((c) => sounds(word, c.name))?.name;
}

/** Other words for the blight's kinds (06-voice §4a), as the field names them. */
const FOE_SYNONYMS: Record<string, [string, string]> = {
  dragon: ['DRAKES', 'drakes'], dragons: ['DRAKES', 'drakes'], wyrm: ['DRAKES', 'drakes'], wyrms: ['DRAKES', 'drakes'],
  giant: ['TROLLS', 'trolls'], giants: ['TROLLS', 'trolls'],
};

/**
 * Spoken company names replaced by their exact names, so "boris" reaches the brain as BORS, and other words for a
 * seen foe kind by the field's own word, so "the dragon" reaches it as "the drakes".
 */
export function canonicalNames(norm: string, f: Field): string {
  const seen = new Set(seenFoeKinds(f));
  return norm
    .split(' ')
    .map((w) => nameFor(w, f) ?? (FOE_SYNONYMS[w] && seen.has(FOE_SYNONYMS[w][0]) ? FOE_SYNONYMS[w][1] : w))
    .join(' ');
}

/** Selector words as the schema's names: company names, kinds, groups and "everyone". */
function who(words: string[], f: Field): string[] | undefined {
  const out: string[] = [];
  for (const w of words) {
    const group = f.groups?.find((g) => g.name.toLowerCase() === w)?.name;
    const name = ARMY_WORDS.has(w) ? 'ARMY' : (KIND_SYNONYMS[w] ?? group ?? nameFor(w, f));
    if (name) out.push(name);
    else if (!['the', 'and', 'you', 'lads'].includes(w)) return undefined;
  }
  return out.length ? out : undefined;
}

const order = (who: string[], d: Do, extra: Partial<ModelOrder> = {}): ModelOrder => ({ who, do: d, ...extra });
const reply = (...orders: ModelOrder[]): Reply => ({ orders, unclear: false });

/** Whole-utterance patterns that skip the model. `pause` is returned on its own. */
export function fastPath(norm: string, f: Field): Reply | 'pause' | undefined {
  if (norm === 'pause') return 'pause';
  const waiting = (f.waiting ?? []).length > 0;
  // Signals first: "now", "go", "loose", and "charge" while orders wait for one.
  if (waiting && SIGNAL.has(norm)) return reply(order(['ARMY'], 'signal'));
  if (RALLY.has(norm)) return reply(order(['ARMY'], 'rally'));
  if (HOLD.has(norm)) return reply(order(['ARMY'], 'hold'));
  if (ALL_BACK.has(norm)) return reply(order(['ARMY'], 'recall'));
  if (HOLD_FIRE.has(norm)) return reply(order(['ARCHER'], 'set', { stance: 'hold_fire' }));
  if (FIRE_AT_WILL.has(norm)) return reply(order(['ARCHER'], 'set', { stance: 'fire_at_will' }));
  if (CHARGE.has(norm)) {
    const near = nearestFoe(f, f.captain);
    if (!near) return undefined;
    return reply(order(['ARMY'], norm === 'charge' ? 'charge' : 'attack', { to: near.id }));
  }
  const words = norm.split(' ');
  for (let k = 1; k < words.length; k++) {
    const tail = words.slice(k).join(' ');
    const names = who(words.slice(0, k), f);
    if (!names) continue;
    if (BACK.has(tail) && !names.includes('ARMY')) return reply(order(names, 'recall'));
    if (STOP.has(tail)) return reply(order(names, 'hold'));
    if (HOLD_FIRE.has(tail)) return reply(order(names, 'set', { stance: 'hold_fire' }));
    if (FIRE_AT_WILL.has(tail)) return reply(order(names, 'set', { stance: 'fire_at_will' }));
    if (SIGNAL.has(tail) && waitingFor(names, f)) return reply(order(names, 'signal'));
  }
  return undefined;
}

/** True if any waiting order belongs to these selectors (a group by its name, or a company in it). */
function waitingFor(names: string[], f: Field): boolean {
  if (names.includes('ARMY')) return (f.waiting ?? []).length > 0;
  const members = (n: string) => f.groups?.find((g) => g.name === n)?.members ?? [n];
  const ours = new Set(names.flatMap(members));
  return (f.waiting ?? []).some((w) => w.who.some((n) => names.includes(n) || members(n).some((m) => ours.has(m))));
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
