//! The broodlord's intents (docs/spec/06-voice.md §8, 00-start-here.md §A3 "2. The enemy's mind"): the local model
//! decides only where to go, whom to attack, when to sally or pull back; the bots carry it out between its calls.
//!
//! An intent arrives as a `Command` for the bot's own side with `src: Source::Brain`, already resolved and validated
//! in code (web/src/voice/broodlord). The bot reads it from the battle's log, so a replay (the seed plus the log,
//! the bots re-run) reaches the very same intents without any model. While an intent stands:
//! - the bot's own plan leaves its companies alone (they are out of its roles, and any deed of its own for them is
//!   dropped; a front the general draws gathers every company, so the intents are given again right after it);
//! - the bot carries it out: a company sent to a place fighting attacks what comes near the place, then goes back
//!   to it; one sent to attack a foe takes the next foe near it when that one breaks or falls; one sent to take a
//!   place holds it once taken; one pulled back keeps walking out of the fight.
//!
//! An intent lapses `IntentTune::lapse_s` after the brain last gave it, or when its company breaks, and the bot's own
//! plan takes the company back (the general recalls it to the army when it is out of the fight). With no brain
//! commands in the log nothing here changes what a bot does.

use super::{BotKind, Orders, Seen, nearest, seen};
use crate::battle::{Battle, Order, SquadState};
use crate::contracts::{Deed, P, SiteId, Source, SquadId, Team, Tick, Who};

/// What the brain asked of one company, as the bot carries it out.
#[derive(Clone, Debug, PartialEq)]
pub enum Aim {
    /// Go to `to`: a move, or holding a place (ready to fight), or pulling back to it (`fight` false).
    Go { to: P, fight: bool },
    /// Attack (or charge) this foe.
    Attack { target: SquadId },
    /// Take this site, then hold it.
    Take { site: SiteId },
    /// Anything else (hold here, withdraw, regroup, guard, screen…): the company is left to its order.
    Leave,
}

/// One company's intent.
#[derive(Clone, Debug, PartialEq)]
pub struct Intent {
    pub squad: SquadId,
    pub aim: Aim,
    /// The brain's deed, for this company alone.
    pub deed: Deed,
    /// The tick the brain gave it (its command's tick in the log).
    pub from: Tick,
    /// It lapses at this tick.
    pub until: Tick,
}

/// What a bot remembers of the brain's intents.
#[derive(Clone, Debug, Default)]
pub struct Intents {
    /// How far into the battle's log the brain's commands have been read.
    read: usize,
    /// One per company under an intent, in squad id order.
    pub list: Vec<Intent>,
    /// An order from the brain to the whole army holds the bot's own army orders (fronts, rides) until this tick.
    pub army_until: Option<Tick>,
}

fn ticks(s: f64) -> Tick {
    (s * crate::contracts::TICK_HZ as f64).round() as Tick
}

/// The deed inside any `with` and `wait`.
fn inner(d: &Deed) -> &Deed {
    match d {
        Deed::With { deed, .. } | Deed::Wait { deed, .. } => inner(deed),
        d => d,
    }
}

/// `d` for `who`, through any `with` and `wait`.
fn with_who(d: &Deed, to: Who) -> Deed {
    let mut d = d.clone();
    match &mut d {
        Deed::With { deed, .. } | Deed::Wait { deed, .. } => **deed = with_who(deed, to),
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
        _ => {}
    }
    d
}

/// Who a deed is for, if anyone.
fn who_of(d: &Deed) -> Option<&Who> {
    match inner(d) {
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
        _ => None,
    }
}

/// What a brain deed asks, as an aim. A deed that waits for a trigger is left to the sim's own queue.
fn aim_of(d: &Deed) -> Aim {
    if matches!(d, Deed::Wait { .. }) {
        return Aim::Leave;
    }
    match inner(d) {
        Deed::Move { to, fight, .. } => Aim::Go { to: *to, fight: *fight },
        Deed::Attack { target, .. } | Deed::Charge { target: Some(target), .. } | Deed::Commit { target: Some(target), .. } => Aim::Attack { target: *target },
        Deed::Take { site, .. } => Aim::Take { site: *site },
        _ => Aim::Leave,
    }
}

/// Whether a company's order already goes after `target`.
fn on(order: &Order, target: SquadId) -> bool {
    matches!(order, Order::Attack { target: t, .. } | Order::Charge { target: t } if *t == target)
}

impl Intents {
    /// Reads the brain's commands for `team` logged since the last call (only those applied before this tick, so
    /// a live game and its replay read the same ones at the same think), and returns the companies under an intent
    /// now, in id order.
    pub fn absorb(&mut self, b: &Battle, team: Team) -> Vec<SquadId> {
        let lapse = ticks(b.tune.bots.intent.lapse_s);
        while self.read < b.log.len() && b.log[self.read].tick < b.tick {
            let c = &b.log[self.read];
            self.read += 1;
            if c.src != Source::Brain || c.team != team {
                continue;
            }
            let until = c.tick + lapse;
            let ids: Vec<SquadId> = match who_of(&c.deed) {
                Some(Who::Squad { id }) => vec![*id],
                Some(Who::Squads { ids }) => ids.clone(),
                Some(Who::Army) | None => {
                    // An army order (or a front, a rally): the bot's own army orders wait for it to lapse.
                    self.army_until = Some(until);
                    continue;
                }
            };
            let aim = aim_of(&c.deed);
            for id in ids {
                if b.squads.get(id as usize).is_none_or(|s| s.team != team) {
                    continue;
                }
                self.list.retain(|i| i.squad != id);
                let deed = with_who(&c.deed, Who::Squad { id });
                self.list.push(Intent { squad: id, aim: aim.clone(), deed, from: c.tick, until });
            }
        }
        self.list.sort_by_key(|i| i.squad);
        if self.army_until.is_some_and(|t| b.tick >= t) {
            self.army_until = None;
        }
        self.list.iter().filter(|i| b.tick < i.until && b.squads[i.squad as usize].standing()).map(|i| i.squad).collect()
    }

