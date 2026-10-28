//! Step 10, morale (04-battle.md §5 "Morale", "Routing"; §6 ways): flank and outnumber losses with their
//! shields, recovery, horse terror, breaking below 22, rallying after 5 quiet seconds, and the captain's wounds
//! closing.

use super::{Battle, DT, Order, SquadState};
use crate::contracts::{EventCode, Kind, P, Way};

impl Battle {
    pub(super) fn update_morale(&mut self) {
        let mo = self.tune.morale.clone();
        let ways = self.tune.ways.clone();
        let beast = self.tune.beast.clone();
        for i in 0..self.squads.len() {
            let s = &self.squads[i];
            if !s.on_field() || s.alive == 0 {
                continue;
            }
            if s.kind == Kind::Captain {
                let k = s.soldiers[0];
                let m = &mut self.soldiers[k];
                if m.since_contact >= mo.captain_regen_after_s {
                    m.hp = (m.hp + mo.captain_regen * DT).min(m.max_hp);
                }
                continue;
            }
            let team = s.team;
            let centre = self.centre(i);
            let near = self.grid.foes_near(centre, mo.rally_clear_r + self.spread(i), team) && self.foe_within(team, centre, mo.rally_clear_r + self.spread(i));
            if s.state == SquadState::Routing {
                let quiet = if near { 0.0 } else { s.quiet + DT };
                self.squads[i].quiet = quiet;
                if quiet >= mo.rally_quiet_s && !self.squads[i].commander_fell {
                    self.rally(i);
                }
                continue;
            }
            self.squads[i].quiet = if near { 0.0 } else { self.squads[i].quiet + DT };
            let s = &self.squads[i];
            let aura = self.captain_at(team).is_some_and(|c| c.dist(centre) <= mo.aura_r);
            let steady = self.squads.iter().enumerate().any(|(j, o)| {
                o.team == team && o.standing() && o.way() == Some(Way::Steady) && self.centre(j).dist(centre) <= ways.steady_r
            });
            let way = match s.way() {
                Some(Way::Stubborn) => ways.stubborn_morale,
                Some(Way::Reckless) => ways.reckless_morale,
                _ => 1.0,
            };
            let shield = if aura { mo.aura_shield } else { 1.0 } * if steady { ways.steady_shield } else { 1.0 } * way;
            let att = self.scratch.attackers[i];
            let mut loss = 0.0;
            if self.scratch.flanked[i] {
                loss += mo.flank_rate;
            }
            if att >= mo.outnumber_min && att as f64 >= mo.outnumber_ratio * s.alive as f64 {
                loss += mo.outnumber_rate;
            }
            let attacked = att > 0 || self.scratch.shot[i];
            let mut gain = if !attacked {
                mo.recover
            } else if aura {
                mo.aura_recover
            } else {
                0.0
            };
            if steady {
                gain += ways.steady_regen;
            }
            let terror = s.kind == Kind::Horse && !s.spec.beast && self.beast_near(team, centre, beast.terror_r);
            let mut morale = s.morale - loss * shield * DT + gain * DT;
            if terror {
                morale -= beast.terror_rate * DT;
            }
            morale = morale.min(s.max_morale);
            if s.commander_fell {
                morale = morale.min(mo.commander_fell_cap);
            }
            let breaks = morale < mo.rout_below && !s.spec.never_routes && !s.last_stand;
            self.squads[i].morale = morale;
            if breaks {
                let s = &mut self.squads[i];
                s.state = SquadState::Routing;
                s.threat = None;
                s.quiet = 0.0;
                s.path.clear();
                let (at, id) = (P::new(s.x, s.y), s.id as u32);
                self.event(EventCode::Rout, at, id, 0);
            }
        }
    }

    /// A living foe man within `r` of `p`.
    fn foe_within(&self, team: u8, p: P, r: f64) -> bool {
        let mut found = false;
        self.grid.visit(p, r, |k| {
            let m = &self.soldiers[k];
            if !found && self.squads[m.squad as usize].team != team && m.pos().dist(p) <= r {
                found = true;
            }
        });
        found
    }

    fn beast_near(&self, team: u8, p: P, r: f64) -> bool {
        let mut found = false;
        self.grid.visit(p, r, |k| {
            let m = &self.soldiers[k];
            let s = &self.squads[m.squad as usize];
            if !found && s.team != team && s.spec.beast && m.pos().dist(p) <= r {
                found = true;
            }
        });
        found
    }

    /// §5 "Rallying": back at morale 45 with a hold order where it stands.
    fn rally(&mut self, i: usize) {
        let m = self.tune.morale.rally_morale;
        self.set_order(i, Order::Hold { face: None }, None);
        let s = &mut self.squads[i];
        s.state = SquadState::Idle;
        s.morale = m.min(s.max_morale);
        s.quiet = 0.0;
        let (at, id) = (P::new(s.x, s.y), s.id as u32);
        self.event(EventCode::Rally, at, id, 0);
    }
}
