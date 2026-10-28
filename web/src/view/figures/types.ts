import type { Kind, Team, Unit } from '../../contracts';

// The records the game hands the figure layer each frame (day 3 fills them from the sim's soldier and squad
// buffers). Plain data: the figure layer never imports the sim and never writes back.
// Units: tiles (x east, y south, as in the sim), seconds, radians (facing = atan2(dy, dx) in sim coordinates).

/** One soldier, as the view needs him. */
export interface ManRecord {
  /** Stable soldier id: it seeds his looks (hair, beard, coat, child or woman) through hash32. */
  id: number;
  /** Simulation position in tiles, and the ground height there. */
  x: number;
  y: number;
  h: number;
  /** The sim's facing (radians, atan2(dy, dx)). */
  face: number;
  /** The sim's speed, tiles/s. Over 0.2 he walks. */
  speed: number;
  kind: Kind;
  /** Who he is: the blight's units are drawn as beasts (blight-man, troll, drake, broodlord), never as soldiers. */
  unit: Unit;
  team: Team;
  /** 0..3. */
  rank: number;
  /** Soldier 0 of a company: drawn ×1.16. */
  commander: boolean;
  /** The warband's captain: mounted on the general's charger. */
  captain: boolean;
  routing: boolean;
  alive: boolean;
  /** A man who joined from a freed village and is not yet dyed. */
  recruit: boolean;
  /** The sim's strike counter: when it changes, a blow (or a loosed arrow) starts. Never a view timer. */
  strikes: number;
  /** Seconds since he was last hit (Infinity if never): white for 0.1 s. */
  hitAge: number;
  /** Seconds since he fell (read only when !alive): topple over 0.35 s, then lie. */
  deathAge: number;
  /** His company is fighting: the guard and shooting stances instead of the carry. */
  engaged?: boolean;
  /** What he strikes or shoots at, in sim tiles: archers draw toward it, a standing man turns to it. */
  aimX?: number;
  aimY?: number;
  /** A drake: seconds since its last breath jet began (the sim's `Breath` event; Infinity if never). */
  breathAge?: number;
  /** Walking against his facing (a drake springing back): the stride plays in reverse (04-battle.md §9). */
  backing?: boolean;
}

/** One company's banner. */
export interface BannerRecord {
  /** Squad id: picks which holes and tears its cloth shows. */
  id: number;
  /** Where the pole stands (the anchor or the bearer), sim tiles, and the ground height there. */
  x: number;
  y: number;
  h: number;
  /** The company's facing (radians) and speed (tiles/s, the wind in the cloth). */
  face: number;
  speed: number;
  /** Morale / 100: the pole leans below 0.55 and shakes near breaking. */
  heart: number;
  /** Men lost so far and the full company size: the four tatter stages. */
  lost: number;
  size: number;
  /** 0..3: gold chevrons. */
  rank: number;
  /** Battles survived: one honour ribbon each. */
  honours: number;
  kind: Kind;
  /** The blight's companies carry its standards (a ragged hide on a crooked pole under a horned skull). */
  unit: Unit;
  team: Team;
  /** The freed villages' plain linen banner. */
  linen?: boolean;
  /** The captain's banner: 1.95 tall, gold border and emblem, the crown. */
  captain?: boolean;
  /** Hidden while the company routs. */
  routing: boolean;
  selected?: boolean;
  hover?: boolean;
  /** 0..1 while the banner unfurls the first time it is given (1 = fully out). */
  unfurl?: number;
}

/** What the figure layer needs from the camera each frame. */
export interface FigureFrame {
  men: readonly ManRecord[];
  banners?: readonly BannerRecord[];
  /** Seconds since the last frame (0 freezes every easing and timer). */
  dt: number;
  /** The cloth clock, seconds. */
  time: number;
  /** Art pixels per tile (ViewCamera.s): pixel snapping, minimum thickness and the zoom-dependent detail. */
  zoom: number;
  /**
   * The camera's pixel grid, for the exact clip (every vertex lands on the same sub-pixel spot whatever the
   * camera's or the figure's whole-pixel position): ViewCamera.origin, and half the scene target in art px,
   * ((aw + 2) / 2, (ah + 2) / 2). Without it figures are projected the ordinary way.
   */
  screen?: { origin: { x: number; y: number }; halfW: number; halfH: number };
  /** The sun's shadow-map texel in tiles ((right − left) / map size): thin things cast at least that wide a shadow. */
  shadowTexel?: number;
}
