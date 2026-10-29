//! Bots (docs/spec/04-battle.md §7, 01-flow.md §8): each plays one side, seeing only through that side's fog, and
//! issues Commands through the order queue like the player; it never mutates the battle. `think` is called every
//! tick; a bot decides internally when to think. Bots are deterministic: their only state is what they
//! remember from earlier thinking.
//!
//! Enemy: `garrison` (defending a place) and `general` at skills 0/1/2 (open field). Warband: `commander` (a
//! sensible general that also takes the keep), `charge` (mindless: every company attacks the nearest foe) and
//! `idle`. `raiders` hunt the ford's civilians (day 4).

mod garrison;
mod general;
mod raiders;

use crate::battle::{Battle, Order};
use crate::contracts::{Command, Deed, Kind, P, Source, SquadId, Team, Tick, Who};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BotKind {
    Garrison,
    /// Skill 0, 1 or 2.
    General(u8),
    Commander,
    Charge,
    Idle,
    /// The ford's raiders (04-battle.md §7).
    Raiders,
}

impl BotKind {
    /// `garrison`, `general0`..`general2` (`general` is skill 1), `commander`, `charge`, `idle`, `raiders`.
    pub fn parse(s: &str) -> Result<BotKind, String> {
        Ok(match s {
            "garrison" => BotKind::Garrison,
            "general" | "general1" => BotKind::General(1),
            "general0" => BotKind::General(0),
            "general2" => BotKind::General(2),
            "commander" => BotKind::Commander,
            "charge" => BotKind::Charge,
            "idle" => BotKind::Idle,
            "raiders" => BotKind::Raiders,
            _ => return Err(format!("no bot {s} (garrison, general0..2, commander, charge, idle, raiders)")),
        })
    }

    pub fn name(self) -> String {
        match self {
            BotKind::Garrison => "garrison".into(),
            BotKind::General(k) => format!("general{k}"),
            BotKind::Commander => "commander".into(),
            BotKind::Charge => "charge".into(),
            BotKind::Idle => "idle".into(),
            BotKind::Raiders => "raiders".into(),
        }
    }
}

/// A foe squad as one side sees it: only its men standing on tiles in sight.
#[derive(Clone, Debug, PartialEq)]
pub struct Seen {
    pub id: SquadId,
    pub kind: Kind,
    /// The centroid of its visible men.
    pub at: P,
    pub men: usize,
    pub routing: bool,
    pub fighting: bool,
    pub ranged: bool,
    pub captain: bool,
    /// Its morale share, as its banner shows it.
    pub morale: f64,
}

/// The foe squads `team` sees now, in id order.
pub fn seen(b: &Battle, team: Team) -> Vec<Seen> {
    let mut out = Vec::new();
    for s in b.squads.iter().filter(|s| s.team != team && s.on_field()) {
        let (mut x, mut y, mut n) = (0.0, 0.0, 0usize);
        for &k in &s.soldiers {
            let m = &b.soldiers[k];
            if m.alive && b.sees(team, m.pos()) {
                x += m.x;
                y += m.y;
                n += 1;
            }
        }
        if n > 0 {
            out.push(Seen {
                id: s.id,
                kind: s.kind,
                at: P::new(x / n as f64, y / n as f64),
                men: n,
                routing: s.state == crate::battle::SquadState::Routing,
                fighting: s.state == crate::battle::SquadState::Fighting,
                ranged: s.spec.ranged(),
                captain: s.kind == Kind::Captain,
                morale: s.morale_share(),
            });
        }
    }
    out
}

/// What a bot remembers between thoughts.
#[derive(Clone, Debug, Default)]
pub(crate) struct Memory {
    /// Garrison: each company's first place and facing.
    posts: Vec<(SquadId, P, f64)>,
    /// Garrison: foe men seen, as (tick, where, how many), kept 25 s.
    sightings: Vec<(Tick, P, usize)>,
    sally: Option<garrison::Sally>,
    sally_ready: Tick,
    /// General: the company held back, resting companies, the last front's tick, the last place a foe was seen.
    reserve: Option<SquadId>,
    resting: Vec<SquadId>,
    routed: Vec<SquadId>,
    last_front: Option<Tick>,
    last_seen: Option<P>,
    started: bool,
    /// General (skill 2): the captain is being kept out of the fight.
    captain_out: bool,
    /// General: foe squads as last seen, with the tick.
    known: Vec<(Tick, Seen)>,
}

