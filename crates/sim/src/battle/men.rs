//! Step 3, the soldiers (04-battle.md §3c, §5): each man picks a target, steers toward his slot or a combat point
//! with the momentum model (SETTLE, ARRIVE, RESPONSE, separation from the neighbour grid), and collects his blow
//! or loosens an arrow. Every man reads the positions of the tick's start; all move together in `integrate`.

use super::order::Rules;
use super::{Arrow, Battle, DT, SALT_COOLDOWN, SALT_SCATTER_X, SALT_SCATTER_Y, SALT_TARGET, SquadState, Strike};
use crate::contracts::{EventCode, Kind, P, Tick, Way};
use crate::map::path;
use crate::math::{atan2, cos, hyp, sin, turn};
use crate::rng::jitter;
use crate::tune::Tune;

/// What one man decided this tick, applied before the next man thinks (nothing here is read by another man's
/// thinking, so the order of men does not matter).
struct Decision {
    target: Option<usize>,
    cooldown: f64,
    charge_used: bool,
    since_contact: f64,
    engaged: bool,
    v: P,
    heading: f64,
    route: Option<(Vec<P>, P, Tick)>,
    strikes: Vec<Strike>,
    arrow: Option<Arrow>,
    /// The foe squad he is in melee contact with, and whether he strikes it from more than 110° off its facing.
    contact: Option<(usize, bool)>,
    /// The foe squad he targets.
    shot: Option<usize>,
}

impl Battle {
    pub(super) fn update_soldiers(&mut self) {
        let tune = self.tune.clone();
        let n = self.squads.len();
        let rules: Vec<Rules> = (0..n).map(|i| self.rules(i)).collect();
        // A priority other than the nearest shifts each foe squad's score for that squad's men.
        let adj: Vec<Option<Vec<f64>>> = (0..n)
            .map(|i| {
                let s = &self.squads[i];
                if s.how.priority == super::Priority::Nearest || !s.on_field() {
                    return None;
                }
                let from = self.centre(i);
                Some(
                    (0..n)
                        .map(|j| {
                            let o = &self.squads[j];
                            if o.team != s.team && o.on_field() { self.priority_score(s.team, from, j, s.how.priority) - from.dist(self.centre(j)) } else { 0.0 }
                        })
                        .collect(),
                )
            })
            .collect();
        let mut volleys: Vec<usize> = Vec::new();
        for k in 0..self.soldiers.len() {
            if !self.soldiers[k].alive {
                continue;
            }
            let d = self.think(k, &tune, &rules, &adj);
            let si = self.soldiers[k].squad as usize;
            if d.arrow.is_some() && !volleys.contains(&si) {
                volleys.push(si);
            }
            self.decide(k, d);
        }
        for si in volleys {
            let gap = (self.squads[si].spec.interval * tune.combat.cooldown_base / DT) as Tick;
            if self.tick >= self.squads[si].volley_event.saturating_add(gap) || self.squads[si].volley_event == Tick::MAX {
                self.squads[si].volley_event = self.tick;
                let at = self.centre(si);
                self.event(EventCode::Volley, at, si as u32, 0);
            }
        }
        for k in 0..self.soldiers.len() {
            if self.soldiers[k].alive {
                self.integrate(k);
            }
        }
    }

    fn decide(&mut self, k: usize, d: Decision) {
        if let Some((foe, flank)) = d.contact {
            self.scratch.attackers[foe] += 1;
            self.scratch.flanked[foe] |= flank;
        }
        if let Some(foe) = d.shot {
            self.scratch.shot[foe] = true;
        }
        let struck = !d.strikes.is_empty() || d.arrow.is_some();
        self.strikes.extend(d.strikes);
        if let Some(a) = d.arrow {
            self.arrows.push(a);
        }
        let m = &mut self.soldiers[k];
        m.target = d.target;
        m.cooldown = d.cooldown;
        m.since_contact = d.since_contact;
        m.charge_ready = !d.charge_used && (m.charge_ready || m.since_contact >= self.tune.combat.charge_regain_s);
        m.engaged = d.engaged;
        m.vx = d.v.x;
        m.vy = d.v.y;
        m.heading = d.heading;
        if struck {
            m.strikes = m.strikes.wrapping_add(1);
        }
        if let Some((route, goal, at)) = d.route {
            m.route = route;
            m.route_goal = goal;
            m.route_at = at;
        }
    }

