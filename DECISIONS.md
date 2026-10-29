# Decisions

One entry per decision, newest at the bottom. Format:

## D-01 | YYYY-MM-DD | Title
**Decision:** what was decided.
**Why:** the reason, with numbers when there are any.
**Rejected:** the alternatives considered.
**Spec:** the section affected, if any.

---

## D-01 | 2026-10-28 | Stack: Rust sim (native + WASM), TypeScript + three.js view
**Decision:** Rust for rules, the harness and land painting; TypeScript and three.js (WebGL2) for the view, input, voice, sound and screens.
**Why:** a live web link for the judges and phones; the spec's render pipeline maps to three.js; deterministic floats via libm across native and WASM; fast native balance sweeps.
**Rejected:** an all-Rust renderer (Bevy/wgpu): the custom post pipeline, API churn and WASM size are too risky in 8 days. All-TypeScript: kept as the fallback if WASM fights us on day 1.
**Spec:** docs/engine/ENGINE.md

## D-02 | 2026-10-28 | Theme: The Wardens (provisional)
**Decision:** The Wardens: a warden-captain's companies free villages from a blight of beasts (drakes, trolls, blight-men). No real history, no war between peoples. **Provisional:** the organisers have not answered yet. The question is open in Discord `#questions`, thread "Query regarding anti-project criteria" (28 Oct 2026, about fictional strategy games and "anything political or involving war"). We proceed on an assumed GO.
**Why:** the hackathon lists "anything political or involving war" as an anti-project. Even if fictional battles are cleared, beasts against villages stays the safer reading, so the reframe stands either way.
**Rejected:** the historical campaigns (Hannibal and the empires).
**Spec:** docs/spec/00-start-here.md §A2.
**Open:** record the organisers' answer here when it comes.

## D-03 | 2026-10-28 | The voice brain: local Glimmer skips its thinking by a prefilled answer turn
**Decision:** serve `meta-models/Muse-Glimmer-30B-GGUF`, file `Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf` (16.8 GB, kept in `~/models/muse-glimmer/`, outside the repo), with llama.cpp `llama-server` (build 11429, `--jinja`). Call it through `/apply-template` plus `/completion`, with the assistant turn prefilled as `<|start|>assistant to=user<|message|>`, so the model writes the JSON answer at once and never opens its `to=self` reasoning message.
**Why (smoke test on the M5 Pro, 64 GB, 7–12 utterances from docs/voice-eval against the spec's prefix without its 8 examples):**
- Decode is 12–15 tok/s and prefill about 200–270 tok/s. A dense 16.8 GB model is bound by memory bandwidth, so this won't get much faster.
- Glimmer's template always opens a thinking message. `reasoning_strength: low`, `--reasoning-budget 0` and `--reasoning-budget 32` all had no effect in this build: 250–650 thinking tokens, **21–50 s per order**.
- With the prefilled answer turn: **2–8 s per order**, valid JSON under the schema every time. The output was pretty-printed (55–100 tokens); a whitespace-free grammar should bring a typical order to about 30 tokens.
- Accuracy without examples or thinking was roughly 5–7 of 11. Errors: `move` for `take`, all four companies instead of `ARMY`, and `side: left` when no side was said. The 8 examples of §4a are the first fix.
**Next (block D, voice-eval):** a compact grammar; warming the KV cache with the field state when the hold starts, so only the words need reading on release; the 8 examples; then try the DFlash drafter (`-md dflash-…gguf`, 1.6 GB) for speculative decoding. Expected local end-to-end is about 2–2.5 s, absorbed by time at ×0.3. Meeting the 1.2 s target needs the hosted GPU.
**Rejected:** relying on the template's reasoning controls (they don't work); the 19.7 GB Q4_K_XL build (no speed gain, 3 GB more on a disk with about 20 GB free).
**Spec:** docs/spec/06-voice.md §2, §9.

## D-04 | 2026-10-28 | Repo layout and toolchain versions (day 1 block A)
**Decision:**
- One `package.json` at the repo root, with Vite's root at `web/` (`vite web`), so `npm run sim`, `npm run dev` and `npm run build` run from the root as `CLAUDE.md` and the README say. `web/` holds `index.html`, `vite.config.ts` and its own `tsconfig.json`.
- Cargo workspace with resolver 3 and edition 2024. `Cargo.lock` and `package-lock.json` are committed, so the exact versions are pinned.
- Versions: Rust 1.99, wasm-pack 0.15.0, wasm-bindgen 0.2 (0.2.129 at setup), serde 1, serde_json 1, libm 0.2; three ~0.180 (in `dependencies`, since it ships), @types/three ~0.180, vite 6.4, typescript 5.9; Node 22.
- The harness gets `clap 4` and `image 0.25` in block B, when it first uses them. No unused dependencies.
- `.claude/launch.json` starts the dev server on port 5173 for the browser preview.
**Why:** matches ENGINE.md's architecture and the commands the repo's docs already name. Release WASM is 13.7 kB at this stage.
**Rejected:** separate `web/package.json` (two install steps, and the documented commands would need a `cd`).
**Spec:** docs/engine/ENGINE.md "Architecture", "Toolchain".

## D-05 | 2026-10-28 | Day 1 block B: what the spec left open in the core, the maps and the battle skeleton
**Decision:**
- **Map constants are named `const`s, not JSON tuning.** They define what a seed's map is, so overriding them would silently change every replay's map. Balance and movement numbers live in `tune.rs` (`PROTO_TUNE`).
- **Assault map (03-land §3a):**
  - Forest blobs use the rocks' y range, `2 + r·(H−4)`.
  - Blobs only cover open ground, never water, road or each other.
  - Village pairs split the 0.3W span into one band per pair. Shrines use `y = 2 + r·(H−4)`. Towers alternate flanks (0.1–0.3H, then 0.7–0.9H), with a random first flank.
  - A site gets up to 12 tries. A spot is rejected if there is water within its 2.2 clearing (clearing it would cut the river). The clearing removes rock and forest only. A site with no valid spot is left out; that never happened in 180 test maps.
- **Ford map (03-land §3b):**
  - The narrow ford is at 0.1–0.18H or 0.82–0.9H.
  - People enter at the east edge and leave at the west edge, on the main ford's row. Route tiles become road.
  - The warband deploys on the west bank at (0.3W, ford row). The raiders' deploy point, (W−4.5, 3.5), is provisional until the ford battle (day 4).
- **Relief (03-land §3d):** a tile mask takes the strongest cone, not the sum. A site's pad height is the raw height at its centre.
- **Battle skeleton (04-battle §1):**
  - The state hash is 64-bit FNV-1a over the tick and every squad's and soldier's state, floats by their bits.
  - Commands due at or before the current tick are applied in arrival order before the tick runs.
  - Every command is logged, refused or not; a refusal also raises a `Refused` event.
  - A company's men include its commander, soldier 0, who has 3× hp.
- **Until day 3 (temporary behaviour):**
  - An army order sends each company with the army to its fixed station around the destination, turned to the march heading; following the captain comes on day 3.
  - A drawn front marches the army to the line's middle; `planFront` comes on day 3.
  - An attack closes to melee range (2.6).
  - Beast stats are a placeholder.
- **Default setup, provisional until the muster and garrisons land (day 5):**
  - The voice fixture's warband: WIL spear, ODA shield, REN archer, BORS horse, and the captain, in the §3d line stations, facing the enemy.
  - Against it, 3 companies of blight-men (levy stats) in a line 2.5 tiles before the keep.
- **Harness:**
  - Sessions are `Replay` JSON in `out/sessions/`: seed, map, tick, log, and the optional tune override.
  - `do` stamps the current tick and reports a refusal at once. `undo` drops the last command and keeps the clock.
  - `look` draws `out/look/<session>.png` at 12 px per tile.
- **Determinism checks:**
  - One golden file, `crates/sim/tests/fixtures/replay.hashes`, is checked natively (`cargo test`) and in WASM under Node (`npm run test:wasm`). Rewrite it with `UPDATE_GOLDEN=1` after a deliberate rule change.
  - `clippy.toml` forbids the platform maths functions (`f64::sin` and friends, `powi`, `hypot`) and `HashMap`/`HashSet`.
**Why (gate, measured):**
- The fixture's map hash and 7 state hashes over 60 s and 11 commands (2 refused) are identical natively, in debug WASM under Node, and in release WASM in the browser.
- 1,800 ticks replay in 24 ms in the browser.
- `hash32` and `Rng` match the spec's JS formula on reference values. 180 maps (3 kinds × 3 widths × 20 seeds) are valid, with every site reachable.
**Rejected:** a shared-output script that diffs native against WASM at run time (needs file access from the WASM test); FNV-1a 32-bit (more collisions for no gain).
**Spec:** docs/spec/03-land.md §1–§3, docs/spec/04-battle.md §1–§3, docs/spec/01-flow.md §8.

## D-06 | 2026-10-28 | Day 1 block C: the pixel pipeline, and three changes that keep panning still
**Decision:** the pipeline follows 02-look.md §1–§3: art-pixel target, CELL, POST with `uSub`, no canvas depth, colour management off, toon ramp, the ortho 30° camera, ZOOMS, and the daylight table. The land is the WASM height grid in flat grass. Three choices go beyond the spec, all so that a slow pan changes the picture only by whole-pixel shifts:
1. **The camera stands on a fixed plane 150 back along the view**, not 150 back from the focus. An ortho picture is the same either way, but with the focus-relative camera every depth value moved as the focus crossed hills, and the depth outlines flipped single pixels.
2. **The shadow camera is snapped to its own texel grid and to a fixed plane along the light, and re-centres only after the focus has drifted 4.5 of its 6 tiles of margin.** Re-fitting it every frame made shadow edges flicker at zoom 16.
3. **The night's Bayer dither is indexed by `c + uOrigin`** (the camera's position in whole art pixels), so it stays fixed to the world instead of crawling across it while panning.
**Also:**
- `?tier=high|mid|low` picks the shadow map size and the canvas resolution. Choosing the tier by GPU name, and the frame-time governor, come later.
- `?kind=keep|town|ford` picks the map kind, until the campaign does.
- Camera controls are temporary until the pointer state machine (day 4): a drag pans, the wheel steps the zoom per 90 deltaY, arrows/WASD pan at 520 px/s, + and − zoom.
- The dev server's `/__shot` saves `out/shots/<name>.png`. `@types/node` is added for the Vite config's own typecheck (`web/tsconfig.node.json`).
- `window.__v` has `shot`, `zoom`, `focus`, `night`, `grey`, `state` and `shimmer`.
**Why (gate, measured with `__v.shimmer`):** it pans in 0.1–0.13 art-pixel steps in four directions and checks that every change of the art-pixel image is a whole-pixel shift of the frame before.
- Across all 9 zooms (2,160 frames), no frame changed without the view shifting.
- 9 frames, at zooms 19 and 34, carried one stray pixel out of ~197,000: GPU rounding exactly on a triangle or outline edge.
- Before fixes 1 and 2, up to 18 frames in 80 changed while the view had not moved.
- Shots at zoom 7, 16 and 34 (plus night and pause) are in `out/shots/c-*.png`.
**Rejected:** one shadow camera over the whole map (stable, but 2–2.5 art pixels per shadow texel at zoom 34); a shadow camera re-fitted every frame (the flicker above).
**Spec:** docs/spec/02-look.md §1–§3, §8.

## D-07 | 2026-10-28 | Day 1 block D: the voice eval, and local Glimmer as the brain
**Decision:**
- **Code layout.** `tools/voice-eval` is Node/TypeScript running the game's own voice modules from `web/src/voice/` (field, prompt, normalise, fast path, resolve, brain client), so what is measured is what ships. Node 22 runs TypeScript natively, so no extra dependency.
- **Serving.** The brain is `scripts/brain.sh`: llama-server, 2 slots, with the DFlash drafter for speculative decoding by default. Calls use the prefill mode of D-03 with a whitespace-free GBNF grammar built from the per-battle schema, on slot 0, at temperature 0. The OpenAI-compatible `chat` mode is kept for hosted endpoints.
- **Prompt and field state.**
  - The prompt is §4a's rules verbatim plus 8 examples on another field (KAEL, MAREK, HUGH, TAMSIN; CHAPEL, WEIR, BARROW, ASHWOOD, BROOK), worded differently from the eval set.
  - The state text and schema builders reproduce `docs/voice-eval/fixture.json`'s text and `schema.json` exactly, checked on every run. As in the fixture, only villages say who holds them.
- **Normalising (§5).**
  - "right" and "go on" are fillers only at the start ("right, everyone hold"); elsewhere "right" is a side.
  - Names match by Levenshtein ≤ 1 or a simplified sound key standing in for Double Metaphone.
  - Common words (will, hold, march, back…) are never heard as names.
  - Spoken names are replaced by their exact names before the brain, so "boris" reaches it as BORS.
- **Resolving (§6).**
  - Naming every company is an order to the army.
  - Holding a place is moving there with fight on. Attacking a place takes it.
  - **A move to a village the blight holds is a take.**
  - Orders that come with `unclear: true` are still carried out.
  - Attack and take deeds now carry `via`, so "round the left to the mill" bends the route (contracts extended on both sides; the golden hashes are unchanged).
**Results** (fixture field, 20 cases):

| Configuration | Accuracy | Brain p50 / p95 | Tokens out / new in |
|---|---|---|---|
| D-03 smoke: chat with reasoning | ~2/7 | 21–50 s | 250–650 thinking |
| D-03 smoke: prefill, no examples | ~5–7/11 | 2–8 s | 55–100 |
| prefill + examples, no drafter (1 run) | 17/20 | 4.7 / 7.0 s | 32 / 24 |
| **+ resolve fixes + DFlash drafter, state warm, 3 runs** | **20/20, every case every run** | **2.76 / 3.70 s** | 32 / 5 |
| same, state cold (1 run) | 20/20 | 4.25 / 6.76 s | 32 / 515 |

