# Game flow, input, campaign, diegetic UI, persistence, tooling and performance

## 1. The game and its feeling
- **One paragraph.**
  - You lead a warband of 4 companies (9 in "big army" mode) from a Hall of Banners down a seeded road of places to the enemy's keep. Each place is one real-time battle.
  - You command by **marking the field**: tap, draw a line, drag a path. In battle there are no buttons, bars, panels, minimap or floating text.
  - Each company is led by a **commander with a painted face**, a name, a scarf colour, a horn call and one trait.
  - **Losses stick.** Dead men stay dead. A commander who falls ends their company, and their banner is planted where they fell. New men come only from the villages you free.
  - A lost battle is not the end: march the captain off your own edge and the warband falls back along the road.
  - The campaign ends when the captain falls, when the warband is gone, or when the keep is taken. Commanders who survive lead the next campaign a rank up, and the fallen hang in the Hall.
- **Feeling:** *"They follow you, and some of them will not come home."*
- **Closing test:** "I lost the Oakshafts at the ford in the third battle. I had had them since the start."
- **Core verbs:** draw the line; send a company; call it back.
- **Non-negotiables (owner rulings):**
  - "Extremely easy to control but highly engaging and very diegetic in every sense."
  - No HUD. Every input is a mark on the field. A battle is legible in 5 seconds with no number to read.
  - Nothing looks like a web page.
  - Phone and desktop are both first-class (touch is designed first).
  - The simulation is deterministic.
  - References, for their principles: The Banner Saga (the journey is the frame and your people are the cost), XCOM (losing someone you named is the stake), and Kingdom Two Crowns (the screen is the world, with information living in objects).
  - **Not** Total War's management screens, and **not** Warpips' units-as-currency.

## 2. Input: every mark and how it is recognised
**Page setup:** one stage with a WebGL canvas and a pixel overlay canvas. Set `touch-action:none`, and disable user-select and the context menu.

### Thresholds (`touchish = pointerType !== 'mouse'`)
| Constant | Touch | Mouse | Meaning |
|---|---|---|---|
| slop | 12 px | 7 px | movement before a press becomes a stroke or drag |
| tapRadius | 26 px | 14 px | a press on a company or the captain that never strays further than this is a **tap**, however much it slid |
| companyReach | 24 px | 14 px | hit distance to your own company |
| kingReach | 36 px | 24 px | hit distance to the captain; ×1.3 while a company is selected |
| reach | 34 px | 20 px | hit distance to enemies and order flags |
| LAPSE | 7 s | 7 s | an unused selection deselects itself, blinking for its last 1.5 s |

### Hit-testing
- **Settle the press where it lands**, against the world as the player saw it, not on release.
- **Measure in screen pixels** to the segment from each man's feet to his head, and to the banner pole. Beasts add four points around their bodies.
- **Score, and the nearest wins:**
  - The captain scores ×0.65 (×0.45 while a company is selected), so he wins ties. "He is the handle for the whole army."
  - A selected company also answers anywhere inside its ground oval.
  - Order flags score ×0.7.
  - Otherwise the hit is ground, plus the nearest site within capture radius + 0.4 tiles.
- **Bugs this fixed in the original:**
  - 44% of the captain couldn't be clicked.
  - A 9 px slide on the captain meant "march here" 8 times out of 8.
  - Own squads always beat enemies, so only 2 of 9 enemies were tappable in a melee.

### Pointer state machine
Modes: `none | press | stroke | pan | pinch | drag`.

- **One pointer down → `press`.** Pressing a company selects it at once. The right or middle mouse button pans instead.
- **Moving past slop:**
  - In battle it becomes a **stroke**. Its kind comes from what was pressed: captain → `captain`, a company → `squad`, anything else → `front`.
  - At the muster it becomes a **drag**, carrying a commander.
  - On the road it becomes a **pan**.
- **Stroke points** are ground points at least 0.3 tiles apart.
- **A second pointer down:**
  - cancels the stroke and gives back the press's selection
  - switches to `pinch`: the midpoint pans, and the zoom steps once each time `log(d/d0)` passes ±0.22
  - a **two-finger tap** (both fingers down and up within 320 ms, less than 14 px travel) re-follows the captain and deselects
- **Wheel:** one zoom step per 90 deltaY.

### What a tap does
If a company is selected, the order goes to it alone and deselects it. Otherwise the order goes to the whole army.

