import type { Kind } from '../../contracts';
import type { BannerLook, Mark } from './atlas';
import { tatterStage, type BannerAtlas, type ShieldAtlas } from './atlas';
import { hash32 } from './hash';
import type { PartPool } from './instances';
import { alongDown, frame, ident, m4, mul, point, rotX, rotY, rotZ, scale, translate, type M4 } from './mat';
import { type Form, type Look } from './outfit';
import { RIBBONS, rgb } from './palette';
import { BANNER, BODY, HORSE, PARTS, type PartDef, type PartId } from './parts';
import { snapFigure, type Snapped } from './snap';
import type { BannerRecord, ManRecord } from './types';

// docs/spec/02-look.md §5 "Animation" and 04-battle.md §9: every man posed procedurally each frame, joint
// matrices composed here and written straight into the part instance buffers. No skeletons, no animation files;
// the only keyframes are the small blow tables below.

/** Part units → tiles. */
export const FIG = 1.32;
const STRIDE_FOOT = 3.6;
const STRIDE_MOUNTED = 2.4;
/** Men turn at 7 rad/s (04-battle.md §9). */
const TURN = 7;
const EASE = 16;
const SPEED_LP = 10;
export const WALK_MIN = 0.2;
const FACE_MOTION = 0.35;
export const HIT_FLASH = 0.1;
export const TOPPLE = 0.35;
const SWORD_T = 0.3;
const SPEAR_T = 0.5;
/** A thin thing is at least this many art pixels across. */
const MIN_PX = 1.2;
/** Face detail from this zoom, shield devices at this zoom (02-look.md §5). */
export const FACE_ZOOM = 28;
export const DEVICE_ZOOM = 34;

/** (shoulder, elbow, blade) of the sword arm. */
type Arm3 = readonly [number, number, number];
const GUARD: Arm3 = [0.35, 1.0, -0.6];
const LOW: Arm3 = [0.05, 0.3, -2.4];
/** Sword blow (0.3 s): rest → (0.4, 2.9, 0.6, 0.9) → (0.62, 1.1, 0.15, −1.9) → rest, smoothstep between keys. */
const SWORD_KEYS: readonly (readonly [number, number, number, number])[] = [
  [0, ...GUARD],
  [0.4, 2.9, 0.6, 0.9],
  [0.62, 1.1, 0.15, -1.9],
  [1, ...GUARD],
];

export const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function swordArm(t: number, out: number[]): void {
  const k = t / SWORD_T;
  let i = 0;
  while (i < SWORD_KEYS.length - 2 && k > SWORD_KEYS[i + 1][0]) i++;
  const a = SWORD_KEYS[i], b = SWORD_KEYS[i + 1];
  const f = smooth((k - a[0]) / (b[0] - a[0]));
  for (let j = 0; j < 3; j++) out[j] = a[j + 1] + (b[j + 1] - a[j + 1]) * f;
}

/** Spear thrust (0.5 s): draw back to −0.3 in the first 20%, drive to 1 by 40%, then ease back. */
export function thrust(t: number): number {
  const k = t / SPEAR_T;
  if (k >= 1 || k < 0) return 0;
  if (k < 0.2) return -0.3 * smooth(k / 0.2);
  if (k < 0.4) return -0.3 + 1.3 * smooth((k - 0.2) / 0.2);
  return 1 - smooth((k - 0.4) / 0.6);
}

/** What the view keeps per man between frames. */
export interface FigState {
  id: number;
  seen: number;
  /** Drawn position (sim tiles) and ground height, easing toward the sim's. */
  x: number;
  y: number;
  h: number;
  speed: number;
  face: number;
  phase: number;
  strikes: number;
  /** Seconds since the last blow started (Infinity before the first). */
  strikeT: number;
  look: Look;
  lookKey: number;
  /** The face seed the look was made with (ManRecord.faceSeed). */
  faceSeed: number;
  /** Where he was drawn last, snapped (world), for picking and checks. */
  at: Snapped;
}

export interface RigCtx {
  pool: PartPool;
  zoom: number;
  time: number;
  shields: ShieldAtlas;
  banners: BannerAtlas;
}

/**
 * The extension point for other bodies. Men (on foot and mounted) are built in; the blight's bodies (blight-men,
 * trolls, drakes, the broodlord) register a rig for their form (blight.ts), and any other beast for its kind with
 * `registerRig('beast', …)`. A body without a rig is skipped.
 */
export interface Rig {
  pose(ctx: RigCtx, st: FigState, rec: ManRecord): void;
  /** Stride for the walk phase (04-battle.md §9: beasts 3, drakes 3.4) and the turn rate (beasts 2.2 rad/s). */
  stride?: number;
  turn?: number;
}
export const RIGS: Partial<Record<Kind | Exclude<Form, 'man'>, Rig>> = {};
export function registerRig(key: Kind | Exclude<Form, 'man'>, rig: Rig): void {
  RIGS[key] = rig;
}

// ---------------------------------------------------------------------------------------------------------- state

