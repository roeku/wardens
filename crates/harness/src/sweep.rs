//! `sweep`: many seeds of a bot-against-bot battle, natively and in parallel, printing the experience numbers
//! (first blow, share of men fighting, battle length, outcome counts by reason) and the jitter metrics of
//! docs/spec/00-start-here.md §A5: standing direction reversals per second per man, and march ↔ stand flips per
//! squad-minute. Every count is printed, so a gate cannot pass without running (01-flow.md §8).

use std::thread;

use sim::battle::{Battle, HouseState, Order, OutcomeReason, Setup, SquadState, Tally};
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
    /// The armies (`Setup::named`): blight or mirror.
    pub setup: String,
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
    /// Men at the start, per team.
    pub men_start: [usize; 2],
    /// What the blight's rules did (breath, the hunt, impact blows, pressing on drakes).
    pub tally: Tally,
    /// Flips by the order the company held, for finding jitter.
    pub flips_by: Vec<(String, u64)>,
    /// What day 4's places did (the town, the ford, the night).
    pub places: PlaceCounts,
}

/// Day 4's places in one battle (AGENTS.md rule 4: every rule prints its counts).
#[derive(Clone, Debug, Default)]
pub struct PlaceCounts {
    /// The town: houses fired and fallen, people burnt and freed, and the freed men who fell in.
    pub fired: u32,
    pub fallen: u32,
    pub burnt: u32,
    pub freed: u32,
    pub freed_men: u32,
    /// The ford: groups come in and gone, people saved and lost, raiders' companies come in.
    pub groups: u32,
    pub groups_done: u32,
    pub saved: u32,
    pub lost: u32,
    pub raiders: u32,
    /// The night: it fell, the relief's companies came, and the most torches lit at once.
    pub night: bool,
    pub relief: u32,
    pub torches: u32,
}

fn order_name(o: &Order) -> &'static str {
    o.name()
}

