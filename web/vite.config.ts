import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

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

// The rest of the dev middleware (/brain, /stt, /__sound) arrives with its block (docs/engine/ENGINE.md).
export default defineConfig({
  plugins: [shots()],
  server: { port: 5173, strictPort: true },
});
