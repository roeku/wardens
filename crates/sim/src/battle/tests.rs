//! Rule checks for 04-battle.md §2–§8 and the order model of 08-orders.md. Each prints its counts.

use super::*;
use crate::bots::{Bot, BotKind};
use crate::contracts::{Deed, Source, Who};
use crate::map::MapKind;

fn field() -> Battle {
    Battle::new(7, MapOpts { kind: MapKind::Field, width: 48 }, &Setup::field(), Tune::default())
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
    let mut b = field();
    let (wil, oda, ren) = (named(&b, "WIL"), named(&b, "ODA"), named(&b, "REN"));
    order(&mut b, 0, Deed::Move { who: Who::Squad { id: wil as u16 }, to: P::new(12.0, 11.0), via: Vec::new(), fight: false, face: None });
    b.queue_order(wil, Order::Hold { face: Some(0.0) }, How { stance: Stance::Defensive, ..How::default() }, When::Done);
    b.queue_order(oda, Order::Move { to: P::new(12.0, 16.0), via: Vec::new(), fight: false, face: None }, How::default(), When::Signal { n: 1 });
    b.queue_order(ren, Order::Hold { face: None }, How { stance: Stance::HoldFire, ..How::default() }, When::After { s: 2.0 });
    b.step(30);
    assert_eq!(b.squads[oda].queue.len(), 1, "waits for the signal");
    assert_eq!(b.squads[ren].queue.len(), 1, "waits 2 s");
    b.raise_signal(0, 1);
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
    let mut b = field();
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
