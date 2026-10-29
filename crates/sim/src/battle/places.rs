//! Day 4's places (04-battle.md §8; 03-land.md §7, §8; 02-look.md §3; 01-flow.md §4):
//! - **The village under the torch:** five houses of three people round the town's green; the first is fired at
//!   22 s, then one every 26 s; each burns 24 s, then falls in on its people. Taking the town frees everyone in the
//!   houses still standing (a burning one is doused), and its men fall in behind the captain under a plain banner.
//! - **The ford:** four groups of five civilians come in at the east at 1, 31, 61 and 91 s and walk west, alternate
//!   groups by the far ford, at 0.95, running at 1.6 when an enemy is within 5. The raiders come in waves at 14, 37,
//!   67 and 97 s. The ford is won when every group has come and left the field, with at least one person saved.
//! - **The night:** torches lit in order after nightfall give each army away within its spread + 0.8; burning
//!   houses light 4 tiles round them; 6 s after nightfall a relief of half the garrison's starting companies comes
//!   in from the east.
//!
//! Companies that join a battle (civilians, raiders, the relief, the freed) are spawned at the start of a tick,
//! before the neighbour grid is built, so every per-tick table has room for them. Choices the spec leaves open are
//! in out/decisions-d4-places.md.

use super::outcome::OutcomeReason;
use super::setup::spawn;
use super::{Battle, Company, DT, Order, SquadState};
use crate::contracts::{EventCode, Kind, P, SquadId, TICK_HZ, Team, Tick};
use crate::hash::Fnv;
use crate::map::{MapKind, SiteKind};
use crate::math::atan2;
use crate::rng::jitter;
use crate::units::Unit;

/// A house of the village under the torch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HouseState {
    Standing = 0,
    Burning = 1,
    /// Burnt and fallen in on its people: a ruin, smouldering for a while.
    Fallen = 2,
    /// Its fire put out when the village was taken: it smokes for a while.
    Doused = 3,
}

#[derive(Clone, Debug, PartialEq)]
pub struct House {
    /// Its centre on the map, and its width (east–west) and depth.
    pub at: P,
    pub size: (f64, f64),
    pub state: HouseState,
    /// When it is to be fired.
    pub fire_at: Tick,
    /// When its state began (fired, fell or doused); `Tick::MAX` while it stands unfired.
    pub since: Tick,
    /// The people inside.
    pub people: u16,
}

impl House {
    /// How far it has burnt, 0..1 (its fire's age over the burn time), 1 once fallen.
    pub fn burnt(&self, tick: Tick, burn_s: f64) -> f64 {
        match self.state {
            HouseState::Standing => 0.0,
            HouseState::Fallen => 1.0,
            HouseState::Burning | HouseState::Doused => {
                let end = if self.state == HouseState::Burning { tick } else { self.since };
                let fired = self.fire_at.min(end);
                ((end - fired) as f64 * DT / burn_s).clamp(0.0, 1.0)
            }
        }
    }
}

/// A group of the ford's civilians.
#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    /// When it comes in.
    pub at: Tick,
    /// It takes the far (narrow) ford.
    pub far: bool,
    /// Its company once it has come in.
    pub squad: Option<SquadId>,
    /// It has left the field at the west, or nobody of it lives.
    pub done: bool,
    /// People who left the field alive.
    pub saved: u16,
}

/// A wave of the ford's raiders.
#[derive(Clone, Debug, PartialEq)]
pub struct Wave {
    pub at: Tick,
    pub units: Vec<Unit>,
    /// It comes in at the north end of the east edge (else the south).
    pub north: bool,
    pub squads: Vec<SquadId>,
}

/// The ford's people, routes and raiders.
#[derive(Clone, Debug, PartialEq)]
pub struct Ford {
    pub groups: Vec<Group>,
    pub waves: Vec<Wave>,
    /// Where the civilians come in (east) and leave (west).
    pub entry: P,
    pub exit: P,
    /// The main ford's crossing and the far (narrow) ford's.
    pub crossing: [P; 2],
    /// The refugees' wagons (03-land.md §7), with their fire.
    pub wagons: P,
}

