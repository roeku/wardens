import { BLIGHTMAN, BROOD_BODY, DRAKE, TROLL_BODY, type BruteBody } from './blight-parts';
import { tatterStage, type BannerLook, type Sigil } from './atlas';
import { hash32 } from './hash';
import { frame, ident, m4, mul, point, rotX, rotY, rotZ, scale, translate, type M4 } from './mat';
import type { Form } from './outfit';
import { BLIGHT, BONE, EMBER, FLAME } from './palette';
import { BANNER, type PartId } from './parts';
import { AT, emit, FIG, fitCloth, HIT_FLASH, registerRig, smooth, thrust, TOPPLE, WALK_MIN, type FigState, type RigCtx } from './rig';
import { snapFigure, type Snapped } from './snap';
import type { BannerRecord, ManRecord } from './types';

// The blight's bodies posed (00-start-here.md §A2; 02-look.md §5 "Animation"; 04-battle.md §5 "Beasts", "Drake
// breath", §9): hunched blight-men, stone trolls with the impact blow's wind-up, the broodlord, and drakes with the
// breath cycle (rear, jet, bite) driven from the tick the sim began it, the hunt's lunge and spring back (the stride
// in reverse), and the flame. Like the men: procedural joint matrices written into the shared part instances, no
// vertical bob, every figure on the art-pixel grid. Choices: out/decisions-blight-view.md.

/** Beasts turn at 2.2 rad/s (04-battle.md §9); blight-men are men-sized and turn as men do. */
const BEAST_TURN = 2.2;
/** Stride (04-battle.md §9): men 3.6, beasts 3, drakes 3.4. */
const STRIDE_MAN = 3.6;
const STRIDE_BEAST = 3;
const STRIDE_DRAKE = 3.4;

/**
 * The blows' `impact` (04-battle.md §5 "Myth rules": the blow lands that many seconds after it starts), as the sim's
 * unit table sets them (crates/sim/src/tune.rs `Units`): the troll 0.5 s, the broodlord 0.35 s. The sim's strike
 * counter changes when a blow starts, so the wind-up plays first and the blow falls on the impact.
 */
const TROLL_IMPACT = 0.5;
/** A corpse's cracks and eyes: the ember gone out, the blight's darkest step. */
const COLD = BLIGHT[0];
/** Where the broodlord's horns grow from on its skull (head frame): a longer pair is scaled about it. */
const HORN_ROOT = [-0.015, 0.075] as const;
const BROOD_IMPACT = 0.35;
/** A blight-man's chop (seconds): the men's sword blow, a little slower and wilder. */
const CHOP_T = 0.35;

/** The breath cycle (04-battle.md §5; crates/sim/src/tune.rs `BreathTune`), seconds from the start of a cycle. */
const BREATH = {
  rear: 0.4,
  jet: 1.2,
  tail: 0.55,
  bite: 2.3,
  period: 3.2,
  lungeBefore: 0.45,
  /** The cone reaches 2.3 from a root 1 tile ahead, half-angle 0.3, sweeping ±0.3 across its pulses. */
  reach: 2.3,
  root: 1,
  halfAngle: 0.3,
  sweep: 0.3,
  /** The first and last pulses (every 0.25 s of the jet; ceil(1.2/0.25) = 5 of them): the sweep runs between them. */
  sweepSpan: 1.0,
} as const;

type Arm4 = readonly [number, number, number, number];

/** Keyframes (t, a, b, c) with smoothstep between keys; t is past the last key → the last. */
function keyed(keys: readonly Arm4[], t: number, out: number[]): void {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const a = keys[i], b = keys[i + 1];
  const f = smooth((t - a[0]) / Math.max(1e-6, b[0] - a[0]));
  for (let j = 0; j < 3; j++) out[j] = a[j + 1] + (b[j + 1] - a[j + 1]) * f;
}

