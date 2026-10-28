//! The order language's checks (docs/spec/08-orders.md §3–§8; AGENTS.md rule 4): one scenario per verb, modifier,
//! trigger and field work, each printing its counts. The unit tests assert them; `harness orders` prints them.
//! Every scenario gives its orders as text (`sim::text`), the way the harness and typed orders do.

use super::{Battle, Company, Order, SquadState, Stance};
use crate::contracts::{Command, EventCode, Kind, P, Source, Team, Tick};
use crate::map::{MapKind, MapOpts, Tile, path};
use crate::math::{atan2, wrap};
use crate::tune::Tune;
use crate::units::Unit;

use super::Setup;

/// One check's outcome: what it measured, and whether that proves the behaviour.
#[derive(Clone, Debug)]
pub struct Check {
    pub name: &'static str,
    pub counts: String,
    pub pass: bool,
}

/// A check's scenario.
pub type Scenario = fn() -> Check;

/// Every check, by name.
pub const ALL: &[(&str, Scenario)] = &[
    ("hold fire", hold_fire),
    ("aggressive", aggressive),
    ("defensive", defensive),
    ("skirmish", skirmish),
    ("pursue", pursue),
    ("pace", pace),
    ("shapes", shapes),
    ("priorities", priorities),
    ("with", with),
    ("set", set),
    ("squads", squads),
    ("wait done", wait_done),
    ("wait signal", wait_signal),
    ("wait after", wait_after),
    ("wait enemy near", wait_enemy_near),
    ("wait breaks", wait_breaks),
    ("wait captain attacked", wait_captain),
    ("wait nightfall and dawn", wait_night),
    ("army waits", army_waits),
    ("guard", guard),
    ("screen", screen),
    ("charge", charge),
    ("withdraw", withdraw),
    ("regroup", regroup),
    ("reserve and commit", reserve),
    ("face", face),
    ("held and advance", held),
    ("stakes", stakes),
    ("barricade", barricade),
    ("bridge", bridge),
    ("watchtower", watchtower),
    ("building is interrupted", interrupted),
    ("works are torn down", torn_down),
    ("the blight raids works", raided),
];

/// Runs every check.
pub fn all() -> Vec<Check> {
    ALL.iter().map(|(_, f)| f()).collect()
}

fn field() -> Battle {
    Battle::new(7, MapOpts { kind: MapKind::Field, width: 48 }, &Setup::field(), Tune::default())
}

fn named(b: &Battle, name: &str) -> usize {
    b.squads.iter().position(|s| s.name == name).unwrap_or_else(|| panic!("no {name}"))
}

/// Gives `text` as `team`'s order now. Returns the refusal's reason, if refused.
fn give(b: &mut Battle, team: Team, text: &str) -> Option<String> {
    let deed = crate::text::parse(b, team, text).unwrap_or_else(|e| panic!("{text}: {e}"));
    let before = b.refusals.len();
    b.apply(Command { tick: b.tick, team, deed, src: Source::Typed, note: None });
    b.flush();
    b.refusals.get(before).map(|r| r.why.clone())
}

/// Squad `i` stood at `at` facing `face`, every man in his slot, holding there detached.
fn place(b: &mut Battle, i: usize, at: P, face: f64) {
    let s = &mut b.squads[i];
    (s.x, s.y, s.facing, s.post) = (at.x, at.y, face, at);
    s.order = Order::Hold { face: Some(face) };
    s.detached = true;
    let n = s.alive as usize;
    let men = s.soldiers.clone();
    for k in men {
        let p = b.slot(&b.squads[i], b.soldiers[k].slot, n);
        (b.soldiers[k].x, b.soldiers[k].y, b.soldiers[k].heading) = (p.x, p.y, face);
    }
}

fn settle(b: &mut Battle) {
    b.rebucket();
    b.measure();
    b.update_sight();
}

/// Our companies (squads 1..) facing east at x = 20 against theirs facing west at x = 20 + `gap` (front rank to
/// front rank), 4.5 apart down the line, on the open field; our captain stands far back at (5, 13.5).
fn duel(ours: &[Unit], theirs: &[Unit], gap: f64, tune: Tune) -> Battle {
    let co = |u: &Unit| Company::of(*u, "");
    let setup = Setup { warband: ours.iter().map(co).collect(), garrison: theirs.iter().map(co).collect(), general: None, mirror: false, held: false };
    let mut b = Battle::new(7, MapOpts { kind: MapKind::Field, width: 48 }, &setup, tune);
    place(&mut b, 0, P::new(5.0, 13.5), 0.0);
    b.squads[0].detached = false;
    let y = |k: usize, n: usize| 13.5 + (k as f64 - (n as f64 - 1.0) / 2.0) * 4.5;
    for (k, _) in ours.iter().enumerate() {
        place(&mut b, 1 + k, P::new(20.0, y(k, ours.len())), 0.0);
    }
    for (k, _) in theirs.iter().enumerate() {
        place(&mut b, 1 + ours.len() + k, P::new(20.0 + gap, y(k, theirs.len())), std::f64::consts::PI);
    }
    settle(&mut b);
    b
}

/// A tune where nobody breaks, so a scenario runs its course.
fn steady() -> Tune {
    Tune::with_override(&serde_json::json!({"morale": {"rout_below": -1.0e9}})).expect("tune")
}

/// The closest living men of squads `i` and `j`.
fn gap(b: &Battle, i: usize, j: usize) -> f64 {
    let mut best = f64::INFINITY;
    for &a in &b.squads[i].soldiers {
        for &c in &b.squads[j].soldiers {
            let (ma, mc) = (&b.soldiers[a], &b.soldiers[c]);
            if ma.alive && mc.alive {
                best = best.min(ma.pos().dist(mc.pos()));
            }
        }
    }
    best
}

fn volleys(b: &mut Battle) -> usize {
    b.drain_events().iter().filter(|e| e.code == EventCode::Volley).count()
}

// ------------------------------------------------------------------------------------------------- stances

fn hold_fire() -> Check {
    let run = |hold: bool| {
        let mut b = duel(&[Unit::Archer], &[Unit::Spear], 6.0, steady());
        if hold {
            give(&mut b, 0, "stance 1 holdfire");
        }
        let mut v = 0;
        for _ in 0..(10 * 30) {
            b.step(1);
            v += volleys(&mut b);
        }
        (b.tally.arrows, v)
    };
    let (normal, held) = (run(false), run(true));
    Check {
        name: "hold fire",
        counts: format!("archers 6 tiles from spears for 10 s: normal {} arrows in {} volleys; hold fire {} arrows in {} volleys", normal.0, normal.1, held.0, held.1),
        pass: normal.0 > 0 && held == (0, 0),
    }
}

