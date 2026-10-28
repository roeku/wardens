//! Step 2, the squads: the army's heading and column/line (04-battle.md §3d), and each squad's anchor (§3b):
//! A* replanned every second, the cohesion gate, turning, arrival, following the captain at a fixed station,
//! fighting, routing home, recall and retreat.

use super::{Battle, DT, Formation, Order, SquadState};
use crate::contracts::{EventCode, Kind, P, Team};
use crate::map::path;
use crate::math::{atan2, turn, wrap};

/// How the anchor faces while it walks.
#[derive(Clone, Copy)]
pub(super) enum Facing {
    /// The way it steps, at the anchor's turn rate.
    Step,
    /// A fixed heading at a given rate (followers face the army's heading, never the way they step).
    Fixed(f64, f64),
}

impl Battle {
    /// Each squad's centroid, spread, slot centroid and looseness, once per tick.
    pub(super) fn measure(&mut self) {
        let n = self.squads.len();
        let sc = &mut self.scratch;
        sc.centre.resize(n, P::new(0.0, 0.0));
        sc.spread.resize(n, 0.0);
        sc.slot_centre.resize(n, P::new(0.0, 0.0));
        sc.loose.resize(n, 0.0);
        sc.attackers.resize(n, 0);
        sc.shot.resize(n, false);
        sc.flanked.resize(n, false);
        sc.defend.resize(n, None);
        for i in 0..n {
            let s = &self.squads[i];
            let alive = s.alive as usize;
            let (mut cx, mut cy, mut sx, mut sy, mut loose) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for &k in &s.soldiers {
                let m = &self.soldiers[k];
                if !m.alive {
                    continue;
                }
                let at = self.slot(s, m.slot, alive);
                cx += m.x;
                cy += m.y;
                sx += at.x;
                sy += at.y;
                loose += m.pos().dist(at);
            }
            let (centre, slots, loose) = if alive == 0 {
                (P::new(s.x, s.y), P::new(s.x, s.y), 0.0)
            } else {
                let a = alive as f64;
                (P::new(cx / a, cy / a), P::new(sx / a, sy / a), loose / a)
            };
            let spread = s.soldiers.iter().filter(|&&k| self.soldiers[k].alive).map(|&k| self.soldiers[k].pos().dist(centre)).fold(0.0, f64::max);
            let sc = &mut self.scratch;
            sc.centre[i] = centre;
            sc.slot_centre[i] = slots;
            sc.loose[i] = loose;
            sc.spread[i] = spread;
            sc.attackers[i] = 0;
            sc.shot[i] = false;
            sc.flanked[i] = false;
            sc.defend[i] = None;
        }
    }

    /// 04-battle.md §3d: re-aim the formation heading after the captain has moved 2.5 tiles (in line, never more
    /// than 120° off), ease it at 0.9 rad/s; line when a visible enemy is within 9 or after a 2 s halt, column
    /// after 1.5 s of marching with no enemy near.
    pub(super) fn update_armies(&mut self) {
        for team in 0..2u8 {
            let Some(c) = self.captain_of(team) else { continue };
            let at = self.soldiers[self.squads[c].soldiers[0]].pos();
            let a = self.tune.army.clone();
            let near = self.enemy_seen_within(team, at, a.line_enemy);
            let marching = self.squads[c].state == SquadState::Marching;
            let army = &mut self.armies[team as usize];
            if at.dist(army.aim_from) >= a.reaim_moved {
                let new = atan2(at.y - army.aim_from.y, at.x - army.aim_from.x);
                if !(army.formation == Formation::Line && wrap(new - army.aim).abs() > a.reaim_max) {
                    army.aim = new;
                }
                army.aim_from = at;
            }
            army.heading = turn(army.heading, army.aim, a.heading_ease * DT);
            army.halted = if marching { 0.0 } else { army.halted + DT };
            army.marched = if marching && !near { army.marched + DT } else { 0.0 };
            if near || army.halted >= a.line_halt_s {
                army.formation = Formation::Line;
            } else if army.marched >= a.column_after_s {
                army.formation = Formation::Column;
            }
        }
    }

    /// Whether `team` sees a living enemy man within `r` of `p`.
    pub(super) fn enemy_seen_within(&self, team: Team, p: P, r: f64) -> bool {
        let mut seen = false;
        self.grid.visit(p, r, |k| {
            let m = &self.soldiers[k];
            if !seen && self.squads[m.squad as usize].team != team && m.pos().dist(p) <= r && self.sees(team, m.pos()) {
                seen = true;
            }
        });
        seen
    }

