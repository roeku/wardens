//! Day 4's places, checked (04-battle.md §7–§8; 03-land.md §8; 02-look.md §3; 01-flow.md §4; AGENTS.md rule 4):
//! one scenario per rule of the village under the torch, the ford, the raiders and the night, each printing its
//! counts. The unit tests assert them; `harness places` prints them. The night's scenarios shorten the day by a
//! tuning override, as the harness's sweeps may.

use super::checks::Check;
use super::{Battle, HouseState, LightKind, Order, OutcomeReason, Setup};
use crate::bots::{Bot, BotKind};
use crate::contracts::{EventCode, Kind, P, TICK_HZ, Tick};
use crate::map::{MapKind, MapOpts, SiteKind};
use crate::tune::Tune;
use crate::units::Unit;

/// Every places check, by name.
pub const ALL: &[(&str, super::checks::Scenario)] = &[
    ("the town burns on the clock", town_burns),
    ("taking the town frees the standing", town_freed),
    ("the ford's groups walk, run and leave", ford_groups),
    ("the ford is lost with nobody saved", ford_lost),
    ("the raiders hunt the civilians", raiders),
    ("civilians take no orders and never fight", civilians),
    ("torches at nightfall give armies away", torches),
    ("the relief comes from the east", relief),
    ("the night's level and its lights", night_lights),
];

/// Runs every places check.
pub fn all() -> Vec<Check> {
    ALL.iter().map(|(_, f)| f()).collect()
}

fn secs(t: Tick) -> f64 {
    t as f64 / TICK_HZ as f64
}

fn battle(seed: u32, kind: MapKind, tune: Tune) -> Battle {
    Battle::new(seed, MapOpts { kind, width: 48 }, &Setup::for_map(kind), tune)
}

/// A day of 20 s, so night falls at 20 s and dawn comes at 90 s.
fn short_day() -> Tune {
    Tune::with_override(&serde_json::json!({"outcome": {"battle_s": 20.0}})).expect("tune")
}

/// Steps with bots for both sides until `until` holds or `max` ticks pass.
fn run(b: &mut Battle, bots: &mut [Bot], max: Tick, mut until: impl FnMut(&Battle) -> bool) {
    let end = b.tick + max;
    while b.tick < end && !until(b) {
        for bot in bots.iter_mut() {
            for c in bot.think(b) {
                b.apply(c);
            }
        }
        b.step(1);
    }
}

fn town_burns() -> Check {
    let mut b = battle(3, MapKind::Town, Tune::default());
    let t = b.tune.places.town.clone();
    let mut fired = Vec::new();
    let mut fell = Vec::new();
    while b.tick < 160 * TICK_HZ {
        b.step(1);
        for e in b.drain_events() {
            match e.code {
                EventCode::HouseFired => fired.push((secs(e.tick), e.b)),
                EventCode::HouseLost => fell.push((secs(e.tick), e.b)),
                _ => {}
            }
        }
    }
    let want: Vec<f64> = (0..t.houses.len()).map(|k| t.first_s + t.every_s * k as f64).collect();
    let fired_s: Vec<f64> = fired.iter().map(|f| f.0).collect();
    let burns: Vec<f64> = fell.iter().map(|&(s, h)| s - fired.iter().find(|f| f.1 == h).map_or(0.0, |f| f.0)).collect();
    let mut order: Vec<u32> = fired.iter().map(|f| f.1).collect();
    order.sort_unstable();
    let all_fallen = b.places.houses.iter().all(|h| h.state == HouseState::Fallen && h.people == 0);
    let close = |a: &[f64], b: &[f64]| a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 0.05);
    Check {
        name: "the town burns on the clock",
        counts: format!(
            "fired at {fired_s:?} s (houses {:?}); each burnt {burns:?} s; {} people burnt; all fallen: {all_fallen}",
            fired.iter().map(|f| f.1).collect::<Vec<_>>(),
            b.places.burnt_people
        ),
        pass: close(&fired_s, &want) && burns.iter().all(|&s| (s - t.burn_s).abs() < 0.05) && order == [0, 1, 2, 3, 4] && b.places.burnt_people == 15 && all_fallen,
    }
}

