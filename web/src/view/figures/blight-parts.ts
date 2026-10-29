import { Builder, ball, cone, fixed, rags, rod, shade, tube, type Paint, type V3 } from './geom';
import { BONE, BONE_DARK, CROSSBAR, IRON, MANE, POLE, WOOD } from './palette';
import type { PartDef } from './parts';

// The blight's bodies (00-start-here.md §A2: "a blight of beasts"): blight-men, stone trolls, drakes and the
// broodlord, and the blight's standards. Built like the men (02-look.md §5 "Parts"): one merged, vertex-painted
// geometry per part in its joint's frame, in part units (× FIG × the figure's scale = tiles), +x forward, +y up,
// +z the figure's right. `shade(k)` takes the instance's dye (flesh, stone, hide); a fixed hex is bone, wood or
// iron. Glowing parts (eyes, cracks, the heart) are drawn unlit in their dye: the blight's ember.

/** A biped brute's measures (part units). Its torso is pitched forward by `hunch`; the head looks ahead again. */
export interface BruteBody {
  /** Pelvis above the ground (the leg, knee bent, reaches the sole), and the hip joints either side. */
  hip: number;
  hipHalf: number;
  /** The torso's forward pitch at rest (radians). */
  hunch: number;
  /** Shoulder joints along the spine from the pelvis, and either side. */
  shoulder: number;
  shoulderHalf: number;
  /** The head's base in the torso's frame: forward, up. */
  neck: readonly [number, number];
  /** The head tips back by this (of the hunch) to look ahead. */
  headLift: number;
  upperArm: number;
  forearm: number;
  /** The arms at rest: swing forward, elbow bend, out from the body (radians). */
  rest: readonly [number, number, number];
  /** Overall scale on FIG (a man is 1). */
  scale: number;
}

/** Blight-men: hunched, long-armed, a head shorter than a man and much broader (out/decisions-blight-view.md). */
export const BLIGHTMAN: BruteBody = {
  hip: 0.172,
  hipHalf: 0.062,
  hunch: 0.6,
  shoulder: 0.2,
  shoulderHalf: 0.122,
  neck: [0.085, 0.19],
  headLift: 0.5,
  upperArm: 0.14,
  forearm: 0.15,
  rest: [0.3, 0.3, 0.14],
  scale: 1.2,
};

/** Stone trolls: about twice a man's height, short thick legs, arms to the ground. */
export const TROLL_BODY: BruteBody = {
  hip: 0.162,
  hipHalf: 0.078,
  hunch: 0.3,
  shoulder: 0.215,
  shoulderHalf: 0.168,
  neck: [0.1, 0.24],
  headLift: 0.22,
  upperArm: 0.14,
  forearm: 0.15,
  rest: [0.3, 0.55, 0.22],
  scale: 2.3,
};

/** The broodlord: a great horned beast on hoofed, backward-kneed legs, larger than a troll. */
export const BROOD_BODY: BruteBody = {
  hip: 0.186,
  hipHalf: 0.07,
  hunch: 0.42,
  shoulder: 0.22,
  shoulderHalf: 0.15,
  neck: [0.06, 0.22],
  headLift: 0.32,
  upperArm: 0.14,
  forearm: 0.15,
  rest: [0.28, 0.42, 0.18],
  scale: 2.55,
};

/** Drakes are drawn this much over FIG: about two and a half men long (the reference drakes at zoom 34). */
export const DRAKE_SCALE = 1.4;

/** Drake measures, part units (× DRAKE_SCALE; a pack leader ×1.16). */
export const DRAKE = {
  /** Body centre above the ground. */
  body: 0.25,
  /** Shoulder and hip joints relative to the body centre (z either side). */
  front: [0.13, -0.06, 0.075] as V3,
  hind: [-0.13, -0.04, 0.085] as V3,
  upper: 0.1,
  lower: 0.09,
  thigh: 0.11,
  shin: 0.1,
  neckBase: [0.2, 0.05, 0] as V3,
  neckSeg: 0.115,
  necks: 3,
  /** The head joint sits this far along the last neck segment; the jaw's hinge in the head's frame. */
  hinge: [0.02, -0.025, 0] as V3,
  /** The mouth (where the breath leaves) in the head's frame. */
  mouth: [0.13, -0.02, 0] as V3,
  tailBase: [-0.2, 0.03, 0] as V3,
  tailSeg: 0.12,
  tails: 6,
} as const;

/** The flame's cone: a unit jet along +x, its radius (y and z) growing to 1 at the far end; rounded tip. */
function flameCone(b: Builder): void {
  const rings = 14;
  const seg = 12;
  const R = (u: number) => 0.06 + 0.94 * Math.pow(Math.min(1, u), 0.72);
  const grid: number[][] = [];
  for (let j = 0; j <= rings; j++) {
    // u runs to 1.08: the last rings close the far end in a rounded cap
    const u = (j / rings) * 1.08;
    const cap = u > 1 ? Math.sqrt(Math.max(0, 1 - ((u - 1) / 0.08) ** 2)) : 1;
    const row: number[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (Math.PI * 2 * i) / seg;
      // a lumpy outline, the same every frame (the licks are the shader's)
      const lump = (1 + 0.14 * Math.sin(5 * a + 9 * u) + 0.08 * Math.sin(3 * a - 5 * u)) * (1 + 0.1 * Math.sin(17 * u));
      const r = R(u) * cap * lump;
      const y = Math.sin(a) * r, z = Math.cos(a) * r;
      // aAxis.x carries u along the jet (the shader's heat and reach); the rim is read from the normal
      b.axisAt = () => [Math.min(u, 1), 0, 0];
      row.push(b.vertex(u, y, z, u > 1 ? (u - 1) / 0.08 : -0.2, Math.sin(a), Math.cos(a)));
    }
    grid.push(row);
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const i2 = (i + 1) % seg;
      b.quad(grid[j][i], grid[j][i2], grid[j + 1][i2], grid[j + 1][i]);
    }
  }
  b.axisAt = null;
}

/** A zig-zag crack along points (a glowing part). */
function crack(b: Builder, pts: readonly V3[], r: number): void {
  for (let i = 0; i < pts.length - 1; i++) rod(b, pts[i], pts[i + 1], r, 4, r, true);
}

