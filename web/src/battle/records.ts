import {
  KIND_ORDER,
  NEVER,
  SOLDIER_F32 as F,
  SOLDIER_TICKS as T,
  SQUAD_F32 as Q,
  TICK_HZ,
  soldierBits as sb,
  squadBits as qb,
  squadUnit,
  type Team,
  type Views,
} from '../contracts';
import type { BannerRecord, ManRecord } from '../view/figures';
import { FOG_SIGHT } from '../view/fog';

// The records the figure layer draws, built each frame from the sim's packed buffers (04-battle.md §9,
// 02-look.md §3 and §6). Zero garbage: the record objects are pooled and rewritten in place.
//
// - Men: the sim's position, facing (already in §9's priority order: motion, target, squad), pace, strikes, and
//   the hit and death ages from the sim's ticks. The figure layer eases, turns and poses them.
// - Banners: one per company still on the field, on its commander (or the middle of its men), eased like a man.
// - Fog: enemies and the dead are drawn only on tiles in sight; our living men always are. Men who left the field
//   (not alive, never died) are not drawn at all.

const ST_FIGHTING = 2;
const ST_ROUTING = 3;
const ST_FLED = 4;
const ST_DESTROYED = 5;
/** 04-battle.md §9: the drawn position follows the sim's by 1 − e^(−16·dt); the banner too. */
const EASE = 16;
/** The banner stands this far to its bearer's left (tiles), so the pole doesn't run through him. */
const BEARER_LEFT = 0.3;

export interface RecordsInput {
  views: Views;
  /** One byte per map tile, whose sight decides what is drawn (0 never seen, 1 seen before, 2 in sight). */
  fog: Uint8Array;
  soldiers: number;
  squads: number;
  /** Ticks stepped so far, and the seconds accumulated since the last one. */
  tick: number;
  acc: number;
  /** Real seconds since the last frame (0 freezes the banners' easing). */
  dt: number;
  mapW: number;
  mapH: number;
  /** Whose fog decides what is drawn. */
  team: Team;
  ground: (x: number, y: number) => number;
}

function newMan(): ManRecord {
  return {
    id: 0, x: 0, y: 0, h: 0, face: 0, speed: 0, kind: 'spear', unit: 'spear', team: 0, rank: 0, commander: false,
    captain: false, routing: false, alive: true, recruit: false, strikes: 0, hitAge: Infinity, deathAge: 0, engaged: false,
    aimX: undefined, aimY: undefined, breathAge: Infinity, backing: false,
  };
}

function newBanner(): BannerRecord {
  return {
    id: 0, x: 0, y: 0, h: 0, face: 0, speed: 0, heart: 1, lost: 0, size: 1, rank: 0, honours: 0, kind: 'spear',
    unit: 'spear', team: 0, linen: false, captain: false, routing: false, selected: false, hover: false, unfurl: 1,
  };
}

export class Records {
  readonly men: ManRecord[] = [];
  readonly banners: BannerRecord[] = [];
  /** Figures left out by the fog this frame (men + banners). */
  hidden = 0;
  private readonly manPool: ManRecord[] = [];
  private readonly bannerPool: BannerRecord[] = [];
  // per squad: sums over the living men, and the commander's soldier index (−1 if none alive)
  private sumX = new Float64Array(0);
  private sumY = new Float64Array(0);
  private sumV = new Float64Array(0);
  private count = new Uint16Array(0);
  private cmdr = new Int32Array(0);
  // per squad: the banner's drawn position, and whether it was drawn last frame (else it snaps)
  private bx = new Float64Array(0);
  private by = new Float64Array(0);
  private seen = new Uint8Array(0);

