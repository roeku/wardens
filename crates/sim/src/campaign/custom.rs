//! Custom battles from the war table (01-flow §3.3; contract §2 `Battle.custom`): `{kind, size, strength, land}`.
//!
//! - **kind:** `field` the open field against the host; `keep` and `village` (the town) against the nest under a
//!   broodlord; `ford` the ford's raiders; `night` a keep at nightfall (the day is 10 s long, then 70 s of night
//!   until dawn, the relief at 6 s); `hold` the open field with a held start (08-orders §8) until hold-the-line
//!   waves exist (out/decisions-d5-campaign.md).
//! - **size:** 4, 6 or 9 companies: ours from the list spear, shield, archer, horse, spear, shield, archer, spear,
//!   horse; the enemy's base army (the host, the nest or the waves) grows with it, `round(len·size/4)` companies.
//! - **strength:** the enemy's war chest ×0.8, ×1 or ×1.2 (each company's men), and 0, 0 or 75% of its companies
//!   veterans (+1 rank) (04-battle §7 "Difficulty"); the general plays at skill 0, 1 or 2.
//! - **land:** any name or `any`; the sim has one land (MEADOW), so it is read and kept for the view only.

use serde::Deserialize;

use super::names::{self, BROODLORDS, COMMANDERS, SALT_BROODLORD, SALT_COMMANDER};
use super::{WAYS, suits};
use crate::battle::{Company, Setup};
use crate::bots::BotKind;
use crate::map::names::onset;
use crate::map::{MapKind, MapOpts, map_size_for};
use crate::rng::{hash32, jitter};
use crate::tune::Tune;
use crate::units::Unit;

const OURS: [Unit; 9] = [Unit::Spear, Unit::Shield, Unit::Archer, Unit::Horse, Unit::Spear, Unit::Shield, Unit::Archer, Unit::Spear, Unit::Horse];
/// The night battle's day, s at width 48 (chosen): night falls almost at once.
const NIGHT_DAY_S: f64 = 10.0;
const SALT_VETERANS: u32 = 0x6361_0060;
const SALT_FACE: u32 = 0x6361_0061;

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct CustomOpts {
    pub kind: String,
    #[serde(default = "four")]
    pub size: u32,
    #[serde(default = "fair")]
    pub strength: String,
    #[serde(default = "any")]
    pub land: String,
}

fn four() -> u32 {
    4
}

fn fair() -> String {
    "fair".into()
}

fn any() -> String {
    "any".into()
}

/// A custom battle's parts: the map, the armies, the tuning and the enemy's bot.
pub struct Custom {
    pub opts: MapOpts,
    pub setup: Setup,
    pub tune: Tune,
    pub enemy: BotKind,
}

/// The war table's battle for `seed` and `json` (`CustomOpts`).
pub fn custom(seed: u32, json: &str, base: &Tune) -> Result<Custom, String> {
    let o: CustomOpts = serde_json::from_str(json).map_err(|e| format!("custom battle: {e}"))?;
    if ![4, 6, 9].contains(&o.size) {
        return Err(format!("custom battle: size {} (4, 6 or 9)", o.size));
    }
    let (chest, veterans, skill) = match o.strength.as_str() {
        "easy" => (0.8, 0.0, 0),
        "fair" => (1.0, 0.0, 1),
        "hard" => (1.2, 0.75, 2),
        s => return Err(format!("custom battle: strength {s} (easy, fair, hard)")),
    };
    let size = o.size as usize;
    let mut tune = base.clone();
    let width = map_size_for(size);
    let (kind, enemy) = match o.kind.as_str() {
        "field" | "hold" => (MapKind::Field, BotKind::General(skill)),
        "keep" | "night" => (MapKind::Keep, BotKind::Garrison),
        "village" => (MapKind::Town, BotKind::Garrison),
        "ford" => (MapKind::Ford, BotKind::Raiders),
        k => return Err(format!("custom battle: kind {k} (field, night, keep, hold, village, ford)")),
    };
    if o.kind == "night" {
        tune.outcome.battle_s = NIGHT_DAY_S;
    }
    // Ours.
    let mut taken: Vec<String> = Vec::new();
    let mut sounds: Vec<String> = Vec::new();
    let mut warband = Vec::with_capacity(size);
    for (k, &unit) in OURS.iter().take(size).enumerate() {
        let name = names::pick(COMMANDERS, seed, k as u32, SALT_COMMANDER, &taken, &sounds, &[]);
        sounds.push(onset(&name));
        taken.push(name.clone());
        let mut c = Company::of(unit, &name);
        c.way = WAYS.iter().copied().find(|&w| suits(w) == unit);
        c.face = hash32(seed, k as u32, SALT_FACE).max(1);
        warband.push(c);
    }
    // Theirs: the base army for the kind, grown with the size, the chest in every company's men.
    use Unit::*;
    let base_army: Vec<Unit> = match kind {
        MapKind::Field => vec![BlightMan, BlightMan, BlightMan, Troll, Drake],
        MapKind::Keep | MapKind::Town => vec![BlightMan, BlightMan, BlightMan, BlightMan, Troll, Drake, Drake],
        _ => Vec::new(),
    };
    let grow = |n: usize| ((n as f64 * size as f64 / 4.0).round() as usize).max(1);
    let mut garrison: Vec<Company> = (0..if base_army.is_empty() { 0 } else { grow(base_army.len()) })
        .map(|k| {
            let unit = base_army[k % base_army.len()];
            let mut c = Company::of(unit, "");
            let full = tune.unit_spec(unit).map_or(1, |s| s.men) as f64;
            c.men = Some(((full * chest).round() as u16).max(1));
            c
        })
        .collect();
    let n_vet = (garrison.len() as f64 * veterans).round() as usize;
    let mut order: Vec<usize> = (0..garrison.len()).collect();
    order.sort_by(|&a, &b| jitter(seed, a as u32, SALT_VETERANS).total_cmp(&jitter(seed, b as u32, SALT_VETERANS)).then(a.cmp(&b)));
    for &k in order.iter().take(n_vet) {
        garrison[k].rank += 1;
    }
    if kind == MapKind::Ford {
        let f = &mut tune.places.ford;
        f.waves = f.waves.iter().map(|w| (0..grow(w.len()).min(w.len() * 3)).map(|k| w[k % w.len()]).collect()).collect();
        // The chest scales the raiders' men through their units.
        for u in [BlightMan, Troll, Drake] {
            let full = tune.unit_spec(u).map_or(1, |s| s.men) as f64;
            set_men(&mut tune, u, ((full * chest).round() as u16).max(1));
        }
    }
    let general = (kind != MapKind::Ford).then(|| {
        let name = names::pick(BROODLORDS, seed, 0, SALT_BROODLORD, &[], &sounds, &taken);
        let mut g = Company::of(Broodlord, &name);
        g.rank = u8::from(veterans > 0.0);
        g.face = hash32(seed, 100, SALT_FACE).max(1);
        g
    });
    let setup = Setup { warband, garrison, general, mirror: kind == MapKind::Field, held: o.kind == "hold" };
    Ok(Custom { opts: MapOpts { kind, width }, setup, tune, enemy })
}

/// Overrides a unit's men in a battle's tuning (the ford's raiders join through the units table).
fn set_men(t: &mut Tune, u: Unit, men: u16) {
    let us = match u {
        Unit::BlightMan => &mut t.units.blightman,
        Unit::Troll => &mut t.units.troll,
        Unit::Drake => &mut t.units.drake,
        _ => return,
    };
    us.stats.insert("men".into(), serde_json::json!(men));
}
