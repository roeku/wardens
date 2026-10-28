# Prompts to paste into Claude, day by day

**How to use them:**
- Open the new repo folder in Claude (desktop app, Code tab). The repo's `CLAUDE.md` and `AGENTS.md` load on their own.
- Paste one block at a time.
- After each block, check its gate yourself (screenshot, harness output, phone) before moving on.
- Keep the sessions short. Start a fresh one for each block.
- Mention the spec section by its path every time; it keeps the agent from inventing numbers.

---

## Day 1, block A: scaffold
```
Read docs/spec/00-start-here.md (Part A only), docs/engine/ENGINE.md and docs/engine/contracts/*.
Set up the repo exactly as ENGINE.md "Architecture" describes: a Cargo workspace with crates sim,
sim-wasm, harness; web/ with Vite + TypeScript + three.js ^0.180.0; an npm script `sim` that runs
wasm-pack (target web, out dir web/src/sim-pkg, gitignored); `npm run dev` serving on localhost.
Copy contracts.rs into crates/sim/src/contracts.rs and contracts.ts into web/src/contracts.ts.
Add a smoke test: the browser page calls into WASM and logs the sim's version string.
Record every choice the spec leaves open in DECISIONS.md. Don't build gameplay yet.
```

## Day 1, block B: deterministic core + map + harness
```
Implement in crates/sim, exactly per the spec:
- hash32, Rng (xorshift32), value noise and fbm: docs/spec/03-land.md §2.
- The map model and generators (assault map, ford map, relief): 03-land.md §1, §3.
- The battle skeleton: 30 Hz fixed tick, the order queue of Command {tick, team, deed, src}, state hash
  (FNV-1a over all soldier/squad state), tick order per 04-battle.md §1 (stub the steps not built yet).
- Determinism rules from ENGINE.md (libm only, no HashMap iteration, total_cmp sorts).
Implement crates/harness: `play <session> new <seed>`, `do <command>`, `wait <seconds>`, `look`
(text state + a top-down PNG: tiles coloured by type, squads as dots), `undo`; a session file is
seed + command log, re-simulated on every call (01-flow.md §8).
Add a test that runs the same seed+log natively and under `wasm-pack test --node` and compares hashes
every 300 ticks.
```

## Day 1, block C: the pixel pipeline
```
Implement the render pipeline in web/src/view per docs/spec/02-look.md §1–§3 exactly: art-pixel target
sized from min(innerW, innerH)/380, the CELL pass (outlines from depth with the given formula, the
night tint, the pause grey), the POST pass with sub-pixel shift, no canvas depth buffer, colour
management off, toon ramp [96,150,205,255], orthographic 30° camera facing north-east, ZOOMS table,
pixel snapping of the camera with uSub. Show the map's height grid from WASM as a mesh with a flat
grass colour. Add window.__v.shot(name) saving the WebGL frame through a dev-server endpoint.
Gate: panning slowly shows no shimmer; take shots at zoom 7, 16 and 34.
```

## Day 1, block D: voice spike (evening)
```
Read docs/spec/06-voice.md §2, §4, §5, §9 and docs/voice-eval/*. Build tools/voice-eval (Node or Rust,
your choice; log it): it loads fixture.json + cases.json, builds the cached system prefix and the
dynamic state exactly as §4, calls an OpenAI-compatible endpoint (default http://127.0.0.1:8080, the
local llama-server running Glimmer) with response_format = the per-battle JSON schema, runs the fast
path first, resolves and checks each case 3 times, and prints accuracy and latency p50/p95.
Write the results into DECISIONS.md.
```

## Day 2: land and men
```
A) Port the ground painter and scatter to Rust (crates/sim/src/land/): docs/spec/03-land.md §4–§6,
   MEADOW only for now. Expose Land::make() in sim-wasm returning the RGBA texture, heights and the
   tree/rock/bush instance arrays. Draw them in three.js per 03-land.md §5 and 02-look.md §4. Measure
   make() time; if > 50 ms move it to a Web Worker that loads the same WASM (03-land.md §10).
B) Figures: docs/spec/02-look.md §5–§6. One InstancedMesh per body part, posed procedurally with matrices
   written straight into the instance buffers; walk cycle, no bob, strike tables, death, hit flash;
   pixel snapping of every figure; the banner atlas with the 16×26 gonfalon. Build web/src/labs/units
   (dev-only page) showing every kind, both teams, poses, zoom, sub-pixel drift. Gate: no flicker.
```

## Day 3: the battle
```
Implement docs/spec/04-battle.md §2–§8 in crates/sim exactly: unit tables in a tuning table that a
JSON override can replace, slots, the momentum steering model, cohesion gate, the army following
the captain (column/line), planFront, engagement, melee, ranged, morale, routing, commanders,
saveTheLast, recall, the captain's ride, the garrison and general bots, battle outcomes.
Add harness `sweep` printing experience numbers and the jitter metric (standing reversals per second
per man; march/stand flips per squad-minute). Gates in 00-start-here.md §A5.
```

## Day 4: command
```
A) Input: docs/spec/01-flow.md §2 exactly (thresholds table, hit-testing, the pointer state machine,
   taps, strokes, pause, keys) producing Commands through sim-wasm apply(). Marks per 02-look.md §7.
B) Structures and objectives: 03-land.md §7 (medieval set, burning, smoke, fire lights), village under
   the torch, ford, night (04-battle.md §8; 02-look.md §3 night pass).
C) Voice end to end: docs/spec/06-voice.md §1–§7. Vite middleware /stt and /brain; hold V or hold the
   captain 400 ms; time ×0.3 while listening; fast path; resolve; validate; horn answers; red cross.
```

## Day 5: the campaign
```
docs/spec/01-flow.md §3–§7: road, muster parade ground, cards with pictograms and the 5×7 bitmap font,
the Hall of Banners, saves. Theme per the decision in DECISIONS.md (The Wardens unless the organisers
cleared otherwise). The LLM broodlord: 06-voice.md §8, Glimmer slot 2, intents carried out by the
garrison/general bots, every reply logged into the order queue.
```

## Day 6: progression (session 1) and sound (session 2, separate files)
```
Session 1: docs/spec/07-progression.md §11 "in scope", data-driven per §9, with draft bots and the
balance targets in §10 measured natively in the harness. Print the counts of every check.

Session 2: docs/spec/05-sound.md. A dev-only sound lab that renders the Strudel recipes to .m4a
(ship only renders), the Web Audio engine with the MIX table, spatial rule, density rules, music
director with stems, horn calls, and the event wiring from the sim's event ring. Check levels with
ffmpeg (05-sound.md §6).
```

## Day 7: finish and ship
```
Camp letters and the chronicle from the battle log (local Glimmer; short; no words on the battlefield).
The ghost-hand lesson (01-flow.md §6). A polish pass against 02-look.md §9 "Rules of the look".
Deploy: Vercel or Cloudflare Pages with the cache headers from 01-flow.md §8; a serverless /brain and
/stt proxy to the hosted Glimmer (Modal or Baseten) with the key in env and an IP rate limit;
?brain=hosted the default on the public URL. Feature freeze at 6 PM.
```