impl Ford {
    pub fn saved(&self) -> u32 {
        self.groups.iter().map(|g| g.saved as u32).sum()
    }
}

/// What a light is, for the view (02-look.md §3 "Lights").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LightKind {
    /// Carried by a company's leader (`of` = his soldier index).
    Torch = 0,
    /// A burning house (`of` = the house).
    House = 1,
    /// A fallen house smouldering (`of` = the house).
    Ruin = 2,
    /// A shrine's flame (`of` = the site) or the ford's wagons fire (`of` = u32::MAX).
    Fire = 3,
}

/// A night light: a world point with a reach in tiles and a strength.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Light {
    pub at: P,
    pub reach: f64,
    pub strength: f64,
    pub kind: LightKind,
    pub of: u32,
}

/// A company waiting to join the battle at the next tick's start.
#[derive(Clone, Debug)]
struct Coming {
    team: Team,
    company: Company,
    at: P,
    facing: f64,
    men: Option<u16>,
    /// What it is for.
    role: Role,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Role {
    Freed,
}

/// Day 4's places in a battle: the town's houses, the ford, the night's torches and relief, and the freed.
#[derive(Clone, Debug, Default)]
pub struct Places {
    /// The village under the torch's site, when the map is a town.
    pub town: Option<usize>,
    pub houses: Vec<House>,
    pub ford: Option<Ford>,
    /// The tick night fell and the tick dawn came (`Tick::MAX` until then).
    pub nightfall: Option<Tick>,
    pub dawn_at: Option<Tick>,
    /// Per squad: the tick its leader's torch is lit (`Tick::MAX` for none).
    pub torches: Vec<Tick>,
    /// The garrison's starting companies, by unit (the relief is half of them).
    pub garrison: Vec<Unit>,
    pub relief: Vec<SquadId>,
    pub relief_sent: bool,
    /// The freed: their companies, and the people freed and burnt in the town.
    pub freed: Vec<SquadId>,
    pub freed_people: u32,
    pub burnt_people: u32,
    coming: Vec<Coming>,
}

const SALT_HOUSE_ORDER: u32 = 201;

fn ticks(s: f64) -> Tick {
    (s * TICK_HZ as f64).round().max(0.0) as Tick
}

impl Battle {
    /// The places this map has, laid out when the battle opens.
    pub(super) fn init_places(&mut self) {
        let mut p = Places { garrison: self.squads.iter().filter(|s| s.team == 1 && s.kind != Kind::Captain).map(|s| s.unit).collect(), ..Places::default() };
        p.torches = vec![Tick::MAX; self.squads.len()];
        if self.map.kind == MapKind::Town
            && let Some(si) = self.map.sites.iter().position(|s| s.kind == SiteKind::Town)
        {
            let t = &self.tune.places.town;
            let at = self.map.sites[si].at;
            // The houses burn in a seeded order.
            let mut order: Vec<usize> = (0..t.houses.len()).collect();
            order.sort_by(|&a, &b| jitter(self.seed, a as u32, SALT_HOUSE_ORDER).total_cmp(&jitter(self.seed, b as u32, SALT_HOUSE_ORDER)).then(a.cmp(&b)));
            p.town = Some(si);
            p.houses = t
                .houses
                .iter()
                .enumerate()
                .map(|(k, h)| {
                    let nth = order.iter().position(|&o| o == k).unwrap_or(k);
                    House {
                        at: P::new(at.x + h[0], at.y + h[1]),
                        size: (h[2], h[3]),
                        state: HouseState::Standing,
                        fire_at: ticks(t.first_s + t.every_s * nth as f64),
                        since: Tick::MAX,
                        people: t.people,
                    }
                })
                .collect();
        }
        if self.map.kind == MapKind::Ford {
            p.ford = self.lay_out_ford();
        }
        self.places = p;
    }