// Blow tables in "world" angles, each measured from straight down toward the front (0 hanging, π/2 level ahead, π
// straight up): (t s, the upper arm's swing, the elbow's bend, the weapon's angle). The torso's hunch is added when
// posing, so the tables read the same for a hunched blight-man and an upright troll.
const CHOP_GUARD: readonly [number, number, number] = [1.0, 1.25, 3.0];
const CHOP: readonly Arm4[] = [
  [0, ...CHOP_GUARD],
  [0.4 * CHOP_T, 2.8, 0.8, 4.2],
  [0.62 * CHOP_T, 0.8, 0.15, 1.2],
  [CHOP_T, ...CHOP_GUARD],
];
const SLAM_GUARD: readonly [number, number, number] = [0.75, 0.95, 2.6];
/** The troll's slam: wound up over the head by 0.8 of the impact, down on the impact, held, recovered. */
const SLAM: readonly Arm4[] = [
  [0, ...SLAM_GUARD],
  [0.8 * TROLL_IMPACT, 3.1, 0.55, 4.4],
  [TROLL_IMPACT, 0.75, 0.05, 1.25],
  [TROLL_IMPACT + 0.25, 0.75, 0.05, 1.25],
  [TROLL_IMPACT + 0.55, ...SLAM_GUARD],
];
/** The broodlord's claw: raised and back by 0.7 of the impact, raked down across on it (the third value: across). */
const SWIPE_GUARD: readonly [number, number, number] = [1.0, 0.8, 0.25];
const SWIPE: readonly Arm4[] = [
  [0, ...SWIPE_GUARD],
  [0.7 * BROOD_IMPACT, 2.5, 1.0, 0.7],
  [BROOD_IMPACT, 0.6, 0.2, -0.35],
  [BROOD_IMPACT + 0.35, ...SWIPE_GUARD],
];

interface BruteRig {
  body: BruteBody;
  leg: PartId;
  torso: PartId;
  head: PartId;
  eyes: PartId;
  uarm: PartId;
  farm: PartId;
  hand: PartId;
  rags?: PartId;
  crack?: PartId;
  armCrack?: PartId;
  mane?: PartId;
  tail?: PartId;
  horns?: PartId;
  heart?: PartId;
  blow: 'chop' | 'slam' | 'swipe';
  /** The weapon arm when not fighting: swing, bend, the weapon's angle (world, as the blow tables). */
  carry: readonly [number, number, number];
  /** How far the body lies off the ground when dead (part units), rolled onto its side. */
  lie: number;
  /** The hand's grip below the wrist. */
  grip: number;
}

const BLIGHTMAN_RIG: BruteRig = {
  body: BLIGHTMAN,
  leg: 'bmLeg',
  torso: 'bmTorso',
  head: 'bmHead',
  eyes: 'bmEyes',
  uarm: 'bmUarm',
  farm: 'bmFarm',
  hand: 'bmHand',
  rags: 'bmRags',
  crack: 'bmCrack',
  blow: 'chop',
  carry: [0.3, 1.55, 3.35],
  lie: 0.11,
  grip: -0.03,
};
const TROLL_RIG: BruteRig = {
  body: TROLL_BODY,
  leg: 'trLeg',
  torso: 'trTorso',
  head: 'trHead',
  eyes: 'trEyes',
  uarm: 'trUarm',
  farm: 'trFarm',
  hand: 'trHand',
  rags: 'trRags',
  crack: 'trCracks',
  armCrack: 'trArmCrack',
  blow: 'slam',
  carry: [0.3, 2.15, 3.75],
  lie: 0.15,
  grip: -0.045,
};
const BROOD_RIG: BruteRig = {
  body: BROOD_BODY,
  leg: 'blLeg',
  torso: 'blTorso',
  head: 'blHead',
  eyes: 'blEyes',
  uarm: 'blUarm',
  farm: 'blFarm',
  hand: 'blHand',
  rags: 'bmRags',
  mane: 'blMane',
  tail: 'blTail',
  horns: 'blHorns',
  heart: 'blHeart',
  blow: 'swipe',
  carry: [0.28, 0.42, 0],
  lie: 0.14,
  grip: -0.04,
};

// ---------------------------------------------------------------------------------------------------------- brutes

const ROOT = m4();
const PEL = m4();
const TOR = m4();
const HEAD = m4();
const SH = m4();
const UA = m4();
const FA = m4();
const HD = m4();
const HDR = m4();
const TMP = m4();
const TMP2 = m4();
const W = m4();
const I = m4();
const P = [0, 0, 0];
const ARM_R = [0, 0, 0];
const ARM_L = [0, 0, 0];
const UP = [0, 1, 0];

/** One arm by forward kinematics from its shoulder frame: swing forward, elbow bend, out from the body. */
function armFK(sh: M4, th: number, bend: number, abduct: number, upper: number, fore: number, ua: M4, fa: M4, hand: M4): void {
  ua.set(sh);
  rotX(ua, abduct);
  rotZ(ua, th);
  fa.set(ua);
  translate(fa, 0, -upper, 0);
  rotZ(fa, bend);
  hand.set(fa);
  translate(hand, 0, -fore, 0);
}

