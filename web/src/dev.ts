import type { BattleView } from './battle/battle';
import { SQUAD_F32, SQUAD_STATE, squadBits, squadUnit, KIND_ORDER, type Deed, type Source } from './contracts';
import { inputHooks, type Input } from './input';
import { FWD, PITCH, ZOOMS } from './view/camera';
import { FOG_NEVER, FOG_SEEN, FOG_SIGHT } from './view/fog';
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
  /** Up to 12 stray pixels: frame index, art-pixel position (y up) and the colour before and after. */
  strays: string[];
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

/** Notes the pixels that still differ under shift `s`, up to 12 in all. */
function strays(a: Uint8Array, b: Uint8Array, w: number, h: number, s: { dx: number; dy: number }, frame: number, out: string[]): void {
  const hex = (d: Uint8Array, k: number) => ((d[k * 4] << 16) | (d[k * 4 + 1] << 8) | d[k * 4 + 2]).toString(16).padStart(6, '0');
  for (let y = MAX_SHIFT; y < h - MAX_SHIFT && out.length < 12; y++) {
    for (let x = MAX_SHIFT; x < w - MAX_SHIFT && out.length < 12; x++) {
      // As in bestShift: the earlier frame `b` at (x, y) against the later frame `a` at (x+dx, y+dy).
      const k = y * w + x;
      const ka = (y + s.dy) * w + x + s.dx;
      if (b[k * 4] !== a[ka * 4] || b[k * 4 + 1] !== a[ka * 4 + 1] || b[k * 4 + 2] !== a[ka * 4 + 2]) {
        out.push(`f${frame} (${x + s.dx},${y + s.dy}) ${hex(b, k)}→${hex(a, ka)}`);
      }
    }
  }
}

