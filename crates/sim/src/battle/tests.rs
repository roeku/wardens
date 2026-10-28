//! Rule checks for 04-battle.md §2–§8 and the order model of 08-orders.md. Each prints its counts.

use super::*;
use crate::bots::{Bot, BotKind};
use crate::units::Unit;
use crate::contracts::{Deed, Source, Who};
use crate::map::MapKind;

fn field() -> Battle {
    Battle::new(7, MapOpts { kind: MapKind::Field, width: 48 }, &Setup::field(), Tune::default())
}

/// The symmetric human field of day 3 (`Setup::mirror`).
fn mirror() -> Battle {
    Battle::new(7, MapOpts { kind: MapKind::Field, width: 48 }, &Setup::mirror(), Tune::default())
}

fn keep() -> Battle {
    Battle::new(4, MapOpts::default(), &Setup::default(), Tune::default())
}

fn named(b: &Battle, name: &str) -> usize {
    b.squads.iter().position(|s| s.name == name).expect(name)
}

fn order(b: &mut Battle, team: Team, deed: Deed) {
    b.apply(Command { tick: b.tick, team, deed, src: Source::Typed, note: None });
    b.flush();
}

#[test]
fn a_death_costs_morale_and_the_highest_slot_fills_the_gap() {
    let mut b = keep();
    let wil = named(&b, "WIL");
    let men = b.squads[wil].soldiers.clone();
    let victim = men[3];
    let highest = *men.iter().max_by_key(|&&k| b.soldiers[k].slot).unwrap();
    let before: Vec<u16> = men.iter().map(|&k| b.soldiers[k].slot).collect();
    b.kill(victim, None);
    b.cull();
    let after: Vec<u16> = men.iter().map(|&k| b.soldiers[k].slot).collect();
    let moved = before.iter().zip(&after).filter(|(a, b)| a != b).count();
    assert_eq!(b.soldiers[highest].slot, 3, "the highest slot steps into the gap");
    assert_eq!(moved, 1, "nobody else moves");
    let lost = 100.0 - b.squads[wil].morale;
    assert!((lost - 1.6 * 100.0 / 12.0).abs() < 1e-9, "a 12-man spear company loses 13.3 per man: {lost}");
    println!("cull: 1 death, {moved} man moved slot, morale −{lost:.2}");
}

#[test]
fn a_fallen_commander_breaks_his_company_and_it_never_rallies() {
    let mut b = keep();
    let oda = named(&b, "ODA");
    let leader = b.squads[oda].leader.unwrap();
    b.kill(leader, None);
    b.cull();
    assert!(b.squads[oda].commander_fell && b.squads[oda].morale <= 21.0);
    b.step(1);
    assert_eq!(b.squads[oda].state, SquadState::Routing);
    let codes: Vec<EventCode> = b.events.iter().map(|e| e.code).collect();
    assert!(codes.contains(&EventCode::CommanderFall) && codes.contains(&EventCode::Rout));
    b.step(30 * 30);
    assert_ne!(b.squads[oda].state, SquadState::Idle, "no rally after a commander falls");
    println!("commander fall: morale {:.0}, state {:?} after 30 s", b.squads[oda].morale, b.squads[oda].state);
}

#[test]
fn the_last_men_are_pulled_out_once() {
    let mut b = keep();
    let wil = named(&b, "WIL");
    let men: Vec<usize> = b.squads[wil].soldiers.iter().copied().filter(|&k| Some(k) != b.squads[wil].leader).collect();
    // 12 men, commander included: the limit is max(2, floor(11·0.3)) = 3.
    for &k in &men[..9] {
        b.kill(k, None);
    }
    b.cull();
    assert_eq!(b.squads[wil].alive, 3);
    assert_eq!(b.squads[wil].order, Order::Retreat);
    assert!(b.squads[wil].saved);
    println!("save the last: {} left, order {:?}", b.squads[wil].alive, b.squads[wil].order);
}

