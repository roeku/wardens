//! Every balance and movement number in named tables (AGENTS.md rule 3). A JSON override replaces any part,
//! e.g. `PROTO_TUNE='{"kinds":{"spear":{"hp":11}}}'` (docs/spec/01-flow.md §8).
//!
//! The numbers are the spec's (docs/spec/04-battle.md §2–§8, 03-land.md §1 and §8). Where the spec is silent the
//! choice is recorded in out/decisions-battle.md and the field's comment says "chosen".

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::contracts::Kind;
use crate::units::Unit;

/// One kind's stats (docs/spec/04-battle.md §2). Units merge partial overrides onto these (`Units`). Every rule a
/// unit brings is one of these stats ("never an `if (unit.id === …)`"); an unknown name in an override is an error.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
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
    /// A beast: bane applies against it, horse will not charge it, it cleaves and tramples (§5 "Beasts").
    pub beast: bool,
    /// A man's heading may change at most this fast, rad/s, at constant speed (0: no limit). Elephant 1.1.
    pub turn: f64,
    /// Drake breath (§5 "Drake breath"): the harm of one jet, shared over its pulses, ignoring armour. A breather
    /// hunts (rear, jet, bite, spring back) instead of standing to strike; 0: no breath.
    #[serde(default)]
    pub breath: f64,
    /// A pack (§3a): files ×1.15, the rank's ends pushed back, seeded jitter. Packs take the wings.
    #[serde(default)]
    pub pack: bool,
    /// Myth rule `impact` (§5): a blow lands this many seconds after it starts (0: at once).
    #[serde(default)]
    pub impact: f64,
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
            beast: false,
            turn: 0.0,
            breath: 0.0,
            pack: false,
            impact: 0.0,
        }
    }

    pub fn ranged(&self) -> bool {
        self.range > 0.0
    }

    /// `worth = hp/(0.6+0.4·arrowTaken) × dmg/int × (1 + 0.05(charge−1) + 0.04·range + 0.3 if beast)` at `rank`
    /// (§2 "Worth"): AI pricing and the time-out score.
    pub fn worth(&self, rank: &RankTune, r: u8) -> f64 {
        let hp = self.hp * (1.0 + rank.hp * r as f64);
        let dmg = self.damage * (1.0 + rank.damage * r as f64);
        let extra = 1.0 + 0.05 * (self.charge - 1.0) + 0.04 * self.range + if self.beast { 0.3 } else { 0.0 };
        hp / (0.6 + 0.4 * self.arrow_taken) * dmg / self.interval.max(1e-6) * extra
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
    /// The base the blight's beasts merge onto (§5 "Beasts": bane applies, horse terror, cleave, trample, turning at
    /// most 1.1 rad/s): the wild drake's hp and bite, levy-like otherwise. The units table makes trolls and drakes.
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
            beast: KindSpec { beast: true, turn: 1.1, ..b(3, 18.0, 3.4, 1.1, 1.5, 0.0, 1.1, 1.0, 0.7, 1.15, 0.0) },
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

/// One unit: its base kind and the stats it overrides (04-battle.md §2 "Unit overrides"), merged as
/// `spec = {...KINDS[kind], ...stats}`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct UnitSpec {
    pub kind: Kind,
    #[serde(default)]
    pub stats: Map<String, Value>,
}

fn unit(kind: Kind, stats: Value) -> UnitSpec {
    UnitSpec { kind, stats: stats.as_object().cloned().unwrap_or_default() }
}

/// The units table. The warband's units are their kinds; the blight's stats are the spec's where it gives them
/// (the wild drake: hp 18, bite 3.4, breath 6, pack, 3–4 per company) and chosen where it is silent (trolls, the
/// drake's pace and size, the broodlord), recorded in out/decisions-blight-sim.md.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Units {
    pub spear: UnitSpec,
    pub shield: UnitSpec,
    pub archer: UnitSpec,
    pub horse: UnitSpec,
    pub levy: UnitSpec,
    pub folk: UnitSpec,
    pub captain: UnitSpec,
    /// The blight's swarm: levy stats (00-start-here.md §A4).
    pub blightman: UnitSpec,
    /// A great beast with heavy, slow blows that land after `impact`, cleaving (chosen; the spec names trolls and
    /// their impact blows only).
    pub troll: UnitSpec,
    /// The wild drake (04-battle.md §2 "Norse drakes"): hp 18, bite 3.4, breath 6, a pack of 3.
    pub drake: UnitSpec,
    /// The blight's commander in the general's place: a great beast that never routes (chosen).
    pub broodlord: UnitSpec,
}