function poseBrute(c: RigCtx, st: FigState, rec: ManRecord, R: BruteRig): void {
  const L = st.look;
  const B = R.body;
  const alive = rec.alive;
  const rout = rec.routing && alive;
  const engaged = !!rec.engaged && alive && !rout;
  const moving = alive && st.speed > WALK_MIN;
  const swing = moving ? Math.sin(st.phase) * Math.min(0.7, 0.25 + 0.3 * st.speed) : 0;
  const flash = rec.hitAge < HIT_FLASH;
  const tpu = FIG * L.scale;
  const seed = hash32(st.id, 7, 0xc1a5);

  snapFigure(st.x, st.y, st.h, c.zoom, st.at);
  AT[0] = st.at.x;
  AT[1] = st.at.y;
  AT[2] = st.at.z;
  ident(ROOT);
  rotY(ROOT, -st.face);
  scale(ROOT, tpu, tpu, tpu);
  let fall = 0;
  if (!alive) {
    fall = smooth(Math.min(1, rec.deathAge / TOPPLE));
    translate(ROOT, 0, fall * R.lie, 0);
    rotX(ROOT, fall * (Math.PI / 2) * (seed & 1 ? 1 : -1) * 0.92);
  }

  // ---------------------------------------------------------------- the blow
  const sT = st.strikeT;
  let lean = 0;
  // weapon arm (right) and off arm (left): world swing, bend, and the weapon's angle (or the arm's reach across)
  const wr = ARM_R, wl = ARM_L;
  let abR = B.rest[2], abL = B.rest[2];
  let striking = false;
  if (engaged) {
    if (R.blow === 'chop') {
      if (sT < CHOP_T) {
        keyed(CHOP, sT, wr);
        lean += Math.sin((sT / CHOP_T) * Math.PI) * 0.2;
        striking = true;
      } else wr.splice(0, 3, ...CHOP_GUARD);
      wl[0] = 0.85;
      wl[1] = 0.75;
      wl[2] = 0;
    } else if (R.blow === 'slam') {
      const end = SLAM[SLAM.length - 1][0];
      if (sT < end) {
        keyed(SLAM, sT, wr);
        // lean back in the wind-up, throw the body into the blow as it falls
        lean += sT < TROLL_IMPACT ? -0.12 * smooth(sT / (0.8 * TROLL_IMPACT)) : 0.3 * (1 - smooth((sT - TROLL_IMPACT - 0.15) / 0.4));
        striking = true;
      } else wr.splice(0, 3, ...SLAM_GUARD);
      wl[0] = wr[0] * 0.75;
      wl[1] = wr[1];
      wl[2] = 0;
    } else {
      // the broodlord rakes with each arm in turn
      const end = SWIPE[SWIPE.length - 1][0];
      const raking = sT < end ? (st.strikes & 1 ? wr : wl) : null;
      wr.splice(0, 3, ...SWIPE_GUARD);
      wl.splice(0, 3, ...SWIPE_GUARD);
      if (raking) {
        keyed(SWIPE, sT, raking);
        lean += Math.sin(Math.min(1, sT / end) * Math.PI) * 0.22;
        striking = true;
      }
      abR = B.rest[2] + (wr[2] - 0.25) * 0.8;
      abL = B.rest[2] + (wl[2] - 0.25) * 0.8;
    }
  }
  if (rout) lean = 0.22;

  // ---------------------------------------------------------------- legs, hips, torso, head
  let legL = swing;
  let legR = -swing;
  if (engaged && !moving) {
    legL = 0.2;
    legR = -0.14;
  }
  if (!alive) {
    legL = 0.12;
    legR = -0.08;
  }
  ident(PEL);
  translate(PEL, 0, B.hip, 0);
  // a heavy body rolls a little from foot to foot (no bob: the root never rises)
  if (moving && R.blow !== 'chop') rotX(PEL, swing * 0.08);
  for (let li = 0; li < 2; li++) {
    const side = li === 0 ? -1 : 1;
    TMP.set(PEL);
    translate(TMP, 0, 0, side * B.hipHalf);
    rotX(TMP, -side * 0.05);
    rotZ(TMP, li === 0 ? legL : legR);
    emit(c, R.leg, ROOT, TMP, L.flesh, flash, tpu);
  }
  if (R.rags) {
    TMP.set(PEL);
    if (R.blow === 'swipe') scale(TMP, 1.3, 1, 1.3);
    emit(c, R.rags, ROOT, TMP, L.hide, flash, tpu);
  }
  if (R.tail) {
    TMP.set(PEL);
    rotY(TMP, moving ? Math.sin(st.phase * 0.5) * 0.25 : 0);
    emit(c, R.tail, ROOT, TMP, L.flesh, flash, tpu);
  }
  const tilt = B.hunch + lean;
  ident(TOR).set(PEL);
  if (moving && R.blow !== 'chop') rotX(TOR, -swing * 0.12);
  rotZ(TOR, -tilt);
  emit(c, R.torso, ROOT, TOR, L.flesh, flash, tpu);
  if (L.mantle) emit(c, 'bmMantle', ROOT, TOR, L.hide, flash, tpu);
  // the mane is dyed (MANE unless a broodlord's face gives another, person.ts `brute`)
  if (R.mane && L.maneShape > 0) emit(c, L.maneShape === 1 ? 'blCrest' : R.mane, ROOT, TOR, L.mane, flash, tpu);
  // the ember goes out of the dead
  const ember = alive ? EMBER : COLD;
  if (R.crack) emit(c, R.crack, ROOT, TOR, ember, flash, tpu);
  // the heart burns in the eyes' glow: the ember (hotter while it strikes), or a broodlord's green or pale
  if (R.heart) emit(c, R.heart, ROOT, TOR, !alive ? COLD : L.eyes !== FLAME[1] ? L.eyes : striking ? FLAME[2] : FLAME[1], flash, tpu);
  ident(HEAD).set(TOR);
  translate(HEAD, B.neck[0], B.neck[1], 0);
  // the head looks ahead again (and up at whom it strikes); dead, it sags
  rotZ(HEAD, B.headLift + lean * 0.7 + (engaged ? 0.08 : 0));
  if (!alive) rotZ(HEAD, -0.35);
  // a broodlord's face picks its muzzle: the bull's, a boar's snout, an ape's jaw (person.ts `brute`)
  emit(c, R.blow === 'swipe' && L.muzzle === 1 ? 'blHead1' : R.blow === 'swipe' && L.muzzle === 2 ? 'blHead2' : R.head, ROOT, HEAD, L.flesh, flash, tpu);
  emit(c, R.eyes, ROOT, HEAD, alive ? L.eyes : COLD, flash, tpu);
  if (R.horns) {
    // a broodlord's face picks its horns and their length, grown about their roots on the skull (person.ts `brute`)
    // bone horns are the fixed-colour parts; black or ash ones the dyed copies
    const bone = L.hornColour === BONE;
    const horns: PartId = bone ? (L.horns === 1 ? 'blHorns1' : L.horns === 2 ? 'blHorns2' : R.horns) : L.horns === 1 ? 'blHornsD1' : L.horns === 2 ? 'blHornsD2' : 'blHornsD0';
    const dye = bone ? null : L.hornColour;
    if (L.hornLen === 1) emit(c, horns, ROOT, HEAD, dye, flash, tpu);
    else {
      TMP.set(HEAD);
      translate(TMP, HORN_ROOT[0], HORN_ROOT[1], 0);
      scale(TMP, L.hornLen, L.hornLen, L.hornLen);
      translate(TMP, -HORN_ROOT[0], -HORN_ROOT[1], 0);
      emit(c, horns, ROOT, TMP, dye, flash, tpu * L.hornLen);
    }
  }
  if (rec.commander && R.blow === 'chop') emit(c, 'bmCrown', ROOT, HEAD, null, flash, tpu);

  // ---------------------------------------------------------------- arms
  // the rest pose and the walk's counter-swing, in world angles; the torso's tilt is added to hang them true
  const [r0, r1] = B.rest;
  let thL = r0 - swing * 0.7, bendL = r1 + Math.max(0, -swing) * 0.5;
  let thR = r0 + swing * 0.7, bendR = r1 + Math.max(0, swing) * 0.5;
  const armed = R.blow !== 'swipe' && L.arms !== 'claws';
  let held = 0;
  if (armed) {
    // the weapon arm carries: a club up before him, a troll's on his shoulder
    thR = R.carry[0] + swing * 0.3;
    bendR = R.carry[1];
    held = R.carry[2] + swing * 0.3;
  }
  if (engaged) {
    thR = wr[0];
    bendR = wr[1];
    thL = wl[0];
    bendL = wl[1];
    held = wr[2];
  }
  // the weapon's angle from the forearm's perpendicular (the hand frame's +x)
  const blade = held - (thR + bendR) - Math.PI / 2;
  if (rout) {
    thL = 0.6 - swing * 1.6;
    thR = 0.6 + swing * 1.6;
    bendL = bendR = 1.1;
  } else if (!alive) {
    thL = thR = 2.5 - tilt;
    bendL = bendR = 0.2;
    abL = abR = 0.3;
  }
  const up = B.upperArm, fore = B.forearm;
  for (let side = 0; side < 2; side++) {
    const left = side === 0;
    ident(SH).set(TOR);
    translate(SH, 0, B.shoulder, (left ? -1 : 1) * B.shoulderHalf);
    armFK(SH, (left ? thL : thR) + tilt, left ? bendL : bendR, left ? abL : -abR, up, fore, UA, FA, HD);
    emit(c, R.uarm, ROOT, UA, L.flesh, flash, tpu);
    emit(c, R.farm, ROOT, FA, L.flesh, flash, tpu);
    if (R.armCrack) emit(c, R.armCrack, ROOT, FA, ember, flash, tpu);
    emit(c, R.hand, ROOT, HD, L.flesh, flash, tpu);
    if (!left) HDR.set(HD);
  }

  // ---------------------------------------------------------------- weapons (the dead drop them)
  if (!alive || rout) return;
  let weapon: PartId | null = null;
  if (R.blow === 'slam') weapon = L.maul ? 'trMaul' : 'trClub';
  else if (R.blow === 'chop') weapon = L.arms === 'club' ? 'bmClub' : L.arms === 'cleaver' ? 'bmCleaver' : L.arms === 'spear' ? 'bmSpear' : null;
  if (!weapon) return;
  if (weapon === 'bmSpear') {
    // a spear: upright at the right hand, levelled along the facing when the company fights, thrust on a strike
    point(P, HDR, 0, R.grip, 0);
    ident(TMP);
    if (engaged) {
      translate(TMP, P[0] + 0.12 * thrust(sT), P[1], P[2]);
      rotZ(TMP, -Math.PI / 2 + 0.1);
    } else {
      translate(TMP, P[0], Math.max(P[1], 0.34), P[2]);
      rotZ(TMP, moving ? -0.12 : -0.05);
    }
    emit(c, weapon, ROOT, TMP, null, flash, tpu);
    return;
  }
  ident(TMP).set(HDR);
  translate(TMP, 0, R.grip, 0);
  rotZ(TMP, blade - Math.PI / 2);
  emit(c, weapon, ROOT, TMP, null, flash, tpu);
}

