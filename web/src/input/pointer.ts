import {
  HOLD_S,
  PINCH_STEP,
  thresholds,
  TWO_TAP_MS,
  TWO_TAP_PX,
  WHEEL_STEP,
} from './thresholds';

// The pointer state machine (docs/spec/01-flow.md §2): modes none | press | stroke | pan | pinch | drag.
// - One pointer down → press; the right or middle mouse button pans instead.
// - Past slop the press becomes a stroke (in battle; a drag at the muster, a pan on the road). A press on a company
//   or the captain that never strays further than its tap radius is still a tap, however much it slid.
// - Holding the captain still for 400 ms starts voice; releasing after that is not a tap.
// - A second pointer cancels the stroke, gives back the press's selection and pinches: the midpoint pans, the zoom
//   steps each time log(d/d0) passes ±0.22. Both fingers down and up within 320 ms, under 14 px of travel, is a
//   two-finger tap.
// - The wheel steps the zoom once per 90 deltaY.
// What each gesture means in battle is `Gestures`' business (command.ts); this file only recognises them.

export type Mode = 'none' | 'press' | 'stroke' | 'pan' | 'pinch' | 'drag';

/** What the press landed on, as far as the state machine cares. */
export interface Pressed {
  /** A company or the captain: the tap radius applies, however far it slid. */
  handle: boolean;
  /** The captain: holding him still starts voice. */
  captain: boolean;
  /** What the press becomes past slop: a stroke (in battle, the default), a drag (carrying a commander at the
   * muster), or a pan (the road, the title: the ground follows the finger and nothing is ordered). */
  becomes?: 'stroke' | 'drag' | 'pan';
}

export interface Gestures {
  /** One pointer down: settle the press where it lands (CSS px from the canvas's top-left). */
  press(x: number, y: number, touchish: boolean): Pressed;
  /** The press moved past slop: a stroke from where it was pressed. */
  strokeStart(x: number, y: number): void;
  strokeMove(x: number, y: number): void;
  /** Release; `tap` when the press never became a stroke, or never strayed past its tap radius off a handle. */
  release(x: number, y: number, tap: boolean): void;
  /** A second pointer came down, or the pointer was cancelled: no order, the press's selection given back. */
  cancel(): void;
  /** The captain held still for 400 ms ('start'), and let go ('end'). */
  hold(phase: 'start' | 'end'): void;
  /** Pan by CSS px (the ground follows the finger). */
  pan(dx: number, dy: number): void;
  /** One zoom step in (+1) or out (−1) about a CSS point. */
  zoom(step: number, x: number, y: number): void;
  twoFingerTap(): void;
  /** The mouse moved with no button down; `leave` when it left the canvas. */
  hover(x: number, y: number): void;
  leave(): void;
}

interface Track {
  x: number;
  y: number;
  x0: number;
  y0: number;
}

interface PressState {
  id: number;
  x0: number;
  y0: number;
  /** The furthest it has strayed from where it was pressed, CSS px. */
  stray: number;
  touchish: boolean;
  pressed: Pressed;
  t0: number;
  timer: number;
  holding: boolean;
}

export class PointerInput {
  mode: Mode = 'none';
  private readonly tracks = new Map<number, Track>();
  private press: PressState | null = null;
  private panId = -1;
  /** The pan was begun by a touch press (a second finger then pinches). */
  private panTouch = false;
  private pinch: { a: number; b: number; d0: number; mx: number; my: number } | null = null;
  private twoTap: { t0: number; travel: number } | null = null;
  private wheel = 0;

