# THE WARDENS

*Command your army by voice.* A real-time strategy game where every order is a mark on the field or a sentence you speak. A local Meta Muse Glimmer turns what you say, together with what your captain can see, into orders. Companies are led by commanders with faces. They grow, they fall, and the Hall of Banners remembers them.

**Play:** <public URL> · **Video:** <3-minute demo link> · **Track:** Indie Developer · Meta Global AI Developer Hackathon 2026

## What it does
- **Voice command.**
  - Hold V, or hold your captain, and speak: "Bors, take the riders round the left to the mill."
  - Time slows while you speak.
  - The order appears on the field as marks, and the company answers with its own horn call.
  - A tap undoes any order.
- **Marks.** Tap to march, draw a line to form a front, drag a company to send it, tap the captain to rally.
- **An enemy that thinks.** The enemy broodlord is an LLM agent on the same local Glimmer. It sees only through its own fog of war and decides where to strike. Deterministic bots carry out its intents.
- **A campaign that remembers.**
  - Commanders earn drills as they rank up, and lose them when they fall.
  - You choose a boon after each battle.
  - Honour builds the Hall's tapestry between campaigns.

## How Meta's models are used
| Model | Where | How |
|---|---|---|
| Muse Glimmer (open weights, local on an Apple M5 Pro via llama.cpp; hosted copy on <Modal/Baseten> for the public build) | voice interpretation, the enemy broodlord, camp letters and the chronicle | JSON-schema-constrained output with per-battle enums; the fog-limited state as context; replies validated, logged and replayable |
| Muse Voice Transcribe (Meta Model API) | speech-to-text | <if available; otherwise state what was used> |
| Muse Image | commander portraits | <if available> |

## Why it matters
Real-time strategy is locked behind fast, precise hands. Speaking plus a few marks on the field makes it playable for people with limited dexterity, and on a phone. With the local model, the player's voice never leaves their machine.

## Built during the hackathon, and before it
- **Before the hackathon:** VANGUARD, an earlier prototype by the same author (<link, if public>). Its design was written up as `docs/spec/` before 27 Oct 2026. **That document is the only material carried over: no code, art, sound or music.**
- **During the hackathon (27 Oct to 4 Nov 2026):** all code, art, sound and music in this repository:
  - the Rust simulation and its WASM build
  - the three.js renderer
  - voice command
  - the broodlord agent
  - progression
  - deployment

  The commit history starts on <date>.
- **Tools:** coded with an AI coding assistant (<name it honestly>). Meta's models are used inside the product, as listed above.

## Run it
```bash
npm install && npm run sim && npm run dev        # the game on localhost
scripts/brain.sh                                  # local Glimmer (llama-server), see DECISIONS.md
cargo run -p harness -- play demo new 4           # headless play
```

## Technical notes
- **Simulation:** Rust at a fixed 30 Hz. It is deterministic (seeded hashes, `libm`) and bit-identical natively and in WASM. A replay is the seed plus the order log.
- **Harness:** a headless CLI with bots and balance sweeps.
- **Renderer:** three.js toon shading drawn into a low-resolution art-pixel target, with depth outlines, Bayer dithering and a night pass by torchlight.
- **Audio:** sound and music authored as code and rendered to files.

## Licence
MIT. See `LICENSE`.