fn town_freed() -> Check {
    let mut b = battle(3, MapKind::Town, Tune::default());
    // At 60 s two houses are fired and one has fallen; the town is then ours (as a capture would make it).
    b.run_to(60 * TICK_HZ);
    let si = b.places.town.expect("a town");
    let before: Vec<HouseState> = b.places.houses.iter().map(|h| h.state).collect();
    let standing: u16 = b.places.houses.iter().filter(|h| matches!(h.state, HouseState::Standing | HouseState::Burning)).map(|h| h.people).sum();
    b.drain_events();
    // The blight is cleared from round the town (as a capture needs), and the town is ours.
    let at = b.map.sites[si].at;
    for k in 0..b.soldiers.len() {
        let s = &b.squads[b.soldiers[k].squad as usize];
        if s.team == 1 && s.kind != Kind::Captain && b.soldiers[k].alive && b.soldiers[k].pos().dist(at) < 8.0 {
            b.kill(k, None);
        }
    }
    let lord = b.captain_of(1).expect("broodlord");
    let away = P::new(b.map.wf() - 1.0, 1.0);
    for k in b.squads[lord].soldiers.clone() {
        (b.soldiers[k].x, b.soldiers[k].y) = (away.x, away.y);
    }
    (b.squads[lord].x, b.squads[lord].y) = (away.x, away.y);
    b.sites[si].owner = Some(0);
    b.step(1);
    let freed: Vec<u32> = b.drain_events().iter().filter(|e| e.code == EventCode::Freed).map(|e| e.b).collect();
    let after: Vec<HouseState> = b.places.houses.iter().map(|h| h.state).collect();
    b.step(1);
    let company = b.places.freed.first().map(|&id| id as usize);
    let (men, levy, follows) = company.map_or((0, false, false), |i| {
        let s = &b.squads[i];
        (s.alive, s.unit == Unit::Levy && s.freed && s.name.is_empty(), s.order == Order::Follow)
    });
    // They fall in behind the captain: the distance to their station after 30 s.
    b.step(30 * TICK_HZ);
    let to_station = company.and_then(|i| b.station_at(i).map(|st| b.centre(i).dist(st))).unwrap_or(f64::INFINITY);
    let burning_after = b.places.houses.iter().filter(|h| h.state == HouseState::Burning).count();
    let fires_after = b.tick >= 74 * TICK_HZ && b.places.houses.iter().filter(|h| h.state == HouseState::Burning).count() == 0;
    Check {
        name: "taking the town frees the standing",
        counts: format!(
            "houses at 60 s {before:?} -> {after:?}; {standing} people standing, Freed event {freed:?}; the freed: {men} men, plain levy {levy}, follow {follows}, {to_station:.1} from their station 30 s later; burning afterwards {burning_after}"
        ),
        pass: before.iter().filter(|&&s| s == HouseState::Fallen).count() == 1
            && after.iter().filter(|&&s| s == HouseState::Doused).count() == 1
            && freed == [standing as u32]
            && standing == 12
            && men == 6
            && levy
            && follows
            && to_station < 3.0
            && fires_after,
    }
}

