//! Deeds become squad orders, or are refused (docs/spec/01-flow.md §2 "What a tap does"; 06-voice.md §6
//! "Validation"; 08-orders.md). A refusal is a red cross on the field; its reason is only for the log.
//!
//! An army order moves the captain, and every company still with the army follows him at its fixed station
//! (04-battle.md §3d). A company given an order of its own is detached until recalled.

use super::{Battle, How, Order, SquadState};
use crate::contracts::{Deed, Kind, P, SquadId, Team, Who};
use crate::map::path;
use crate::math::atan2;

type Refused = (P, String);

enum Whom {
    /// The army, by its captain's index.
    Army(usize),
    One(usize),
}

impl Battle {
    pub(super) fn obey(&mut self, team: Team, deed: &Deed) -> Result<(), Refused> {
        match deed {
            Deed::Move { who, to, via, fight, face } => {
                let whom = self.whom(team, who)?;
                self.reachable(&whom, *to)?;
                match whom {
                    Whom::Army(cap) => self.army_to(team, cap, *to, via.clone(), *fight, *face),
                    Whom::One(i) => self.detach(i, Order::Move { to: *to, via: via.clone(), fight: *fight, face: *face }),
                }
            }
            Deed::Attack { who, target, via } => {
                let whom = self.whom(team, who)?;
                let t = self.foe(team, *target)?;
                match whom {
                    Whom::Army(cap) => {
                        for i in self.with_army(team, cap) {
                            self.command(i, Order::Attack { target: t, via: via.clone() }, How::default());
                        }
                        self.command(cap, Order::Ride, How::default());
                    }
                    Whom::One(i) => self.detach(i, Order::Attack { target: t, via: via.clone() }),
                }
            }
            Deed::Take { who, site, via } => {
                let whom = self.whom(team, who)?;
                let Some(at) = self.map.sites.get(*site as usize).map(|s| s.at) else {
                    return Err((self.here(team), format!("no site {site}")));
                };
                match whom {
                    Whom::Army(cap) => {
                        self.army_to(team, cap, at, via.clone(), true, None);
                        self.command(cap, Order::Take { site: *site, via: via.clone() }, How::default());
                    }
                    Whom::One(i) => self.detach(i, Order::Take { site: *site, via: via.clone() }),
                }
            }
            Deed::Front { line } => {
                let Whom::Army(cap) = self.whom(team, &Who::Army)? else { unreachable!() };
                if line.is_empty() {
                    return Err((self.here(team), "empty front".into()));
                }
                self.plan_front(team, cap, line)?;
            }
            Deed::Hold { who } => match self.whom(team, who)? {
                Whom::Army(cap) => {
                    for i in self.with_army(team, cap).into_iter().chain(std::iter::once(cap)) {
                        self.command(i, Order::Hold { face: None }, How::default());
                    }
                }
                Whom::One(i) => self.detach(i, Order::Hold { face: None }),
            },
            Deed::Recall { id } => {
                let i = self.own(team, *id)?;
                if self.squads[i].kind == Kind::Captain {
                    return Err((self.here(team), "the captain is not recalled".into()));
                }
                self.recall(i);
            }
            Deed::Rally => {
                let Whom::Army(cap) = self.whom(team, &Who::Army)? else { unreachable!() };
                self.command(cap, Order::Hold { face: None }, How::default());
                let ids: Vec<usize> = (0..self.squads.len()).filter(|&i| i != cap && self.squads[i].team == team && self.squads[i].standing()).collect();
                for i in ids {
                    self.recall(i);
                }
            }
            // The order language (08-orders) is carried out from day 4; until then its deeds are refused, not ignored.
            _ => return Err((self.captain_at(team).unwrap_or(self.map.deploy[team as usize & 1]), "not carried out yet (08-orders)".into())),
        }
        Ok(())
    }

    /// Makes `order` current at once, replacing anything queued (a new direct order). The modifiers come with it.
    pub(crate) fn command(&mut self, i: usize, order: Order, how: How) {
        self.squads[i].queue.clear();
        self.set_order(i, order, how);
    }

