// Turning the reply's names and sides into the game's deeds, in code (docs/spec/06-voice.md §6). The model
// never gives coordinates. Pure and deterministic.

import type { Deed, P, Who } from '../contracts.ts';
import { KIND_WORDS, type Field, type FieldCompany, type FieldGround } from './field.ts';
import type { Do, ModelOrder, Reply, Side } from './orders.ts';

const SIDE_SHIFT = 6;
const RIVER_BACK = 2.5;
const LINE_PER_COMPANY = 3.2;
const LINE_KINDS = new Set(['spear', 'shield', 'levy']);

export interface Resolved {
  /** 'ARMY' for an order to the army, else the companies it names. */
  who: 'ARMY' | string[];
  do: Do;
  target: string;
  side: Side;
  fight: boolean;
  deeds: Deed[];
  via?: P;
  line?: P[];
}

export interface Refused {
  order: ModelOrder;
  why: string;
}

const add = (a: P, b: P, k = 1): P => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const centroid = (ps: P[]): P => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length });

/** The army's frame: forward from the centroid to the threat point, and left = (f.y, −f.x). */
export function frame(f: Field): { centre: P; forward: P; left: P } {
  const centre = centroid(f.ours.map((c) => ({ x: c.x, y: c.y })));
  const dx = f.threatPoint.x - centre.x;
  const dy = f.threatPoint.y - centre.y;
  const d = Math.hypot(dx, dy) || 1;
  const forward = { x: dx / d, y: dy / d };
  return { centre, forward, left: { x: forward.y, y: -forward.x } };
}

export function resolve(reply: Reply, f: Field): { orders: Resolved[]; refused: Refused[] } {
  const orders: Resolved[] = [];
  const refused: Refused[] = [];
  const named = new Set<string>();
  const fr = frame(f);
  for (const o of reply.orders) {
    try {
      const companies = expandWho(o.who, f, named);
      const r = resolveOne(o, companies, f, fr);
      if (r.who !== 'ARMY') r.who.forEach((n) => named.add(n));
      orders.push(r);
    } catch (e) {
      refused.push({ order: o, why: (e as Error).message });
    }
  }
  return { orders, refused };
}

/** ARMY, OTHERS, kind words and names into companies. Naming every company is an order to the army. */
function expandWho(who: string[], f: Field, named: Set<string>): 'ARMY' | FieldCompany[] {
  if (who.includes('ARMY')) return 'ARMY';
  const out = new Map<string, FieldCompany>();
  for (const w of who) {
    const kind = KIND_WORDS[w];
    const pick =
      w === 'OTHERS' ? f.ours.filter((c) => !named.has(c.name)) : kind ? f.ours.filter((c) => c.kind === kind) : f.ours.filter((c) => c.name === w);
    if (!pick.length) throw new Error(`no company for ${w}`);
    pick.forEach((c) => out.set(c.name, c));
  }
  const list = [...out.values()];
  return list.length === f.ours.length && list.length > 1 ? 'ARMY' : list;
}

