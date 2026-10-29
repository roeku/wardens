//! The broodlord (day 5; docs/spec/06-voice.md §8, docs/engine/contracts/campaign.md §7): the field as the blight
//! sees it, for its brain, and the battle's replay (the seed and the log, the bots re-run), so a battle the brain
//! played replays without it. Its own `impl Battle` block, as the other parts of the WASM face.
//!
//! The field is web/src/voice/broodlord/mind.ts `BroodField`: the blight's companies (each named by its kind and a
//! number, BLIGHT1, TROLLS1, DRAKES2, so the brain can tell them apart), its broodlord, the warband's companies the
//! blight sees now (through team 1's fog, as the bots see them), the places with who holds them as the blight knows
//! it, and the named ground. Each company says what it is doing and when the brain last ordered it.

use serde_json::{Value, json};
use sim::battle::{Order, SquadState};
use sim::contracts::{Kind, P, Source, TICK_HZ, Team};
use sim::units::Unit;
use wasm_bindgen::prelude::*;

use crate::Battle;

/// The broodlord's side.
const TEAM: Team = 1;
/// A company's morale is shown only below this share.
const MORALE_SHOWN: f64 = 0.95;
/// The river's columns are given over this many rows either side of the blight's centre.
const RIVER_ROWS: i32 = 8;
/// A foe marching slower than this (tiles/s, its seen men's mean) is just "marching".
const MARCH_SHOWN: f64 = 0.2;
/// A point within this of a named spot is said by the spot's name.
const SPOT_R: f64 = 3.0;

#[wasm_bindgen]
impl Battle {
    /// The blight's fog-limited field as JSON, for the broodlord's brain.
    pub fn broodlord_field(&self) -> String {
        let names: Value = serde_json::from_str(&self.voice_names()).unwrap_or(Value::Null);
        field(&self.inner, &names).to_string()
    }

    /// The battle so far as a replay (`sim::battle::Replay` JSON): the seed, the map, the tick, every command that
    /// was not a bot's (taps, voice, the brain's intents), and the bots by name, which the replay re-runs. `setup`
    /// is the armies' name (empty for what the map opens with); `bots` is `[team0, team1]`, `none` for no bot.
    pub fn replay_json(&self, setup: &str, bot0: &str, bot1: &str) -> String {
        let b = &self.inner;
        let log: Vec<&sim::contracts::Command> = b.log.iter().filter(|c| c.src != Source::Bot).collect();
        let bots: Vec<Value> = [(0, bot0), (1, bot1)].iter().filter(|(_, n)| !n.is_empty() && *n != "none").map(|(t, n)| json!({ "team": t, "bot": n })).collect();
        let mut out = json!({ "seed": b.seed, "map": { "kind": b.map.kind, "width": b.map.w }, "tick": b.tick, "log": log, "bots": bots });
        if !setup.is_empty() {
            out["setup"] = json!(setup);
        }
        out.to_string()
    }
}

fn round(v: f64) -> f64 {
    v.round()
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// The compass word for a direction in sim coordinates (y south), in eight steps.
fn compass(d: P) -> &'static str {
    const T: f64 = 0.414_213_56; // tan(22.5°)
    let (x, y) = (d.x, d.y);
    if x.abs() < 1e-9 && y.abs() < 1e-9 {
        return "west";
    }
    let (ax, ay) = (x.abs(), y.abs());
    if ay <= ax * T {
        return if x > 0.0 { "east" } else { "west" };
    }
    if ax <= ay * T {
        return if y > 0.0 { "south" } else { "north" };
    }
    match (x > 0.0, y > 0.0) {
        (true, true) => "south-east",
        (true, false) => "north-east",
        (false, true) => "south-west",
        (false, false) => "north-west",
    }
}

/// A blight unit's kind word, as the brain says it, and the stem of its companies' names.
fn unit_words(u: Unit) -> (&'static str, &'static str) {
    match u {
        Unit::BlightMan => ("blight-men", "BLIGHT"),
        Unit::Troll => ("trolls", "TROLLS"),
        Unit::Drake => ("drakes", "DRAKES"),
        Unit::Broodlord => ("broodlord", "BROODLORD"),
        Unit::Spear => ("spear", "SPEAR"),
        Unit::Shield => ("shield", "SHIELD"),
        Unit::Archer => ("archer", "ARCHER"),
        Unit::Horse => ("horse", "HORSE"),
        Unit::Levy => ("levy", "LEVY"),
        Unit::Folk => ("folk", "FOLK"),
        Unit::Captain => ("captain", "CAPTAIN"),
    }
}

