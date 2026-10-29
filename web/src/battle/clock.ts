import { TICK_HZ } from '../contracts';

// docs/spec/04-battle.md §1 "Fixed tick": the browser owns the accumulator, `acc += dt·rate`, stepping while
// acc ≥ 1/30, with rate = slow·(fast ? 2 : 1) and `slow` easing toward its target at dt·12. The target is 0.3 while
// the player draws a line or speaks (day 4; 06-voice.md §3), and 0.35 for 0.9 s after one of our commanders falls or
// 0.7 s after an enemy's.

const TICK = 1 / TICK_HZ;
const SLOW_EASE = 12;
export const SLOW_DRAWING = 0.3;
export const SLOW_FALL = 0.35;
export const FALL_OURS_S = 0.9;
export const FALL_FOES_S = 0.7;
/** At most this many ticks per frame, so a long hitch can't snowball (dt is already capped at 0.1 s). */
const MAX_TICKS = 12;

export class Clock {
  /** Seconds of simulated time not yet stepped, 0 ≤ acc < 1/30 after `advance`. */
  acc = 0;
  slow = 1;
  fast = false;
  paused = false;
  /** Set by the input layer while the player draws a line (day 4). */
  drawing = false;
  /** Set by voice while the captain speaks, and after release until the orders land (06-voice.md §3). */
  listening = false;
  /** Real seconds left of the slow time after a commander's fall. */
  private fallLeft = 0;

  get rate(): number {
    return this.slow * (this.fast ? 2 : 1);
  }

  /** The target `slow` eases toward. */
  get target(): number {
    let t = 1;
    if (this.drawing || this.listening) t = Math.min(t, SLOW_DRAWING);
    if (this.fallLeft > 0) t = Math.min(t, SLOW_FALL);
    return t;
  }

  /** Real seconds left of a fall's slow time (0 when none): the face moment (battle/faces.ts) keeps time with it. */
  get fallHold(): number {
    return this.fallLeft;
  }

  /** A commander fell: slow time for `seconds` of real time (the longer hold wins). */
  holdSlow(seconds: number): void {
    this.fallLeft = Math.max(this.fallLeft, seconds);
  }

  /** Advances by `dt` real seconds and returns how many ticks to step. Paused: none, and nothing eases. */
  advance(dt: number): number {
    if (this.paused) return 0;
    this.fallLeft = Math.max(0, this.fallLeft - dt);
    this.slow += (this.target - this.slow) * Math.min(1, dt * SLOW_EASE);
    this.acc += dt * this.rate;
    let n = 0;
    while (this.acc >= TICK && n < MAX_TICKS) {
      this.acc -= TICK;
      n++;
    }
    // a hitch beyond MAX_TICKS drops the rest rather than carrying it into the next frames
    if (this.acc >= TICK) this.acc = 0;
    return n;
  }
}
