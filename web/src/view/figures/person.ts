import { hash32 } from './hash';
import { BLIGHT, BONE, EMBER, FLAME, HAIR, MANE, TROLL } from './palette';

// A person's look from their face seed (docs/engine/contracts/campaign.md §3 `face`). The figure on the field
// (outfit.ts) and the portrait (view/portraits/) both read it, so a commander looks the same in every battle, on
// every card and in the Hall. Everything here follows from the seed through hash32: no Math.random.
//
// The figure shows skin, hair, beard (and a bald crown); the rest (hair style, brows, nose, jaw, a scar) is detail
// too small for the field that only the portrait draws (out/decisions-d5-faces.md "One seed, one person").

/**
 * The commanders' skins: the men's skin and the peoples' skins of 02-look.md §4 "Men" and §5 "Peoples" (Africa's
 * two ends, Iberia, Gaul). The wardens' commanders come from many villages. Italy's `#d8aa7a` is left out: it is
 * within 2 ΔE of the men's, and two faces in it could not be told apart.
 */
export const SKINS = [0xdcae82, 0xca9a68, 0xf2caa4, 0x94603c, 0x5e3a22] as const;
/** The men's hair (02-look.md §4) and Gaulish red and straw (§5 "Peoples"). */
export const HAIRS = [...HAIR, 0xa04a22, 0xc89a52] as const;
/** Dark skins take the dark hairs. */
const DARK_HAIRS = [0x2e241c, 0x4a3020] as const;

export type HairStyle = 'short' | 'long' | 'receding' | 'bald' | 'tied';
const STYLES: readonly HairStyle[] = ['short', 'short', 'long', 'receding', 'tied', 'long', 'bald', 'short'];

export interface Person {
  seed: number;
  /** The figure's skin and hair dyes, and its beard part (0..4: full, short, moustache, forked, pointed; −1 none). */
  skin: number;
  hair: number;
  beard: number;
  /** No hair ball on the figure. */
  bald: boolean;
  // ---------------------------------------------------------------- portrait only
  style: HairStyle;
  /** 0 light, 1 straight, 2 heavy. */
  brow: number;
  /** 0 small, 1 straight, 2 hooked. */
  nose: number;
  /** 0 narrow, 1 square, 2 broad. */
  jaw: number;
  /** 0 none; 1 across the cheek; 2 through the brow; 3 over the nose. */
  scar: number;
}

const pick = <T>(list: readonly T[], seed: number, salt: number): T => list[hash32(seed, salt, 0xfacade) % list.length];

/** A warden's person from a face seed. */
export function person(seed: number): Person {
  const skin = pick(SKINS, seed, 1);
  const dark = skin === 0x94603c || skin === 0x5e3a22;
  const style = pick(STYLES, seed, 3);
  // five beard types and none, as the men's id % 7 (02-look.md §5 "Head"), here from the seed's hash
  const roll = hash32(seed, 4, 0xfacade) % 7;
  return {
    seed,
    skin,
    hair: dark ? pick(DARK_HAIRS, seed, 2) : pick(HAIRS, seed, 2),
    beard: roll < 5 ? roll : -1,
    bald: style === 'bald',
    style,
    brow: hash32(seed, 5, 0xfacade) % 3,
    nose: hash32(seed, 6, 0xfacade) % 3,
    jaw: hash32(seed, 7, 0xfacade) % 3,
    scar: Math.max(0, (hash32(seed, 8, 0xfacade) % 6) - 2),
  };
}

/** A broodlord's look from a face seed: every part varies on its own hash, so nine foes rarely share more than one. */
export interface Brute {
  seed: number;
  /** The hide (BRUTE_FLESH). */
  flesh: number;
  /** 0 the great forward-sweeping pair (and a swept-back pair), 1 ram's curls, 2 tall and upswept. */
  horns: number;
  /** Horn length, ×, and colour (BRUTE_HORNS: bone, black, ash). */
  hornLen: number;
  hornColour: number;
  /** The mane's colour (BRUTE_MANES), and its shape: 0 none (a bare hump), 1 a short crest, 2 long and shaggy. */
  mane: number;
  maneShape: number;
  /** The eyes' glow: core and rim (BRUTE_EYES: ember, sick green, pale). */
  eyes: number;
  eyeRim: number;
  /** 0 a bull's broad muzzle, 1 a boar's long snout with tusks, 2 an ape's short muzzle and heavy underbite. */
  muzzle: number;
  /** 0 none; 1 a broken horn tip; 2 a scar over the eye; 3 a torn ear. */
  scar: number;
  /** War-paint (portrait only): 0 none, 1 bars across the brow, 2 a stripe down the muzzle, 3 claw marks on the cheek. */
  paint: number;
  /** The paint's colour (BRUTE_PAINTS). */
  paintColour: number;
  /** The hide's markings (portrait only): 0 plain, 1 dark stripes, 2 pale blotches. */
  pattern: number;
  /** Tusks from the lower jaw (always on a boar's snout). */
  tusks: boolean;
}

/**
 * The hides (out/decisions-d5-faces.md "Broodlords differ at a glance"): the blight ramp's brown `#6a3e36`
 * (07-progression §8), the trolls' ash `#77727e` (D-15), and three beside them: a bruise purple, a grey moss and a
 * bone-pale, each low in saturation so the blight stays the blight and a moss hide never melts into the grass.
 */
export const BRUTE_FLESH = [BLIGHT[2], TROLL[2], 0x5e4466, 0x5e6142, 0xb0a693] as const;
/** Manes: the dark mane, Gaul's rust (02-look §5), bone white (the linen ramp) and the stones' ash (02-look §4). */
export const BRUTE_MANES = [MANE, 0xa04a22, 0xd2c29c, 0x5a544d] as const;
/** Eyes, core and rim: the ember (the torch ramp and the cracks), a sick green (the plan's green), and a cold pale. */
export const BRUTE_EYES = [
  [FLAME[1], EMBER],
  [0x9fd36a, 0x5e8a34],
  [0xcfe3e8, 0x7fa0aa],
] as const;
/** War-paint: the device's cream and a red ochre (the chestnut coat). */
export const BRUTE_PAINTS = [0xf3ecd8, 0xa8642e] as const;
const HORN_LEN = [0.85, 1, 1.15] as const;
/** Horns: bone (the linen ramp), the black coat and the stones' ash (02-look §4). */
export const BRUTE_HORNS = [BONE, 0x3e342c, 0x8e877a] as const;

export function brute(seed: number): Brute {
  const h = (salt: number, n: number) => hash32(seed, salt, 0xfacade) % n;
  const eyes = BRUTE_EYES[h(15, 3)];
  const muzzle = h(18, 3);
  return {
    seed,
    flesh: BRUTE_FLESH[h(11, BRUTE_FLESH.length)],
    horns: h(12, 3),
    hornLen: HORN_LEN[h(13, 3)],
    hornColour: BRUTE_HORNS[h(22, 3)],
    mane: BRUTE_MANES[h(14, BRUTE_MANES.length)],
    maneShape: h(19, 3),
    eyes: eyes[0],
    eyeRim: eyes[1],
    muzzle,
    scar: Math.max(0, h(16, 6) - 2),
    paint: h(20, 4),
    paintColour: BRUTE_PAINTS[h(21, 2)],
    pattern: h(23, 3),
    tusks: muzzle === 1 || h(17, 2) === 0,
  };
}
