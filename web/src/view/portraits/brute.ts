import { hash32 } from '../figures/hash';
import type { Look } from '../figures/outfit';
import { BONE, BONE_DARK, EMBER, FLAME } from '../figures/palette';
import type { Brute } from '../figures/person';
import { boxed, clip, ellipsoid, oval, Pic, poly, ramp, stroke, union, type Shape } from './paint';
import { mixHex, mulHex } from './post';
import { INK } from './warden';

// A broodlord's face (00-start-here.md §A2; out/decisions-blight-view.md "The broodlord"): a bull's skull with a
// broad muzzle, ember eyes under a heavy brow, horns, a shaggy mane over the hump and the ember heart burst open in
// its chest, turned three quarters to the picture's right like every face. Its flesh, horns and their length, mane,
// eyes, tusks and scar follow its face seed (person.ts `brute`), as its figure on the field does.

const EYE_Y = 40;
type Pt = readonly [number, number];

/** The horns' centrelines, root first, by style: [near horn, far horn, the near back horn or none]. */
const HORNS: readonly (readonly (readonly Pt[])[])[] = [
  // the great pair, spreading wide to the sides and turning up and forward, and a swept-back pair
  [
    [[32, 28], [22, 27], [12, 24], [5, 18], [4, 11], [7, 6]],
    [[46, 26], [56, 24], [66, 20], [72, 13], [74, 7]],
    [[29, 32], [22, 34], [16, 39]],
  ],
  // ram's curls round the ears
  [
    [[32, 28], [25, 23], [18, 25], [15, 32], [17, 40], [23, 43], [27, 39], [25, 34]],
    [[46, 26], [53, 21], [60, 23], [62, 30], [59, 36], [55, 35]],
    [],
  ],
  // tall and upswept, with a short back pair
  [
    [[32, 28], [27, 20], [25, 11], [27, 3], [31, 0]],
    [[46, 26], [50, 17], [53, 9], [58, 3], [62, 1]],
    [[29, 32], [23, 33], [19, 36]],
  ],
];

const grow = (pts: readonly Pt[], k: number): Pt[] => pts.map(([x, y]) => [pts[0][0] + (x - pts[0][0]) * k, pts[0][1] + (y - pts[0][1]) * k] as const);

/** A shaggy outline: an ellipse whose radius is torn by the seed into tufts. */
function shaggy(cx: number, cy: number, rx: number, ry: number, seed: number, salt: number): Shape {
  const base = ellipsoid(cx, cy, rx, ry);
  return boxed((x, y) => {
    const a = Math.atan2((y - cy) / ry, (x - cx) / rx);
    const k = Math.floor(((a + Math.PI) / (2 * Math.PI)) * 22);
    const t = 0.86 + (hash32(seed, salt, k) % 100) / 100 * 0.14 + 0.05 * Math.sin(a * 22);
    const u = (x - cx) / (rx * t), v = (y - cy) / (ry * t);
    if (u * u + v * v > 1) return null;
    return base(cx + (x - cx) / t * 0.98, cy + (y - cy) / t * 0.98) ?? [0, 0, 1];
  }, cx - rx * 1.1, cy - ry * 1.1, cx + rx * 1.1, cy + ry * 1.1);
}

