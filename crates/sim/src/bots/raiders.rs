//! The raiders (04-battle.md §7 "Raiders (the ford)"), thinking every 1.5 s like the garrison:
//! - **Horse** go for the civilians. The blight has no horse: its hunters, the drake packs, take that part.
//! - **Archers** shoot troops within 9, else civilians.
//! - **Foot** go for troops within 4, or closer than 0.8 of the civilians' distance; otherwise for the civilians.
//!
//! Everything is seen through the raiders' own fog. With nothing in sight, a company marches on the main ford,
//! fighting: the civilians must cross there or at the far ford, and the warband stands between. Works they see are
//! torn down as the other bots do (`raid_works`).

use super::{Orders, Seen, companies, nearest, seen};
use crate::battle::Battle;
use crate::contracts::{Deed, Kind, Team, Who};

pub(super) fn think(b: &Battle, team: Team, out: &mut Orders) {
    let foes = seen(b, team);
    let folk: Vec<Seen> = foes.iter().filter(|f| f.kind == Kind::Folk).cloned().collect();
    let troops: Vec<Seen> = foes.iter().filter(|f| f.kind != Kind::Folk).cloned().collect();
    let r = &b.tune.bots.raiders;
    let goal = b.places.ford.as_ref().map_or(b.map.deploy[1 - (team as usize & 1)], |f| f.crossing[0]);
    for i in companies(b, team) {
        let s = &b.squads[i];
        let here = b.centre(i);
        let civ = nearest(&folk, here, f64::INFINITY);
        let troop = nearest(&troops, here, f64::INFINITY);
        let d = |f: Option<&Seen>| f.map_or(f64::INFINITY, |f| f.at.dist(here));
        let hunter = s.kind == Kind::Horse || s.spec.pack;
        let choice = if hunter {
            civ.or(troop)
        } else if s.spec.ranged() {
            if d(troop) <= r.archer_r { troop } else { civ.or(troop) }
        } else if d(troop) <= r.foot_r || d(troop) < r.foot_share * d(civ) {
            troop
        } else {
            civ.or(troop)
        };
        let who = Who::Squad { id: s.id };
        match choice {
            Some(f) => out.push(b, Deed::Attack { who, target: f.id, via: Vec::new() }),
            None => out.push(b, Deed::Move { who, to: b.open_near(goal), via: Vec::new(), fight: true, face: None }),
        }
    }
}
