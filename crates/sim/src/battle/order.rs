//! The order model (docs/spec/08-orders.md §1, §3, §5, §6; 04-battle.md §1 "Orders"). A squad's order is a verb
//! (`Order`) plus the modifiers every verb shares (`How`), with a queue of pending orders, each released by a
//! trigger (`When`). Stances are read in one place, `Battle::rules`; target priorities are scored in one place,
//! `Battle::priority_score`, which the men, the squads and the bots all use.
//!
//! The Deeds that reach these from the order queue are the spec's seven for now; the order-language pass adds the
//! rest (out/decisions-battle.md, "The order model").

use serde::{Deserialize, Serialize};

use super::{Battle, SquadState};
use crate::contracts::{Kind, P, SquadId, Team, Tick, Way};
use crate::units::Unit;

/// The verb: what a squad is doing.
#[derive(Clone, Debug, PartialEq)]
pub enum Order {
    Hold { face: Option<f64> },
    Move { to: P, via: Vec<P>, fight: bool, face: Option<f64> },
    Attack { target: SquadId, via: Vec<P> },
    Take { site: u16, via: Vec<P> },
    /// With the army: keep the company's fixed station by the captain (04-battle.md §3d).
    Follow,
    /// Escort: stay by a company (or the captain) and defend it (08-orders.md §3 "follow / escort").
    Guard { ward: SquadId },
    /// Back to the station by the captain, never engaging, until within 2 tiles or `until` (§5 "Recall").
    Recall { until: Tick },
    /// Off the field to home: the commander saving the last men (§5).
    Retreat,
    /// The captain's ride (§5).
    Ride,
}

impl Order {
    /// Waypoints still to pass, dropped one by one within 0.9 tiles (04-battle.md §3b).
    pub fn via(&self) -> &[P] {
        match self {
            Order::Move { via, .. } | Order::Attack { via, .. } | Order::Take { via, .. } => via,
            _ => &[],
        }
    }

    pub(super) fn via_mut(&mut self) -> Option<&mut Vec<P>> {
        match self {
            Order::Move { via, .. } | Order::Attack { via, .. } | Order::Take { via, .. } => Some(via),
            _ => None,
        }
    }
}

/// How a squad engages (08-orders.md §5 "stance"). `Normal` is 04-battle.md §5 exactly.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stance {
    #[default]
    Normal,
    /// Engage further, seek further, pursue routers.
    Aggressive,
    /// Hold ground: fight only what reaches the squad, never leave the post by more than the leash.
    Defensive,
    /// Archers don't shoot; men strike only what reaches them.
    HoldFire,
    /// Ranged keep their distance and fall back from melee.
    Skirmish,
    /// Never engage as a squad (a march without `fight`); anyone touched still fights back.
    Passive,
}

/// Which foes a squad and its men prefer (08-orders.md §5 "priority"; §4 "targets").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Priority {
    #[default]
    Nearest,
    /// "their archers", "the horse".
    Kind { kind: Kind },
    /// "the drakes", "the big ones" (trolls), "the blight-men": one unit (08-orders.md §4).
    Unit { unit: Unit },
    /// Any company with range.
    Ranged,
    /// "the most shaken": lowest morale share.
    Shaken,
    /// "the weakest": least men × worth left.
    Weakest,
    /// "their strongest".
    Strongest,
    /// "their commander": the captain first, then companies with a commander alive.
    Commander,
    /// "the ones attacking the mill / Oda": foes whose men are striking that company.
    Attacking { id: SquadId },
    /// One company by id.
    Squad { id: SquadId },
}

/// The formation's shape (08-orders.md §3 "form"); frontage is `How::files`, spacing `How::spacing`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Shape {
    #[default]
    Block,
    /// Rank r holds 2r+1 men, the point at the anchor.
    Wedge,
    /// A ring round a point behind the anchor; every man faces out.
    Ring,
}

/// The modifiers every verb shares (08-orders.md §5). `How::default()` is 04-battle.md's behaviour.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct How {
    pub stance: Stance,
    /// Chase routers; `None` keeps the stance's default (only Aggressive pursues).
    pub pursue: Option<bool>,
    /// A share of the squad's speed (walk, quick, double time); `None` is the spec's pace.
    pub pace: Option<f64>,
    pub shape: Shape,
    /// Frontage override (a drawn line's `files`).
    pub files: Option<u16>,
    /// The file gap ×this (loose, tight).
    pub spacing: Option<f64>,
    pub priority: Priority,
}

