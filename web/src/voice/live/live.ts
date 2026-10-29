// Voice in the live battle (docs/spec/06-voice.md §1–§3, §7; 08-orders.md §9). Hold V (or hold the captain still
// for 400 ms, through the input layer's `onCaptainHold`): time runs at ×0.3, a dithered ring pulses at the
// captain's feet with the mic level, the brain reads the field while the captain speaks. On release: speech-to-text,
// normalise, the fast path, the brain, resolution in code, and the deeds go into the order queue at the tick they
// arrive. Each addressed company answers with its own horn from where it stands; the army with horn_army; a refusal
// or unclear words with a red cross and the query horn. Enter opens a typed line that takes the same path without
// speech-to-text. The voice's own state (named groups, orders waiting for a signal) is kept here and given to the
// brain with the field. No words on the field: marks, horns and movement answer.

import type { BattleView } from '../../battle/battle';
import type { Deed, P, Source } from '../../contracts';
import { armyHorn, callFor, companyHorn, queryHorn, rallyHorn, type Ear } from '../../sound/horns';
import { inputHooks, onCaptainHold, type HoldPhase } from '../../input/hooks';
import { bindUnlock } from '../../sound/audio';
import { MARK, type Pen } from '../../view/marks';
import { brainLock } from '../brain';
import { broodlordFromUrl } from '../broodlord';
import { stateText, type Field, type FieldGroup, type FieldWaiting } from '../field';
import { understand, type Understood } from '../pipeline';
import type { Resolved } from '../resolve';
import { Mic, readWav, levelOf } from './mic';
import { ABANDON_MS, Brains, NoBrain, transcribe, warmStt, type BrainChoice, type Heard } from './serve';
import { TypedLine } from './typed';

/** 06-voice.md §3: after release, time stays slow until the orders land, for at most this long. */
const SLOW_AFTER_MS = 3000;
/** Each addressed company's horn answers this long after the one before, so the calls can be told apart. */
const HORN_STAGGER_S = 0.35;
/** Speech-to-text gets this long before the order is given up. */
const STT_TIMEOUT_MS = 8000;
/** The listening ring (06-voice.md §3): its radius at silence, how much the voice widens it, its width and pulse. */
const LISTEN_R = 0.8;
const LISTEN_GROW = 1.6;
const LISTEN_W = 0.14;
const LISTEN_PULSE = 0.06;
/** Foe words for the speech-to-text prompt, besides the field's names. */
const PROMPT_WORDS = ['riders', 'archers', 'spears', 'shields', 'blight-men', 'trolls', 'drakes', 'broodlord'];

/** The sim's waiting deed as `voice_field` lists it. */
interface Pending {
  squad: number;
  when: { on: string; n?: number };
  queued: number;
}
/** The live field: the voice Field plus the sim's waiting deeds and the tick. */
type LiveField = Field & { pending: Pending[]; tick: number };

/** An order waiting for a signal, as the voice keeps it (the field shows `who`, `what` and `n`). */
interface Waiting extends FieldWaiting {
  queued: number;
  squads: number[];
}

/** One utterance, start to end: what was heard, what came of it, and how long each step took (ms). */
export interface Utterance {
  src: Source;
  said: string;
  heard: string;
  path: string;
  brain: string;
  reply: unknown;
  deeds: Deed[];
  refused: { why: string }[];
  unclear: boolean;
  tick: number;
  stt?: number;
  sttEngine?: string;
  brainMs?: number;
  /** New prompt tokens the brain read, and tokens it wrote. */
  tokens?: { read: number; written: number };
  /** From release (or Enter) to the marks on the field. */
  e2e: number;
  error?: string;
  /** The field as the brain read it (06-voice.md §4b), for judging the order afterwards. */
  field?: string;
}

/** One voice order in the log (06-voice.md §7): replays use only `deed`. */
export interface VoiceLogEntry {
  tick: number;
  team: 0;
  deed: Deed;
  src: Source;
  heard: string;
  reply: unknown;
  brain: string;
  ms: number;
}

type Hold = { field: LiveField; source: string; level?: () => number; started: number };