export function advance(st: FigState, rec: ManRecord, dt: number, rig?: Rig): void {
  const k = 1 - Math.exp(-EASE * dt);
  st.x += (rec.x - st.x) * k;
  st.y += (rec.y - st.y) * k;
  st.h += (rec.h - st.h) * k;
  st.speed += (rec.speed - st.speed) * Math.min(1, dt * SPEED_LP);
  if (rec.alive) {
    // facing: the sim's (its motion) when moving, else the target, else the sim's
    let want = rec.face;
    if (rec.speed <= FACE_MOTION && rec.aimX !== undefined && rec.aimY !== undefined) {
      const dx = rec.aimX - rec.x, dy = rec.aimY - rec.y;
      if (dx * dx + dy * dy > 1e-6) want = Math.atan2(dy, dx);
    }
    let d = want - st.face;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const cap = (rig?.turn ?? TURN) * dt;
    st.face += Math.max(-cap, Math.min(cap, d));
    const stride = rig?.stride ?? (st.look.mounted ? STRIDE_MOUNTED : STRIDE_FOOT);
    // walking against his facing (a drake springing back) plays the stride in reverse (04-battle.md §9)
    st.phase += (rec.backing ? -1 : 1) * st.speed * dt * stride;
  }
  if (rec.strikes !== st.strikes) {
    st.strikes = rec.strikes;
    st.strikeT = 0;
  } else st.strikeT += dt;
}

// ---------------------------------------------------------------------------------------------------------- emit

const W = m4();
const rgbCache = new Map<number, [number, number, number]>();
function dyeRGB(hex: number): [number, number, number] {
  let c = rgbCache.get(hex);
  if (!c) {
    c = rgb(hex);
    rgbCache.set(hex, c);
  }
  return c;
}

/**
 * Writes one part: world = root · local. `dye` null = a fixed-colour part (white instance colour). Cloth parts
 * take (wind, phase, length); thin parts get their swell from the zoom and `tilesPerUnit` (tiles per local unit).
 */
export function emit(c: RigCtx, id: PartId, root: M4, local: M4, dye: number | null, flash: boolean, tilesPerUnit: number, wind = 0, phase = 0, len = 0, tile?: ArrayLike<number>): void {
  mul(W, root, local);
  const def = PARTS[id] as PartDef;
  const [r, g, b] = dye === null || flash ? WHITE : dyeRGB(dye);
  if (def.cloth) c.pool.add(id, W, AT, r, g, b, wind, phase, len, 0, tile);
  else if (def.thin) {
    // the swell for the art pixel, and the stroke's radius in tiles (the shadow pass swells to its own texels)
    const radius = def.thin * tilesPerUnit;
    c.pool.add(id, W, AT, r, g, b, Math.max(1, (MIN_PX * 0.5) / c.zoom / radius), radius, 0, 0, tile);
  } else c.pool.add(id, W, AT, r, g, b, 1, 0, 0, 0, tile);
}
/** The snapped root of the figure being posed: matrices are relative to it (see material.ts, PROJECT). */
export const AT = new Float64Array(3);
const WHITE: [number, number, number] = [1, 1, 1];

// ---------------------------------------------------------------------------------------------------------- men

const ROOT = m4();
const PELVIS = m4();
const TORSO = m4();
const HEADM = m4();
const SHL = m4();
const SHR = m4();
const UAL = m4();
const UAR = m4();
const FAL = m4();
const FAR = m4();
const HDL = m4();
const HDR = m4();
const TMP = m4();
const TMP2 = m4();
const HB = m4();
const HN = m4();
const HH = m4();
const I = m4();
const P = [0, 0, 0];
const Q = [0, 0, 0];
const R3 = [0, 0, 0];
const V = [0, 0, 0];
const SIDE = [0, 0, 1];
const UP = [0, 1, 0];

/** Two-bone IK from shoulder `s` to wrist target `t` (root-local), elbow bent toward `pole`. Writes UA, FA, hand. */
function ik(s: ArrayLike<number>, t: ArrayLike<number>, pole: ArrayLike<number>, ua: M4, fa: M4, hand: M4): void {
  const a = BODY.upperArm, b = BODY.forearm;
  let dx = t[0] - s[0], dy = t[1] - s[1], dz = t[2] - s[2];
  let dist = Math.hypot(dx, dy, dz) || 1e-4;
  dx /= dist; dy /= dist; dz /= dist;
  dist = Math.max(Math.abs(a - b) + 1e-3, Math.min(a + b - 1e-3, dist));
  const cosA = (a * a + dist * dist - b * b) / (2 * a * dist);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  // the pole, made perpendicular to the reach
  const pd = pole[0] * dx + pole[1] * dy + pole[2] * dz;
  let qx = pole[0] - pd * dx, qy = pole[1] - pd * dy, qz = pole[2] - pd * dz;
  const qn = Math.hypot(qx, qy, qz) || 1;
  qx /= qn; qy /= qn; qz /= qn;
  const ux = dx * cosA + qx * sinA, uy = dy * cosA + qy * sinA, uz = dz * cosA + qz * sinA;
  const ex = s[0] + ux * a, ey = s[1] + uy * a, ez = s[2] + uz * a;
  const wx = s[0] + dx * dist, wy = s[1] + dy * dist, wz = s[2] + dz * dist;
  let lx = wx - ex, ly = wy - ey, lz = wz - ez;
  const ln = Math.hypot(lx, ly, lz) || 1;
  lx /= ln; ly /= ln; lz /= ln;
  V[0] = ux; V[1] = uy; V[2] = uz;
  alongDown(ua, I, s, V, SIDE);
  R3[0] = ex; R3[1] = ey; R3[2] = ez;
  V[0] = lx; V[1] = ly; V[2] = lz;
  alongDown(fa, I, R3, V, SIDE);
  R3[0] = wx; R3[1] = wy; R3[2] = wz;
  alongDown(hand, I, R3, V, SIDE);
}