    /// Where squad `i`'s station is now: the captain's position plus its fixed offset in the current
    /// formation, laid out on the army's heading.
    pub fn station_at(&self, i: usize) -> Option<P> {
        let s = &self.squads[i];
        let cap = self.captain_at(s.team)?;
        let army = &self.armies[s.team as usize];
        let (ahead, left) = if army.formation == Formation::Line { s.station } else { s.column };
        Some(cap.offset(army.heading, ahead, left))
    }

    /// The point a squad flees or retreats to: its team's retreat point.
    pub(super) fn home(&self, team: Team) -> P {
        self.map.retreat[team as usize & 1]
    }

    /// Step 2 for one squad.
    pub(super) fn update_squad(&mut self, i: usize) {
        if !self.squads[i].on_field() {
            return;
        }
        if self.squads[i].kind == Kind::Captain {
            self.sample_hp(i);
        }
        if self.squads[i].state == SquadState::Routing {
            self.flee(i);
            return;
        }
        if self.squads[i].threat.is_some() {
            self.fight_anchor(i);
            return;
        }
        if self.squads[i].state == SquadState::Fighting && !self.squads[i].spec.ranged() {
            // The fight is over: the block re-forms where its men stand, so nobody walks back to an old slot.
            let (men, slots) = (self.scratch.centre[i], self.scratch.slot_centre[i]);
            let s = &mut self.squads[i];
            s.x += men.x - slots.x;
            s.y += men.y - slots.y;
            if matches!(s.order, Order::Hold { .. }) {
                s.post = P::new(s.x, s.y);
            }
        }
        let mv = self.tune.movement.clone();
        let speed = self.squads[i].speed(&self.tune) * self.squads[i].how.pace.unwrap_or(1.0);
        if let Some(foe) = self.scratch.defend[i]
            && !matches!(self.squads[i].order, Order::Follow | Order::Guard { .. })
        {
            // Defending the captain: turn on the foe that came within 3 of him.
            let goal = self.centre(foe as usize);
            self.walk(i, goal, speed, true, Facing::Step);
            self.squads[i].state = SquadState::Marching;
            return;
        }
        match self.squads[i].order.clone() {
            Order::Hold { face } => {
                if let Some(f) = face {
                    let rate = self.turn_rate(i);
                    self.squads[i].facing = turn(self.squads[i].facing, f, rate * DT);
                }
                self.squads[i].state = SquadState::Idle;
            }
            Order::Move { to, face, .. } => {
                let speed = if self.squads[i].kind == Kind::Captain { self.captain_pace(i) } else { speed };
                if self.walk_order(i, to, mv.arrive_at, speed) {
                    if self.squads[i].kind == Kind::Captain
                        && let Some(f) = face
                    {
                        self.armies[self.squads[i].team as usize].aim = f;
                    }
                    self.arrive(i, face);
                }
            }
            Order::Take { site, .. } => {
                let at = self.map.sites[site as usize].at;
                let speed = if self.squads[i].kind == Kind::Captain { self.captain_pace(i) } else { speed };
                // It stands on the site until the site is ours (step 9), then holds there: the take is done.
                if self.walk_order(i, at, mv.arrive_at, speed) {
                    self.squads[i].state = SquadState::Idle;
                    if self.sites[site as usize].owner == Some(self.squads[i].team) {
                        let face = self.squads[i].facing;
                        self.arrive(i, Some(face));
                    }
                }
            }
            Order::Attack { target, .. } => {
                let t = target as usize;
                // Done when the target is gone, or routs and the stance does not pursue.
                let pursue = self.rules(i).pursue;
                if !self.squads.get(t).is_some_and(|t| t.on_field() && (pursue || t.state != SquadState::Routing)) {
                    self.arrive(i, None);
                    return;
                }
                let goal = self.centre(t);
                self.walk_order(i, goal, 0.0, speed);
            }
            Order::Follow => self.follow(i),
            Order::Guard { ward } => self.guard(i, ward as usize),
            Order::Recall { until } => {
                let Some(goal) = self.station_at(i) else {
                    self.arrive(i, None);
                    return;
                };
                let m = &self.tune.morale;
                let (done_r, pace) = (m.recall_done, m.recall_pace);
                let here = P::new(self.squads[i].x, self.squads[i].y);
                if here.dist(goal) <= done_r || self.tick >= until {
                    let s = &mut self.squads[i];
                    s.order = Order::Follow;
                    s.done = true;
                    s.following = true;
                    return;
                }
                self.walk(i, goal, speed * pace, true, Facing::Step);
                self.squads[i].state = SquadState::Marching;
            }
            Order::Retreat => {
                let home = self.home(self.squads[i].team);
                self.walk(i, home, speed, false, Facing::Step);
                self.squads[i].state = SquadState::Marching;
                if self.at_home(i) {
                    if self.flees(self.squads[i].team) {
                        self.leave_field(i);
                    } else {
                        self.arrive(i, None);
                    }
                }
            }
            Order::Ride => self.ride(i),
        }
    }

