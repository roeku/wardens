//! The captain's ride (04-battle.md §5): before contact he trails 3.5 behind the foot line; after it he rides at
//! the foe pressing his most shaken company, round its flank, re-picking every 5 s; hurt, he rides 5 behind the
//! army until healed.

use super::anchor::Facing;
use super::{Battle, SquadState};
use crate::contracts::{Kind, P, SquadId};
use crate::math::{atan2, cos, sin};

impl Battle {
    /// Leaving the fight below 50% hp or after losing 20% within 2 s; returning at 80%. Checked for every riding
    /// captain before engagement (step 2), so a captain in a brawl can still leave it.
    pub(super) fn ride_wounds(&mut self) {
        let rt = self.tune.ride.clone();
        for c in 0..self.squads.len() {
            let s = &self.squads[c];
            if s.kind != Kind::Captain || s.order != super::Order::Ride || !s.on_field() {
                continue;
            }
            let m = &self.soldiers[s.soldiers[0]];
            let (hp, max) = (m.hp, m.max_hp);
            let peak = s.hp_ring.iter().copied().fold(hp, f64::max);
            let r = &mut self.squads[c].ride;
            if !r.out && (hp < rt.leave_hp * max || peak - hp >= rt.burst * max) {
                r.out = true;
                r.target = None;
            } else if r.out && hp >= rt.return_hp * max {
                r.out = false;
            }
        }
    }

    pub(super) fn ride(&mut self, c: usize) {
        let rt = self.tune.ride.clone();
        let team = self.squads[c].team;
        let man = self.squads[c].soldiers[0];
        let out = self.squads[c].ride.out;
        let companies: Vec<usize> = (0..self.squads.len()).filter(|&j| self.squads[j].team == team && self.squads[j].standing() && self.squads[j].kind != Kind::Captain).collect();
        let speed = self.squads[c].speed(&self.tune);
        let here = self.soldiers[man].pos();
        if companies.is_empty() {
            self.squads[c].state = SquadState::Idle;
            return;
        }
        let foot: Vec<usize> = companies.iter().copied().filter(|&j| !self.squads[j].spec.ranged() && self.squads[j].kind != Kind::Horse).collect();
        let line = if foot.is_empty() { &companies } else { &foot };
        let mean = |b: &Battle, ids: &[usize]| {
            let n = ids.len() as f64;
            let (x, y) = ids.iter().fold((0.0, 0.0), |(x, y), &j| (x + b.centre(j).x, y + b.centre(j).y));
            P::new(x / n, y / n)
        };
        let (fx, fy) = line.iter().fold((0.0, 0.0), |(x, y), &j| (x + cos(self.squads[j].facing), y + sin(self.squads[j].facing)));
        let heading = if fx == 0.0 && fy == 0.0 { self.armies[team as usize].heading } else { atan2(fy, fx) };
        if out {
            // Behind the army means away from the threat (mid-fight its companies face every way).
            let army = mean(self, &companies);
            let threat = self.threat_point(team, army);
            let away = if threat.dist(army) > 1e-9 { atan2(threat.y - army.y, threat.x - army.x) } else { heading };
            let goal = army.offset(away, -rt.back, 0.0);
            // Never onto his own edge, where he would withdraw and lose the battle.
            let (w, h, m) = (self.map.wf(), self.map.hf(), rt.edge_keep);
            let goal = self.open_near(P::new(goal.x.clamp(m, w - m), goal.y.clamp(m / 2.0, h - m / 2.0)));
            self.ride_to(c, goal, speed, Some(away), rt.trail_slack);
            if self.squads[c].state == SquadState::Marching && self.soldiers[man].since_contact < rt.burst_s {
                // Still in reach of a foe: he rides out at full pace, not the followers' easing law.
                self.walk(c, goal, speed, false, Facing::Step);
            }
            return;
        }
        let contact = companies.iter().any(|&j| self.squads[j].state == SquadState::Fighting);
        let trail = self.trail_point(c, &companies, mean(self, line), heading);
        if !contact {
            self.squads[c].ride.target = None;
            self.ride_to(c, trail, speed, Some(heading), rt.trail_slack);
            return;
        }
        let valid = self.squads[c].ride.target.is_some_and(|t| self.squads[t as usize].standing());
        if !valid || self.tick >= self.squads[c].ride.repick_at {
            let pick = self.ride_pick(c, &companies);
            let r = &mut self.squads[c].ride;
            if pick != r.target {
                r.went_in = false;
            }
            r.target = pick;
            r.repick_at = self.tick + (rt.repick_s * crate::contracts::TICK_HZ as f64) as u32;
        }
        let Some(t) = self.squads[c].ride.target.map(|t| t as usize) else {
            self.ride_to(c, trail, speed, Some(heading), rt.trail_slack);
            return;
        };
        let flank = self.flank_point(t, here);
        if !self.squads[c].ride.went_in && here.dist(flank) > rt.flank_reached {
            self.ride_to(c, flank, speed, None, self.tune.army.march_above);
        } else {
            self.squads[c].ride.went_in = true;
            let goal = self.centre(t);
            self.ride_to(c, goal, speed, None, self.tune.army.march_above);
        }
    }

