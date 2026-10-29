// The broodlord's mind (docs/spec/06-voice.md §8; 00-start-here.md §A3 "2. The enemy's mind"): what the enemy's
// brain is told, the schema its answer must fit, and the answer resolved into deeds in code. Pure, no DOM, so the
// eval runs it under Node exactly as the game does.
//
// The same order language as the captain's (06-voice.md §4c, 08-orders.md §9) cut to intents: `who` is the
// broodlord's own companies (by name, or every one of a kind), the verbs are take, attack, charge, move, hold,
// withdraw and regroup, and the targets are the warband's companies it has seen (through team 1's fog), the places
// and the named ground. At most 2 orders per call. The answer is resolved with the voice's own resolver
// (resolve.ts) on a Field seen from the blight's side, never to the army as a whole, and checked again before it
// goes into the order queue for team 1 as `src: 'brain'` commands.

import type { Deed } from '../../contracts.ts';
import type { CompanyKind, Field, FieldGround, FieldPlace } from '../field.ts';
import { replyOf, type ModelOrder, type Reply } from '../orders.ts';
import { resolve, type Resolution } from '../resolve.ts';

/** The broodlord's way (04-battle.md §6), which sets its character (docs/engine/contracts/campaign.md §7). */
export type BroodlordWay = 'stubborn' | 'reckless' | 'steady' | 'veteran';
export const WAYS: BroodlordWay[] = ['stubborn', 'reckless', 'steady', 'veteran'];

/** One of the blight's companies as `broodlord_field` gives it. */
export interface BroodCompany {
  id: number;
  name: string;
  unit: string;
  /** blight-men, trolls, drakes. */
  kind: string;
  men: number;
  full: number;
  x: number;
  y: number;
  state: string;
  /** Its order in words: "holding", "taking MILL", "attacking WIL", "going to RIDGE"… */
  doing: string;
  morale?: number;
  /** Seconds since the brain last ordered it. */
  orderedS?: number;
}

/** A warband company the blight sees now. */
export interface BroodFoe {
  /** Its name (the captain is CAPTAIN). */
  id: string;
  squad: number;
  kind: string;
  men: number;
  x: number;
  y: number;
  state: string;
  morale?: number;
  strength?: number;
}

/** The field as the blight sees it (crates/sim-wasm/src/broodlord_api.rs `broodlord_field`). */
export interface BroodField {
  facing: string;
  armyLeft: string;
  threatPoint: { x: number; y: number };
  ours: BroodCompany[];
  /** The broodlord himself. */
  captain: { x: number; y: number; hp: number; id?: number };
  foesSeen: BroodFoe[];
  places: FieldPlace[];
  ground: FieldGround[];
  tick?: number;
  size?: { w: number; h: number };
  night?: boolean;
}

/** The blight's kinds as `who` names them, by unit. */
export const BROOD_KINDS: Record<string, string> = { blightman: 'BLIGHTMEN', troll: 'TROLLS', drake: 'DRAKES' };
/** For the shared resolver, which knows the warband's kinds: the blight-men stand in the line like levy, trolls
 * like spears, drakes hunt round the wings like horse. Only the resolver's own geometry reads it. */
const AS_KIND: Record<string, CompanyKind> = { blightman: 'levy', troll: 'spear', drake: 'horse' };

export const BROOD_VERBS = ['take', 'attack', 'charge', 'move', 'hold', 'withdraw', 'regroup'] as const;
const PICKS = ['NEAREST', 'WEAKEST', 'STRONGEST'] as const;
const ROUNDS = ['left', 'right', 'front', 'back'] as const;
/** At most this many orders per call (06-voice.md §8). */
export const MAX_ORDERS = 2;
/** Tokens the answer may take: two full orders are about 50. */
export const MAX_TOKENS = 96;

// ---------------------------------------------------------------------------------------------
// The prompt: rules, examples on another field, then the broodlord's way (all cached), then the field.
// ---------------------------------------------------------------------------------------------

