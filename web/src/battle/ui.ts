import type { Deed, P, Team, When } from '../contracts';
import type { Hit } from '../input/hit';

// What the input layer and the marks share about a battle: the orders as the WASM side describes them
// (crates/sim-wasm/src/input_api.rs), the sites' capture, each company's fixed traits, and the input's own state
// (the selection, the stroke being drawn, what the mouse is over). Written by web/src/input, read by the marks.

/** A deed waiting for its trigger (08-orders.md §6). */
export interface WaitView {
  when: When;
  deed: Deed;
  /** The deed as the sim's text command. */
  text: string;
  signalled: boolean;
  /** Where its faint mark points, if anywhere. */
  to: [number, number] | null;
}

/** One company's order, for drawing (`Battle.orders_json`). */
export interface OrderView {
  id: number;
  order: string;
  state: string;
  detached: boolean;
  reserve: boolean;
  working: boolean;
  /** Its centre. */
  c: [number, number];
  to?: [number, number];
  target?: number;
  site?: number;
  ward?: number;
  fight?: boolean;
  /** Waypoints still to pass. */
  via: [number, number][];
  /** A detached company's order flag. */
  flag: [number, number] | null;
  waits: WaitView[];
}

export interface OrdersView {
  captain: number | null;
  held: boolean;
  squads: OrderView[];
  /** The army's waiting deeds. */
  army: WaitView[];
}

export interface SiteView {
  id: number;
  kind: string;
  x: number;
  y: number;
  owner: Team | null;
  by: Team | null;
  progress: number;
}

export interface SitesView {
  /** The capture radius, tiles. */
  r: number;
  sites: SiteView[];
}

/** A company's fixed traits (`Battle.squads_json`). */
export interface SquadInfo {
  id: number;
  team: Team;
  kind: string;
  unit: string;
  name: string;
  radius: number;
  ranged: boolean;
  captain: boolean;
}

/** One company's bar in a front's preview (`Battle.plan_front_preview`). */
export interface PreviewBar {
  id: number;
  x: number;
  y: number;
  face: number;
  files: number | null;
  len: number;
  role: 'line' | 'bows' | 'horse' | 'reserve';
}

export interface FrontPreview {
  tap: boolean;
  march: P | null;
  fight: boolean;
  face: number;
  bars: PreviewBar[];
  captain: P | null;
}

export type StrokeKind = 'front' | 'squad' | 'captain';

/** The stroke being drawn (01-flow.md §2 "Strokes"). */
export interface StrokeView {
  kind: StrokeKind;
  /** The company dragged (a `squad` stroke). */
  squad: number;
  /** Ground points as drawn, at least 0.3 tiles apart. */
  points: P[];
  /** What the stroke would end on now (squad and captain strokes). */
  end: Hit | null;
  /** A front's ghost bars. */
  preview: FrontPreview | null;
}

export class BattleUi {
  /** The selected company, if any. */
  selected: number | null = null;
  /** Real seconds before the selection lapses (01-flow.md §2 LAPSE). */
  lapse = 0;
  stroke: StrokeView | null = null;
  /** What the mouse is over (banners grow, capture rings widen). */
  hoverSquad: number | null = null;
  hoverSite: number | null = null;
}