    /// The anchor of a move, attack or take: drop via points within 0.9, walk the A* path at `speed` (the
    /// cohesion gate applies except to the captain), and report arrival within `arrive` of the final goal.
    fn walk_order(&mut self, i: usize, to: P, arrive: f64, speed: f64) -> bool {
        let via_drop = self.tune.movement.via_drop;
        let here = P::new(self.squads[i].x, self.squads[i].y);
        if let Some(via) = self.squads[i].order.via_mut()
            && via.first().is_some_and(|v| v.dist(here) < via_drop)
        {
            via.remove(0);
        }
        let goal = self.squads[i].order.via().first().copied().unwrap_or(to);
        let final_leg = self.squads[i].order.via().is_empty();
        if final_leg && here.dist(goal) <= arrive {
            return true;
        }
        if self.held[self.squads[i].team as usize] && self.squads[i].kind != Kind::Captain {
            // 08-orders.md §8 hook: held before contact, nobody advances.
            self.squads[i].state = SquadState::Idle;
            return false;
        }
        let gate = self.squads[i].kind != Kind::Captain;
        self.walk(i, goal, speed, gate, Facing::Step);
        self.squads[i].state = SquadState::Marching;
        false
    }

    /// The order is done: hold where it stands, posted there.
    pub(super) fn arrive(&mut self, i: usize, face: Option<f64>) {
        let s = &mut self.squads[i];
        s.order = Order::Hold { face };
        s.state = SquadState::Idle;
        s.done = true;
        s.post = P::new(s.x, s.y);
        s.path.clear();
    }

    pub(super) fn turn_rate(&self, i: usize) -> f64 {
        let mv = &self.tune.movement;
        if self.squads[i].spec.beast { mv.anchor_turn * mv.beast_turn_share } else { mv.anchor_turn }
    }

    /// Moves the anchor one tick toward `goal` along its A* path (replanned every second, or when the goal moves
    /// more than 1.5): `step = speed · terrain · hill pace · gate · dt` (§3b).
    pub(super) fn walk(&mut self, i: usize, goal: P, speed: f64, gate: bool, facing: Facing) {
        let mv = self.tune.movement.clone();
        let goal = self.open_near(goal);
        let here = P::new(self.squads[i].x, self.squads[i].y);
        let replan_ticks = (mv.replan_s / DT).round() as u32;
        let s = &self.squads[i];
        if s.path.is_empty() || s.path_goal.dist(goal) > mv.replan_moved || self.tick >= s.replan_at {
            let way = path::route(&self.map, here, goal).unwrap_or_else(|| vec![goal]);
            let s = &mut self.squads[i];
            s.path = way;
            s.path_goal = goal;
            s.replan_at = self.tick + replan_ticks.max(1);
        } else if s.path.len() == 1 {
            // The final leg tracks a moving goal (a station, a target) between replans.
            self.squads[i].path[0] = goal;
        }
        let Some(&next) = self.squads[i].path.first() else { return };
        let loose = self.looseness(i);
        let g = if !gate || loose <= mv.loose_slow {
            1.0
        } else if loose <= mv.loose_stop {
            mv.loose_pace
        } else {
            0.0
        };
        let d = here.dist(next);
        let dir = if d > 0.0 { P::new((next.x - here.x) / d, (next.y - here.y) / d) } else { P::new(0.0, 0.0) };
        let step = speed * self.ground_pace(here, dir) * g * DT;
        let rate = self.turn_rate(i);
        let s = &mut self.squads[i];
        match facing {
            Facing::Step if d > 1e-6 => s.facing = turn(s.facing, atan2(dir.y, dir.x), rate * DT),
            Facing::Fixed(h, r) => s.facing = turn(s.facing, h, r * DT),
            _ => {}
        }
        if d <= step {
            s.x = next.x;
            s.y = next.y;
            s.path.remove(0);
        } else {
            s.x += dir.x * step;
            s.y += dir.y * step;
        }
    }

