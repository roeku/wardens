# The campaign contract (day 5)

The shared names between the campaign's rules (Rust, `crates/sim/src/campaign/`), its WASM face
(`crates/sim-wasm/src/campaign_api.rs`), the screens (`web/src/screens/`), the portraits (`web/src/view/portraits/`) and the
broodlord (`web/src/voice/broodlord/`). Specs: `docs/spec/01-flow.md` §3–§7, `03-land.md` §7 "Campaign props" and §9 "The road",
`04-battle.md` §7–§8, `06-voice.md` §8.

The owner of the campaign rules may **add** fields. Renaming or removing a field below needs this file updated in the same
change, since the other parts read it.

## 1. Who owns what

| Part | Owns | Gives the others |
|---|---|---|
| Campaign rules | `crates/sim/src/campaign/`, `crates/sim/src/map/road.rs`, road land dressing, `Setup` for campaign and custom battles, `crates/sim-wasm/src/campaign_api.rs`, harness `campaign` | the `Campaign` WASM object below; `face` on every company |
| Screens | `web/src/main.ts`, `web/src/screens/`, `web/src/view/cards/`, scene changes, saves | `Cards` (§5); a battle scene that calls `installBroodlord` |
| Portraits | `web/src/view/portraits/`, commander looks in `web/src/view/figures/outfit.ts`, the battle's face moments | `portrait(face, side)` (§6) |
| Broodlord | `web/src/voice/broodlord/`, intent-following in `crates/sim/src/bots/` | `installBroodlord(play, opts)` (§7) |

Every installer returns `{ dispose(): void }`, so a scene can end and the next one start without a page reload.

## 2. The `Campaign` WASM object

```
Campaign.create(seed: u32, opts_json: string): Campaign   // opts: {campaign: "warden", banners: 4}  (01-flow §4)
Campaign.load(save_json: string): Campaign                  // throws on a version mismatch (01-flow §5): discard the save
save(): string                                             // only between battles; throws during 'battle'
state_json(): string                                       // §3
// muster (01-flow §3.4)
plant(commander: u32, band: u32)                           // drop a commander on a band; swaps if the band had one
stand_down(commander: u32)                                 // lift a commander off its company
auto_muster()                                              // the debug hook's muster (01-flow §5 `autoMuster()`)
// the road (01-flow §3.5)
set_out(place: u32)                                        // phase 'muster'|'map' → 'march'; refuses an unreachable place
road_battle(): Battle                                      // the peaceful battle on the road map: the warband at its place
arrive()                                                   // 'march' → 'battle' (or → 'camp' at a camp place)
// battle
battle(): Battle                                           // the battle at the current place; its seed is hash32(seed, step, place)
finish(battle: &Battle): string                            // applies the outcome; returns the tally (§4); phase → 'map'|'camp'|'won'|'lost'
// camp (01-flow §3.8)
honour(company: u32)                                       // +1 rank, once per camp
break_camp()                                               // 'camp' → 'map'
// the end
chronicle_json(): string                                   // §3 `chronicle`
hall_json(): string                                        // §3 `hall`: what this campaign adds to the Hall
```

Custom battles (the war table, 01-flow §3.3): `Battle.custom(seed, json)` with
`{kind: "field"|"night"|"keep"|"hold"|"village"|"ford", size: 4|6|9, strength: "easy"|"fair"|"hard", land: string|"any"}`.

Phases (01-flow §3): `muster | map | march | battle | camp | won | lost`. `march` is the column walking the road.

## 3. `state_json()`

