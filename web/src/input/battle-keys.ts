import type { BattleView } from '../battle/battle';

// The battle's keys from docs/spec/01-flow.md §2 "Pause and keys" that need no marks: F follows the captain again,
// Space or P pauses (the world greys; the order marks drawn while paused come with day 4), X toggles ×2 speed.

export function bindBattleKeys(battle: BattleView): void {
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'KeyF') battle.follow = true;
    else if (e.code === 'Space' || e.code === 'KeyP') {
      e.preventDefault();
      battle.setPaused(!battle.clock.paused);
    } else if (e.code === 'KeyX') battle.clock.fast = !battle.clock.fast;
  });
}
