import { UNIT_ORDER, type Kind, type Team, type Unit } from '../../contracts';
import { BLIGHTMAN, BROOD_BODY, DRAKE_SCALE, TROLL_BODY } from './blight-parts';
import { hash32 } from './hash';
import {
  ARCHER_SLEEVE, BLIGHT, CAPTAIN_HELM, CAPTAIN_PLUME, CHARGER, COATS, GOLD, HAIR, HERALDRY, HIDES, HOSE, MAIL, SKIN, SMOCKS,
  STEEL, TEAM, TROLL,
} from './palette';

// docs/spec/02-look.md §5 "Kinds", "Rank marks" and "Peoples": what a man wears, from his kind, team, rank and id.
// Another people would be another `outfit` (its own skin and hair palettes, picked by id % n).

/**
 * The body a figure is drawn with. Men (and their horses) are the warband's and the villages'; the blight's units
 * are beasts: hunched blight-men, stone trolls, drakes and the broodlord (00-start-here.md §A2).
 */
export type Form = 'man' | 'blightman' | 'troll' | 'drake' | 'broodlord';

/**
 * The form for a unit. The blight's units are themselves. An enemy given a soldier's unit is still the blight, never
 * a man in red: its general is the broodlord, its horse are drakes, anything else a blight-man (out/decisions-blight-
 * view.md "Every enemy is the blight"). A beast on our side is a drake (the tamed drake of the Myths).
 */
export function formOf(w: { unit: Unit; kind: Kind; team: Team; captain: boolean }): Form {
  switch (w.unit) {
    case 'blightman':
    case 'troll':
    case 'drake':
    case 'broodlord':
      return w.unit;
    default:
      break;
  }
  if (w.team === 1) {
    if (w.captain || w.kind === 'captain') return 'broodlord';
    if (w.kind === 'horse') return 'drake';
    if (w.kind === 'beast') return 'troll';
    return 'blightman';
  }
  return w.kind === 'beast' ? 'drake' : 'man';
}

/** Which weapon a blight-man carries. */
export type BlightArms = 'club' | 'cleaver' | 'claws' | 'spear';

export type Head = 'none' | 'kettle' | 'nasal' | 'coif+nasal' | 'hood' | 'cap' | 'kerchief';
export type Gear = 'spear' | 'sword+shield' | 'bow' | 'pitchfork' | 'lance' | 'sword' | 'bundle' | 'none';

export interface Look {
  body: number;
  sleeve: number;
  skirt: number;
  /** A long gown instead of a knee skirt (women). */
  gown: boolean;
  hose: number;
  skin: number;
  hair: number;
  /** 0..4, or −1 for none. */
  beard: number;
  head: Head;
  /** Dye of the helmet, hood, cap or kerchief. */
  headDye: number;
  /** The mail coif under a nasal helm. */
  coif: number;
  plume: number | null;
  cape: number | null;
  gear: Gear;
  quiver: boolean;
  /** Shield face: heraldry ramp 0 blue, 1 red, 2 linen. */
  shieldRamp: 0 | 1 | 2;
  /** Overall scale on top of FIG: child 0.72, commander 1.16, mounted general 1.08. */
  scale: number;
  mounted: boolean;
  coat: number;
  saddleCloth: number;
  /** The body (men are 'man'; the rest is the blight's, posed by blight.ts). */
  form: Form;
  /** Blight bodies: the flesh (stone for trolls), the hide of their rags, their weapon and a leader's crown. */
  flesh: number;
  hide: number;
  arms: BlightArms;
  /** Trolls: a boulder maul instead of the club. */
  maul: boolean;
  /** A blight-man wears a hide over his hump. */
  mantle: boolean;
}

const pick = <T>(list: readonly T[], id: number, salt: number) => list[hash32(id, salt, 0x5eed) % list.length];

export interface Who {
  id: number;
  kind: Kind;
  unit: Unit;
  team: Team;
  rank: number;
  commander: boolean;
  captain: boolean;
  recruit: boolean;
}

/** A folk figure's variant, from the id alone: 1 in 4 a child, about half women. */
export function folkVariant(id: number): { child: boolean; woman: boolean } {
  return { child: hash32(id, 11, 0xf01c) % 4 === 0, woman: hash32(id, 12, 0xf01c) % 2 === 0 };
}

