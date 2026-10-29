import { audio, sfxBus } from '../sound/audio';
import { hash32 } from '../view/figures/hash';

// The screens' few sounds, as plain Web Audio until the day-6 engine (05-sound.md): the muster's thud when a
// commander is planted (01-flow.md §3.4: "a 0.09 s thud and dust"), and the camp's cheer when a company is honoured
// (§3.8: "its commander steps out to a horn and a cheer"; the horn is horns.ts's). Noise from hash32, never
// Math.random, so a render is the same every time.

let noise: AudioBuffer | null = null;

function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noise && noise.sampleRate === ctx.sampleRate) return noise;
  const n = Math.floor(ctx.sampleRate * 1.5);
  noise = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = hash32(i, 3, 0x7e1) / 2147483648 - 1;
  return noise;
}

/** The thud of a planted commander: a low knock and a puff of dust, 0.09 s. */
export function thud(level = 0.5): void {
  try {
    const ctx = audio();
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    g.connect(sfxBus());
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.09);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.2);
    const n = ctx.createBufferSource();
    n.buffer = noiseBuffer(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 600;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(level * 0.4, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    n.connect(lp).connect(ng).connect(sfxBus());
    n.start(t, 0, 0.12);
  } catch {
    // no audio: the dust still shows
  }
}

/** A company's cheer: a rising swell of band-passed voices, about a second. */
export function cheer(level = 0.35, delay = 0): void {
  try {
    const ctx = audio();
    const t = ctx.currentTime + delay;
    for (let k = 0; k < 3; k++) {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 3;
      bp.frequency.setValueAtTime(500 + k * 260, t);
      bp.frequency.linearRampToValueAtTime(700 + k * 300, t + 0.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level / 3, t + 0.15 + k * 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      n.connect(bp).connect(g).connect(sfxBus());
      n.start(t, k * 0.3, 1.2);
    }
  } catch {
    // no audio
  }
}
