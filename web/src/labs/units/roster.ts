import type { Kind, Team, Unit } from '../../contracts';
import { FWD, RIGHT } from '../../view/camera';
import { folkVariant, type BannerRecord, type ManRecord } from '../../view/figures';
import { outfit, type Look } from '../../view/figures/outfit';

// The lab's cast: every kind of the warband for both teams, and the blight (blight-men, trolls, drakes, the
// broodlord and their standards), in rows, with a banner per company kind. Positions are put on the art-pixel
// lattice of the current zoom (offsets of whole pixels along the screen axes from the focus), so in the drift checks
// every figure crosses a pixel at the same moment.

/** `back`: walking backwards while facing ahead (a drake springing back: the stride in reverse). */
export type Pose = 'stand' | 'march' | 'fight' | 'rout' | 'death' | 'back';
export const POSES: Pose[] = ['stand', 'march', 'fight', 'rout', 'death', 'back'];
/** Which rows: the warband for each team (day 2's lab), the blight alone, or our warband over the blight. */
export type RosterName = 'warband' | 'blight' | 'both';

interface Slot {
  label: string;
  kind: Kind;
  unit?: Unit;
  team?: Team;
  captain?: boolean;
  commander?: boolean;
  /** Folk variant wanted: the lab finds an id that gives it. */
  folk?: 'man' | 'woman' | 'child';
  /** A look wanted (a blight-man's weapon, a troll's maul): the lab finds an id that gives it. */
  want?: (l: Look) => boolean;
  banner?: boolean;
  /** Room along the row, tiles (default COL). */
  width?: number;
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

/** The blight's roster (team 1): blight-men by weapon and their pack-leader, trolls, drakes, the broodlord. */
export const BLIGHT_SLOTS: Slot[] = [
  { label: 'blight club', kind: 'levy', unit: 'blightman', want: (l) => l.arms === 'club' && !l.mantle, banner: true },
  { label: 'blight cleaver', kind: 'levy', unit: 'blightman', want: (l) => l.arms === 'cleaver' && l.mantle },
  { label: 'blight claws', kind: 'levy', unit: 'blightman', want: (l) => l.arms === 'claws' },
  { label: 'blight leader', kind: 'levy', unit: 'blightman', commander: true, want: (l) => l.arms === 'club' },
  { label: 'troll', kind: 'beast', unit: 'troll', want: (l) => !l.maul, banner: true, width: 1.9 },
  { label: 'troll maul', kind: 'beast', unit: 'troll', want: (l) => l.maul, width: 1.9 },
  { label: 'drake', kind: 'beast', unit: 'drake', banner: true, width: 2.3 },
  { label: 'drake leader', kind: 'beast', unit: 'drake', commander: true, width: 2.3 },
  { label: 'broodlord', kind: 'captain', unit: 'broodlord', captain: true, banner: true, width: 2.2 },
];

/** Speeds (04-battle.md §2; crates/sim/src/tune.rs `Units`) and strike intervals for the march and fight poses. */
const SPEED: Record<Kind, number> = { spear: 1.6, shield: 1.3, archer: 1.6, horse: 3.2, levy: 1.5, folk: 1, captain: 3, beast: 2 };
const INTERVAL: Record<Kind, number> = { spear: 1.0, shield: 1.0, archer: 1.6, horse: 1.1, levy: 1.1, folk: 9, captain: 0.8, beast: 1.5 };
const UNIT_SPEED: Partial<Record<Unit, number>> = { blightman: 1.5, troll: 1.3, drake: 2.2, broodlord: 2.4 };
const UNIT_INTERVAL: Partial<Record<Unit, number>> = { blightman: 1.1, troll: 2.2, drake: 3.2, broodlord: 1.2 };
/** The drakes' breath cycle (04-battle.md §5): its period. */
const BREATH_PERIOD = 3.2;

export interface Cast {
  roster: RosterName;
  /** The warband's teams (roster 'warband'). */
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
  /** Drakes held at this many seconds into their breath cycle (null: they breathe while fighting). */
  breath: number | null;
}

/** The id used for slot `i` of team `t`; folk and blight slots search for an id that gives the look they show. */
function idFor(i: number, t: Team, slot: Slot): number {
  const id = slot.unit ? 500 + i * 7 : 100 + t * 50 + i * 3;
  if (slot.folk) {
    for (let k = 0; k < 400; k++) {
      const v = folkVariant(id + k);
      const kind = v.child ? 'child' : v.woman ? 'woman' : 'man';
      if (kind === slot.folk) return id + k;
    }
  }
  if (slot.want) {
    for (let k = 0; k < 400; k++) {
      const who = { id: id + k, kind: slot.kind, unit: slot.unit ?? 'spear', team: t, rank: 0, commander: !!slot.commander, captain: !!slot.captain, recruit: false };
      if (slot.want(outfit(who))) return id + k;
    }
  }
  // spread beard and hair types over the roster
  return id;
}

/** The id of the first figure the cast shows (the flicker check follows its whole-pixel steps). */
export function firstId(cast: Cast): number {
  return cast.roster === 'blight' ? idFor(0, 1, BLIGHT_SLOTS[0]) : idFor(0, cast.roster === 'both' ? 0 : cast.teams[0], SLOTS[0]);
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
  const rows: { slots: Slot[]; team: Team }[] =
    cast.roster === 'warband' ? cast.teams.map((team) => ({ slots: SLOTS, team })) :
    cast.roster === 'blight' ? [{ slots: BLIGHT_SLOTS, team: 1 }] :
    [{ slots: SLOTS, team: 0 }, { slots: BLIGHT_SLOTS, team: 1 }];
  rows.forEach(({ slots, team }, row) => {
    const rowF = rows.length === 1 ? 0 : row === 0 ? -ROW / 2 : ROW / 2;
    const widths = slots.map((sl) => sl.width ?? COL);
    const total = widths.reduce((a, w) => a + w, 0);
    let at = -total / 2;
    slots.forEach((slot, i) => {
      const across = at + widths[i] / 2;
      at += widths[i];
      const [ox, oy] = latticeOffset(across, rowF, s);
      const x = focus.x + ox + cast.driftX;
      const y = focus.y + oy + cast.driftY;
      const p = cast.pose;
      const id = idFor(i, team, slot);
      const unit: Unit = slot.unit ?? (slot.captain ? 'captain' : (slot.kind as Unit));
      const pace = UNIT_SPEED[unit] ?? SPEED[slot.kind];
      let speed = 0;
      let face = cast.face;
      if (p === 'march') speed = pace;
      if (p === 'back') speed = pace * 0.8;
      if (p === 'rout') {
        speed = pace * 1.25;
        face += Math.PI;
      }
      const interval = UNIT_INTERVAL[unit] ?? INTERVAL[slot.kind];
      const strikes = p === 'fight' ? Math.floor(cast.poseT / interval + (i % 3) * 0.31) : 0;
      const aimR = slot.kind === 'archer' ? 6 : 1.2;
      const breathAge = cast.breath ?? (p === 'fight' ? (cast.poseT + (i % 2) * 0.9) % BREATH_PERIOD : Infinity);
      men.push({
        id,
        x,
        y,
        h: 0,
        face,
        speed,
        kind: slot.kind,
        unit,
        team: slot.team ?? team,
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
        breathAge: unit === 'drake' ? breathAge : Infinity,
        backing: p === 'back',
      });
      if (cast.banners && slot.banner) {
        const [bx, by] = latticeOffset(across - 0.45, rowF + 1.1, s);
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
          unit,
          team,
          linen: slot.kind === 'levy' && team === 0 && cast.rank < 2,
          captain: !!slot.captain,
          routing: p === 'rout',
        });
      }
    });
  });
  return { men, banners };
}