fn ford_groups() -> Check {
    let mut b = battle(5, MapKind::Ford, Tune::default());
    let f = b.tune.places.ford.clone();
    let mut came: Vec<Option<f64>> = vec![None; f.groups_s.len()];
    let note = |b: &Battle, came: &mut Vec<Option<f64>>| {
        for (k, g) in b.places.ford.as_ref().expect("ford").groups.iter().enumerate() {
            if g.squad.is_some() && came[k].is_none() {
                came[k] = Some(b.time());
            }
        }
    };
    // Strikes every raider from the field, so the groups go their way.
    let clear = |b: &mut Battle| {
        for w in b.places.ford.clone().expect("ford").waves {
            for id in w.squads {
                for k in b.squads[id as usize].soldiers.clone() {
                    b.kill(k, None);
                }
            }
        }
    };
    // Group 0 walks 10 s with nobody near.
    while came[0].is_none() {
        b.step(1);
        note(&b, &mut came);
    }
    let g0 = b.places.ford.as_ref().and_then(|f| f.groups[0].squad).expect("group 0") as usize;
    let a = b.centre(g0);
    b.step(10 * TICK_HZ);
    let walk = b.centre(g0).dist(a) / 10.0;
    b.run_to(15 * TICK_HZ);
    // A raider of the first wave (in at 14 s) stands 3.5 beside it: it runs.
    let raider = b.places.ford.as_ref().and_then(|f| f.waves[0].squads.first().copied()).expect("wave 0") as usize;
    let near = b.centre(g0).offset(0.0, 0.0, 3.5);
    for k in b.squads[raider].soldiers.clone() {
        (b.soldiers[k].x, b.soldiers[k].y) = (near.x, near.y);
    }
    (b.squads[raider].x, b.squads[raider].y) = (near.x, near.y);
    b.step(2);
    let running = b.squads[g0].spec.speed;
    let mut decided = None;
    for _ in 0..(240 * TICK_HZ) {
        clear(&mut b);
        b.step(1);
        note(&b, &mut came);
        if b.outcome().is_some() {
            decided = b.outcome();
            break;
        }
    }
    let fd = b.places.ford.as_ref().expect("ford");
    let saved: Vec<u16> = fd.groups.iter().map(|g| g.saved).collect();
    let far: Vec<bool> = fd.groups.iter().map(|g| g.far).collect();
    let came: Vec<f64> = came.into_iter().map(|c| c.unwrap_or(f64::NAN)).collect();
    let came_ok = came.iter().zip(&f.groups_s).all(|(c, w)| (c - w).abs() <= 0.1);
    Check {
        name: "the ford's groups walk, run and leave",
        counts: format!(
            "groups came at {came:.2?} s (far ford: {far:?}); walking {walk:.2} t/s, running {running:.2} with a raider 3.5 away; saved {saved:?}; outcome {decided:?} at {:.0} s",
            b.time()
        ),
        pass: came_ok && (walk - f.walk).abs() < 0.2 && running == f.run && saved.iter().all(|&s| s == f.group_men) && far == [false, true, false, true] && decided == Some((0, OutcomeReason::Saved)),
    }
}

fn ford_lost() -> Check {
    let mut b = battle(5, MapKind::Ford, Tune::default());
    let mut decided = None;
    for _ in 0..(120 * TICK_HZ) {
        b.step(1);
        // Every civilian falls as soon as he comes.
        for i in 0..b.squads.len() {
            if b.civilian(i) {
                for k in b.squads[i].soldiers.clone() {
                    if b.soldiers[k].alive {
                        b.kill(k, None);
                    }
                }
            }
        }
        if b.outcome().is_some() {
            decided = b.outcome();
            break;
        }
    }
    let fd = b.places.ford.as_ref().expect("ford");
    let killed: u32 = fd.groups.iter().filter_map(|g| g.squad).map(|id| (b.squads[id as usize].full - b.squads[id as usize].alive) as u32).sum();
    Check {
        name: "the ford is lost with nobody saved",
        counts: format!("{killed} civilians fell; outcome {decided:?} at {:.1} s (the last group comes at 91 s)", b.time()),
        pass: killed == 20 && decided == Some((1, OutcomeReason::NoneSaved)) && b.time() >= 91.0,
    }
}

fn raiders() -> Check {
    let mut b = battle(5, MapKind::Ford, Tune::default());
    let mut bots = [Bot::new(BotKind::Idle, 0), Bot::new(BotKind::Raiders, 1)];
    let (mut at_folk, mut at_troops, mut marches) = (0, 0, 0);
    let mut hunters_at_folk = 0;
    let mut seen = Vec::new();
    while b.tick < 90 * TICK_HZ && b.outcome().is_none() {
        for bot in bots.iter_mut() {
            for c in bot.think(&b) {
                if c.team == 1 {
                    match &c.deed {
                        crate::contracts::Deed::Attack { who: crate::contracts::Who::Squad { id }, target, .. } => {
                            let folk = b.squads[*target as usize].kind == Kind::Folk;
                            if folk {
                                at_folk += 1;
                                hunters_at_folk += b.squads[*id as usize].spec.pack as u32;
                            } else {
                                at_troops += 1;
                            }
                            if !seen.contains(id) {
                                seen.push(*id);
                            }
                        }
                        crate::contracts::Deed::Move { .. } => marches += 1,
                        _ => {}
                    }
                }
                b.apply(c);
            }
        }
        b.step(1);
    }
    let lost: u32 = b.places.ford.as_ref().map_or(0, |f| f.groups.iter().filter_map(|g| g.squad).map(|id| (b.squads[id as usize].full - b.squads[id as usize].alive) as u32).sum::<u32>() - f.saved());
    Check {
        name: "the raiders hunt the civilians",
        counts: format!(
            "in 90 s: {} raider companies came; orders: {at_folk} attacks on civilians ({hunters_at_folk} by drake packs), {at_troops} on troops, {marches} marches on the ford; {lost} civilians fell",
            b.places.ford.as_ref().map_or(0, |f| f.waves.iter().map(|w| w.squads.len()).sum::<usize>())
        ),
        pass: at_folk > 0 && hunters_at_folk > 0 && marches > 0,
    }
}

