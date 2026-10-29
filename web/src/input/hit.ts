import { soldierBits, squadBits, type P } from '../contracts';
import type { BattleView } from '../battle/battle';
import { snapFigure } from '../view/figures';
import type { Screen } from './screen';
import {
  CAPTAIN_SCORE,
  CAPTAIN_SCORE_SELECTED,
  FLAG_SCORE,
  KING_REACH_SELECTED,
  SITE_EXTRA,
  thresholds,
} from './thresholds';

// Hit-testing (docs/spec/01-flow.md §2 "Hit-testing"): settled where the press lands, against the world as the
// player saw it (each man where he was drawn, each banner where it stood), measured in screen pixels to the segment
// from each man's feet to his head and to each banner's pole; beasts add four points round their bodies. Scored,
// and the nearest wins: the captain ×0.65 (×0.45 while a company is selected) so he wins ties ("he is the handle
// for the whole army"), order flags ×0.7, a selected company anywhere inside its ground oval. Otherwise the hit is
// the ground, with the nearest site within capture radius + 0.4 tiles.

export type HitKind = 'captain' | 'company' | 'enemy' | 'flag' | 'ground';

export interface Hit {
  kind: HitKind;
  /** The company hit (the captain's, an enemy's, a flag's company); −1 for the ground. */
  squad: number;
  /** The ground under the point (sim tiles). */
  ground: P;
  /** For a ground hit: the nearest site within capture radius + 0.4, else −1. */
  site: number;
  /** CSS pixels from the point to what was hit (0 for the ground), and its score. */
  dist: number;
  score: number;
  /** A routing company: it takes no orders, but tapping it shows its face. */
  routing: boolean;
}

/** Top of the head above the feet, tiles, by unit (figures: FIG 1.32 × the body's height in part units). */
const HEAD: Record<string, number> = {
  spear: 0.76, shield: 0.76, archer: 0.76, levy: 0.76, folk: 0.7, horse: 1.04, captain: 1.12,
  blightman: 0.95, troll: 1.75, drake: 1.05, broodlord: 2.0,
};
/** A commander stands ×1.16 (figures' outfit). */
const COMMANDER_SCALE = 1.16;
/** Banner poles (02-look.md §6, figures' poseBanner): 1.6 tall, the captain's 1.95, a beast standard's 2.4, grown
 * to 18 px per tile when zoomed out, ×1.3 while selected. */
const POLE = { company: 1.6, captain: 1.95, beast: 2.4 };
/** An order flag's height (marks.ts `Pen.flag`). */
export const FLAG_H = 1.15;
/** Beasts' four extra points sit this far out (× the body's radius) at half their height. */
const BEAST_OUT = 1.6;
/** A horse's body, tail to nose, is measured too (chosen: the rider's segment alone left the horse's head and rump
 * out of reach when zoomed in): half its length and its height, tiles (figures: HORSE ×FIG 1.32). */
const MOUNTED = new Set(['horse', 'captain']);
const HORSE_HALF = 0.42;
const HORSE_Y = 0.45;

const ST_ROUTING = 3;

/** The oval a selected company answers inside (the selection ellipse). */
export interface Oval {
  c: P;
  /** Half-axes along the facing and across it, and the facing. */
  a: number;
  b: number;
  face: number;
}

export function insideOval(o: Oval, p: P): boolean {
  const dx = p.x - o.c.x;
  const dy = p.y - o.c.y;
  const f = Math.cos(o.face);
  const g = Math.sin(o.face);
  const u = (dx * f + dy * g) / o.a;
  const v = (-dx * g + dy * f) / o.b;
  return u * u + v * v <= 1;
}

/** Distance from p to the segment ab (CSS px). */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

const KIND_RANK: Record<HitKind, number> = { captain: 0, flag: 1, company: 2, enemy: 3, ground: 4 };

export class HitTester {
  private readonly a = { x: 0, y: 0 };
  private readonly b = { x: 0, y: 0 };
  private readonly snap = { x: 0, y: 0, z: 0, px: 0, py: 0 };

  constructor(
    private readonly battle: BattleView,
    private readonly screen: Screen,
  ) {}