/** Two eyes either side of x–y at (x, y, ±z): balls swelled about their own centres when small on screen. */
function eyes(b: Builder, x: number, y: number, z: number, r: number): void {
  for (const s of [-1, 1]) {
    const c: V3 = [x, y, s * z];
    b.axisAt = () => c;
    ball(b, { c, r: [r * 0.9, r, r], seg: 6, rings: 3 });
  }
  b.axisAt = null;
}

/** The broodlord's three horn shapes (head frame), each painted `root` at the skull and `body` along the horn. */
const HORN_SHAPES: readonly ((b: Builder, root: Paint, body: Paint) => void)[] = [
  // the great forward-sweeping pair, and a swept-back pair
  (b, root, body) => {
    for (const s of [-1, 1]) {
      b.paint = root;
      rod(b, [-0.01, 0.07, s * 0.045], [-0.02, 0.1, s * 0.1], 0.022, 6, 0.026);
      b.paint = body;
      tube(b, [[-0.02, 0.1, s * 0.1], [-0.005, 0.15, s * 0.155], [0.045, 0.19, s * 0.17], [0.1, 0.205, s * 0.148], [0.14, 0.2, s * 0.115]], 0.028, 0.008, 6, true);
      tube(b, [[-0.03, 0.07, s * 0.04], [-0.09, 0.09, s * 0.062], [-0.135, 0.07, s * 0.075], [-0.15, 0.03, s * 0.08]], 0.018, 0.006, 5, true);
    }
  },
  // ram's curls
  (b, root, body) => {
    for (const s of [-1, 1]) {
      b.paint = root;
      rod(b, [-0.01, 0.07, s * 0.045], [-0.025, 0.1, s * 0.09], 0.026, 6, 0.028);
      b.paint = body;
      tube(b, [[-0.025, 0.1, s * 0.09], [-0.075, 0.115, s * 0.12], [-0.115, 0.075, s * 0.135], [-0.105, 0.02, s * 0.14], [-0.06, -0.005, s * 0.135], [-0.025, 0.02, s * 0.125], [-0.03, 0.05, s * 0.12]], 0.03, 0.01, 6, true);
    }
  },
  // tall and upswept, with a short back pair
  (b, root, body) => {
    for (const s of [-1, 1]) {
      b.paint = root;
      rod(b, [-0.01, 0.07, s * 0.045], [-0.01, 0.105, s * 0.085], 0.022, 6, 0.024);
      b.paint = body;
      tube(b, [[-0.01, 0.105, s * 0.085], [0.0, 0.15, s * 0.125], [-0.005, 0.21, s * 0.14], [0.01, 0.265, s * 0.12], [0.035, 0.295, s * 0.095]], 0.024, 0.007, 6, true);
      tube(b, [[-0.03, 0.07, s * 0.04], [-0.08, 0.085, s * 0.055], [-0.11, 0.065, s * 0.065]], 0.015, 0.006, 5, true);
    }
  },
];

const RAG_LENS = [0.09, 0.06, 0.1, 0.07, 0.05, 0.08, 0.1, 0.06, 0.09, 0.05, 0.08, 0.07];