export class Voice {
  readonly log: VoiceLogEntry[] = [];
  readonly utterances: Utterance[] = [];
  groups: FieldGroup[] = [];
  waiting: Waiting[] = [];
  readonly brains: Brains;
  readonly mic = new Mic();
  readonly typed: TypedLine;
  private hold: Hold | null = null;
  /** Orders on their way (released, not landed): when each was released. */
  private inflight = new Map<number, number>();
  private nextRun = 0;
  /** A field read when the typed line opened (the brain reads it while the captain types). */
  private typedField: LiveField | null = null;
  /** The voice's claim on the brain while the captain holds (the broodlord gives way, brain.ts `brainLock`). */
  private claim: (() => void) | null = null;
  /** Taken off the battle: no more holds, runs or drawing. */
  disposed = false;
  private readonly ring = (pen: Pen) => {
    const cap = this.hold ? this.play.captain() : null;
    if (!cap) return;
    const level = this.hold?.level ? this.hold.level() : this.mic.level;
    const pulse = LISTEN_PULSE * Math.sin((performance.now() / 1000) * 7);
    pen.ring(cap, LISTEN_R + LISTEN_GROW * level + pulse, { colour: MARK.gold, width: LISTEN_W, alpha: 0.55 + 0.45 * level });
  };

  constructor(
    readonly play: BattleView,
    opts: { brain: BrainChoice; abandonMs: number; typed: boolean },
  ) {
    this.brains = new Brains(opts.brain, opts.abandonMs);
    // the listening ring: a mark on the field, drawn with the battle's own marks (02-look.md §7)
    play.marks.drawers.push(this.ring);
    this.typed = new TypedLine(
      play.view,
      {
        open: () => {
          this.typedField = this.field();
          void this.brains.warm(this.typedField);
        },
        submit: (text) => void this.run({ text, src: 'typed', field: this.typedField ?? this.field(), released: performance.now() }),
        close: () => {},
      },
      opts.typed,
    );
  }

  // ------------------------------------------------------------------------------------------- the field

  /** The field as the player sees it now, with the voice's groups and the orders still waiting for a signal. */
  field(): LiveField {
    const f = JSON.parse(this.play.sim.voice_field()) as LiveField;
    // drop waiting orders the sim no longer holds (released by a signal, or cleared by a direct order)
    this.waiting = this.waiting.filter((w) =>
      f.pending.some((p) => p.queued === w.queued && p.when.on === 'signal' && p.when.n === w.n && (p.squad < 0 || w.squads.includes(p.squad) || !w.squads.length)),
    );
    // a group whose companies are all gone is forgotten
    const names = new Set(f.ours.map((c) => c.name));
    this.groups = this.groups.filter((g) => g.members.some((m) => names.has(m)));
    f.groups = this.groups.map((g) => ({ name: g.name, members: g.members.filter((m) => names.has(m)) }));
    f.waiting = this.waiting.map(({ who, what, n }) => ({ who, what, n }));
    return f;
  }

  /** The names the recogniser should expect: companies, groups, places, ground, works, foe kinds. */
  names(f: Field): string[] {
    const spots = [...f.places.map((p) => p.name), ...f.ground.map((g) => g.name), ...(f.works ?? []).map((w) => w.name)];
    const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
    return [...new Set([...f.ours.map((c) => c.name), ...(f.groups ?? []).map((g) => g.name), ...spots].map(title)), ...PROMPT_WORDS];
  }

  // ------------------------------------------------------------------------------------------- holding

  get listening(): boolean {
    return this.hold !== null;
  }

  /** The captain starts to speak: slow time, the ring, the mic (unless a file stands in), warm the ears and brain.
   * The broodlord's brain call, if one is running, gives way. */
  begin(source: string, level?: () => number): boolean {
    if (this.hold || this.typed.isOpen || this.disposed) return false;
    this.claim?.();
    this.claim = brainLock.claim();
    const field = this.field();
    this.hold = { field, source, level, started: performance.now() };
    warmStt();
    void this.brains.warm(field);
    if (!level) {
      this.mic.start().catch((e) => {
        console.warn('[voice] no microphone:', e instanceof Error ? e.message : e);
        this.hold = null;
        this.unclaim();
        this.refuse(null, 'no microphone');
      });
    }
    return true;
  }