    /// Whether foe `t` is a target man `k` may keep or take: alive and on the field, within `range` (gap within
    /// reach when `reach_only`), seen if he shoots, on a walkable line beyond 1 tile if he strikes, inside the leash.
    #[allow(clippy::too_many_arguments)]
    fn may_target(&self, k: usize, t: usize, tune: &Tune, r: &Rules, reach_only: bool, range: f64, shoots: bool) -> Option<f64> {
        let m = &self.soldiers[k];
        let o = &self.soldiers[t];
        let s = &self.squads[m.squad as usize];
        let os = &self.squads[o.squad as usize];
        if !o.alive || os.team == s.team || !os.on_field() {
            return None;
        }
        let (here, there) = (m.pos(), o.pos());
        let d = here.dist(there);
        let c = &tune.combat;
        let bulks = s.spec.radius + os.spec.radius - 2.0 * tune.movement.base_radius;
        // Without pursuit a router is struck only while he is in reach.
        if reach_only || (os.state == SquadState::Routing && !r.pursue) {
            if d - bulks > c.reach {
                return None;
            }
        } else {
            let extra = if shoots { self.height_bonus(here, there, tune) } else { 0.0 };
            if d > range + extra {
                return None;
            }
            if shoots && !self.sees(s.team, there) {
                return None;
            }
            if !shoots && d > c.walk_line_beyond && !self.line_walkable(here, there) {
                return None;
            }
        }
        if let Some((post, leash)) = r.leash
            && there.dist(post) > leash + c.reach + bulks
        {
            return None;
        }
        Some(d)
    }

    /// The archers' height bonus to range: ±1.2 per tile of height, capped at ±2 (§5 "Ranged", 03-land.md §1).
    pub(super) fn height_bonus(&self, from: P, to: P, tune: &Tune) -> f64 {
        let c = &tune.combat;
        ((self.height(from) - self.height(to)) * c.range_per_height).clamp(-c.range_height_cap, c.range_height_cap)
    }