fn aggressive() -> Check {
    let run = |stance: &str| {
        let mut b = duel(&[Unit::Spear], &[Unit::BlightMan], 4.0, steady());
        give(&mut b, 0, &format!("stance 1 {stance}"));
        let first = (0..(3 * 30)).find(|_| {
            b.step(1);
            b.squads[1].threat.is_some()
        });
        (first, b.rules(1))
    };
    let (normal, aggr) = (run("normal"), run("aggressive"));
    Check {
        name: "aggressive",
        counts: format!(
            "spears 4 tiles from holding blight-men: normal engage {:.1} seek {:.1}, engaged at tick {:?}; aggressive engage {:.1} seek {:.1} pursue {}, engaged at tick {:?}",
            normal.1.engage, normal.1.seek, normal.0, aggr.1.engage, aggr.1.seek, aggr.1.pursue, aggr.0
        ),
        pass: normal.0.is_none() && aggr.0.is_some() && aggr.1.pursue && !normal.1.pursue,
    }
}

fn defensive() -> Check {
    // Fight only what reaches it: a foe standing 2.3 away.
    let engaged = |stance: &str| {
        let mut b = duel(&[Unit::Spear], &[Unit::BlightMan], 2.3, steady());
        give(&mut b, 0, &format!("stance 1 {stance}"));
        // The blight-men stand: they strike only what reaches them.
        give(&mut b, 1, "stance 2 holdfire");
        (0..(3 * 30)).filter(|_| {
            b.step(1);
            b.squads[1].threat.is_some()
        }).count()
    };
    // Never leave the post: the blight-men attack, then walk off with our men at their heels.
    let leash = |stance: &str| {
        let mut b = duel(&[Unit::Spear], &[Unit::BlightMan], 3.0, steady());
        give(&mut b, 0, &format!("stance 1 {stance}"));
        let post = P::new(b.squads[1].x, b.squads[1].y);
        give(&mut b, 1, "attack 2 E1");
        b.step(6 * 30);
        give(&mut b, 1, "send 2 40 13.5");
        let mut far = 0.0f64;
        for _ in 0..(8 * 30) {
            b.step(1);
            far = far.max(P::new(b.squads[1].x, b.squads[1].y).dist(post));
        }
        far
    };
    let (n_ticks, d_ticks) = (engaged("normal"), engaged("defensive"));
    let (n_far, d_far) = (leash("normal"), leash("defensive"));
    let limit = Tune::default().stance.leash;
    Check {
        name: "defensive",
        counts: format!(
            "a foe 2.3 away: engaged {n_ticks} of 90 ticks normal, {d_ticks} defensive; after a fight the anchor strayed {n_far:.2} normal, {d_far:.2} defensive (leash {limit})"
        ),
        pass: n_ticks > 0 && d_ticks == 0 && d_far <= limit + 1e-6,
    }
}

fn skirmish() -> Check {
    let run = |stance: &str| {
        let mut b = duel(&[Unit::Archer], &[Unit::BlightMan], 5.0, steady());
        give(&mut b, 0, &format!("stance 1 {stance}"));
        give(&mut b, 1, "attack 2 E1");
        let (mut contact, mut sum, mut n) = (0, 0.0, 0);
        let mut least = f64::INFINITY;
        for t in 0..(20 * 30) {
            b.step(1);
            if b.squads[1].alive == 0 || b.squads[2].alive == 0 {
                break;
            }
            let g = gap(&b, 1, 2);
            if t >= 30 {
                least = least.min(g);
            }
            sum += g;
            n += 1;
            contact += (g <= b.tune.combat.reach + 0.05) as u32;
        }
        (least, sum / n as f64, contact, b.tally.arrows, b.squads[2].alive)
    };
    let (normal, skirm) = (run("normal"), run("skirmish"));
    Check {
        name: "skirmish",
        counts: format!(
            "blight-men attack archers 5 away, 20 s: normal closest {:.2} mean {:.2}, {} ticks in reach, {} arrows, {} foes left; skirmish closest {:.2} mean {:.2}, {} ticks in reach, {} arrows, {} foes left",
            normal.0, normal.1, normal.2, normal.3, normal.4, skirm.0, skirm.1, skirm.2, skirm.3, skirm.4
        ),
        pass: skirm.2 * 2 < normal.2.max(1) && skirm.1 > normal.1 && skirm.3 > 0,
    }
}

fn pursue() -> Check {
    let run = |on: bool| {
        let mut b = duel(&[Unit::Spear], &[Unit::BlightMan], 2.0, Tune::default());
        if on {
            give(&mut b, 0, "pursue 1 on");
        }
        give(&mut b, 0, "attack 1 E2");
        b.step(30);
        b.squads[2].morale = 0.0;
        b.step(1);
        let from = P::new(b.squads[1].x, b.squads[1].y);
        b.step(6 * 30);
        let still = matches!(b.squads[1].order, Order::Attack { .. });
        (P::new(b.squads[1].x, b.squads[1].y).dist(from), still, b.squads[2].state)
    };
    let (off, on) = (run(false), run(true));
    Check {
        name: "pursue",
        counts: format!(
            "the foe routs mid-fight: pursuit off moved {:.1} (still attacking: {}), on moved {:.1} (still attacking: {}, foe {:?})",
            off.0, off.1, on.0, on.1, on.2
        ),
        pass: !off.1 && on.0 > off.0 + 2.0,
    }
}

fn pace() -> Check {
    let time = |pace: &str| {
        let mut b = field();
        let wil = named(&b, "WIL");
        let start = P::new(b.squads[wil].x, b.squads[wil].y);
        let to = P::new(start.x + 8.0, start.y);
        give(&mut b, 0, &format!("with pace={pace} send WIL {} {}", to.x, to.y));
        (0..(30 * 30)).find(|_| {
            b.step(1);
            b.squads[wil].done
        })
    };
    let (walk, quick, double) = (time("walk"), time("quick"), time("double"));
    // Double time with the army: column at once.
    let mut b = field();
    give(&mut b, 0, "with pace=double march 20 13.5");
    let column_at = (0..(4 * 30)).find(|_| {
        b.step(1);
        b.armies[0].formation == super::Formation::Column
    });
    let mut q = field();
    give(&mut q, 0, "march 20 13.5");
    let quick_column = (0..(4 * 30)).find(|_| {
        q.step(1);
        q.armies[0].formation == super::Formation::Column
    });
    Check {
        name: "pace",
        counts: format!("WIL marches 8 tiles in {walk:?} ticks walking, {quick:?} quick, {double:?} at double time; the army forms column at tick {column_at:?} at double time, {quick_column:?} quick"),
        pass: matches!((walk, quick, double), (Some(w), Some(q), Some(d)) if w > q && q > d) && column_at < quick_column,
    }
}

