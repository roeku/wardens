//! Deeds become squad orders, or are refused (docs/spec/01-flow.md §2 "What a tap does"; 06-voice.md §6
//! "Validation"; 08-orders.md §2–§8). A refusal is a red cross on the field; its reason is only for the log.
//!
//! An army order moves the captain, and every company still with the army follows him at its fixed station
//! (04-battle.md §3d). A company given an order of its own is detached until recalled. Several companies at once
//! (`Who::Squads`) are each ordered as if alone. A waiting deed (`Wait`) goes into its company's queue, or its
//! army's when the deed is for the army; a direct order clears the queue of whoever it orders.

use super::{Battle, Order, Pending, Priority, SquadState, When};
use crate::contracts::{Deed, EventCode, Kind, P, Refusal, SquadId, Team, Who};
use crate::map::path;
use crate::math::atan2;

pub(super) type Refused = (P, String);

enum Whom {
    /// The army, by its captain's index.
    Army(usize),
    One(usize),
}

/// The companies a deed names, if it names any (a `With` or `Wait` names its inner deed's).
fn who_of(deed: &Deed) -> Option<&Who> {
    match deed {
        Deed::Move { who, .. }
        | Deed::Attack { who, .. }
        | Deed::Take { who, .. }
        | Deed::Hold { who }
        | Deed::Set { who, .. }
        | Deed::Guard { who, .. }
        | Deed::Screen { who, .. }
        | Deed::Charge { who, .. }
        | Deed::Withdraw { who, .. }
        | Deed::Regroup { who }
        | Deed::Reserve { who }
        | Deed::Commit { who, .. }
        | Deed::Face { who, .. }
        | Deed::Build { who, .. } => Some(who),
        Deed::With { deed, .. } | Deed::Wait { deed, .. } => who_of(deed),
        Deed::Front { .. } | Deed::Recall { .. } | Deed::Rally | Deed::Signal { .. } | Deed::Advance => None,
    }
}

/// `deed` with its companies (its inner deed's, through `With` and `Wait`) replaced by `to`.
fn with_who(deed: &Deed, to: Who) -> Deed {
    let mut d = deed.clone();
    match &mut d {
        Deed::Move { who, .. }
        | Deed::Attack { who, .. }
        | Deed::Take { who, .. }
        | Deed::Hold { who }
        | Deed::Set { who, .. }
        | Deed::Guard { who, .. }
        | Deed::Screen { who, .. }
        | Deed::Charge { who, .. }
        | Deed::Withdraw { who, .. }
        | Deed::Regroup { who }
        | Deed::Reserve { who }
        | Deed::Commit { who, .. }
        | Deed::Face { who, .. }
        | Deed::Build { who, .. } => *who = to,
        Deed::With { deed, .. } | Deed::Wait { deed, .. } => **deed = with_who(deed, to),
        Deed::Front { .. } | Deed::Recall { .. } | Deed::Rally | Deed::Signal { .. } | Deed::Advance => {}
    }
    d
}

