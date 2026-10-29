// Turning the reply's names into the game's deeds, in code (docs/spec/06-voice.md §6, 08-orders.md §2–§7). The
// model never gives coordinates: selectors become companies, targets become squads and points, modifiers become
// `with`, sequences, signals and conditions become `wait`. Pure and deterministic.

import type { Deed, How, P, Priority, When, Who, Work } from '../contracts.ts';
import {
  FOE_KINDS, FRAME_POINTS, KIND_WORDS, foeKind, frame, free, fresh, inLine, lineTags, shaken, spotNames, wounded,
  type Field, type FieldCompany, type FieldFoe, type FieldGroup, type FieldGround,
} from './field.ts';
import type { Do, ModelOrder, Reply, Side } from './orders.ts';

export { frame };

const SIDE_SHIFT = 6;
const RIVER_BACK = 2.5;
const LINE_PER_COMPANY = 3.2;
const LINE_KINDS = new Set(['spear', 'shield', 'levy']);
/** "the ones by the mill": the nearest company, and any other within this many tiles of the spot. */
const NEAR_R = 4;
/** "when they reach the ford": an enemy within this many tiles of the spot. */
const TRIGGER_R = 3;
/** A relative point stands this far beyond the target's own extent. */
const REL_GAP = 2;
/** "our left flank": this far out beyond the outermost company. */
const FLANK_GAP = 3;
/** "advance" with no place, when the deployment is not held: this far toward the threat. */
const ADVANCE_STEP = 6;
/** Stakes go this far in front of the company that plants them. */
const STAKE_AHEAD = 1.5;
/** "a thin line" and "a deep line" as files in the front rank. */
const THIN_FILES = 8;
const DEEP_FILES = 3;

/** One company's (or the army's) part of an order: what the eval and `say` read. */
export interface Act {
  /** A company name, or 'ARMY'. */
  who: string;
  /** The verb of the deed inside any `with` and `wait`. */
  do: string;
  /** What it acts on, by name: a foe id, place, feature, work, company, ME, or a point of the army's frame. */
  target?: string;
  to?: P;
  via?: P[];
  /** The route's side ("round the left"). */
  side?: Side;
  fight?: boolean;
  how?: How;
  /** The trigger, with `of` naming what it watches. */
  when?: When & { of?: string };
  work?: Work;
  face?: number;
  n?: number;
  /** The threat a screen stands against, by name. */
  from?: string;
  /** None for naming a group, which is the voice's own state, not the battle's. */
  deed?: Deed;
}

export interface Resolved {
  said: ModelOrder;
  /** 'ARMY' for an order to the army, else the companies it names. */
  who: 'ARMY' | string[];
  do: Do | string;
  target: string;
  side: Side;
  fight: boolean;
  acts: Act[];
  /** The order's deeds; companies given the same deed share one `squads` deed. */
  deeds: Deed[];
  via?: P;
  line?: P[];
  /** A group named by this order ("Bors and Ren, you're the hammer"). */
  group?: FieldGroup;
}

export interface Refused {
  order: ModelOrder;
  why: string;
}

export interface Resolution {
  orders: Resolved[];
  refused: Refused[];
  /** Every deed of every order, the direct ones first and the waiting ones after (as one command batch). */
  deeds: Deed[];
  /** The field's groups after this reply. */
  groups: FieldGroup[];
}

type Frame = ReturnType<typeof frame>;
/** How a side's words are resolved. */
export interface ResolveOpts {
  /** False: never an order to the army (the broodlord's companies are ordered each by name, 06-voice.md §8). */
  army?: boolean;
}

interface Ctx {
  f: Field;
  /** Orders may go to the army as a whole. */
  army: boolean;
  fr: Frame;
  tags: ReturnType<typeof lineTags>;
  /** Companies named earlier in the same words, for OTHERS. */
  named: Set<string>;
  groups: FieldGroup[];
}
interface Unit {
  who: Who;
  name: string;
  at: P;
  company?: FieldCompany;
}
interface Target {
  name: string;
  p: P;
  /** How far the thing reaches from `p`, for relative points. */
  ext: number;
  kind: 'here' | 'me' | 'place' | 'ground' | 'work' | 'foe' | 'ours' | 'frame';
  /** The sim's site id; none for a place that is not a site (a ford). */
  site?: number;
  /** The place's index in the field's places. */
  index?: number;
  foe?: FieldFoe;
  company?: FieldCompany;
  ground?: FieldGround;
  priority?: Priority;
  /** A direction of the army's frame, for `face`. */
  dir?: P;
}

class Refusal extends Error {}
const refuse = (why: string): never => {
  throw new Refusal(why);
};