/// One battle, `us` as team 0 and `them` as team 1, measured tick by tick.
pub fn run_one(seed: u32, o: &Opts) -> Run {
    let setup = Setup::named(&o.setup, o.kind).expect("setup checked by the caller");
    let mut b = Battle::new(seed, MapOpts { kind: o.kind, width: o.width }, &setup, o.tune.clone());
    let mut bots = [Bot::new(o.us, 0), Bot::new(o.them, 1)];
    let limit = ((b.time_limit() + GRACE_S) * TICK_HZ as f64) as u32;
    let mut run = Run { seed, ..Run::default() };

    let mut last: Vec<(f64, f64)> = b.soldiers.iter().map(|m| (m.x, m.y)).collect();
    let mut step: Vec<(f64, f64)> = vec![(0.0, 0.0); b.soldiers.len()];
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
        // Companies join mid-battle (the ford's civilians and raiders, the night's relief, the freed).
        for m in &b.soldiers[last.len()..] {
            last.push((m.x, m.y));
            step.push((0.0, 0.0));
        }
        for s in &b.squads[states.len()..] {
            states.push(s.state);
            idle_since.push(b.tick);
        }
        let lit = (0..b.squads.len()).filter(|&i| b.torch_lit(i)).count() as u32;
        run.places.torches = run.places.torches.max(lit);
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
    run.tally = b.tally.clone();
    let p = &b.places;
    let pc = &mut run.places;
    pc.fired = p.houses.iter().filter(|h| h.state != HouseState::Standing).count() as u32;
    pc.fallen = p.houses.iter().filter(|h| h.state == HouseState::Fallen).count() as u32;
    pc.burnt = p.burnt_people;
    pc.freed = p.freed_people;
    // The freed fall in at the tick after the town is taken, which a sweep stops before: count what will come.
    pc.freed_men = if p.freed_people > 0 { p.freed_people.min(b.tune.places.town.freed_men as u32) } else { 0 };
    if let Some(f) = &p.ford {
        pc.groups = f.groups.iter().filter(|g| g.squad.is_some()).count() as u32;
        pc.groups_done = f.groups.iter().filter(|g| g.done).count() as u32;
        pc.saved = f.saved();
        let came: u32 = f.groups.iter().filter_map(|g| g.squad).map(|id| b.squads[id as usize].full as u32).sum();
        let here: u32 = f.groups.iter().filter(|g| !g.done).filter_map(|g| g.squad).map(|id| b.squads[id as usize].alive as u32).sum();
        pc.lost = came - pc.saved - here;
        pc.raiders = f.waves.iter().map(|w| w.squads.len() as u32).sum();
    }
    pc.night = p.nightfall.is_some();
    pc.relief = p.relief.len() as u32;
    // Soldiers, not civilians; everyone who came to the battle, those who joined it late included.
    for t in 0..2u8 {
        let troops = || b.squads.iter().filter(|s| s.team == t && s.kind != sim::contracts::Kind::Folk);
        run.men_start[t as usize] = troops().map(|s| s.full as usize).sum();
        run.men_left[t as usize] = troops().filter(|s| s.on_field()).map(|s| s.alive as usize).sum();
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
        "sweep {:?} {} ({}): {} (team 0) vs {} (team 1), {} seeds from {}",
        o.kind,
        o.width,
        if o.setup.is_empty() { "blight" } else { &o.setup },
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
    let sum = |f: &dyn Fn(&Tally) -> f64| runs.iter().map(|r| f(&r.tally)).sum::<f64>();
    let per = |x: f64| x / n.max(1.0);
    let (lost0, lost1): (usize, usize) = runs.iter().fold((0, 0), |(a, c), r| (a + r.men_start[0] - r.men_left[0], c + r.men_start[1] - r.men_left[1]));
    let (came0, came1): (usize, usize) = runs.iter().fold((0, 0), |(a, c), r| (a + r.men_start[0], c + r.men_start[1]));
    println!(
        "men lost per battle (soldiers, the late-comers included): team 0 {:.1} of {:.1}, team 1 {:.1} of {:.1}",
        per(lost0 as f64),
        per(came0 as f64),
        per(lost1 as f64),
        per(came1 as f64)
    );
    println!(
        "blight rules per battle: {:.1} jets, {:.1} burns ({:.1} harm, {:.2} kills), {:.1} scorch morale, {:.1} bites; impact blows {:.1} started, {:.1} landed, {:.1} missed; {:.0} press ticks",
        per(sum(&|t| t.jets as f64)),
        per(sum(&|t| t.burns as f64)),
        per(sum(&|t| t.burn_harm)),
        per(sum(&|t| t.burn_kills as f64)),
        per(sum(&|t| t.scorch)),
        per(sum(&|t| t.bites as f64)),
        per(sum(&|t| t.impacts as f64)),
        per(sum(&|t| t.landed as f64)),
        per(sum(&|t| t.missed as f64)),
        per(sum(&|t| t.presses as f64)),
    );
    let pc = |f: &dyn Fn(&PlaceCounts) -> u32| runs.iter().map(|r| f(&r.places)).sum::<u32>();
    let nights = runs.iter().filter(|r| r.places.night).count();
    let at_dawn = runs.iter().filter(|r| r.outcome.is_some_and(|(_, why)| why == OutcomeReason::Dawn)).count();
    let wins_at_dawn = runs.iter().filter(|r| r.outcome == Some((0, OutcomeReason::Dawn))).count();
    match o.kind {
        MapKind::Town => println!(
            "town per battle: {:.2} houses fired, {:.2} fallen; {:.2} people burnt, {:.2} freed ({} battles freed some; {:.2} freed men fall in)",
            per(pc(&|p| p.fired) as f64),
            per(pc(&|p| p.fallen) as f64),
            per(pc(&|p| p.burnt) as f64),
            per(pc(&|p| p.freed) as f64),
            runs.iter().filter(|r| r.places.freed > 0).count(),
            per(pc(&|p| p.freed_men) as f64),
        ),
        MapKind::Ford => println!(
            "ford per battle: {:.2} groups came, {:.2} gone; {:.2} saved, {:.2} lost of 20; {:.2} raider companies; {} battles saved nobody",
            per(pc(&|p| p.groups) as f64),
            per(pc(&|p| p.groups_done) as f64),
            per(pc(&|p| p.saved) as f64),
            per(pc(&|p| p.lost) as f64),
            per(pc(&|p| p.raiders) as f64),
            runs.iter().filter(|r| r.places.groups_done == r.places.groups && r.places.groups > 0 && r.places.saved == 0).count(),
        ),
        _ => {}
    }
    if o.kind != MapKind::Field && nights == 0 {
        println!("night: fell in 0 of {} battles; decided at dawn {at_dawn}", runs.len());
    } else if o.kind != MapKind::Field {
        println!(
            "night: fell in {nights} of {} battles; relief {:.2} companies per night; up to {:.1} torches lit; decided at dawn {at_dawn} (won by team 0 at dawn: {wins_at_dawn})",
            runs.len(),
            pc(&|p| p.relief) as f64 / nights.max(1) as f64,
            runs.iter().filter(|r| r.places.night).map(|r| r.places.torches as f64).sum::<f64>() / nights.max(1) as f64,
        );
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
        if o.kind != MapKind::Field {
            println!("gate: doing nothing no longer wins at dawn: {wins_at_dawn} of {} {}", runs.len(), pass(wins_at_dawn == 0));
        }
    }
    if undecided > 0 {
        println!("gate: every battle ends: {undecided} undecided FAIL");
    } else {
        println!("gate: every battle ends: PASS");
    }
}
