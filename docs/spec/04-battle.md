# Units, movement, formations, combat, commanders and enemy AI

## 1. Simulation architecture
- **Fixed tick.**
  - 30 Hz, so `dt = 1/30`.
  - The browser runs an accumulator: `acc += dt*rate`, then steps while `acc >= 1/30`.
  - `rate = slow * (fast ? 2 : 1)`. `slow` eases toward its target at `dt*12`.
  - `slow` targets 0.3 **while the player is drawing a line**, 0.35 for 0.9 s after one of your commanders falls, and 0.7 s after an enemy commander falls.
- **Determinism.**
  - Iterate squads, then soldiers, in id order.
  - The tick loop never draws from a sequential random stream. All per-entity randomness is `jitter(id, salt) = hash32(seed, id, salt)/2^32` (see land.md for `hash32`).
  - The sequential xorshift32 `Rng` is used only for map generation and setup.
  - A* ties break on tile index.
  - Use your own `hyp()` instead of `Math.hypot`, which is not guaranteed bit-identical across engines.
- **Orders are a queue.** Every input becomes a JSON `{tick, team, deed}`, applied before its tick. **Nothing else may mutate a battle.** So a replay is the seed plus the log, undo is free, and bots and the player share the same interface. Build this on day one; the original added it late and paid for it.
- **Tick order:**
  1. **rebucket:** sort soldiers into 1-tile grid cells with a counting sort, plus a per-cell bitmask of which teams are present.
  2. **updateSquad:** for each squad; this moves only the anchors.
  3. **updateSoldier:** for each soldier. Strikes are **collected, not applied**.
  4. **resolve(strikes):** all blows land together, after all movement.
  5. **burn:** fires.
  6. **updateArrows.**
  7. **hooks.**
  8. **cull:** remove the dead and close the ranks.
  9. **sites, towns, ford, night.**
  10. **updateMorale.**
  11. **updateSight:** every 8 ticks.
  12. **checkOutcome.**