const add = (a: P, b: P, k = 1): P => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const neg = (a: P): P => ({ x: -a.x, y: -a.y });
const dot = (a: P, b: P) => a.x * b.x + a.y * b.y;
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });
const angle = (d: P) => Math.atan2(d.y, d.x);
const round2 = (p: P): P => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
/** A point kept half a tile inside the map, when the field gives the map's size (the live game does). */
const inMap = (p: P, f: Field): P =>
  f.size ? { x: Math.min(Math.max(p.x, 0.5), f.size.w - 0.5), y: Math.min(Math.max(p.y, 0.5), f.size.h - 0.5) } : p;
const foeSquad = (e: FieldFoe) => e.squad ?? Number(e.id.replace(/\D/g, ''));
const lc = (s: string) => s.toLowerCase().replace(/_/g, ' ');

export function resolve(reply: Reply, f: Field, opts: ResolveOpts = {}): Resolution {
  const ctx: Ctx = { f, army: opts.army ?? true, fr: frame(f), tags: lineTags(f), named: new Set(), groups: [...(f.groups ?? [])] };
  const orders: Resolved[] = [];
  const refused: Refused[] = [];
  for (const raw of reply.orders) {
    const o = dayOne(raw);
    try {
      const r = resolveOne(o, ctx);
      if (r.who !== 'ARMY') r.who.forEach((n) => ctx.named.add(n));
      if (r.group) {
        const at = ctx.groups.findIndex((g) => g.name === r.group!.name);
        if (at >= 0) ctx.groups[at] = r.group;
        else ctx.groups.push(r.group);
      }
      orders.push(r);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      refused.push({ order: raw, why: e.message });
    }
  }
  // A direct order clears the waits of whoever it orders (the sim's queue), so in one batch every `wait` goes after
  // the direct deeds, whatever order the words gave them in: "hold the ford once you've taken the mill".
  const deeds = orders.flatMap((r) => r.deeds);
  return { orders, refused, deeds: [...deeds.filter((d) => d.do !== 'wait'), ...deeds.filter((d) => d.do === 'wait')], groups: ctx.groups };
}

