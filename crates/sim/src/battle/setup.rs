//! Who stands where when a battle opens. Until the muster and the campaign's garrisons land (day 5), a battle
//! opens with the voice fixture's warband against the blight (docs/spec/00-start-here.md §A2, §A4): blight-men, a
//! troll company and a drake pack under a broodlord, the blight's commander. At a held place they stand before the
//! keep with the broodlord on it (`Setup::default`); on the open field they deploy as an army round him
//! (`Setup::field`). The old symmetric human field stays for regression sweeps (`Setup::mirror`).

use super::{Battle, How, Order, RideState, Soldier, Squad, SquadState};
use crate::contracts::{Kind, P, SquadId, Team, Tick, Way};
use crate::map::MapKind;
use crate::math::atan2;
use crate::units::Unit;

#[derive(Clone, Debug)]
pub struct Company {
    /// Which unit it is; its kind and stats come from the units table (`Tune::units`).
    pub unit: Unit,
    /// The commander's name; empty for a company without one.
    pub name: String,
    pub rank: u8,
    /// The commander's way (04-battle.md §6).
    pub way: Option<Way>,
    /// Freed men: the reserve (01-flow.md §4 "The freed").
    pub freed: bool,
}

impl Company {
    /// A company of the kind's own unit (a bare beast is a drake pack).
    pub fn new(kind: Kind, name: &str) -> Company {
        Company::of(Unit::of_kind(kind), name)
    }

    pub fn of(unit: Unit, name: &str) -> Company {
        Company { unit, name: name.to_string(), rank: 0, way: None, freed: false }
    }
}

#[derive(Clone, Debug)]
pub struct Setup {
    /// The player's companies; the captain is always added.
    pub warband: Vec<Company>,
    pub garrison: Vec<Company>,
    /// Team 1's commander (a captain-kind unit: the broodlord, or the human general), at its deploy point.
    pub general: Option<Company>,
    /// Team 1 deploys as an army round its general, mirroring team 0's stations (the open field); otherwise its
    /// companies stand in a line 2.5 tiles before the keep, each at its own post.
    pub mirror: bool,
}

impl Default for Setup {
    /// A held place (keep, town, ford): the blight stands before the keep, the broodlord on it.
    fn default() -> Setup {
        Setup { warband: warband(), garrison: nest(), general: Some(broodlord()), mirror: false }
    }
}

const GARRISON_AHEAD: f64 = 2.5;

/// The voice fixture's warband: WIL's spears, ODA's shields, REN's bows and BORS's riders.
fn warband() -> Vec<Company> {
    vec![Company::new(Kind::Spear, "WIL"), Company::new(Kind::Shield, "ODA"), Company::new(Kind::Archer, "REN"), Company::new(Kind::Horse, "BORS")]
}

/// The blight's host for the slice (00-start-here.md §A4): a swarm of three companies of blight-men, a troll company
/// and a drake pack. Without commanders of their own: the broodlord commands them all (out/decisions-blight-sim.md).
fn blight() -> Vec<Company> {
    use Unit::*;
    [BlightMan, BlightMan, BlightMan, Troll, Drake].into_iter().map(|u| Company::of(u, "")).collect()
}

/// The blight holding a place, its nest: the host with a fourth company of blight-men and a second drake pack. A
/// garrison fights piecemeal round its keep (one company guards it), so a nest the host's size lost four battles in
/// five to the commander (out/decisions-blight-sim.md).
fn nest() -> Vec<Company> {
    use Unit::*;
    [BlightMan, BlightMan, BlightMan, BlightMan, Troll, Drake, Drake].into_iter().map(|u| Company::of(u, "")).collect()
}

fn broodlord() -> Company {
    Company::of(Unit::Broodlord, "BROODLORD")
}

impl Setup {
    /// The open field against the blight: the warband against the blight's host deployed as an army round its
    /// broodlord, stations mirrored left and right.
    pub fn field() -> Setup {
        Setup { warband: warband(), garrison: blight(), general: Some(broodlord()), mirror: true }
    }

    /// The symmetric human field of day 3, kept for regression sweeps: both sides a captain and the same four
    /// companies (GRIM, MAUL, ROOK, FANG facing WIL, ODA, REN, BORS).
    pub fn mirror() -> Setup {
        let garrison = [(Kind::Spear, "GRIM"), (Kind::Shield, "MAUL"), (Kind::Archer, "ROOK"), (Kind::Horse, "FANG")]
            .into_iter()
            .map(|(k, n)| Company::new(k, n))
            .collect();
        Setup { warband: warband(), garrison, general: Some(Company::new(Kind::Captain, "GENERAL")), mirror: true }
    }

