//! The intents' checks (docs/spec/06-voice.md §8; AGENTS.md rule 4): the broodlord's brain gives an intent as a
//! `Source::Brain` command, and the bots carry it out between its calls instead of their own plan. Each check runs
//! across seeds, prints its counts, and runs the same seeds without the intent for contrast. The unit tests assert
//! them; `harness intents` prints them.

use super::{Bot, BotKind};
use crate::battle::checks::Check;
use crate::battle::{Battle, Order, Replay, Setup, SquadState};
use crate::contracts::{Command, Deed, P, Source, SquadId, TICK_HZ, Team, Tick, Who};
use crate::map::{MapKind, MapOpts, SiteKind};
use crate::tune::Tune;
use crate::units::Unit;

/// A check's scenario.
pub type Scenario = fn() -> Check;

/// Every check, by name.
pub const ALL: &[(&str, Scenario)] =
    &[("sally", sally), ("pull back", pull_back), ("attack that", attack_that), ("raiders", raiders), ("lapse", lapse), ("replay", replay)];

/// Runs every check.
pub fn all() -> Vec<Check> {
    ALL.iter().map(|(_, f)| f()).collect()
}

const SEEDS: std::ops::RangeInclusive<u32> = 1..=8;
const BLIGHT: Team = 1;

fn t(s: f64) -> Tick {
    (s * TICK_HZ as f64).round() as Tick
}

fn secs(t: Tick) -> f64 {
    t as f64 / TICK_HZ as f64
}

fn battle(seed: u32, kind: MapKind) -> Battle {
    Battle::new(seed, MapOpts { kind, width: 48 }, &Setup::for_map(kind), Tune::default())
}

/// Steps `n` ticks, the bots thinking before every tick (as the game and replays do).
fn step(b: &mut Battle, bots: &mut [Bot], n: u32) {
    for _ in 0..n {
        for bot in bots.iter_mut() {
            for c in bot.think(b) {
                b.apply(c);
            }
        }
        b.step(1);
    }
}

/// The brain's intent, queued now for the blight (the page's `sim.apply`).
fn intent(b: &mut Battle, deed: Deed) {
    b.apply(Command { tick: b.tick, team: BLIGHT, deed, src: Source::Brain, note: None });
}

fn of_unit(b: &Battle, unit: Unit) -> Vec<usize> {
    (0..b.squads.len()).filter(|&i| b.squads[i].team == BLIGHT && b.squads[i].unit == unit).collect()
}

fn median(mut xs: Vec<f64>) -> f64 {
    if xs.is_empty() {
        return f64::NAN;
    }
    xs.sort_by(|a, c| a.total_cmp(c));
    xs[xs.len() / 2]
}

/// The nearest living foe man's distance from squad `i`'s centre.
fn foe_gap(b: &Battle, i: usize) -> f64 {
    let c = b.centre(i);
    let team = b.squads[i].team;
    b.soldiers.iter().filter(|m| m.alive && b.squads[m.squad as usize].team != team).map(|m| m.pos().dist(c)).fold(f64::INFINITY, f64::min)
}