    /// §5 "When engaged": face the enemy at 2.5 rad/s; a melee block follows its brawl. The anchor drifts by the
    /// offset between the men and their slots at `dt·2`, so the block follows without creeping backward. A
    /// defensive stance keeps it within the leash of its post.
    fn fight_anchor(&mut self, i: usize) {
        let c = self.tune.combat.clone();
        let t = self.squads[i].threat.expect("engaged") as usize;
        let foe = self.centre(t);
        let here = self.centre(i);
        let face = atan2(foe.y - here.y, foe.x - here.x);
        let drift = (DT * c.drift_rate).min(1.0);
        let (men, slots) = (self.scratch.centre[i], self.scratch.slot_centre[i]);
        let leash = self.rules(i).leash;
        let s = &mut self.squads[i];
        s.facing = turn(s.facing, face, c.face_rate * DT);
        s.state = SquadState::Fighting;
        s.path.clear();
        if !s.spec.ranged() {
            let (mut nx, mut ny) = (s.x + (men.x - slots.x) * drift, s.y + (men.y - slots.y) * drift);
            if let Some((post, r)) = leash {
                let d = P::new(nx, ny).dist(post);
                if d > r {
                    nx = post.x + (nx - post.x) * r / d;
                    ny = post.y + (ny - post.y) * r / d;
                }
            }
            s.x = nx;
            s.y = ny;
        }
    }

    /// §3d followers: march to the station when more than 1 tile off, stop within 0.3, at
    /// `min(top, 0.4 + 0.9·d)` (halved when loose), facing the army's heading at 2 rad/s. A follower turns on an
    /// enemy within 3 of its captain (step 2's engagement marks it).
    fn follow(&mut self, i: usize) {
        let a = self.tune.army.clone();
        if let Some(foe) = self.scratch.defend[i] {
            let goal = self.centre(foe as usize);
            let speed = self.squads[i].speed(&self.tune);
            self.walk(i, goal, speed, true, Facing::Step);
            self.squads[i].state = SquadState::Marching;
            return;
        }
        let Some(goal) = self.station_at(i) else {
            self.arrive(i, None);
            return;
        };
        let team = self.squads[i].team as usize;
        let (heading, column) = (self.armies[team].heading, self.armies[team].formation == Formation::Column);
        let here = P::new(self.squads[i].x, self.squads[i].y);
        let d = here.dist(goal);
        let s = &mut self.squads[i];
        if !s.following && d > a.march_above {
            s.following = true;
        } else if s.following && d < a.idle_below {
            s.following = false;
        }
        if !s.following {
            s.state = SquadState::Idle;
            s.facing = turn(s.facing, heading, a.follower_turn * DT);
            s.path.clear();
            return;
        }
        let top = s.spec.speed
            * (1.0 + self.tune.rank.speed * s.rank as f64)
            * if d > a.follow_far { a.follow_far_pace } else { 1.0 }
            * if column { a.column_pace } else { 1.0 };
        let mut speed = top.min(a.follow_base + a.follow_k * d);
        if self.looseness(i) > a.follow_loose {
            speed *= a.follow_loose_pace;
        }
        speed *= self.squads[i].how.pace.unwrap_or(1.0);
        self.walk(i, goal, speed, true, Facing::Fixed(heading, a.follower_turn));
        self.squads[i].state = SquadState::Marching;
    }

    /// Escort (08-orders.md §3): keep `guard_behind` behind the ward, facing its way; step 2's engagement turns
    /// the escort on anything within `guard_r` of the ward.
    fn guard(&mut self, i: usize, ward: usize) {
        if !self.squads.get(ward).is_some_and(|w| w.on_field()) {
            self.arrive(i, None);
            return;
        }
        if let Some(foe) = self.scratch.defend[i] {
            let goal = self.centre(foe as usize);
            let speed = self.squads[i].speed(&self.tune);
            self.walk(i, goal, speed, true, Facing::Step);
            self.squads[i].state = SquadState::Marching;
            return;
        }
        let a = self.tune.army.clone();
        let w = &self.squads[ward];
        let goal = self.centre(ward).offset(w.facing, -a.guard_behind, 0.0);
        let heading = w.facing;
        let here = P::new(self.squads[i].x, self.squads[i].y);
        let d = here.dist(goal);
        let s = &mut self.squads[i];
        if !s.following && d > a.march_above {
            s.following = true;
        } else if s.following && d < a.idle_below {
            s.following = false;
        }
        if !s.following {
            s.state = SquadState::Idle;
            s.facing = turn(s.facing, heading, a.follower_turn * DT);
            return;
        }
        let speed = (s.speed(&self.tune) * a.follow_far_pace).min(a.follow_base + a.follow_k * d);
        self.walk(i, goal, speed, true, Facing::Fixed(heading, a.follower_turn));
        self.squads[i].state = SquadState::Marching;
    }

