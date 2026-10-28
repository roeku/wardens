# Progression: drafts, unlocks, the Hall's tree, and difficulty

**What the original was missing.**
- VANGUARD had growth *within* a campaign: companies gained ranks from kills, commanders had traits with a suited bonus, a camp could honour a company, and the freed joined as recruits.
- It had almost nothing *between* campaigns. Only the surviving commanders came back, a rank up.
- It never gave the player a **choice of how to grow**: no skill tree, no unlocks, no drafts, no difficulty ladder.
- Gold, relics and spoils had been removed (D-64) to keep power off menus. The removal went too far: the game lost its long-term pull.

This file adds the missing layers. It takes from three reference games (teardowns in `game-analysis/docs/`):
- **We March as One:** payout rules you can read, gold even on a loss, plain-number upgrade trees, the enemy roster shown before you commit.
- **Dawn of Defense:** the pick-1-of-3 draft ceremony with rarity, unlock-type drafts, a meta tree that **widens the pool rather than raising numbers**, and an authored pressure curve over seeded maps.
- **Kingmakers:** officers as morale nodes, a three-way choice over a captured officer, and counters printed in plain words on the unit card.

**What the layers must keep from VANGUARD:**
- losses that stick
- no shop and no power menu **on the battlefield**
- people you know as the centre of everything

The rule that resolves the tension: **grow through your people and your choices, not through a store.**

| Layer | Timescale | Where it happens | Currency |
|---|---|---|---|
| Battle | seconds | the field | none |
| Company drills | each rank-up | after the battle, on the road | none (a draft) |
| Boons | after each won battle | after the battle, on the road | none (a draft) |
| The Hall's tree | between campaigns | the Hall of Banners | **Honour** |
| Heat (difficulty ladder) | after the first won campaign | the Hall | multiplies Honour |

There is exactly **one currency, Honour**, and it is only spent at the Hall. Inside a campaign every choice is a draft, so there is no shopping and nothing to grind.

**On words.** The battlefield stays wordless. Off the field (drafts, the Hall, cards), a choice may carry **one short line with a number** in the bitmap font, e.g. `SPEARS · CHARGE TAKEN −30%`. The rule was "at most a word"; this relaxes it on purpose. All three reference games show that plain numbers are what make upgrades readable, and We March as One's YouTuber praised exactly that.

---

## 1. Honour: what a battle pays
After every battle, banked even if the campaign is later lost. It is shown as a tally of pictograms under the banners, in the same scene as the loss/joiner tallies (`01-flow.md` §3.5). Each line pops in with a coin tick.

| Line | Rule | Pictogram |
|---|---|---|
| Victory | `V = 100 × (1 + 0.15·step)` | crossed swords |
| Decisive | +0.5·V if ≥ 60% of the men who began the battle are alive at its end (wounded count as alive) | banner |
| Unbroken | +0.5·V if no commander of yours fell and no company routed | heart |
| Saved | +2 per villager freed or carried across the ford | man |
| Broodlord | +0.4·V if one was brought down (or the capture choice in §5) | pennant |
| **Defeat** | instead of Victory: `0.2 × V × fraction of enemy men destroyed`; Decisive and Unbroken don't apply | broken sword |
| Heat | the subtotal × `(1 + 0.2·heat)` | flame |

**Expected totals** (check these with the bots in §7): a won campaign pays about **1,200–1,800**; a lost one about **300–800**.

**The rule behind it,** from We March as One: a loss still moves you forward. The partial pay on defeat is what turns a wall into something you chip at. VANGUARD's men still die for good; only the Honour carries over.

## 2. Company drills: the people grow (the core addition)
A company gains a rank at 6, 18 and 36 kills (existing). **Each rank now also brings a drill:**
- After the battle, during the banner tally, the commander of each company that ranked up steps forward.
- **Three drill cards rise from the ground beside them.** Pick one.

**The draw:**
- Two cards come from the company's **kind** list and one from the commander's **way** list.
- A company can hold at most 3 drills, one per rank.
- **Drills belong to the commander.** If the commander falls, the drills go into the ground with the banner. When a veteran commander returns in the next campaign, they bring their drills with them.

This makes every loss cost more, and every survivor worth more. That is the centre of VANGUARD's feeling, now with player choice in it.

**The card:**
- the drill's pictogram, its one-word name, and one line with its number
- the company card (`01-flow.md` §3) shows the drills owned as small pictograms beside the chevrons

### Kind drills
All are stat hooks that already exist in the battle spec, so nothing new needs simulating except where marked "new".