fn state_word(s: SquadState) -> &'static str {
    match s {
        SquadState::Idle => "idle",
        SquadState::Marching => "marching",
        SquadState::Fighting => "fighting",
        SquadState::Routing => "routing",
        SquadState::Fled => "fled",
        SquadState::Destroyed => "destroyed",
    }
}

/// The blight's companies' names by squad: the kind's stem and its number among the side's companies of that unit,
/// in id order (the dead keep theirs, so a name never moves to another company).
pub fn brood_names(b: &sim::battle::Battle) -> Vec<Option<String>> {
    let mut count = [0usize; Unit::ALL.len()];
    b.squads
        .iter()
        .map(|s| {
            if s.team != TEAM || s.kind == Kind::Captain || s.kind == Kind::Folk {
                return None;
            }
            let k = s.unit.id() as usize;
            count[k] += 1;
            Some(format!("{}{}", unit_words(s.unit).1, count[k]))
        })
        .collect()
}

/// The river's westmost and eastmost water columns over the rows near `y`.
fn river_near(m: &sim::map::BattleMap, y: f64) -> Option<(i32, i32)> {
    if m.river.is_empty() {
        return None;
    }
    let mid = (y.floor() as i32).clamp(0, m.h as i32 - 1);
    let rows = (mid - RIVER_ROWS).max(0)..=(mid + RIVER_ROWS).min(m.h as i32 - 1);
    let cols: Vec<i32> = rows.filter_map(|r| m.river.get(r as usize).copied()).collect();
    Some((*cols.iter().min()?, *cols.iter().max()? + 1))
}