  private unclaim(): void {
    this.claim?.();
    this.claim = null;
  }

  /** The captain stops speaking: the hold's audio goes down the release path. `audio` stands in for the mic. */
  async end(audio?: Blob): Promise<Utterance | null> {
    const hold = this.hold;
    if (!hold) return null;
    this.hold = null;
    const released = performance.now();
    try {
      const wav = audio ?? (await this.mic.stop());
      if (!wav) {
        this.refuse(null, 'nothing heard');
        return null;
      }
      return await this.run({ audio: wav, src: 'voice', field: hold.field, released });
    } finally {
      if (!this.hold) this.unclaim();
    }
  }

  /** Lets go of a hold without giving an order (the hold turned into something else). */
  cancel(): void {
    if (!this.hold) return;
    this.hold = null;
    this.unclaim();
    void this.mic.stop();
  }

  /** Takes voice off this battle (the scene ends): the ring, the typed line, the hold and the brain's claim. */
  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.typed.dispose();
    const i = this.play.marks.drawers.indexOf(this.ring);
    if (i >= 0) this.play.marks.drawers.splice(i, 1);
    this.unclaim();
  }

  // ------------------------------------------------------------------------------------------- the release path

  /** Words (spoken or typed) → orders on the field. */
  async run(input: { audio?: Blob; text?: string; src: Source; field: LiveField; released: number }): Promise<Utterance> {
    const { field, src, released } = input;
    const key = this.nextRun++;
    this.inflight.set(key, released);
    // the broodlord gives way once the words need the brain (not for the fast path), until they have landed
    const claim: { release?: () => void } = {};
    const u: Utterance = { src, said: input.text ?? '', heard: '', path: '', brain: '', reply: null, deeds: [], refused: [], unclear: false, tick: 0, e2e: 0, field: stateText(field) };
    try {
      if (input.audio) {
        let heard: Heard;
        try {
          heard = await withTimeout(transcribe(input.audio, this.names(field)), STT_TIMEOUT_MS, 'speech-to-text');
        } catch (e) {
          u.error = e instanceof Error ? e.message : String(e);
          this.unclear(field, u, released);
          return u;
        }
        u.said = heard.text;
        u.stt = heard.ms;
        u.sttEngine = heard.engine;
      }
      let brainMs: number | undefined;
      let brain = 'fast';
      let understood: Understood;
      try {
        understood = await understand(field, u.said, this.brains.choice === 'off' ? undefined : async (heard) => {
          claim.release ??= brainLock.claim();
          const a = await this.brains.ask(field, heard);
          brainMs = a.ms;
          brain = a.brain;
          u.tokens = { read: a.promptTokens ?? 0, written: a.genTokens ?? 0 };
          return a;
        });
      } catch (e) {
        u.error = e instanceof Error ? e.message : String(e);
        u.brain = e instanceof NoBrain ? (e.abandoned ? 'abandoned' : 'none') : 'error';
        u.heard = u.said;
        this.unclear(field, u, released);
        return u;
      }
      u.heard = understood.heard;
      u.path = understood.path;
      u.brain = understood.path === 'brain' ? (this.brains.choice === 'off' ? 'off' : brain) : understood.path;
      u.brainMs = brainMs;
      u.reply = understood.brain?.raw ?? understood.reply.orders;
      if (understood.path === 'pause') {
        this.play.setPaused(!this.play.clock.paused);
        u.e2e = performance.now() - released;
        this.record(u);
        return u;
      }
      this.land(field, understood, u, released);
      return u;
    } finally {
      claim.release?.();
      this.inflight.delete(key);
    }
  }

  /** The orders land: into the queue, onto the field as marks, and into the air as horns. */
  private land(field: LiveField, understood: Understood, u: Utterance, released: number): void {
    const r = understood.resolution;
    const deeds = r.deeds;
    u.deeds = deeds;
    u.refused = r.refused.map((x) => ({ why: x.why }));
    u.unclear = understood.reply.unclear && !r.orders.length && !r.refused.length;
    // each deed through the battle's one way in, so it shows exactly as a tap or a drag would (BattleView.issue)
    u.tick = this.play.sim.tick();
    let simRefused = 0;
    for (const deed of deeds) if (this.play.issue(deed, u.src).refused) simRefused++;
    this.groups = r.groups;
    this.remember(r.orders, u.tick, field);
    const marks = this.play.marks;
    // a group named has no deed: its companies answer with a ping
    for (const o of r.orders) {
      if (o.group) for (const name of o.group.members) this.pingCompany(name);
    }
    // horns: the army's, the rally's, or each addressed company's own call from where it stands
    const ear = this.ear();
    const active = field.ours.map((c) => c.name);
    let delay = 0;
    for (const o of r.orders) {
      if (o.do === 'rally') rallyHorn(delay);
      else if (o.who === 'ARMY' || o.do === 'signal') armyHorn(delay);
      else {
        for (const name of o.who) {
          const at = this.companyAt(name, field);
          if (!at) continue;
          companyHorn(callFor(name, active), o.do === 'recall', at.x, at.y, ear, delay);
          delay += HORN_STAGGER_S;
        }
        continue;
      }
      delay += HORN_STAGGER_S;
    }
    // refused in code: a red cross at the target if one was understood, else at the captain (the sim's own
    // refusals are crossed by the battle where it refused them)
    for (const x of r.refused) marks.cross(this.pointOf(x.order.to ?? x.order.target, field) ?? this.captainAt(field));
    if (u.unclear) marks.cross(this.captainAt(field));
    if (r.refused.length || u.unclear || simRefused) queryHorn(delay);
    u.refused.push(...Array.from({ length: simRefused }, () => ({ why: 'refused by the sim' })));
    u.e2e = performance.now() - released;
    this.record(u);
  }

  /** Not understood at all: a red cross at the captain and the query horn. */
  private unclear(field: LiveField, u: Utterance, released: number): void {
    u.unclear = true;
    u.tick = this.play.sim.tick();
    this.play.marks.cross(this.captainAt(field));
    queryHorn();
    u.e2e = performance.now() - released;
    this.record(u);
  }

  private refuse(at: P | null, why: string): void {
    console.warn(`[voice] ${why}`);
    const cap = this.play.captain();
    this.play.marks.cross(at ?? (cap ? { x: cap.x, y: cap.y } : { x: 0, y: 0 }));
    queryHorn();
  }

  /** Keeps the orders that wait for a signal, so "now" and "hammer, go" find them (D-17). */
  private remember(orders: Resolved[], tick: number, field: Field): void {
    for (const o of orders) {
      for (const a of o.acts) {
        if (a.when?.on !== 'signal' || !a.deed) continue;
        const squads = a.who === 'ARMY' ? [] : field.ours.filter((c) => c.name === a.who).map((c) => c.id);
        const what = [a.do, a.target].filter(Boolean).join(' ') + ' on mark';
        const n = a.when.n;
        const who = o.said.who;
        const same = this.waiting.find((w) => w.queued === tick && w.n === n && w.what === what && w.who.join() === who.join());
        if (same) same.squads.push(...squads);
        else this.waiting.push({ who, what, n, queued: tick, squads });
      }
    }
  }

  private record(u: Utterance): void {
    u.e2e = Math.round(u.e2e);
    this.utterances.push(u);
    for (const deed of u.deeds) {
      this.log.push({ tick: u.tick, team: 0, deed, src: u.src, heard: u.heard, reply: u.reply, brain: u.brain, ms: u.e2e });
    }
    const line = { ...u, deeds: u.deeds.length };
    console.log(`[voice] ${u.src} "${u.said}" → ${u.path || 'none'}/${u.brain} ${u.deeds.length} deeds${u.refused.length ? `, ${u.refused.length} refused` : ''}${u.unclear ? ', unclear' : ''}; stt ${u.stt ? Math.round(u.stt) : '-'} brain ${u.brainMs ? Math.round(u.brainMs) : '-'} e2e ${u.e2e} ms`);
    if (import.meta.env.DEV) {
      fetch('/__voicelog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ utterance: line, log: this.log.slice(-u.deeds.length || this.log.length) }) }).catch(() => {});
    }
  }

  // ------------------------------------------------------------------------------------------- marks

  /** A ping where a company stands now (it was named into a group). */
  private pingCompany(name: string): void {
    const c = this.companyAt(name, null);
    if (c) this.play.marks.ping(c, MARK.cream);
  }

  /** A company's middle now (its men as drawn), else where the field had it. */
  private companyAt(name: string, f: Field | null): P | null {
    const c = (f ?? this.field()).ours.find((x) => x.name === name);
    if (!c) return null;
    return this.play.squadCentre(c.id) ?? { x: c.x, y: c.y };
  }

  /** Where a named thing stands in the field: a company, foe, place, feature or work. */
  private pointOf(name: string | undefined, f: Field): P | null {
    if (!name) return null;
    const c = f.ours.find((x) => x.name === name);
    if (c) return { x: c.x, y: c.y };
    const e = f.foesSeen.find((x) => x.id === name);
    if (e) return { x: e.x, y: e.y };
    const p = f.places.find((x) => x.name === name);
    if (p) return { x: p.x, y: p.y };
    const w = f.works?.find((x) => x.name === name);
    if (w) return { x: w.x, y: w.y };
    const g = f.ground.find((x) => x.name === name);
    if (g?.type === 'hill' || g?.type === 'narrows') return { x: g.x, y: g.y };
    if (g?.type === 'wood') return { x: (g.x0 + g.x1 + 1) / 2, y: (g.y0 + g.y1 + 1) / 2 };
    return null;
  }

  private captainAt(f: Field): P {
    const cap = this.play.captain();
    return cap ? { x: cap.x, y: cap.y } : { x: f.captain.x, y: f.captain.y };
  }

  /** The ear: the camera's focus and half the screen's width, in tiles (05-sound.md §2). */
  private ear(): Ear {
    const cam = this.play.view.camera;
    return { x: cam.focus.x, y: cam.focus.y, half: this.play.view.renderer.size.aw / 2 / cam.s };
  }

  // ------------------------------------------------------------------------------------------- every frame

  /** Called just before every draw: the clock and the typed line. */
  frame(): void {
    if (this.disposed) return;
    const released = [...this.inflight.values()].some((t) => performance.now() - t < SLOW_AFTER_MS);
    this.play.clock.listening = this.hold !== null || this.typed.isOpen || released;
    this.typed.draw();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error(`${what} took over ${ms} ms`)), ms))]);
}

