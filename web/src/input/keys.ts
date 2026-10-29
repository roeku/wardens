import type { BattleView } from '../battle/battle';
import type { View } from '../view/view';
import type { BattleInput } from './command';
import { inputHooks } from './hooks';
import { KEY_PAN } from './thresholds';

// The battle's keys (docs/spec/01-flow.md §2 "Pause and keys"): Space or P pause (orders still work while
// paused), X ×2 speed, F follow the captain, Esc deselect, M mute (`inputHooks.onMute`), + and − zoom, arrows and
// WASD pan at 520 px/s. V (held: talk) is voice's own key (web/src/voice/live); N (new campaign) waits for the
// campaign. Keys typed into a text field are not the battle's.

const PAN_KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
  ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
};

const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};

/** Binds the keys; returns the per-frame pan by held keys, and how to unbind them. */
export function bindKeys(view: View, battle: BattleView, input: BattleInput): { frame: (dt: number) => void; dispose: () => void } {
  const held = new Set<string>();
  const down = (e: KeyboardEvent) => {
    if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (PAN_KEYS[e.code]) {
      held.add(e.code);
      e.preventDefault();
    }
    if (e.repeat) return;
    switch (e.code) {
      case 'Space':
      case 'KeyP':
        e.preventDefault();
        battle.setPaused(!battle.clock.paused);
        return;
      case 'KeyX':
        battle.clock.fast = !battle.clock.fast;
        return;
      case 'KeyF':
        battle.follow = true;
        return;
      case 'Escape':
        input.deselect();
        return;
      case 'KeyM':
        inputHooks.onMute();
        return;
    }
    if (e.key === '+' || e.key === '=') view.camera.zoomAt(1, 0, 0, view.renderer.size.px);
    else if (e.key === '-' || e.key === '_') view.camera.zoomAt(-1, 0, 0, view.renderer.size.px);
  };
  const up = (e: KeyboardEvent) => held.delete(e.code);
  const blur = () => held.clear();
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', blur);
  const dispose = () => {
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
    window.removeEventListener('blur', blur);
    held.clear();
  };
  const frame = (dt: number) => {
    let dx = 0;
    let dy = 0;
    for (const code of held) {
      const d = PAN_KEYS[code];
      if (d) [dx, dy] = [dx + d[0], dy + d[1]];
    }
    if (dx || dy) {
      view.camera.panBy(-dx * KEY_PAN * dt, -dy * KEY_PAN * dt, view.renderer.size.px);
      battle.follow = false;
    }
  };
  return { frame, dispose };
}