impl Default for Units {
    fn default() -> Units {
        Units {
            spear: unit(Kind::Spear, json!({})),
            shield: unit(Kind::Shield, json!({})),
            archer: unit(Kind::Archer, json!({})),
            horse: unit(Kind::Horse, json!({})),
            levy: unit(Kind::Levy, json!({})),
            folk: unit(Kind::Folk, json!({})),
            captain: unit(Kind::Captain, json!({})),
            blightman: unit(Kind::Levy, json!({})),
            troll: unit(
                Kind::Beast,
                json!({
                    "men": 3, "hp": 30.0, "damage": 4.5, "interval": 2.2, "speed": 1.3, "arrow_taken": 0.7,
                    "charge": 1.0, "charge_taken": 1.0, "steadiness": 0.6, "cost": 90.0, "radius": 0.7, "frontage": 3,
                    "turn": 1.1, "impact": 0.5
                }),
            ),
            drake: unit(
                Kind::Beast,
                json!({
                    "men": 3, "hp": 18.0, "damage": 3.4, "interval": 3.2, "speed": 2.2, "arrow_taken": 1.0,
                    "steadiness": 0.8, "cost": 90.0, "radius": 0.55, "turn": 2.5, "breath": 6.0, "pack": true
                }),
            ),
            broodlord: unit(
                Kind::Captain,
                json!({
                    "hp": 150.0, "damage": 5.0, "interval": 1.2, "speed": 2.4, "arrow_taken": 0.6, "charge": 1.5,
                    "radius": 0.8, "beast": true, "turn": 1.6, "impact": 0.35
                }),
            ),
        }
    }
}

impl Units {
    pub fn get(&self, u: Unit) -> &UnitSpec {
        match u {
            Unit::Spear => &self.spear,
            Unit::Shield => &self.shield,
            Unit::Archer => &self.archer,
            Unit::Horse => &self.horse,
            Unit::Levy => &self.levy,
            Unit::Folk => &self.folk,
            Unit::Captain => &self.captain,
            Unit::BlightMan => &self.blightman,
            Unit::Troll => &self.troll,
            Unit::Drake => &self.drake,
            Unit::Broodlord => &self.broodlord,
        }
    }
}

/// Drake breath and the hunt (04-battle.md §5 "Drake breath"), seconds from the start of a cycle.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BreathTune {
    /// It rears until the jet starts.
    pub rear: f64,
    pub jet: f64,
    /// The flame's tail after the jet (no harm; the view draws it).
    pub tail: f64,
    pub bite: f64,
    pub period: f64,
    /// The cone: reach and half-angle, sweeping ±`sweep` across the jet, rooted `root` tiles ahead.
    pub reach: f64,
    pub half_angle: f64,
    pub sweep: f64,
    pub root: f64,
    /// A pulse every `pulse` seconds of the jet; each deals `breath/pulses`.
    pub pulse: f64,
    /// Each company caught loses `morale·steadiness` per pulse.
    pub morale: f64,
    /// The hunt: rear when the prey is within `hunt_r`; lunge at `lunge`× pace `lunge_before` s before the bite;
    /// spring back to `spring`, still facing the prey.
    pub hunt_r: f64,
    pub lunge: f64,
    pub lunge_before: f64,
    pub spring: f64,
    /// A spot's density counts foes within this of a candidate prey; a spot within it of a pack-mate's prey is
    /// taken (chosen).
    pub spot_r: f64,
    /// Meeting a drake: men step at most this far from their slots, and the block presses forward.
    pub meet_step: f64,
}

impl Default for BreathTune {
    fn default() -> BreathTune {
        BreathTune {
            rear: 0.4,
            jet: 1.2,
            tail: 0.55,
            bite: 2.3,
            period: 3.2,
            reach: 2.3,
            half_angle: 0.3,
            sweep: 0.3,
            root: 1.0,
            pulse: 0.25,
            morale: 1.6,
            hunt_r: 2.4,
            lunge: 1.6,
            lunge_before: 0.45,
            spring: 2.1,
            spot_r: 1.5,
            meet_step: 1.0,
        }
    }
}

