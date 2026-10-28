import type { View } from '../view/view';

// Temporary camera controls until the pointer state machine lands (day 4, docs/spec/01-flow.md §2): a drag pans,
// the wheel steps the zoom once per 90 deltaY, arrows/WASD pan at 520 px/s, + and − zoom.

const WHEEL_STEP = 90;
const KEY_PAN = 520;
const PAN_KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
  ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
};

export function bindCameraControls(view: View): (dt: number) => void {
  const { canvas } = view;
  const held = new Set<string>();
  let drag: { x: number; y: number } | null = null;
  let wheel = 0;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    view.camera.panBy(e.clientX - drag.x, e.clientY - drag.y, view.renderer.size.px);
    drag = { x: e.clientX, y: e.clientY };
  });
  const end = () => (drag = null);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      wheel += e.deltaY;
      const r = canvas.getBoundingClientRect();
      while (Math.abs(wheel) >= WHEEL_STEP) {
        const step = wheel > 0 ? -1 : 1;
        wheel -= Math.sign(wheel) * WHEEL_STEP;
        view.camera.zoomAt(step, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2, view.renderer.size.px);
      }
    },
    { passive: false },
  );
  window.addEventListener('keydown', (e) => {
    held.add(e.code);
    if (e.key === '+' || e.key === '=') view.camera.zoomAt(1, 0, 0, view.renderer.size.px);
    if (e.key === '-' || e.key === '_') view.camera.zoomAt(-1, 0, 0, view.renderer.size.px);
  });
  window.addEventListener('keyup', (e) => held.delete(e.code));
  window.addEventListener('blur', () => held.clear());

  return (dt) => {
    let dx = 0;
    let dy = 0;
    for (const code of held) {
      const d = PAN_KEYS[code];
      if (d) [dx, dy] = [dx + d[0], dy + d[1]];
    }
    if (dx || dy) view.camera.panBy(-dx * KEY_PAN * dt, -dy * KEY_PAN * dt, view.renderer.size.px);
  };
}