// ---------------------------------------------------------------------------------------------------------- drakes

const BODY = m4();
const NECK = m4();
const DHEAD = m4();
const FROOT = m4();
const TAIL = m4();
const M3 = [0, 0, 0];
const D3 = [0, 0, 0];

/** Neck segment pitches and the head's, at rest, rearing, in the jet, and in the bite's lunge (radians). */
const NECK_REST = [0.95, 0.32, -0.4];
const NECK_REAR = [1.2, 0.55, 0.0];
const NECK_JET = [0.16, -0.08, -0.16];
const NECK_BITE = [0.2, -0.12, -0.24];
const NECK_DEAD = [-0.05, -0.05, 0];
const HEAD_REST = -0.75;
const HEAD_REAR = -1.1;
const HEAD_JET = -0.12;
const HEAD_BITE = -0.05;
/** Tail segments' droop (positive bends the tail down), and how each is drawn smaller than the one before. */
const TAIL_DROOP = [0.34, 0.2, 0.1, 0, -0.1, -0.14];
const TAIL_TAPER = 0.86;
/** Front-left with hind-right, front-right with hind-left (as the horse). */
const DRAKE_LEGS: readonly (readonly [boolean, number, number])[] = [
  [true, -1, 0],
  [true, 1, Math.PI],
  [false, -1, Math.PI],
  [false, 1, 0],
];

