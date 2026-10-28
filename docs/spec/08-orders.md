# The order language: commanding by voice and marks

Added during the hackathon, 28 Oct 2026, on the owner's direction (DECISIONS.md D-10). It widens what the captain can order, and what the simulation can carry out. It builds on `04-battle.md` and `06-voice.md`, and takes from the three reference games.

**Why this is the heart of the game:**
- **We March as One:** its player's loudest frustration was having no orders after deployment: *"Cavalry, you're going for the wrong troops, please get their archers."*
- **Dawn of Defense:** it has targeting priorities, but they hide behind icons the player never touched.
- **Kingmakers:** its strategy view gives only attack, hold and waypoint.

Speech fixes all three, but only if the words can say *who, what, which, how and when*, and the battle can do it.

## 1. Principles
- **One order language.** Voice, marks, typed text, bots and the broodlord all produce the same `Deed`s through the order queue. A replay is still the seed plus the log.
- **The model never invents names or coordinates.** Every name the model may use is an enum in the per-battle schema (`06-voice.md` §4c); code resolves names, selectors and sides into points and squads.
- **Breadth by composition, not special cases.** An order is
  - **who** (a selector)
  - a **verb**
  - a **target** (a selector)
  - **modifiers**
  - **when** (now, after the current order, on a signal, or on a condition)

  A small set of each multiplies into a large language.
- **Every order is visible and revocable:**
  - It draws as marks.
  - A tap undoes it.
  - A refusal shows a red cross and sounds the query horn; its reason goes to the log, not the field.
- **The battlefield stays wordless.** Speech goes in; marks, horns and movement come out.

## 2. Who: selectors
| Selector | Examples | Resolves to |
|---|---|---|
| the army | "everyone", "all", "the army" | ARMY: the captain leads, companies keep stations |
| others | "everyone else", "the rest" | companies not named earlier in the same words |
| kind | "riders", "archers", "spears", "shields", "the levy" | every company of that kind |
| name | "Bors", "Oda" (fuzzy) | that company |
| position | "the left wing", "the front line", "the rear", "the reserve" | companies by their place in the army's frame |
| state | "whoever is free" (not fighting), "the fresh ones", "the broken ones", "the wounded" | companies by state and morale |
| relation | "the company nearest the ford", "the ones by the mill" | nearest to, or within reach of, a place or feature |
| a named group | "Bors and Ren, you're the hammer" … "hammer, go" | a group named by voice, kept for the battle (the hotgroups of Dawn of Defense and Kingmakers) |

## 3. Verbs
| Verb | Meaning | Notes |
|---|---|---|
| move · attack · take · hold/guard · front · recall · rally | as `04-battle.md` and `06-voice.md` §6 | existing |
| follow / escort | stay by a company or the captain, and defend it | target is a company or "me" |
| screen / cover | stand between a threat and a company or place | e.g. "shields, cover the archers" |
| charge | attack now, ignoring the cohesion gate | reckless |
| withdraw | fall back fighting: keep facing the enemy, step back | different from a recall, which walks out |
| pursue · stop | chase routers, or stop chasing | |
| skirmish / harass | ranged companies keep their distance and shoot, falling back from melee | |
| volley · hold fire · fire at will | archers' fire discipline | "loose on my mark" uses §6 |
| wait / stand by | do nothing until a signal | a standing order |
| reserve · commit | hold a company back out of the line, or send it in | We March as One's reserves |
| regroup / rest | fall back behind the line to recover morale | |
| form | line, column, wedge, square/ring, shield wall, loose, tight, thin, deep | shapes the frontage and spacing |
| face | turn toward a direction, feature or enemy | |
| build · man · tear down | the field works of §7 | |
| evacuate · douse | lead the folk across the ford; fight a village fire | places of `04-battle.md` §8 |
| signal | "now!", "go!", "loose!" | releases waiting orders (§6); fast path |

## 4. Targets: selectors
- **Places, features and enemy ids:** as today.
- **Enemies by kind:** "their archers", "the drakes", "the big ones" (trolls), "the blight-men".
- **Enemies by state or relation:**
  - "the nearest"
  - "the weakest" or "the most shaken"
  - "their strongest"
  - "their commander" or "the broodlord"
  - "the ones attacking the mill"
  - "whatever crosses the ford"
- **Relative points:**
  - "between the mill and the ford"
  - "behind the ridge"
  - "in front of the wood"
  - "across the river"
  - "our left flank"
  - "beside Oda"

  Each resolves in code from the army's frame and the named features.

