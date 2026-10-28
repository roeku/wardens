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
