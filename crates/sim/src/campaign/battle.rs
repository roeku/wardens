//! The battle at a place (contract §2 `battle`) and the peaceful battle on the road (`road_battle`).
//!
//! - The battle's seed is `hash32(seed, step, place)`; its map is the place's kind (holdfast → keep, village →
//!   town, ford → ford, keep → keep with the nest's lord), as wide as `map_size_for` the warband's companies.
//! - Team 0 is the captain (squad 0) and the companies in the warband's order (squad k+1 is company k), each with
//!   its name, rank, way, face, freed flag and men as they stand; the captain with his hp.
//! - Team 1 is the place's garrison (garrison.rs) under its broodlord, or the ford's raiders, scaled.
//! - A village with houses burnt before the battle opens with only the houses still standing.

use super::{Campaign, Phase, PlaceKind};
use crate::battle::{Battle, Company, Order, Setup};
use crate::bots::BotKind;
use crate::contracts::{Kind, P};
use crate::map::road::{HALL, MUSTER_X1};
use crate::map::{MapKind, MapOpts, map_size_for};
use crate::math::atan2;
use crate::rng::hash32;
use crate::tune::Tune;
use crate::units::Unit;

/// The captain stands this far east of the hall at the muster (chosen).
const MUSTER_CAPTAIN_X: f64 = 7.5;

/// A battle made by the campaign, with the bot that plays the blight there.
pub struct Fight {
    pub battle: Battle,
    pub enemy: Option<BotKind>,
}

impl Campaign {
    /// The battle's seed at `place`: `hash32(seed, step, place)`.
    pub fn battle_seed(&self, place: u32) -> u32 {
        hash32(self.seed, self.step, place)
    }

    /// The captain and the companies as the battle's team 0.
    pub(super) fn warband_setup(&self) -> Vec<Company> {
        let mut out = Vec::with_capacity(self.companies.len() + 1);
        let mut cap = Company::of(Unit::Captain, &self.captain.name);
        cap.hp = Some(self.captain.hp);
        cap.face = self.captain.face;
        out.push(cap);
        for c in &self.companies {
            let mut k = Company::of(c.unit, &c.name);
            k.rank = c.rank;
            k.way = Some(c.way);
            k.freed = c.freed;
            k.face = c.face;
            k.men = Some(c.men.max(1));
            out.push(k);
        }
        out
    }

    /// The map, armies and tuning of the battle at `place`, and the enemy's bot.
    pub fn battle_parts(&self, place: u32) -> Result<(u32, MapOpts, Setup, Tune, Option<BotKind>), String> {
        let p = self.place(place).ok_or(format!("no place {place}"))?.clone();
        let kind = match p.kind {
            PlaceKind::Holdfast | PlaceKind::Keep => MapKind::Keep,
            PlaceKind::Village => MapKind::Town,
            PlaceKind::Ford => MapKind::Ford,
            PlaceKind::Camp => return Err(format!("{} is a camp: no battle there", p.name)),
        };
        let opts = MapOpts { kind, width: map_size_for(self.companies.len()) };
        let mut tune = self.tune.clone();
        let general = p.foe.and_then(|f| self.foes.get(f as usize)).map(|f| {
            let t = &self.tune.campaign;
            let mut g = Company::of(Unit::Broodlord, &f.name);
            let lord = if f.lord { t.lord_rank } else { 0 };
            g.rank = (self.garrison_rank(&p) + f.rank + lord).min(t.max_rank);
            g.way = Some(f.way);
            g.face = f.face;
            g
        });
        let (garrison, enemy) = match p.kind {
            PlaceKind::Ford => {
                tune.places.ford.waves = self.raider_waves(&p);
                (Vec::new(), BotKind::Raiders)
            }
            _ => (self.garrison(&p), BotKind::Garrison),
        };
        if p.kind == PlaceKind::Village {
            let houses = (p.houses as usize).min(tune.places.town.houses.len());
            tune.places.town.houses.truncate(houses);
        }
        let setup = Setup { warband: self.warband_setup(), garrison, general: if p.kind == PlaceKind::Ford { None } else { general }, mirror: false, held: false };
        Ok((self.battle_seed(place), opts, setup, tune, Some(enemy)))
    }