const RULES = `You are the will of a broodlord of the blight. Your companies of blight-men, trolls and drakes fight the
wardens' warband for the places of this land. Every few seconds you are shown the field as your creatures see it,
and you answer with your orders: a JSON array of at most 2 orders.

AN ORDER is {"who":[WHO,...],"do":VERB} plus "to", "round" and "fight" only when needed.

WHO: your companies by name (BLIGHT1, TROLLS1, DRAKES2...), every company of a kind (BLIGHTMEN, TROLLS,
DRAKES), or OTHERS (every company not named earlier in the same answer). A routing company obeys nobody.

VERBS
- take: take a place "to" it: a village to burn, the shrine, the tower, a place they took from you.
- attack: attack a warband company "to" it by name, or NEAREST, WEAKEST, STRONGEST.
- charge: attack "to" it at once, reckless of losses.
- move: go to a hill, a wood or a place of yours. Add "fight":false only to pull back out of a fight.
  Going to a village or a place that is not yours is taking it.
- hold: hold a place "to" it, ready to fight. With no "to": stand where you are.
- withdraw: give ground from the fight you are in, still facing them.
- regroup: pull out of the fight to recover.
round: left, right, front or back: go round that side on the way ("round their flank").

RULES
- Use only the names on the field. Attack only warband companies you see.
- A company carries out its order until you change it, for about 30 seconds. Do not repeat an order a
  company is already carrying out; give orders only where something should change.
- [] means carry on as you are.
- Never order a company that is routing. The BROODLORD himself is not yours to order.
- Act as your WAY says.
`;

const EXAMPLES = `EXAMPLES, on another field:
FIELD 1. You face west. Your left = south.
YOURS: BLIGHT1 blight-men 12/12 (40,8) idle holding | BLIGHT2 blight-men 12/12 (40,14) idle holding |
      TROLLS1 trolls 3/3 (39,20) idle holding | DRAKES1 drakes 3/3 (38,24) idle holding | BROODLORD (42,14) hp 100%
WARBAND SEEN: KAEL spear 12 (24,13) marching east | HUGH archer 10 (20,15) marching east
PLACES: NEST keep (42,14) ours | CHAPEL village (22,5) | FOLD village (24,22) ours
GROUND: BARROW hill (30,18) r3 | ASHWOOD wood (28-33,2-6)
WAY reckless: [{"who":["BLIGHT1","BLIGHT2"],"do":"attack","to":"KAEL"},{"who":["DRAKES1"],"do":"attack","to":"HUGH","round":"right"}]
WAY steady: [{"who":["DRAKES1"],"do":"move","to":"BARROW"},{"who":["OTHERS"],"do":"hold","to":"NEST"}]
WAY stubborn: [{"who":["TROLLS1"],"do":"hold","to":"FOLD"}]
WAY veteran: [{"who":["DRAKES1"],"do":"attack","to":"HUGH","round":"left"}]

FIELD 2. You face west. Your left = south.
YOURS: BLIGHT1 blight-men 4/12 (26,12) fighting KAEL attacking KAEL shaken wounded | BLIGHT2 blight-men 11/12 (27,15)
      fighting attacking KAEL | TROLLS1 trolls 3/3 (39,20) idle holding | DRAKES1 drakes 2/3 (25,6) idle taking CHAPEL |
      BROODLORD (42,14) hp 100%
WARBAND SEEN: KAEL spear 9 (24,13) fighting BLIGHT1 | MAREK shield 10 (23,19) marching north-east | CAPTAIN captain 1 (16,14) idle
PLACES: NEST keep (42,14) ours | CHAPEL village (22,5) ours | FOLD village (24,22) foe
WAY reckless: [{"who":["TROLLS1"],"do":"charge","to":"KAEL"},{"who":["DRAKES1"],"do":"attack","to":"CAPTAIN"}]
WAY steady: [{"who":["BLIGHT1"],"do":"move","to":"NEST","fight":false}]
WAY stubborn: [{"who":["TROLLS1"],"do":"take","to":"FOLD"}]
WAY veteran: [{"who":["BLIGHT1"],"do":"regroup"},{"who":["TROLLS1"],"do":"attack","to":"MAREK","round":"left"}]

FIELD 3. You face west. Your left = south.
YOURS: BLIGHT1 blight-men 12/12 (40,8) idle holding | TROLLS1 trolls 3/3 (30,18) fighting MAREK attacking MAREK |
      DRAKES1 drakes 3/3 (24,7) idle holding CHAPEL | BROODLORD (42,14) hp 100%
WARBAND SEEN: MAREK shield 6 (29,18) fighting TROLLS1 shaken
PLACES: NEST keep (42,14) ours | CHAPEL village (22,5) ours | FOLD village (24,22)
WAY reckless: [{"who":["DRAKES1"],"do":"take","to":"FOLD"}]
WAY steady: []
WAY stubborn: []
WAY veteran: [{"who":["BLIGHT1"],"do":"attack","to":"MAREK"}]

FIELD 4. You face west. Your left = south.
YOURS: BLIGHT1 blight-men 12/12 (40,8) idle holding | BLIGHT2 blight-men 12/12 (40,14) idle holding |
      DRAKES1 drakes 3/3 (38,24) idle holding | BROODLORD (42,14) hp 100%
WARBAND SEEN: none
PLACES: NEST keep (42,14) ours | CHAPEL village (22,5) | FOLD village (24,22) ours
WAY reckless: [{"who":["BLIGHT1","BLIGHT2"],"do":"take","to":"CHAPEL"},{"who":["DRAKES1"],"do":"move","to":"BARROW"}]
WAY steady: [{"who":["DRAKES1"],"do":"move","to":"BARROW"}]
WAY stubborn: []
WAY veteran: [{"who":["DRAKES1"],"do":"move","to":"ASHWOOD"}]
`;