fn civilians() -> Check {
    let mut b = battle(5, MapKind::Ford, Tune::default());
    b.run_to(3 * TICK_HZ);
    let g = b.places.ford.as_ref().and_then(|f| f.groups[0].squad).expect("group 0") as usize;
    let deed = crate::contracts::Deed::Hold { who: crate::contracts::Who::Squad { id: g as u16 } };
    b.apply(crate::contracts::Command { tick: b.tick, team: 0, deed, src: crate::contracts::Source::Typed, note: None });
    b.flush();
    let refused = b.refusals.last().map(|r| r.why.clone()).unwrap_or_default();
    let everyone = crate::text::parse(&b, 0, "stance army holdfire").ok();
    if let Some(d) = everyone {
        b.apply(crate::contracts::Command { tick: b.tick, team: 0, deed: d, src: crate::contracts::Source::Typed, note: None });
        b.flush();
    }
    let kept = b.squads[g].how.stance;
    let r = b.rules(g);
    let in_army = crate::bots::companies(&b, 0).contains(&g);
    Check {
        name: "civilians take no orders and never fight",
        counts: format!("an order to them: {refused:?}; \"everyone, hold fire\" leaves them {kept:?}; rules engage {} strike {}; a bot's company: {in_army}", r.engage, r.strike),
        pass: refused.contains("civilians") && kept == super::Stance::Normal && r.engage == 0.0 && !r.strike && !in_army,
    }
}

fn torches() -> Check {
    let mut b = battle(4, MapKind::Keep, short_day());
    b.run_to(19 * TICK_HZ);
    let fog_before = squads_seen(&b, 1, 0);
    let mut lit: Vec<(u16, u8, f64)> = Vec::new();
    while b.tick < 24 * TICK_HZ {
        b.step(1);
        for i in 0..b.squads.len() {
            if b.torch_lit(i) && !lit.iter().any(|l| l.0 == b.squads[i].id) {
                lit.push((b.squads[i].id, b.squads[i].team, secs(b.tick) - 20.0));
            }
        }
    }
    let ours: Vec<f64> = lit.iter().filter(|l| l.1 == 0).map(|l| (l.2 * 100.0).round() / 100.0).collect();
    let theirs: Vec<f64> = lit.iter().filter(|l| l.1 == 1).map(|l| (l.2 * 100.0).round() / 100.0).collect();
    b.step(16);
    let fog_after = squads_seen(&b, 1, 0);
    let n = &b.tune.places.night;
    let want: Vec<f64> = (0..ours.len()).map(|k| ((n.torch_first_s + n.torch_step_s * k as f64) * 30.0).round() / 30.0).collect();
    Check {
        name: "torches at nightfall give armies away",
        counts: format!(
            "ours lit at {ours:?} s after nightfall, theirs at {theirs:?}; the blight sees {fog_before} of our companies before nightfall and {fog_after} after"
        ),
        pass: ours.len() == 5 && ours.iter().zip(&want).all(|(a, w)| (a - w).abs() < 0.04) && theirs.iter().all(|&t| (t - n.foe_torch_s).abs() < 0.04) && fog_after == 5 && fog_before < 5,
    }
}

/// How many of `of`'s squads on the field `team` sees a man of.
fn squads_seen(b: &Battle, team: u8, of: u8) -> usize {
    (0..b.squads.len())
        .filter(|&i| b.squads[i].team == of && b.squads[i].on_field() && b.squads[i].soldiers.iter().any(|&k| b.soldiers[k].alive && b.sees(team, b.soldiers[k].pos())))
        .count()
}