- **State.**
  - **Soldier:** `x, y, hp, maxHp, atk` (cooldown), `target`, `pace` (low-passed speed), `chargeReady`, `sinceContact`, `strikes` (a counter the view watches to start a strike animation), `hitAt`, `vx, vy`, `route` (personal A* waypoints), `slot` (fixed index), `alive`, `recruit`.
  - **Squad:** `team, kind, spec` (merged stats), `soldiers[]`, `full` (count at start), the anchor `x, y` (centre of the front rank), `facing, order, path, morale, maxMorale`.
    - `state`: idle | marching | fighting | routing | fled | destroyed.
    - `quiet`: seconds since the last threat.
    - `rank, kills`.
    - The captain also has `heading, formation (line|column)`.
    - Also `detached, files` (frontage override), `commander {name, face, trait}`, `leader` (the commander's Soldier), `commanderFell, recalling, flag`.
- **Orders:** `hold {face?}`, `move {x, y, face?, fight?, pace?, via?, files?}`, `attack {target}`, `take {site}`, `retreat`, `follow {leader, slot}`, `ride {target}`.
- **Rendering is separate.** The view never writes to the simulation, and the simulation never reads the view. Each frame, every drawn man chases his simulated position exponentially (§9).

## 2. Units and stats

### Base kinds
| kind | men | hp | dmg | int s | spd t/s | range | arrowTaken | charge | chargeTaken | steadiness | cost | extra |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| spear | 12 | 10 | 2 | 1.0 | 1.6 | 0 | 1 | 1 | **0.4** | 1 | 30 | vsHorse 2 |
| shield | 10 | 14 | 1.6 | 1.0 | 1.3 | 0 | **0.35** | 1 | 1 | **0.6** | 35 | |
| archer | 10 | 7 | 1.5 | 1.6 | 1.6 | 7 | 1 | 1 | 1.2 | 1.3 | 35 | melee ×0.5 |
| horse | 6 | 14 | 2.4 | 1.1 | 3.2 | 0 | 1.1 | **3** | 1 | 1 | 45 | frontage 3 |
| levy (freed) | 12 | 9 | 1.6 | 1.1 | 1.5 | 0 | 1.1 | 1 | 0.7 | 1.15 | 0 | |
| folk (civilians) | 7 | 5 | 0 | 9 | 1 | 0 | 1 | 1 | 1.5 | 0 | 0 | |
| captain | 1 | 80 | 4 | 0.8 | 3 | 0 | 0.6 | 2 | 1 | 0 | 0 | never routes |

- `steadiness` multiplies the morale lost per death: lower is braver.
- A unit merges partial overrides onto its kind: `spec = {...KINDS[kind], ...stats}`.

### Unit overrides
| unit | kind | overrides |
|---|---|---|
| Libyan | spear | hp 11, arrowTaken .8, steady .9 |
| Iberian | shield | dmg 1.8, hp 13, arrowTaken .5, spd 1.4 |
| Balearic slinger | archer | range 8 (out-reaches bows), hp 6 |
| Numidian | horse | spd 3.8, hp 11, charge 2.4, arrowTaken 1.2 |
| Gaul | levy | dmg 2, charge 1.8, steady 1.4 (charges hard, breaks easily) |
| Hastatus | shield | dmg 1.75, hp 14 |
| Triarius | spear | hp 12, steady .75, arrowTaken .6 |
| Veles | archer | range 6, dmg 2, int 1.8, hp 8, **bane 2.2** (×2.2 vs beasts) |
| Eques | horse | hp 15, charge 2.6 |
| Caetrati | archer | range 5, dmg 1.7, hp 9, melee .9, bane 2.2 |
| Gaulish horse | horse | charge 3.8, steady 1.5 |
| Crossbowman | archer | 7 men, range 8, dmg 3.4, int 3, melee .4, cost 45 |
| Man-at-arms | | 9 men, hp 13, dmg 2.5, vsHorse 3, cost 45 |
| Knight | horse | 5 men, hp 20, dmg 3.2, spd 2.8, charge 4.2, chargeTaken .8, arrowTaken .5, cost 90 |
| War elephant | horse + beast | 4 per company, hp 45, dmg 4.5, int 2.2, spd 2.3, charge 4.5, arrowTaken .7, steady .6, cost 130, radius .85, frontage 3 |

### Other empires
- **Greek hoplite:** chargeTaken .35. Loses morale ×1.5 when flanked.
- **Greek peltast:** range 5.5, bane 2.2, pierce .5.
- **Egyptian chariot:** 6 per company, hp 14.5, spd 3.9, with a bow on the move (range 6.5).
- **Qin ji:** vsHorse 3.4.
- **Qin crossbow:** range 8, dmg 3.6, int 3.
- **Khmer ballista elephant:** 3 per company, hp 22, dmg 10, int 5.5, range 10. Its bolt passes through 2.
- **Norse berserker:** charge 2.6, chargeTaken 1.25, arrowTaken 1.5, steady .3.
- **Norse huscarl:** dmg 2.7, int 1.4, spd 1.1.
- **Norse drakes:**
  - wild: hp 18, bite 3.4, breath 6, pack
  - ridden: hp 20, breath 5, lance 3
  - armoured: hp 27, arrowTaken .4
- **Myth creatures** (all beasts, 3–4 per company):

  | creature | rule |
  |---|---|
  | griffin | flies |
  | cyclops | boulder: range 8, splash r 1.1 |
  | basilisk | gaze freezes a man for 4 s |
  | eagle, dragon | fly; lightning splash |
  | naga | venom cone |
  | centaur | shoots on the move |

### Empire price multipliers
Rome 1.25, Greeks 1.15, Egypt 1.12, Qin 1.15, Khmer 1.38, the rest 1. They were measured so that AI against AI is fair.

### Rank effects (rank 0–3)
| stat | per rank |
|---|---|
| hp | ×(1 + 0.12·rank) |
| max morale | 100 + 10·rank |
| speed | ×(1 + 0.05·rank) |
| damage | ×(1 + 0.1·rank) |

Ranks come at 6, 18 and 36 cumulative kills.

### Worth (for AI pricing and the time-out score)
`worth = hp/(0.6+0.4·arrowTaken) × dmg/int × (1 + 0.05(charge−1) + 0.04Δrange + 0.3 if beast)`

**Rule for adding units:** every new rule is a stat in `KindSpec`, never an `if (unit.id === …)`.

## 3. Movement

### 3a. Formation slots
- **Frontage:** `files` if a drawn line set it, else `spec.frontage`, else 3 for horse and 6 for the rest.
- **Man i of n:**
  - `rank = floor(i/f)`, `file = i%f`, `inRank = min(f, n − rank·f)`.
  - `lateral = (file − (inRank−1)/2)·0.72·room`, `back = −rank·0.72·room`, where `room = radius/0.32`.
  - Rotate by the squad's `facing` about the anchor, which is the centre of the front rank.
  - The last, partial rank centres itself.
- **Variations:**
  - Folk get ±0.35 seeded scatter.
  - A pack (drakes) gets files ×1.15, its rank ends pushed back 0.5, and ±0.125 jitter.
- **The commander's spot** is `0.8 + (ranks−1)·0.72` tiles behind the anchor.
- **Slots are fixed per man.** When men die, fill each gap with the man holding the highest slot. One man steps forward; nobody else moves.

### 3b. The squad anchor
- **Path:** A* (8-connected, no corner cutting, smoothed). Replan every 1 s, or when the goal moves more than 1.5 tiles.
- **Cohesion gate.** Looseness is the mean distance of the men from their slots.

  | looseness | anchor moves at |
  |---|---|
  | > 3.2 | stops |
  | > 1.6 | 0.35 pace |
  | otherwise | full pace |

  Routing squads and the captain skip the gate.
- **Step:** `step = speed · terrain (forest .7) · hillPace · pace · dt`.
- **Turning:** the anchor turns toward its waypoint at 4 rad/s. Beasts wheel at 0.4 of that.
- **Arrival:** within 0.4 tiles it switches to `hold {face}`. `via` points are dropped once within 0.9.

### 3c. Each man: the momentum model that fixed the shiver
- **Target:** his slot, or a combat point (§5).
- **Speed:** `spec.speed·(1+0.05·rank)·catchup·traitPace`, where catchup is 1.4 if he is more than 1 tile from his slot and 1.15 if more than 0.5.
- **Path:** if the straight line to his target is blocked, he gets a personal A* route, replanned every 1 s or when the goal moves more than 2.
- **Steering:**
  - Desired velocity: if `d > SETTLE 0.05`, then `want = dir · min(speed·terrain, (d − 0.025)·ARRIVE 8)`.
  - Separation, for each neighbour within `ra + rb`:
    - `push = ((rr−d)/rr)·SEPARATION 6·(0.5 for a teammate, 0.8 for an enemy)·mass`
    - `mass = clamp((rb/ra)², 0.15, 3)`
  - `v += (want − v)·min(1, dt·RESPONSE 20)`.
  - Beasts also clamp their change of heading to their turn rate (elephant 1.1 rad/s) at constant speed.
- **Collision:** move each axis separately against passability, and keep men 0.2 inside the map.
- `pace` low-passes the actual speed at `dt·4`; it is the input to charges.
- **Neighbours** come from the grid. Fliers only push fliers.
- **Tuning evidence:**
  - Softer settings (ARRIVE 4 / RESPONSE 12) let a mindless charge win 85%.
  - Stiffer settings (12 / 30) brought the shiver back.
  - Before this model, standing blocks reversed direction 17.1 times a second; after it, 0.07.

### 3d. The army follows the captain
- **Formation heading.**
  - Re-aim it only after the captain's centroid has moved 2.5 tiles.
  - In line formation, don't re-aim if the new direction is more than 120° off, so a line falls back still facing the enemy.
  - It eases at 0.9 rad/s.
- **Column or line.**
  - Form **line** at once when a visible enemy is within 9 tiles, or after a 2 s halt.
  - Form **column** after 1.5 s of marching with no enemy near.
- **Stations** (`GAP = 4.4`, filling outward from the centre):
  - **Line formation:**
    - line companies 3 tiles ahead of the captain, 5 per row, rows 3.2 apart and staggered
    - bows 3.5 behind, 4 per row
    - horse on the wings, 1 ahead and `half + 5 + 3.5·floor(slot/2)` to the side
    - freed reserve 0.4 behind, 3.4 to the side
  - **Column formation:**
    - two abreast at ±2.3
    - line companies first, from 3 ahead, in pairs 3.3 apart
    - then bows, horse and reserve, from 3 behind, in pairs 3 apart
- **Followers.**
  - They face the leader's heading, **never the way they step**, turning at 2 rad/s.
  - `speed = min(top, 0.4 + 0.9·d)`, halved if looseness > 3, with `top = spec.speed·(1.25 if d > 3)·(1.3 in column)`.
  - Hysteresis: they start marching above 1 tile from station and go idle below 0.3.
- **The captain's pace:** `min(follower speeds)·0.9·(1.3 in column)`, then ×0.6 if the mean station error exceeds 5, or ×0.8 if it exceeds 3.
- **Defending the captain.** Line squads within 7 tiles of the captain turn on any enemy within 3 of him.
- **Stations are fixed per company**, so one company leaving doesn't reshuffle the rest.
- **Results:** state flips went from 289 to 3–6 per squad-minute, and block spin from 27°/s to 5–6°/s.

## 4. Formations

### Line to a point
- The heading runs from the group's centroid to the point.
- Sort the squads by lateral offset and space them 4.4 tiles apart, perpendicular to the heading.
- Everyone moves at the slowest squad's speed.

### The drawn front (`planFront`)
- **Input.**
  - Resample the polyline by arc length; a line under 1.5 tiles is a tap.
  - Take the tangent over ±1 tile, so a wobble doesn't swing a squad round.
- **Which side is the front.** Whichever side `threatPoint` lies on. `threatPoint` is the 1/(1+d)-weighted centroid of visible enemies within 24 tiles, else the enemy keep or deploy point.
- **Melee squads** (range 0, not horse, not reserve):
  - They split the line evenly: `seg = L/n`, each centred in its share.
  - `files = clamp(floor(seg/0.72), 3, max(2, ceil(men/2)))`. **A long line is thin, and a short one is deep.**
- **Bows:** 3.2 tiles behind the line, 4.6 apart, centred.
- **Reserve:** 2.6 behind, either side of the bows.
- **Horse:** at alternating ends, `2.8 + 3·floor(k/2)` beyond the end along the tangent (+2 for a beast) and 1.2 back.
- **Captain:** 5 behind (2.8 if there are no bows).
- **Facing:** every squad faces the normal toward the threat and keeps its left-to-right order, so none cross.
- **Fallbacks:** with no melee squads, the bows take the line; with no bows either, the horse.
- **Fight or fall back:**
  - A line drawn **toward** the threat sets `fight: true`, and the captain rides.
  - A line drawn **away** from the threat is a fall-back, with no fighting.
- **Preview while drawing:**
  - Time ×0.3.
  - Bars of length `files·0.72` show where each squad will stand (4.2 for a beast, 3.4 for a chariot, 2.2 for horse, 3 for archers), plus a disc for the captain.
- **Simplifying input:** a front is simplified at 0.12 tiles. A drag route is simplified at 0.35 and keeps its last 12 points as `via`.

## 5. Combat

### Engagement
- **Who may engage:** not a march without `fight`, not a retreat, not a recall.
- **Threat** = the nearest enemy to any of the squad's men, within:
  - melee: 2.6, +1.5 under a reckless commander
  - ranged: range + the height bonus
- Melee needs a clear walking line beyond 1 tile.
- **When engaged:**
  - The squad's state becomes `fighting`.
  - It faces the enemy centroid at 2.5 rad/s.
  - A melee squad's anchor drifts toward its own men's centroid at `dt·2`, so the block follows the brawl.

### Target choice per man
- Keep the current target while it is within `seek·1.3`.
- Otherwise take the nearest enemy within `seekRange = max(3.2, engage + 0.6)`, scored as `d + 0.6 if routing + jitter·0.3`. The jitter spreads targets.
- Melee needs a walkable line; ranged needs sight.
- In a squad that isn't fighting, a man only picks someone already in reach. **Anyone touched fights back**, whatever his order.

### Reach
- `reach = 0.99` tiles, measured from body edge to body edge: `gap = dist − bulk_a − bulk_b`, with `bulk = radius − 0.32`.
- A man walks in until `gap ≤ 0.92·reach`, then stands.

### Melee blow
- **When:** `gap ≤ reach` and his cooldown is up.
- **Charge** if all of these hold:
  - `chargeReady` (regained after 3 s out of contact)
  - `pace > 0.6·speed`
  - `spec.charge > 1`
  - not recalling
  - not horse against a beast
- **Base damage:** `damage·(1+0.1·rank)·(0.5 if a ranged unit in melee)·(1.12 if veteran)`.
- **On landing, multiply by:**
  - a charge: `atk.charge·vic.chargeTaken`, then ×1.3 if the attacker is reckless, ×0.7 if the victim is veteran
  - against horse that isn't a beast: `vsHorse`
  - against a beast: `bane`
  - height: `(1 + clamp(Δh·0.25, ±0.35))`
  - a routing victim: ×1.6
- A charge also costs the victim's squad 3 morale.
- **Cooldown:** `interval·(0.85 + 0.3·jitter)`. Start each man's cooldown at a random fraction of the interval, so blows aren't synchronised.

### Ranged
- **Firing:** archers stand in their slots and fire while their target is beyond reach.
- **Arrows:**
  - They home on the target, with flight time `max(0.2, d·0.06 s)`.
  - Their damage is fixed at launch.
  - On landing: `dmg·(arrowTaken + (1−arrowTaken)·pierce)·(bane vs beasts)`.
- **Height:** ±1.2 range per tile of height, capped at ±2.
- **In melee:** an archer strikes at half damage.
- **Mounted bows and chariots:**
  - They fire on the move, with aim `1 − 0.35·(pace/speed)`.
  - They don't fire in woods. Chariots don't fire on slopes over 0.3.

### Beasts
- **Cleave:** each blow also hits the 3 nearest enemies within 1.5 at 0.6 share.
- **Horse terror:** enemy horse within 6 tiles lose 11 morale/s and won't charge them.
- **Turning:** at most 1.1 rad/s.
- **Trample when routing:** every 0.3 s, everything in contact takes 1.8, **friend or foe**. Elephants trample their own side when they flee.

### Drake breath
- **The cycle:**
  - rear until the jet starts at 0.4 s
  - the jet runs 1.2 s, with a 0.55 s tail
  - the bite comes at 2.3 s
  - period ≈ 3.2 s
- **The cone:** reach 2.3, half-angle 0.3 rad, sweeping ±0.3 rad, rooted 1 tile ahead.
- **Damage:**
  - Every 0.25 s, every enemy in the cone takes `breath/pulses`, ignoring armour.
  - Each company caught loses `1.6·steadiness` morale.
  - No friendly fire.
- **The hunt:**
  - rear when the prey is within 2.4
  - hold ground while breathing
  - lunge at 1.6× pace 0.45 s before the bite
  - spring back to 2.1, still facing the prey
  - the next prey is the densest spot not already taken by a pack-mate
- **Meeting a drake:** men step at most 1 tile from their slots, and the company presses forward as a block.

### Myth rules
| rule | effect |
|---|---|
| `impact` | the blow lands that many seconds after it starts |
| fliers | stand off at 1.8; dive within 1.6 at 1.6× pace; blades can reach them only around the impact |
| `splash` | area harm |
| `hold` | freezes a man |

### Morale (0 to 100+)
- **Per death:** `−1.6·(100/full)·steadiness·(0.6 if ranged)·trait`. A full 12-man spear squad loses 13.3 per man lost.
- **Flanked:** a melee attacker more than 110° off the squad's facing costs 7/s.
- **Outnumbered:** at least twice as many attackers as fighting men, and at least 4, costs 4/s.
- **Recovery:**
  - +5/s with no attackers
  - otherwise +3/s inside the captain's aura (5.5 tiles)
  - +0.6/s near a steady commander
- **Shields on flank and outnumber losses:** captain's aura ×0.5; a steady neighbour ×0.88; stubborn ×0.72; reckless ×1.2.
- **The captain** never routes. He regenerates 1.2 hp/s after 4 s out of contact.

### Routing
- **Breaking:** a squad routs when morale falls below 22.
- **Fleeing:**
  - it runs home at ×1.25 speed
  - its men scatter ±1 around the anchor
  - it ignores the cohesion gate
- **Rallying:** after 5 s with no enemy within 5 tiles, it rallies at morale 45 with a `hold` order, unless its commander has fallen.
- **At home:** an attacker's squad leaves the map (`fled`); a defender's makes a last stand at morale 30.

### Commanders on the field
- The commander is soldier 0. He has 3× hp and stands behind the ranks. He strikes only whoever reaches him.
- **If he dies:**
  - his squad's morale is capped at 21, so it routs at once and never rallies
  - if he was an enemy commander, every other enemy squad loses 25
- **Saving the last men:**
  - When the men left ≤ `max(2, floor((full−1)·0.3))` (0.5 for an enemy commander), the commander pulls the company off the field, once per battle.
  - When an enemy commander does this, the other enemy squads lose 12.
- **Recall** (the player's "come back"):
  - lasts up to 10 s, at ×1.15 pace, with no engaging
  - the men strike anyone in reach but never stop, so the enemy gets free blows
  - it ends within 2 tiles of the company's station
- **If the captain dies, that side loses the battle.** Check this first.

### The captain's ride
- **Before contact:** he trails 3.5 tiles behind the foot line.
- **After contact:**
  - He rides at the enemy squad pressing his most shaken company, scored `d + 8·morale%`, within 12 tiles.
  - He skips approaches with more than 3 other enemies within 3.5 tiles.
  - He re-picks every 5 s and comes in around the flank, `wide + 1.4` clear of the outermost man.
- **Leaving the fight:** below 50% hp, or after losing 20% of his hp within 2 s, he rides 5 tiles behind the army. He returns at 80%.

## 6. Commander ways
| way | effect | suits (+1 rank when paired) |
|---|---|---|
| stubborn | morale loss ×0.72, speed ×0.92 | shield |
| reckless | engages from 1.5 tiles further, charge ×1.3, morale loss ×1.2 | horse |
| steady | companies within 5 tiles: flank and outnumber loss ×0.88, +0.6 morale/s | archer |
| veteran | damage ×1.12, enemy charges against them ×0.7 | spear |

Lessons:
- Reckless riders hovered without fighting because the squad's engage range and its men's seek range differed. Use **one** seek range for both.
- In the first build, 51 of 57 commanders who died were the last man of their company. The pull-out rule brought that down to about 2.5 per campaign.

## 7. Enemy AI
- **General rules:**
  - Every policy sees only through its own side's fog.
  - Issue an order only if it differs from the squad's current one (compare as JSON).

### Garrison (defending a place; thinks every 1.5 s)
1. Each squad remembers its first order as its post.
2. **At night:** everyone attacks the nearest foe.
3. **Keep guard:** the melee squad nearest the keep stays on it, attacking anything within 5 tiles.
4. **Shaken:** squads below 40% morale and not fighting go to the shrine, or else the keep.
5. **Threat:** the visible enemy nearest any held site, within 9 tiles.
   - Every free melee squad within 16 tiles attacks the foe nearest itself, among those within 8 of the threat.
   - Archers go 4 tiles behind the first responder.
   - The general rides at the threat.
6. **Sallies:**
   - after 12 s, with a 20 s cooldown
   - party size `max(2, round(0.6·free))`, from squads above 60% morale
   - target: the attacker's villages nearest the keep first, then neutral villages
   - they go only with 1.4× the enemy men seen near the target, remembered for 25 s; under fog, sallies were suicidal until the AI remembered sightings
   - they march as a line
   - they come home when the site is retaken, at 50% losses, when the keep is threatened, or after 75 s
7. **Otherwise:** return to the post, or retake a lost site within 12 tiles if no foe is within 6.

### General (open-field battles; skill 0/1/2 thinks every 2.4/1.5/1.0 s)
- **Skill 1 and up:**
  - Keep a reserve: the strongest line company, given at least 5 companies and at least 3 line companies.
  - Rest companies that rallied below 45% morale, 6 tiles back, until they reach 80%.
  - Send horse round the flanks at bows, or at enemies already fighting, within 28.
- **Skill 2 also:**
  - pulls out wavering companies mid-fight
  - focuses wavering enemies
  - keeps the captain out of the fight below 60% hp
- **Before contact:**
  - Every 6 s, form a new front with the same `planFront` the player uses.
  - The front steps 8 tiles toward the goal and stops 8 short of the enemy.
  - Its half-width is `max(2, line companies)·4.4/2`.
- **Contact** = any company fighting, or within 10 tiles of a foe. Then:
  - Bows hold if a foe is within range + 1, else go 3 tiles behind the line.
  - Fliers and breathers pick their quarry by score:
    - fliers: archers −8, horse +6, javelins +5
    - breathers: `0.5d − men`, horse +8, bane +12, braced +3, already fighting −4
  - Elephants go at the nearest foot within 24.
  - Everyone else attacks the nearest grounded enemy within 12.
  - The reserve commits below 60% morale, or when an enemy comes within 8 of the captain.

### Raiders (the ford)
- Horse go for the civilians.
- Archers shoot troops within 9, else civilians.
- Foot go for troops if they are within 4, or closer than 0.8 of the civilians' distance; otherwise for the civilians.

### Difficulty
- **Custom battles:** the enemy war chest is ×0.8, ×1 or ×1.2, and 0, 0 or 75% of its companies are veterans (+1 rank).
- **Campaign garrisons:** `0.8 + 0.075·step + 0.15·danger` of full size, at rank `floor(step/3)`. A returning enemy commander is +1 rank.

## 8. Battle types and outcomes
- **Always:** if a side's captain is destroyed, that side loses. The attacker withdraws, losing but surviving, if its captain is within 1.6 of its own edge after 8 s.
- **Holdfast (keep):**
  - The attacker wins by owning the keep or by leaving no defenders.
  - **Capture:** radius 1.8. `rate = dt/(6·(keep 2, town 1.5))·(1 + 0.25·(weight−1))`, where the captain weighs 3. A contested site freezes.
- **Village under the torch:**
  - 5 houses of 3 people each.
  - The first house is fired at 22 s, then one every 26 s. Each burns 24 s, then falls in, killing its people.
  - Taking the village frees everyone in the houses still standing.
- **Ford:**
  - 4 groups of 5 civilians arrive at 1, 31, 61 and 91 s; alternate groups take the far ford.
  - They walk at 0.95 and run at 1.6 when an enemy is within 5.
  - Enemy waves come at 14, 37, 67 and 97 s.
  - Win when every group has spawned and left the field, with at least one saved.
- **Night:**
  - When the day runs out in a campaign battle, 70 s of night follow, with sight ×0.6.
  - Torches give each army away within its spread + 0.8, and fires light 4 tiles.
  - 6 s after nightfall, a relief of 0.5× the garrison's starting squads comes from the east.
  - **If the captain lives until dawn, the attacker wins.**
- **Open field:**
  - A side loses with no non-routing company left.
  - At time out, the side with the higher men × worth wins.
  - Field time is 360 s × width/48.
- **Battle time in a campaign:** 300 s × width/48.

## 9. Animation from the simulation
- **Position:** the drawn position follows `st += (sim − st)·(1 − e^(−16·dt))`.
- **Speed:** the drawn speed low-passes at `dt·10`.
- **Facing**, in priority order:
  1. a breathing beast faces its target
  2. else the direction of motion, if moving faster than 0.35
  3. else the target
  4. else the squad's facing

  Men turn at 7 rad/s; beasts at 2.2 rad/s.
- **Walk:**
  - `phase += speed·dt·stride`. Stride is 3.6 for men, 2.4 mounted, 3 for beasts, 3.4 for drakes.
  - A drake springing back plays its stride in reverse.
  - `swing = sin(phase)·min(0.7, 0.25+0.3·speed)` when speed > 0.2.
  - **No vertical bob** (see the look spec).
- **Strikes:** an animation starts when `s.strikes` changes, so animations are driven by simulation events and never by a timer of the view's own.
- **Other:**
  - Hit flash: white for 0.1 s.
  - Routing men flail their arms.
  - Commanders are drawn ×1.16.
  - Dust scales with speed.
  - **The dead stay where they fell.**

## 10. Lessons
- **Chaotic army movement:**
  - The army looked "disjointed" while stations were laid out on the captain's facing, followers faced the way they stepped, a departure reshuffled the stations, and everyone replanned every second.
  - The fix: a steady heading, fixed slots, facing the heading, an eased approach, the captain at 0.9× the followers' pace, a column on the march and a line in the fight.
- **Columns** march 30% faster. Men out of place jog to catch up.
- **Standing blocks shivered** because pushed men snapped back to their slots. The fix was the momentum model (SETTLE, ARRIVE, RESPONSE).
- **Downhill speed bonus = 0.** A bonus made the mindless charge too strong.
- **Every order can be taken back.** Commanders pull their remnants out.
- **Drakes** inherited the elephant's turning and its way of standing in melee, which "looked weird". Turn rate, pack behaviour and the hunt became per-unit stats.
- **Open issue:** team 1 won about 55% of fights between equal armies, possibly because of squad step order. Consider alternating which side steps first each tick.