pub struct Bot {
    pub kind: BotKind,
    pub team: Team,
    next: Tick,
    mem: Memory,
}

impl Bot {
    pub fn new(kind: BotKind, team: Team) -> Bot {
        Bot { kind, team, next: 0, mem: Memory::default() }
    }

    /// Called every tick; returns the commands to apply before the next tick (stamped with this tick).
    pub fn think(&mut self, b: &Battle) -> Vec<Command> {
        if b.outcome().is_some() || b.tick < self.next || self.kind == BotKind::Idle {
            return Vec::new();
        }
        let t = &b.tune.bots;
        let period = match self.kind {
            BotKind::Garrison => t.garrison.think_s,
            BotKind::Raiders => t.raiders.think_s,
            BotKind::General(k) => t.general.think_s[(k as usize).min(2)],
            BotKind::Commander => t.general.think_s[1],
            BotKind::Charge | BotKind::Idle => t.charge_think_s,
        };
        self.next = b.tick + ((period * crate::contracts::TICK_HZ as f64).round() as Tick).max(1);
        let mut out = Orders { deeds: Vec::new() };
        match self.kind {
            BotKind::Garrison => {
                garrison::think(b, self.team, &mut self.mem, &mut out);
                raid_works(b, self.team, &mut out);
            }
            BotKind::General(k) => {
                general::think(b, self.team, k, false, &mut self.mem, &mut out);
                raid_works(b, self.team, &mut out);
            }
            BotKind::Commander => general::think(b, self.team, 1, true, &mut self.mem, &mut out),
            BotKind::Raiders => {
                raiders::think(b, self.team, &mut out);
                raid_works(b, self.team, &mut out);
            }
            BotKind::Charge => charge(b, self.team, &mut out),
            BotKind::Idle => {}
        }
        out.deeds.into_iter().map(|deed| Command { tick: b.tick, team: self.team, deed, src: Source::Bot, note: None }).collect()
    }
}

/// The deeds a bot issues this thought; a deed the squad is already carrying out is dropped (§7: "issue an order
/// only if it differs from the squad's current one").
pub(crate) struct Orders {
    deeds: Vec<Deed>,
}

impl Orders {
    pub(crate) fn push(&mut self, b: &Battle, deed: Deed) {
        if !same(b, &deed) {
            self.deeds.push(deed);
        }
    }

    pub(crate) fn push_always(&mut self, deed: Deed) {
        self.deeds.push(deed);
    }
}

/// Whether `deed` for one squad is what that squad is already doing.
fn same(b: &Battle, deed: &Deed) -> bool {
    let squad = |who: &Who| match who {
        Who::Squad { id } => b.squads.get(*id as usize),
        Who::Army | Who::Squads { .. } => None,
    };
    const NEAR: f64 = 1.0;
    match deed {
        Deed::Move { who, to, fight, .. } => squad(who).is_some_and(|s| match &s.order {
            Order::Move { to: t, fight: f, .. } => t.dist(*to) < NEAR && f == fight,
            Order::Hold { .. } => P::new(s.x, s.y).dist(*to) < NEAR,
            _ => false,
        }),
        Deed::Attack { who, target, .. } => squad(who).is_some_and(|s| matches!(&s.order, Order::Attack { target: t, .. } if t == target)),
        Deed::Take { who, site, .. } => squad(who).is_some_and(|s| matches!(&s.order, Order::Take { site: t, .. } if t == site)),
        Deed::Hold { who } => squad(who).is_some_and(|s| matches!(s.order, Order::Hold { .. })),
        _ => false,
    }
}

