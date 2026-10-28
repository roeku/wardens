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