    /// The ford's routes from the map (03-land.md §3b): the main and far routes run from the east entry to the west
    /// exit; each crosses the river at its first ford tile. The wagons stand off the main road near the entry.
    fn lay_out_ford(&self) -> Option<Ford> {
        let f = &self.tune.places.ford;
        let (main, far) = (self.map.roads.first()?, self.map.roads.get(1)?);
        let (entry, exit) = (*main.first()?, *main.last()?);
        let ford = |q: &P| self.map.idx(q.x.floor() as i32, q.y.floor() as i32).is_some_and(|i| self.map.ford[i]);
        // The main crossing is the main route's first ford tile. The far route may reach its narrow ford by way of
        // the main one (the map's A* route is shortest, not faithful): its crossing is its ford tile off the main
        // ford's rows, the eastern one, so a group bound there comes at it from the east bank.
        let main_at = main.iter().copied().find(ford)?;
        let far_at = far
            .iter()
            .copied()
            .filter(|q| ford(q) && (q.y - main_at.y).abs() > 1.5)
            .max_by(|a, b| a.x.total_cmp(&b.x).then(b.y.total_cmp(&a.y)))
            .unwrap_or(main_at);
        let crossing = [main_at, far_at];
        let road = main.iter().copied().find(|q| q.x <= entry.x - f.wagons_in).unwrap_or(entry);
        let wagons = [-1.0, 1.0]
            .into_iter()
            .map(|side| P::new(road.x, road.y + side * f.wagons_off))
            .find(|&q| self.map.tile_at(q) == crate::map::Tile::Open)
            .unwrap_or(road);
        let groups = f.groups_s.iter().enumerate().map(|(k, &s)| Group { at: ticks(s), far: k % 2 == 1, squad: None, done: false, saved: 0 }).collect();
        let waves = f.waves_s.iter().zip(&f.waves).enumerate().map(|(k, (&s, units))| Wave { at: ticks(s), units: units.clone(), north: k % 2 == 0, squads: Vec::new() }).collect();
        Some(Ford { groups, waves, entry, exit, crossing, wagons })
    }

    /// At the tick's start: the companies whose time has come join the battle (the ford's groups and waves, the
    /// night's relief, the freed).
    pub(super) fn spawn_places(&mut self) {
        let mut ford = self.places.ford.take();
        if let Some(f) = ford.as_mut() {
            for g in 0..f.groups.len() {
                if f.groups[g].squad.is_none() && self.tick >= f.groups[g].at {
                    f.groups[g].squad = Some(self.spawn_group(f, g));
                }
            }
            for w in 0..f.waves.len() {
                if f.waves[w].squads.is_empty() && !f.waves[w].units.is_empty() && self.tick >= f.waves[w].at {
                    let (units, north) = (f.waves[w].units.clone(), f.waves[w].north);
                    f.waves[w].squads = self.spawn_raiders(&units, north);
                }
            }
        }
        self.places.ford = ford;
        if let Some(nf) = self.places.nightfall
            && !self.places.relief_sent
            && self.tick >= nf + ticks(self.tune.places.night.relief_s)
        {
            self.places.relief_sent = true;
            self.send_relief();
        }
        for c in std::mem::take(&mut self.places.coming) {
            let a = &self.tune.army;
            let k = self.places.freed.len();
            let side = if k.is_multiple_of(2) { 1.0 } else { -1.0 };
            let stations = ((-a.reserve_behind, side * (a.reserve_side + a.gap * (k / 2) as f64)), (-a.column_rest_behind - a.column_rest_gap * (k / 2) as f64, side * a.column_abreast));
            let i = self.join(c.team, &c.company, c.at, c.facing, stations, c.men);
            match c.role {
                Role::Freed => {
                    self.places.freed.push(i as SquadId);
                    // They fall in behind the captain (01-flow.md §4), or hold where they are without one.
                    if self.captain_of(c.team).is_some() {
                        self.squads[i].order = Order::Follow;
                    } else {
                        self.squads[i].detached = true;
                    }
                }
            }
        }
    }