fn shapes() -> Check {
    let mut b = field();
    let wil = named(&b, "WIL");
    // Ranks (distinct distances behind the anchor), files (most men in a rank) and the file gap of each shape.
    let measure = |b: &Battle| {
        let s = &b.squads[wil];
        let n = s.alive as usize;
        let pts: Vec<(f64, f64)> = (1..n as u16)
            .map(|k| {
                let p = b.slot(s, k, n);
                let (dx, dy) = (p.x - s.x, p.y - s.y);
                let f = P::from_angle(s.facing);
                (-(dx * f.x + dy * f.y), dx * f.y - dy * f.x)
            })
            .collect();
        let mut ranks: Vec<f64> = Vec::new();
        for &(back, _) in &pts {
            if !ranks.iter().any(|&r| (r - back).abs() < 1e-6) {
                ranks.push(back);
            }
        }
        let files = ranks.iter().map(|&r| pts.iter().filter(|p| (p.0 - r).abs() < 1e-6).count()).max().unwrap_or(0);
        let front: Vec<f64> = pts.iter().filter(|p| p.0.abs() < 1e-6).map(|p| p.1).collect();
        let gap = if front.len() > 1 { (front.iter().copied().fold(f64::MIN, f64::max) - front.iter().copied().fold(f64::MAX, f64::min)) / (front.len() - 1) as f64 } else { 0.0 };
        let centre = {
            let (x, y) = pts.iter().fold((0.0, 0.0), |(x, y), p| (x + p.0, y + p.1));
            (x / pts.len() as f64, y / pts.len() as f64)
        };
        let radii: Vec<f64> = pts.iter().map(|p| P::new(p.0, p.1).dist(P::new(centre.0, centre.1))).collect();
        let round = radii.iter().copied().fold(f64::MIN, f64::max) - radii.iter().copied().fold(f64::MAX, f64::min);
        (ranks.len(), files, gap, round)
    };
    let mut rows = Vec::new();
    let mut got = Vec::new();
    for form in ["block", "line", "column", "wedge", "square", "shieldwall", "loose", "tight", "files8"] {
        b.squads[wil].how = super::How::default();
        match form {
            "block" => {}
            "files8" => {
                give(&mut b, 0, "files WIL 8");
            }
            f => {
                give(&mut b, 0, &format!("form WIL {f}"));
            }
        }
        let m = measure(&b);
        rows.push(format!("{form} {}x{} gap {:.2}{}", m.0, m.1, m.2, if form == "square" { format!(" round ±{:.3}", m.3) } else { String::new() }));
        got.push(m);
    }
    let [block, line, column, wedge, square, wall, loose, tight, files8] = got[..] else { unreachable!() };
    Check {
        name: "shapes",
        counts: format!("WIL's 11 rank-and-file as ranks x files: {}", rows.join("; ")),
        pass: line.0 == 2
            && column.1 == 2
            && wedge.0 >= 3
            && square.3 < 1e-6
            && wall.0 == 2
            && wall.2 < block.2
            && loose.2 > block.2
            && tight.2 < block.2
            && files8.1 == 8,
    }
}

fn priorities() -> Check {
    // Our spears face blight-men 1.6 away and a troll company 2.3 away: nearest takes the blight-men.
    let run = |pri: &str| {
        let mut b = duel(&[Unit::Spear], &[Unit::BlightMan, Unit::Troll], 2.0, steady());
        place(&mut b, 2, P::new(21.6, 13.5), std::f64::consts::PI);
        place(&mut b, 3, P::new(22.3, 17.0), std::f64::consts::PI);
        settle(&mut b);
        give(&mut b, 0, &format!("priority 1 {pri}"));
        b.step(15);
        let threat = b.squads[1].threat;
        let at_troll = b.squads[1].soldiers.iter().filter(|&&k| b.soldiers[k].target.is_some_and(|t| b.soldiers[t].squad == 3)).count();
        let seen = crate::bots::seen(&b, 0);
        let bot = crate::bots::pick(&b, 0, &seen, b.centre(1), 24.0, b.squads[1].how.priority).map(|f| f.id);
        let best = b.best_foe(1, 24.0);
        (threat, at_troll, bot, best)
    };
    let near = run("nearest");
    let troll = run("troll");
    // Weakest, strongest and the commander on the open field, from WIL, as the squads, men and bots score them.
    let mut f = field();
    let wil = named(&f, "WIL");
    f.squads[7].morale = 30.0;
    let mut pick = |pri: &str| {
        give(&mut f, 0, &format!("priority WIL {pri}"));
        let (from, p) = (f.centre(wil), f.squads[wil].how.priority);
        (0..f.squads.len())
            .filter(|&j| f.squads[j].team == 1)
            .min_by(|&x, &y| f.priority_score(0, from, x, p).total_cmp(&f.priority_score(0, from, y, p)).then(x.cmp(&y)))
            .map(|j| j as u16)
    };
    let (weak, strong, cmd) = (pick("weakest"), pick("strongest"), pick("commander"));
    let strength = |b: &Battle, j: usize| b.squads[j].strength(&b.tune) * b.squads[j].morale_share();
    let foes: Vec<usize> = (0..f.squads.len()).filter(|&j| f.squads[j].team == 1).collect();
    // Attacking: the foe striking ODA.
    let mut a = duel(&[Unit::Spear, Unit::Shield], &[Unit::BlightMan, Unit::BlightMan], 1.0, steady());
    b_step(&mut a, 60);
    let on_shield = a.attackers_of(2);
    give(&mut a, 0, "priority 1 attacking:2");
    let att = a.best_foe(1, f64::INFINITY);
    Check {
        name: "priorities",
        counts: format!(
            "nearest: threat {:?}, {} men at the trolls, bot {:?}, pick {:?}; troll: threat {:?}, {} men at the trolls, bot {:?}, pick {:?}; field: weakest {:?} (morale 30 company 7), strongest {:?}, commander {:?} (the broodlord {:?}); attacking ODA: {:?} strike it, pick {:?}",
            near.0, near.1, near.2, near.3, troll.0, troll.1, troll.2, troll.3, weak, strong, cmd, f.captain_of(1), on_shield, att
        ),
        pass: near.0 == Some(2)
            && troll.0 == Some(3)
            && troll.1 > near.1
            && troll.2 == Some(3)
            && near.2 == Some(2)
            && weak == Some(7)
            && strong.is_some_and(|s| foes.iter().all(|&j| f.squads[j].kind == Kind::Captain || strength(&f, j) <= strength(&f, s as usize) + 1e-9))
            && cmd.map(|c| c as usize) == f.captain_of(1)
            && att.is_some_and(|t| on_shield.contains(&t)),
    }
}

fn b_step(b: &mut Battle, n: u32) {
    b.step(n);
}

// ------------------------------------------------------------------------------------------------- With, Set, Squads