/// What releases a pending order (08-orders.md §6). Every trigger reads only sim state; signals arrive as
/// Commands through the queue, so replays stay exact.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum When {
    /// When the current order completes (arrived, taken, target gone, recalled).
    Done,
    /// On the player's signal `n` ("on my mark… now!").
    Signal { n: u16 },
    /// `s` seconds after it was queued.
    After { s: f64 },
    /// An enemy within `r` of a point.
    EnemyNear { at: P, r: f64 },
    /// That company routs, flees or is destroyed.
    Breaks { id: SquadId },
    /// The captain was hit in the last second.
    CaptainAttacked,
    /// Nightfall (day 4's night; never yet).
    Night,
}

/// An order waiting in a squad's queue.
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub order: Order,
    pub how: How,
    pub when: When,
    pub queued: Tick,
}

/// The engagement rules a squad follows this tick: every stance and order check lives here.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rules {
    /// The squad takes on threats within this (0: never engages as a squad). Ranged add the height bonus.
    pub engage: f64,
    /// A man's seek range while his squad fights.
    pub seek: f64,
    /// Men take only foes already in reach.
    pub reach_only: bool,
    /// Ranged men loose arrows.
    pub fire: bool,
    /// Chase routers (no routing penalty in target choice).
    pub pursue: bool,
    /// Stay within `.1` of `.0`.
    pub leash: Option<(P, f64)>,
    /// Ranged fall back from melee foes within this.
    pub skirmish: Option<f64>,
    /// No charges (a recall).
    pub no_charge: bool,
}

impl Battle {
    /// The rules for squad `i` from its order, its state and its stance (08-orders.md §5).
    pub fn rules(&self, i: usize) -> Rules {
        let s = &self.squads[i];
        let c = &self.tune.combat;
        let st = &self.tune.stance;
        let reckless = s.way() == Some(Way::Reckless);
        let base = if s.spec.ranged() { s.spec.range } else { c.melee + if reckless { c.reckless_engage } else { 0.0 } };
        let seek = c.seek_min.max(base + c.seek_extra);
        let mut r = Rules {
            engage: if self.may_engage(i) { base } else { 0.0 },
            seek,
            reach_only: false,
            fire: true,
            pursue: false,
            leash: None,
            skirmish: None,
            no_charge: matches!(s.order, Order::Recall { .. }),
        };
        match s.how.stance {
            Stance::Normal => {}
            Stance::Aggressive => {
                if r.engage > 0.0 {
                    r.engage += st.aggressive_extra;
                }
                r.seek += st.aggressive_extra;
                r.pursue = true;
            }
            Stance::Defensive => {
                if !s.spec.ranged() {
                    r.engage = r.engage.min(c.reach + c.walk_line_beyond);
                }
                r.leash = Some((s.post, st.leash));
            }
            Stance::HoldFire => {
                r.fire = false;
                r.engage = r.engage.min(c.reach);
                r.reach_only = true;
            }
            Stance::Skirmish => {
                if s.spec.ranged() {
                    r.skirmish = Some(st.skirmish_r);
                }
            }
            Stance::Passive => r.engage = 0.0,
        }
        if r.engage == 0.0 {
            r.reach_only = true;
        }
        if let Some(p) = s.how.pursue {
            r.pursue = p;
        }
        r
    }

    /// 04-battle.md §5 "Who may engage": not a march without fight, not a retreat, not a recall; a follower
    /// engages when its army's march fights or it stands at its station; 08-orders' escort defends its ward.
    fn may_engage(&self, i: usize) -> bool {
        let s = &self.squads[i];
        match &s.order {
            Order::Retreat | Order::Recall { .. } => false,
            // Riding round to the flank he does not stop to fight; he goes in once there.
            Order::Ride => !s.ride.out && (s.ride.target.is_none() || s.ride.went_in),
            // A move is always on its way (arrival turns it into a hold): it engages only if it fights.
            Order::Move { fight, .. } => *fight,
            Order::Follow => !s.following || self.army_fights(s.team),
            _ => true,
        }
    }

    /// Whether the captain's current order fights on the way.
    pub(super) fn army_fights(&self, team: Team) -> bool {
        match self.captain_of(team).map(|c| &self.squads[c].order) {
            Some(Order::Move { fight, .. }) => *fight,
            Some(Order::Hold { .. } | Order::Attack { .. } | Order::Take { .. } | Order::Ride) => true,
            _ => false,
        }
    }