| Kind | Drill | Effect |
|---|---|---|
| Spear | BRACE | chargeTaken 0.4 → 0.28 |
| | LONG PIKES | melee reach +25% |
| | HEDGEHOG | when standing (hold), morale loss from flanking ×0.5 |
| | HUNTSMEN | ×1.3 damage vs beasts |
| | STEADY RANKS | steadiness ×0.85 |
| Shield | SHIELD WALL | damage taken −4% per adjacent shield man, up to −24% (new: neighbour count from the grid) |
| | PAVISE | the first missile hit on each man is blocked once per battle (new) |
| | THORNS | 30% of melee damage taken is dealt back (new) |
| | MAIL | hp ×1.2 |
| | ANVIL | outnumbered morale loss ×0.5 |
| Archer | LONGBOWS | range +1.5 |
| | RAPID FIRE | interval ×0.85 |
| | BARBED | a hit slows the target's move and attack by 25% for 2 s (new) |
| | PIERCING | pierce 0 → 0.4 |
| | FIRE ARROWS | hit sets 2 damage over 3 s; can douse/burn nothing (new) |
| Horse | BLOODED | after a charge lands, interval ×0.5 for 4 s (new) |
| | LANCE | first blow of a charge from +0.5 reach, ×1.3 damage |
| | OUTRIDERS | speed ×1.1, sight +2 |
| | WHEEL | beasts' horse terror doesn't apply; turn rate ×1.3 |
| | SKIRMISH | arrowTaken 1.1 → 0.8 |
| Levy (freed) | VILLAGE PRIDE | steadiness 1.15 → 0.9 |
| | PITCHFORKS | vsHorse 1.6 |
| | QUICK TO LEARN | gain colours (rank 2) one battle sooner |

### Way drills
| Way | Drill | Effect |
|---|---|---|
| Stubborn | IMMOVABLE | rout threshold 22 → 14 |
| | LAST STAND | below 30% men, damage ×1.3 |
| | GRUDGE | +morale when an adjacent company breaks instead of losing it |
| Reckless | GLORY HOUND | kills count double toward rank |
| | HEADLONG | charge recovers after 1.5 s out of contact instead of 3 |
| | FEARLESS | the reckless morale penalty is removed |
| Steady | WATCHFUL | the steady aura reaches 8 tiles instead of 5 |
| | CALM VOICE | a routing company within 5 rallies after 2 s instead of 5 |
| | DISCIPLINE | the cohesion gate is loosened: the full-pace threshold 1.6 → 2.4 |
| Veteran | OLD HAND | the commander's own hp ×1.5 |
| | TEACHER | recruits joining this company arrive at rank +1 |
| | READ THE FIELD | sight +2, and the company's enemies show on its card |