fn with() -> Check {
    let mut b = field();
    let (ren, wil) = (named(&b, "REN"), named(&b, "WIL"));
    give(&mut b, 0, "with stance=holdfire pace=walk send REN 10 16");
    let ren_way = b.squads[ren].how.clone();
    let wil_way = b.squads[wil].how.clone();
    // With on an army order: every company it moves takes the way.
    give(&mut b, 0, "with form=wedge march 14 13.5");
    let wedges = b.squads.iter().filter(|s| s.team == 0 && s.how.shape == super::Shape::Wedge).count();
    let following = b.squads.iter().filter(|s| s.team == 0 && s.order == Order::Follow).count();
    Check {
        name: "with",
        counts: format!(
            "REN sent with hold fire at a walk: stance {:?}, pace {:?}, order {}; WIL untouched {:?}; an army march in a wedge: {wedges} squads wedge ({following} following + the captain)",
            ren_way.stance,
            ren_way.pace,
            b.squads[ren].order.name(),
            wil_way.stance
        ),
        pass: ren_way.stance == Stance::HoldFire && ren_way.pace == Some(super::Pace::Walk) && wil_way == super::How::default() && wedges == following + 1,
    }
}

fn set() -> Check {
    let mut b = field();
    let ren = named(&b, "REN");
    give(&mut b, 0, "send REN 10 16");
    let order = b.squads[ren].order.clone();
    give(&mut b, 0, "stance army holdfire");
    let held = b.squads.iter().filter(|s| s.team == 0 && s.how.stance == Stance::HoldFire).count();
    give(&mut b, 0, "set REN stance=skirmish priority=drake");
    let kept = b.squads[ren].order == order;
    // A new order keeps the standing way.
    give(&mut b, 0, "send REN 12 16");
    let way = b.squads[ren].how.clone();
    Check {
        name: "set",
        counts: format!("hold fire for everyone: {held} of 5 squads; REN's order kept through set: {kept}; after a new order REN is {:?} by {:?}", way.stance, way.priority),
        pass: held == 5 && kept && way.stance == Stance::Skirmish && way.priority == super::Priority::Unit { unit: Unit::Drake },
    }
}

fn squads() -> Check {
    let mut b = field();
    let (wil, oda) = (named(&b, "WIL"), named(&b, "ODA"));
    give(&mut b, 0, "attack WIL+ODA E6");
    let both = [wil, oda].iter().all(|&i| b.squads[i].order == Order::Attack { target: 6, via: Vec::new() } && b.squads[i].detached);
    give(&mut b, 0, "wait signal 1 hold WIL+ODA");
    let queued = (b.squads[wil].queue.len(), b.squads[oda].queue.len());
    let refused = give(&mut b, 0, "attack WIL+9 E6");
    let partly = b.refusals.len();
    Check {
        name: "squads",
        counts: format!("WIL+ODA attack E6 each alone: {both}; each queues its own wait: {queued:?}; WIL+9 refuses 9 only ({partly} refusal, deed refused: {refused:?})"),
        pass: both && queued == (1, 1) && partly == 1 && refused.is_some_and(|r| r.contains('9')),
    }
}

// ------------------------------------------------------------------------------------------------- triggers

fn wait_done() -> Check {
    let mut b = field();
    let wil = named(&b, "WIL");
    give(&mut b, 0, "send WIL 12 11");
    give(&mut b, 0, "then face WIL 1.5");
    let (mut done_at, mut released_at) = (None, None);
    for _ in 0..(20 * 30) {
        b.step(1);
        if done_at.is_none() && b.squads[wil].done {
            done_at = Some(b.tick);
        }
        if released_at.is_none() && b.squads[wil].queue.is_empty() {
            released_at = Some(b.tick);
        }
    }
    Check {
        name: "wait done",
        counts: format!("WIL arrived (done) after tick {done_at:?}; 'then face' released after tick {released_at:?}; now {:?}", b.squads[wil].order),
        pass: done_at.is_some() && released_at.is_some_and(|r| Some(r) == done_at.map(|d| d + 1)) && b.squads[wil].order == Order::Hold { face: Some(1.5) },
    }
}

fn wait_signal() -> Check {
    let mut b = field();
    let bors = named(&b, "BORS");
    give(&mut b, 0, "wait signal 2 send BORS 14 4");
    give(&mut b, 0, "wait signal 0 hold BORS");
    b.step(45);
    let before = (b.squads[bors].queue.len(), b.squads[bors].order.name());
    give(&mut b, 0, "signal 1");
    b.step(15);
    let wrong = b.squads[bors].queue.len();
    let signal_tick = b.tick;
    give(&mut b, 0, "signal 2");
    let still = b.squads[bors].queue.len();
    b.step(1);
    let after = (b.squads[bors].queue.len(), b.squads[bors].order.name());
    Check {
        name: "wait signal",
        counts: format!(
            "BORS waits on signals 2 and 0: before any signal {before:?}; after signal 1 still {wrong} waiting; signal 2 given at tick {signal_tick}: {still} waiting before the tick, {after:?} after it"
        ),
        pass: before == (2, "follow") && wrong == 2 && still == 2 && after == (1, "move"),
    }
}

fn wait_after() -> Check {
    let mut b = field();
    let ren = named(&b, "REN");
    let queued = b.tick;
    give(&mut b, 0, "wait after 2 stance REN holdfire");
    let released = (0..(4 * 30)).find_map(|_| {
        b.step(1);
        (b.squads[ren].how.stance == Stance::HoldFire).then_some(b.tick - 1)
    });
    Check {
        name: "wait after",
        counts: format!("queued at tick {queued}, released on tick {released:?} (2 s = 60 ticks)"),
        pass: released == Some(queued + 60),
    }
}

fn wait_enemy_near() -> Check {
    let mut b = field();
    let bors = named(&b, "BORS");
    let at = P::new(26.0, 13.5);
    let r = 3.0;
    give(&mut b, 0, &format!("wait near {} {} {r} charge BORS E6", at.x, at.y));
    give(&mut b, 1, "march 20 13.5");
    let (mut entered, mut released) = (None, None);
    for _ in 0..(40 * 30) {
        let inside = b.soldiers.iter().any(|m| m.alive && b.squads[m.squad as usize].team == 1 && m.pos().dist(at) <= r);
        if entered.is_none() && inside {
            entered = Some(b.tick);
        }
        b.step(1);
        if released.is_none() && b.squads[bors].queue.is_empty() {
            released = Some(b.tick - 1);
        }
        if released.is_some() {
            break;
        }
    }
    Check {
        name: "wait enemy near",
        counts: format!("the first foe man came within {r} of ({}, {}) on tick {entered:?}; BORS charged on tick {released:?} ({:?})", at.x, at.y, b.squads[bors].order.name()),
        pass: entered.is_some() && released == entered && b.squads[bors].order.name() == "charge",
    }
}

