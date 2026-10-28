# The plan: 8 building days (Cambodia time)

This replaces the 9-day table in `03-spec/00-start-here.md` §A4. You start on **Wed 28 Oct**, and the hard deadline is **Thu 5 Nov 9:00 AM ICT**.

Stack: **Rust sim (native + WASM) with a TypeScript/three.js view** (`../04-engine/ENGINE.md`).

## Order of work
Each day ends at a gate you can check. If a gate fails, fix it the next morning before starting anything new.

| Day | Date (ICT) | Build | Gate |
|---|---|---|---|
| 1 | Wed 28 Oct | **Morning:** repo, Cargo workspace (`sim`, `sim-wasm`, `harness`), Vite + TS + three.js, `wasm-pack` script, contracts copied in. `hash32`, `Rng`, value noise, map generator (assault + ford), heights. Sim skeleton at 30 Hz with the **order queue**. Harness `play/look/wait` printing text and a top-down PNG. **Afternoon:** three.js pipeline (art-pixel target, ortho 30° camera with pixel snap, toon ramp, outline pass) showing the land's heights and a flat-colour ground from WASM. **Evening:** voice spike. `llama-server` with Glimmer, then `voice-eval` in text mode (`../06-voice-eval/`). | same seed + log gives the same state hash natively and in WASM; the land pans without shimmer; voice-eval run, with accuracy and latency written into DECISIONS.md |
| 2 | Thu 29 Oct | Ground painter in Rust (12 texels/tile, Bayer, tufts, roads, fields), trees, rocks, water shader, fog. Instanced soldier parts in TS, the walk cycle, poses, hit flash, death, banners atlas. **Units lab page.** | every kind visible at game scale with no flicker at any of the 9 zooms; land building time measured (move it to a worker if over 50 ms) |
| 3 | Fri 30 Oct | Rust: slots, momentum steering, cohesion gate, the column/line army following the captain, `planFront`, combat, morale, routing, commanders, recall, the captain's ride. Bots `garrison` and `commander`. Harness `sweep` with the jitter metric. | standing reversals < 0.1/s; state flips < 10 per squad-minute; bot battles end sensibly; mindless charge 20–60% |
| 4 | Sat 31 Oct | Input: the pointer state machine with the exact thresholds, the marks, ghost bars, pause and time slowing. Structures (medieval set), villages burning, the ford, the night pass. **Voice end to end:** hold to talk, `/stt` + `/brain` in Vite middleware, fast path, resolve, validate, horn answers. | a whole battle playable on your phone, by touch and by voice |
| 5 | Sun 1 Nov | Campaign road, muster parade ground, cards, bitmap font, the Hall. Portraits: Muse Image if you have access, otherwise the fallback in `../00-today-checklist.md` §5. **The LLM broodlord** (Glimmer slot 2), with the bot carrying out its intents. | a whole campaign plays start to finish |
| 6 | Mon 2 Nov | **Progression** (`07-progression.md` §11): Honour tally, drills, the boon draft, the Hall's tapestry rings 1–2, roster pictograms, the aura tint; draft bots and native sweeps. **In parallel (a second session, separate files):** sound lab renders, the Web Audio engine, mix, music director. | progression bands met (`07-progression.md` §10); sound levels within targets |
| 7 | Tue 3 Nov | Camp letters and the chronicle (Glimmer, from the battle log). Ghost-hand lesson. Polish against "Rules of the look". Deploy to Vercel or Cloudflare; **hosted Glimmer on Modal or Baseten**, with `?brain=hosted` as the default on the public URL. **Feature freeze at 6 PM.** Office hours 10–11 PM for submission questions. | the public URL works on a phone you've never used, by voice, with the hosted brain |
| 8 | Wed 4 Nov | Bug bash. **The 3-minute video** (clips gathered since day 2). README with the disclosure ledger. Make the repo public; check the video link and the team list. **Submit by 11 PM ICT.** | submitted, about 10 hours before the deadline |
| — | Thu 5 Nov morning | Reserve only. After submitting, post on X (the Most Viral window runs to 8 Nov). | |

## Cut list, in order (when a day overruns, cut from the top)
1. Heat levels.
2. Broodlord capture choice.
3. Camp letters. Keep the chronicle, which is shorter.
4. Blight corruption on the land. It's a strong visual, so cut it late.
5. The ford place type.
6. The night. Make day battles longer instead.

**Never cut:** voice orders, the order queue and replays, the drawn front, commanders with faces, the Hall, the progression core, the hosted brain for the judges.

## The 3-minute video
1. **0:00–0:15.** The We March as One YouTuber's line, *"Cavalry, you're going for the wrong troops, please get their archers"* (quote it as text on screen; don't use their footage). Then **you** say it, and your riders turn.
2. **0:15–1:15.** A battle commanded by voice and marks: time slows while you speak, horns answer, a front is drawn, a company is sent round the flank and called back with a tap.
3. **1:15–1:50.** The broodlord adapting: a sally on a village, and you answering it.
4. **1:50–2:30.** A commander you know gets a rank-up drill; later they fall; their banner stands in the Hall; their letter; the tapestry grows.
5. **2:30–3:00.** How it's built: Glimmer on the laptop (show the llama.cpp timings), the order queue and replays, the Rust sim running natively in the harness, the hosted brain. End with the disclosure line.
