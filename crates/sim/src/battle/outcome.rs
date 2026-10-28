//! Steps 9 and 12: sites change hands, and the battle is decided (04-battle.md §8).

use super::{Battle, SquadState};
use crate::contracts::{EventCode, Kind, P, Team};
use crate::map::{MapKind, SiteKind};

/// Why a battle ended; `Outcome` events carry it as `b` (the code below).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum OutcomeReason {
    /// The loser's captain fell (checked first).
    CaptainFell = 1,
    /// The attacker's captain reached his own edge after 8 s: he withdraws, losing but surviving.
    Withdrew = 2,
    /// The attacker owns the keep.
    KeepTaken = 3,
    /// No defender company is left on the field.
    NoDefenders = 4,
    /// Open field: the loser has no company left that is not routing.
    Routed = 5,
    /// Open field: time ran out; the higher men × worth wins.
    TimeOut = 6,
    /// The attacker's captain lived until dawn.
    Dawn = 7,
}

impl OutcomeReason {
    pub fn code(self) -> u32 {
        self as u32
    }

    pub fn name(self) -> &'static str {
        match self {
            OutcomeReason::CaptainFell => "captain fell",
            OutcomeReason::Withdrew => "withdrew",
            OutcomeReason::KeepTaken => "keep taken",
            OutcomeReason::NoDefenders => "no defenders",
            OutcomeReason::Routed => "routed",
            OutcomeReason::TimeOut => "time out",
            OutcomeReason::Dawn => "dawn",
        }
    }
}

impl Battle {
    /// The battle's length before it is decided by time: field `360 s × width/48`; otherwise the day,
    /// `300 s × width/48`, then 70 s of night until dawn.
    pub fn time_limit(&self) -> f64 {
        let o = &self.tune.outcome;
        let w = self.map.wf() / o.width_base;
        if self.map.kind == MapKind::Field { o.field_s * w } else { o.battle_s * w + o.night_s }
    }

    /// Step 9, holdfast capture: within 1.8, `rate = dt/(6·k)·(1 + 0.25·(weight−1))`, k = 2 for the keep and 1.5
    /// for a town; every company weighs 1 and the captain 3. A contested site freezes.
    pub(super) fn update_sites(&mut self) {
        let o = self.tune.outcome.clone();
        for si in 0..self.sites.len() {
            let at = self.map.sites[si].at;
            let mut weight = [0.0f64; 2];
            for s in &self.squads {
                if !s.standing() || s.alive == 0 {
                    continue;
                }
                let inside = s.soldiers.iter().any(|&k| self.soldiers[k].alive && self.soldiers[k].pos().dist(at) <= o.capture_r);
                if inside {
                    weight[s.team as usize & 1] += if s.kind == Kind::Captain { o.captain_weight } else { 1.0 };
                }
            }
            let team = match (weight[0] > 0.0, weight[1] > 0.0) {
                (true, false) => 0u8,
                (false, true) => 1u8,
                _ => continue,
            };
            let st = &mut self.sites[si];
            if st.owner == Some(team) {
                st.progress = 0.0;
                st.by = None;
                continue;
            }
            if st.by != Some(team) {
                st.by = Some(team);
                st.progress = 0.0;
            }
            let k = match self.map.sites[si].kind {
                SiteKind::Keep => o.keep_k,
                SiteKind::Town => o.town_k,
                _ => 1.0,
            };
            st.progress += super::DT / (o.capture_s * k) * (1.0 + o.weight_k * (weight[team as usize] - 1.0));
            if st.progress >= 1.0 {
                st.owner = Some(team);
                st.progress = 0.0;
                st.by = None;
                self.event(EventCode::SiteTaken, at, si as u32, team as u32);
            }
        }
    }

