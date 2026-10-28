//! Who stands where when a battle opens. Until the muster and the campaign's garrisons land (day 5), a battle
//! opens with the voice fixture's warband against a garrison of blight-men (DECISIONS.md D-05), now led by their
//! general at the keep; an open field opens with the same companies on both sides (`Setup::field`).

use super::{Battle, How, Order, RideState, Soldier, Squad, SquadState};
use crate::contracts::{Kind, P, SquadId, Team, Tick, Way};
use crate::map::MapKind;
use crate::math::atan2;

#[derive(Clone, Debug)]
pub struct Company {
    pub kind: Kind,
    /// The commander's name; empty for a company without one.
    pub name: String,
    pub rank: u8,
    /// The commander's way (04-battle.md §6).
    pub way: Option<Way>,
    /// Freed men: the reserve (01-flow.md §4 "The freed").
    pub freed: bool,
}

impl Company {
    pub fn new(kind: Kind, name: &str) -> Company {
        Company { kind, name: name.to_string(), rank: 0, way: None, freed: false }
    }
}

#[derive(Clone, Debug)]
pub struct Setup {
    /// The player's companies; the captain is always added.
    pub warband: Vec<Company>,
    pub garrison: Vec<Company>,
    /// Team 1 has a general (a captain of its own), at its deploy point.
    pub general: bool,
    /// Team 1 deploys as an army round its general, mirroring team 0's stations (the open field); otherwise its
    /// companies stand in a line 2.5 tiles before the keep, each at its own post.
    pub mirror: bool,
}

impl Default for Setup {
    fn default() -> Setup {
        Setup {
            warband: vec![
                Company::new(Kind::Spear, "WIL"),
                Company::new(Kind::Shield, "ODA"),
                Company::new(Kind::Archer, "REN"),
                Company::new(Kind::Horse, "BORS"),
            ],
            garrison: vec![Company::new(Kind::Levy, ""), Company::new(Kind::Levy, ""), Company::new(Kind::Levy, "")],
            general: true,
            mirror: false,
        }
    }
}

const GARRISON_AHEAD: f64 = 2.5;

impl Setup {
    /// The symmetric open-field setup for balance sweeps: both sides a captain and the same four companies.
    pub fn field() -> Setup {
        let base = Setup::default();
        let garrison = [(Kind::Spear, "GRIM"), (Kind::Shield, "MAUL"), (Kind::Archer, "ROOK"), (Kind::Horse, "FANG")]
            .into_iter()
            .map(|(k, n)| Company::new(k, n))
            .collect();
        Setup { garrison, mirror: true, ..base }
    }

    /// The setup a map kind opens with when nothing else is given.
    pub fn for_map(kind: MapKind) -> Setup {
        if kind == MapKind::Field { Setup::field() } else { Setup::default() }
    }

    pub(super) fn deploy(&self, b: &mut Battle) {
        let (ours, theirs) = (b.map.deploy[0], b.map.deploy[1]);
        let heading = atan2(theirs.y - ours.y, theirs.x - ours.x);
        let back = heading + std::f64::consts::PI;
        army(b, 0, ours, heading, &self.warband, "CAPTAIN", true, false);
        if self.mirror {
            army(b, 1, theirs, back, &self.garrison, "GENERAL", self.general, true);
            return;
        }
        let n = self.garrison.len() as f64;
        for (j, c) in self.garrison.iter().enumerate() {
            let station = (GARRISON_AHEAD, (j as f64 - (n - 1.0) / 2.0) * b.tune.army.gap);
            let id = add(b, 1, c, theirs.offset(back, station.0, station.1), back, (station, station));
            b.squads[id].detached = true;
        }
        // The general comes last, so the garrison keeps the ids it had before he joined.
        if self.general {
            let a = &mut b.armies[1];
            a.heading = back;
            a.aim = back;
            add(b, 1, &Company::new(Kind::Captain, "GENERAL"), theirs, back, ((0.0, 0.0), (0.0, 0.0)));
        }
    }
}

/// A captain and his companies at their line stations, following him. `mirrored` flips left and right, so an army
/// facing west stands as the mirror image of one facing east (the open field is mirrored, not rotated).
#[allow(clippy::too_many_arguments)]
fn army(b: &mut Battle, team: Team, at: P, heading: f64, companies: &[Company], captain: &str, with_captain: bool, mirrored: bool) {
    let a = &mut b.armies[team as usize];
    a.heading = heading;
    a.aim = heading;
    a.aim_from = at;
    if with_captain {
        add(b, team, &Company::new(Kind::Captain, captain), at, heading, ((0.0, 0.0), (0.0, 0.0)));
    }
    for (c, st) in companies.iter().zip(stations(b, companies)) {
        let st = if mirrored { ((st.0.0, -st.0.1), (st.1.0, -st.1.1)) } else { st };
        let id = add(b, team, c, at.offset(heading, st.0.0, st.0.1), heading, st);
        if with_captain {
            b.squads[id].order = Order::Follow;
        }
    }
}

/// What a company is to the army's stations.
fn line_kind(c: &Company, b: &Battle) -> bool {
    let spec = b.tune.kinds.get(c.kind);
    !c.freed && !spec.ranged() && c.kind != Kind::Horse && c.kind != Kind::Captain
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
    let line: Vec<usize> = (0..n).filter(|&i| line_kind(&companies[i], b)).collect();
    let bows: Vec<usize> = (0..n).filter(|&i| !companies[i].freed && b.tune.kinds.get(companies[i].kind).ranged()).collect();
    let horse: Vec<usize> = (0..n).filter(|&i| !companies[i].freed && companies[i].kind == Kind::Horse).collect();
    let reserve: Vec<usize> = (0..n).filter(|&i| companies[i].freed).collect();
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
    let spec = b.tune.kinds.get(c.kind).clone();
    let id = b.squads.len() as SquadId;
    let max_morale = b.tune.rank.morale_base + b.tune.rank.morale * c.rank as f64;
    let hp = spec.hp * (1.0 + b.tune.rank.hp * c.rank as f64);
    let men = spec.men;
    let commanded = !c.name.is_empty() && c.kind != Kind::Captain;
    let first = b.soldiers.len();
    let squad = Squad {
        id,
        team,
        kind: c.kind,
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
            route: Vec::new(),
            route_goal: p,
            route_at: 0,
        });
    }
    b.squads.push(squad);
    id as usize
}
