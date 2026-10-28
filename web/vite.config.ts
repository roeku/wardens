import { defineConfig } from 'vite';

// Dev middleware (/brain, /stt, /__shot, /__sound) is added here as each block needs it (docs/engine/ENGINE.md).
export default defineConfig({
  server: { port: 5173, strictPort: true },
});