    /// The battle at the current place (contract §2 `battle`): only in the battle phase; called again, the same
    /// battle from its start.
    pub fn battle(&self) -> Result<Fight, String> {
        if self.phase != Phase::Battle {
            return Err(format!("no battle during '{}'", self.phase.name()));
        }
        let place = self.at.ok_or("no place to fight at")?;
        let (seed, opts, setup, tune, enemy) = self.battle_parts(place)?;
        Ok(Fight { battle: Battle::new(seed, opts, &setup, tune), enemy })
    }

    /// The peaceful battle on the road (contract §2 `road_battle`): only team 0. At the muster the captain stands
    /// before the hall and every band waits at its place on the muster ground (squad k+1 is band k, named for its
    /// commander once planted); afterwards the warband stands at its place (or by the hall) facing where it goes.
    pub fn road_battle(&self) -> Battle {
        let mut map = self.road_map();
        let muster = self.phase == Phase::Muster;
        let here = if muster {
            P::new(HALL.x + MUSTER_CAPTAIN_X, HALL.y)
        } else if let Some(p) = self.at.and_then(|id| self.place(id)) {
            p.at
        } else {
            P::new(MUSTER_X1 - 2.0, HALL.y)
        };
        let ahead = self.to.and_then(|id| self.place(id)).map(|p| p.at).or_else(|| {
            let r = self.reachable();
            (!r.is_empty()).then(|| {
                let n = r.len() as f64;
                let (x, y) = r.iter().filter_map(|&id| self.place(id)).fold((0.0, 0.0), |a, p| (a.0 + p.at.x / n, a.1 + p.at.y / n));
                P::new(x, y)
            })
        });
        map.deploy[0] = here;
        map.deploy[1] = ahead.filter(|a| a.dist(here) > 0.5).unwrap_or(P::new(here.x + 10.0, here.y));
        let warband = if muster { self.muster_setup() } else { self.warband_setup() };
        let setup = Setup { warband, garrison: Vec::new(), general: None, mirror: false, held: false };
        let mut b = Battle::on_map(self.seed, map, &setup, self.tune.clone());
        if muster {
            for (k, band) in self.bands.iter().enumerate() {
                let facing = atan2(HALL.y - band.at.y, HALL.x - band.at.x);
                stand(&mut b, k + 1, band.at, facing);
            }
        }
        b
    }

    /// At the muster: the captain and every band as a company (named for its commander once planted).
    fn muster_setup(&self) -> Vec<Company> {
        let mut out = self.warband_setup();
        out.truncate(1);
        for band in &self.bands {
            let c = band.commander.and_then(|id| self.commanders.iter().find(|c| c.id == id));
            let mut k = Company::of(band.unit, c.map_or("", |c| c.name.as_str()));
            k.men = Some(band.men);
            k.rank = c.map_or(band.rank, |c| self.planted_rank(c, band));
            k.way = c.map(|c| c.way);
            k.face = c.map_or(0, |c| c.face);
            out.push(k);
        }
        out
    }
}

/// Stands squad `i` detached at `at`, holding, every man in his slot.
fn stand(b: &mut Battle, i: usize, at: P, facing: f64) {
    if i >= b.squads.len() || b.squads[i].kind == Kind::Captain {
        return;
    }
    let s = &mut b.squads[i];
    s.x = at.x;
    s.y = at.y;
    s.post = at;
    s.facing = facing;
    s.detached = true;
    s.order = Order::Hold { face: Some(facing) };
    let s = b.squads[i].clone();
    let n = s.soldiers.len();
    for &k in &s.soldiers {
        let slot = b.soldiers[k].slot;
        let p = b.slot(&s, slot, n);
        let m = &mut b.soldiers[k];
        m.x = p.x;
        m.y = p.y;
        m.heading = facing;
    }
}