interface Breath {
  rear: number;
  jet: number;
  bite: number;
  jaw: number;
  /** The head's sweep toward the figure's right (the sim's heading + sweep). */
  sweep: number;
  /** The flame: how far the jet reaches (0..1), how far it has faded, and how much of its near end is gone. */
  ext: number;
  fade: number;
  eaten: number;
}
const BR: Breath = { rear: 0, jet: 0, bite: 0, jaw: 0, sweep: 0, ext: 0, fade: 0, eaten: 0 };

/** The breath cycle's pose weights at `e` seconds from its start (04-battle.md §5 "Drake breath"). */
export function breathAt(e: number, out: Breath = BR): Breath {
  out.rear = out.jet = out.bite = out.sweep = out.ext = out.fade = out.eaten = 0;
  out.jaw = 0.06;
  if (!(e >= 0) || e > BREATH.period + 0.4) return out;
  const jetEnd = BREATH.rear + BREATH.jet;
  // rear: the head rises and draws back until the jet; the jet thrusts it forward and low
  if (e < BREATH.rear) out.rear = smooth(e / (BREATH.rear * 0.75));
  else if (e < jetEnd) {
    out.jet = smooth((e - BREATH.rear) / 0.12);
    out.rear = 1 - out.jet;
  } else out.jet = 1 - smooth((e - jetEnd) / 0.4);
  // the bite's lunge (0.45 s before it), the snap on the bite, and back
  const lunge = BREATH.bite - BREATH.lungeBefore;
  if (e >= lunge) out.bite = e < BREATH.bite ? smooth((e - lunge) / BREATH.lungeBefore) : 1 - smooth((e - BREATH.bite) / 0.35);
  // the jaw: agape while rearing and in the jet, wide before the bite and shut on it
  let jaw = out.jaw + 0.3 * out.rear + 0.72 * out.jet;
  if (e >= BREATH.bite - 0.38 && e < BREATH.bite) {
    const k = e < BREATH.bite - 0.1 ? smooth((e - (BREATH.bite - 0.38)) / 0.2) : (BREATH.bite - e) / 0.1;
    jaw = Math.max(jaw, 0.85 * k);
  }
  out.jaw = jaw;
  // the sweep across the pulses, from the figure's left to its right, held to the end of the jet, then back
  const s0 = BREATH.rear;
  if (e >= s0 && e < jetEnd + BREATH.tail) {
    const k = Math.min(1, (e - s0) / BREATH.sweepSpan);
    out.sweep = (-1 + 2 * k) * BREATH.sweep * (e < jetEnd ? 1 : 1 - smooth((e - jetEnd) / BREATH.tail));
    out.ext = smooth((e - s0) / 0.15);
    if (e >= jetEnd) {
      const t = (e - jetEnd) / BREATH.tail;
      out.fade = t;
      out.eaten = smooth(t) * 0.75;
    }
  }
  return out;
}