impl BreathTune {
    /// Pulses in one jet: one at its start and every `pulse` seconds while it runs.
    pub fn pulses(&self) -> u32 {
        ((self.jet / self.pulse.max(1e-6)).ceil() as u32).max(1)
    }
}

/// A pack's formation (04-battle.md §3a "Variations").
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PackTune {
    pub files: f64,
    pub ends_back: f64,
    pub jitter: f64,
}

impl Default for PackTune {
    fn default() -> PackTune {
        PackTune { files: 1.15, ends_back: 0.5, jitter: 0.125 }
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

/// Formation slots, the squad anchor and each man's steering (04-battle.md §3a–§3c; 03-land.md §1).
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
    /// Climbing pace: `1 − slope_pace·slope`, never below `slope_min` (03-land.md §1). No downhill bonus.
    pub slope_pace: f64,
    pub slope_min: f64,
    /// The slope is measured this far ahead along the step (chosen).
    pub slope_probe: f64,
    pub anchor_turn: f64,
    pub beast_turn_share: f64,
    pub arrive_at: f64,
    pub via_drop: f64,
    pub catchup_far_at: f64,
    pub catchup_far: f64,
    pub catchup_near_at: f64,
    pub catchup_near: f64,
    pub settle: f64,
    /// The `0.025` in `(d − 0.025)·ARRIVE`.
    pub settle_ease: f64,
    pub arrive: f64,
    pub response: f64,
    pub separation: f64,
    pub sep_friend: f64,
    pub sep_foe: f64,
    pub mass_min: f64,
    pub mass_max: f64,
    pub pace_rate: f64,
    pub edge_margin: f64,
    /// A man's personal A* route: replanned every `route_s`, or when his goal moves more than `route_moved`.
    pub route_s: f64,
    pub route_moved: f64,
    /// Shapes beyond the block (08-orders.md §3 "form", chosen): spacing for `loose` and `tight`.
    pub loose_spacing: f64,
    pub tight_spacing: f64,
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
            slope_pace: 0.4,
            slope_min: 0.6,
            slope_probe: 0.5,
            anchor_turn: 4.0,
            beast_turn_share: 0.4,
            arrive_at: 0.4,
            via_drop: 0.9,
            catchup_far_at: 1.0,
            catchup_far: 1.4,
            catchup_near_at: 0.5,
            catchup_near: 1.15,
            settle: 0.05,
            settle_ease: 0.025,
            arrive: 8.0,
            response: 20.0,
            separation: 6.0,
            sep_friend: 0.5,
            sep_foe: 0.8,
            mass_min: 0.15,
            mass_max: 3.0,
            pace_rate: 4.0,
            edge_margin: 0.2,
            route_s: 1.0,
            route_moved: 2.0,
            loose_spacing: 1.6,
            tight_spacing: 0.85,
        }
    }
}

