//! The garrison (04-battle.md §7 "Garrison"): defending a place, thinking every 1.5 s.
//! 1. Each company remembers its first place as its post.
//! 2. At night everyone attacks the nearest foe.
//! 3. The melee company nearest the keep guards it, attacking anything within 5.
//! 4. Shaken companies (below 40%, not fighting) go to the shrine, else the keep.
//! 5. The threat is the seen foe nearest any held site within 9: free melee companies within 16 attack the foe
//!    nearest each among those within 8 of it; archers go 4 behind the first responder; the general rides at it.
//! 6. Sallies after 12 s, every 20 s at most: `max(2, round(0.6·free))` companies above 60% morale, at the
//!    attacker's villages nearest the keep first, then neutral ones, only with 1.4× the foe men seen near the
//!    target in the last 25 s; they march as a line and come home when the site is ours, at 50% losses, when the
//!    keep is threatened, or after 75 s.
//! 7. Otherwise back to the post, or retake a lost site within 12 when no foe is within 6 of it.

use super::{Memory, Orders, Seen, companies, nearest, quarry, seen};
use crate::battle::{Battle, SquadState, line_spots};
use crate::contracts::{Deed, P, SquadId, Team, Tick, Who};
use crate::map::SiteKind;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Sally {
    members: Vec<SquadId>,
    site: u16,
    started: Tick,
    men: usize,
}

