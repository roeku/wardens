// Horn calls as plain Web Audio synths (docs/spec/05-sound.md §4 "Horns and signals", "Per-company horn calls";
// 06-voice.md §3), standing in for the day-6 engine's rendered samples. The rhythms, tempos and levels are the
// spec's; the pitches are D and A only (§1 "One tonality"), so a call's order rises and its recall falls.
//
// Each of the five company calls differs from the others in rhythm, register and instrument at once. A commander
// gets the lowest call no other company on the field holds at their first order, and keeps it (by name).

import { audio, sfxBus } from './audio';

export type Instrument = 'horn' | 'trumpet' | 'trombone';
/** One line of a call: Strudel-like steps, e.g. `[a3@2 ~ d4@3]` (`@n` weights a step, `~` rests). */
interface Line {
  seq: string;
  gain?: number;
}
interface Cue {
  instrument: Instrument;
  /** Cycles per second: one bracketed sequence lasts 1/cps seconds. */
  cps: number;
  lines: Line[];
  attack: number;
  release: number;
  gain: number;
  room: number;
  roomSize: number;
  lpf?: number;
}

/** The five company calls: [order, recall]. */
const CALLS: { instrument: Instrument; cps: number; order: string; recall: string }[] = [
  { instrument: 'horn', cps: 1, order: '[a2 d3@3]', recall: '[d3 a2@3]' }, // short, long; low
  { instrument: 'horn', cps: 1, order: '[d3 d3 d3 a3@3]', recall: '[a3 a3 a3 d3@3]' }, // three quick, then a leap
  { instrument: 'horn', cps: 2 / 3, order: '[a3@2 ~ d4@3]', recall: '[d4@2 ~ a3@3]' }, // long, a breath, long; higher
  { instrument: 'trumpet', cps: 1, order: '[a3 d4 a4 d5@4]', recall: '[d5 a4 d4 a3@4]' }, // a quick run, the highest
  { instrument: 'trombone', cps: 2 / 3, order: '[d2@3 a2@3]', recall: '[a2@3 d2@3]' }, // slow and low, a fifth
];
export const CALL_COUNT = CALLS.length;

const COMPANY = (instrument: Instrument, cps: number, seq: string): Cue => ({
  instrument, cps, lines: [{ seq }], attack: 0.04, release: 0.5, gain: 0.9, room: 0.45, roomSize: 3,
});

/** horn_army: two horns in harmony (the lower line on D, not the spec's F, by §1's one tonality). */
const ARMY: Cue = {
  instrument: 'horn', cps: 1, lines: [{ seq: '[d3@2 a3@4]' }, { seq: '[a2@2 d3@4]', gain: 0.6 }], attack: 0.04, release: 0.5, gain: 0.9, room: 0.45, roomSize: 3,
};
/** horn_rally: the captain's call. */
const RALLY: Cue = {
  instrument: 'horn', cps: 1 / 3, lines: [{ seq: '[d3 d3 a3@6]' }, { seq: '[a2 a2 d3@6]', gain: 0.6 }], attack: 0.06, release: 1, gain: 0.9, room: 0.5, roomSize: 4,
};
/** horn_query (06-voice.md §3): refused or unclear. */
const QUERY: Cue = { instrument: 'horn', cps: 1, lines: [{ seq: '[a3 ~ a3@2]' }], attack: 0.04, release: 0.3, gain: 0.7, room: 0.3, roomSize: 2, lpf: 1200 };

/** 05-sound.md §2 "Levels table" (query: 06-voice.md §3). */
export const MIX = { horn: 0.2, army: 0.22, rally: 0.28, query: 0.18 };
/** The trumpet is brighter and the trombone darker than the horn; these keep the five calls about as loud. */
const LOUDNESS: Record<Instrument, number> = { horn: 1, trumpet: 0.62, trombone: 1.25 };
/** Company horns: `across × 0.6`, no distance fade (05-sound.md §2 "Spatial rule"). */
const PAN_HORN = 0.6;

const NOTE: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

function freq(name: string): number {
  const m = /^([a-g])(#|b)?(-?\d)$/.exec(name);
  if (!m) return 0;
  const midi = 12 * (Number(m[3]) + 1) + NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return 440 * 2 ** ((midi - 69) / 12);
}

/** The steps of one bracketed sequence: [start, length] in cycles, and the note (null for a rest). */
function steps(seq: string): { t: number; len: number; f: number | null }[] {
  const toks = seq.replace(/[[\]]/g, '').trim().split(/\s+/);
  const parts = toks.map((tok) => {
    const [n, w] = tok.split('@');
    return { f: n === '~' ? null : freq(n), w: w ? Number(w) : 1 };
  });
  const total = parts.reduce((s, p) => s + p.w, 0);
  let t = 0;
  return parts.map((p) => {
    const out = { t: t / total, len: p.w / total, f: p.f };
    t += p.w;
    return out;
  });
}

/** A short room: decaying noise from a fixed seed (never the same random twice, but the same every run). */
const rooms = new Map<number, AudioBuffer>();
function roomImpulse(ac: AudioContext, size: number): AudioBuffer {
  const key = Math.round(size * 10);
  const hit = rooms.get(key);
  if (hit) return hit;
  const seconds = 0.35 + size * 0.4;
  const n = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(2, n, ac.sampleRate);
  let s = 0x9e3779b9 ^ key;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] = rnd() * (1 - i / n) ** 2.6;
  }
  rooms.set(key, buf);
  return buf;
}