fn wait_breaks() -> Check {
    let mut b = field();
    let (wil, oda) = (named(&b, "WIL"), named(&b, "ODA"));
    give(&mut b, 0, &format!("wait breaks {wil} send ODA 12 13.5"));
    b.step(30);
    let before = b.squads[oda].queue.len();
    b.squads[wil].morale = 0.0;
    let broke = (0..30).find_map(|_| {
        b.step(1);
        (b.squads[wil].state == SquadState::Routing).then_some(b.tick)
    });
    b.step(1);
    let after = b.squads[oda].queue.len();
    Check {
        name: "wait breaks",
        counts: format!("ODA waits for WIL to break: {before} waiting; WIL routed by tick {broke:?}; then {after} waiting, ODA {}", b.squads[oda].order.name()),
        pass: before == 1 && broke.is_some() && after == 0 && b.squads[oda].order.name() == "move",
    }
}

fn wait_captain() -> Check {
    let mut b = field();
    let oda = named(&b, "ODA");
    give(&mut b, 0, "wait captain guard ODA me");
    b.step(30);
    let before = b.squads[oda].queue.len();
    let cap = b.captain_of(0).expect("captain");
    let man = b.squads[cap].soldiers[0];
    b.soldiers[man].hit_at = b.tick;
    b.step(1);
    Check {
        name: "wait captain attacked",
        counts: format!("ODA waits to guard the captain: {before} waiting; the captain is struck: {} waiting, ODA {:?}", b.squads[oda].queue.len(), b.squads[oda].order),
        pass: before == 1 && b.squads[oda].queue.is_empty() && b.squads[oda].order == Order::Guard { ward: cap as u16 },
    }
}

fn wait_night() -> Check {
    let mut b = Battle::new(4, MapOpts::default(), &Setup::default(), Tune::default());
    let (wil, ren) = (named(&b, "WIL"), named(&b, "REN"));
    give(&mut b, 0, "wait nightfall stance REN holdfire");
    give(&mut b, 0, "wait dawn regroup WIL");
    b.step(30);
    let before = (b.squads[ren].queue.len(), b.squads[wil].queue.len());
    // The keep's night comes at 300 s; the check sets the clock's flags rather than waiting for them.
    b.night = true;
    b.step(1);
    let night = (b.squads[ren].how.stance, b.squads[wil].queue.len());
    b.night = false;
    b.dawn = true;
    b.step(1);
    Check {
        name: "wait nightfall and dawn",
        counts: format!("waiting {before:?}; at nightfall REN is {:?} and WIL still waits ({}); at dawn WIL {}", night.0, night.1, b.squads[wil].order.name()),
        pass: before == (1, 1) && night == (Stance::HoldFire, 1) && b.squads[wil].order.name() == "regroup",
    }
}

fn army_waits() -> Check {
    let mut b = field();
    let cap = b.captain_of(0).expect("captain");
    give(&mut b, 0, "march 12 13.5");
    give(&mut b, 0, "then march 14 10");
    give(&mut b, 0, "wait signal 0 hold army");
    let waiting = b.waiting[0].len();
    let (mut arrived, mut second) = (None, None);
    for _ in 0..(30 * 30) {
        b.step(1);
        if arrived.is_none() && b.squads[cap].done {
            arrived = Some(b.tick);
        }
        if second.is_none() && matches!(b.squads[cap].order, Order::Move { to, .. } if to == P::new(14.0, 10.0)) {
            second = Some(b.tick);
        }
    }
    let left = b.waiting[0].len();
    give(&mut b, 0, "march 10 13.5");
    Check {
        name: "army waits",
        counts: format!(
            "{waiting} waiting for the army; the march arrived by tick {arrived:?}, the 'then' march began by tick {second:?}; {left} left on a signal; a new army order clears it: {}",
            b.waiting[0].len()
        ),
        pass: waiting == 2 && arrived.is_some() && second.is_some_and(|s| Some(s) == arrived.map(|a| a + 1)) && left == 1 && b.waiting[0].is_empty(),
    }
}

// ------------------------------------------------------------------------------------------------- verbs

fn guard() -> Check {
    let mut b = field();
    let (wil, oda) = (named(&b, "WIL"), named(&b, "ODA"));
    give(&mut b, 0, "guard WIL ODA");
    give(&mut b, 0, "send ODA 6 22");
    let (mut worst, mut sum, mut n) = (0.0f64, 0.0, 0);
    for t in 0..(25 * 30) {
        b.step(1);
        if t >= 30 {
            let d = b.centre(wil).dist(b.centre(oda));
            worst = worst.max(d);
            sum += d;
            n += 1;
        }
    }
    let moved = b.centre(oda).dist(P::new(6.0, 22.0));
    let r = b.tune.army.guard_behind + 3.0;
    Check {
        name: "guard",
        counts: format!("WIL escorts ODA on a march to (6, 22) (ODA ends {moved:.1} from it): WIL at most {worst:.2} from ODA, {:.2} on average", sum / n.max(1) as f64),
        pass: worst <= r && moved < 2.0 && b.squads[wil].order == Order::Guard { ward: oda as u16 },
    }
}

fn screen() -> Check {
    let mut b = field();
    let (oda, ren) = (named(&b, "ODA"), named(&b, "REN"));
    give(&mut b, 0, "screen ODA REN");
    b.step(12 * 30);
    let threat = b.nearest_foe(ren, b.tune.orders.screen_r).unwrap_or(b.threat_point(0, b.centre(ren)));
    let (r, o) = (b.centre(ren), b.centre(oda));
    let off = wrap(atan2(o.y - r.y, o.x - r.x) - atan2(threat.y - r.y, threat.x - r.x)).abs();
    let (dr, dd) = (r.dist(threat), o.dist(threat));
    // From a named foe.
    give(&mut b, 0, "screen ODA REN from E9");
    b.step(10 * 30);
    let t = b.centre(9);
    let (r2, o2) = (b.centre(ren), b.centre(oda));
    let off2 = wrap(atan2(o2.y - r2.y, o2.x - r2.x) - atan2(t.y - r2.y, t.x - r2.x)).abs();
    Check {
        name: "screen",
        counts: format!("ODA screens REN: {off:.2} rad off the line to the nearest foe, ODA {dd:.1} from it and REN {dr:.1}; from the trolls: {off2:.2} rad off"),
        pass: off < 0.5 && dd < dr && off2 < 0.5,
    }
}