/** A Day 1 reply's `target`/`side` read as `to`/`round` (docs/voice-eval/schema.json). */
function dayOne(o: ModelOrder): ModelOrder {
  if (o.target === undefined && o.side === undefined) return o;
  const out: ModelOrder = { ...o };
  if (o.to === undefined && o.target && o.target !== 'NONE') out.to = o.target;
  if (o.round === undefined && o.side && o.side !== 'none') out.round = o.side;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------------------------

const PLACE_TAG: Record<string, (c: FieldCompany, ctx: Ctx) => boolean> = {
  LEFT_WING: (c, x) => !!x.tags.get(c.name)?.includes('left'),
  RIGHT_WING: (c, x) => !!x.tags.get(c.name)?.includes('right'),
  CENTRE: (c, x) => !!x.tags.get(c.name)?.includes('centre'),
  FRONT_LINE: (c, x) => !!x.tags.get(c.name)?.includes('front'),
  REAR: (c, x) => !!x.tags.get(c.name)?.includes('rear'),
  RESERVE: (c) => !!c.reserve,
  FREE: (c) => free(c),
  FRESH: (c) => fresh(c),
  SHAKEN: (c) => shaken(c),
  WOUNDED: (c) => wounded(c),
};

/** Companies that may take orders (06-voice §6 "validation": not routing, not fled). */
const canObey = (c: FieldCompany) => c.state !== 'routing' && c.state !== 'fled';

/** One selector's companies, or a refusal naming it. */
function select(s: string, ctx: Ctx, self?: FieldCompany): FieldCompany[] {
  const { f } = ctx;
  let pick: FieldCompany[];
  const group = ctx.groups.find((g) => g.name === s);
  if (s === 'OTHERS') pick = f.ours.filter((c) => !ctx.named.has(c.name));
  else if (KIND_WORDS[s]) pick = f.ours.filter((c) => c.kind === KIND_WORDS[s]);
  else if (group) pick = f.ours.filter((c) => group.members.includes(c.name));
  else if (PLACE_TAG[s]) pick = f.ours.filter((c) => PLACE_TAG[s](c, ctx));
  else if (s.startsWith('NEAR_')) pick = nearSpot(s.slice(5), ctx, self);
  else pick = f.ours.filter((c) => c.name === s);
  if (!pick.length) refuse(`no company is ${lc(s)}`);
  return pick;
}

/** "the company nearest the ford", "the ones by the mill": the nearest, and any other within NEAR_R of the spot. */
function nearSpot(spot: string, ctx: Ctx, self?: FieldCompany): FieldCompany[] {
  const ours = ctx.f.ours.filter((c) => canObey(c) && c !== self);
  const d = (c: FieldCompany) => dist(c, spotPoint(spot, c, ctx));
  const sorted = [...ours].sort((a, b) => d(a) - d(b) || a.id - b.id);
  return sorted.filter((c, i) => i === 0 || d(c) <= NEAR_R);
}

/** ARMY, OTHERS, kinds, names, groups, places in the line, states and nearness into companies. */
function expandWho(who: string[], ctx: Ctx): { army: boolean; list: FieldCompany[] } {
  const { f } = ctx;
  if (!who.length || who.includes('ARMY')) {
    const all = f.ours.filter(canObey);
    if (!ctx.army && !all.length) refuse('no company can take orders');
    return { army: ctx.army, list: all };
  }
  const out = new Map<string, FieldCompany>();
  for (const s of who) select(s, ctx).forEach((c) => out.set(c.name, c));
  const all = [...out.values()];
  const list = all.filter(canObey);
  if (!list.length) refuse(`${all.map((c) => c.name).join(', ')} cannot take orders (${all[0].state})`);
  // Naming every company is an order to the army (DECISIONS.md D-07).
  return { army: ctx.army && list.length === f.ours.length && list.length > 1, list };
}

// ---------------------------------------------------------------------------------------------
// Targets and points
// ---------------------------------------------------------------------------------------------

/** A hill's crest; a wood's edge nearest `from`; a river's near bank (our side) level with `from`. */
function groundPoint(g: FieldGround, from: P, centre: P): P {
  if (g.type === 'hill' || g.type === 'narrows') return { x: g.x, y: g.y };
  if (g.type === 'wood') return { x: Math.max(g.x0, Math.min(g.x1 + 1, from.x)), y: Math.max(g.y0, Math.min(g.y1 + 1, from.y)) };
  return { x: centre.x < g.x0 ? g.x0 - 0.5 : g.x1 + 1.5, y: from.y };
}

function groundExt(g: FieldGround): number {
  if (g.type === 'hill') return g.r;
  if (g.type === 'wood') return Math.max(g.x1 + 1 - g.x0, g.y1 + 1 - g.y0) / 2;
  return 1;
}

/** Where a place, feature or work is, as seen from `from`. */
function spotPoint(name: string, from: P, ctx: Ctx): P {
  const { f } = ctx;
  const place = f.places.find((p) => p.name === name);
  if (place) return { x: place.x, y: place.y };
  const g = f.ground.find((x) => x.name === name);
  if (g) return groundPoint(g, from, ctx.fr.centre);
  const w = f.works?.find((x) => x.name === name);
  if (w) return { x: w.x, y: w.y };
  return refuse(`no ${lc(name)} on the field`);
}

/** The points of the army's own frame: beyond its outermost companies on each side. */
function framePoint(name: string, ctx: Ctx): { p: P; dir: P } {
  const { fr, f } = ctx;
  const line = f.ours.filter(inLine);
  const across = line.map((c) => dot(sub(c, fr.centre), fr.left));
  const depth = line.map((c) => dot(sub(c, fr.centre), fr.forward));
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);
  const min = (xs: number[]) => (xs.length ? Math.min(...xs) : 0);
  if (name === 'LEFT_FLANK') return { p: add(fr.centre, fr.left, max(across) + FLANK_GAP), dir: fr.left };
  if (name === 'RIGHT_FLANK') return { p: add(fr.centre, fr.left, min(across) - FLANK_GAP), dir: neg(fr.left) };
  if (name === 'FRONT') return { p: add(fr.centre, fr.forward, max(depth) + FLANK_GAP), dir: fr.forward };
  return { p: add(fr.centre, fr.forward, min(depth) - FLANK_GAP), dir: neg(fr.forward) };
}

const strength = (e: FieldFoe) => e.strength ?? e.men;
function nearestOf<T extends P>(xs: T[], from: P, tie: (t: T) => number): T | undefined {
  return [...xs].sort((a, b) => dist(a, from) - dist(b, from) || tie(a) - tie(b))[0];
}

