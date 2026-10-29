import { FLEUR } from '../figures/atlas';
import { hash32 } from '../figures/hash';
import type { Look } from '../figures/outfit';
import { CLASP, DEVICE } from '../figures/palette';
import type { Person } from '../figures/person';
import { clip, ellipsoid, minus, oval, Pic, poly, ramp, stroke, union } from './paint';
import { mulHex } from './post';

// A warden commander's face, head and shoulders, turned three quarters to the picture's right (01-flow.md §7's
// framing): the eyes on row 40, the middle of the head on column 40, the shoulders cut by the bottom edge. Every part
// follows the figure's look (outfit.ts: skin, hair, beard, headgear, plume, cape, tunic) and the person's details
// (person.ts: hair style, brows, nose, jaw, scar).

/** Colours that are not a ramp: the eyes, and the ink of the outline. */
export const EYE_WHITE = 0xe8dfcc;
export const IRIS = 0x2a221e;
export const INK = 0x16120f;

/** Shapes of the head (art px on the 80×96 tile). */
const CRANIUM = { cx: 40, cy: 33.5, rx: 15, ry: 16.5 };
const EYE_Y = 40;

export function paintWarden(look: Look, p: Person, bg: number): Pic {
  const pic = new Pic(bg);
  const skin = ramp(look.skin);
  const hair = ramp(look.hair);
  const seed = p.seed;
  const strands = (x: number, y: number) => (hash32(seed, x, y >> 1) % 5 === 0 ? -1 : 0);
  const hooded = look.head === 'hood' || look.head === 'coif+nasal';
  const helmed = look.head !== 'none' && !hooded;

  // ---------------------------------------------------------------- the jaw, by the person's jaw
  const jrx = 11.2 + p.jaw * 0.8;
  const jaw = ellipsoid(43.5, 45, jrx, 12.5, p.jaw === 1 ? 2.7 : 2);
  const cranium = ellipsoid(CRANIUM.cx, CRANIUM.cy, CRANIUM.rx, CRANIUM.ry);
  const head = union(jaw, cranium);

  // ---------------------------------------------------------------- shoulders: tunic, sleeves, collar, cape
  const body = ramp(look.body);
  const torso = ellipsoid(40, 97, 39.5, 30, 3);
  pic.fill(torso, body, { edge: body[0] });
  if (look.sleeve !== look.body) {
    const sl = ramp(look.sleeve);
    const mail = look.sleeve === 0x8d949c;
    pic.fill(clip(torso, (x, y) => Math.abs(x - 40) > 27 - (y - 68) * 0.3), sl, { edge: sl[0], tex: mail ? (x, y) => ((x + y) & 1 ? 0 : -1) : undefined });
  }
  // long hair falls behind the head, over the near shoulder; a tail hangs from a tie
  if (!hooded && p.style === 'long') pic.fill(poly([[25, 34], [36, 40], [37, 58], [35, 72], [22, 74], [21, 50]]), hair, { edge: hair[0], tex: strands, bias: -1 });
  if (!hooded && p.style === 'tied') pic.fill(stroke([[25, 38], [20, 46], [19, 58]], 3.2, 1.6), hair, { edge: hair[0], tex: strands, bias: -1 });
  // the tabard's device, cream on the chest (the banners' fleur, 02-look.md §6)
  FLEUR.forEach((row, dy) => [...row].forEach((ch, dx) => ch === '#' && pic.px(41 + dx, 84 + dy, DEVICE)));
  const collar = ramp(mulHex(look.body, 0.72));
  pic.fill(clip(ellipsoid(40.5, 70, 12, 4.2), (_, y) => y < 70.5), collar, { edge: collar[0] });

  // ---------------------------------------------------------------- the neck, shaded under the jaw
  pic.fill(poly([[34, 50], [47, 50], [49, 70], [32, 70]]), skin, { edge: skin[0], bias: -1 });
  pic.shadeOver(ellipsoid(44, 50, 12.5, 12.5), skin, -1);
  pic.fill(clip(ellipsoid(40.5, 70, 12, 4.2), (_, y) => y >= 70.5), collar, { edge: collar[0] });
  if (look.cape !== null) {
    const cape = ramp(look.cape);
    pic.fill(union(clip(ellipsoid(40, 97, 41, 31.5, 3), (x, y) => Math.abs(x - 40) > 21 - (y - 68) * 0.2), clip(ellipsoid(40, 71, 21, 6), (_, y) => y < 72 && y > 66)), cape, { edge: cape[0] });
    for (const cx of [31, 49]) {
      pic.px(cx, 69, CLASP);
      pic.px(cx + 1, 69, CLASP);
      pic.px(cx, 70, mulHex(CLASP, 0.7));
      pic.px(cx + 1, 70, mulHex(CLASP, 0.7));
    }
  }

  // ---------------------------------------------------------------- the head
  pic.fill(head, skin, { edge: skin[0], head: true });
  // the near cheek catches the light; the far side of the face turns away
  pic.shadeOver(ellipsoid(39.5, 45, 3.2, 2.2), skin, 1);
  // the ear (hidden under a hood or a coif)
  if (!hooded) {
    pic.fill(oval(30.5, 42.5, 2.6, 4.6, 0.12), skin, { edge: skin[0] });
    pic.px(30, 42, skin[1]);
    pic.px(30, 43, skin[1]);
    pic.px(31, 44, skin[2]);
  }
  // eye sockets in shade
  pic.shadeOver(ellipsoid(42.5, 39, 3.8, 2.3), skin, -1);
  pic.shadeOver(ellipsoid(51.3, 39, 2.3, 2.3), skin, -1);
  // the scar under everything that lies on the skin
  if (p.scar === 1) pic.line(38, 44, 41, 48, skin[4]);
  if (p.scar === 2) pic.line(42, 35, 44, 38, skin[4]);
  if (p.scar === 3) pic.line(46, 43, 49, 42, skin[4]);
  // eyes: small, looking the way the head turns
  pic.line(41, EYE_Y - 1, 43, EYE_Y - 1, skin[0]);
  pic.px(41, EYE_Y, EYE_WHITE);
  pic.px(42, EYE_Y, IRIS);
  pic.px(43, EYE_Y, IRIS);
  pic.line(50, EYE_Y - 1, 52, EYE_Y - 1, skin[0]);
  pic.px(51, EYE_Y, EYE_WHITE);
  pic.px(52, EYE_Y, IRIS);
  // brows in the hair's colour
  const brow = p.brow === 0 ? hair[2] : p.brow === 1 ? hair[1] : hair[0];
  pic.line(40, EYE_Y - 2, 41, EYE_Y - 3, brow);
  pic.line(42, EYE_Y - 3, 44, EYE_Y - 3, brow);
  pic.line(50, EYE_Y - 3, 52, EYE_Y - 3, brow);
  if (p.brow === 2) {
    pic.line(41, EYE_Y - 4, 44, EYE_Y - 4, brow);
    pic.px(51, EYE_Y - 4, brow);
  }
  if (p.scar === 2) pic.px(43, EYE_Y - 3, skin[4]);
  // the nose: its lit side, its profile against the far cheek, the nostril
  const tip = 50.5 + p.nose * 0.8;
  pic.fill(poly([[46.5, 40], [48.5, 39.5], [tip - 0.5, 45], [tip + 0.5, 47.5], [tip - 1.5, 49], [46, 49], [45.5, 46]]), skin, { bias: 1 });
  if (p.nose === 2) pic.line(48, 41, 50, 43, skin[1]);
  pic.line(p.nose === 2 ? 50 : 48, p.nose === 2 ? 43 : 41, Math.round(tip), 46, skin[1]);
  pic.line(46, 48, Math.round(tip) - 1, 48, skin[1]);
  pic.px(Math.round(tip) - 2, 48, skin[0]);
  // the mouth
  pic.line(44, 51, 49, 51, skin[0]);
  pic.px(43, 50, skin[1]);
  pic.line(45, 50, 48, 50, skin[2]);
  pic.line(45, 52, 47, 52, skin[4]);
  pic.px(47, 55, skin[4]);

  // ---------------------------------------------------------------- hair
  // under a hood or a coif, a fringe of the hair shows at the brow (none for the bald)
  if (hooded && p.style !== 'bald' && p.style !== 'receding') pic.fill(clip(ellipsoid(45.5, 33.5, 9.5, 3.8), (_, y) => y < 35), hair, { edge: hair[0], tex: strands });
  if (!hooded && !(helmed && p.style === 'bald')) {
    const hairline = (x: number, y: number): boolean => {
      if (p.style === 'bald') return x < 33 && y > 35 && y < 47;
      const front = p.style === 'receding' ? 21.5 : 25;
      if (x >= 35) return y < front + (x - 35) * 0.12;
      if (x >= 31) return y < 41;
      return y < (p.style === 'short' || p.style === 'receding' ? 47 : 52);
    };
    pic.fill(clip(ellipsoid(40, 32, 16.6, 17.6), hairline), hair, { edge: hair[0], edgeOn: 'out', tex: strands });
    if (p.style === 'tied') {
      pic.fill(ellipsoid(24.5, 35, 4.2, 3.6), hair, { edge: hair[0], tex: strands });
      pic.line(26, 37, 27, 33, hair[0]);
    }
  }

  // ---------------------------------------------------------------- the beard (none under a coif, as on the field)
  if (look.beard >= 0 && look.head !== 'coif+nasal') {
    const o = { edge: hair[0], tex: strands };
    const moustache = poly([[43, 50.5], [46, 48.8], [48, 49.3], [50.5, 48.8], [52, 50.5], [51.5, 52.5], [50, 50.6], [47.5, 50.5], [45, 50.8], [43.5, 52.5]]);
    switch (look.beard) {
      case 0:
        pic.fill(clip(ellipsoid(43.5, 47.5, jrx + 1.8, 15), (x, y) => (y > 49.5 && x > 33) || (x > 31 && x < 35.5 && y > 40)), hair, o);
        pic.fill(moustache, hair, o);
        break;
      case 1:
        pic.fill(clip(ellipsoid(43.5, 46, jrx + 0.8, 13.7), (x, y) => (y > 51.5 && x > 33) || (x > 31 && x < 35 && y > 43)), hair, o);
        break;
      case 2:
        pic.fill(moustache, hair, o);
        break;
      case 3:
        pic.fill(union(poly([[43.5, 51], [48, 52], [46.5, 63], [44.5, 60]]), poly([[48, 52], [53, 50.5], [52.5, 60], [50.5, 63]])), hair, o);
        pic.fill(moustache, hair, o);
        break;
      case 4:
        pic.fill(poly([[43, 51], [53, 50.5], [50, 66]]), hair, o);
        pic.fill(moustache, hair, o);
        break;
      default:
        break;
    }
    // the mouth shows through every beard
    pic.line(45, 51, 49, 51, look.beard === 2 ? skin[0] : hair[0]);
  }

  // ---------------------------------------------------------------- headgear, by the figure's head
  const dye = ramp(look.headDye);
  // the plume first, so the helmet (or hood) holds its foot: rank 1 team [3], rank 3 gold, the captain's red
  if (look.plume !== null) {
    const pl = ramp(look.plume);
    const top: readonly [number, number] = look.head === 'nasal' || look.head === 'coif+nasal' ? [38, 12] : look.head === 'hood' ? [33, 16] : [35, 15];
    pic.fill(stroke([[top[0] + 1, top[1] + 2], [top[0] - 1, top[1] - 2]], 1.3, 1.1), pl, { edge: pl[0], bias: -1 });
    pic.fill(oval(top[0] - 4, top[1] - 6, 3.8, 7.5, -0.6), pl, { edge: pl[0] });
  }
  switch (look.head) {
    case 'kettle': {
      // the brim's shadow on the brow
      pic.shadeOver(ellipsoid(41, 33.5, 25, 4), skin, -1);
      pic.shadeOver(ellipsoid(41, 33.5, 25, 4), hair, -1);
      const brim = ramp(mulHex(look.headDye, 0.86));
      pic.fill(oval(40, 30.5, 26, 4.2, -0.04), brim, { edge: brim[0], bias: 1 });
      pic.fill(clip(ellipsoid(40, 26.5, 17.5, 12.5), (_, y) => y < 29.5), dye, { edge: dye[0] });
      const band = ramp(mulHex(look.headDye, 0.7));
      pic.fill(clip(ellipsoid(40, 26.5, 17.6, 12.6), (_, y) => y >= 26.8 && y < 29.5), band);
      break;
    }
    case 'nasal':
    case 'coif+nasal': {
      if (look.head === 'coif+nasal') {
        const coif = ramp(look.coif);
        const mantle = clip(ellipsoid(40, 96, 33, 30), (_, y) => y < 84);
        pic.fill(minus(union(ellipsoid(40, 38, 18.5, 22.5), mantle), ellipsoid(45.5, 44.5, 10, 12.5)), coif, { edge: coif[0], tex: (x, y) => ((x + y) & 1 ? 0 : -1) });
      }
      pic.fill(union(clip(ellipsoid(40, 27.5, 17, 13), (_, y) => y < 30), poly([[25.5, 25], [38.5, 11], [40.5, 11], [55, 25]])), dye, { edge: dye[0] });
      const band = ramp(mulHex(look.headDye, 0.75));
      pic.fill(clip(ellipsoid(40, 27.5, 17.1, 13.1), (_, y) => y >= 27.2 && y < 30), band);
      pic.fill(stroke([[47.6, 28.5], [48.6, 43.5]], 1.25, 1.1), dye, { edge: dye[0] });
      break;
    }
    case 'hood': {
      const hood = dye;
      const opening = ellipsoid(45.5, 44.5, 10.5, 13.5);
      pic.fill(clip(ellipsoid(40, 94, 35, 27), (_, y) => y < 84), hood, { edge: hood[0], bias: -1 });
      pic.fill(minus(union(ellipsoid(39.5, 37, 19.5, 23), poly([[25, 23], [12, 13], [15.5, 9.5], [33, 18.5]])), opening), hood, { edge: hood[0] });
      break;
    }
    case 'cap': {
      pic.fill(clip(ellipsoid(39, 26.5, 16.8, 11.5), (_, y) => y < 30), dye, { edge: dye[0] });
      const band = ramp(mulHex(look.headDye, 0.78));
      pic.fill(clip(ellipsoid(39, 26.5, 16.9, 11.6), (_, y) => y >= 27.5 && y < 30), band);
      break;
    }
    default:
      break;
  }
  return pic;
}

/** Every colour a warden portrait may hold, with its weight in the palette's k-means (faces matter most). */
export function wardenColours(looks: readonly { look: Look }[], extra: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  const add = (hex: number, w: number) => out.set(hex, (out.get(hex) ?? 0) + w);
  for (const { look } of looks) {
    for (const c of ramp(look.skin)) add(c, 6);
    for (const c of ramp(look.hair)) add(c, 3);
    for (const base of [look.body, look.sleeve, mulHex(look.body, 0.72), look.headDye, mulHex(look.headDye, 0.86), mulHex(look.headDye, 0.7), mulHex(look.headDye, 0.75), mulHex(look.headDye, 0.78), look.coif]) {
      for (const c of ramp(base)) add(c, 1);
    }
    if (look.cape !== null) for (const c of ramp(look.cape)) add(c, 1);
    if (look.plume !== null) for (const c of ramp(look.plume)) add(c, 1);
  }
  for (const c of [EYE_WHITE, IRIS, INK, DEVICE, CLASP, mulHex(CLASP, 0.7), ...extra]) add(c, 8);
  return out;
}