/** One note of an instrument into `out`, from `t0` for `len` seconds plus the release. */
function voice(ac: AudioContext, out: AudioNode, inst: Instrument, f: number, t0: number, len: number, cue: Cue, gain: number): void {
  const env = ac.createGain();
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.8;
  const bright = inst === 'trumpet' ? 3.2 : inst === 'trombone' ? 1.6 : 2.2;
  const cut = Math.min(cue.lpf ?? 20000, f * bright + (inst === 'trumpet' ? 1400 : 500));
  lp.frequency.setValueAtTime(cut * 0.55, t0);
  lp.frequency.linearRampToValueAtTime(cut, t0 + cue.attack + 0.06);
  const oscs: OscillatorNode[] = [];
  const add = (type: OscillatorType, detune: number, g: number) => {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.detune.value = detune;
    const og = ac.createGain();
    og.gain.value = g;
    o.connect(og).connect(lp);
    oscs.push(o);
  };
  add('sawtooth', -5, 0.5);
  add('sawtooth', 5, 0.5);
  if (inst === 'trumpet') add('square', 0, 0.25);
  if (inst !== 'trumpet') add('triangle', -1200, 0.35);
  // a slow vibrato that comes in after the attack
  const lfo = ac.createOscillator();
  lfo.frequency.value = 5;
  const depth = ac.createGain();
  depth.gain.setValueAtTime(0, t0);
  depth.gain.linearRampToValueAtTime(f * 0.004, t0 + Math.min(len, 0.35));
  lfo.connect(depth);
  for (const o of oscs) depth.connect(o.frequency);
  const end = t0 + len;
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(gain, t0 + cue.attack);
  env.gain.setValueAtTime(gain, end);
  env.gain.setTargetAtTime(0, end, cue.release / 4);
  lp.connect(env).connect(out);
  const stop = end + cue.release * 1.5;
  for (const o of [...oscs, lfo]) {
    o.start(t0);
    o.stop(stop);
  }
}

/** Plays a cue at `level` (the mix), panned by `pan` (−1..1), `delay` seconds from now. */
function play(cue: Cue, level: number, pan = 0, delay = 0): void {
  const ac = audio();
  const t0 = ac.currentTime + 0.02 + delay;
  const panner = ac.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  // every note into one bus, heard dry and through the room
  const bus = ac.createGain();
  const wet = ac.createGain();
  wet.gain.value = cue.room;
  const conv = ac.createConvolver();
  conv.buffer = roomImpulse(ac, cue.roomSize);
  bus.connect(panner);
  bus.connect(wet).connect(conv).connect(panner);
  panner.connect(sfxBus());
  const cycle = 1 / cue.cps;
  const amp = cue.gain * level * LOUDNESS[cue.instrument];
  for (const line of cue.lines) {
    for (const s of steps(line.seq)) {
      if (s.f === null) continue;
      const at = t0 + s.t * cycle;
      voice(ac, bus, cue.instrument, s.f, at, s.len * cycle, cue, amp * (line.gain ?? 1) * 0.5);
    }
  }
}

/** Where the ear is: the camera's focus in tiles, and half the screen's width in tiles. */
export interface Ear {
  x: number;
  y: number;
  half: number;
}

/** 05-sound.md §2 "Spatial rule": across the screen, whose right is the ground vector (1,1). */
export function across(x: number, y: number, ear: Ear): number {
  return Math.max(-1, Math.min(1, (x - ear.x + (y - ear.y)) / Math.SQRT2 / Math.max(1, ear.half)));
}

const STORE = 'wardens.horns';
function loadCalls(): Map<string, number> {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, number>));
  } catch {
    return new Map();
  }
}
const calls = loadCalls();

/**
 * The call a commander answers with: the one they already hold, unless another company on the field (`active`) holds
 * it too, else the lowest call none of the active companies holds. Kept by name across battles.
 */
export function callFor(name: string, active: string[]): number {
  const held = (n: number) => active.some((a) => a !== name && calls.get(a) === n);
  let c = calls.get(name);
  if (c === undefined || held(c)) {
    c = 0;
    while (c < CALL_COUNT - 1 && held(c)) c++;
    calls.set(name, c);
    try {
      localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(calls)));
    } catch {
      // no storage: the calls still hold for this battle
    }
  }
  return c;
}

/** A company's call: its order (rising) or recall (falling), panned from where it stands. */
export function companyHorn(call: number, recall: boolean, x: number, y: number, ear: Ear, delay = 0): void {
  const c = CALLS[call % CALL_COUNT];
  play(COMPANY(c.instrument, c.cps, recall ? c.recall : c.order), MIX.horn, across(x, y, ear) * PAN_HORN, delay);
}

/** An order to the whole army (not positioned). */
export function armyHorn(delay = 0): void {
  play(ARMY, MIX.army, 0, delay);
}

/** The rally (not positioned). */
export function rallyHorn(delay = 0): void {
  play(RALLY, MIX.rally, 0, delay);
}

/** Refused or unclear (not positioned). */
export function queryHorn(delay = 0): void {
  play(QUERY, MIX.query, 0, delay);
}