/** Forward kinematics for an arm from its shoulder frame: th swings forward, bend folds the elbow forward. */
function fk(sh: M4, th: number, bend: number, abduct: number, ua: M4, fa: M4, hand: M4): void {
  ua.set(sh);
  rotX(ua, abduct);
  rotZ(ua, th);
  fa.set(ua);
  translate(fa, 0, -BODY.upperArm, 0);
  rotZ(fa, bend);
  hand.set(fa);
  translate(hand, 0, -BODY.forearm, 0);
}

interface Ctl {
  flash: boolean;
  wind: number;
  tpu: number;
}
const CTL: Ctl = { flash: false, wind: 0, tpu: 1 };
const TGT_L = [0, 0, 0];
const TGT_R = [0, 0, 0];
const SWORD3 = [0, 0, 0];

/** A man on foot, or the rider on a horse (the horse is posed first and gives the seat). */
export function poseMan(c: RigCtx, st: FigState, rec: ManRecord): void {
  const L = st.look;
  const alive = rec.alive;
  const rout = rec.routing && alive;
  const engaged = !!rec.engaged && alive && !rout;
  const moving = alive && st.speed > WALK_MIN;
  const swing = moving ? Math.sin(st.phase) * Math.min(0.7, 0.25 + 0.3 * st.speed) : 0;
  const flash = rec.hitAge < HIT_FLASH;
  const tpu = FIG * L.scale;
  const ctl = CTL;
  ctl.flash = flash;
  ctl.wind = Math.min(1, st.speed / 1.6);
  ctl.tpu = tpu;
  const seed = hash32(st.id, 7, 0xc1a5);

  // the root: snapped position, facing, scale; the dead roll onto their side over 0.35 s
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
    const side = seed & 1 ? 1 : -1;
    translate(ROOT, 0, fall * (L.mounted ? 0.085 : 0.1), 0);
    rotX(ROOT, fall * (Math.PI / 2) * side * 0.92);
  }

  // ---------------------------------------------------------------- horse
  let seatY: number = BODY.hip;
  if (L.mounted) {
    poseHorse(c, st, rec, ctl, moving, fall);
    // HB is the horse body; the rider's pelvis sits on the saddle
    ident(PELVIS).set(HB);
    translate(PELVIS, HORSE.saddle[0], HORSE.saddle[1] + HORSE.seat, 0);
    seatY = PELVIS[13];
  }

  // ---------------------------------------------------------------- stance
  const gear = rout ? 'none' : L.gear;
  const polearm = gear === 'spear' || gear === 'pitchfork';
  let hipYaw = 0;
  let torsoYaw = 0;
  let lean = 0;
  let lunge = 0;
  let legL = swing;
  let legR = -swing;
  const sT = st.strikeT;
  const v = engaged && (polearm || gear === 'lance') ? thrust(sT) : 0;
  if (sT < 0.25 && engaged && !polearm && gear !== 'bow') lean += Math.sin((sT / 0.25) * Math.PI) * 0.18;
  if (rout) lean = 0.2;
  if (engaged && polearm) {
    hipYaw = -0.3;
    if (!moving) {
      legL = 0.24;
      legR = -0.14;
    }
    lunge = 0.06 * Math.max(0, v);
  } else if (engaged && gear === 'bow') {
    hipYaw = -0.5;
    torsoYaw = -0.8;
    if (!moving) {
      legL = 0.22;
      legR = -0.2;
    }
  } else if (engaged && gear === 'sword+shield' && !moving) {
    legL = 0.16;
    legR = -0.1;
  }
  if (!alive) {
    legL = 0.12;
    legR = -0.08;
  }

  if (!L.mounted) {
    ident(PELVIS);
    translate(PELVIS, lunge, BODY.hip, 0);
    rotY(PELVIS, hipYaw);
  } else {
    lean += moving ? 0.08 : 0;
  }

  // legs and skirt
  const legDye = L.hose;
  for (let li = 0; li < 2; li++) {
    const side = li === 0 ? -1 : 1;
    const z = side * BODY.hipHalf;
    const ang = li === 0 ? legL : legR;
    TMP.set(PELVIS);
    translate(TMP, 0, 0, z);
    if (L.mounted) {
      rotX(TMP, -side * 0.5 * (1 - fall));
      rotZ(TMP, 0.55);
    } else {
      rotX(TMP, -side * 0.04);
      rotZ(TMP, ang);
    }
    emit(c, 'leg', ROOT, TMP, legDye, flash, tpu);
  }
  emit(c, L.gown ? 'gown' : 'skirt', ROOT, PELVIS, L.skirt, flash, tpu);

  // torso, head
  ident(TORSO).set(PELVIS);
  rotY(TORSO, torsoYaw - hipYaw);
  rotZ(TORSO, -lean);
  emit(c, 'torso', ROOT, TORSO, L.body, flash, tpu);
  ident(HEADM).set(TORSO);
  translate(HEADM, 0, BODY.neck, 0);
  if (engaged && gear === 'bow') rotY(HEADM, -torsoYaw * 0.75);
  if (!alive) rotZ(HEADM, -0.3);
  emit(c, 'head', ROOT, HEADM, L.skin, flash, tpu);
  if (c.zoom >= FACE_ZOOM) emit(c, 'face', ROOT, HEADM, L.skin, flash, tpu);
  const hooded = L.head === 'hood' || L.head === 'kerchief' || L.head === 'coif+nasal';
  if (!hooded && !L.bald) emit(c, 'hair', ROOT, HEADM, L.hair, flash, tpu);
  if (L.beard >= 0 && L.head !== 'coif+nasal') emit(c, `beard${L.beard}` as PartId, ROOT, HEADM, L.hair, flash, tpu);
  let plumeY = 0.128;
  switch (L.head) {
    case 'kettle':
      emit(c, 'kettle', ROOT, HEADM, L.headDye, flash, tpu);
      plumeY = 0.136;
      break;
    case 'nasal':
      emit(c, 'nasal', ROOT, HEADM, L.headDye, flash, tpu);
      plumeY = 0.16;
      break;
    case 'coif+nasal':
      emit(c, 'coif', ROOT, HEADM, L.coif, flash, tpu);
      emit(c, 'nasal', ROOT, HEADM, L.headDye, flash, tpu);
      plumeY = 0.16;
      break;
    case 'hood':
      emit(c, 'hood', ROOT, HEADM, L.headDye, flash, tpu);
      plumeY = 0.142;
      break;
    case 'cap':
      emit(c, 'cap', ROOT, HEADM, L.headDye, flash, tpu);
      plumeY = 0.136;
      break;
    case 'kerchief':
      emit(c, 'kerchief', ROOT, HEADM, L.headDye, flash, tpu);
      break;
    default:
      break;
  }
  if (L.plume !== null) {
    ident(TMP).set(HEADM);
    translate(TMP, -0.006, plumeY, 0);
    emit(c, 'plume', ROOT, TMP, L.plume, flash, tpu);
  }
  // the cape (rank 2, the captain): not while routing
  if (L.cape !== null && !rout) {
    ident(TMP).set(TORSO);
    translate(TMP, 0, BODY.torsoH + 0.022, 0);
    emit(c, 'cape', ROOT, TMP, L.cape, flash, tpu, alive ? ctl.wind : 0, (seed % 628) / 100, 0.3);
  }
  if (L.quiver && !rout) {
    ident(TMP).set(TORSO);
    translate(TMP, -0.1, 0.13, 0.04);
    rotX(TMP, 0.45);
    rotZ(TMP, -0.15);
    emit(c, 'quiver', ROOT, TMP, null, flash, tpu);
  }
  if (gear === 'bundle' || (rout && L.gear === 'bundle')) {
    ident(TMP).set(TORSO);
    translate(TMP, -0.12, 0.11, 0);
    emit(c, 'bundle', ROOT, TMP, null, flash, tpu);
  }

  // ---------------------------------------------------------------- arms
  ident(SHL).set(TORSO);
  translate(SHL, 0, BODY.shoulder, -BODY.shoulderHalf);
  ident(SHR).set(TORSO);
  translate(SHR, 0, BODY.shoulder, BODY.shoulderHalf);
  const armSwing = swing * 0.8;
  // defaults: counter-swing (th = ∓swing·0.8, bend = 0.2 + max(0, ∓swing)·0.6)
  let thL = -armSwing, bendL = 0.2 + Math.max(0, -swing) * 0.6, abL = 0.08;
  let thR = armSwing, bendR = 0.2 + Math.max(0, swing) * 0.6, abR = 0.08;
  let ikL = false, ikR = false;
  const tgtL = TGT_L, tgtR = TGT_R, sword = SWORD3;
  let blade = 0;

  if (rout) {
    thL = 0.3 - swing * 1.8;
    thR = 0.3 + swing * 1.8;
    bendL = bendR = 1.1;
  } else if (!alive) {
    // arms stretched out past the head: once rolled onto his side they lie along the ground
    thL = thR = 2.5;
    bendL = bendR = 0.2;
    abL = abR = 0.25;
  } else if (L.mounted) {
    thL = 0.55;
    bendL = 0.75;
    if (gear === 'lance') {
      if (engaged) {
        ikR = true;
        tgtR[0] = 0.02 + 0.1 * v;
        tgtR[1] = seatY + 0.17;
        tgtR[2] = 0.11;
      } else {
        thR = 0.18;
        bendR = 0.95;
      }
    } else {
      swordTuple(engaged, sT, 0, sword);
      thR = sword[0];
      bendR = sword[1];
      blade = sword[2];
    }
  } else if (polearm) {
    if (engaged) {
      ikL = ikR = true;
      // levelled: the grip at the right hip, the left hand forward on the shaft
      const reach = 0.15 * v;
      tgtR[0] = -0.03 + reach + lunge;
      tgtR[1] = BODY.hip + 0.12;
      tgtR[2] = 0.075;
      tgtL[0] = tgtR[0] + 0.16;
      tgtL[1] = tgtR[1] - 0.012;
      tgtL[2] = 0.035;
    } else {
      thR = 0.22 + (moving ? 0.04 * swing : 0);
      bendR = 1.0;
    }
  } else if (gear === 'sword+shield' || gear === 'sword') {
    swordTuple(engaged, sT, moving ? swing * 0.5 : 0, sword);
    thR = sword[0];
    bendR = sword[1];
    blade = sword[2];
    if (gear === 'sword+shield') {
      if (engaged) {
        thL = 0.75;
        bendL = 0.95;
      } else {
        thL = -armSwing * 0.5;
        bendL = 0.45;
      }
      abL = 0.18;
    }
  } else if (gear === 'bow' && engaged) {
    ikL = ikR = true;
  }

  if (gear === 'bow' && engaged) bowAim(rec, st, tgtL, tgtR, sT);

  if (ikL) {
    point(P, SHL, 0, 0, 0);
    Q[0] = -0.2; Q[1] = -1; Q[2] = -0.6;
    ik(P, tgtL, Q, UAL, FAL, HDL);
  } else fk(SHL, thL, bendL, abL, UAL, FAL, HDL);
  if (ikR) {
    point(P, SHR, 0, 0, 0);
    Q[0] = -0.3; Q[1] = -1; Q[2] = 0.6;
    ik(P, tgtR, Q, UAR, FAR, HDR);
  } else fk(SHR, thR, bendR, -abR, UAR, FAR, HDR);
  emit(c, 'uarm', ROOT, UAL, L.sleeve, flash, tpu);
  emit(c, 'farm', ROOT, FAL, L.sleeve, flash, tpu);
  emit(c, 'hand', ROOT, HDL, L.skin, flash, tpu);
  emit(c, 'uarm', ROOT, UAR, L.sleeve, flash, tpu);
  emit(c, 'farm', ROOT, FAR, L.sleeve, flash, tpu);
  emit(c, 'hand', ROOT, HDR, L.skin, flash, tpu);

  if (L.mounted && alive && !rout) {
    point(P, HDL, 0, -0.02, 0);
    stringBetweenPart(c, 'rein', P, MUZZLE, flash, tpu);
  }

  // ---------------------------------------------------------------- gear (the dead drop what they held)
  if (!alive && gear !== 'sword+shield') return;
  switch (gear) {
    case 'spear':
    case 'pitchfork':
    case 'lance': {
      if (engaged) {
        // levelled along the facing, a little down
        V[0] = Math.cos(-0.1);
        V[1] = Math.sin(-0.1);
        V[2] = 0;
        point(P, HDR, 0, -0.02, 0);
        Q[0] = -V[0]; Q[1] = -V[1]; Q[2] = 0;
        alongDown(TMP, I, P, Q, SIDE);
      } else {
        point(P, HDR, 0, -0.02, 0);
        if (!L.mounted) P[1] = Math.max(P[1], 0.355);
        ident(TMP);
        translate(TMP, P[0] + 0.005, P[1], P[2]);
        rotZ(TMP, moving ? -0.12 : -0.05);
      }
      emit(c, gear, ROOT, TMP, null, flash, tpu);
      if (gear === 'lance') {
        ident(TMP2).set(TMP);
        translate(TMP2, 0, 0.8, 0);
        rotZ(TMP2, engaged ? 0 : -Math.PI / 2);
        emit(c, 'pennant', ROOT, TMP2, L.saddleCloth, flash, tpu, ctl.wind, (seed % 300) / 50, 0.16);
      }
      break;
    }
    case 'sword':
    case 'sword+shield': {
      if (alive) {
        ident(TMP).set(HDR);
        translate(TMP, 0, -0.018, 0);
        rotZ(TMP, blade - Math.PI / 2);
        emit(c, 'sword', ROOT, TMP, null, flash, tpu);
      }
      if (gear === 'sword+shield') {
        // strapped on the left forearm, face out to the left-front; square to the foe when fighting
        point(P, FAL, 0, -0.06, 0);
        ident(TMP).set(TORSO);
        TMP[12] = P[0];
        TMP[13] = P[1];
        TMP[14] = P[2];
        rotY(TMP, engaged ? 0.25 : 0.95);
        translate(TMP, 0.03, 0, 0);
        if (!alive) rotZ(TMP, 0.4);
        emit(c, 'shieldBack', ROOT, TMP, null, flash, tpu);
        const tile = c.zoom >= DEVICE_ZOOM ? 1 : 0;
        c.shields.get(L.shieldRamp, tile === 1, SHIELD_TILE);
        emit(c, 'shieldFace', ROOT, TMP, null, flash, tpu, 0, 0, 0, SHIELD_TILE);
      }
      break;
    }
    case 'bow':
      poseBow(c, st, rec, engaged, flash, tpu);
      break;
    default:
      break;
  }
}
const SHIELD_TILE = new Float32Array(4);

