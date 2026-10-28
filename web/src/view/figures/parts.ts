import type * as THREE from 'three';
import { BH, BW, FAR } from './atlas';
import { Builder, ball, cone, drape, fixed, rod, round, shade, shell, slab, strip } from './geom';
import type { ClothKind } from './material';
import {
  BLADE, CLASP, CROSS, CROSSBAR, FLETCH, GOLD, IRON, POLE, REINS, SADDLE, SHIELD_BACK, SPEAR_HEAD, STEEL, STRING, WOOD,
} from './palette';

// docs/spec/02-look.md §5 "Parts". Every part is built once in its own joint frame, in part units (× FIG = tiles):
// +x forward, +y up, +z the figure's right. Limbs hang down −y from their joint.

/** Body proportions (02-look.md §5 "Scale"), in part units. */
export const BODY = {
  /** Pelvis above the ground; the leg reaches the sole. */
  hip: 0.2,
  /** Shoulder joints and the base of the head, above the pelvis. */
  shoulder: 0.232,
  neck: 0.25,
  shoulderHalf: 0.128,
  upperArm: 0.11,
  forearm: 0.118,
  headR: 0.064,
  handR: 0.029,
  torsoH: 0.19,
  /** Hip joints sit this far either side of the centre. */
  hipHalf: 0.052,
} as const;

/** Horse proportions, part units. The body centre stands `horseBody` above the ground. */
export const HORSE = {
  body: 0.275,
  upperLeg: 0.11,
  lowerLeg: 0.1,
  /** Front and hind leg joints, relative to the body centre. */
  front: [0.15, -0.04, 0.05],
  hind: [-0.15, -0.04, 0.055],
  neckBase: [0.17, 0.05, 0],
  neckTop: [0.1, 0.15, 0],
  tail: [-0.245, 0.06, 0],
  saddle: [0, 0.095, 0],
  /** The rider's pelvis above the saddle origin. */
  seat: 0.04,
} as const;

/**
 * Banner measures in tiles (02-look.md §6). The cloth is 2/3 tile wide: when zoomed out the banner grows to 18
 * px per tile, so the far 12×20 gonfalon lands exactly one texel per art pixel; the near 16×26 one keeps its shape.
 */
export const BANNER = {
  clothW: 2 / 3,
  clothH: ((2 / 3) * BH) / BW,
  clothHFar: ((2 / 3) * FAR.h) / FAR.w,
  crossW: 0.9,
  /** The cloth hangs this far out from the pole, toward the viewer. */
  push: 0.06,
  crossZ: 0.03,
} as const;

export interface PartDef {
  build: (b: Builder) => void;
  cloth?: ClothKind;
  /** Nominal radius of the part's thinnest stroke (local units): it is swelled to stay ≥ 1 art pixel across. */
  thin?: number;
  /** The part is an atlas card: 'banner' or 'shield'. */
  atlas?: 'banner' | 'bannerFar' | 'shield';
  /** Casts a shadow (cards and small details don't need to). */
  shadow?: boolean;
}

const leather = fixed(SADDLE);