| Tap on | Nothing selected | A company selected |
|---|---|---|
| Ground | the army marches there; the captain leads and the companies keep their stations (a ring ping and a dashed trail with an arrowhead) | that company alone goes there, leaves the army and plants an **order flag** |
| Enemy | the army attacks it (red ring) | the company attacks it |
| Site | the army goes to take it (gold ring at capture radius) | the company takes it |
| Your captain | **rally**: every company is recalled from its fights, the army halts, a big gold ring | the selected company is called back |
| An order flag | its company is called back, walking out of any fight | |
| Your company | select it; the commander's face card shows on release; a second tap deselects | |
| A fallen banner | shows the grey face | |

- A routing company can't be given orders, but tapping it shows its face.
- **New in the rebuild: holding the captain still for 400 ms starts voice command** (`06-voice.md` §3). Releasing after that is not a tap. A shorter press is still a tap, and moving past slop is still a drag.
- **A refused order shows a red cross at the spot. No words.**

### Strokes
- **Front, drawn from open ground:**
  - Simplify at 0.12 tiles. Under 1.5 tiles it counts as a tap.
  - It is always an order to the whole army.
  - The army forms along the line facing the enemy: spears and shields on the line, bows behind, riders off its ends. **A long line spreads them thin; a short one stacks them deep.**
  - While drawing, **time runs at 0.3** and bars on the ground show where each company will stand.
  - A good line leaves a cream trail for 2.6 s; a refused one, a grey trail.
- **Drag from a company:**
  - Simplify the route at 0.35 and keep its last 12 points.
  - What it ends on decides the order: an enemy → attack; the captain → recall; a site → take; anything else → move along the route.
  - The company leaves the army until it is called back.
- **Drag from the captain:** the army marches along the path.

### Pause and keys
- **Pause (Space or P):**
  - The world greys and every company's order is drawn: dashed lines to move targets, red to attack targets, gold to sites.
  - **Orders still work while paused.**
- **Keys:**

  | key | action |
  |---|---|
  | V (hold) | talk: voice command (rebuild, `06-voice.md`) |
  | X | ×2 speed |
  | M | mute |
  | N | new campaign |
  | F | follow the captain |
  | Esc | deselect |
  | + / − | zoom |
  | arrows / WASD | pan at 520 px/s |

- **Camera follow:** the camera follows the captain until the player pans. F, a two-finger tap, or giving the army an order re-follows.
- **Carrying on a phone:** an item carried at the muster is drawn 44 px above the thumb.

## 3. Screens and transitions
**Structure:**
- Top level: `title | setup | play`.
- Within play, the run's phase: `muster | map | battle | camp | won | lost`.
- A 0.45 s fade from black follows every scene change.

