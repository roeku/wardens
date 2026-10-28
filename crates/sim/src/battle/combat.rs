//! Engagement (step 2), blows landing together (step 4), arrows (step 6), trampling (step 7) and the cull
//! (step 8): 04-battle.md §5.

use super::{Battle, DT, Order, SquadState, Strike};
use crate::contracts::{EventCode, Kind, P, SquadId, Tick, Way};

impl Battle {
    /// Each squad's threat: the nearest foe to any of its men within its engagement distance (melee 2.6, +1.5
    /// reckless; ranged its range plus the height bonus), on a clear walking line beyond 1 tile for melee and in
    /// sight for ranged. A priority shifts which foe squad it takes. Followers of the captain turn on a foe within
    /// 3 of him; an escort on a foe near its ward (§3d, 08-orders.md §3).
    pub(super) fn engage_all(&mut self) {
        let n = self.squads.len();
        let tune = self.tune.clone();
        let c = &tune.combat;
        let mut threats: Vec<Option<SquadId>> = vec![None; n];
        let mut defend: Vec<Option<SquadId>> = vec![None; n];
        for i in 0..n {
            let s = &self.squads[i];
            if !s.standing() || s.alive == 0 {
                continue;
            }
            let r = self.rules(i);
            let ward = self.ward_point(i);
            if let Some((p, radius)) = ward {
                defend[i] = self.nearest_foe_squad(s.team, p, radius);
            }
            let engage = if defend[i].is_some() { r.engage.max(c.melee) } else { r.engage };
            if engage <= 0.0 {
                continue;
            }
            let ranged = s.spec.ranged();
            let ci = self.centre(i);
            let mut best: Option<(f64, usize)> = None;
            for j in 0..n {
                let o = &self.squads[j];
                if o.team == s.team || !o.on_field() || o.alive == 0 || (o.state == SquadState::Routing && !r.pursue) {
                    continue;
                }
                let gap = ci.dist(self.centre(j)) - self.spread(i) - self.spread(j);
                if gap > engage + c.range_height_cap {
                    continue;
                }
                let Some(d) = self.closest_pair(i, j, engage, ranged) else { continue };
                let adj = if s.how.priority == super::Priority::Nearest {
                    0.0
                } else {
                    self.priority_score(s.team, ci, j, s.how.priority) - ci.dist(self.centre(j))
                };
                let score = d + adj;
                if best.is_none_or(|(b, bj)| score < b || (score == b && j < bj)) {
                    best = Some((score, j));
                }
            }
            threats[i] = best.map(|(_, j)| j as SquadId);
        }
        for i in 0..n {
            self.squads[i].threat = threats[i];
            self.scratch.defend[i] = if threats[i].is_none() { defend[i] } else { None };
        }
    }

    /// Where squad `i` stands guard, and how near a foe must come: a line company within 7 of its captain guards
    /// him within 3, whatever its order (§3d "Defending the captain"), unless it is walking out of the field or
    /// back to him; an escort guards its ward.
    fn ward_point(&self, i: usize) -> Option<(P, f64)> {
        let s = &self.squads[i];
        let a = &self.tune.army;
        match s.order {
            Order::Retreat | Order::Recall { .. } => None,
            Order::Guard { ward } => {
                let w = self.squads.get(ward as usize).filter(|w| w.on_field())?;
                Some((self.centre(w.id as usize), a.guard_r))
            }
            _ if !s.spec.ranged() && s.kind != Kind::Horse && s.kind != Kind::Captain && !s.freed => {
                let cap = self.captain_at(s.team)?;
                (cap.dist(self.centre(i)) <= a.defend_within).then_some((cap, a.defend_enemy))
            }
            _ => None,
        }
    }

    /// The squad of the living foe man nearest `p` within `r`.
    fn nearest_foe_squad(&self, team: u8, p: P, r: f64) -> Option<SquadId> {
        let mut best: Option<(f64, usize)> = None;
        self.grid.visit(p, r, |k| {
            let m = &self.soldiers[k];
            let d = m.pos().dist(p);
            if self.squads[m.squad as usize].team != team && d <= r && best.is_none_or(|(b, bk)| d < b || (d == b && k < bk)) {
                best = Some((d, k));
            }
        });
        best.map(|(_, k)| self.soldiers[k].squad)
    }