const mixA = (rest: readonly number[], i: number, b: Breath, rear: readonly number[], jet: readonly number[], bite: readonly number[]) =>
  rest[i] + b.rear * (rear[i] - rest[i]) + b.jet * (jet[i] - rest[i]) + b.bite * (bite[i] - rest[i]);

function poseDrake(c: RigCtx, st: FigState, rec: ManRecord): void {
  const L = st.look;
  const alive = rec.alive;
  const moving = alive && st.speed > WALK_MIN;
  const ph = st.phase;
  const amp = moving ? Math.min(0.55, 0.18 + 0.22 * st.speed) : 0;
  const flash = rec.hitAge < HIT_FLASH;
  const tpu = FIG * L.scale;
  const seed = hash32(st.id, 7, 0xc1a5);
  const b = breathAt(alive && !rec.routing ? rec.breathAge ?? Infinity : Infinity);

  snapFigure(st.x, st.y, st.h, c.zoom, st.at);
  AT[0] = st.at.x;
  AT[1] = st.at.y;
  AT[2] = st.at.z;
  ident(ROOT);
  rotY(ROOT, -st.face);
  scale(ROOT, tpu, tpu, tpu);
  let fall = 0;
  if (!alive) {
    fall = smooth(Math.min(1, rec.deathAge / TOPPLE));
    translate(ROOT, 0, fall * 0.085, 0);
    rotX(ROOT, fall * (Math.PI / 2) * (seed & 1 ? 1 : -1) * 0.92);
  }

  // the body pitches up about the hips as it rears, and down into the jet and the lunge
  const pitch = 0.15 * b.rear - 0.05 * b.jet - 0.05 * b.bite;
  const hx = DRAKE.hind[0];
  ident(BODY);
  translate(BODY, hx, DRAKE.body, 0);
  rotZ(BODY, pitch);
  translate(BODY, -hx, 0, 0);
  emit(c, 'drBody', ROOT, BODY, L.flesh, flash, tpu);
  emit(c, 'drWings', ROOT, BODY, L.flesh, flash, tpu);
  const ember = alive ? EMBER : COLD;
  emit(c, 'drSeams', ROOT, BODY, ember, flash, tpu);

  // legs: diagonal pairs; the forelegs reach forward as it rears; a dead drake's legs splay
  for (const [front, side, off] of DRAKE_LEGS) {
    const p = ph + off;
    const a = fall > 0 ? fall * 0.5 * side : amp * Math.sin(p);
    const fold = moving ? 1.1 * Math.max(0, Math.cos(p)) : 0;
    const j = front ? DRAKE.front : DRAKE.hind;
    ident(TMP).set(BODY);
    translate(TMP, j[0], j[1], j[2] * side);
    if (front) {
      rotZ(TMP, a - 0.1 + 0.55 * b.rear);
      emit(c, 'drArmU', ROOT, TMP, L.flesh, flash, tpu);
      translate(TMP, 0, -DRAKE.upper, 0);
      rotZ(TMP, 0.2 - fold - 0.6 * b.rear);
      emit(c, 'drArmL', ROOT, TMP, L.flesh, flash, tpu);
    } else {
      rotZ(TMP, a + 0.3 - pitch);
      emit(c, 'drThigh', ROOT, TMP, L.flesh, flash, tpu);
      translate(TMP, 0, -DRAKE.thigh, 0);
      rotZ(TMP, -0.6 - fold);
      emit(c, 'drShin', ROOT, TMP, L.flesh, flash, tpu);
    }
  }

  // the neck: three segments, turned by the sweep at its base; the head; the jaw
  const hot = b.rear + b.jet > 0.1;
  ident(NECK).set(BODY);
  translate(NECK, DRAKE.neckBase[0], DRAKE.neckBase[1], 0);
  rotY(NECK, -b.sweep * b.jet);
  const nod = moving ? Math.sin(1.5 * ph) * 0.06 : 0;
  for (let i = 0; i < DRAKE.necks; i++) {
    const a = !alive ? NECK_DEAD[i] * fall + NECK_REST[i] * (1 - fall) : mixA(NECK_REST, i, b, NECK_REAR, NECK_JET, NECK_BITE) + (i === 0 ? nod : 0);
    rotZ(NECK, rec.routing && alive ? a - 0.25 : a);
    emit(c, 'drNeck', ROOT, NECK, L.flesh, flash, tpu);
    emit(c, 'drThroat', ROOT, NECK, hot ? FLAME[2] : ember, flash, tpu);
    translate(NECK, DRAKE.neckSeg, 0, 0);
  }
  ident(DHEAD).set(NECK);
  rotZ(DHEAD, alive ? HEAD_REST + b.rear * (HEAD_REAR - HEAD_REST) + b.jet * (HEAD_JET - HEAD_REST) + b.bite * (HEAD_BITE - HEAD_REST) : HEAD_REST * (1 - fall));
  emit(c, 'drHead', ROOT, DHEAD, L.flesh, flash, tpu);
  emit(c, 'drHorns', ROOT, DHEAD, null, flash, tpu);
  emit(c, 'drEyes', ROOT, DHEAD, alive ? FLAME[1] : COLD, flash, tpu);
  ident(TMP).set(DHEAD);
  translate(TMP, DRAKE.hinge[0], DRAKE.hinge[1], 0);
  rotZ(TMP, -b.jaw * 0.7);
  emit(c, 'drJaw', ROOT, TMP, L.flesh, flash, tpu);
  if (b.jaw > 0.18) emit(c, 'drMaw', ROOT, DHEAD, b.jet > 0.3 ? FLAME[3] : FLAME[1], flash, tpu);

  // the tail: tapering segments drooping behind, swaying with the walk
  ident(TAIL).set(BODY);
  translate(TAIL, DRAKE.tailBase[0], DRAKE.tailBase[1], 0);
  let k = 1;
  for (let i = 0; i < DRAKE.tails; i++) {
    const sway = moving ? Math.sin(ph * 0.5 - i * 0.7) * 0.13 : 0;
    rotY(TAIL, sway);
    rotZ(TAIL, TAIL_DROOP[i] - (i === 0 ? pitch : 0));
    ident(TMP).set(TAIL);
    scale(TMP, k, k, k);
    emit(c, 'drTail', ROOT, TMP, L.flesh, flash, tpu);
    translate(TAIL, -DRAKE.tailSeg * k, 0, 0);
    k *= TAIL_TAPER;
  }
  ident(TMP).set(TAIL);
  scale(TMP, k, k, k);
  emit(c, 'drTailTip', ROOT, TMP, null, flash, tpu);

  // the flame: from the mouth to the far end of the cone (its root 1 tile ahead, reaching 2.3, half-angle 0.3)
  if (alive && b.ext > 0 && b.fade < 1) {
    point(M3, DHEAD, DRAKE.mouth[0], DRAKE.mouth[1], DRAKE.mouth[2]);
    for (let i = 0; i < 3; i++) M3[i] *= tpu;
    const far = BREATH.root + BREATH.reach;
    D3[0] = far * Math.cos(b.sweep) - M3[0];
    D3[1] = -M3[1] * 0.92;
    D3[2] = far * Math.sin(b.sweep) - M3[2];
    const len = Math.hypot(D3[0], D3[1], D3[2]);
    ident(FROOT);
    rotY(FROOT, -st.face);
    frame(TMP, I, M3, D3, UP);
    scale(TMP, len, 0.32, BREATH.reach * Math.tan(BREATH.halfAngle));
    mul(W, FROOT, TMP);
    c.pool.add('flame', W, AT, 1, 1, 1, b.ext, b.fade, (st.id % 61) / 7, b.eaten);
  }
}