/** The broodlord's character from its way (04-battle.md §6 names the four; 06-voice.md §8 gives the reckless and
 * the cautious one). Recorded in out/decisions-d5-broodlord.md. */
export const WAY_LINES: Record<BroodlordWay, string> = {
  reckless:
    'reckless. You commit early and all at once: throw your companies at the nearest warband companies, chase what runs, burn their villages, never pull back. With no foe in sight, go and take the villages. An idle company is a wasted one.',
  steady:
    'steady. You are cautious and you bait: one company goes out to draw them while the rest hold the NEST and your places. Strike only a company that is alone, shaken or routing. Pull back a company that is losing.',
  stubborn:
    'stubborn. You give no ground: hold the NEST and every place you own, retake at once any place they take from you, and never pull a company back. You do not go far from what you hold.',
  veteran:
    'veteran. You strike where they are weak: their archers, a company that strayed from the rest, their captain when he is exposed. Go round their flanks. Rest a hurt company and send a fresh one.',
};

/** The cached prefix for one way: the rules and examples are the same for every way, so only the last lines differ. */
export function broodPrefix(way: BroodlordWay, name: string): string {
  return `${RULES}\n${EXAMPLES}\nYOU ARE ${name}. YOUR WAY: ${WAY_LINES[way]}`;
}

// ---------------------------------------------------------------------------------------------
// The field as text, and the turn.
// ---------------------------------------------------------------------------------------------

const PER_LINE = 3;

const shaken = (c: { morale?: number; state: string }) => c.state !== 'routing' && (c.morale ?? 1) < 0.5;

/** The blight's field as the brain reads it. */
export function broodText(f: BroodField): string {
  const ours = f.ours.map((c) => {
    const notes = [shaken(c) ? 'shaken' : '', c.men / c.full < 0.6 ? 'wounded' : '', c.orderedS !== undefined ? `(your order ${c.orderedS}s ago)` : ''].filter(Boolean);
    return `${c.name} ${c.kind} ${c.men}/${c.full} (${c.x},${c.y}) ${c.state} ${c.doing}${notes.length ? ' ' + notes.join(' ') : ''}`;
  });
  ours.push(`BROODLORD (${f.captain.x},${f.captain.y}) hp ${Math.round(f.captain.hp * 100)}%`);
  const lines: string[] = [];
  for (let i = 0; i < ours.length; i += PER_LINE) lines.push(ours.slice(i, i + PER_LINE).join(' | '));
  const foes = f.foesSeen.map((e) => `${e.id} ${e.kind} ${e.men} (${e.x},${e.y}) ${e.state}${shaken(e) ? ' shaken' : ''}`);
  const places = f.places.map((p) => `${p.name} ${p.type} (${p.x},${p.y})${p.holder !== 'none' ? ` ${p.holder}` : ''}`);
  const ground = f.ground.map((g) => {
    if (g.type === 'hill') return `${g.name} hill (${g.x},${g.y}) r${g.r}`;
    if (g.type === 'wood') return `${g.name} wood (${g.x0}-${g.x1},${g.y0}-${g.y1})`;
    if (g.type === 'narrows') return `${g.name} narrows (${g.x},${g.y})`;
    return `${g.name} x ${g.x0}-${g.x1}, fords at y ${g.fords.join(' and ')}`;
  });
  const out = [
    `You face ${f.facing}. Your left = ${f.armyLeft}.${f.night ? ' It is night.' : ''}`,
    `YOURS: ${lines.join(' |\n      ')}`,
    `WARBAND SEEN: ${foes.length ? foes.join(' | ') : 'none'}`,
    `PLACES: ${places.length ? places.join(' | ') : 'none'}`,
  ];
  if (ground.length) out.push(`GROUND: ${ground.join(' | ')}`);
  return out.join('\n');
}