    /// The smallest distance between a man of `i` and a man of `j` within `engage` (ranged: plus the height
    /// bonus, and only foes in sight), if its line is walkable for melee beyond 1 tile.
    fn closest_pair(&self, i: usize, j: usize, engage: f64, ranged: bool) -> Option<f64> {
        let c = &self.tune.combat;
        let team = self.squads[i].team;
        let mut best: Option<(f64, P, P)> = None;
        for &a in &self.squads[i].soldiers {
            let ma = &self.soldiers[a];
            if !ma.alive {
                continue;
            }
            for &b in &self.squads[j].soldiers {
                let mb = &self.soldiers[b];
                if !mb.alive {
                    continue;
                }
                let d = ma.pos().dist(mb.pos());
                if d > engage + c.range_height_cap || best.is_some_and(|(bd, _, _)| d >= bd) {
                    continue;
                }
                if ranged {
                    if d > engage + self.height_bonus(ma.pos(), mb.pos(), &self.tune) || !self.sees(team, mb.pos()) {
                        continue;
                    }
                } else if d > engage {
                    continue;
                }
                best = Some((d, ma.pos(), mb.pos()));
            }
        }
        let (d, a, b) = best?;
        if !ranged && d > c.walk_line_beyond && !self.line_walkable(a, b) {
            return None;
        }
        Some(d)
    }

    /// Blows whose `impact` is due fall now, after this tick's movement, if the victim is still within reach (plus
    /// `impact_slack`) of a living attacker; a beast's cleave is reckoned where the blow falls.
    fn land_blows(&mut self) {
        if self.blows.is_empty() {
            return;
        }
        let tick = self.tick;
        let (due, later): (Vec<_>, Vec<_>) = std::mem::take(&mut self.blows).into_iter().partition(|w| w.lands <= tick);
        self.blows = later;
        let tune = self.tune.clone();
        let mut strikes: Vec<Strike> = Vec::new();
        for w in due {
            let (a, v) = (&self.soldiers[w.attacker], &self.soldiers[w.victim]);
            if !a.alive || !v.alive {
                self.tally.missed += 1;
                continue;
            }
            let (sa, sv) = (&self.squads[a.squad as usize], &self.squads[v.squad as usize]);
            let gap = a.pos().dist(v.pos()) - (sa.spec.radius + sv.spec.radius - 2.0 * tune.movement.base_radius);
            if gap > tune.combat.reach + tune.combat.impact_slack {
                self.tally.missed += 1;
                continue;
            }
            self.tally.landed += 1;
            strikes.push(Strike { attacker: w.attacker, victim: w.victim, dmg: w.dmg, charge: w.charge, breath: false });
            if sa.spec.beast {
                self.cleave(w.attacker, w.victim, w.dmg, &tune, &mut strikes);
            }
        }
        self.strikes.extend(strikes);
    }

