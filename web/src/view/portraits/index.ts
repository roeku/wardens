import type { Kind, Unit } from '../../contracts';
import { outfit, type Look, type Who } from '../figures/outfit';
import { BRUTE_EYES, BRUTE_FLESH, BRUTE_HORNS, BRUTE_MANES, BRUTE_PAINTS, brute, HAIRS, person, SKINS } from '../figures/person';
import { bruteColours, paintBrute } from './brute';
import { FLAME } from '../figures/palette';
import { EYE_Y, GREYS, grey, kmeans, measure, MID_X, PALETTE_MAX, Quantiser, shift, toCanvas, W, type Img } from './post';
import { EYE_WHITE, INK, IRIS, paintWarden, wardenColours } from './warden';

// Portraits (docs/engine/contracts/campaign.md §6; docs/spec/01-flow.md §7): `portrait(face, side, opts)` is an
// 80×96 canvas, cached. With no Muse Image keys, faces are the kit's fallback (b): procedural pixel faces painted
// from the same look as the commander's figure (out/decisions-d5-faces.md "Procedural faces, not the figure's
// close-up"). Then 01-flow §7's post-process: a flat background per side, every face turned the same way, the eyes on
// row 40 and the middle of the head on column 40, one shared palette of at most 64 colours per side (k-means in Lab,
// no dithering). The grey variant is for the fallen.

export type Side = 'warden' | 'blight';
export interface PortraitOpts {
  /** The fallen: the colour portrait in greys. */
  grey?: boolean;
  /** The company's unit: the headgear and dress (spear, shield, archer, horse, levy, captain). Omitted: bare-headed. */
  unit?: string;
  /** 0..3: the rank marks a figure of that rank wears (a plume from 1, a cape from 2, a gold plume at 3). */
  rank?: number;
}

/** 01-flow §7 `ground`: warm ochre for the player, dark slate grey for the enemy (the land's thatch and a slate). */
export const BG: Record<Side, number> = { warden: 0x977b3c, blight: 0x46424c };

const WARDEN_UNITS: readonly Unit[] = ['spear', 'shield', 'archer', 'horse', 'levy', 'captain'];

/** The figure's look for a commander of this face, side and unit: the one look both the field and the portrait read. */
export function commanderLook(face: number, side: Side, unit?: string, rank = 0): Look {
  if (side === 'blight') {
    return outfit({ id: 0, kind: 'captain', unit: 'broodlord', team: 1, rank, commander: false, captain: true, recruit: false, faceSeed: face || 1 });
  }
  const u = (WARDEN_UNITS as readonly string[]).includes(unit ?? '') ? (unit as Unit) : 'spear';
  const kind: Kind = u === 'captain' ? 'captain' : (u as Kind);
  const who: Who = { id: 0, kind, unit: u, team: 0, rank, commander: u !== 'captain', captain: u === 'captain', recruit: false, faceSeed: face || 1 };
  const look = outfit(who);
  if (!unit) {
    // a commander not yet given a company (the muster): bare-headed, in the tunic
    look.head = 'none';
  }
  return look;
}

// ------------------------------------------------------------------------------------------------- palettes

const palettes = new Map<Side, Quantiser>();
/** How many colours each side's painter can lay down, before the k-means (for the faces lab). */
export const paletteInputs: Partial<Record<Side, number>> = {};

/**
 * The side's shared palette: every colour its painter can lay down (all skins and hairs, every unit's dress and
 * headgear at every rank, the eyes, the ink, the ground), reduced to at most 64 by k-means in Lab. Made once, from
 * the painter's own colours, so it does not depend on which faces were drawn first.
 */
export function palette(side: Side): readonly number[] {
  return quantiser(side).palette;
}

function quantiser(side: Side): Quantiser {
  let q = palettes.get(side);
  if (q) return q;
  let colours: Map<number, number>;
  if (side === 'warden') {
    const looks: { look: Look }[] = [];
    for (const unit of [...WARDEN_UNITS, undefined]) {
      for (let rank = 0; rank <= 3; rank++) {
        const look = commanderLook(1, 'warden', unit, rank);
        for (const skin of SKINS) looks.push({ look: { ...look, skin, hair: HAIRS[looks.length % HAIRS.length] } });
        for (const hair of HAIRS) looks.push({ look: { ...look, hair } });
      }
    }
    colours = wardenColours(looks, [BG.warden]);
    q = new Quantiser(kmeans(colours, PALETTE_MAX, [BG.warden, INK, EYE_WHITE, IRIS]));
  } else {
    colours = bruteColours(BRUTE_FLESH, BRUTE_MANES, BRUTE_HORNS, EYES, BRUTE_PAINTS, [BG.blight]);
    q = new Quantiser(kmeans(colours, PALETTE_MAX, [BG.blight, INK, ...EYES, ...FLAME]));
  }
  paletteInputs[side] = colours.size;
  palettes.set(side, q);
  return q;
}