fn charge() -> Check {
    let run = |verb: &str| {
        let mut b = duel(&[Unit::Spear], &[Unit::BlightMan], 8.0, steady());
        // The company is scattered: an attack waits on its cohesion gate, a charge does not.
        let men = b.squads[1].soldiers.clone();
        for (k, &m) in men.iter().enumerate() {
            b.soldiers[m].x = 12.0 + (k % 4) as f64 * 1.3;
            b.soldiers[m].y = 9.0 + (k / 4) as f64 * 3.0;
        }
        settle(&mut b);
        let loose = b.looseness(1);
        let from = P::new(b.squads[1].x, b.squads[1].y);
        give(&mut b, 0, &format!("{verb} 1 E2"));
        b.step(30);
        let moved = P::new(b.squads[1].x, b.squads[1].y).dist(from);
        let contact = (0..(20 * 30)).find(|_| {
            b.step(1);
            gap(&b, 1, 2) <= b.tune.combat.reach + 0.05
        });
        (loose, moved, contact)
    };
    let (attack, charge) = (run("attack"), run("charge"));
    Check {
        name: "charge",
        counts: format!(
            "a scattered company (looseness {:.1}): its anchor moved {:.2} in 1 s on an attack, {:.2} on a charge; contact {:?} ticks later attacking, {:?} charging",
            attack.0, attack.1, charge.1, attack.2, charge.2
        ),
        pass: charge.1 > attack.1 + 0.5 && charge.2.is_some(),
    }
}

fn withdraw() -> Check {
    let run = |verb: &str| {
        let mut b = duel(&[Unit::Spear], &[Unit::BlightMan], 1.0, steady());
        b.step(3 * 30);
        let from = P::new(b.squads[1].x, b.squads[1].y);
        give(&mut b, 0, &format!("{verb} 1"));
        let (mut worst, mut strikes) = (0.0f64, 0u32);
        let s0: u32 = b.squads[1].soldiers.iter().map(|&k| b.soldiers[k].strikes).sum();
        for t in 0..(4 * 30) {
            b.step(1);
            if t >= 30 {
                let c = b.centre(1);
                let foe = b.centre(2);
                worst = worst.max(wrap(b.squads[1].facing - atan2(foe.y - c.y, foe.x - c.x)).abs());
            }
        }
        strikes += b.squads[1].soldiers.iter().map(|&k| b.soldiers[k].strikes).sum::<u32>() - s0;
        (P::new(b.squads[1].x, b.squads[1].y).dist(from), worst, strikes)
    };
    let (w, r) = (run("withdraw"), run("recall"));
    Check {
        name: "withdraw",
        counts: format!(
            "from a fight, 4 s: withdraw stepped back {:.2} facing the foe within {:.2} rad, striking {} blows; recall walked {:.2}, {:.2} rad off the foe, {} blows",
            w.0, w.1, w.2, r.0, r.1, r.2
        ),
        pass: w.0 >= 1.5 && w.1 <= 0.5 && r.1 > 1.5,
    }
}

fn regroup() -> Check {
    let mut b = field();
    let wil = named(&b, "WIL");
    b.squads[wil].morale = 40.0;
    let cap = b.captain_at(0).expect("captain");
    let threat = b.threat_point(0, b.centre(wil));
    give(&mut b, 0, "regroup WIL");
    let to = match b.squads[wil].order {
        Order::Regroup { to } => to,
        _ => P::new(f64::NAN, f64::NAN),
    };
    b.step(12 * 30);
    let axis = P::new(threat.x - cap.x, threat.y - cap.y);
    let len = (axis.x * axis.x + axis.y * axis.y).sqrt();
    let c = b.centre(wil);
    let behind = -((c.x - cap.x) * axis.x + (c.y - cap.y) * axis.y) / len;
    Check {
        name: "regroup",
        counts: format!("WIL at morale 40 regroups to ({:.1}, {:.1}): after 12 s morale {:.0}, {:.1} behind the captain, {}", to.x, to.y, b.squads[wil].morale, behind, b.squads[wil].order.name()),
        pass: b.squads[wil].morale >= 80.0 && behind >= 2.0 && b.squads[wil].done,
    }
}

fn reserve() -> Check {
    let mut b = field();
    let oda = named(&b, "ODA");
    give(&mut b, 0, "reserve ODA");
    b.step(10 * 30);
    let cap = b.captain_at(0).expect("captain");
    let h = b.armies[0].heading;
    let c = b.centre(oda);
    let ahead = (c.x - cap.x) * crate::math::cos(h) + (c.y - cap.y) * crate::math::sin(h);
    give(&mut b, 0, "attack army E6");
    let held_back = b.squads[oda].order == Order::Follow;
    let attackers = b.squads.iter().filter(|s| s.team == 0 && matches!(s.order, Order::Attack { .. })).count();
    let commit_army = give(&mut b, 0, "commit army E7");
    let committed = (b.squads[oda].order.clone(), b.squads[oda].reserve);
    Check {
        name: "reserve and commit",
        counts: format!("ODA in reserve stands {ahead:.1} ahead of the captain (behind him); an army attack sends {attackers} companies and leaves ODA following: {held_back}; committed at E7: {:?}, reserve {:?} ({commit_army:?})", committed.0, committed.1),
        pass: ahead < -4.0 && held_back && attackers == 3 && committed.0 == (Order::Attack { target: 7, via: Vec::new() }) && committed.1.is_none(),
    }
}

fn face() -> Check {
    let mut b = field();
    let wil = named(&b, "WIL");
    give(&mut b, 0, "face WIL 1.57");
    b.step(2 * 30);
    let one = wrap(b.squads[wil].facing - 1.57).abs();
    give(&mut b, 0, "face army -1.2");
    b.step(4 * 30);
    let aim = b.armies[0].aim;
    let heading = wrap(b.armies[0].heading + 1.2).abs();
    Check {
        name: "face",
        counts: format!("WIL turned to within {one:.3} rad of 1.57 in 2 s; the army aims {aim:.2}, its heading within {heading:.2} after 4 s"),
        pass: one < 0.01 && aim == -1.2 && heading < 0.5,
    }
}

fn held() -> Check {
    let mut b = Battle::new(7, MapOpts { kind: MapKind::Field, width: 48 }, &Setup { held: true, ..Setup::field() }, Tune::default());
    let mut bots = [crate::bots::Bot::new(crate::bots::BotKind::Charge, 0), crate::bots::Bot::new(crate::bots::BotKind::General(1), 1)];
    let depth = b.tune.orders.held_depth;
    let advanced = |b: &Battle| {
        let mut worst = f64::MIN;
        for t in 0..2usize {
            let (own, foe) = (b.map.deploy[t], b.map.deploy[1 - t]);
            let d = own.dist(foe);
            let a = P::new((foe.x - own.x) / d, (foe.y - own.y) / d);
            for s in b.squads.iter().filter(|s| s.team as usize == t && s.on_field()) {
                worst = worst.max((s.x - own.x) * a.x + (s.y - own.y) * a.y);
            }
        }
        worst
    };
    let mut blows = 0;
    let mut most = f64::MIN;
    let step = |b: &mut Battle, bots: &mut [crate::bots::Bot; 2], secs: u32| {
        let mut n = 0;
        for _ in 0..(secs * 30) {
            for bot in bots.iter_mut() {
                for c in bot.think(b) {
                    b.apply(c);
                }
            }
            b.step(1);
            n += b.drain_events().iter().filter(|e| e.code == EventCode::Hit).count();
        }
        n
    };
    blows += step(&mut b, &mut bots, 30);
    most = most.max(advanced(&b));
    give(&mut b, 0, "advance");
    let after = step(&mut b, &mut bots, 40);
    Check {
        name: "held and advance",
        counts: format!("held 30 s with the charge against general1: the furthest anchor {most:.2} ahead of its deploy point (depth {depth}), {blows} blows; after 'advance', {after} blows in 40 s"),
        pass: most <= depth + 0.5 && blows == 0 && after > 0 && b.held == [false, false],
    }
}

