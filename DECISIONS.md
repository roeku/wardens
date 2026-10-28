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
