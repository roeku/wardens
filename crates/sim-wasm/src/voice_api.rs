//! Voice: the live field the brain reads, feature names, and applying resolved deeds (day 4).
//! Its own `impl Battle` block, so each part of day 4 adds exports without touching the others' files.
//!
//! The field is what the player's side can see (docs/spec/06-voice.md §4b): our companies and captain, the foes in
//! sight now, the places and named ground of the map, the works, and the army's facing. It is the `Field` of
//! web/src/voice/field.ts as JSON, plus `pending` (the sim's waiting deeds, so the game can drop released ones from
//! its own list) and `tick`. The game adds the voice's own state (named groups, waiting orders) before the brain.

use std::cell::RefCell;

use serde_json::{Value, json};
use sim::battle::{Pending, SquadState, When};
use sim::contracts::{Command, Deed, Kind, P, Source, Team, Work};
use sim::map::BattleMap;
use sim::map::names::{Names, name_features};
use sim::units::Unit;
use wasm_bindgen::prelude::*;

use crate::Battle;

/// The voice speaks for the player's side.
const TEAM: Team = 0;
/// A company's morale is shown only below this share (the fixture's "steady" companies say nothing).
const MORALE_SHOWN: f64 = 0.95;
/// The river's columns are given over this many rows either side of the captain, so "the river" is its stretch by
/// the army, not its whole meander.
const RIVER_ROWS: i32 = 8;
/// A foe marching slower than this (tiles/s, its seen men's mean) is just "marching", with no direction.
const MARCH_SHOWN: f64 = 0.2;

/// Which map a set of names is for: its seed, width and kind.
type MapKey = (u32, u16, u16);

thread_local! {
    /// The names of the current map, made once per map (the tiles change under field works; the names must not).
    static NAMES: RefCell<Option<(MapKey, Names)>> = const { RefCell::new(None) };
}

#[wasm_bindgen]
impl Battle {
    /// The map's feature names as JSON (`sim::map::names::Names`): sites by id, the river and its fords, hills, woods.
    pub fn voice_names(&self) -> String {
        self.names(|n| serde_json::to_string(n).unwrap_or_default())
    }

    /// The player's fog-limited field as JSON (web/src/voice/field.ts `Field`, plus `pending` and `tick`).
    pub fn voice_field(&self) -> String {
        self.names(|names| field(&self.inner, names).to_string())
    }

    /// Queues a resolved batch of deeds (a JSON array of contract `Deed`s) for the player at the current tick, in
    /// order, from `src` (`voice` or `typed`), each carrying `note_json` (the voice log's heard words, reply, brain
    /// and timing; never read by the sim). Returns the tick they were queued for.
    pub fn apply_deeds(&mut self, deeds_json: &str, src: &str, note_json: &str) -> Result<u32, JsError> {
        let deeds: Vec<Deed> = serde_json::from_str(deeds_json)?;
        let src: Source = serde_json::from_value(Value::String(src.to_string()))?;
        let note: Option<Value> = if note_json.is_empty() { None } else { Some(serde_json::from_str(note_json)?) };
        let tick = self.inner.tick;
        for deed in deeds {
            self.inner.apply(Command { tick, team: TEAM, deed, src, note: note.clone() });
        }
        Ok(tick)
    }
}