export const PARTS = {
  // ---------------------------------------------------------------- body
  leg: {
    build(b) {
      b.paint = shade(1);
      round(b, { r0: 0.03, r1: 0.035, y0: -0.13, h: 0.135, seg: 7 });
      b.paint = shade(0.55);
      round(b, { r0: 0.034, r1: 0.032, y0: -0.2, h: 0.075, seg: 7, capBottom: true });
      ball(b, { c: [0.028, -0.188, 0], r: [0.04, 0.017, 0.03], seg: 7, rings: 3 });
    },
  },
  skirt: {
    build(b) {
      b.paint = shade(1);
      round(b, { r0: 0.125, r1: 0.088, y0: -0.08, h: 0.11, sx: 0.78, seg: 12 });
      b.paint = shade(0.7);
      round(b, { r0: 0.128, r1: 0.125, y0: -0.1, h: 0.02, sx: 0.78, seg: 12 });
    },
  },
  gown: {
    build(b) {
      b.paint = shade(1);
      round(b, { r0: 0.13, r1: 0.09, y0: -0.17, h: 0.2, sx: 0.85, seg: 12 });
      b.paint = shade(0.7);
      round(b, { r0: 0.134, r1: 0.13, y0: -0.195, h: 0.025, sx: 0.85, seg: 12 });
    },
  },
  torso: {
    build(b) {
      b.paint = shade(1);
      round(b, { r0: 0.093, r1: 0.108, y0: 0, h: BODY.torsoH, sx: 0.82, seg: 12 });
      ball(b, { c: [0, BODY.torsoH, 0], r: [0.085, 0.045, 0.14], seg: 10, rings: 3 });
      b.paint = shade(1.15);
      round(b, { r0: 0.097, r1: 0.111, y0: 0.03, h: 0.14, sx: 0.82, a0: -0.55, a1: 0.55, seg: 4 });
      b.paint = shade(0.72);
      round(b, { r0: 0.062, r1: 0.054, y0: BODY.torsoH + 0.01, h: 0.028, seg: 10, capTop: true });
      b.paint = leather;
      round(b, { r0: 0.097, r1: 0.097, y0: 0.0, h: 0.022, sx: 0.84, seg: 12 });
      ball(b, { c: [0.045, -0.005, 0.075], r: [0.024, 0.028, 0.02], seg: 5, rings: 2 });
    },
  },
  uarm: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, -0.008, 0], r: [0.042, 0.045, 0.04], seg: 8, rings: 4 });
      round(b, { r0: 0.03, r1: 0.034, y0: -BODY.upperArm, h: BODY.upperArm, seg: 7 });
    },
  },
  farm: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, 0, 0], r: [0.031, 0.031, 0.031], seg: 7, rings: 3 });
      round(b, { r0: 0.027, r1: 0.03, y0: -BODY.forearm + 0.02, h: BODY.forearm - 0.02, seg: 7 });
      b.paint = shade(0.72);
      round(b, { r0: 0.031, r1: 0.031, y0: -BODY.forearm, h: 0.022, seg: 7 });
    },
  },
  hand: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, -0.02, 0], r: [BODY.handR, BODY.handR, BODY.handR], seg: 6, rings: 3 });
    },
  },
  head: {
    build(b) {
      b.paint = shade(1);
      round(b, { r0: 0.032, r1: 0.03, y0: -0.05, h: 0.06, seg: 7 });
      ball(b, { c: [0.004, 0.058, 0], r: [0.06, BODY.headR, 0.056], seg: 9, rings: 5 });
      ball(b, { c: [0.016, 0.026, 0], r: [0.046, 0.034, 0.042], seg: 7, rings: 3 });
      ball(b, { c: [0.064, 0.048, 0], r: [0.014, 0.013, 0.011], seg: 5, rings: 2 });
      for (const z of [-0.056, 0.056]) ball(b, { c: [-0.002, 0.05, z], r: [0.011, 0.017, 0.009], seg: 4, rings: 2 });
    },
  },
  /** Eyes, mouth and brows: drawn only at zoom ≥ 28. */
  face: {
    shadow: false,
    build(b) {
      b.paint = shade(0.22);
      for (const z of [-0.022, 0.022]) ball(b, { c: [0.057, 0.064, z], r: [0.008, 0.012, 0.012], seg: 5, rings: 2 });
      b.paint = shade(0.5);
      ball(b, { c: [0.058, 0.025, 0], r: [0.006, 0.005, 0.016], seg: 5, rings: 2 });
      b.paint = shade(0.4);
      for (const z of [-0.022, 0.022]) ball(b, { c: [0.058, 0.082, z], r: [0.007, 0.005, 0.014], seg: 5, rings: 2 });
    },
  },
  hair: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [-0.01, 0.068, 0], r: [0.062, 0.06, 0.061], seg: 10, rings: 5 });
    },
  },
  beard0: {
    // full
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0.034, 0.014, 0], r: [0.036, 0.042, 0.046], seg: 8, rings: 4 });
    },
  },
  beard1: {
    // short
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0.04, 0.02, 0], r: [0.03, 0.026, 0.04], seg: 8, rings: 4 });
    },
  },
  beard2: {
    // moustache
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0.062, 0.035, 0], r: [0.011, 0.008, 0.026], seg: 6, rings: 3 });
    },
  },
  beard3: {
    // forked
    build(b) {
      b.paint = shade(1);
      for (const z of [-0.015, 0.015]) ball(b, { c: [0.045, 0.0, z], r: [0.02, 0.038, 0.015], seg: 5, rings: 3 });
      ball(b, { c: [0.06, 0.035, 0], r: [0.011, 0.008, 0.026], seg: 6, rings: 3 });
    },
  },
  beard4: {
    // pointed
    build(b) {
      b.paint = shade(1);
      cone(b, [0.042, 0.03, 0], [0.058, -0.045, 0], 0.03, 7);
    },
  },

  // ---------------------------------------------------------------- headgear (origin: the base of the head)
  kettle: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [-0.002, 0.074, 0], r: [0.07, 0.064, 0.067], seg: 10, rings: 4, lat0: 0 });
      b.paint = shade(0.86);
      round(b, { r0: 0.112, r1: 0.072, y0: 0.054, h: 0.026, seg: 12, capBottom: true, cx: -0.002 });
      b.paint = shade(0.7);
      round(b, { r0: 0.073, r1: 0.072, y0: 0.078, h: 0.01, seg: 12, cx: -0.002 });
    },
  },
  nasal: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, 0.076, 0], r: [0.07, 0.07, 0.067], seg: 10, rings: 4, lat0: 0 });
      cone(b, [0, 0.13, 0], [-0.004, 0.162, 0], 0.03, 8);
      b.paint = shade(0.75);
      round(b, { r0: 0.072, r1: 0.071, y0: 0.07, h: 0.014, seg: 12 });
      b.paint = shade(0.85);
      rod(b, [0.07, 0.082, 0], [0.074, 0.032, 0], 0.009, 5);
    },
  },
  coif: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [-0.016, 0.056, 0], r: [0.07, 0.079, 0.07], seg: 10, rings: 5, lat0: -0.9 });
      // the mail mantle spreads over the shoulders
      round(b, { r0: 0.15, r1: 0.06, y0: -0.075, h: 0.075, sx: 0.72, seg: 12 });
      b.paint = shade(0.75);
      round(b, { r0: 0.152, r1: 0.15, y0: -0.084, h: 0.01, sx: 0.72, seg: 12 });
    },
  },
  hood: {
    build(b) {
      b.paint = shade(1);
      shell(b, { c: [-0.014, 0.06, 0], r: [0.075, 0.082, 0.071], seg: 9, rings: 4, lat0: -0.75 }, shade(0.5));
      cone(b, [-0.04, 0.115, 0], [-0.1, 0.165, 0], 0.036, 7);
      round(b, { r0: 0.128, r1: 0.07, y0: -0.085, h: 0.08, seg: 12 });
      b.paint = shade(0.72);
      round(b, { r0: 0.13, r1: 0.128, y0: -0.095, h: 0.012, seg: 12 });
    },
  },
  cap: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [-0.01, 0.086, 0], r: [0.067, 0.05, 0.065], seg: 10, rings: 4, lat0: 0 });
      b.paint = shade(0.78);
      round(b, { r0: 0.068, r1: 0.067, y0: 0.08, h: 0.014, seg: 12, cx: -0.01 });
    },
  },
  kerchief: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [-0.012, 0.066, 0], r: [0.07, 0.07, 0.068], seg: 10, rings: 5, lat0: -0.45 });
      cone(b, [-0.05, 0.035, 0], [-0.075, -0.03, 0], 0.032, 6);
    },
  },
  plume: {
    build(b) {
      b.paint = shade(0.8);
      rod(b, [0, -0.005, 0], [-0.012, 0.04, 0], 0.011, 5);
      b.paint = shade(1);
      ball(b, { c: [-0.03, 0.066, 0], r: [0.034, 0.03, 0.018], seg: 8, rings: 4 });
    },
  },
  /** A cape hanging from the collar (origin at the top of the torso): 7 folds, lined at 0.62, dark hem, gold clasps. */
  cape: {
    cloth: 'hang',
    build(b) {
      b.paint = shade(1);
      drape(b, { rTop: 0.125, rHem: 0.16, len: 0.3, span: 3.7, folds: 7, depth: 0.014, sx: 0.78, lining: shade(0.62), hem: shade(0.6), hemFrom: 0.86, seg: 14 });
      b.paint = shade(0.9);
      round(b, { r0: 0.074, r1: 0.064, y0: -0.004, h: 0.026, seg: 10 });
      b.paint = fixed(CLASP);
      for (const z of [-0.058, 0.058]) ball(b, { c: [0.058, 0.004, z], r: [0.014, 0.014, 0.014], seg: 5, rings: 2 });
    },
  },

  // ---------------------------------------------------------------- gear (fixed colours)
  /** Shaft 1.0 with a leaf head; origin at the grip, shaft along +y. */
  spear: {
    thin: 0.009,
    build(b) {
      b.axisAt = (_x, y) => [0, y, 0];
      b.paint = fixed(WOOD);
      rod(b, [0, -0.34, 0], [0, 0.62, 0], 0.009, 5);
      b.paint = fixed(IRON);
      rod(b, [0, 0.6, 0], [0, 0.645, 0], 0.012, 5);
      b.paint = fixed(SPEAR_HEAD);
      ball(b, { c: [0, 0.69, 0], r: [0.017, 0.055, 0.013], seg: 6, rings: 4 });
      b.axisAt = null;
    },
  },
  sword: {
    thin: 0.008,
    build(b) {
      b.paint = fixed(WOOD);
      rod(b, [0, -0.03, 0], [0, 0.0, 0], 0.009, 5);
      b.paint = fixed(CROSS);
      ball(b, { c: [0, -0.036, 0], r: [0.012, 0.012, 0.012], seg: 6, rings: 3 });
      rod(b, [0, 0.006, -0.032], [0, 0.006, 0.032], 0.007, 5);
      b.paint = fixed(BLADE);
      rod(b, [0, 0.012, 0], [0, 0.2, 0], 0.01, 5, 0.004);
    },
  },
  pitchfork: {
    thin: 0.009,
    build(b) {
      b.paint = fixed(WOOD);
      rod(b, [0, -0.34, 0], [0, 0.5, 0], 0.009, 5);
      b.paint = fixed(IRON);
      rod(b, [0, 0.5, -0.048], [0, 0.5, 0.048], 0.006, 4);
      for (const z of [-0.046, 0, 0.046]) rod(b, [0, 0.5, z], [0, 0.61, z], 0.005, 4, 0.004);
    },
  },
  lance: {
    thin: 0.01,
    build(b) {
      b.axisAt = (_x, y) => [0, y, 0];
      b.paint = fixed(WOOD);
      rod(b, [0, -0.3, 0], [0, 0.82, 0], 0.01, 5, 0.008);
      b.paint = fixed(STEEL);
      cone(b, [0, 0.82, 0], [0, 0.92, 0], 0.016, 5);
      b.axisAt = null;
    },
  },
  /** The lance's pennant, a flag in team [2] hanging from its attach point along −y. */
  pennant: {
    cloth: 'flag',
    shadow: false,
    build(b) {
      b.paint = shade(1);
      strip(b, 0.16, 0.065, 4);
    },
  },
  /** A heater shield's back and rim (origin at its centre, the face toward +x). */
  shieldBack: {
    build(b) {
      b.paint = fixed(SHIELD_BACK);
      slab(b, HEATER, -0.014, 0, false);
      b.paint = fixed(IRON);
      ball(b, { c: [-0.02, 0, 0], r: [0.014, 0.02, 0.02], seg: 6, rings: 3 });
    },
  },
  /** The shield's face card (12×14 atlas tile). */
  shieldFace: {
    atlas: 'shield',
    shadow: false,
    build(b) {
      b.paint = shade(1);
      // a card in the y–z plane facing +x, u along z, v along y
      const [y0, y1, z0, z1] = [-0.13, 0.1, -0.087, 0.087];
      const a = b.vertex(0.001, y0, z0, 1, 0, 0, 0, 0);
      const c = b.vertex(0.001, y0, z1, 1, 0, 0, 1, 0);
      const d = b.vertex(0.001, y1, z1, 1, 0, 0, 1, 1);
      const e = b.vertex(0.001, y1, z0, 1, 0, 0, 0, 1);
      b.quad(a, e, d, c);
    },
  },
  /** The bow, limbs up and down, bulging forward (+x); origin at the grip. */
  bow: {
    thin: 0.008,
    build(b) {
      b.paint = fixed(WOOD);
      const pts: [number, number, number][] = [];
      for (let i = 0; i <= 8; i++) {
        const t = -1 + (2 * i) / 8;
        pts.push([-0.17 + 0.2 * Math.cos(t), 0.2 * Math.sin(t), 0]);
      }
      for (let i = 0; i < 8; i++) rod(b, pts[i], pts[i + 1], i === 0 || i === 7 ? 0.006 : 0.009, 5);
    },
  },
  /** A unit rod down −y, for strings and reins stretched between two points. */
  string: {
    thin: 0.003,
    shadow: false,
    build(b) {
      b.paint = fixed(STRING);
      rod(b, [0, 0, 0], [0, -1, 0], 0.003, 4, 0.003, false);
    },
  },
  rein: {
    thin: 0.004,
    shadow: false,
    build(b) {
      b.paint = fixed(REINS);
      rod(b, [0, 0, 0], [0, -1, 0], 0.004, 4, 0.004, false);
    },
  },
  /** An arrow from the nock (origin) along +y. */
  arrow: {
    thin: 0.005,
    build(b) {
      b.axisAt = (_x, y) => [0, y, 0];
      b.paint = fixed(WOOD);
      rod(b, [0, 0, 0], [0, 0.3, 0], 0.005, 4);
      b.paint = fixed(STEEL);
      cone(b, [0, 0.3, 0], [0, 0.335, 0], 0.011, 4);
      b.paint = fixed(FLETCH);
      ball(b, { c: [0, 0.03, 0], r: [0.012, 0.03, 0.004], seg: 4, rings: 2 });
      b.axisAt = null;
    },
  },
  /** A quiver worn on the back (origin at its middle), its fletchings showing. */
  quiver: {
    build(b) {
      b.paint = leather;
      round(b, { r0: 0.028, r1: 0.032, y0: -0.11, h: 0.2, seg: 7, capBottom: true, capTop: true });
      b.paint = fixed(FLETCH);
      for (const [x, z] of [[0.008, -0.012], [-0.01, 0.006], [0.01, 0.014]]) ball(b, { c: [x, 0.11, z], r: [0.012, 0.03, 0.01], seg: 4, rings: 2 });
    },
  },
  /** The folk's bundle on the back. */
  bundle: {
    build(b) {
      b.paint = fixed(0xa8946c);
      ball(b, { c: [0, 0, 0], r: [0.055, 0.068, 0.075], seg: 7, rings: 4 });
      b.paint = fixed(0x6b5a40);
      ball(b, { c: [0.01, 0.066, 0], r: [0.022, 0.018, 0.026], seg: 6, rings: 3 });
      round(b, { r0: 0.058, r1: 0.058, y0: -0.008, h: 0.014, seg: 10, sz: 1.3 });
    },
  },

  // ---------------------------------------------------------------- horse (origin at the body centre)
  hBody: {
    build(b) {
      b.paint = shade(1);
      rod(b, [-0.15, 0, 0], [0.15, 0, 0], 0.095, 12, 0.095, false);
      ball(b, { c: [0.16, 0.0, 0], r: [0.09, 0.1, 0.086], seg: 9, rings: 4 });
      ball(b, { c: [-0.16, 0.02, 0], r: [0.1, 0.1, 0.096], seg: 9, rings: 4 });
      for (const z of [-0.05, 0.05]) {
        ball(b, { c: [0.13, -0.025, z], r: [0.065, 0.085, 0.052], seg: 7, rings: 3 });
        ball(b, { c: [-0.15, -0.02, z * 1.1], r: [0.075, 0.09, 0.052], seg: 7, rings: 3 });
      }
      b.paint = shade(0.3);
      rod(b, [0.045, 0, 0], [0.07, 0, 0], 0.099, 12, 0.099, false);
    },
  },
  hNeck: {
    build(b) {
      b.paint = shade(1);
      rod(b, [0, 0, 0], [HORSE.neckTop[0], HORSE.neckTop[1], 0], 0.058, 9, 0.04);
      b.paint = shade(0.42);
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        ball(b, { c: [-0.03 + 0.11 * t, 0.045 + 0.13 * t, 0], r: [0.024, 0.026, 0.014], seg: 5, rings: 2 });
      }
    },
  },
  hHead: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0.01, 0.002, 0], r: [0.048, 0.044, 0.04], seg: 7, rings: 3 });
      rod(b, [0.01, 0, 0], [0.13, -0.075, 0], 0.038, 7, 0.027);
      b.paint = shade(0.55);
      ball(b, { c: [0.135, -0.078, 0], r: [0.032, 0.03, 0.027], seg: 7, rings: 3 });
      b.paint = shade(1);
      for (const z of [-0.02, 0.02]) cone(b, [-0.005, 0.03, z], [-0.018, 0.078, z * 1.2], 0.013, 5);
      b.paint = shade(0.42);
      ball(b, { c: [0.025, 0.036, 0], r: [0.022, 0.013, 0.016], seg: 6, rings: 3 });
    },
  },
  hUpper: {
    build(b) {
      b.paint = shade(1);
      rod(b, [0, 0.02, 0], [0, -HORSE.upperLeg, 0], 0.034, 7, 0.024, false);
      ball(b, { c: [0, -HORSE.upperLeg, 0], r: [0.025, 0.025, 0.024], seg: 6, rings: 3 });
    },
  },
  hLower: {
    build(b) {
      b.paint = shade(1);
      rod(b, [0, 0, 0], [0, -HORSE.lowerLeg, 0], 0.019, 6, 0.017, false);
      b.paint = shade(0.25);
      round(b, { r0: 0.024, r1: 0.02, y0: -HORSE.lowerLeg - 0.025, h: 0.027, seg: 6, capBottom: true });
    },
  },
  /** Tail: cloth, length 0.27, colour coat × 0.32. */
  hTail: {
    cloth: 'hang',
    build(b) {
      b.paint = shade(0.32);
      b.clothS = (_x, y) => Math.max(0, Math.min(1, -y / 0.27));
      round(b, { r0: 0.012, r1: 0.028, y0: -0.27, h: 0.27, seg: 6, capBottom: true });
      b.clothS = null;
    },
  },
  /** Saddle cloth (dyed team [2]) and the saddle (fixed). Origin on the top of the barrel. */
  saddle: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [-0.01, -0.045, 0], r: [0.12, 0.06, 0.108], seg: 9, rings: 3, lat0: -0.25 });
      b.paint = leather;
      ball(b, { c: [0, 0.008, 0], r: [0.072, 0.026, 0.06], seg: 7, rings: 2 });
      ball(b, { c: [-0.06, 0.025, 0], r: [0.016, 0.03, 0.05], seg: 5, rings: 2 });
      ball(b, { c: [0.06, 0.02, 0], r: [0.014, 0.024, 0.03], seg: 5, rings: 2 });
    },
  },

  // ---------------------------------------------------------------- banners (tiles, origin at the pole's foot)
  /** A unit pole up +y (scaled to the banner's height). */
  pole: {
    thin: 0.018,
    build(b) {
      b.paint = fixed(POLE);
      rod(b, [0, 0, 0], [0, 1, 0], 0.018, 5, 0.016);
    },
  },
  /** The crossbar, unit length along x, with knobs. */
  crossbar: {
    thin: 0.016,
    build(b) {
      b.paint = fixed(CROSSBAR);
      rod(b, [-0.5, 0, 0], [0.5, 0, 0], 0.016, 5);
    },
  },
  finial: {
    build(b) {
      b.paint = fixed(CROSSBAR);
      ball(b, { c: [0, 0.03, 0], r: [0.035, 0.035, 0.035], seg: 6, rings: 4 });
    },
  },
  /** The gonfalon itself: a card hanging from y = 0, drawn from the banner atlas, waving as a flag. */
  bannerCloth: {
    atlas: 'banner',
    cloth: 'flag',
    build(b) {
      b.paint = shade(1);
      strip(b, BANNER.clothH, BANNER.clothW, 10, 1, 0, false);
    },
  },
  /** The far gonfalon (12×20), for zooms where the near one would be minified. */
  bannerClothFar: {
    atlas: 'bannerFar',
    cloth: 'flag',
    build(b) {
      b.paint = shade(1);
      strip(b, BANNER.clothHFar, BANNER.clothW, 10, 1, 0, false);
    },
  },
  /** A gold rank chevron, ^-shaped, in the cloth's plane. */
  chevron: {
    thin: 0.016,
    shadow: false,
    build(b) {
      b.paint = fixed(GOLD);
      rod(b, [-0.22, 0, 0], [0, 0.11, 0], 0.018, 5);
      rod(b, [0, 0.11, 0], [0.22, 0, 0], 0.018, 5);
    },
  },
  /** An honour ribbon: a narrow flag, dyed cream or red. */
  ribbon: {
    cloth: 'flag',
    shadow: false,
    build(b) {
      b.paint = shade(1);
      strip(b, 0.32, 0.055, 6);
    },
  },
} satisfies Record<string, PartDef>;

export type PartId = keyof typeof PARTS;

/** A heater outline in the y–z plane, matching the 12×14 shield tile (top flat, sides curving to a point). */
const HEATER: [number, number][] = (() => {
  const out: [number, number][] = [[0.1, -0.087], [0.1, 0.087]];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const y = -0.01 - 0.12 * t;
    const hw = 0.087 * Math.sqrt(Math.max(0, 1 - t * t));
    out.push([y, hw]);
  }
  for (let i = 7; i >= 0; i--) {
    const t = i / 8;
    out.push([-0.01 - 0.12 * t, -0.087 * Math.sqrt(Math.max(0, 1 - t * t))]);
  }
  return out;
})();

const built = new Map<PartId, THREE.BufferGeometry>();
/** The merged geometry of a part, built on first use. */
export function partGeometry(id: PartId): THREE.BufferGeometry {
  let g = built.get(id);
  if (!g) {
    const b = new Builder();
    (PARTS[id] as PartDef).build(b);
    g = b.build();
    built.set(id, g);
  }
  return g;
}
