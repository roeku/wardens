# VANGUARD rebuild: start here

Written 26 October 2026, the hackathon's kickoff day, for rebuilding VANGUARD at the Meta Global AI Developer Hackathon (building runs 27 Oct to 4 Nov; submissions close **Wed 4 Nov, 9:00 PM ET**).

This pack has two parts:
- **Part A (this file):** an honest review of the idea against the hackathon's rules, a recommended reframe, where Meta's models should go, a 9-day plan, and how to drive Muse Code with this pack.
- **Part B (the other files):** a full rebuild spec of VANGUARD, read out of the original code. It covers numbers, colours, algorithms, and the lessons that took about 130 recorded decisions to learn.

The spec files are written to be handed to a coding model that has never seen the original repository:

| File | What it covers |
|---|---|
| `01-flow.md` | the game, its feeling, input marks, screens, campaign rules, diegetic UI, persistence, harness, performance lessons |
| `02-look.md` | rendering pipeline, camera, light and night, palette, how a soldier is built and animated, banners, marks, quality tiers |
| `03-land.md` | map model, terrain generation, ground painting, biomes, structures by culture, burning, fog, the road, the chart |
| `04-battle.md` | simulation, unit stats, movement and formations, combat, morale, commanders, enemy AI, battle types |
| `05-sound.md` | audio engine, mix table, every SFX recipe, the seven pieces of music, horn calls, lessons |
| `06-voice.md` | voice command with a local Muse Glimmer: pipeline, serving, controls, prompt, schema, fast path, name resolution, determinism, the enemy broodlord on the same server, the day-one evaluation |
| `07-progression.md` | what the original lacked: Honour, company drills on rank-up, the boon draft, the Hall's tree, broodlord capture, heat levels, showing the threat, blight on the land; from We March as One, Dawn of Defense and Kingmakers |

> **Updated 27 Oct 2026, in the hackathon kit.**
> - The stack is now a Rust simulation (native + WASM) with a TypeScript/three.js view: see `docs/engine/ENGINE.md`. Spec passages that name TypeScript files or three.js for *rules* now mean the Rust sim. Rendering, input, voice and sound stay in TypeScript.
> - The day plan in §A4 is superseded by `docs/plan/plan-8-days.md`. Building starts on 28 Oct.
> - The code is written with Claude rather than Muse Code. Name your tools honestly in the README. Meta's models are used inside the product.

---

# Part A. The verdict

## A1. Does "remake VANGUARD, more polished" fit this hackathon? As pitched, no.

Here is what the guide says, and what it means for this idea.

### 1. The idea is on the guide's list of projects to avoid
The guide lists **"Anything political or involving war"** among its "Sample Anti-Projects".
- VANGUARD is a campaign of battles between armies. Its second campaign is Hannibal's war on Rome.
- Stage One of judging is **pass/fail** on whether the project "reasonably fits the theme".
- A real-history war game can be failed there before anyone looks at the craft. **This is the biggest risk, and it is fatal if ignored.**

### 2. The problem statements don't fit a game naturally
The statements are "Build for Your World" (solve a problem you know first-hand) and "Push the Frontier" (science, robotics, physical systems). "Impact" is a quarter of the Stage Two score:
> "What's the real-world potential here? Who benefits, and how much does it matter?"

A game, however good, scores low on Impact unless it is framed around a real benefit.

### 3. "New work only"
The guide says:
> "Judges must be able to clearly identify what was created during the Hackathon. Failure to clearly identify your original contributions will result in immediate disqualification."

What follows from this:
- **A remake from this spec is defensible**, provided you do three things:
  - start a fresh public repo on 27 Oct;
  - write no code before then;
  - say plainly in the README and the video that VANGUARD existed before, and that this design document came from it.
- **Do not copy code or assets from the old repo.** That covers the 111 sound files, the portraits and the shaders. Regenerate everything; the spec has every recipe.
- The rule says "startups may build on existing codebases". The indie track is not mentioned. **Ask in Discord `#questions` on day one** whether a ground-up rebuild of your own earlier prototype from its design doc is acceptable for the indie track. That one message removes the risk.