impl Battle {
    fn names<T>(&self, f: impl FnOnce(&Names) -> T) -> T {
        let m = &self.inner.map;
        let key = (m.seed, m.w, m.kind as u16);
        NAMES.with(|cell| {
            let mut cell = cell.borrow_mut();
            if cell.as_ref().is_none_or(|(k, _)| *k != key) {
                let companies: Vec<&str> = self.inner.squads.iter().map(|s| s.name.as_str()).filter(|n| !n.is_empty()).collect();
                *cell = Some((key, name_features(m, &companies)));
            }
            f(&cell.as_ref().expect("named above").1)
        })
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
        return "east";
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

fn kind_word(k: Kind) -> Option<&'static str> {
    Some(match k {
        Kind::Spear => "spear",
        Kind::Shield => "shield",
        Kind::Archer => "archer",
        Kind::Horse => "horse",
        Kind::Levy => "levy",
        _ => return None,
    })
}

/// A foe's kind as the player says it (web/src/voice/field.ts `FOE_KINDS`).
fn foe_word(u: Unit) -> String {
    match u {
        Unit::BlightMan => "blight-men".into(),
        Unit::Troll => "trolls".into(),
        Unit::Drake => "drakes".into(),
        Unit::Broodlord => "broodlord".into(),
        u => format!("{}s", u.name()),
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

fn work_word(w: Work) -> &'static str {
    match w {
        Work::Stakes => "stakes",
        Work::Barricade => "barricade",
        Work::Bridge => "bridge",
        Work::Watchtower => "watchtower",
    }
}

/// A work's name: its plain word (a watchtower is the TOWER), numbered from the second of a kind.
fn work_name(w: Work, nth: usize) -> String {
    let base = match w {
        Work::Stakes => "STAKES",
        Work::Barricade => "BARRICADE",
        Work::Bridge => "BRIDGE",
        Work::Watchtower => "TOWER",
    };
    if nth == 0 { base.to_string() } else { format!("{base}{}", nth + 1) }
}

fn when_json(w: &When) -> Value {
    match w {
        When::Done => json!({ "on": "done" }),
        When::Signal { n } => json!({ "on": "signal", "n": n }),
        When::After { s } => json!({ "on": "after", "s": s }),
        When::EnemyNear { .. } => json!({ "on": "enemy_near" }),
        When::Breaks { squad } => json!({ "on": "breaks", "squad": squad }),
        When::CaptainAttacked => json!({ "on": "captain_attacked" }),
        When::Nightfall => json!({ "on": "nightfall" }),
        When::Dawn => json!({ "on": "dawn" }),
    }
}

fn pending_json(squad: i64, p: &Pending) -> Value {
    json!({ "squad": squad, "when": when_json(&p.when), "queued": p.queued, "signalled": p.signalled })
}

/// The river's westmost and eastmost water columns over the rows near `y`.
fn river_near(m: &BattleMap, y: f64) -> Option<(i32, i32)> {
    if m.river.is_empty() {
        return None;
    }
    let mid = (y.floor() as i32).clamp(0, m.h as i32 - 1);
    let rows = (mid - RIVER_ROWS).max(0)..=(mid + RIVER_ROWS).min(m.h as i32 - 1);
    let cols: Vec<i32> = rows.filter_map(|r| m.river.get(r as usize).copied()).collect();
    Some((*cols.iter().min()?, *cols.iter().max()? + 1))
}

fn field(b: &sim::battle::Battle, names: &Names) -> Value {
    let m = &b.map;
    let fog = b.fog(TEAM);
    let seen_tile = |p: P| m.idx(p.x.floor() as i32, p.y.floor() as i32).map_or(0, |i| fog[i]);

    // Our companies: on the field, not the captain.
    let mut ours = Vec::new();
    let mut line = (0.0, 0.0, 0.0);
    for (j, s) in b.squads.iter().enumerate() {
        if s.team != TEAM || !s.on_field() || s.alive == 0 {
            continue;
        }
        let Some(kind) = kind_word(s.kind) else { continue };
        let c = b.centre(j);
        let mut o = json!({
            "id": j, "name": s.name, "kind": kind, "men": s.alive, "full": s.full,
            "x": round(c.x), "y": round(c.y), "state": state_word(s.state),
        });
        if s.detached {
            o["detached"] = json!(true);
        }
        if s.reserve.is_some() {
            o["reserve"] = json!(true);
        }
        let morale = s.morale_share();
        if morale < MORALE_SHOWN {
            o["morale"] = json!(round2(morale));
        }
        if !s.detached && s.reserve.is_none() && s.state != SquadState::Routing {
            line = (line.0 + c.x, line.1 + c.y, line.2 + 1.0);
        }
        ours.push(o);
    }

    // The captain.
    let cap = b.captain_of(TEAM);
    let cap_at = b.captain_at(TEAM).unwrap_or(m.deploy[TEAM as usize]);
    let cap_hp = cap.map_or(0.0, |c| {
        let man = &b.soldiers[b.squads[c].soldiers[0]];
        if man.max_hp > 0.0 { man.hp / man.max_hp } else { 0.0 }
    });
    let centre = if line.2 > 0.0 { P::new(line.0 / line.2, line.1 / line.2) } else { cap_at };
    let threat = b.threat_point(TEAM, centre);
    let fwd = P::new(threat.x - centre.x, threat.y - centre.y);
    let left = P::new(fwd.y, -fwd.x);

    // Foes in sight now: only the men the player sees, where he sees them.
    let mut foes = Vec::new();
    for (j, s) in b.squads.iter().enumerate() {
        if s.team == TEAM || !s.on_field() {
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
            SquadState::Fighting => match s.threat.and_then(|t| b.squads.get(t as usize)).filter(|t| t.team == TEAM && !t.name.is_empty()) {
                Some(t) => format!("fighting {}", t.name),
                None => "fighting".into(),
            },
            st => state_word(st).into(),
        };
        let mut o = json!({
            "id": format!("E{j}"), "kind": foe_word(s.unit), "men": n, "x": round(x / nf), "y": round(y / nf),
            "state": state, "strength": round(s.strength(&b.tune)),
        });
        let morale = s.morale_share();
        if morale < MORALE_SHOWN {
            o["morale"] = json!(round2(morale));
        }
        foes.push(o);
    }

    // Places: the sites in id order (so a place's index is its site id), then the fords.
    let mut places = Vec::new();
    for (i, site) in m.sites.iter().enumerate() {
        // Who holds a place is known once its ground has been seen.
        let holder = match (seen_tile(site.at) > 0, b.sites.get(i).and_then(|s| s.owner)) {
            (true, Some(t)) if t == TEAM => "ours",
            (true, Some(_)) => "foe",
            _ => "none",
        };
        let kind = serde_json::to_value(site.kind).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
        places.push(json!({
            "name": names.sites.get(i).cloned().unwrap_or_default(), "type": kind,
            "x": round(site.at.x), "y": round(site.at.y), "holder": holder, "site": i,
        }));
    }
    let mut ground = Vec::new();
    if let Some(r) = &names.river {
        for f in &r.fords {
            places.push(json!({ "name": f.name, "type": "ford", "x": round(f.at.x), "y": round(f.at.y), "holder": "none", "site": null }));
        }
    }
    for h in &names.hills {
        ground.push(json!({ "name": h.name, "type": "hill", "x": round(h.at.x), "y": round(h.at.y), "r": round(h.r) }));
    }
    for w in &names.woods {
        ground.push(json!({ "name": w.name, "type": "wood", "x0": w.x0, "y0": w.y0, "x1": w.x1, "y1": w.y1 }));
    }
    if let (Some(r), Some((x0, x1))) = (&names.river, river_near(m, centre.y)) {
        // the same rows the fords' places give
        let fords: Vec<f64> = r.fords.iter().map(|f| round(f.at.y)).collect();
        ground.push(json!({ "name": r.name, "type": "river", "x0": x0, "x1": x1, "fords": fords }));
    }

    // Works: ours, and the foe's in sight.
    let mut works = Vec::new();
    let mut count = [0usize; 4];
    for w in &b.works {
        if w.razed || (w.team != TEAM && !b.sees(TEAM, w.at)) {
            continue;
        }
        let k = w.kind as usize;
        works.push(json!({
            "name": work_name(w.kind, count[k]), "work": work_word(w.kind), "x": round(w.at.x), "y": round(w.at.y),
            "holder": if w.team == TEAM { "ours" } else { "foe" },
        }));
        count[k] += 1;
    }

    // The sim's waiting deeds for our side, so the game can drop the ones that were released or cleared.
    let mut pending: Vec<Value> = b.waiting[TEAM as usize].iter().map(|p| pending_json(-1, p)).collect();
    for (j, s) in b.squads.iter().enumerate() {
        if s.team == TEAM {
            pending.extend(s.queue.iter().map(|p| pending_json(j as i64, p)));
        }
    }

    let mut out = json!({
        "facing": compass(fwd), "armyLeft": compass(left),
        "threatPoint": { "x": round2(threat.x), "y": round2(threat.y) },
        "ours": ours,
        "captain": { "x": round(cap_at.x), "y": round(cap_at.y), "hp": round2(cap_hp), "id": cap.unwrap_or(0) },
        "foesSeen": foes, "places": places, "ground": ground, "works": works,
        "pending": pending, "tick": b.tick, "size": { "w": m.w, "h": m.h },
    });
    if b.held[TEAM as usize] {
        out["held"] = json!(true);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim::map::{MapKind, MapOpts};

    #[test]
    fn the_field_is_fog_limited_and_named() {
        let b = crate::compat::muster(4, MapOpts { kind: MapKind::Keep, width: 48 }, "default").unwrap();
        let w = Battle::wrap(b);
        let f: Value = serde_json::from_str(&w.voice_field()).unwrap();
        let ours: Vec<&str> = f["ours"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
        assert_eq!(ours, ["WIL", "ODA", "REN", "BORS"]);
        assert_eq!(f["places"][0]["name"], "NEST");
        assert_eq!(f["facing"], "east");
        assert_eq!(f["armyLeft"], "north");
        let seen = f["foesSeen"].as_array().unwrap().len();
        let total = w.inner.squads.iter().filter(|s| s.team == 1).count();
        println!("voice field keep/48 seed 4: {} ours, {seen} of {total} foes seen, {} places, {} ground", ours.len(), f["places"].as_array().unwrap().len(), f["ground"].as_array().unwrap().len());
        assert!(seen < total, "the field shows only foes in sight");
    }

    #[test]
    fn deeds_are_queued_for_the_player() {
        let b = crate::compat::muster(4, MapOpts { kind: MapKind::Keep, width: 48 }, "default").unwrap();
        let mut w = Battle::wrap(b);
        let tick = w.apply_deeds(r#"[{"do":"hold","who":{"t":"army"}},{"do":"signal","n":0}]"#, "voice", r#"{"heard":"hold"}"#).unwrap();
        w.step(1);
        assert_eq!(tick, 0);
        assert_eq!(w.inner.log.len(), 2);
        assert!(w.inner.log.iter().all(|c| c.src == Source::Voice && c.team == 0 && c.note.is_some()));
        println!("voice deeds: {} queued and logged at tick {tick}", w.inner.log.len());
    }
}