/**
 * Puts voice into the live battle: V to talk, Enter to type, the captain hold, and the dev hooks. Returns the voice,
 * whose `dispose()` takes it all off again (the scene ends; the next battle installs its own). With
 * `?broodlord=<way>`, the broodlord's mind comes with it on a battle whose scene gives no foe (the dev path).
 */
export function installVoice(play: BattleView): Voice {
  const params = new URLSearchParams(location.search);
  const brain = (params.get('brain') ?? 'local') as BrainChoice;
  const voice = new Voice(play, {
    brain: ['local', 'hosted', 'off'].includes(brain) ? brain : 'local',
    abandonMs: params.has('brainms') ? Number(params.get('brainms')) : ABANDON_MS,
    typed: params.get('typed') !== '0',
  });
  bindUnlock();
  const prev = play.view.beforeDraw;
  const draw = () => {
    prev?.();
    voice.frame();
  };
  play.view.beforeDraw = draw;
  const down = (e: KeyboardEvent) => {
    if (e.code === 'KeyV' && !e.repeat && !e.metaKey && !e.ctrlKey) voice.begin('key');
  };
  const up = (e: KeyboardEvent) => {
    if (e.code === 'KeyV') void voice.end();
  };
  const blur = () => void voice.end();
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', blur);
  // the input layer's 400 ms still-press on the captain (01-flow.md §2)
  const hold = (phase: HoldPhase) => (phase === 'start' ? voice.begin('captain') : void voice.end());
  onCaptainHold(hold);
  // the brain reads the rules and the field once the battle is on screen, so the first order is not the slow one (a
  // tab in the background never does: it would push the playing tab's field out of the voice slot)
  const warmIfSeen = () => {
    if (document.visibilityState === 'visible' && !voice.disposed) void voice.brains.warm(voice.field());
  };
  warmIfSeen();
  document.addEventListener('visibilitychange', warmIfSeen);
  if (import.meta.env.DEV) installVoiceDev(voice);
  const brood = broodlordFromUrl(play);
  const dispose = voice.dispose.bind(voice);
  voice.dispose = () => {
    if (voice.disposed) return;
    dispose();
    brood?.dispose();
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
    window.removeEventListener('blur', blur);
    document.removeEventListener('visibilitychange', warmIfSeen);
    if (inputHooks.onCaptainHold === hold) inputHooks.onCaptainHold = () => {};
    // the draw hook goes back to what it was, unless another part has wrapped it since (then `frame` is a no-op)
    if (play.view.beforeDraw === draw) play.view.beforeDraw = prev;
  };
  return voice;
}