// ------------------------------------------------------------------------------------------------- portraits

/** A broodlord's eye colours, cores and rims (ember, sick green, pale): kept exactly in the palette. */
const EYES = BRUTE_EYES.flat();

/**
 * Where a face's eyes are, from its pixels alone: a warden's eye is its white with the iris beside it; a broodlord's,
 * its eye glow above the shoulders (the heart's ember is below them).
 */
export function eyeTest(img: Img, side: Side): (x: number, y: number) => boolean {
  if (side === 'warden') return (x, y) => y < 64 && x < W - 1 && img[y * W + x] === EYE_WHITE && img[y * W + x + 1] === IRIS;
  const glow = new Set<number>(EYES);
  return (x, y) => y < 64 && glow.has(img[y * W + x]);
}

export interface PortraitCheck {
  img: Img;
  /** The crop that put the eyes on row 40 and the head's middle on column 40 (0, 0 when painted in place). */
  shiftX: number;
  shiftY: number;
  /** Measured again after the crop. */
  eyeY: number;
  midX: number;
  eyes: number;
}

/**
 * The portrait's pixels and its checks (0xRRGGBB, 80×96, rows top-down): painted, quantised to its side's palette
 * (the ground keeps its own colour), cropped so the eyes are on row 40 and the head's middle on column 40
 * (01-flow §7 step 3, measured from the pixels), greyed if asked.
 */
export function portraitCheck(face: number, side: Side, opts: PortraitOpts = {}): PortraitCheck {
  const rank = Math.max(0, Math.min(3, opts.rank ?? 0));
  const look = commanderLook(face, side, opts.unit, rank);
  const pic = side === 'warden' ? paintWarden(look, person(face || 1), BG.warden) : paintBrute(look, brute(face || 1), BG[side]);
  let img = quantiser(side).apply(pic.col, pic.bgMask, BG[side]);
  let head = pic.head;
  const m0 = measure(eyeTest(img, side), head);
  let sx = 0, sy = 0;
  if (m0 && Number.isFinite(m0.midX)) {
    // a half pixel off is as near as an even run allows: no crop for it
    const whole = (d: number) => (Math.abs(d) <= 0.5 ? 0 : Math.round(d));
    sx = whole(MID_X - m0.midX);
    sy = whole(EYE_Y - m0.eyeY);
    img = shift(img, sx, sy);
    const h = new Uint32Array(head.length);
    head.forEach((v, i) => (h[i] = v));
    const hs = shift(h, sx, sy);
    head = new Uint8Array(hs.length);
    hs.forEach((v, i) => (head[i] = v));
  }
  const m = measure(eyeTest(img, side), head);
  if (opts.grey) img = grey(img);
  return { img, shiftX: sx, shiftY: sy, eyeY: m?.eyeY ?? NaN, midX: m?.midX ?? NaN, eyes: m?.eyes ?? 0 };
}

/** The portrait's pixels (see portraitCheck). */
export function portraitImage(face: number, side: Side, opts: PortraitOpts = {}): Img {
  return portraitCheck(face, side, opts).img;
}

const cache = new Map<string, HTMLCanvasElement>();
/** The colour pictures already made: the grey of the fallen is made from them, not painted again. */
const colours = new Map<string, Img>();

/** 80×96, cached: the same face, side and options give the same canvas (and the same pixels on every run). */
export function portrait(face: number, side: Side, opts: PortraitOpts = {}): HTMLCanvasElement {
  const base = `${side}:${face >>> 0}:${opts.unit ?? '-'}:${Math.max(0, Math.min(3, opts.rank ?? 0))}`;
  const key = `${base}:${opts.grey ? 1 : 0}`;
  let c = cache.get(key);
  if (!c) {
    let img = colours.get(base);
    if (!img) {
      img = portraitImage(face, side, { ...opts, grey: false });
      colours.set(base, img);
    }
    c = toCanvas(opts.grey ? grey(img) : img);
    cache.set(key, c);
  }
  return c;
}

export { GREYS };