pub(super) fn think(b: &Battle, team: Team, mem: &mut Memory, out: &mut Orders) {
    let g = b.tune.bots.garrison.clone();
    let comps = companies(b, team);
    if mem.posts.is_empty() {
        mem.posts = comps.iter().map(|&i| (b.squads[i].id, P::new(b.squads[i].x, b.squads[i].y), b.squads[i].facing)).collect();
        mem.sally_ready = (g.sally_after_s * 30.0) as Tick;
    }
    let foes = seen(b, team);
    let ticks = |s: f64| (s * 30.0) as Tick;
    for f in &foes {
        mem.sightings.push((b.tick, f.at, f.men));
    }
    mem.sightings.retain(|&(t, _, _)| b.tick < t + ticks(g.sighting_s));

    let keep = b.map.sites.iter().find(|s| matches!(s.kind, SiteKind::Keep | SiteKind::Town)).map_or(b.map.deploy[team as usize & 1], |s| s.at);
    let attack = |out: &mut Orders, i: usize, f: &Seen| out.push(b, Deed::Attack { who: Who::Squad { id: b.squads[i].id }, target: f.id, via: Vec::new() });
    let go = |out: &mut Orders, i: usize, to: P, fight: bool, face: Option<f64>| {
        let to = b.open_near(to);
        out.push(b, Deed::Move { who: Who::Squad { id: b.squads[i].id }, to, via: Vec::new(), fight, face })
    };

    // 2. Night.
    if b.night {
        for &i in &comps {
            if let Some(f) = nearest(&foes, b.centre(i), f64::INFINITY) {
                attack(out, i, f);
            }
        }
        return;
    }
    let mut busy: Vec<usize> = Vec::new();

    // 3. Keep guard.
    let guard = comps.iter().copied().filter(|&i| !b.squads[i].spec.ranged()).min_by(|&x, &y| b.centre(x).dist(keep).total_cmp(&b.centre(y).dist(keep)).then(x.cmp(&y)));
    if let Some(i) = guard {
        busy.push(i);
        match nearest(&foes, keep, g.guard_r) {
            Some(f) => attack(out, i, f),
            None => go(out, i, keep, true, None),
        }
    }

    // 4. Shaken.
    let shrine = b.map.sites.iter().zip(&b.sites).filter(|(s, st)| s.kind == SiteKind::Shrine && st.owner == Some(team)).map(|(s, _)| s.at).next();
    for &i in &comps {
        if busy.contains(&i) {
            continue;
        }
        let s = &b.squads[i];
        if s.morale_share() < g.shaken && s.state != SquadState::Fighting {
            busy.push(i);
            go(out, i, shrine.unwrap_or(keep), false, None);
        }
    }

    // The sally in progress: home when the site is ours, at 50% losses, when the keep is threatened, or after 75 s.
    let held: Vec<P> = b.map.sites.iter().zip(&b.sites).filter(|(_, st)| st.owner == Some(team)).map(|(s, _)| s.at).collect();
    let threat = foes
        .iter()
        .filter(|f| !f.routing)
        .filter_map(|f| held.iter().map(|&h| f.at.dist(h)).min_by(|a, c| a.total_cmp(c)).filter(|&d| d <= g.threat_r).map(|d| (d, f)))
        .min_by(|a, c| a.0.total_cmp(&c.0).then(a.1.id.cmp(&c.1.id)))
        .map(|(_, f)| f.clone());
    let keep_threatened = threat.as_ref().is_some_and(|f| f.at.dist(keep) <= g.threat_r);
    if let Some(sally) = mem.sally.clone() {
        let alive: usize = sally.members.iter().map(|&id| b.squads[id as usize].alive as usize).sum();
        let standing: Vec<usize> = sally.members.iter().map(|&id| id as usize).filter(|&i| b.squads[i].standing()).collect();
        let over = b.sites[sally.site as usize].owner == Some(team)
            || (alive as f64) < g.sally_losses * sally.men as f64
            || keep_threatened
            || b.tick >= sally.started + ticks(g.sally_max_s)
            || standing.is_empty();
        if over {
            mem.sally = None;
            mem.sally_ready = b.tick + ticks(g.sally_cooldown_s);
        } else {
            let at = b.map.sites[sally.site as usize].at;
            for &i in &standing {
                if busy.contains(&i) {
                    continue;
                }
                busy.push(i);
                match nearest(&foes, b.centre(i), b.tune.combat.melee + 2.0) {
                    Some(f) => attack(out, i, f),
                    None if i == standing[0] => out.push(b, Deed::Take { who: Who::Squad { id: b.squads[i].id }, site: sally.site, via: Vec::new() }),
                    None => {
                        let _ = at;
                    }
                }
            }
        }
    }

    // 5. The threat.
    if let Some(t) = &threat {
        let near: Vec<&Seen> = foes.iter().filter(|f| !f.routing && f.at.dist(t.at) <= g.foe_near_threat).collect();
        let mut first: Option<usize> = None;
        for &i in &comps {
            let s = &b.squads[i];
            if busy.contains(&i) || s.spec.ranged() || b.centre(i).dist(t.at) > g.respond_r {
                continue;
            }
            let here = b.centre(i);
            // Beasts choose by their own rule among the foes near the threat (§7 "Contact"): breathers by score,
            // trolls the nearest foot; everyone else the nearest.
            let close: Vec<Seen> = near.iter().map(|&f| f.clone()).collect();
            let choice = quarry(b, i, &close, here).or_else(|| close.iter().min_by(|a, c| a.at.dist(here).total_cmp(&c.at.dist(here)).then(a.id.cmp(&c.id))));
            if let Some(f) = choice {
                busy.push(i);
                first.get_or_insert(i);
                attack(out, i, f);
            }
        }
        if let Some(r) = first {
            let rc = b.centre(r);
            let d = rc.dist(t.at).max(1e-9);
            let back = P::new(rc.x - (t.at.x - rc.x) / d * g.archers_behind, rc.y - (t.at.y - rc.y) / d * g.archers_behind);
            for &i in &comps {
                if !busy.contains(&i) && b.squads[i].spec.ranged() {
                    busy.push(i);
                    go(out, i, back, true, None);
                }
            }
        }
        if let Some(cap) = b.captain_of(team) {
            out.push(b, Deed::Attack { who: Who::Squad { id: b.squads[cap].id }, target: t.id, via: Vec::new() });
        }
    }

    // 6. A new sally.
    let free: Vec<usize> = comps.iter().copied().filter(|i| !busy.contains(i)).collect();
    if mem.sally.is_none() && threat.is_none() && b.tick >= mem.sally_ready {
        let mut party: Vec<usize> = free.iter().copied().filter(|&i| b.squads[i].morale_share() > g.sally_morale).collect();
        let size = ((g.sally_share * free.len() as f64).round() as usize).max(g.sally_min);
        if party.len() >= g.sally_min {
            party.truncate(size);
            let foe_team = 1 - (team & 1);
            let mut targets: Vec<(u8, f64, u16)> = b
                .map
                .sites
                .iter()
                .zip(&b.sites)
                .filter(|(s, st)| s.kind == SiteKind::Village && st.owner != Some(team))
                .map(|(s, st)| (if st.owner == Some(foe_team) { 0 } else { 1 }, s.at.dist(keep), s.id))
                .collect();
            targets.sort_by(|a, c| a.0.cmp(&c.0).then(a.1.total_cmp(&c.1)).then(a.2.cmp(&c.2)));
            let men: usize = party.iter().map(|&i| b.squads[i].alive as usize).sum();
            for (_, _, site) in targets {
                let at = b.map.sites[site as usize].at;
                let seen_there: usize = mem.sightings.iter().filter(|(_, p, _)| p.dist(at) <= g.sighting_r).map(|&(_, _, n)| n).max().unwrap_or(0);
                if men as f64 >= g.sally_odds * seen_there as f64 {
                    let spots = line_spots(&party.iter().map(|&i| (b.squads[i].id, b.centre(i))).collect::<Vec<_>>(), at, b.tune.front.line_gap);
                    for (id, p, face) in spots {
                        go(out, id as usize, p, true, Some(face));
                        busy.push(id as usize);
                    }
                    mem.sally = Some(Sally { members: party.iter().map(|&i| b.squads[i].id).collect(), site, started: b.tick, men });
                    break;
                }
            }
        }
    }

    // 7. Otherwise: retake a lost site within 12 with no foe within 6, or back to the post.
    for &i in &comps {
        if busy.contains(&i) {
            continue;
        }
        let id = b.squads[i].id;
        let Some(&(_, post, face)) = mem.posts.iter().find(|p| p.0 == id) else { continue };
        let lost = b.map.sites.iter().zip(&b.sites).find(|(s, st)| {
            st.owner.is_some_and(|o| o != team) && s.at.dist(post) <= g.retake_r && !foes.iter().any(|f| f.at.dist(s.at) <= g.retake_clear)
        });
        match lost {
            Some((s, _)) => out.push(b, Deed::Take { who: Who::Squad { id }, site: s.id, via: Vec::new() }),
            None => go(out, i, post, false, Some(face)),
        }
    }
}