### 4. Using Muse Code only to write the game is a thin use of Meta's models
The rubric gives a quarter of the score to "Use of Meta AI Tooling":
> "Did they go beyond a basic integration? Did they surface capabilities that surprised even us?"

- A game written by Muse Code with no model inside it will likely pass Stage One.
- It will score low on this criterion, and it is ineligible for every bonus prize except the viral one.

### 5. Time
- Building lasts **9 days**. The original is about 75,000 lines and roughly 130 recorded decisions.
- Full parity in 9 days is not realistic, even with this spec. Eight empires, two campaigns, Myths and the Mediterranean chart are each days of work.
- **What is realistic:** a vertical slice that is more polished than the original was at the same point. That's because this spec removes the months of finding out:
  - which movement model doesn't shiver
  - which hit-test radii work on a phone
  - which sounds were too loud
  - which performance mistakes to avoid

### 6. The coding agent will be weaker than what built VANGUARD
- Third-party reviews place Muse Code below Claude Code. Its model, Muse Spark 1.2, scored about 59% on DeepSWE.
- This pack is meant to make up for that. The model should never have to invent a constant. It should be held to the acceptance numbers in A5.

### So: change the pitch, keep the engine
None of the six points above is a reason to stop. Together they say:
- keep the engine;
- change what the battles are about;
- put Meta's models **inside** the game, where judges can see them.

## A2. Recommended reframe: same engine, no war between peoples

Drop the human-against-human war and the real history. Keep everything that makes VANGUARD feel like VANGUARD:
- command by marks on the field
- companies led by commanders with faces
- losses that stick
- villages you save
- holding the line through the night
- the Hall of Banners