#[test]
fn a_long_front_is_thin_and_a_short_one_deep() {
    let mut b = field();
    order(&mut b, 0, Deed::Front { line: vec![P::new(14.0, 3.0), P::new(14.0, 24.0)] });
    let (wil, oda) = (named(&b, "WIL"), named(&b, "ODA"));
    let long = (b.squads[wil].files, b.squads[oda].files);
    // seg = 21/2 = 10.5 → floor(10.5/0.72) = 14, capped at max(2, ceil(men/2)): WIL 11 men → 6, ODA 9 → 5.
    assert_eq!(long, (Some(6), Some(5)));
    order(&mut b, 0, Deed::Front { line: vec![P::new(14.0, 12.0), P::new(14.0, 14.5)] });
    let short = (b.squads[wil].files, b.squads[oda].files);
    assert_eq!(short, (Some(3), Some(3)), "a short line is deep (never under 3 files)");
    assert!(matches!(b.squads[named(&b, "REN")].order, Order::Move { .. }));
    let cap = b.captain_of(0).unwrap();
    println!("planFront: long line files {long:?}, short {short:?}, captain {:?}", b.squads[cap].order);
}

#[test]
fn a_front_drawn_toward_the_threat_fights_and_the_captain_rides() {
    let mut b = field();
    order(&mut b, 0, Deed::Front { line: vec![P::new(16.0, 8.0), P::new(16.0, 19.0)] });
    let cap = b.captain_of(0).unwrap();
    let wil = named(&b, "WIL");
    assert_eq!(b.squads[cap].order, Order::Ride);
    assert!(matches!(b.squads[wil].order, Order::Move { fight: true, .. }));
    let mut back = field();
    order(&mut back, 0, Deed::Front { line: vec![P::new(3.0, 8.0), P::new(3.0, 19.0)] });
    let wil = named(&back, "WIL");
    assert!(matches!(back.squads[wil].order, Order::Move { fight: false, .. }), "a fall-back does not fight");
    println!("front: toward the threat fights with the captain riding; away falls back");
}

#[test]
fn the_army_follows_the_captain_and_forms_column_then_line() {
    let mut b = field();
    order(&mut b, 0, Deed::Move { who: Who::Army, to: P::new(20.0, 13.5), via: Vec::new(), fight: false, face: None });
    let wil = named(&b, "WIL");
    assert_eq!(b.squads[wil].order, Order::Follow);
    let mut column = false;
    for _ in 0..(8 * 30) {
        b.step(1);
        column |= b.armies[0].formation == Formation::Column;
    }
    assert!(column, "a march of more than 1.5 s forms column");
    b.step(6 * 30);
    assert_eq!(b.armies[0].formation, Formation::Line, "a halt of 2 s forms line");
    let err = b.station_at(wil).unwrap().dist(P::new(b.squads[wil].x, b.squads[wil].y));
    assert!(err < 1.5, "the company stands at its station: {err:.2}");
    println!("follow: column on the march, line at the halt, WIL {err:.2} from its station");
}

#[test]
fn fog_is_seen_near_the_army_and_unknown_far_away() {
    let b = field();
    let fog = b.fog(0);
    let at = |x: f64, y: f64| fog[(y.floor() as usize) * b.map.w as usize + x.floor() as usize];
    assert_eq!(at(6.0, 13.5), 2);
    assert_eq!(at(44.0, 13.5), 0);
    let seen = fog.iter().filter(|&&v| v == 2).count();
    println!("fog: {seen} of {} tiles in sight at the start", fog.len());
}

#[test]
fn pending_orders_run_on_completion_on_a_signal_and_on_a_condition() {
    use crate::contracts::{How as Way, Stance as St};
    let mut b = field();
    let (wil, oda, ren) = (named(&b, "WIL"), named(&b, "ODA"), named(&b, "REN"));
    let id = |i: usize| Who::Squad { id: i as u16 };
    let set = |i: usize, stance: St| Deed::Set { who: id(i), how: Way { stance: Some(stance), ..Way::default() } };
    order(&mut b, 0, Deed::Move { who: id(wil), to: P::new(12.0, 11.0), via: Vec::new(), fight: false, face: None });
    order(&mut b, 0, Deed::Wait { until: When::Done, deed: Box::new(set(wil, St::Defensive)) });
    order(&mut b, 0, Deed::Wait { until: When::Signal { n: 1 }, deed: Box::new(Deed::Move { who: id(oda), to: P::new(12.0, 16.0), via: Vec::new(), fight: false, face: None }) });
    order(&mut b, 0, Deed::Wait { until: When::After { s: 2.0 }, deed: Box::new(set(ren, St::HoldFire)) });
    b.step(30);
    assert_eq!(b.squads[oda].queue.len(), 1, "waits for the signal");
    assert_eq!(b.squads[ren].queue.len(), 1, "waits 2 s");
    order(&mut b, 0, Deed::Signal { n: 1 });
    b.step(2 * 30);
    assert!(b.squads[oda].queue.is_empty() && matches!(b.squads[oda].order, Order::Move { .. } | Order::Hold { .. }));
    assert!(b.squads[ren].queue.is_empty() && b.squads[ren].how.stance == Stance::HoldFire);
    assert!(!b.rules(ren).fire, "hold fire");
    b.step(10 * 30);
    assert!(b.squads[wil].queue.is_empty(), "released when the move completed");
    assert_eq!(b.squads[wil].how.stance, Stance::Defensive);
    assert!(b.rules(wil).leash.is_some());
    println!("queue: 3 orders released (done, signal, after 2 s); stances defensive and hold fire read by the rules");
}

