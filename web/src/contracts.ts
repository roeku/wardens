// Shared contracts, TypeScript side. Mirror of contracts.rs; keep the two in step.
// Units: tiles (x east, y south), seconds, radians (facing = atan2(dy, dx) in sim coordinates).

export const TICK_HZ = 30;

export type Team = 0 | 1; // 0 player, 1 enemy
export type Kind = 'spear' | 'shield' | 'archer' | 'horse' | 'levy' | 'folk' | 'captain' | 'beast';
/**
 * The unit a company is (sim::units::Unit): its kind's rules plus who it is. The blight's units (blight-men,
 * trolls, drakes and the broodlord) are drawn as beasts and monsters, never as soldiers (00-start-here.md §A2).
 */
export type Unit = 'spear' | 'shield' | 'archer' | 'horse' | 'levy' | 'folk' | 'captain' | 'blightman' | 'troll' | 'drake' | 'broodlord';
export type Way = 'stubborn' | 'reckless' | 'steady' | 'veteran';
export interface P { x: number; y: number }

export type Who = { t: 'army' } | { t: 'squad'; id: number };

export type Deed =
  | { do: 'move'; who: Who; to: P; via?: P[]; fight?: boolean; face?: number }
  | { do: 'attack'; who: Who; target: number; via?: P[] }
  | { do: 'take'; who: Who; site: number; via?: P[] }
  | { do: 'front'; line: P[] }
  | { do: 'hold'; who: Who }
  | { do: 'recall'; id: number }
  | { do: 'rally' };

export type Source = 'tap' | 'drag' | 'line' | 'voice' | 'typed' | 'bot' | 'brain';

export interface Command { tick: number; team: Team; deed: Deed; src: Source; note?: unknown }
export interface Refusal { tick: number; at: P; why: string }

// Per-frame buffers over WASM memory (contracts.rs `soldier_buf`, `squad_buf`). Records are interleaved per entry:
// soldier k's field F is f32[k * SOLDIER_F32.FIELDS + F].
export const SOLDIER_F32 = { X: 0, Y: 1, FACE: 2, SPEED: 3, HP: 4, AIM_X: 5, AIM_Y: 6, FIELDS: 7 } as const;
export const soldierBits = {
  squad: (w: number) => w & 0xffff,
  kind: (w: number) => (w >>> 16) & 0xf,
  team: (w: number) => ((w >>> 20) & 1) as Team,
  alive: (w: number) => ((w >>> 21) & 1) === 1,
  routing: (w: number) => ((w >>> 22) & 1) === 1,
  commander: (w: number) => ((w >>> 23) & 1) === 1,
  captain: (w: number) => ((w >>> 24) & 1) === 1,
  recruit: (w: number) => ((w >>> 25) & 1) === 1,
  rank: (w: number) => (w >>> 26) & 3,
  /** In contact or shooting this tick. */
  engaged: (w: number) => ((w >>> 28) & 1) === 1,
  /** Moving against his facing: a drake springing back plays its stride in reverse (04-battle.md §9). */
  backing: (w: number) => ((w >>> 29) & 1) === 1,
};
/** Per soldier: the tick he was last hit, the tick he died, and the tick his breath cycle began (a drake: rear, jet at
 * 0.4 s, bite at 2.3 s; 04-battle.md §5); NEVER if not. */
export const SOLDIER_TICKS = { HIT_AT: 0, DIED_AT: 1, BREATH_AT: 2, FIELDS: 3 } as const;
export const NEVER = 0xffffffff;
export const KIND_ORDER: Kind[] = ['spear', 'shield', 'archer', 'horse', 'levy', 'folk', 'captain', 'beast'];
/** sim::units::Unit by id. */
export const UNIT_ORDER: Unit[] = ['spear', 'shield', 'archer', 'horse', 'levy', 'folk', 'captain', 'blightman', 'troll', 'drake', 'broodlord'];