/** The user turn: the field, then the call for orders. */
export function broodTurn(f: BroodField): string {
  return `${broodText(f)}\nYOUR ORDERS:`;
}

// ---------------------------------------------------------------------------------------------
// The schema: every name an enum of this field.
// ---------------------------------------------------------------------------------------------

/** The companies that can take orders: on the field and not routing. */
const canObey = (c: BroodCompany) => c.state !== 'routing' && c.state !== 'fled';

export function broodEnums(f: BroodField) {
  const names = f.ours.filter(canObey).map((c) => c.name);
  const kinds = [...new Set(f.ours.filter(canObey).map((c) => BROOD_KINDS[c.unit]).filter(Boolean))];
  const spots = [...f.places.map((p) => p.name), ...f.ground.map((g) => g.name)];
  return {
    who: [...names, ...kinds, ...(names.length > 1 ? ['OTHERS'] : [])],
    do: [...BROOD_VERBS],
    target: [...spots, ...f.foesSeen.map((e) => e.id), ...(f.foesSeen.length ? PICKS : []), 'HERE'],
    round: [...ROUNDS],
  };
}

/** The answer's grammar: a bare array of at most 2 orders, no whitespace, the optional fields in a fixed order. */
export function broodGrammar(f: BroodField): string {
  const e = broodEnums(f);
  const alt = (xs: readonly string[]) => xs.map((x) => `"\\"${x}\\""`).join(' | ');
  const opt = (key: string, rule: string) => `("," "\\"${key}\\":" ${rule})?`;
  if (!e.who.length) return `root ::= "[]"`;
  return [
    `root ::= "[" (order ("," order)?)? "]"`,
    `order ::= "{\\"who\\":[" who ("," who)* "],\\"do\\":" do ${opt('to', 'target')} ${opt('round', 'round')} ${opt('fight', 'bool')} "}"`,
    `who ::= ${alt(e.who)}`,
    `do ::= ${alt(e.do)}`,
    `target ::= ${alt(e.target)}`,
    `round ::= ${alt(e.round)}`,
    `bool ::= "true" | "false"`,
  ].join('\n');
}

