//! Deeds become squad orders, or are refused (docs/spec/01-flow.md §2 "What a tap does"; 06-voice.md §6
//! "Validation"). A refusal is a red cross on the field; its reason is only for the log.
//!
//! An army order moves the captain and gives every company still with the army its fixed station around
//! him (04-battle.md §3d). Following him on the march, and planFront for a drawn line, arrive on day 3.

use super::{Battle, Order, SquadState};
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
            Deed::Attack { who, target } => {
                let whom = self.whom(team, who)?;
                let t = self.foe(team, *target)?;
                match whom {
                    Whom::Army(_) => self.with_army(team, |_| Order::Attack { target: t }),
                    Whom::One(i) => self.detach(i, Order::Attack { target: t }),
                }
            }
            Deed::Take { who, site } => {
                let whom = self.whom(team, who)?;
                let Some(at) = self.map.sites.get(*site as usize).map(|s| s.at) else {
                    return Err((self.captain_at(team), format!("no site {site}")));
                };
                match whom {
                    Whom::Army(cap) => {
                        self.army_to(team, cap, at, Vec::new(), true, None);
                        self.squads[cap].order = Order::Take { site: *site };
                    }
                    Whom::One(i) => self.detach(i, Order::Take { site: *site }),
                }
            }
            Deed::Front { line } => {
                // planFront is day 3; until then the army marches to the line's middle.
                let (Some(a), Some(b)) = (line.first(), line.last()) else {
                    return Err((self.captain_at(team), "empty front".into()));
                };
                let whom = self.whom(team, &Who::Army)?;
                let mid = P::new((a.x + b.x) / 2.0, (a.y + b.y) / 2.0);
                self.reachable(&whom, mid)?;
                if let Whom::Army(cap) = whom {
                    self.army_to(team, cap, mid, Vec::new(), false, None);
                }
            }
            Deed::Hold { who } => match self.whom(team, who)? {
                Whom::Army(_) => self.with_army(team, |_| Order::Hold { face: None }),
                Whom::One(i) => self.detach(i, Order::Hold { face: None }),
            },
            Deed::Recall { id } => {
                let i = self.own(team, *id)?;
                if self.squads[i].kind == Kind::Captain {
                    return Err((self.captain_at(team), "the captain is not recalled".into()));
                }
                self.recall(team, i);
            }
            Deed::Rally => {
                let Whom::Army(cap) = self.whom(team, &Who::Army)? else { unreachable!() };
                self.squads[cap].order = Order::Hold { face: None };
                let ids: Vec<usize> = self.team_squads(team).filter(|&i| i != cap).collect();
                for i in ids {
                    self.recall(team, i);
                }
            }
        }
        Ok(())
    }

    fn team_squads(&self, team: Team) -> impl Iterator<Item = usize> + '_ {
        self.squads.iter().enumerate().filter(move |(_, s)| s.team == team && can_obey(s.state)).map(|(i, _)| i)
    }

    fn captain(&self, team: Team) -> Option<usize> {
        self.team_squads(team).find(|&i| self.squads[i].kind == Kind::Captain)
    }

    fn captain_at(&self, team: Team) -> P {
        self.captain(team).map_or(self.map.deploy[team as usize], |i| P::new(self.squads[i].x, self.squads[i].y))
    }

    /// One of `team`'s own squads that can take orders.
    fn own(&self, team: Team, id: SquadId) -> Result<usize, Refused> {
        match self.squads.get(id as usize) {
            Some(s) if s.team == team && can_obey(s.state) => Ok(id as usize),
            Some(s) if s.team == team => Err((P::new(s.x, s.y), format!("squad {id} is {:?}", s.state))),
            _ => Err((self.captain_at(team), format!("no squad {id} of ours"))),
        }
    }

    fn whom(&self, team: Team, who: &Who) -> Result<Whom, Refused> {
        match who {
            Who::Army => self.captain(team).map(Whom::Army).ok_or_else(|| (self.map.deploy[team as usize], "no captain".into())),
            Who::Squad { id } => {
                let i = self.own(team, *id)?;
                Ok(if self.squads[i].kind == Kind::Captain { Whom::Army(i) } else { Whom::One(i) })
            }
        }
    }

    /// An enemy squad that is still on the field.
    fn foe(&self, team: Team, id: SquadId) -> Result<SquadId, Refused> {
        match self.squads.get(id as usize) {
            Some(s) if s.team != team && !matches!(s.state, SquadState::Fled | SquadState::Destroyed) => Ok(id),
            Some(s) => Err((P::new(s.x, s.y), format!("squad {id} is not a foe on the field"))),
            None => Err((self.captain_at(team), format!("no squad {id}"))),
        }
    }

    /// The destination is inside the map, on passable ground, and A* finds a way there.
    fn reachable(&self, whom: &Whom, to: P) -> Result<(), Refused> {
        let i = match whom {
            Whom::Army(i) | Whom::One(i) => *i,
        };
        let from = P::new(self.squads[i].x, self.squads[i].y);
        if path::astar(&self.map, from, to).is_none() {
            return Err((to, "unreachable".into()));
        }
        Ok(())
    }

    fn detach(&mut self, i: usize, order: Order) {
        let s = &mut self.squads[i];
        s.detached = true;
        s.order = order;
    }

    /// Every squad still with the army, captain included, gets `order(i)`.
    fn with_army(&mut self, team: Team, order: impl Fn(usize) -> Order) {
        let ids: Vec<usize> = self.team_squads(team).filter(|&i| !self.squads[i].detached).collect();
        for i in ids {
            self.squads[i].order = order(i);
        }
    }

    /// The captain goes to `to`; each company with the army goes to its station there, facing the way marched.
    fn army_to(&mut self, team: Team, cap: usize, to: P, via: Vec<P>, fight: bool, face: Option<f64>) {
        let c = &self.squads[cap];
        let heading = if to.dist(P::new(c.x, c.y)) > 0.0 { atan2(to.y - c.y, to.x - c.x) } else { c.facing };
        let face = face.unwrap_or(heading);
        self.squads[cap].order = Order::Move { to, via, fight, face: Some(face) };
        let ids: Vec<usize> = self.team_squads(team).filter(|&i| i != cap && !self.squads[i].detached).collect();
        for i in ids {
            let (ahead, left) = self.squads[i].station;
            let spot = to.offset(heading, ahead, left);
            self.squads[i].order = Order::Move { to: spot, via: Vec::new(), fight, face: Some(face) };
        }
    }

    /// Back to its station by the captain, walking out of any fight (04-battle.md §5 "Recall").
    fn recall(&mut self, team: Team, i: usize) {
        let Some(cap) = self.captain(team) else { return };
        let c = &self.squads[cap];
        let (ahead, left) = self.squads[i].station;
        let spot = P::new(c.x, c.y).offset(c.facing, ahead, left);
        let face = Some(c.facing);
        let s = &mut self.squads[i];
        s.detached = false;
        s.order = Order::Move { to: spot, via: Vec::new(), fight: false, face };
    }
}

fn can_obey(state: SquadState) -> bool {
    !matches!(state, SquadState::Routing | SquadState::Fled | SquadState::Destroyed)
}