/** A synthetic pointer event on the canvas, at client (x, y). */
function pointer(view: View, type: string, x: number, y: number, o: { id?: number; touch?: boolean; button?: number } = {}): void {
  const touch = o.touch ?? false;
  const down = type === 'pointerdown' || type === 'pointermove';
  view.canvas.dispatchEvent(
    new PointerEvent(type, {
      pointerId: o.id ?? (touch ? 11 : 1),
      pointerType: touch ? 'touch' : 'mouse',
      isPrimary: (o.id ?? 0) < 12,
      clientX: x,
      clientY: y,
      button: type === 'pointermove' ? -1 : (o.button ?? 0),
      buttons: down ? 1 << (o.button ?? 0) : 0,
      bubbles: true,
      cancelable: true,
    }),
  );
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export function installDev(view: View, battle: BattleView, input?: Input): void {
  /** Each company: id, team, kind, unit, state, men alive / full, morale (0..1 of max), anchor; and the outcome. */
  function battleState() {
    const sim = battle.sim;
    battle.views.refresh();
    const q = sim.squad_count();
    const squads = [];
    for (let j = 0; j < q; j++) {
      const w = battle.views.squadU32[j];
      const o = j * SQUAD_F32.FIELDS;
      const f = battle.views.squadF32;
      squads.push({
        id: j,
        name: sim.squad_name(j),
        team: squadBits.team(w),
        kind: KIND_ORDER[squadBits.kind(w)],
        unit: squadUnit(battle.views.squadUnit[j]),
        state: SQUAD_STATE[squadBits.state(w)],
        men: `${squadBits.alive(w)}/${squadBits.full(w)}`,
        morale: Math.round(f[o + SQUAD_F32.MORALE] * 100) / 100,
        at: [Math.round(f[o + SQUAD_F32.X] * 10) / 10, Math.round(f[o + SQUAD_F32.Y] * 10) / 10],
      });
    }
    const outcome = sim.outcome();
    return {
      tick: sim.tick(),
      seconds: Math.round((sim.tick() / 30) * 10) / 10,
      bots: battle.bots,
      clock: { slow: battle.clock.slow, fast: battle.clock.fast, paused: battle.clock.paused },
      drawn: { men: battle.records.men.length, banners: battle.records.banners.length, hidden: battle.records.hidden },
      outcome: outcome ? JSON.parse(outcome) : battle.outcome,
      squads,
    };
  }

  const v = {
    view,
    battle,
    /** The commander bot plays our side (on), or nobody does (off). */
    pilot(on = true): boolean {
      battle.pilot(on);
      return on;
    },
    /** The enemy's bot: garrison, general0..2, charge, idle or none. */
    bot(kind: string): string {
      battle.bot(kind);
      return kind;
    },
    /**
     * Fast-forwards the sim `ticks` (with its bots), then lets the figures catch up at once, so a shot right after
     * shows where everyone is. Returns the tick reached and how long the stepping took.
     */
    ff(ticks: number): { tick: number; ms: number } {
      const ms = battle.fastForward(ticks);
      battle.settle();
      view.render();
      return { tick: battle.sim.tick(), ms: Math.round(ms * 10) / 10 };
    },
    /**
     * Fast-forwards in steps of `chunk` ticks until `test(battle_state())` holds or `max` ticks have passed, e.g.
     * `__v.ffUntil(s => s.squads.some(q => q.state === 'fighting'))`. Returns the tick reached and whether it held.
     */
    ffUntil(test: (s: ReturnType<typeof battleState>) => boolean, max = 9000, chunk = 15): { tick: number; held: boolean } {
      const end = battle.sim.tick() + max;
      let held = test(battleState());
      while (!held && battle.sim.tick() < end) {
        battle.fastForward(chunk);
        held = test(battleState());
      }
      battle.settle();
      view.render();
      return { tick: battle.sim.tick(), held };
    },
    pause(on = true): boolean {
      battle.setPaused(on);
      view.render();
      return on;
    },
    /** Stops every clock like a pause, without the pause's grey: for shots and the shimmer test. */
    freeze(on = true): boolean {
      battle.clock.paused = on;
      view.render();
      return on;
    },
    fast(on = true): boolean {
      battle.clock.fast = on;
      return on;
    },
    /** Follow the captain again (F). */
    follow(on = true): boolean {
      battle.follow = on;
      return on;
    },
    /** Each company: id, team, kind, state, men alive / full, morale (0..1 of max), anchor; and the outcome. */
    battle_state: battleState,
    /** The sim's own text description (as the harness's `look`). */
    describe(): string {
      return battle.sim.describe();
    },
    /**
     * Runs `frames` game frames back to back at `dt` (the sim, records, figures and render as in the frame loop),
     * waiting for the GPU after each (a 1-pixel read), at a `w × h` CSS-pixel window if given. Returns perf().
     */
    bench({ frames = 300, dt = 1 / 60, w = 0, h = 0 } = {}) {
      const r = view.renderer;
      if (w && h) r.resize(w, h);
      const ctx = r.gl.getContext();
      const px = new Uint8Array(4);
      battle.perf.reset();
      for (let i = 0; i < frames; i++) {
        battle.frame(dt);
        if (!battle.clock.paused) view.time += dt;
        view.render();
        battle.perf.mark('render');
        ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
        battle.perf.mark('gpu');
        battle.perf.end();
      }
      const out = { ...battle.perf.report(), drawn: battle.figures.stats(), size: { ...r.size } };
      if (w && h) view.resize();
      return out;
    },
    /** Frame-time stats (ms) over the last 600 frames: sim step, records, figures, render, total, frame interval. */
    perf(reset = false) {
      if (reset) battle.perf.reset();
      return { ...battle.perf.report(), drawn: battle.figures.stats() };
    },
    /** Renders a frame and saves it to out/shots/<name>.png through the dev server. */
    async shot(name: string): Promise<string> {
      view.render();
      const blob = await new Promise<Blob | null>((ok) => view.canvas.toBlob(ok, 'image/png'));
      if (!blob) throw new Error('no frame');
      const res = await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
      return ((await res.json()) as { path: string }).path;
    },
    /** Sets the zoom to one of the 9 steps by index or by its art px per tile (7, 9, … 34). */
    zoom(i: number): number {
      const zi = ZOOMS.indexOf(i) >= 0 && i > ZOOMS.length - 1 ? ZOOMS.indexOf(i) : i;
      view.camera.zi = Math.max(0, Math.min(ZOOMS.length - 1, zi));
      view.render();
      return ZOOMS[view.camera.zi];
    },
    /** Looks at (x, y) and stops following the captain. */
    focus(x: number, y: number): void {
      battle.follow = false;
      view.camera.focus.set(x, y);
      view.render();
    },
    night(k: number): void {
      view.nightK = k;
      view.render();
    },
    /**
     * Sets the fog of war for a look at its three levels: 'sight' is all in sight (the default until sight is
     * simulated); 'bands' is never seen in the west third, seen before in the middle and in sight in the east; 'ring'
     * is in sight within 8 tiles of (x, y), seen before within 14, never seen beyond. The battle obeys it (enemies
     * and the dead outside sight are hidden) until `fog('sight')` hands the fog back to the sim.
     */
    fog(kind: 'sight' | 'bands' | 'ring' = 'sight', x = view.land.w / 2, y = view.land.h / 2): void {
      const { w, h } = view.land;
      const levels = new Uint8Array(w * h);
      for (let ty = 0; ty < h; ty++) {
        for (let tx = 0; tx < w; tx++) {
          const d = Math.hypot(tx + 0.5 - x, ty + 0.5 - y);
          levels[ty * w + tx] =
            kind === 'bands' ? (tx < w / 3 ? FOG_NEVER : tx < (2 * w) / 3 ? FOG_SEEN : FOG_SIGHT)
            : kind === 'ring' ? (d < 8 ? FOG_SIGHT : d < 14 ? FOG_SEEN : FOG_NEVER)
            : FOG_SIGHT;
        }
      }
      battle.overrideFog(kind === 'sight' ? null : levels);
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
    // ------------------------------------------------------------------------------- input and marks (day 4)
    input,
    /** The hooks the input calls (voice's captain hold, mute). */
    hooks: inputHooks,
    /** The client point of sim ground point (x, y) as last drawn. */
    toScreen(x: number, y: number): { x: number; y: number } {
      const r = view.canvas.getBoundingClientRect();
      const p = input!.screen.project(x, battle.groundH(x, y), y, { x: 0, y: 0 });
      return { x: p.x + r.left, y: p.y + r.top };
    },
    /** Soldier `id` as drawn: his feet and the top of his head in client points, his company and team. */
    man(id: number) {
      const at = battle.figures.drawnAt(id);
      const rec = battle.records.men.find((m) => m.id === id);
      if (!at || !rec) return null;
      const r = view.canvas.getBoundingClientRect();
      const s = input!.screen;
      const feet = s.fromArt(at.px, at.py, { x: 0, y: 0 });
      return { feet: { x: feet.x + r.left, y: feet.y + r.top }, squad: battle.views.u32[id] & 0xffff, team: rec.team, captain: rec.captain, unit: rec.unit, commander: rec.commander };
    },
    /** What a press at client (x, y) would hit now. */
    hit(x: number, y: number, touch = false, seen?: Parameters<NonNullable<Input>['battle']['hits']['test']>[3]) {
      const r = view.canvas.getBoundingClientRect();
      return input!.battle.hits.test(x - r.left, y - r.top, touch, seen);
    },
    /** Synthetic pointer events: one event, a tap, a press-and-slide, a drag along client points. */
    pointer: (type: string, x: number, y: number, o: { id?: number; touch?: boolean; button?: number } = {}) => pointer(view, type, x, y, o),
    tap(x: number, y: number, o: { touch?: boolean; slide?: [number, number]; holdMs?: number } = {}): Promise<void> | void {
      pointer(view, 'pointerdown', x, y, o);
      const end = () => {
        const [dx, dy] = o.slide ?? [0, 0];
        if (dx || dy) for (let i = 1; i <= 4; i++) pointer(view, 'pointermove', x + (dx * i) / 4, y + (dy * i) / 4, o);
        pointer(view, 'pointerup', x + (o.slide?.[0] ?? 0), y + (o.slide?.[1] ?? 0), o);
      };
      if (o.holdMs) return sleep(o.holdMs).then(end);
      end();
    },
    async drag(pts: [number, number][], o: { touch?: boolean; stepMs?: number; frames?: boolean } = {}): Promise<void> {
      pointer(view, 'pointerdown', pts[0][0], pts[0][1], o);
      for (let i = 1; i < pts.length; i++) {
        pointer(view, 'pointermove', pts[i][0], pts[i][1], o);
        if (o.stepMs) await sleep(o.stepMs);
      }
      const z = pts[pts.length - 1];
      pointer(view, 'pointerup', z[0], z[1], o);
    },
    /** Gives an order as the input would (with its marks). */
    issue(deed: Deed, src: Source = 'typed') {
      return battle.issue(deed, src);
    },
    select(id: number | null): void {
      if (id === null) input?.battle.deselect();
      else input?.battle.select(id);
    },
    ui() {
      return { ...battle.ui, mode: input?.pointer.mode, drawing: battle.clock.drawing, marks: battle.marks.stats() };
    },
    orders() {
      return battle.orders;
    },
    /** Runs `n` frames of `dt` at once (game frames: the sim, the input, the marks), then renders. */
    frames(n: number, dt = 1 / 60): void {
      for (let i = 0; i < n; i++) {
        battle.frame(dt);
        if (!battle.clock.paused) view.time += dt;
        input?.frame(dt);
      }
      view.render();
    },
    /**
     * Pans `steps` times by `step` art pixels of screen travel and checks that every change of the art-pixel
     * image is a whole-pixel shift of the frame before. Any other change is shimmer.
     */
    shimmer({ dir = 'right', step = 0.1, steps = 80 } = {}): ShimmerReport {
      const per = DIRS[dir](view.camera.s);
      const report: ShimmerReport = { dir, zoom: view.camera.s, frames: steps, changed: 0, badFrames: 0, maxBadPixels: 0, shifts: {}, strays: [] };
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
            strays(cur.data, prev.data, cur.w, cur.h, s, i, report.strays);
          }
        }
        prev = cur;
      }
      return report;
    },
  };
  (window as unknown as { __v: typeof v }).__v = v;
}
