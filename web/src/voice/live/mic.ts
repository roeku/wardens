// The microphone, only while the captain holds (docs/spec/06-voice.md §3 "Microphone details"):
// getUserMedia({audio:{channelCount:1, echoCancellation:true, noiseSuppression:true}}) asked for on the first hold,
// an AudioWorklet that averages the input down to 16 kHz mono, and a 16-bit WAV made on release. The tracks are
// stopped on every release, so nothing is ever recorded outside the hold.

import { audio } from '../../sound/audio';

export const RATE = 16000;

/** The worklet: box-averages the context's rate down to 16 kHz, posts PCM in chunks and the input's RMS level. */
const WORKLET = `
class Down16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${RATE};
    this.acc = 0; this.sum = 0; this.n = 0;
    this.buf = new Float32Array(2048); this.len = 0;
    this.sq = 0; this.sqn = 0;
    this.on = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') { this.flush(); this.port.postMessage({ done: true }); this.on = false; } };
  }
  flush() { if (this.len) { this.port.postMessage({ pcm: this.buf.slice(0, this.len) }); this.len = 0; } }
  process(inputs) {
    if (!this.on) return false;
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      this.sq += v * v; this.sqn++;
      this.sum += v; this.n++; this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        this.buf[this.len++] = this.sum / this.n; this.sum = 0; this.n = 0;
        if (this.len === this.buf.length) this.flush();
      }
    }
    if (this.sqn >= 2048) { this.port.postMessage({ level: Math.sqrt(this.sq / this.sqn) }); this.sq = 0; this.sqn = 0; }
    return true;
  }
}
registerProcessor('down16k', Down16k);
`;

let workletReady: Promise<void> | null = null;

/** The mic level as 0..1 for the ring: −50 dBFS and below is silence, −10 dBFS full. */
export function levelOf(rms: number): number {
  const db = 20 * Math.log10(Math.max(1e-6, rms));
  return Math.max(0, Math.min(1, (db + 50) / 40));
}

export class Mic {
  /** The input level now, 0..1 (smoothed). */
  level = 0;
  private chunks: Float32Array[] = [];
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private starting: Promise<void> | null = null;
  private done: (() => void) | null = null;

  /** Starts capturing (asks for the mic on the first hold). Throws if it is refused or unavailable. */
  start(): Promise<void> {
    this.chunks = [];
    this.level = 0;
    this.starting = this.open();
    return this.starting;
  }

  private async open(): Promise<void> {
    const ac = audio();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no microphone here (it needs HTTPS or localhost)');
    workletReady ??= ac.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })));
    const [stream] = await Promise.all([
      navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }),
      workletReady,
    ]);
    this.stream = stream;
    this.source = ac.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(ac, 'down16k', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    this.node.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { pcm?: Float32Array; level?: number; done?: boolean };
      if (d.pcm) this.chunks.push(d.pcm);
      if (d.level !== undefined) this.level += (levelOf(d.level) - this.level) * 0.5;
      if (d.done) this.done?.();
    };
    this.source.connect(this.node);
  }

  /** Stops capturing, releases the mic, and returns the hold's audio as 16 kHz mono 16-bit WAV (null if none). */
  async stop(): Promise<Blob | null> {
    try {
      await this.starting;
    } catch {
      return null;
    }
    const node = this.node;
    if (node) {
      await new Promise<void>((ok) => {
        this.done = ok;
        node.port.postMessage('stop');
        setTimeout(ok, 300);
      });
    }
    this.source?.disconnect();
    node?.disconnect();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.node = null;
    this.source = null;
    this.level = 0;
    const n = this.chunks.reduce((s, c) => s + c.length, 0);
    if (!n) return null;
    const pcm = new Float32Array(n);
    let o = 0;
    for (const c of this.chunks) {
      pcm.set(c, o);
      o += c.length;
    }
    this.chunks = [];
    return wav(pcm, RATE);
  }
}

/** 16-bit PCM mono WAV. */
export function wav(pcm: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

/** A 16-bit mono WAV's samples and rate (for feeding a file through the release path). */
export function readWav(buf: ArrayBuffer): { pcm: Float32Array; rate: number } {
  const v = new DataView(buf);
  let o = 12;
  let rate = RATE;
  let bits = 16;
  let channels = 1;
  while (o + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      channels = v.getUint16(o + 10, true);
      rate = v.getUint32(o + 12, true);
      bits = v.getUint16(o + 22, true);
    } else if (id === 'data') {
      const n = Math.floor(size / (bits / 8) / channels);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = bits === 16 ? v.getInt16(o + 8 + i * 2 * channels, true) / 0x8000 : 0;
      return { pcm, rate };
    }
    o += 8 + size + (size & 1);
  }
  return { pcm: new Float32Array(0), rate };
}