function swordTuple(engaged: boolean, sT: number, swingAdd: number, out: number[]): void {
  if (engaged && sT < SWORD_T) swordArm(sT, out);
  else {
    const r = engaged ? GUARD : LOW;
    out[0] = r[0] + swingAdd;
    out[1] = r[1];
    out[2] = r[2];
  }
}

// ---------------------------------------------------------------------------------------------------------- bow

const AIM = [1, 0, 0];
const TOP = [0, 0, 0];
const BOT = [0, 0, 0];
const NOCK = [0, 0, 0];
let drawK = 1;

/** The archer's aim (root-local, toward the target and up a little) and his two hand targets. */
function bowAim(rec: ManRecord, st: FigState, tgtL: number[], tgtR: number[], sT: number): void {
  // aim in the root frame: the target relative to him, turned by his facing
  let ax = 1, az = 0;
  if (rec.aimX !== undefined && rec.aimY !== undefined) {
    const dx = rec.aimX - st.x, dy = rec.aimY - st.y;
    const n = Math.hypot(dx, dy);
    if (n > 1e-3) {
      const c = Math.cos(-st.face), s = Math.sin(-st.face);
      ax = (dx * c - dy * s) / n;
      az = (dx * s + dy * c) / n;
    }
  }
  const el = 0.22;
  AIM[0] = ax * Math.cos(el);
  AIM[1] = Math.sin(el);
  AIM[2] = az * Math.cos(el);
  // the bow hand reaches toward the target from the left shoulder (torso turned −0.8 about y)
  point(P, SHL, 0, 0, 0);
  const reach = (BODY.upperArm + BODY.forearm) * 0.93;
  for (let k = 0; k < 3; k++) tgtL[k] = P[k] + AIM[k] * reach;
  // the string hand: anchored at the cheek; after a loose it flies back, nocks at the bow, and draws again
  point(Q, HEADM, 0.035, 0.045, 0.05);
  const t = sT;
  let d = 1;
  if (t < 0.1) {
    d = 0;
    for (let k = 0; k < 3; k++) tgtR[k] = Q[k] - AIM[k] * 0.07;
  } else if (t < 0.45) {
    d = 0;
    const f = smooth((t - 0.1) / 0.35);
    for (let k = 0; k < 3; k++) tgtR[k] = Q[k] - AIM[k] * 0.07 * (1 - f) + (tgtL[k] - AIM[k] * 0.03 - Q[k]) * f;
  } else if (t < 0.9) {
    d = smooth((t - 0.45) / 0.45);
    for (let k = 0; k < 3; k++) tgtR[k] = tgtL[k] - AIM[k] * 0.03 + (Q[k] - tgtL[k] + AIM[k] * 0.03) * d;
  } else {
    for (let k = 0; k < 3; k++) tgtR[k] = Q[k];
  }
  drawK = d;
}