/// The army following the captain (04-battle.md §3d): stations, column and line, the followers' pace.
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
    pub reserve_behind: f64,
    pub reserve_side: f64,
    pub column_abreast: f64,
    pub column_ahead: f64,
    pub column_pair_gap: f64,
    pub column_rest_behind: f64,
    pub column_rest_gap: f64,
    pub reaim_moved: f64,
    /// In line, a re-aim more than this far off (radians, 120°) is skipped: a line falls back still facing.
    pub reaim_max: f64,
    pub heading_ease: f64,
    pub line_enemy: f64,
    pub line_halt_s: f64,
    pub column_after_s: f64,
    pub follower_turn: f64,
    pub follow_base: f64,
    pub follow_k: f64,
    pub follow_far: f64,
    pub follow_far_pace: f64,
    pub column_pace: f64,
    pub follow_loose: f64,
    pub follow_loose_pace: f64,
    pub march_above: f64,
    pub idle_below: f64,
    pub captain_pace: f64,
    pub error_far: f64,
    pub error_far_pace: f64,
    pub error_near: f64,
    pub error_near_pace: f64,
    pub defend_within: f64,
    pub defend_enemy: f64,
    /// Escort (08-orders.md §3 "follow / escort", chosen): stand this far behind the ward, and defend it from
    /// anything within `guard_r` of it.
    pub guard_behind: f64,
    pub guard_r: f64,
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
            reserve_behind: 0.4,
            reserve_side: 3.4,
            column_abreast: 2.3,
            column_ahead: 3.0,
            column_pair_gap: 3.3,
            column_rest_behind: 3.0,
            column_rest_gap: 3.0,
            reaim_moved: 2.5,
            reaim_max: 120f64.to_radians(),
            heading_ease: 0.9,
            line_enemy: 9.0,
            line_halt_s: 2.0,
            column_after_s: 1.5,
            follower_turn: 2.0,
            follow_base: 0.4,
            follow_k: 0.9,
            follow_far: 3.0,
            follow_far_pace: 1.25,
            column_pace: 1.3,
            follow_loose: 3.0,
            follow_loose_pace: 0.5,
            march_above: 1.0,
            idle_below: 0.3,
            captain_pace: 0.9,
            error_far: 5.0,
            error_far_pace: 0.6,
            error_near: 3.0,
            error_near_pace: 0.8,
            defend_within: 7.0,
            defend_enemy: 3.0,
            guard_behind: 3.0,
            guard_r: 5.0,
        }
    }
}

/// The drawn front and the line to a point (04-battle.md §4).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct FrontTune {
    pub tap: f64,
    pub tangent: f64,
    pub threat_r: f64,
    pub bows_back: f64,
    pub bows_gap: f64,
    pub reserve_back: f64,
    pub horse_beyond: f64,
    pub horse_step: f64,
    pub beast_beyond: f64,
    pub horse_back: f64,
    pub captain_back: f64,
    pub captain_back_no_bows: f64,
    pub min_files: u16,
    pub line_gap: f64,
    /// A spot on rock or water moves to the nearest open tile within this (chosen).
    pub snap_r: i32,
}

impl Default for FrontTune {
    fn default() -> FrontTune {
        FrontTune {
            tap: 1.5,
            tangent: 1.0,
            threat_r: 24.0,
            bows_back: 3.2,
            bows_gap: 4.6,
            reserve_back: 2.6,
            horse_beyond: 2.8,
            horse_step: 3.0,
            beast_beyond: 2.0,
            horse_back: 1.2,
            captain_back: 5.0,
            captain_back_no_bows: 2.8,
            min_files: 3,
            line_gap: 4.4,
            snap_r: 4,
        }
    }
}

/// Engagement, target choice, blows and arrows (04-battle.md §5).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CombatTune {
    pub melee: f64,
    pub reckless_engage: f64,
    pub walk_line_beyond: f64,
    pub seek_min: f64,
    pub seek_extra: f64,
    pub keep_target: f64,
    pub routing_penalty: f64,
    pub target_jitter: f64,
    pub reach: f64,
    pub stand: f64,
    pub charge_regain_s: f64,
    pub charge_pace: f64,
    pub veteran_damage: f64,
    pub reckless_charge: f64,
    pub veteran_charge_taken: f64,
    pub height_k: f64,
    pub height_cap: f64,
    pub routing_victim: f64,
    pub charge_morale: f64,
    pub cooldown_base: f64,
    pub cooldown_jitter: f64,
    pub arrow_flight_k: f64,
    pub arrow_flight_min: f64,
    pub range_per_height: f64,
    pub range_height_cap: f64,
    pub commander_hp: f64,
    pub face_rate: f64,
    pub drift_rate: f64,
    /// A Charge (or Volley) event per company at most this often, seconds (chosen).
    pub event_gap_s: f64,
    /// An `impact` blow lands only if its victim is still within reach plus this when it lands (chosen).
    pub impact_slack: f64,
}