/// "Sally at the village with two packs": on the keep, the brain sends the two blight-men companies nearest the
/// village farthest from the keep to take it. They must reach it within 40 s, never be ordered elsewhere on the way,
/// and hold it once taken (the garrison's own sally comes home as soon as the site is its own).
fn sally() -> Check {
    let (mut reached, mut held, mut off, mut control) = (0, 0, 0, 0);
    let mut times = Vec::new();
    let mut n = 0;
    for seed in SEEDS {
        let run = |with: bool| {
            let mut b = battle(seed, MapKind::Keep);
            let mut bots = [Bot::new(BotKind::Idle, 0), Bot::new(BotKind::Garrison, BLIGHT)];
            step(&mut b, &mut bots, t(2.0));
            let keep = b.map.sites.iter().find(|s| s.kind == SiteKind::Keep).map(|s| s.at)?;
            let village = b.map.sites.iter().filter(|s| s.kind == SiteKind::Village).max_by(|a, c| a.at.dist(keep).total_cmp(&c.at.dist(keep)).then(a.id.cmp(&c.id)))?.clone();
            let mut men = of_unit(&b, Unit::BlightMan);
            men.sort_by(|&x, &y| b.centre(x).dist(village.at).total_cmp(&b.centre(y).dist(village.at)).then(x.cmp(&y)));
            men.truncate(2);
            let ids: Vec<SquadId> = men.iter().map(|&i| b.squads[i].id).collect();
            if with {
                intent(&mut b, Deed::Take { who: Who::Squads { ids: ids.clone() }, site: village.id, via: Vec::new() });
            }
            let from = b.tick;
            let reach = b.tune.outcome.capture_r + 1.0;
            let (mut at, mut off) = (None, 0);
            while b.tick < from + t(29.0) {
                step(&mut b, &mut bots, 15);
                let there = men.iter().all(|&i| b.centre(i).dist(village.at) <= reach);
                if there && at.is_none() {
                    at = Some(b.tick - from);
                }
                // On the intent: taking the village, or fighting or holding by it.
                for &i in &men {
                    let s = &b.squads[i];
                    let near = |p: P| p.dist(village.at) <= b.tune.bots.intent.guard_r + reach;
                    let ok = !s.standing()
                        || match &s.order {
                            Order::Take { site, .. } => *site == village.id,
                            Order::Move { to, .. } => near(*to),
                            Order::Hold { .. } | Order::Attack { .. } => near(b.centre(i)) || s.state == SquadState::Fighting,
                            _ => false,
                        };
                    off += (!ok) as usize;
                }
            }
            let stays = men.iter().all(|&i| !b.squads[i].standing() || b.centre(i).dist(village.at) <= reach + 1.0);
            Some((at, stays, off))
        };
        let (Some(with), Some(without)) = (run(true), run(false)) else { continue };
        n += 1;
        if let Some(at) = with.0 {
            reached += 1;
            times.push(secs(at));
        }
        held += with.1 as usize;
        off += with.2;
        control += without.0.is_some() as usize;
    }
    Check {
        name: "sally",
        counts: format!(
            "{reached}/{n} seeds: both companies reached the far village (median {:.1} s after the intent), {held}/{n} still hold it at 29 s, {off} samples off the intent; without it {control}/{n} reached it",
            median(times)
        ),
        pass: n >= 6 && reached * 8 >= n * 7 && held * 4 >= n * 3 && off == 0,
    }
}

/// "Pull back": on the open field (the charge bot against the general), once a blight company is fighting, the
/// brain moves it 10 tiles back toward its own side without fighting. It must leave the fight and gain ground,
/// where the general alone keeps it in.
fn pull_back() -> Check {
    let (mut out, mut gained, mut control, mut n) = (0, 0, 0, 0);
    let (mut times, mut gaps, mut kept) = (Vec::new(), Vec::new(), Vec::new());
    for seed in SEEDS {
        let run = |with: bool| {
            let mut b = battle(seed, MapKind::Field);
            let mut bots = [Bot::new(BotKind::Charge, 0), Bot::new(BotKind::General(1), BLIGHT)];
            let mut who = None;
            while b.tick < t(90.0) && b.outcome().is_none() {
                step(&mut b, &mut bots, 15);
                who = (0..b.squads.len()).find(|&i| {
                    let s = &b.squads[i];
                    s.team == BLIGHT && s.kind != crate::contracts::Kind::Captain && s.state == SquadState::Fighting && s.alive >= 2
                });
                if who.is_some() {
                    break;
                }
            }
            let i = who?;
            let home = b.map.deploy[BLIGHT as usize];
            let c = b.centre(i);
            let d = c.dist(home).max(1e-9);
            let to = b.open_near(P::new(c.x + (home.x - c.x) / d * 10.0, c.y + (home.y - c.y) / d * 10.0));
            let id = b.squads[i].id;
            if with {
                intent(&mut b, Deed::Move { who: Who::Squad { id }, to, via: Vec::new(), fight: false, face: None });
            }
            let (from, gap0) = (b.tick, foe_gap(&b, i));
            let mut left = None;
            while b.tick < from + t(10.0) {
                step(&mut b, &mut bots, 3);
                if left.is_none() && b.squads[i].state != SquadState::Fighting {
                    left = Some(b.tick - from);
                }
            }
            let fighting = b.squads[i].state == SquadState::Fighting;
            Some((left, foe_gap(&b, i) - gap0, b.centre(i).dist(to), fighting))
        };
        let (Some(with), Some(without)) = (run(true), run(false)) else { continue };
        n += 1;
        if let Some(l) = with.0 {
            out += 1;
            times.push(secs(l));
        }
        gaps.push(with.1);
        gained += (with.1 >= 2.0 || with.2 <= 2.5) as usize;
        control += without.3 as usize;
        kept.push(without.1);
    }
    Check {
        name: "pull back",
        counts: format!(
            "{out}/{n} seeds the company left the fight (median {:.1} s), {gained}/{n} gained ground on the foe or reached the spot in 10 s (median gap {:+.1} tiles); without it the gap changed {:+.1} tiles (median) and {control}/{n} still fight after 10 s",
            median(times),
            median(gaps),
            median(kept)
        ),
        pass: n >= 6 && out * 4 >= n * 3 && gained * 4 >= n * 3,
    }
}