function poseBow(c: RigCtx, _st: FigState, _rec: ManRecord, engaged: boolean, flash: boolean, tpu: number): void {
  const BOW = TMP;
  if (engaged) {
    point(P, HDL, 0, -0.02, 0);
    frame(BOW, I, P, AIM, UP);
  } else {
    ident(BOW).set(HDL);
    translate(BOW, 0, -0.02, 0);
    drawK = 0;
  }
  emit(c, 'bow', ROOT, BOW, null, flash, tpu);
  // the string: tip → nock → tip (straight when not drawn)
  const top = TOP, bot = BOT;
  point(top, BOW, -0.062, 0.168, 0);
  point(bot, BOW, -0.062, -0.168, 0);
  if (engaged && drawK > 0.02) {
    point(NOCK, HDR, 0, -0.02, 0);
    stringBetween(c, top, NOCK, flash, tpu);
    stringBetween(c, NOCK, bot, flash, tpu);
    // the nocked arrow, from the string toward the target
    Q[0] = -AIM[0]; Q[1] = -AIM[1]; Q[2] = -AIM[2];
    alongDown(TMP2, I, NOCK, Q, SIDE);
    emit(c, 'arrow', ROOT, TMP2, null, flash, tpu);
  } else {
    stringBetween(c, top, bot, flash, tpu);
  }
}