## 3. Boons: the warband's draft after each battle
After every **won** battle, once the tallies and drills are done, **three standards rise on the road: CHOOSE ONE.** This is the runestone ceremony from Dawn of Defense:
- The field dims to 0.62.
- The standards flip from blank linen to their device, one after another, 0.15 s apart.
- The hovered or held one grows ×1.15 and shows its one line.
- **The border colour is the rarity:** linen (common), green (uncommon), blue (rare), gold (legendary). Gold already means honour and choice in the palette, so legendary keeps it.
- **Buttons, drawn as small pictogram plates:**
  - **ROAD:** look at the road first (Dawn of Defense's VIEW MAP).
  - **REROLL:** spends a reroll. 2 per campaign, +1 from the Hall.
  - **PASS.**

**Rarity weights** at step s: common `60 − 4s`, uncommon `28 + 2s`, rare `10 + 1.5s`, legendary `2 + 0.5s` (percent; renormalise).

### The starting pool (18)
| Boon | Rarity | Effect |
|---|---|---|
| FIELD SURGEONS | common | after a won battle, 70% of the fallen were only wounded (instead of 50%) |
| RECRUITERS | common | a freed village sends 8 men instead of 6 |
| PROVISIONS | common | camps heal 50% of missing men instead of 35% |
| LONG DAY | common | battle time +20% before nightfall |
| SCOUTS | common | road places show their full enemy roster from two rows away |
| BANNER BEARER | uncommon | captain's aura 5.5 → 7.5 tiles |
| RALLY HORN | uncommon | a rally also restores +15 morale to every company |
| CHARGER | uncommon | the captain's charge ×1.5 and his ride speed ×1.15 |
| FORCED MARCH | uncommon | villages in sight do not lose a house on camp days |
| DRILLMASTER | uncommon | the next rank-up draft shows 4 cards |
| SPEARS / SHIELDS / BOWS / HORSE OF RENOWN | uncommon | every company of that kind: damage ×1.1 |
| WATCHFIRES | rare | at night, sight ×0.8 instead of ×0.6, and the relief arrives 10 s later |
| SECOND WIND | rare | once per battle, the first company to rout rallies at once at 45 morale |
| THE OLD OATH | legendary | once per campaign, the first commander who would fall survives at 1 hp and is pulled out |

### Unlock-type boons
These change the shape of the campaign, as Dawn of Defense's Catapult and Quarry runes do. Each enters the pool only after its Hall node is bought (§4).

| Boon | Rarity | Effect |
|---|---|---|
| BOWYERS OF ASHFORD | uncommon | crossbowmen appear among the bands at the next muster or freed village; the first company of them arrives free |
| THE WARDEN KNIGHTS | rare | a band of knights (5) joins at once under a new commander |
| HOUNDMASTER | rare | a company of war hounds: fast, light, ×2 vs routing men |
| BEAST TAMERS | legendary | one tamed drake joins (Myths) |

## 4. The Hall's tree: between campaigns
**Where it lives.** The Hall of Banners is already the place where campaigns begin and the fallen are remembered (`03-land.md` §7, `01-flow.md` §3). Its tree is part of the Hall:
- Tap the hall's door and a **tapestry** unrolls, the same motion as the chart (`03-land.md` §9).
- It is woven in rings around the warband's device.
- Each node is a small embroidered pictogram, with one word and its cost in Honour.
- **Node states:** bought nodes are stitched in gold thread; affordable ones are cream; unaffordable ones are faded; locked ones are dotted outlines.
- A bought node's line glows along its thread to its neighbours.
- It reads like We March as One's tree, in VANGUARD's own materials.

**Principle** (from Dawn of Defense, and from the original SPILLWAY design doc's "unlocks widen the pool instead of raising numbers"): most nodes add **possibilities** (kinds at the muster, cards in the draft pools, choices at the muster), not raw power. Flat stat nodes are few and small, so a player's first campaign stays as hard as the bots say it is.

| Ring | Node | Cost | Effect |
|---|---|---|---|
| 1 | MUSTER CRIER | 120 | +1 band to choose from at the muster |
| 1 | SEASONED MEN | 150 | seasoned band chance 30% → 45% |
| 1 | SECOND THOUGHTS | 150 | +1 boon reroll per campaign |
| 1 | BOWYERS | 200 | unlocks crossbowmen (muster pool + the BOWYERS boon) |
| 1 | SCOUTING PARTY | 180 | adds SCOUTS and LONG DAY to the boon pool at uncommon |
| 2 | FIFTH BANNER | 450 | campaigns start with 5 companies instead of 4 |
| 2 | ARMOURERS | 400 | unlocks men-at-arms |
| 2 | DRILL YARD | 500 | adds tier-II drills: each kind's last two drills enter its draw (before, only the first three) |
| 2 | CAPTAIN'S CHARGER | 350 | the captain's hp 80 → 100 |
| 2 | WAR HOUNDS | 400 | unlocks war hounds and the HOUNDMASTER boon |
| 3 | THE WARDEN KNIGHTS | 900 | unlocks knights and the WARDEN KNIGHTS boon |
| 3 | OATHKEEPERS | 1,000 | adds the legendary boons to the pool |
| 3 | TAMERS | 1,500 | unlocks beasts at the muster (Myths) and BEAST TAMERS |
| 3 | HEAT | 600 | unlocks the difficulty ladder (§6); needs one won campaign |
| — | VETERANS' WELCOME | 250 | a returning veteran commander may bring one drill more |
| — | CHRONICLER | 300 | the chronicle and camp letters remember 3 campaigns back (LLM context) |

- Total: about **7,500 Honour**, so the full tree takes **5 to 7 campaigns**.
- **Gates:** each ring needs 2 nodes bought in the ring inside it. Show the gate as the thread itself: a ring's threads stay dotted until it opens.

## 5. Broodlords: officers as morale nodes, and what to do with one taken
VANGUARD already makes the enemy commander a morale node: their fall costs the other enemy companies 25. Kingmakers adds two things worth taking:
- **A second outcome for the same trigger.** When a broodlord falls, each enemy company within 8 tiles rolls:
  - **rout shock:** the existing −25;
  - or **frenzy**, with chance `0.25 × (1 − morale%)`: damage ×1.3 and steadiness ×0.5 for 10 s.

  This keeps "kill the officer" from being an automatic win. Show frenzy as the company's banner whipping fast and its men tinted toward team [3].
- **A choice when one is brought low** (their company pulled out at half strength is the existing escape rule). If your captain or a company **reaches the broodlord while their hp is under 25%**, they are taken instead of killed.
  - After the battle, three plates appear by their face:

    | Choice | Effect |
    |---|---|
    | **RANSOM** | +0.8·V Honour; they return later, a rank harder (the existing escape rule) |
    | **QUESTION** | the next two rows of the road show their full rosters, and the nest's broodlord's way is revealed |
    | **SLAY** | +15 morale to every company at the start of the next battle; their colours hang in the Hall |

  - Kingmakers' version includes torture. For The Wardens, use the three above.

## 6. Heat: the difficulty ladder (after the first won campaign)
Thronefall-style mutators, as the original design doc's "Floodmarks". Each level adds one rule and multiplies Honour by `(1 + 0.2·heat)`. The current heat shows as flames on the Hall's brazier.

| Heat | Adds |
|---|---|
| 1 | garrisons +10% men |
| 2 | broodlords start +1 rank |
| 3 | villages burn every 20 s instead of 26 s, and a passed village loses 2 houses a day |
| 4 | the day is 20% shorter |
| 5 | freed villages send 4 men, and the wounded share after a win is 35% |

## 7. Show the threat before you commit
All three reference games tell the player what's coming; VANGUARD only showed the enemy commander's face.

- **The place card on the road:**
  - add the garrison as pictograms of kind × count, e.g. `▲12 ■10 ◆6`, using the battle spec's kind marks
  - add the broodlord's way sign
  - SCOUTS and QUESTION reveal places further ahead
- **Counters on cards, as icons.** A company card shows **STRONG VS** and **WEAK VS** as kind marks, in green and red. This is We March as One's icon plus Kingmakers' coloured line, generated from the stat table:
  - a multiplier ≥ 1.5 against a kind counts as strong
  - a multiplier ≤ 0.7 taken from a kind counts as weak
- **Make height visible.** VANGUARD's hills already give archers +1.2 range per tile of height, the same number Dawn of Defense uses for its towers. While drawing a front, the ghost bars of a bow company on high ground get a small `+` chevron per tile of height.
- **The captain's aura becomes visible:** men inside it are tinted 12% toward team [3], as We March as One does with its King.

## 8. Ownership you can see on the land (a Wardens-only idea from Dawn of Defense)
In The Wardens, the blight **corrupts the land it holds**, and it heals when you free it. This is Dawn of Defense's biome recolouring, used as the story.

- **Corrupted ground uses a blight ramp:**
  - grass `#3a2a2a #4f3330 #6a3e36 #84503f`
  - glowing cracks `#c84a1c`
  - drawn as texel-level crack lines with the same noise as the rock cracks in `03-land.md` §4, at 0.6 intensity
- **When a place is freed,** the corruption recedes outward from the site over 1.5 s. Ground texels flip back to the land's own ramp in a Bayer-dithered ring, with a soft rising chord on the `freed` cue.
- **On the road,** corrupted stretches show which places are still the blight's.

This replaces the original's roof-colour ownership for the enemy side: roofs still take the player's blue when held.

## 9. Data and determinism
- **Boons, drills and Hall nodes are data:**
  `{id, rarity?, cost?, ring?, requires?: id[], kind?: Kind, way?: Way, mods: Mod[], unlock?: UnitId | BoonId, hook?: HookId}`.
- **`Mod` reuses the tuning-table override mechanism** the original already had (`PROTO_TUNE`): `{path: 'KINDS.spear.chargeTaken', op: 'mul' | 'add' | 'set', v: 0.7, scope: 'company' | 'kind' | 'army'}`. So every effect is testable headless, and a run is still seed + log.
- **Effects that need code** (THORNS, BARBED, PAVISE, BLOODED, SHIELD WALL, FIRE ARROWS) are named hooks in the battle step, each with its own check.
- **Drafts draw with `hash32(seed, battleIndex, salt)`,** so a campaign's drafts replay identically. Rerolls advance the salt.
- **Save format:** the Hall stores `{honour, bought[], heat, unlockedKinds[], pool[]}`. The campaign stores each company's drills, and the boons taken.

## 10. Balance targets (bots in the harness)
Add bot policies:
- **draft:** `greedy` (highest rarity, then a fixed preference) and `random`
- **Hall:** `cheapest-first`

| Measure | Target |
|---|---|
| sensible bot, heat 0, nothing bought | campaign win 30–50% (unchanged) |
| sensible bot, full Hall tree, heat 0 | 60–75% |
| sensible bot, full tree, heat 5 | 25–40% |
| any single boon or drill | raises win rate by ≤ 12 points over 30 seeds (the original's "swap test") |
| Honour per campaign | won 1,200–1,800; lost 300–800 |
| campaigns to complete the tree | 5–7 |

Every check prints its counts (the original's lesson: checks that pass without running).

## 11. What to build in the hackathon, and what to leave
**In scope (about 1.5 days):**
- Honour and its tally (§1)
- company drills, with 3 per kind and 3 per way to start (§2)
- the boon draft, with 12 boons including 2 unlock-type (§3)
- the Hall's tapestry with rings 1–2 (§4)
- roster pictograms and STRONG/WEAK icons (§7)
- the visible captain's aura (§7)

**If time allows:**
- the broodlord capture choice (§5)
- heat 1–3 (§6)
- blight corruption on the land (§8): this one is a strong visual for the demo, so try for it

**Leave out:** ring 3 of the tree, beasts, frenzy, and everything marked Myths.
