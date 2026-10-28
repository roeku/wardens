# Working rules for coding agents in this repository

**The game.** THE WARDENS (working title). A real-time strategy game commanded by marking the field and by voice. Companies are led by commanders with faces; losses stick; villages are freed from a blight. It is built for the Meta Global AI Developer Hackathon (27 Oct to 4 Nov 2026).

## Source of truth
- `docs/spec/` is the design. Start with `00-start-here.md`. The other files:
  - `01-flow.md`: input, screens, campaign
  - `02-look.md`: rendering
  - `03-land.md`: terrain and structures
  - `04-battle.md`: simulation
  - `05-sound.md`: audio
  - `06-voice.md`: voice command
  - `07-progression.md`: progression
- `docs/engine/ENGINE.md` is the architecture. `docs/engine/contracts/` holds the shared types.
- **Never invent a constant the spec gives.** When the spec is silent, choose, and add an entry to `DECISIONS.md`: the date, the decision, the reason, and the alternatives rejected.
- When the spec and the code disagree, fix the code, or record the change in `DECISIONS.md` and update the spec.

## Architecture rules
1. **The simulation (`crates/sim`) never reads the view, and the view never writes to the simulation.** Every change to a battle is a `Command {tick, team, deed, src}` through the order queue. Taps, drags, voice, bots and the LLM broodlord all go through it.
2. **Determinism:**
   - Randomness only from `hash32(seed, id, salt)` or the seeded `Rng`.
   - `libm` for every transcendental function.
   - No `HashMap` or `HashSet` iteration in the sim.
   - Sort with `total_cmp` and an id tie-break.
   - No threads inside a tick.
   - The native-vs-WASM hash test must stay green.
3. **Every number lives in a named tuning table** that a JSON override can replace (for the harness and balance sweeps).
4. **Every rule is runnable headless** through `crates/harness`. Every new rule comes with a harness check that **prints its counts**.
5. **Model output never touches the sim directly.** It is resolved into Deeds in code, validated, then queued. Model replies are logged and cached, so tests replay without a GPU.

## The look and feel (non-negotiable)
- **No HUD on the battlefield:**
  - no text over the field
  - no browser fonts anywhere (use the 5×7 bitmap font)
  - nothing that looks like a web page
- **No alpha blending.** See-through effects use the 4×4 Bayer dither.
- **No `Math.random` in the view.** Use the seeded `rand()`, so frames can be compared.
- **Pixel stability:**
  - the camera and every figure snap to the art-pixel grid
  - no vertical bob
  - nothing thinner than 1 art pixel
- **Phones are first-class.** Use the touch thresholds in `01-flow.md` §2.

## How to work
- Work on one plan row (`docs/plan/plan-8-days.md`) or one spec section at a time. Name the section in commits.
- **Verify with numbers.** Use:
  - the harness (`cargo run -p harness -- …`)
  - screenshots (`window.__v.shot(name)`, saved to `out/shots/`)
  - ffmpeg loudness checks for sound
  - `voice-eval` for the brain

  You can't watch or listen, so measure. The acceptance numbers are in `00-start-here.md` §A5.
- Keep commits small and frequent, so the hackathon history shows the work as it was done.
- **Don't add dependencies without a line in `DECISIONS.md`.**
- Assets: everything in this repo is made during the hackathon. **Never copy files from the earlier VANGUARD project.**