function stringBetween(c: RigCtx, a: number[], b: number[], flash: boolean, tpu: number): void {
  V[0] = b[0] - a[0];
  V[1] = b[1] - a[1];
  V[2] = b[2] - a[2];
  const len = Math.hypot(V[0], V[1], V[2]) || 1e-4;
  V[0] /= len; V[1] /= len; V[2] /= len;
  alongDown(TMP2, I, a, V, SIDE);
  scale(TMP2, 1, len, 1);
  emit(c, 'string', ROOT, TMP2, null, flash, tpu);
}

// ---------------------------------------------------------------------------------------------------------- horse

const MUZZLE = [0, 0, 0];
/** Front-left with hind-right, front-right with hind-left. */
const HORSE_LEGS: readonly (readonly [readonly number[], number, number])[] = [
  [HORSE.front, -1, 0],
  [HORSE.front, 1, Math.PI],
  [HORSE.hind, -1, Math.PI],
  [HORSE.hind, 1, 0],
];

/** Diagonal-pair gait, knees and hocks folding, the gallop rise and the head nod (02-look.md §5 "Horse gait"). */
function poseHorse(c: RigCtx, st: FigState, rec: ManRecord, ctl: Ctl, moving: boolean, fall: number): void {
  const L = st.look;
  const ph = st.phase;
  const sp = st.speed;
  const amp = moving ? Math.min(0.55, 0.18 + 0.22 * sp) : 0;
  const rise = moving ? (1 - Math.cos(3 * ph)) * 0.016 : 0;
  const nod = moving ? Math.sin(1.5 * ph) * 0.1 : 0;
  const { flash, tpu } = ctl;
  ident(HB);
  translate(HB, 0, HORSE.body + rise, 0);
  emit(c, 'hBody', ROOT, HB, L.coat, flash, tpu);
  // legs: front-left with hind-right, front-right with hind-left
  for (const [j, side, off] of HORSE_LEGS) {
    const p = ph + off;
    const a = fall > 0 ? fall * 0.4 * side : amp * Math.sin(p);
    const fold = moving ? 1.3 * Math.max(0, Math.cos(p)) : fall * 0.5;
    ident(TMP).set(HB);
    translate(TMP, j[0], j[1], j[2] * side);
    rotZ(TMP, a);
    emit(c, 'hUpper', ROOT, TMP, L.coat, flash, tpu);
    translate(TMP, 0, -HORSE.upperLeg, 0);
    rotZ(TMP, -fold);
    emit(c, 'hLower', ROOT, TMP, L.coat, flash, tpu);
  }
  ident(HN).set(HB);
  translate(HN, HORSE.neckBase[0], HORSE.neckBase[1], 0);
  rotZ(HN, -nod * 0.6 + (fall > 0 ? 0.4 * fall : 0));
  emit(c, 'hNeck', ROOT, HN, L.coat, flash, tpu);
  ident(HH).set(HN);
  translate(HH, HORSE.neckTop[0], HORSE.neckTop[1], 0);
  rotZ(HH, -nod * 0.4);
  emit(c, 'hHead', ROOT, HH, L.coat, flash, tpu);
  point(MUZZLE, HH, 0.13, -0.07, 0);
  ident(TMP).set(HB);
  translate(TMP, HORSE.tail[0], HORSE.tail[1], 0);
  rotZ(TMP, -0.25);
  emit(c, 'hTail', ROOT, TMP, L.coat, flash, tpu, rec.alive ? ctl.wind : 0, (st.id % 97) / 15, 0.27);
  ident(TMP).set(HB);
  translate(TMP, HORSE.saddle[0], HORSE.saddle[1], 0);
  emit(c, 'saddle', ROOT, TMP, L.saddleCloth, flash, tpu);
}