  build(f: RecordsInput): void {
    const { views: v, soldiers: n, squads: q } = f;
    this.ensure(q);
    this.sumX.fill(0, 0, q);
    this.sumY.fill(0, 0, q);
    this.sumV.fill(0, 0, q);
    this.count.fill(0, 0, q);
    this.cmdr.fill(-1, 0, q);
    this.hidden = 0;
    const fog = f.fog;
    const inSight = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= f.mapW || y >= f.mapH) return false;
      return fog[Math.floor(y) * f.mapW + Math.floor(x)] === FOG_SIGHT;
    };
    const age = (at: number): number => (at === NEVER ? Infinity : Math.max(0, (f.tick - 1 - at) / TICK_HZ + f.acc));

    let m = 0;
    for (let k = 0; k < n; k++) {
      const bits = v.u32[k];
      const o = k * F.FIELDS;
      const x = v.f32[o + F.X];
      const y = v.f32[o + F.Y];
      const squad = sb.squad(bits);
      const alive = sb.alive(bits);
      const team = sb.team(bits);
      if (alive) {
        this.sumX[squad] += x;
        this.sumY[squad] += y;
        this.sumV[squad] += v.f32[o + F.SPEED];
        this.count[squad]++;
        if (sb.commander(bits)) this.cmdr[squad] = k;
      }
      // a man not alive who never died left the field with his fleeing company: nothing to draw
      if (!alive && v.ticks[k * T.FIELDS + T.DIED_AT] === NEVER) continue;
      if (!((alive && team === f.team) || inSight(x, y))) {
        this.hidden++;
        continue;
      }
      const r = (this.manPool[m] ??= newMan());
      this.men[m++] = r;
      r.id = k;
      r.x = x;
      r.y = y;
      r.h = f.ground(x, y);
      r.face = v.f32[o + F.FACE];
      r.speed = v.f32[o + F.SPEED];
      r.kind = KIND_ORDER[sb.kind(bits)];
      r.unit = squadUnit(v.squadUnit[squad]);
      r.team = team;
      r.rank = sb.rank(bits);
      r.commander = sb.commander(bits);
      r.captain = sb.captain(bits);
      r.routing = sb.routing(bits);
      r.alive = alive;
      r.recruit = sb.recruit(bits);
      r.strikes = v.strikes[k];
      r.hitAge = age(v.ticks[k * T.FIELDS + T.HIT_AT]);
      r.deathAge = alive ? 0 : age(v.ticks[k * T.FIELDS + T.DIED_AT]);
      // a drake's breath cycle, from the tick the sim began it (04-battle.md §5 "Drake breath")
      r.breathAge = age(v.ticks[k * T.FIELDS + T.BREATH_AT]);
      r.backing = sb.backing(bits);
      // the guard and shooting stances while his company fights, or while he himself is in contact or shooting
      r.engaged = qb.state(v.squadU32[squad]) === ST_FIGHTING || sb.engaged(bits);
      const ax = v.f32[o + F.AIM_X];
      r.aimX = Number.isNaN(ax) ? undefined : ax;
      r.aimY = Number.isNaN(ax) ? undefined : v.f32[o + F.AIM_Y];
    }
    this.men.length = m;

    const k16 = 1 - Math.exp(-EASE * f.dt);
    let b = 0;
    for (let j = 0; j < q; j++) {
      const bits = v.squadU32[j];
      const state = qb.state(bits);
      const live = this.count[j];
      if (state === ST_FLED || state === ST_DESTROYED || live === 0) {
        this.seen[j] = 0;
        continue;
      }
      const o = j * Q.FIELDS;
      const face = v.squadF32[o + Q.FACE];
      let tx: number;
      let ty: number;
      const c = this.cmdr[j];
      if (c >= 0) {
        tx = v.f32[c * F.FIELDS + F.X] + Math.sin(face) * BEARER_LEFT;
        ty = v.f32[c * F.FIELDS + F.Y] - Math.cos(face) * BEARER_LEFT;
      } else {
        tx = this.sumX[j] / live;
        ty = this.sumY[j] / live;
      }
      if (this.seen[j]) {
        this.bx[j] += (tx - this.bx[j]) * k16;
        this.by[j] += (ty - this.by[j]) * k16;
      } else {
        this.bx[j] = tx;
        this.by[j] = ty;
      }
      const team = qb.team(bits);
      if (team !== f.team && !inSight(this.bx[j], this.by[j])) {
        this.seen[j] = 0;
        this.hidden++;
        continue;
      }
      this.seen[j] = 1;
      const kind = KIND_ORDER[qb.kind(bits)];
      // Civilians crossing the ford are not a company: no banner over them (04-battle.md §8).
      if (kind === 'folk') continue;
      const r = (this.bannerPool[b] ??= newBanner());
      this.banners[b++] = r;
      r.id = j;
      r.x = this.bx[j];
      r.y = this.by[j];
      r.h = f.ground(r.x, r.y);
      r.face = face;
      r.speed = this.sumV[j] / live;
      r.heart = v.squadF32[o + Q.MORALE];
      r.size = qb.full(bits);
      r.lost = Math.max(0, r.size - live);
      r.rank = qb.rank(bits);
      r.kind = kind;
      r.unit = squadUnit(v.squadUnit[j]);
      r.team = team;
      r.captain = kind === 'captain';
      // the freed villages' levy carry plain linen until rank 2 (out/decisions-figures.md)
      r.linen = kind === 'levy' && team === 0 && r.rank < 2;
      r.routing = state === ST_ROUTING;
    }
    this.banners.length = b;
  }

  /** The middle of company j's living men as built this frame (sim tiles), or null if none live. */
  centre(j: number): { x: number; y: number } | null {
    const n = j < this.count.length ? this.count[j] : 0;
    return n > 0 ? { x: this.sumX[j] / n, y: this.sumY[j] / n } : null;
  }

  private ensure(q: number): void {
    if (this.count.length >= q) return;
    const cap = Math.max(64, q * 2);
    const grow = <A extends Float64Array | Uint8Array>(a: A, make: (n: number) => A): A => {
      const out = make(cap);
      out.set(a);
      return out;
    };
    this.sumX = new Float64Array(cap);
    this.sumY = new Float64Array(cap);
    this.sumV = new Float64Array(cap);
    this.count = new Uint16Array(cap);
    this.cmdr = new Int32Array(cap);
    this.bx = grow(this.bx, (k) => new Float64Array(k));
    this.by = grow(this.by, (k) => new Float64Array(k));
    this.seen = grow(this.seen, (k) => new Uint8Array(k));
  }
}