```jsonc
{
  "v": 1, "seed": 7, "campaign": "warden", "phase": "map", "step": 1, "at": 3,   // at: a place id, or null at the hall
  "day": 4,
  "road": {
    "w": 119, "h": 40, "hall": {"x": 5.5, "y": 20.5}, "muster": {"x0": 8, "y0": 0, "x1": 31, "y1": 40},
    "places": [{
      "id": 3, "step": 1, "lane": 0, "kind": "holdfast",   // holdfast | village | ford | camp | keep
      "name": "MILL", "at": {"x": 44.5, "y": 8.0}, "links": [6, 7],
      "reachable": true, "done": false, "danger": 0,
      "houses": 5,                                     // villages: houses still standing (0 = burnt out)
      "foe": 2,                                        // the broodlord holding it (a `foes` id), or null
      "garrison": [{"unit": "blightman", "n": 24}, {"unit": "troll", "n": 6}]
    }]
  },
  "warband": {
    "captain": {"name": "CAPTAIN", "hp": 30, "hp_max": 30, "face": 1234},
    "companies": [{
      "id": 0, "name": "BORS", "unit": "horse", "men": 12, "full": 14, "rank": 1, "way": "reckless",
      "face": 98765, "freed": false, "kills": 9, "battles": 2,
      "colours": [2],                                  // broodlords this company brought down (`foes` ids)
      "last": {"lost": 3, "joined": 0}
    }]
  },
  "muster": {
    "banners": 4,
    "bands": [{"id": 0, "unit": "spear", "men": 16, "seasoned": false, "rank": 0, "village": "ASH", "commander": null}],
    "commanders": [{"id": 0, "name": "ODA", "way": "steady", "face": 4411, "veteran": false, "suits": "shield", "band": null}]
  },
  "foes": [{"id": 2, "name": "GRAX", "way": "reckless", "rank": 0, "face": 777, "place": 3, "state": "waiting"}],  // waiting | escaped | down
  "fallen": [{"name": "WIL", "face": 12, "way": "stubborn", "rank": 2, "unit": "spear", "step": 2, "place": 5}],
  "chronicle": null,                                   // at the end: see chronicle_json()
  "hall": null
}
```

- `face` is a stable seed for a person's look. The same number drives the figure on the field and the portrait, so a commander
  looks the same in every battle, on every card and in the Hall.
- Names follow the kit's rule for speech: one or two syllables, a different first sound each, never a common word or a command.

## 4. The tally (`finish`)

```jsonc
{
  "won": true, "reason": "keep taken",
  "companies": [{"id": 0, "lost": 3, "joined": 2, "rank_up": true, "fell": false}],
  "fallen": ["WIL"], "returned": ["ODA"],             // a won battle: half the fallen were only wounded
  "freed": 9, "new_company": "TAM",                   // the freed founding a company, or null
  "foe": {"id": 2, "state": "down", "by": 0},          // brought down by company 0, or escaped
  "burnt": [5]                                         // villages that burnt out while the warband was away
}
```

### 4a. What the campaign rules added (day 5; additions only, nothing above renamed)

Behaviour the calls above did not spell out:
- `battle()` and `Battle.custom()` return the battle with **the blight's bot already set on team 1** (`garrison` at a
  holdfast, village or keep; `raiders` at a ford; `general0..2` on a custom field or hold by strength). Call `set_bot(1,
  'none')` to play it otherwise. Team 0 has no bot.
- In `battle()` and `road_battle()`, **squad 0 is the captain and squad k+1 is company k** in `warband.companies` order. At
  the muster, `road_battle()` has the captain and **every band** as a company standing at its `at` (squad k+1 is band k,
  named for its commander once planted, else unnamed). After the muster the warband stands at its place (or by the hall),
  facing where it goes. The road battle has no team 1 and never ends; the road map is `kind: "road"` (`places_info().kind`).
- On the road map each place is a site whose id is the place id (the hall is the last site, our colours). The view draws
  them with the site kinds it has: holdfast → tower, village → town, ford → village, camp → shrine (its fire), keep → keep,
  hall → keep (ours). `places[].site` gives the site id.
- `unit` everywhere is the sim's unit name: `spear | shield | archer | horse | levy` (the freed) for the warband and
  `blightman | troll | drake` for the blight. The bow icon is `archer`'s.
- `chronicle_json()` and `hall_json()` return the data as it stands at any time; `state_json().chronicle/hall` are null until
  the end.

