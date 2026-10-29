//! `campaign`: whole campaigns headless (01-flow §8), seeds on threads (never inside a tick), each played by
//! `sim::campaign::auto` with the warband's bot against each place's: the debug muster, a road choice, every
//! battle, the camp's honour. Prints every count, so a band cannot pass without running (AGENTS.md rule 4):
//! won or lost and why, steps and battles, men lost, commanders fallen and returned, villages freed and burnt,
//! broodlords down and escaped, and sim and wall time per campaign. `--checks` runs the campaign's checks.

use std::thread;
use std::time::Instant;

use serde_json::Value;
use sim::campaign::auto::{Played, Policy, play};
use sim::campaign::{Campaign, Opts, PlaceKind};
use sim::tune::Tune;

pub struct Opts2 {
    pub n: u32,
    pub seed0: u32,
    pub bot: Policy,
    pub tune: Tune,
    pub verbose: bool,
}

/// A played campaign and its wall time.
struct Timed {
    p: Played,
    wall_s: f64,
}

fn run_seeds(seeds: &[u32], bot: Policy, tune: &Tune, keep_saves: bool) -> Vec<(Played, f64)> {
    let threads = thread::available_parallelism().map_or(4, |n| n.get()).min(seeds.len().max(1));
    let chunks: Vec<Vec<u32>> = (0..threads).map(|t| seeds.iter().copied().skip(t).step_by(threads).collect()).collect();
    let mut out: Vec<(Played, f64)> = thread::scope(|s| {
        let handles: Vec<_> = chunks
            .into_iter()
            .map(|chunk| {
                let tune = tune.clone();
                s.spawn(move || {
                    chunk
                        .into_iter()
                        .map(|seed| {
                            let t = Instant::now();
                            let p = play(seed, bot, &tune, keep_saves);
                            (p, t.elapsed().as_secs_f64())
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().expect("a campaign thread")).collect()
    });
    out.sort_by_key(|(p, _)| p.seed);
    out
}

pub fn run(o: &Opts2) -> Result<(), String> {
    let seeds: Vec<u32> = (o.seed0..o.seed0 + o.n).collect();
    let started = Instant::now();
    let runs: Vec<Timed> = run_seeds(&seeds, o.bot, &o.tune, false).into_iter().map(|(p, wall_s)| Timed { p, wall_s }).collect();
    let wall = started.elapsed().as_secs_f64();
    if o.verbose {
        for r in &runs {
            let p = &r.p;
            println!(
                "seed {:>5}: {:<4} {:<13} steps {} battles {:>2} (won {:>2}) camps {} days {:>2} | men lost {:>3} | commanders fell {} returned {} heirs {} | freed {:>2} new {} | villages freed {} burnt {} | broodlords down {} escaped {} | sim {:>6.0} s wall {:>5.2} s",
                p.seed,
                if p.won { "WON" } else { "lost" },
                p.reason,
                p.steps,
                p.battles,
                p.battles_won,
                p.camps,
                p.days,
                p.men_lost,
                p.fallen,
                p.returned,
                p.heirs,
                p.freed,
                p.new_companies,
                p.villages_freed,
                p.villages_burnt,
                p.foes_down,
                p.foes_escaped,
                p.sim_s,
                r.wall_s
            );
            for l in &p.log {
                println!("    {l}");
            }
        }
    }
    report(o, &runs, wall);
    Ok(())
}

fn report(o: &Opts2, runs: &[Timed], wall: f64) {
    let n = runs.len().max(1) as f64;
    let won = runs.iter().filter(|r| r.p.won).count();
    let mut reasons: Vec<(String, usize)> = Vec::new();
    for r in runs {
        match reasons.iter_mut().find(|(k, _)| *k == r.p.reason) {
            Some(e) => e.1 += 1,
            None => reasons.push((r.p.reason.clone(), 1)),
        }
    }
    reasons.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let sum = |f: fn(&Played) -> u32| runs.iter().map(|r| f(&r.p) as u64).sum::<u64>();
    let mean = |f: fn(&Played) -> u32| sum(f) as f64 / n;
    let mut steps = [0usize; 7];
    for r in runs {
        steps[(r.p.steps as usize).min(6)] += 1;
    }
    let sim: f64 = runs.iter().map(|r| r.p.sim_s).sum();
    let wall_each: f64 = runs.iter().map(|r| r.wall_s).sum();
    println!("campaign {} x{} from seed {} (warband bot {}):", runs.len(), o.n, o.seed0, o.bot.name());
    println!("  won {won} of {} = {:.1}%", runs.len(), 100.0 * won as f64 / n);
    println!("  ended: {}", reasons.iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(", "));
    println!("  steps reached (0..6, 6 = keep taken): {:?}; mean {:.2}", steps, mean(|p| p.steps));
    println!(
        "  battles {} (won {}), mean {:.2} per campaign; camps {}; days mean {:.1}",
        sum(|p| p.battles),
        sum(|p| p.battles_won),
        mean(|p| p.battles),
        sum(|p| p.camps),
        mean(|p| p.days)
    );
    println!("  men lost {} (mean {:.1} per campaign)", sum(|p| p.men_lost), mean(|p| p.men_lost));
    println!(
        "  commanders fallen {} (mean {:.2}), returned wounded {}, heirs {}; freed men joined {}, companies founded by the freed {}",
        sum(|p| p.fallen),
        mean(|p| p.fallen),
        sum(|p| p.returned),
        sum(|p| p.heirs),
        sum(|p| p.freed),
        sum(|p| p.new_companies)
    );
    println!("  villages freed {}, burnt {}", sum(|p| p.villages_freed), sum(|p| p.villages_burnt));
    println!("  broodlords down {}, escaped {}; battles broken off (withdrawn) {}", sum(|p| p.foes_down), sum(|p| p.foes_escaped), sum(|p| p.withdrawals));
    println!("  sim time {:.0} s total, {:.0} s per campaign; wall {:.2} s per campaign (one thread), {:.1} s in all", sim, sim / n, wall_each / n, wall);
}

/// One check's result.
struct Check {
    name: &'static str,
    pass: bool,
    counts: String,
}

/// The campaign's checks, each printing its counts: every campaign ends; a save and load at every between-battle
/// phase gives the same state; the same seed plays the same campaign; links obey L±1; garrison sizes follow the
/// formula; names are distinct and sayable.
pub fn checks(n: u32, seed0: u32, bot: Policy, tune: &Tune) -> Result<(), String> {
    let seeds: Vec<u32> = (seed0..seed0 + n).collect();
    let played = run_seeds(&seeds, bot, tune, true);
    let again = run_seeds(&seeds, bot, tune, false);
    let mut all = vec![
        ends(&played),
        round_trip(&played, tune),
        same_seed(&played, &again),
        links(&seeds, tune),
        garrisons(&seeds, tune),
        names(&seeds, tune),
    ];
    all.push(Check { name: "checks ran", pass: true, counts: format!("{n} campaigns from seed {seed0}, bot {}", bot.name()) });
    let mut failed = 0;
    for c in &all {
        failed += usize::from(!c.pass);
        println!("{} {}: {}", if c.pass { "PASS" } else { "FAIL" }, c.name, c.counts);
    }
    println!("campaign checks: {} of {} pass", all.len() - failed, all.len());
    if failed > 0 { Err(format!("{failed} campaign checks failed")) } else { Ok(()) }
}

fn ends(played: &[(Played, f64)]) -> Check {
    let ended = played.iter().filter(|(p, _)| matches!(p.reason.as_str(), "keep taken" | "captain fell" | "warband gone")).count();
    let other: Vec<String> = played.iter().filter(|(p, _)| !matches!(p.reason.as_str(), "keep taken" | "captain fell" | "warband gone")).map(|(p, _)| format!("{}:{}", p.seed, p.reason)).collect();
    let battles: u32 = played.iter().map(|(p, _)| p.battles).sum();
    Check { name: "every campaign ends", pass: other.is_empty(), counts: format!("{ended} of {} ended (keep taken, captain fell or warband gone) over {battles} battles; others {other:?}", played.len()) }
}

fn round_trip(played: &[(Played, f64)], tune: &Tune) -> Check {
    let (mut n, mut same) = (0, 0);
    let mut phases: Vec<(String, usize)> = Vec::new();
    let mut bad = Vec::new();
    for (p, _) in played {
        for (phase, save) in &p.saves {
            n += 1;
            let ok = Campaign::load(save, tune.clone()).is_ok_and(|c| c.save().is_ok_and(|s2| s2 == *save) && c.state() == Campaign::load(save, tune.clone()).expect("loads").state());
            same += usize::from(ok);
            if !ok {
                bad.push(format!("{}:{phase}", p.seed));
            }
            match phases.iter_mut().find(|(k, _)| k == phase) {
                Some(e) => e.1 += 1,
                None => phases.push((phase.clone(), 1)),
            }
        }
    }
    // A save of another version is refused.
    let refused = played.first().and_then(|(p, _)| p.saves.first()).is_some_and(|(_, s)| {
        let mut v: Value = serde_json::from_str(s).expect("a save");
        v["v"] = Value::from(99);
        Campaign::load(&v.to_string(), tune.clone()).is_err()
    });
    Check {
        name: "save/load round trip at every between-battle phase",
        pass: same == n && n > 0 && refused,
        counts: format!("{same} of {n} saves load to an identical save and state, by phase {phases:?}; a v99 save refused: {refused}; bad {bad:?}"),
    }
}

fn same_seed(a: &[(Played, f64)], b: &[(Played, f64)]) -> Check {
    let key = |p: &Played| format!("{} {} {} {} {} {} {} {} {} {:.6}", p.won, p.reason, p.steps, p.battles, p.men_lost, p.fallen, p.returned, p.foes_down, p.days, p.sim_s);
    let same = a.iter().zip(b).filter(|((x, _), (y, _))| key(x) == key(y)).count();
    let created = a.iter().filter(|(p, _)| {
        let c1 = Campaign::create(p.seed, &Opts::default(), Tune::default());
        let c2 = Campaign::create(p.seed, &Opts::default(), Tune::default());
        c1.save() == c2.save()
    });
    let created = created.count();
    let differ = a.windows(2).filter(|w| Campaign::create(w[0].0.seed, &Opts::default(), Tune::default()).save() != Campaign::create(w[1].0.seed, &Opts::default(), Tune::default()).save()).count();
    Check {
        name: "same seed, same campaign",
        pass: same == a.len() && created == a.len() && differ + 1 == a.len().max(1),
        counts: format!("{same} of {} campaigns played twice end alike (outcome, steps, battles, losses, days, sim time); {created} created twice alike; {differ} of {} neighbouring seeds differ", a.len(), a.len().saturating_sub(1)),
    }
}

fn links(seeds: &[u32], tune: &Tune) -> Check {
    let (mut n, mut ok, mut keep, mut hall) = (0, 0, 0, 0);
    let mut kinds = [0usize; 5];
    for &s in seeds {
        let c = Campaign::create(s, &Opts::default(), tune.clone());
        let t = &tune.campaign;
        for p in &c.places {
            kinds[p.kind as usize] += 1;
            for &to in &p.links {
                n += 1;
                let q = c.place(to).expect("a linked place");
                let fine = if q.kind == PlaceKind::Keep { p.step + 1 == t.rows } else { q.step == p.step + 1 && q.lane.abs_diff(p.lane) <= 1 };
                ok += usize::from(fine);
                keep += usize::from(q.kind == PlaceKind::Keep);
            }
            if p.step == 0 {
                hall += 1;
            }
        }
        // Row 0 is all holdfasts; every place but the keep has at least one link.
        if c.places.iter().any(|p| p.step == 0 && p.kind != PlaceKind::Holdfast) || c.places.iter().any(|p| p.kind != PlaceKind::Keep && p.links.is_empty()) {
            ok = 0;
        }
    }
    let rolled: usize = kinds.iter().sum::<usize>() - seeds.len() * 4;
    Check {
        name: "links obey L±1",
        pass: ok == n && n > 0,
        counts: format!(
            "{ok} of {n} links go one row on within ±1 lane ({keep} to the keep), {hall} from the hall; kinds over {} places: holdfast {}, village {}, ford {}, camp {}, keep {} (later rows: {rolled} rolled)",
            kinds.iter().sum::<usize>(),
            kinds[0],
            kinds[1],
            kinds[2],
            kinds[3],
            kinds[4]
        ),
    }
}

fn garrisons(seeds: &[u32], tune: &Tune) -> Check {
    let (mut n, mut ok) = (0, 0);
    let mut worth_err: f64 = 0.0;
    let mut sizes: Vec<String> = Vec::new();
    for &s in seeds {
        let c = Campaign::create(s, &Opts::default(), tune.clone());
        let mut c = c;
        c.auto_muster().expect("muster");
        let first = c.reachable()[0];
        c.set_out(first).expect("set out");
        let t = tune.campaign.clone();
        let w = c.warband_worth();
        for p in c.places.clone() {
            if !p.kind.held() {
                continue;
            }
            for danger in [0, 2] {
                let mut q = p.clone();
                q.danger = danger;
                n += 1;
                let share = t.share[0] + t.share[1] * q.step as f64 + t.share[2] * danger as f64;
                let want_kinds = 3 + usize::from(q.step >= t.spear_from) + usize::from(danger > 0) + usize::from(q.step >= t.horse_from) + usize::from(q.kind == PlaceKind::Keep);
                // The rule's kinds as blight units at full count, and their worth; m makes them worth share·factor·W.
                let worth = |u: sim::units::Unit| tune.unit_spec(u).map_or(0.0, |s| s.men as f64 * s.worth(&tune.rank, 0));
                let full: f64 = c.garrison_kinds(&q).into_iter().map(|k| worth(c.blight_unit(k))).sum();
                let m = share * t.warband_factor * w / full;
                let g = c.garrison(&q);
                let men_ok = g.iter().all(|k| {
                    let full = tune.unit_spec(k.unit).map_or(1, |s| s.men) as f64;
                    k.men == Some(((full * m).round() as u16).max(1)) && k.rank == (q.step / t.rank_every) as u8
                });
                let got: f64 = g.iter().map(|k| k.men.unwrap_or(0) as f64 * tune.unit_spec(k.unit).map_or(0.0, |s| s.worth(&tune.rank, 0))).sum();
                worth_err = worth_err.max((got / (share * t.warband_factor * w) - 1.0).abs());
                if g.len() == want_kinds && men_ok && (c.garrison_share(&q) - m).abs() < 1e-9 {
                    ok += 1;
                }
                if s == seeds[0] && danger == 0 && (q.id == 0 || q.kind == PlaceKind::Keep) {
                    let men: u32 = g.iter().map(|k| k.men.unwrap_or(0) as u32).sum();
                    sizes.push(format!("step {} {}: {} companies, {men} men, m {:.3}", q.step, q.kind.name(), g.len(), m));
                }
            }
        }
    }
    Check { name: "garrison sizes follow the formula", pass: ok == n && n > 0, counts: format!("{ok} of {n} garrisons (danger 0 and 2) match kinds, men and rank; worth within {:.1}% of share·factor·W after rounding men; e.g. {}", worth_err * 100.0, sizes.join("; ")) }
}

fn names(seeds: &[u32], tune: &Tune) -> Check {
    let (mut sets, mut ok, mut words) = (0, 0, 0);
    let mut bad: [(usize, String); 3] = Default::default();
    for &s in seeds {
        let c = Campaign::create(s, &Opts::default(), tune.clone());
        let people: Vec<&str> = c.commanders.iter().map(|m| m.name.as_str()).chain(c.foes.iter().map(|f| f.name.as_str())).collect();
        let places: Vec<&str> = c.places.iter().map(|p| p.name.as_str()).collect();
        let villages: Vec<&str> = c.bands.iter().map(|b| b.village.as_str()).collect();
        for (k, set) in [&people, &places, &villages].into_iter().enumerate() {
            sets += 1;
            words += set.len();
            let distinct = sim::campaign::names::distinct_sounds(set);
            let short = set.iter().all(|w| (1..=2).contains(&sim::campaign::names::syllables(w)));
            let unique = set.iter().enumerate().all(|(i, a)| set[i + 1..].iter().all(|b| a != b && !sim::map::names::alike(a, b)));
            let pass = distinct && short && unique;
            ok += usize::from(pass);
            if !pass {
                bad[k].0 += 1;
                if bad[k].1.is_empty() {
                    bad[k].1 = format!("seed {s}: {set:?} (sounds {distinct}, short {short}, unalike {unique})");
                }
            }
        }
    }
    Check {
        name: "names: distinct first sounds, 1–2 syllables, none alike",
        pass: ok == sets,
        counts: format!(
            "{ok} of {sets} name sets ({words} names: commanders with broodlords, places, villages) pass; failing sets: people {}, places {}, villages {}; first: {} {} {}",
            bad[0].0, bad[1].0, bad[2].0, bad[0].1, bad[1].1, bad[2].1
        ),
    }
}