    /// Adds a company mid-battle: its torch is lit at once if night has fallen (the enemy's are all lit by then; ours
    /// a moment after it arrives).
    fn join(&mut self, team: Team, c: &Company, at: P, facing: f64, stations: ((f64, f64), (f64, f64)), men: Option<u16>) -> usize {
        let i = spawn(self, team, c, at, facing, stations, men);
        let n = &self.tune.places.night;
        let lit = match self.places.nightfall {
            Some(_) if team == 0 => self.tick + ticks(n.torch_first_s),
            Some(nf) => self.tick.max(nf + ticks(n.foe_torch_s)),
            None => Tick::MAX,
        };
        self.places.torches.resize(self.squads.len(), Tick::MAX);
        self.places.torches[i] = lit;
        let s = &self.squads[i];
        self.max_radius = self.max_radius.max(s.spec.radius);
        // Blows aren't synchronised (§5): each new man's first cooldown is a random fraction of his interval.
        let (interval, men) = (s.spec.interval, s.soldiers.clone());
        for k in men {
            self.soldiers[k].cooldown = interval * jitter(self.seed, k as u32, super::SALT_COOLDOWN0);
        }
        i
    }

    /// A group of civilians comes in at the entry, bound for the exit by its ford.
    fn spawn_group(&mut self, f: &Ford, g: usize) -> SquadId {
        let at = self.open_near(P::new(f.entry.x - 1.0, f.entry.y));
        let men = self.tune.places.ford.group_men;
        let c = Company::of(Unit::Folk, "");
        let facing = atan2(f.exit.y - at.y, f.exit.x - at.x);
        let i = self.join(0, &c, at, facing, ((0.0, 0.0), (0.0, 0.0)), Some(men));
        let via = vec![f.crossing[f.groups[g].far as usize]];
        let s = &mut self.squads[i];
        s.detached = true;
        s.order = Order::Move { to: f.exit, via, fight: false, face: None };
        s.state = SquadState::Marching;
        s.spec.speed = self.tune.places.ford.walk;
        i as SquadId
    }

    /// A wave of raiders comes in at the north-east or south-east corner, in a line westward along the map's edge
    /// (clear of the civilians' entry midway down the east edge).
    fn spawn_raiders(&mut self, units: &[Unit], north: bool) -> Vec<SquadId> {
        let f = self.tune.places.ford.clone();
        let (w, h) = (self.map.wf(), self.map.hf());
        let gap = self.tune.army.gap;
        let west = std::f64::consts::PI;
        let mut out = Vec::new();
        for (k, &u) in units.iter().enumerate() {
            let y = if north { f.wave_end } else { h - f.wave_end };
            let at = self.open_near(P::new(w - f.wave_in - gap * k as f64, y));
            let i = self.join(1, &Company::of(u, ""), at, west, ((0.0, 0.0), (0.0, 0.0)), None);
            self.squads[i].detached = true;
            out.push(i as SquadId);
        }
        out
    }

    /// 04-battle.md §8 "Night": half the garrison's starting companies come in at the east edge, round the keep's
    /// row, spread evenly over the garrison's units.
    fn send_relief(&mut self) {
        let n = self.tune.places.night.clone();
        let g = self.places.garrison.clone();
        let m = (n.relief_share * g.len() as f64).round() as usize;
        if m == 0 || !matches!(self.map.kind, MapKind::Keep | MapKind::Town) {
            return;
        }
        let units: Vec<Unit> = (0..m).map(|k| g[((2 * k + 1) * g.len()) / (2 * m)]).collect();
        let (w, h) = (self.map.wf(), self.map.hf());
        let row = self.map.deploy[1].y;
        let gap = self.tune.army.gap;
        let west = std::f64::consts::PI;
        for (k, u) in units.into_iter().enumerate() {
            let y = (row + (k as f64 - (m as f64 - 1.0) / 2.0) * gap).clamp(1.5, h - 1.5);
            let at = self.open_near(P::new(w - n.relief_in, y));
            let i = self.join(1, &Company::of(u, ""), at, west, ((0.0, 0.0), (0.0, 0.0)), None);
            self.squads[i].detached = true;
            self.places.relief.push(i as SquadId);
        }
    }

