import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** POST /__shot?name=… saves the posted PNG to out/shots/<name>.png (window.__v.shot). */
function shots(): Plugin {
  return {
    name: 'wardens-shots',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const name = (new URL(req.url ?? '', 'http://dev').searchParams.get('name') ?? 'shot').replace(/[^\w-]/g, '_');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const dir = join(ROOT, 'out', 'shots');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${name}.png`), Buffer.concat(chunks));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ path: `out/shots/${name}.png` }));
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Voice serving (docs/spec/06-voice.md §2): `/brain` and `/brain-hosted` are proxies to llama-server, `/stt`
// transcribes a posted 16 kHz WAV, `/__voicelog` keeps the voice orders. Keys come from the repo's .env, read here
// in the dev server's Node process, and never reach the browser (.env.example lists them).
// ---------------------------------------------------------------------------------------------------------------

type Env = Record<string, string>;

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok, no) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', no);
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}

/** The brain proxies. `/brain/*` → the local llama-server; `/brain-hosted/*` → the hosted copy, with its key. */
function brainProxy(env: Env): Record<string, ProxyOptions> {
  const out: Record<string, ProxyOptions> = {
    '^/brain/': { target: env.BRAIN_URL || 'http://127.0.0.1:8080', changeOrigin: true, rewrite: (p) => p.replace(/^\/brain/, '') },
  };
  if (env.HOSTED_BRAIN_URL) {
    out['^/brain-hosted/'] = {
      target: env.HOSTED_BRAIN_URL,
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/brain-hosted/, ''),
      headers: env.HOSTED_BRAIN_KEY ? { authorization: `Bearer ${env.HOSTED_BRAIN_KEY}` } : {},
    };
  }
  return out;
}

/** Without a hosted brain configured, `/brain-hosted` answers 503 at once, so the chain falls through quickly. */
function noHostedBrain(env: Env): Plugin {
  return {
    name: 'wardens-no-hosted-brain',
    configureServer(server) {
      if (env.HOSTED_BRAIN_URL) return;
      server.middlewares.use('/brain-hosted', (_req, res) => json(res, 503, { error: 'no hosted brain: set HOSTED_BRAIN_URL in .env' }));
    },
  };
}

/** What a speech-to-text engine gives back. */
interface Transcript {
  text: string;
  engine: string;
}

/**
 * Speech-to-text. `local`: whisper.cpp's `whisper-server`, started on the first request (or `/stt/warm`, sent when
 * the captain starts to hold) and kept warm; `whisper-cli` if the server cannot start. `meta`: Muse Voice
 * Transcribe through the Meta Model API once the owner has keys (META_API_KEY, META_STT_URL, META_STT_MODEL);
 * on any failure it falls back to local. `STT_ENGINE=local|meta` picks; meta is the default when a key is set.
 */
function stt(env: Env): Plugin {
  const model = env.WHISPER_MODEL || join(homedir(), '.cache/hyperframes/whisper/models/ggml-small.en.bin');
  const port = Number(env.WHISPER_PORT || 8178);
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  let ready: Promise<boolean> | null = null;

  const alive = async () => {
    try {
      await fetch(base + '/', { signal: AbortSignal.timeout(500) });
      return true;
    } catch {
      return false;
    }
  };

  /** Starts whisper-server unless one already answers on the port. True once it answers. */
  const ensure = (): Promise<boolean> => {
    ready ??= (async () => {
      if (await alive()) return true;
      if (!existsSync(model)) {
        console.warn(`[stt] no whisper model at ${model} (set WHISPER_MODEL)`);
        return false;
      }
      child = spawn(env.WHISPER_SERVER || 'whisper-server', ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-nt', '-t', '4'], {
        stdio: 'ignore',
      });
      child.on('exit', () => {
        child = null;
        ready = null;
      });
      child.on('error', (e) => console.warn(`[stt] whisper-server: ${e.message}`));
      for (let i = 0; i < 100; i++) {
        if (await alive()) {
          console.log(`[stt] whisper-server ready on ${port} (${model})`);
          return true;
        }
        await new Promise((ok) => setTimeout(ok, 200));
      }
      return false;
    })();
    return ready;
  };

  const local = async (wav: Buffer, prompt: string): Promise<Transcript> => {
    if (await ensure()) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'hold.wav');
      form.append('response_format', 'json');
      form.append('temperature', '0');
      if (prompt) form.append('prompt', prompt);
      const r = await fetch(base + '/inference', { method: 'POST', body: form });
      if (!r.ok) throw new Error(`whisper-server ${r.status}`);
      return { text: ((await r.json()) as { text: string }).text.trim(), engine: 'whisper-server' };
    }
    // the server would not start: one-shot whisper-cli (slower: it loads the model every time)
    const dir = join(ROOT, 'out', 'stt');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'hold.wav');
    writeFileSync(file, wav);
    const args = ['-m', model, '-f', file, '-nt', '-np', ...(prompt ? ['--prompt', prompt] : [])];
    const text = execFileSync(env.WHISPER_CLI || 'whisper-cli', args, { encoding: 'utf8', timeout: 20_000 });
    return { text: text.replace(/\s+/g, ' ').trim(), engine: 'whisper-cli' };
  };

  /**
   * Muse Voice Transcribe (06-voice.md §2 option A). The request format is not confirmed yet (it waits on the Meta
   * team's keys): this sends the common multipart transcription shape (file, model, prompt), with the key as a bearer
   * token, and reads `text` back. Adjust here, in one place, when the API is known.
   */
  const meta = async (wav: Buffer, prompt: string): Promise<Transcript> => {
    if (!env.META_API_KEY || !env.META_STT_URL) throw new Error('META_API_KEY and META_STT_URL are not set');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'hold.wav');
    form.append('model', env.META_STT_MODEL || 'muse-voice-transcribe');
    if (prompt) form.append('prompt', prompt);
    const r = await fetch(env.META_STT_URL, { method: 'POST', headers: { authorization: `Bearer ${env.META_API_KEY}` }, body: form, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`meta stt ${r.status}`);
    return { text: ((await r.json()) as { text: string }).text.trim(), engine: 'meta' };
  };

  const engine = env.STT_ENGINE || (env.META_API_KEY ? 'meta' : 'local');

  return {
    name: 'wardens-stt',
    configureServer(server) {
      server.httpServer?.on('close', () => child?.kill());
      process.once('exit', () => child?.kill());
      server.middlewares.use('/stt', async (req, res) => {
        try {
          const url = new URL(req.url ?? '', 'http://dev');
          if (url.pathname === '/warm') {
            json(res, 200, { engine, ready: engine === 'meta' ? true : await ensure() });
            return;
          }
          if (req.method !== 'POST') return json(res, 405, { error: 'POST a 16 kHz WAV' });
          const wav = await body(req);
          const prompt = url.searchParams.get('prompt') ?? '';
          const t0 = performance.now();
          let out: Transcript;
          if (engine === 'meta') {
            try {
              out = await meta(wav, prompt);
            } catch (e) {
              console.warn(`[stt] meta failed, local instead: ${e instanceof Error ? e.message : e}`);
              out = await local(wav, prompt);
            }
          } else out = await local(wav, prompt);
          json(res, 200, { ...out, ms: Math.round(performance.now() - t0) });
        } catch (e) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      });
    },
  };
}