1. **Title.**
   - It stands over two armies at dusk on a field of the last land chosen.
   - Choices are banners on cloth: CONTINUE (if a campaign is kept), CAMPAIGN, BATTLE.
   - A "Myths" standard (a drake's head on dark cloth) toggles fantasy creatures. When tapped it burns and roars.
   - Every target is at least 24 art px, and each choice carries at most a word.
2. **Campaign cards.** One card per campaign standing over the hall, each with a title, a year and a one-line blurb in bitmap capitals.
3. **War table** (custom battle setup). Six pieces, each a picture plus one word:
   - both empires
   - the land (15 lands, or ANY)
   - the kind of battle: FIELD, NIGHT, KEEP, HOLD, VILLAGE, FORD
   - the size: 4, 6 or 9 companies
   - the enemy's strength: EASY, FAIR, HARD

   FIGHT goes straight to the muster with the last setup, so a returning player is two taps from the field.
4. **Muster (the parade ground).**
   - **The bands.** Bands of men wait in the meadows across the road from the commanders, each under the plain linen banner of its village.
     - Each is spear, shield, bow or horse.
     - Each is **raw** (in their own clothes, about a company of men) or **seasoned** (a 30% chance; 2 fewer men, rank 1, already in colours).
     - There are 3 more bands than banners.
   - **The commanders** stand before the hall, 2 more than there are banners. A veteran wears a plume.
   - **The verb: lift a commander and plant them at a band.**
     - **Lift** (rises 0.55 tiles in 0.14 s): the bands this commander's way suits stir, ringed in gold, with the chevron they would gain pulsing.
     - **Hover:** the band wheels to face the commander.
     - **Drop** (a 0.09 s thud and dust): the linen gives way to the hall's banner, and the men leap in a ripple (0.07 s per tile). A suited band hops twice in a gold flash and keeps a gold **chevron (a rank)**.
     - Lifting a commander off a company stands it down. Dropping one on a company swaps them.
   - **Setting out.** When every banner has its company, the road's first places glow. A tap on one sets out, and the companies fall in behind the king.
   - **Lesson:** the first muster was a table, and the owner said it felt "like spreadsheets". It was rebuilt as this parade ground.
5. **Road.**
   - The road is a land of its own, drawn by the same 3D view.
   - Each place is a building of its kind: a holdfast tower, a village with smoke, a ford with wagons by a fire, camp tents, the keep.
   - Reachable places glow, with their name beside them. A tap marches the real column along the road, and arriving starts the battle.
   - Tapping a place shows the enemy commander who holds it.
   - **The land remembers:** cairns for the dead, and the planted banners of companies that died there.
   - **After a battle, each banner tallies:** losses count down in red (0.11 s per man), joiners count up in green, and a new rank chevron pops on.
6. **Battle.**
   - The camera opens on the captain.
   - The enemy commander's face card shows the first time their company comes into sight.
   - When a commander falls: a slow-motion moment, their grey face where they fell, and their banner planted.
7. **Aftermath.** The field is left quiet, then **goes to the road by itself after 3.2 s**; a tap after 0.6 s skips it. There is no victory text.
8. **Camp.**
   - The wounded mend: 35% of each company's missing men, and half the captain's missing hp.
   - **Honour one company:** tap it for +1 rank. Its commander steps out to a horn and a cheer.
   - Resting costs the villages in sight a day.
9. **Chronicle** (the end of a campaign).
   - Your commanders' faces side by side on dark cloth: the living in colour, the fallen in grey.
   - A gold frame if won, grey if lost.
   - Below a red rule, the enemy commanders you met, grey if you brought them down.
10. **Hall of Banners.** A place in the world:
    - the fallen commanders' blue banners in rows (up to 24)
    - the enemy colours taken, on the other side (up to 12)
    - tapping one shows the face
11. **Chart** (Hannibal only).
    - On setting out, the view pulls back and a pixel-art map sheet unrolls.
    - The route so far is traced in blue and the next leg in gold. A horn sounds and the sheet rolls up.

### Diegetic UI rules
- **Cards** show a face, a name, **at most one word**, and pictograms. A card stands **beside** what was tapped, never over it. It rises in 1/6 s and fades.
  - **Commander card:** the sign of their way, plus the suited kind's mark with a gold chevron.
  - **Band card:** its people, its number of men, its rank.
  - **Company card:** rank chevrons, battle ribbons, last battle's losses (red) and joiners (green), enemy commanders taken (pennants).
  - **King card:** hearts, battles, companies, men.
- **Pictograms** are ASCII bitmaps drawn at the font's scale: man, chevron, crossed swords, banner, pennant, heart and empty heart, broken sword, hall, ribbon, coin.
- **No floating text over the field, ever.** It was tried, and the owner found it "not at all diegetic".

## 4. Campaign rules
- **The road.**
  - Six steps: five rows of 3 places, then the keep alone.
  - From lane L you may go to lanes L±1.
  - Row 0 is all holdfasts. Later rows roll: camp 24%, village 22%, ford 20%, holdfast 34%.
- **Garrison size.**
  - The share is `(0.80 + 0.075·step + 0.15·danger)`.
  - Kinds: shield, spear, archer to start; +spear from step 2; +archer if dangerous; +horse from step 4; +shield at the keep.
  - Size is scaled by the warband's size, with factor 0.9. (The original used 0.6 against human garrisons; against the blight's units 0.6 let a sensible bot win 74.5% of campaigns and doing nothing 2%. See DECISIONS.md D-21.)
  - Rank `floor(step/3)`.
- **Battle time:** 300 s × width/48. When the day runs out, night follows (see the battle spec).
- **Village under the torch.**
  - In battle it burns house by house.
  - **On the road**, every village in sight loses a house each day the warband spends elsewhere, camps included. A village the warband passes by burns out. **You cannot save every village.**
- **The freed.**
  - A village freed in battle sends 6 men, who fall in behind the captain under a plain banner.
  - After the battle, if there is room (at most 5 companies) and they number at least 4, they found a company under a new commander. Otherwise they fill the emptiest ranks, in their own clothes until the next battle.
  - Each battle they survive is +1 rank. At rank 2 they wear the colours and join the line.
  - The freed are the campaign's only new men.
