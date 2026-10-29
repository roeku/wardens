import type { Gestures, Pressed } from '../input/pointer';
import { PointerInput } from '../input/pointer';
import type { View } from '../view/view';

// The screens' marks (docs/spec/01-flow.md §2 "Pointer state machine"): the same pointer state machine and thresholds
// as the battle, with what a press becomes past slop decided by what it landed on: a drag carrying a commander at the
// muster, a pan anywhere else on the road. Taps are taps; the wheel and a pinch zoom where the scene allows.

export interface SceneTaps {
  /** A press landed: return `{ becomes: 'drag' }` to carry something, or nothing to pan (or ignore) past slop. */
  press?(x: number, y: number, touchish: boolean): Partial<Pressed> | void;
  tap?(x: number, y: number, touchish: boolean): void;
  dragStart?(x: number, y: number): void;
  dragMove?(x: number, y: number): void;
  dragEnd?(x: number, y: number): void;
  /** A second finger came down, or the pointer was lost: drop what is carried. */
  cancel?(): void;
  hover?(x: number, y: number): void;
  /** The camera was panned by the player. */
  panned?(): void;
  twoFingerTap?(): void;
}

export interface SceneInput {
  readonly pointer: PointerInput;
  /** The last press came from a finger (touch thresholds). */
  readonly touchish: boolean;
  dispose(): void;
}

export function sceneInput(view: View, h: SceneTaps, opts: { pan: boolean; zoom: boolean }): SceneInput {
  let touchish = false;
  const g: Gestures = {
    press(x, y, t) {
      touchish = t;
      const p = h.press?.(x, y, t) ?? {};
      return { handle: p.handle ?? false, captain: false, becomes: p.becomes ?? (opts.pan ? 'pan' : 'drag') };
    },
    strokeStart: (x, y) => h.dragStart?.(x, y),
    strokeMove: (x, y) => h.dragMove?.(x, y),
    release: (x, y, tap) => (tap ? h.tap?.(x, y, touchish) : h.dragEnd?.(x, y)),
    cancel: () => h.cancel?.(),
    hold: () => {},
    pan(dx, dy) {
      if (!opts.pan) return;
      view.camera.panBy(dx, dy, view.renderer.size.px);
      h.panned?.();
    },
    zoom(step, x, y) {
      if (!opts.zoom) return;
      const { px, aw, ah } = view.renderer.size;
      view.camera.zoomAt(step, x - (aw * px) / 2, y - (ah * px) / 2, px);
    },
    twoFingerTap: () => h.twoFingerTap?.(),
    hover: (x, y) => h.hover?.(x, y),
    leave: () => {},
  };
  const local = (cx: number, cy: number) => {
    const r = view.canvas.getBoundingClientRect();
    return { x: cx - r.left, y: cy - r.top };
  };
  const pointer = new PointerInput(view.canvas, g, local);
  return {
    pointer,
    get touchish() {
      return touchish;
    },
    dispose: () => pointer.dispose(),
  };
}
