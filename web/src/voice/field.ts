// What the voice brain is told about the battle (docs/spec/06-voice.md §4b, §4c; 08-orders.md §2, §4, §9): a
// fog-limited field, its compact text, and the per-battle schema whose enums hold every name the model may use.
// Pure; no DOM.

import type { P, Work } from '../contracts.ts';

export type CompanyKind = 'spear' | 'shield' | 'archer' | 'horse' | 'levy';

export interface FieldCompany {
  id: number;
  name: string;
  kind: CompanyKind;
  men: number;
  full: number;
  x: number;
  y: number;
  /** idle, marching, fighting, routing, fled. */
  state: string;
  /** Detached from the army by an order of its own. */
  detached?: boolean;
  /** Held back out of the line by a reserve order (08-orders §3). */
  reserve?: boolean;
  /** Morale share 0..1; absent means steady. */
  morale?: number;
}

export interface FieldFoe {
  /** Shown to the model as `E<id>`. */
  id: string;
  /** blight-men, trolls, drakes, broodlord (as the player would say them). */
  kind: string;
  men: number;
  x: number;
  y: number;
  /** Free text: "idle", "marching west", "fighting WIL", "attacking MILL". */
  state: string;
  morale?: number;
  /** Men × worth left, for "the weakest" and "their strongest"; absent means men. */
  strength?: number;
}

export interface FieldPlace {
  name: string;
  type: string;
  x: number;
  y: number;
  holder: 'ours' | 'foe' | 'none';
  burning?: string;
}

export type FieldGround =
  | { name: string; type: 'hill'; x: number; y: number; r: number }
  | { name: string; type: 'wood'; x0: number; y0: number; x1: number; y1: number }
  | { name: string; type: 'river'; x0: number; x1: number; fords: number[] }
  /** A narrow point of the river, where a bridge can be thrown (08-orders §7). */
  | { name: string; type: 'narrows'; x: number; y: number };

/** A built field work (08-orders §7). */
export interface FieldWork {
  name: string;
  work: Work;
  x: number;
  y: number;
  holder: 'ours' | 'foe';
}

/** A group the captain has named by voice: "Bors and Ren, you're the hammer" (08-orders §2). */
export interface FieldGroup {
  name: string;
  members: string[];
}

/** An order waiting for a signal or a condition (08-orders §6). `n` is the signal that releases it. */
export interface FieldWaiting {
  who: string[];
  what: string;
  n: number;
}

export interface Field {
  facing: string;
  armyLeft: string;
  threatPoint: P;
  ours: FieldCompany[];
  /** The captain; `id` is his squad (0 in the sim's setups). */
  captain: { x: number; y: number; hp: number; id?: number };
  foesSeen: FieldFoe[];
  places: FieldPlace[];
  ground: FieldGround[];
  works?: FieldWork[];
  groups?: FieldGroup[];
  waiting?: FieldWaiting[];
  /** Deployment before contact: "advance" ends it (08-orders §8). */
  held?: boolean;
}

/** Kind words the model may use in `who`, and the company kinds they name. */
export const KIND_WORDS: Record<string, CompanyKind> = { HORSE: 'horse', SPEAR: 'spear', SHIELD: 'shield', ARCHER: 'archer', LEVY: 'levy' };

/** Selectors by place in the army's frame and by state (08-orders §2). */
export const PLACE_SELECTORS = ['LEFT_WING', 'RIGHT_WING', 'CENTRE', 'FRONT_LINE', 'REAR', 'RESERVE'] as const;
export const STATE_SELECTORS = ['FREE', 'FRESH', 'SHAKEN', 'WOUNDED'] as const;

/** The blight's units by the word the model uses, with the sim's `Unit::id()` (crates/sim/src/units.rs). */
export const FOE_KINDS: Record<string, { unit: number; words: string[] }> = {
  BLIGHTMEN: { unit: 7, words: ['blightmen', 'blightman'] },
  TROLLS: { unit: 8, words: ['trolls', 'troll'] },
  DRAKES: { unit: 9, words: ['drakes', 'drake'] },
  BROODLORD: { unit: 10, words: ['broodlord', 'broodlords'] },
};
/** Enemies picked by state (08-orders §4). */
export const FOE_PICKS = ['NEAREST', 'WEAKEST', 'STRONGEST', 'MOST_SHAKEN'] as const;
/** Points in the army's own frame: "our left flank", "the rear". */
export const FRAME_POINTS = ['LEFT_FLANK', 'RIGHT_FLANK', 'FRONT', 'REAR'] as const;