impl Default for CombatTune {
    fn default() -> CombatTune {
        CombatTune {
            melee: 2.6,
            reckless_engage: 1.5,
            walk_line_beyond: 1.0,
            seek_min: 3.2,
            seek_extra: 0.6,
            keep_target: 1.3,
            routing_penalty: 0.6,
            target_jitter: 0.3,
            reach: 0.99,
            stand: 0.92,
            charge_regain_s: 3.0,
            charge_pace: 0.6,
            veteran_damage: 1.12,
            reckless_charge: 1.3,
            veteran_charge_taken: 0.7,
            height_k: 0.25,
            height_cap: 0.35,
            routing_victim: 1.6,
            charge_morale: 3.0,
            cooldown_base: 0.85,
            cooldown_jitter: 0.3,
            arrow_flight_k: 0.06,
            arrow_flight_min: 0.2,
            range_per_height: 1.2,
            range_height_cap: 2.0,
            commander_hp: 3.0,
            face_rate: 2.5,
            drift_rate: 2.0,
            event_gap_s: 3.0,
            impact_slack: 0.5,
        }
    }
}

/// Beasts (04-battle.md §5 "Beasts"): minimal until the blight's rosters land.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BeastTune {
    pub cleave_n: usize,
    pub cleave_r: f64,
    pub cleave_share: f64,
    pub terror_r: f64,
    pub terror_rate: f64,
    pub trample_s: f64,
    pub trample_dmg: f64,
}

impl Default for BeastTune {
    fn default() -> BeastTune {
        BeastTune { cleave_n: 3, cleave_r: 1.5, cleave_share: 0.6, terror_r: 6.0, terror_rate: 11.0, trample_s: 0.3, trample_dmg: 1.8 }
    }
}

/// Morale, routing, rallying and the commanders' rules (04-battle.md §5 "Morale", "Routing", "Commanders").
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct MoraleTune {
    pub death_k: f64,
    pub ranged_share: f64,
    pub flank_angle: f64,
    pub flank_rate: f64,
    pub outnumber_ratio: f64,
    pub outnumber_min: u32,
    pub outnumber_rate: f64,
    pub recover: f64,
    pub aura_recover: f64,
    pub aura_r: f64,
    pub aura_shield: f64,
    pub rout_below: f64,
    pub rout_speed: f64,
    pub scatter: f64,
    pub rally_quiet_s: f64,
    pub rally_clear_r: f64,
    pub rally_morale: f64,
    pub last_stand: f64,
    /// A routing company is home within this of its retreat point, or of its own map edge (chosen).
    pub home_r: f64,
    pub captain_regen: f64,
    pub captain_regen_after_s: f64,
    pub commander_fell_cap: f64,
    pub foe_commander_fell: f64,
    pub save_share: f64,
    pub foe_save_share: f64,
    pub save_min: u16,
    pub foe_save_loss: f64,
    pub recall_s: f64,
    pub recall_pace: f64,
    pub recall_done: f64,
}

impl Default for MoraleTune {
    fn default() -> MoraleTune {
        MoraleTune {
            death_k: 1.6,
            ranged_share: 0.6,
            flank_angle: 110f64.to_radians(),
            flank_rate: 7.0,
            outnumber_ratio: 2.0,
            outnumber_min: 4,
            outnumber_rate: 4.0,
            recover: 5.0,
            aura_recover: 3.0,
            aura_r: 5.5,
            aura_shield: 0.5,
            rout_below: 22.0,
            rout_speed: 1.25,
            scatter: 1.0,
            rally_quiet_s: 5.0,
            rally_clear_r: 5.0,
            rally_morale: 45.0,
            last_stand: 30.0,
            home_r: 1.5,
            captain_regen: 1.2,
            captain_regen_after_s: 4.0,
            commander_fell_cap: 21.0,
            foe_commander_fell: 25.0,
            save_share: 0.3,
            foe_save_share: 0.5,
            save_min: 2,
            foe_save_loss: 12.0,
            recall_s: 10.0,
            recall_pace: 1.15,
            recall_done: 2.0,
        }
    }
}

/// Commander ways (04-battle.md §6).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct WaysTune {
    pub stubborn_morale: f64,
    pub stubborn_speed: f64,
    pub reckless_morale: f64,
    pub steady_r: f64,
    pub steady_shield: f64,
    pub steady_regen: f64,
}

impl Default for WaysTune {
    fn default() -> WaysTune {
        WaysTune { stubborn_morale: 0.72, stubborn_speed: 0.92, reckless_morale: 1.2, steady_r: 5.0, steady_shield: 0.88, steady_regen: 0.6 }
    }
}