/// "Attack that": on the open field, the brain sends the trolls at the warband's riders, which the trolls' own
/// quarry rule never picks (they go at the nearest foot). Their order must stay on the riders.
fn attack_that() -> Check {
    let (mut on, mut total, mut control, mut n) = (0, 0, 0, 0);
    for seed in SEEDS {
        let run = |with: bool| {
            let mut b = battle(seed, MapKind::Field);
            let mut bots = [Bot::new(BotKind::Idle, 0), Bot::new(BotKind::General(1), BLIGHT)];
            step(&mut b, &mut bots, t(1.0));
            let trolls = *of_unit(&b, Unit::Troll).first()?;
            let horse = b.squads.iter().position(|s| s.team == 0 && s.unit == Unit::Horse)?;
            let target = b.squads[horse].id;
            let id = b.squads[trolls].id;
            if with {
                intent(&mut b, Deed::Attack { who: Who::Squad { id }, target, via: Vec::new() });
            }
            let (mut yes, mut all) = (0, 0);
            let from = b.tick;
            while b.tick < from + t(28.0) && b.squads[horse].standing() && b.squads[trolls].standing() {
                step(&mut b, &mut bots, 15);
                all += 1;
                yes += matches!(b.squads[trolls].order, Order::Attack { target: x, .. } | Order::Charge { target: x } if x == target) as usize;
            }
            Some((yes, all))
        };
        let (Some(with), Some(without)) = (run(true), run(false)) else { continue };
        n += 1;
        on += with.0;
        total += with.1;
        control += without.0;
    }
    Check {
        name: "attack that",
        counts: format!("{n} seeds: the trolls' order was on the riders in {on}/{total} samples (every 0.5 s for 28 s); without the intent in {control}"),
        pass: n >= 6 && total > 0 && on * 100 >= total * 95,
    }
}

/// The ford's raiders keep an intent too: once the first raiders are on the field, the brain holds one company back
/// at its spot (a hold) where the raiders would send it at the civilians or the warband. Its order must stay the
/// hold for the intent's length; without the intent the raiders send it on.
fn raiders() -> Check {
    let (mut on, mut total, mut control, mut n) = (0, 0, 0, 0);
    for seed in SEEDS {
        let run = |with: bool| {
            let mut b = battle(seed, MapKind::Ford);
            let mut bots = [Bot::new(BotKind::Commander, 0), Bot::new(BotKind::Raiders, BLIGHT)];
            let mut who = None;
            while b.tick < t(120.0) && who.is_none() {
                step(&mut b, &mut bots, 15);
                who = (0..b.squads.len()).find(|&i| b.squads[i].team == BLIGHT && b.squads[i].standing() && b.squads[i].kind != crate::contracts::Kind::Captain);
            }
            let i = who?;
            let id = b.squads[i].id;
            if with {
                intent(&mut b, Deed::Hold { who: Who::Squad { id } });
            }
            let (mut yes, mut all) = (0, 0);
            let from = b.tick;
            while b.tick < from + t(25.0) && b.squads[i].standing() {
                step(&mut b, &mut bots, 15);
                all += 1;
                yes += matches!(b.squads[i].order, Order::Hold { .. }) as usize;
            }
            Some((yes, all))
        };
        let (Some(with), Some(without)) = (run(true), run(false)) else { continue };
        n += 1;
        on += with.0;
        total += with.1;
        control += without.0;
    }
    Check {
        name: "raiders",
        counts: format!("{n} seeds: the held raider company's order was the hold in {on}/{total} samples (every 0.5 s for 25 s); without the intent in {control}"),
        pass: n >= 6 && total > 0 && on == total,
    }
}