export const BLIGHT_PARTS = {
  // ---------------------------------------------------------------- blight-men (dye: flesh; rags and mantle: hide)
  /** A leg from the hip joint, knee bent forward, a clawed foot. */
  bmLeg: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0.012, -0.02, 0], r: [0.05, 0.054, 0.045], seg: 7, rings: 3 });
      rod(b, [0, -0.01, 0], [0.05, -0.088, 0], 0.04, 7, 0.034);
      ball(b, { c: [0.05, -0.088, 0], r: [0.035, 0.034, 0.033], seg: 6, rings: 3 });
      b.paint = shade(0.85);
      rod(b, [0.05, -0.088, 0], [0.002, -0.158, 0], 0.031, 6, 0.025);
      b.paint = shade(0.72);
      ball(b, { c: [0.02, -0.163, 0], r: [0.046, 0.014, 0.03], seg: 7, rings: 3 });
      b.paint = fixed(BONE_DARK);
      for (const z of [-0.017, 0, 0.017]) cone(b, [0.055, -0.166, z], [0.08, -0.172, z], 0.008, 4);
    },
  },
  /** Ragged hides round the hips (dye: the hide). */
  bmRags: {
    build(b) {
      b.paint = shade(1);
      rags(b, { r0: 0.088, r1: 0.105, y0: 0.035, lens: RAG_LENS, sx: 0.9, inner: shade(0.55) });
    },
  },
  /** The torso from the pelvis up the (pitched) spine: belly, a great chest, the hump, bone spurs on the spine. */
  bmTorso: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0.015, 0.06, 0], r: [0.085, 0.08, 0.095], seg: 10, rings: 4 });
      ball(b, { c: [0.025, 0.16, 0], r: [0.1, 0.086, 0.13], seg: 11, rings: 5 });
      ball(b, { c: [-0.045, 0.175, 0], r: [0.08, 0.08, 0.105], seg: 9, rings: 4 });
      for (const z of [-0.115, 0.115]) ball(b, { c: [0.005, 0.2, z], r: [0.056, 0.05, 0.05], seg: 7, rings: 3 });
      b.paint = shade(0.8);
      ball(b, { c: [0.03, 0.105, 0], r: [0.083, 0.03, 0.105], seg: 10, rings: 3 });
      b.paint = fixed(BONE_DARK);
      for (let t = 0; t < 3; t++) cone(b, [-0.11 + 0.012 * t, 0.12 + 0.045 * t, 0], [-0.16 + 0.012 * t, 0.15 + 0.05 * t, 0], 0.014, 4);
      for (const z of [-0.12, 0.12]) cone(b, [-0.01, 0.235, z], [-0.04, 0.27, z * 1.15], 0.012, 4);
    },
  },
  /** A hide thrown over the hump and shoulders, its tongues hanging behind (dye: the hide). */
  bmMantle: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [-0.025, 0.19, 0], r: [0.105, 0.07, 0.142], seg: 11, rings: 3, lat0: -0.2 });
      for (const z of [-0.07, 0, 0.07]) cone(b, [-0.085, 0.16, z], [-0.14, 0.07 + Math.abs(z) * 0.4, z * 1.2], 0.032, 5);
      b.paint = shade(0.7);
      for (const z of [-0.09, 0.09]) ball(b, { c: [0.02, 0.215, z], r: [0.05, 0.03, 0.05], seg: 6, rings: 2 });
    },
  },
  /** A low skull with a heavy brow, a jutting muzzle, tusks and swept-back ears (origin at the neck's base). */
  bmHead: {
    build(b) {
      b.paint = shade(1);
      rod(b, [-0.04, -0.06, 0], [0.005, 0.02, 0], 0.042, 7);
      ball(b, { c: [0, 0.045, 0], r: [0.062, 0.05, 0.054], seg: 9, rings: 4 });
      ball(b, { c: [0.05, 0.02, 0], r: [0.048, 0.032, 0.042], seg: 8, rings: 3 });
      b.paint = shade(0.8);
      ball(b, { c: [0.04, 0.062, 0], r: [0.028, 0.015, 0.053], seg: 7, rings: 3 });
      b.paint = shade(0.72);
      ball(b, { c: [0.045, -0.003, 0], r: [0.043, 0.02, 0.038], seg: 7, rings: 3 });
      b.paint = shade(0.9);
      for (const s of [-1, 1]) cone(b, [-0.005, 0.055, s * 0.04], [-0.075, 0.09, s * 0.08], 0.017, 5);
      b.paint = fixed(BONE);
      for (const s of [-1, 1]) cone(b, [0.075, 0.002, s * 0.022], [0.085, 0.034, s * 0.026], 0.008, 4);
    },
  },
  bmEyes: {
    glow: true,
    shadow: false,
    thin: 0.011,
    build(b) {
      b.paint = shade(1);
      eyes(b, 0.064, 0.05, 0.021, 0.011);
    },
  },
  /** A glowing crack down the chest (in the torso's frame). */
  bmCrack: {
    glow: true,
    shadow: false,
    thin: 0.006,
    build(b) {
      b.paint = shade(1);
      crack(b, [[0.112, 0.205, -0.04], [0.13, 0.168, -0.004], [0.124, 0.13, -0.034], [0.102, 0.09, 0.004], [0.094, 0.06, -0.02]], 0.006);
    },
  },
  bmUarm: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, -0.005, 0], r: [0.048, 0.05, 0.045], seg: 8, rings: 3 });
      rod(b, [0, 0, 0], [0, -0.13, 0], 0.034, 7, 0.03);
    },
  },
  bmFarm: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, 0, 0], r: [0.032, 0.032, 0.032], seg: 7, rings: 3 });
      rod(b, [0, 0, 0], [0, -0.14, 0], 0.03, 7, 0.026);
    },
  },
  /** A clawed hand (origin at the wrist). */
  bmHand: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, -0.028, 0], r: [0.034, 0.036, 0.03], seg: 7, rings: 3 });
      b.paint = fixed(BONE_DARK);
      for (const z of [-0.016, 0, 0.016]) cone(b, [0.016, -0.05, z], [0.034, -0.083, z * 1.2], 0.008, 4);
    },
  },
  /** Antlers: a pack-leader's crown (origin at the head's base). */
  bmCrown: {
    thin: 0.009,
    build(b) {
      b.paint = fixed(BONE);
      for (const s of [-1, 1]) {
        tube(b, [[-0.01, 0.075, s * 0.025], [-0.03, 0.13, s * 0.052], [-0.065, 0.17, s * 0.064], [-0.11, 0.19, s * 0.064]], 0.012, 0.006, 5, true);
        cone(b, [-0.03, 0.13, s * 0.052], [0.005, 0.175, s * 0.062], 0.009, 4);
        cone(b, [-0.065, 0.17, s * 0.064], [-0.05, 0.22, s * 0.07], 0.008, 4);
      }
    },
  },
  /** A bone club, a great thigh bone (origin at the grip, along +y). */
  bmClub: {
    thin: 0.014,
    build(b) {
      b.paint = fixed(BONE);
      rod(b, [0, -0.04, 0], [0, 0.2, 0], 0.014, 5, 0.017);
      for (const z of [-0.016, 0.016]) ball(b, { c: [0, 0.212, z], r: [0.026, 0.026, 0.024], seg: 6, rings: 3 });
      b.paint = fixed(BONE_DARK);
      ball(b, { c: [0, -0.045, 0], r: [0.021, 0.02, 0.021], seg: 6, rings: 3 });
    },
  },
  /** A crude iron cleaver on a short haft (origin at the grip, along +y, the edge forward). */
  bmCleaver: {
    thin: 0.011,
    build(b) {
      b.axisAt = (_x, y) => [0, y, 0];
      b.paint = fixed(WOOD);
      rod(b, [0, -0.035, 0], [0, 0.09, 0], 0.011, 5);
      b.axisAt = null;
      b.paint = fixed(IRON);
      ball(b, { c: [0.03, 0.15, 0], r: [0.04, 0.07, 0.009], seg: 8, rings: 4 });
      b.paint = fixed(0x8d949c);
      ball(b, { c: [0.064, 0.15, 0], r: [0.009, 0.06, 0.006], seg: 5, rings: 3 });
    },
  },
  /** A bone-tipped spear (the blight's stand-in for a spear company; origin at the grip). */
  bmSpear: {
    thin: 0.009,
    build(b) {
      b.axisAt = (_x, y) => [0, y, 0];
      b.paint = fixed(WOOD);
      rod(b, [0, -0.34, 0], [0, 0.56, 0], 0.009, 5);
      b.paint = fixed(BONE_DARK);
      rod(b, [0, 0.54, 0], [0, 0.58, 0], 0.013, 5);
      b.paint = fixed(BONE);
      cone(b, [0, 0.57, 0], [0, 0.69, 0], 0.017, 5);
      b.axisAt = null;
    },
  },

  // ---------------------------------------------------------------- stone trolls (dye: stone; rags: hide)
  trLeg: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, -0.02, 0], r: [0.072, 0.07, 0.066], seg: 9, rings: 4 });
      rod(b, [0, -0.02, 0], [0.012, -0.088, 0], 0.062, 9, 0.056);
      ball(b, { c: [0.012, -0.088, 0], r: [0.054, 0.05, 0.052], seg: 8, rings: 3 });
      b.paint = shade(0.9);
      rod(b, [0.012, -0.088, 0], [0, -0.135, 0], 0.052, 8, 0.05);
      b.paint = shade(0.75);
      ball(b, { c: [0.026, -0.146, 0], r: [0.072, 0.022, 0.056], seg: 9, rings: 3 });
    },
  },
  trRags: {
    build(b) {
      b.paint = shade(1);
      rags(b, { r0: 0.12, r1: 0.132, y0: 0.04, lens: [0.08, 0.05, 0.035, 0.03, 0.04, 0.07, 0.085, 0.065, 0.04, 0.03, 0.035, 0.06], sx: 0.95, inner: shade(0.55) });
    },
  },
  /** A massive torso of stone: belly, chest, hump, boulder shoulders and plates on the back. */
  trTorso: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0.02, 0.06, 0], r: [0.115, 0.09, 0.125], seg: 11, rings: 4 });
      ball(b, { c: [0.03, 0.165, 0], r: [0.13, 0.116, 0.16], seg: 12, rings: 5 });
      ball(b, { c: [-0.05, 0.19, 0], r: [0.1, 0.1, 0.13], seg: 10, rings: 4 });
      for (const z of [-0.16, 0.16]) ball(b, { c: [0, 0.222, z], r: [0.086, 0.08, 0.08], seg: 9, rings: 4 });
      b.paint = shade(0.82);
      for (const [x, y, z, r] of [[-0.11, 0.2, -0.06, 0.042], [-0.11, 0.2, 0.06, 0.042], [-0.085, 0.25, 0, 0.044], [-0.12, 0.13, 0, 0.04]] as const) {
        ball(b, { c: [x, y, z], r: [r, r * 0.9, r], seg: 6, rings: 3 });
      }
      b.paint = shade(1.14);
      for (const z of [-0.155, 0.155]) ball(b, { c: [0.005, 0.27, z], r: [0.05, 0.026, 0.05], seg: 7, rings: 2 });
      ball(b, { c: [0.085, 0.215, 0], r: [0.06, 0.035, 0.1], seg: 8, rings: 2 });
    },
  },
  trHead: {
    build(b) {
      b.paint = shade(1);
      rod(b, [-0.02, -0.06, 0], [0, 0, 0], 0.06, 8);
      ball(b, { c: [0, 0.035, 0], r: [0.06, 0.048, 0.055], seg: 9, rings: 4 });
      b.paint = shade(0.82);
      ball(b, { c: [0.04, 0.05, 0], r: [0.03, 0.017, 0.058], seg: 7, rings: 3 });
      b.paint = shade(0.92);
      ball(b, { c: [0.04, 0.0, 0], r: [0.05, 0.03, 0.052], seg: 8, rings: 3 });
      ball(b, { c: [0.066, 0.026, 0], r: [0.018, 0.018, 0.02], seg: 6, rings: 3 });
      b.paint = fixed(BONE);
      for (const s of [-1, 1]) cone(b, [0.075, 0.004, s * 0.03], [0.085, 0.04, s * 0.036], 0.01, 4);
    },
  },
  trEyes: {
    glow: true,
    shadow: false,
    thin: 0.009,
    build(b) {
      b.paint = shade(1);
      eyes(b, 0.06, 0.036, 0.022, 0.009);
    },
  },
  /** Glowing cracks across the chest and over the right shoulder (torso frame). */
  trCracks: {
    glow: true,
    shadow: false,
    thin: 0.006,
    build(b) {
      b.paint = shade(1);
      crack(b, [[0.152, 0.235, -0.07], [0.172, 0.19, -0.03], [0.165, 0.15, -0.06], [0.15, 0.11, -0.02], [0.125, 0.07, -0.05]], 0.006);
      crack(b, [[0.168, 0.19, -0.03], [0.17, 0.17, 0.03], [0.158, 0.13, 0.06]], 0.006);
      crack(b, [[0.05, 0.285, 0.12], [0.075, 0.262, 0.16], [0.07, 0.235, 0.2], [0.085, 0.205, 0.226]], 0.006);
    },
  },
  trUarm: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, -0.01, 0], r: [0.072, 0.072, 0.066], seg: 9, rings: 4 });
      rod(b, [0, 0, 0], [0, -0.14, 0], 0.056, 8, 0.048);
    },
  },
  trFarm: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, 0, 0], r: [0.05, 0.05, 0.05], seg: 8, rings: 3 });
      rod(b, [0, 0, 0], [0, -0.15, 0], 0.05, 8, 0.062);
    },
  },
  /** A crack down the front of each forearm. */
  trArmCrack: {
    glow: true,
    shadow: false,
    thin: 0.006,
    build(b) {
      b.paint = shade(1);
      crack(b, [[0.056, -0.025, 0.004], [0.066, -0.075, -0.012], [0.068, -0.12, 0.006]], 0.006);
    },
  },
  /** A great fist (origin at the wrist). */
  trHand: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, -0.04, 0], r: [0.064, 0.058, 0.058], seg: 8, rings: 4 });
      b.paint = shade(0.82);
      ball(b, { c: [0.035, -0.058, 0], r: [0.032, 0.026, 0.054], seg: 7, rings: 3 });
    },
  },
  /** A tree-limb club (origin at the grip, along +y). */
  trClub: {
    thin: 0.022,
    build(b) {
      b.paint = fixed(WOOD);
      rod(b, [0, -0.07, 0], [0, 0.38, 0], 0.022, 7, 0.045);
      b.paint = fixed(CROSSBAR);
      ball(b, { c: [0, 0.4, 0], r: [0.05, 0.05, 0.05], seg: 7, rings: 3 });
      ball(b, { c: [0.024, 0.18, 0.01], r: [0.024, 0.03, 0.024], seg: 6, rings: 3 });
      ball(b, { c: [-0.03, 0.3, -0.01], r: [0.03, 0.035, 0.03], seg: 6, rings: 3 });
      ball(b, { c: [0.01, 0.34, 0.04], r: [0.03, 0.03, 0.028], seg: 6, rings: 3 });
    },
  },
  /** A boulder lashed to a log. */
  trMaul: {
    thin: 0.022,
    build(b) {
      b.paint = fixed(WOOD);
      rod(b, [0, -0.07, 0], [0, 0.34, 0], 0.022, 7, 0.026);
      b.paint = fixed(0x6b645b);
      ball(b, { c: [0, 0.39, 0], r: [0.08, 0.065, 0.1], seg: 8, rings: 4 });
      b.paint = fixed(0x878073);
      ball(b, { c: [0.02, 0.43, 0.02], r: [0.05, 0.03, 0.06], seg: 6, rings: 2 });
      b.paint = fixed(BONE_DARK);
      ball(b, { c: [0, 0.34, 0], r: [0.034, 0.02, 0.034], seg: 6, rings: 2 });
    },
  },

  // ---------------------------------------------------------------- the broodlord (dye: flesh)
  /** A backward-kneed leg ending in a hoof. */
  blLeg: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0.01, -0.02, 0], r: [0.062, 0.066, 0.056], seg: 9, rings: 4 });
      rod(b, [0, -0.012, 0], [0.058, -0.078, 0], 0.05, 8, 0.04);
      ball(b, { c: [0.058, -0.078, 0], r: [0.04, 0.038, 0.038], seg: 7, rings: 3 });
      b.paint = shade(0.85);
      rod(b, [0.058, -0.078, 0], [-0.02, -0.125, 0], 0.035, 7, 0.028);
      b.paint = shade(0.75);
      rod(b, [-0.02, -0.125, 0], [0.004, -0.172, 0], 0.027, 6, 0.024);
      b.paint = fixed(MANE);
      ball(b, { c: [0.012, -0.178, 0], r: [0.038, 0.014, 0.032], seg: 7, rings: 3 });
    },
  },
  blTorso: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0.015, 0.06, 0], r: [0.1, 0.086, 0.11], seg: 11, rings: 4 });
      ball(b, { c: [0.03, 0.16, 0], r: [0.12, 0.1, 0.15], seg: 12, rings: 5 });
      ball(b, { c: [-0.05, 0.19, 0], r: [0.09, 0.09, 0.12], seg: 10, rings: 4 });
      for (const z of [-0.14, 0.14]) ball(b, { c: [0, 0.215, z], r: [0.072, 0.066, 0.066], seg: 8, rings: 3 });
      b.paint = shade(0.78);
      ball(b, { c: [0.035, 0.1, 0], r: [0.095, 0.032, 0.12], seg: 10, rings: 3 });
    },
  },
  /** A shaggy mane over the hump and neck (dyed: MANE, or a face's own), and bone spines down the back. */
  blMane: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [-0.045, 0.232, 0], r: [0.095, 0.062, 0.125], seg: 10, rings: 4 });
      for (const z of [-0.075, 0.075]) ball(b, { c: [0.005, 0.255, z], r: [0.062, 0.05, 0.06], seg: 7, rings: 3 });
      for (const z of [-0.06, 0, 0.06]) cone(b, [-0.09, 0.2, z], [-0.15, 0.27, z * 1.3], 0.03, 5);
      b.paint = fixed(BONE_DARK);
      for (const z of [-0.05, 0.05]) cone(b, [-0.06, 0.26, z], [-0.1, 0.34, z * 1.5], 0.016, 4);
      cone(b, [-0.1, 0.22, 0], [-0.17, 0.3, 0], 0.016, 4);
    },
  },
  /** A short crest instead of the mane: a ridge of dyed bristles along the neck and hump, and the bone spines. */
  blCrest: {
    build(b) {
      b.paint = shade(1);
      for (let i = 0; i < 6; i++) {
        const x = 0.05 - i * 0.03, y = 0.29 - i * 0.012;
        cone(b, [x, y - 0.03, 0], [x - 0.035, y + 0.035, 0], 0.024, 5);
      }
      b.paint = fixed(BONE_DARK);
      for (const z of [-0.05, 0.05]) cone(b, [-0.06, 0.26, z], [-0.1, 0.34, z * 1.5], 0.016, 4);
      cone(b, [-0.1, 0.22, 0], [-0.17, 0.3, 0], 0.016, 4);
    },
  },
  /** A heavy tail from the pelvis (origin at the pelvis, hanging back). */
  blTail: {
    build(b) {
      b.paint = shade(1);
      tube(b, [[-0.07, 0.04, 0], [-0.17, 0.0, 0], [-0.26, -0.05, 0], [-0.33, -0.07, 0]], 0.036, 0.012, 6, true);
    },
  },
  /** A bull's skull with a broad muzzle, great forward-sweeping horns and a second, swept-back pair. */
  blHead: {
    build(b) {
      b.paint = shade(1);
      rod(b, [-0.02, -0.06, 0], [0, 0, 0], 0.056, 8);
      ball(b, { c: [0, 0.042, 0], r: [0.066, 0.056, 0.06], seg: 9, rings: 4 });
      ball(b, { c: [0.06, 0.016, 0], r: [0.056, 0.036, 0.046], seg: 8, rings: 3 });
      b.paint = shade(0.6);
      ball(b, { c: [0.108, 0.02, 0], r: [0.012, 0.014, 0.032], seg: 6, rings: 2 });
      b.paint = shade(0.78);
      ball(b, { c: [0.05, -0.014, 0], r: [0.046, 0.02, 0.042], seg: 7, rings: 3 });
      ball(b, { c: [0.045, 0.07, 0], r: [0.03, 0.014, 0.062], seg: 7, rings: 2 });
      b.paint = fixed(BONE);
      for (const s of [-1, 1]) cone(b, [0.088, -0.006, s * 0.022], [0.094, -0.042, s * 0.024], 0.009, 4);
    },
  },
  /** A boar's skull: a long narrow snout ending in a flat nose, a slim jaw and tusks curling up. */
  blHead1: {
    build(b) {
      b.paint = shade(1);
      rod(b, [-0.02, -0.06, 0], [0, 0, 0], 0.056, 8);
      ball(b, { c: [0, 0.042, 0], r: [0.064, 0.054, 0.058], seg: 9, rings: 4 });
      ball(b, { c: [0.075, 0.014, 0], r: [0.078, 0.03, 0.036], seg: 8, rings: 3 });
      b.paint = shade(0.6);
      ball(b, { c: [0.152, 0.016, 0], r: [0.01, 0.024, 0.028], seg: 6, rings: 2 });
      b.paint = shade(0.78);
      ball(b, { c: [0.06, -0.012, 0], r: [0.058, 0.016, 0.03], seg: 7, rings: 3 });
      ball(b, { c: [0.045, 0.068, 0], r: [0.03, 0.014, 0.06], seg: 7, rings: 2 });
      b.paint = fixed(BONE);
      for (const s of [-1, 1]) cone(b, [0.075, -0.012, s * 0.03], [0.062, 0.05, s * 0.052], 0.011, 4);
    },
  },
  /** An ape's skull: a short deep muzzle over a heavy jaw, the fangs of an underbite. */
  blHead2: {
    build(b) {
      b.paint = shade(1);
      rod(b, [-0.02, -0.06, 0], [0, 0, 0], 0.058, 8);
      ball(b, { c: [0, 0.042, 0], r: [0.066, 0.058, 0.062], seg: 9, rings: 4 });
      ball(b, { c: [0.05, 0.012, 0], r: [0.046, 0.04, 0.05], seg: 8, rings: 3 });
      b.paint = shade(0.6);
      ball(b, { c: [0.09, 0.024, 0], r: [0.01, 0.014, 0.026], seg: 6, rings: 2 });
      b.paint = shade(0.78);
      ball(b, { c: [0.052, -0.028, 0], r: [0.052, 0.03, 0.054], seg: 8, rings: 3 });
      ball(b, { c: [0.045, 0.074, 0], r: [0.036, 0.02, 0.068], seg: 7, rings: 2 });
      b.paint = fixed(BONE);
      for (const s of [-1, 1]) cone(b, [0.088, -0.02, s * 0.026], [0.092, 0.014, s * 0.028], 0.009, 4);
    },
  },
  /** The broodlord's horns (fixed bone; thin enough to need the swell far away). */
  blHorns: { thin: 0.008, build: (b) => HORN_SHAPES[0](b, fixed(BONE_DARK), fixed(BONE)) },
  /** Ram's curls: each horn rolls back, down and forward round the ear (a face's variant, person.ts `brute`). */
  blHorns1: { thin: 0.008, build: (b) => HORN_SHAPES[1](b, fixed(BONE_DARK), fixed(BONE)) },
  /** Tall horns sweeping up and out like a lyre, with a short back pair (a face's variant, person.ts `brute`). */
  blHorns2: { thin: 0.008, build: (b) => HORN_SHAPES[2](b, fixed(BONE_DARK), fixed(BONE)) },
  /** The same three, dyed: a face's black or ash horns (the root a shade darker). */
  blHornsD0: { thin: 0.008, build: (b) => HORN_SHAPES[0](b, shade(0.8), shade(1)) },
  blHornsD1: { thin: 0.008, build: (b) => HORN_SHAPES[1](b, shade(0.8), shade(1)) },
  blHornsD2: { thin: 0.008, build: (b) => HORN_SHAPES[2](b, shade(0.8), shade(1)) },
  blEyes: {
    glow: true,
    shadow: false,
    thin: 0.011,
    build(b) {
      b.paint = shade(1);
      eyes(b, 0.062, 0.05, 0.027, 0.012);
    },
  },
  /** An ember heart burst open in the chest (torso frame). */
  blHeart: {
    glow: true,
    shadow: false,
    thin: 0.007,
    build(b) {
      b.paint = shade(1);
      const c: V3 = [0.152, 0.168, 0];
      for (const p of [[0.135, 0.235, -0.035], [0.13, 0.11, 0.04], [0.125, 0.17, 0.09], [0.13, 0.195, -0.085], [0.118, 0.1, -0.05]] as V3[]) {
        const m: V3 = [(c[0] + p[0]) / 2 + 0.008, (c[1] + p[1]) / 2, (c[2] + p[2]) / 2 + 0.01];
        crack(b, [c, m, p], 0.007);
      }
      b.axisAt = () => c;
      ball(b, { c, r: [0.016, 0.026, 0.024], seg: 6, rings: 3 });
      b.axisAt = null;
    },
  },
  blUarm: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, -0.008, 0], r: [0.062, 0.062, 0.058], seg: 9, rings: 4 });
      rod(b, [0, 0, 0], [0, -0.14, 0], 0.048, 8, 0.04);
    },
  },
  blFarm: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, 0, 0], r: [0.042, 0.042, 0.042], seg: 7, rings: 3 });
      rod(b, [0, 0, 0], [0, -0.15, 0], 0.042, 8, 0.036);
      b.paint = fixed(BONE_DARK);
      cone(b, [-0.03, -0.01, 0], [-0.075, 0.02, 0], 0.016, 4);
    },
  },
  /** A great claw (origin at the wrist). */
  blHand: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, -0.03, 0], r: [0.046, 0.046, 0.04], seg: 8, rings: 3 });
      b.paint = fixed(BONE);
      for (const z of [-0.026, 0, 0.026]) cone(b, [0.022, -0.055, z], [0.052, -0.115, z * 1.2], 0.012, 4);
    },
  },

  // ---------------------------------------------------------------- drakes (dye: hide)
  /** The barrel, chest and haunches, a paler belly, and bone spines down the back (origin at the body centre). */
  drBody: {
    build(b) {
      b.paint = shade(1);
      rod(b, [-0.16, 0, 0], [0.14, 0, 0], 0.085, 12, 0.08, false);
      ball(b, { c: [0.15, -0.005, 0], r: [0.1, 0.095, 0.085], seg: 10, rings: 4 });
      ball(b, { c: [-0.15, 0.015, 0], r: [0.1, 0.1, 0.09], seg: 10, rings: 4 });
      for (const z of [-1, 1]) {
        ball(b, { c: [0.12, -0.02, z * 0.055], r: [0.06, 0.075, 0.045], seg: 7, rings: 3 });
        ball(b, { c: [-0.14, -0.02, z * 0.06], r: [0.08, 0.09, 0.05], seg: 7, rings: 3 });
      }
      b.paint = shade(1.32);
      ball(b, { c: [0, -0.045, 0], r: [0.17, 0.05, 0.066], seg: 10, rings: 3 });
      b.paint = fixed(BONE_DARK);
      for (const x of [-0.17, -0.09, -0.01, 0.07, 0.15]) cone(b, [x, 0.075, 0], [x - 0.035, 0.125, 0], 0.017, 4);
    },
  },
  /** Ember seams along both flanks (body frame). */
  drSeams: {
    glow: true,
    shadow: false,
    thin: 0.006,
    build(b) {
      b.paint = shade(1);
      for (const s of [-1, 1]) crack(b, [[0.07, 0.012, s * 0.089], [0.025, 0.04, s * 0.085], [-0.03, 0.002, s * 0.088], [-0.075, 0.03, s * 0.092]], 0.006);
    },
  },
  /** Both wings, folded along the flanks: the bony arm, an elbow claw and the dark membrane (body frame). */
  drWings: {
    build(b) {
      for (const s of [-1, 1]) {
        b.paint = shade(0.55);
        ball(b, { c: [-0.085, 0.085, s * 0.104], r: [0.15, 0.06, 0.014], seg: 10, rings: 4 });
        b.paint = shade(0.78);
        rod(b, [0.08, 0.06, s * 0.07], [-0.02, 0.155, s * 0.1], 0.019, 6, 0.016);
        rod(b, [-0.02, 0.155, s * 0.1], [-0.23, 0.1, s * 0.11], 0.015, 6, 0.01);
        b.paint = fixed(BONE);
        cone(b, [-0.02, 0.155, s * 0.1], [0.005, 0.2, s * 0.108], 0.012, 4);
      }
    },
  },
  /** One neck segment from its base along +x, with a paler throat and a spine. */
  drNeck: {
    build(b) {
      b.paint = shade(1);
      rod(b, [-0.012, 0, 0], [0.122, 0, 0], 0.048, 9, 0.042);
      b.paint = shade(1.3);
      ball(b, { c: [0.056, -0.025, 0], r: [0.068, 0.025, 0.032], seg: 7, rings: 3 });
      b.paint = fixed(BONE_DARK);
      cone(b, [0.05, 0.04, 0], [0.022, 0.078, 0], 0.013, 4);
    },
  },
  /** The ember seam down each neck segment's throat (glows hot while it breathes). */
  drThroat: {
    glow: true,
    shadow: false,
    thin: 0.006,
    build(b) {
      b.paint = shade(1);
      crack(b, [[0, -0.049, 0.012], [0.058, -0.052, -0.006], [0.118, -0.046, 0.008]], 0.006);
    },
  },
  /** The skull and snout (origin at the head joint, +x forward), its teeth, brow and swept-back horns. */
  drHead: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0.025, 0.012, 0], r: [0.06, 0.045, 0.048], seg: 9, rings: 4 });
      rod(b, [0.03, 0.005, 0], [0.135, -0.006, 0], 0.034, 8, 0.024);
      b.paint = shade(0.9);
      ball(b, { c: [0.136, -0.004, 0], r: [0.022, 0.02, 0.024], seg: 6, rings: 3 });
      b.paint = shade(0.75);
      for (const s of [-1, 1]) ball(b, { c: [0.05, 0.04, s * 0.026], r: [0.032, 0.013, 0.016], seg: 6, rings: 2 });
      b.paint = fixed(BONE);
      for (const x of [0.07, 0.1, 0.125]) for (const s of [-1, 1]) cone(b, [x, -0.018, s * 0.019], [x, -0.034, s * 0.019], 0.006, 4);
      b.paint = fixed(BONE_DARK);
      for (const s of [-1, 1]) cone(b, [-0.02, 0.02, s * 0.044], [-0.065, 0.0, s * 0.072], 0.012, 4);
    },
  },
  drHorns: {
    thin: 0.008,
    build(b) {
      b.paint = fixed(BONE);
      for (const s of [-1, 1]) {
        tube(b, [[0, 0.035, s * 0.03], [-0.06, 0.072, s * 0.046], [-0.12, 0.086, s * 0.052], [-0.17, 0.07, s * 0.052]], 0.02, 0.006, 6, true);
        tube(b, [[0.01, 0.028, s * 0.042], [-0.04, 0.045, s * 0.07], [-0.08, 0.04, s * 0.086]], 0.012, 0.005, 5, true);
      }
    },
  },
  /** The lower jaw (origin at the hinge, +x forward). */
  drJaw: {
    build(b) {
      b.paint = shade(0.85);
      rod(b, [0, 0, 0], [0.11, -0.004, 0], 0.026, 7, 0.017);
      b.paint = fixed(BONE);
      for (const x of [0.05, 0.08, 0.1]) for (const s of [-1, 1]) cone(b, [x, 0.012, s * 0.016], [x, 0.027, s * 0.016], 0.005, 4);
    },
  },
  /** The hot inside of the open mouth (head frame). */
  drMaw: {
    glow: true,
    shadow: false,
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0.07, -0.024, 0], r: [0.055, 0.012, 0.02], seg: 7, rings: 3 });
    },
  },
  drEyes: {
    glow: true,
    shadow: false,
    thin: 0.009,
    build(b) {
      b.paint = shade(1);
      eyes(b, 0.062, 0.03, 0.035, 0.009);
    },
  },
  /** One tail segment from its base along −x (each is drawn smaller than the one before). */
  drTail: {
    build(b) {
      b.paint = shade(1);
      rod(b, [0.01, 0, 0], [-0.128, 0, 0], 0.048, 8, 0.04);
      b.paint = fixed(BONE_DARK);
      cone(b, [-0.06, 0.036, 0], [-0.092, 0.068, 0], 0.012, 4);
    },
  },
  /** A bone spade at the tail's end. */
  drTailTip: {
    build(b) {
      b.paint = fixed(BONE);
      cone(b, [0.01, 0, 0], [-0.09, 0, 0], 0.024, 5);
      for (const s of [-1, 1]) cone(b, [-0.02, 0, 0], [0.0, 0.004, s * 0.05], 0.012, 4);
    },
  },
  /** Front leg: the upper (from the shoulder joint, hanging −y) and the lower with a clawed foot. */
  drArmU: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, -0.005, 0], r: [0.04, 0.046, 0.036], seg: 7, rings: 3 });
      rod(b, [0, 0, 0], [0, -DRAKE.upper, 0], 0.032, 7, 0.025);
    },
  },
  drArmL: {
    build(b) {
      b.paint = shade(0.85);
      rod(b, [0, 0, 0], [0, -DRAKE.lower, 0], 0.023, 6, 0.018);
      b.paint = shade(0.72);
      ball(b, { c: [0.016, -DRAKE.lower - 0.004, 0], r: [0.032, 0.012, 0.026], seg: 7, rings: 3 });
      b.paint = fixed(BONE_DARK);
      for (const z of [-0.013, 0.013]) cone(b, [0.036, -DRAKE.lower - 0.006, z], [0.058, -DRAKE.lower - 0.012, z], 0.007, 4);
    },
  },
  drThigh: {
    build(b) {
      b.paint = shade(1);
      ball(b, { c: [0, -0.012, 0], r: [0.062, 0.066, 0.046], seg: 8, rings: 3 });
      rod(b, [0, 0, 0], [0, -DRAKE.thigh, 0], 0.04, 7, 0.03);
    },
  },
  drShin: {
    build(b) {
      b.paint = shade(0.85);
      rod(b, [0, 0, 0], [0, -DRAKE.shin, 0], 0.027, 6, 0.02);
      b.paint = shade(0.72);
      ball(b, { c: [0.02, -DRAKE.shin - 0.004, 0], r: [0.04, 0.013, 0.028], seg: 7, rings: 3 });
      b.paint = fixed(BONE_DARK);
      for (const z of [-0.014, 0.014]) cone(b, [0.045, -DRAKE.shin - 0.006, z], [0.07, -DRAKE.shin - 0.012, z], 0.008, 4);
    },
  },
  /** The breath: a unit jet along +x (scaled to the cone in tiles), unlit and dithered. */
  flame: {
    flame: true,
    shadow: false,
    build(b) {
      b.paint = shade(1);
      flameCone(b);
    },
  },

  // ---------------------------------------------------------------- the blight's standards (tiles)
  /** A crooked pole, unit height (scaled to the standard's). */
  bsPole: {
    thin: 0.018,
    build(b) {
      b.paint = fixed(POLE);
      const pts: V3[] = [[0, 0, 0], [0.026, 0.3, 0.012], [-0.022, 0.6, -0.01], [0.014, 0.84, 0.006], [0, 1, 0]];
      for (let i = 0; i < pts.length - 1; i++) rod(b, pts[i], pts[i + 1], 0.02 - i * 0.0012, 5, 0.02 - (i + 1) * 0.0012);
    },
  },
  /** A crooked branch for a crossbar, unit length along x, with a broken twig. */
  bsBar: {
    thin: 0.015,
    build(b) {
      b.paint = fixed(CROSSBAR);
      const pts: V3[] = [[-0.5, 0.012, 0], [-0.16, -0.012, 0.004], [0.2, 0.01, -0.004], [0.5, -0.012, 0]];
      for (let i = 0; i < pts.length - 1; i++) rod(b, pts[i], pts[i + 1], 0.016, 5);
      cone(b, [0.32, 0.0, 0], [0.4, 0.07, 0], 0.012, 4);
    },
  },
  /** A horned skull lashed to the pole's top, facing the viewer (+z). */
  bsTotem: {
    build(b) {
      b.paint = fixed(BONE);
      ball(b, { c: [0, 0.075, 0], r: [0.066, 0.06, 0.06], seg: 9, rings: 4 });
      ball(b, { c: [0, 0.042, 0.052], r: [0.036, 0.03, 0.045], seg: 7, rings: 3 });
      b.paint = fixed(BONE);
      for (const s of [-1, 1]) {
        tube(b, [[s * 0.05, 0.1, 0], [s * 0.11, 0.14, -0.012], [s * 0.145, 0.2, 0], [s * 0.125, 0.262, 0.02]], 0.022, 0.006, 5, true);
        cone(b, [s * 0.11, 0.14, -0.012], [s * 0.16, 0.13, 0.02], 0.01, 4);
      }
      b.paint = fixed(MANE);
      for (const s of [-1, 1]) ball(b, { c: [s * 0.026, 0.082, 0.05], r: [0.018, 0.016, 0.012], seg: 6, rings: 2 });
      ball(b, { c: [0, -0.01, 0], r: [0.03, 0.03, 0.03], seg: 6, rings: 2 });
    },
  },
  /** The ember eyes in the totem's sockets. */
  bsEyes: {
    glow: true,
    shadow: false,
    thin: 0.012,
    build(b) {
      b.paint = shade(1);
      for (const s of [-1, 1]) {
        const c: V3 = [s * 0.026, 0.082, 0.058];
        b.axisAt = () => c;
        ball(b, { c, r: [0.012, 0.012, 0.008], seg: 6, rings: 2 });
      }
      b.axisAt = null;
    },
  },
  /** The broodlord's totem: a great bull's skull with ram's curls and a crown of spines. */
  bsLordTotem: {
    build(b) {
      b.paint = fixed(BONE);
      ball(b, { c: [0, 0.1, 0], r: [0.09, 0.08, 0.08], seg: 10, rings: 4 });
      ball(b, { c: [0, 0.055, 0.07], r: [0.05, 0.04, 0.06], seg: 8, rings: 3 });
      for (const s of [-1, 1]) {
        tube(b, [[s * 0.07, 0.13, 0], [s * 0.15, 0.17, -0.02], [s * 0.21, 0.24, 0], [s * 0.2, 0.33, 0.03], [s * 0.15, 0.37, 0.05]], 0.032, 0.008, 6, true);
        tube(b, [[s * 0.06, 0.08, -0.02], [s * 0.13, 0.05, -0.03], [s * 0.17, 0.0, 0.0], [s * 0.15, -0.04, 0.03]], 0.024, 0.006, 5, true);
      }
      b.paint = fixed(BONE_DARK);
      for (const x of [-0.04, 0, 0.04]) cone(b, [x, 0.16, -0.01], [x * 1.4, 0.26 - Math.abs(x), -0.02], 0.014, 4);
      b.paint = fixed(MANE);
      for (const s of [-1, 1]) ball(b, { c: [s * 0.034, 0.11, 0.068], r: [0.022, 0.02, 0.014], seg: 6, rings: 2 });
      ball(b, { c: [0, -0.015, 0], r: [0.04, 0.04, 0.04], seg: 6, rings: 2 });
    },
  },
  bsLordEyes: {
    glow: true,
    shadow: false,
    thin: 0.014,
    build(b) {
      b.paint = shade(1);
      for (const s of [-1, 1]) {
        const c: V3 = [s * 0.034, 0.11, 0.077];
        b.axisAt = () => c;
        ball(b, { c, r: [0.015, 0.015, 0.01], seg: 6, rings: 2 });
      }
      b.axisAt = null;
    },
  },
  /** A bone fang on a thong, hung from the crossbar: one per rank (the blight's chevrons). */
  bsFang: {
    thin: 0.008,
    shadow: false,
    build(b) {
      b.paint = fixed(MANE);
      rod(b, [0, 0, 0], [0, -0.05, 0], 0.006, 4);
      b.paint = fixed(BONE);
      cone(b, [0, -0.045, 0], [0.01, -0.13, 0], 0.017, 5);
    },
  },
} satisfies Record<string, PartDef>;