    /// Step 4: every collected blow lands, with the impact blows now due. Charges multiply by `charge·chargeTaken`
    /// (×1.3 reckless, ×0.7 against a veteran) and cost the victim's company 3 morale; then vsHorse, bane, height
    /// and routing victims. Breath is flat, ignoring armour; each company it caught loses its scorch.
    pub(super) fn resolve(&mut self) {
        self.land_blows();
        for i in 0..self.squads.len() {
            let loss = self.scratch.scorch.get(i).copied().unwrap_or(0.0);
            if loss > 0.0 && self.squads[i].on_field() {
                self.squads[i].morale -= loss;
            }
        }
        let strikes = std::mem::take(&mut self.strikes);
        let c = self.tune.combat.clone();
        let gap = (self.tune.combat.event_gap_s / DT) as Tick;
        let mut dead: Vec<(usize, usize)> = Vec::new();
        for st in &strikes {
            let (a, v) = (st.attacker, st.victim);
            if !self.soldiers[v].alive {
                continue;
            }
            let (asq, vsq) = (self.soldiers[a].squad as usize, self.soldiers[v].squad as usize);
            let (att, vic) = (&self.squads[asq], &self.squads[vsq]);
            let mut mult = 1.0;
            if st.breath {
                let m = &mut self.soldiers[v];
                let was = m.hp;
                m.hp -= st.dmg;
                m.hit_at = self.tick;
                let (at, now) = (m.pos(), m.hp);
                self.event(EventCode::Hit, at, v as u32, Kind::Beast as u32);
                self.tally.burns += 1;
                self.tally.burn_harm += st.dmg;
                if was > 0.0 && now <= 0.0 {
                    self.tally.burn_kills += 1;
                    dead.push((v, a));
                }
                continue;
            }
            // 08-orders.md §7 hook: charging into stakes takes chargeTaken ×0.4 and loses the charge bonus.
            let charge = st.charge && self.work_stakes(self.soldiers[v].pos()).is_none();
            if charge {
                mult *= att.spec.charge * vic.spec.charge_taken;
                if att.way() == Some(Way::Reckless) {
                    mult *= c.reckless_charge;
                }
                if vic.way() == Some(Way::Veteran) {
                    mult *= c.veteran_charge_taken;
                }
            }
            if vic.kind == Kind::Horse && !vic.spec.beast {
                mult *= att.spec.vs_horse;
            }
            if vic.spec.beast {
                mult *= att.spec.bane;
            }
            let dh = self.height(self.soldiers[a].pos()) - self.height(self.soldiers[v].pos());
            mult *= 1.0 + (dh * c.height_k).clamp(-c.height_cap, c.height_cap);
            if vic.state == SquadState::Routing {
                mult *= c.routing_victim;
            }
            let kind = att.kind as u32;
            let was = self.soldiers[v].hp;
            let m = &mut self.soldiers[v];
            m.hp -= st.dmg * mult;
            m.hit_at = self.tick;
            m.since_contact = 0.0;
            let (at, now) = (m.pos(), m.hp);
            self.event(EventCode::Hit, at, v as u32, kind | (st.charge as u32) << 8);
            if st.charge {
                self.squads[vsq].morale -= c.charge_morale;
                let last = self.squads[asq].charge_event;
                if last == Tick::MAX || self.tick >= last.saturating_add(gap) {
                    self.squads[asq].charge_event = self.tick;
                    let at = self.centre(asq);
                    self.event(EventCode::Charge, at, asq as u32, 0);
                }
            }
            if was > 0.0 && now <= 0.0 {
                dead.push((v, a));
            }
        }
        for (v, a) in dead {
            self.kill(v, Some(a));
        }
    }

    /// Step 6: arrows home on their targets and land after their flight time:
    /// `dmg·(arrowTaken + (1−arrowTaken)·pierce)·(bane vs beasts)`. An arrow whose target fell is lost.
    pub(super) fn update_arrows(&mut self) {
        let arrows = std::mem::take(&mut self.arrows);
        let mut keep = Vec::with_capacity(arrows.len());
        for mut a in arrows {
            let t = &self.soldiers[a.target];
            if !t.alive {
                continue;
            }
            a.t += DT;
            let k = (a.t / a.flight).min(1.0);
            a.x = a.from.x + (t.x - a.from.x) * k;
            a.y = a.from.y + (t.y - a.from.y) * k;
            if a.t < a.flight {
                keep.push(a);
                continue;
            }
            let shooter = &self.squads[self.soldiers[a.shooter].squad as usize];
            let vic = &self.squads[t.squad as usize];
            let taken = vic.spec.arrow_taken + (1.0 - vic.spec.arrow_taken) * shooter.spec.pierce;
            let dmg = a.dmg * taken * if vic.spec.beast { shooter.spec.bane } else { 1.0 } * self.work_cover(a.from, t.pos());
            let kind = shooter.kind as u32;
            let m = &mut self.soldiers[a.target];
            let was = m.hp;
            m.hp -= dmg;
            m.hit_at = self.tick;
            let (at, now) = (m.pos(), m.hp);
            self.event(EventCode::Hit, at, a.target as u32, kind);
            if was > 0.0 && now <= 0.0 {
                self.kill(a.target, Some(a.shooter));
            }
        }
        self.arrows.extend(keep);
    }