    fn think(&self, k: usize, tune: &Tune, rules: &[Rules], adj: &[Option<Vec<f64>>]) -> Decision {
        let (mv, c) = (&tune.movement, &tune.combat);
        let m = &self.soldiers[k];
        let si = m.squad as usize;
        let s = &self.squads[si];
        let r = &rules[si];
        let here = m.pos();
        let routing = s.state == SquadState::Routing;
        let commander = s.leader == Some(k);
        let fighting = s.threat.is_some();
        let ranged = s.spec.ranged();
        let recalling = matches!(s.order, super::Order::Recall { .. });
        let reach_only = commander || !fighting || r.reach_only;
        let shoots = ranged && r.fire && !reach_only;
        let range = if ranged && !reach_only { r.seek.max(s.spec.range) } else { r.seek };
        let bulk_a = s.spec.radius - mv.base_radius;

        // Target: keep the current one within seek·1.3, else the best scored within seek.
        let mut target = None;
        if !routing {
            if let Some(t) = m.target
                && self.may_target(k, t, tune, r, reach_only, range * c.keep_target, shoots).is_some()
            {
                target = Some(t);
            }
            if target.is_none() {
                let reach = if reach_only { c.reach + bulk_a + (self.max_radius - mv.base_radius) } else { range + c.range_height_cap };
                let mut best: Option<(f64, usize)> = None;
                self.grid.visit(here, reach, |t| {
                    if self.squads[self.soldiers[t].squad as usize].team == s.team {
                        return;
                    }
                    let Some(d) = self.may_target(k, t, tune, r, reach_only, range, shoots) else { return };
                    let os = &self.squads[self.soldiers[t].squad as usize];
                    let mut score = d + c.target_jitter * jitter(self.seed, k as u32, SALT_TARGET.wrapping_add((t as u32).wrapping_mul(7919)));
                    if os.state == SquadState::Routing && !r.pursue {
                        score += c.routing_penalty;
                    }
                    if let Some(a) = &adj[si] {
                        score += a[os.id as usize];
                    }
                    if best.is_none_or(|(b, bt)| score < b || (score == b && t < bt)) {
                        best = Some((score, t));
                    }
                });
                target = best.map(|(_, t)| t);
            }
        }

        // Where he goes: his slot, a combat point, or scattered round a fleeing anchor.
        let slot = self.slot(s, m.slot, s.alive as usize);
        let mut goal = slot;
        let mut gap = f64::INFINITY;
        let mut foe_dist = f64::INFINITY;
        if routing {
            let sc = tune.morale.scatter;
            goal = P::new(
                s.x + (jitter(self.seed, k as u32, SALT_SCATTER_X) * 2.0 - 1.0) * sc,
                s.y + (jitter(self.seed, k as u32, SALT_SCATTER_Y) * 2.0 - 1.0) * sc,
            );
        } else if let Some(t) = target {
            let o = &self.soldiers[t];
            let os = &self.squads[o.squad as usize];
            let bulks = bulk_a + os.spec.radius - mv.base_radius;
            foe_dist = here.dist(o.pos());
            gap = foe_dist - bulks;
            // He stands to fight when his company fights or stands; a company on the move that is not fighting
            // (a march, a retreat, a recall, a hurt captain riding out) strikes in passing but never stops (§5).
            let stands = fighting || s.state == SquadState::Idle;
            if !ranged && !commander && !recalling && stands && s.kind != Kind::Folk {
                // A man walks in until his gap is 0.92 of reach, then stands.
                let stand = c.stand * c.reach + bulks;
                goal = if foe_dist > 1e-9 {
                    P::new(o.x + (here.x - o.x) / foe_dist * stand, o.y + (here.y - o.y) / foe_dist * stand)
                } else {
                    here
                };
            }
        }
        if let Some(sk) = r.skirmish {
            // Skirmishers step back from the nearest melee foe within reach of them.
            let mut near: Option<(f64, P)> = None;
            self.grid.visit(here, sk, |j| {
                let o = &self.soldiers[j];
                let os = &self.squads[o.squad as usize];
                let d = here.dist(o.pos());
                if os.team != s.team && !os.spec.ranged() && d <= sk && near.is_none_or(|(b, _)| d < b) {
                    near = Some((d, o.pos()));
                }
            });
            if let Some((d, p)) = near
                && d > 1e-9
            {
                goal = P::new(here.x + (here.x - p.x) / d * (sk - d + 1.0), here.y + (here.y - p.y) / d * (sk - d + 1.0));
            }
        }

        // The blow, or the arrow.
        let mut cooldown = m.cooldown - DT;
        let mut strikes = Vec::new();
        let mut arrow = None;
        let mut charge_used = false;
        let in_contact = target.is_some() && gap <= c.reach;
        let man_speed = s.speed(tune);
        let veteran = if s.way() == Some(Way::Veteran) { c.veteran_damage } else { 1.0 };
        let base = s.spec.damage * (1.0 + tune.rank.damage * s.rank as f64) * veteran;
        if let Some(t) = target
            && cooldown <= 0.0
            && !routing
        {
            let foe = &self.squads[self.soldiers[t].squad as usize];
            let next = || s.spec.interval * (c.cooldown_base + c.cooldown_jitter * jitter(self.seed, k as u32, SALT_COOLDOWN.wrapping_add(m.strikes.wrapping_mul(7919))));
            if in_contact {
                let charge = m.charge_ready
                    && m.pace > c.charge_pace * man_speed
                    && s.spec.charge > 1.0
                    && !r.no_charge
                    && !(s.kind == Kind::Horse && foe.spec.beast);
                charge_used = charge;
                let dmg = base * if ranged { s.spec.melee } else { 1.0 };
                strikes.push(Strike { attacker: k, victim: t, dmg, charge });
                if s.spec.beast {
                    self.cleave(k, t, dmg, tune, &mut strikes);
                }
                cooldown = next();
            } else if shoots && foe_dist <= s.spec.range + self.height_bonus(here, self.soldiers[t].pos(), tune) {
                let flight = (foe_dist * c.arrow_flight_k).max(c.arrow_flight_min);
                arrow = Some(Arrow { from: here, x: here.x, y: here.y, target: t, shooter: k, dmg: base, t: 0.0, flight });
                cooldown = next();
            }
        }
        let cooldown = cooldown.max(-DT);
        let since_contact = if in_contact { 0.0 } else { m.since_contact + DT };
        let engaged = in_contact || (target.is_some() && shoots && foe_dist <= s.spec.range + c.range_height_cap);
        let contact = if in_contact && !routing {
            let t = &self.soldiers[target.expect("in contact")];
            let fi = t.squad as usize;
            let fc = self.centre(fi);
            let off = atan2(here.y - fc.y, here.x - fc.x);
            let flank = crate::math::wrap(off - self.squads[fi].facing).abs() > tune.morale.flank_angle;
            Some((fi, flank))
        } else {
            None
        };
        let shot = target.map(|t| self.soldiers[t].squad as usize);

        // Steering: the momentum model.
        let to_slot = here.dist(slot);
        let catchup = if to_slot > mv.catchup_far_at {
            mv.catchup_far
        } else if to_slot > mv.catchup_near_at {
            mv.catchup_near
        } else {
            1.0
        };
        let speed = man_speed
            * catchup
            * if routing { tune.morale.rout_speed } else { 1.0 }
            * if recalling { tune.morale.recall_pace } else { 1.0 };
        let d_goal = here.dist(goal);
        let mut route = None;
        let mut aim = goal;
        if d_goal > mv.catchup_near_at && !path::line_clear(&self.map, here, goal) {
            let (mut way, mut wgoal, mut wat) = (m.route.clone(), m.route_goal, m.route_at);
            if way.is_empty() || wgoal.dist(goal) > mv.route_moved || self.tick >= wat {
                way = path::route_clear(&self.map, here, goal).unwrap_or_default();
                wgoal = goal;
                wat = self.tick + (mv.route_s / DT).round() as Tick;
            }
            while way.len() > 1 && way[0].dist(here) < mv.arrive_at {
                way.remove(0);
            }
            if let Some(&w) = way.first() {
                aim = w;
            }
            route = Some((way, wgoal, wat));
        } else if !m.route.is_empty() {
            route = Some((Vec::new(), goal, self.tick));
        }
        let (mut wx, mut wy) = (0.0, 0.0);
        let mut pushed = false;
        let ra = s.spec.radius;
        self.grid.visit(here, ra + self.max_radius, |j| {
            if j == k {
                return;
            }
            let o = &self.soldiers[j];
            let os = &self.squads[o.squad as usize];
            let rb = os.spec.radius;
            let rr = ra + rb;
            let (dx, dy) = (here.x - o.x, here.y - o.y);
            let d = hyp(dx, dy);
            if d >= rr {
                return;
            }
            pushed = true;
            let mass = ((rb / ra) * (rb / ra)).clamp(mv.mass_min, mv.mass_max);
            let push = (rr - d) / rr * mv.separation * if os.team == s.team { mv.sep_friend } else { mv.sep_foe } * mass;
            if d > 1e-9 {
                wx += dx / d * push;
                wy += dy / d * push;
            } else {
                // Two men on one spot part along a direction fixed by their ids.
                let a = std::f64::consts::TAU * jitter(self.seed, k.min(j) as u32, j.max(k) as u32);
                let sign = if k < j { 1.0 } else { -1.0 };
                wx += cos(a) * push * sign;
                wy += sin(a) * push * sign;
            }
        });
        // The arrive term. SETTLE's dead zone holds for a man nobody pushes; a pushed man keeps the (continuous)
        // arrive term down to 0.025, so he comes to rest against the push instead of cycling across SETTLE's edge.
        if d_goal > mv.settle || (pushed && d_goal > mv.settle_ease) {
            let da = here.dist(aim).max(1e-9);
            let dir = P::new((aim.x - here.x) / da, (aim.y - here.y) / da);
            let v = (speed * self.ground_pace(here, dir)).min((d_goal - mv.settle_ease) * mv.arrive);
            wx += dir.x * v;
            wy += dir.y * v;
        }
        let ease = (DT * mv.response).min(1.0);
        let mut v = P::new(m.vx + (wx - m.vx) * ease, m.vy + (wy - m.vy) * ease);
        let mut heading = m.heading;
        let mag = hyp(v.x, v.y);
        if mag > mv.settle {
            if s.spec.turn > 0.0 {
                heading = turn(m.heading, atan2(v.y, v.x), s.spec.turn * DT);
                v = P::new(cos(heading) * mag, sin(heading) * mag);
            } else {
                heading = atan2(v.y, v.x);
            }
        }
        Decision { target, cooldown, charge_used, since_contact, engaged, v, heading, route, strikes, arrow, contact, shot }
    }

