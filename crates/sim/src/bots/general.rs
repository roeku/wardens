//! The general (04-battle.md §7 "General"), for open-field battles at skill 0/1/2, and the warband's sensible
//! `commander`, which is a skill-1 general that also takes the keep.
//!
//! Before contact it forms a new front every 6 s with the same `planFront` the player uses, stepping 8 tiles
//! toward the goal and stopping 8 short of the enemy. Contact is any company fighting or within 10 of a foe; then
//! bows hold within range + 1 or fall 3 behind the line, horse go round the flanks at bows or at foes already
//! fighting, and everyone else attacks the nearest foe within 12. Skill 1 adds the reserve and resting; skill 2
//! pulls wavering companies out, focuses wavering foes and keeps the captain back when hurt.

use super::{Memory, Orders, Seen, companies, nearest, pick, seen};
use crate::battle::{Battle, Priority, SquadState};
use crate::contracts::{Deed, Kind, P, Team, Who};
use crate::map::{MapKind, SiteKind};
use crate::math::atan2;

pub(super) fn think(b: &Battle, team: Team, skill: u8, take_keep: bool, mem: &mut Memory, out: &mut Orders) {
    let g = b.tune.bots.general.clone();
    let Some(cap) = b.captain_of(team) else { return };
    let comps = companies(b, team);
    if comps.is_empty() {
        return;
    }
    // What it sees now, and what it saw in the last 25 s (the general fights by its last sightings, like the
    // garrison: its front stops 8 short of the enemy, beyond sight, and contact is within 10).
    for f in seen(b, team) {
        mem.known.retain(|(_, k)| k.id != f.id);
        mem.known.push((b.tick, f));
    }
    let keep = (g.memory_s * 30.0) as u32;
    mem.known.retain(|(t, k)| b.tick < t + keep && b.squads[k.id as usize].on_field());
    mem.known.sort_by_key(|(_, k)| k.id);
    let foes: Vec<Seen> = mem.known.iter().map(|(_, k)| k.clone()).collect();
    if let Some(f) = nearest(&foes, b.centre(cap), f64::INFINITY) {
        mem.last_seen = Some(f.at);
    }
    let line_kind = |i: usize| !b.squads[i].spec.ranged() && b.squads[i].kind != Kind::Horse;

    // Skill 1+: the reserve, chosen once: the strongest line company, with at least 5 companies and 3 in line.
    if !mem.started {
        mem.started = true;
        let line: Vec<usize> = comps.iter().copied().filter(|&i| line_kind(i)).collect();
        if skill >= 1 && comps.len() >= g.reserve_companies && line.len() >= g.reserve_line {
            mem.reserve = line.iter().copied().max_by(|&x, &y| b.squads[x].strength(&b.tune).total_cmp(&b.squads[y].strength(&b.tune)).then(y.cmp(&x))).map(|i| b.squads[i].id);
        }
    }
    // Skill 1+: companies that rallied below 45% rest 6 tiles back until 80%.
    if skill >= 1 {
        for &i in &comps {
            let id = b.squads[i].id;
            if mem.routed.contains(&id) && b.squads[i].morale_share() < g.rest_below && !mem.resting.contains(&id) {
                mem.resting.push(id);
            }
        }
        mem.resting.retain(|&id| b.squads[id as usize].standing() && b.squads[id as usize].morale_share() < g.rest_until);
    }
    mem.routed = b.squads.iter().filter(|s| s.team == team && s.state == SquadState::Routing).map(|s| s.id).collect();

    let keep = (take_keep && matches!(b.map.kind, MapKind::Keep | MapKind::Town)).then(|| b.map.sites.first().filter(|s| s.kind != SiteKind::Village)).flatten();
    let foe_deploy = b.map.deploy[1 - (team as usize & 1)];
    let goal = match keep {
        Some(k) => k.at,
        None => mem.last_seen.unwrap_or(foe_deploy),
    };
    let army = |ids: &[usize]| {
        let n = ids.len().max(1) as f64;
        let (x, y) = ids.iter().fold((0.0, 0.0), |(x, y), &i| (x + b.centre(i).x, y + b.centre(i).y));
        P::new(x / n, y / n)
    };
    let active: Vec<usize> = comps.iter().copied().filter(|&i| Some(b.squads[i].id) != mem.reserve && !mem.resting.contains(&b.squads[i].id)).collect();
    let line: Vec<usize> = active.iter().copied().filter(|&i| line_kind(i)).collect();
    // With no line companies left the bows take the line (as planFront's fallback), so a side never stands off.
    let bows_lead = line.is_empty();
    let centre = army(if active.is_empty() { &comps } else { &active });
    let contact = comps.iter().any(|&i| b.squads[i].state == SquadState::Fighting || foes.iter().any(|f| !f.routing && f.at.dist(b.centre(i)) <= g.contact_r));
    let heading = {
        let d = goal.dist(centre);
        if d > 1e-9 { atan2(goal.y - centre.y, goal.x - centre.x) } else { b.armies[team as usize].heading }
    };
    let behind = |p: P, d: f64| p.offset(heading, -d, 0.0);
    let line_centre = if line.is_empty() { centre } else { army(&line) };

    // Resting companies go 6 behind the line (after any front this thought, which would take them along).
    let rest = |out: &mut Orders, after_front: bool| {
        for &id in &mem.resting {
            let to = b.open_near(behind(line_centre, g.rest_back));
            let deed = Deed::Move { who: Who::Squad { id }, to, via: Vec::new(), fight: false, face: Some(heading) };
            if after_front { out.push_always(deed) } else { out.push(b, deed) }
        }
    };

    if !contact {
        // Every 6 s a new front, 8 tiles toward the goal, stopping 8 short of the enemy.
        let due = mem.last_front.is_none_or(|t| b.tick >= t + (g.front_every_s * 30.0) as u32);
        if due {
            let target = foes.iter().filter(|f| !f.routing).map(|f| f.at).min_by(|a, c| a.dist(centre).total_cmp(&c.dist(centre))).unwrap_or(goal);
            let room = (target.dist(centre) - g.front_short).max(0.0);
            let step = g.front_step.min(room);
            let ahead = line_centre.offset(heading, step, 0.0);
            let half = (line.len().max(2) as f64) * b.tune.army.gap / 2.0;
            let a = ahead.offset(heading, 0.0, half);
            let c = ahead.offset(heading, 0.0, -half);
            mem.last_front = Some(b.tick);
            let front = step > 0.5 || b.squads[cap].order == crate::battle::Order::Follow;
            if front {
                out.push_always(Deed::Front { line: vec![a, c] });
            }
            if let Some(id) = mem.reserve {
                let to = b.open_near(behind(ahead, b.tune.front.bows_back + g.bow_back));
                let deed = Deed::Move { who: Who::Squad { id }, to, via: Vec::new(), fight: false, face: Some(heading) };
                if front { out.push_always(deed) } else { out.push(b, deed) }
            }
            rest(out, front);
        } else {
            rest(out, false);
        }
        if let Some(k) = keep {
            take_the_keep(b, team, k.id, k.at, &foes, &active, out);
        }
        return;
    }

    // Contact.
    let wavering = |i: usize| b.squads[i].morale_share() < g.waver;
    let mean_morale = comps.iter().map(|&i| b.squads[i].morale_share()).sum::<f64>() / comps.len() as f64;
    if let Some(id) = mem.reserve {
        let cap_at = b.centre(cap);
        let threatened = foes.iter().any(|f| !f.routing && f.at.dist(cap_at) <= g.reserve_enemy_r);
        if mean_morale < g.reserve_commit || threatened {
            mem.reserve = None;
        } else {
            let to = b.open_near(behind(line_centre, b.tune.front.bows_back + g.bow_back));
            out.push(b, Deed::Move { who: Who::Squad { id }, to, via: Vec::new(), fight: false, face: Some(heading) });
        }
    }
    let committed: Vec<usize> = comps.iter().copied().filter(|&i| Some(b.squads[i].id) != mem.reserve && !mem.resting.contains(&b.squads[i].id)).collect();
    for &i in &committed {
        let s = &b.squads[i];
        let who = Who::Squad { id: s.id };
        let here = b.centre(i);
        if skill >= 2 && wavering(i) && s.state == SquadState::Fighting {
            let to = b.open_near(behind(here, g.waver_back));
            out.push(b, Deed::Move { who, to, via: Vec::new(), fight: false, face: Some(heading) });
            continue;
        }
        if s.spec.ranged() && !bows_lead {
            if foes.iter().any(|f| f.at.dist(here) <= s.spec.range + g.bow_hold_extra) {
                out.push(b, Deed::Hold { who });
            } else {
                let to = b.open_near(behind(line_centre, g.bow_back));
                out.push(b, Deed::Move { who, to, via: Vec::new(), fight: false, face: Some(heading) });
            }
            continue;
        }
        if s.kind == Kind::Horse && skill >= 1 {
            // Horse go for bows first (the "their archers" priority), else for foes already fighting.
            let prey: Vec<Seen> = foes.iter().filter(|f| !f.routing && (f.ranged || f.fighting) && !f.captain).cloned().collect();
            if let Some(f) = pick(b, team, &prey, here, g.horse_r, Priority::Ranged) {
                if matches!(&s.order, crate::battle::Order::Attack { target, .. } if *target == f.id) {
                    continue;
                }
                // Round the flank: through a point to the side of the prey, on the horse's side.
                let to_prey = atan2(f.at.y - here.y, f.at.x - here.x);
                let (l, r) = (f.at.offset(to_prey, -g.horse_wide * 0.5, g.horse_wide), f.at.offset(to_prey, -g.horse_wide * 0.5, -g.horse_wide));
                let via = if l.dist(here) <= r.dist(here) { l } else { r };
                let via = if b.map.passable(via) && f.at.dist(here) > g.horse_wide { vec![via] } else { Vec::new() };
                out.push(b, Deed::Attack { who, target: f.id, via });
                continue;
            }
        }
        // Skill 2 focuses wavering foes: the "most shaken" priority.
        let pri = if skill >= 2 { Priority::Shaken } else { Priority::Nearest };
        match pick(b, team, &foes, here, g.attack_r, pri) {
            Some(f) => out.push(b, Deed::Attack { who, target: f.id, via: Vec::new() }),
            None => {
                let to = nearest(&foes, here, f64::INFINITY).map_or(goal, |f| f.at);
                let to = b.open_near(to);
                out.push(b, Deed::Move { who, to, via: Vec::new(), fight: true, face: None });
            }
        }
    }
    rest(out, false);
    // Skill 2 keeps the captain out of the fight below 60% hp, away from the nearest foe, until he is back at the
    // ride's 80%; then he rides again.
    if skill >= 2 {
        let man = &b.soldiers[b.squads[cap].soldiers[0]];
        let share = man.hp / man.max_hp;
        if share < g.captain_out {
            mem.captain_out = true;
        } else if share >= b.tune.ride.return_hp {
            mem.captain_out = false;
        }
        let cap_id = b.squads[cap].id;
        if mem.captain_out {
            let at = man.pos();
            let mut to = behind(line_centre, g.captain_back);
            if let Some(f) = nearest(&foes, to, g.captain_back) {
                let d = f.at.dist(at).max(1e-9);
                to = P::new(at.x + (at.x - f.at.x) / d * g.captain_back, at.y + (at.y - f.at.y) / d * g.captain_back);
            }
            // Never toward his own edge: within it he would withdraw and lose the battle.
            let m = g.edge_keep;
            let to = b.open_near(P::new(to.x.clamp(m, b.map.wf() - m), to.y.clamp(m / 2.0, b.map.hf() - m / 2.0)));
            out.push(b, Deed::Move { who: Who::Squad { id: cap_id }, to, via: Vec::new(), fight: false, face: Some(heading) });
        } else if b.squads[cap].order != crate::battle::Order::Ride
            && let Some(f) = nearest(&foes, man.pos(), f64::INFINITY)
        {
            out.push_always(Deed::Attack { who: Who::Army, target: f.id, via: Vec::new() });
        }
    }
    if let Some(k) = keep {
        take_the_keep(b, team, k.id, k.at, &foes, &committed, out);
    }
}

/// The commander's last step: when no foe it sees stands within 6 of the keep, the company nearest it goes to
/// take it.
fn take_the_keep(b: &Battle, team: Team, site: u16, at: P, foes: &[Seen], comps: &[usize], out: &mut Orders) {
    if b.sites[site as usize].owner == Some(team) || foes.iter().any(|f| !f.routing && f.at.dist(at) <= b.tune.bots.garrison.retake_clear) {
        return;
    }
    if !b.sees(team, at) {
        return;
    }
    if let Some(&i) = comps.iter().min_by(|&&x, &&y| b.centre(x).dist(at).total_cmp(&b.centre(y).dist(at)).then(x.cmp(&y))) {
        out.push(b, Deed::Take { who: Who::Squad { id: b.squads[i].id }, site, via: Vec::new() });
    }
}