#[test]
fn shapes_and_priorities_are_modifiers() {
    let mut b = mirror();
    let wil = named(&b, "WIL");
    let n = b.squads[wil].alive as usize;
    let block: Vec<P> = (1..n as u16).map(|k| b.slot(&b.squads[wil], k, n)).collect();
    b.squads[wil].how.shape = Shape::Wedge;
    let wedge: Vec<P> = (1..n as u16).map(|k| b.slot(&b.squads[wil], k, n)).collect();
    b.squads[wil].how.shape = Shape::Ring;
    let ring: Vec<P> = (1..n as u16).map(|k| b.slot(&b.squads[wil], k, n)).collect();
    let spread = |ps: &[P]| ps.iter().map(|p| p.dist(ps[0])).fold(0.0, f64::max);
    assert!(spread(&block) != spread(&wedge) && spread(&ring) > 0.0);
    // The archers are favoured by a kind priority over a nearer foe.
    let from = b.centre(wil);
    let rook = named(&b, "ROOK");
    let grim = named(&b, "GRIM");
    let pri = Priority::Kind { kind: Kind::Archer };
    assert!(b.priority_score(0, from, rook, pri) < b.priority_score(0, from, grim, pri));
    println!("modifiers: block/wedge/ring spreads {:.1}/{:.1}/{:.1}; kind priority favours archers", spread(&block), spread(&wedge), spread(&ring));
}

#[test]
fn a_bot_battle_on_the_field_ends() {
    let mut b = field();
    let mut bots = [Bot::new(BotKind::Charge, 0), Bot::new(BotKind::General(1), 1)];
    let limit = (b.time_limit() * 30.0) as u32 + 30;
    let mut hits = 0;
    while b.outcome().is_none() && b.tick < limit {
        for bot in bots.iter_mut() {
            for c in bot.think(&b) {
                b.apply(c);
            }
        }
        b.step(1);
        hits += b.drain_events().iter().filter(|e| e.code == EventCode::Hit).count();
    }
    let (winner, why) = b.outcome().expect("decided");
    assert!(hits > 0);
    let dead = b.soldiers.iter().filter(|m| m.died_at != Tick::MAX).count();
    println!("bot battle: team {winner} wins ({}) at {:.1} s after {hits} hits, {dead} dead", why.name(), b.time());
}