/// "The intent lapses": on the keep, the brain moves a blight-men company 6 tiles out from its post without
/// fighting. The garrison leaves it there until the intent lapses (`IntentTune::lapse_s`), then takes it back to its
/// post.
fn lapse() -> Check {
    let (mut kept, mut back, mut n) = (0, 0, 0);
    let mut reclaimed = Vec::new();
    let lapse_s = Tune::default().bots.intent.lapse_s;
    for seed in SEEDS {
        let mut b = battle(seed, MapKind::Keep);
        let mut bots = [Bot::new(BotKind::Idle, 0), Bot::new(BotKind::Garrison, BLIGHT)];
        step(&mut b, &mut bots, t(1.0));
        let Some(&i) = of_unit(&b, Unit::BlightMan).first() else { continue };
        let post = b.centre(i);
        let to = b.open_near(P::new(post.x - 6.0, post.y));
        let id = b.squads[i].id;
        intent(&mut b, Deed::Move { who: Who::Squad { id }, to, via: Vec::new(), fight: false, face: None });
        let from = b.tick;
        let mut stayed = true;
        let mut home = None;
        let mut log = b.log.len();
        while b.tick < from + t(lapse_s + 20.0) {
            step(&mut b, &mut bots, 3);
            let ours = b.log[log..].iter().any(|c| c.src == Source::Bot && c.team == BLIGHT && matches!(&c.deed, Deed::Move { who: Who::Squad { id: x }, to: p, .. } if *x == id && p.dist(to) > 1.0));
            log = b.log.len();
            if b.tick < from + t(lapse_s) && ours {
                stayed = false;
            }
            if ours && home.is_none() && b.tick >= from + t(lapse_s) {
                home = Some(b.tick - from);
            }
        }
        n += 1;
        kept += stayed as usize;
        if let Some(h) = home {
            reclaimed.push(secs(h));
            back += (b.centre(i).dist(post) <= 2.5) as usize;
        }
    }
    let late = reclaimed.iter().cloned().fold(0.0, f64::max);
    let think = Tune::default().bots.garrison.think_s;
    Check {
        name: "lapse",
        counts: format!(
            "{kept}/{n} seeds the garrison left the company to the intent for its {lapse_s:.0} s; {}/{n} reclaimed after it (latest {late:.1} s), {back}/{n} back at the post by {:.0} s",
            reclaimed.len(),
            lapse_s + 20.0
        ),
        pass: n >= 6 && kept == n && reclaimed.len() == n && late <= lapse_s + think + 0.2 && back * 4 >= n * 3,
    }
}

/// "Replays need no model": a battle with the brain's intents, played as the game plays it (the bots thinking, the
/// intents applied as they arrive), and its replay (the seed and the log of intents, the bots re-run) reach the
/// same hash.
fn replay() -> Check {
    let (mut same, mut n) = (0, 0);
    let mut intents = 0;
    for seed in SEEDS {
        let mut b = battle(seed, MapKind::Keep);
        let mut bots = [Bot::new(BotKind::Commander, 0), Bot::new(BotKind::Garrison, BLIGHT)];
        let men = of_unit(&b, Unit::BlightMan);
        let village = b.map.sites.iter().find(|s| s.kind == SiteKind::Village).map(|s| s.id);
        let mut given = Vec::new();
        for k in 0..6u32 {
            step(&mut b, &mut bots, t(8.0) + k);
            let i = men[(k as usize) % men.len()];
            let id = b.squads[i].id;
            let deed = match (k % 3, village) {
                (0, Some(site)) => Deed::Take { who: Who::Squad { id }, site, via: Vec::new() },
                (1, _) => Deed::Move { who: Who::Squad { id }, to: b.open_near(P::new(b.centre(i).x - 4.0, b.centre(i).y)), via: Vec::new(), fight: false, face: None },
                _ => match super::nearest(&super::seen(&b, BLIGHT), b.centre(i), f64::INFINITY) {
                    Some(f) => Deed::Attack { who: Who::Squad { id }, target: f.id, via: Vec::new() },
                    None => Deed::Hold { who: Who::Squad { id } },
                },
            };
            let cmd = Command { tick: b.tick, team: BLIGHT, deed, src: Source::Brain, note: Some(serde_json::json!({ "brain": "check" })) };
            given.push(cmd.clone());
            b.apply(cmd);
        }
        step(&mut b, &mut bots, t(20.0));
        intents += given.len();
        // The replay keeps only what is not a bot's: the bots are re-run with it.
        let mut r = Replay::new(seed, MapOpts { kind: MapKind::Keep, width: 48 });
        r.tick = b.tick;
        r.log = b.log.iter().filter(|c| c.src != Source::Bot).cloned().collect();
        r.bots = vec![crate::battle::BotSlot { team: 0, bot: "commander".into() }, crate::battle::BotSlot { team: BLIGHT, bot: "garrison".into() }];
        let again = r.run().map(|x| x.hash()).unwrap_or(0);
        n += 1;
        same += (again == b.hash()) as usize;
    }
    Check { name: "replay", counts: format!("{same}/{n} seeds: the game and its replay ({intents} brain intents in the log, bots re-run) reach the same hash"), pass: n > 0 && same == n }
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_intent_check_passes() {
        let mut failed = Vec::new();
        for c in super::all() {
            println!("{} {}: {}", if c.pass { "PASS" } else { "FAIL" }, c.name, c.counts);
            if !c.pass {
                failed.push(c.name);
            }
        }
        assert!(failed.is_empty(), "failed: {failed:?}");
    }
}

