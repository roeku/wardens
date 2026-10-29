import type { Battle } from '../sim-pkg/sim_wasm.js';
import { makeLandInline, makeLandInWorker } from '../view/land';
import type { LandData } from '../view/land-data';

// Lands for the scenes (docs/spec/01-flow.md §8 Performance 2; 03-land.md §10): made in the land worker as soon as a
// map is known, kept by the map's hash, so a return to the road (or the title's field) swaps a land already made.

/** FNV-1a of a string, as a key. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${s.length}:${h.toString(16)}`;
}

/** How many lands are kept (chosen: the road, the battle being fought, and one made ahead). */
const KEEP = 4;

export class Lands {
  private readonly made = new Map<string, Promise<LandData>>();
  /** Lands made, and how long each took in the worker (ms). */
  readonly log: { key: string; ms: number; where: string }[] = [];

  constructor(private readonly inline: boolean) {}

  /** The land of `battle`'s map: made once (in the worker unless `?land=inline`), then kept. */
  of(battle: Battle): Promise<LandData> {
    const json = battle.map_json();
    const key = fnv(json);
    let p = this.made.get(key);
    if (!p) {
      p = this.inline ? Promise.resolve(makeLandInline(battle)) : makeLandInWorker(json);
      p.then((l) => this.log.push({ key, ms: Math.round(l.ms * 10) / 10, where: l.where })).catch(() => this.made.delete(key));
      this.made.set(key, p);
      while (this.made.size > KEEP) this.made.delete(this.made.keys().next().value as string);
    } else {
      // keep the newest use last
      this.made.delete(key);
      this.made.set(key, p);
    }
    return p;
  }
}