// ------------------------------------------------------------------------------------------------- works

/// Runs until the work is built (or `secs` pass); returns the tick.
fn build_until(b: &mut Battle, w: usize, secs: u32) -> Option<Tick> {
    (0..(secs * 30)).find_map(|_| {
        b.step(1);
        (b.works.get(w).is_some_and(|w| w.built >= 1.0)).then_some(b.tick)
    })
}

fn stakes() -> Check {
    let run = |staked: bool| {
        let co = |u: Unit| Company::of(u, "");
        let setup = Setup { warband: vec![co(Unit::Spear)], garrison: vec![co(Unit::Horse)], general: None, mirror: false, held: false };
        let mut b = Battle::new(7, MapOpts { kind: MapKind::Field, width: 48 }, &setup, steady());
        place(&mut b, 0, P::new(5.0, 13.5), 0.0);
        place(&mut b, 1, P::new(19.0, 13.5), 0.0);
        place(&mut b, 2, P::new(34.0, 13.5), std::f64::consts::PI);
        settle(&mut b);
        let mut built = None;
        if staked {
            give(&mut b, 0, "build 1 stakes 20.5 13.5 0");
            built = build_until(&mut b, 0, 30);
            give(&mut b, 0, "hold 1");
        }
        give(&mut b, 1, "attack 2 E1");
        b.step(8 * 30);
        (b.tally.charge_harm, b.tally.staked, b.squads[1].alive, built)
    };
    let (open, staked) = (run(false), run(true));
    Check {
        name: "stakes",
        counts: format!(
            "horse charge spears: in the open {:.1} charge harm, {} men left; behind stakes (built by tick {:?}) {:.1} charge harm ({} charging blows met the stakes), {} men left",
            open.0, open.2, staked.3, staked.0, staked.1, staked.2
        ),
        pass: staked.3.is_some() && staked.1 > 0 && staked.0 < open.0 * 0.6,
    }
}

fn barricade() -> Check {
    // Movement: a built barricade's tiles are blocked and A* goes round.
    let mut b = field();
    let wil = named(&b, "WIL");
    let at = P::new(14.5, 13.5);
    let (a, z) = (P::new(13.0, 13.5), P::new(16.0, 13.5));
    let before = path::astar(&b.map, a, z).map_or(0, |p| p.len());
    give(&mut b, 0, &format!("build WIL barricade {} {} 0", at.x, at.y));
    let built = build_until(&mut b, 0, 40);
    let blocked = b.works[0].tiles.iter().filter(|&&(i, _)| b.map.tiles[i] == Tile::Rock).count();
    let after = path::astar(&b.map, a, z).map_or(0, |p| p.len());
    let _ = wil;
    // Cover: foe archers shoot our spears behind it.
    let cover = |walled: bool| {
        let co = |u: Unit| Company::of(u, "");
        let setup = Setup { warband: vec![co(Unit::Spear)], garrison: vec![co(Unit::Archer)], general: None, mirror: false, held: false };
        let mut b = Battle::new(7, MapOpts { kind: MapKind::Field, width: 48 }, &setup, steady());
        place(&mut b, 0, P::new(5.0, 13.5), 0.0);
        place(&mut b, 1, P::new(19.0, 13.5), 0.0);
        place(&mut b, 2, P::new(32.0, 13.5), std::f64::consts::PI);
        settle(&mut b);
        if walled {
            give(&mut b, 0, "build 1 barricade 20.5 13.5 0");
            build_until(&mut b, 0, 40);
            give(&mut b, 0, "hold 1");
        }
        let hp0: f64 = b.squads[1].soldiers.iter().map(|&k| b.soldiers[k].hp.max(0.0)).sum();
        give(&mut b, 1, "send 2 25.5 13.5 fight");
        b.step(5 * 30);
        let arrows = b.tally.arrows;
        b.step(12 * 30);
        let hp1: f64 = b.squads[1].soldiers.iter().map(|&k| b.soldiers[k].hp.max(0.0)).sum();
        (hp0 - hp1, b.tally.arrows - arrows)
    };
    let (open, walled) = (cover(false), cover(true));
    Check {
        name: "barricade",
        counts: format!(
            "built by tick {built:?}: {blocked} tiles blocked, A* from (13,13.5) to (16,13.5) {before} tiles before, {after} after; archers' harm on spears in the open {:.1} ({} arrows), behind a barricade {:.1} ({} arrows)",
            open.0, open.1, walled.0, walled.1
        ),
        pass: built.is_some() && blocked >= 3 && after > before && walled.0 < open.0 * 0.75 && walled.1 > 0,
    }
}

fn bridge() -> Check {
    let mut b = Battle::new(4, MapOpts::default(), &Setup::default(), Tune::default());
    let wil = named(&b, "WIL");
    // The river row whose crossing A* finds longest (furthest from any ford or road).
    let mut best: Option<(usize, i32)> = None;
    for y in (b.map.h as i32 / 4)..(b.map.h as i32 * 3 / 4) {
        let x = b.map.river[y as usize];
        let (a, z) = (P::new(x as f64 - 1.5, y as f64 + 0.5), P::new(x as f64 + 3.5, y as f64 + 0.5));
        if !b.map.passable(a) || !b.map.passable(z) {
            continue;
        }
        let len = path::astar(&b.map, a, z).map_or(usize::MAX, |p| p.len());
        if len != usize::MAX && best.is_none_or(|(l, _)| len > l) {
            best = Some((len, y));
        }
    }
    let Some((before, y)) = best else {
        return Check { name: "bridge", counts: "no river crossing to test".into(), pass: false };
    };
    let x = b.map.river[y as usize];
    let at = P::new(x as f64 + 1.0, y as f64 + 0.5);
    let (a, z) = (P::new(x as f64 - 1.5, y as f64 + 0.5), P::new(x as f64 + 3.5, y as f64 + 0.5));
    let refused = give(&mut b, 0, &format!("build WIL bridge {} {} 0", at.x, at.y));
    let water = b.works.first().map_or(0, |w| w.tiles.len());
    let built = build_until(&mut b, 0, 90);
    let after = path::astar(&b.map, a, z).map_or(usize::MAX, |p| p.len());
    let road = b.works.first().map_or(0, |w| w.tiles.iter().filter(|&&(i, _)| b.map.tiles[i] == Tile::Road).count());
    // The company crosses by it.
    give(&mut b, 0, &format!("send WIL {} {}", z.x, z.y));
    let crossed = (0..(20 * 30)).any(|_| {
        b.step(1);
        P::new(b.squads[wil].x, b.squads[wil].y).dist(z) < 0.5
    });
    let dry = give(&mut b, 0, "build WIL bridge 10 10 0");
    Check {
        name: "bridge",
        counts: format!(
            "river row {y}: A* across {before} tiles before; bridge laid ({refused:?}) over {water} water tiles, built by tick {built:?}, {road} now road; A* {after} tiles after; WIL crossed: {crossed}; on dry ground: {dry:?}"
        ),
        pass: refused.is_none() && built.is_some() && after < before && road == water && crossed && dry.is_some(),
    }
}