/// The captain's ride (04-battle.md §5).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RideTune {
    pub trail: f64,
    pub pick_r: f64,
    pub morale_weight: f64,
    pub crowd_n: usize,
    pub crowd_r: f64,
    pub repick_s: f64,
    pub flank_clear: f64,
    pub leave_hp: f64,
    pub burst: f64,
    pub burst_s: f64,
    pub back: f64,
    pub return_hp: f64,
    /// Close enough to the flank point to go in (chosen).
    pub flank_reached: f64,
    /// Riding out of the fight he keeps this far from the map's sides (chosen: withdrawal is within 1.6).
    pub edge_keep: f64,
    /// Trailing the line he sets off again once it is this far ahead (chosen; followers use 1).
    pub trail_slack: f64,
}

impl Default for RideTune {
    fn default() -> RideTune {
        RideTune {
            trail: 3.5,
            pick_r: 12.0,
            morale_weight: 8.0,
            crowd_n: 3,
            crowd_r: 3.5,
            repick_s: 5.0,
            flank_clear: 1.4,
            leave_hp: 0.5,
            burst: 0.2,
            burst_s: 2.0,
            back: 5.0,
            return_hp: 0.8,
            flank_reached: 1.5,
            edge_keep: 4.0,
            trail_slack: 2.0,
        }
    }
}

/// Sight and the fog of war (03-land.md §8; heights §1).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SightTune {
    pub every: u32,
    pub base: f64,
    pub hill_k: f64,
    pub hill_cap: f64,
    pub night: f64,
    pub spread_cap: f64,
    pub tower: f64,
    pub site: f64,
}

impl Default for SightTune {
    fn default() -> SightTune {
        SightTune { every: 8, base: 6.5, hill_k: 1.5, hill_cap: 3.0, night: 0.6, spread_cap: 3.0, tower: 9.0, site: 4.0 }
    }
}

/// Battle types and outcomes (04-battle.md §8).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct OutcomeTune {
    pub withdraw_r: f64,
    pub withdraw_after_s: f64,
    pub capture_r: f64,
    pub capture_s: f64,
    pub keep_k: f64,
    pub town_k: f64,
    pub weight_k: f64,
    pub captain_weight: f64,
    pub field_s: f64,
    pub battle_s: f64,
    pub night_s: f64,
    pub width_base: f64,
}

impl Default for OutcomeTune {
    fn default() -> OutcomeTune {
        OutcomeTune {
            withdraw_r: 1.6,
            withdraw_after_s: 8.0,
            capture_r: 1.8,
            capture_s: 6.0,
            keep_k: 2.0,
            town_k: 1.5,
            weight_k: 0.25,
            captain_weight: 3.0,
            field_s: 360.0,
            battle_s: 300.0,
            night_s: 70.0,
            width_base: 48.0,
        }
    }
}

/// Stances (08-orders.md §5; chosen): how far each reaches, read in one place, `Battle::rules`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct StanceTune {
    /// Aggressive: the squad engages this much further and its men seek this much further.
    pub aggressive_extra: f64,
    /// Defensive: never leave the post by more than this.
    pub leash: f64,
    /// Skirmish: ranged men fall back from melee foes within this.
    pub skirmish_r: f64,
    /// A priority's favoured foes count as this much nearer, tiles.
    pub priority_bonus: f64,
}

impl Default for StanceTune {
    fn default() -> StanceTune {
        StanceTune { aggressive_extra: 2.0, leash: 3.0, skirmish_r: 3.5, priority_bonus: 12.0 }
    }
}

/// The garrison policy (04-battle.md §7 "Garrison").
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct GarrisonTune {
    pub think_s: f64,
    pub guard_r: f64,
    pub shaken: f64,
    pub threat_r: f64,
    pub respond_r: f64,
    pub foe_near_threat: f64,
    pub archers_behind: f64,
    pub sally_after_s: f64,
    pub sally_cooldown_s: f64,
    pub sally_share: f64,
    pub sally_min: usize,
    pub sally_morale: f64,
    pub sally_odds: f64,
    pub sighting_s: f64,
    /// Enemy men count as near a sally's target within this (chosen).
    pub sighting_r: f64,
    pub sally_losses: f64,
    pub sally_max_s: f64,
    pub retake_r: f64,
    pub retake_clear: f64,
}

