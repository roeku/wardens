//! Every balance and movement number in named tables (AGENTS.md rule 3). A JSON override replaces any part,
//! e.g. `PROTO_TUNE='{"kinds":{"spear":{"hp":11}}}'` (docs/spec/01-flow.md §8).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::contracts::Kind;

/// One kind's stats (docs/spec/04-battle.md §2). Units merge partial overrides onto these.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct KindSpec {
    pub men: u16,
    pub hp: f64,
    pub damage: f64,
    /// Seconds between blows.
    pub interval: f64,
    /// Tiles per second.
    pub speed: f64,
    pub range: f64,
    pub arrow_taken: f64,
    pub charge: f64,
    pub charge_taken: f64,
    /// Multiplies the morale lost per death: lower is braver.
    pub steadiness: f64,
    pub cost: f64,
    pub vs_horse: f64,
    /// Damage share when a ranged unit strikes in melee.
    pub melee: f64,
    /// Damage multiplier against beasts.
    pub bane: f64,
    pub pierce: f64,
    /// Files in the front rank; `None` means 3 for horse, 6 for the rest (§3a).
    pub frontage: Option<u16>,
    pub radius: f64,
    pub never_routes: bool,
}

impl KindSpec {
    #[allow(clippy::too_many_arguments)]
    fn base(
        men: u16,
        hp: f64,
        damage: f64,
        interval: f64,
        speed: f64,
        range: f64,
        arrow_taken: f64,
        charge: f64,
        charge_taken: f64,
        steadiness: f64,
        cost: f64,
    ) -> KindSpec {
        KindSpec {
            men,
            hp,
            damage,
            interval,
            speed,
            range,
            arrow_taken,
            charge,
            charge_taken,
            steadiness,
            cost,
            vs_horse: 1.0,
            melee: 1.0,
            bane: 1.0,
            pierce: 0.0,
            frontage: None,
            radius: 0.32,
            never_routes: false,
        }
    }
}

/// The base kinds table, 04-battle.md §2.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Kinds {
    pub spear: KindSpec,
    pub shield: KindSpec,
    pub archer: KindSpec,
    pub horse: KindSpec,
    pub levy: KindSpec,
    pub folk: KindSpec,
    pub captain: KindSpec,
    /// Provisional until the blight's rosters land (day 3): the wild drake's hp and bite, levy-like otherwise.
    pub beast: KindSpec,
}

impl Default for Kinds {
    fn default() -> Kinds {
        let b = KindSpec::base;
        Kinds {
            spear: KindSpec { vs_horse: 2.0, ..b(12, 10.0, 2.0, 1.0, 1.6, 0.0, 1.0, 1.0, 0.4, 1.0, 30.0) },
            shield: b(10, 14.0, 1.6, 1.0, 1.3, 0.0, 0.35, 1.0, 1.0, 0.6, 35.0),
            archer: KindSpec { melee: 0.5, ..b(10, 7.0, 1.5, 1.6, 1.6, 7.0, 1.0, 1.0, 1.2, 1.3, 35.0) },
            horse: KindSpec { frontage: Some(3), ..b(6, 14.0, 2.4, 1.1, 3.2, 0.0, 1.1, 3.0, 1.0, 1.0, 45.0) },
            levy: b(12, 9.0, 1.6, 1.1, 1.5, 0.0, 1.1, 1.0, 0.7, 1.15, 0.0),
            folk: b(7, 5.0, 0.0, 9.0, 1.0, 0.0, 1.0, 1.0, 1.5, 0.0, 0.0),
            captain: KindSpec { never_routes: true, ..b(1, 80.0, 4.0, 0.8, 3.0, 0.0, 0.6, 2.0, 1.0, 0.0, 0.0) },
            beast: b(3, 18.0, 3.4, 1.1, 1.5, 0.0, 1.1, 1.0, 0.7, 1.15, 0.0),
        }
    }
}

impl Kinds {
    pub fn get(&self, kind: Kind) -> &KindSpec {
        match kind {
            Kind::Spear => &self.spear,
            Kind::Shield => &self.shield,
            Kind::Archer => &self.archer,
            Kind::Horse => &self.horse,
            Kind::Levy => &self.levy,
            Kind::Folk => &self.folk,
            Kind::Captain => &self.captain,
            Kind::Beast => &self.beast,
        }
    }
}

/// Rank effects, rank 0–3 (04-battle.md §2).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RankTune {
    pub hp: f64,
    pub morale_base: f64,
    pub morale: f64,
    pub speed: f64,
    pub damage: f64,
    pub kills: [u32; 3],
}