/** POST /__voicelog appends the posted JSON as one line of out/voice-log/voice.jsonl (06-voice.md §7). */
function voiceLog(): Plugin {
  return {
    name: 'wardens-voice-log',
    configureServer(server) {
      server.middlewares.use('/__voicelog', async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, {});
        let entry: unknown;
        try {
          entry = JSON.parse((await body(req)).toString('utf8'));
        } catch {
          return json(res, 400, { error: 'not JSON' });
        }
        const dir = join(ROOT, 'out', 'voice-log');
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'voice.jsonl'), JSON.stringify({ at: new Date().toISOString(), entry }) + '\n');
        json(res, 200, { ok: true });
      });
    },
  };
}

/**
 * `npm run dev:https`: the dev server over HTTPS on the LAN (port 5174), so a phone can use the microphone, which
 * browsers allow only on HTTPS or localhost. A self-signed certificate for this machine's names and LAN addresses
 * is made once with the system's `openssl` into out/certs (the phone asks to trust it the first time).
 */
function https(): { key: Buffer; cert: Buffer } {
  const dir = join(ROOT, 'out', 'certs');
  const key = join(dir, 'dev-key.pem');
  const cert = join(dir, 'dev-cert.pem');
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(dir, { recursive: true });
    const ips = Object.values(networkInterfaces())
      .flat()
      .filter((n) => n && n.family === 'IPv4')
      .map((n) => `IP:${n!.address}`);
    const san = ['DNS:localhost', ...ips].join(',');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '365', '-subj', '/CN=wardens-dev', '-addext', `subjectAltName=${san}`], {
      stdio: 'ignore',
    });
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, '');
  const secure = process.env.WARDENS_HTTPS === '1';
  return {
    plugins: [shots(), noHostedBrain(env), stt(env), voiceLog()],
    server: secure
      ? { port: 5174, strictPort: true, host: true, https: https(), proxy: brainProxy(env) }
      : { port: 5173, strictPort: true, proxy: brainProxy(env) },
  };
});
