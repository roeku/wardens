//! `sweep`: many seeds of a bot-against-bot battle, natively and in parallel, printing the experience numbers
//! (first blow, share of men fighting, battle length, outcome counts by reason) and the jitter metrics of
//! docs/spec/00-start-here.md §A5: standing direction reversals per second per man, and march ↔ stand flips per
//! squad-minute. Every count is printed, so a gate cannot pass without running (01-flow.md §8).

use std::thread;

use sim::battle::{Battle, Order, OutcomeReason, Setup, SquadState};
use sim::bots::{Bot, BotKind};
use sim::contracts::{EventCode, TICK_HZ, Team};
use sim::map::{MapKind, MapOpts};
use sim::tune::Tune;

/// A man counts as moving for the reversal metric above this speed (tiles/s): below it a reversal can't be seen.
const REVERSAL_SPEED: f64 = 0.05;
/// A block counts as standing once it has been idle this long (s): the instant a fight or a march ends, men
/// turning back once is a change of direction, not the shiver the gate measures.
const SETTLED_S: f64 = 1.0;
/// Seconds simulated past the battle's own time limit before a sweep gives up on it.
const GRACE_S: f64 = 30.0;

pub struct Opts {
    pub kind: MapKind,
    pub width: u16,
    pub us: BotKind,
    pub them: BotKind,
    pub seeds: u32,
    pub from: u32,
    pub verbose: bool,
    pub tune: Tune,
}

#[derive(Clone, Debug, Default)]
pub struct Run {
    pub seed: u32,
    pub outcome: Option<(Team, OutcomeReason)>,
    pub length_s: f64,
    pub first_blow_s: Option<f64>,
    /// Sum over ticks after the first blow of (men engaged / men alive), and the ticks counted.
    pub fighting: f64,
    pub fighting_ticks: u64,
    pub reversals: u64,
    pub standing_ticks: u64,
    /// The same over every idle man, settled or not.
    pub reversals_all: u64,
    pub idle_ticks: u64,
    pub flips: u64,
    pub squad_ticks: u64,
    pub men_left: [usize; 2],
    /// Flips by the order the company held, for finding jitter.
    pub flips_by: Vec<(String, u64)>,
}

fn order_name(o: &Order) -> &'static str {
    match o {
        Order::Hold { .. } => "hold",
        Order::Move { .. } => "move",
        Order::Attack { .. } => "attack",
        Order::Take { .. } => "take",
        Order::Follow => "follow",
        Order::Guard { .. } => "guard",
        Order::Recall { .. } => "recall",
        Order::Retreat => "retreat",
        Order::Ride => "ride",
    }
}