fn watchtower() -> Check {
    let run = |tower: bool| {
        let mut b = duel(&[Unit::Archer], &[Unit::Spear], 7.6, steady());
        let sight0 = b.fog(0).iter().filter(|&&v| v == 2).count();
        let mut built = None;
        if tower {
            give(&mut b, 0, "build 1 watchtower 19.2 13.5 0");
            built = build_until(&mut b, 0, 40);
            give(&mut b, 0, "send 1 20 13.5");
            b.step(3 * 30);
            give(&mut b, 0, "hold 1");
        }
        b.step(8);
        let sight = b.fog(0).iter().filter(|&&v| v == 2).count();
        let arrows = b.tally.arrows;
        b.step(8 * 30);
        (sight0, sight, b.tally.arrows - arrows, built, b.work_bonus(b.centre(1), 0, "range"))
    };
    let (open, manned) = (run(false), run(true));
    Check {
        name: "watchtower",
        counts: format!(
            "archers 7.6 from spears (range 7): unmanned {} tiles in sight, {} arrows in 8 s; manned tower (built by tick {:?}) {} tiles in sight, range +{:.1}, {} arrows",
            open.1, open.2, manned.3, manned.1, manned.4, manned.2
        ),
        pass: manned.3.is_some() && manned.1 > open.1 && open.2 == 0 && manned.2 > 0,
    }
}

fn interrupted() -> Check {
    let mut b = duel(&[Unit::Spear], &[Unit::BlightMan], 9.0, steady());
    give(&mut b, 0, "build 1 barricade 20.5 13.5 0");
    b.step(4 * 30);
    let working = b.squads[1].working;
    let rules = b.rules(1);
    let progress = b.works[0].built;
    give(&mut b, 1, "attack 2 E1");
    let stopped = (0..(15 * 30)).find_map(|_| {
        b.step(1);
        (!matches!(b.squads[1].order, Order::Build { .. })).then_some(b.tick)
    });
    b.step(2 * 30);
    let fights = b.squads[1].state == SquadState::Fighting;
    Check {
        name: "building is interrupted",
        counts: format!(
            "at work: {working} (engage {:.1}, fire {}, strikes {}), {:.0}% built after 4 s; attacked, it stopped building on tick {stopped:?} ({} interruptions) and fights: {fights}; the work kept {:.0}%",
            rules.engage,
            rules.fire,
            rules.strike,
            progress * 100.0,
            b.tally.interrupts,
            b.works[0].built * 100.0
        ),
        pass: working && rules.engage == 0.0 && !rules.strike && stopped.is_some() && b.tally.interrupts >= 1 && fights && b.works[0].built < 1.0,
    }
}

fn torn_down() -> Check {
    let mut b = duel(&[Unit::Spear], &[Unit::BlightMan], 12.0, steady());
    give(&mut b, 0, "build 1 barricade 24.5 13.5 0");
    let built = build_until(&mut b, 0, 40);
    give(&mut b, 0, "send 1 12 13.5");
    b.step(4 * 30);
    let blocked = b.works[0].tiles.iter().filter(|&&(i, _)| b.map.tiles[i] == Tile::Rock).count();
    give(&mut b, 1, "send 2 25.5 13.5 fight");
    let razed = (0..(60 * 30)).find_map(|_| {
        b.step(1);
        b.works[0].razed.then_some(b.tick)
    });
    let open = b.works[0].tiles.iter().filter(|&&(i, t)| b.map.tiles[i] == t && t.passable()).count();
    Check {
        name: "works are torn down",
        counts: format!(
            "a barricade built by tick {built:?} ({blocked} tiles blocked); blight-men sent at it tore it down by tick {razed:?} ({:.0} harm); {open} tiles open again",
            b.tally.raze_harm
        ),
        pass: built.is_some() && razed.is_some() && open == blocked && blocked > 0,
    }
}

fn raided() -> Check {
    let mut b = field();
    give(&mut b, 0, "build WIL stakes 15.5 13.5 0");
    let built = build_until(&mut b, 0, 40);
    give(&mut b, 0, "hold WIL");
    let mut general = crate::bots::Bot::new(crate::bots::BotKind::General(1), 1);
    let (mut sent, mut first_harm) = (None, None);
    for _ in 0..(90 * 30) {
        for c in general.think(&b) {
            b.apply(c);
        }
        b.step(1);
        if sent.is_none()
            && b.squads.iter().any(|s| s.team == 1 && matches!(s.order, Order::Move { to, fight: true, .. } if to.dist(b.works[0].at) < 1.5))
        {
            sent = Some(b.tick);
        }
        if first_harm.is_none() && b.works[0].hp < b.works[0].max_hp {
            first_harm = Some(b.tick);
        }
        if b.works[0].razed {
            break;
        }
    }
    Check {
        name: "the blight raids works",
        counts: format!(
            "stakes built by tick {built:?}; general1 sent a company at them on tick {sent:?}, first harm on tick {first_harm:?}; {:.0} harm, razed: {} (tick {})",
            b.tally.raze_harm, b.works[0].razed, b.tick
        ),
        pass: built.is_some() && sent.is_some() && first_harm.is_some(),
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

    check!(
        hold_fire, aggressive, defensive, skirmish, pursue, pace, shapes, priorities, with, set, squads, wait_done, wait_signal, wait_after,
        wait_enemy_near, wait_breaks, wait_captain, wait_night, army_waits, guard, screen, charge, withdraw, regroup, reserve, face, held, stakes,
        barricade, bridge, watchtower, interrupted, torn_down, raided,
    );
}