/// The side's companies that can take orders (standing, not the captain, not civilians), in id order.
pub(crate) fn companies(b: &Battle, team: Team) -> Vec<usize> {
    (0..b.squads.len())
        .filter(|&i| b.squads[i].team == team && b.squads[i].standing() && b.squads[i].kind != Kind::Captain && b.squads[i].kind != Kind::Folk && b.squads[i].alive > 0)
        .collect()
}

/// The seen foe nearest `from` (ties by id), optionally only within `r`, skipping routers unless nothing else.
pub(crate) fn nearest(seen: &[Seen], from: P, r: f64) -> Option<&Seen> {
    let pick = |routers: bool| {
        seen.iter()
            .filter(|f| f.routing == routers && f.at.dist(from) <= r)
            .min_by(|a, b| a.at.dist(from).total_cmp(&b.at.dist(from)).then(a.id.cmp(&b.id)))
    };
    pick(false).or_else(|| pick(true))
}

/// The seen foe a company at `from` should take within `r` by target priority (08-orders.md §5), scored by the
/// battle's own `priority_score` with the distance to where the foe was seen. Routers only if nothing else.
pub(crate) fn pick<'a>(b: &Battle, team: Team, seen: &'a [Seen], from: P, r: f64, pri: crate::battle::Priority) -> Option<&'a Seen> {
    if pri == crate::battle::Priority::Nearest {
        return nearest(seen, from, r);
    }
    let score = |f: &Seen| {
        let j = f.id as usize;
        f.at.dist(from) + b.priority_score(team, from, j, pri) - from.dist(b.centre(j))
    };
    let best = |routers: bool| {
        seen.iter()
            .filter(|f| f.routing == routers && f.at.dist(from) <= r)
            .min_by(|a, c| score(a).total_cmp(&score(c)).then(a.id.cmp(&c.id)))
    };
    best(false).or_else(|| best(true))
}

/// How a beast company chooses its quarry (04-battle.md §7 "Contact"), or `None` for every other company (and when
/// nothing fits, so the caller's own rule applies):
/// - **breathers** (drakes) score `0.5·d − men`, horse +8, bane +12, braced +3, already fighting −4, lowest
///   first, within 24;
/// - **other beasts** (trolls, as elephants) go at the nearest foot within 24: the line (melee foot) first, then any
///   foot.
///
/// Braced: a company that takes charges lightly (`chargeTaken < 1`, spears) standing rather than marching.
pub(crate) fn quarry<'a>(b: &Battle, i: usize, seen: &'a [Seen], from: P) -> Option<&'a Seen> {
    let s = &b.squads[i];
    let q = &b.tune.bots.quarry;
    if !s.spec.beast || s.kind == Kind::Captain {
        return None;
    }
    let live = |f: &&Seen| !f.routing && f.at.dist(from) <= if s.spec.breath > 0.0 { q.breather_r } else { q.foot_r };
    let near = |a: &&Seen, c: &&Seen| a.at.dist(from).total_cmp(&c.at.dist(from)).then(a.id.cmp(&c.id));
    if s.spec.breath > 0.0 {
        let score = |f: &Seen| {
            let o = &b.squads[f.id as usize];
            let braced = o.spec.charge_taken < 1.0 && o.state != crate::battle::SquadState::Marching;
            q.dist * f.at.dist(from) - q.men * f.men as f64
                + if o.kind == Kind::Horse && !o.spec.beast { q.horse } else { 0.0 }
                + if o.spec.bane > 1.0 { q.bane } else { 0.0 }
                + if braced { q.braced } else { 0.0 }
                + if f.fighting { q.fighting } else { 0.0 }
        };
        return seen.iter().filter(live).min_by(|a, c| score(a).total_cmp(&score(c)).then(a.id.cmp(&c.id)));
    }
    let foot = |f: &&Seen| f.kind != Kind::Horse && !f.captain;
    seen.iter().filter(live).filter(foot).filter(|f| !f.ranged).min_by(near).or_else(|| seen.iter().filter(live).filter(foot).min_by(near))
}