impl Default for RankTune {
    fn default() -> RankTune {
        RankTune { hp: 0.12, morale_base: 100.0, morale: 10.0, speed: 0.05, damage: 0.1, kills: [6, 18, 36] }
    }
}

/// Formation slots, the squad anchor and each man's steering (04-battle.md §3a–§3c).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MoveTune {
    pub file_gap: f64,
    pub frontage: u16,
    pub frontage_horse: u16,
    pub base_radius: f64,
    pub commander_back: f64,
    pub replan_s: f64,
    pub replan_moved: f64,
    pub loose_stop: f64,
    pub loose_slow: f64,
    pub loose_pace: f64,
    pub forest_pace: f64,
    pub anchor_turn: f64,
    pub beast_turn_share: f64,
    pub arrive_at: f64,
    pub via_drop: f64,
    pub catchup_far_at: f64,
    pub catchup_far: f64,
    pub catchup_near_at: f64,
    pub catchup_near: f64,
    pub settle: f64,
    pub arrive: f64,
    pub response: f64,
    pub pace_rate: f64,
    pub edge_margin: f64,
}

impl Default for MoveTune {
    fn default() -> MoveTune {
        MoveTune {
            file_gap: 0.72,
            frontage: 6,
            frontage_horse: 3,
            base_radius: 0.32,
            commander_back: 0.8,
            replan_s: 1.0,
            replan_moved: 1.5,
            loose_stop: 3.2,
            loose_slow: 1.6,
            loose_pace: 0.35,
            forest_pace: 0.7,
            anchor_turn: 4.0,
            beast_turn_share: 0.4,
            arrive_at: 0.4,
            via_drop: 0.9,
            catchup_far_at: 1.0,
            catchup_far: 1.4,
            catchup_near_at: 0.5,
            catchup_near: 1.15,
            settle: 0.05,
            arrive: 8.0,
            response: 20.0,
            pace_rate: 4.0,
            edge_margin: 0.2,
        }
    }
}

/// Stations around the captain in line formation (04-battle.md §3d). Stations are fixed per company.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ArmyTune {
    pub gap: f64,
    pub line_ahead: f64,
    pub line_per_row: usize,
    pub row_gap: f64,
    pub bows_behind: f64,
    pub bows_per_row: usize,
    pub horse_ahead: f64,
    pub horse_side: f64,
    pub horse_step: f64,
}

impl Default for ArmyTune {
    fn default() -> ArmyTune {
        ArmyTune {
            gap: 4.4,
            line_ahead: 3.0,
            line_per_row: 5,
            row_gap: 3.2,
            bows_behind: 3.5,
            bows_per_row: 4,
            horse_ahead: 1.0,
            horse_side: 5.0,
            horse_step: 3.5,
        }
    }
}

/// Engagement distances (04-battle.md §5). Until combat lands on day 3, an attack order closes to `melee`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CombatTune {
    pub melee: f64,
    pub commander_hp: f64,
}

impl Default for CombatTune {
    fn default() -> CombatTune {
        CombatTune { melee: 2.6, commander_hp: 3.0 }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Tune {
    pub kinds: Kinds,
    pub rank: RankTune,
    pub movement: MoveTune,
    pub army: ArmyTune,
    pub combat: CombatTune,
}

impl Tune {
    /// The defaults with a JSON override deep-merged on top.
    pub fn with_override(over: &Value) -> Result<Tune, String> {
        let mut v = serde_json::to_value(Tune::default()).map_err(|e| e.to_string())?;
        merge(&mut v, over.clone());
        serde_json::from_value(v).map_err(|e| format!("tune override: {e}"))
    }
}

fn merge(base: &mut Value, over: Value) {
    match (base, over) {
        (Value::Object(base), Value::Object(over)) => {
            for (k, v) in over {
                merge(base.entry(k).or_insert(Value::Null), v);
            }
        }
        (base, over) => *base = over,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_replaces_only_what_it_names() {
        let t = Tune::with_override(&serde_json::json!({"kinds": {"spear": {"hp": 11.0}}})).unwrap();
        assert_eq!(t.kinds.spear.hp, 11.0);
        assert_eq!(t.kinds.spear.men, 12);
        assert_eq!(t.kinds.shield, Tune::default().kinds.shield);
        assert!(Tune::with_override(&serde_json::json!({"kinds": {"spear": {"hp": "x"}}})).is_err());
        println!("tune override: 4 checks");
    }
}
