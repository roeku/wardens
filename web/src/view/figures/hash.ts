// The view's only randomness: the same `hash32(a, b, c)` as crates/sim/src/rng.rs (03-land.md §2), so a figure's
// looks follow from its id and frames can be compared. Never Math.random.

const GOLDEN = 0x9e3779b9;

export function hash32(a: number, b: number, c: number): number {
  let h = (a ^ GOLDEN) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = (h ^ Math.imul((b + 0x165667b1) >>> 0, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ Math.imul((c + 0x27d4eb2f) >>> 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x2545f491) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** hash32 as a float in [0, 1). */
export function unit(a: number, b: number, c: number): number {
  return hash32(a, b, c) / 4294967296;
}
