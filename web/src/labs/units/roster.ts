import type { Kind, Team } from '../../contracts';
import { FWD, RIGHT } from '../../view/camera';
import { folkVariant, type BannerRecord, type ManRecord } from '../../view/figures';

// The lab's cast: every kind for both teams, in rows, with a banner per company kind. Positions are put on the
// art-pixel lattice of the current zoom (offsets of whole pixels along the screen axes from the focus), so in
// the drift checks every figure crosses a pixel at the same moment.

export type Pose = 'stand' | 'march' | 'fight' | 'rout' | 'death';
export const POSES: Pose[] = ['stand', 'march', 'fight', 'rout', 'death'];

interface Slot {
  label: string;
  kind: Kind;
  captain?: boolean;
  commander?: boolean;
  /** Folk variant wanted: the lab finds an id that gives it. */
  folk?: 'man' | 'woman' | 'child';
  banner?: boolean;
}

export const SLOTS: Slot[] = [
  { label: 'spear', kind: 'spear', banner: true },
  { label: 'shield', kind: 'shield', banner: true },
  { label: 'archer', kind: 'archer', banner: true },
  { label: 'horse', kind: 'horse', banner: true },
  { label: 'captain', kind: 'captain', captain: true, banner: true },
  { label: 'levy', kind: 'levy', banner: true },
  { label: 'commander', kind: 'spear', commander: true },
  { label: 'folk', kind: 'folk', folk: 'man' },
  { label: 'woman', kind: 'folk', folk: 'woman' },
  { label: 'child', kind: 'folk', folk: 'child' },
];

/** Speeds (04-battle.md §2) and strike intervals for the march and fight poses. */
const SPEED: Record<Kind, number> = { spear: 1.6, shield: 1.3, archer: 1.6, horse: 3.2, levy: 1.5, folk: 1, captain: 3, beast: 2 };
const INTERVAL: Record<Kind, number> = { spear: 1.0, shield: 1.0, archer: 1.6, horse: 1.1, levy: 1.1, folk: 9, captain: 0.8, beast: 1.5 };

export interface Cast {
  teams: Team[];
  rank: number;
  pose: Pose;
  /** Sim facing for everyone (radians). */
  face: number;
  /** Seconds since the pose was set (lab clock): strike counters and death ages come from it. */
  poseT: number;
  /** Sub-pixel drift of the figures, sim tiles. */
  driftX: number;
  driftY: number;
  /** Hit flash test: seconds since a hit (Infinity = none). */
  hitAge: number;
  banners: boolean;
  /** Banner state for the heraldry checks. */
  heart: number;
  lost: number;
  honours: number;
}

/** The id used for slot `i` of team `t`; folk slots search for an id that gives the variant they show. */
function idFor(i: number, t: Team, slot: Slot): number {
  let id = 100 + t * 50 + i * 3;
  if (slot.folk) {
    for (let k = 0; k < 400; k++) {
      const v = folkVariant(id + k);
      const kind = v.child ? 'child' : v.woman ? 'woman' : 'man';
      if (kind === slot.folk) return id + k;
    }
  }
  // spread beard and hair types over the roster
  return id;
}

/** Column spacing (tiles along the screen's right) and row spacing (tiles along the ground's forward). */
export const COL = 1.25;
export const ROW = 4.4;

/** Lattice offset: `a` tiles across and `f` tiles forward on flat ground, rounded to whole art pixels at zoom s. */
export function latticeOffset(a: number, f: number, s: number): [number, number] {
  const across = Math.round(a * s) / s;
  // moving d forward on flat ground moves the screen's up by d·sin(30°)
  const fwd = (2 * Math.round((f * s) / 2)) / s;
  return [RIGHT.x * across + FWD.x * fwd, RIGHT.z * across + FWD.z * fwd];
}

export function buildRecords(cast: Cast, focus: { x: number; y: number }, s: number): { men: ManRecord[]; banners: BannerRecord[] } {
  const men: ManRecord[] = [];
  const banners: BannerRecord[] = [];
  const n = SLOTS.length;
  cast.teams.forEach((team, row) => {
    const rowF = cast.teams.length === 1 ? 0 : row === 0 ? -ROW / 2 : ROW / 2;
    SLOTS.forEach((slot, i) => {
      const [ox, oy] = latticeOffset((i - (n - 1) / 2) * COL, rowF, s);
      const x = focus.x + ox + cast.driftX;
      const y = focus.y + oy + cast.driftY;
      const p = cast.pose;
      const id = idFor(i, team, slot);
      let speed = 0;
      let face = cast.face;
      if (p === 'march') speed = SPEED[slot.kind];
      if (p === 'rout') {
        speed = SPEED[slot.kind] * 1.25;
        face += Math.PI;
      }
      const interval = INTERVAL[slot.kind];
      const strikes = p === 'fight' ? Math.floor(cast.poseT / interval + (i % 3) * 0.31) : 0;
      const aimR = slot.kind === 'archer' ? 6 : 1.2;
      men.push({
        id,
        x,
        y,
        h: 0,
        face,
        speed,
        kind: slot.kind,
        team,
        rank: cast.rank,
        commander: !!slot.commander,
        captain: !!slot.captain,
        routing: p === 'rout',
        alive: p !== 'death',
        recruit: false,
        strikes,
        hitAge: cast.hitAge,
        deathAge: p === 'death' ? cast.poseT : 0,
        engaged: p === 'fight',
        aimX: p === 'fight' ? x + Math.cos(face) * aimR : undefined,
        aimY: p === 'fight' ? y + Math.sin(face) * aimR : undefined,
      });
      if (cast.banners && slot.banner) {
        const [bx, by] = latticeOffset((i - (n - 1) / 2) * COL - 0.45, rowF + 1.1, s);
        banners.push({
          id: 1000 + team * 100 + i,
          x: focus.x + bx + cast.driftX,
          y: focus.y + by + cast.driftY,
          h: 0,
          face,
          speed,
          heart: cast.heart,
          lost: cast.lost,
          size: 12,
          rank: cast.rank,
          honours: cast.honours,
          kind: slot.kind,
          team,
          linen: slot.kind === 'levy' && cast.rank < 2,
          captain: !!slot.captain,
          routing: p === 'rout',
        });
      }
    });
  });
  return { men, banners };
}