  constructor(
    private readonly el: HTMLElement,
    private readonly g: Gestures,
    private readonly local: (clientX: number, clientY: number) => { x: number; y: number },
  ) {
    el.style.touchAction = 'none';
    el.style.userSelect = 'none';
    (el.style as CSSStyleDeclaration & { webkitUserSelect: string }).webkitUserSelect = 'none';
    this.on('contextmenu', (e) => e.preventDefault());
    this.on('pointerdown', (e) => this.down(e as PointerEvent));
    this.on('pointermove', (e) => this.move(e as PointerEvent));
    this.on('pointerup', (e) => this.up(e as PointerEvent, false));
    this.on('pointercancel', (e) => this.up(e as PointerEvent, true));
    this.on('wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.on('pointerleave', (e) => {
      if ((e as PointerEvent).pointerType === 'mouse') this.g.leave();
    });
  }

  private readonly bound: [string, (e: Event) => void, AddEventListenerOptions | undefined][] = [];

  private on(type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    this.el.addEventListener(type, fn, opts);
    this.bound.push([type, fn, opts]);
  }

  /** Unhooks every listener (a scene ends); a press in progress is dropped without an order. */
  dispose(): void {
    for (const [type, fn, opts] of this.bound) this.el.removeEventListener(type, fn, opts);
    this.bound.length = 0;
    if (this.press) window.clearTimeout(this.press.timer);
    this.press = null;
    this.mode = 'none';
    this.tracks.clear();
  }

  private down(e: PointerEvent): void {
    e.preventDefault();
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // a synthetic pointer cannot be captured; its events still come to the canvas
    }
    const p = this.local(e.clientX, e.clientY);
    this.tracks.set(e.pointerId, { x: p.x, y: p.y, x0: p.x, y0: p.y });
    const touchish = e.pointerType !== 'mouse';
    if (!touchish && e.button !== 0) {
      if (this.mode === 'none') {
        this.mode = 'pan';
        this.panId = e.pointerId;
      }
      return;
    }
    if (this.mode === 'none') {
      const pressed = this.g.press(p.x, p.y, touchish);
      this.mode = 'press';
      this.press = { id: e.pointerId, x0: p.x, y0: p.y, stray: 0, touchish, pressed, t0: performance.now(), timer: 0, holding: false };
      if (pressed.captain) {
        const st = this.press;
        st.timer = window.setTimeout(() => {
          if (this.press === st && this.mode === 'press') {
            st.holding = true;
            this.g.hold('start');
          }
        }, HOLD_S * 1000);
      }
      return;
    }
    if (this.mode === 'pan' && touchish && this.panTouch && this.tracks.has(this.panId)) {
      // a second finger on a pan begun by a press: pinch
      const first = this.panId;
      this.panId = -1;
      this.panTouch = false;
      this.startPinch(first, e.pointerId, performance.now() - TWO_TAP_MS, TWO_TAP_PX);
      return;
    }
    if ((this.mode === 'press' || this.mode === 'stroke' || this.mode === 'drag') && touchish && this.press) {
      // a second finger: cancel the stroke, give back the press's selection, pinch
      const st = this.press;
      window.clearTimeout(st.timer);
      if (st.holding) this.g.hold('end');
      this.g.cancel();
      this.press = null;
      this.startPinch(st.id, e.pointerId, st.t0, st.stray);
    }
  }

  /** Two fingers: the first (already `travel` px from where it went down) and the second. */
  private startPinch(a: number, b: number, t0: number, travel: number): void {
    const ta = this.tracks.get(a)!;
    const tb = this.tracks.get(b)!;
    this.mode = 'pinch';
    this.pinch = { a, b, d0: Math.max(1, Math.hypot(ta.x - tb.x, ta.y - tb.y)), mx: (ta.x + tb.x) / 2, my: (ta.y + tb.y) / 2 };
    this.twoTap = { t0, travel };
  }

  private move(e: PointerEvent): void {
    const p = this.local(e.clientX, e.clientY);
    const tr = this.tracks.get(e.pointerId);
    if (!tr) {
      if (this.mode === 'none' && e.pointerType === 'mouse') this.g.hover(p.x, p.y);
      return;
    }
    const dx = p.x - tr.x;
    const dy = p.y - tr.y;
    tr.x = p.x;
    tr.y = p.y;
    switch (this.mode) {
      case 'press':
      case 'stroke':
      case 'drag': {
        const st = this.press;
        if (!st || st.id !== e.pointerId) return;
        const d = Math.hypot(p.x - st.x0, p.y - st.y0);
        st.stray = Math.max(st.stray, d);
        if (this.mode === 'press') {
          if (st.holding || d <= thresholds(st.touchish).slop) return;
          window.clearTimeout(st.timer);
          const becomes = st.pressed.becomes ?? 'stroke';
          if (becomes === 'pan') {
            // the press becomes a pan: the ground follows the finger from where it went down
            this.press = null;
            this.mode = 'pan';
            this.panId = st.id;
            this.panTouch = st.touchish;
            this.g.pan(p.x - st.x0, p.y - st.y0);
            return;
          }
          this.mode = becomes;
          this.g.strokeStart(st.x0, st.y0);
        }
        this.g.strokeMove(p.x, p.y);
        return;
      }
      case 'pan':
        if (e.pointerId === this.panId && (dx || dy)) this.g.pan(dx, dy);
        return;
      case 'pinch': {
        const pc = this.pinch;
        if (!pc) return;
        if (this.twoTap) this.twoTap.travel = Math.max(this.twoTap.travel, Math.hypot(p.x - tr.x0, p.y - tr.y0));
        const ta = this.tracks.get(pc.a);
        const tb = this.tracks.get(pc.b);
        if (!ta || !tb) return;
        const mx = (ta.x + tb.x) / 2;
        const my = (ta.y + tb.y) / 2;
        if (mx !== pc.mx || my !== pc.my) this.g.pan(mx - pc.mx, my - pc.my);
        pc.mx = mx;
        pc.my = my;
        const d = Math.max(1, Math.hypot(ta.x - tb.x, ta.y - tb.y));
        let l = Math.log(d / pc.d0);
        while (Math.abs(l) >= PINCH_STEP) {
          const step = l > 0 ? 1 : -1;
          this.g.zoom(step, mx, my);
          pc.d0 *= Math.exp(step * PINCH_STEP);
          l = Math.log(d / pc.d0);
        }
        return;
      }
    }
  }

  private up(e: PointerEvent, cancelled: boolean): void {
    const tr = this.tracks.get(e.pointerId);
    this.tracks.delete(e.pointerId);
    const p = tr ? { x: tr.x, y: tr.y } : this.local(e.clientX, e.clientY);
    switch (this.mode) {
      case 'press':
      case 'stroke':
      case 'drag': {
        const st = this.press;
        if (!st || st.id !== e.pointerId) return;
        window.clearTimeout(st.timer);
        const stroke = this.mode !== 'press';
        this.press = null;
        this.mode = 'none';
        if (st.holding) this.g.hold('end');
        else if (cancelled) this.g.cancel();
        else if (!stroke) this.g.release(p.x, p.y, true);
        else this.g.release(p.x, p.y, st.pressed.handle && st.stray <= thresholds(st.touchish).tapRadius);
        return;
      }
      case 'pan':
        if (e.pointerId === this.panId) {
          this.mode = 'none';
          this.panId = -1;
          this.panTouch = false;
        }
        return;
      case 'pinch':
        if (this.twoTap && tr) this.twoTap.travel = Math.max(this.twoTap.travel, Math.hypot(tr.x - tr.x0, tr.y - tr.y0));
        if (this.tracks.size > 0) return;
        if (!cancelled && this.twoTap && performance.now() - this.twoTap.t0 <= TWO_TAP_MS && this.twoTap.travel < TWO_TAP_PX) this.g.twoFingerTap();
        this.mode = 'none';
        this.pinch = null;
        this.twoTap = null;
        return;
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.wheel += e.deltaY;
    const p = this.local(e.clientX, e.clientY);
    while (Math.abs(this.wheel) >= WHEEL_STEP) {
      const step = this.wheel > 0 ? -1 : 1;
      this.wheel -= Math.sign(this.wheel) * WHEEL_STEP;
      this.g.zoom(step, p.x, p.y);
    }
  }
}