impl Default for GarrisonTune {
    fn default() -> GarrisonTune {
        GarrisonTune {
            think_s: 1.5,
            guard_r: 5.0,
            shaken: 0.4,
            threat_r: 9.0,
            respond_r: 16.0,
            foe_near_threat: 8.0,
            archers_behind: 4.0,
            sally_after_s: 12.0,
            sally_cooldown_s: 20.0,
            sally_share: 0.6,
            sally_min: 2,
            sally_morale: 0.6,
            sally_odds: 1.4,
            sighting_s: 25.0,
            sighting_r: 8.0,
            sally_losses: 0.5,
            sally_max_s: 75.0,
            retake_r: 12.0,
            retake_clear: 6.0,
        }
    }
}

/// The general policy (04-battle.md §7 "General").
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct GeneralTune {
    pub think_s: [f64; 3],
    pub reserve_companies: usize,
    pub reserve_line: usize,
    pub rest_below: f64,
    pub rest_back: f64,
    pub rest_until: f64,
    pub horse_r: f64,
    /// Horse go round the flank through a point this far to the side of the target (chosen).
    pub horse_wide: f64,
    pub front_every_s: f64,
    pub front_step: f64,
    pub front_short: f64,
    pub contact_r: f64,
    pub bow_hold_extra: f64,
    pub bow_back: f64,
    pub attack_r: f64,
    pub reserve_commit: f64,
    pub reserve_enemy_r: f64,
    pub waver: f64,
    pub waver_back: f64,
    pub captain_out: f64,
    pub captain_back: f64,
    /// A captain kept out of the fight stays this far from the map's sides (chosen: withdrawal is 1.6).
    pub edge_keep: f64,
    /// Foes it saw are remembered this long, s (chosen: the garrison's 25 s).
    pub memory_s: f64,
}

impl Default for GeneralTune {
    fn default() -> GeneralTune {
        GeneralTune {
            think_s: [2.4, 1.5, 1.0],
            reserve_companies: 5,
            reserve_line: 3,
            rest_below: 0.45,
            rest_back: 6.0,
            rest_until: 0.8,
            horse_r: 28.0,
            horse_wide: 6.0,
            front_every_s: 6.0,
            front_step: 8.0,
            front_short: 8.0,
            contact_r: 10.0,
            bow_hold_extra: 1.0,
            bow_back: 3.0,
            attack_r: 12.0,
            reserve_commit: 0.6,
            reserve_enemy_r: 8.0,
            waver: 0.4,
            waver_back: 6.0,
            captain_out: 0.6,
            captain_back: 6.0,
            edge_keep: 4.0,
            memory_s: 25.0,
        }
    }
}

/// How beasts choose their quarry (04-battle.md §7 "Contact"), for the general and the garrison alike.
/// Breathers score `d·0.5 − men`, horse +8, bane +12, braced +3, already fighting −4 (lower is better); elephants,
/// and so trolls, go at the nearest foot within 24.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct QuarryTune {
    pub dist: f64,
    pub men: f64,
    pub horse: f64,
    pub bane: f64,
    pub braced: f64,
    pub fighting: f64,
    /// Breathers look this far for quarry (chosen: the elephants' 24).
    pub breather_r: f64,
    pub foot_r: f64,
}