/** A target name as seen from `from` by the company `self` (or the army). */
function target(name: string, from: P, ctx: Ctx, self?: FieldCompany): Target {
  const { f } = ctx;
  if (name === 'HERE') return { name, p: from, ext: 0, kind: 'here' };
  if (name === 'ME') return { name, p: { x: f.captain.x, y: f.captain.y }, ext: 1, kind: 'me' };
  const index = f.places.findIndex((p) => p.name === name);
  if (index >= 0) {
    const place = f.places[index];
    // A place's site id is its own `site` when the live game gives one (null: not a site), else its index (fixtures).
    const site = place.site === undefined ? index : (place.site ?? undefined);
    return { name, p: { x: place.x, y: place.y }, ext: 1.5, kind: 'place', site, index };
  }
  const g = f.ground.find((x) => x.name === name);
  if (g) return { name, p: groundPoint(g, from, ctx.fr.centre), ext: groundExt(g), kind: 'ground', ground: g };
  const w = f.works?.find((x) => x.name === name);
  if (w) return { name, p: { x: w.x, y: w.y }, ext: 1, kind: 'work' };
  if ((FRAME_POINTS as readonly string[]).includes(name)) {
    const { p, dir } = framePoint(name, ctx);
    return { name, p, ext: 0, kind: 'frame', dir };
  }
  const foe = (e: FieldFoe, priority?: Priority): Target => ({ name: e.id, p: { x: e.x, y: e.y }, ext: 1.5, kind: 'foe', foe: e, priority });
  const byId = f.foesSeen.find((e) => e.id === name);
  if (byId) return foe(byId);
  if (FOE_KINDS[name]) {
    const e = nearestOf(f.foesSeen.filter((x) => foeKind(x) === name), from, foeSquad);
    if (!e) return refuse(`no ${lc(name)} seen`);
    return foe(e, { by: 'unit', unit: FOE_KINDS[name].unit });
  }
  if (['NEAREST', 'WEAKEST', 'STRONGEST', 'MOST_SHAKEN'].includes(name)) {
    if (!f.foesSeen.length) return refuse('no foe seen');
    const near = (a: FieldFoe, b: FieldFoe) => dist(a, from) - dist(b, from) || foeSquad(a) - foeSquad(b);
    const pick = {
      NEAREST: (a: FieldFoe, b: FieldFoe) => near(a, b),
      WEAKEST: (a: FieldFoe, b: FieldFoe) => strength(a) - strength(b) || near(a, b),
      STRONGEST: (a: FieldFoe, b: FieldFoe) => strength(b) - strength(a) || near(a, b),
      MOST_SHAKEN: (a: FieldFoe, b: FieldFoe) => (a.morale ?? 1) - (b.morale ?? 1) || near(a, b),
    }[name as 'NEAREST']!;
    const e = [...f.foesSeen].sort(pick)[0];
    const priority: Priority | undefined = name === 'MOST_SHAKEN' ? undefined : { by: name.toLowerCase() as 'nearest' | 'weakest' | 'strongest' };
    return foe(e, priority);
  }
  // Our own companies: a name, or the nearest company of a kind, group or selector.
  const ours = select(name, ctx, self).filter((c) => c !== self);
  const c = nearestOf(ours, from, (x) => x.id);
  if (!c) return refuse(`${self?.name ?? 'the army'} cannot act on itself`);
  return { name: c.name, p: { x: c.x, y: c.y }, ext: 1.5, kind: 'ours', company: c };
}

/** "behind the ridge", "in front of the wood", "across the river", "beside Oda", "between the mill and the ford". */
function relPoint(t: Target, o: ModelOrder, from: P, ctx: Ctx, self?: FieldCompany): P {
  const { fr } = ctx;
  const reach = t.ext + REL_GAP;
  const river = t.ground?.type === 'river' ? t.ground : undefined;
  const farBank = (g: Extract<FieldGround, { type: 'river' }>, y: number): P => ({ x: fr.centre.x < g.x0 ? g.x1 + 1 + RIVER_BACK : g.x0 - RIVER_BACK, y });
  // An enemy's "behind" is its far side from us; a feature's is our side of it, away from the enemy.
  const away = t.kind === 'foe' ? fr.forward : neg(fr.forward);
  switch (o.rel) {
    case 'behind':
      return river ? { x: fr.centre.x < river.x0 ? river.x0 - RIVER_BACK : river.x1 + 1 + RIVER_BACK, y: from.y } : add(t.p, away, reach);
    case 'front':
      return river ? farBank(river, from.y) : add(t.p, neg(away), reach);
    case 'across': {
      if (!river) return add(t.p, fr.forward, reach);
      // Across a river means by a ford: the far bank at the ford nearest the company.
      const ford = [...river.fords].sort((a, b) => Math.abs(a - from.y) - Math.abs(b - from.y))[0] ?? from.y;
      return farBank(river, ford);
    }
    case 'beside': {
      const side = dot(sub(from, t.p), fr.left) >= 0 ? 1 : -1;
      return add(t.p, fr.left, side * reach);
    }
    case 'left':
      return add(t.p, fr.left, reach);
    case 'right':
      return add(t.p, fr.left, -reach);
    case 'between': {
      if (!o.and) return refuse('between needs two places');
      return mid(t.p, target(o.and, from, ctx, self).p);
    }
  }
  return t.p;
}

/** The route: "round the left" bends through a point 6 tiles out; "through the wood" passes the feature. */
function route(o: ModelOrder, from: P, to: P, ctx: Ctx, self?: FieldCompany): P[] {
  const { fr } = ctx;
  const via: P[] = [];
  if (o.by) via.push(target(o.by, mid(from, to), ctx, self).p);
  if (o.round) {
    const dir = { left: fr.left, right: neg(fr.left), front: fr.forward, back: neg(fr.forward) }[o.round];
    via.push(add(mid(from, to), dir, SIDE_SHIFT));
  }
  return via.map((p) => round2(inMap(p, ctx.f)));
}