    /// Step 9, the village under the torch: fires on the clock, houses falling in on their people, and, once the town
    /// is ours, everyone in the houses still standing freed.
    pub(super) fn update_town(&mut self) {
        let Some(si) = self.places.town else { return };
        let t = self.tune.places.town.clone();
        let taken = self.sites[si].owner == Some(0);
        let site = si as u32;
        for k in 0..self.places.houses.len() {
            let h = &mut self.places.houses[k];
            match h.state {
                HouseState::Standing if !taken && self.tick >= h.fire_at => {
                    h.state = HouseState::Burning;
                    h.since = self.tick;
                    let at = h.at;
                    self.event(EventCode::HouseFired, at, site, k as u32);
                }
                HouseState::Burning if self.tick >= h.since + ticks(t.burn_s) => {
                    h.state = HouseState::Fallen;
                    h.since = self.tick;
                    let (at, lost) = (h.at, h.people);
                    h.people = 0;
                    self.places.burnt_people += lost as u32;
                    self.event(EventCode::HouseLost, at, site, k as u32);
                }
                _ => {}
            }
        }
        if taken && self.places.houses.iter().any(|h| h.people > 0) {
            let mut people = 0u16;
            for h in &mut self.places.houses {
                if matches!(h.state, HouseState::Standing | HouseState::Burning) {
                    people += h.people;
                    h.people = 0;
                    if h.state == HouseState::Burning {
                        h.state = HouseState::Doused;
                        h.since = self.tick;
                    }
                }
            }
            self.places.freed_people += people as u32;
            let at = self.map.sites[si].at;
            self.event(EventCode::Freed, at, site, people as u32);
            let men = people.min(t.freed_men);
            if men > 0 {
                let facing = self.captain_at(0).map_or(0.0, |c| atan2(c.y - at.y, c.x - at.x));
                let mut c = Company::of(Unit::Levy, "");
                c.freed = true;
                self.places.coming.push(Coming { team: 0, company: c, at, facing, men: Some(men), role: Role::Freed });
            }
        }
    }

    /// Step 9, the ford: each group walks, or runs with an enemy within 5, and leaves the field at the exit; a group
    /// with nobody left is done.
    pub(super) fn update_ford(&mut self) {
        let Some(mut f) = self.places.ford.take() else { return };
        let ft = self.tune.places.ford.clone();
        for g in f.groups.iter_mut() {
            let Some(id) = g.squad else { continue };
            if g.done {
                continue;
            }
            let i = id as usize;
            if self.squads[i].alive == 0 || !self.squads[i].on_field() {
                g.done = true;
                continue;
            }
            let c = self.centre(i);
            let left = c.dist(f.exit) <= ft.leave_r || self.squads[i].done;
            if left {
                // They leave the field: alive, but no longer on it (as a fled company's men).
                let men: Vec<usize> = self.squads[i].soldiers.iter().copied().filter(|&k| self.soldiers[k].alive).collect();
                for &k in &men {
                    let m = &mut self.soldiers[k];
                    m.alive = false;
                    m.target = None;
                    m.vx = 0.0;
                    m.vy = 0.0;
                }
                let s = &mut self.squads[i];
                s.state = SquadState::Fled;
                s.alive = 0;
                s.threat = None;
                g.saved = men.len() as u16;
                g.done = true;
                self.event(EventCode::Saved, c, men.len() as u32, id as u32);
                continue;
            }
            let near = self.foe_near(0, c, ft.run_r + self.spread(i));
            self.squads[i].spec.speed = if near { ft.run } else { ft.walk };
        }
        self.places.ford = Some(f);
    }