/// One battle, `us` as team 0 and `them` as team 1, measured tick by tick.
pub fn run_one(seed: u32, o: &Opts) -> Run {
    let mut b = Battle::new(seed, MapOpts { kind: o.kind, width: o.width }, &Setup::for_map(o.kind), o.tune.clone());
    let mut bots = [Bot::new(o.us, 0), Bot::new(o.them, 1)];
    let limit = ((b.time_limit() + GRACE_S) * TICK_HZ as f64) as u32;
    let mut run = Run { seed, ..Run::default() };
    let n = b.soldiers.len();
    let mut last: Vec<(f64, f64)> = b.soldiers.iter().map(|m| (m.x, m.y)).collect();
    let mut step: Vec<(f64, f64)> = vec![(0.0, 0.0); n];
    let mut states: Vec<SquadState> = b.squads.iter().map(|s| s.state).collect();
    let mut idle_since: Vec<u32> = vec![0; b.squads.len()];
    let settled = (SETTLED_S * TICK_HZ as f64) as u32;
    let min_step = REVERSAL_SPEED / TICK_HZ as f64;
    while b.outcome().is_none() && b.tick < limit {
        for bot in bots.iter_mut() {
            for c in bot.think(&b) {
                b.apply(c);
            }
        }
        b.step(1);
        for e in b.drain_events() {
            if e.code == EventCode::Hit && run.first_blow_s.is_none() {
                run.first_blow_s = Some(e.tick as f64 / TICK_HZ as f64);
            }
        }
        let (mut alive, mut engaged) = (0usize, 0usize);
        for (k, m) in b.soldiers.iter().enumerate() {
            let d = (m.x - last[k].0, m.y - last[k].1);
            last[k] = (m.x, m.y);
            if !m.alive {
                step[k] = (0.0, 0.0);
                continue;
            }
            alive += 1;
            engaged += m.engaged as usize;
            let s = &b.squads[m.squad as usize];
            let idle = s.state == SquadState::Idle && m.target.is_none();
            if idle {
                let p = step[k];
                let moving = |v: (f64, f64)| v.0 * v.0 + v.1 * v.1 > min_step * min_step;
                let reversed = moving(d) && moving(p) && d.0 * p.0 + d.1 * p.1 < 0.0;
                run.idle_ticks += 1;
                run.reversals_all += reversed as u64;
                if b.tick >= idle_since[m.squad as usize] + settled {
                    run.standing_ticks += 1;
                    run.reversals += reversed as u64;
                }
            }
            step[k] = d;
        }
        if run.first_blow_s.is_some() && alive > 0 {
            run.fighting += engaged as f64 / alive as f64;
            run.fighting_ticks += 1;
        }
        for (i, s) in b.squads.iter().enumerate() {
            if !s.on_field() {
                continue;
            }
            run.squad_ticks += 1;
            let was = states[i];
            if s.state != SquadState::Idle || was != SquadState::Idle {
                idle_since[i] = b.tick;
            }
            let flip = matches!((was, s.state), (SquadState::Marching, SquadState::Idle) | (SquadState::Idle, SquadState::Marching));
            run.flips += flip as u64;
            if flip {
                let key = format!("{:?}/{}", s.kind, order_name(&s.order));
                match run.flips_by.iter_mut().find(|x| x.0 == key) {
                    Some(x) => x.1 += 1,
                    None => run.flips_by.push((key, 1)),
                }
            }
            states[i] = s.state;
        }
    }
    run.outcome = b.outcome();
    run.length_s = b.time();
    for t in 0..2u8 {
        run.men_left[t as usize] = b.squads.iter().filter(|s| s.team == t && s.on_field()).map(|s| s.alive as usize).sum();
    }
    run
}

pub fn sweep(o: &Opts) -> Vec<Run> {
    let seeds: Vec<u32> = (o.from..o.from + o.seeds).collect();
    let workers = thread::available_parallelism().map_or(4, |n| n.get()).min(seeds.len().max(1));
    let mut runs: Vec<Run> = thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|w| {
                let mine: Vec<u32> = seeds.iter().copied().skip(w).step_by(workers).collect();
                scope.spawn(move || mine.into_iter().map(|s| run_one(s, o)).collect::<Vec<_>>())
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().expect("sweep worker")).collect()
    });
    runs.sort_by_key(|r| r.seed);
    runs
}

