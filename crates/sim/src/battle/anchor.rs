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
        sc.scorch.resize(n, 0.0);
        sc.prey.resize(n, Vec::new());
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
            sc.scorch[i] = 0.0;
            sc.prey[i].clear();
        }
        // The spots each pack's breathers have taken, from the tick's start (so no man reads another's choice).
        for k in 0..self.soldiers.len() {
            let m = &self.soldiers[k];
            if let Some(t) = m.target
                && m.alive
                && self.squads[m.squad as usize].spec.breath > 0.0
            {
                let at = self.soldiers[t].pos();
                self.scratch.prey[m.squad as usize].push((k, at));
            }
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
            // Double time marches in column at once (08-orders.md §5 "pace").
            let double = self.squads[c].how.pace == Some(super::Pace::Double);
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
            } else if army.marched >= a.column_after_s || (double && marching) {
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
        let (ahead, left) = match (army.formation, s.reserve) {
            (Formation::Line, Some(r)) => r,
            (Formation::Line, None) => s.station,
            (Formation::Column, _) => s.column,
        };
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
        let speed = self.squads[i].speed(&self.tune) * self.pace_k(i);
        if !matches!(self.squads[i].order, Order::Hold { .. }) {
            // Out of a fight and not holding, the post a defensive stance keeps to travels with the company.
            let s = &mut self.squads[i];
            s.post = P::new(s.x, s.y);
        }
        if let Some(foe) = self.scratch.defend[i]
            && !matches!(self.squads[i].order, Order::Follow | Order::Guard { .. } | Order::Screen { .. })
        {
            // Defending the captain: turn on the foe that came within 3 of him (a defensive stance on its leash).
            let goal = self.leashed(i, self.centre(foe as usize));
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
            Order::Screen { ward, from } => self.screen(i, ward as usize, from),
            Order::Charge { target } => {
                let t = target as usize;
                let pursue = self.rules(i).pursue;
                if !self.squads.get(t).is_some_and(|t| t.on_field() && (pursue || t.state != SquadState::Routing)) {
                    self.arrive(i, None);
                    return;
                }
                // Reckless: straight at the foe, the cohesion gate ignored (08-orders.md §3 "charge").
                let goal = self.centre(t);
                self.walk(i, goal, speed, false, Facing::Step);
                self.squads[i].state = SquadState::Marching;
            }
            Order::Withdraw { to } => self.withdraw(i, to, speed),
            Order::Regroup { to } => {
                if self.walk_order(i, to, mv.arrive_at, speed) {
                    let s = &self.squads[i];
                    let face = self.nearest_foe(i, self.tune.orders.screen_r).map(|f| atan2(f.y - s.y, f.x - s.x));
                    self.arrive(i, face);
                }
            }
            Order::Build { work, at } => self.build_step(i, work, at, speed),
        }
    }

    /// `goal` kept within a defensive stance's leash of its post.
    fn leashed(&self, i: usize, goal: P) -> P {
        match self.rules(i).leash {
            Some((post, r)) if goal.dist(post) > r => {
                let d = goal.dist(post);
                P::new(post.x + (goal.x - post.x) * r / d, post.y + (goal.y - post.y) * r / d)
            }
            _ => goal,
        }
    }

    /// Withdraw (08-orders.md §3): step back to `to` at `withdraw_pace`, the block still facing the nearest foe;
    /// its men strike in passing. A company with the army falls in again when there.
    fn withdraw(&mut self, i: usize, to: P, speed: f64) {
        let o = self.tune.orders.clone();
        let here = P::new(self.squads[i].x, self.squads[i].y);
        let c = self.centre(i);
        let face = self.nearest_foe(i, o.screen_r).map_or(self.squads[i].facing, |f| atan2(f.y - c.y, f.x - c.x));
        if here.dist(to) <= self.tune.movement.arrive_at {
            if self.squads[i].detached || self.squads[i].kind == Kind::Captain {
                self.arrive(i, Some(face));
            } else {
                let s = &mut self.squads[i];
                s.order = Order::Follow;
                s.done = true;
                s.following = true;
            }
            return;
        }
        let gate = self.squads[i].kind != Kind::Captain;
        self.walk(i, to, speed * o.withdraw_pace, gate, Facing::Fixed(face, self.tune.combat.face_rate));
        self.squads[i].state = SquadState::Marching;
    }

    /// Screen (08-orders.md §3 "screen / cover"): stand `screen_d` from the ward toward `from` (or the nearest foe
    /// to the ward, or the threat point), facing it; turn on anything that comes within `guard_r` of the ward.
    fn screen(&mut self, i: usize, ward: usize, from: Option<crate::contracts::SquadId>) {
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
        let o = self.tune.orders.clone();
        let wc = self.centre(ward);
        let team = self.squads[i].team;
        let threat = from
            .filter(|&f| self.squads.get(f as usize).is_some_and(|s| s.on_field()))
            .map(|f| self.centre(f as usize))
            .or_else(|| self.nearest_foe(ward, o.screen_r))
            .unwrap_or_else(|| self.threat_point(team, wc));
        let d = wc.dist(threat);
        let dir = if d > 1e-9 { P::new((threat.x - wc.x) / d, (threat.y - wc.y) / d) } else { P::from_angle(self.squads[ward].facing) };
        let goal = P::new(wc.x + dir.x * o.screen_d, wc.y + dir.y * o.screen_d);
        self.keep_by(i, goal, atan2(dir.y, dir.x));
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
    /// A held start (08-orders.md §8): no anchor goes further than `held_depth` from its deploy point toward the
    /// enemy's until "advance".
    pub(super) fn held_clamp(&self, team: Team, goal: P) -> P {
        if !self.held[team as usize & 1] {
            return goal;
        }
        let (own, foe) = (self.map.deploy[team as usize & 1], self.map.deploy[1 - (team as usize & 1)]);
        let d = own.dist(foe);
        if d < 1e-9 {
            return goal;
        }
        let a = P::new((foe.x - own.x) / d, (foe.y - own.y) / d);
        let ahead = (goal.x - own.x) * a.x + (goal.y - own.y) * a.y;
        let over = ahead - self.tune.orders.held_depth;
        if over > 0.0 { P::new(goal.x - a.x * over, goal.y - a.y * over) } else { goal }
    }

    pub(super) fn walk(&mut self, i: usize, goal: P, speed: f64, gate: bool, facing: Facing) {
        let mv = self.tune.movement.clone();
        // The ford's civilians are nobody's to hold back (places.rs).
        let goal = if self.civilian(i) { self.open_near(goal) } else { self.open_near(self.held_clamp(self.squads[i].team, goal)) };
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
    /// offset between the men and their slots at `dt·2`, so the block follows without creeping backward. Meeting a
    /// drake, the block presses forward instead: the anchor walks at the company's pace (the cohesion gate holding
    /// it together) until its front rank stands in reach of the nearest drake. A defensive stance keeps it within
    /// the leash of its post.
    fn fight_anchor(&mut self, i: usize) {
        if self.skirmish_back(i) {
            return;
        }
        let c = self.tune.combat.clone();
        let t = self.squads[i].threat.expect("engaged") as usize;
        let foe = self.centre(t);
        let here = self.centre(i);
        let face = atan2(foe.y - here.y, foe.x - here.x);
        let drift = (DT * c.drift_rate).min(1.0);
        let (men, slots) = (self.scratch.centre[i], self.scratch.slot_centre[i]);
        let leash = self.rules(i).leash;
        let press = (self.squads[t].spec.breath > 0.0).then(|| self.press_step(i, t)).flatten();
        self.tally.presses += press.is_some() as u64;
        let s = &mut self.squads[i];
        s.facing = turn(s.facing, face, c.face_rate * DT);
        s.state = SquadState::Fighting;
        s.path.clear();
        if !s.spec.ranged() {
            let (mut nx, mut ny) = match press {
                Some(p) => (p.x, p.y),
                None => (s.x + (men.x - slots.x) * drift, s.y + (men.y - slots.y) * drift),
            };
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

    /// Skirmish (08-orders.md §5): a ranged company with a melee foe man within `skirmish_r` of any of its men
    /// falls back, still facing him, to `skirmish_r + 1` from him; its men keep shooting. True when it stepped.
    fn skirmish_back(&mut self, i: usize) -> bool {
        let Some(sk) = self.rules(i).skirmish else { return false };
        let s = &self.squads[i];
        if !s.spec.ranged() {
            return false;
        }
        let team = s.team;
        let mut near: Option<(f64, P, P)> = None;
        for &k in &s.soldiers {
            let m = &self.soldiers[k];
            if !m.alive {
                continue;
            }
            self.grid.visit(m.pos(), sk, |j| {
                let o = &self.soldiers[j];
                let os = &self.squads[o.squad as usize];
                let d = m.pos().dist(o.pos());
                if os.team != team && !os.spec.ranged() && os.standing() && d <= sk && near.is_none_or(|(b, _, _)| d < b) {
                    near = Some((d, m.pos(), o.pos()));
                }
            });
        }
        let Some((d, ours, foe)) = near else { return false };
        let c = self.centre(i);
        let dc = c.dist(foe).max(1e-9);
        let away = P::new((c.x - foe.x) / dc, (c.y - foe.y) / dc);
        let back = sk - d + 1.0;
        let here = P::new(self.squads[i].x, self.squads[i].y);
        let goal = P::new(here.x + away.x * back, here.y + away.y * back);
        let face = atan2(foe.y - ours.y, foe.x - ours.x);
        let speed = self.squads[i].speed(&self.tune);
        self.walk(i, goal, speed, false, Facing::Fixed(face, self.tune.combat.face_rate));
        self.squads[i].state = SquadState::Fighting;
        true
    }

    /// Meeting a drake (§5): the anchor's next point, one step toward the drake nearest it until the front rank
    /// stands at the men's stand-off (`0.92·reach` from body to body), at the company's pace through the cohesion
    /// gate; `None` once there.
    fn press_step(&self, i: usize, t: usize) -> Option<P> {
        let (mv, c) = (&self.tune.movement, &self.tune.combat);
        let s = &self.squads[i];
        let here = P::new(s.x, s.y);
        let mut near: Option<(f64, usize)> = None;
        for &k in &self.squads[t].soldiers {
            let m = &self.soldiers[k];
            let d = m.pos().dist(here);
            if m.alive && near.is_none_or(|(b, bk)| d < b || (d == b && k < bk)) {
                near = Some((d, k));
            }
        }
        let (d, k) = near?;
        let stand = c.stand * c.reach + s.spec.radius + self.squads[t].spec.radius - 2.0 * mv.base_radius;
        if d <= stand + 1e-9 {
            return None;
        }
        let to = self.soldiers[k].pos();
        let dir = P::new((to.x - here.x) / d, (to.y - here.y) / d);
        let loose = self.looseness(i);
        let gate = if loose <= mv.loose_slow {
            1.0
        } else if loose <= mv.loose_stop {
            mv.loose_pace
        } else {
            0.0
        };
        let step = (s.speed(&self.tune) * s.how.pace_k(&self.tune) * self.ground_pace(here, dir) * gate * DT).min(d - stand);
        let next = P::new(here.x + dir.x * step, here.y + dir.y * step);
        self.walkable(next).then_some(next)
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
        speed *= self.pace_k(i);
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
        let w = &self.squads[ward];
        let goal = self.centre(ward).offset(w.facing, -self.tune.army.guard_behind, 0.0);
        let heading = w.facing;
        self.keep_by(i, goal, heading);
    }

    /// Keeps station at a moving `goal` (an escort's or a screen's) with the followers' hysteresis and speed law,
    /// facing `heading`.
    fn keep_by(&mut self, i: usize, goal: P, heading: f64) {
        let a = self.tune.army.clone();
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
        let speed = (s.speed(&self.tune) * a.follow_far_pace * s.how.pace_k(&self.tune)).min(a.follow_base + a.follow_k * d);
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
        let own = self.squads[c].speed(&self.tune) * self.pace_k(c);
        if followers.is_empty() {
            return own;
        }
        let slowest = followers.iter().map(|&j| self.squads[j].speed(&self.tune) * self.pace_k(j)).fold(f64::INFINITY, f64::min);
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
