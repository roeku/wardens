import type { BattleView } from '../battle/battle';
import type { View } from '../view/view';
import { BattleInput } from './command';
import { bindKeys } from './keys';
import { PointerInput } from './pointer';
import { Screen } from './screen';

// The battle's input (docs/spec/01-flow.md §2): the pointer state machine on the canvas, what each tap and stroke
// orders, and the keys. Every order goes through `BattleView.issue`.

export { inputHooks, onCaptainHold, type HoldPhase } from './hooks';

export interface Input {
  readonly battle: BattleInput;
  readonly pointer: PointerInput;
  readonly screen: Screen;
  /** Once a frame, before the render: held keys pan, the selection lapses, the stroke's preview updates. */
  frame(dt: number): void;
}

export function installInput(view: View, battle: BattleView): Input {
  const screen = new Screen(view);
  const cmd = new BattleInput(battle, view, screen);
  const pointer = new PointerInput(view.canvas, cmd, (x, y) => screen.local(x, y));
  const keys = bindKeys(view, battle, cmd);
  return {
    battle: cmd,
    pointer,
    screen,
    frame(dt) {
      keys(dt);
      cmd.frame(dt);
    },
  };
}