    /// Whether a living man of a team other than `team` stands within `r` of `p`.
    fn foe_near(&self, team: Team, p: P, r: f64) -> bool {
        let mut found = false;
        self.grid.visit(p, r, |k| {
            let m = &self.soldiers[k];
            if !found && m.alive && self.squads[m.squad as usize].team != team && m.pos().dist(p) <= r {
                found = true;
            }
        });
        found
    }

    /// The ford's outcome (04-battle.md §8): once every group has come in and left the field (or perished), the
    /// warband wins with at least one person saved, and loses with none.
    pub(super) fn ford_outcome(&self) -> Option<(Team, OutcomeReason)> {
        let f = self.places.ford.as_ref()?;
        if !f.groups.iter().all(|g| g.squad.is_some() && g.done) {
            return None;
        }
        Some(if f.saved() > 0 { (0, OutcomeReason::Saved) } else { (1, OutcomeReason::NoneSaved) })
    }

    /// At nightfall: each company's leader lights his torch (02-look.md §3): ours in order along the line, at
    /// 0.7 s + 0.45 s × index (left to right across the army's heading), the enemy's all at 2.4 s.
    pub(super) fn light_torches(&mut self) {
        let n = self.tune.places.night.clone();
        let nf = self.tick;
        self.places.nightfall = Some(nf);
        self.places.torches = vec![Tick::MAX; self.squads.len()];
        let heading = self.armies[0].heading;
        let from = self.captain_at(0).unwrap_or(self.map.deploy[0]);
        let mut ours: Vec<(f64, usize)> = (0..self.squads.len())
            .filter(|&i| self.squads[i].team == 0 && self.squads[i].on_field() && self.squads[i].alive > 0)
            .map(|i| {
                let c = self.centre(i);
                // Its offset to the army's left.
                let left = P::new(0.0, 0.0).offset(heading, 0.0, 1.0);
                (-((c.x - from.x) * left.x + (c.y - from.y) * left.y), i)
            })
            .collect();
        ours.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        for (k, &(_, i)) in ours.iter().enumerate() {
            self.places.torches[i] = nf + ticks(n.torch_first_s + n.torch_step_s * k as f64);
        }
        for i in 0..self.squads.len() {
            if self.squads[i].team == 1 && self.squads[i].on_field() {
                self.places.torches[i] = nf + ticks(n.foe_torch_s);
            }
        }
    }

    /// Whether squad `i`'s leader carries a lit torch now.
    pub fn torch_lit(&self, i: usize) -> bool {
        self.night && self.places.torches.get(i).is_some_and(|&t| self.tick >= t) && self.squads[i].on_field() && self.squads[i].alive > 0
    }

    /// The man who carries a company's torch: its commander while he lives, else its living man of the lowest slot.
    pub fn torch_bearer(&self, i: usize) -> Option<usize> {
        let s = &self.squads[i];
        if let Some(k) = s.leader
            && self.soldiers[k].alive
        {
            return Some(k);
        }
        s.soldiers.iter().copied().filter(|&k| self.soldiers[k].alive).min_by_key(|&k| (self.soldiers[k].slot, k))
    }

    /// 03-land.md §8: burning houses light 4 tiles round them for both sides; at night, every lit torch of the other
    /// side gives its company away within its spread + 0.8.
    pub(super) fn place_sight(&self, team: Team, circles: &mut Vec<(P, f64)>) {
        let n = &self.tune.places.night;
        for h in &self.places.houses {
            if h.state == HouseState::Burning {
                circles.push((h.at, n.fire_sight));
            }
        }
        if self.night {
            for i in 0..self.squads.len() {
                if self.squads[i].team != team && self.torch_lit(i) {
                    circles.push((self.centre(i), self.spread(i) + n.torch_r));
                }
            }
        }
    }