## 5. Modifiers
| Modifier | Values |
|---|---|
| route | round the left / right, through the wood, along the river, by the road (via points, `06-voice.md` §6) |
| pace | walk, quick, double time (column) |
| stance | aggressive (engage at full reach, pursue), defensive / hold ground (fight only what reaches you, never leave the post), hold fire, skirmish |
| formation | shape and frontage, as `form` |
| priority | nearest, by kind, weakest, strongest, commander (the targeting of Dawn of Defense, made sayable) |
| fight | whether a move engages on the way (`04-battle.md` §5) |

## 6. When: sequences, signals, conditions
- **Sequences:** "take the mill, **then** hold the ford" puts the second order in that company's queue, and it runs when the first completes.
- **Signals:** "riders, wait for my mark" … "**now!**". Signals arrive as Commands, so they stay deterministic.
- **Conditions,** checked each tick from sim state only:
  - an enemy within reach of a place ("when they reach the ford, charge")
  - a company breaks ("if the shields break, the spears fill in")
  - the captain is attacked
  - nightfall or dawn
  - after N seconds
  - the target routs ("if they run, let them go")
- **Standing orders:** "don't let anything cross the ford"; "whoever is free, help the shields".
- **Marks:** a waiting order shows as a faint mark that brightens when its trigger fires.

## 7. Field works (built structures)
Companies build them by order, as in Dawn of Defense and Kingmakers, inside a battle. No currency: the cost is the company's time and safety.

| Work | Effect | Voice |
|---|---|---|
| stakes | in front of a line: charges into them take chargeTaken ×0.4 and lose the charge bonus | "spears, stake the line" |
| barricade | a short segment that blocks movement; cover against arrows behind it | "shields, barricade the ford" |
| bridge | a new crossing over the river at a point | "build a bridge at the narrows" |
| watchtower | sight +3, archers inside +1.2 range, like a height level | "archers, man the tower" |

- **Building:**
  - A company works for N seconds and cannot fight while working.
  - An attack interrupts it.
  - The work rises visibly as it is built.
- **Enemy response:** the enemy can tear works down or burn them. The blight's capture squads go for places and works, not the line, as Dawn of Defense's enemy does.
- **Data:** works are data like units: `{id, work_s, footprint, hp, mods, blocks}`. Their effects reuse the tuning-table mods (`07-progression.md` §9).

## 8. Reference systems inside VANGUARD's core
Decided 28 Oct (D-10): **no store, losses stick, grow through your people.** Within that:
- **Deployment before contact** (We March as One): before the armies meet, time is held. The player places companies by drag or by voice ("riders on the left, archers behind the shields"), keeps a reserve, then gives "advance".
- **Hold-the-line waves** (Dawn of Defense):
  - The night and holdfast battles bring authored waves, and the next wave shows diegetically as enemy banners on the horizon.
  - The blight also sends capture squads at places and works.
- **Officers as morale nodes** (Kingmakers): a broodlord's fall can rout or enrage the companies near it, and a broodlord can be taken (`07-progression.md` §5).
- **Visible counters and the enemy roster before battle** (all three): `07-progression.md` §7.

## 9. Voice requirements
- **The schema grows** with the selectors, verbs, targets, modifiers and when-clauses above. Every name is still a per-battle enum, and the grammar keeps the reply compact. Measure the latency cost.
- **The fast path grows:** signals ("now", "go", "loose"), "hold fire", "stop", "everyone halt", and per-company stop.
- **Resolution** turns each selector into squads and points in code, and refuses with a reason.
- **Tools:**
  - `say "<words>"` runs any sentence against the current field.
  - The typed-order line goes through the same pipeline.
- **The eval grows from 20 cases to at least 100,** in categories:
  - selectors
  - verbs
  - enemy-by-kind targets
  - relative points
  - modifiers
  - sequences
  - signals
  - conditions
  - field works
  - refusals and unclear speech
  - paraphrases and filler

  Each category has paraphrases of the same intent.
- **Gate:** at least 90% accuracy in every category, and brain latency within 1.3× of D-07's.

## 10. Build order
1. **Day 3 (now):** the battle model is shaped for this: order = verb + modifiers, stances read in one place, target priorities, and a per-squad order queue with triggers.
2. **Next pass, with day 4's voice end to end:**
   - `Deed`s for §3–§6 in the contracts
   - the sim behaviours
   - the schema, resolution and fast path
   - the 100-case eval and `say`
3. **Field works (§7):** day 4–5, with the structures and the ford.
4. **Deployment and reserves (§8):** with the muster on day 5. **Waves:** with the night on day 4.