    /// §5 "Beasts": each blow also hits the 3 nearest other foes within 1.5 at 0.6 share.
    fn cleave(&self, k: usize, victim: usize, dmg: f64, tune: &Tune, out: &mut Vec<Strike>) {
        let b = &tune.beast;
        let here = self.soldiers[k].pos();
        let team = self.squads[self.soldiers[k].squad as usize].team;
        let mut near: Vec<(f64, usize)> = Vec::new();
        self.grid.visit(here, b.cleave_r, |j| {
            let o = &self.soldiers[j];
            let d = here.dist(o.pos());
            if j != victim && self.squads[o.squad as usize].team != team && d <= b.cleave_r {
                near.push((d, j));
            }
        });
        near.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        for &(_, j) in near.iter().take(b.cleave_n) {
            out.push(Strike { attacker: k, victim: j, dmg: dmg * b.cleave_share, charge: false });
        }
    }

    /// Moves a man by his velocity one axis at a time against walkable ground, 0.2 inside the map, and low-passes
    /// his pace at `dt·4`. A man standing somewhere unwalkable may step out of it.
    fn integrate(&mut self, k: usize) {
        let mv = &self.tune.movement;
        let (w, h) = (self.map.wf(), self.map.hf());
        let m = &self.soldiers[k];
        let nx = (m.x + m.vx * DT).clamp(mv.edge_margin, w - mv.edge_margin);
        let ny = (m.y + m.vy * DT).clamp(mv.edge_margin, h - mv.edge_margin);
        let stuck = !self.walkable(m.pos());
        let x = if stuck || self.walkable(P::new(nx, m.y)) { nx } else { m.x };
        let y = if stuck || self.walkable(P::new(x, ny)) { ny } else { m.y };
        let actual = m.pos().dist(P::new(x, y)) / DT;
        let rate = (DT * mv.pace_rate).min(1.0);
        let m = &mut self.soldiers[k];
        m.pace += (actual - m.pace) * rate;
        m.x = x;
        m.y = y;
    }
}