    /// Stakes in front of `p` (08-orders.md §7 hook): their chargeTaken share, if any. None are built yet.
    fn work_stakes(&self, _p: P) -> Option<f64> {
        None
    }

    /// Cover from field works against an arrow from `from` to `to` (08-orders.md §7 hook): none yet.
    fn work_cover(&self, _from: P, _to: P) -> f64 {
        1.0
    }

    /// A man falls: he stays where he fell (§9), and his killer's company counts the kill.
    pub(super) fn kill(&mut self, v: usize, by: Option<usize>) {
        let m = &mut self.soldiers[v];
        if !m.alive {
            return;
        }
        m.alive = false;
        m.died_at = self.tick;
        m.target = None;
        m.vx = 0.0;
        m.vy = 0.0;
        let at = m.pos();
        self.event(EventCode::Death, at, v as u32, 0);
        if let Some(a) = by {
            let sq = self.soldiers[a].squad as usize;
            self.squads[sq].kills += 1;
        }
    }

    /// Step 7: a routing beast tramples everything in contact, friend or foe, every 0.3 s (§5 "Beasts").
    pub(super) fn trample(&mut self) {
        let b = self.tune.beast.clone();
        let every = ((b.trample_s / DT).round() as Tick).max(1);
        if !self.tick.is_multiple_of(every) {
            return;
        }
        let mut hits: Vec<usize> = Vec::new();
        for s in self.squads.iter().filter(|s| s.spec.beast && s.state == SquadState::Routing) {
            for &k in &s.soldiers {
                let m = &self.soldiers[k];
                if !m.alive {
                    continue;
                }
                let ra = s.spec.radius;
                self.grid.visit(m.pos(), ra + self.max_radius, |j| {
                    let o = &self.soldiers[j];
                    let rb = self.squads[o.squad as usize].spec.radius;
                    if j != k && o.pos().dist(m.pos()) < ra + rb && !hits.contains(&j) {
                        hits.push(j);
                    }
                });
            }
        }
        hits.sort_unstable();
        for j in hits {
            let m = &mut self.soldiers[j];
            m.hp -= b.trample_dmg;
            m.hit_at = self.tick;
            let (at, dead) = (m.pos(), m.hp <= 0.0);
            self.event(EventCode::Hit, at, j as u32, Kind::Beast as u32);
            if dead {
                self.kill(j, None);
            }
        }
    }

    /// Step 8: the dead leave the ranks. Each death costs the company `1.6·(100/full)·steadiness·(0.6 ranged)·way`
    /// morale; each gap is filled by the man holding the highest slot. A fallen commander breaks his company; a
    /// living commander pulls the last men off the field once.
    pub(super) fn cull(&mut self) {
        let mo = self.tune.morale.clone();
        let ways = self.tune.ways.clone();
        for i in 0..self.squads.len() {
            let mut fallen: Vec<usize> = self.squads[i].soldiers.iter().copied().filter(|&k| self.soldiers[k].died_at == self.tick).collect();
            if fallen.is_empty() {
                continue;
            }
            fallen.sort_by_key(|&k| self.soldiers[k].slot);
            for k in fallen {
                self.squads[i].alive = self.squads[i].alive.saturating_sub(1);
                if self.squads[i].leader == Some(k) {
                    self.commander_falls(i);
                    continue;
                }
                let s = &self.squads[i];
                if s.kind != Kind::Captain {
                    let way = match s.way() {
                        Some(Way::Stubborn) => ways.stubborn_morale,
                        Some(Way::Reckless) => ways.reckless_morale,
                        _ => 1.0,
                    };
                    let loss = mo.death_k * (100.0 / s.full as f64) * s.spec.steadiness * if s.spec.ranged() { mo.ranged_share } else { 1.0 } * way;
                    self.squads[i].morale -= loss;
                }
                // The man holding the highest slot steps into the gap; nobody else moves.
                let gap = self.soldiers[k].slot;
                let leader = self.squads[i].leader;
                let highest = self.squads[i]
                    .soldiers
                    .iter()
                    .copied()
                    .filter(|&j| self.soldiers[j].alive && Some(j) != leader)
                    .max_by_key(|&j| self.soldiers[j].slot);
                if let Some(j) = highest
                    && self.soldiers[j].slot > gap
                {
                    self.soldiers[j].slot = gap;
                }
            }
            if self.squads[i].alive == 0 && self.squads[i].on_field() {
                let s = &mut self.squads[i];
                s.state = SquadState::Destroyed;
                s.threat = None;
                let (at, id, fell) = (P::new(s.x, s.y), s.id as u32, s.commander_fell);
                if s.kind == Kind::Captain && s.team == 1 {
                    self.general_falls(i);
                } else if !fell {
                    self.event(EventCode::BannerFall, at, id, 0);
                }
                continue;
            }
            self.save_the_last(i);
        }
    }