impl Battle {
    pub(super) fn obey(&mut self, team: Team, deed: &Deed) -> Result<(), Refused> {
        // Several companies at once: each as if ordered alone. Those refused are refused one by one; the deed is
        // refused only if every one is.
        if let Some(Who::Squads { ids }) = who_of(deed) {
            if ids.is_empty() {
                return Err((self.here(team), "no companies named".into()));
            }
            let mut errs: Vec<Refused> = Vec::new();
            for &id in ids {
                if let Err(e) = self.obey(team, &with_who(deed, Who::Squad { id })) {
                    errs.push(e);
                }
            }
            let all = errs.len() == ids.len();
            let last = if all { errs.pop() } else { None };
            for (at, why) in errs {
                self.refuse(team, at, why);
            }
            return last.map_or(Ok(()), Err);
        }
        if !self.releasing && self.orders_army(team, deed) {
            // A direct army order replaces whatever the army was waiting to do.
            self.waiting[team as usize & 1].clear();
        }
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
                        for i in self.line_of(team, cap) {
                            self.command(i, Order::Attack { target: t, via: via.clone() });
                        }
                        self.command(cap, Order::Ride);
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
                        self.command(cap, Order::Take { site: *site, via: via.clone() });
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
                        self.command(i, Order::Hold { face: None });
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
                self.command(cap, Order::Hold { face: None });
                let ids: Vec<usize> = (0..self.squads.len()).filter(|&i| i != cap && self.squads[i].team == team && self.squads[i].standing() && !self.civilian(i)).collect();
                for i in ids {
                    self.recall(i);
                }
            }
            // The order language (08-orders.md §3, §5, §6, §7, §8).
            Deed::With { how, deed } => {
                // Check the modifiers before anything is ordered.
                super::How::default().merge(how, &self.tune).map_err(|e| (self.here(team), e))?;
                if let Deed::Wait { until, deed } = deed.as_ref() {
                    // "With" outside a wait applies when the wait runs.
                    return self.wait(team, until.clone(), Deed::With { how: how.clone(), deed: deed.clone() });
                }
                self.touched.clear();
                self.obey(team, deed)?;
                let mut touched = std::mem::take(&mut self.touched);
                touched.sort_unstable();
                touched.dedup();
                for i in touched {
                    let mut way = self.squads[i].how.clone();
                    way.merge(how, &self.tune).map_err(|e| (self.here(team), e))?;
                    self.squads[i].how = way;
                }
            }
            Deed::Wait { until, deed } => self.wait(team, until.clone(), (**deed).clone())?,
            Deed::Signal { n } => self.raise_signal(team, *n),
            Deed::Set { who, how } => {
                let ids = match self.whom(team, who)? {
                    // "Everyone": the captain and every company still standing, with the army or not.
                    Whom::Army(cap) => std::iter::once(cap).chain((0..self.squads.len()).filter(|&i| i != cap && self.squads[i].team == team && self.squads[i].standing() && !self.civilian(i))).collect(),
                    Whom::One(i) => vec![i],
                };
                let mut ways = Vec::new();
                for &i in &ids {
                    let mut way = self.squads[i].how.clone();
                    way.merge(how, &self.tune).map_err(|e| (self.here(team), e))?;
                    ways.push(way);
                }
                for (i, way) in ids.into_iter().zip(ways) {
                    self.squads[i].how = way;
                }
            }
            Deed::Guard { who, ward } => {
                let whom = self.whom(team, who)?;
                let w = self.own(team, *ward)?;
                match whom {
                    Whom::Army(cap) if cap == w => return Err((self.here(team), "the army cannot guard its own captain".into())),
                    Whom::Army(cap) => self.command(cap, Order::Guard { ward: *ward }),
                    Whom::One(i) if i == w => return Err((self.at(i), "a company cannot guard itself".into())),
                    Whom::One(i) => self.detach(i, Order::Guard { ward: *ward }),
                }
            }
            Deed::Screen { who, ward, from } => {
                let whom = self.whom(team, who)?;
                let w = self.own(team, *ward)?;
                if let Some(f) = from {
                    self.foe(team, *f)?;
                }
                match whom {
                    Whom::Army(cap) if cap == w => return Err((self.here(team), "the army cannot screen its own captain".into())),
                    Whom::Army(cap) => self.command(cap, Order::Screen { ward: *ward, from: *from }),
                    Whom::One(i) if i == w => return Err((self.at(i), "a company cannot screen itself".into())),
                    Whom::One(i) => self.detach(i, Order::Screen { ward: *ward, from: *from }),
                }
            }
            Deed::Charge { who, target } => {
                let whom = self.whom(team, who)?;
                if let Some(t) = target {
                    self.foe(team, *t)?;
                }
                match whom {
                    Whom::Army(cap) => {
                        let mut any = false;
                        for i in self.line_of(team, cap) {
                            if let Some(t) = target.or_else(|| self.best_foe(i, f64::INFINITY)) {
                                self.command(i, Order::Charge { target: t });
                                any = true;
                            }
                        }
                        if !any {
                            return Err((self.here(team), "no foe in sight to charge".into()));
                        }
                        self.command(cap, Order::Ride);
                    }
                    Whom::One(i) => {
                        let t = target.or_else(|| self.best_foe(i, f64::INFINITY)).ok_or_else(|| (self.at(i), "no foe in sight to charge".to_string()))?;
                        self.detach(i, Order::Charge { target: t });
                    }
                }
            }
            Deed::Withdraw { who, to } => match self.whom(team, who)? {
                Whom::Army(cap) => {
                    // The army steps back together, each company by the captain's own step, still with the army.
                    let cap_at = self.at(cap);
                    let step = match to {
                        Some(p) => P::new(p.x - cap_at.x, p.y - cap_at.y),
                        None => {
                            let c = self.centre(cap);
                            let back = self.withdraw_point(cap, None);
                            P::new(back.x - c.x, back.y - c.y)
                        }
                    };
                    for i in self.with_army(team, cap).into_iter().chain(std::iter::once(cap)) {
                        let here = self.at(i);
                        let to = self.inside(P::new(here.x + step.x, here.y + step.y));
                        self.command(i, Order::Withdraw { to });
                    }
                }
                Whom::One(i) => {
                    let to = self.withdraw_point(i, *to);
                    self.detach(i, Order::Withdraw { to });
                }
            },
            Deed::Regroup { who } => match self.whom(team, who)? {
                Whom::Army(cap) => {
                    let to = self.regroup_point(cap);
                    self.army_to(team, cap, to, Vec::new(), false, Some(self.squads[cap].facing));
                }
                Whom::One(i) => {
                    let to = self.regroup_point(i);
                    self.detach(i, Order::Regroup { to });
                }
            },
            Deed::Reserve { who } => match self.whom(team, who)? {
                Whom::Army(_) => return Err((self.here(team), "the army cannot be its own reserve: name a company".into())),
                Whom::One(i) => {
                    let a = &self.tune.army;
                    let k = self.squads.iter().filter(|s| s.team == team && s.reserve.is_some() && s.id as usize != i).count();
                    let side = if k % 2 == 0 { 1.0 } else { -1.0 };
                    let station = (-self.tune.orders.reserve_behind, side * (a.reserve_side + a.gap * (k / 2) as f64));
                    self.squads[i].reserve = Some(station);
                    self.command(i, Order::Follow);
                    let s = &mut self.squads[i];
                    s.detached = false;
                    s.following = true;
                }
            },
            Deed::Commit { who, target } => {
                if let Some(t) = target {
                    self.foe(team, *t)?;
                }
                match self.whom(team, who)? {
                    Whom::Army(_) => {
                        let reserves: Vec<usize> = (0..self.squads.len()).filter(|&i| self.squads[i].team == team && self.squads[i].reserve.is_some() && self.squads[i].standing()).collect();
                        if reserves.is_empty() {
                            return Err((self.here(team), "no reserve to commit".into()));
                        }
                        for i in reserves {
                            self.commit(i, *target);
                        }
                    }
                    Whom::One(i) => self.commit(i, *target),
                }
            }
            Deed::Face { who, face } => {
                if !face.is_finite() {
                    return Err((self.here(team), "face: not a direction".into()));
                }
                match self.whom(team, who)? {
                    Whom::Army(cap) => {
                        self.command(cap, Order::Hold { face: Some(*face) });
                        self.armies[team as usize & 1].aim = *face;
                    }
                    Whom::One(i) => self.detach(i, Order::Hold { face: Some(*face) }),
                }
            }
            Deed::Advance => self.held = [false, false],
            Deed::Build { who, work, at, face } => match self.whom(team, who)? {
                Whom::Army(_) => return Err((self.here(team), "build: name a company".into())),
                Whom::One(i) => {
                    let (id, spot) = self.lay_work(team, i, *work, *at, *face)?;
                    self.detach(i, Order::Build { work: id, at: spot });
                }
            },
        }
        Ok(())
    }

    /// A refusal: a red cross at `at` for the view, its reason for the log.
    pub(super) fn refuse(&mut self, team: Team, at: P, why: String) {
        self.refusals.push(Refusal { tick: self.tick, at, why });
        self.event(EventCode::Refused, at, team as u32, 0);
    }

    /// Whether `deed` is a direct order to `team`'s army (it clears the army's waiting deeds).
    fn orders_army(&self, team: Team, deed: &Deed) -> bool {
        match deed {
            Deed::Front { .. } | Deed::Rally => true,
            Deed::Wait { .. } | Deed::Set { .. } | Deed::Signal { .. } | Deed::Advance | Deed::Recall { .. } => false,
            Deed::With { deed, .. } => self.orders_army(team, deed),
            _ => match who_of(deed) {
                Some(Who::Army) => true,
                Some(Who::Squad { id }) => self.squads.get(*id as usize).is_some_and(|s| s.team == team && s.kind == Kind::Captain),
                _ => false,
            },
        }
    }

    /// Queues `deed` until `until` fires (08-orders.md §6): in the queue of the company it names, or its army's
    /// when it is for the army (or names no company). Several companies wait each in its own queue.
    pub(super) fn wait(&mut self, team: Team, until: When, deed: Deed) -> Result<(), Refused> {
        match &until {
            When::After { s } if !s.is_finite() || *s < 0.0 => return Err((self.here(team), "wait: a time of 0 s or more".into())),
            When::EnemyNear { r, at } if !r.is_finite() || *r <= 0.0 || !at.x.is_finite() || !at.y.is_finite() => {
                return Err((self.here(team), "wait: a place and a reach".into()));
            }
            When::Breaks { squad } if self.squads.get(*squad as usize).is_none() => return Err((self.here(team), format!("wait: no squad {squad}"))),
            _ => {}
        }
        let squad = match (&deed, who_of(&deed)) {
            (_, Some(Who::Squads { ids })) => {
                if ids.is_empty() {
                    return Err((self.here(team), "no companies named".into()));
                }
                for &id in ids.clone().iter() {
                    self.wait(team, until.clone(), with_who(&deed, Who::Squad { id }))?;
                }
                return Ok(());
            }
            (_, Some(Who::Squad { id })) | (Deed::Recall { id }, _) => {
                let i = self.own(team, *id)?;
                (self.squads[i].kind != Kind::Captain).then_some(i)
            }
            _ => None,
        };
        let p = Pending { deed, when: until, queued: self.tick, signalled: false };
        match squad {
            Some(i) => self.squads[i].queue.push(p),
            None => self.waiting[team as usize & 1].push(p),
        }
        Ok(())
    }

    /// Makes `order` current at once, replacing anything queued (a new direct order); a released waiting deed
    /// keeps the queue. The company's way (`How`) stands.
    pub(crate) fn command(&mut self, i: usize, order: Order) {
        self.command_files(i, order, None);
    }

    /// `command` with a drawn front's frontage for this order.
    pub(crate) fn command_files(&mut self, i: usize, order: Order, files: Option<u16>) {
        if !self.releasing {
            self.squads[i].queue.clear();
        }
        self.set_order(i, order, files);
    }

    /// Makes `order` current, keeping the queue (a released pending order, a rally, the last men pulled out).
    pub(super) fn set_order(&mut self, i: usize, order: Order, files: Option<u16>) {
        let s = &mut self.squads[i];
        if matches!(order, Order::Hold { .. }) {
            s.post = P::new(s.x, s.y);
        }
        if s.kind == Kind::Captain && order != Order::Ride {
            s.ride = super::RideState::default();
        }
        s.files = files;
        s.order = order;
        s.done = false;
        s.working = false;
        s.path.clear();
        self.touched.push(i);
    }

    pub(super) fn here(&self, team: Team) -> P {
        self.captain_at(team).unwrap_or(self.map.deploy[team as usize & 1])
    }

    /// Squad `i`'s anchor.
    pub(super) fn at(&self, i: usize) -> P {
        P::new(self.squads[i].x, self.squads[i].y)
    }

    /// One of `team`'s own squads that can take orders.
    pub(super) fn own(&self, team: Team, id: SquadId) -> Result<usize, Refused> {
        match self.squads.get(id as usize) {
            // The ford's civilians take no orders (places.rs).
            Some(s) if s.team == team && s.kind == Kind::Folk => Err((P::new(s.x, s.y), format!("squad {id} are civilians"))),
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
            // Split by `obey` and `wait` before they get here.
            Who::Squads { .. } => Err((self.here(team), "several companies: one at a time".into())),
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
        self.command(i, order);
        self.squads[i].detached = true;
    }

    /// The companies still with the army (not detached, on the field and not routing), captain excluded.
    fn with_army(&self, team: Team, cap: usize) -> Vec<usize> {
        (0..self.squads.len())
            .filter(|&i| i != cap && self.squads[i].team == team && !self.squads[i].detached && self.squads[i].standing() && self.squads[i].alive > 0)
            .collect()
    }

    /// The army's line: the companies with the army less its reserve, which an army attack leaves behind.
    fn line_of(&self, team: Team, cap: usize) -> Vec<usize> {
        self.with_army(team, cap).into_iter().filter(|&i| self.squads[i].reserve.is_none()).collect()
    }

    /// The captain goes to `to`; each company with the army follows him at its fixed station (§3d).
    pub(super) fn army_to(&mut self, team: Team, cap: usize, to: P, via: Vec<P>, fight: bool, face: Option<f64>) {
        let c = &self.squads[cap];
        let heading = if to.dist(P::new(c.x, c.y)) > 0.0 { atan2(to.y - c.y, to.x - c.x) } else { c.facing };
        let face = face.unwrap_or(heading);
        self.command(cap, Order::Move { to, via, fight, face: Some(face) });
        for i in self.with_army(team, cap) {
            self.command(i, Order::Follow);
        }
    }

    /// Back to its station by the captain, walking out of any fight (04-battle.md §5 "Recall").
    fn recall(&mut self, i: usize) {
        let until = self.tick + (self.tune.morale.recall_s * crate::contracts::TICK_HZ as f64) as u32;
        self.command(i, Order::Recall { until });
        let s = &mut self.squads[i];
        s.detached = false;
        s.threat = None;
        if s.state == SquadState::Fighting {
            s.state = SquadState::Marching;
        }
    }

    /// The reserve is sent in: at `target`, else at the best foe by its priority within reach of a commitment,
    /// else back to its station in the line.
    fn commit(&mut self, i: usize, target: Option<SquadId>) {
        self.squads[i].reserve = None;
        match target.or_else(|| self.best_foe(i, self.tune.orders.commit_r)) {
            Some(t) => self.detach(i, Order::Attack { target: t, via: Vec::new() }),
            None => {
                self.command(i, Order::Follow);
                self.squads[i].detached = false;
            }
        }
    }

    /// The foe squad company `i` would go for by its priority (`Battle::priority_score`) among the foes its side
    /// sees, not routing, within `r`.
    pub(super) fn best_foe(&self, i: usize, r: f64) -> Option<SquadId> {
        let s = &self.squads[i];
        let from = self.centre(i);
        let pri: Priority = s.how.priority;
        let mut best: Option<(f64, usize)> = None;
        for (j, o) in self.squads.iter().enumerate() {
            if o.team == s.team || !o.standing() || o.alive == 0 || from.dist(self.centre(j)) > r {
                continue;
            }
            if !o.soldiers.iter().any(|&k| self.soldiers[k].alive && self.sees(s.team, self.soldiers[k].pos())) {
                continue;
            }
            let score = self.priority_score(s.team, from, j, pri);
            if best.is_none_or(|(b, bj)| score < b || (score == b && j < bj)) {
                best = Some((score, j));
            }
        }
        best.map(|(_, j)| j as SquadId)
    }

    /// The centre of the nearest foe squad standing on the field to squad `i` (its threat first).
    pub(super) fn nearest_foe(&self, i: usize, r: f64) -> Option<P> {
        if let Some(t) = self.squads[i].threat {
            return Some(self.centre(t as usize));
        }
        let (team, from) = (self.squads[i].team, self.centre(i));
        let mut best: Option<(f64, usize)> = None;
        for (j, o) in self.squads.iter().enumerate() {
            if o.team == team || !o.standing() || o.alive == 0 {
                continue;
            }
            let d = from.dist(self.centre(j));
            if d <= r && best.is_none_or(|(b, bj)| d < b || (d == b && j < bj)) {
                best = Some((d, j));
            }
        }
        best.map(|(_, j)| self.centre(j))
    }

    /// Where a withdrawal goes: `to`, or `withdraw_d` straight back from the nearest foe (the threat point when
    /// none stands near).
    fn withdraw_point(&self, i: usize, to: Option<P>) -> P {
        if let Some(p) = to {
            return self.open_near(p);
        }
        let c = self.centre(i);
        let foe = self.nearest_foe(i, self.tune.orders.screen_r).unwrap_or_else(|| self.threat_point(self.squads[i].team, c));
        let d = c.dist(foe);
        let away = if d > 1e-9 { P::new((c.x - foe.x) / d, (c.y - foe.y) / d) } else { P::from_angle(self.squads[i].facing + std::f64::consts::PI) };
        let back = self.tune.orders.withdraw_d;
        self.inside(P::new(c.x + away.x * back, c.y + away.y * back))
    }

    /// `p` kept `edge_keep` inside the map's sides (half that from the top and bottom), on open ground.
    fn inside(&self, p: P) -> P {
        let m = self.tune.orders.edge_keep;
        self.open_near(P::new(p.x.clamp(m, self.map.wf() - m), p.y.clamp(m / 2.0, self.map.hf() - m / 2.0)))
    }

    /// Behind the line: `regroup_back` from the centre of the side's other companies (the captain alone if none),
    /// away from the threat.
    fn regroup_point(&self, i: usize) -> P {
        let team = self.squads[i].team;
        let others: Vec<usize> = (0..self.squads.len()).filter(|&j| j != i && self.squads[j].team == team && self.squads[j].standing() && self.squads[j].kind != Kind::Captain && !self.civilian(j)).collect();
        let line = if others.is_empty() {
            self.captain_at(team).unwrap_or(self.centre(i))
        } else {
            let n = others.len() as f64;
            let (x, y) = others.iter().fold((0.0, 0.0), |(x, y), &j| (x + self.centre(j).x, y + self.centre(j).y));
            P::new(x / n, y / n)
        };
        let threat = self.threat_point(team, line);
        let d = line.dist(threat);
        let away = if d > 1e-9 { P::new((line.x - threat.x) / d, (line.y - threat.y) / d) } else { P::from_angle(self.armies[team as usize & 1].heading + std::f64::consts::PI) };
        let back = self.tune.orders.regroup_back;
        self.inside(P::new(line.x + away.x * back, line.y + away.y * back))
    }
}