fn field(b: &sim::battle::Battle, names: &Value) -> Value {
    let m = &b.map;
    let fog = b.fog(TEAM);
    let seen_tile = |p: P| m.idx(p.x.floor() as i32, p.y.floor() as i32).map_or(0, |i| fog[i]);
    let brood = brood_names(b);
    let site_name = |i: usize| names["sites"][i].as_str().unwrap_or("").to_string();
    // Spots a point can be said by: the sites, the fords and the hills.
    let mut spots: Vec<(String, P)> = m.sites.iter().enumerate().map(|(i, s)| (site_name(i), s.at)).collect();
    if let Some(fords) = names["river"]["fords"].as_array() {
        spots.extend(fords.iter().map(|f| (f["name"].as_str().unwrap_or("").to_string(), P::new(f["at"]["x"].as_f64().unwrap_or(0.0), f["at"]["y"].as_f64().unwrap_or(0.0)))));
    }
    if let Some(hills) = names["hills"].as_array() {
        spots.extend(hills.iter().map(|h| (h["name"].as_str().unwrap_or("").to_string(), P::new(h["at"]["x"].as_f64().unwrap_or(0.0), h["at"]["y"].as_f64().unwrap_or(0.0)))));
    }
    let say = |p: P| -> String {
        spots
            .iter()
            .filter(|(n, at)| !n.is_empty() && at.dist(p) <= SPOT_R)
            .min_by(|a, c| a.1.dist(p).total_cmp(&c.1.dist(p)))
            .map_or_else(|| format!("({},{})", round(p.x), round(p.y)), |(n, _)| n.clone())
    };
    let name_of = |j: usize| -> String {
        let s = &b.squads[j];
        if s.team == TEAM { brood.get(j).cloned().flatten().unwrap_or_else(|| s.name.clone()) } else { s.name.clone() }
    };
    // When the brain last ordered each of its companies, by squad.
    let mut ordered: Vec<Option<u32>> = vec![None; b.squads.len()];
    for c in b.log.iter().filter(|c| c.src == Source::Brain && c.team == TEAM) {
        for id in ids_of(&c.deed) {
            if let Some(o) = ordered.get_mut(id as usize) {
                *o = Some(c.tick);
            }
        }
    }

    // Its companies.
    let mut ours = Vec::new();
    let (mut cx, mut cy, mut cn) = (0.0, 0.0, 0.0);
    for (j, s) in b.squads.iter().enumerate() {
        if s.team != TEAM || !s.on_field() || s.alive == 0 || s.kind == Kind::Captain || s.kind == Kind::Folk {
            continue;
        }
        let c = b.centre(j);
        let doing = match &s.order {
            Order::Hold { .. } => "holding".to_string(),
            Order::Move { to, fight, .. } => format!("{} {}", if *fight { "going to" } else { "falling back to" }, say(*to)),
            Order::Attack { target, .. } => format!("attacking {}", name_of(*target as usize)),
            Order::Charge { target } => format!("charging {}", name_of(*target as usize)),
            Order::Take { site, .. } => format!("taking {}", site_name(*site as usize)),
            Order::Follow => "with the broodlord".to_string(),
            Order::Guard { ward } => format!("guarding {}", name_of(*ward as usize)),
            Order::Screen { ward, .. } => format!("screening {}", name_of(*ward as usize)),
            Order::Recall { .. } => "rejoining".to_string(),
            Order::Retreat => "retreating".to_string(),
            Order::Ride => "riding".to_string(),
            Order::Withdraw { to } => format!("withdrawing to {}", say(*to)),
            Order::Regroup { .. } => "regrouping".to_string(),
            Order::Build { .. } => "building".to_string(),
        };
        let mut o = json!({
            "id": j, "name": name_of(j), "unit": s.unit.name(), "kind": unit_words(s.unit).0, "men": s.alive, "full": s.full,
            "x": round(c.x), "y": round(c.y), "state": state_word(s.state), "doing": doing,
        });
        let morale = s.morale_share();
        if morale < MORALE_SHOWN {
            o["morale"] = json!(round2(morale));
        }
        if let Some(t) = ordered[j] {
            o["orderedS"] = json!(round((b.tick - t.min(b.tick)) as f64 / TICK_HZ as f64));
        }
        if s.state != SquadState::Routing {
            (cx, cy, cn) = (cx + c.x, cy + c.y, cn + 1.0);
        }
        ours.push(o);
    }

    // The broodlord.
    let lord = b.captain_of(TEAM);
    let lord_at = b.captain_at(TEAM).unwrap_or(m.deploy[TEAM as usize]);
    let lord_hp = lord.map_or(0.0, |c| {
        let man = &b.soldiers[b.squads[c].soldiers[0]];
        if man.max_hp > 0.0 { man.hp / man.max_hp } else { 0.0 }
    });
    let centre = if cn > 0.0 { P::new(cx / cn, cy / cn) } else { lord_at };
    let threat = b.threat_point(TEAM, centre);
    let fwd = P::new(threat.x - centre.x, threat.y - centre.y);
    let left = P::new(fwd.y, -fwd.x);

    // The warband's companies it sees now: only the men in its sight, where it sees them.
    let mut foes = Vec::new();
    for (j, s) in b.squads.iter().enumerate() {
        if s.team == TEAM || !s.on_field() || s.kind == Kind::Folk {
            continue;
        }
        let (mut n, mut x, mut y, mut vx, mut vy) = (0usize, 0.0, 0.0, 0.0, 0.0);
        for &k in &s.soldiers {
            let man = &b.soldiers[k];
            if man.alive && b.sees(TEAM, man.pos()) {
                n += 1;
                x += man.x;
                y += man.y;
                vx += man.vx;
                vy += man.vy;
            }
        }
        if n == 0 {
            continue;
        }
        let nf = n as f64;
        let state = match s.state {
            SquadState::Marching if (vx * vx + vy * vy).sqrt() / nf > MARCH_SHOWN => format!("marching {}", compass(P::new(vx, vy))),
            SquadState::Fighting => match s.threat.map(|t| t as usize).filter(|&t| t < b.squads.len() && b.squads[t].team == TEAM) {
                Some(t) => format!("fighting {}", name_of(t)),
                None => "fighting".into(),
            },
            st => state_word(st).into(),
        };
        let name = if s.kind == Kind::Captain { "CAPTAIN".to_string() } else { s.name.clone() };
        let mut o = json!({
            "id": name, "squad": j, "kind": unit_words(s.unit).0, "men": n, "x": round(x / nf), "y": round(y / nf),
            "state": state, "strength": round(s.strength(&b.tune)),
        });
        let morale = s.morale_share();
        if morale < MORALE_SHOWN {
            o["morale"] = json!(round2(morale));
        }
        foes.push(o);
    }

    // Places: the sites in id order, then the fords. Who holds a place is known once its ground has been seen.
    let mut places = Vec::new();
    for (i, site) in m.sites.iter().enumerate() {
        let holder = match (seen_tile(site.at) > 0, b.sites.get(i).and_then(|s| s.owner)) {
            (true, Some(t)) if t == TEAM => "ours",
            (true, Some(_)) => "foe",
            _ => "none",
        };
        let kind = serde_json::to_value(site.kind).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
        places.push(json!({ "name": site_name(i), "type": kind, "x": round(site.at.x), "y": round(site.at.y), "holder": holder, "site": i }));
    }
    let mut ground = Vec::new();
    if let Some(fords) = names["river"]["fords"].as_array() {
        for f in fords {
            places.push(json!({ "name": f["name"], "type": "ford", "x": round(f["at"]["x"].as_f64().unwrap_or(0.0)), "y": round(f["at"]["y"].as_f64().unwrap_or(0.0)), "holder": "none", "site": null }));
        }
    }
    for h in names["hills"].as_array().into_iter().flatten() {
        ground.push(json!({ "name": h["name"], "type": "hill", "x": round(h["at"]["x"].as_f64().unwrap_or(0.0)), "y": round(h["at"]["y"].as_f64().unwrap_or(0.0)), "r": round(h["r"].as_f64().unwrap_or(0.0)) }));
    }
    for w in names["woods"].as_array().into_iter().flatten() {
        ground.push(json!({ "name": w["name"], "type": "wood", "x0": w["x0"], "y0": w["y0"], "x1": w["x1"], "y1": w["y1"] }));
    }
    if let (Some(r), Some((x0, x1))) = (names["river"]["name"].as_str(), river_near(m, centre.y)) {
        let fords: Vec<f64> = names["river"]["fords"].as_array().into_iter().flatten().map(|f| round(f["at"]["y"].as_f64().unwrap_or(0.0))).collect();
        ground.push(json!({ "name": r, "type": "river", "x0": x0, "x1": x1, "fords": fords }));
    }

    json!({
        "facing": compass(fwd), "armyLeft": compass(left),
        "threatPoint": { "x": round2(threat.x), "y": round2(threat.y) },
        "ours": ours,
        "captain": { "x": round(lord_at.x), "y": round(lord_at.y), "hp": round2(lord_hp), "id": lord.unwrap_or(0) },
        "foesSeen": foes, "places": places, "ground": ground,
        "tick": b.tick, "size": { "w": m.w, "h": m.h }, "night": b.night,
    })
}

