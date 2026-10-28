import { FWD, PITCH, ZOOMS } from './view/camera';
import type { View } from './view/view';

// window.__v: the eyes an agent uses (docs/spec/00-start-here.md §A5). Dev builds only.

const R = Math.SQRT1_2;
/** Pan directions in sim tiles per art pixel of screen travel at zoom s. */
const DIRS: Record<string, (s: number) => [number, number]> = {
  right: (s) => [R / s, R / s],
  up: (s) => [FWD.x / (s * Math.sin(PITCH)), FWD.z / (s * Math.sin(PITCH))],
  east: (s) => [1 / s, 0],
  north: (s) => [0, -1 / s],
};
const MAX_SHIFT = 3;

interface ShimmerReport {
  dir: string;
  zoom: number;
  frames: number;
  changed: number;
  /** Frames whose change was not a whole-pixel shift of the frame before, and their worst pixel count. */
  badFrames: number;
  maxBadPixels: number;
  shifts: Record<string, number>;
}

/** The best whole-pixel shift from `a` to `b`, and how many interior pixels still differ under it. */
function bestShift(a: Uint8Array, b: Uint8Array, w: number, h: number): { dx: number; dy: number; bad: number } {
  const a32 = new Uint32Array(a.buffer);
  const b32 = new Uint32Array(b.buffer);
  let best = { dx: 0, dy: 0, bad: Infinity };
  for (let dy = -MAX_SHIFT; dy <= MAX_SHIFT; dy++) {
    for (let dx = -MAX_SHIFT; dx <= MAX_SHIFT; dx++) {
      let bad = 0;
      for (let y = MAX_SHIFT; y < h - MAX_SHIFT && bad < best.bad; y++) {
        for (let x = MAX_SHIFT; x < w - MAX_SHIFT; x++) {
          if (b32[y * w + x] !== a32[(y + dy) * w + x + dx]) bad++;
        }
      }
      if (bad < best.bad) best = { dx, dy, bad };
    }
  }
  return best;
}

export function installDev(view: View): void {
  const v = {
    view,
    /** Renders a frame and saves it to out/shots/<name>.png through the dev server. */
    async shot(name: string): Promise<string> {
      view.render();
      const blob = await new Promise<Blob | null>((ok) => view.canvas.toBlob(ok, 'image/png'));
      if (!blob) throw new Error('no frame');
      const res = await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
      return ((await res.json()) as { path: string }).path;
    },
    zoom(i: number): number {
      view.camera.zi = Math.max(0, Math.min(ZOOMS.length - 1, i));
      view.render();
      return ZOOMS[view.camera.zi];
    },
    focus(x: number, y: number): void {
      view.camera.focus.set(x, y);
      view.render();
    },
    night(k: number): void {
      view.nightK = k;
      view.render();
    },
    grey(on: boolean): void {
      view.grey = on ? 1 : 0;
      view.render();
    },
    state() {
      const { px, dpr, aw, ah } = view.renderer.size;
      const c = view.camera;
      return { px, dpr, aw, ah, zoom: c.s, focus: [c.focus.x, c.focus.y], sub: [c.sub.x, c.sub.y], origin: [c.origin.x, c.origin.y] };
    },
    /**
     * Pans `steps` times by `step` art pixels of screen travel and checks that every change of the art-pixel
     * image is a whole-pixel shift of the frame before. Any other change is shimmer.
     */
    shimmer({ dir = 'right', step = 0.1, steps = 80 } = {}): ShimmerReport {
      const per = DIRS[dir](view.camera.s);
      const report: ShimmerReport = { dir, zoom: view.camera.s, frames: steps, changed: 0, badFrames: 0, maxBadPixels: 0, shifts: {} };
      view.render();
      let prev = view.renderer.readCell();
      for (let i = 0; i < steps; i++) {
        view.camera.focus.x += per[0] * step;
        view.camera.focus.y += per[1] * step;
        view.render();
        const cur = view.renderer.readCell();
        if (!cur.data.every((x, k) => x === prev.data[k])) {
          report.changed++;
          const s = bestShift(cur.data, prev.data, cur.w, cur.h);
          const key = `${s.dx},${s.dy}`;
          report.shifts[key] = (report.shifts[key] ?? 0) + 1;
          if (s.bad > 0) {
            report.badFrames++;
            report.maxBadPixels = Math.max(report.maxBadPixels, s.bad);
          }
        }
        prev = cur;
      }
      return report;
    },
  };
  (window as unknown as { __v: typeof v }).__v = v;
}