/** `__v.voice*`: feed a WAV or words through the release path, read the field and the log. */
function installVoiceDev(voice: Voice): void {
  const hooks = {
    voice,
    /** The live field and its text as the brain reads it. */
    voiceField(): { field: Field; text: string } {
      const f = voice.field();
      return { field: f, text: stateText(f) };
    },
    /**
     * Plays a 16 kHz WAV through exactly the release path, as if the captain held V while saying it: the hold
     * starts (slow time, the ring scaled by the clip's level, the warm-up), lasts the clip's length (or `holdMs`),
     * then releases with the clip as the mic's audio.
     */
    async voiceFile(url: string, opts: { holdMs?: number } = {}): Promise<Utterance | null> {
      const buf = await (await fetch(url)).arrayBuffer();
      const { pcm, rate } = readWav(buf);
      const seconds = pcm.length / rate;
      const t0 = performance.now();
      const level = () => {
        const i = Math.floor(((performance.now() - t0) / 1000) * rate);
        let sq = 0;
        const n = Math.min(pcm.length, i + 1024) - i;
        for (let k = 0; k < n; k++) sq += pcm[i + k] ** 2;
        return n > 0 ? levelOf(Math.sqrt(sq / n)) : 0;
      };
      if (!voice.begin('file', level)) return null;
      await new Promise((ok) => setTimeout(ok, opts.holdMs ?? seconds * 1000));
      return voice.end(new Blob([buf], { type: 'audio/wav' }));
    },
    /** Words through the typed path (or `src` 'voice' to log them as spoken), as the typed line gives them: the field
     * is read into the brain first, as it is while the captain types (`{cold: true}` skips that). */
    async voiceText(text: string, src: Source = 'typed', opts: { cold?: boolean } = {}): Promise<Utterance> {
      const field = voice.field();
      if (!opts.cold && voice.brains.choice !== 'off') {
        const release = brainLock.claim();
        try {
          await voice.brains.warm(field);
        } finally {
          release();
        }
      }
      return voice.run({ text, src, field, released: performance.now() });
    },
    /** Starts or ends a hold by hand (the real mic). */
    voiceHold(on = true): Promise<Utterance | null> | boolean {
      return on ? voice.begin('dev') : voice.end();
    },
    voiceLog(): { utterances: Utterance[]; log: VoiceLogEntry[] } {
      return { utterances: voice.utterances, log: voice.log };
    },
    /** Like `__v.shot`, with the typed line drawn in where it stands: out/shots/<name>.png. */
    async voiceShot(name: string): Promise<string> {
      const view = voice.play.view;
      view.render();
      const gl = view.canvas;
      const out = document.createElement('canvas');
      out.width = gl.width;
      out.height = gl.height;
      const c = out.getContext('2d')!;
      c.imageSmoothingEnabled = false;
      c.drawImage(gl, 0, 0);
      const line = voice.typed.canvas;
      if (voice.typed.isOpen) {
        voice.typed.draw();
        const k = gl.width / view.renderer.size.aw;
        c.drawImage(line, 0, gl.height - line.height * k, line.width * k, line.height * k);
      }
      const blob = await new Promise<Blob | null>((ok) => out.toBlob(ok, 'image/png'));
      if (!blob) throw new Error('no frame');
      const res = await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
      return ((await res.json()) as { path: string }).path;
    },
  };
  const w = window as unknown as { __v?: Record<string, unknown> };
  w.__v = Object.assign(w.__v ?? {}, hooks);
}