/** 06-voice §6 "front on a feature": a line 3.2 tiles per line company, then planFront in the sim. */
function frontLine(name: string | undefined, list: FieldCompany[], ctx: Ctx): P[] {
  const { f, fr } = ctx;
  const length = LINE_PER_COMPANY * Math.max(1, list.filter((c) => LINE_KINDS.has(c.kind)).length);
  const across = (c: P): P[] => [add(c, fr.left, length / 2), add(c, fr.left, -length / 2)];
  const g = f.ground.find((x) => x.name === name);
  if (g?.type === 'river') {
    const x = fr.centre.x < g.x0 ? g.x0 - RIVER_BACK : g.x1 + 1 + RIVER_BACK;
    return [{ x, y: fr.centre.y - length / 2 }, { x, y: fr.centre.y + length / 2 }];
  }
  if (g?.type === 'hill' || g?.type === 'narrows') return across({ x: g.x, y: g.y });
  if (name === undefined || name === 'HERE') return list.map((c) => ({ x: c.x, y: c.y }));
  if (g?.type === 'wood') return across(groundPoint(g, fr.centre, fr.centre));
  return across(target(name, fr.centre, ctx).p);
}

// ---------------------------------------------------------------------------------------------
// Ways and triggers
// ---------------------------------------------------------------------------------------------

/** stance, shape and pace as the contract's How (08-orders §5). */
function howOf(o: ModelOrder): How {
  const how: How = {};
  if (o.stance === 'chase') how.pursue = true;
  else if (o.stance === 'no_chase') how.pursue = false;
  else if (o.stance === 'fire_at_will') how.stance = 'normal';
  else if (o.stance) how.stance = o.stance;
  if (o.shape === 'thin') how.files = THIN_FILES;
  else if (o.shape === 'deep') how.files = DEEP_FILES;
  else if (o.shape) how.shape = o.shape;
  if (o.pace) how.pace = o.pace;
  return how;
}

/** The signal a waiting order listens for: a named group's own, else 0 (the plain "now"). */
function signalOf(who: string[], ctx: Ctx): number {
  if (who.length === 1) {
    const i = ctx.groups.findIndex((g) => g.name === who[0]);
    if (i >= 0) return i + 1;
  }
  return 0;
}

/** The signals that release the waiting orders of these selectors (all of them for the army). */
function signalsFor(who: string[], ctx: Ctx): number[] {
  const waiting = ctx.f.waiting ?? [];
  if (!waiting.length) return refuse('nothing is waiting for a signal');
  const all = [...new Set(waiting.map((w) => w.n))].sort((a, b) => a - b);
  if (!who.length || who.includes('ARMY')) return all;
  const members = (n: string) => ctx.groups.find((g) => g.name === n)?.members ?? [n];
  const ours = new Set(who.flatMap((s) => (ctx.groups.some((g) => g.name === s) ? members(s) : select(s, ctx).map((c) => c.name))));
  const ns = waiting.filter((w) => w.who.some((n) => who.includes(n) || members(n).some((m) => ours.has(m)))).map((w) => w.n);
  if (!ns.length) return refuse(`nothing of ${who.map(lc).join(', ')} is waiting`);
  return [...new Set(ns)].sort((a, b) => a - b);
}

function whenOf(o: ModelOrder, u: Unit, ctx: Ctx): Act['when'] | undefined {
  const w = o.when;
  if (!w) return undefined;
  if (w === 'done') return { on: 'done' };
  if (w === 'mark') return { on: 'signal', n: signalOf(o.who, ctx) };
  if (w === 'attacked') return { on: 'captain_attacked' };
  if (w === 'night') return { on: 'nightfall' };
  if (w === 'dawn') return { on: 'dawn' };
  const [kind, arg] = [w.slice(0, w.indexOf(':')), w.slice(w.indexOf(':') + 1)];
  if (kind === 'after') return { on: 'after', s: Number(arg) };
  if (kind === 'near') return { on: 'enemy_near', at: round2(spotPoint(arg, ctx.fr.centre, ctx)), r: TRIGGER_R, of: arg };
  if (kind === 'breaks') {
    const t = target(arg, u.at, ctx);
    if (t.kind === 'foe') return { on: 'breaks', squad: foeSquad(t.foe!), of: t.name };
    if (t.kind === 'ours') return { on: 'breaks', squad: t.company!.id, of: t.name };
    // A selector naming only the company itself: "if you break" is not a trigger.
    return refuse(`breaks needs a company or a foe, not ${lc(arg)}`);
  }
  return refuse(`no trigger ${w}`);
}

/** The deed with a new `who`, through any `with` and `wait`. */
function withWho(d: Deed, who: Who): Deed {
  if (d.do === 'with' || d.do === 'wait') return { ...d, deed: withWho(d.deed, who) };
  return 'who' in d ? ({ ...d, who } as Deed) : d;
}
const whoOf = (d: Deed): Who | undefined => (d.do === 'with' || d.do === 'wait' ? whoOf(d.deed) : 'who' in d ? d.who : undefined);

