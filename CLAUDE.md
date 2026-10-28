Read and follow `AGENTS.md`. It holds the rules for this repository.

**Quick commands:**
| Command | What it does |
|---|---|
| `npm run sim` | build the WASM sim into `web/src/sim-pkg` |
| `npm run dev` | the game on localhost (Vite), with the `/brain`, `/stt`, `/__shot` and `/__sound` middleware |
| `cargo test` | sim tests, including determinism against the golden hashes (`UPDATE_GOLDEN=1` rewrites them) |
| `npm run test:wasm` | the same determinism replay compiled to WASM, under Node |
| `cargo run -p harness -- play <session> new <seed>` then `do <order>`, `wait <s>`, `look`, `undo` | play headless; `look` draws `out/look/<session>.png` |
| `cargo run -p harness -- hashes <replay.json>` | a replay's map and state hashes |
| `window.__v` in the dev page | `shot(name)` → `out/shots/<name>.png`, `zoom(i)`, `focus(x, y)`, `night(k)`, `grey(on)`, `state()`, `shimmer({dir, step, steps})` |
| `cargo run -p harness -- sweep …` | balance sweeps |
| `npm run voice-eval` | the 20-command voice test against the brain at `$BRAIN_URL` (default `http://127.0.0.1:8080`) |

**Local brain:** `llama-server` with Muse Glimmer, started by `scripts/brain.sh` (record the exact command in `DECISIONS.md` on day 1).