/** The same as a JSON schema, for a server without grammars (06-voice.md §2, chat mode). */
export function broodSchema(f: BroodField): object {
  const e = broodEnums(f);
  return {
    type: 'array',
    maxItems: MAX_ORDERS,
    items: {
      type: 'object',
      properties: { who: { type: 'array', minItems: 1, items: { enum: e.who } }, do: { enum: e.do }, to: { enum: e.target }, round: { enum: e.round }, fight: { type: 'boolean' } },
      required: ['who', 'do'],
      additionalProperties: false,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Resolving and checking the answer.
// ---------------------------------------------------------------------------------------------

/** The blight's field in the shape the shared resolver reads: its companies as "ours", the warband as the foes. */
export function asField(f: BroodField): Field {
  return {
    facing: f.facing,
    armyLeft: f.armyLeft,
    threatPoint: f.threatPoint,
    ours: f.ours.map((c) => ({ id: c.id, name: c.name, kind: AS_KIND[c.unit] ?? 'levy', men: c.men, full: c.full, x: c.x, y: c.y, state: c.state, morale: c.morale })),
    captain: f.captain,
    foesSeen: f.foesSeen.map((e) => ({ id: e.id, squad: e.squad, kind: e.kind, men: e.men, x: e.x, y: e.y, state: e.state, morale: e.morale, strength: e.strength })),
    places: f.places,
    ground: f.ground,
    size: f.size,
  };
}

/** Places the blight takes by going there: a village, the shrine or the tower it does not hold. */
const TAKEN_BY_GOING = new Set(['village', 'shrine', 'tower', 'keep', 'town']);

/** Kinds in `who` as the companies they name (the shared resolver knows only the warband's kinds); going to a place
 * the blight does not hold is taking it (as a move to a village the blight holds is a take for the warband, D-07). */
function expandKinds(o: ModelOrder, f: BroodField, named: Set<string>): ModelOrder {
  const obeying = f.ours.filter(canObey);
  const who = o.who.flatMap((w) => {
    const unit = Object.keys(BROOD_KINDS).find((u) => BROOD_KINDS[u] === w);
    if (unit) return obeying.filter((c) => c.unit === unit).map((c) => c.name);
    // OTHERS: the companies not named earlier that can obey (a broken one obeys nobody)
    if (w === 'OTHERS') return obeying.filter((c) => !named.has(c.name)).map((c) => c.name);
    // a company that broke since the field was read is passed over
    return obeying.some((c) => c.name === w) ? [w] : [];
  });
  const place = o.do === 'move' && o.fight !== false ? f.places.find((p) => p.name === o.to) : undefined;
  const take = place && place.holder !== 'ours' && TAKEN_BY_GOING.has(place.type) && place.site != null;
  return { ...o, who: [...new Set(who)], ...(take ? { do: 'take' as const } : {}) };
}

/** The deeds the broodlord may give: intents for its own companies only. */
const ALLOWED = new Set(['move', 'attack', 'take', 'hold', 'charge', 'withdraw', 'regroup']);

/** Why a resolved deed may not go into the queue, or '' if it may. A `with` (a target priority, "the weakest")
 * is checked by the deed inside it; a `wait` is not the broodlord's. */
export function invalid(d: Deed, f: BroodField): string {
  if (d.do === 'with') return invalid(d.deed, f);
  const ours = new Set(f.ours.filter(canObey).map((c) => c.id));
  if (!ALLOWED.has(d.do)) return `${d.do} is not the broodlord's`;
  if (!('who' in d)) return 'no company';
  const w = d.who;
  const ids = w.t === 'squad' ? [w.id] : w.t === 'squads' ? w.ids : [];
  if (!ids.length) return 'not to the army';
  const bad = ids.find((id) => !ours.has(id));
  if (bad !== undefined) return `squad ${bad} is not a company of the blight that can obey`;
  if ((d.do === 'attack' || d.do === 'charge') && d.target !== undefined && !f.foesSeen.some((e) => e.squad === d.target)) return `target ${d.target} not seen`;
  return '';
}

export interface Decision {
  reply: Reply;
  resolution: Resolution;
  /** What goes into the queue: resolved, checked, the direct deeds only. */
  deeds: Deed[];
  /** Deeds dropped by the check, with why. */
  dropped: { deed: Deed; why: string }[];
  /** Orders left with no company that can obey (all those it named are routing): nothing to do. */
  moot: ModelOrder[];
}

/** The brain's raw answer to deeds for team 1: parse, at most 2 orders, kinds to names, resolve, check. */
export function decide(raw: string, f: BroodField): Decision {
  const reply = replyOf(JSON.parse(raw));
  const named = new Set<string>();
  const orders: ModelOrder[] = [];
  const moot: ModelOrder[] = [];
  for (const o of reply.orders.slice(0, MAX_ORDERS)) {
    const x = expandKinds(o, f, named);
    x.who.forEach((n) => named.add(n));
    if (x.who.length) orders.push(x);
    else moot.push(o);
  }
  const resolution = resolve({ orders, unclear: false }, asField(f), { army: false });
  const deeds: Deed[] = [];
  const dropped: Decision['dropped'] = [];
  for (const d of resolution.deeds) {
    const why = invalid(d, f);
    if (why) dropped.push({ deed: d, why });
    else deeds.push(d);
  }
  return { reply: { orders, unclear: reply.unclear }, resolution, deeds, dropped, moot };
}