/** Companies given the same deed share one `squads` deed (08-orders §2); different deeds stay apart. */
function merge(acts: Act[]): Deed[] {
  const out: { key: string; ids: number[]; deed: Deed }[] = [];
  for (const a of acts) {
    if (!a.deed) continue;
    const who = whoOf(a.deed);
    if (!who || who.t !== 'squad') {
      out.push({ key: '', ids: [], deed: a.deed });
      continue;
    }
    const key = JSON.stringify(withWho(a.deed, { t: 'army' }));
    const same = out.find((x) => x.key === key && x.ids.length);
    if (same) same.ids.push(who.id);
    else out.push({ key, ids: [who.id], deed: a.deed });
  }
  return out.map((x) => (x.ids.length > 1 ? withWho(x.deed, { t: 'squads', ids: x.ids }) : x.deed));
}

// ---------------------------------------------------------------------------------------------
// One order
// ---------------------------------------------------------------------------------------------

function resolveOne(o: ModelOrder, ctx: Ctx): Resolved {
  const { f, fr } = ctx;
  let { army, list } = expandWho(o.who, ctx);
  // "Commit the reserve" said to no one in particular sends in the companies held in reserve.
  if (o.do === 'commit' && army) [army, list] = [false, select('RESERVE', ctx)];
  // The sim takes a reserve or a work only from a company (as it refuses them for the army).
  if (o.do === 'reserve' && army) refuse('the army cannot be its own reserve: name a company');
  if (o.do === 'build' && army) [army, list] = [false, [builder(o, ctx)]];
  const units: Unit[] = army
    ? [{ who: { t: 'army' }, name: 'ARMY', at: { x: f.captain.x, y: f.captain.y } }]
    : list.map((c) => ({ who: { t: 'squad', id: c.id }, name: c.name, at: { x: c.x, y: c.y }, company: c }));
  const out: Resolved = {
    said: o, who: army ? 'ARMY' : list.map((c) => c.name), do: o.do, target: o.to ?? 'NONE', side: o.round ?? 'none', fight: o.fight ?? false, acts: [], deeds: [],
  };
  const acts: Act[] = [];
  const how = howOf(o);
  const need = (verb: string): string => o.to ?? refuse(`${verb} needs a target`);
  /** The point an order goes to: the target, or the point the rel names by it. */
  const pointOf = (t: Target, u: Unit) => round2(inMap(o.rel ? relPoint(t, o, u.at, ctx, u.company) : t.p, f));
  const notOurs = (t: Target) => {
    if (t.kind === 'ours' || t.kind === 'me') refuse(`will not attack our own (${lc(t.name)})`);
  };

  type Part = Omit<Act, 'who' | 'deed'> & { deed: Deed };
  /** One unit's act before `with` and `wait`. */
  const one = (u: Unit): Part | Part[] => {
    const goTo = (t: Target, fight: boolean): Part => {
      const to = pointOf(t, u);
      const via = route(o, u.at, to, ctx, u.company);
      return { do: 'move', target: t.name, to, via, fight, deed: { do: 'move', who: u.who, to, via, fight } };
    };
    const take = (t: Target): Part => {
      // Taking a place that is not a site (a ford) is holding it: going there ready to fight.
      if (t.site === undefined) return goTo(t, true);
      const via = route(o, u.at, t.p, ctx, u.company);
      return { do: 'take', target: t.name, to: t.p, via, deed: { do: 'take', who: u.who, site: t.site!, via } };
    };
    const strike = (t: Target, verb: 'attack' | 'charge'): Part => {
      const via = route(o, u.at, t.p, ctx, u.company);
      const id = foeSquad(t.foe!);
      const deed: Deed = verb === 'attack' ? { do: 'attack', who: u.who, target: id, via } : { do: 'charge', who: u.who, target: id };
      return { do: verb, target: t.name, to: t.p, via: verb === 'attack' ? via : undefined, deed, how: t.priority ? { priority: t.priority } : undefined };
    };
    const tgt = (name: string) => target(name, u.at, ctx, u.company);
    switch (o.do) {
      case 'rally':
        return { do: 'rally', deed: { do: 'rally' } };
      case 'recall': {
        if (u.company) return { do: 'recall', deed: { do: 'recall', id: u.company.id } };
        const detached = f.ours.filter((c) => c.detached);
        return detached.map((c) => ({ do: 'recall', target: c.name, deed: { do: 'recall', id: c.id } as Deed }));
      }
      case 'front': {
        const line = frontLine(o.to, army ? f.ours : list, ctx).map(round2);
        out.line = line;
        return { do: 'front', target: o.to ?? 'HERE', deed: { do: 'front', line } };
      }
      case 'move': {
        const t = tgt(need('move'));
        if (t.kind === 'me' && !o.rel) return u.company ? { do: 'recall', target: 'ME', deed: { do: 'recall', id: u.company.id } } : { do: 'rally', deed: { do: 'rally' } };
        // Going to a village the blight holds is freeing it, whatever verb was used (DECISIONS.md D-07).
        if (t.kind === 'place' && !o.rel && f.places[t.index!].type === 'village' && f.places[t.index!].holder === 'foe') return take(t);
        return goTo(t, o.fight ?? false);
      }
      case 'advance':
      case 'hold': {
        if (o.to === undefined || o.to === 'HERE') {
          if (o.do === 'hold') return { do: 'hold', target: 'HERE', deed: { do: 'hold', who: u.who } };
          if (f.held) return { do: 'advance', deed: { do: 'advance' } };
          const to = round2(add(u.at, fr.forward, ADVANCE_STEP));
          return { do: 'move', target: 'FRONT', to, via: [], fight: true, deed: { do: 'move', who: u.who, to, via: [], fight: true } };
        }
        // Holding a place is moving to it ready to fight (06-voice §4a).
        return goTo(tgt(o.to), o.fight ?? true);
      }
      case 'take': {
        const t = tgt(need('take'));
        if (t.kind === 'place' && !o.rel) return take(t);
        if (t.kind === 'foe' && !o.rel) return strike(t, 'attack');
        notOurs(t);
        return goTo(t, true);
      }
      case 'attack':
      case 'charge': {
        // "If anything gets to the ford, charge it": the foe is whoever arrives, so no target is fixed now.
        const atTrigger = o.when === `near:${o.to}` && !o.rel;
        if ((o.to === undefined || atTrigger) && o.do === 'charge') return { do: 'charge', deed: { do: 'charge', who: u.who } };
        if (atTrigger) return goTo(tgt(o.to!), true);
        const t = tgt(o.to ?? 'NEAREST');
        notOurs(t);
        if (t.kind === 'foe' && !o.rel) return strike(t, o.do);
        if (t.kind === 'place' && !o.rel) return take(t);
        return goTo(t, true);
      }
      case 'guard': {
        const t = tgt(need('guard'));
        if (t.kind === 'ours' || t.kind === 'me') {
          const ward = t.kind === 'me' ? (f.captain.id ?? 0) : t.company!.id;
          return { do: 'guard', target: t.name, deed: { do: 'guard', who: u.who, ward } };
        }
        if (t.kind === 'foe') return refuse(`cannot guard a foe (${t.name})`);
        return goTo(t, true);
      }
      case 'screen': {
        const t = tgt(need('screen'));
        if (t.kind === 'ours' || t.kind === 'me') {
          const ward = t.kind === 'me' ? (f.captain.id ?? 0) : t.company!.id;
          const from = o.from ? target(o.from, t.p, ctx) : undefined;
          if (from && from.kind !== 'foe') refuse(`screen from a foe, not ${lc(from.name)}`);
          const deed: Deed = from ? { do: 'screen', who: u.who, ward, from: foeSquad(from.foe!) } : { do: 'screen', who: u.who, ward };
          return { do: 'screen', target: t.name, from: from?.name, deed };
        }
        if (t.kind === 'foe') return refuse(`cannot screen a foe (${t.name})`);
        return goTo(t, true);
      }
      case 'withdraw': {
        if (o.to === undefined) return { do: 'withdraw', deed: { do: 'withdraw', who: u.who } };
        const t = tgt(o.to);
        const to = pointOf(t, u);
        return { do: 'withdraw', target: t.name, to, deed: { do: 'withdraw', who: u.who, to } };
      }
      case 'regroup':
        return { do: 'regroup', deed: { do: 'regroup', who: u.who } };
      case 'reserve':
        return { do: 'reserve', deed: { do: 'reserve', who: u.who } };
      case 'commit': {
        if (o.to === undefined) return { do: 'commit', deed: { do: 'commit', who: u.who } };
        const t = tgt(o.to);
        notOurs(t);
        if (t.kind !== 'foe') return goTo(t, true);
        return { do: 'commit', target: t.name, deed: { do: 'commit', who: u.who, target: foeSquad(t.foe!) }, how: t.priority ? { priority: t.priority } : undefined };
      }
      case 'face': {
        const name = o.to ?? (o.round ? { left: 'LEFT_FLANK', right: 'RIGHT_FLANK', front: 'FRONT', back: 'REAR' }[o.round] : refuse('face needs a direction'));
        const t = tgt(name);
        const d = t.dir ?? sub(pointOf(t, u), u.at);
        const face = Math.round(angle(d) * 1000) / 1000;
        return { do: 'face', target: t.name, face, deed: { do: 'face', who: u.who, face } };
      }
      case 'build': {
        const work = o.work ?? refuse('build needs a work: stakes, barricade, bridge or watchtower');
        const face = Math.round(angle(fr.forward) * 1000) / 1000;
        if (o.to === undefined || o.to === 'HERE') {
          if (work === 'bridge') refuse('a bridge must span the river');
          const at = round2(add(u.at, fr.forward, work === 'stakes' ? STAKE_AHEAD : 0));
          return { do: 'build', target: 'HERE', to: at, work, face, deed: { do: 'build', who: u.who, work, at, face } };
        }
        const t = tgt(o.to);
        if (work === 'bridge' && !onRiver(t, ctx)) refuse(`a bridge must span the river, not ${lc(t.name)}`);
        if (t.kind === 'foe') refuse(`cannot build on a foe (${t.name})`);
        const at = pointOf(t, u);
        return { do: 'build', target: t.name, to: at, work, face, deed: { do: 'build', who: u.who, work, at, face } };
      }
      case 'set': {
        const h: How = { ...how };
        if (o.to) {
          const t = tgt(o.to);
          if (t.priority) h.priority = t.priority;
        }
        if (!Object.keys(h).length) refuse('set needs a stance, shape or pace');
        return { do: 'set', how: h, deed: { do: 'set', who: u.who, how: h } };
      }
      case 'signal':
        return signalsFor(o.who, ctx).map((n) => ({ do: 'signal', n, deed: { do: 'signal', n } as Deed }));
      case 'name':
        return refuse('unreachable');
    }
    return refuse(`no verb ${o.do}`);
  };

  if (o.do === 'name') {
    const word = (o.as ?? refuse('a group needs a name')).toUpperCase();
    if (enumsTaken(f).has(word)) refuse(`${lc(word)} is already a name on the field`);
    out.group = { name: word, members: list.map((c) => c.name) };
    out.who = list.map((c) => c.name);
    out.target = word;
    for (const c of list) acts.push({ who: c.name, do: 'name', target: word });
    out.acts = acts;
    out.deeds = [];
    return out;
  }

  // Signals and army-wide deeds are one act, not one per company.
  const perArmy = o.do === 'signal' || o.do === 'rally' || o.do === 'front' || (o.do === 'advance' && f.held && o.to === undefined);
  for (const u of perArmy ? units.slice(0, 1) : units) {
    const res = one(u);
    for (const a of Array.isArray(res) ? res : [res]) {
      const act: Act & { deed: Deed } = { who: perArmy || a.do === 'signal' ? 'ARMY' : u.name, ...a };
      if (o.round && a.via?.length) act.side = o.round;
      // Modifiers wrap the deed in `with`; a `set` carries them itself.
      const h: How = o.do === 'set' ? {} : { ...how, ...(a.how ?? {}) };
      if (Object.keys(h).length) {
        act.how = h;
        act.deed = { do: 'with', how: h, deed: act.deed };
      }
      const when = whenOf(o, u, ctx);
      if (when) {
        const { of: _, ...until } = when;
        act.when = when;
        act.deed = { do: 'wait', until: until as When, deed: act.deed };
      }
      acts.push(act);
    }
  }
  if (!acts.length) refuse(o.do === 'recall' ? 'no company is detached' : `nothing to ${o.do}`);
  const first = acts[0];
  out.acts = acts;
  out.deeds = merge(acts);
  out.do = first.do;
  out.target = first.target ?? out.target;
  out.fight = first.fight ?? (first.do === 'move' ? false : true);
  out.via = first.via?.[0];
  return out;
}