/// The squads a deed orders by id.
fn ids_of(d: &sim::contracts::Deed) -> Vec<u16> {
    use sim::contracts::{Deed, Who};
    let who = match d {
        Deed::With { deed, .. } | Deed::Wait { deed, .. } => return ids_of(deed),
        Deed::Move { who, .. }
        | Deed::Attack { who, .. }
        | Deed::Take { who, .. }
        | Deed::Hold { who }
        | Deed::Set { who, .. }
        | Deed::Guard { who, .. }
        | Deed::Screen { who, .. }
        | Deed::Charge { who, .. }
        | Deed::Withdraw { who, .. }
        | Deed::Regroup { who }
        | Deed::Reserve { who }
        | Deed::Commit { who, .. }
        | Deed::Face { who, .. }
        | Deed::Build { who, .. } => who,
        _ => return Vec::new(),
    };
    match who {
        Who::Squad { id } => vec![*id],
        Who::Squads { ids } => ids.clone(),
        Who::Army => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim::contracts::{Command, Deed, Who};
    use sim::map::{MapKind, MapOpts};

    #[test]
    fn the_blight_sees_through_its_own_fog() {
        let b = crate::compat::muster(4, MapOpts { kind: MapKind::Keep, width: 48 }, "default").unwrap();
        let mut w = Battle::wrap(b);
        let f: Value = serde_json::from_str(&w.broodlord_field()).unwrap();
        let ours: Vec<&str> = f["ours"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
        assert_eq!(ours, ["BLIGHT1", "BLIGHT2", "BLIGHT3", "BLIGHT4", "TROLLS1", "DRAKES1", "DRAKES2"]);
        assert_eq!(f["places"][0]["name"], "NEST");
        assert_eq!(f["places"][0]["holder"], "ours");
        let seen = f["foesSeen"].as_array().unwrap().len();
        assert!(seen < 5, "the warband stands beyond the blight's sight at the start: {seen} seen");
        // The brain's order shows on its company.
        let cmd = Command { tick: 0, team: 1, deed: Deed::Take { who: Who::Squad { id: 5 }, site: 1, via: Vec::new() }, src: Source::Brain, note: None };
        w.inner.apply(cmd);
        w.step(30);
        let f: Value = serde_json::from_str(&w.broodlord_field()).unwrap();
        assert_eq!(f["ours"][0]["orderedS"], 1.0);
        assert!(f["ours"][0]["doing"].as_str().unwrap().starts_with("taking"), "{}", f["ours"][0]);
        let r: Value = serde_json::from_str(&w.replay_json("", "none", "garrison")).unwrap();
        assert_eq!(r["log"].as_array().unwrap().len(), 1);
        println!("broodlord field keep/48 seed 4: {} companies, {seen} foes seen at the start; {}", ours.len(), f["ours"][0]["doing"]);
    }

    /// The broodlord eval's situations (tools/voice-eval, `--suite broodlord`): the blight's field at moments of real
    /// bot battles (the commander bot for the warband against the garrison or the general), with a way for each.
    /// `cargo test -p sim-wasm --lib broodlord_api::tests::situations -- --ignored` rewrites
    /// docs/voice-eval/broodlord-situations.json.
    #[test]
    #[ignore]
    fn situations() {
        let ways = ["reckless", "steady", "stubborn", "veteran"];
        // BROOD_SET=heldout: other seeds, never used to tune the prompt (docs/voice-eval/broodlord-heldout.json)
        let heldout = std::env::var("BROOD_SET").is_ok_and(|s| s == "heldout");
        let held: &[(MapKind, u32, &[u32])] = &[
            (MapKind::Keep, 7, &[10, 30, 50, 70]),
            (MapKind::Keep, 8, &[20, 45]),
            (MapKind::Town, 6, &[15, 40, 65]),
            (MapKind::Field, 6, &[8, 22, 36]),
            (MapKind::Field, 7, &[12, 30, 48]),
            (MapKind::Town, 7, &[25, 50]),
        ];
        // (map, seed, the seconds to look at)
        let tuned: &[(MapKind, u32, &[u32])] = &[
            (MapKind::Keep, 1, &[4, 30, 55, 80]),
            (MapKind::Keep, 2, &[25, 50, 75]),
            (MapKind::Keep, 3, &[40, 70]),
            (MapKind::Keep, 5, &[15, 35, 60]),
            (MapKind::Town, 1, &[20, 45, 70]),
            (MapKind::Town, 2, &[35, 60]),
            (MapKind::Field, 1, &[6, 20, 35, 50]),
            (MapKind::Field, 2, &[15, 30, 45]),
            (MapKind::Field, 3, &[25, 40]),
            (MapKind::Field, 4, &[10, 28]),
        ];
        let plan = if heldout { held } else { tuned };
        let mut out = Vec::new();
        for &(kind, seed, times) in plan {
            let b = crate::compat::muster(seed, MapOpts { kind, width: 48 }, "default").unwrap();
            let mut w = Battle::wrap(b);
            w.set_bot(0, "commander").unwrap();
            w.set_bot(1, if kind == MapKind::Field { "general1" } else { "garrison" }).unwrap();
            for &s in times {
                let to = s * TICK_HZ;
                if w.inner.tick < to {
                    w.step(to - w.inner.tick);
                }
                if w.inner.outcome().is_some() {
                    break;
                }
                let field: Value = serde_json::from_str(&w.broodlord_field()).unwrap();
                let n = out.len() + 1;
                out.push(json!({ "n": n, "map": kind, "seed": seed, "s": s, "way": ways[(n - 1) % 4], "field": field }));
            }
        }
        let doc = json!({
            "about": "The broodlord eval's situations (06-voice.md §8): the blight's field (crates/sim-wasm/src/broodlord_api.rs broodlord_field) at moments of bot battles, the commander bot for the warband against the garrison (keep, town) or general1 (field), 48 wide, with a way for each in turn. Made by `cargo test -p sim-wasm --lib broodlord_api::tests::situations -- --ignored`.",
            "situations": out,
        });
        let path = if heldout {
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/voice-eval/broodlord-heldout.json")
        } else {
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/voice-eval/broodlord-situations.json")
        };
        std::fs::write(path, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
        println!("broodlord situations: {} written to {path}", doc["situations"].as_array().unwrap().len());
    }
}