    /// Makes `order` current, keeping the queue (a released pending order).
    pub(super) fn set_order(&mut self, i: usize, order: Order, how: How) {
        let s = &mut self.squads[i];
        if matches!(order, Order::Hold { .. }) {
            s.post = P::new(s.x, s.y);
        }
        if s.kind == Kind::Captain && order != Order::Ride {
            s.ride = super::RideState::default();
        }
        s.files = how.files;
        s.order = order;
        s.how = how;
        s.done = false;
        s.path.clear();
    }

    fn here(&self, team: Team) -> P {
        self.captain_at(team).unwrap_or(self.map.deploy[team as usize & 1])
    }

    /// One of `team`'s own squads that can take orders.
    fn own(&self, team: Team, id: SquadId) -> Result<usize, Refused> {
        match self.squads.get(id as usize) {
            Some(s) if s.team == team && s.standing() => Ok(id as usize),
            Some(s) if s.team == team => Err((P::new(s.x, s.y), format!("squad {id} is {:?}", s.state))),
            _ => Err((self.here(team), format!("no squad {id} of ours"))),
        }
    }

    fn whom(&self, team: Team, who: &Who) -> Result<Whom, Refused> {
        match who {
            Who::Army => self.captain_of(team).map(Whom::Army).ok_or_else(|| (self.map.deploy[team as usize & 1], "no captain".into())),
            Who::Squad { id } => {
                let i = self.own(team, *id)?;
                Ok(if self.squads[i].kind == Kind::Captain { Whom::Army(i) } else { Whom::One(i) })
            }
            Who::Squads { .. } => Err((self.captain_at(team).unwrap_or(self.map.deploy[team as usize & 1]), "several companies at once: not carried out yet (08-orders)".into())),
        }
    }

    /// An enemy squad that is still on the field.
    fn foe(&self, team: Team, id: SquadId) -> Result<SquadId, Refused> {
        match self.squads.get(id as usize) {
            Some(s) if s.team != team && s.on_field() => Ok(id),
            Some(s) => Err((P::new(s.x, s.y), format!("squad {id} is not a foe on the field"))),
            None => Err((self.here(team), format!("no squad {id}"))),
        }
    }

    /// The destination is inside the map, on passable ground, and A* finds a way there.
    fn reachable(&self, whom: &Whom, to: P) -> Result<(), Refused> {
        let i = match whom {
            Whom::Army(i) | Whom::One(i) => *i,
        };
        let from = P::new(self.squads[i].x, self.squads[i].y);
        if path::astar(&self.map, self.open_near(from), to).is_none() {
            return Err((to, "unreachable".into()));
        }
        Ok(())
    }

    fn detach(&mut self, i: usize, order: Order) {
        self.command(i, order, How::default());
        self.squads[i].detached = true;
    }

    /// The companies still with the army (not detached, on the field and not routing), captain excluded.
    fn with_army(&self, team: Team, cap: usize) -> Vec<usize> {
        (0..self.squads.len())
            .filter(|&i| i != cap && self.squads[i].team == team && !self.squads[i].detached && self.squads[i].standing() && self.squads[i].alive > 0)
            .collect()
    }

    /// The captain goes to `to`; each company with the army follows him at its fixed station (§3d).
    pub(super) fn army_to(&mut self, team: Team, cap: usize, to: P, via: Vec<P>, fight: bool, face: Option<f64>) {
        let c = &self.squads[cap];
        let heading = if to.dist(P::new(c.x, c.y)) > 0.0 { atan2(to.y - c.y, to.x - c.x) } else { c.facing };
        let face = face.unwrap_or(heading);
        self.command(cap, Order::Move { to, via, fight, face: Some(face) }, How::default());
        for i in self.with_army(team, cap) {
            self.command(i, Order::Follow, How::default());
        }
    }

    /// Back to its station by the captain, walking out of any fight (04-battle.md §5 "Recall").
    fn recall(&mut self, i: usize) {
        let until = self.tick + (self.tune.morale.recall_s * crate::contracts::TICK_HZ as f64) as u32;
        self.command(i, Order::Recall { until }, How::default());
        let s = &mut self.squads[i];
        s.detached = false;
        s.threat = None;
        if s.state == SquadState::Fighting {
            s.state = SquadState::Marching;
        }
    }
}