export const VERBS = [
  'move', 'hold', 'take', 'attack', 'charge', 'front', 'recall', 'rally', 'guard', 'screen', 'withdraw', 'regroup',
  'reserve', 'commit', 'face', 'advance', 'signal', 'build', 'set', 'name',
] as const;
export const RELS = ['behind', 'front', 'across', 'beside', 'between', 'left', 'right'] as const;
export const ROUNDS = ['left', 'right', 'front', 'back'] as const;
export const WORKS: Work[] = ['stakes', 'barricade', 'bridge', 'watchtower'];
export const STANCES = ['aggressive', 'defensive', 'hold_fire', 'fire_at_will', 'skirmish', 'chase', 'no_chase'] as const;
export const SHAPES = ['line', 'column', 'wedge', 'square', 'shield_wall', 'loose', 'tight', 'thin', 'deep'] as const;
export const PACES = ['walk', 'quick', 'double'] as const;
export const WHENS = ['done', 'mark', 'attacked', 'night', 'dawn'] as const;

/** The foe kind word (BLIGHTMEN…) of a seen foe, from its kind text. */
export function foeKind(e: FieldFoe): string | undefined {
  const w = e.kind.toLowerCase().replace(/[^a-z]/g, '');
  return Object.keys(FOE_KINDS).find((k) => FOE_KINDS[k].words.includes(w));
}

// ---------------------------------------------------------------------------------------------
// The army's frame (06-voice.md §6) and each company's place in it (08-orders §2 "position").
// ---------------------------------------------------------------------------------------------

/** A company stands in the line unless it is detached, held in reserve, or gone. */
export const inLine = (c: FieldCompany): boolean => !c.detached && !c.reserve && c.state !== 'routing' && c.state !== 'fled';

