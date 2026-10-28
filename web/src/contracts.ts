// Shared contracts, TypeScript side. Mirror of contracts.rs; keep the two in step.
// Units: tiles (x east, y south), seconds, radians (facing = atan2(dy, dx) in sim coordinates).

export const TICK_HZ = 30;

export type Team = 0 | 1; // 0 player, 1 enemy
export type Kind = 'spear' | 'shield' | 'archer' | 'horse' | 'levy' | 'folk' | 'captain' | 'beast';
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

// Soldier buffer layout (struct of arrays over WASM memory).
export const SOLDIER_F32 = { X: 0, Y: 1, FACE: 2, SPEED: 3, HP: 4, FIELDS: 5 } as const;
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
};
export const KIND_ORDER: Kind[] = ['spear', 'shield', 'archer', 'horse', 'levy', 'folk', 'captain', 'beast'];

export const SQUAD_F32 = { X: 0, Y: 1, FACE: 2, MORALE: 3, LEAN: 4, ALIVE_FRAC: 5, FIELDS: 6 } as const;
export const SQUAD_STATE = ['idle', 'marching', 'fighting', 'routing', 'fled', 'destroyed'] as const;

export enum EventCode {
  Hit = 1, Volley, Charge, Death, BannerFall, CommanderFall, FoeCommanderFall, Rout, Rally,
  SiteTaken, HouseFired, HouseLost, Freed, Saved, Nightfall, Dawn, DuskBell, Breath, Refused, Outcome,
}
/** One event as unpacked from the ring: [code, tick, x, y, a, b]. */
export interface SimEvent { code: EventCode; tick: number; x: number; y: number; a: number; b: number }

/**
 * Keeps typed-array views over WASM memory valid. WASM memory growth replaces memory.buffer and
 * detaches old views, so call refresh() once per frame before reading.
 */
export class Views {
  private buf: ArrayBuffer | null = null;
  f32!: Float32Array; u32!: Uint32Array; strikes!: Uint32Array;
  constructor(private memory: WebAssembly.Memory, private ptrs: () => { f32: number; u32: number; strikes: number; cap: number }) {}
  refresh(): void {
    if (this.memory.buffer === this.buf) return;
    this.buf = this.memory.buffer;
    const p = this.ptrs();
    this.f32 = new Float32Array(this.buf, p.f32, p.cap * SOLDIER_F32.FIELDS);
    this.u32 = new Uint32Array(this.buf, p.u32, p.cap);
    this.strikes = new Uint32Array(this.buf, p.strikes, p.cap);
  }
}