function stringBetweenPart(c: RigCtx, id: PartId, a: number[], b: number[], flash: boolean, tpu: number): void {
  V[0] = b[0] - a[0];
  V[1] = b[1] - a[1];
  V[2] = b[2] - a[2];
  const len = Math.hypot(V[0], V[1], V[2]) || 1e-4;
  V[0] /= len; V[1] /= len; V[2] /= len;
  alongDown(TMP2, I, a, V, SIDE);
  scale(TMP2, 1, len, 1);
  emit(c, id, ROOT, TMP2, null, flash, tpu);
}

// ---------------------------------------------------------------------------------------------------------- banners

const BROOT = m4();
const BTILE = new Float32Array(4);
const CW = m4();
const CP = [0, 0, 0];
const SQ = Math.SQRT1_2;
const COS30 = Math.sqrt(3) / 2;

/**
 * Puts a banner's cloth card (`local`, in `root`'s frame, root scale `k`) on whole art pixels per texel: the far
 * 12×20 gonfalon at exactly 12 px wide, the near 16×26 at 16 px, or (from 20 px) the near one at its own width; and,
 * while it hangs straight, its top-left corner on a whole pixel, so every pixel centre samples a texel's centre.
 * Returns whether the far gonfalon is drawn and the scale given to the cloth (out/decisions-blight-view.md "Banner
 * cloth on whole texels").
 */
export function fitCloth(c: RigCtx, root: M4, local: M4, k: number, straight: boolean): { far: boolean; s: number } {
  const want = c.zoom * k * BANNER.clothW;
  const far = want < 14;
  const s = far ? 12 / want : want < 20 ? 16 / want : 1;
  scale(local, s, s, 1);
  if (straight && s !== 1) {
    // the corner's offset from the root's pixel, in art px along the screen's right and up (material.ts FIG_RIGHT/UP)
    mul(CW, root, local);
    point(CP, CW, -BANNER.clothW / 2, 0, 0);
    const ox = (CP[0] + CP[2]) * SQ * c.zoom;
    const oy = ((CP[0] - CP[2]) * SQ * 0.5 + CP[1] * COS30) * c.zoom;
    const dx = (Math.round(ox) - ox) / c.zoom;
    const dy = (Math.round(oy) - oy) / (c.zoom * COS30);
    // that shift in the world (along the screen's right, and straight up), into the root's frame (rotation × k)
    const vx = dx * SQ, vy = dy, vz = dx * SQ;
    const k2 = k * k;
    local[12] += (root[0] * vx + root[1] * vy + root[2] * vz) / k2;
    local[13] += (root[4] * vx + root[5] * vy + root[6] * vz) / k2;
    local[14] += (root[8] * vx + root[9] * vy + root[10] * vz) / k2;
  }
  return { far, s };
}
const BSNAP: Snapped = { x: 0, y: 0, z: 0, px: 0, py: 0 };
const PITCH = Math.PI / 6;
/** Most the pole leans when heart is low (radians). */
const LEAN_MAX = 0.42;
const SHAKE_BELOW = 0.3;