    /// How dark it is, 0..1: easing toward 1 at 0.7/s after nightfall and back at 0.9/s after dawn (02-look.md §3).
    pub fn night_level(&self) -> f64 {
        let n = &self.tune.places.night;
        let since = |a: Tick| self.tick.saturating_sub(a) as f64 * DT;
        match (self.places.nightfall, self.places.dawn_at) {
            (None, _) => 0.0,
            (Some(nf), None) => 1.0 - libm::exp(-n.ease * since(nf)),
            (Some(nf), Some(d)) => (1.0 - libm::exp(-n.ease * d.saturating_sub(nf) as f64 * DT)) * libm::exp(-n.dawn_ease * since(d)),
        }
    }

    /// Every light on the field now (02-look.md §3 "Lights"): lit torches, burning houses (their reach growing over
    /// 6 s), smouldering ruins, the shrines' flames and the ford's wagons fire. `out` is cleared first.
    pub fn lights(&self, out: &mut Vec<Light>) {
        out.clear();
        let n = &self.tune.places.night;
        let t = &self.tune.places.town;
        for i in 0..self.squads.len() {
            if self.torch_lit(i)
                && let Some(k) = self.torch_bearer(i)
            {
                out.push(Light { at: self.soldiers[k].pos(), reach: n.torch[0], strength: n.torch[1], kind: LightKind::Torch, of: k as u32 });
            }
        }
        for (k, h) in self.places.houses.iter().enumerate() {
            let age = self.tick.saturating_sub(h.since) as f64 * DT;
            match h.state {
                HouseState::Burning => {
                    let grow = (age / n.house_grow_s).clamp(0.0, 1.0);
                    let reach = n.house[0] + (n.house[1] - n.house[0]) * grow;
                    out.push(Light { at: h.at, reach, strength: n.house[2], kind: LightKind::House, of: k as u32 });
                }
                HouseState::Fallen if age < t.smoulder_s => {
                    out.push(Light { at: h.at, reach: n.ruin[0], strength: n.ruin[1], kind: LightKind::Ruin, of: k as u32 });
                }
                _ => {}
            }
        }
        for s in &self.map.sites {
            if s.kind == SiteKind::Shrine {
                out.push(Light { at: s.at, reach: n.fire[0], strength: n.fire[1], kind: LightKind::Fire, of: s.id as u32 });
            }
        }
        if let Some(f) = &self.places.ford {
            out.push(Light { at: f.wagons, reach: n.fire[0], strength: n.fire[1], kind: LightKind::Fire, of: u32::MAX });
        }
    }

    /// The civilians: a company of folk (they take no orders, never fight and never break).
    pub fn civilian(&self, i: usize) -> bool {
        self.squads[i].kind == Kind::Folk
    }

    /// The places' state, hashed only where a battle has it, so replays without it keep their hashes.
    pub(super) fn hash_places(&self, f: &mut Fnv) {
        let p = &self.places;
        for h in &p.houses {
            f.u32(0x0b01);
            f.u32(h.state as u32);
            f.u32(h.since);
            f.u32(h.people as u32);
        }
        if let Some(fd) = &p.ford {
            for g in &fd.groups {
                f.u32(0x0b02);
                f.u32(g.squad.map_or(u32::MAX, |s| s as u32));
                f.u32(g.done as u32 | (g.saved as u32) << 1);
            }
            for w in &fd.waves {
                f.u32(0x0b03);
                f.u32(w.squads.len() as u32);
            }
        }
        if let Some(nf) = p.nightfall {
            f.u32(0x0b04);
            f.u32(nf);
            f.u32(p.relief_sent as u32);
            for &t in &p.torches {
                f.u32(t);
            }
        }
        if !p.freed.is_empty() || !p.coming.is_empty() {
            f.u32(0x0b05);
            f.u32(p.freed.len() as u32);
            f.u32(p.coming.len() as u32);
        }
    }
}