    /// The trail point: `trail` behind the foot line `line` along `heading`, or behind the rearmost of his own
    /// companies standing in his lane (the bows stand 3.2 behind the line, inside 3.5), clear by `flank_clear`;
    /// kept off the map's sides. It moves continuously with the companies, so he never chases a jumping point.
    fn trail_point(&self, c: usize, companies: &[usize], line: P, heading: f64) -> P {
        let rt = &self.tune.ride;
        let f = P::from_angle(heading);
        let mut back = rt.trail;
        for &j in companies.iter().filter(|&&j| j != c) {
            let d = P::new(self.centre(j).x - line.x, self.centre(j).y - line.y);
            let behind = -(d.x * f.x + d.y * f.y);
            let lateral = (d.x * f.y - d.y * f.x).abs();
            let room = self.spread(j) + rt.flank_clear;
            if lateral < room && behind + room > back {
                back = behind + room;
            }
        }
        let p = line.offset(heading, -back, 0.0);
        let (w, h, m) = (self.map.wf(), self.map.hf(), rt.edge_keep);
        self.open_near(P::new(p.x.clamp(m, w - m), p.y.clamp(m / 2.0, h - m / 2.0)))
    }

    /// Rides toward `goal` with the followers' hysteresis: he sets off beyond `slack` (1 tile, or the trail's
    /// slack behind a drifting line) and stops within 0.3.
    fn ride_to(&mut self, c: usize, goal: P, speed: f64, face: Option<f64>, slack: f64) {
        let here = P::new(self.squads[c].x, self.squads[c].y);
        let a = self.tune.army.clone();
        let d = here.dist(goal);
        let s = &mut self.squads[c];
        if !s.following && d > slack {
            s.following = true;
        } else if s.following && d < a.idle_below {
            s.following = false;
        }
        if !s.following {
            s.state = SquadState::Idle;
            if let Some(f) = face {
                s.facing = crate::math::turn(s.facing, f, self.tune.movement.anchor_turn * super::DT);
            }
            return;
        }
        // The followers' speed law (§3d), so he keeps a steady lag behind a moving line instead of stopping.
        let speed = speed.min(a.follow_base + a.follow_k * d);
        self.walk(c, goal, speed, false, Facing::Step);
        self.squads[c].state = SquadState::Marching;
    }

    /// The foe pressing his most shaken company, scored `d + 8·morale%`, within 12; approaches with more than 3
    /// other foes within 3.5 of the flank point are skipped.
    fn ride_pick(&self, c: usize, companies: &[usize]) -> Option<SquadId> {
        let rt = &self.tune.ride;
        let here = self.soldiers[self.squads[c].soldiers[0]].pos();
        let mut best: Option<(f64, SquadId)> = None;
        for &f in companies {
            let Some(t) = self.squads[f].threat else { continue };
            let ti = t as usize;
            // The ride relieves a company; it never seeks a duel with the enemy captain, which would decide the
            // battle on one fight.
            if self.squads[ti].kind == Kind::Captain {
                continue;
            }
            let d = here.dist(self.centre(ti));
            if d > rt.pick_r {
                continue;
            }
            let flank = self.flank_point(ti, here);
            let mut crowd = 0;
            self.grid.visit(flank, rt.crowd_r, |k| {
                let m = &self.soldiers[k];
                if m.squad != t && self.squads[m.squad as usize].team != self.squads[c].team && m.pos().dist(flank) <= rt.crowd_r {
                    crowd += 1;
                }
            });
            if crowd > rt.crowd_n {
                continue;
            }
            let score = d + rt.morale_weight * self.squads[f].morale_share();
            if best.is_none_or(|(b, bt)| score < b || (score == b && t < bt)) {
                best = Some((score, t));
            }
        }
        best.map(|(_, t)| t)
    }

    /// The flank of squad `t` nearer `from`: `wide + 1.4` clear of its outermost man, across its facing.
    fn flank_point(&self, t: usize, from: P) -> P {
        let centre = self.centre(t);
        let wide = self.spread(t) + self.tune.ride.flank_clear;
        let face = self.squads[t].facing;
        let (a, b) = (centre.offset(face, 0.0, wide), centre.offset(face, 0.0, -wide));
        if a.dist(from) <= b.dist(from) { a } else { b }
    }
}
