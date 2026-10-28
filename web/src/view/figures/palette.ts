// docs/spec/02-look.md §4: every colour a figure or banner may use. Hex values reach the screen unconverted.

/** Team ramps, dark → light: [0] darkest, [1] capes/hoods, [2] tunics/saddle cloths/pennants, [3] plumes. */
export const TEAM = [
  [0x12324a, 0x1f5a80, 0x3a8dbd, 0x78c5e6], // player (blue)
  [0x4a1614, 0x86281f, 0xc64833, 0xef8e70], // enemy (red)
] as const;
export const NEUTRAL = [0x6e6655, 0xa89f86, 0xd8cfb4] as const;

/** Heraldry ramps for banners and shields; index 2 is the freed villages' linen. */
export const HERALDRY = [
  [0x153a5c, 0x1f5a8e, 0x2f78b8, 0x6fb0e0],
  [0x4a1614, 0x86281f, 0xb83a2b, 0xe8765c],
  [0x6b5a40, 0xa8946c, 0xd2c29c, 0xece2c6],
] as const;
export const DEVICE = 0xf3ecd8;
export const LINEN_DEVICE = 0xa8741e;

export const GOLD = 0xe8c34a;
export const DARK_GOLD = 0x9a7a2a;
export const CLASP = 0xd8b24a;

/** Honour ribbons alternate cream and red. */
export const RIBBONS = [0xf3ecd8, 0xd8463a] as const;

export const SKIN = 0xdcae82;
export const MAIL = 0x8d949c;
export const STEEL = 0xa3abb3;
export const WOOD = 0x7a5634;
export const IRON = 0x5c6066;
export const SMOCKS = [0xc9b48a, 0xa89a7a, 0x8d8a6a, 0xb59a74, 0x9c8466] as const;
export const HAIR = [0x4a3020, 0x6b4a2a, 0x2e241c, 0x8a6a3a, 0x5a4a3a] as const;
/** Bay, dark bay, chestnut, black, grey, dun. */
export const COATS = [0x8a5632, 0x6e4426, 0xa8642e, 0x3e342c, 0xb4ada2, 0xbc9c68] as const;
/** The general's charger: grey for the player, black for the enemy. */
export const CHARGER = [0xc9c3b6, 0x36302b] as const;
export const CAPTAIN_HELM = 0xe8c34a;
export const CAPTAIN_PLUME = 0xd8463a;

/** Gear (02-look.md §5 "Gear"). */
export const SPEAR_HEAD = 0xe7eaec;
export const BLADE = 0xd8dde2;
export const CROSS = 0x8a9096;
export const STRING = 0xd8d0b8;
export const FLETCH = 0xc44a34;
export const SHIELD_BACK = 0x6a4a30;
export const HOSE = 0x4e4a46;
export const ARCHER_SLEEVE = 0x8a6e4e;
export const SADDLE = 0x5a3a22;
export const REINS = 0x3a2618;

/** Banner pole and crossbar (02-look.md §6). */
export const POLE = 0x35231a;
export const CROSSBAR = 0x56391f;

/** Grime on the last tatter stage multiplies the cloth. */
export const GRIME = [0.72, 0.68, 0.62] as const;

export function rgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
