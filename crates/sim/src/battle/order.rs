//! The order model (docs/spec/08-orders.md §1, §3, §5, §6; 04-battle.md §1 "Orders"). A squad's order is a verb
//! (`Order`) plus the standing modifiers every verb shares (`How`), with a queue of waiting deeds, each released by
//! a trigger (`When`). Stances are read in one place, `Battle::rules`; target priorities are scored in one place,
//! `Battle::priority_score`, which the men, the squads and the bots all use.
//!
//! A company's way (`How`) stands until changed: `Set` changes it with no new order, `With` changes it for the
//! companies its deed orders, and unset fields keep what the company had (out/decisions-orders-sim.md).

use serde::{Deserialize, Serialize};

use super::{Battle, SquadState};
use crate::contracts::{self, Deed, Kind, P, SquadId, Team, Tick, Way};
use crate::tune::Tune;
use crate::units::Unit;

pub use crate::contracts::{Pace, When};

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
    /// Stand between `ward` and the nearest threat, or `from` (08-orders.md §3 "screen / cover").
    Screen { ward: SquadId, from: Option<SquadId> },
    /// Attack now, the cohesion gate ignored (08-orders.md §3 "charge").
    Charge { target: SquadId },
    /// Fall back fighting to `to`, still facing the foe (08-orders.md §3 "withdraw").
    Withdraw { to: P },
    /// Fall back behind the line to `to`, out of the fight, to recover morale (08-orders.md §3 "regroup").
    Regroup { to: P },
    /// Build (or help build) field work `work`, standing at `at` (08-orders.md §7).
    Build { work: u16, at: P },
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

    /// A short name, for the harness and logs.
    pub fn name(&self) -> &'static str {
        match self {
            Order::Hold { .. } => "hold",
            Order::Move { .. } => "move",
            Order::Attack { .. } => "attack",
            Order::Take { .. } => "take",
            Order::Follow => "follow",
            Order::Guard { .. } => "guard",
            Order::Recall { .. } => "recall",
            Order::Retreat => "retreat",
            Order::Ride => "ride",
            Order::Screen { .. } => "screen",
            Order::Charge { .. } => "charge",
            Order::Withdraw { .. } => "withdraw",
            Order::Regroup { .. } => "regroup",
            Order::Build { .. } => "build",
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

impl From<contracts::Stance> for Stance {
    fn from(s: contracts::Stance) -> Stance {
        match s {
            contracts::Stance::Normal => Stance::Normal,
            contracts::Stance::Aggressive => Stance::Aggressive,
            contracts::Stance::Defensive => Stance::Defensive,
            contracts::Stance::HoldFire => Stance::HoldFire,
            contracts::Stance::Skirmish => Stance::Skirmish,
        }
    }
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
    /// "the weakest" or "the most shaken": least men × worth × morale share left.
    Weakest,
    /// "their strongest".
    Strongest,
    /// "their commander", "the broodlord": the captain first, then companies with a commander alive.
    Commander,
    /// "the ones attacking the mill / Oda": foes whose men are striking that company.
    Attacking { id: SquadId },
    /// One company by id.
    Squad { id: SquadId },
}

impl Priority {
    /// The contract's priority (08-orders.md §4–§5) in the sim's terms; `None` for a unit id that is not one.
    pub fn from_contract(p: contracts::Priority) -> Option<Priority> {
        Some(match p {
            contracts::Priority::Nearest => Priority::Nearest,
            contracts::Priority::Unit { unit } => Priority::Unit { unit: *Unit::ALL.get(unit as usize)? },
            contracts::Priority::Weakest => Priority::Weakest,
            contracts::Priority::Strongest => Priority::Strongest,
            contracts::Priority::Commander => Priority::Commander,
            contracts::Priority::Attacking { squad } => Priority::Attacking { id: squad },
        })
    }
}

/// The formation's shape (08-orders.md §3 "form"): its geometry and default frontage. Spacing is `How::spacing`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Shape {
    /// §3a's block at the kind's own frontage.
    #[default]
    Block,
    /// A block `orders.line_ranks` deep.
    Line,
    /// A block `orders.column_files` wide.
    Column,
    /// Rank r holds 2r+1 men, the point at the anchor.
    Wedge,
    /// A ring round a point behind the anchor ("square"); every man faces out.
    Ring,
    /// A line `orders.line_ranks` deep at the tight spacing.
    ShieldWall,
}