export const SQUAD_F32 = { X: 0, Y: 1, FACE: 2, MORALE: 3, LEAN: 4, ALIVE_FRAC: 5, FIELDS: 6 } as const;
export const SQUAD_STATE = ['idle', 'marching', 'fighting', 'routing', 'fled', 'destroyed'] as const;
export const squadBits = {
  state: (w: number) => w & 0xff,
  detached: (w: number) => ((w >>> 8) & 1) === 1,
  kind: (w: number) => (w >>> 9) & 0xf,
  team: (w: number) => ((w >>> 13) & 1) as Team,
  rank: (w: number) => (w >>> 14) & 3,
  full: (w: number) => (w >>> 16) & 0xff,
  alive: (w: number) => (w >>> 24) & 0xff,
};
/** The second u32 per squad (`squad_unit_ptr`): bits 0..7 the unit id (UNIT_ORDER). */
export const squadUnit = (w: number): Unit => UNIT_ORDER[w & 0xff] ?? 'spear';

export enum EventCode {
  Hit = 1, Volley, Charge, Death, BannerFall, CommanderFall, FoeCommanderFall, Rout, Rally,
  SiteTaken, HouseFired, HouseLost, Freed, Saved, Nightfall, Dawn, DuskBell, Breath, Refused, Outcome,
}
/** One event as unpacked from the ring: [code, tick, x, y, a, b]. */
export interface SimEvent { code: EventCode; tick: number; x: number; y: number; a: number; b: number }
/** u32 words per event in the ring; x and y are f32 bit patterns. */
export const EVENT_WORDS = 6;

/** What the WASM battle exposes for the per-frame buffers (byte addresses in WASM memory, counts in entries). */
export interface FrameSource {
  layout(): number;
  soldier_cap(): number;
  soldier_f32_ptr(): number;
  soldier_u32_ptr(): number;
  soldier_strikes_ptr(): number;
  soldier_ticks_ptr(): number;
  squad_cap(): number;
  squad_f32_ptr(): number;
  squad_u32_ptr(): number;
  squad_unit_ptr(): number;
  events_cap(): number;
  events_ptr(): number;
  fog_len(): number;
  fog_ptr(): number;
}

/**
 * Keeps typed-array views over WASM memory valid. WASM memory growth replaces memory.buffer and detaches old
 * views, and a buffer that outgrows its reserve moves (the source's layout() changes), so call refresh() once per
 * frame, after sync() and drain_events(), before reading.
 */
export class Views {
  private buf: ArrayBuffer | null = null;
  private layout = -1;
  f32!: Float32Array; u32!: Uint32Array; strikes!: Uint32Array; ticks!: Uint32Array;
  squadF32!: Float32Array; squadU32!: Uint32Array; squadUnit!: Uint32Array;
  events!: Uint32Array; eventsF32!: Float32Array;
  fog!: Uint8Array;
  constructor(private memory: WebAssembly.Memory, private src: FrameSource) {}
  /** True when the views were re-created. */
  refresh(): boolean {
    const layout = this.src.layout();
    if (this.memory.buffer === this.buf && layout === this.layout) return false;
    this.buf = this.memory.buffer;
    this.layout = layout;
    const s = this.src;
    const cap = s.soldier_cap();
    const qcap = s.squad_cap();
    const ecap = s.events_cap();
    this.f32 = new Float32Array(this.buf, s.soldier_f32_ptr(), cap * SOLDIER_F32.FIELDS);
    this.u32 = new Uint32Array(this.buf, s.soldier_u32_ptr(), cap);
    this.strikes = new Uint32Array(this.buf, s.soldier_strikes_ptr(), cap);
    this.ticks = new Uint32Array(this.buf, s.soldier_ticks_ptr(), cap * SOLDIER_TICKS.FIELDS);
    this.squadF32 = new Float32Array(this.buf, s.squad_f32_ptr(), qcap * SQUAD_F32.FIELDS);
    this.squadU32 = new Uint32Array(this.buf, s.squad_u32_ptr(), qcap);
    this.squadUnit = new Uint32Array(this.buf, s.squad_unit_ptr(), qcap);
    this.events = new Uint32Array(this.buf, s.events_ptr(), ecap * EVENT_WORDS);
    this.eventsF32 = new Float32Array(this.buf, s.events_ptr(), ecap * EVENT_WORDS);
    this.fog = new Uint8Array(this.buf, s.fog_ptr(), s.fog_len());
    return true;
  }
}