/** The army's frame: forward from the line's centroid to the threat point, and left = (f.y, −f.x). */
export function frame(f: Field): { centre: P; forward: P; left: P } {
  const line = f.ours.filter(inLine);
  const ps = (line.length ? line : f.ours).map((c) => ({ x: c.x, y: c.y }));
  const centre = { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
  const dx = f.threatPoint.x - centre.x;
  const dy = f.threatPoint.y - centre.y;
  const d = Math.hypot(dx, dy) || 1;
  const forward = { x: dx / d, y: dy / d };
  return { centre, forward, left: { x: forward.y, y: -forward.x } };
}

/** A wing is at least this far across from the line's centre, and within WING_BAND of the outermost company. */
const WING_MIN = 2.5;
const WING_BAND = 2;
/** The front line is within FRONT_BAND of the foremost company; the rear at least REAR_GAP behind it. */
const FRONT_BAND = 1.5;
const REAR_GAP = 3;

export type LineTag = 'front' | 'rear' | 'left' | 'centre' | 'right' | 'reserve' | 'detached';

/** Each company's place in the army's frame: depth (front, rear) then side (left, centre, right). */
export function lineTags(f: Field): Map<string, LineTag[]> {
  const fr = frame(f);
  const line = f.ours.filter(inLine);
  const across = (c: FieldCompany) => (c.x - fr.centre.x) * fr.left.x + (c.y - fr.centre.y) * fr.left.y;
  const depth = (c: FieldCompany) => (c.x - fr.centre.x) * fr.forward.x + (c.y - fr.centre.y) * fr.forward.y;
  const lMax = Math.max(...line.map(across));
  const lMin = Math.min(...line.map(across));
  const dMax = Math.max(...line.map(depth));
  const out = new Map<string, LineTag[]>();
  for (const c of f.ours) {
    if (c.reserve) out.set(c.name, ['reserve']);
    else if (c.detached) out.set(c.name, ['detached']);
    else if (!inLine(c)) out.set(c.name, []);
    else {
      const tags: LineTag[] = [];
      const l = across(c);
      const d = depth(c);
      if (line.length > 1 && d >= dMax - FRONT_BAND) tags.push('front');
      else if (d <= dMax - REAR_GAP) tags.push('rear');
      if (l >= WING_MIN && l >= lMax - WING_BAND) tags.push('left');
      else if (l <= -WING_MIN && l <= lMin + WING_BAND) tags.push('right');
      else tags.push('centre');
      out.set(c.name, tags);
    }
  }
  return out;
}

/** Wavering: routing, or morale under half (08-orders §2 "the broken ones"). */
export const shaken = (c: { morale?: number; state: string }): boolean => c.state === 'routing' || (c.morale ?? 1) < 0.5;
/** Fewer than 60% of its men left. */
export const wounded = (c: FieldCompany): boolean => c.men / c.full < 0.6;
/** At least 90% of its men, steady, and not fighting. */
export const fresh = (c: FieldCompany): boolean =>
  c.men / c.full >= 0.9 && (c.morale ?? 1) >= 0.8 && !['fighting', 'routing', 'fled'].includes(c.state);
/** Not fighting, not marching on an order, not held in reserve. */
export const free = (c: FieldCompany): boolean => c.state === 'idle' && !c.reserve && !c.detached;

const OURS_PER_LINE = 3;

/** The dynamic field state (§4b), with each company's place in the line and state, groups, waiting orders and works. */
export function stateText(f: Field): string {
  const tags = lineTags(f);
  const ours = f.ours.map((c) => {
    const notes = [...(tags.get(c.name) ?? [])];
    if (shaken(c) && c.state !== 'routing') notes.push('shaken' as LineTag);
    if (wounded(c)) notes.push('wounded' as LineTag);
    return `${c.name} ${c.kind} ${c.men}/${c.full} (${c.x},${c.y}) ${c.state}${notes.length ? ' ' + notes.join(' ') : ''}`;
  });
  ours.push(`CAPTAIN (${f.captain.x},${f.captain.y}) hp ${Math.round(f.captain.hp * 100)}%`);
  const lines: string[] = [];
  for (let i = 0; i < ours.length; i += OURS_PER_LINE) lines.push(ours.slice(i, i + OURS_PER_LINE).join(' | '));
  const foes = f.foesSeen.map((e) => `${e.id} ${e.kind} ${e.men} (${e.x},${e.y}) ${e.state}${(e.morale ?? 1) < 0.5 ? ' shaken' : ''}`);
  const places = f.places.map((p) => {
    // Only a village changes hands, so only a village says who holds it (as in docs/voice-eval/fixture.json).
    const held = p.type === 'village' && p.holder !== 'none' ? ` ${p.holder}-held` : '';
    const burning = p.burning ? ` burning ${p.burning}` : '';
    return `${p.name} ${p.type} (${p.x},${p.y})${held}${burning}`;
  });
  const ground = f.ground.map((g) => {
    if (g.type === 'hill') return `${g.name} hill (${g.x},${g.y}) r${g.r}`;
    if (g.type === 'wood') return `${g.name} wood (${g.x0}-${g.x1},${g.y0}-${g.y1})`;
    if (g.type === 'narrows') return `${g.name} narrows (${g.x},${g.y})`;
    return `${g.name} x ${g.x0}-${g.x1}, fords at y ${g.fords.join(' and ')}`;
  });
  const out = [`FACING ${f.facing}. Army left = ${f.armyLeft}.${f.held ? ' Deployment held.' : ''}`, `OURS: ${lines.join(' |\n      ')}`];
  if (f.groups?.length) out.push(`GROUPS: ${f.groups.map((g) => `${g.name} = ${g.members.join(' ')}`).join(' | ')}`);
  if (f.waiting?.length) out.push(`WAITING: ${f.waiting.map((w) => `${w.who.join(' ')} ${w.what}`).join(' | ')}`);
  out.push(`FOES SEEN: ${foes.join(' | ')}`, `PLACES: ${places.join(' | ')}`, `GROUND: ${ground.join(' | ')}`);
  if (f.works?.length) out.push(`WORKS: ${f.works.map((w) => `${w.name} ${w.work} (${w.x},${w.y}) ${w.holder}`).join(' | ')}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// The reply schema (08-orders §9): an array of orders, every name an enum built from this field.
// ---------------------------------------------------------------------------------------------

/** Names that point at a spot on the field: places, ground and works. */
export const spotNames = (f: Field): string[] => [...f.places.map((p) => p.name), ...f.ground.map((g) => g.name), ...(f.works ?? []).map((w) => w.name)];

/** Foe kinds actually seen, in FOE_KINDS order. */
export const seenFoeKinds = (f: Field): string[] => Object.keys(FOE_KINDS).filter((k) => f.foesSeen.some((e) => foeKind(e) === k));

/** Every enum of the reply, for this field. */
export function enums(f: Field) {
  const names = f.ours.map((c) => c.name);
  const groups = (f.groups ?? []).map((g) => g.name);
  const kinds = Object.keys(KIND_WORDS);
  const spots = spotNames(f);
  const foes = f.foesSeen.map((e) => e.id);
  const foeKinds = seenFoeKinds(f);
  return {
    who: ['ARMY', 'OTHERS', ...kinds, ...names, ...groups, ...PLACE_SELECTORS, ...STATE_SELECTORS, ...spots.map((s) => `NEAR_${s}`)],
    do: [...VERBS],
    target: ['HERE', 'ME', ...names, ...kinds, ...groups, ...spots, ...foes, ...foeKinds, ...FOE_PICKS, ...FRAME_POINTS],
    rel: [...RELS],
    round: [...ROUNDS],
    work: [...WORKS],
    stance: [...STANCES],
    shape: [...SHAPES],
    pace: [...PACES],
    when: [...WHENS, ...spots.map((s) => `near:${s}`), ...[...names, ...kinds, ...groups, ...foes, ...foeKinds].map((s) => `breaks:${s}`)],
  };
}

/** The optional fields of an order, in the order the reply must give them. */
export const OPTIONAL_FIELDS = ['work', 'as', 'to', 'rel', 'and', 'from', 'round', 'by', 'stance', 'shape', 'pace', 'fight', 'when'] as const;

/** Words of the utterance the model may give as a group's name ("as"), so it never invents one. */
export function nameWords(said: string): string[] {
  const words = said.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
  return [...new Set(words)];
}

/** The output schema built per battle, so every name is an enum the model cannot invent (§4c, 08-orders §9). */
export function orderSchema(f: Field, said = ''): object {
  const e = enums(f);
  const str = (xs: readonly string[]) => ({ enum: [...xs] });
  const target = str(e.target);
  const words = nameWords(said);
  return {
    type: 'array',
    maxItems: 4,
    items: {
      type: 'object',
      properties: {
        who: { type: 'array', minItems: 1, items: str(e.who) },
        do: str(e.do),
        work: str(e.work),
        as: words.length ? str(words) : { type: 'string', maxLength: 0 },
        to: target,
        rel: str(e.rel),
        and: target,
        from: target,
        round: str(e.round),
        by: target,
        stance: str(e.stance),
        shape: str(e.shape),
        pace: str(e.pace),
        fight: { type: 'boolean' },
        when: { anyOf: [str(e.when), { type: 'string', pattern: '^after:[0-9]{1,3}$' }] },
      },
      required: ['who', 'do'],
      additionalProperties: false,
    },
  };
}

/**
 * The same schema as a GBNF grammar with no whitespace and the optional fields in a fixed order, so the reply is
 * as few tokens as it can be: a plain order is `{"who":["BORS"],"do":"take","to":"MILL"}`.
 */
export function orderGrammar(f: Field, said = ''): string {
  const e = enums(f);
  const alt = (xs: readonly string[]) => xs.map((x) => `"\\"${x}\\""`).join(' | ');
  const words = nameWords(said);
  const opt = (key: string, rule: string) => `("," "\\"${key}\\":" ${rule})?`;
  const whens = [...e.when.map((w) => `"${w}"`), `"after:" [0-9] [0-9]? [0-9]?`].join(' | ');
  return [
    `root ::= "[" (order ("," order)? ("," order)? ("," order)?)? "]"`,
    `order ::= "{\\"who\\":[" who ("," who)* "],\\"do\\":" do ` +
      [
        opt('work', 'work'), ...(words.length ? [opt('as', 'as')] : []), opt('to', 'target'), opt('rel', 'rel'), opt('and', 'target'),
        opt('from', 'target'), opt('round', 'round'), opt('by', 'target'), opt('stance', 'stance'), opt('shape', 'shape'), opt('pace', 'pace'),
        opt('fight', 'bool'), opt('when', 'when'),
      ].join(' ') +
      ` "}"`,
    `who ::= ${alt(e.who)}`,
    `do ::= ${alt(e.do)}`,
    `target ::= ${alt(e.target)}`,
    `rel ::= ${alt(e.rel)}`,
    `round ::= ${alt(e.round)}`,
    `work ::= ${alt(e.work)}`,
    ...(words.length ? [`as ::= ${alt(words)}`] : []),
    `stance ::= ${alt(e.stance)}`,
    `shape ::= ${alt(e.shape)}`,
    `pace ::= ${alt(e.pace)}`,
    `when ::= "\\"" (${whens}) "\\""`,
    `bool ::= "true" | "false"`,
  ].join('\n');
}