    /// The day's end in a campaign battle (04-battle.md §8 "Night"): the dusk bell when 80% of the day is gone,
    /// then night falls (sight ×0.6; the garrison attacks). Dawn comes 70 s later. The relief from the east and the
    /// torches come with day 4.
    pub(super) fn update_night(&mut self) {
        if self.map.kind == MapKind::Field || self.decided.is_some() {
            return;
        }
        let o = &self.tune.outcome;
        let day = o.battle_s * self.map.wf() / o.width_base;
        let night_s = o.night_s;
        let tick = |s: f64| (s * crate::contracts::TICK_HZ as f64).round() as crate::contracts::Tick;
        if self.tick == tick(day * 0.8) {
            self.event(EventCode::DuskBell, self.map.deploy[0], 0, 0);
        }
        if !self.night && !self.dawn && self.tick >= tick(day) {
            self.night = true;
            self.event(EventCode::Nightfall, self.map.deploy[0], 0, 0);
        }
        // Dawn ends the night (the battle's own outcome is reckoned in step 12); `When::Dawn` reads it.
        if self.night && self.tick >= tick(day + night_s) {
            self.night = false;
            self.dawn = true;
        }
    }

    /// Men × worth for `team`'s companies and captain still on the field.
    pub fn strength(&self, team: Team) -> f64 {
        self.squads.iter().filter(|s| s.team == team && s.on_field()).map(|s| s.strength(&self.tune)).sum()
    }

    /// Step 12 (04-battle.md §8): the captain first, then withdrawal, then the battle type's own rules, then time.
    pub(super) fn check_outcome(&mut self) {
        if self.decided.is_some() {
            return;
        }
        let o = self.tune.outcome.clone();
        let by_worth = |b: &Battle| if b.strength(0) > b.strength(1) { 0 } else { 1 };
        let decided = 'd: {
            let fell = [0u8, 1].map(|t| self.had_captain[t as usize] && self.captain_of(t).is_none());
            match fell {
                [true, true] => break 'd Some((by_worth(self), OutcomeReason::CaptainFell)),
                [true, false] => break 'd Some((1, OutcomeReason::CaptainFell)),
                [false, true] => break 'd Some((0, OutcomeReason::CaptainFell)),
                _ => {}
            }
            if self.time() >= o.withdraw_after_s {
                let w = self.map.wf();
                if self.captain_at(0).is_some_and(|p| p.x <= o.withdraw_r) {
                    break 'd Some((1, OutcomeReason::Withdrew));
                }
                if self.map.kind == MapKind::Field && self.captain_at(1).is_some_and(|p: P| p.x >= w - o.withdraw_r) {
                    break 'd Some((0, OutcomeReason::Withdrew));
                }
            }
            match self.map.kind {
                MapKind::Keep | MapKind::Town => {
                    if self.sites.first().is_some_and(|s| s.owner == Some(0)) {
                        break 'd Some((0, OutcomeReason::KeepTaken));
                    }
                    let defenders = self.squads.iter().filter(|s| s.team == 1 && s.kind != Kind::Captain);
                    let mut any = false;
                    let mut left = false;
                    for s in defenders {
                        any = true;
                        left |= s.on_field();
                    }
                    if any && !left {
                        break 'd Some((0, OutcomeReason::NoDefenders));
                    }
                }
                MapKind::Field => {
                    let broken = [0u8, 1].map(|t| {
                        let mut companies = self.squads.iter().filter(|s| s.team == t && s.kind != Kind::Captain).peekable();
                        companies.peek().is_some() && companies.all(|s| s.state == SquadState::Routing || !s.on_field())
                    });
                    match broken {
                        [true, true] => break 'd Some((by_worth(self), OutcomeReason::Routed)),
                        [true, false] => break 'd Some((1, OutcomeReason::Routed)),
                        [false, true] => break 'd Some((0, OutcomeReason::Routed)),
                        _ => {}
                    }
                }
                MapKind::Ford => {}
            }
            if self.time() >= self.time_limit() {
                if self.map.kind == MapKind::Field {
                    break 'd Some((by_worth(self), OutcomeReason::TimeOut));
                }
                self.event(EventCode::Dawn, self.map.deploy[0], 0, 0);
                break 'd Some((0, OutcomeReason::Dawn));
            }
            None
        };
        if let Some((team, why)) = decided {
            self.decided = Some((team, why));
            let at = self.captain_at(team).unwrap_or(self.map.deploy[team as usize & 1]);
            self.event(EventCode::Outcome, at, team as u32, why.code());
        }
    }
}