/// Prints the per-seed rows (with `verbose`), the summary and the gates that apply.
pub fn report(o: &Opts, runs: &[Run]) {
    let n = runs.len() as f64;
    println!(
        "sweep {:?} {}: {} (team 0) vs {} (team 1), {} seeds from {}",
        o.kind,
        o.width,
        o.us.name(),
        o.them.name(),
        runs.len(),
        o.from
    );
    if o.verbose {
        println!("  seed  winner  reason         length  first blow  fighting  men left  rev/s/man  flips/sq-min");
        for r in runs {
            let (w, why) = r.outcome.map_or(("-".to_string(), "undecided"), |(t, why)| (t.to_string(), why.name()));
            println!(
                "  {:>4}  {:>6}  {:<13}  {:>6.1}  {:>10}  {:>7.1}%  {:>3} / {:<3}  {:>9.3}  {:>12.2}",
                r.seed,
                w,
                why,
                r.length_s,
                r.first_blow_s.map_or("-".into(), |s| format!("{s:.1}")),
                100.0 * r.fighting / r.fighting_ticks.max(1) as f64,
                r.men_left[0],
                r.men_left[1],
                r.reversals as f64 / (r.standing_ticks as f64 / TICK_HZ as f64).max(1e-9),
                r.flips as f64 / (r.squad_ticks as f64 / TICK_HZ as f64 / 60.0).max(1e-9),
            );
        }
    }
    let wins = |t: Team| runs.iter().filter(|r| r.outcome.is_some_and(|(w, _)| w == t)).count();
    let undecided = runs.iter().filter(|r| r.outcome.is_none()).count();
    let (w0, w1) = (wins(0), wins(1));
    println!("wins: team 0 {w0}/{} ({:.1}%), team 1 {w1}/{} ({:.1}%), undecided {undecided}", runs.len(), 100.0 * w0 as f64 / n, runs.len(), 100.0 * w1 as f64 / n);
    let mut reasons: Vec<(OutcomeReason, Team, usize)> = Vec::new();
    for r in runs {
        if let Some((t, why)) = r.outcome {
            match reasons.iter_mut().find(|x| x.0 == why && x.1 == t) {
                Some(x) => x.2 += 1,
                None => reasons.push((why, t, 1)),
            }
        }
    }
    reasons.sort();
    let rs: Vec<String> = reasons.iter().map(|(why, t, c)| format!("{} by team {t}: {c}", why.name())).collect();
    println!("reasons: {}", if rs.is_empty() { "none".into() } else { rs.join(" | ") });
    let lens: Vec<f64> = runs.iter().map(|r| r.length_s).collect();
    let mean = |v: &[f64]| if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 };
    println!(
        "length s: mean {:.1}, min {:.1}, max {:.1}",
        mean(&lens),
        lens.iter().copied().fold(f64::INFINITY, f64::min),
        lens.iter().copied().fold(0.0, f64::max)
    );
    let blows: Vec<f64> = runs.iter().filter_map(|r| r.first_blow_s).collect();
    println!("first blow s: mean {:.1}, min {:.1}, max {:.1} ({} of {} battles had blows)", mean(&blows), blows.iter().copied().fold(f64::INFINITY, f64::min), blows.iter().copied().fold(0.0, f64::max), blows.len(), runs.len());
    let (fs, ft): (f64, u64) = runs.iter().fold((0.0, 0), |(a, b), r| (a + r.fighting, b + r.fighting_ticks));
    println!("share of men fighting: {:.1}% (mean over {} ticks from the first blow to the end)", 100.0 * fs / ft.max(1) as f64, ft);
    let (rev, st): (u64, u64) = runs.iter().fold((0, 0), |(a, b), r| (a + r.reversals, b + r.standing_ticks));
    let (fl, sq): (u64, u64) = runs.iter().fold((0, 0), |(a, b), r| (a + r.flips, b + r.squad_ticks));
    let man_s = st as f64 / TICK_HZ as f64;
    let sq_min = sq as f64 / TICK_HZ as f64 / 60.0;
    let rev_rate = rev as f64 / man_s.max(1e-9);
    let flip_rate = fl as f64 / sq_min.max(1e-9);
    println!("jitter: {rev} standing reversals in {man_s:.0} man-s = {rev_rate:.4} /s/man; {fl} march<->stand flips in {sq_min:.1} squad-min = {flip_rate:.2} /squad-min");
    let (ra, it): (u64, u64) = runs.iter().fold((0, 0), |(a, b), r| (a + r.reversals_all, b + r.idle_ticks));
    println!(
        "  (every idle man, settled or not: {ra} reversals in {:.0} man-s = {:.4} /s/man)",
        it as f64 / TICK_HZ as f64,
        ra as f64 / (it as f64 / TICK_HZ as f64).max(1e-9)
    );
    if o.verbose {
        let mut by: Vec<(String, u64)> = Vec::new();
        for r in runs {
            for (k, n) in &r.flips_by {
                match by.iter_mut().find(|x| &x.0 == k) {
                    Some(x) => x.1 += n,
                    None => by.push((k.clone(), *n)),
                }
            }
        }
        by.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let parts: Vec<String> = by.iter().take(10).map(|(k, n)| format!("{k} {n}")).collect();
        println!("flips by kind/order: {}", parts.join(", "));
    }
    let pass = |ok: bool| if ok { "PASS" } else { "FAIL" };
    println!("gate: standing reversals < 0.1 /s/man: {}", pass(rev_rate < 0.1));
    println!("gate: state flips < 10 /squad-min: {}", pass(flip_rate < 10.0));
    let share = 100.0 * w0 as f64 / n;
    if o.us == BotKind::Charge && matches!(o.them, BotKind::General(_)) && o.kind == MapKind::Field {
        println!("gate: mindless charge wins 20-60% of field battles: {share:.1}% {}", pass((20.0..=60.0).contains(&share)));
    }
    if o.us == BotKind::Idle {
        println!("gate: doing nothing wins 0%: {share:.1}% {}", pass(w0 == 0));
    }
    if undecided > 0 {
        println!("gate: every battle ends: {undecided} undecided FAIL");
    } else {
        println!("gate: every battle ends: PASS");
    }
}