/// The blight goes for places and works, not the line (08-orders.md §7 "Enemy response"): for each field work of
/// the foe's it sees, the nearest free company (standing, not fighting, melee foot that does not breathe) is sent at
/// it, fighting; once there its men tear it down. Given after the bot's other deeds, so it stands this thought.
pub(crate) fn raid_works(b: &Battle, team: Team, out: &mut Orders) {
    let mut sent: Vec<usize> = Vec::new();
    for w in b.works.iter().filter(|w| w.team != team && !w.razed && b.sees(team, w.at)) {
        let free = companies(b, team).into_iter().filter(|&i| {
            let s = &b.squads[i];
            !sent.contains(&i) && s.state != crate::battle::SquadState::Fighting && !s.spec.ranged() && s.spec.breath == 0.0 && s.kind != Kind::Horse
        });
        let Some(i) = free.min_by(|&x, &y| b.centre(x).dist(w.at).total_cmp(&b.centre(y).dist(w.at)).then(x.cmp(&y))) else { continue };
        let to = b.open_near(w.at);
        let id = b.squads[i].id;
        // Re-given when another deed this thought would order it elsewhere (a front, an army order, its own).
        let touched = out.deeds.iter().any(|d| match d {
            Deed::Front { .. } => true,
            Deed::Move { who, .. } | Deed::Attack { who, .. } | Deed::Take { who, .. } | Deed::Hold { who } => *who == Who::Army || *who == (Who::Squad { id }),
            _ => false,
        });
        let already = matches!(&b.squads[i].order, Order::Move { to: t, fight: true, .. } if t.dist(to) < 1.0);
        if touched || !already {
            out.push_always(Deed::Move { who: Who::Squad { id }, to, via: Vec::new(), fight: true, face: None });
        }
        sent.push(i);
    }
}