    /// The setup a map kind opens with when nothing else is given: the blight, as an army on the open field.
    pub fn for_map(kind: MapKind) -> Setup {
        if kind == MapKind::Field { Setup::field() } else { Setup::default() }
    }

    /// A setup by name: `blight` (or empty) is what the map kind opens with; `mirror` is the human field.
    pub fn named(name: &str, kind: MapKind) -> Result<Setup, String> {
        match name {
            "" | "blight" => Ok(Setup::for_map(kind)),
            "mirror" => Ok(Setup::mirror()),
            _ => Err(format!("no setup {name} (blight, mirror)")),
        }
    }

    pub(super) fn deploy(&self, b: &mut Battle) {
        let (ours, theirs) = (b.map.deploy[0], b.map.deploy[1]);
        let heading = atan2(theirs.y - ours.y, theirs.x - ours.x);
        let back = heading + std::f64::consts::PI;
        army(b, 0, ours, heading, &self.warband, Some(&Company::new(Kind::Captain, "CAPTAIN")), false);
        if self.mirror {
            army(b, 1, theirs, back, &self.garrison, self.general.as_ref(), true);
            return;
        }
        let n = self.garrison.len() as f64;
        for (j, c) in self.garrison.iter().enumerate() {
            let station = (GARRISON_AHEAD, (j as f64 - (n - 1.0) / 2.0) * b.tune.army.gap);
            let id = add(b, 1, c, theirs.offset(back, station.0, station.1), back, (station, station));
            b.squads[id].detached = true;
        }
        // The general comes last, so the garrison keeps the ids it had before he joined.
        if let Some(g) = &self.general {
            let a = &mut b.armies[1];
            a.heading = back;
            a.aim = back;
            add(b, 1, g, theirs, back, ((0.0, 0.0), (0.0, 0.0)));
        }
    }
}

/// A captain and his companies at their line stations, following him. `mirrored` flips left and right, so an army
/// facing west stands as the mirror image of one facing east (the open field is mirrored, not rotated).
fn army(b: &mut Battle, team: Team, at: P, heading: f64, companies: &[Company], captain: Option<&Company>, mirrored: bool) {
    let a = &mut b.armies[team as usize];
    a.heading = heading;
    a.aim = heading;
    a.aim_from = at;
    if let Some(c) = captain {
        add(b, team, c, at, heading, ((0.0, 0.0), (0.0, 0.0)));
    }
    for (c, st) in companies.iter().zip(stations(b, companies)) {
        let st = if mirrored { ((st.0.0, -st.0.1), (st.1.0, -st.1.1)) } else { st };
        let id = add(b, team, c, at.offset(heading, st.0.0, st.0.1), heading, st);
        if captain.is_some() {
            b.squads[id].order = Order::Follow;
        }
    }
}

/// Where a company stands in the army: the line, the bows, the wings (horse, and packs, which hunt round the
/// ends), or the freed reserve.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Place {
    Line,
    Bows,
    Wing,
    Reserve,
}

fn place(c: &Company, b: &Battle) -> Place {
    let kind = b.tune.unit_kind(c.unit);
    let spec = b.tune.unit_spec(c.unit).unwrap_or_else(|_| b.tune.kinds.get(kind).clone());
    if c.freed {
        Place::Reserve
    } else if spec.ranged() {
        Place::Bows
    } else if kind == Kind::Horse || spec.pack {
        Place::Wing
    } else {
        Place::Line
    }
}