export function outfit(w: Who): Look {
  const T = TEAM[w.team];
  const rank = Math.max(0, Math.min(3, w.rank | 0));
  const hair = pick(HAIR, w.id, 1);
  // five beard types chosen by id % 7 (02-look.md §5 "Head"); 5 and 6 are clean-shaven
  const beardRoll = w.id % 7;
  const look: Look = {
    body: T[2],
    sleeve: T[2],
    skirt: T[2],
    gown: false,
    hose: HOSE,
    skin: SKIN,
    hair,
    beard: beardRoll < 5 ? beardRoll : -1,
    head: 'kettle',
    headDye: STEEL,
    coif: MAIL,
    plume: null,
    cape: null,
    gear: 'none',
    quiver: false,
    shieldRamp: w.team === 0 ? 0 : 1,
    scale: 1,
    mounted: false,
    coat: pick(COATS, w.id, 2),
    saddleCloth: T[2],
    form: formOf(w),
    flesh: 0,
    hide: 0,
    arms: 'club',
    maul: false,
    mantle: false,
  };
  if (look.form !== 'man') return blight(look, w);
  const kind = w.captain ? 'captain' : w.kind;
  switch (kind) {
    case 'spear':
      look.gear = 'spear';
      break;
    case 'shield':
      look.sleeve = MAIL;
      look.skirt = MAIL;
      look.head = 'coif+nasal';
      look.gear = 'sword+shield';
      break;
    case 'archer':
      look.sleeve = ARCHER_SLEEVE;
      look.head = 'hood';
      look.headDye = T[1];
      look.gear = 'bow';
      look.quiver = true;
      break;
    case 'horse':
      look.mounted = true;
      look.gear = 'lance';
      break;
    case 'captain':
      look.body = T[3];
      look.sleeve = T[3];
      look.skirt = T[3];
      look.hose = T[0];
      look.headDye = CAPTAIN_HELM;
      look.plume = CAPTAIN_PLUME;
      look.cape = T[1];
      look.gear = 'sword';
      look.mounted = true;
      look.coat = CHARGER[w.team];
      look.scale = 1.08;
      break;
    case 'levy': {
      // the freed: their own village smock until dyed (rank 2); bare-headed, then a cap, then a steel helm
      const own = pick(SMOCKS, w.id, 3);
      const dyed = rank >= 2 && !w.recruit;
      look.body = look.sleeve = look.skirt = dyed ? T[2] : own;
      look.head = w.recruit || rank === 0 ? 'none' : rank === 1 ? 'cap' : 'nasal';
      look.headDye = rank === 1 ? own : STEEL;
      look.gear = 'pitchfork';
      look.shieldRamp = 2;
      break;
    }
    case 'folk': {
      const v = folkVariant(w.id);
      const own = pick(SMOCKS, w.id, 3);
      look.body = look.sleeve = look.skirt = own;
      look.gown = v.woman;
      look.head = v.woman ? 'kerchief' : hash32(w.id, 13, 0xf01c) % 2 ? 'cap' : 'none';
      look.headDye = v.woman ? HERALDRY[2][2] : pick(SMOCKS, w.id, 4);
      look.beard = v.woman || v.child ? -1 : look.beard;
      look.gear = 'bundle';
      look.scale = v.child ? 0.72 : 1;
      break;
    }
    default:
      break;
  }
  // rank marks on the men: 1 a plume in team [3], 2 a cape in team [1], 3 a gold plume (marks accumulate);
  // folk carry none, and the captain keeps his red plume and cape
  if (kind !== 'folk' && kind !== 'captain' && !w.recruit) {
    if (rank >= 1) look.plume = rank >= 3 ? GOLD : T[3];
    if (rank >= 2) look.cape = T[1];
  }
  if (w.commander && !w.captain) look.scale *= 1.16;
  return look;
}

/** The blight's looks: flesh and hide by id, the weapon by id (a spear company's carry bone spears). */
function blight(look: Look, w: Who): Look {
  const lead = w.commander ? 1.16 : 1;
  look.hide = pick(HIDES, w.id, 21);
  switch (look.form) {
    case 'blightman': {
      look.flesh = pick([BLIGHT[2], BLIGHT[3]], w.id, 22);
      const roll = hash32(w.id, 23, 0x5eed) % 6;
      look.arms = w.kind === 'spear' ? 'spear' : roll < 3 ? 'club' : roll < 5 ? 'cleaver' : 'claws';
      look.mantle = hash32(w.id, 24, 0x5eed) % 2 === 0 || w.commander;
      look.scale = BLIGHTMAN.scale * lead;
      break;
    }
    case 'troll':
      look.flesh = pick([TROLL[0], TROLL[0], TROLL[1]], w.id, 22);
      look.maul = hash32(w.id, 25, 0x5eed) % 3 === 0;
      look.scale = TROLL_BODY.scale * lead;
      break;
    case 'drake':
      look.flesh = w.commander ? BLIGHT[1] : BLIGHT[2];
      look.scale = DRAKE_SCALE * lead;
      break;
    case 'broodlord':
      look.flesh = BLIGHT[2];
      look.scale = BROOD_BODY.scale;
      break;
    default:
      break;
  }
  look.mounted = false;
  look.gear = 'none';
  return look;
}

/** A key that changes whenever the look would. */
export function lookKey(w: Who): number {
  return (((((w.rank & 3) | (w.team << 2) | (w.commander ? 8 : 0) | (w.captain ? 16 : 0) | (w.recruit ? 32 : 0)) << 4) | KINDS.indexOf(w.kind)) << 4) | UNIT_ORDER.indexOf(w.unit);
}
const KINDS: Kind[] = ['spear', 'shield', 'archer', 'horse', 'levy', 'folk', 'captain', 'beast'];