export function paintBrute(look: Look, b: Brute, bg: number): Pic {
  const pic = new Pic(bg);
  const flesh = ramp(look.flesh);
  const mane = ramp(look.mane);
  const bone = ramp(BONE);
  const boneDark = ramp(BONE_DARK);
  // the horns' own colour: bone (with the bone-dark root, as on the field), or black or ash with a darker root
  const hornBody = ramp(b.hornColour);
  const hornRoot = b.hornColour === BONE ? boneDark : ramp(mulHex(b.hornColour, 0.8));
  const seed = b.seed;
  const strands = (x: number, y: number) => (hash32(seed, x, (y >> 1) + 7) % 4 === 0 ? -1 : 0);
  const rings = (x: number, y: number) => ((x + 2 * y) % 5 === 0 ? -1 : 0);
  const [near, far, back] = HORNS[b.horns].map((h) => grow(h, b.hornLen));
  // a broken horn tip: the far horn ends short and flat
  const farHorn = b.scar === 1 ? far.slice(0, Math.max(2, far.length - 2)) : far;
  const horn = (pts: readonly Pt[], r0: number) => {
    pic.fill(stroke(pts.slice(0, 2), r0 + 0.3, r0), hornRoot, { edge: INK });
    pic.fill(stroke(pts.slice(1), r0, pts.length > 3 ? 0.7 : 1.1), hornBody, { edge: b.hornColour === BONE ? boneDark[0] : INK, tex: rings });
  };

  // ---------------------------------------------------------------- behind the head: mane, far horn, back horns
  if (b.maneShape === 2) pic.fill(shaggy(34, 52, 28, 23, seed, 1), mane, { edge: mane[0], tex: strands, bias: -1 });
  horn(farHorn, 3.1);
  if (back.length) horn(back, 2.2);

  // ---------------------------------------------------------------- the body: hump, chest, the ember heart
  const body = ellipsoid(42, 102, 44, 37, 2.2);
  pic.fill(body, flesh, { edge: flesh[0] });
  // the heart burst open in the chest
  // the heart burst open in the chest, in the eyes' glow (the ember's, or a green or pale one)
  const heart: Pt = [47, 86];
  const ember = b.eyes === FLAME[1];
  const hot = ember ? FLAME[2] : b.eyes, white = ember ? FLAME[3] : mixHex(b.eyes, 0xffffff, 0.5);
  for (const [dx, dy] of [[-6, -6], [5, -5], [7, 3], [-5, 5], [1, 8]] as const) pic.line(heart[0], heart[1], heart[0] + dx, heart[1] + dy, b.eyeRim);
  for (const [dx, dy] of [[-3, -3], [3, -2], [3, 2], [-2, 3]] as const) pic.line(heart[0], heart[1], heart[0] + dx, heart[1] + dy, b.eyes);
  pic.fill(ellipsoid(heart[0], heart[1], 2.2, 2.6), [b.eyes, hot, hot, white, white], { edge: b.eyes });
  // the mane falls over the shoulders, in front of the hump; without one, a bare thick neck
  if (b.maneShape === 2) pic.fill(clip(shaggy(36, 64, 24, 11, seed, 2), (x, y) => y > 55 && x < 60), mane, { edge: mane[0], tex: strands });
  else pic.fill(poly([[27, 44], [51, 46], [62, 72], [12, 72]]), flesh, { edge: flesh[0], bias: -1 });
  if (b.maneShape === 1) {
    // a crest: a ridge of bristles standing up from the crown and down the back of the neck to the hump
    const spine: Pt[] = [[34, 23], [27, 29], [23, 38], [20, 48], [17, 60]];
    const ridge: Shape[] = [stroke(spine, 2.4, 2.8)];
    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      const k = Math.min(spine.length - 2, Math.floor(t * (spine.length - 1)));
      const f = t * (spine.length - 1) - k;
      const x = spine[k][0] + (spine[k + 1][0] - spine[k][0]) * f, y = spine[k][1] + (spine[k + 1][1] - spine[k][1]) * f;
      const len = 13 - 5 * t, ang = -1.85 - 0.8 * t, w = 3.2;
      ridge.push(poly([[x + w * Math.sin(ang), y - w * Math.cos(ang)], [x + Math.cos(ang) * len, y + Math.sin(ang) * len], [x - w * Math.sin(ang), y + w * Math.cos(ang)]]));
    }
    pic.fill(union(...ridge), mane, { edge: mane[0], tex: strands });
  }

  // ---------------------------------------------------------------- ears, under the horns
  pic.fill(oval(56.5, 33, 4.5, 2.1, -0.45), flesh, { edge: flesh[0], bias: -1 });
  pic.fill(oval(24.5, 37, 6, 2.7, 0.35), flesh, { edge: flesh[0] });
  pic.line(21, 36, 26, 38, flesh[1]);
  if (b.scar === 3) {
    pic.px(19, 35, bg);
    pic.px(20, 36, bg);
    pic.px(20, 35, bg);
  }

  // ---------------------------------------------------------------- the skull, by muzzle: bull, boar, ape
  let cranium: Shape, snout: Shape, under: Shape;
  if (b.muzzle === 1) {
    cranium = ellipsoid(39, 36.5, 14, 13);
    snout = union(oval(52.5, 46, 13, 6, 0.12), ellipsoid(64, 47.5, 2.4, 3.6));
    under = clip(oval(52.5, 46, 13, 6, 0.12), (_, y) => y > 49);
  } else if (b.muzzle === 2) {
    cranium = ellipsoid(39.5, 35.5, 15, 13.5);
    snout = union(ellipsoid(48.5, 46, 9, 8), ellipsoid(47.5, 53, 11, 5.5));
    under = ellipsoid(47.5, 53, 11, 5.5);
  } else {
    cranium = ellipsoid(39.5, 36.5, 14.5, 13.5);
    snout = ellipsoid(49.5, 47, 11, 8.5);
    under = clip(snout, (_, y) => y > 51);
  }
  pic.fill(union(snout, cranium), flesh, { edge: flesh[0], head: true });
  // the underside of the jaw in shade, the bridge of the muzzle in light
  pic.shadeOver(under, flesh, -1);
  pic.shadeOver(b.muzzle === 1 ? oval(54, 43.5, 7, 1.6, 0.12) : ellipsoid(51, 43.5, 4.5, 2), flesh, 1);
  // the brow: a heavy ridge in light over deep sockets
  pic.shadeOver(oval(46, 36, 11, b.muzzle === 2 ? 2.4 : 1.6, -0.05), flesh, 1);
  pic.shadeOver(ellipsoid(42.5, 40, 4.2, 2.6), flesh, -2);
  pic.shadeOver(ellipsoid(51.2, 40, 2.8, 2.4), flesh, -2);
  // the hide's markings, a step darker (stripes) or lighter (blotches) on every pixel of flesh
  if (b.pattern === 1) pic.shadeOver(boxed((x, y) => ((x * 0.55 + y + (seed & 7)) % 8 < 2.2 ? [0, 0, 1] : null), 0, 0, 80, 96), flesh, -1);
  if (b.pattern === 2) pic.shadeOver(boxed((x, y) => {
    const cx = Math.floor(x / 9), cy = Math.floor(y / 9);
    if (hash32(seed, cx * 31 + cy, 0xb10c) % 3 !== 0) return null;
    const dx = x - (cx * 9 + 4.5), dy = y - (cy * 9 + 4.5);
    return dx * dx + dy * dy < 9 ? [0, 0, 1] : null;
  }, 0, 0, 80, 96), flesh, 1);
  // war-paint
  const pc = b.paintColour;
  if (b.paint === 1) {
    // two bars across the brow
    for (const y of [29, 30, 33, 34]) pic.line(34, y, 48, y - 1, pc);
  } else if (b.paint === 2) {
    // a stripe from the crown down the muzzle, and a line under each eye
    for (const d of [0, 1, 2]) pic.line(46 + d, 25, (b.muzzle === 1 ? 57 : 53) + d, 44, pc);
    pic.line(39, 43, 44, 44, pc);
  } else if (b.paint === 3) {
    // claw marks raked down the cheek
    for (const dx of [0, 3, 6]) {
      pic.line(32 + dx, 41, 36 + dx, 50, pc);
      pic.line(33 + dx, 41, 37 + dx, 50, pc);
    }
  }
  // the eyes, slanting down toward the muzzle (the scarred one dimmer); their rows average to row 40
  const dim = b.scar === 2;
  pic.px(41, EYE_Y - 1, b.eyeRim);
  pic.px(42, EYE_Y, dim ? b.eyeRim : b.eyes);
  pic.px(43, EYE_Y, b.eyes);
  pic.px(44, EYE_Y + 1, b.eyeRim);
  pic.px(50, EYE_Y + 1, b.eyeRim);
  pic.px(51, EYE_Y, b.eyes);
  pic.px(52, EYE_Y - 1, b.eyeRim);
  if (dim) pic.line(40, 35, 44, 45, flesh[0]);
  // nostrils, mouth, fangs, tusks
  if (b.muzzle === 1) {
    pic.px(64, 46, flesh[0]);
    pic.px(64, 49, flesh[0]);
    pic.line(46, 51, 61, 51, flesh[0]);
    pic.fill(stroke([[53, 53], [51, 48.5], [52.5, 44.5]], 1.6, 0.6), bone, { edge: boneDark[0] });
  } else if (b.muzzle === 2) {
    pic.px(55, 44, flesh[0]);
    pic.px(53, 45, flesh[0]);
    pic.line(42, 51, 56, 50, flesh[0]);
    for (const x of [50, 54]) {
      pic.px(x, 50, bone[3]);
      pic.px(x, 49, bone[2]);
    }
  } else {
    pic.px(57, 46, flesh[0]);
    pic.px(57, 47, flesh[0]);
    pic.px(54, 47, flesh[0]);
    pic.line(44, 52, 57, 51, flesh[0]);
    for (const x of [52, 55]) {
      pic.px(x, 52, bone[3]);
      pic.px(x, 53, bone[2]);
    }
  }
  if (b.tusks && b.muzzle !== 1) pic.fill(stroke([[46, 54], [44.5, 50], [45.5, 46.5]], 1.5, 0.6), bone, { edge: boneDark[0] });

  // ---------------------------------------------------------------- the near horn, over the skull
  horn(near, 3.4);
  return pic;
}

/** Every colour a broodlord's portrait may hold, weighted for the palette's k-means. */
export function bruteColours(fleshes: readonly number[], manes: readonly number[], horns: readonly number[], eyes: readonly number[], paints: readonly number[], extra: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  const add = (hex: number, w: number) => out.set(hex, (out.get(hex) ?? 0) + w);
  for (const f of fleshes) for (const c of ramp(f)) add(c, 6);
  for (const m of manes) for (const c of ramp(m)) add(c, 3);
  for (const h of horns) for (const c of [...ramp(h), ...ramp(mulHex(h, 0.8))]) add(c, 2);
  for (const c of ramp(BONE_DARK)) add(c, 2);
  for (const c of [EMBER, ...FLAME, ...eyes, ...paints, INK, ...extra]) add(c, 8);
  // the green and pale hearts' white-hot cores
  for (const c of eyes) if (c !== FLAME[1] && c !== EMBER) add(mixHex(c, 0xffffff, 0.5), 2);
  return out;
}