**Proposal: THE WARDENS.**
- **The player:** a warden-captain leading companies of a frontier watch against **a blight of beasts**: drake packs, trolls, a horde out of the wild.
  - The original already has these, with rules (the drake's breath and hunt), animation and sound.
  - The first mockup, "the line and the flood", already shows stone trolls and a horde.
- **The places:**
  - Villages are overrun, not burned by an enemy king.
  - The ford is still a rescue: carry the people across ahead of the horde.
  - The night is still "hold until dawn".
  - The keep becomes the blight's nest.
- **Company kinds** stay the same (spear, shield, bow, horse), and so does their logic. Spears brace against charges, shields soak missiles, bows need a line in front of them, horse flank.

**Why this beats the alternatives:**
- It removes the "war" problem rather than arguing about it. Defending villages from monsters is a rescue, not a war between nations.
- The owner once ruled against a fantasy horde, to keep the game an RTS. The fix that ruling relied on still holds: the enemy must be **armies with their own commanders, formations and morale, not a swarm.** Give the blight its own named "broodlords" (the original's enemy commanders, who escape and return a rank harder), and pack tactics through the same AI.

**Confirm with the organisers before building.** Ask in Discord whether "fantasy creatures attacking villages" is acceptable. It costs one message.

**If the organisers clear historical battles anyway:** keep the war theme and the rest of this plan still applies. Don't count on it.

## A3. Where Meta's models go: inside the game, not just behind it

Each idea below shows what the model does, why it fits VANGUARD's pillars, and which prize it targets.

### 1. Command by voice: Muse Voice Transcribe, then a local Muse Glimmer (full design in `06-voice.md`)
**What it does.** Hold V, or hold your captain still for 400 ms, and speak:
> "Bors, take the riders round the left to the mill. Everyone else, hold the ridge."

- **Ears:** Muse Voice Transcribe turns speech to text. A local whisper.cpp is the offline option.
- **Interpretation:** **Muse Glimmer, running locally,** turns the text into orders.
  - It reads a compact, fog-limited description of the field.
  - Its output is constrained to a JSON schema built per battle, so every company, place and enemy is an enum it can't invent.
  - It never emits coordinates; code resolves names and "left/right" into points.
- **Instant shortcut:** common words ("rally", "hold", "Wil, come back") skip the model entirely.
- **Queue:** the orders enter the **same tick-stamped order queue** as taps and drags.
- **Speed:** time slows to ×0.3 while the captain speaks, as it does while drawing a line, so the model's delay becomes part of the game.
- **Hosting:** the public build serves the same weights on Modal or Baseten.
- **Test first:** run the 20-command evaluation in `06-voice.md` §9 on day one, before anything depends on it.

**Why it fits the game.**
- It is more diegetic than any button, and it is how commanders actually gave orders.
- The original's pillar was "extremely easy to control". Voice is the strongest version of that.

**What to build.**
- Always show the parsed order on the field, as the same marks a tap would draw: lines, flags, rings.
- Every voice order is revocable with a tap.

**Why it scores.** This is the clearest "surprised even us" moment for the demo. It is also your **Impact** story:
- RTS is a genre locked behind APM (actions per minute) and fine motor control.
- Voice plus a few marks makes real-time strategy playable for people with limited dexterity, and on a phone.

Be honest in the pitch: it is an accessibility *pattern* proven on a game. Don't present it as a medical product.

### 2. The enemy's mind: Muse Glimmer or Muse Spark Open on your own hardware
**What it does.**
- Every 5 to 10 seconds of game time, the enemy broodlord gets a compact text state:
  - what the enemy's own fog shows
  - its companies, with morale and position
  - the objectives
- It answers with intents in the same order schema the bots use, for example: "sally at the east village with two packs", "pull the wounded drakes back".
- The fast, deterministic bot policy (`04-battle.md` §7) carries those intents out between calls.

**Why it fits the game.**
- A model's latency (seconds) is fine for strategy and fatal for steering. So the model only decides where to go and what to attack; the bot code moves the units.
- **Determinism survives** because the model's answers are logged into the order queue. A replay is still the seed plus the log.

**Prize.** It targets **"Best Build on Meta Open Weight Models" ($10k)**. Glimmer is 30B and Apache-2.0, and runs locally in under 20 GB. Partner inference is Baseten, Modal or Fireworks; on Baseten use `meta-models/muse-spark-open-1026`. Each commander's personality can be a system prompt plus its trait: a reckless broodlord over-commits, a cautious one baits.

### 3. Faces, banners and the chronicle: Muse Image and Muse Spark
**Portraits.**
- Every commander gets a portrait from Muse Image, using the original's prompt skeleton (`01-flow.md` §7) and its post-process: flat background, eyes at y 40, 80×96 tiles, a 64-colour palette per side.
- So a campaign's cast is new every time and still consistent.
- The same `look` text drives the commander's 3D figure.

**Optional: raise your own commander from a photo.**
- Muse Image accepts photos, and SAM 3.1 can cut the head out cleanly before pixelising.
- This is very shareable and helps with the **Most Viral** prize.
- Make it opt-in, keep it on the device where possible, and never use another person's likeness.

**Banners.** Generate each company's device from a few words chosen by the player, then quantise it to the 7×9 emblem grid.

**The campaign remembers in words, where words belong.**
- At camp, and in the chronicle, Muse Spark writes from the **actual battle log**: who held, who broke, who fell, which village was saved.
- Output is one short letter from a commander, or the chronicle's lines.
- This answers two of the owner's open questions: "May a camp have a few words of its own (a letter, a song at the fire)?" and "Does the enemy need a story?"
- It also makes the feeling the game is built around land harder: *"Wil's company held the ford all night, and then Wil fell. His banner is in my hall now."*
- **Keep the battlefield wordless.**

**Prize.** It targets **"Best Creative Build" ($5k, Muse Image or Muse Wonder)**.

### 4. Muse Code: how the game gets built
Show it in the video: a 15-second time-lapse of agents building from the spec, and the harness running.

**Agentic angle ("Best Agentic Use-Case", $5k).** The commanders become real agents:
- They take a voice order.
- They decide how to carry it out, given their trait.
- If it is suicidal they refuse, and say why, by horn and a red cross.
- An AI game master (Muse Wonder) composes each campaign's road, places and broodlords.

This is a stretch goal. Don't start it before the core works.

**How to use the models safely in a deterministic game:**
- **The model never touches the simulation directly.** It only emits orders through the queue, which are validated against the schema and the rules ("can this company reach there?"). Invalid orders are refused, on the field, with a red cross.
- **Cache and log every model reply,** so replays, tests and the demo video are reproducible.
- **Budget the $150 of credits.**
  - Voice: one Muse Voice Transcribe call per spoken order. Interpreting runs on local Glimmer and costs nothing; the hosted copy for judges runs on Modal or Baseten credits.
  - Enemy mind: about 10 calls per minute of battle, against Glimmer, which is free if it runs on your own hardware.
  - Portraits: batch them per campaign and cache them.
  - Set a spend limit on the billing page.

## A4. The plan: 9 days, one vertical slice, polished

**The slice:**
- **Setting:**
  - one land, the meadow, with the medieval buildings
  - one campaign road of 4 steps plus the nest
- **Your side:**
  - your 4 kinds plus the captain
  - **2 or 3 enemy kinds:** a drake pack (breath and hunt), trolls (impact blows), a swarm of blight-men (levy stats)
  - commanders with faces, the muster parade ground, cards, the Hall of Banners
- **Places and battles:**
  - **4 place types:** holdfast-nest, village under attack, ford rescue, camp
  - night until dawn
- **Command:** the full mark set and voice orders
- **Around the game:**
  - LLM broodlords
  - **progression** (`07-progression.md` §11): Honour, company drills, the boon draft, the Hall's tree rings 1–2, the enemy roster on place cards
  - camp letters and the chronicle
  - sound and music
  - the ghost-hand lesson
- **Cut:** the 8 empires, Hannibal's campaign and chart, cultures other than medieval, custom battles (keep one "quick battle" button only if time allows), quality tiers beyond high/low, the full performance rig.

**Day by day:**

| Day | Date | Build | Done when |
|---|---|---|---|
| 1 | Tue 27 | Repo, Vite + TS + three.js. Seeded RNG, `hash32`, value noise. Map generator (assault + ford). Simulation skeleton at 30 Hz with the **order queue** and the **headless harness CLI**. Render pipeline: art-pixel target, ortho 30° camera with pixel snap, toon ramp, outline pass. **Voice spike:** Glimmer served locally, and `voice-eval` (`06-voice.md` §9) run against it. | `harness play` runs a battle as text and a PNG; the land renders without shimmer while panning; voice-eval at least 18/20, with latency measured (if it misses, decide local or hosted today) |
| 2 | Wed 28 | Ground painter (12 texels/tile, Bayer), trees, water, fog. Instanced soldier parts, procedural walk, posing, hit flash, death. Banners atlas. | units-lab page shows each kind at game scale; no flicker at any zoom |
| 3 | Thu 29 | Movement (slots, momentum steering, cohesion gate, column/line following the captain), formations (`planFront`), combat, morale, routing, commanders, recall. Bots (`garrison`, `commander`). | bot campaigns win in the 30–50% band; standing reversals < 0.1/s |
| 4 | Fri 30 | Input marks with the exact thresholds, ghost bars, pause, time slow. Structures (medieval set), villages burning, the ford, the night. **Voice orders end to end:** hold to talk, `/stt` + `/brain` proxies, name resolution, validation, horn answers, the typed-order option. | a person can play a whole battle on a phone and by voice |
| 5 | Sat 31 | Campaign road, muster parade ground, cards, Muse Image portraits + post-process, the Hall. **The LLM broodlord** with the bot as its hands. | a full campaign plays start to finish |
| 6 | Sun 1 | **Progression** (`07-progression.md` §11): Honour tally, company drills, the boon draft, the Hall's tapestry, roster pictograms, the aura tint, draft bots and balance sweeps. In parallel (a separate sub-agent, separate files): the sound lab, rendering every SFX and the music from the recipes, with the mix table, spatial rule, horn calls and music director. | bots hit the progression bands (`07-progression.md` §10); `sound-check` levels within targets |
| 7 | Mon 2 | Camp letters and the chronicle from the battle log. Ghost-hand lesson. Sound wiring, if Day 6 left any. Polish passes against the "Rules of the look". Performance basics: worker land, never dispose materials, split the bundle. | first-time players learn without words |
| 8 | Tue 3 | Bug bash on real phones, deploy, cache headers. Freeze features at noon. The last office hours for submission questions are today. | live URL stable |
| 9 | Wed 4 | **Demo video (3 min)**, README with a *built during the hackathon* ledger, X post (viral prize, engagement counts until 8 Nov), submit before 9 PM ET. | submitted |

**The 3-minute video.** Cut it like this:
1. 20 s: the feeling, a company you've named holding the ford at night.
2. 60 s: commanding by voice, with marks appearing on the field.
3. 40 s: the broodlord out-thinking you, then you adapting.
4. 30 s: a rank-up drill chosen for a commander you know, then that commander's banner in the Hall when they fall, the letter they left, and the Hall's tapestry growing.
5. 30 s: how it's built: Glimmer locally, Muse Image faces, Muse Code building from the spec, the deterministic harness.

Judges rank from this video. **Show only work built during the hackathon.**

## A5. How to drive Muse Code with this pack

**Setup.**
- Put the seven spec files in the new repo under `docs/spec/`.
- Add an `AGENTS.md` that says:
  1. The spec is the source of truth. **Never invent a constant that the spec gives.** If the spec is silent, choose, and write the choice down in `DECISIONS.md` with a reason.
  2. Every rule is runnable headless. The simulation never reads the view. All randomness goes through `hash32(seed, id, salt)` or the seeded `Rng`. All input goes through the order queue.
  3. Every number lives in a named tuning table.
  4. No text on the battlefield. No browser fonts. No alpha blending (use dithering). No `Math.random` in the view.
- **Work one row of the plan at a time.** Use `/plan`, then build, then verify, with the spec section named in the prompt ("Implement `04-battle.md` §3c exactly").
- **Verify with numbers, not vibes.** These acceptance checks come from the original's measurements:
  - movement: standing direction reversals < 0.1 per second per man; company state flips (march ↔ stand) < 10 per squad-minute
  - balance: a sensible bot wins 30–50% of campaigns; a mindless charge wins 20–60% of field battles; doing nothing wins 0%
  - determinism: the same seed and order log give a bit-identical state hash after N ticks
  - input: a 9 px slide on the captain on touch is still a tap; a tap on his head selects him
  - render: no figure moves by a fractional art pixel; nothing thinner than 1 art pixel; no flicker at any of the 9 zooms
  - sound: horns about 4 dB over the road tune; commander_fall the loudest signal (about −21 LUFS); no ceremony cue longer than 1.2 s
  - performance: battle start < 0.5 s after the land is ready; materials never disposed; terrain built in a worker
- **Give it eyes:**
  - a dev-server endpoint that saves WebGL screenshots (`window.__v.shot(name)`)
  - the harness's PNG frames
  - ffmpeg loudness and spectrogram checks

  A coding model can't watch or listen, so it must measure.
- **Use sub-agents in parallel only on independent files:** for example sound, terrain painter and figures.

**Disclosure ledger template** (for the README):
> **Built before the hackathon:** VANGUARD, a prototype by the same author (link). Its design was documented in `docs/spec/`, which was written before 27 Oct 2026 and is the only material carried over.
> **Built during the hackathon (27 Oct to 4 Nov 2026):** all code, art, sound and music in this repository; voice command (Muse Voice Transcribe + Muse Glimmer, run locally); the broodlord AI (Muse Glimmer, the same local server); portraits and banners (Muse Image); camp letters and the chronicle (Muse Spark); built with Muse Code.

## A6. Licences and rights to check
- **Strudel is AGPL.** Use it only as an offline tool in a dev page, and ship only the rendered audio, as the original did. Alternatively, write the SFX as small Web Audio synth functions in your own code.
- **VCSL samples are CC0.** The original left the General MIDI soundfont licences (FluidR3, MIT; GeneralUser) as an open item. Check them, or avoid them.
- **The original's portraits** were made with a third-party model and LoRA. Don't reuse them; regenerate with Muse Image.
- **The repository must be public** by submission.