/// The standing modifiers every verb shares (08-orders.md §5). `How::default()` is 04-battle.md's behaviour.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct How {
    pub stance: Stance,
    /// Chase routers; `None` keeps the stance's default (only Aggressive pursues).
    pub pursue: Option<bool>,
    /// Walk or double time; `None` is the spec's pace (quick).
    pub pace: Option<Pace>,
    pub shape: Shape,
    /// Files in the front rank ("thin", "deep"); a drawn front's own frontage (`Squad::files`) comes first.
    pub files: Option<u16>,
    /// The file gap ×this (loose, tight).
    pub spacing: Option<f64>,
    pub priority: Priority,
}

impl How {
    /// Merges the contract's modifiers onto this way: unset fields keep what it had. A new shape clears a standing
    /// frontage unless `files` comes with it; loose and tight change only the spacing.
    pub fn merge(&mut self, h: &contracts::How, tune: &Tune) -> Result<(), String> {
        let priority = match h.priority {
            Some(p) => Some(Priority::from_contract(p).ok_or_else(|| format!("no unit {p:?}"))?),
            None => None,
        };
        if h.files == Some(0) {
            return Err("files: at least 1".into());
        }
        if let Some(s) = h.stance {
            self.stance = s.into();
        }
        if let Some(p) = h.pace {
            self.pace = if p == Pace::Quick { None } else { Some(p) };
        }
        if let Some(shape) = h.shape {
            let mv = &tune.movement;
            match shape {
                contracts::Shape::Loose => self.spacing = Some(mv.loose_spacing),
                contracts::Shape::Tight => self.spacing = Some(mv.tight_spacing),
                other => {
                    self.shape = match other {
                        contracts::Shape::Line => Shape::Line,
                        contracts::Shape::Column => Shape::Column,
                        contracts::Shape::Wedge => Shape::Wedge,
                        contracts::Shape::Square => Shape::Ring,
                        _ => Shape::ShieldWall,
                    };
                    self.spacing = None;
                    self.files = None;
                }
            }
        }
        if let Some(f) = h.files {
            self.files = Some(f);
        }
        if let Some(p) = h.pursue {
            self.pursue = Some(p);
        }
        if let Some(p) = priority {
            self.priority = p;
        }
        Ok(())
    }

    /// The pace as a share of the company's speed.
    pub fn pace_k(&self, tune: &Tune) -> f64 {
        let o = &tune.orders;
        match self.pace {
            None | Some(Pace::Quick) => o.pace_quick,
            Some(Pace::Walk) => o.pace_walk,
            Some(Pace::Double) => o.pace_double,
        }
    }
}