function resolveOne(o: ModelOrder, companies: 'ARMY' | FieldCompany[], f: Field, fr: ReturnType<typeof frame>): Resolved {
  const army = companies === 'ARMY';
  const units: { who: Who; at: P }[] = army
    ? [{ who: { t: 'army' }, at: { x: f.captain.x, y: f.captain.y } }]
    : companies.map((c) => ({ who: { t: 'squad', id: c.id }, at: { x: c.x, y: c.y } }));
  const out: Resolved = { who: army ? 'ARMY' : companies.map((c) => c.name), do: o.do, target: o.target, side: o.side, fight: o.fight, deeds: [] };
  const sideShift = (from: P, to: P): P[] => {
    const dir = { left: fr.left, right: { x: -fr.left.x, y: -fr.left.y }, front: fr.forward, back: { x: -fr.forward.x, y: -fr.forward.y } }[o.side as Exclude<Side, 'none'>];
    if (!dir) return [];
    const via = add(mid(from, to), dir, SIDE_SHIFT);
    out.via = via;
    return [via];
  };
  const place = f.places.findIndex((p) => p.name === o.target);
  const foe = f.foesSeen.find((e) => e.id === o.target);
  const ground = f.ground.find((g) => g.name === o.target);
  /** Where the target is for a unit standing at `from`. */
  const point = (from: P): P => {
    if (place >= 0) return { x: f.places[place].x, y: f.places[place].y };
    if (foe) return { x: foe.x, y: foe.y };
    if (ground) return groundPoint(ground, from, fr.centre);
    if (o.target === 'HERE') return from;
    throw new Error(`${o.do} needs a target`);
  };

  switch (o.do) {
    case 'rally':
      out.deeds.push({ do: 'rally' });
      break;
    case 'recall':
      if (army) for (const c of f.ours.filter((c) => c.detached)) out.deeds.push({ do: 'recall', id: c.id });
      else for (const c of companies) out.deeds.push({ do: 'recall', id: c.id });
      break;
    case 'front':
      out.line = frontLine(o.target, companies, f, fr);
      out.deeds.push({ do: 'front', line: out.line });
      break;
    case 'hold':
      // Holding a place is moving to it ready to fight (§4a); holding with no place stands where it is.
      if (o.target !== 'NONE' && o.target !== 'HERE') [out.do, out.fight] = ['move', true];
      for (const u of units) {
        if (out.do === 'hold') out.deeds.push({ do: 'hold', who: u.who });
        else out.deeds.push({ do: 'move', who: u.who, to: point(u.at), via: [], fight: true });
      }
      break;
    case 'attack':
    case 'take':
    case 'move': {
      // What the deed really is: attacking a place takes it; taking a hill or a wood is moving there to fight.
      // Going to a village the blight holds is freeing it, whatever verb was used (DECISIONS.md D-07).
      if (o.do === 'attack' && !foe && place < 0) throw new Error(`attack needs a foe, not ${o.target}`);
      const freeing = place >= 0 && f.places[place].type === 'village' && f.places[place].holder === 'foe';
      out.do = o.do === 'attack' && foe ? 'attack' : (o.do !== 'move' || freeing) && place >= 0 ? 'take' : 'move';
      out.fight = out.do === 'move' ? o.fight || o.do !== 'move' : true;
      for (const u of units) {
        const to = point(u.at);
        const via = sideShift(u.at, to);
        if (out.do === 'attack') out.deeds.push({ do: 'attack', who: u.who, target: Number(foe!.id.slice(1)), via });
        else if (out.do === 'take') out.deeds.push({ do: 'take', who: u.who, site: place, via });
        else out.deeds.push({ do: 'move', who: u.who, to, via, fight: out.fight });
      }
      break;
    }
  }
  return out;
}

/** A hill's crest; a wood's edge nearest `from`; a river's near bank (our side) level with `from`. */
function groundPoint(g: FieldGround, from: P, centre: P): P {
  if (g.type === 'hill') return { x: g.x, y: g.y };
  if (g.type === 'wood') return { x: Math.max(g.x0, Math.min(g.x1 + 1, from.x)), y: Math.max(g.y0, Math.min(g.y1 + 1, from.y)) };
  return { x: centre.x < g.x0 ? g.x0 - 0.5 : g.x1 + 1.5, y: from.y };
}

/** 06-voice §6 "front on a feature": a line 3.2 tiles per line company, then planFront in the sim. */
function frontLine(target: string, companies: 'ARMY' | FieldCompany[], f: Field, fr: ReturnType<typeof frame>): P[] {
  const list = companies === 'ARMY' ? f.ours : companies;
  const length = LINE_PER_COMPANY * Math.max(1, list.filter((c) => LINE_KINDS.has(c.kind)).length);
  const g = f.ground.find((x) => x.name === target);
  const across = (c: P): P[] => [add(c, fr.left, length / 2), add(c, fr.left, -length / 2)];
  if (g?.type === 'river') {
    const x = fr.centre.x < g.x0 ? g.x0 - RIVER_BACK : g.x1 + 1 + RIVER_BACK;
    return [{ x, y: fr.centre.y - length / 2 }, { x, y: fr.centre.y + length / 2 }];
  }
  if (g?.type === 'hill') return across({ x: g.x, y: g.y });
  if (target === 'HERE') return list.map((c) => ({ x: c.x, y: c.y }));
  const place = f.places.find((p) => p.name === target);
  if (place) return across({ x: place.x, y: place.y });
  if (g?.type === 'wood') return across(groundPoint(g, fr.centre, fr.centre));
  throw new Error(`no line along ${target}`);
}