- **Load caveat.** During these runs the Mac was busy with other work: four `basisu` processes at about 500% CPU, Blender, a Playwright Chrome, and 6.5 GB of swap. Decode ran at 6.3–7.4 tok/s without the drafter and 12.5–13.4 with it, against 14–15 without the drafter in the morning's smoke test. The drafter is a 1.8× speed-up under the same load. Re-measure on an idle machine (estimate: about 1.3–1.6 s p50).
- **Fast-path cases** (rally, hold, recall ×2) take under 10 ms end to end.
**Local or hosted:**
- **Local Glimmer stays the brain** for development and for the offline, private story: the accuracy target is met with margin.
- It misses the 1.2 s Mac latency target (2.8 s p50 loaded). With time at ×0.3 while speaking, 2.8 s is about 0.85 s of game time, which plays.
- The judges' public build serves the same weights on a hosted GPU (day 7). Run llama-server there, so the prefill mode and grammar work. That needs the Modal or Baseten credits, which wait on the Meta team ID.
- In the game, the field state must be sent to the brain when the hold starts (`warm`), not on release. Cold costs about +1.5 s.
**Not yet measured:**
- The `--audio` path: the 20+20 clips aren't recorded yet. Only `small.en` is on this machine; the checklist's `large-v3-turbo` path doesn't exist here.
- Chat mode end to end: its reasoning makes it 21–50 s per order locally (D-03).
**Rejected:** relying on the template's reasoning controls (D-03); the full Double Metaphone (several hundred lines for one test case that Levenshtein already covers).
**Spec:** docs/spec/06-voice.md §2, §4–§6, §9; docs/voice-eval/*.

## D-10 | 2026-10-28 | The order language, and how much of the reference games to bring in
**Decision (owner):** commanding by natural voice is the core of the game, so the sim must carry out a wide range of orders, and voice must understand them. That covers both:
- **command structures:** sequences, signals, conditions, standing orders, named groups;
- **built structures:** field works the companies build and man by order.

The reference games (We March as One, Dawn of Defense, Kingmakers) come in *inside* VANGUARD's core (no store, losses stick, grow through your people):
- deployment before contact, with reserves
- hold-the-line waves, and capture squads that go for places
- officers as morale nodes, with capture
- field works
- visible counters and enemy rosters

The design is `docs/spec/08-orders.md`.
**Why:** the owner's direction; all three teardowns were read in full on 28 Oct. Their players' biggest gaps are the very ones voice fills: no orders after deployment, hidden targeting, orders limited to attack/hold/waypoint.
**Rejected:** an economy layer with resources and paid buildings (it breaks "no store"); keeping only the spec's 7 verbs.
**Spec:** docs/spec/08-orders.md (new); 04-battle.md; 06-voice.md; 07-progression.md.

## D-08 | 2026-10-28 | Day 2 part A: the land (03-land §4–§6, §10; 02-look §3–§4)
**Summary:**
- `sim::land::make(&BattleMap)` paints the MEADOW ground at 12 texels per tile over the map plus 18 tiles of country, extends the heights and places the scatter. The view draws the painted mesh, water, instanced scatter and the fog patch.
- Built by a delegated agent; checked again before commit.
**Gate (measured):**
- **Shimmer:**
  - The agent: 0 stray frames at zooms 7, 16 and 34 on keep/48, ford/48 and keep/80.
  - My re-check: seed 9 at zooms 9, 19 and 28, east and north, gave 49 shifted frames, 0 stray pixels and 0 changes without a shift.
- **Time to make the land:**
  - Native release: 15.5, 21.4 and 27.4 ms for widths 48, 64 and 80.
  - WASM warm: 18, 25 and 33 ms. Under heavy machine load: 46, 62 and 82 ms.
  - So it runs in a module worker by default (`?land=inline` to compare). Inline and worker output are byte-identical.
- **Hashes:** the land hash is golden-checked natively and in WASM (`crates/sim-wasm/tests/land.rs`). The replay golden hashes are unchanged.
**Open:**
- The drawn river is about one tile wider than the rules' 2-tile river (the §3d relief carves round the water mask), so men on Open tiles by the bank may seem to stand in water. Settle this before day 3's movement is judged on screen.
- Roads follow A*, which ignores height, so they can run down crag slopes.
- Figures need `patchFog` to get fog and the vertex snap.

# Day 2 part A (land): choices the spec left open

### The land's contract between Rust and the view
**Decision:**
- `sim::land::make(&BattleMap) -> Land` (MEADOW; `make_with` takes another `Scape`). `Land` holds the RGBA ground (`ew·12 × eh·12`, rows from the north), the extended heights (`(2ew+1) × (2eh+1)`), a per-tile water-quad mask, the roads, the fields, and five instanced parts (`wood` boxes, `leaf` icosahedra, `tier` 7-sided cones, `stone` dodecahedra, `hay` cones), each as flat `mat` (16 floats per instance, column-major as three.js stores it, `T·Ry(yaw)·Rz(tilt)·S`) and `col` (3 floats, the hex value /255, unconverted).
- WASM: `Battle.land()` (inline) and `Battle.map_json()` + `new Land(map_json)` (worker). Buffers come out once through `take_*`, so the worker transfers them without a second copy. `Land.hash()` is FNV-1a over everything drawn.
- The seed comes from the map (`BattleMap.seed`), so ENGINE.md's `Land::make(map_json, seed)` is `new Land(map_json)`.
**Why:** the view writes the buffers straight into `InstancedMesh.instanceMatrix`/`instanceColor`; no per-instance work on the main thread. Rust builds the matrices because §10 says the worker builds "the instanced tree matrices".
**Rejected:** compact (x, y, scale, yaw) records expanded in TypeScript (main-thread work per battle); one JSON blob (slow, and floats would round-trip through text).
**Spec:** 03-land.md §4–§5, §10; docs/engine/ENGINE.md "Land".

### Land constants are named consts, not tuning
**Decision:** every land number is a `const` in `crates/sim/src/land/*`, and the MEADOW table is `scape::MEADOW`, as the map's constants are (D-05).
**Why:** they define what a seed's land looks like; a JSON override would silently change every replay's picture.
**Rejected:** a JSON tuning table.
**Spec:** AGENTS.md "every number named"; D-05.

### Noise salts and frequencies the spec doesn't give
**Decision:**
- Where the spec writes `fbm(seed+k, …)` without a salt, the salt is k (as the relief does: `fbm(seed+1, …, 1)`, `fbm(seed+4, …, 4)`): rise `seed+2/2`, outside wood `seed+3/3`, species `seed+7/7`, rock `seed+9/9`, lakes `seed+12/12`, pools `seed+13/13`, patch `seed+5/5`, dry `seed+6/6`, meadow `seed+11/11`. Peak ridges use `noise(seed, ·0.16, 14)`.
- Edge warp `noise(seed, 1.7x, 1.7y, 71 | 72)`; a `fine` noise (single octave, 0.8/tile, salt 73) for texture inside a ramp; a `wob` noise (1.3/tile, salt 74) for the road's `.44 ± .08` width, the yard's `± 0.3` wobble and the shore line; cracks `noise(seed, 3.5x, 3.5y, 75)`.
- Hash salts: river 31, fields 41–43, lichen 76, ford pebbles 77, tufts 78, flowers 79–80, scatter 91–92.
- All noise grids (warp, patch, dry, meadow, fine, wob) are sampled at quarter tiles and read bilinearly; the texel loop pre-interpolates each texel row.
**Why:** consistency with the existing relief code; the quarter-tile grids keep `make` at 15–27 ms natively.
**Rejected:** per-texel noise for the warp (≈2× slower).
**Spec:** 03-land.md §2, §4.

### Outside the map: river, relief and the seam
**Decision:**
- The river runs on past the north and south edges as a random walk like the map's own (drift chance 0.3 per row), held within ±2 columns of where it left the map.
- The outside relief is the §4 formula (base `·0.9`, rising ground, peaks) **plus** the map's hills and the §3d tile-mask terms over the extended grid (rock crags, wood +0.12, water carve, `max(h, WATER_Y+.08)` away from water). The rising ground and peaks are multiplied by `1 − water` so the river cuts a valley through them, and over the river's own tiles (water mask > 0.45) the bed is held at `WATER_Y − 0.05 − (mask − 0.45)·0.6`.
- Inside the map the heights are the map's exactly (tested bit for bit); outside, `lerp(edge height, outside height, smoothstep(0, 2, out))`, with the edge height read at the nearest point of the map.
**Why:** without the carve the outside river climbed out of the rising bowl and dried up 2–3 tiles past the edge; without the masks, outside rocks were flat paint.
**Rejected:** the bare §4 formula (dry river, flat rocks); a river that keeps going straight.
**Spec:** 03-land.md §3d, §4 "Outside the map".

### Roads
**Decision:**
- The assault map's main road: west edge at the deploy row → the other sites in order of x, taking a site only when it lies ahead within 45° (`|dy| ≤ dx`) of the last stop → the keep. The rest get spurs (A* to the nearest point of the main road). The keep's road east goes to the edge tile on the keep's row, else the nearest open row within ±3.
- Routing is the rules' own A* (`map::path::astar`), so roads cross rivers only at fords; then densified to 0.5 tiles and smoothed (6 passes, factor 0.5, never onto water or rock).
- A road ending within 1 tile of an edge runs straight on to the end of the painted country (18 tiles), and outside the map woods and rock are cleared within 1.5 tiles of it.
**Why:** "through the sites in order of x" plus "the other sites get spurs" needs a rule for which sites are on the main road; the 45° rule gives one winding road instead of a zig-zag between top and bottom villages.
**Rejected:** the main road through every site (zig-zags across the map); roads stopping at the map's edge.
**Spec:** 03-land.md §4 "Roads".

### Fields
**Decision:** farmed points are villages and towns (+1.6 distance for a town), `m.farms`, and the farmland grid (none in MEADOW). Fields are axis-aligned rectangles; "on Open tiles only" means every tile under the rectangle is Open (rules road tiles excluded); the road gap is measured from the rectangle to the road's segments (sampled every 0.1 tile). The 14 beyond the map get up to 400 tries, each lying wholly at least 1 tile past the edge.
**Why:** the spec gives the sizes, distances and gaps but not the shape or how the gaps are measured.
**Rejected:** rotated fields (the stripes and furrows would alias on the 12-texel grid).
**Spec:** 03-land.md §4 "Fields".

### Ground painting details
**Decision:**
- Precedence per texel: water bed > ford > yard > road > field > rock > forest floor > grass. Water, ford, rock and wood come from the warped tile; road, field and yard from unwarped distances (straight field edges, smooth roads).
- Ramp positions for the classes the spec gives no formula for: forest floor `(patch−.3)·1.6 + (fine−.5)·.3` (moss); rock `.55 + (fine−.5)·.7 + (patch−.5)·.4`, a moss cap where the slope is under 0.45, lichen on 3% of texels; bed `.3 + fine·.5`; ford pebble `.5 + (fine−.5)·.6` + per-texel jag; road `.5 + (fine−.5)·.4`, ruts −0.45, pale edges +0.3; yard `.5 + (fine−.5)·.5 + (patch−.5)·.3`; field stripes ± `(fine−.5)·.15`, furrow 0.09 tiles wide.
- "Near a road" (+0.14) is within 1 tile of the centre line. Worn verges (`dirt[2]`) fade out over 0.14 tiles past the road's edge, dithered. The dry ramp's threshold is dithered over ±0.02 so dry patches stipple at their edge.
- Pebble shores: grass on tiles within 2 of water whose ground lies below `WATER_Y + 0.1 ± 0.04`, so the pebbles follow the real waterline (the relief's carve makes the visible water wider than the river's two tiles).
- Tufts: the light blade (`grass[4]`) in the cell's x 1..2 / y 0..1, its dark root (`grass[0]`) at (x−1, y+1), which is straight below it on screen. Flowers: the 25% neighbour is the patch east or south. Tufts and flowers only on plain grass (not verges or shores).
- Bare earth, bog, snow and scree are left out: MEADOW has them off (9), and their ramps are incomplete in the spec.
**Why:** the spec lists the classes and ramps; these fill the gaps so the picture matches the references.
**Rejected:** pebble shores by distance to water tiles (they ended up under the water).
**Spec:** 03-land.md §4 "Ground painting", §6; 02-look.md §4.

### Scatter details
**Decision:**
- `lone: [.018, .05]` is [chance per open tile inside the map, outside it], of oak. "Otherwise a bush, otherwise a small stone" uses one roll: bush 0.07, small stone 0.05 after the lone-tree chance.
- Oak: trunk 0.5s, crown radius r = 0.36s, blobs (in r over the trunk top) two low at (±0.47, 0.15–0.2) ×0.7, a broad middle at 0.62 ×(1.12, 0.86, 1.12), two small on top at ~1.15 ×0.58; ramp steps base+0/+0/+1/+2/+2 with base 0–2 per tree. Pine: each tier turned a further 0.45 rad so the seven sides don't line up; the upper two tiers one needle step lighter. Bushes centred 0.45s above the ground, stones 0.2s, with ±0.25 rad tilt and a random yaw. Trunks, posts and walls sink 0.04 into the ground.
- Fences: posts every ~0.36 (rounded to fit the side), two rails per gap between posts, each following the slope. Hedge bushes are scale 0.2–0.28. Haystacks stand at least 0.4 inside the field. Poplars and dry-stone walls are built for lands that use them (not MEADOW).
- Crowns and bushes use an icosahedron with smooth normals (the vertex direction), so they read round under the toon ramp.
**Why:** the spec gives the shapes and sizes, not the layout inside a tree or the bush/stone rates; these match the references' density.
**Rejected:** flat-faced crowns (gem-like); full random rotation of stones (the 0.7 flattening ends up sideways).
**Spec:** 03-land.md §4 "Scatter", §5, §6; 02-look.md §9 "Round, not boxy".

### Water
**Decision:** the bed band mixes the painted ground texel (bed, pebble or shore) 72% toward the shallow colour; band edges are dithered over ±0.03 of depth; glints are 0.8% of 1/6-tile cells, drifting (0.11, 0.05) tiles/s, only past the bed band. The heights are a float32 texture read with `texelFetch` on the terrain mesh's own two triangles per cell, instead of a linearly filtered half-float. Time comes from `View.time`, advanced by the frame loop, never by `render()`.
**Why:** depth then matches the drawn ground exactly at the shore; a frozen clock keeps the shimmer test meaningful.
**Rejected:** a half-float with bilinear filtering (the shoreline disagreed with the mesh by up to a few hundredths).
**Spec:** 03-land.md §5 "Water".

### Fog details
**Decision:** `greyed(c, k) = mix(c, luma(c), k)` with the pause pass's luma weights (0.3, 0.55, 0.15). Every dither (fog levels, haze steps, water bands) is indexed by the world-fixed pixel `floor(gl_FragCoord) + uOrigin`. `patchFog(material, {surface, speckle, coat})` lives in `web/src/view/fog.ts`; `setFog(levels)` takes one byte per tile (0/1/2); until sight is simulated everything is in sight. `__v.fog('bands' | 'ring' | 'sight')` shows the three levels.
**Why:** the spec names `greyed` without defining it; the luma weights are the ones the look already uses.
**Rejected:** a separate luma (Rec. 709) for the fog only.
**Spec:** 02-look.md §3 "Fog of war"; 03-land.md §8.

### Pixel-stable land: surfaces rebuilt from the world-fixed pixel
**Decision:** every land material rebuilds its surface point instead of trusting interpolated varyings:
1. The pixel `W = floor(gl_FragCoord) + uOrigin` always looks down the same world ray. The terrain intersects that ray with its own triangle's plane (corner heights by `texelFetch`), and takes its texel, its vertex normal (interpolated at that point from a normal texture), its shadow lookup and its depth (`gl_FragDepth`, exact because the camera sits on a fixed plane, D-06) from that point. The water does the same on the plane `y = WATER_Y`.
2. Instanced shapes carry their whole triangle on every vertex (`faceGeometry`), so the face plane, the point, the barycentric normal, the speckle cell (`floor(P·11)`, as the spec says), the coat and the depth are the same in every frame.
3. Every land vertex's clip position is rebuilt from its world-fixed screen coordinates (RIGHT/UP ×s), rounded to 1/256 art pixel, minus the whole-pixel origin, so the rasterizer covers and interpolates identically in every frame.
4. The camera's rotation is a constant quaternion (`lookAt` rebuilt it each frame with wobbling last bits); instance colours are `flat`; the hemisphere light's weight is rounded to 1/1024 (far below one colour step).
`camera.ts` only gained `export` on `BACK`, which the exact depth needs.
**Why (measured with `__v.shimmer`, 80 steps of 0.1 px):** with the painted texture on plain interpolation, every changed frame had strays: up to 14–19 pixels at zoom 7 and 16, 3–4 at zoom 34. Step by step: exact texel lookup 19→3; screen-locked speckle and exact depth → 1-pixel, 1/255 lighting flips; constant rotation, exact normals and the clip snap → **0 stray frames** at zooms 7, 16 and 34 in four directions on keep/48, and in two directions on ford/48 and keep/80. The cost is under 1 ms per frame on the M5 at art resolution.
**Rejected:** accepting the strays (D-06 accepted 9 single pixels on flat ground; the painted land had hundreds); speckle on screen-space blocks (stable, but not world-fixed as the spec asks).
**Spec:** 02-look.md §2 "Pixel snapping", §9 "Never shimmer"; DECISIONS.md D-06.

### Land off the main thread
**Decision:** the land is made in a module Web Worker (`web/src/view/land-worker.ts`) by default, loading the same WASM and transferring every buffer; `?land=inline` makes it on the main thread. Inline and worker results are byte-identical (checked on keep/48, ford/48, keep/80), and the native and WASM hashes match a golden file (`crates/sim-wasm/tests/land.hashes`, run natively by `cargo test` and in WASM by `npm run test:wasm`). Keeping 4 ready lands and requesting the next one ahead (§10) waits for the campaign.
**Why (measured):** native `make` 15.5 / 21.4 / 27.4 ms for widths 48 / 64 / 80; WASM in the browser 18 / 25 / 33 ms warm, 20 / 28 / 38 ms in a cold worker (37–44 ms round trip). Under load (other jobs at load average 50–90) the same WASM took 46 / 62 / 82 ms, and the very first call on a cold page 163 ms; an old phone is 5–10× slower still. §10 asks for the worker from day one.
**Rejected:** inline only (over 50 ms for 64 and 80 under load, and the spec measured 1.4–2.3 s on an old phone).
**Spec:** 03-land.md §10; docs/engine/ENGINE.md "Performance" 2.

## D-09 | 2026-10-28 | Day 2 part B: the men, banners and the units lab (02-look §5–§6, §10; 04-battle §9)
**Summary:**
- `web/src/view/figures/` builds every soldier from about 50 vertex-painted parts, one InstancedMesh per part shared by all figures, posed procedurally into the instance buffers.
- Banners and shields come from generated atlases. `web/labs/units.html` (dev only) shows every kind for both teams.
- The game drives it from day 3 through `Figures.update({ men, banners, … })`.
- Built by a delegated agent; checked again before commit.
**Gate (measured):**
- **Standing figures, no flicker at any of the 9 zooms:**
  - My re-check, fresh lab load with defaults (banners on), an odd-sized target 371×355: camera drift right and figure drift up, at zooms 7–34, gave 0 bad frames in every case.
  - My first re-check had found 500–900 stray pixels on the banners at zooms ≤ 18, and a few on the men at 34.
  - The cause: on odd-sized targets the exact clip put vertices exactly on pixel centres.
  - The fix: an offset of half a pixel plus 1/1024 in `figures/material.ts`. The agent confirmed odd, even and mixed sizes.
**Open:**
- Moving figures' shadows re-rasterise at their edges: up to 616 px at zoom 34. It needs a shadow projection aligned to the art-pixel grid in `light.ts`.
- Cloth (capes, tails, banners) waves even with no wind, by the spec's formulas.
- Beasts are not drawn yet (`registerRig('beast', …)` is the hook). Petrified, torches, dust and the other peoples' outfits are not built.
- 500 marching men take 5.7 ms to pose. Caching standing poses and lower detail far away are the next levers.
- The figures need the fog patch wired through `figureShaderHooks` (day 3).

# Decisions: day 2 part B, the figures (men, horses, banners)

Choices made where docs/spec/02-look.md §5–§6 and 04-battle.md §9 are silent or ambiguous. Code: web/src/view/figures/,
lab: web/labs/units.html + web/src/labs/units/.

### Body proportions: hip, shoulder and neck heights
**Decision:** read the part table as the pelvis 0.2 above the ground, the shoulder joints 0.232 and the base of the head 0.25 above the pelvis (part units, × FIG 1.32 = tiles). A standing man is then ≈ 0.57 part units ≈ 0.75 tiles to the top of the head: 10–12 art px tall at zoom 16–19 and 22 px at zoom 34.
**Why:** with everything measured from the ground the torso (h 0.19) would not fit under the shoulders; measured from the pelvis, arms of 0.11 + 0.118 hang to the hip as they should. The result matches the spec's "9–12 art px at the default zoom" and the reference muster screenshot (int-1-muster, px = 2: 11 art px at zoom 16). It is taller than the spec's "≈ 0.55 tiles" and "19 px at zoom 34"; the zoom-34 reference (d89) shows 27 px, so the spec's two statements already disagree and the default-zoom one was kept.
**Rejected:** scaling the parts down to hit 0.55 tiles (would change FIG or the part table, both spec constants).
**Spec:** 02-look.md §5 "Scale".

### One paint attribute: shade or fixed colour per vertex
**Decision:** every part carries a vec4 `color` attribute: rgb, and alpha = how much the instance dye applies. `shade(k)` = (k, k, k, 1) multiplies the dye; a fixed hex = (r, g, b, 0) ignores it. One merged part may mix both (the torso's leather belt and pouch, the saddle on the dyed saddle cloth, the cape's gold clasps).
**Why:** the spec's "shade(k) or a fixed hex drawn with a white instance colour" otherwise forces a part to be all-dyed or all-fixed, which would split torso, cape and saddle into extra meshes.
**Rejected:** separate meshes for belts, clasps and saddles (more draw calls for 2–3 triangles each).
**Spec:** 02-look.md §5 "Colour".

### Helmets, hoods and caps are dyed parts
**Decision:** headgear is dyed (instance colour = steel #a3abb3, the captain's gold #e8c34a, the hood's team [1], the cap's smock). Belt and pouch leather is the saddle's #5a3a22; every soldier's hose is the shield kind's #4e4a46 except the captain's (team [0]).
**Why:** one kettle-hat mesh serves steel and gold. The spec names the hose and belt colours only for some kinds.
**Rejected:** a gold and a steel copy of every helmet.
**Spec:** 02-look.md §4 "Men", §5 "Kinds".

### Thin things swell in the vertex shader, to at least 1.2 art px
**Decision:** thin parts (spear, lance, pitchfork, sword, bow, string, reins, arrow, banner pole, crossbar, chevrons) store each vertex's centreline point (`aAxis`) and swell about it by a per-instance factor `max(1, 0.6 px / zoom / (radius × tiles per unit))`. In the shadow pass they swell to at least one shadow-map texel of radius (`FigureFrame.shadowTexel`).
**Why:** "never under 1 art pixel across". A 6-sided rod's narrowest silhouette is cos 30° of its diameter, so 1.2 px keeps it ≥ 1.04 px and gap-free at every angle. Scaling the instance matrix instead would bend the bow's arc and lengthen crossguards. Without the shadow-pass swell, spears and banner poles cast dashed shadows; a stroke narrower than about two shadow texels breaks up when sampled.
**Rejected:** per-zoom geometry; a fixed 1-pixel line pass.
**Spec:** 02-look.md §5 "Minimum thickness and detail", §9.

### Exact clip: figures land on the art-pixel grid to the sub-pixel
**Decision:** instance matrices are relative to the figure's snapped root; the root's world position is a per-instance `aRoot`. The vertex shader puts the clip position at the root's whole pixel plus the relative offset rounded to 1/256 px, minus the camera's whole-pixel origin (`FigureFrame.screen`). Light, depth and shadows use root + relative as usual. The hemisphere light's weight is rounded to 1/1024.
**Why (measured, units lab, both teams, 60 steps of 0.1 px):** with three's own projection the camera drift left 1–9 flipped pixels in 2–6 frames at zooms 7, 9, 19, 23, 28 and 34 (thin edges whose vertices sat on a pixel boundary). With the exact clip: 0 at all 9 zooms, for camera drift and for figure drift. A pose now draws the same picture wherever the figure stands, a whole pixel over. This is the same idea as the land's exact clip (out/decisions-land.md), done root-relative so that moving figures are exact too.
**Also:** the window position is (pixel − origin) + half the target, and that half ends in .5 when the target's width or height (aw + 2, ah + 2) is odd. Then every whole-pixel point fell exactly on a pixel centre. A 1:1 far gonfalon put a texel edge on every sample, so 500–900 px of banner flickered per step at zooms ≤ 18. Men's vertices sat on the rasterizer's rounding boundaries, giving 3–7 stray px at zoom 34. The clip now subtracts that half pixel and adds 1/1024 px, so every vertex sits strictly inside a 1/256 cell for any target size and either GPU rounding mode. The first measurement hid this because the lab windows happened to be even-sized. Re-measured at 701×431, 700×430, 701×430 and 674×414: 0 bad frames at all 9 zooms (camera and figure drift, right and up, banners on).
**Rejected:** rounding world-space screen positions only (exact for camera pans, but a moving figure's float error still flips vertices near a 1/512 boundary); three's projection (the flips above).
**Spec:** 02-look.md §2 "Figures are snapped too", §9 "Never shimmer".

### Figures cast shadows but do not receive them
**Decision:** `Figures` parts cast shadows; `receiveShadow` is off by default (an option).
**Why:** a moving figure crosses a fixed shadow map, and self-shadowing would add speckle that changes with every whole-pixel step.
**Rejected:** receiving by default.
**Spec:** 02-look.md §1 (shadows), §9.

### Facing and stances
**Decision:**
- Facing: the sim's facing; when the man moves at 0.35 tiles/s or less and an aim is given, the aim. Turning is capped at 7 rad/s; a `Rig` may set its own rate (beasts 2.2).
- "hip −0.3" and "hip −0.5, turn −0.8" are the pelvis's and the torso's yaw from the facing, in radians. The archer's head turns 75% of the way back to the target.
- Feet: the spear stance puts the left foot 0.24 forward and the right 0.14 back; the archer's stance is 0.22 / −0.2 apart.
- Stances apply while `engaged` (the company fights).
**Why:** the sim already reports its direction of motion as its facing. The archer must look along his arrow.
**Spec:** 02-look.md §5 "Stances", 04-battle.md §9 "Facing".

### Weapons in hand
**Decision:**
- **Spear, pitchfork and couched lance:** carried upright at the right hand, the spear's butt 0.015 above the ground. When engaged they are levelled along the facing, 0.1 rad down. The grip is at the right hip and the left hand 0.16 further along the shaft, both hands by two-bone IK. A thrust moves the grip 0.15 × v along the shaft and the body lunges 0.06 × max(0, v). The lance uses the spear thrust table.
- **Sword:** carried low when not engaged (with half the walk swing on the shoulder), on guard when engaged, the blow table on each strike. The mounted captain keeps the guard. The blade angle is measured from the forearm's perpendicular: blade 0 points forward when the arm hangs.
- **Shield:** strapped on the left forearm, facing 0.95 rad to the left-front, or 0.25 (square to the foe) when engaged with the arm raised (0.75, 0.95). The iron boss is on the back as the grip, so it never covers the device.
- **Bow:** hangs from the left hand when not engaged. When shooting, the bow faces the aim, which is lifted 0.22 rad. Each strike looses: the string hand flies back for 0.1 s, returns to nock by 0.45 s, draws to the cheek by 0.9 s and holds. The string runs tip → hand → tip and the arrow shows while drawing.
**Why:** the spec gives the tables and families but not the carry, the grip or the draw cycle. The strike lean (sin pulse × 0.18) is for melee blows only, since an archer does not lunge.
**Spec:** 02-look.md §5 "Strike", "Blows", "Stances"; 04-battle.md §9 "Strikes".

### Death
**Decision:** the man rolls about his facing axis toward a side chosen by hash32(id). The root is lifted 0.1 part units (0.085 for a horse and rider) so the body rests on the ground rather than in it. The arms are abducted 1.25 rad and the head bowed. A horse rolls with its rider. The dead keep helmet and shield and drop held weapons; a corpse's cape and tail hang without wind.
**Why:** "roll fall·π/2·side·0.92" names the roll. Dropping spears keeps a field of corpses from bristling with poles.
**Spec:** 02-look.md §5 "Death".

### Rank marks accumulate, and the kinds' looks by rank
**Decision:**
- Rank 2 wears both the team [3] plume and the team [1] cape; rank 3 wears the gold plume and the cape.
- Folk carry no marks. The captain always has his red plume and a team [1] cape.
- **Levy (the freed):** rank 0 is bare-headed in the man's own village smock (SMOCKS by hash); rank 1 adds a soft cap in the smock colour; rank 2 and up is dyed team [2] with a steel nasal helm. A recruit looks rank 0 whatever his rank.
- The levy's banner is linen until rank 2.
**Why:** the rank table lists one mark per rank; a rank-3 man losing the cape he had at rank 2 would read as a demotion.
**Spec:** 02-look.md §5 "Kinds", "Rank marks".

### Folk, the captain and the horse kind
**Decision:**
- **Folk:** a child when hash32(id, 11) % 4 = 0 (×0.72); a woman when hash32(id, 12) is even (gown to the ankle, kerchief in linen #d2c29c); half the men wear a soft cap. The bundle is linen #a8946c tied with #6b5a40.
- **The captain** is always mounted on the general's charger at ×1.08, with a sword (04-battle.md §5 "The captain's ride").
- **The horse kind:** a rider in a kettle hat with a lance and a team [2] pennant; coat by hash32(id); one rein from the left hand to the muzzle.
- Beards: types 0–4 by id % 7, none for 5 and 6, and none for women and children.
**Spec:** 02-look.md §4 "Men", §5 "Kinds", "Horse".

### Horse legs
**Decision:** knee and hock both fold the lower leg backward. The gallop rise and head nod apply only while moving; a standing horse is still.
**Spec:** 02-look.md §5 "Horse gait".

### Cloth details
**Decision:**
- The hanging bend's `gust` is `0.5 + 0.5·sin(0.83t + 0.37·phase)`, and its `z` is the vertex's lateral coordinate in part units.
- A flag's normals follow its wave at 30% only, so the device stays flat-lit.
- The per-instance `aCloth` of the spec is the first three components of `aExtra` (wind, phase, length).
**Why:** with full normals the toon ramp striped every banner in light and dark bands.
**Note:** the spec's formulas move cloth even at zero wind. A standing man is still, but capes, tails and pennants sway slightly at rest. Measured with the clock running and nobody moving, at most 4 px change per frame at zoom 16 and 10 px at zoom 34 (rank 0), and up to 30 px with every man caped. Banners wave every frame.
**Spec:** 02-look.md §5 "Cloth".

### Banner cloth: size, a far gonfalon, and square to the camera
**Decision:**
- The cloth is 2/3 tile wide (the 16:26 gonfalon is then 1.08 tall) on the spec's 1.6 / 1.95 pole.
- The card is turned square to the camera: tilted by the 30° pitch, its foot toward the viewer, pushed 0.06 out from the pole.
- When the 16×26 texture would be minified (zoom × grow × 2/3 < 16 px, i.e. zooms 7–23), a far 12×20 gonfalon is drawn instead. Its layout: a 5×6 fleur at (3, 3), 3–5 px kind marks centred at row 12, a 4-row swallowtail, 2 dark columns. At zoom 18 and below it lands exactly one texel per art pixel, because the banner then grows to 18 px per tile.
**Why:** nearest-neighbour minification of the 16×26 fleur dropped columns and turned it into a "$" at zoom 16. Facing the camera removes the cos 30° vertical squash. The reference screenshots show banners square to the viewer, about as wide as a man is tall.
**Rejected:** a 16-px-wide cloth at 18 px per tile (0.89 × 1.44 tiles, hanging almost to the ground on a 1.6 pole); mipmaps (blend colours, not pixel art).
**Spec:** 02-look.md §6.

### Gonfalon layout
**Decision:**
- The fold row is row 1 (row 2 on the captain's, under its gold ring).
- Columns 12–14 are ramp[1], inside the ramp[0] outline.
- The swallowtail is a V cut across the bottom 5 rows.
- The kind mark is centred on column 7 at row 15. The marks (ASCII in atlas.ts) are: spear a leaf blade, shield a heater, bow an arc with an arrow, horseshoe, and crown.
**Spec:** 02-look.md §6 "The banner texture".

### Chevrons and honour ribbons are geometry
**Decision:**
- Rank chevrons are gold ^ strokes stacked above the crossbar (0.14 apart, up to 3), in the cloth's plane.
- Honour ribbons (up to 6, cream and red in turn) hang 0.32 from the crossbar's ends, outside the cloth, alternating left and right; the crossbar is 0.9 wide.
**Why:** the reference shows rank chevrons as a gold peak over the crossbar, and the 16×26 texture has no free rows for them once the emblem and mark are placed.
**Spec:** 02-look.md §5 "Rank marks", §6.

### Tatter stages
**Decision:** stage 0 pristine; 1 the tail is eaten (2–3 rows, ragged); 2 adds the fly torn (a ragged bite out of the right edge); 3 adds two or three holes beside the device (never within a pixel of it) and the grime. Holes and tears have 4 variants per look, picked by hash32 of the squad id.
**Spec:** 02-look.md §6.

### Banner lean and shake
**Decision:** lean = clamp((0.55 − heart)/0.3, 0, 1) × 0.42 rad, in the screen plane, away from where the company faces on screen. Below heart 0.3 a shake of sin(23t)·0.08 rad is added.
**Why:** the spec's lean is unbounded (1.8 at heart 0), so it reads as a factor. "Near breaking" needs a number; companies break at morale 22 (04-battle.md §5).
**Spec:** 02-look.md §6 "Pole and behaviour".

### Beasts: an extension point
**Decision:** men and horses are built in. Any other body registers a `Rig` (`registerRig('beast', { pose, stride, turn })`), which gets the shared part pool and the per-man state. Until a rig exists, beasts are skipped with a single console warning.
**Spec:** 02-look.md §5, 04-battle.md §9.

### Units lab specifics
**Decision:**
- The lab's focus is a little off the art lattice, at (32.0137, 31.9781).
- It faces everyone west (π) by default, toward the viewer's lower left as in the references.
- Its plain ground looks shadows up at the exact point of each pixel's ray, as the game's land does.
- `flicker()` freezes the clock unless asked.
- For figure drift, it predicts the frame as the previous frame's figure pixels (those differing from a render of the empty field) moved by the figures' own whole-pixel step over the current empty field; any other pixel counts.
**Why:** a focus exactly on the lattice puts every figure on a .5 tie at the same step, and float noise then rounds neighbours differently. That is a lab artefact which game positions never hit.
**Spec:** 02-look.md §10.

### Triangle budget and posing cost
**Decision:** about 1,350 triangles per man on foot and 2,800 per rider and horse (ball segment counts trimmed to what reads at 6–22 px). Posing allocates nothing per man.
**Why (measured, 500 men, 1/6 of them riders, all marching, M5 Pro):** 860 k triangles (the original's heavy battle hit its limit at 1.5 M); `Figures.update` takes 5.7 ms p50 and 7.3 ms p90. When they stand still nothing is uploaded, but posing still takes 4.9 ms. Before the trim: 1.0 M triangles and 8.5 ms.
**Next levers:** cache the matrices of men whose inputs did not change; fewer segments below zoom 16; drop face, hand and toe detail far away.
**Spec:** 02-look.md §8 "Known limit".

## D-11 | 2026-10-28 | Day 3: the battle rules (04-battle §2–§8; 03-land §3c, §8; 08-orders §10 step 1)
**Summary:**
- 04-battle §2–§8 run headless at 30 Hz:
  - slots, the cohesion gate, the momentum model with a neighbour grid
  - the army following its captain in column and line, and `planFront`
  - melee with charges, homing arrows, height effects
  - morale, routing, last stands, commanders, saving the last men, recall, the captain's ride
  - site capture, outcomes, fog per team, and a night hook
- New: the open-field map (`MapKind::Field`, mirrored).
- Bots `garrison`, `general0–2`, `commander`, `charge` and `idle` see through their own fog and give orders through the queue.
- The harness gained `sweep` and bot sessions.
- The order model is shaped for 08-orders: `Order` plus `Squad.how` (stance, pace, shape, priority); stances read in one place; target choice through one priority score; a per-squad queue with triggers. Field works and the held deployment are hooks only.
- Built by a delegated agent; checked again before commit.
**Gates:** the agent's sweeps, and mine on fresh seeds 5000+ (release harness).
- **Standing reversals:** 0.0003–0.018 per man-second (gate < 0.1).
- **State flips:** 5.0–8.5 per squad-minute (gate < 10).
- **Mindless charge vs general1:** the agent: 49.7% over 300 seeds. Mine: 40.0% over 60. Band 20–60%.
- **Every battle ends.**
- **Mirror matches:** 49.5% (the spec's "team 1 wins 55%" is gone).
- **Doing nothing wins 1.7% (1 of 60), against a 0% target: missed.** Each such win is a real defensive win, an idle line beating a weak attack, so it is not forced to zero with a special case.
- **Determinism:** the golden replay is regenerated and now includes the garrison bot; native and WASM agree. A field replay is added (native). The map and land golden hashes are unchanged.
**Open:**
- Doing nothing wins every keep battle at dawn, by the spec's night rule. Day 4's relief from the east must change that.
- The keep commander wins 93% against today's stand-in garrison; the real garrisons come on day 5.
- `Deed::Move` needs `pace`.
- The general is barely better than the charge.
- No drake breath or myth rules yet.

# Day 3 (the battle): choices the spec left open

Code: crates/sim/src/battle/, crates/sim/src/bots/, crates/sim/src/map/field.rs, crates/harness/src/sweep.rs.
Spec: docs/spec/04-battle.md §2–§8, 03-land.md §1, §3c, §8; 08-orders.md §1–§7, §10 step 1.

### The order model: a verb, its modifiers, and a queue with triggers
**Decision:**
- `Squad.order: Order` is the verb. The spec's variants keep their shape (`Hold{face}`, `Move{to,via,fight,face}`, `Attack{target,via}`, `Take{site,via}`). New ones: `Follow` (with the army at its station), `Guard{ward}` (escort a company or the captain), `Recall{until}`, `Retreat` (the commander saving the last men), `Ride` (the captain's ride).
- `Squad.how: How` holds the modifiers every verb shares: `stance`, `pursue`, `pace`, `shape`, `files`, `spacing`, `priority`. `How::default()` is 04-battle.md's behaviour exactly. `Squad.files` stays the effective frontage; it is set from `how.files` whenever an order becomes current.
- `Squad.queue: Vec<Pending { order, how, when, queued }>`. A trigger (`When`) is one of `Done`, `Signal{n}`, `After{s}`, `EnemyNear{at,r}`, `Breaks{id}`, `CaptainAttacked`, `Night`.
  - The pending order is released at the start of step 2 when its trigger holds. Triggers read only sim state.
  - A signal is `(n, tick)` in `Battle.signals[team]`; it releases orders queued at or before that tick.
  - A direct order (any Deed) clears the queue; a released pending order keeps the rest.
- `Done` means:
  - a move has arrived (it turns into a hold)
  - a take holds its site
  - an attack's target is gone, or routs while the stance doesn't pursue
  - a recall has reached its station
  - a retreat has reached home
- The entry points for the order-language pass are `Battle::queue_order`, `raise_signal` and `command`. They are `pub(crate)`, so nothing outside the sim can change a battle except through Commands.

**Why:** 08-orders.md §10 step 1, and the coordinator's steer. New modifiers never touch the verbs, and the view's existing matches on the four spec variants keep working.
**Rejected:** a variant per combination (`AttackKind`, `MoveDefensive`…); putting `fight` and `via` into `How` (it would break the existing variant shapes the view codes against).
**Spec:** 08-orders.md §1, §5, §6; 04-battle.md §1 "Orders".

### What the order-language pass must expose as Deeds
**Decision:** the Deeds and fields to add in the contracts (I did not edit them):
- `Deed::Move/Attack/Take/Hold`: an optional `how: How`, a JSON object `{stance, pursue, pace, shape, files, spacing, priority}`. Every field is optional and serde-defaulted. This one field carries stance, pace (walk/quick/double time), formation (shape/files/spacing) and target priority for every verb.
- Every deed: optional `when: When` (`{"t":"done"}`, `{"t":"signal","n":1}`, `{"t":"after","s":5}`, `{"t":"enemynear","at":P,"r":3}`, `{"t":"breaks","id":2}`, `{"t":"captainattacked"}`, `{"t":"night"}`), and `then: bool` (append to the queue rather than replace it).
- `Who` selectors resolve in code to several `Who::Squad`. A multi-squad target needs `Who::Squads{ids}`, or one Deed per squad in the same tick.
- New verbs:
  - `Deed::Guard{who, ward}` → `Order::Guard` (follow/escort, "cover", screen)
  - `Deed::Signal{n}` → `raise_signal` ("now!")
  - `Deed::Form{who, how}`: change the modifiers without changing the verb
  - `Deed::Stance{who, stance}`: hold fire, fire at will, pursue/stop
  - `Deed::Face{who, face}`
  - `Deed::Withdraw{who}`: fall back facing the enemy. This would be `Move` with a new `Facing::Fixed` mode, which the anchor already has.
  - `Deed::Reserve/Commit`
  - `Deed::Advance` (§8): clears `Battle.held[team]`
  - `Deed::Build{who, work, at, face}` (§7): fills `Battle.works`
- `Deed::Attack` with a target selector: `priority` in `how` lets "their archers" resolve in the sim, through `Battle::priority_score`, rather than in the brain.

**Why:** the model is ready for each of these; only the contract stands between them and the queue.
**Spec:** 08-orders.md §2–§7, §10 step 2.

### Stances, read in one place
**Decision:** `Battle::rules(i) -> Rules { engage, seek, reach_only, fire, pursue, leash, skirmish, no_charge }` is the only place that reads the order, state and stance.
- **Normal:** the spec.
- **Aggressive:** engage and seek +2 tiles, and pursue.
- **Defensive:** melee engages only within reach + 1, and never leaves its post by more than 3 (the leash clamps the anchor's drift and the men's targets).
- **HoldFire:** archers don't loose; men strike only what is in reach.
- **Skirmish:** ranged men step back from melee foes within 3.5.
- **Passive:** never engages as a squad; anyone touched still fights back.
- The numbers are in `StanceTune`.

**Why:** steer item 2. These are cheap enough to build now.
**Spec:** 08-orders.md §5 "stance".

### The default stance does not pursue
**Decision:** in the Normal stance a routing foe is struck only while he is in reach (the routing penalty of +0.6 still applies). A squad never takes a router as its threat, and an attack order completes when its target routs. Aggressive, or `pursue: Some(true)`, chases.
**Why:** the first sweeps had men chasing routers across the map at catchup ×1.4. A general's captain followed a fleeing horseman to the enemy captain and duelled him, and 28 of 30 general-vs-general battles ended with a captain dead in about 40 s. With this, captain deaths fell to about 1–3 in 100.
**Rejected:** only the +0.6 score (it does not stop a chase); a fixed chase distance.
**Spec:** 04-battle.md §5 "Target choice"; 08-orders.md §3 "pursue · stop".

### Target priority, scored once
**Decision:** `Battle::priority_score(team, from, foe, priority)` returns the distance less 12 (`priority_bonus`) for a favoured foe, or scales with the named measure (morale share for shaken; men × worth for weakest or strongest). Squads use it to choose a threat, men use it as a per-foe-squad offset in their target score, and bots use it through `bots::pick`. The priorities are nearest, kind, ranged, shaken, weakest, strongest, commander, attacking-X and one squad.
**Why:** steer item 3: one scoring function for the squad, its men and the bots.
**Spec:** 08-orders.md §4, §5.

### Shapes and spacing
**Decision:** `Shape::Block` is §3a. `Wedge` puts 2r+1 men in rank r, with the point at the anchor. `Ring` puts men round a circle of radius `max(gap, n·gap/2π)` behind the anchor, with the commander in the middle. `How::spacing` multiplies the file gap (loose 1.6, tight 0.85 in `MoveTune`).
**Why:** steer item 5. Slots are a pure function, so this was cheap.
**Spec:** 08-orders.md §3 "form".

### Men think on the tick's starting positions, then move together
**Decision:** step 3 decides every man (target, blow, velocity) from the positions at the start of the tick, then integrates all positions. Blows land together in step 4, as the spec says.
**Why:** it removes the stepping-order bias the spec lists as an open issue ("team 1 won about 55%"). Measured over 600 seeds of the mirror match: general1 vs general1 49.5%, charge vs charge 49.7%.
**Rejected:** alternating which side steps first.
**Spec:** 04-battle.md §1 tick order, §10 "Open issue".

### Slot 0 is the commander's for the company's life
**Decision:** a company created with a commander (named, not the captain) keeps slot 0 for him. Rank slots are 1..n. When he falls, slot 0 stays empty. Gaps among rank slots are filled by the man holding the highest slot, lowest gap first.
**Why:** "slots are fixed per man". Re-indexing after his fall would move everybody.
**Spec:** 04-battle.md §3a.

### A fighting block follows its brawl without creeping back
**Decision:** a melee anchor drifts by (men's centroid − their slots' centroid)·dt·2, not toward the men's centroid. When the fight ends the block re-forms where its men stand: the anchor jumps by that offset once.
**Why:** the anchor is the front rank's centre, so drifting toward the men's centroid pulled the block back by half its depth every tick. Without the re-forming, men walked back up to 1.6 tiles to their old slots when a fight ended.
**Spec:** 04-battle.md §5 "When engaged".

### A company on the move that isn't fighting strikes in passing
**Decision:** a man stands at a combat point only when his company fights or stands idle. A marching company that doesn't fight, a retreat, a recall, or a hurt captain riding out all keep walking and strike whoever is in reach, as the spec says of a recall.
**Why:** otherwise a hurt captain, his man in reach of foes, never rode away. Captains fell in most battles.
**Spec:** 04-battle.md §5 "Recall", "Target choice".

### SETTLE's dead zone holds only for a man nobody pushes
**Decision:** for a man with any neighbour within `ra+rb`, the arrive term `(d − 0.025)·ARRIVE` applies down to d = 0.025 rather than SETTLE 0.05. SETTLE, ARRIVE, RESPONSE and SEPARATION keep the spec's values.
**Why:** where two companies' slots overlap slightly (a guard company on the general at the keep, a captain trailing among his bows), the push held a man just outside SETTLE. There the arrive term jumps from 0 to 0.2 t/s, and he flipped direction every tick. Commander vs garrison measured 0.098 standing reversals/s/man, and one field seed 0.79. After the change: 0.0068 and 0.001–0.017 everywhere. The term is continuous, so a pushed man comes to rest against the push. A man nobody pushes behaves exactly as in the spec.
**Rejected:** a bigger SETTLE, or SETTLE hysteresis (a slower cycle with a larger swing).
**Spec:** 04-battle.md §3c.

### Men walk strict lines
**Decision:** men test their straight line with `path::line_clear`: every 0.25 tile is checked, and no diagonal step between two blocked tiles is allowed (A*'s own rule). Their personal routes are pulled with that test (`path::route_clear`). Anchors keep `line_walkable` and `route`.
**Why:** a man moves one axis at a time. The 0.35-step test let his line cut a corner between two rocks, and he wedged there. His company's cohesion gate then stopped it for good; one general stood still for 300 s.
**Spec:** 03-land.md §1 "Pathfinding"; 04-battle.md §3c "Path", "Collision".

### Who may engage
**Decision:**
- A `Move` engages only with `fight` (arrival turns it into a hold, which engages).
- A follower engages when it stands at its station (outside the march hysteresis) or when its army's march fights.
- Retreat and recall never engage.
- The ride engages unless the captain is out of the fight, or is still riding round to a flank.

**Why:** "not a march without fight". The earlier `fight || not marching` let a moving squad that was already fighting keep fighting for ever.
**Spec:** 04-battle.md §5 "Engagement".

### Defending the captain applies to every line company near him
**Decision:** any melee company that isn't horse (not retreating or recalling) within 7 of its captain turns on a foe within 3 of him, whatever its order. An escort guards its ward within `guard_r` = 5.
**Why:** the text says "line squads within 7 tiles of the captain". Limiting it to followers let a lone enemy captain hunt a general through his own army.
**Spec:** 04-battle.md §3d "Defending the captain".

### The captain's ride
**Decision:**
- **Leaving the fight** (below 50% hp, or 20% lost within 2 s, with hp sampled every 0.5 s) and returning (at 80%) are checked before engagement. Checking them inside the ride never ran while he was engaged.
- **The trail point** is 3.5 behind the foot line, or behind the rearmost of his own companies in his lane, clear by 1.4. It is continuous, so he never chases a jumping point, and it stays 4 tiles off the map's sides.
- **His pace** follows the followers' law `min(top, 0.4 + 0.9·d)`, so he keeps a steady lag. He sets off again once the line is 2 ahead (`trail_slack`), and stops within 0.3.
- **Riding out** goes 5 behind the army, away from `threatPoint` (mid-fight, companies face every way), at full pace while foes are in reach.
- **He never picks the enemy captain** as the foe to ride at. A duel would decide the battle on one fight.

**Why:** each was found in traces: captains duelling, stop-go every half second, standing inside the bows, riding onto his own edge and withdrawing.
**Spec:** 04-battle.md §5 "The captain's ride".

### Morale details
**Decision:**
- Attackers are foe men in melee contact (gap ≤ reach) with a man of the squad.
- "With no attackers" also needs no foe to be targeting the squad: being shot at stops the +5/s.
- The flank angle is measured from the company's centroid, not its front-rank anchor.
- Outnumbered compares attackers with men alive.
- A steady commander's company counts itself among the companies within 5.
- A rally keeps the company's place with the army (a hold, not detached).
- A last-stand company never routs again.

**Why:** the anchor is at the front rank, so measured from it, attackers on the side of the second rank read as 106°.
**Spec:** 04-battle.md §5 "Morale", "Routing".

### The enemy-commander rules
**Decision:** −25 on his fall, the 0.5 pull-out share and −12 on pulling out apply to team 1, and to both sides of an open-field battle.
**Why:** the spec writes them for "enemy" commanders; a mirror match must be fair.
**Spec:** 04-battle.md §5 "Commanders on the field".

### Home, fleeing and the last stand
**Decision:**
- A routing company is home within 1.5 of its retreat point, or within 1.5 of its own map edge.
- At home it leaves the map, except the defenders of a keep or town, who make a last stand at morale 30 (Rally event with b = 1).
- The fled are `alive = false` with `died_at = Tick::MAX`.
- A saved company (its commander pulling out the last men) retreats the same way. Defenders hold at the keep.
- The men left are counted with the commander.

**Why:** the view tells fled from fallen by `died_at`.
**Spec:** 04-battle.md §5 "Routing", "Saving the last men".

### Capture
**Decision:** a site's capture weight is 1 per company with a living, non-routing man within 1.8, and 3 for the captain. Progress belongs to one team, resets when another team starts capturing, persists while nobody stands there, and freezes while contested.
**Why:** "the captain weighs 3" reads as companies. By men, one company would take the keep in 3 s.
**Spec:** 04-battle.md §8 "Holdfast".

### Outcomes and the night
**Decision:**
- If both captains fall in the same tick, the higher men × worth wins.
- Withdrawal applies to team 0 in every battle, and to both sides on the open field.
- "No defenders" means no team-1 company is left on the field (the general is not counted).
- If both sides break in the same tick on the field, men × worth decides.
- **Night hook** for campaign battles (keep, town, ford): the dusk bell at 80% of `300 s × w/48`, then night (`night = true`: sight ×0.6, and the garrison attacks the nearest foe it sees). Dawn comes 70 s later, and the attacker wins if his captain lives.
- `Battle::time_limit()` gives each type's limit. The relief from the east, the torches and the ford's own win come on day 4.

**Why:** the spec's night rule, without the day-4 content.
**Spec:** 04-battle.md §8.

### The default and field setups
**Decision:**
- The keep's garrison (3 levy companies, D-05) gets its general: a Captain named GENERAL at the keep, added after the companies so their ids stay 5–7.
- `Setup::field()` puts the same four companies on both sides (GRIM, MAUL, ROOK, FANG facing WIL, ODA, REN, BORS), each side with a captain. Team 1's stations are mirrored left↔right.
- `Setup::for_map(kind)` chooses the setup. `Setup` gains `general` and `mirror`; `Company` gains `way` and `freed`.

**Why:**
- The garrison bot's "general rides at the threat" needs a general.
- The open field is mirror-symmetric, not rotation-symmetric. With rotated stations, team 1's horse took the other wing, and the mirror match measured 40/60 over 100 seeds.
**Spec:** 04-battle.md §7, §8; 01-flow.md §8.

### The open field
**Decision:**
- Blobs are centred in x ∈ [8, W/2), with y and sizes as on the assault map. Anything blobbed into the east half is overwritten by the mirror.
- There are `max(1, round(0.8·area))` hill pairs, at x ∈ [7 + r, W/2 − 1 − r], and a centre hill with chance 0.5. They use relief's own stream.
- The road runs through x = 0.5, W/4, W/2, 3W/4, W − 0.5 at y = mid + (0, 2, 3, 2, 0). It is rasterised 4-connected on the west half, then mirrored, and is also handed to the land as `roads`.
- There are `round(1.5·area)` farm pairs, at least 4 from the road.
- Deploy is at x = 6 and W − 6; retreat at the edges.
- Assault and ford generation are untouched (relief was only split into `hills` + `heights`). The land golden and the keep fixture's map hash are unchanged.

**Why:** the spec gives counts per half and leaves placement open; 4-connected roads avoid corner-only joins.
**Spec:** 03-land.md §3c.

### Arrows, events and ranks
**Decision:**
- An arrow whose target falls is lost.
- Volley: at most one per company per `interval·0.85`.
- Charge: at most one per company per 3 s.
- Hit: `b = attacker kind | charge << 8`.
- CommanderFall for team 0 and FoeCommanderFall for team 1 (`b = team`), each followed by BannerFall (b = 1).
- BannerFall (b = 0) when a company is destroyed or leaves the map.
- Kills are counted per company; rank-ups between battles are the campaign's (day 5).

**Why:** event rates the sound can use; the spec gives no rates.
**Spec:** contracts `EventCode`; 04-battle.md §2 ranks.

### Sight
**Decision:** a squad sees from its men's centroid. Its spread is the farthest man from that centroid. The squad and site circles are stamped on tile centres. Fog starts with a stamp at tick 0.
**Spec:** 03-land.md §8.

### Bots
**Decision:**
- **Thinking:** the garrison every 1.5 s; the general every 2.4/1.5/1.0 s; charge and commander every 1 s (commander as general1).
- **"Only if it differs":** a deed is dropped when the squad's current order already matches it. A move matches within 1 tile, or a hold standing within 1 tile of its point.
- **Charge:** every company attacks the nearest foe it sees, or marches on the enemy's deploy point with fight. Once a foe is seen, the army attacks, which puts the captain on his ride. Mindless, but the captain rides with his men. Before this the charge won 6.7% of field battles; the captain's aura and blade belong to "everyone attacks".
- **General:**
  - It remembers foes it saw for 25 s (`memory_s`, as the garrison does). Its front stops 8 short of the enemy, beyond sight; without memory it never made contact again.
  - With no line companies left, its bows lead.
  - Horse go round a flank point 6 to the side of their prey.
  - Skill 2 keeps the captain away from the nearest foe and 4 off the edges until 80% hp, then rides again.
- **Commander:** general1 that also sends the nearest company to take the keep when no foe it sees is within 6 of it.
- **Garrison sallies:** they stand in a `line_spots` line. "Everyone at the slowest's pace" needs a `pace` on `Deed::Move` (see the Deeds above).

**Why:** traces of each failure.
**Spec:** 04-battle.md §7; 01-flow.md §8.

### The sweep's metrics
**Decision:**
- **Standing reversals:** a man counts while his squad has been Idle for at least 1 s and he has no target. A reversal is two consecutive tick displacements faster than 0.05 tiles/s with a negative dot product. The rate is per man-second standing. The sweep also prints the count over every idle man, settled or not.
- **State flips:** Marching↔Idle per squad, the captain included, per squad-minute on the field.
- **Share of men fighting:** men in contact or shooting, over men alive, averaged from the first blow to the end.

**Why:** one turn per man the instant a fight ends is a change of direction, not the shiver the gate measures. The strict count is printed too, so nothing hides.
**Spec:** 00-start-here.md §A5.

### Replays may name bots; the golden fixture runs one
**Decision:**
- `Replay.bots: [{team, bot}]` re-runs deterministic bots with the replay (they are not logged). `harness play <s> new … --us/--them` uses it.
- `crates/sim/tests/fixtures/replay.json` now has the garrison bot on team 1, so the WASM test checks bot thinking against the native golden without touching sim-wasm.
- `fixtures/field.json` (charge vs general2 with a drawn front) is checked natively.

**Spec:** 01-flow.md §8; DECISIONS.md D-05.

### Hooks for field works and the held deployment
**Decision:**
- `Battle.works: Vec<Work { id, kind: Stakes|Barricade|Bridge|Watchtower, team, at, face, built, hp }>` is empty.
- Movement asks `walkable()` (→ `work_blocks`), blows ask `work_stakes` (charge lost, chargeTaken ×0.4), arrows ask `work_cover`, and sight asks `work_sight`. All are neutral now.
- `Battle.held[team]` stops every company's anchor except the captain's (08-orders.md §8 "held before contact").

**Why:** steer follow-up. They plug in without touching the rules.
**Spec:** 08-orders.md §7, §8.

## D-12 | 2026-10-28 | Day 3: the battle on screen (ENGINE.md boundary; 04-battle §1, §9)
**Summary:**
- `crates/sim-wasm` packs zero-copy per-frame buffers (`frame.rs`) for soldiers, squads, events and fog, and drives the bots.
- `web/src/battle/` holds the 30 Hz accumulator with slow-time, builds the figure and banner records from the buffers, and hooks the fog into figures. The camera follows the captain.
- `?pilot=1` plays a whole battle. The contracts gain aim, engaged, hit and death ticks, and a richer squad record.
- Built by a delegated agent; checked again before commit.
**Measured:**
- **Frame time:** 1.8–4.1 ms p50 for 76–194 men (bench with GPU sync).
- **Sim cost:** 0.011–0.038 ms per tick.
- **Shimmer:** 0 bad frames at zooms 7, 16 and 34, except 2–5 of 80 frames with one pixel off by 1/255 in dense melee at zoom 34 (figure normals and the hemisphere light).
**Open:**
- **Men stand in the drawn river and on crags (D-08).** Clearly visible in battle shots; fix before the demo.
- A company inside a wood is hidden by its trees.
- The blight-men are drawn as human levy under red banners, and the enemy general like our captain. The Wardens needs a visible blight (D-02).
- The recruit bit, night torches, sound and the end-of-battle flow are for day 4.

# Decisions: day 3, the battle on the game page (view side)

Choices made where the spec is silent, for the live battle view: `crates/sim-wasm/src/{lib,frame,compat}.rs`,
`web/src/battle/*`, `web/src/input/battle-keys.ts`, and the contract additions in `contracts.rs` / `contracts.ts`.

### The packed buffers are interleaved records, refilled by an explicit `sync()`
**Decision:** soldier k's f32 field F is `f32[k·F32_FIELDS + F]` (the u32 bits, the strike counter and the hit/death ticks are separate arrays, one entry per soldier). The view calls `sync()` once per frame after stepping, then `drain_events()`, then `Views.refresh()`. The buffers are reserved at battle start (soldiers `max(1024, 2n)`, squads `max(128, 2n)`, events 4,096); if one outgrows its reserve it moves and `layout()` is bumped, and `Views.refresh()` re-creates every view when `memory.buffer` or `layout()` changes.
**Why:** a frame steps 0–2 ticks (more under ×2 or a fast-forward); packing once per frame instead of at the end of every `step` costs nothing on idle frames. One record per soldier is how the constants `X = 0 … HP = 4` read. Checking only `memory.buffer` (the old `Views`) misses a Vec that reallocated without the memory growing.
**Rejected:** separate f32 arrays per field (true struct-of-arrays: more pointers to pass, no gain for a 200-man loop); packing at the end of `step` (wasted on fast-forwards).
**Spec:** docs/engine/ENGINE.md "The boundary"; contracts `soldier_buf`, `squad_buf`.

### Contract additions: aim, engaged, hit and death ticks, squad bits, event stride
**Decision:**
- `soldier_buf`: `AIM_X`, `AIM_Y` (where the man's target stands; NaN when he has none), so `F32_FIELDS = 7`; bit 28 of the u32, `engaged` (in contact or shooting this tick); a third u32 array of `TICK_FIELDS = 2` per soldier, `HIT_AT`, `DIED_AT`, with `NEVER = u32::MAX` (the sim's `Tick::MAX`).
- `squad_buf`: the f32 field indices are named; the u32 keeps `state | detached<<8` and adds kind (bits 9–12), team (13), rank (14–15), full (16–23) and men alive (24–31).
- `EVENT_WORDS = 6`.
**Why:** the figures need the aim for archers and for a standing man's turn (04-battle.md §9 priority 3), and the hit flash and the topple need ages that come from the sim, never a view timer. A banner needs its company's kind, team, rank, full size and losses (tatters), which the squad record lacked.
**Spec:** 04-battle.md §9; 02-look.md §6.

### FACE is resolved in the sim wrapper, in §9's order; the aim is the sim's target
**Decision:** FACE = the direction of the man's velocity when his pace is over 0.35 tiles/s, else the direction of his target (`Soldier::target`, a soldier index), else his company's facing. AIM is the target's position. A breathing beast facing its target (priority 1) waits for beasts. The figures still turn at 7 rad/s and use the aim themselves when slow.
**Why:** one place applies the spec's priority, from the sim's own choice of foe; the figure layer's rule (aim when slow, else the given face) agrees with it.
**Rejected:** (before the sim had targets) the nearest enemy in reach, found by the wrapper: it disagreed with whom the man actually struck.
**Spec:** 04-battle.md §5 "Target choice per man", §9 "Facing".

### Hit and death ages from the sim's ticks; men who left the field are not drawn
**Decision:** a tick number means "during that tick"; the age is `(tick − 1 − at)/30 + acc` seconds, where `tick` is the ticks stepped so far and `acc` the accumulator's remainder (so a hit shows its white for the full 0.1 s, starting 0–1/30 s in). A man not alive whose `died_at` is never left the field with his fleeing company: he is not drawn (no corpse). After a fast-forward (`__v.ff`) the figures are advanced by one second at once, so topples are done and blows over.
**Why:** 04-battle.md §9: animations come from simulation events, never a timer of the view's own; and "the dead stay where they fell", which a man who walked off the map did not do.
**Spec:** 04-battle.md §9 "Hit flash", "The dead stay"; 02-look.md §5 "Death".

### The guard stance: the company fights, or the man is in contact
**Decision:** `ManRecord.engaged` (the guard, levelled spear and shooting stances) is set while his company's state is Fighting or while he himself is engaged (in contact or shooting this tick).
**Why:** the figure layer reads it as "his company is fighting"; a man struck while his company still marches should raise his guard too.
**Spec:** 02-look.md §5 "Stances".

### Banners stand by the commander, eased like a man
**Decision:** a company's banner stands 0.3 tiles to its commander's left (the left of the company's facing) while he lives, else at the middle of its living men; it eases toward that spot by 1 − e^(−16·dt) as men do, and snaps when it first appears. No banner for a fled or destroyed company or one with no men left; a routing company's banner is passed with `routing` (the figure layer hides it). Heart = morale ÷ max morale. The player's levy carry linen until rank 2 (out/decisions-figures.md).
**Why:** BannerRecord asks for "the anchor or the bearer"; the anchor is the middle of the front rank, where a pole would stand among the spears. Beside the commander, behind the ranks, the banner marks the company and never runs through a man. Without easing it stepped at 30 Hz.
**Rejected:** the anchor; the pole exactly on the commander (it ran through his head).
**Spec:** 02-look.md §6 "Pole and behaviour"; 04-battle.md §5 "Commanders on the field".

### Enemies and the dead are hidden on the CPU; the fog's colour is a figure shader hook
**Decision:** each frame the records leave out every enemy (alive or dead), every corpse, and every enemy banner whose tile is not in sight (fog byte 2); our living men and banners are always drawn. A hook in `figureShaderHooks` passes the figure's root (x, z) as a flat varying and runs the land's `fogApply` on the final colour, so a drawn figure takes the same dithered dusk and night levels and the haze past the map's edge. The fog is read at the root, so a man is never split between two levels.
**Why:** "Enemy units are simply hidden outside sight": a whole man disappears, never half of one at a tile edge, and the hidden men cost no posing. The shader hook was the open item of D-08/D-09.
**Rejected:** discarding fragments outside sight (cuts men in half at the edge, still poses them); the per-pixel world position for the fog level (a man at a boundary stippled across his height).
**Spec:** 02-look.md §3 "Fog of war"; DECISIONS.md D-08 "Open", D-09 "Open".

### Figures get exact depth too
**Decision:** the same hook sets each figure vertex's depth to the exact `(p·VIEW + BACK − NEAR)/(FAR − NEAR)` of its world point (root + relative), leaving the exact clip's x and y alone.
**Why (measured with `__v.shimmer` on a frozen battle, keep/48 seed 4, 60 steps of 0.1 px):** through the camera's matrices the depth wobbled in its last bits as the view panned; where a hoof met a slope the land (which writes exact depth) and the horse took turns at one pixel: 4 bad frames of 1 pixel at zoom 16, 0 with the figures hidden. With exact depth: 0 bad frames at zooms 7, 16 and 34, right and up, 80 steps each.
**Left open:** in a dense melee at zoom 34, one pixel flips by 1/255 in 2–5 frames of 80. It is the hemisphere light: with its intensity set to 0 the flips vanish. The figures' interpolated normal lands either side of the 1/1024 rounding step of the hemisphere weight (out/decisions-figures.md); the fix is an exact or flat normal for that term in `figures/material.ts`.
**Spec:** 02-look.md §9 "Never shimmer"; DECISIONS.md D-06 (the fixed camera plane).

### The camera follows the captain; zooming does not stop it
**Decision:** each frame the focus eases toward our captain's sim position at rate 3 (`easeTo`) while following. A drag that moves, or a key pan, stops it; F (and `__v.follow()`) starts it again. The wheel and +/− zoom keep following. At battle start the focus is put on the captain at once; after a fast-forward too.
**Why:** the spec says "until the player pans"; zooming toward the cursor and then easing back to the captain reads as the camera being held, not lost.
**Rejected:** zoom also ending the follow (a zoom-in to watch the captain's company would then need an F).
**Spec:** 02-look.md §2 "Controls"; 01-flow.md §2 "Camera follow".

### Pause and ×2 are keys now; pause freezes every clock
**Decision:** Space or P pauses: the sim stops, the pause grey is on, and the cloth and water clocks stand still too (dt 0 for the figures). X toggles ×2. `slow` eases toward 0.35 for 0.9 s (real time) after one of our commanders falls and 0.7 s after an enemy's (the CommanderFall event, by the squad's team; FoeCommanderFall counts as an enemy's), and toward 0.3 while `clock.drawing` is set (day 4's input sets it). A frame steps at most 12 ticks; a longer hitch is dropped.
**Why:** the accumulator is this module's; the keys need no marks. The spec gives "0.35 for 0.9 s … and 0.7 s after an enemy commander falls": the 0.7 is read as the duration, with the same 0.35.
**Rejected:** cloth waving on in pause (the pause would not be a still picture to read, and the shimmer test needs a still one).
**Spec:** 04-battle.md §1 "Fixed tick"; 01-flow.md §2 "Pause and keys".

### The light is the clock, in steps of 1/256
**Decision:** `dayT = battle seconds / daylight`, rounded down to 1/256, where daylight is the sim's `time_limit()` (field: 360 s × width/48), less the 70 s of night on the other maps (300 s × width/48).
**Why:** 02-look.md §3 makes t "battle time / time limit", with night after the day runs out (04-battle.md §8). The sun's shadow camera re-fits whenever t changes (D-06), so a continuous t would re-fit it every frame and crawl every shadow edge; at 1/256 it re-fits every 1.2–2 s by an amount far below a pixel for most shadows.
**Rejected:** a fixed noon (no clock at all); a continuous t (shadow crawl).
**Spec:** 02-look.md §3; 04-battle.md §8 "Battle time in a campaign".

### Bots run inside the WASM step; who plays whom
**Decision:** `Battle.set_bot(team, kind)` keeps one of the sim's bots per side in the wrapper (`BotKind::parse`, `Bot::new`); `step(n)` asks each to think before every tick and queues its commands through `apply`, as the sim's own `Replay` does. The enemy plays `garrison` on keep and town maps and `general1` on the others (ford, field) unless `?enemy=` says otherwise; our side has no bot unless `?pilot=1` or `__v.pilot()` gives it the `commander`.
**Why:** the spec's bots think every tick through the order queue; doing it inside `step` keeps a fast-forward one WASM call.
**Spec:** 04-battle.md §7; 01-flow.md §8 "Bots".

### `?army=big`: nine companies a side
**Decision:** our side: 3 spear, 2 shield, 2 bow, 2 horse (all with commanders) and the captain. The enemy on a held place (keep, town, ford): 5 levy, 2 spear, 2 archer without commanders, plus the map's own general; on the open field the same nine kinds as ours, named, mirrored round their general. Built in the wrapper (`Battle.muster(seed, map_json, army)`) on `Setup::for_map`.
**Why:** the performance gate asks for 4–9 companies a side; the muster that picks armies is day 5.
**Spec:** 01-flow.md §5 `?army=big`.

### Measuring: `__v.perf()` and `__v.bench()`
**Decision:** the frame loop times the sim step, the record build, the figures' update and the render submission; `__v.bench({frames, dt, w, h})` runs frames back to back at a given window size and waits for the GPU after each (a 1-pixel read), so it also measures when the page gets no animation frames (a hidden pane).
**Why:** CPU stage times alone hide the GPU; the pane the agent drives is often hidden, where requestAnimationFrame does not run.
**Spec:** 01-flow.md §8 "Performance".

## D-13 | 2026-10-28 | The drawn ground agrees with the rules' tiles: no men in the river or up a crag
**Decision:** the §3d relief still shapes the land with its masks, but each half-tile height sample now checks which tiles it actually touches (1, 2 or 4):
- A crag rises only from samples wholly on rock.
- Dry ground (passable, not a ford) never sinks under the water.
- A sample on the edge between water or a ford and dry ground sits just above the waterline (+0.02).

Fords stay shallow water that men wade, on the ford's own tiles.
**Why:** the masks spread about a tile past their tiles. Water carved into dry ground beside the river, and crags lifted the open ground beside the rock, so men walking where the rules allow were drawn standing in the river or half-way up a crag (D-08, D-12). Measured over 48 maps (keep, town, ford and field, seeds 1–12), 290,275 samples inside dry tiles:
- **Before:** 5,450 under the water and 1,315 on a crag's slope.
- **After:** 0 and 0. The new test `dry_ground_is_drawn_dry_and_flat_by_crags` holds it.

The river now draws at the rules' width, and crags stand as steep blocks on their own rock.
**Effect on the rules:** heights feed range, melee and sight, so the golden hashes (replay, field, land) are regenerated deliberately; native and WASM agree.
- **Gates re-run:** charge vs general1 47.0% over 300 seeds; jitter 0.016 per man-second and 7.0 flips per squad-minute.
- **Doing nothing** still wins 0% against general0, 1.0% against general1 and 0.3% against general2 (300 seeds each), as in D-11.
**Rejected:** making the tiles follow the drawn relief (it would widen the rules' river and move every path); hiding the problem in the view by lowering the water plane.
**Spec:** 03-land.md §3d step 3.

## D-14 | 2026-10-28 | The enemy is a blight in the rules: units as data, drakes, trolls, the broodlord
**Summary:**
- Units are now data: a kind plus named stat overrides (`Tune::units`).
- The blight: blight-men (levy stats); trolls with the `impact` blow and cleave; drakes with §5's breath and hunt exactly; and a broodlord in place of the captain-like general.
- Every map kind's enemy is a blight army (`Setup::field`, `Setup::default`). `Setup::mirror` keeps day 3's human field for regression.
- Bots use the spec's breather quarry scores.
- Built by a delegated agent; checked again before commit.
**Measured** (my sweep, seeds 9000+, 200 each):
- **Charge vs general1:** 22.0% (band 20–60%; the agent saw 23–27%).
- **Commander vs general1:** 27.5%.
- **Keep, commander vs garrison:** 48.0% (was a 93% walkover).
- **Jitter:** within the gates.
- **Doing nothing vs general1: 12.0% — gate missed** (the agent saw 4–6%). A standing line with archers breaks a blight that has no missiles, and the general throws itself at it.
**Open:**
- **The idle miss and the weak bots**, for day 5's balance with the campaign garrisons. Smarter blight tactics against a static line: flank with drakes, hold out of bow range. Possibly a blight missile unit.
- The broodlord rarely joins the fight, and drake bites are rare.

# Decisions: the blight in the sim (04-battle §2, §3a, §5, §7, §8; 00-start-here §A2, §A4)

Code: `crates/sim/src/units.rs`, `crates/sim/src/tune.rs` (`Units`, `BreathTune`, `PackTune`, `QuarryTune`,
`CombatTune::impact_slack`), `crates/sim/src/battle/{men,combat,anchor,setup,mod,front,order,replay}.rs`,
`crates/sim/src/bots/{mod,general,garrison}.rs`, `crates/harness/src/{sweep,main,draw}.rs`.

### Units are data: a base kind plus a map of stat overrides, merged by name
**Decision:**
- `Tune::units` holds one `UnitSpec { kind, stats }` per unit. `stats` is a JSON object merged onto the kind's `KindSpec` (`Tune::unit_spec`), so `spec = {...KINDS[kind], ...stats}`. A JSON override can retune a stat (`{"units":{"troll":{"stats":{"hp":44}}}}`) or re-base a unit (`"kind"`).
- `KindSpec` is `deny_unknown_fields`, and `Tune::with_override` builds every unit, so a misspelt stat is an error rather than a silent no-op.
- `Company` carries a `unit`, and its kind comes from the table. `Company::new(kind, name)` still works: it takes the kind's own unit, and a bare `Kind::Beast` is a drake, as the beast kind's placeholder stats were.
- `Squad.unit` sits beside `Squad.kind`. The rules read only the merged spec and the base kind (a broodlord is his side's `Captain`, trolls and drakes are `Beast`, blight-men are `Levy`). The view draws by `unit`.
- New stats: `breath` (the harm of one jet; a breather hunts), `pack` (§3a's pack formation; packs take the wings), `impact` (seconds from a blow's start to its landing).

**Why:** §2 "a unit merges partial overrides onto its kind", and "every new rule is a stat in KindSpec, never an `if (unit.id == …)`". Merging by name means a new stat needs no second partial struct to keep in step.
**Rejected:**
- A parallel `KindOver` struct of `Option` fields: it doubles every new stat.
- A `Kind` per unit: the kind is the rules' class, and the view packs it in 4 bits.

**Spec:** 04-battle.md §2 "Unit overrides", "Rule for adding units".

### The units table
**Decision:** where the spec gives a number it is used. Chosen values are marked (chosen).

| unit | kind | stats |
|---|---|---|
| blightman | levy | none: levy stats (§A4) |
| troll | beast | 3 men (chosen, within §2's "3–4 per company" for myth beasts), hp 30, damage 4.5, interval 2.2, speed 1.3, arrowTaken 0.7, charge 1, chargeTaken 1, steadiness 0.6, cost 90, radius 0.7, frontage 3, turn 1.1, **impact 0.5 s** (all chosen); cleaves as a beast |
| drake | beast | **hp 18, bite (damage) 3.4, breath 6, pack** (spec); 3 men (spec 3–4); interval 3.2 (the cycle's period); speed 2.2, arrowTaken 1.0 (wild, not armoured), steadiness 0.8, radius 0.55, turn 2.5, cost 90 (chosen); chargeTaken 0.7 from the beast base |
| broodlord | captain | the captain's base (never routes, regenerates out of contact) with hp 150, damage 5, interval 1.2, speed 2.4, arrowTaken 0.6, charge 1.5, radius 0.8, **beast**, turn 1.6, impact 0.35 (all chosen) |

**Why:**
- Balance, measured below. Four trolls at hp 40 and damage 6, with packs of four drakes, won 97% of field battles against the mindless charge.
- A pack of three: one pack of four routed a 12-man spear company in a single breath cycle (4 dead, 30 morale scorched).
- Drakes at 2.2 are quicker than men, as a predator should be. A drake turns at 2.5 rad/s, not the elephant's 1.1 (§10: the turning "looked weird").

**Rejected:**
- Trolls at 4 per company with hp 24 and damage 3.6, or hp 40 and damage 6.
- Drakes at 1.6 (charge 36%, idle 3.5–6%: no better on idle).
- Braver beasts (steadiness 0.4 and 0.3): charge 19.5%.

**Spec:** 04-battle.md §2 "Norse drakes", "Myth creatures"; 00-start-here.md §A4.

### The broodlord is his side's captain, and the enemy-commander rules hold for him
**Decision:**
- He stands in the general's place: kind `Captain`, unit `Broodlord`. So the army follows him, he rides (§5), the garrison "rides at the threat" with him, and his fall decides the battle (§8 `CaptainFell`, checked first, as for the human general).
- When team 1's captain falls (the broodlord, or the human general in the mirror), the enemy-commander rules apply as they do to a company's commander: a `FoeCommanderFall` event (a = squad, b = team), then `BannerFall` (b = 1), and every other team-1 company loses 25.
- This applies to team 1 only, so our captain's fall emits exactly what it did on day 3.
- He is named `BROODLORD` for now. The campaign names its broodlords on day 5.

**Why:** the brief: "never routes; a great beast; the enemy-commander fall rules still apply". A captain-kind beast needs no new rule. As a beast, he brings horse terror, bane and cleave.
**Rejected:** a beast kind with a new "commander of the side" flag (it would duplicate every captain rule).
**Spec:** 04-battle.md §5 "Commanders on the field", "The captain's ride"; §8; 00-start-here.md §A2.

### Blight companies have no commanders of their own
**Decision:** blight-men, trolls and drakes are unnamed companies; the broodlord commands them all.
**Why:**
- A commander is soldier 0 with 3× hp standing behind the ranks, striking only who reaches him. That idles a quarter of a three-beast pack.
- The levy garrison of day 3 was unnamed too.

**Rejected:** named blight companies with "save the last men" (to revisit when broodlords become campaign characters, 07-progression).
**Spec:** 04-battle.md §5 "Commanders on the field".

### The setups: the host on the field, the nest at a held place, the human mirror kept
**Decision:**
- `Setup::field()` (the open field): the warband against the host, deployed as an army round the broodlord with mirrored stations. The host is three companies of blight-men (the "swarm"), a troll company and a drake pack. Team 1's ids: broodlord 5, companies 6–10.
- `Setup::default()` (keep, town, ford): the nest stands in a line 2.5 before the keep, each company at its post, with the broodlord on the keep. The nest is the host plus a fourth company of blight-men and a second drake pack. Team 1's ids: companies 5–11, broodlord 12.
- `Setup::mirror()` is day 3's symmetric human field.
- `Setup::named("blight" | "mirror", kind)`, `Replay.setup` (omitted when empty), and `harness sweep/play … --setup`.
- Packs take the wings, at the horse's stations and at the ends of a drawn front (`role`), so they hunt round the flanks.

**Why:**
- With two companies of blight-men, doing nothing on the field won 18% (the line with its archers breaks a thin host).
- A nest the host's size lost 82% to the commander, since a garrison fights piecemeal and one company always guards the keep.
- Measured nests over 200 seeds:

  | nest | commander wins |
  |---|---|
  | 3 blight-men, 1 troll, 2 drakes | 67% |
  | 4 blight-men, 2 trolls, 1 drake | 53% |
  | 4 blight-men, 1 troll, 2 drakes | 49% (chosen) |

**Rejected:** a single composition for both places; a fourth company of blight-men on the field (charge 5–6%).
**Spec:** 00-start-here.md §A2 ("the keep becomes the blight's nest"), §A4; 04-battle.md §3d, §4, §7.

### Drake breath
**Decision:**
- **Pulses.** `ceil(jet/pulse)` = 5 pulses per jet, at 0.4 + k·0.25 s into the cycle. Each deals `breath·(1 + 0.1·rank)/pulses` (1.2), flat: no arrowTaken, bane, height or routing multiplier ("ignoring armour").
- **Scorch.** Each company caught loses `1.6·steadiness` **per pulse**. It is applied in step 4 with the blows.
- **The cone.** It is rooted 1 tile ahead along the drake's heading. Its axis sweeps linearly from −0.3 to +0.3 rad across the 5 pulses. A man is in it when his centre lies within 0.3 rad of the axis and his body's edge within 2.3 of the root. Only foes: no friendly fire.
- **Events.** `Breath` (a = the drake's soldier index, b = 0) fires on the tick the jet starts. Burn hits emit `Hit` with b = `Kind::Beast`. The tail (0.55 s) is the view's.

**Why:** 1.6 is the per-death factor without `100/full`: small and frequent, so it reads as per pulse. A sweep across the pulses reaches every part of the cone once.
**Rejected:**
- Scorch once per jet (1.6 per drake per cycle, hardly felt).
- A sinusoidal sweep.
- Counting a man in the cone by his centre's distance only (big beasts would be missed).

**Spec:** 04-battle.md §5 "Drake breath".

### The hunt
**Decision:**
- **Who hunts.** Each drake hunts on its own; its prey is its `target`. It hunts while its company fights or stands. A company marching without fighting walks, strikes in passing as men do, and drops any cycle.
- **The prey.** It is kept through a cycle while it lives. Between cycles it is kept while within seek·1.3.
- **The next prey.** When a cycle ends, the drake takes the foe man (within seek, 3.2) with the most foes within 1.5 of him. It prefers spots where no pack-mate's prey stood within 1.5 at the tick's start, then the nearest, then the lowest index.
- **The cycle.** It starts on the tick the prey's centre is within 2.4. The drake approaches toward 2.1 from its prey. It holds ground (its goal is where it stands) until 1.85 s. It lunges at 1.6× pace to the men's stand-off (0.92·reach, body to body) until 2.3 s. It bites at 2.3 s if the prey is in reach (with the beast's cleave). It springs back toward 2.1 at 1.6× pace until 3.2 s.
- **Facing.** Through the cycle it turns toward its prey at its turn rate, while its velocity is free, so it can back off facing the prey.

**Why:** the spec's numbers. Reading the pack-mates' prey from the tick's start keeps "no man reads another's choice this tick" (D-11).
**Measured** (`a_drake_rears_breathes_bites_and_springs_back`):
- every jet started 0.4 s after the rear;
- every bite came 2.3 s into the cycle;
- the prey was at most 2.35 away at the rear;
- the drake held ground at 0.05 t/s;
- it sprang back to 1.96 on average.

**Spec:** 04-battle.md §5 "The hunt", §9 "Facing".

### Meeting a drake
**Decision:**
- **Who.** A company whose threat (§5 engagement) is a breathing company.
- **The men.** Every man's goal is clamped within 1 tile of his slot.
- **The anchor.** A melee company's anchor presses forward, instead of drifting with the brawl: toward the nearest drake, at the company's pace through the cohesion gate, until the front rank stands at the stand-off. A defensive leash still clamps it.

**Why:** "men step at most 1 tile from their slots, and the company presses forward as a block."
**Measured:** looseness at most 0.95 while engaged with drakes; the anchor moved 2.3 tiles in 34 press ticks.
**Spec:** 04-battle.md §5 "Meeting a drake".

### Impact blows
**Decision:**
- A blow from a unit with `impact` starts in step 3, and the strike counter turns then, so the view's swing starts.
- It lands in step 4 of the tick `round(impact·30)` later, if both men live and the victim is still within reach + 0.5 (`impact_slack`); otherwise it misses.
- A beast's cleave is reckoned where the blow lands. `Hit` is emitted at the landing.
- Pending blows are `Battle.blows` and are hashed.

**Why:** "the blow lands that many seconds after it starts". Stepping out of a slow blow should be possible, but not by a hair.
**Measured:** 7 of 7 troll blows were timed 15 ticks ahead; 7 landed.
**Spec:** 04-battle.md §5 "Myth rules".

### The pack formation
**Decision:**
- "Files ×1.15" widens the file gap by 1.15; it does not multiply the file count.
- Each rank's two end men stand 0.5 further back.
- Each slot gets a fixed ±0.125 jitter on both axes, from `hash32(seed, squad<<16 | slot, 106/107)`.

**Why:** a file count of 4.6 has no meaning; the ends pushed back make the pack's crescent.
**Spec:** 04-battle.md §3a "Variations".

### Beasts choose their quarry, in the general and in the garrison
**Decision:**
- **Breathers** score `0.5·d − men`, +8 for horse (not a beast), +12 for bane > 1, +3 when braced, −4 when already fighting. Lowest wins, within 24.
- **Braced** means chargeTaken < 1 (spears) and not marching.
- **Trolls** (beasts without breath) go at the nearest foot within 24: the line (melee foot) first, then any foot.
- **The garrison** applies the same rule among the foes within 8 of its threat.
- Blight-men and the broodlord follow the existing rules.

**Why:**
- §7 "Contact". The "within 24" for breathers is chosen from the elephants'.
- "Send trolls at the line" is the brief.

**Spec:** 04-battle.md §7.

### A point off the map is brought inside it before it becomes a goal
**Decision:** `open_near` clamps its point into the map (by the men's edge margin, 0.2) before snapping to an open tile.
**Why:**
- A drawn front's end, with the pack 2.8 + 2 beyond it, fell at y = −4.9.
- `open_near` returned a point more than 4 tiles off the map unchanged. The pack's anchor walked off the map, its men could not follow, and the cohesion gate held the pack there for the rest of the battle.
- This inflated idle-vs-general results with time-outs.
- The human mirror never met it: 100 seeds of charge and idle are identical, row for row, to day 3's harness.

**Spec:** 04-battle.md §3b, §4.

### The harness prints what the blight's rules did
**Decision:**
- `Battle.tally` counts jets, burns (and their harm and kills), scorch, bites, impact blows started, landed and missed, and press ticks. It is not state: it is never read by the rules and not hashed.
- `sweep` prints them per battle, with men lost per side.
- `look` draws each man at his body's size.

**Spec:** AGENTS.md rule 4.

### Target priority by unit
**Decision:** `Priority::Unit { unit }` ("the drakes", "the big ones", "the blight-men") beside `Priority::Kind`.
**Why:** the order language names enemies by unit (08-orders §4); trolls and drakes share a kind.
**Spec:** 08-orders.md §4.

### The golden replays
**Decision:**
- The state hash now includes each squad's unit, each man's breath cycle and the pending blows.
- `replay.json` (the keep, checked in WASM) runs to tick 2700, so native and WASM agree over breath (2 jets, 25 burns), pressing (183 ticks) and impact blows (3 landed).
- `field.json` is the charge against general2 and the blight.
- `mirror.json` is the same replay on `Setup::mirror` (the day-3 human field), checked natively.
- Map and land hashes are unchanged.

**Spec:** DECISIONS.md D-05, D-11.

### Balance with the blight as the enemy (300 seeds unless noted, release harness)
**Decision:** tuned only through the units table and the setups' composition.

| sweep | result |
|---|---|
| field, charge vs general1 | 23.0% (seeds 1–300), 26.7% (5001–5300); vs general2: 23.0% |
| field, commander vs general1 | 27.3% |
| field, idle vs general0 / general1 / general2 | **4.0% / 6.0% / 5.0%: the ~0% target is missed** |
| jitter | 0.002–0.065 standing reversals per man-second (highest: the charge, 0.057 and 0.065); 4.4–7.3 flips per squad-minute (both gates pass on every sweep) |
| keep, commander vs garrison | 54.3% (seeds 1–300), 55.3% (5001–5300), of which 75 and 71 at dawn; town 55.0% over 200 |
| keep, idle vs garrison | 99% (all at dawn: the spec's night rule; the relief from the east comes on day 4) |
| field, mirror, charge vs general1 | 47.0% |
| field, mirror, idle vs general1 | 1.0% |

**Why the idle miss is reported, not forced:**
- Each idle win is the host's five companies all breaking against the standing line while its archers shoot (the host has no missiles), with our archers and captain alive.
- Every lever that took idle under 3% also took the charge under 20%:
  - a fourth company of blight-men: charge 5–6%, idle 1–2%;
  - braver beasts: charge 19.5%, idle 2–4.5%.
- Levers that did not separate the two:
  - drake pace 1.6–2.2;
  - troll stats;
  - the general's reserve (none: charge 12%, idle 5%);
  - the broodlord's ride reach;
  - counting broken companies in the reserve's commit morale.
- No special case was added.

**Rejected:** a host strong enough for idle ≈ 0% (the mindless charge falls out of its band).
**Spec:** 00-start-here.md §A5; DECISIONS.md D-11 gates.

## D-15 | 2026-10-28 | The blight drawn as beasts (02-look §4–§6; 07-progression §8)
**Summary:**
- Blight-men: hunched, ember-eyed, with bone weapons.
- Stone trolls about twice a man's height, with the over-head impact blow.
- Drakes with the full breath cycle timed from the sim, and a dithered flame cone.
- A horned broodlord.
- Ragged hide standards under horned skulls with ember sigils, instead of heraldic red banners.
- The unit id travels per squad in the WASM buffers. The units lab shows both rosters.
- Built by a delegated agent; checked again before commit.
**Checked:** shots of a live battle and the roster read as soldiers against monsters; typecheck, clippy, and WASM = native.
**Flicker:**
- 0 bad frames at zooms 7–19.
- At 23–34, 1–4 pixels change by up to 10/255 in some frames, about the same as the warband on this machine's GPU (D-09 measured 0 on another).
- A banner-cloth flicker at zoom 19 is fixed for both sides.
**Open:**
- Moving figures' shadows (D-09).
- The flame lights nothing at night, and the blight has no torches.
- Trolls overlap at the sim's spacing.

# Decisions: day 3b, the blight on screen (view side)

Choices made where docs/spec is silent, to draw the enemy as a blight of beasts (00-start-here.md §A2, DECISIONS.md D-02)
instead of human levy under heraldry. Code: `web/src/view/figures/{blight,blight-parts}.ts` and changes in `atlas.ts`,
`material.ts`, `outfit.ts`, `rig.ts`, `figures.ts`; `web/src/battle/records.ts`; `crates/sim-wasm/src/{frame,compat,lib}.rs`;
the contracts; the units lab (`web/src/labs/units/*`).

### The unit reaches the view as a second u32 per squad
**Decision:** `squad_buf` gains a second u32 array, one per squad (`Battle.squad_unit_ptr()`, `Views.squadUnit`): bits 0..7
the unit id (`sim::units::Unit::id()`), the rest free. `records.ts` gives every `ManRecord` and `BannerRecord` its `unit`
(`UNIT_ORDER` in contracts.ts).
**Why:** the squad u32 is full (state, detached, kind, team, rank, full, alive) and the soldier u32 has three free bits, too
few for 11 units. Every soldier's unit is his squad's, so one word per squad is enough and costs nothing per man.
**Rejected:** widening the squad u32 to two interleaved words (every `squadU32[j]` read would change); packing the unit in
the soldier word (no room).
**Spec:** docs/engine/ENGINE.md "The boundary"; contracts `squad_buf`.

### The breath cycle's tick, and walking backwards, in the soldier buffers
**Decision:** `soldier_buf` gets `TICK_FIELDS = 3` with `BREATH_AT`, the tick the sim began the drake's breath cycle
(`Soldier::cycle`; `NEVER` when none runs), and bit 29 `backing`: the man walks (pace > 0.2) against his drawn facing.
The view's breath age is `(tick − 1 − at)/30 + acc` like the hit and death ages; the stride runs backwards while backing.
**Why:** 04-battle.md §9: animations come from the sim, never a view timer. The cycle's start (the rear) is earlier than
the `Breath` event (the jet), so the rear plays in time on every cycle, the first included; the event stays in the ring for
sound. "A drake springing back plays its stride in reverse" needs the direction of motion against the facing, which the
packed FACE (facing the prey) no longer carries.
**Rejected:** dating the jet from the `Breath` event in the frame's drain (the first rear could not be shown; it was the
first version, replaced when `Soldier::cycle` landed); a signed SPEED (the banners' wind reads it).
**Spec:** 04-battle.md §5 "Drake breath", §9 "Walk", "Strikes".

### FACE priority 1: a breathing beast faces its prey
**Decision:** in `frame.rs`, a soldier of a company that breathes (`spec.breath > 0`) with a target faces the target,
before the direction of motion. Otherwise §9's order as before.
**Why:** §9 lists it first and D-12 left it "for beasts". The hunt's lunge and spring back keep the head on the prey; with
motion first, a drake springing back would turn its tail to its prey.
**Spec:** 04-battle.md §9 "Facing".

### `?army=big`: the enemy's nine companies are the blight
**Decision:** `muster("big")` fields our nine companies against five companies of blight-men, two troll companies and two
drake packs, without commanders of their own, and the map's broodlord; on every map kind.
**Why:** the old big army was a human garrison or a mirrored human army, the very war between peoples this work removes;
the sim's own setups give the blight's companies no commanders (out/decisions-blight-sim.md).
**Spec:** 01-flow.md §5 `?army=big`; 00-start-here.md §A2, §A4.

### Every enemy is the blight
**Decision:** the body a figure is drawn with (`formOf`) is its unit for the blight's units. An enemy whose unit is a
soldier's (an old setup, the sim's `mirror` regression field) is still the blight: its general the broodlord, its horse
drakes, its beasts trolls, anything else a blight-man (a spear company's with bone spears). A beast on our side is a drake.
**Why:** whatever the sim fields, the screen never shows soldiers in red fighting soldiers in blue.
**Rejected:** drawing team 1's human units as men (the anti-project look).
**Spec:** 00-start-here.md §A2.

### Blight-men
**Decision:** a biped "brute" rig (shared with trolls and the broodlord): a torso pitched 0.6 rad forward over a hump with
bone spurs, a low head with a heavy brow, tusks and swept-back ears thrust forward (it looks ahead again by 0.5 rad), legs
bent at the knee with clawed feet, arms 0.14 + 0.15 long (a man's are 0.11 + 0.118) ending in claws. Scale 1.2: a head
shorter than a man, much broader. Flesh in the blight ramp's two light steps (`#6a3e36`, `#84503f`) by id; rags of hide
(leather and hair browns from 02-look.md §4) round the hips; half wear a hide over the hump. Weapons by id: a bone club
(1/2), a crude iron cleaver (1/3), bare claws (1/6); spear companies bone-tipped spears. Ember eyes and a glowing crack
down the chest. A company's commander (soldier 0) wears an antler crown at ×1.16. Stride 3.6, turn 7 rad/s (men-sized).
The blow: the men's sword table, slower (0.35 s) and wilder (the club wound back over the head).
**Why:** "unmistakably not human soldiers": no tabard, helmet, plume, cape or heraldry; the silhouette is a hunch, long
arms and a jutting head; the ember eyes carry the read down to zoom 9.
**Spec:** 02-look.md §5 (built like the men); 07-progression.md §8 (the blight ramp, the glowing cracks).

### Stone trolls
**Decision:** the brute rig at ×2.3 (about 1.4 tiles to the crown, near twice a man): short thick legs, a massive chest and
hump with stone plates, boulder shoulders, a small head sunk forward with tusks, long arms with great fists. Skin a dark
violet slate (`TROLL` `#4a4650 #5e5966 #77727e`), with glowing cracks on the chest, a shoulder and both forearms. A
tree-limb club (2 in 3) or a boulder maul, carried on the shoulder. Stride 3 (beasts), turn 2.2 rad/s, a slight roll from
foot to foot when walking (never a rise). The blow: the club wound up over the head by 0.8 × impact, slammed down on the
impact (0.5 s, the sim's `units.troll.impact`), held 0.25 s, recovered by 1.05 s; the body leans back in the wind-up and
throws itself into the slam.
**Why:** the spec names stone trolls (mockup "the line and the flood") but no colours. The rock ramp is the land's; a cooler,
darker stone keeps them a unit, not a boulder (02-look.md §4 readability). The sim counts a strike when an impact blow
starts, so the wind-up is visible before the blow lands.
**Rejected:** the land's rock ramp (trolls vanished against crags); a two-handed slam (the hands could not meet on the
haft at these proportions).
**Spec:** 04-battle.md §5 "Myth rules" `impact`; 02-look.md §4.

### The broodlord
**Decision:** the brute rig at ×2.55: backward-kneed legs with hooves, a great chest with an ember heart burst open in it
(hotter while it strikes), a mane over the hump with bone spines, a heavy tail, a bull's skull with forward-sweeping horns
and a second swept-back pair, long arms with bone claws. Flesh `#6a3e36`. It rakes with each arm in turn (strike parity),
raised by 0.7 × impact, down on the impact (0.35 s, `units.broodlord.impact`). Turn 2.2 rad/s.
**Why:** "a great horned beast clearly distinct from our captain": no horse, no gold, no red plume; the largest figure on
the field, with the brightest ember.
**Spec:** 00-start-here.md §A2 (broodlords); 07-progression.md §5.

### Drakes
**Decision:** a quadruped at ×1.4 (pack leader ×1.16 more), about 2.2 tiles nose to tail: a barrel with a paler belly and
bone spines down the back, wings folded along the flanks (a bony arm, an elbow claw, a dark membrane), a three-segment
neck rising in an S, a horned head with a hinged jaw, a six-segment tail drooping behind and swaying with the walk,
forelegs and backward-kneed hind legs with claws, diagonal-pair gait. Hide `#6a3e36` (leaders `#4f3330`); ember seams down
both flanks and every neck segment's throat, ember eyes. Stride 3.4, turn 2.2 rad/s.
The breath, from the cycle's start (e seconds): rear 0–0.4 (neck up and back, forequarters lifted about the hips, forelegs
reaching, jaw ajar, throat hot); jet 0.4–1.6 (blended in over 0.12 s: neck thrust forward and low, jaw wide, the hot maw
showing); its head sweeps from the figure's left to its right across the pulses (0.4 → 1.4 s, ±0.3 rad, as the sim's
pulses sweep `heading + sweep`), held to the jet's end; tail 1.6–2.15 the flame dies; the lunge from 1.85 (bite − 0.45),
jaw wide at 2.12, snapped shut on the bite at 2.3, back by 2.65. The spring back is the sim moving it backwards: the stride
reverses (`backing`).
**Why:** the reference drakes (d89, myths_drakes_night) are about two and a half men long, horned, long-necked; the cycle's
times are 04-battle.md §5's (`BreathTune`).
**Rejected:** scale 1 (a drake the size of a dog at zoom 16).
**Spec:** 04-battle.md §5 "Drake breath", §9; 02-look.md §5 "Animation".

### The flame
**Decision:** one part, a lumpy cone along +x, drawn from the mouth to the far end of the sim's cone (its root 1 tile ahead,
reach 2.3: 3.3 tiles out along `heading + sweep`, at the ground), half-width 2.3 · tan 0.3 = 0.71 at the far end, 0.32 high.
Unlit, opaque, dithered by discard (no alpha blending): density falls toward the far end and the silhouette, colour in the
torch ramp `#d84a1c #f07a22 #ffb23a #ffe07a` by heat (hot at the mouth and the core), licked by two sines of the cloth
clock. The jet's front races out over 0.15 s; in the 0.55 s tail it thins and its near end is eaten away from the mouth.
The dither's 4×4 Bayer cell is anchored at the drake's root pixel, so a whole-pixel move of the camera or the drake moves
the flame's pixels with it, and a frozen clock freezes it. It casts no shadow.
**Why:** "dithered, no alpha blending; flame colours from 02-look §3; pixel-stable". The core is solid and the colour bands
are wide (the dither only widens a band edge by ±0.06), so the jet reads as fire, not a speckled cone.
**Rejected:** screen-anchored dither (crawls across the flame as the camera pans); alpha blending (AGENTS.md).
**Spec:** 04-battle.md §5 "The cone"; 02-look.md §3 "Torches", §9 "See-through only by dither".

### Glowing parts are unlit
**Decision:** eyes, cracks, seams, the broodlord's heart and the totems' eyes are parts drawn their dye unlit (a `glow`
material variant); a blight standard's sigil texels are drawn unlit too (atlas alpha 204: above the 0.5 cut, under 0.9).
The eyes are small balls that swell about their own centres to ≥ 1.2 art px (the thin-part swell), so at zoom 9–16 they
are a 1–2 px ember dot. Eyes and the jet's maw `#f07a22`/`#ffe07a`; cracks and sigil rims `#c84a1c`, sigil cores
`#f07a22`. A corpse's embers go out (the blight's darkest `#3a2a2a`).
**Why:** the ember is the blight's faction note (02-look.md §4: the most saturated thing on screen); lit by the toon ramp
it went dull brown in shade. Orange-red stays clear of our blue and of the gold of honour `#e8c34a`; the yellow flame steps
appear only in the breath and the broodlord's blow, never as a standing mark.
**Spec:** 02-look.md §4 "The readability rule"; 07-progression.md §8 "glowing cracks `#c84a1c`".

### Standards
**Decision:** a blight company carries a standard, not a gonfalon: a ragged hide in the blight ramp (base `#6a3e36`,
mottled and shaded `#4f3330`, rolled top `#84503f`, outline `#3a2a2a`), its sides notched and its foot a fringe of tongues
(both varied by squad id), an ember sigil burnt into it — claws for blight-men, a jagged crack for trolls, a flame for
drakes, a horned eye for the broodlord (the banners' kind mark, 02-look.md §9) — hung from a crooked branch on a crooked
pole under a horned skull with ember eyes (the broodlord's a great bull's skull with ram's curls). Heights 1.6 (blight-men),
2.4 (trolls, drakes: "beasts' +0.8"), 2.75 (the broodlord: the captain's 1.95 + 0.8). It leans and shakes with heart, is
hidden while the company routs and grows when zoomed out, as a banner; it tatters by the same four stages (the fringe is
eaten, the fly torn, holes beside the sigil, grime that spares the glow). Rank is a bone fang per rank hung from the
branch's ends. No honour ribbons.
**Why:** "ragged dark cloth on a crooked pole or antler/bone totem with an ember-glowing sigil (no fleur, no kind marks in
cream)". A pale skull on a dark pole and an ember sigil read at zoom 9 against grass and against our cream-on-blue.
**Spec:** 02-look.md §6.

### Banner cloth on whole texels
**Decision:** every banner and standard cloth is drawn at a whole number of art pixels per texel: below 14 px wide the far
12×20 cloth at exactly 12 px; from 14 to 20 px the near 16×26 at exactly 16 px; above 20 px (zoom 34) its own 2/3 tile.
While it hangs straight, its top-left corner is moved onto a whole pixel, so every pixel centre samples a texel's centre.
Zooms 7–18 are unchanged (they were already 12 px); zoom 19 draws 12 px instead of 12.7, zoom 23 the near cloth at 16 px
(was the far one at 15.3), zoom 28 16 px (was 18.7).
**Why (measured, units lab, camera drift):** at zoom 19 the cloth's texel edges fell within float noise of pixel centres
and 5 px of the drake standard's fringe flipped (Δ146) in 1–2 of 6 frames; the warband's gonfalons did the same (1 px,
Δ28). With whole texels: 0 at zoom 19 for both.
**Rejected:** leaving 19 and 23 at non-integer scales.
**Spec:** 02-look.md §6, §9 "Never shimmer"; DECISIONS.md D-09 "Banner cloth".

### The units lab's blight roster
**Decision:** `__lab.roster('warband' | 'blight' | 'both')` (`?roster=`, default `both`: our warband in front of the
blight). The blight row: blight-men with club (bare back), cleaver (with hide) and claws, a crowned leader, a troll with a
club and one with a maul, a drake and a pack leader, the broodlord, and the four standards; slots are as wide as their
bodies; ids are searched for the look each slot shows. The fight pose breathes the drakes (cycle offset per slot);
`__lab.breath(e)` holds them `e` seconds into their cycle; a `back` pose walks everyone backwards facing ahead. The flicker
check follows the roster's first figure.
**Spec:** 02-look.md §10.

### Left open
- **Residual flicker at zooms 23–34 (1–4 px).** Camera and figure drift on the standing blight roster: 0 bad frames at
  zooms 7–19; at 23 one pixel (Δ10) in 2–3 of 6 frames; at 28–34 one to four pixels, Δ1 (invisible) to Δ16 at 34. The
  warband shows the same class in this browser (zoom 34: up to 5 px, Δ10). The zoom-34 ones were traced to the standard's
  skull where horn and cranium intersect (BONE_DARK horns gave Δ24; the horns are now bone like the skull: Δ10). D-09's
  0 was measured on another GPU; the remaining cause looks like the GPU's interpolation at the absolute pixel position
  (plane equations) deciding near-ties of depth or colour.
- Moving figures' shadows still re-rasterise at their edges (D-09's open item): figure drift with shadows on is 56–260
  bad px per frame on the blight roster as on the warband.
- The flame lights nothing at night (02-look.md §3 lights), and the blight lights no torches.
- A tamed drake on our side (Myths) wears no harness in our colours.
- The blight's hit flash is the men's white (02-look.md §5).

## D-16 | 2026-10-28 | Day 4: the order language in the sim (08-orders §3, §5–§8)
**Summary:** every deed of the order-language contract (D-10, commit 940cb21) is carried out through the Day 3 order model:
- modifiers that stand from order to order: stance, pace, shape, files, pursuit, target priority
- per-company and per-army wait queues with every trigger, released by signals
- guard, screen, charge, withdraw (still facing the foe), regroup, reserve and commit, face, a held start with advance, and several companies at once
- the four field works as data (stakes, barricade, bridge, watchtower), built over time, interruptible, torn down by the blight
`sim::text` has a text command for each, so the harness can play them all. Built by a delegated agent; checked again before commit.
**Verified:**
- 79 tests pass; clippy is clean.
- `harness orders`: 34 of 34 behaviour checks pass, each with printed numbers. For example:
  - hold fire: 61 arrows → 0
  - withdraw: steps back 3.79 tiles still facing within 0.08 rad
  - stakes: charge damage 8.7 → 1.2
  - bridge: the crossing path shrinks from 12 to 6 tiles
  - signal: releases on its tick and not before
- The replay, field, mirror and land goldens are unchanged. A new `orders.json` replay matches natively and in WASM.
- **Gates:** charge vs general1 23.0%; jitter 0.057 and 6.0; keep 56%.
**Open:**
- The view cannot see works, wait queues or the held start yet (they need sim-wasm exposure). Withdrawing men will be drawn by their motion, so facing backwards. A bridge needs a deck under the men.
- "Wait for dawn" cannot fire while a battle ends at dawn.
- On keep seed 4 one drake company deploys off the map (pre-existing).
- To revisit: pace 0.6/1.0/1.4, the works' build times and hp, and the barricade's ×0.5 arrow cover.

# Decisions: the order language in the sim (08-orders §2–§8; DECISIONS.md D-10, D-11)

Code: `crates/sim/src/battle/{order,orders,works,anchor,combat,men,sight,outcome,front,mod,setup,replay,checks}.rs`,
`crates/sim/src/{text,tune}.rs`, `crates/sim/src/bots/{mod,general}.rs`, `crates/harness/src/{main,sweep,draw}.rs`,
`crates/sim/tests/{determinism.rs,fixtures/orders.*}`, `crates/sim-wasm/tests/orders.rs`.
The contract (`crates/sim/src/contracts.rs`) is unchanged.

### A company's way stands until changed
**Decision:**
- `Squad.how` (stance, pursue, pace, shape, files, spacing, priority) is kept from order to order. `Set` merges the contract's `How` into it with no new order; `With{how, deed}` merges it into every squad the inner deed orders (the captain and his followers for an army order).
- Unset fields keep what the company had (the contract's rule). A new shape clears a standing `files` unless `files` comes with it; `loose` and `tight` change only the spacing.
- A drawn front's frontage stays per order (`Squad.files`, reset by every new order), so a front's files never outlive it.
- `Quick` pace is stored as the spec's own pace (`None`).

**Why:** "archers, hold fire" is a standing order until "fire at will"; resetting the way on every order would undo it at the next attack. Keeping the front's files per order keeps every existing replay bit-identical.
**Rejected:** a `How` per order (resets on each command, as on day 3); putting the front's files into the standing way.
**Spec:** 08-orders.md §5; contracts `How`.

### Waiting deeds, signals and triggers
**Decision:**
- `Wait{until, deed}` stores the deed itself (`Pending { deed, when, queued, signalled }`), in the queue of the company it names, or in `Battle.waiting[team]` when it is for the army (or names no company: front, rally, signal, advance). Several companies each wait in their own queue. `With` around a `Wait` is moved inside it, so the modifiers apply when it runs.
- At tick step 2, for each company in id order and then each army, the first waiting deed whose trigger holds is obeyed as if given then, except that it keeps the queues it lands in. At most one per company per tick.
- `Done` is the company's `done` (an army's: its captain's). A plain hold is never done.
- `Signal{n}` marks every waiting deed on signal `n` of that side; they run in that tick's step 2. A signal given before a wait (even in the same tick) does not release it.
- `After{s}`: `(tick − queued)·dt ≥ s`. `EnemyNear{at, r}`: any living foe man within `r` of `at`, from sim state (not the side's fog). `Breaks{squad}`: routing, fled or destroyed. `CaptainAttacked`: the captain hit within the last second. `Nightfall`: `night`. `Dawn`: the new `Battle.dawn`, set when the night ends.
- A direct order clears the queue of every company it orders, and a direct army order (any deed for the army, a front, a rally) clears the army's waiting deeds. `Set`, `Wait`, `Signal`, `Advance` and `Recall` clear nothing.
- A waiting deed is validated when it runs; a refusal then is logged and marked like any other.

**Why:** storing the deed lets any deed wait (army orders included) and keeps one code path for obeying. Signals as flags make "not before the signal" exact.
**Rejected:** converting deeds to orders at queue time (army orders lay out stations when they run); a FIFO where only the first waiting deed can fire (a signal wait would block a later condition).
**Spec:** 08-orders.md §6; D-11 "The order model".
**Note for the voice side:** give the direct order first and the waits after it in the same words ("BORS, hold — on my mark, charge" → `Hold`, then `Wait`), or the direct order clears the wait.

### Several companies at once
**Decision:** `Who::Squads{ids}` is split into one deed per company (through `With` and `Wait`), each obeyed as if alone. Each refused company is refused on its own; the deed as a whole is refused only if every company is.
**Spec:** 08-orders.md §2; contracts `Who::Squads`.

### Who the army is, per verb
**Decision:** naming the captain is naming the army (as on day 3).
- `Set` for the army: the captain and every standing company, with the army or detached ("everyone").
- `Attack`/`Charge` for the army: the line (companies with the army, less the reserve); the captain rides.
- `Guard`/`Screen` for the army: the captain does it and the army follows him. `Withdraw` for the army: every company with it and the captain step back by the captain's step, still with the army. `Regroup` for the army: the army marches back. `Face` for the army: the captain holds facing it and the army's heading aims there.
- `Reserve` and `Build` for the army are refused ("name a company"). `Commit` for the army commits every reserve company.

### Stances, pace, shapes (numbers in `StanceTune`, `OrdersTune`, `MoveTune`)
**Decision:**
- Stances as D-11 (`Battle::rules`): aggressive engage +2, seek +2, pursue; defensive engage ≤ reach + 1 for melee and a leash of 3 from its post; hold fire: no arrows, strike only what is in reach; skirmish: ranged step back from melee foes within 3.5.
- The post a defensive company keeps to is where it was posted by a hold, and travels with its anchor while it is under any other order and not fighting. Its turning to defend the captain is leashed too.
- Skirmish also moves the block: a ranged company in a fight with a melee foe man within 3.5 of any of its men walks its anchor back to 3.5 + 1 from him, facing him, at full pace, ungated. (Day 3 moved only the men, who then walked back to their slots.)
- Pace (chosen): walk 0.6, quick 1.0 (the spec's), double 1.4 of the company's speed. It scales the anchor and, while the company marches out of a fight, its men. The captain's pace counts his followers' pace. Double time with the army forms column at once.
- Shapes: `line` and `shield wall` stand 2 ranks deep (`line_ranks`); `column` is 2 files wide (`column_files`); `wedge` and `square` (the ring) are day 3's; `shield wall` takes the tight spacing; `loose`/`tight` are 1.6/0.85 of the file gap. A drawn front's files come first, then a standing `files`, then the shape's.
- Shapes are geometry only: the spec gives no combat effect for a shield wall or a square.

**Rejected:** a shield-wall arrow bonus (no number in the spec); scaling the men's fighting speed by the pace.
**Spec:** 08-orders.md §3 "form", §5.

### Priorities
**Decision:**
- The contract's `Unit{unit}` is `Unit::ALL[unit]`; an id out of range is refused.
- `Weakest` covers "the weakest or the most shaken": the least men × worth × morale share.
- `Commander`: the side's captain (the broodlord) by the full priority bonus, a company with a living commander by half.
- The same `Battle::priority_score` sets the squad's threat, its men's targets and the bots' `pick`. The charge bot and the general (below skill 2) now pick by each company's standing priority; it is `Nearest` unless an order set it, so their play is unchanged.
- `Charge`/`Commit` without a target take the best foe by the company's priority among those its side sees (commit: within 24).

**Spec:** 08-orders.md §4, §5.

### The new verbs
**Decision:**
- **Guard:** day 3's escort (`guard_behind` 3 behind the ward, defending it within 5). A company cannot guard itself.
- **Screen:** stand `screen_d` = 3 from the ward toward `from`, else the nearest foe to the ward (within 24), else the threat point, facing it; it defends the ward within 5 like an escort.
- **Charge:** attack now with the cohesion gate off (`Order::Charge`); done like an attack.
- **Withdraw:** to `to`, or 6 tiles straight back from the nearest foe; the anchor walks at 0.6 of its pace, gated, turning toward the nearest foe at the fighting turn rate (2.5 rad/s); it never engages, its men strike in passing and do not charge. Detached it holds there facing the foe; with the army it falls in again.
- **Regroup:** to 6 behind the centre of the side's other companies, away from the threat; never engages; holds there facing the nearest foe. Morale comes back by the spec's own recovery (+5/s unattacked): no new rule.
- Withdraw and regroup points stay 3 inside the map's sides (`edge_keep`), so a captain never withdraws onto his own edge.
- **Reserve:** the company follows the captain at a reserve station 6.5 behind him (behind the bows), `reserve_side` to the side by turns; it fights only what reaches it; a drawn front puts it in the reserve's place; army attacks and charges leave it. **Commit** clears it: at the target, else the best foe within 24, else back to its line station.
- **Face:** a company holds where it stands, facing the angle (detached, as a hold is).
- **Held start and Advance:** `Setup.held` / `Replay.held` (`harness play … new --held`) holds both sides: no anchor goes further than `held_depth` = 8 from its side's deploy point toward the enemy's. Companies may still be placed inside that. `Advance` (from either side) ends it for both.

**Rejected:** a held start that freezes all movement (the player could not place the army); a regroup bonus to morale recovery (no number in the spec).
**Spec:** 08-orders.md §3, §8.

### Field works
**Decision:**
- `WorksTune` holds the four works as data `{work_s, footprint, hp, mods, blocks}` in 07-progression §9's mod form `{path, op, v}`:

  | work | work_s | footprint | hp | mods | blocks |
  |---|---|---|---|---|---|
  | stakes | 8 | 4 × 1 | 40 | `charge` set 1, `charge_taken` ×0.4 (spec) | no |
  | barricade | 12 | 3 × 1 | 80 | `arrow_taken` ×0.5 | yes |
  | bridge | 20 | 2 wide, spans ≤ 10 | 120 | — | (its water becomes road) |
  | watchtower | 15 | 1.5 × 1.5 | 100 | `sight` +3, `range` +1.2 (spec) | no |

  Times, sizes, hp and the barricade's 0.5 are chosen.
- `Build` lays the work out at once (`built` 0, so the view can show it rising) or joins an unfinished one of the same kind within a tile (two companies build twice as fast). It is refused off the map, on blocked ground, on another work, out of reach, and (bridge) with no water within 1.5 along the crossing or water wider than the span.
- The company walks to its spot (1.2 behind the work's back edge; a bridge's nearer landing) and works `dt/work_s` a tick. At work it cannot fight: it does not engage, loose or take targets. A hit on any of its men interrupts it: it holds and fights; the work keeps what was built.
- Built, a barricade's tiles become rock and a bridge's water tiles road, so A*, the men and the anchors all use them; torn down, the old tiles come back.
- Stakes: a charging blow at a man of their side among or up to 2.5 behind them, from in front, loses the charge bonus and takes `charge_taken ×0.4`; it costs no charge morale. Barricade: an arrow from in front at a man up to 2.5 behind it takes `arrow_taken ×0.5`. Watchtower: a company with its centre within 1.8 sees +3 and (ranged) shoots +1.2, by the best tower.
- Tearing down: any foe man in reach of a work with no foe to strike (not a commander, not building) does his `damage × raze` (1) per interval to it. The general and garrison bots send the nearest free melee foot company (not a breather, not horse) at each foe work they see, fighting ("capture squads go for places and works").
- `Battle.works` is pub and keeps razed works (`razed`), with each work's `built`, `hp`, `tiles`, `ends` and `size` for the view.

**Rejected:** works as squads; a per-man tear-down cooldown (dps is the same over a second and needs no state).
**Spec:** 08-orders.md §7.

### Hashes and goldens
**Decision:** the new state is hashed only where it differs from day 3's (a non-default way, a reserve, a builder at work, a held start, dawn, an army's waiting deeds, the works), so the keep, field and mirror goldens are unchanged. `fixtures/orders.json` (the keep, held, against the garrison bot) is golden-hashed natively and in WASM.

### Text commands
**Decision:** `sim::text` reads and writes every deed (`parse(format(d)) == d`); the grammar is in its module comment. Names and `me` are read; ids are written. `then X` is `wait done X`.

### Dawn
**Decision:** `Battle.dawn` is set when the night ends; on today's keep and town maps that is the tick the battle is decided, so `When::Dawn` only matters once a battle can outlast its night (day 4's relief). The check sets the flag directly.

## D-17 | 2026-10-28 | Day 4: the order language in voice (08-orders §9)
**Summary:**
- **The reply:** a bare JSON array of up to 4 orders, `{"who":[…],"do":VERB}` plus only the fields that were said: `work, as, to, rel, and, from, round, by, stance, shape, pace, fight, when`. Every value is a per-battle enum under a whitespace-free grammar.
- **Resolution** turns selectors, enemy-by-kind targets and relative points into the contract's deeds. Modifiers become `with`, and sequences, signals and conditions become `wait`; waits go after the direct deeds in each batch (D-16).
- **The fast path** grows: signals, hold fire, fire at will, and per-company halt.
- **`npm run say`** runs any sentence (cached, `--live` or `--offline`).
- **The eval:** a 146-case suite in 11 categories (`docs/voice-eval/cases-08.json` with `fixture-08.json`).
- Built by a delegated agent; checked again before commit.
**Measured:**
- **The 08 suite:**
  - The agent, 146 × 3 live: 99.3%.
  - My cached re-judge: 145/146.
  - My live re-run after the name fix below: 145/146, brain p50 1.9 s and p95 2.9 s. 10 categories at 100%; conditions 92% (case 141, an ambiguous "when they reach the ford, charge").
- **The Day 1 suite:** 20/20, brain p50 1.64 s (D-07: 2.76 s). Replies average 17–19 tokens, against 32 before.
- **Held-out check (mine):** 10 new sentences, never seen by the agent or the prompt.
  - 7 fully right, including "take their place", "if Oda breaks, Hakon fills the gap", "wait till the trolls reach the ford" and "look after Ella".
  - "Nobody moves until I say so" became hold-fire on my mark instead of an army hold.
  - "Get your bows up" pulled in BORS: the fuzzy matcher heard "bows" as BORS. **Fixed:** kind words and army words are never names. The sentence now resolves correctly.
  - So on new phrasing, expect about 80–90%, not the suite's 99%.
**Open:**
- Keep a held-out set for measurement only, never for prompt tuning.
- The game must store groups and waiting orders in the field it gives voice (day 4's wiring).
- Sequences across companies need a new `When`.
- "Bors, now" releases every signal-0 wait, not only Bors's.
- The prefix is now about 3,970 cached tokens (15–20 s to read once per server start).
- Warming the field at hold start is still required.

# Decisions: the order language on the voice side (08-orders §9)

Choices made where `docs/spec/08-orders.md` and `06-voice.md` are silent, while building the voice side of the order
language: the reply schema, the field description, the prompt, resolution, the fast path, `say` and the 08 eval.
Code: `web/src/voice/{field,orders,resolve,prompt,brain,normalise,pipeline}.ts`, `tools/say/main.ts`,
`tools/voice-eval/main.ts`, `tools/voice-cache.ts`. Data: `docs/voice-eval/{fixture-08,cases-08}.json`.

### The reply is a bare array of orders with optional fields in a fixed order
**Decision:** the model replies with a JSON array of at most 4 orders, `[]` meaning unclear. Each order is
`{"who":[…],"do":VERB}` plus only the fields the words ask for, in this order: `work`, `as`, `to`, `rel`, `and`,
`from`, `round`, `by`, `stance`, `shape`, `pace`, `fight`, `when`. Every name is a per-battle enum (`enums(field)`),
and the GBNF grammar has no whitespace and makes each field optional in that order. A plain order is
`{"who":["BORS"],"do":"take","to":"MILL"}`; a full one
`{"who":["BORS"],"do":"charge","to":"TROLLS","shape":"wedge","when":"mark"}`.
- `when` is one string: `done`, `mark`, `attacked`, `night`, `dawn`, `after:N`, `near:<spot>`, `breaks:<company or foe>`.
  The compound values are enums too (`after:` takes 1–3 digits), so a condition is one field, not two.
- `work` and `as` come straight after `do`: on the first run the model wrote `"do":"build","work":…` and, with `to`
  ordered before `work`, could no longer say where (2 failures). Verb, then object, then place is how it writes.
**Why:** the brain writes every token at ~13 tok/s here, so tokens are latency. Day 1's object form wrote 32 tokens
p50 for one order (`side`, `fight` and `unclear` always present); this form writes 17 for the same Day 1 cases, and
Day 1 brain p50 fell from 2.76 s to 2.1 s at 20/20.
**Rejected:** keeping Day 1's object with required fields (every order pays for fields nobody said); one-letter keys
(`who`, `do`, `to` are already one token each, and names the model understands help accuracy); a non-JSON line format
(fewer tokens, but the spec asks for a JSON schema and the model writes JSON best); a separate `on` field for
conditions (one more key per conditional order).
**Spec:** 08-orders §9 "the schema grows"; 06-voice §4c.

### Selectors are enums resolved in code; the field shows each company's place and state
**Decision:** `who` takes company names, kinds (HORSE, SPEAR, SHIELD, ARCHER, LEVY), ARMY, OTHERS, named groups,
`LEFT_WING`, `RIGHT_WING`, `CENTRE`, `FRONT_LINE`, `REAR`, `RESERVE`, `FREE`, `FRESH`, `SHAKEN`, `WOUNDED` and
`NEAR_<spot>`. The code resolves them (`resolve.ts` `select`):
- **The line** is the companies not detached, not in reserve and not routing; the army's frame is centred on it
  (Day 1 centred it on every company; the Day 1 field has none detached, so nothing there moves).
- **Wings:** at least 2.5 tiles across from the line's centre and within 2 of the outermost company. **Front line:**
  within 1.5 tiles of the foremost company's depth. **Rear:** 3 or more tiles behind it. **Centre:** the rest.
  **Reserve:** the reserve flag.
- **FREE:** idle, and not in reserve or detached. **FRESH:** 90% of its men, morale ≥ 0.8, not fighting (the reserve
  counts). **SHAKEN:** routing or morale < 0.5. **WOUNDED:** under 60% of its men.
- **NEAR_X:** the company nearest X, plus any other within 4 tiles of it ("the company nearest the ford" and "the ones
  by the mill" both resolve sensibly without the model counting).
- The state text adds the same tags to each company (`fighting front centre wounded`, `reserve`, `detached`,
  `shaken`), and `shaken` to foes, about 3 tokens a company, so the model and the code see the same thing.
**Why:** the model cannot measure; code can. With the tags shown the model may also answer with names, which resolve
to the same companies, so the eval judges resolved companies, not selector tokens.
**Rejected:** letting the model pick companies from the tags alone (it would have to compare coordinates); showing
morale as a number (more tokens; `shaken` is the threshold the selectors use).
**Spec:** 08-orders §2.

### Named groups live on the voice side; the model may only name one with a word that was said
**Decision:** "Bors and Ren, you're the hammer" resolves to a group `{name: HAMMER, members}` returned by `resolve`
(`Resolution.groups`), with no deed. The caller keeps it in `Field.groups`; it then appears in the state text
(`GROUPS: HAMMER = BORS HAKON`) and in the `who` and target enums. The `as` field's enum is the words of this
utterance (3+ letters), built into the grammar per call, so the model never invents a name. A group cannot take a name
already in use (a company, kind, selector, spot or foe kind).
**Why:** the spec says every name is an enum; a group name is the one name the captain coins, so the utterance is its
enum. The grammar is not part of the cached prompt, so a per-call grammar costs nothing.
**Rejected:** a fixed list of group names (HAMMER, ANVIL…), which a player would have to learn; letting code alone
parse "you're the X" (brittle across phrasings).
**Spec:** 08-orders §2 "a named group".

### Signals: 0 for everyone, a group's own number for its orders
**Decision:** a waiting order on `mark` waits for signal `n` = the group's number (its index + 1) when it is
addressed to exactly one named group, else 0. `Field.waiting` lists the waiting orders with their `n`. "now", "go",
"loose", "go go go", "fire" and, while anything waits, "charge" raise every `n` that is waiting (one Signal deed
each); "hammer, go" or "Ren, now" raise only the signals of that group's or company's waiting orders. A signal with
nothing waiting is refused. "now" is no longer a filler word (it was in 06-voice §5's list) since it is the signal.
"attack" alone is not a signal: it stays ARMY attack the nearest foe.
**Why:** "hammer, go" (08-orders §2) must release only the hammer; the contract's `Signal{n}` releases every order on
`n`, so groups need their own numbers. Plain "now" releasing everything is what a captain means.
**Rejected:** one signal per company (a "now!" would need many deeds, and groups are how the spec names a
manoeuvre); signal 0 for everything (then "hammer, go" releases everyone).
**Spec:** 08-orders §3 "signal", §6 "signals".

### Enemy kinds and picks resolve to the nearest squad, with the priority in `with`
**Decision:** a target of BLIGHTMEN, TROLLS, DRAKES or BROODLORD is the nearest seen squad of that unit to each
company (so the army's archers may pick different packs), and the deed is wrapped in
`with {priority: {by: 'unit', unit}}` (7, 8, 9, 10). NEAREST, WEAKEST and STRONGEST likewise add
`{by: 'nearest' | 'weakest' | 'strongest'}`; WEAKEST and STRONGEST use `FieldFoe.strength` (men × worth, as the sim's
priority scores), else men. MOST_SHAKEN is the foe with the lowest morale and adds no priority (the TS contract has no
"shaken" priority). An explicit enemy id ("the ones attacking the mill" → the id whose state says so) adds none.
**Why:** `Attack` needs one squad now, while "get their drakes" means "and the next drakes after": the priority makes
the sim keep choosing that kind once the first pack is gone.
**Spec:** 08-orders §4, §5 "priority".

### Relative points and the army's own sides
**Decision:** (`relPoint`, `framePoint`), each `ext + 2` tiles from the target, where ext is a hill's radius, half a
wood's larger side, 1.5 for a place, company or foe, and 1 for a work:
- **behind** a feature: on our side of it, away from the enemy; behind a foe: its far side from us. **in front of**
  is the opposite. A river's behind is our bank, its front the far bank.
- **across** a river: the far bank, 2.5 tiles out, level with the ford nearest the company; across anything else: its
  far side.
- **beside** a company or spot: on the side the ordered company comes from. **left/right** of: along the army's left.
- **between** A and B: the midpoint. Without the second place it is refused.
- **LEFT_FLANK / RIGHT_FLANK:** 3 tiles beyond the outermost company of the line on that side; **FRONT / REAR:** 3
  tiles beyond the foremost / hindmost. For `face` they give the direction itself.
- **Routes:** `round` keeps 06-voice §6 (6 tiles out from the midpoint); `by` adds a via at the feature's point nearest
  the midpoint.
**Why:** "behind the ridge" in a battle means the reverse slope (sheltered from the enemy), and "get behind the
trolls" means their rear; one rule for features and the opposite for foes covers both.
**Open:** "stakes in front of the ford" puts them on the far bank (forward of the ford); a river crossing may want
"in front" clamped to our bank.
**Spec:** 08-orders §4 "relative points".

### Modifiers and triggers wrap the deed as `wait(with(deed))`
**Decision:** stance, shape, pace and the target priority become `How` in a `with`; the trigger becomes a `wait`
outside it. `fire_at_will` is stance `normal`; `chase` / `no_chase` are `pursue: true / false`; `thin` and `deep` are
`files: 8` and `files: 3` (no shape change). `set` carries its `How` itself (no `with`), and a `set` with an enemy
target sets only the priority ("archers, focus the drakes"). `near:X` is `enemy_near` at X's point with r = 3;
`breaks:X` takes a company or a foe (kinds and groups resolve to their nearest member). Several companies given the
same deed share one deed with `who: {t: 'squads'}`; companies whose points differ keep one deed each.
**Why:** the contract's nesting; `wait` outermost so the trigger is checked before the modifiers apply.
**Spec:** 08-orders §5, §6; contracts `With`, `Wait`, `Who::Squads`.

### In one utterance's batch, the waiting deeds go after the direct ones
**Decision:** `Resolution.deeds`, the batch queued for one utterance, lists every deed that is not a `wait` first and
the `wait`s after, each group in the reply's order. "Hold the ford once you've taken the mill" gives
`take`, then `wait done (move)`, even if the model wrote the waiting order first.
**Why:** in the sim a direct order clears the waits of whoever it orders (the queue of 08-orders §6), so a wait queued
before a direct order to the same company in the same tick would be lost.
**Spec:** 08-orders §6 "sequences"; the sim's order queue (D-11 "the order model").

### `when: done` is per company
**Decision:** "Bors, take the mill, then Wil, hold the ford" gives Wil a `wait done`, which waits for Wil's own current
order, not Bors's. A sequence across companies is not expressible in the contract's `When`; the model's examples only
use `done` for the same company.
**Open:** a `When::Done { squad }` would carry "once the riders are through, the spears go".
**Spec:** 08-orders §6; contracts `When::Done`.

### Verb details the spec leaves open
**Decision:**
- **hold** with no place (or HERE) is `Hold`; with a place it is a move with fight on (Day 1). "wait / stand by" with
  no order after it is `hold`.
- **move** to ME is a recall (the army: rally). A move to a village the blight holds is a take (D-07, kept).
- **attack** with no target is the nearest foe to each company; at a place it takes it; at our own company or the
  captain it is refused. **charge** with no target is `Charge{who}` (the sim picks); "charge it" when the trigger is
  `near:X` and the target is X is also `Charge{who}` (whoever arrives is the foe), and the same attack is a move to X
  ready to fight.
- **guard / screen** take a company or ME as the ward (the captain is squad `Field.captain.id`, 0 in the sim's
  setups); a kind or group ward is its nearest member; a place ward becomes a move there ready to fight; a foe ward is
  refused.
- **commit** said to no one sends in the companies in reserve (refused if none). **reserve** said to the army is
  refused ("the army cannot be its own reserve"), as the sim refuses it.
- **build** said to the army goes to one company, as the sim takes works only from a company: the free company
  nearest the spot (the captain, for stakes with no place), else the nearest one not fighting. On fixture-08
  "Build a bridge at the narrows" goes to REN.
- **advance** with no place is `Advance` when the deployment is held (`Field.held`), else a move 6 tiles toward the
  threat with fight on.
- **build:** stakes with no place go 1.5 tiles in front of the company; every work faces the army's forward; a bridge
  must be on the river, its narrows or a place within 2 tiles of its banks, else refused. "man the tower" is a hold of
  the work (a move there ready to fight).
- **recall** said to the army recalls every detached company.
**Spec:** 08-orders §3, §7, §8.

### Other words for a seen foe kind are normalised in code
**Decision:** before the brain, "dragon(s)" and "wyrm(s)" become "drakes" and "giant(s)" "trolls", when the field
has that kind, as spoken company names already become their exact names (`canonicalNames`). The rules still list
the synonyms.
**Why:** after the rule "any other kind of foe … is not on the field" was added (it fixed "charge the goblins"),
Day 1's "Kill the dragon" was answered `[]` in 3 of 3 runs. Doing the 06-voice §4a synonym rule in code made it 3 of
3 again without giving up the refusal.
**Rejected:** dropping the refusal rule (the goblins case then names blight-men); more examples (the model weighed
"dragon" against the new rule, so the mapping belongs in code).
**Spec:** 06-voice §4a, §5.

### The fast path's new patterns
**Decision:** before the brain: the signals above; "hold fire / hold your fire / cease fire / stop shooting" and
"fire at will / loose at will / open fire" for the archers, or for whoever is named first ("Ren, hold your fire");
"<who> stop / halt / hold / stand / stand fast / hold position" for a company, kind or group ("everyone halt" is the
army). Who-words there are names (fuzzy), kinds, groups and everyone/all/army. "men", "ten", "fill", "boys", "rest",
"tell" and similar are never heard as names (REN, WIL, BORS sound like them).
**Why:** 08-orders §9 lists them; each answers in under 10 ms instead of ~2 s.
**Spec:** 08-orders §9 "the fast path grows"; 06-voice §5.

### Refusals carry a reason; unclear is an empty reply
**Decision:** a reply of `[]` is unclear (query horn). A resolved order that cannot be carried out is refused on its
own with a reason (`Refused.why`): no company matches a selector ("no company is shaken"), the companies cannot take
orders (routing), a verb lacks its target, an unseen foe kind, attacking our own, a bridge off the river, a company
acting on itself, a signal with nothing waiting, a group name already in use. The rules tell the model to reply `[]`
for a foe that is not seen ("charge the goblins").
**Spec:** 08-orders §1 "a refusal … its reason goes to the log"; 06-voice §6 "validation".

### The Day 1 suite runs on the new format; its state text and schema are kept as records
**Decision:** `npm run voice-eval` still runs the 20 Day 1 cases on `fixture.json` unchanged, through the new prompt,
schema and resolver (what ships). The Day 1 check that the builders reproduce `fixture.json`'s `stateText` and
`schema.json` exactly no longer holds (the state text gains tags, the schema is the new one), so it now checks that
every Day 1 name is still an enum. `fixture-08.json` carries its own `stateText`, checked exactly on every 08 run.
Day 1 replies in the old object form (`target`, `side`) are still read by `replyOf` and `resolve`.
**Rejected:** a second, Day 1-only prompt and schema (it would measure something that no longer ships).
**Spec:** 06-voice §9; the brief's "the Day 1 suite must still run unchanged".

### The 08 fixture and its eval
**Decision:** `fixture-08.json` is the Day 1 warband plus ELLA (archers, detached) and HAKON (spears, reserve), two
companies in a fight (one shaken, both worn), five foes of all four blight units, a group (HAMMER) and two waiting
orders, a watchtower and the river's narrows. Foe ids are E12–E16, distinct from our squad ids 0–6 (in Day 1's
fixture E1–E3 share numbers with our companies, which made a `breaks:E3` trigger point at ODA). Cases are judged on
resolved acts (one per company, or one for the army): every expected act must match a distinct act and there must be
no others; a `when` that was not asked for fails. `none` cases pass on unclear or on a refusal.
**Why:** judging after resolution lets the model answer with a selector or with names, as long as the right companies
get the right deeds.
**Spec:** 08-orders §9 "the eval grows".

### A reply cache for `say` and the eval
**Decision:** every live reply is cached in `out/voice-cache.json`, keyed by sha256(mode, temperature, prompt prefix,
state text, heard words). `say` replays a cached reply when there is one and asks the brain otherwise; `--live` always
asks, `--offline` never does, `--reply '<json>'` resolves a hand-written reply. The eval's `--cached` re-judges on
cached replies (for resolution changes, no GPU needed).
**Why:** 06-voice §7 ("a fixture cache keyed by hash(state text + utterance)"); the prefix is in the key so a prompt
change can never replay a stale reply.
**Rejected:** committing the cache under docs/ (it churns with every prompt change; out/ is ignored by git).
**Spec:** 06-voice §7.

### Checked against the sim's own types
**Decision:** every deed the 08 suite resolves (151, from the cached replies) was fed to the sim through
`harness play … do '<deed JSON>'` (the sim's serde types, `sim::text::parse`). All 151 parse. On the harness's own
ford map the sim carried out 69 and refused the rest only for ids and spots that exist in fixture-08 but not on that
map (squads 5–6, foes E13–E16, site 0, a bridge where its map has no water); the one shape it refused outright,
`build` for the army, is now given to a company (above).
**Spec:** contracts `Deed`; AGENTS.md rule 5 (model output is resolved, validated, then queued).


## D-18 | 2026-10-29 | Day 4: input and marks (01-flow §2; 02-look §2, §7)
**Summary:**
- **The pointer state machine:** press, stroke, pan, pinch and drag, with the exact touch and mouse thresholds. Hit-testing is settled on press, against what was drawn.
- **Every row of §2's tap and stroke tables** becomes a Command through `BattleView.issue`. A front is drawn at time ×0.3 with ghost bars from a sim `planFront` preview (checked equal to the real front). Also: the selection lapse, pause showing every order including waiting ones, and the keys.
- **The 400 ms captain hold** calls `onCaptainHold`, for voice.
- **Every mark of 02-look §7,** and the red X at every refusal.
- **Facing fix:** withdrawing men face the squad, not their motion.
- Built by a delegated agent; checked again before commit.
**Acceptance (the agent's synthetic pointer runs):**
- A 9 px slide on the captain is a tap: 8/8 on touch and on mouse.
- Every drawn pixel of the captain hits him, at zooms 7–34.
- Enemies in a melee: 20–21 of 21 tappable (the old bug was 2 of 9).
- The captain wins 47 of 47 ties.
- Shimmer with about 3,600 mark vertices: 0 bad frames at 7, 16 and 34.
- Whole battles were played by mouse and by emulated touch.
**Open:**
- No face cards yet (no portraits).
- On a 375 px phone the captain's touch reach covers about 2 tiles, which feels greedy.

# Decisions: day 4, input and marks

Choices made where the spec is silent, for the battle's touch and mouse input and the marks every order draws:
`web/src/input/*`, `web/src/view/marks.ts`, `web/src/battle/{battle,order-marks,ui,records}.ts`, `web/src/main.ts`,
`web/src/dev.ts`, `crates/sim-wasm/src/{input_api,frame,compat}.rs`, one line in `web/src/view/shaders.ts`, and the
visibility of `Battle::open_near` in `crates/sim/src/battle/mod.rs`.

### An order is applied at once, the bots thinking first
**Decision:** every order the input gives goes through `BattleView.issue(deed, src)`: the Command is queued with
`apply`, then `Battle.flush()` (new, input_api.rs) lets the bots think for this tick exactly as the next `step` would
(a bot thinks at most once a tick, so that step does not think again) and applies the queue without stepping. The
view re-reads the sim at once, so the order's marks, a refusal's red X and the paused view all show the new order
in the same frame.
**Why:** "Orders still work while paused" (01-flow.md §2): with no ticks running, a queued order would only land on
unpause, and the paused view could not draw it. Letting the bots think first keeps the log (and so a replay) the
one the next tick would have given: same commands, same order, same bot decisions.
**Rejected:** applying only on the next tick (nothing shows in a pause); flushing without the bots (a bot would see
the player's order a tick early, unlike in a replay that re-runs the bots).
**Spec:** 01-flow.md §2 "Pause and keys"; 04-battle.md §1 "Orders are a queue".

### A tap on the ground marches without fighting
**Decision:** a tap on open ground is `move { to, fight: false }` (the army, or the selected company); a drag from a
company or the captain the same along its route. A company stops to fight once it gets there (arrival is a hold).
**Why:** the spec names no `fight` for a tap; voice's march defaults to `fight: false` (D-17), and the two must
mean the same. Attacking is a tap on the enemy.
**Spec:** 01-flow.md §2 "What a tap does"; 04-battle.md §5 "Who may engage".

### Every order given uses up the selection
**Decision:** any order the input gives deselects: a tap's, a drag's, a front's (a front orders every company, the
selected one too), and tapping an order flag (which recalls that flag's company, selected or not). Pressing a
company selects it at once; releasing that press keeps it selected; a tap on the selected company deselects. The
lapse (7 s) does not run while paused; a company that routs or leaves the field is let go.
**Why:** 01-flow.md §2 says a selected company's order "deselects it"; the front and the flag cells of the table are
silent. The pause is for thinking, so a selection made in it should not blink away.
**Spec:** 01-flow.md §2 "What a tap does", LAPSE.

### Time slows only while a front is drawn
**Decision:** `clock.drawing` (slow 0.3) is set for a front stroke only, not for a drag from a company or the captain.
**Why:** 01-flow.md §2 and 04-battle.md §4 tie the slow time to drawing the front, whose ghost bars need reading.
**Spec:** 04-battle.md §1, §4 "Preview while drawing".

### The front's preview is the sim's planFront, ported and checked
**Decision:** `Battle.plan_front_preview(team, line)` runs a copy of `planFront` (front.rs) that orders nothing and
returns each company's bar (spot, facing, files, length, role) and the captain's spot. The test
`preview_matches_the_front_obeyed` gives four lines on four armies and checks every bar against the order the real
front then gives: 82 bars and taps, every spot, facing and frontage equal. Bar lengths: files × 0.72 for the line,
3 for bows, 2.2 for horse, 4.2 for a beast; a horse or beast filling the line keeps its own; a foot company in the
reserve gets 02-look's spear-and-shield 3. The captain's gold disc stands at his place behind the line even when the
line fights (he rides from there).
**Why:** `planFront` mutates the battle and `Battle` cannot be cloned; changing the sim beyond visibility was not
mine. The test fails if the two drift.
**Rejected:** applying the front to a copy of the battle (no `Clone`); replaying the log per stroke point (too slow).
**Spec:** 04-battle.md §4; 02-look.md §7 "Front preview".

### Hit-testing: mounted bodies, head heights, the oval
**Decision:**
- Head heights (tiles, from the figures' parts × FIG 1.32): foot 0.76, horse 1.04, the captain 1.12, a commander
  ×1.16; blight-men 0.95, trolls 1.75, drakes 1.05, the broodlord 2.0.
- A mounted figure (horse, the captain) is also measured to its horse's body, tail to nose (±0.42 tiles along its
  facing at 0.45 high): the rider's segment alone left 29 of 385 pixels of the captain's horse out of reach at zoom 34.
- Banner poles: 1.6 tall (the captain's 1.95, a beast standard 2.4) × the zoom's growth × 1.3 when selected, as drawn.
- An order flag is measured from its foot to its top (1.15) and scores ×0.7.
- A selected company's oval is the selection ellipse; a press inside it scores as if at the company's reach, so a man
  actually nearer (an enemy in its melee) still wins.
- Exact score ties go captain, flag, company, enemy.
**Spec:** 01-flow.md §2 "Hit-testing".

### Marks: widths, timings and faint marks
**Decision:**
- A ground ribbon is at least one art pixel tall on screen (2/s tiles: across the screen it is foreshortened by half);
  the ink shows at least one pixel each side; an arrowhead at least 3 pixels; a refusal's X at least 4.
- Order given: a fading dashed route (1.3 s, holding full for its first 35%) and a ring closing in (0.55 s); an attack's
  red ring r 1.9 and a take's gold ring at the capture radius close in instead of the ping; a rally's big gold ring
  r 4.2 on the captain; an order that moves no route (a wait, a change of way, a signal) pings the companies it names.
- The refused X lasts 1.6 s, drawn for every `Refused` event of ours (taps, drags, voice, a waiting order that runs and
  is refused), laid on the ground so it crosses at 45° on screen.
- Faint marks: a detached company's dotted line to its flag at α .5; a waiting order's dotted line and a 0.7 ring
  where it points at α .45 (.7 once its signal is given), and a dashed red ring round an "enemy near" trigger's
  ground. When a waiting order fires, the company gets the order-given marks: the faint mark brightens.
- The selection ellipse is the formation's extent along and across its facing plus 0.7 tiles (at least 0.9); it
  blinks at 4 Hz for the last 1.5 s.
- The order flag is a standing pennant: a wooden pole and a team-blue cloth with a cream edge, 1.15 tall, snapped to
  the art-pixel grid like a figure and written to depth so it is outlined. It stands at the order's point: a move's
  goal, a site, a foe's or a ward's centre (following it), a hold's post.
- Pause draws, for every company, a dashed route to its target in its order's colour (cream, red for attack and
  charge, gold for a site and for the captain's own route, the withdraw colour for recall, withdraw and regroup), its
  arrowhead, and a red ring round an attacked foe; order lines start at the company's banner as drawn.
**Why:** 02-look.md §7 gives the widths and colours but not durations, alphas or the flag's look.
**Spec:** 02-look.md §7; 01-flow.md §2; 08-orders.md §1, §6.

### The pause greys the world, not its marks
**Decision:** marks write alpha 0 into the scene target; CELL (`shaders.ts`) skips the pause grey where alpha < 0.5.
**Why:** "The world greys and every company's order is drawn": orders drawn in grey would not read. Nothing else in
the scene writes an alpha below the alpha-test.
**Spec:** 01-flow.md §2 "Pause"; 02-look.md §9.

### Two-finger tap, hover, and keys
**Decision:**
- A two-finger tap's travel counts the first finger's own slide before the second came down, so a front cut short by a
  second finger is not also a re-follow.
- What the mouse is over is tested when it moves and every 8 frames under a still mouse; it widens a capture ring to
  0.12 and grows a banner ×1.1.
- V (talk) is voice's key; the input exports `onCaptainHold(fn)` / `inputHooks.onCaptainHold` for the 400 ms captain
  hold ('start', then 'end' on release or a second finger) and `inputHooks.onMute` for M. N waits for the campaign.
**Spec:** 01-flow.md §2 "Pointer state machine", "Pause and keys".

### A withdrawing company's men face their foe, or the squad's facing
**Decision:** in the frame packing, a man of a company under `Withdraw` never faces his motion: he faces his target if
he has one, else the squad's facing (which turns toward the nearest foe), so he walks backwards (the `backing` bit).
Test `a_withdrawing_company_faces_the_foe_and_walks_backwards`: 12 of 12 walking men face the squad's way and back.
**Spec:** 08-orders.md §3 "withdraw"; DECISIONS.md D-16 "Open".

### `Battle::open_near` is public
**Decision:** its visibility only (`pub(crate)` → `pub`), so the preview snaps spots to open ground exactly as
`planFront` does.
**Spec:** AGENTS.md (the sim is the places agent's; visibility only).

## D-19 | 2026-10-29 | Day 4: places, the night and field works (03-land §7–§8; 04-battle §7–§8; 02-look §3)
**Summary:**
- **The village under the torch:** houses burn on the spec's clock and fall killing their people. Taking the village frees the rest, and the freed fall in behind the captain.
- **The ford:** civilians as Folk companies, raider waves and the `raiders` bot.
- **The night:** torches as a rule, the relief from the east, and lights listed by the sim.
- **The view:** medieval structures in the holder's colours, flags climbing, fire, smoke, embers and ruins, the ford's wagons, the night pass fed with real lights, and field works rising and falling with a bridge deck.
- Built by a delegated agent; checked again before commit.
**Measured** (100 seeds each):

| Battle | idle | commander | charge |
|---|---|---|---|
| keep | 0% (was 99%) | 26% | 17% |
| town | 0% | 27% | 22% |
| ford | **16% (miss)** | 52% | 22% |
| field | 5% (miss) | 31% | 21% |

- Every battle ends; the jitter gates pass.
- `harness places`: 9/9.
- Existing goldens unchanged; new town and ford fixtures match natively and in WASM.
**Open** (day 5 balance):
- Ford idle 16%; the commander at 26–27% on keep and town.
- The town is freed in only 3% of the commander's battles.
- Hold-the-line waves not done.
- `BattleView` needs a public ground hook (places wraps a private one).
- Civilians carried a company banner: fixed at commit in `records.ts`. The voice field already leaves them out.

# Decisions: day 4, the places (04-battle §7–§8; 03-land §7–§8; 02-look §3; 01-flow §4; 08-orders §7)

Code: `crates/sim/src/battle/{places,place_checks}.rs`, `crates/sim/src/bots/raiders.rs`, `crates/sim/src/tune.rs`
(`PlacesTune`: `TownTune`, `FordTune`, `NightTune`; `RaidersTune`), small hooks in `battle/{mod,outcome,sight,setup,
order,orders,anchor,front,combat,ride}.rs` and `bots/{mod,general}.rs`, `crates/harness/src/{main,sweep}.rs`,
`crates/sim-wasm/src/places_api.rs`, `web/src/view/places/*`.

### Companies that join a battle are spawned at the start of a tick
**Decision:** the ford's groups and waves, the night's relief and the freed are added (`setup::spawn`) at the start of
`tick_once`, after the commands and before the neighbour grid, so every per-tick table (`Scratch`, the grid) has room
for them. A capture that frees a village queues its company for the next tick.
**Why:** adding a squad in step 9 left step 10 (morale) indexing tables sized for the old count.
**Rejected:** resizing the per-tick tables mid-tick.
**Spec:** 04-battle.md §1 "Tick order" (step 9 decides when; the joining is one tick later at most).

### The order the town's houses burn in
**Decision:** a seeded order (`jitter(seed, house, 201)`), fired at 22 + 26·k s. Each burns 24 s, then falls in and
its people die (`HouseLost`). The houses stand where 03-land §7 puts the town's five (offsets from the site).
**Why:** the spec gives the times, not which house; the layout gives the places, and the sim needs them for the fires'
sight and light.
**Rejected:** a fixed order (every town would burn the same way).
**Spec:** 04-battle.md §8 "Village under the torch"; 03-land.md §7 "Town".

### Taking the town: who is freed, and who falls in
**Decision:** when the town's owner becomes the warband (its capture, as a holdfast), every house still standing or
burning gives up its people (a burning one is doused, smoking 12 s); `Freed` carries the count. `min(6, freed)` of them
fall in behind the captain as a levy company with no commander (a plain banner: records.ts draws a team-0 levy in
linen), marked `freed` (the figures' recruit bit 25: their own clothes), at the reserve's station (0.4 behind, 3.4 to
the side). They do not defend the captain (as the reserve). No fires start once the town is taken.
**Why:** 01-flow §4 "a village freed in battle sends 6 men, who fall in behind the captain under a plain banner".
Taking the town ends the battle (it is a holdfast), so they join as the field falls quiet.
**Rejected:** freeing the neutral villages of a keep map (they start neutral, not held by the blight; that would add
two companies to every keep battle); all freed people as soldiers (the spec says 6).
**Spec:** 04-battle.md §8; 01-flow.md §4 "The freed".

### The ford: civilians are team-0 companies of folk
**Decision:** each group is a `Folk` company of 5 on the warband's side, detached, walking `Move` to the west exit by
way of its ford (alternate groups the far ford). Its pace is set each tick: 0.95, or 1.6 with a foe within 5 (plus its
spread) of its centre (its `spec.speed`, which every pace rule reads). A company that deals no harm never engages,
strikes or looses (`Battle::rules`), defends nobody (`ward_point`), and never breaks (the folk unit's `never_routes`).
They take no orders (`own` refuses them), are left out of "everyone", rallies, fronts, regrouping, the captain's ride
and the bots' companies, and are never held back by a held start.
**Why:** the sim already moves companies on paths with formations and fog; a separate walker would duplicate that.
**Rejected:** a third team (fog, captains and outcomes are two-sided everywhere).
**Spec:** 04-battle.md §2 "folk (civilians)", §8 "Ford".

### The ford: when a group has left, and who wins
**Decision:** a group has left the field when its men's centre is within 1.5 of the exit (`leave_r`, as "home" is
1.5): its men leave alive (as fleeing men do: `alive = false`, never died) and are counted saved (`Saved`, a = men). A
group with nobody left is done too. When every group has come and is done, the warband wins (`Saved`, reason 8) with
at least one saved, and the blight wins (`NoneSaved`, reason 9) with none.
**Spec:** 04-battle.md §8 "Ford".

### The ford: the far crossing
**Decision:** a far group goes by the far route's ford tile off the main ford's rows (the eastern of the two), so it
comes at the narrow ford from the east bank.
**Why:** the map's far route (A* to the narrow ford, then to the exit) sometimes reaches the narrow ford by way of the
main one; its first ford tile is then the main ford's.
**Spec:** 03-land.md §3b.

### The raiders: no broodlord, waves of three, from the corners
**Decision:** at the ford the blight has no army at the start and no broodlord: four waves at 14, 37, 67 and 97 s of
three companies each — [drake, blight-men, blight-men], [blight-men, troll, blight-men], [drake, drake, blight-men],
[troll, blight-men, blight-men] — entering alternately at the north-east and south-east corners (2.5 in from the east
edge, 3.5 from the north or south, in a line westward along the edge).
**Why (measured, 100 seeds each, after the civilians fixes):** two a wave (8 companies) let doing nothing win 62% and the
commander 95%; three a wave gives commander 52%, charge 22%, idle 16%; four a wave crushes the commander (17%) while
idle stays ~19%. A broodlord on the field would make killing him the ford's quickest win.
**Rejected:** the keep's nest on the field from the start (nothing for the waves to be); waves from the middle of the
north and south edges (idle 9–27%, no better).
**Spec:** 04-battle.md §8 "Ford" (the waves' times), §7 "Raiders".

### The raiders' bot
**Decision:** `raiders` thinks every 1.5 s, through its own fog. Horse go for the nearest civilians; the blight has no
horse, so its hunters, the packs (drakes), take that rule. Archers shoot troops within 9, else civilians. Foot go for
troops within 4, or nearer than 0.8 of the civilians' distance, else civilians. With nothing seen a company marches on
the main ford, fighting. It tears down works it sees (`raid_works`).
**Spec:** 04-battle.md §7 "Raiders".

### The night: torches, the relief, the level
**Decision:**
- **Torches** are rules, not looks: at nightfall our companies (the captain too) light theirs in order across the army's
  heading (left to right), at 0.7 + 0.45·k s; the enemy's all at 2.4 s; a company that joins at night is lit at once
  (the enemy's) or 0.7 s after (ours). The bearer is the commander while he lives, else the living man of the lowest
  slot.
- **Sight** (03-land §8): each side's fog is stamped, at night, round every lit torch of the other side's companies
  (their centre, spread + 0.8); burning houses are stamped radius 4 for both sides, day or night.
- **The relief** comes 6 s after nightfall: `round(0.5·n)` of the garrison's n starting companies, spread evenly over
  their units (the k-th is unit `⌊(2k+1)·n/2m⌋`), at the east edge (1.5 in) round the keep's row, detached. The garrison
  bot orders them like its own (at night: attack the nearest foe it sees).
- **The level** is a pure function of the clock in the sim: `1 − e^(−0.7·t)` after nightfall, times `e^(−0.9·t)` after
  dawn (02-look's easing, done once where the view can read it and a pause freezes it).
- **Dawn** that ends a battle by its time limit also ends the night (`dawn_at`), so the level eases back.
**Why:** D-11 open item: doing nothing won every keep battle at dawn because the garrison could not see the warband at
night. Measured (100 seeds): idle at the keep and the town wins 0 (91 and 93 captains fell); no battle is decided at
dawn any more, by anyone (the commander's old dawn wins were mostly a lone captain with no army left).
**Spec:** 04-battle.md §8 "Night"; 02-look.md §3 "Torches"; 03-land.md §8.

### The commander keeps its captain out of the fight at night
**Decision:** the warband's commander bot keeps its captain back all night (skill 2's "captain out" rule, applied from
nightfall), since at dawn a living captain wins.
**Why:** a sensible general's night. It changed nothing measurable (26% at the keep): by nightfall its army is usually
spent.
**Spec:** 04-battle.md §7 "General", §8 "Night".

### Lights the sim sends
**Decision:** `Battle::lights` lists every light now, with 02-look's table: lit torches (2.6, 1), burning houses (reach
1.5 → 4 over 6 s, 1.15), smouldering ruins (1.3, 0.6) for the 74 s a fallen house smoulders, and fires (2.2, 0.9): each
shrine's flame and the ford's wagons. Each carries its kind and what it belongs to (the bearer's soldier, the house,
the site).
**Spec:** 02-look.md §3 "Lights"; 03-land.md §7.

### The places in the WASM API
**Decision:** `places_sync()` fills five flat f32 buffers (sites, houses, groups, lights, works; strides 8, 8, 8, 6,
16) kept in a thread-local in `places_api.rs` (the wasm `Battle` struct is in lib.rs); `places_ptr/len/stride` give the
views. `places_info()` is the static layout (JSON, once). `night_level()`, `night_s()`. `retune(json)` (dev only)
re-opens the same battle under a tuning override, for shots of rules far apart in time.
**Why:** no allocation per frame once the buffers have grown; lib.rs stays untouched.

### The view
**Decision:**
- One merged body mesh per place plus one owned mesh (painted white, coloured by the holder) through the fog patch's
  exact faces (pixel-stable). Ours `0x1f5a80`; the blight's places are corrupted: `0x4f3330` with their shingle bands
  glowing ember `0xc84a1c` instead of ×0.8; nobody's: thatch for villages, `0x6b5a48` for the fort culture.
- The keep shows its holder by its cones and roof (the medieval set) and two cloth hangings by the gate (the keeps'
  rule).
- The town's houses keep thatch roofs (03-land: "lerps from its thatch colour"); the town's holder shows on the
  chapel's roof and the belfry's spire. A fallen house hides its walls and roof and shows its ruin: wall stubs turned
  `0x3a332e`, a charred floor and three charred beams.
- Fire: 8 roof flame boxes per burning house (ramping over 6 s), smoke every 0.1 s and embers every 0.12 s; a
  smouldering ruin smokes every 0.3 s with a low ember; a doused house smokes 12 s. Smoke and embers are points snapped
  to whole art pixels, depth-tested but not written, fading by the Bayer dither.
- Torches: the flame (0.07×0.11×0.07 × FIG, flickering `0.8 + 0.35|sin(13t + id·1.7)|`) is held out before the bearer's
  left hand, since his company's banner stands 0.3 to his left; the light pools sit at the sim's positions.
- Works rise stage by stage (stakes one by one, a barricade's posts then logs, a bridge plank by plank, a tower's legs
  then platform, parapet and roof) and break down to a third of their height over 0.8 s when razed.
- Men on a bridge's laid deck stand on it: the battle view's private ground function is wrapped at install
  (`installPlaces`), pending a hook.
- At the ford the enemy's bot defaults to `raiders` (unless `?enemy=`), set by `installPlaces`.
- The CELL pass's lights: `View.lights`/`lightN` are now public (view.ts, two lines); the night level is written to
  `nightK` only when the sim's level changes, so `__v.night(k)` still works by day.

## D-20 | 2026-10-29 | Day 4: voice end to end in the game (06-voice §1–§3, §4b, §7; 05-sound §4)
**Summary:**
- **Hold V, or the captain for 400 ms:** time ×0.3, a mic ring, and the brain reads the field at hold start. On release: local whisper STT → fast path → Glimmer → resolve → `issue`, with the same marks as a tap.
- **Answers:** each company answers with its own synth horn from where it stands. Unclear speech gets a red X and the query horn.
- **Also:** typed orders in a new 5×7 bitmap font; named groups and waiting orders fed back; `?brain=` fallback with a 2.5 s abandon.
- **Feature names** are generated in the sim (`map/names.rs`). Voice orders are logged to `out/voice-log`.
- `npm run dev:https` (port 5174) serves phones.
- Built by a delegated agent; checked again before commit.
**Measured** (the agent, 47 WAV utterances in live battles):
- Release to marks: p50 0.91 s, p95 2.3 s (the spec's Mac target is 1.8 s p50).
- STT: p50 91 ms. Brain: p50 0.91 s.
- 31 of 35 judged orders carried out correctly (89%); typed 5/5.
- **My check:** typed orders through the live page (fast path, brain off) carried out with their marks, and no console errors.
**Open:**
- **Brain stability:** with the DFlash drafter, llama-server crashed once and hung once when two requests hit slot 0 together. The game sends one at a time, but this must be settled before a live demo: drafter off for the demo, or a request lock in the proxy.
- The Meta keys (Muse Voice Transcribe format, hosted brain URL).
- Phone HTTPS not yet tried on a device.
- Horns use only D and A (05-sound §1), where the §4 call table also lists C, F, G and E.

# Decisions: day 4, voice in the live game (06-voice §1–§3, §4b, §7; 05-sound §4; 08-orders §9; D-07, D-17)

Choices made where the spec is silent, while wiring voice into the live battle. Code: `crates/sim/src/map/names.rs`,
`crates/sim-wasm/src/voice_api.rs`, `web/vite.config.ts`, `web/src/voice/live/*`, `web/src/sound/*`,
`web/src/view/font5x7.ts`, and small changes to `web/src/voice/{field,resolve}.ts` (fixtures unaffected).

### Feature names: one plain word per feature, from pools, with distinct first sounds
**Decision:** `sim::map::names::name_features(map, companies)` names every site, the river, each ford, the 3 most
prominent hills (radius × height) and the 4 largest woods (4-connected forest of ≥ 8 tiles). Each kind has a pool of
plain words (keep NEST; town TOWN; villages MILL, BARN, FOLD, CROFT, GRANGE, THORPE, KILN, DAIRY, …; shrines SHRINE,
CAIRN, CHAPEL, …; towers SPIRE, LOOKOUT, BEACON, …; fords FORD, WADE, SHALLOWS, SHOAL, STEPS, GRAVEL; hills RIDGE,
KNOLL, TOR, BARROW, FELL, CRAG, …; woods OAKWOOD, ASHWOOD, ELMWOOD, BIRCHES, …). The keep, the town, the river and the
widest ford always get their pool's first word (NEST, TOWN, RIVER, FORD); the others start at
`hash32(map seed, index, salt) % pool` and take the first word that is free, not a command/kind/foe/work word, not
like a company's name (same word, one edit away, or same onset and consonants), and whose first sound (leading
consonant cluster with look-alike spellings folded, or first vowel) no other feature has; failing that, the first
free word. Sites are named first (id order), then the river and fords, hills, woods.
**Why:** single words survive speech-to-text, the canonicaliser and the grammar untouched; distinct first sounds keep
"the kiln" and "the crag" apart by ear. Over 240 maps (4 kinds × 3 widths × 20 seeds): 2,874 names, 25 sharing a
first sound (the pools run short on 80-wide keep maps with 11 sites), none numbered.
**Rejected:** two-word names (NORTH HILL, MILL STREAM in §4b's examples: they would need multi-word canonicalising and
show twice in `NEAR_…` and `breaks:…` enums); naming every wood (up to 14 on an 80-wide map: tokens for features no
one says); names independent of the companies (a TOR next to a TOM).
**Spec:** 06-voice §4b.

### The river is "RIVER", given by its stretch near the army
**Decision:** the one river is always RIVER; in the field its columns are the westmost and eastmost water columns over
the rows within 8 of the army's line centre, and its fords are listed by row and also as places of type `ford`.
**Why:** a player says "the river"; the generator lets the river drift ±1 a row across 20% of the map's width, so the
whole span put "our bank" up to 6 tiles from the water by the army (06-voice §6 resolves banks from x0/x1).
**Spec:** 06-voice §4b, §6.

### Fords are places, not sites; place ids are the sim's site ids
**Decision:** `FieldPlace.site` carries the sim's site id (null for a ford); the resolver uses it for `take`, and taking
a place that is not a site is holding it (a move there ready to fight). Without `site` (the eval fixtures) the place's
index is used as before. `Field.size` (the map in tiles) keeps routes and relative points half a tile inside the map
(it was putting "round the left" via points at y = −0.43).
**Why:** a Take of a ford would have named a wrong or missing site; the fixtures must resolve exactly as before
(both suites re-judged on cached replies: 20/20 and 145/146, unchanged).
**Spec:** 06-voice §6.

### What the live field shows (the player's fog)
**Decision:** our companies on the field (not fled or destroyed) at their men's centre, rounded to whole tiles; morale
only below 0.95; the captain's hp. Foes: only squads with a man in sight now, counted and placed by the seen men
only, state `marching <compass>` (mean velocity over 0.2 t/s), `fighting <our company>` (its threat), `routing`,
`idle`. A place's holder is shown once its ground has been seen. Works: ours, and the foe's in sight; a watchtower is
the TOWER, a second work of a kind is numbered (STAKES2). Facing and army left are 8-way compass words. With nothing
seen, the text says `FOES SEEN: none` (the fixtures always see foes, so their text is unchanged).
**Why:** "the model must not know more than the player"; seen-men counts and centres are what the screen shows.
**Spec:** 06-voice §4b; 08-orders §7.

### Voice orders go in through `BattleView.issue`; `apply_deeds` stays for batches with a note
**Decision:** the live game gives each resolved deed, in the batch's order (direct deeds first, waits after, D-17), to
the input layer's `BattleView.issue(deed, 'voice' | 'typed')`, which applies it at once and draws the order-given
marks from the sim's own order state, exactly as a tap or drag does; the sim's refusals are crossed there too. The
WASM `apply_deeds(json, src, note)` queues a whole batch at the current tick with the voice log as each command's
`note` (tested natively); the live path does not use it. Every voice order is logged in the page
(`__v.voiceLog()`) and appended to `out/voice-log/voice.jsonl` by the dev server: `{tick, team, deed, src, heard,
reply, brain, ms}` per deed, plus a per-utterance record with the stt/brain/end-to-end times and the field text.
**Why:** 06-voice §3 "its marks draw exactly as a tap or drag would"; the input layer made `issue` the one way in.
**Spec:** 06-voice §3, §7; ENGINE.md rule 1.

### The field is read once, when the hold starts
**Decision:** the field snapshot taken when the captain starts to hold (or the typed line opens) is the one warmed
into the brain, sent with the words, and resolved against.
**Why:** the warm only pays if the request's prefix is byte for byte the warmed one (D-07, D-17); measured, an order
then reads 9–14 new tokens instead of 180–400. Positions are at most ~1 s of slowed game time old.
**Spec:** 06-voice §3; D-07 "warm".

### One request at a time on the voice slot
**Decision:** the client sends brain requests to slot 0 strictly one after another; a warm is skipped while another
request runs or when the slot already holds that very field; an order waits at most 4 s for a warm still reading,
else it is abandoned (query horn). A tab only warms at load when it is visible.
**Why:** llama-server with the DFlash drafter aborted with `GGML_ASSERT(batch.size() > 0)` when a second request
arrived for slot 0 while it was still reading a prompt (two warms 1 s apart); later, with the eval and other tabs on
slot 0 at once, a task hung in "processing" for minutes until the server was restarted. Background tabs on the shared
dev server were warming their own fields into slot 0 on every hot reload, which evicted the playing tab's field
(seen in the server log; it caused the one abandoned order and a 2.2 s one in the measurements).
**Rejected:** the broodlord's slot 1 for overflow (cold prefix: 15–20 s).
**Spec:** 06-voice §2 (slots), §8.

### The fallback chain: a brain that fails is skipped, a slow one abandons the order
**Decision:** `?brain=local` tries local then hosted; `?brain=hosted` hosted only; `?brain=off` the fast path only. A
brain that errors (unreachable, 5xx) is skipped for 15 s and the next is tried at once; a request over 2.5 s is
abandoned and the order with it (query horn), without trying the next brain. `?brainms=` overrides the 2.5 s for
measuring. Without HOSTED_BRAIN_URL, `/brain-hosted` answers 503 at once.
**Why:** a second brain after 2.5 s would make the order 5 s late; an unreachable one costs nothing to skip.
**Spec:** 06-voice §2 "Fallback chain".

### Speech-to-text: whisper-server started on demand, Muse Voice Transcribe behind one function
**Decision:** `/stt` POSTs the WAV to a `whisper-server` (small.en, port 8178, 4 threads, no timestamps) that the dev
server starts on the first `/stt/warm` (sent when a hold starts) and keeps; the field's names (companies, groups,
places, ground, works, title case) and the foe and kind words are the per-request prompt. `whisper-cli` is the
fallback if the server will not start. `STT_ENGINE=meta` (the default once META_API_KEY is set) sends the WAV to
META_STT_URL as a multipart `file`/`model`/`prompt` request with the key as a bearer token, falling back to local on
any failure; the request shape is a placeholder until the API is confirmed. Keys are read from the repo's `.env` in
the dev server only (`.env.example` lists them; `.gitignore` now keeps `.env.example`).
**Why:** measured, small.en transcribes a 2–3 s clip in 70–110 ms on this Mac once loaded, under the spec's 0.3–0.7 s
for the API; starting it at hold start hides the ~1 s model load.
**Spec:** 06-voice §2 "Speech-to-text".

### HTTPS for phones without a new package
**Decision:** `npm run dev:https` (WARDENS_HTTPS=1) serves on 0.0.0.0:5174 over HTTPS with a self-signed certificate
for localhost and the machine's LAN addresses, made once with the system's `openssl` into `out/certs/`.
**Why:** browsers give the microphone only to HTTPS or localhost. The dependency is the system `openssl` binary
(present on macOS and Linux), not an npm package; the phone asks to trust the certificate once.
**Rejected:** `@vitejs/plugin-basic-ssl` (a new npm dependency for the same certificate).
**Spec:** 06-voice §3 "It needs HTTPS or localhost".

### The microphone is opened for each hold
**Decision:** each hold calls getUserMedia with the spec's constraints and stops the tracks on release; an inline
AudioWorklet box-averages the context's rate to 16 kHz and posts PCM and an RMS level; the ring maps −50…−10 dBFS
to 0…1. The WAV is 16-bit mono.
**Why:** "never record outside the hold": a stream left open shows the browser's recording light between orders.
The re-open costs ~0.1 s at the hold's start, while time is already slowing.
**Spec:** 06-voice §3 "Microphone details".

### Horn calls: Web Audio synths in D and A only
**Decision:** `web/src/sound/horns.ts` plays the five company calls, horn_army, horn_rally and horn_query as small
synths (detuned saws, a sub-octave triangle, a filter that opens on the attack, a late vibrato, a seeded noise room),
with the spec's rhythms, tempos, attacks, releases, rooms and levels (horn 0.2, army 0.22, rally 0.28, query 0.18;
sfx bus 0.85, master 0.9). The pitches are D and A only: call 0 `[a2 d3@3]`, 1 `[d3 d3 d3 a3@3]`, 2 `[a3@2 ~ d4@3]`,
3 trumpet `[a3 d4 a4 d5@4]`, 4 trombone `[d2@3 a2@3]`; recalls reversed; horn_army's lower line is `[a2@2 d3@4]`.
A company's horn is panned by `across × 0.6` from where it stands, with no distance fade; the army's, the rally and
the query are not positioned. Addressed companies answer 0.35 s apart. A commander gets the lowest call no other
company on the field holds and keeps it by name (localStorage).
**Why:** the brief and 05-sound §1 ("pitched SFX use only the notes D and A"); the §4 table's C, F, G and E and
horn_army's F contradict §1. Day 6 replaces the synths with rendered samples behind the same functions.
**Spec:** 05-sound §1, §2, §4; 06-voice §3.

### Time stays slow from the hold until the orders land
**Decision:** the clock's new `listening` flag (target 0.3, as `drawing`) is set while the captain holds, while the
typed line is open, and after release until the orders land or 3 s pass, whichever is first.
**Why:** 06-voice §3; typing an order is the same pause for thought as speaking one.
**Spec:** 06-voice §3 "While listening", "After release".

### The typed line is on by default until there are settings
**Decision:** Enter opens the line (5×7 bitmap font, cream on ink, at the bottom edge, at the art-pixel scale), it
takes every key while open (Space types a space), Enter sends, Escape closes; `?typed=0` turns it off. The brain reads
the field when the line opens.
**Why:** the spec puts it behind a setting, and there is no settings screen yet; the judges' noisy hall needs it now.
**Spec:** 06-voice §3 "Typed orders"; 01-flow §6 "Fonts and words".

### The listening ring and the refusal cross use the battle's marks
**Decision:** the ring is a per-frame drawer on the battle's `Marks`: gold, 0.14 wide, radius 0.8 + 1.6 × level with a
±0.06 pulse at 7 rad/s, dither alpha 0.55 + 0.45 × level. A refusal in the resolver (a company that cannot obey, a
missing target) is crossed at its target if one was understood, else at the captain; unclear words at the captain;
the query horn sounds once for any refusal in the batch, after the other horns.
**Spec:** 06-voice §3; 02-look §7.

### Waiting orders and groups
**Decision:** only orders waiting on the captain's signal are listed in `Field.waiting` (`who` as said, `<verb>
<target> on mark`, `n`); each is dropped when the sim no longer holds a pending deed with its queued tick and signal.
Groups are kept from each resolution and forgotten when all their companies are gone.
**Why:** a signal can only release signal waits; other triggers fire by themselves.
**Spec:** D-17 "the game must store groups and waiting orders"; 08-orders §6.

### The captain hold is the input layer's
**Decision:** voice binds `onCaptainHold((phase) => …)` from `web/src/input/hooks.ts` ('start' begins listening,
'end' releases), and V itself.
**Spec:** 01-flow §2; 06-voice §3.