/// `charge`: every company attacks the nearest foe it sees, or marches on the enemy's deploy point fighting; the
/// captain rides with them once a foe is seen (an army attack puts him on his ride).
fn charge(b: &Battle, team: Team, out: &mut Orders) {
    let foes = seen(b, team);
    let goal = b.map.deploy[1 - (team as usize & 1)];
    if let Some(c) = b.captain_of(team)
        && b.squads[c].order != Order::Ride
        && let Some(f) = nearest(&foes, b.centre(c), f64::INFINITY)
    {
        out.push_always(Deed::Attack { who: Who::Army, target: f.id, via: Vec::new() });
    }
    for i in companies(b, team) {
        let id = b.squads[i].id;
        let who = Who::Squad { id };
        // Its standing priority (nearest unless told otherwise, 08-orders.md §5).
        match pick(b, team, &foes, b.centre(i), f64::INFINITY, b.squads[i].how.priority) {
            Some(f) => out.push(b, Deed::Attack { who, target: f.id, via: Vec::new() }),
            None => out.push(b, Deed::Move { who, to: goal, via: Vec::new(), fight: true, face: None }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::battle::Setup;
    use crate::map::{MapKind, MapOpts};
    use crate::tune::Tune;

    fn play(seed: u32, us: BotKind, them: BotKind, kind: MapKind, secs: u32) -> (u64, Option<(Team, crate::battle::OutcomeReason)>, usize) {
        let mut b = Battle::new(seed, MapOpts { kind, width: 48 }, &Setup::for_map(kind), Tune::default());
        let mut bots = [Bot::new(us, 0), Bot::new(them, 1)];
        let mut issued = 0;
        while b.tick < secs * 30 && b.outcome().is_none() {
            for bot in bots.iter_mut() {
                for c in bot.think(&b) {
                    issued += 1;
                    b.apply(c);
                }
            }
            b.step(1);
        }
        (b.hash(), b.outcome(), issued)
    }

    #[test]
    fn bots_are_deterministic_and_issue_orders() {
        let a = play(3, BotKind::Charge, BotKind::General(1), MapKind::Field, 60);
        let b = play(3, BotKind::Charge, BotKind::General(1), MapKind::Field, 60);
        assert_eq!(a.0, b.0);
        assert!(a.2 > 0);
        let g = play(5, BotKind::Commander, BotKind::Garrison, MapKind::Keep, 60);
        assert!(g.2 > 0);
        println!("bots: 2 runs agree ({:016x}), charge+general issued {} orders, commander+garrison {}", a.0, a.2, g.2);
    }

    #[test]
    fn beasts_choose_their_quarry() {
        let b = Battle::new(7, MapOpts { kind: MapKind::Field, width: 48 }, &Setup::field(), Tune::default());
        let of = |u: crate::units::Unit| b.squads.iter().position(|s| s.unit == u).unwrap();
        let (drake, troll) = (of(crate::units::Unit::Drake), of(crate::units::Unit::Troll));
        // Everything of ours, as if seen where it stands.
        let all: Vec<Seen> = b
            .squads
            .iter()
            .filter(|s| s.team == 0)
            .map(|s| Seen {
                id: s.id,
                kind: s.kind,
                at: b.centre(s.id as usize),
                men: s.alive as usize,
                routing: false,
                fighting: false,
                ranged: s.spec.ranged(),
                captain: s.kind == Kind::Captain,
                morale: 1.0,
            })
            .collect();
        let q = &b.tune.bots.quarry;
        let from = P::new(24.0, 13.5);
        let score = |f: &Seen| {
            let o = &b.squads[f.id as usize];
            let braced = o.spec.charge_taken < 1.0 && o.state != crate::battle::SquadState::Marching;
            q.dist * f.at.dist(from) - q.men * f.men as f64 + if o.kind == Kind::Horse { q.horse } else { 0.0 } + if braced { q.braced } else { 0.0 }
        };
        let want = all.iter().min_by(|a, c| score(a).total_cmp(&score(c)).then(a.id.cmp(&c.id))).unwrap();
        let got = quarry(&b, drake, &all, from).unwrap();
        assert_eq!(got.id, want.id, "the breather's score");
        // Fighting already makes a company 4 better.
        let mut busy = all.clone();
        let second = busy.iter().filter(|f| f.id != want.id).min_by(|a, c| score(a).total_cmp(&score(c))).unwrap().id;
        busy.iter_mut().find(|f| f.id == second).unwrap().fighting = true;
        let fights = score(busy.iter().find(|f| f.id == second).unwrap()) + q.fighting < score(want);
        assert_eq!(quarry(&b, drake, &busy, from).unwrap().id == second, fights);
        // A troll goes at the nearest foot of the line, never the horse, the bows or the captain while foot stand.
        let t = quarry(&b, troll, &all, from).unwrap();
        assert!(!t.ranged && t.kind != Kind::Horse && !t.captain);
        let line_near = all.iter().filter(|f| !f.ranged && f.kind != Kind::Horse && !f.captain).map(|f| f.at.dist(from)).fold(f64::INFINITY, f64::min);
        assert_eq!(t.at.dist(from), line_near);
        // Blight-men and the broodlord have no quarry rule.
        let bm = of(crate::units::Unit::BlightMan);
        assert!(quarry(&b, bm, &all, from).is_none() && quarry(&b, b.captain_of(1).unwrap(), &all, from).is_none());
        let names = |id: SquadId| b.squads[id as usize].name.clone();
        println!("quarry: the drakes take {} (score {:.1}), with {} fighting {}; the trolls take {}", names(got.id), score(got), names(second), names(quarry(&b, drake, &busy, from).unwrap().id), names(t.id));
    }

    #[test]
    fn parse_names() {
        for n in ["garrison", "general0", "general1", "general2", "commander", "charge", "idle", "raiders"] {
            assert_eq!(BotKind::parse(n).unwrap().name(), n);
        }
        assert!(BotKind::parse("pirates").is_err());
        println!("bot names: 8 parsed, an unknown one refused");
    }
}