/// A deed waiting for its trigger (08-orders.md §6), in a company's queue or its army's.
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub deed: Deed,
    pub when: When,
    pub queued: Tick,
    /// Its signal was given (a `Signal` command after it was queued).
    pub signalled: bool,
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
    /// No charges (a recall, a regroup, a withdrawal).
    pub no_charge: bool,
    /// Men strike at all: a company at work on a field work cannot fight (08-orders.md §7).
    pub strike: bool,
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
            no_charge: matches!(s.order, Order::Recall { .. } | Order::Regroup { .. } | Order::Withdraw { .. }),
            strike: true,
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
        // The reserve is held back: it fights only what reaches it (08-orders.md §3 "reserve").
        if s.reserve.is_some() && !s.spec.ranged() {
            r.engage = r.engage.min(c.reach + c.walk_line_beyond);
        }
        // At work on a field work it cannot fight (08-orders.md §7).
        if s.working {
            r.engage = 0.0;
            r.fire = false;
            r.strike = false;
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
    /// engages when its army's march fights or it stands at its station; 08-orders' escort defends its ward. A
    /// withdrawal, a regroup and a company going to build strike only in passing.
    fn may_engage(&self, i: usize) -> bool {
        let s = &self.squads[i];
        match &s.order {
            Order::Retreat | Order::Recall { .. } | Order::Withdraw { .. } | Order::Regroup { .. } | Order::Build { .. } => false,
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

    /// The pace of squad `i` as a share of its speed (08-orders.md §5 "pace").
    pub(super) fn pace_k(&self, i: usize) -> f64 {
        self.squads[i].how.pace_k(&self.tune)
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
                let worth = |o: &super::Squad| o.strength(&self.tune) * if pri == Priority::Weakest { o.morale_share() } else { 1.0 };
                let most = self.squads.iter().filter(|o| o.team != team && o.on_field()).map(worth).fold(1e-9, f64::max);
                let share = worth(f) / most;
                if pri == Priority::Weakest { d + bonus * share } else { d - bonus * share }
            }
            Priority::Commander => {
                if f.kind == Kind::Captain {
                    d - bonus
                } else if f.leader.is_some() {
                    d - bonus / 2.0
                } else {
                    d
                }
            }
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

    /// Whether a waiting deed of `team` fires now; `done` is whether its company's (or its army's captain's)
    /// current order has completed.
    pub(super) fn fires(&self, team: Team, done: bool, p: &Pending) -> bool {
        match &p.when {
            When::Done => done,
            When::Signal { .. } => p.signalled,
            When::After { s } => self.tick.saturating_sub(p.queued) as f64 * super::DT >= *s,
            When::EnemyNear { at, r } => {
                let mut near = false;
                self.grid.visit(*at, *r, |k| {
                    let m = &self.soldiers[k];
                    near |= m.alive && self.squads[m.squad as usize].team != team && m.pos().dist(*at) <= *r;
                });
                near
            }
            When::Breaks { squad } => self.squads.get(*squad as usize).is_some_and(|o| matches!(o.state, SquadState::Routing | SquadState::Fled | SquadState::Destroyed)),
            When::CaptainAttacked => self.captain_of(team).is_some_and(|c| {
                let m = &self.soldiers[self.squads[c].soldiers[0]];
                m.hit_at != Tick::MAX && self.tick.saturating_sub(m.hit_at) <= super::TICK_HZ
            }),
            When::Nightfall => self.night,
            When::Dawn => self.dawn,
        }
    }

    /// Tick step 2, before the anchors: for every company (in id order), then every army, the first waiting deed
    /// whose trigger holds is carried out, keeping the rest of the queue.
    pub(super) fn release_pending(&mut self) {
        for i in 0..self.squads.len() {
            let s = &self.squads[i];
            if s.queue.is_empty() || !s.standing() {
                continue;
            }
            let (team, done) = (s.team, s.done);
            let Some(k) = s.queue.iter().position(|p| self.fires(team, done, p)) else { continue };
            let p = self.squads[i].queue.remove(k);
            self.release(team, &p.deed);
        }
        for team in 0..2u8 {
            if self.waiting[team as usize].is_empty() {
                continue;
            }
            let done = self.captain_of(team).is_some_and(|c| self.squads[c].done);
            let Some(k) = self.waiting[team as usize].iter().position(|p| self.fires(team, done, p)) else { continue };
            let p = self.waiting[team as usize].remove(k);
            self.release(team, &p.deed);
        }
    }

    /// A waiting deed runs: obeyed as if given now, except that it keeps the queues it lands in.
    fn release(&mut self, team: Team, deed: &Deed) {
        self.releasing = true;
        let r = self.obey(team, deed);
        self.releasing = false;
        if let Err((at, why)) = r {
            self.refuse(team, at, why);
        }
    }

    /// Raises signal `n` for `team` ("now!"): its waiting deeds on that signal run this tick (08-orders.md §6).
    pub(crate) fn raise_signal(&mut self, team: Team, n: u8) {
        let on = |p: &mut Pending| {
            if p.when == (When::Signal { n }) {
                p.signalled = true;
            }
        };
        for s in self.squads.iter_mut().filter(|s| s.team == team) {
            s.queue.iter_mut().for_each(on);
        }
        self.waiting[team as usize & 1].iter_mut().for_each(on);
    }
}

/// A commander's way, if the company has a living commander with one.
impl super::Squad {
    pub fn way(&self) -> Option<Way> {
        if self.leader.is_some() { self.way } else { None }
    }
}