    /// §5 "If he dies": morale capped at 21 (it routs at once and never rallies); an enemy commander's fall costs
    /// every other company of his side 25.
    fn commander_falls(&mut self, i: usize) {
        let mo = self.tune.morale.clone();
        let s = &mut self.squads[i];
        s.leader = None;
        s.commander_fell = true;
        s.morale = s.morale.min(mo.commander_fell_cap);
        let (team, id, at) = (s.team, s.id as u32, P::new(s.x, s.y));
        let code = if team == 0 { EventCode::CommanderFall } else { EventCode::FoeCommanderFall };
        self.event(code, at, id, team as u32);
        self.event(EventCode::BannerFall, at, id, 1);
        if self.foe_rules(team) {
            for o in self.squads.iter_mut().filter(|o| o.team == team && o.id as usize != i && o.on_field() && o.kind != Kind::Captain) {
                o.morale -= mo.foe_commander_fell;
            }
        }
    }

    /// The enemy's own commander falls (the broodlord, or the general): the enemy-commander rules hold for him as
    /// for a company's commander (§5: every other company of his side loses 25; FoeCommanderFall, then his banner
    /// falls). His side's battle is lost besides (§8, checked in step 12).
    fn general_falls(&mut self, i: usize) {
        let mo = self.tune.morale.clone();
        let s = &self.squads[i];
        let (team, id, at) = (s.team, s.id as u32, P::new(s.x, s.y));
        self.event(EventCode::FoeCommanderFall, at, id, team as u32);
        self.event(EventCode::BannerFall, at, id, 1);
        for o in self.squads.iter_mut().filter(|o| o.team == team && o.id as usize != i && o.on_field() && o.kind != Kind::Captain) {
            o.morale -= mo.foe_commander_fell;
        }
    }

    /// §5 "Saving the last men": with `max(2, floor((full−1)·0.3))` men left (0.5 for an enemy commander), the
    /// commander pulls the company off the field, once; an enemy commander doing it costs his side 12.
    fn save_the_last(&mut self, i: usize) {
        let mo = self.tune.morale.clone();
        let s = &self.squads[i];
        if s.leader.is_none() || s.saved || !s.standing() || s.kind == Kind::Captain {
            return;
        }
        let foe = self.foe_rules(s.team);
        let share = if foe { mo.foe_save_share } else { mo.save_share };
        let limit = (((s.full as f64 - 1.0) * share).floor() as u16).max(mo.save_min);
        if s.alive > limit {
            return;
        }
        let team = s.team;
        let s = &mut self.squads[i];
        s.saved = true;
        s.detached = true;
        s.queue.clear();
        s.threat = None;
        self.set_order(i, Order::Retreat, super::How::default());
        if foe {
            for o in self.squads.iter_mut().filter(|o| o.team == team && o.id as usize != i && o.on_field() && o.kind != Kind::Captain) {
                o.morale -= mo.foe_save_loss;
            }
        }
    }
}