// ---------------------------------------------------------------------------------------------------------- rigs

registerRig('blightman', { pose: (c, st, rec) => poseBrute(c, st, rec, BLIGHTMAN_RIG), stride: STRIDE_MAN });
registerRig('troll', { pose: (c, st, rec) => poseBrute(c, st, rec, TROLL_RIG), stride: STRIDE_BEAST, turn: BEAST_TURN });
registerRig('broodlord', { pose: (c, st, rec) => poseBrute(c, st, rec, BROOD_RIG), stride: STRIDE_BEAST, turn: BEAST_TURN });
registerRig('drake', { pose: poseDrake, stride: STRIDE_DRAKE, turn: BEAST_TURN });

// ---------------------------------------------------------------------------------------------------------- standards

const SROOT = m4();
const STILE = new Float32Array(4);
const SSNAP: Snapped = { x: 0, y: 0, z: 0, px: 0, py: 0 };
const PITCH = Math.PI / 6;
const LEAN_MAX = 0.42;
const SHAKE_BELOW = 0.3;
const SIGIL: Record<Exclude<Form, 'man'>, Sigil> = { blightman: 'claw', troll: 'crack', drake: 'flame', broodlord: 'eye' };
/**
 * Heights (02-look.md §6 "Pole and behaviour": 1.6, the captain's 1.95, beasts' +0.8): blight-men 1.6, trolls and
 * drakes 2.4, the broodlord the captain's plus a beast's, 2.75.
 */
