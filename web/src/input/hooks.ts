// Hooks the input calls that other parts fill in (day 4): voice listens while the captain is held (06-voice.md §3;
// 01-flow.md §2 "holding the captain still for 400 ms starts voice command"), and M mutes (sound). Set them once at
// start-up: `onCaptainHold((phase) => phase === 'start' ? listen() : stop())`, or assign `inputHooks.onMute`.

export type HoldPhase = 'start' | 'end';

export const inputHooks = {
  /** The captain was held still for 400 ms: 'start'; let go (or a second finger came down): 'end'. Releasing the
   * captain after a hold is never a tap. */
  onCaptainHold(_phase: HoldPhase): void {},
  /** M: mute or unmute. */
  onMute(): void {},
  /** A tap selected one of our companies, or tapped a routing one (01-flow.md §2: "the commander's face card shows on
   * release"; "tapping it shows its face"). The battle's scene shows the card. */
  onCompanyTap(_squad: number): void {},
};

/** Sets the voice hook (the same as assigning `inputHooks.onCaptainHold`). */
export function onCaptainHold(fn: (phase: HoldPhase) => void): void {
  inputHooks.onCaptainHold = fn;
}
