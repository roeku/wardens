import * as sim from '../sim-pkg/sim_wasm.js';
import type { Battle } from '../sim-pkg/sim_wasm.js';

// The campaign's WASM face as the screens read it (docs/engine/contracts/campaign.md §2–§4). The campaign part owns
// the object; these are its contract's shapes, read through `sim.Campaign` so the screens build whether or not the
// generated bindings have it yet.

export type Phase = 'muster' | 'map' | 'march' | 'battle' | 'camp' | 'won' | 'lost';
export type Way = 'stubborn' | 'reckless' | 'steady' | 'veteran';
export type PlaceKind = 'holdfast' | 'village' | 'ford' | 'camp' | 'keep';

export interface PlaceState {
  id: number;
  step: number;
  lane: number;
  kind: PlaceKind;
  name: string;
  at: { x: number; y: number };
  links: number[];
  reachable: boolean;
  done: boolean;
  danger: number;
  houses?: number;
  foe: number | null;
  /** The garrison by kind: men (`n`) in `companies` companies. */
  garrison: { unit: string; n: number; companies?: number }[];
  /** Its site in `road_battle()`, and the garrison's rank. */
  site?: number;
  rank?: number;
}

export interface CompanyState {
  id: number;
  name: string;
  unit: string;
  men: number;
  full: number;
  rank: number;
  way: Way;
  face: number;
  freed: boolean;
  kills: number;
  battles: number;
  colours: number[];
  last: { lost: number; joined: number } | null;
  /** Its squad in a battle and on the road (squad 0 is the captain). */
  squad?: number;
}

export interface BandState {
  id: number;
  unit: string;
  men: number;
  seasoned: boolean;
  rank: number;
  village: string;
  commander: number | null;
  /** Where the band waits on the muster ground, and its squad in `road_battle()` (the campaign part's additions). */
  at?: { x: number; y: number };
  squad?: number;
}

export interface CommanderState {
  id: number;
  name: string;
  way: Way;
  face: number;
  veteran: boolean;
  suits: string;
  band: number | null;
  /** Where the commander stands before the hall (the campaign part's addition). */
  at?: { x: number; y: number };
}

export interface FoeState {
  id: number;
  name: string;
  way: Way;
  rank: number;
  face: number;
  place: number | null;
  state: 'waiting' | 'escaped' | 'down';
}

export interface FallenState {
  name: string;
  face: number;
  way: Way;
  rank: number;
  unit: string;
  step: number;
  place: number | null;
}

export interface CampaignState {
  v: number;
  seed: number;
  campaign: string;
  phase: Phase;
  step: number;
  at: number | null;
  /** On the march: the place it left and the place it is bound for (the campaign part's additions). */
  from?: number | null;
  to?: number | null;
  /** At a camp: the company honoured there, if one was. */
  honoured?: number | null;
  battles?: number;
  day: number;
  road: {
    w: number;
    h: number;
    hall: { x: number; y: number };
    muster: { x0: number; y0: number; x1: number; y1: number };
    places: PlaceState[];
  };
  warband: {
    captain: { name: string; hp: number; hp_max: number; face: number };
    companies: CompanyState[];
  };
  muster: { banners: number; bands: BandState[]; commanders: CommanderState[]; planted?: number; ready?: boolean };
  foes: FoeState[];
  fallen: FallenState[];
  chronicle: unknown;
  hall: unknown;
}

export interface Tally {
  won: boolean;
  reason: string;
  companies: { id: number; lost: number; joined: number; rank_up: boolean; fell: boolean }[];
  fallen: string[];
  returned: string[];
  freed: number;
  new_company: string | null;
  foe: { id: number; state: string; by: number | null } | null;
  burnt: number[];
}

/** The chronicle (01-flow.md §3.9), as `chronicle_json()` gives it: our commanders, living and fallen, and the enemy
 * commanders met. */
export interface Chronicle {
  won: boolean;
  frame: 'gold' | 'grey';
  reason: string;
  battles: number;
  days: number;
  captain: { name: string; face: number; alive: boolean };
  commanders: { name: string; face: number; alive: boolean; way?: Way; rank?: number; unit?: string; colours?: number }[];
  foes: { name: string; face: number; down: boolean; lord?: boolean }[];
}

/** What a campaign adds to the Hall (`hall_json()`): the fallen commanders' banners and the enemy colours taken. */
export interface HallAdds {
  campaign: string;
  won: boolean;
  fallen: { name: string; face: number; way?: Way; rank?: number; unit?: string }[];
  colours: { name: string; face: number; by?: string; lord?: boolean }[];
}

/** The `Campaign` object of the contract (§2). */
export interface Campaign {
  free(): void;
  save(): string;
  state_json(): string;
  plant(commander: number, band: number): void;
  stand_down(commander: number): void;
  auto_muster(): void;
  set_out(place: number): void;
  road_battle(): Battle;
  arrive(): void;
  battle(): Battle;
  finish(battle: Battle): string;
  honour(company: number): void;
  break_camp(): void;
  chronicle_json(): string;
  hall_json(): string;
}

interface CampaignStatic {
  create(seed: number, opts_json: string): Campaign;
  load(save_json: string): Campaign;
}

/** The campaign's constructor, once the bindings have it. */
export function campaignApi(): CampaignStatic | null {
  const c = (sim as unknown as { Campaign?: CampaignStatic }).Campaign;
  return c ?? null;
}

/** Custom battles (the war table, 01-flow.md §3.3): `Battle.custom(seed, json)`, once the bindings have it. */
export function customBattle(seed: number, setup: { kind: string; size: number; strength: string; land: string }): Battle | null {
  const B = sim.Battle as unknown as { custom?: (seed: number, json: string) => Battle };
  return B.custom ? B.custom(seed, JSON.stringify(setup)) : null;
}

export function readState(c: Campaign): CampaignState {
  return JSON.parse(c.state_json()) as CampaignState;
}
