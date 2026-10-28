//! Step 3, the soldiers (04-battle.md §3c, §5): each man picks a target, steers toward his slot or a combat point
//! with the momentum model (SETTLE, ARRIVE, RESPONSE, separation from the neighbour grid), and collects his blow
//! or loosens an arrow. Every man reads the positions of the tick's start; all move together in `integrate`.
//!
//! A breather (the drake) hunts instead (§5 "Drake breath"): it rears when its prey is within 2.4, holds ground
//! while its jet sweeps a cone, lunges for the bite and springs back, then takes the densest spot no pack-mate
//! has taken. Men whose company meets a drake step at most 1 tile from their slots. A blow with `impact` lands
//! that many seconds after it starts.

use super::order::Rules;
use super::{Arrow, Battle, Blow, DT, SALT_COOLDOWN, SALT_SCATTER_X, SALT_SCATTER_Y, SALT_TARGET, SquadState, Strike};
use crate::contracts::{EventCode, Kind, P, TICK_HZ, Tick, Way};
use crate::map::path;
use crate::math::{atan2, cos, hyp, sin, turn, wrap};
use crate::rng::jitter;
use crate::tune::Tune;

/// A man's personal A* route, its goal and when to replan it; `Some` when it changed this tick.
type Route = Option<(Vec<P>, P, Tick)>;

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
    route: Route,
    strikes: Vec<Strike>,
    /// Blows started now that land later (`impact`).
    blows: Vec<Blow>,
    /// Breath pulses: harm to everyone in the cone, and the morale each company caught loses.
    burns: Vec<Strike>,
    scorch: Vec<(usize, f64)>,
    /// A jet started this tick (the `Breath` event).
    breath: bool,
    /// The breath cycle's start, `Tick::MAX` when none runs.
    cycle: Tick,
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
        for (q, loss) in d.scorch {
            self.scratch.scorch[q] += loss;
            self.tally.scorch += loss;
        }
        let struck = !d.strikes.is_empty() || d.arrow.is_some() || !d.blows.is_empty();
        if struck && d.cycle != Tick::MAX {
            self.tally.bites += 1;
        }
        self.tally.impacts += d.blows.len() as u64;
        self.strikes.extend(d.strikes);
        self.strikes.extend(d.burns);
        self.blows.extend(d.blows);
        if let Some(a) = d.arrow {
            self.tally.arrows += 1;
            self.arrows.push(a);
        }
        if d.breath {
            self.tally.jets += 1;
            let at = self.soldiers[k].pos();
            self.event(EventCode::Breath, at, k as u32, 0);
        }
        let m = &mut self.soldiers[k];
        m.cycle = d.cycle;
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
            let extra = if shoots { self.height_bonus(here, there, tune) + self.work_bonus(here, s.team, "range") } else { 0.0 };
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
        if s.spec.breath > 0.0 && !routing && !commander && !recalling && (fighting || s.state == SquadState::Idle) {
            return self.hunt(k, tune, r);
        }
        let reach_only = commander || !fighting || r.reach_only;
        let shoots = ranged && r.fire && !reach_only;
        let range = if ranged && !reach_only { r.seek.max(s.spec.range) } else { r.seek };
        let bulk_a = s.spec.radius - mv.base_radius;

        // Target: keep the current one within seek·1.3, else the best scored within seek.
        let mut target = None;
        if !routing && r.strike {
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
        // Meeting a drake (§5): men step at most 1 tile from their slots; the anchor presses the block forward.
        if !routing
            && let Some(t) = s.threat
            && self.squads[t as usize].spec.breath > 0.0
        {
            let (d, step) = (goal.dist(slot), tune.breath.meet_step);
            if d > step {
                goal = P::new(slot.x + (goal.x - slot.x) * step / d, slot.y + (goal.y - slot.y) * step / d);
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
        let mut blows = Vec::new();
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
                self.blow(k, t, dmg, charge, tune, &mut strikes, &mut blows);
                cooldown = next();
            } else if shoots && foe_dist <= s.spec.range + self.height_bonus(here, self.soldiers[t].pos(), tune) + self.work_bonus(here, s.team, "range") {
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
        let marching = s.state == SquadState::Marching && !fighting && !routing;
        let speed = man_speed
            * catchup(mv, to_slot)
            * if routing { tune.morale.rout_speed } else { 1.0 }
            * if recalling { tune.morale.recall_pace } else { 1.0 }
            * if marching { s.how.pace_k(tune) } else { 1.0 };
        let (v, heading, route) = self.steer(k, goal, speed, None, tune);
        Decision {
            target,
            cooldown,
            charge_used,
            since_contact,
            engaged,
            v,
            heading,
            route,
            strikes,
            blows,
            burns: Vec::new(),
            scorch: Vec::new(),
            breath: false,
            cycle: Tick::MAX,
            arrow,
            contact,
            shot,
        }
    }

    /// The momentum model (§3c) toward `goal` at `speed`: a personal A* route when the straight line is blocked,
    /// the arrive term, separation from the neighbour grid, the response ease, and a beast's turn limit. With
    /// `face`, he turns toward it at his rate and steps any way (a hunting drake keeps its eyes on its prey while it
    /// springs back).
    fn steer(&self, k: usize, goal: P, speed: f64, face: Option<f64>, tune: &Tune) -> (P, f64, Route) {
        let mv = &tune.movement;
        let m = &self.soldiers[k];
        let s = &self.squads[m.squad as usize];
        let here = m.pos();
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
        if let Some(f) = face {
            heading = if s.spec.turn > 0.0 { turn(m.heading, f, s.spec.turn * DT) } else { f };
        } else if mag > mv.settle {
            if s.spec.turn > 0.0 {
                heading = turn(m.heading, atan2(v.y, v.x), s.spec.turn * DT);
                v = P::new(cos(heading) * mag, sin(heading) * mag);
            } else {
                heading = atan2(v.y, v.x);
            }
        }
        (v, heading, route)
    }

    /// A blow starts: it lands in this tick's step 4 with a beast's cleave, or after the unit's `impact` (§5 "Myth
    /// rules"), when the cleave is reckoned where the blow falls.
    #[allow(clippy::too_many_arguments)]
    fn blow(&self, k: usize, t: usize, dmg: f64, charge: bool, tune: &Tune, strikes: &mut Vec<Strike>, blows: &mut Vec<Blow>) {
        let s = &self.squads[self.soldiers[k].squad as usize];
        if s.spec.impact > 0.0 {
            let lands = self.tick + ((s.spec.impact * TICK_HZ as f64).round() as Tick).max(1);
            blows.push(Blow { attacker: k, victim: t, dmg, charge, lands });
            return;
        }
        strikes.push(Strike { attacker: k, victim: t, dmg, charge, breath: false });
        if s.spec.beast {
            self.cleave(k, t, dmg, tune, strikes);
        }
    }

    /// A breather's hunt (§5 "Drake breath"). The cycle, from rearing: the jet starts at 0.4 s and runs 1.2 s (a
    /// pulse every 0.25 s harms every foe in the cone by `breath/pulses`, ignoring armour, and costs each company
    /// caught `1.6·steadiness` morale; the cone reaches 2.3 from a root 1 tile ahead, half-angle 0.3, sweeping
    /// ±0.3 across the pulses); the bite comes at 2.3 s; the cycle is 3.2 s. The hunt: rear when the prey is within
    /// 2.4, hold ground while breathing, lunge at 1.6× pace 0.45 s before the bite, spring back to 2.1 still facing
    /// the prey; the next prey is the densest spot not taken by a pack-mate.
    fn hunt(&self, k: usize, tune: &Tune, r: &Rules) -> Decision {
        let (mv, c, bt) = (&tune.movement, &tune.combat, &tune.breath);
        let m = &self.soldiers[k];
        let si = m.squad as usize;
        let s = &self.squads[si];
        let here = m.pos();
        let hz = TICK_HZ as f64;
        let fighting = s.threat.is_some();
        let reach_only = !fighting || r.reach_only;
        let range = r.seek.max(bt.hunt_r);
        let running = m.cycle != Tick::MAX && ((self.tick - m.cycle) as f64) < bt.period * hz;
        let ended = m.cycle != Tick::MAX && !running;

        // The prey: kept through a cycle while he lives, and between cycles while within the hunt's reach; a cycle
        // that has just ended takes the next prey.
        let keep = |t: usize| {
            let lim = if running { f64::INFINITY } else { range * c.keep_target };
            self.may_target(k, t, tune, r, reach_only && !running, lim, false).is_some()
        };
        let mut prey = m.target.filter(|&t| !ended && keep(t));
        if prey.is_none() {
            prey = self.densest(k, tune, r, reach_only && !running, range);
        }
        let bulk_a = s.spec.radius - mv.base_radius;
        let (preyp, dprey, bulks) = match prey {
            Some(t) => {
                let o = &self.soldiers[t];
                let ob = self.squads[o.squad as usize].spec.radius - mv.base_radius;
                (Some(o.pos()), here.dist(o.pos()), bulk_a + ob)
            }
            None => (None, f64::INFINITY, bulk_a),
        };

        // The cycle: rear when the prey comes within 2.4.
        let mut cycle = if running { m.cycle } else { Tick::MAX };
        if cycle == Tick::MAX && dprey <= bt.hunt_r {
            cycle = self.tick;
        }
        let e = if cycle == Tick::MAX { -1.0 } else { (self.tick - cycle) as f64 };
        // The moment `secs` into the cycle falls in this tick.
        let at = |secs: f64| cycle != Tick::MAX && e - 1.0 < secs * hz && secs * hz <= e;
        let secs = e / hz;

        // Where he goes: his slot with no prey; toward the prey until it is within reach of the hunt; then ground
        // held while breathing, the lunge, and the spring back.
        let slot = self.slot(s, m.slot, s.alive as usize);
        let man_speed = s.speed(tune);
        let off = |p: P, dist: f64| {
            if dprey > 1e-9 { P::new(p.x + (here.x - p.x) / dprey * dist, p.y + (here.y - p.y) / dprey * dist) } else { here }
        };
        let (goal, speed) = match preyp {
            None => (slot, man_speed * catchup(mv, here.dist(slot))),
            Some(p) if cycle == Tick::MAX => (off(p, bt.spring), man_speed * catchup(mv, here.dist(slot))),
            Some(_) if secs < bt.bite - bt.lunge_before => (here, man_speed),
            Some(p) if secs <= bt.bite => (off(p, c.stand * c.reach + bulks), man_speed * bt.lunge),
            Some(p) => (off(p, bt.spring), man_speed * bt.lunge),
        };
        let face = preyp.map(|p| atan2(p.y - here.y, p.x - here.x));
        let (v, heading, route) = self.steer(k, goal, speed, face, tune);

        // The bite, at 2.3 s, if the prey is in reach.
        let gap = dprey - bulks;
        let in_contact = prey.is_some() && gap <= c.reach;
        let (mut strikes, mut blows) = (Vec::new(), Vec::new());
        let rank = 1.0 + tune.rank.damage * s.rank as f64;
        if let Some(t) = prey
            && in_contact
            && at(bt.bite)
        {
            let veteran = if s.way() == Some(Way::Veteran) { c.veteran_damage } else { 1.0 };
            self.blow(k, t, s.spec.damage * rank * veteran, false, tune, &mut strikes, &mut blows);
        }

        // The jet: the Breath event at its start, and its pulses sweeping the cone from one side to the other.
        let (mut burns, mut scorch) = (Vec::new(), Vec::new());
        let pulses = bt.pulses();
        for p in 0..pulses {
            if at(bt.rear + p as f64 * bt.pulse) {
                let sweep = if pulses > 1 { bt.sweep * (2.0 * p as f64 / (pulses - 1) as f64 - 1.0) } else { 0.0 };
                let root = here.offset(heading, bt.root, 0.0);
                self.burn(k, root, heading + sweep, s.spec.breath * rank / pulses as f64, tune, &mut burns, &mut scorch);
            }
        }
        let contact = if in_contact {
            let t = &self.soldiers[prey.expect("in contact")];
            let fi = t.squad as usize;
            let fc = self.centre(fi);
            let off = atan2(here.y - fc.y, here.x - fc.x);
            Some((fi, wrap(off - self.squads[fi].facing).abs() > tune.morale.flank_angle))
        } else {
            None
        };
        Decision {
            target: prey,
            cooldown: (m.cooldown - DT).max(-DT),
            charge_used: false,
            since_contact: if in_contact { 0.0 } else { m.since_contact + DT },
            engaged: in_contact || (cycle != Tick::MAX && prey.is_some()),
            v,
            heading,
            route,
            strikes,
            blows,
            burns,
            scorch,
            breath: at(bt.rear),
            cycle,
            arrow: None,
            contact,
            shot: prey.map(|t| self.soldiers[t].squad as usize),
        }
    }

    /// The densest spot a pack-mate has not taken (§5 "The hunt"): among the foes man `k` may take within `range`
    /// (only those in reach when `reach_only`), the one with the most foes within `spot_r` of him, preferring
    /// spots no pack-mate's prey stands within `spot_r` of; then the nearest, then the lowest index.
    fn densest(&self, k: usize, tune: &Tune, r: &Rules, reach_only: bool, range: f64) -> Option<usize> {
        let (mv, bt) = (&tune.movement, &tune.breath);
        let m = &self.soldiers[k];
        let s = &self.squads[m.squad as usize];
        let here = m.pos();
        let look = if reach_only { tune.combat.reach + s.spec.radius - mv.base_radius + self.max_radius - mv.base_radius } else { range };
        let mates = &self.scratch.prey[m.squad as usize];
        let mut best: Option<(bool, u32, f64, usize)> = None;
        self.grid.visit(here, look, |t| {
            if self.squads[self.soldiers[t].squad as usize].team == s.team {
                return;
            }
            let Some(d) = self.may_target(k, t, tune, r, reach_only, range, false) else { return };
            let at = self.soldiers[t].pos();
            let taken = mates.iter().any(|&(j, p)| j != k && p.dist(at) <= bt.spot_r);
            let mut dense = 0u32;
            self.grid.visit(at, bt.spot_r, |j| {
                let o = &self.soldiers[j];
                if self.squads[o.squad as usize].team != s.team && o.pos().dist(at) <= bt.spot_r {
                    dense += 1;
                }
            });
            let better = best.is_none_or(|(bt_, bn, bd, bi)| {
                (taken, std::cmp::Reverse(dense)).cmp(&(bt_, std::cmp::Reverse(bn))).then(d.total_cmp(&bd)).then(t.cmp(&bi)).is_lt()
            });
            if better {
                best = Some((taken, dense, d, t));
            }
        });
        best.map(|(_, _, _, t)| t)
    }

    /// One breath pulse: every foe in the cone from `root` along `axis` (reach 2.3 to his body's edge, half-angle
    /// 0.3) takes `dmg`; each company caught loses `1.6·steadiness` morale. No friendly fire.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn burn(&self, k: usize, root: P, axis: f64, dmg: f64, tune: &Tune, out: &mut Vec<Strike>, scorch: &mut Vec<(usize, f64)>) {
        let (mv, bt) = (&tune.movement, &tune.breath);
        let team = self.squads[self.soldiers[k].squad as usize].team;
        self.grid.visit(root, bt.reach + self.max_radius, |j| {
            let o = &self.soldiers[j];
            let os = &self.squads[o.squad as usize];
            if os.team == team || !os.on_field() {
                return;
            }
            let (dx, dy) = (o.x - root.x, o.y - root.y);
            let d = hyp(dx, dy);
            if d - (os.spec.radius - mv.base_radius) > bt.reach || (d > 1e-9 && wrap(atan2(dy, dx) - axis).abs() > bt.half_angle) {
                return;
            }
            out.push(Strike { attacker: k, victim: j, dmg, charge: false, breath: true });
            if !scorch.iter().any(|&(q, _)| q == o.squad as usize) {
                scorch.push((o.squad as usize, bt.morale * os.spec.steadiness));
            }
        });
    }

    /// §5 "Beasts": each blow also hits the 3 nearest other foes within 1.5 at 0.6 share.
    pub(super) fn cleave(&self, k: usize, victim: usize, dmg: f64, tune: &Tune, out: &mut Vec<Strike>) {
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
            out.push(Strike { attacker: k, victim: j, dmg: dmg * b.cleave_share, charge: false, breath: false });
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

/// A man more than 1 tile from his slot jogs at ×1.4, more than 0.5 at ×1.15 (§3c "Speed").
fn catchup(mv: &crate::tune::MoveTune, to_slot: f64) -> f64 {
    if to_slot > mv.catchup_far_at {
        mv.catchup_far
    } else if to_slot > mv.catchup_near_at {
        mv.catchup_near
    } else {
        1.0
    }
}
