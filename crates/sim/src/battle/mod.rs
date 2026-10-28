//! One real-time battle at a fixed 30 Hz (docs/spec/04-battle.md §1). Nothing changes a battle except a
//! `Command` through the order queue, so a replay is the seed plus the log.
//!
//! Day 1 skeleton: the queue, orders, the squad anchor (§3b) and each man's steering toward his slot (§3c,
//! without separation). Followers, formations, combat, morale and the rest arrive on day 3; `step` lists the
//! full tick order and marks the steps not built yet.

mod orders;
mod replay;
mod setup;

pub use replay::Replay;
pub use setup::Setup;

use crate::contracts::{Command, EventCode, Kind, P, Refusal, SquadId, TICK_HZ, Team, Tick};
use crate::hash::Fnv;
use crate::map::{self, BattleMap, MapOpts, Tile, path};
use crate::math::{atan2, turn};
use crate::tune::{KindSpec, Tune};

pub const DT: f64 = 1.0 / TICK_HZ as f64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SquadState {
    Idle = 0,
    Marching = 1,
    Fighting = 2,
    Routing = 3,
    Fled = 4,
    Destroyed = 5,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Order {
    Hold { face: Option<f64> },
    Move { to: P, via: Vec<P>, fight: bool, face: Option<f64> },
    Attack { target: SquadId, via: Vec<P> },
    Take { site: u16, via: Vec<P> },
}

impl Order {
    /// Waypoints still to pass, dropped one by one within 0.9 tiles (04-battle.md §3b).
    pub fn via(&self) -> &[P] {
        match self {
            Order::Move { via, .. } | Order::Attack { via, .. } | Order::Take { via, .. } => via,
            Order::Hold { .. } => &[],
        }
    }

    fn via_mut(&mut self) -> Option<&mut Vec<P>> {
        match self {
            Order::Move { via, .. } | Order::Attack { via, .. } | Order::Take { via, .. } => Some(via),
            Order::Hold { .. } => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Soldier {
    pub squad: SquadId,
    /// Fixed per man; 0 is the commander, who stands behind the ranks.
    pub slot: u16,
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    /// Low-passed actual speed, the input to charges.
    pub pace: f64,
    pub hp: f64,
    pub max_hp: f64,
    pub alive: bool,
    /// Counter the view watches to start a strike animation.
    pub strikes: u32,
}

#[derive(Clone, Debug)]
pub struct Squad {
    pub id: SquadId,
    pub team: Team,
    pub kind: Kind,
    /// The commander's name; empty for a company without one.
    pub name: String,
    pub spec: KindSpec,
    pub rank: u8,
    pub soldiers: Vec<usize>,
    pub full: u16,
    /// The anchor: the centre of the front rank.
    pub x: f64,
    pub y: f64,
    pub facing: f64,
    pub order: Order,
    pub state: SquadState,
    pub morale: f64,
    pub max_morale: f64,
    /// Detached from the army by an order of its own, until recalled.
    pub detached: bool,
    /// Frontage override from a drawn line.
    pub files: Option<u16>,
    /// Its fixed place around the captain: (ahead, to the left), 04-battle.md §3d.
    pub station: (f64, f64),
    path: Vec<P>,
    path_goal: P,
    replan_at: Tick,
}

/// One event for the view and sound, drained each frame (contracts: `EventCode`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Event {
    pub code: EventCode,
    pub tick: Tick,
    pub at: P,
    pub a: u32,
    pub b: u32,
}

pub struct Battle {
    pub seed: u32,
    pub tick: Tick,
    pub map: BattleMap,
    pub tune: Tune,
    pub squads: Vec<Squad>,
    pub soldiers: Vec<Soldier>,
    /// Every command applied so far, in order: with the seed, the replay.
    pub log: Vec<Command>,
    pub refusals: Vec<Refusal>,
    pub events: Vec<Event>,
    /// Commands waiting for their tick, kept in arrival order.
    queue: Vec<Command>,
}

impl Battle {
    pub fn new(seed: u32, opts: MapOpts, setup: &Setup, tune: Tune) -> Battle {
        let map = map::generate(seed, opts);
        let mut b = Battle {
            seed,
            tick: 0,
            map,
            tune,
            squads: Vec::new(),
            soldiers: Vec::new(),
            log: Vec::new(),
            refusals: Vec::new(),
            events: Vec::new(),
            queue: Vec::new(),
        };
        setup.deploy(&mut b);
        b
    }

    pub fn time(&self) -> f64 {
        self.tick as f64 * DT
    }

    /// Queues a command. It is applied before its tick; one already late is applied before the next tick.
    pub fn apply(&mut self, cmd: Command) {
        self.queue.push(cmd);
    }

    /// Advances `n` fixed ticks.
    pub fn step(&mut self, n: u32) {
        for _ in 0..n {
            self.tick_once();
        }
    }

    pub fn run_to(&mut self, tick: Tick) {
        while self.tick < tick {
            self.tick_once();
        }
    }

    pub fn drain_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }

    fn tick_once(&mut self) {
        self.apply_due();
        // 1. rebucket (the neighbour grid): day 3, with separation and combat.
        // 2. updateSquad: moves only the anchors.
        for i in 0..self.squads.len() {
            self.update_squad(i);
        }
        // 3. updateSoldier: strikes are collected, not applied (day 3).
        for i in 0..self.soldiers.len() {
            self.update_soldier(i);
        }
        // 4. resolve strikes, 5. burn, 6. arrows, 7. hooks, 8. cull, 9. sites/towns/ford/night,
        // 10. morale, 11. sight (every 8 ticks), 12. outcome: days 3 and 4.
        self.tick += 1;
    }

    /// Applies the commands due now without stepping: the same result as the next tick would give, sooner.
    /// The harness uses it to report a refusal as soon as an order is given.
    pub fn flush(&mut self) {
        self.apply_due();
    }

    fn apply_due(&mut self) {
        let (due, later): (Vec<_>, Vec<_>) = std::mem::take(&mut self.queue).into_iter().partition(|c| c.tick <= self.tick);
        self.queue = later;
        for cmd in due {
            if let Err((at, why)) = self.obey(cmd.team, &cmd.deed) {
                self.refusals.push(Refusal { tick: self.tick, at, why: why.clone() });
                self.events.push(Event { code: EventCode::Refused, tick: self.tick, at, a: cmd.team as u32, b: 0 });
            }
            self.log.push(Command { tick: self.tick, ..cmd });
        }
    }

    fn speed(&self, s: &Squad) -> f64 {
        s.spec.speed * (1.0 + self.tune.rank.speed * s.rank as f64)
    }

    fn terrain_pace(&self, p: P) -> f64 {
        if self.map.tile_at(p) == Tile::Forest { self.tune.movement.forest_pace } else { 1.0 }
    }

    /// Where the anchor is heading now, and how close counts as arrived.
    fn goal(&self, s: &Squad) -> Option<(P, f64, Option<f64>)> {
        let mv = &self.tune.movement;
        match &s.order {
            Order::Hold { .. } => None,
            _ if !s.order.via().is_empty() => Some((s.order.via()[0], mv.arrive_at, None)),
            Order::Move { to, face, .. } => Some((*to, mv.arrive_at, *face)),
            Order::Attack { target, .. } => {
                let t = &self.squads[*target as usize];
                Some((P::new(t.x, t.y), self.tune.combat.melee, None))
            }
            Order::Take { site, .. } => Some((self.map.sites[*site as usize].at, mv.arrive_at, None)),
        }
    }

    /// 04-battle.md §3b: path by A*, replanned every second or when the goal moves; the cohesion gate; the
    /// anchor turns toward its waypoint and holds within 0.4 of the goal.
    fn update_squad(&mut self, i: usize) {
        let mv = self.tune.movement.clone();
        let s = &self.squads[i];
        if matches!(s.state, SquadState::Fled | SquadState::Destroyed) {
            return;
        }
        let here = P::new(s.x, s.y);
        let Some((goal, arrive, face)) = self.goal(s) else {
            if let Order::Hold { face: Some(f) } = s.order {
                let turn_rate = self.turn_rate(s);
                let s = &mut self.squads[i];
                s.facing = turn(s.facing, f, turn_rate * DT);
            }
            self.squads[i].state = SquadState::Idle;
            return;
        };
        // Drop a via point once within 0.9.
        if let Some(via) = self.squads[i].order.via_mut()
            && via.first().is_some_and(|v| v.dist(here) < mv.via_drop)
        {
            via.remove(0);
            return;
        }
        let final_leg = self.squads[i].order.via().is_empty();
        if final_leg && here.dist(goal) <= arrive {
            let s = &mut self.squads[i];
            if let Order::Move { .. } | Order::Take { .. } = s.order {
                s.order = Order::Hold { face };
            }
            s.state = SquadState::Idle;
            s.path.clear();
            return;
        }
        let replan_ticks = (mv.replan_s * TICK_HZ as f64) as Tick;
        let s = &self.squads[i];
        if s.path.is_empty() || s.path_goal.dist(goal) > mv.replan_moved || self.tick >= s.replan_at {
            let way = path::route(&self.map, here, goal).unwrap_or_default();
            let s = &mut self.squads[i];
            s.path = way;
            s.path_goal = goal;
            s.replan_at = self.tick + replan_ticks;
        }
        let s = &self.squads[i];
        let Some(&next) = s.path.first() else {
            self.squads[i].state = SquadState::Idle;
            return;
        };
        let loose = self.looseness(i);
        let gate = if s.kind == Kind::Captain || loose <= mv.loose_slow {
            1.0
        } else if loose <= mv.loose_stop {
            mv.loose_pace
        } else {
            0.0
        };
        let step = self.speed(s) * self.terrain_pace(here) * gate * DT;
        let d = here.dist(next);
        let heading = atan2(next.y - here.y, next.x - here.x);
        let turn_rate = self.turn_rate(s);
        let s = &mut self.squads[i];
        s.facing = turn(s.facing, heading, turn_rate * DT);
        s.state = SquadState::Marching;
        if d <= step {
            s.x = next.x;
            s.y = next.y;
            s.path.remove(0);
        } else {
            s.x += (next.x - here.x) / d * step;
            s.y += (next.y - here.y) / d * step;
        }
    }

    fn turn_rate(&self, s: &Squad) -> f64 {
        let mv = &self.tune.movement;
        if s.kind == Kind::Beast { mv.anchor_turn * mv.beast_turn_share } else { mv.anchor_turn }
    }

    /// The mean distance of the living men from their slots.
    fn looseness(&self, i: usize) -> f64 {
        let s = &self.squads[i];
        let alive: Vec<usize> = s.soldiers.iter().copied().filter(|&k| self.soldiers[k].alive).collect();
        if alive.is_empty() {
            return 0.0;
        }
        let total: f64 = alive
            .iter()
            .map(|&k| {
                let m = &self.soldiers[k];
                P::new(m.x, m.y).dist(self.slot(s, m.slot, alive.len()))
            })
            .sum();
        total / alive.len() as f64
    }

    /// 04-battle.md §3a: man `slot` of a squad with `n` men alive, rotated by its facing about the anchor.
    /// Slot 0 is the commander's spot, `0.8 + (ranks−1)·0.72` behind the anchor.
    pub fn slot(&self, s: &Squad, slot: u16, n: usize) -> P {
        let mv = &self.tune.movement;
        let anchor = P::new(s.x, s.y);
        let has_commander = !s.name.is_empty() && s.kind != Kind::Captain;
        let ranks_men = if has_commander { n.saturating_sub(1) } else { n }.max(1);
        let f = s.files.or(s.spec.frontage).unwrap_or(if s.kind == Kind::Horse { mv.frontage_horse } else { mv.frontage });
        let f = (f as usize).max(1);
        let room = s.spec.radius / mv.base_radius;
        if has_commander && slot == 0 {
            let ranks = ranks_men.div_ceil(f);
            return anchor.offset(s.facing, -(mv.commander_back + (ranks as f64 - 1.0) * mv.file_gap), 0.0);
        }
        let i = if has_commander { slot as usize - 1 } else { slot as usize };
        let (rank, file) = (i / f, i % f);
        let in_rank = f.min(ranks_men.saturating_sub(rank * f)).max(1);
        let lateral = (file as f64 - (in_rank as f64 - 1.0) / 2.0) * mv.file_gap * room;
        anchor.offset(s.facing, -(rank as f64) * mv.file_gap * room, lateral)
    }

    /// 04-battle.md §3c without separation: desired velocity toward the slot, eased at RESPONSE, moved one
    /// axis at a time against passability and kept 0.2 inside the map.
    fn update_soldier(&mut self, k: usize) {
        let mv = self.tune.movement.clone();
        let m = &self.soldiers[k];
        if !m.alive {
            return;
        }
        let s = &self.squads[m.squad as usize];
        let n = s.soldiers.iter().filter(|&&j| self.soldiers[j].alive).count();
        let target = self.slot(s, m.slot, n);
        let here = P::new(m.x, m.y);
        let d = here.dist(target);
        let catchup = if d > mv.catchup_far_at {
            mv.catchup_far
        } else if d > mv.catchup_near_at {
            mv.catchup_near
        } else {
            1.0
        };
        let speed = self.speed(s) * catchup * self.terrain_pace(here);
        let (mut wx, mut wy) = (0.0, 0.0);
        if d > mv.settle {
            let v = speed.min((d - 0.025) * mv.arrive);
            wx = (target.x - here.x) / d * v;
            wy = (target.y - here.y) / d * v;
        }
        let ease = (DT * mv.response).min(1.0);
        let (w, h) = (self.map.wf(), self.map.hf());
        let m = &self.soldiers[k];
        let (vx, vy) = (m.vx + (wx - m.vx) * ease, m.vy + (wy - m.vy) * ease);
        let nx = (m.x + vx * DT).clamp(mv.edge_margin, w - mv.edge_margin);
        let ny = (m.y + vy * DT).clamp(mv.edge_margin, h - mv.edge_margin);
        let x = if self.map.passable(P::new(nx, m.y)) { nx } else { m.x };
        let y = if self.map.passable(P::new(x, ny)) { ny } else { m.y };
        let actual = P::new(m.x, m.y).dist(P::new(x, y)) / DT;
        let m = &mut self.soldiers[k];
        m.pace += (actual - m.pace) * (DT * mv.pace_rate).min(1.0);
        (m.vx, m.vy, m.x, m.y) = (vx, vy, x, y);
    }

    /// FNV-1a over the tick and all squad and soldier state.
    pub fn hash(&self) -> u64 {
        let mut f = Fnv::default();
        f.u32(self.tick);
        for s in &self.squads {
            f.u32(s.id as u32);
            f.u32(s.team as u32);
            f.u32(s.kind as u32);
            f.u32(s.state as u32);
            f.u32(s.detached as u32);
            for v in [s.x, s.y, s.facing, s.morale] {
                f.f64(v);
            }
            match &s.order {
                Order::Hold { face } => {
                    f.u32(0);
                    f.f64(face.unwrap_or(f64::MAX));
                }
                Order::Move { to, via, fight, face } => {
                    f.u32(1);
                    for p in std::iter::once(to).chain(via) {
                        f.f64(p.x);
                        f.f64(p.y);
                    }
                    f.u32(*fight as u32);
                    f.f64(face.unwrap_or(f64::MAX));
                }
                Order::Attack { target, via } => {
                    f.u32(2);
                    f.u32(*target as u32);
                    for p in via {
                        f.f64(p.x);
                        f.f64(p.y);
                    }
                }
                Order::Take { site, via } => {
                    f.u32(3);
                    f.u32(*site as u32);
                    for p in via {
                        f.f64(p.x);
                        f.f64(p.y);
                    }
                }
            }
        }
        for m in &self.soldiers {
            f.u32(m.alive as u32);
            for v in [m.x, m.y, m.vx, m.vy, m.pace, m.hp] {
                f.f64(v);
            }
        }
        f.finish()
    }

    /// The whole state as text, for the harness (the fog-limited brain view comes with voice).
    pub fn describe(&self) -> String {
        let mut out = format!(
            "tick {} ({:.1} s) | map {:?} {}x{} seed {} | hash {:016x}\n",
            self.tick,
            self.time(),
            self.map.kind,
            self.map.w,
            self.map.h,
            self.map.seed,
            self.hash()
        );
        let sites: Vec<String> = self
            .map
            .sites
            .iter()
            .map(|s| {
                let owner = match s.owner {
                    Some(0) => "ours",
                    Some(_) => "foe",
                    None => "none",
                };
                format!("{} {:?} ({:.1},{:.1}) {owner}", s.id, s.kind, s.at.x, s.at.y)
            })
            .collect();
        out += &format!("SITES: {}\n", sites.join(" | "));
        for team in [0, 1] {
            let label = if team == 0 { "OURS" } else { "FOES" };
            let rows: Vec<String> = self.squads.iter().filter(|s| s.team == team).map(|s| self.describe_squad(s)).collect();
            out += &format!("{label}:\n  {}\n", rows.join("\n  "));
        }
        for r in &self.refusals {
            out += &format!("REFUSED tick {} at ({:.1},{:.1}): {}\n", r.tick, r.at.x, r.at.y, r.why);
        }
        out
    }

    fn describe_squad(&self, s: &Squad) -> String {
        let alive = s.soldiers.iter().filter(|&&k| self.soldiers[k].alive).count();
        let name = if s.name.is_empty() { format!("E{}", s.id) } else { s.name.clone() };
        let order = match &s.order {
            Order::Hold { .. } => "hold".to_string(),
            Order::Move { to, fight, .. } => format!("move ({:.1},{:.1}){}", to.x, to.y, if *fight { " fight" } else { "" }),
            Order::Attack { target, .. } => format!("attack {target}"),
            Order::Take { site, .. } => format!("take site {site}"),
        };
        let detached = if s.detached { " detached" } else { "" };
        format!(
            "{} {name} {:?} {alive}/{} ({:.1},{:.1}) face {:.2} {:?} {order}{detached}",
            s.id, s.kind, s.full, s.x, s.y, s.facing, s.state
        )
    }
}