/// One company of ours (squad 1; our captain, squad 0, stands far back) against one of theirs (squad 2) on the
/// open field, 7 tiles apart and facing each other.
fn duel(ours: Unit, theirs: Unit, tune: Tune) -> Battle {
    let setup = Setup { warband: vec![Company::of(ours, "")], garrison: vec![Company::of(theirs, "")], general: None, mirror: false, held: false };
    let mut b = Battle::new(7, MapOpts { kind: MapKind::Field, width: 48 }, &setup, tune);
    let (a, z) = (P::new(20.0, 13.5), P::new(27.0, 13.5));
    for (i, at, face) in [(0usize, P::new(5.0, 13.5), 0.0), (1, a, 0.0), (2, z, std::f64::consts::PI)] {
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
    b.rebucket();
    b.measure();
    b.update_sight();
    b
}

/// Our company never breaks (no morale lost to deaths or breath, and it never routs), so a hunt runs its course.
fn unbreakable(kind: &str) -> Tune {
    Tune::with_override(&serde_json::json!({"kinds": {kind: {"steadiness": 0.0}}, "morale": {"rout_below": -1.0e9}})).unwrap()
}

#[test]
fn the_blight_takes_the_field_and_the_nest() {
    let ids = |b: &Battle, team: Team| -> Vec<(Unit, Kind)> { b.squads.iter().filter(|s| s.team == team).map(|s| (s.unit, s.kind)).collect() };
    let f = field();
    let theirs = ids(&f, 1);
    assert_eq!(theirs[0], (Unit::Broodlord, Kind::Captain), "the broodlord leads the army as its captain");
    let units: Vec<Unit> = theirs.iter().map(|x| x.0).collect();
    assert_eq!(units, [Unit::Broodlord, Unit::BlightMan, Unit::BlightMan, Unit::BlightMan, Unit::Troll, Unit::Drake]);
    assert!(f.squads.iter().all(|s| s.unit != Unit::Captain || s.team == 0), "no human general");
    let k = keep();
    let nest: Vec<Unit> = ids(&k, 1).iter().map(|x| x.0).collect();
    assert_eq!(*nest.last().unwrap(), Unit::Broodlord, "at the keep the broodlord comes last, after the posts");
    assert_eq!(nest.iter().filter(|&&u| u == Unit::Drake).count(), 2);
    let m = mirror();
    assert!(m.squads.iter().any(|s| s.name == "GRIM") && m.squads.iter().all(|s| s.unit != Unit::Broodlord), "the human mirror stays");
    for b in [&f, &k, &m] {
        for s in &b.squads {
            assert_eq!(s.kind, b.tune.unit_kind(s.unit));
            assert_eq!(s.spec, b.tune.unit_spec(s.unit).unwrap());
        }
    }
    println!("setups: field {:?}; nest {} companies; mirror {} squads", units, nest.len() - 1, m.squads.len());
}

#[test]
fn a_pack_spreads_its_files_and_pulls_its_ends_back() {
    let b = field();
    let pk = b.tune.pack.clone();
    let d = b.squads.iter().position(|s| s.unit == Unit::Drake).unwrap();
    let s = &b.squads[d];
    let n = s.alive as usize;
    let anchor = P::new(s.x, s.y);
    // Along and across the facing: (back, lateral) of each slot.
    let f = P::from_angle(s.facing);
    let at: Vec<(f64, f64)> = (0..n as u16)
        .map(|k| {
            let p = b.slot(s, k, n);
            let (dx, dy) = (p.x - anchor.x, p.y - anchor.y);
            (-(dx * f.x + dy * f.y), dx * f.y - dy * f.x)
        })
        .collect();
    let gap = b.tune.movement.file_gap * s.spec.radius / b.tune.movement.base_radius;
    // Three drakes in one rank: the ends stand back by 0.5 (± the jitter), the files 1.15× apart.
    let mid = at[1].0;
    for e in [at[0].0, at[2].0] {
        assert!((e - mid - pk.ends_back).abs() <= 2.0 * pk.jitter + 1e-9, "ends back {e:.3} vs {mid:.3}");
    }
    let spread = (at[2].1 - at[0].1).abs();
    assert!((spread - 2.0 * gap * pk.files).abs() <= 2.0 * pk.jitter + 1e-9, "files {spread:.3}");
    println!("pack: ends {:.2}/{:.2} behind the middle drake, outer files {spread:.2} apart (plain {:.2})", at[0].0 - mid, at[2].0 - mid, 2.0 * gap);
}

#[test]
fn a_drake_rears_breathes_bites_and_springs_back() {
    let mut b = duel(Unit::Spear, Unit::Drake, unbreakable("spear"));
    order(&mut b, 1, Deed::Attack { who: Who::Squad { id: 2 }, target: 1, via: Vec::new() });
    let bt = b.tune.breath.clone();
    let drakes: Vec<usize> = b.squads[2].soldiers.clone();
    let hz = TICK_HZ as f64;
    let (mut rears, mut rear_d, mut jets, mut jet_late, mut bites, mut late_bites) = (0, 0.0f64, 0, 0, 0, 0);
    let (mut spring, mut springs, mut held, mut held_moved) = (0.0f64, 0, 0, 0.0f64);
    let mut cycles: Vec<Tick> = vec![Tick::MAX; drakes.len()];
    let mut strikes: Vec<u32> = drakes.iter().map(|&k| b.soldiers[k].strikes).collect();
    let mut was: Vec<P> = drakes.iter().map(|&k| b.soldiers[k].pos()).collect();
    for _ in 0..(40 * 30) {
        b.step(1);
        for e in b.drain_events() {
            if e.code == EventCode::Breath {
                jets += 1;
                if (e.tick - b.soldiers[e.a as usize].cycle) as f64 != (bt.rear * hz).round() {
                    jet_late += 1;
                }
            }
        }
        for (j, &k) in drakes.iter().enumerate() {
            let m = &b.soldiers[k];
            let e = if m.cycle == Tick::MAX { -1.0 } else { (b.tick - 1 - m.cycle) as f64 };
            if m.cycle != cycles[j] && m.cycle != Tick::MAX {
                rears += 1;
                if let Some(t) = m.target {
                    rear_d = rear_d.max(was[j].dist(b.soldiers[t].pos()));
                }
            }
            cycles[j] = m.cycle;
            if m.strikes != strikes[j] {
                bites += 1;
                late_bites += (e != (bt.bite * hz).round()) as u32;
                strikes[j] = m.strikes;
            }
            // Ground is held while breathing: from the rear to the lunge he barely moves.
            if e > 0.0 && e < ((bt.bite - bt.lunge_before) * hz).floor() {
                held += 1;
                held_moved += m.pos().dist(was[j]);
            }
            // The cycle's last tick: he has sprung back toward 2.1 of his prey.
            if e == (bt.period * hz).round() - 1.0
                && let Some(t) = m.target
            {
                spring += m.pos().dist(b.soldiers[t].pos());
                springs += 1;
            }
            was[j] = m.pos();
        }
        if b.squads[1].alive == 0 || b.squads[2].alive == 0 {
            break;
        }
    }
    let t = b.tally.clone();
    let spring = spring / springs.max(1) as f64;
    let held = held_moved / held.max(1) as f64 * hz;
    println!(
        "drake hunt: {rears} rears (prey at most {rear_d:.2} away), {jets} jets ({jet_late} off 0.4 s), {} burns ({:.1} harm, {} killed), {:.1} morale scorched, {bites} bites ({late_bites} off 2.3 s), held ground at {held:.2} t/s, sprang back to {spring:.2} ({springs} cycles); spears {} drakes {} left",
        t.burns, t.burn_harm, t.burn_kills, t.scorch, b.squads[1].alive, b.squads[2].alive
    );
    assert!(rears > 0 && jets > 0 && t.burns > 0 && bites > 0 && springs > 0);
    assert_eq!(jet_late, 0, "every jet starts 0.4 s after the rear");
    assert_eq!(late_bites, 0, "every bite comes 2.3 s into the cycle");
    assert!(rear_d <= bt.hunt_r + 0.15, "a drake rears only with its prey within 2.4: {rear_d:.2}");
    assert!(t.burns <= jets as u64 * bt.pulses() as u64 * 12, "pulses are bounded");
    assert!(held < 0.6, "ground held while breathing: {held:.2} t/s");
    assert!(spring > 1.6, "springs back toward 2.1: {spring:.2}");
}

#[test]
fn breath_harms_only_foes_in_the_cone() {
    let mut b = duel(Unit::Spear, Unit::Drake, Tune::default());
    let bt = b.tune.breath.clone();
    let drake = b.squads[2].soldiers[0];
    let at = b.soldiers[drake].pos();
    let face = std::f64::consts::PI;
    let root = at.offset(face, bt.root, 0.0);
    // A foe on the axis, a foe off to the side, a pack-mate on the axis.
    let (foe, side) = (b.squads[1].soldiers[1], b.squads[1].soldiers[2]);
    let mate = b.squads[2].soldiers[1];
    for (k, p) in [(foe, root.offset(face, 1.5, 0.0)), (side, root.offset(face, 1.0, 1.2)), (mate, root.offset(face, 0.8, 0.0))] {
        (b.soldiers[k].x, b.soldiers[k].y) = (p.x, p.y);
    }
    b.rebucket();
    let tune = b.tune.clone();
    let (mut out, mut scorch) = (Vec::new(), Vec::new());
    b.burn(drake, root, face, 1.2, &tune, &mut out, &mut scorch);
    let hit: Vec<usize> = out.iter().map(|s| s.victim).collect();
    assert!(hit.contains(&foe) && !hit.contains(&side) && !hit.contains(&mate), "{hit:?}");
    assert_eq!(scorch, vec![(1, bt.morale * b.squads[1].spec.steadiness)], "one company caught, 1.6·steadiness");
    assert!(out.iter().all(|s| s.breath && s.dmg == 1.2));
    println!("breath: {} hit in the cone, the man 1.2 off its axis and the pack-mate spared; scorch {scorch:?}", hit.len());
}

#[test]
fn a_company_meeting_drakes_holds_its_slots_and_presses_forward() {
    let mut b = duel(Unit::Spear, Unit::Drake, unbreakable("spear"));
    order(&mut b, 1, Deed::Attack { who: Who::Squad { id: 2 }, target: 1, via: Vec::new() });
    let start = P::new(b.squads[1].x, b.squads[1].y);
    let (mut worst, mut ticks) = (0.0f64, 0);
    for _ in 0..(20 * 30) {
        b.step(1);
        if b.squads[1].threat.is_some_and(|t| b.squads[t as usize].spec.breath > 0.0) {
            ticks += 1;
            worst = worst.max(b.looseness(1));
        }
    }
    let pressed = P::new(b.squads[1].x, b.squads[1].y).dist(start);
    println!("meeting drakes: {ticks} ticks engaged, looseness at most {worst:.2}, {} press ticks, anchor moved {pressed:.2}", b.tally.presses);
    assert!(ticks > 0 && b.tally.presses > 0 && pressed > 0.5);
    assert!(worst < 1.2, "men stay within about a tile of their slots: {worst:.2}");
}

#[test]
fn a_troll_blow_lands_after_its_impact() {
    let mut b = duel(Unit::Spear, Unit::Troll, unbreakable("spear"));
    order(&mut b, 1, Deed::Attack { who: Who::Squad { id: 2 }, target: 1, via: Vec::new() });
    let lag = (b.tune.unit_spec(Unit::Troll).unwrap().impact * TICK_HZ as f64).round() as Tick;
    let (mut started, mut on_time, mut pending_max) = (0, 0, 0usize);
    let mut seen: Vec<(usize, Tick)> = Vec::new();
    for _ in 0..(30 * 30) {
        b.step(1);
        pending_max = pending_max.max(b.blows.len());
        for w in &b.blows {
            if !seen.contains(&(w.attacker, w.lands)) {
                seen.push((w.attacker, w.lands));
                started += 1;
                // Started this tick (stamped before the tick advanced), landing `impact` later.
                on_time += (w.lands == b.tick - 1 + lag) as u32;
            }
        }
    }
    let t = b.tally.clone();
    println!("impact: {started} troll blows started ({on_time} timed {lag} ticks ahead), {} landed, {} missed, at most {pending_max} pending", t.landed, t.missed);
    assert!(started > 0 && on_time == started);
    assert_eq!(t.impacts, t.landed + t.missed + b.blows.len() as u64, "every blow lands or misses");
    assert!(t.landed > 0);
}

#[test]
fn the_broodlord_falling_costs_his_host_and_the_battle() {
    let mut b = field();
    let lord = b.captain_of(1).unwrap();
    assert_eq!(b.squads[lord].unit, Unit::Broodlord);
    let before: Vec<f64> = b.squads.iter().map(|s| s.morale).collect();
    let man = b.squads[lord].soldiers[0];
    b.kill(man, None);
    b.cull();
    let codes: Vec<EventCode> = b.events.iter().map(|e| e.code).collect();
    assert!(codes.contains(&EventCode::FoeCommanderFall) && codes.contains(&EventCode::BannerFall));
    let lost: Vec<f64> = b.squads.iter().zip(&before).filter(|(s, _)| s.team == 1 && s.kind != Kind::Captain).map(|(s, m)| m - s.morale).collect();
    assert!(lost.iter().all(|&l| l == b.tune.morale.foe_commander_fell), "{lost:?}");
    b.step(1);
    assert_eq!(b.outcome(), Some((0, OutcomeReason::CaptainFell)));
    println!("broodlord falls: {} companies lose 25, team 0 wins ({:?})", lost.len(), b.outcome());
}