    /// §3d "The captain's pace": `min(follower speeds)·0.9·(1.3 in column)`, ×0.6 when the mean station error
    /// exceeds 5, ×0.8 when it exceeds 3. Alone, his own speed.
    fn captain_pace(&self, c: usize) -> f64 {
        let a = &self.tune.army;
        let team = self.squads[c].team;
        let followers: Vec<usize> =
            (0..self.squads.len()).filter(|&j| self.squads[j].team == team && self.squads[j].standing() && self.squads[j].order == Order::Follow).collect();
        let own = self.squads[c].speed(&self.tune);
        if followers.is_empty() {
            return own;
        }
        let slowest = followers.iter().map(|&j| self.squads[j].speed(&self.tune)).fold(f64::INFINITY, f64::min);
        let column = self.armies[team as usize].formation == Formation::Column;
        let err = followers.iter().map(|&j| self.station_at(j).map_or(0.0, |p| p.dist(P::new(self.squads[j].x, self.squads[j].y)))).sum::<f64>()
            / followers.len() as f64;
        let k = if err > a.error_far {
            a.error_far_pace
        } else if err > a.error_near {
            a.error_near_pace
        } else {
            1.0
        };
        (slowest * a.captain_pace * if column { a.column_pace } else { 1.0 } * k).min(own)
    }

    /// §5 "Routing": run home at ×1.25, skipping the cohesion gate. At home an attacker's company leaves the map;
    /// a defender's makes a last stand at morale 30.
    fn flee(&mut self, i: usize) {
        let home = self.home(self.squads[i].team);
        let speed = self.squads[i].speed(&self.tune) * self.tune.morale.rout_speed;
        self.walk(i, home, speed, false, Facing::Step);
        if self.at_home(i) {
            if self.flees(self.squads[i].team) {
                self.leave_field(i);
            } else {
                let stand = self.tune.morale.last_stand;
                let s = &mut self.squads[i];
                s.state = SquadState::Idle;
                s.morale = stand;
                s.last_stand = true;
                s.order = super::Order::Hold { face: None };
                s.post = P::new(s.x, s.y);
                let at = P::new(s.x, s.y);
                let id = s.id as u32;
                self.event(EventCode::Rally, at, id, 1);
            }
        }
    }

    fn at_home(&self, i: usize) -> bool {
        let s = &self.squads[i];
        let here = P::new(s.x, s.y);
        let r = self.tune.morale.home_r;
        let home = self.home(s.team);
        let edge = if home.x < self.map.wf() / 2.0 { here.x <= r } else { here.x >= self.map.wf() - r };
        here.dist(home) <= r || (self.flees(s.team) && edge)
    }

    /// The company leaves the map: its men are gone (not alive, `died_at` never set).
    pub(super) fn leave_field(&mut self, i: usize) {
        let s = &mut self.squads[i];
        s.state = SquadState::Fled;
        s.threat = None;
        let men = s.soldiers.clone();
        let at = P::new(s.x, s.y);
        let id = s.id as u32;
        for k in men {
            let m = &mut self.soldiers[k];
            m.alive = false;
            m.target = None;
        }
        self.squads[i].alive = 0;
        self.squads[i].leader = None;
        self.event(EventCode::BannerFall, at, id, 0);
    }

    /// Samples the captain's hp every half second for "lost 20% within 2 s" (§5 "The captain's ride").
    fn sample_hp(&mut self, c: usize) {
        if !self.tick.is_multiple_of(15) {
            return;
        }
        let hp = self.soldiers[self.squads[c].soldiers[0]].hp;
        let ring = &mut self.squads[c].hp_ring;
        ring.rotate_left(1);
        ring[3] = hp;
    }
}