/** Who builds a work ordered to the army: the free company nearest the spot, else the nearest one not fighting. */
function builder(o: ModelOrder, ctx: Ctx): FieldCompany {
  const captain = { x: ctx.f.captain.x, y: ctx.f.captain.y };
  const at = o.to === undefined || o.to === 'HERE' ? captain : target(o.to, captain, ctx).p;
  const pool = ctx.f.ours.filter(free);
  const spare = pool.length ? pool : ctx.f.ours.filter((c) => canObey(c) && c.state !== 'fighting');
  return nearestOf(spare, at, (c) => c.id) ?? refuse('no company is free to build');
}

/** A bridge's spot: the river itself, its narrows, or a place on the river's banks. */
function onRiver(t: Target, ctx: Ctx): boolean {
  if (t.ground?.type === 'river' || t.ground?.type === 'narrows') return true;
  return ctx.f.ground.some((g) => g.type === 'river' && t.p.x >= g.x0 - 2 && t.p.x <= g.x1 + 3);
}

/** Every name already in use, so a group cannot shadow a company, kind, selector or spot. */
function enumsTaken(f: Field): Set<string> {
  return new Set([
    'ARMY', 'OTHERS', 'ME', 'HERE', ...Object.keys(KIND_WORDS), ...Object.keys(PLACE_TAG), ...f.ours.map((c) => c.name), ...spotNames(f),
    ...Object.keys(FOE_KINDS), ...FRAME_POINTS,
  ]);
}
