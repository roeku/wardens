//! Who stands where when a battle opens. Until the muster and the campaign's garrisons land (day 5), a
//! battle opens with the voice fixture's warband against a garrison of blight-men (DECISIONS.md D-05).

use super::{Battle, Order, Soldier, Squad, SquadState};
use crate::contracts::{Kind, P, SquadId, Team};
use crate::math::atan2;

#[derive(Clone, Debug)]
pub struct Company {
    pub kind: Kind,
    /// The commander's name; empty for a company without one.
    pub name: String,
    pub rank: u8,
}

impl Company {
    pub fn new(kind: Kind, name: &str) -> Company {
        Company { kind, name: name.to_string(), rank: 0 }
    }
}

#[derive(Clone, Debug)]
pub struct Setup {
    /// The player's companies; the captain is always added.
    pub warband: Vec<Company>,
    pub garrison: Vec<Company>,
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
        }
    }
}

const GARRISON_AHEAD: f64 = 2.5;

impl Setup {
    pub(super) fn deploy(&self, b: &mut Battle) {
        let (ours, theirs) = (b.map.deploy[0], b.map.deploy[1]);
        let heading = atan2(theirs.y - ours.y, theirs.x - ours.x);
        add(b, 0, &Company::new(Kind::Captain, "CAPTAIN"), ours, heading, (0.0, 0.0));
        for (c, station) in self.warband.iter().zip(stations(b, &self.warband)) {
            add(b, 0, c, ours.offset(heading, station.0, station.1), heading, station);
        }
        let back = heading + std::f64::consts::PI;
        let n = self.garrison.len() as f64;
        for (j, c) in self.garrison.iter().enumerate() {
            let station = (GARRISON_AHEAD, (j as f64 - (n - 1.0) / 2.0) * b.tune.army.gap);
            add(b, 1, c, theirs.offset(back, station.0, station.1), back, station);
        }
    }
}

/// Line formation stations around the captain, as (ahead, left), 04-battle.md §3d: line companies 3 ahead,
/// 5 per row, rows 3.2 apart and staggered, filling outward from the centre; bows 3.5 behind, 4 per row;
/// horse on the wings, 1 ahead and `half + 5 + 3.5·floor(slot/2)` to the side.
fn stations(b: &Battle, warband: &[Company]) -> Vec<(f64, f64)> {
    let a = &b.tune.army;
    let line: Vec<usize> = (0..warband.len()).filter(|&i| matches!(warband[i].kind, Kind::Spear | Kind::Shield | Kind::Levy)).collect();
    let bows: Vec<usize> = (0..warband.len()).filter(|&i| warband[i].kind == Kind::Archer).collect();
    let mut out = vec![(0.0, 0.0); warband.len()];
    let mut rows = |ids: &[usize], per_row: usize, ahead: f64, step: f64| {
        for (r, chunk) in ids.chunks(per_row).enumerate() {
            let k = chunk.len();
            let stagger = if r % 2 == 1 { a.gap / 2.0 } else { 0.0 };
            let mut spots: Vec<f64> = (0..k).map(|j| (j as f64 - (k as f64 - 1.0) / 2.0) * a.gap).collect();
            spots.sort_by(|x, y| x.abs().total_cmp(&y.abs()).then(y.total_cmp(x)));
            for (&i, lateral) in chunk.iter().zip(spots) {
                out[i] = (ahead + step * r as f64, lateral + stagger);
            }
        }
    };
    rows(&line, a.line_per_row, a.line_ahead, -a.row_gap);
    rows(&bows, a.bows_per_row, -a.bows_behind, -a.row_gap);
    let half = (line.len().min(a.line_per_row).max(1) as f64 - 1.0) * a.gap / 2.0;
    let horse = (0..warband.len()).filter(|&i| warband[i].kind == Kind::Horse);
    for (slot, i) in horse.enumerate() {
        let side = if slot % 2 == 0 { 1.0 } else { -1.0 };
        out[i] = (a.horse_ahead, side * (half + a.horse_side + a.horse_step * (slot / 2) as f64));
    }
    out
}

fn add(b: &mut Battle, team: Team, c: &Company, at: P, facing: f64, station: (f64, f64)) {
    let spec = b.tune.kinds.get(c.kind).clone();
    let id = b.squads.len() as SquadId;
    let max_morale = b.tune.rank.morale_base + b.tune.rank.morale * c.rank as f64;
    let hp = spec.hp * (1.0 + b.tune.rank.hp * c.rank as f64);
    let men = spec.men;
    let squad = Squad {
        id,
        team,
        kind: c.kind,
        name: c.name.clone(),
        spec,
        rank: c.rank,
        soldiers: Vec::new(),
        full: men,
        x: at.x,
        y: at.y,
        facing,
        order: Order::Hold { face: Some(facing) },
        state: SquadState::Idle,
        morale: max_morale,
        max_morale,
        detached: false,
        files: None,
        station,
        path: Vec::new(),
        path_goal: at,
        replan_at: 0,
    };
    let has_commander = !c.name.is_empty() && c.kind != Kind::Captain;
    for slot in 0..men {
        let p = b.slot(&squad, slot, men as usize);
        let max_hp = if has_commander && slot == 0 { hp * b.tune.combat.commander_hp } else { hp };
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
        });
    }
    let first = b.soldiers.len() - men as usize;
    let squad = Squad { soldiers: (first..b.soldiers.len()).collect(), ..squad };
    b.squads.push(squad);
}