    /// The priority score of foe squad `j` seen from `from` (lower is better): the distance, less
    /// `priority_bonus` for a favoured foe, or scaled by the measure the priority names.
    pub fn priority_score(&self, team: Team, from: P, j: usize, pri: Priority) -> f64 {
        let f = &self.squads[j];
        let d = from.dist(self.centre(j));
        let bonus = self.tune.stance.priority_bonus;
        let fav = |yes: bool| if yes { d - bonus } else { d };
        match pri {
            Priority::Nearest => d,
            Priority::Kind { kind } => fav(f.kind == kind),
            Priority::Unit { unit } => fav(f.unit == unit),
            Priority::Ranged => fav(f.spec.ranged()),
            Priority::Squad { id } => fav(f.id == id),
            Priority::Shaken => d + bonus * f.morale_share(),
            Priority::Weakest | Priority::Strongest => {
                let most = self
                    .squads
                    .iter()
                    .filter(|o| o.team != team && o.on_field())
                    .map(|o| o.strength(&self.tune))
                    .fold(1e-9, f64::max);
                let share = f.strength(&self.tune) / most;
                if pri == Priority::Weakest { d + bonus * share } else { d - bonus * share }
            }
            Priority::Commander => fav(f.kind == Kind::Captain || f.leader.is_some()),
            Priority::Attacking { id } => fav(self.attackers_of(id).contains(&f.id)),
        }
    }

    /// The foe squads whose living men are striking company `id`.
    pub fn attackers_of(&self, id: SquadId) -> Vec<SquadId> {
        let mut out: Vec<SquadId> = Vec::new();
        for m in self.soldiers.iter().filter(|m| m.alive) {
            if let Some(t) = m.target
                && self.soldiers[t].squad == id
                && !out.contains(&m.squad)
            {
                out.push(m.squad);
            }
        }
        out.sort_unstable();
        out
    }

    /// Whether a pending order's trigger holds now.
    pub(super) fn triggered(&self, i: usize, p: &Pending) -> bool {
        let s = &self.squads[i];
        match &p.when {
            When::Done => s.done,
            When::Signal { n } => self.signals[s.team as usize].iter().any(|&(k, at)| k == *n && at >= p.queued),
            When::After { s: secs } => (self.tick - p.queued) as f64 * super::DT >= *secs,
            When::EnemyNear { at, r } => self.soldiers.iter().any(|m| m.alive && self.squads[m.squad as usize].team != s.team && m.pos().dist(*at) <= *r),
            When::Breaks { id } => self.squads.get(*id as usize).is_some_and(|o| !matches!(o.state, SquadState::Idle | SquadState::Marching | SquadState::Fighting)),
            When::CaptainAttacked => self.captain_of(s.team).is_some_and(|c| {
                let m = &self.soldiers[self.squads[c].soldiers[0]];
                m.hit_at != Tick::MAX && self.tick.saturating_sub(m.hit_at) <= super::TICK_HZ
            }),
            When::Night => self.night,
        }
    }

    /// Releases the first pending order of every squad whose trigger holds (tick step 2, before the anchors).
    pub(super) fn release_pending(&mut self) {
        for i in 0..self.squads.len() {
            if self.squads[i].queue.is_empty() || !self.squads[i].on_field() || self.squads[i].state == SquadState::Routing {
                continue;
            }
            let p = self.squads[i].queue[0].clone();
            if self.triggered(i, &p) {
                self.squads[i].queue.remove(0);
                self.set_order(i, p.order, p.how);
            }
        }
    }

    /// Queues `order` for squad `i`, released by `when` (08-orders.md §6). Signals and conditions are evaluated
    /// in the tick from sim state only.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn queue_order(&mut self, i: usize, order: Order, how: How, when: When) {
        let queued = self.tick;
        self.squads[i].queue.push(Pending { order, how, when, queued });
    }

    /// Raises signal `n` for `team` ("now!"): waiting orders with that signal run this tick.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn raise_signal(&mut self, team: Team, n: u16) {
        self.signals[team as usize].push((n, self.tick));
    }
}

/// A commander's way, if the company has a living commander with one.
impl super::Squad {
    pub fn way(&self) -> Option<Way> {
        if self.leader.is_some() { self.way } else { None }
    }
}