const STANDARD_H: Record<Exclude<Form, 'man'>, number> = { blightman: 1.6, troll: 2.4, drake: 2.4, broodlord: 2.75 };

/**
 * A blight company's standard (out/decisions-blight-view.md "Standards"): a ragged hide with an ember sigil, hung
 * from a crooked branch on a crooked pole under a horned skull with ember eyes; the broodlord's a great bull's skull.
 * It leans and shakes with morale, tatters with losses and is hidden while the company routs, as a banner does; its
 * rank is bone fangs hung from the branch.
 */
export function poseStandard(c: RigCtx, b: BannerRecord, form: Exclude<Form, 'man'>): void {
  if (b.routing) return;
  const grow = Math.max(1, Math.min(2.4, 18 / c.zoom));
  const sel = b.selected ? 1.3 : b.hover ? 1.1 : 1;
  const k = grow * sel;
  const lord = form === 'broodlord';
  const H = STANDARD_H[form];
  let lean = Math.max(0, Math.min(1, (0.55 - b.heart) / 0.3)) * LEAN_MAX;
  if (b.heart < SHAKE_BELOW) lean += Math.sin(23 * c.time) * 0.08;
  const screenX = (Math.cos(b.face) + Math.sin(b.face)) * Math.SQRT1_2;
  const dir = screenX > 0 ? 1 : -1;
  snapFigure(b.x, b.y, b.h, c.zoom, SSNAP);
  AT[0] = SSNAP.x;
  AT[1] = SSNAP.y;
  AT[2] = SSNAP.z;
  ident(SROOT);
  rotY(SROOT, -Math.PI / 4);
  rotZ(SROOT, lean * dir);
  scale(SROOT, k, k, k);

  ident(TMP);
  scale(TMP, 1, H, 1);
  emit(c, 'bsPole', SROOT, TMP, null, false, k);
  ident(TMP);
  translate(TMP, 0, H - 0.02, 0);
  emit(c, lord ? 'bsLordTotem' : 'bsTotem', SROOT, TMP, null, false, k);
  emit(c, lord ? 'bsLordEyes' : 'bsEyes', SROOT, TMP, lord ? FLAME[1] : EMBER, false, k);
  const barY = H - 0.1;
  ident(TMP);
  translate(TMP, 0, barY, BANNER.crossZ);
  scale(TMP, BANNER.crossW, 1, 1);
  emit(c, 'bsBar', SROOT, TMP, null, false, k);

  const look: BannerLook = {
    ramp: 1,
    mark: 'none',
    sigil: SIGIL[form],
    tatter: tatterStage(b.lost, b.size),
    captain: false,
    variant: hash32(b.id, 3, 0xba22),
  };
  const unfurl = Math.max(0.05, Math.min(1, b.unfurl ?? 1));
  ident(TMP);
  translate(TMP, 0, barY - 0.01, BANNER.push);
  rotX(TMP, -PITCH);
  scale(TMP, 1, unfurl, 1);
  const fit = fitCloth(c, SROOT, TMP, k, lean === 0 && unfurl === 1);
  c.banners.get(look, fit.far, STILE);
  const wind = Math.min(1, b.speed / 1.6);
  emit(c, fit.far ? 'bannerClothFar' : 'bannerCloth', SROOT, TMP, null, false, k, wind, (b.id % 89) / 14, (fit.far ? BANNER.clothHFar : BANNER.clothH) * fit.s, STILE);

  // rank: a bone fang per rank hung from the branch's ends, outside the hide
  for (let i = 0; i < Math.min(3, b.rank | 0); i++) {
    const side = i % 2 ? 1 : -1;
    const x = side * (BANNER.clothW / 2 + 0.05 + Math.floor(i / 2) * 0.07);
    ident(TMP2);
    translate(TMP2, x, barY - 0.01, BANNER.crossZ + 0.02);
    emit(c, 'bsFang', SROOT, TMP2, null, false, k);
  }
}
