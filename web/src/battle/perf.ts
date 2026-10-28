// Frame-time measurement for the battle (01-flow.md §8 "Performance"): the CPU cost of each stage of a frame
// (sim step, record build, figures update, render submission), the wait for the GPU when a bench forces it, and the
// interval between animation frames, over the last WINDOW frames. Read with `__v.perf()`; `__v.bench()` runs frames
// back to back and waits for the GPU after each, so it measures even when the page gets no animation frames.

const WINDOW = 600;
export const STAGES = ['step', 'records', 'figures', 'render', 'gpu'] as const;
export type Stage = (typeof STAGES)[number];

export interface StageStats {
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
}

function stats(a: Float64Array, n: number): StageStats {
  const s = Array.from(a.subarray(0, n)).sort((x, y) => x - y);
  const at = (q: number) => (n ? s[Math.min(n - 1, Math.floor(q * n))] : 0);
  const mean = n ? s.reduce((x, y) => x + y, 0) / n : 0;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { p50: r(at(0.5)), p90: r(at(0.9)), p99: r(at(0.99)), max: r(n ? s[n - 1] : 0), mean: r(mean) };
}

export class Perf {
  private readonly rings: Record<Stage | 'total' | 'interval', Float64Array>;
  private n = 0;
  private i = 0;
  private open = false;
  private t0 = 0;
  private last = 0;
  private readonly cur: Record<Stage, number> = { step: 0, records: 0, figures: 0, render: 0, gpu: 0 };
  private lastFrame = 0;

  constructor() {
    const ring = () => new Float64Array(WINDOW);
    this.rings = { step: ring(), records: ring(), figures: ring(), render: ring(), gpu: ring(), total: ring(), interval: ring() };
  }

  begin(): void {
    this.open = true;
    this.t0 = this.last = performance.now();
    for (const s of STAGES) this.cur[s] = 0;
  }

  /** The time since the previous mark goes to `stage`. Outside a frame (shots, the shimmer test) it is ignored. */
  mark(stage: Stage): void {
    if (!this.open) return;
    const now = performance.now();
    this.cur[stage] += now - this.last;
    this.last = now;
  }

  end(): void {
    if (!this.open) return;
    this.open = false;
    const now = performance.now();
    const k = this.i;
    for (const s of STAGES) this.rings[s][k] = this.cur[s];
    this.rings.total[k] = now - this.t0;
    this.rings.interval[k] = this.lastFrame ? now - this.lastFrame : 0;
    this.lastFrame = now;
    this.i = (k + 1) % WINDOW;
    this.n = Math.min(WINDOW, this.n + 1);
  }

  reset(): void {
    this.n = this.i = 0;
    this.lastFrame = 0;
  }

  report(): Record<Stage | 'total' | 'interval', StageStats> & { frames: number } {
    const out = { frames: this.n } as Record<Stage | 'total' | 'interval', StageStats> & { frames: number };
    for (const key of [...STAGES, 'total', 'interval'] as const) out[key] = stats(this.rings[key], this.n);
    return out;
  }
}
