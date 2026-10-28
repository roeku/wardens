# Voice command with a local model

The captain speaks; the army obeys. A local Muse Glimmer reads what was said, together with what the captain can see, and returns orders in the game's own schema. Those orders enter the same tick-stamped order queue that taps and drags use.

Two constraints shape everything below:
- **The model never touches the simulation.** It only proposes orders, the game checks them, and replays use the checked orders, never the model.
- **Speed decides whether this feels like command or like waiting.** Every design choice below serves one of those two constraints.

Status of the details:
- Facts about serving tools (llama.cpp flags, MLX structured output, the Muse Voice Transcribe API's request format) are what was known on 27 Oct 2026. **Check them against current docs on day one.**
- Latency figures are estimates to be replaced by the measurements in §9.

---

## 1. The pipeline

```
hold to talk ──► capture 16 kHz mono ──► speech-to-text ──► normalise text
                                                            │
                                     fast path matched? ────┤── yes ──► orders
                                                            │
                                                            no
                                                            ▼
            field state (fog-limited) + text ──► Glimmer, JSON-schema constrained
                                                            │
                                                            ▼
                                     resolve names, sides and features in code
                                                            │
                                                            ▼
                                     validate (exists, can obey, reachable)
                                                            │
                                    ┌───────────────────────┴───────────────────┐
                                    ▼                                           ▼
                     order queue {tick, team, deed, src:'voice'}     refused: red cross + query horn
                                    ▼
                     marks on the field + each company's own horn call
```

## 2. Models and serving

### Interpreter: Muse Glimmer, run locally
Glimmer is 30B, dense, Apache-2.0, and under 20 GB at 4-bit. It is the only Meta model that runs on one machine. Muse Spark Open is 816B MoE and needs about 700 GB of GPU memory, so it can only be used hosted.

- **On a Mac:** you need 32 GB of unified memory at the very least, and 48 GB or more to be comfortable.
- **Serving option A: llama.cpp `llama-server`** with a 4-bit GGUF of Glimmer, all layers on the GPU (Metal or CUDA).
  - Context about 8k, with 2 parallel slots: one for voice, one for the enemy broodlord.
  - Use its OpenAI-compatible `/v1/chat/completions` with `response_format` set to a JSON schema. llama.cpp turns the schema into a grammar, so the output is always valid JSON in the schema.
  - Keep `cache_prompt` on, so the shared prompt prefix is reused between calls.
- **Serving option B: `mlx-lm` server** on Apple silicon. It may be faster on a Mac. If its structured output is weaker, fall back to "parse, validate, and retry once with the error".
- **Choose by measurement** with the evaluation in §9, not by reputation.

### Speech-to-text
Glimmer is not reported to take audio, so it needs text in front of it.

- **Option A: Muse Voice Transcribe** through the Meta Model API.
  - A Meta model, cheap per order. Audio goes to Meta's servers.
  - If the API accepts a vocabulary hint or prompt, pass the company names, place names and kind words.
- **Option B: whisper.cpp `whisper-server`** locally, with a small English model and the same names as its initial prompt.
  - Fully offline, but not a Meta model.
  - Keep it as the "offline / private" setting.
- **Build A first.** The interpreting step, which is where the intelligence is, stays on local Glimmer either way.

### Hosted copy for judges and players
Judges won't have your GPU. Serve the **same Glimmer weights** on Modal or Baseten for the public build. Partner inference still counts for the "Best Build on Meta Open Weight Models" prize.

- **`/brain` is the only URL the game knows:**
  - In development, a Vite dev-server middleware proxies `/brain` to `localhost` llama-server, which avoids CORS.
  - In production, a serverless function proxies it to the hosted endpoint and holds the API key. **Keys never reach the browser.** Rate-limit by IP.
- `/stt` works the same way for transcription.
- **Choose the brain with `?brain=local|hosted|off`.** `off` means the fast path only (§5).
- **Fallback chain:** local, then hosted, then fast path only. A request that takes longer than 2.5 s is abandoned. The player gets the query horn and can repeat, or tap.

## 3. Talking: the controls

**Desktop: hold V.** Space is already pause.

**Touch: press and hold your captain without moving for 400 ms.**
- A shorter press is still a tap (rally).
- Moving past slop is still a drag (march along the path).
- So the gesture fits into the original input rules. After a 400 ms hold, releasing is not a tap.

**While listening:**
- **Time runs at ×0.3**, exactly as while drawing a line.
- The captain raises his horn (a pose).
- A dithered ring pulses at his feet, scaled by microphone level. It is a mark on the field, not a widget.
- **There are no words on screen.**

**After release:**
- Time stays at ×0.3 until the orders land, or for at most 3 s, then eases back at the usual rate (`dt*12`).
- **Each addressed company answers with its own horn call, from where it stands** (`05-sound.md` §6). An order to the whole army sounds `horn_army`.
- Its marks draw exactly as a tap or drag would: the order flag, the dashed route, the attack ring, the ghost bars of a front.
- **Anything a voice order did can be undone with a tap**: tap the order flag, or the captain to rally.

**Refused or unclear:**
- A red cross at the captain, or at the target if one was understood.
- A short `horn_query` cue, new for this feature:
  ```
  setcps(1); note("[a3 ~ a3@2]").s("gm_french_horn").n(1).attack(.04).release(.3).lpf(1200).gain(.7).room(.3)
  ```
  Mix it at 0.18.

**Typed orders, for accessibility and noisy demo halls:**
- Enter opens a single line drawn in the bitmap font at the bottom edge.
- Its text goes through the same pipeline without speech-to-text.
- It is off by default and turned on in settings. Judges at a loud venue will thank you.

**Microphone details:**
- `getUserMedia({audio:{channelCount:1, echoCancellation:true, noiseSuppression:true}})`, asked for on the first hold. It needs HTTPS or localhost.
- An AudioWorklet downsamples the input to 16 kHz mono PCM. Encode it as WAV on release.
- **Never record outside the hold.**

## 4. What the model is told

### 4a. Static prefix (cached, identical byte for byte every call)
```
You are the voice of a warden-captain's will. You turn the captain's spoken words into orders
for the companies on the field. Reply only with JSON in the given schema.

RULES
- Use only the names listed in the field state. Company names, place names, feature names
  and enemy ids are the only targets that exist.
- "Left" and "right" are the ARMY's left and right as it faces the enemy (given as FACING),
  never the screen's.
- Kind words name every company of that kind: riders/horse/cavalry = HORSE, archers/bows = ARCHER,
  spears/pikes = SPEAR, shields = SHIELD. "Everyone", "all", "the army" = ARMY.
  "Everyone else" / "the rest" = OTHERS (every company not named earlier in the same words).
- "take", "free", "save" a village or place = take. "Go", "march", "move", "scout" = move with
  fight=false. "Hold", "stand", "block", "guard" a place = move to it with fight=true, then it holds.
  "Attack", "charge", "kill", "hit", "shoot" = attack. "Form a line", "line up along" = front.
  "Come back", "back", "return", "to me" for a company = recall. "Rally" = rally.
  "Fall back", "retreat" to a place = move with fight=false.
- One sentence may hold several orders. At most 4.
- If the words do not say who or what, set unclear=true and give no orders. Never guess a target
  that was not said.
- "dragon", "drake", "wyrm" all mean drakes; "troll", "giant" mean trolls; "them", "the enemy"
  means the nearest seen foe to the named company.
```
Follow this with 8 short examples in the same JSON, worded differently from the evaluation set. The examples are part of the cached prefix.

### 4b. Dynamic field state (about 250 tokens, built per call from the team's fog)
Coordinates are in tiles, with x east and y south. Show only what the player's side can see. **The model must not know more than the player.**
```
FACING east. Army left = north.
OURS: BORS horse 6/6 (10,10) idle | WIL spear 12/12 (13,13) idle | ODA shield 10/10 (13,16) idle |
      REN archer 10/10 (10,14) idle | CAPTAIN (9,13) hp 100%
FOES SEEN: E1 blight-men 12 (20,14) marching west | E2 drakes 3 (24,6) idle | E3 trolls 3 (26,18) idle
PLACES: MILL village (21,6) foe-held burning 1/5 | FORD road (23,14) | NEST keep (40,13)
GROUND: RIDGE hill (16,19) r4 | OAKWOOD wood (8-12,3-6) | RIVER x 22-23, fords at y 6 and 14
```
- **Name terrain features when the map is generated:** hills, woods, rivers and fords. Give them short, plain names (RIDGE, NORTH HILL, OAKWOOD, MILL STREAM), so a player can say them and the model can refer to them.
- The same names appear on hover in the original's style: a card with one word, never text on the field.

### 4c. Output schema (built per battle, so every name is an enum and cannot be invented)
```json
{
  "type": "object",
  "properties": {
    "orders": { "type": "array", "maxItems": 4, "items": {
      "type": "object",
      "properties": {
        "who":    { "type": "array", "minItems": 1,
                    "items": { "enum": ["ARMY","OTHERS","HORSE","SPEAR","SHIELD","ARCHER",
                                        "BORS","WIL","ODA","REN"] } },
        "do":     { "enum": ["move","attack","take","front","hold","recall","rally"] },
        "target": { "enum": ["NONE","HERE","MILL","FORD","NEST","RIDGE","OAKWOOD","RIVER","E1","E2","E3"] },
        "side":   { "enum": ["none","left","right","front","back"] },
        "fight":  { "type": "boolean" }
      },
      "required": ["who","do","target","side","fight"] } },
    "unclear": { "type": "boolean" }
  },
  "required": ["orders","unclear"]
}
```
**The model never emits coordinates.** Code turns names and sides into points (§6). This removes the most common failure, which is invented or misremembered numbers, and keeps the output to about 30–60 tokens.

## 5. The fast path (no model, instant)
First normalise the text:
- lowercase it and strip punctuation
- drop filler words: uh, um, okay, ok, now, please, go on, right
- map number words to digits

Then fuzzy-match names. A company name or kind word matches within Levenshtein distance 1, or by Double Metaphone, so "Boris" matches BORS.

| Pattern (whole utterance) | Orders |
|---|---|
| `rally` · `to me` · `on me` · `everyone to me` · `follow me` | rally |
| `hold` · `halt` · `stop` · `stand` · `hold position` | ARMY hold |
| `<company or kind> (come back · back · return · back to me · to me)` | recall them |
| `everyone back` · `all back` | recall every detached company |
| `charge` · `attack` | ARMY attack the seen foe nearest the captain |
| `pause` | pause |

Anything else goes to the model. In playtests, log every utterance that reached the model, and add any that recur to the fast path.

## 6. Resolving names into the game's orders (code, deterministic)
**The army's frame:**
- `forward` = unit vector from the army centroid to `threatPoint` (`04-battle.md` §4).
- `left = (forward.y, −forward.x)` in sim coordinates, where y points south. Check it on a map: with the army facing east, left must point north.

**Targets:**
| target | resolves to |
|---|---|
| place | its site position; `take` uses the site |
| E-id | that squad; `attack` |
| hill | its crest |
| wood | the point of its edge nearest the named company |
| river | the point on our bank nearest the company; for `front`, see below |
| HERE | each named company's own position |
| NONE | with `hold` or `rally`, none needed; otherwise refuse |

**`side` on a move or attack:** add a via point at the midpoint between the company and the target, shifted 6 tiles along `left` or `−left`. `front` and `back` shift it along ±`forward`. The company goes round, as in "round the left to the mill", "take their flank".

**`front` on a feature:**
- **River:** a line on our bank, following the bank, 2.5 tiles back from the water, 3.2 tiles of length per line company, centred on the army's position projected onto the river.
- **Hill:** a line across the crest, perpendicular to `forward`.
- **HERE:** a line through the named companies' current positions.
- Then use `planFront` exactly as a drawn line would (`04-battle.md` §4).

**`who` resolution:**
- `ARMY` = an order to the army (the captain leads).
- `OTHERS` = companies not named earlier in the same reply.
- A kind = every company of that kind.
- A named company = a detached order, exactly as if it had been selected and tapped.

**Validation, per order:**
- Every company named exists and can take orders (not routing, not fled).
- The target exists and is seen.
- The destination is reachable by A*.

A failing order is refused on its own with a red cross; the others still go.

## 7. Determinism and replays
- **The model runs outside the simulation.** Its reply is turned into deeds, and the deeds enter the order queue at the tick they arrive (time is slowed while waiting, so the delay is small in game time).
- **Log each voice order** as `{tick, team, deed, src:'voice', heard, reply, brain, ms}`.
- **Replays use only `deed`**, so a replay is still the seed plus the log, and is bit-identical without any model.
- **In the harness:** `say "<text>"` runs the fast path and the brain on the current state and prints the deeds. To keep tests reproducible without a GPU, it reads a fixture cache keyed by `hash(state text + utterance)`. `--live` calls the model and refreshes the cache.

## 8. The enemy broodlord on the same server
- **Its own slot and its own cached prefix.** Use the same orders schema, with its own companies in `who` and the player's seen companies, places and features as targets.
- **When it is called:** every 8 s of game time, and at once when one of its companies breaks or a place changes hands. At most 2 orders per call.
- **What it decides:** only intents: where to go, whom to attack, when to sally or pull back. The garrison and general bots (`04-battle.md` §7) carry them out between calls. If the brain fails, the bots alone play, as in the original.
- **Voice has priority.** If a voice request is in flight, skip that broodlord tick.
- **Personality:** a system line from the broodlord's trait. Reckless commits early and chases; cautious baits with one pack and holds the nest. Its decisions are logged like the player's.

## 9. The day-one test (run it before building anything else)
`npm run voice-eval` uses the field state of §4b and the 20 utterances below.

**How it runs:**
- Each utterance runs 3 times through `normalise → fast path → brain → resolve`.
- It reports, per case: pass or fail, and its latency.
- Overall: accuracy, and brain and end-to-end latency at p50 and p95.
- `--audio` runs 20 WAVs you record yourself on day one, through speech-to-text first. Record each once in a quiet room and once with background noise.

**A pass** means the deeds match the expected `who`, `do` and target. Coordinates are checked only where stated.

| # | Said | Expected |
|---|---|---|
| 1 | "Rally!" | fast path: rally |
| 2 | "Hold." | fast path: ARMY hold |
| 3 | "Wil, come back" | fast path: recall WIL |
| 4 | "Bors, take the riders round the left to the mill" | BORS take MILL, side left; the via point has y < 10 |
| 5 | "Bors round the left to the mill, everyone else hold the ridge" | BORS take MILL (left); WIL, ODA and REN move RIDGE with fight=true |
| 6 | "Archers onto the ridge" | REN move RIDGE |
| 7 | "Form a line along the river" | ARMY front RIVER; the line lies within 4 tiles of x = 20 |
| 8 | "Shields, block the ford" | ODA move FORD, fight=true |
| 9 | "Attack the drakes" | ARMY attack E2 |
| 10 | "Spears on the trolls" | WIL attack E3 |
| 11 | "Ren, shoot the blight-men" | REN attack E1 |
| 12 | "Free the mill" | ARMY take MILL |
| 13 | "Bors, hit their flank" | BORS attack E1, side left or right |
| 14 | "Fall back to the woods" | ARMY move OAKWOOD, fight=false |
| 15 | "Boris, to the mill" | BORS move or take MILL (fuzzy name) |
| 16 | "Send the horse to scout the nest" | BORS move NEST, fight=false |
| 17 | "Everybody to the ford" | ARMY move FORD |
| 18 | "Bors, back to me" | fast path: recall BORS |
| 19 | "Uh, the, wait" | unclear, no orders |
| 20 | "Kill the dragon" | ARMY attack E2 |

**Targets:**

| measure | target |
|---|---|
| accuracy | at least 18 of 20 |
| brain p50, Mac | ≤ 1.2 s |
| brain p50, GPU | ≤ 0.6 s |
| end-to-end p50 (release to marks), Mac | ≤ 1.8 s |
| end-to-end p50 (release to marks), GPU | ≤ 1.2 s |

**If a target is missed, try these in order:**
1. Shorten the dynamic state.
2. Make sure the prefix really is cached (llama.cpp reports cached tokens in its timings).
3. Try a smaller quant.
4. Move the brain to the hosted GPU.

Do this before the rest of the game depends on it.

**Latency budget** (estimates; the evaluation replaces them):

| Step | Mac (M-series, 4-bit 30B) | Desktop or hosted GPU |
|---|---|---|
| speech-to-text (API, short clip) | 0.3–0.7 s | 0.3–0.7 s |
| model: read about 300 new tokens (prefix cached) | 0.3–1 s | under 0.15 s |
| model: write about 40 tokens | 1–2.5 s | 0.3–0.6 s |
| resolve, validate, queue | under 5 ms | under 5 ms |

## 10. What this gives the pitch
- **Impact.** Real-time strategy is locked behind fast, precise hands. Speaking plus a few marks makes it playable for people with limited dexterity, and on a phone. Present it as an accessibility pattern shown on a game, not as a medical product.
- **Privacy.** With local Glimmer and local whisper, the captain's voice never leaves the machine.
- **Use of Meta's models.**
  - Glimmer interprets speech grounded in a live, fog-limited world state, under a schema built per battle.
  - The same local model plays the enemy.
  - Muse Voice Transcribe is the ears.
  - Every model output is validated, replayable and revocable.
- **The demo shot:** the captain says "Bors, take the riders round the left to the mill". Time slows, the riders' horn answers from the left, a dashed route curves north around the mill, and the riders go. Then a tap on their flag calls them back.