    /// Whether the bot's own `deed` must give way to an intent: it orders a company under one, or it is an army
    /// order while the brain's army order stands.
    pub fn blocks(&self, held: &[SquadId], deed: &Deed) -> bool {
        match who_of(deed) {
            Some(Who::Squad { id }) => held.contains(id),
            Some(Who::Squads { ids }) => ids.iter().any(|id| held.contains(id)),
            Some(Who::Army) => self.army_until.is_some(),
            None => matches!(inner(deed), Deed::Front { .. }) && self.army_until.is_some(),
        }
    }

    /// Carries the intents out for this thought, after the bot's own plan, and lets lapsed ones go.
    pub(crate) fn carry_out(&mut self, b: &Battle, team: Team, kind: BotKind, out: &mut Orders) {
        if self.list.is_empty() {
            return;
        }
        let t = b.tune.bots.intent.clone();
        let foes: Vec<Seen> = seen(b, team).into_iter().filter(|f| !f.routing).collect();
        let mut lapsed: Vec<SquadId> = Vec::new();
        self.list.retain(|i| {
            let keep = b.tick < i.until && b.squads[i.squad as usize].standing();
            if !keep {
                lapsed.push(i.squad);
            }
            keep
        });
        // The general fights with its army: a company it gets back out of the fight rejoins it.
        if let BotKind::General(_) = kind {
            let contact = b.tune.bots.general.contact_r;
            for id in lapsed {
                let i = id as usize;
                let s = &b.squads[i];
                if s.standing() && s.detached && s.state != SquadState::Fighting && nearest(&foes, b.centre(i), contact).is_none() {
                    out.push_always(Deed::Recall { id });
                }
            }
        }
        // A front the bot drew this thought gathers every company, those under an intent too: they get it again.
        let front = out.deeds.iter().any(|d| matches!(d, Deed::Front { .. }));
        for it in &mut self.list {
            let i = it.squad as usize;
            if front {
                let who = Who::Squad { id: it.squad };
                out.push_always(match it.aim {
                    Aim::Go { to, fight } => Deed::Move { who, to, via: Vec::new(), fight, face: None },
                    Aim::Attack { target } if b.squads[target as usize].standing() => Deed::Attack { who, target, via: Vec::new() },
                    Aim::Take { site } if b.sites.get(site as usize).is_some_and(|s| s.owner != Some(team)) => Deed::Take { who, site, via: Vec::new() },
                    Aim::Attack { .. } | Aim::Take { .. } => Deed::Hold { who },
                    Aim::Leave => it.deed.clone(),
                });
                continue;
            }
            let s = &b.squads[i];
            let id = s.id;
            let who = Who::Squad { id };
            let here = b.centre(i);
            let fighting = s.state == SquadState::Fighting;
            let strike = |out: &mut Orders, f: &Seen| out.push(b, Deed::Attack { who: who.clone(), target: f.id, via: Vec::new() });
            match it.aim.clone() {
                Aim::Go { to, fight } => {
                    if fight && fighting {
                        continue;
                    }
                    // Holding a place: whatever comes near it is attacked, then the company goes back to it.
                    if fight && let Some(f) = nearest(&foes, to, t.guard_r) {
                        if !on(&s.order, f.id) {
                            strike(out, f);
                        }
                        continue;
                    }
                    out.push(b, Deed::Move { who, to, via: Vec::new(), fight, face: None });
                }
                Aim::Attack { target } => {
                    let them = &b.squads[target as usize];
                    if them.standing() {
                        if !on(&s.order, target) {
                            out.push(b, Deed::Attack { who, target, via: Vec::new() });
                        }
                        continue;
                    }
                    // It broke or fell: the next foe near the company, else stand.
                    if let Some(f) = nearest(&foes, here, t.follow_r) {
                        it.aim = Aim::Attack { target: f.id };
                        strike(out, f);
                    } else if !fighting {
                        out.push(b, Deed::Hold { who });
                    }
                }
                Aim::Take { site } => {
                    let Some(place) = b.map.sites.get(site as usize) else { continue };
                    let at = place.at;
                    if b.sites[site as usize].owner != Some(team) {
                        if !fighting && !matches!(&s.order, Order::Take { site: x, .. } if *x == site) {
                            out.push(b, Deed::Take { who, site, via: Vec::new() });
                        }
                        continue;
                    }
                    // Taken: held, against whatever comes near it.
                    if fighting {
                        continue;
                    }
                    if let Some(f) = nearest(&foes, at, t.guard_r) {
                        if !on(&s.order, f.id) {
                            strike(out, f);
                        }
                    } else if here.dist(at) > t.hold_r {
                        out.push(b, Deed::Move { who, to: b.open_near(at), via: Vec::new(), fight: true, face: None });
                    }
                }
                Aim::Leave => {}
            }
        }
    }
}