/// Each company's (line, column) stations around the captain, as (ahead, left), 04-battle.md §3d, filling
/// outward from the centre.
/// - Line: line companies 3 ahead, 5 per row, rows 3.2 apart and staggered; bows 3.5 behind, 4 per row; horse on
///   the wings, 1 ahead and `half + 5 + 3.5·floor(slot/2)` to the side; the freed reserve 0.4 behind, 3.4 to the
///   side.
/// - Column: two abreast at ±2.3; line companies first from 3 ahead in pairs 3.3 apart, then bows, horse and the
///   reserve from 3 behind in pairs 3 apart.
fn stations(b: &Battle, companies: &[Company]) -> Vec<((f64, f64), (f64, f64))> {
    let a = &b.tune.army;
    let n = companies.len();
    let of = |p: Place| -> Vec<usize> { (0..n).filter(|&i| place(&companies[i], b) == p).collect() };
    let (line, bows, horse, reserve) = (of(Place::Line), of(Place::Bows), of(Place::Wing), of(Place::Reserve));
    let mut lines = vec![(0.0, 0.0); n];
    let mut rows = |ids: &[usize], per_row: usize, ahead: f64, step: f64| {
        for (r, chunk) in ids.chunks(per_row.max(1)).enumerate() {
            let k = chunk.len();
            let stagger = if r % 2 == 1 { a.gap / 2.0 } else { 0.0 };
            let mut spots: Vec<f64> = (0..k).map(|j| (j as f64 - (k as f64 - 1.0) / 2.0) * a.gap).collect();
            spots.sort_by(|x, y| x.abs().total_cmp(&y.abs()).then(y.total_cmp(x)));
            for (&i, lateral) in chunk.iter().zip(spots) {
                lines[i] = (ahead + step * r as f64, lateral + stagger);
            }
        }
    };
    rows(&line, a.line_per_row, a.line_ahead, -a.row_gap);
    rows(&bows, a.bows_per_row, -a.bows_behind, -a.row_gap);
    let half = (line.len().min(a.line_per_row).max(1) as f64 - 1.0) * a.gap / 2.0;
    for (slot, &i) in horse.iter().enumerate() {
        let side = if slot % 2 == 0 { 1.0 } else { -1.0 };
        lines[i] = (a.horse_ahead, side * (half + a.horse_side + a.horse_step * (slot / 2) as f64));
    }
    for (slot, &i) in reserve.iter().enumerate() {
        let side = if slot % 2 == 0 { 1.0 } else { -1.0 };
        lines[i] = (-a.reserve_behind, side * (a.reserve_side + a.gap * (slot / 2) as f64));
    }
    let mut columns = vec![(0.0, 0.0); n];
    let pair = |k: usize| if k.is_multiple_of(2) { a.column_abreast } else { -a.column_abreast };
    for (k, &i) in line.iter().enumerate() {
        columns[i] = (a.column_ahead - a.column_pair_gap * (k / 2) as f64, pair(k));
    }
    for (k, &i) in bows.iter().chain(&horse).chain(&reserve).enumerate() {
        columns[i] = (-a.column_rest_behind - a.column_rest_gap * (k / 2) as f64, pair(k));
    }
    lines.into_iter().zip(columns).collect()
}

/// Adds a company (its commander as soldier 0, with 3× hp) at `at`, every man in his slot. Returns its index.
fn add(b: &mut Battle, team: Team, c: &Company, at: P, facing: f64, stations: ((f64, f64), (f64, f64))) -> usize {
    let kind = b.tune.unit_kind(c.unit);
    // Tune::with_override checks every unit, so this falls back only for a hand-built Tune.
    let spec = b.tune.unit_spec(c.unit).unwrap_or_else(|_| b.tune.kinds.get(kind).clone());
    let id = b.squads.len() as SquadId;
    let max_morale = b.tune.rank.morale_base + b.tune.rank.morale * c.rank as f64;
    let hp = spec.hp * (1.0 + b.tune.rank.hp * c.rank as f64);
    let men = spec.men;
    let commanded = !c.name.is_empty() && kind != Kind::Captain;
    let first = b.soldiers.len();
    let squad = Squad {
        id,
        team,
        kind,
        unit: c.unit,
        name: c.name.clone(),
        spec,
        rank: c.rank,
        soldiers: (first..first + men as usize).collect(),
        full: men,
        x: at.x,
        y: at.y,
        facing,
        order: Order::Hold { face: Some(facing) },
        how: How::default(),
        queue: Vec::new(),
        done: false,
        post: at,
        state: SquadState::Idle,
        morale: max_morale,
        max_morale,
        detached: false,
        files: None,
        station: stations.0,
        column: stations.1,
        way: c.way,
        freed: c.freed,
        commanded,
        leader: commanded.then_some(first),
        commander_fell: false,
        saved: false,
        last_stand: false,
        quiet: 0.0,
        kills: 0,
        alive: men,
        threat: None,
        ride: RideState::default(),
        path: Vec::new(),
        path_goal: at,
        replan_at: 0,
        following: false,
        hp_ring: [hp; 4],
        charge_event: Tick::MAX,
        volley_event: Tick::MAX,
    };
    for slot in 0..men {
        let p = b.slot(&squad, slot, men as usize);
        let max_hp = if commanded && slot == 0 { hp * b.tune.combat.commander_hp } else { hp };
        b.soldiers.push(Soldier {
            squad: id,
            slot,
            x: p.x,
            y: p.y,
            vx: 0.0,
            vy: 0.0,
            pace: 0.0,
            hp: max_hp,
            max_hp,
            alive: true,
            strikes: 0,
            hit_at: Tick::MAX,
            died_at: Tick::MAX,
            target: None,
            cooldown: 0.0,
            charge_ready: true,
            since_contact: b.tune.combat.charge_regain_s,
            engaged: false,
            heading: facing,
            cycle: Tick::MAX,
            route: Vec::new(),
            route_goal: p,
            route_at: 0,
        });
    }
    b.squads.push(squad);
    id as usize
}