const MARK_OF: Record<Kind, Mark> = {
  spear: 'spear',
  shield: 'shield',
  archer: 'bow',
  horse: 'horseshoe',
  captain: 'crown',
  levy: 'none',
  folk: 'none',
  beast: 'none',
};

/** One company's banner (02-look.md §6 "Pole and behaviour"). */
export function poseBanner(c: RigCtx, b: BannerRecord): void {
  if (b.routing) return;
  const grow = Math.max(1, Math.min(2.4, 18 / c.zoom));
  const sel = b.selected ? 1.3 : b.hover ? 1.1 : 1;
  const k = grow * sel;
  const captain = !!b.captain || b.kind === 'captain';
  const H = captain ? 1.95 : b.kind === 'beast' ? 2.4 : 1.6;
  // lean as heart drops, shake near breaking; the lean falls away from where the company faces on screen
  let lean = Math.max(0, Math.min(1, (0.55 - b.heart) / 0.3)) * LEAN_MAX;
  if (b.heart < SHAKE_BELOW) lean += Math.sin(23 * c.time) * 0.08;
  const screenX = (Math.cos(b.face) + Math.sin(b.face)) * Math.SQRT1_2;
  const dir = screenX > 0 ? 1 : -1;
  snapFigure(b.x, b.y, b.h, c.zoom, BSNAP);
  AT[0] = BSNAP.x;
  AT[1] = BSNAP.y;
  AT[2] = BSNAP.z;
  ident(BROOT);
  // the cloth faces the viewer (local +z toward the camera, +x along the screen's right)
  rotY(BROOT, -Math.PI / 4);
  rotZ(BROOT, lean * dir);
  scale(BROOT, k, k, k);

  ident(TMP);
  scale(TMP, 1, H, 1);
  emit(c, 'pole', BROOT, TMP, null, false, k);
  ident(TMP);
  translate(TMP, 0, H, 0);
  emit(c, 'finial', BROOT, TMP, null, false, k);
  const barY = H - 0.07;
  ident(TMP);
  translate(TMP, 0, barY, BANNER.crossZ);
  scale(TMP, BANNER.crossW, 1, 1);
  emit(c, 'crossbar', BROOT, TMP, null, false, k);

  const look: BannerLook = {
    ramp: b.linen ? 2 : b.team === 0 ? 0 : 1,
    mark: MARK_OF[captain ? 'captain' : b.kind],
    tatter: tatterStage(b.lost, b.size),
    captain,
    variant: hash32(b.id, 3, 0xba22),
  };
  const unfurl = Math.max(0.05, Math.min(1, b.unfurl ?? 1));
  // the card turns square to the camera (its foot toward the viewer), so the gonfalon's texels are not
  // foreshortened by the 30° pitch; it is drawn on whole pixels per texel, the far 12×20 gonfalon or the near 16×26
  ident(TMP);
  translate(TMP, 0, barY - 0.01, BANNER.push);
  rotX(TMP, -PITCH);
  scale(TMP, 1, unfurl, 1);
  const fit = fitCloth(c, BROOT, TMP, k, lean === 0 && unfurl === 1);
  const far = fit.far;
  c.banners.get(look, far, BTILE);
  const wind = Math.min(1, b.speed / 1.6);
  emit(c, far ? 'bannerClothFar' : 'bannerCloth', BROOT, TMP, null, false, k, wind, (b.id % 89) / 14, (far ? BANNER.clothHFar : BANNER.clothH) * fit.s, BTILE);

  // gold chevrons above the crossbar, one per rank
  for (let i = 0; i < Math.min(3, b.rank | 0); i++) {
    ident(TMP);
    translate(TMP, 0, barY + 0.06 + i * 0.14, BANNER.push);
    rotX(TMP, -PITCH);
    emit(c, 'chevron', BROOT, TMP, null, false, k);
  }
  // honour ribbons from the crossbar's ends, cream and red in turn
  for (let i = 0; i < Math.min(6, b.honours | 0); i++) {
    const side = i % 2 ? 1 : -1;
    const x = side * (BANNER.clothW / 2 + 0.028 + Math.floor(i / 2) * 0.045);
    ident(TMP);
    translate(TMP, x, barY, BANNER.crossZ + 0.01);
    emit(c, 'ribbon', BROOT, TMP, RIBBONS[i % 2], false, k, wind, i * 1.7 + (b.id % 7), 0.32);
  }
}