fn relief() -> Check {
    let mut b = battle(4, MapKind::Keep, short_day());
    let garrison = b.places.garrison.len();
    b.run_to(25 * TICK_HZ);
    let before = b.squads.len();
    b.run_to(27 * TICK_HZ);
    let came: Vec<usize> = b.places.relief.iter().map(|&id| id as usize).collect();
    let east = came.iter().all(|&i| b.squads[i].x >= b.map.wf() - 3.0 && b.squads[i].team == 1);
    let when = b.places.nightfall.map(secs);
    let units: Vec<&str> = came.iter().map(|&i| b.squads[i].unit.name()).collect();
    let mut bots = [Bot::new(BotKind::Idle, 0), Bot::new(BotKind::Garrison, 1)];
    run(&mut b, &mut bots, 10 * TICK_HZ, |_| false);
    let attacking = came.iter().filter(|&&i| matches!(b.squads[i].order, Order::Attack { .. })).count();
    Check {
        name: "the relief comes from the east",
        counts: format!(
            "night fell at {when:?} s; {} relief companies of {garrison} came at 26 s ({units:?}), at the east edge {east}; 10 s later {attacking} attack (squads {before} -> {})",
            came.len(),
            b.squads.len()
        ),
        pass: came.len() == ((garrison as f64 * 0.5).round() as usize) && before + came.len() == b.squads.len() && east && attacking == came.len() && when == Some(20.0),
    }
}

fn night_lights() -> Check {
    let mut b = battle(3, MapKind::Town, short_day());
    let mut lights = Vec::new();
    b.run_to(19 * TICK_HZ);
    b.lights(&mut lights);
    let day = (b.night_level(), lights.iter().filter(|l| l.kind == LightKind::Torch).count(), lights.len());
    b.run_to(22 * TICK_HZ);
    let k2 = b.night_level();
    b.run_to(30 * TICK_HZ);
    b.lights(&mut lights);
    let torches = lights.iter().filter(|l| l.kind == LightKind::Torch).count();
    let lit = (0..b.squads.len()).filter(|&i| b.torch_lit(i)).count();
    let houses: Vec<(f64, f64)> = lights.iter().filter(|l| l.kind == LightKind::House).map(|l| (l.reach, l.strength)).collect();
    let shrines = b.map.sites.iter().filter(|s| s.kind == SiteKind::Shrine).count();
    let fires = lights.iter().filter(|l| l.kind == LightKind::Fire).count();
    // A burning house lights radius 4 round it for both sides.
    let h = b.places.houses.iter().find(|h| h.state == HouseState::Burning).map(|h| h.at);
    let seen = h.map(|p| (b.sees(0, P::new(p.x + 3.4, p.y)), b.sees(1, P::new(p.x - 3.4, p.y))));
    b.run_to(95 * TICK_HZ);
    let dawn = b.night_level();
    let want2 = 1.0 - libm::exp(-0.7 * 2.0);
    Check {
        name: "the night's level and its lights",
        counts: format!(
            "day: level {:.2}, {} torches, {} lights; 2 s after nightfall level {k2:.3} (want {want2:.3}); at 30 s {torches} torches ({lit} lit), burning houses {houses:?}, {fires} fires ({shrines} shrines); a burning house seen 3.4 off by both sides {seen:?}; after dawn level {dawn:.2}",
            day.0, day.1, day.2
        ),
        pass: day.0 == 0.0
            && day.1 == 0
            && (k2 - want2).abs() < 0.01
            && torches == lit
            && torches > 5
            && !houses.is_empty()
            && fires == shrines
            && seen == Some((true, true))
            && dawn < k2,
    }
}

#[cfg(test)]
mod tests {
    macro_rules! check {
        ($($name:ident),* $(,)?) => {$(
            #[test]
            fn $name() {
                let c = super::$name();
                println!("{}: {}", c.name, c.counts);
                assert!(c.pass, "{}: {}", c.name, c.counts);
            }
        )*};
    }

    check!(town_burns, town_freed, ford_groups, ford_lost, raiders, civilians, torches, relief, night_lights);
}