Fields added to `state_json()`:
```jsonc
{
  "from": 0, "to": 3,          // while marching or fighting: where the warband came from (it falls back there) and goes
  "battles": 2,                // battles fought
  "honoured": null,            // the company honoured at this camp
  "last": { ... },             // the last tally (§4), or null
  "road": {
    "hall_links": [0, 1, 2],
    "places": [{ ..., "site": 3,  // the road map's site id
      "share": 0.62,              // the garrison's size factor m (each company is its unit's full count × m)
      "rank": 0,                  // the garrison's rank, floor(step/3)
      "garrison": [{"unit": "blightman", "n": 24, "companies": 2}] }]   // "companies" added
  },
  "warband": { "companies": [{ ..., "squad": 1, "veteran": false, "village": "ASH" }] },
  "muster": {
    "planted": 3, "ready": false,                         // banners filled so far; true when set_out may go
    "bands": [{ ..., "at": {"x": 24, "y": 5.5}, "squad": 1 }],   // rank: the band's, or with its commander's bonuses once planted
    "commanders": [{ ..., "at": {"x": 9.5, "y": 15.5} }]
  },
  "foes": [{ ..., "lord": false, "met": true, "by": 0 }]    // the nest's lord; fought; the company that brought him down
}
```

Fields added to the tally: `"people"` (villagers freed), `"heirs"` (names of companies founded by an heir of a fallen
commander), `"home"` (men with no ranks to fill, gone home), `"phase"` (the phase after the battle). `"reason"` is the
battle's (04-battle §8: `keep taken`, `no defenders`, `withdrew`, `captain fell`, `saved`, …) unless the campaign ended there,
then the end's: `keep taken | captain fell | warband gone`.

`chronicle_json()`: `{won, reason, frame: "gold"|"grey", days, battles, captain: {name, face, alive}, commanders: [{name,
face, way, rank, unit, alive, colours}], foes: [{name, face, lord, down}]}` (foes met only).
`hall_json()`: `{campaign, seed, won, fallen: [{name, face, way, rank, unit}] (≤ 24), colours: [{name, face, lord, by}] (≤ 12),
veterans: [{name, face, way, rank}]}` (the commanders who lived, once it ended).

## 5. Cards (screens own `web/src/view/cards/`)

```ts
type Icon = 'man' | 'chevron' | 'swords' | 'banner' | 'pennant' | 'heart' | 'heart-empty' | 'broken-sword' | 'hall'
          | 'ribbon' | 'coin' | 'spear' | 'shield' | 'bow' | 'horse' | 'blightman' | 'troll' | 'drake' | 'broodlord';
interface CardSpec {
  face?: { face: number; side: 'warden' | 'blight'; grey?: boolean };   // drawn by portrait()
  name?: string;                        // bitmap capitals
  word?: string;                        // at most one word
  picto?: { icon: Icon; n?: number; colour?: 'gold' | 'red' | 'green' | 'grey' }[];
  frame?: 'gold' | 'grey';
}
class Cards { show(spec: CardSpec, at: { x: number; y: number }, beside: 'left' | 'right'): number; hide(id?: number): void; frame(dt: number): void; dispose(): void }
```

A card stands beside the tapped thing, never over it; it rises in 1/6 s and fades (01-flow §3 "Diegetic UI rules"). It is drawn
at the art-pixel scale with the 5×7 font (`web/src/view/font5x7.ts`), with no browser font and no alpha blending.

## 6. Portraits (`web/src/view/portraits/`)

```ts
portrait(face: number, side: 'warden' | 'blight', opts?: { grey?: boolean; unit?: string }): HTMLCanvasElement   // 80×96, cached
```

Until the portraits land, `Cards` draws a flat side-coloured tile in the face's place.

## 7. The broodlord (`web/src/voice/broodlord/`)

```ts
installBroodlord(play: BattleView, opts: { way: 'stubborn' | 'reckless' | 'steady' | 'veteran'; name: string; enabled: boolean }): { dispose(): void }
```

The battle scene calls it for every battle against a broodlord. With `enabled: false`, or with no brain, the bots alone play.