- **Commanders.**
  - **When a commander falls, the company breaks and is no more.** Its survivors fill other ranks, or follow an heir as a new company if there is room.
  - After a won battle, 50% of the fallen were only wounded and return.
- **Enemy commanders.**
  - There are eight captains plus the lord of the keep, shuffled across the current row, the next row and the keep. Captains who escaped come back first.
  - Each leads the garrison's strongest company.
  - **If brought down,** their colours hang from the banner of the company that did it.
  - **If they escape,** they return further down the road, a rank harder.
- **Losing a battle.** If the captain lives and the warband exists:
  - the army falls back to the lane it came from
  - that place's danger rises by 1
  - the player chooses from the row again
- **The end.** The campaign ends when the keep is taken, the captain falls, or the warband is gone. Then the chronicle shows, and the Hall is updated.
- **Removed on purpose:** gold, relics, spoils, buying men.

### Empires as data from day one
An empire is a record:

| field | contents |
|---|---|
| name | |
| roster | units by kind: spear, shield, archer, horse |
| captain | |
| levy | |
| culture | who builds its villages and keeps |
| device | its emblem, plus a rival device for mirror matches |
| faces | portrait strips |
| ruler | the ruler's face |
| price | balance multiplier |
| myths | its legendary creatures |

There are eight: kingdom, carthage, rome, norse, greeks, egypt, qin, khmer. The campaigns are keyed to empires, **never** the other way round.

## 5. Persistence
- **Storage:** localStorage, with every access wrapped in try/catch.
- **The campaign** (`{v, run state, at: node, taught}`) is saved **only between battles**. A battle left unfinished is refought from its start. A version mismatch discards the save.
- **Other keys:** the Hall per campaign, the last campaign chosen, the last custom setup, the settings, mute.
- **URL flags:** `?seed= ?campaign= ?army=big ?map= ?px= ?tier= ?perf`.
- **Debug hooks** on `window.__v`: `shot(name)`, `pilot()` (autoplay), `ff(ticks)`, `autoMuster()`.

## 6. Onboarding and words
**Ghost-hand lesson** (the first battle). An 11-px pixel hand acts out each beat on the field, then waits for the player to do it:
1. **MARCH:** a ring pulses ahead of the army; the hand taps it.
2. **FORM UP:** a dotted line lies across the way to the enemy; the hand draws along it.
3. **SELECT:** the hand taps the nearest company, then bare ground on the flank.
4. **SEND:** the hand drags the riders' banner along a curve to a flank village.
5. **CALL BACK:** the riders' order flag pulses; the hand taps it.

- The garrison holds still during MARCH and FORM UP, or for 45 s, but still fights back.
- A beat is done by its verb, whatever it was aimed at: "the point is the verb, not the spot".
- A ring of light answers each beat.
- **No words.**

**Fonts and words:**
- A 5×7 bitmap font as ASCII data: capitals, digits and a few marks.
- Drawn in art pixels and scaled by integer factors only. **Never a browser font.**
- At most a word, and only where words would exist in the world: names on cards, place names, the title's choices.

## 7. Portraits (the original pipeline, which you will replace with Muse Image)
- **Original model:** the owner's local ComfyUI running Z-Image Turbo with a pixel-art LoRA at 0.85, 8 steps, cfg 1, 640×768.
- **One prompt skeleton**, where only `who`, `dress` and `ground` vary:
  > "Pixel art style. Tightly framed head and shoulders portrait of {who}, wearing {dress}, the head large and centered with the top of the head near the top edge of the picture, the head turned three quarters to the right, the eyes in the upper half of the picture, the shoulders cut off by the bottom edge of the picture, plain flat {ground} background, soft light from the upper left, a realistic face with natural proportions and small eyes, in the style of a classic strategy game portrait, crisp detailed pixel art with dark outlines, no text, no frame."
  - `who`: people, skin, hair, beard, marks, headgear. **No body-build words**: "huge" or "bare-chested" pulled back to a full figure, and women came out as anime.
  - `dress`: the side's uniform, e.g. "a blue tabard with a white fleur-de-lis and a red scarf around the neck".
  - `ground`: "warm ochre" for the player, "dark slate grey" for the enemy.