  /**
   * What the CSS point (canvas top-left origin) hits, with the selected company (if any) as it is now. `seen`, if
   * given, collects every candidate within reach (for measuring).
   */
  test(x: number, y: number, touchish: boolean, seen?: { kind: HitKind; squad: number; d: number; score: number }[]): Hit {
    const t = thresholds(touchish);
    const bt = this.battle;
    const sel = bt.ui.selected;
    const selected = sel !== null;
    const ground = this.screen.ground(x, y);
    let best: Hit = { kind: 'ground', squad: -1, ground, site: -1, dist: 0, score: Infinity, routing: false };
    const offer = (kind: HitKind, squad: number, d: number, reach: number, k: number) => {
      if (d > reach) return;
      const score = d * k;
      seen?.push({ kind, squad, d, score });
      if (score < best.score || (score === best.score && KIND_RANK[kind] < KIND_RANK[best.kind])) {
        best = { kind, squad, ground, site: -1, dist: d, score, routing: false };
      }
    };
    const v = bt.views;
    const team = bt.team;
    const s = this.screen.s;
    const kingReach = t.kingReach * (selected ? KING_REACH_SELECTED : 1);
    const kingK = selected ? CAPTAIN_SCORE_SELECTED : CAPTAIN_SCORE;
    // men, as drawn this frame
    for (const m of bt.records.men) {
      if (!m.alive) continue;
      const at = bt.figures.drawnAt(m.id);
      if (at) this.screen.fromArt(at.px, at.py, this.a);
      else this.screen.project(m.x, m.h, m.y, this.a);
      const head = (HEAD[m.unit] ?? 0.8) * (m.commander && !m.captain ? COMMANDER_SCALE : 1);
      const rise = this.screen.rise(head);
      let d = segDist(x, y, this.a.x, this.a.y, this.a.x, this.a.y - rise);
      const squad = soldierBits.squad(v.u32[m.id]);
      if (MOUNTED.has(m.unit)) {
        const cx = at ? at.x : m.x;
        const cz = at ? at.z : m.y;
        const cy = (at ? at.y : m.h) + HORSE_Y;
        const k = HORSE_HALF * (m.captain ? 1.08 : 1);
        this.screen.project(cx + Math.cos(m.face) * k, cy, cz + Math.sin(m.face) * k, this.b);
        const nx = this.b.x, ny = this.b.y;
        this.screen.project(cx - Math.cos(m.face) * k, cy, cz - Math.sin(m.face) * k, this.b);
        d = Math.min(d, segDist(x, y, nx, ny, this.b.x, this.b.y));
      }
      if (m.kind === 'beast') {
        const r = (bt.squadInfo[squad]?.radius ?? 0.5) * BEAST_OUT;
        const cx = at ? at.x : m.x;
        const cz = at ? at.z : m.y;
        const ch = (at ? at.y : m.h) + head / 2;
        for (let q = 0; q < 4; q++) {
          const ang = m.face + (q * Math.PI) / 2;
          this.screen.project(cx + Math.cos(ang) * r, ch, cz + Math.sin(ang) * r, this.b);
          d = Math.min(d, Math.hypot(x - this.b.x, y - this.b.y));
        }
      }
      if (m.team !== team) offer('enemy', squad, d, t.reach, 1);
      else if (m.captain) offer('captain', squad, d, kingReach, kingK);
      else offer('company', squad, d, t.companyReach, 1);
    }
    // banner poles
    const grow = Math.max(1, Math.min(2.4, 18 / s));
    for (const b of bt.records.banners) {
      if (b.routing) continue;
      snapFigure(b.x, b.y, b.h, s, this.snap);
      this.screen.fromArt(this.snap.px, this.snap.py, this.a);
      const H = (b.captain ? POLE.captain : b.kind === 'beast' ? POLE.beast : POLE.company) * grow * (b.selected ? 1.3 : 1);
      const d = segDist(x, y, this.a.x, this.a.y, this.a.x, this.a.y - this.screen.rise(H));
      if (b.team !== team) offer('enemy', b.id, d, t.reach, 1);
      else if (b.captain) offer('captain', b.id, d, kingReach, kingK);
      else offer('company', b.id, d, t.companyReach, 1);
    }
    // order flags
    for (const o of bt.orders.squads) {
      if (!o.flag) continue;
      const h = bt.groundH(o.flag[0], o.flag[1]);
      this.screen.project(o.flag[0], h, o.flag[1], this.a);
      const d = segDist(x, y, this.a.x, this.a.y, this.a.x, this.a.y - this.screen.rise(FLAG_H));
      offer('flag', o.id, d, t.reach, FLAG_SCORE);
    }
    // a selected company answers anywhere inside its ground oval
    if (sel !== null) {
      const oval = bt.oval(sel);
      if (oval && insideOval(oval, ground)) offer('company', sel, Math.min(best.kind === 'company' && best.squad === sel ? best.dist : t.companyReach, t.companyReach), t.companyReach, 1);
    }
    if (best.kind === 'company') best.routing = squadBits.state(v.squadU32[best.squad]) === ST_ROUTING;
    if (best.kind === 'ground') {
      best.score = 0;
      best.site = this.siteAt(ground);
    }
    return best;
  }

  /** The nearest site within capture radius + 0.4 tiles of a ground point, else −1. */
  siteAt(p: P): number {
    const sites = this.battle.sites;
    let best = -1;
    let bd = sites.r + SITE_EXTRA;
    for (const st of sites.sites) {
      const d = Math.hypot(st.x - p.x, st.y - p.y);
      if (d <= bd) {
        bd = d;
        best = st.id;
      }
    }
    return best;
  }
}