impl Default for QuarryTune {
    fn default() -> QuarryTune {
        QuarryTune { dist: 0.5, men: 1.0, horse: 8.0, bane: 12.0, braced: 3.0, fighting: -4.0, breather_r: 24.0, foot_r: 24.0 }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BotTune {
    pub garrison: GarrisonTune,
    pub general: GeneralTune,
    pub quarry: QuarryTune,
    /// The mindless charge and the sensible commander think this often (chosen).
    pub charge_think_s: f64,
}

impl Default for BotTune {
    fn default() -> BotTune {
        BotTune { garrison: GarrisonTune::default(), general: GeneralTune::default(), quarry: QuarryTune::default(), charge_think_s: 1.0 }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Tune {
    pub kinds: Kinds,
    pub units: Units,
    pub rank: RankTune,
    pub movement: MoveTune,
    pub army: ArmyTune,
    pub front: FrontTune,
    pub combat: CombatTune,
    pub beast: BeastTune,
    pub breath: BreathTune,
    pub pack: PackTune,
    pub morale: MoraleTune,
    pub ways: WaysTune,
    pub ride: RideTune,
    pub sight: SightTune,
    pub outcome: OutcomeTune,
    pub stance: StanceTune,
    pub bots: BotTune,
}

impl Tune {
    /// The defaults with a JSON override deep-merged on top. Every unit must still make a valid spec.
    pub fn with_override(over: &Value) -> Result<Tune, String> {
        let mut v = serde_json::to_value(Tune::default()).map_err(|e| e.to_string())?;
        merge(&mut v, over.clone());
        let t: Tune = serde_json::from_value(v).map_err(|e| format!("tune override: {e}"))?;
        for u in Unit::ALL {
            t.unit_spec(u)?;
        }
        Ok(t)
    }

    /// A unit's merged stats: its kind's, with the unit's overrides on top (04-battle.md §2).
    pub fn unit_spec(&self, u: Unit) -> Result<KindSpec, String> {
        let us = self.units.get(u);
        let mut v = serde_json::to_value(self.kinds.get(us.kind)).map_err(|e| e.to_string())?;
        merge(&mut v, Value::Object(us.stats.clone()));
        serde_json::from_value(v).map_err(|e| format!("unit {}: {e}", u.name()))
    }

    /// A unit's base kind.
    pub fn unit_kind(&self, u: Unit) -> Kind {
        self.units.get(u).kind
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
        let t = Tune::with_override(&serde_json::json!({"movement": {"arrive": 4.0}, "bots": {"general": {"front_step": 6.0}}})).unwrap();
        assert_eq!((t.movement.arrive, t.bots.general.front_step, t.movement.response), (4.0, 6.0, 20.0));
        println!("tune override: 7 checks");
    }

    #[test]
    fn worth_follows_the_formula() {
        let t = Tune::default();
        let spear = t.kinds.spear.worth(&t.rank, 0);
        assert!((spear - 20.0).abs() < 1e-9, "spear worth {spear}");
        let archer = t.kinds.archer.worth(&t.rank, 0);
        assert!((archer - 7.0 * 1.5 / 1.6 * 1.28).abs() < 1e-9);
        println!("worth: spear {spear:.2}, archer {archer:.2}, captain {:.1}", t.kinds.captain.worth(&t.rank, 0));
    }

    #[test]
    fn units_merge_their_overrides_onto_their_kind() {
        let t = Tune::default();
        // A unit without overrides is its kind exactly.
        assert_eq!(t.unit_spec(Unit::Spear).unwrap(), t.kinds.spear);
        assert_eq!(t.unit_spec(Unit::BlightMan).unwrap(), t.kinds.levy, "blight-men have levy stats");
        let drake = t.unit_spec(Unit::Drake).unwrap();
        assert_eq!((drake.hp, drake.damage, drake.breath, drake.pack, drake.beast), (18.0, 3.4, 6.0, true, true), "the wild drake");
        assert!((3..=4).contains(&drake.men));
        let troll = t.unit_spec(Unit::Troll).unwrap();
        assert!(troll.impact > 0.0 && troll.beast);
        let lord = t.unit_spec(Unit::Broodlord).unwrap();
        assert!(lord.never_routes && lord.beast && t.unit_kind(Unit::Broodlord) == Kind::Captain);
        // The JSON override reaches a unit's stats and its kind, and a misspelt stat is refused.
        let o = Tune::with_override(&serde_json::json!({"units": {"troll": {"stats": {"hp": 44.0}}}})).unwrap();
        assert_eq!((o.unit_spec(Unit::Troll).unwrap().hp, o.unit_spec(Unit::Troll).unwrap().damage), (44.0, troll.damage));
        assert!(Tune::with_override(&serde_json::json!({"units": {"troll": {"stats": {"hpp": 44.0}}}})).is_err());
        let worth: Vec<String> = Unit::ALL.iter().map(|&u| format!("{} {:.1}", u.name(), t.unit_spec(u).unwrap().worth(&t.rank, 0))).collect();
        println!("units: {} merge onto their kinds; worth per man: {}", Unit::ALL.len(), worth.join(", "));
    }
}