- **Post-processing** (Pillow + numpy):
  1. Flood-fill the background to one flat colour per side.
  2. Mirror the faces so all look the same way.
  3. Detect the eyes and crop each face to an **80×96 tile**, with the eyes at y = 40 and the middle of the head at x = 40.
  4. Build **one shared 64-colour palette per side** by k-means in Lab, with no dithering.
  5. Flag faces whose skin lightness is more than 14 L* off the 3D figures'.
  6. Save strips of N×80 by 96 as 8-bit indexed PNGs.
- **Saves refer to faces by index**, so the order of a strip is fixed.
- **Each commander's `look` text also drives their 3D figure's hair and beard.** Keep one text description per character as the single source for both.

## 8. Engineering practice
- **Headless, deterministic harness from day one.**
  - The game interface: `create(seed, opts)`, `step`, `apply(team, cmd)`, `parse`/`format` of commands, `over`, `probe`, `describe` (the state as text), `draw(painter)`, and named bot `policies`.
  - **A CLI** with:
    - `play <game> <session> new|look|do|wait|undo`, where a session is a seed plus a command log, re-simulated on every call, so it is a replay
    - `watch` for filmstrip PNGs
    - `sweep` for many seeds and their numbers
  - Text commands mirror the marks: `march x y`, `front x1 y1 x2 y2`, `raise B C`, `go N`.
  - **This is what lets an AI agent play and tune the game without a browser.** "Claude never built the tools to play the game on its own" was the root regret of the first prototype.
- **Bots:**
  - for the warband: `commander`, `leader`, `greedy`
  - for the enemy: `garrison`, `raiders`, `general` at three skills
  - they see only through their own fog
- **Balance bands:** a sensible bot wins 30–50% of campaigns; a leader-only bot 0–35%; a mindless charge 20–60% of field battles; doing nothing 0%. Every check prints its counts, so a check can't pass without running.
- **All tuning in named tables,** overridable with an env var: `PROTO_TUNE='{"RUN":{...}}'`.
- **`npm test`** = typecheck plus about 200 checks:
  - replay identity
  - each objective plays to an end
  - AI against AI is not lopsided
  - unit duels land in bands
  - assets match their casts
- **Dev labs:**
  - a units lab: every figure at game scale, posable, with screenshots
  - a sound lab: Strudel recipes, rendered to files
  - a dev-server endpoint that saves WebGL screenshots to disk

### Performance: adopt these from day one
The original measured 18/100 on an old phone after 120 decisions, and reached 92/100 only after ten decisions of performance work. Skip that debt:
1. **Never dispose materials between battles.** three.js deletes their shader programs, which costs 60–140 ms of recompiles per battle. Paint shared atlases once.
2. **Make terrain in a Web Worker** as soon as the next map's seed is known (see land.md). This took battle start from 4.1 s to 0.1 s.
3. **Build lazily.** Make each instanced part the first time it is drawn, and warm the next battle's parts between frames in jobs of at most 6 ms.
4. **Zero garbage in hot paths:**
   - write matrices straight into instance buffers
   - a flat-grid neighbour search
   - typed-array particles
   - cache the camera and the ground rays
5. **Sound in sets,** fetched as wanted, 4 at a time. The AudioContext is created after the first frame.
6. **Split the script:** `three` (cached across deploys), the main code, and a late chunk for the road, muster and chart. Hashed assets get `max-age=31536000, immutable`.
7. **Run the post pass at art-pixel resolution.** No canvas depth buffer.
8. **A perf rig** with Puppeteer and a throttled "old phone" profile (CPU ×6, 360×740 @3x, Slow 4G), a committed baseline, and a pixel-diff check that every optimisation keeps frames identical.
9. **Never use `Math.random` in the view.** Use seeded `rand()`, so frames can be compared.

## 9. Lessons and regrets not to repeat
1. **Test whether the loop is fun for 10 minutes before building systems.** The first concept (soldiers streaming along drawn roads) died: 0.1–0.5% of soldiers were fighting at any moment, and the first blow came at 95–109 s.
2. **Build the harness, the bots and deterministic replay first.**
3. **No text over the world.** Floating words read as HUD, and text panels felt like spreadsheets. Use faces, pictograms, banners, sound and light.
4. **Attachment needs control and scarcity.** Every order must be revocable. Death should be rare, telegraphed and personal (a commander's death). Constant free replacements made loss "weather, not an event".
5. **Hit-testing must be generous, nearest-wins and settled on press,** with touch thresholds larger than mouse ones.
6. **Model empires as data from the start.**
7. **Commands as a tick-stamped queue from day one.**
8. **Performance budgets and a rig before content.**
9. **Balance checks must print their counts.**
