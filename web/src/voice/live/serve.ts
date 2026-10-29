// The game's ears and brain through the dev server (docs/spec/06-voice.md §2): `/stt` transcribes a WAV, `/brain`
// is the local llama-server and `/brain-hosted` the hosted copy, both proxied so no key reaches the browser.
// `?brain=local|hosted|off` picks where the chain starts: local, then hosted, then the fast path only. A brain
// request that takes longer than the abandon time (2.5 s) is given up: the player hears the query horn and can
// repeat, or tap.

import { ask, warm, type BrainOpts } from '../brain';
import { stateText, type Field } from '../field';
import type { BrainAnswer } from '../pipeline';

export type BrainName = 'local' | 'hosted';
export type BrainChoice = BrainName | 'off';

/** 06-voice.md §2: a request that takes longer than this is abandoned. */
export const ABANDON_MS = 2500;
/** A brain that failed (not one that was slow) is skipped for this long before it is tried again. */
const DOWN_MS = 15_000;
/** Reading the field at hold start may take longer than an order (a cold prefix): it runs in the background. */
const WARM_MS = 30_000;
/** An order waits at most this long for a warm-up still reading the field. */
const WARM_WAIT_MS = 4000;

const PATHS: Record<BrainName, string> = { local: '/brain', hosted: '/brain-hosted' };

/** Thrown when every brain in the chain was down or too slow. */
export class NoBrain extends Error {
  constructor(
    message: string,
    readonly abandoned: boolean,
    readonly tried: string[],
  ) {
    super(message);
  }
}

export interface Answer extends BrainAnswer {
  brain: BrainName;
}

export class Brains {
  private down = new Map<BrainName, number>();
  /** The last request sent to the voice slot. Requests never overlap on the slot: llama-server (with the drafter)
   * aborts on a second request for a slot that is still reading a prompt (GGML_ASSERT batch.size() > 0). */
  private tail: Promise<unknown> = Promise.resolve();
  private idle = true;
  /** What the slot holds: the brain and the field text it last read. */
  private warmed = '';

  constructor(
    readonly choice: BrainChoice,
    readonly abandonMs = ABANDON_MS,
  ) {}

  /** The brains to try, in order, skipping any that failed lately. */
  chain(): BrainName[] {
    const all: BrainName[] = this.choice === 'off' ? [] : this.choice === 'hosted' ? ['hosted'] : ['local', 'hosted'];
    const t = performance.now();
    return all.filter((b) => (this.down.get(b) ?? 0) <= t);
  }

  opts(b: BrainName, timeoutMs = this.abandonMs): BrainOpts {
    return { url: location.origin + PATHS[b], mode: 'prefill', temperature: 0, slot: 0, timeoutMs };
  }

  /** Runs `f` after every request before it has finished. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    this.idle = false;
    const run = this.tail.then(f, f);
    const done = run.then(
      () => {},
      () => {},
    );
    this.tail = done;
    void done.then(() => {
      if (this.tail === done) this.idle = true;
    });
    return run;
  }

  /**
   * Reads the field into the first live brain's cache while the captain is still speaking (D-07, D-17). Skipped when
   * the slot already holds this very field, or another read is still running (the order will wait for that one).
   */
  warm(field: Field): Promise<void> {
    const b = this.chain()[0];
    if (!b) return Promise.resolve();
    const key = `${b}|${stateText(field)}`;
    if (key === this.warmed || !this.idle) return Promise.resolve();
    this.warmed = key;
    return this.serial(() => warm(this.opts(b, WARM_MS), field)).catch((e) => {
      this.warmed = '';
      if (!isTimeout(e)) this.down.set(b, performance.now() + DOWN_MS);
    });
  }

  /**
   * The brain's reply to the words: the first brain of the chain that answers. A brain that is down is skipped for
   * the next; one that is too slow is abandoned, and so is the order (the query horn), without trying the next. An
   * order waits for a read of the field still running, for at most WARM_WAIT_MS.
   */
  async ask(field: Field, heard: string): Promise<Answer> {
    if (!this.idle) {
      const waited = await Promise.race([this.tail.then(() => true), new Promise<boolean>((ok) => setTimeout(() => ok(false), WARM_WAIT_MS))]);
      if (!waited) throw new NoBrain(`the brain was still reading the field after ${WARM_WAIT_MS} ms: abandoned`, true, []);
    }
    const tried: string[] = [];
    for (const b of this.chain()) {
      tried.push(b);
      const t0 = performance.now();
      try {
        const r = await this.serial(() => ask(this.opts(b), field, heard));
        this.warmed = `${b}|${stateText(field)}`;
        return { ...r, from: 'live', brain: b, ms: performance.now() - t0 };
      } catch (e) {
        if (isTimeout(e)) throw new NoBrain(`${b} brain took over ${this.abandonMs} ms: abandoned`, true, tried);
        console.warn(`[voice] ${b} brain failed:`, e instanceof Error ? e.message : e);
        this.down.set(b, performance.now() + DOWN_MS);
      }
    }
    throw new NoBrain(tried.length ? `no brain answered (${tried.join(', ')})` : 'no brain (fast path only)', false, tried);
  }
}

function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

export interface Heard {
  text: string;
  ms: number;
  engine: string;
}

/** Starts the speech-to-text engine if it sleeps (called when the hold starts, so it is ready on release). */
export function warmStt(): void {
  fetch('/stt/warm', { method: 'POST' }).catch(() => {});
}

/** The words in a 16 kHz WAV, with the field's names as the recogniser's prompt (06-voice.md §2). */
export async function transcribe(audio: Blob, names: string[]): Promise<Heard> {
  const t0 = performance.now();
  const prompt = names.join(', ');
  const res = await fetch(`/stt?prompt=${encodeURIComponent(prompt)}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: audio });
  if (!res.ok) throw new Error(`stt: ${res.status} ${await res.text()}`);
  const r = (await res.json()) as { text: string; engine: string; ms?: number };
  return { text: r.text.trim(), ms: performance.now() - t0, engine: r.engine };
}
