// The shared AudioContext and the master and sfx buses of docs/spec/05-sound.md §2, in their simplest form until
// the day-6 engine replaces them. The context is made and resumed by `unlock()`, called on the player's first key or
// press (the capture phase), so it is never made under the finger of a frame that has not been drawn.

/** 05-sound.md §2 "Levels table": master, and the sfx bus. */
export const MASTER = 0.9;
export const SFX_BUS = 0.85;

let ctx: AudioContext | null = null;
let sfx: GainNode | null = null;

/** The context, made on first use; resumes it if the browser suspended it. */
export function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = MASTER;
    master.connect(ctx.destination);
    sfx = ctx.createGain();
    sfx.gain.value = SFX_BUS;
    sfx.connect(master);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** The sfx bus, where horns go. */
export function sfxBus(): GainNode {
  audio();
  return sfx!;
}

let bound = false;

/** Makes or wakes the context on every key and press, in the capture phase (05-sound.md §2 "Unlock"). */
export function bindUnlock(): void {
  if (bound) return;
  bound = true;
  const unlock = () => audio();
  for (const t of ['pointerdown', 'pointerup', 'keydown'] as const) window.addEventListener(t, unlock, { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) void ctx.suspend();
    else void ctx.resume();
  });
}
