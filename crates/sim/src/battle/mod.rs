//! One real-time battle at a fixed 30 Hz (docs/spec/04-battle.md §1). Nothing changes a battle except a
//! `Command` through the order queue, so a replay is the seed plus the log.
//!
//! The tick follows §1's order: rebucket, squads (anchors only), soldiers (strikes collected), resolve, burn
//! (day 4), arrows, hooks, cull, sites, morale, sight every 8 ticks, outcome. Soldiers read the positions of the
//! tick's start and move together afterwards, so no side gains from stepping first (§10 "Open issue").
//!
//! Choices the spec leaves open are in out/decisions-battle.md.

mod anchor;
mod combat;
mod front;
mod grid;
mod men;
mod morale;
mod order;
mod orders;
mod outcome;
mod places;
mod replay;
mod ride;
mod setup;
mod sight;
#[cfg(test)]
mod tests;
mod works;

pub mod checks;
pub mod place_checks;

pub use crate::contracts::Work as WorkKind;
pub use front::line_spots;
pub use order::{How, Order, Pace, Pending, Priority, Rules, Shape, Stance, When};
pub use outcome::OutcomeReason;
pub use places::{Ford, Group, House, HouseState, Light, LightKind, Places, Wave};
pub use replay::{BotSlot, Replay};
pub use setup::{Company, Setup};
pub use works::Work;

use grid::Grid;

use crate::contracts::{Command, EventCode, Kind, P, Refusal, SquadId, TICK_HZ, Team, Tick, Way};
use crate::hash::Fnv;
use crate::map::{self, BattleMap, MapKind, MapOpts, Tile, path};
use crate::rng::jitter;
use crate::tune::{KindSpec, Tune};
use crate::units::Unit;

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

/// The army's formation on the march (04-battle.md §3d).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Formation {
    Line,
    Column,
}

/// Per team: the formation heading and the column/line state of the army following its captain (§3d).
#[derive(Clone, Debug)]
pub struct Army {
    /// The eased formation heading the stations are laid out on.
    pub heading: f64,
    /// Where the heading is easing toward.
    pub aim: f64,
    /// The captain's position when the heading was last re-aimed.
    pub aim_from: P,
    pub formation: Formation,
    halted: f64,
    marched: f64,
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
    /// The tick of the last hit taken, `Tick::MAX` if never.
    pub hit_at: Tick,
    /// The tick he died, `Tick::MAX` while alive. A man who is not alive with `died_at == Tick::MAX` left the
    /// field with his fleeing company.
    pub died_at: Tick,
    /// The foe he strikes or shoots at (a soldier index).
    pub target: Option<usize>,
    /// Seconds until his next blow.
    pub cooldown: f64,
    /// A charge is ready (regained after 3 s out of contact).
    pub charge_ready: bool,
    /// Seconds since he was last in contact.
    pub since_contact: f64,
    /// In contact (a foe in reach) or shooting this tick: the "share of men fighting".
    pub engaged: bool,
    /// His heading, for beasts' turn limit; a hunting breather keeps it on his prey.
    pub heading: f64,
    /// A breather's hunt (04-battle.md §5 "Drake breath"): the tick his current cycle began (rear, jet, bite,
    /// spring back), `Tick::MAX` when none runs. His prey is `target`.
    pub cycle: Tick,
    route: Vec<P>,
    route_goal: P,
    route_at: Tick,
}

impl Soldier {
    pub fn pos(&self) -> P {
        P::new(self.x, self.y)
    }
}

/// The captain's ride state (04-battle.md §5 "The captain's ride").
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RideState {
    pub target: Option<SquadId>,
    pub repick_at: Tick,
    /// Out of the fight, riding behind the army until healed.
    pub out: bool,
    /// Reached the flank point and gone in.
    pub went_in: bool,
}

#[derive(Clone, Debug)]
pub struct Squad {
    pub id: SquadId,
    pub team: Team,
    /// The base kind the rules read (a broodlord is his side's captain, a troll a beast).
    pub kind: Kind,
    /// Which unit the company is (04-battle.md §2 "Unit overrides"): the view draws by it.
    pub unit: Unit,
    /// The commander's name; empty for a company without one.
    pub name: String,
    pub spec: KindSpec,
    pub rank: u8,
    /// Every man of the company, living or dead, by soldier index.
    pub soldiers: Vec<usize>,
    pub full: u16,
    /// The anchor: the centre of the front rank.
    pub x: f64,
    pub y: f64,
    pub facing: f64,
    /// The verb (08-orders.md): what it is doing.
    pub order: Order,
    /// Its standing way (stance, pace, shape, frontage, pursuit, priority): kept from order to order until changed.
    pub how: How,
    /// Deeds waiting for their trigger.
    pub queue: Vec<Pending>,
    /// The current order has completed (for `When::Done`).
    pub done: bool,
    /// Where it was posted: a defensive stance never leaves it by more than the leash.
    pub post: P,
    pub state: SquadState,
    pub morale: f64,
    pub max_morale: f64,
    /// Detached from the army by an order of its own, until recalled.
    pub detached: bool,
    /// The current order's frontage from a drawn line.
    pub files: Option<u16>,
    /// Its fixed place around the captain in line: (ahead, to the left), 04-battle.md §3d.
    pub station: (f64, f64),
    /// Its fixed place in column.
    pub column: (f64, f64),
    /// The commander's way.
    pub way: Option<Way>,
    /// Freed men: the reserve.
    pub freed: bool,
    /// The commander's look (a campaign's person), 0 to derive it from the id. Not hashed: it changes no rule.
    pub face: u32,
    /// Held back as the reserve (08-orders.md §3): its station by the captain in line, (ahead, to the left).
    pub reserve: Option<(f64, f64)>,
    /// At work on a field work this tick: it cannot fight (08-orders.md §7).
    pub working: bool,
    /// Created with a commander (slot 0 is his, behind the ranks).
    pub commanded: bool,
    /// The commander's soldier index while he lives.
    pub leader: Option<usize>,
    pub commander_fell: bool,
    /// Its commander already pulled it off the field once.
    pub saved: bool,
    pub last_stand: bool,
    /// Seconds since the last enemy within the rally radius.
    pub quiet: f64,
    pub kills: u32,
    /// Men alive.
    pub alive: u16,
    /// The foe squad it is engaged with this tick.
    pub threat: Option<SquadId>,
    pub ride: RideState,
    path: Vec<P>,
    path_goal: P,
    replan_at: Tick,
    /// Follower hysteresis: marching to its station.
    following: bool,
    /// The captain's hp, sampled every half second, for "lost 20% within 2 s".
    hp_ring: [f64; 4],
    charge_event: Tick,
    volley_event: Tick,
}

impl Squad {
    /// Still on the field: not fled and not destroyed.
    pub fn on_field(&self) -> bool {
        !matches!(self.state, SquadState::Fled | SquadState::Destroyed)
    }

    /// On the field and not routing: it can take orders and it holds ground.
    pub fn standing(&self) -> bool {
        self.on_field() && self.state != SquadState::Routing
    }

    pub fn morale_share(&self) -> f64 {
        if self.max_morale > 0.0 { (self.morale / self.max_morale).clamp(0.0, 1.0) } else { 0.0 }
    }

    /// Men alive × worth: the time-out score's part.
    pub fn strength(&self, tune: &Tune) -> f64 {
        self.alive as f64 * self.spec.worth(&tune.rank, self.rank)
    }

    pub fn speed(&self, tune: &Tune) -> f64 {
        let way = if self.way() == Some(Way::Stubborn) { tune.ways.stubborn_speed } else { 1.0 };
        self.spec.speed * (1.0 + tune.rank.speed * self.rank as f64) * way
    }
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

/// An arrow in flight: it homes on its target and lands after `flight` seconds (§5 "Ranged").
#[derive(Clone, Debug)]
pub struct Arrow {
    pub from: P,
    pub x: f64,
    pub y: f64,
    pub target: usize,
    pub shooter: usize,
    pub dmg: f64,
    pub t: f64,
    pub flight: f64,
}

/// A site's state in this battle: its owner and the capture in progress (§8 "Holdfast").
#[derive(Clone, Debug, PartialEq)]
pub struct SiteState {
    pub owner: Option<Team>,
    /// 0..1 toward `by`.
    pub progress: f64,
    pub by: Option<Team>,
}

/// A blow collected in step 3 and landed in step 4.
#[derive(Clone, Copy, Debug)]
struct Strike {
    attacker: usize,
    victim: usize,
    dmg: f64,
    charge: bool,
    /// A breath pulse: its harm is flat, ignoring armour and every multiplier (§5 "Drake breath").
    breath: bool,
}

/// Counts of what the blight's rules did, for the harness (AGENTS.md rule 4). Not state: never read by the rules
/// and not hashed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tally {
    /// Jets breathed (`Breath` events).
    pub jets: u64,
    /// Breath pulses that harmed a man, the harm, and the men they killed.
    pub burns: u64,
    pub burn_harm: f64,
    pub burn_kills: u64,
    /// Morale lost to breath, summed over companies.
    pub scorch: f64,
    /// Drake bites (blows struck at the bite of a cycle).
    pub bites: u64,
    /// Blows with `impact`: started, landed, and missed (the victim gone out of reach, or either man fallen).
    pub impacts: u64,
    pub landed: u64,
    pub missed: u64,
    /// Ticks a company pressed forward on a drake.
    pub presses: u64,
    /// Field works (08-orders.md §7): built, torn down, the harm foes did them, and builders interrupted.
    pub built: u64,
    pub razed: u64,
    pub raze_harm: f64,
    pub interrupts: u64,
    /// Arrows loosed.
    pub arrows: u64,
    /// Charging blows, their harm, and those that met stakes.
    pub charge_harm: f64,
    pub staked: u64,
}

/// A blow started but not yet landed (myth rule `impact`, §5): it lands at `lands` if its victim is still in
/// reach, cleaving then.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Blow {
    pub attacker: usize,
    pub victim: usize,
    pub dmg: f64,
    pub charge: bool,
    pub lands: Tick,
}

/// What each tick measures once for every squad (not state: recomputed from it).
#[derive(Clone, Debug, Default)]
struct Scratch {
    centre: Vec<P>,
    spread: Vec<f64>,
    slot_centre: Vec<P>,
    loose: Vec<f64>,
    attackers: Vec<u32>,
    shot: Vec<bool>,
    flanked: Vec<bool>,
    /// The foe squad a follower turns on to defend its captain (§3d), or an escort its ward.
    defend: Vec<Option<SquadId>>,
    /// Morale each company loses to breath this tick (1.6·steadiness per pulse that catches it).
    scorch: Vec<f64>,
    /// Where each breather's prey stood at the tick's start, by squad: the spots its pack-mates have taken.
    prey: Vec<Vec<(usize, P)>>,
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
    pub arrows: Vec<Arrow>,
    /// Blows started and not yet landed (`impact`).
    pub blows: Vec<Blow>,
    pub tally: Tally,
    pub armies: [Army; 2],
    pub sites: Vec<SiteState>,
    /// Night has fallen (day 4 sets it; sight ×0.6 already reads it).
    pub night: bool,
    /// The night is over (a campaign battle's dawn).
    pub dawn: bool,
    /// Held before contact (08-orders.md §8): the clock runs, nobody advances further than `held_depth` from
    /// their deploy point until "advance".
    pub held: [bool; 2],
    /// Field works laid out, building, standing or torn down (08-orders.md §7), by id.
    pub works: Vec<Work>,
    /// Deeds for each army waiting for their trigger (08-orders.md §6).
    pub waiting: [Vec<Pending>; 2],
    /// Day 4's places: the town's houses, the ford, the night's torches and relief, the freed.
    pub places: Places,
    decided: Option<(Team, OutcomeReason)>,
    fog: [Vec<u8>; 2],
    /// A waiting deed is being carried out: its orders keep the queues they land in.
    releasing: bool,
    /// The squads given an order since this was last cleared (what a `With` applies its modifiers to).
    touched: Vec<usize>,
    /// Commands waiting for their tick, kept in arrival order.
    queue: Vec<Command>,
    grid: Grid,
    strikes: Vec<Strike>,
    scratch: Scratch,
    max_radius: f64,
    /// Each side had a captain at the start.
    had_captain: [bool; 2],
}

impl Battle {
    pub fn new(seed: u32, opts: MapOpts, setup: &Setup, tune: Tune) -> Battle {
        Battle::on_map(seed, map::generate(seed, opts), setup, tune)
    }

    /// A battle on a map made elsewhere (the campaign's road, docs/spec/03-land.md §9).
    pub fn on_map(seed: u32, map: BattleMap, setup: &Setup, tune: Tune) -> Battle {
        let tiles = map.tiles.len();
        let sites = map.sites.iter().map(|s| SiteState { owner: s.owner, progress: 0.0, by: None }).collect();
        let army = |p: P| Army { heading: 0.0, aim: 0.0, aim_from: p, formation: Formation::Line, halted: 0.0, marched: 0.0 };
        let grid = Grid::new(map.w as usize, map.h as usize);
        let mut b = Battle {
            seed,
            tick: 0,
            armies: [army(map.deploy[0]), army(map.deploy[1])],
            map,
            tune,
            squads: Vec::new(),
            soldiers: Vec::new(),
            log: Vec::new(),
            refusals: Vec::new(),
            events: Vec::new(),
            arrows: Vec::new(),
            blows: Vec::new(),
            tally: Tally::default(),
            sites,
            night: false,
            dawn: false,
            held: [setup.held; 2],
            works: Vec::new(),
            waiting: [Vec::new(), Vec::new()],
            places: Places::default(),
            decided: None,
            fog: [vec![0; tiles], vec![0; tiles]],
            releasing: false,
            touched: Vec::new(),
            queue: Vec::new(),
            grid,
            strikes: Vec::new(),
            scratch: Scratch::default(),
            max_radius: 0.0,
            had_captain: [false; 2],
        };
        setup.deploy(&mut b);
        b.max_radius = b.squads.iter().map(|s| s.spec.radius).fold(0.0, f64::max);
        for team in 0..2 {
            b.had_captain[team] = b.captain_of(team as Team).is_some();
        }
        b.init_places();
        // Blows aren't synchronised: each man's first cooldown is a random fraction of his interval (§5).
        for k in 0..b.soldiers.len() {
            let s = &b.squads[b.soldiers[k].squad as usize];
            b.soldiers[k].cooldown = s.spec.interval * jitter(b.seed, k as u32, SALT_COOLDOWN0);
        }
        b.rebucket();
        b.measure();
        b.update_sight();
        b
    }

    pub fn time(&self) -> f64 {
        self.tick as f64 * DT
    }

    /// One byte per map tile for `team`: 0 never seen, 1 seen before, 2 in sight (03-land.md §8).
    pub fn fog(&self, team: Team) -> &[u8] {
        &self.fog[team as usize & 1]
    }

    /// Whether `team` sees the tile under `p` now.
    pub fn sees(&self, team: Team, p: P) -> bool {
        let (x, y) = (p.x.floor() as i32, p.y.floor() as i32);
        self.map.idx(x, y).is_some_and(|i| self.fog[team as usize & 1][i] == 2)
    }

    /// The winner and why, once the battle is decided (04-battle.md §8).
    pub fn outcome(&self) -> Option<(Team, OutcomeReason)> {
        self.decided
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
        // Companies joining the battle now (the ford's civilians and raiders, the night's relief, the freed).
        self.spawn_places();
        // 1. rebucket: the neighbour grid by counting sort, and what each squad measures once.
        self.rebucket();
        self.measure();
        // 2. updateSquad: pending orders, the armies' heading and formation, engagement, then the anchors.
        self.release_pending();
        self.update_armies();
        self.ride_wounds();
        self.engage_all();
        for i in 0..self.squads.len() {
            self.update_squad(i);
        }
        // 3. updateSoldier: targets and steering; strikes are collected, not applied.
        self.update_soldiers();
        // 4. resolve: every blow lands together, after all movement; then foes tear at the field works.
        self.resolve();
        self.raze_works();
        // 5. burn: the village under the torch burns in step 9, with the town.
        // 6. arrows.
        self.update_arrows();
        // 7. hooks: beasts trampling when they flee.
        self.trample();
        // 8. cull: the dead leave the ranks, which close up.
        self.cull();
        // 9. sites, the town's fires, the ford and the night.
        self.update_sites();
        self.update_town();
        self.update_ford();
        self.update_night();
        // 10. morale.
        self.update_morale();
        // 11. sight, every 8 ticks.
        self.tick += 1;
        if self.tick.is_multiple_of(self.tune.sight.every.max(1)) {
            self.update_sight();
        }
        // 12. outcome.
        self.check_outcome();
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
            self.touched.clear();
            if let Err((at, why)) = self.obey(cmd.team, &cmd.deed) {
                self.refuse(cmd.team, at, why);
            }
            self.log.push(Command { tick: self.tick, ..cmd });
        }
        self.touched.clear();
    }

    fn event(&mut self, code: EventCode, at: P, a: u32, b: u32) {
        self.events.push(Event { code, tick: self.tick, at, a, b });
    }

    /// The living captain's squad index for `team`.
    pub fn captain_of(&self, team: Team) -> Option<usize> {
        self.squads.iter().position(|s| s.team == team && s.kind == Kind::Captain && s.on_field())
    }

    /// The captain's man's position, if he lives.
    pub fn captain_at(&self, team: Team) -> Option<P> {
        self.captain_of(team).map(|c| self.soldiers[self.squads[c].soldiers[0]].pos())
    }

    /// The centroid of squad `j`'s living men (its anchor if none live), as measured this tick.
    pub fn centre(&self, j: usize) -> P {
        self.scratch.centre.get(j).copied().unwrap_or(P::new(self.squads[j].x, self.squads[j].y))
    }

    /// How far squad `j`'s men stand from their centroid at most.
    pub fn spread(&self, j: usize) -> f64 {
        self.scratch.spread.get(j).copied().unwrap_or(0.0)
    }

    /// The mean distance of squad `j`'s men from their slots.
    pub fn looseness(&self, j: usize) -> f64 {
        self.scratch.loose.get(j).copied().unwrap_or(0.0)
    }

    /// Walkable for a man: passable ground. A built barricade's tiles are rock and a bridge's road, so the
    /// tiles answer for the field works (08-orders.md §7).
    pub fn walkable(&self, p: P) -> bool {
        self.map.passable(p)
    }

    /// The enemy-commander rules (§5: −25 on his fall, the 0.5 pull-out, −12) hold for team 1, and for both sides
    /// of an open-field battle, so a mirror match stays fair.
    fn foe_rules(&self, team: Team) -> bool {
        team == 1 || self.map.kind == MapKind::Field
    }

    /// A routing company leaves the map at home, except the defenders of a holdfast, who make a last stand.
    fn flees(&self, team: Team) -> bool {
        !(matches!(self.map.kind, MapKind::Keep | MapKind::Town) && team == 1)
    }

    /// 04-battle.md §3a: man `slot` of a squad with `n` men alive, rotated by its facing about the anchor.
    /// Slot 0 of a commanded company is the commander's spot, `0.8 + (ranks−1)·0.72` behind the anchor.
    /// The shape, frontage and spacing come from the order's modifiers (08-orders.md §3 "form").
    pub fn slot(&self, s: &Squad, slot: u16, n: usize) -> P {
        let mv = &self.tune.movement;
        let anchor = P::new(s.x, s.y);
        let ranks_men = if s.leader.is_some() { n.saturating_sub(1) } else { n }.max(1);
        let o = &self.tune.orders;
        let by_shape = match s.how.shape {
            Shape::Line | Shape::ShieldWall => Some((ranks_men as u16).div_ceil(o.line_ranks.max(1))),
            Shape::Column => Some(o.column_files),
            _ => None,
        };
        let f = s.files.or(s.how.files).or(by_shape).or(s.spec.frontage).unwrap_or(if s.kind == Kind::Horse { mv.frontage_horse } else { mv.frontage });
        let f = (f as usize).max(1);
        let room = s.spec.radius / mv.base_radius;
        let spacing = s.how.spacing.or((s.how.shape == Shape::ShieldWall).then_some(mv.tight_spacing)).unwrap_or(1.0);
        let gap = mv.file_gap * room * spacing;
        let ranks = ranks_men.div_ceil(f);
        let block = matches!(s.how.shape, Shape::Block | Shape::Line | Shape::Column | Shape::ShieldWall);
        if s.commanded && slot == 0 {
            let back = match s.how.shape {
                _ if block => mv.commander_back + (ranks as f64 - 1.0) * gap,
                Shape::Wedge => mv.commander_back + (ranks_men as f64).sqrt().ceil() * gap,
                _ => ring_radius(ranks_men, gap),
            };
            return anchor.offset(s.facing, -back, 0.0);
        }
        let i = if s.commanded { slot as usize - 1 } else { slot as usize };
        match s.how.shape {
            _ if block && s.spec.pack => {
                // A pack (§3a): files ×1.15, each rank's ends pushed back, and a fixed jitter per slot.
                let pk = &self.tune.pack;
                let (rank, file) = (i / f, i % f);
                let in_rank = f.min(ranks_men.saturating_sub(rank * f)).max(1);
                let end = in_rank > 1 && (file == 0 || file == in_rank - 1);
                let id = (s.id as u32) << 16 | slot as u32;
                let j = |salt: u32| (jitter(self.seed, id, salt) * 2.0 - 1.0) * pk.jitter;
                let lateral = (file as f64 - (in_rank as f64 - 1.0) / 2.0) * gap * pk.files + j(SALT_PACK_X);
                let back = rank as f64 * gap + if end { pk.ends_back } else { 0.0 } + j(SALT_PACK_Y);
                anchor.offset(s.facing, -back, lateral)
            }
            _ if block => {
                let (rank, file) = (i / f, i % f);
                let in_rank = f.min(ranks_men.saturating_sub(rank * f)).max(1);
                let lateral = (file as f64 - (in_rank as f64 - 1.0) / 2.0) * gap;
                anchor.offset(s.facing, -(rank as f64) * gap, lateral)
            }
            Shape::Wedge => {
                let r = (i as f64).sqrt().floor() as usize;
                let file = i - r * r;
                anchor.offset(s.facing, -(r as f64) * gap, (file as f64 - r as f64) * gap)
            }
            _ => {
                let radius = ring_radius(ranks_men, gap);
                let centre = anchor.offset(s.facing, -radius, 0.0);
                let a = s.facing + std::f64::consts::TAU * (i % ranks_men) as f64 / ranks_men as f64;
                centre.offset(a, radius, 0.0)
            }
        }
    }

    /// FNV-1a over the tick and all squad, soldier, arrow and site state.
    pub fn hash(&self) -> u64 {
        let mut f = Fnv::default();
        f.u32(self.tick);
        for s in &self.squads {
            f.u32(s.id as u32);
            f.u32(s.team as u32);
            f.u32(s.kind as u32);
            f.u32(s.unit as u32);
            f.u32(s.state as u32);
            f.u32(s.detached as u32);
            f.u32(s.alive as u32);
            f.u32(s.threat.map_or(u32::MAX, |t| t as u32));
            for v in [s.x, s.y, s.facing, s.morale, s.quiet] {
                f.f64(v);
            }
            hash_order(&mut f, &s.order);
            f.u32(s.queue.len() as u32);
            // The order language's state, hashed only where it differs from 04-battle's, so replays without it
            // keep their hashes.
            if s.how != How::default() {
                f.u32(0x0a11);
                hash_how(&mut f, &s.how);
            }
            if let Some((a, l)) = s.reserve {
                f.u32(0x0a12);
                f.f64(a);
                f.f64(l);
            }
            if s.working {
                f.u32(0x0a13);
            }
        }
        for m in &self.soldiers {
            f.u32(m.alive as u32);
            f.u32(m.slot as u32);
            f.u32(m.target.map_or(u32::MAX, |t| t as u32));
            f.u32(m.cycle);
            for v in [m.x, m.y, m.vx, m.vy, m.pace, m.hp, m.cooldown] {
                f.f64(v);
            }
        }
        for a in &self.arrows {
            f.u32(a.target as u32);
            f.f64(a.x);
            f.f64(a.y);
        }
        for w in &self.blows {
            f.u32(w.attacker as u32);
            f.u32(w.victim as u32);
            f.u32(w.lands);
            f.f64(w.dmg);
        }
        for s in &self.sites {
            f.u32(s.owner.map_or(9, |t| t as u32));
            f.f64(s.progress);
        }
        for a in &self.armies {
            f.f64(a.heading);
            f.u32(a.formation as u32);
        }
        if self.held != [false; 2] || self.dawn {
            f.u32(0x0a14 | (self.held[0] as u32) << 16 | (self.held[1] as u32) << 17 | (self.dawn as u32) << 18);
        }
        for q in &self.waiting {
            if !q.is_empty() {
                f.u32(0x0a15);
                f.u32(q.len() as u32);
            }
        }
        for w in &self.works {
            f.u32(0x0a16);
            f.u32(w.id as u32);
            f.u32(w.kind as u32);
            f.u32(w.team as u32);
            f.u32(w.razed as u32);
            for v in [w.at.x, w.at.y, w.built, w.hp] {
                f.f64(v);
            }
        }
        self.hash_places(&mut f);
        f.u32(self.decided.map_or(0, |(t, r)| 1 + t as u32 * 16 + r as u32));
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
            .zip(&self.sites)
            .map(|(s, st)| {
                let owner = match st.owner {
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
            let a = &self.armies[team as usize];
            let rows: Vec<String> = self.squads.iter().filter(|s| s.team == team).map(|s| self.describe_squad(s)).collect();
            out += &format!("{label} ({:?}, heading {:.2}):\n  {}\n", a.formation, a.heading, rows.join("\n  "));
        }
        for (team, q) in self.waiting.iter().enumerate() {
            if !q.is_empty() {
                let label = if team == 0 { "OURS" } else { "FOES" };
                let deeds: Vec<String> = q.iter().map(|p| format!("{:?} -> {}", p.when, crate::text::format(&p.deed))).collect();
                out += &format!("{label} ARMY WAITS: {}\n", deeds.join(" | "));
            }
        }
        if self.held != [false; 2] {
            out += &format!("HELD: {:?} (until advance)\n", self.held);
        }
        for w in &self.works {
            let state = if w.razed {
                "razed".to_string()
            } else if w.built >= 1.0 {
                "standing".to_string()
            } else {
                format!("{:.0}% built", w.built * 100.0)
            };
            out += &format!("WORK {} {:?} team {} ({:.1},{:.1}) face {:.2} {state} hp {:.0}/{:.0}\n", w.id, w.kind, w.team, w.at.x, w.at.y, w.face, w.hp, w.max_hp);
        }
        for r in &self.refusals {
            out += &format!("REFUSED tick {} at ({:.1},{:.1}): {}\n", r.tick, r.at.x, r.at.y, r.why);
        }
        if let Some((team, why)) = self.decided {
            out += &format!("OUTCOME: team {team} wins ({why:?})\n");
        }
        out
    }

    fn describe_squad(&self, s: &Squad) -> String {
        let name = if s.name.is_empty() { format!("E{}", s.id) } else { s.name.clone() };
        let order = match &s.order {
            Order::Hold { .. } => "hold".to_string(),
            Order::Move { to, fight, .. } => format!("move ({:.1},{:.1}){}", to.x, to.y, if *fight { " fight" } else { "" }),
            Order::Attack { target, .. } => format!("attack {target}"),
            Order::Take { site, .. } => format!("take site {site}"),
            Order::Follow => "follow".to_string(),
            Order::Guard { ward } => format!("guard {ward}"),
            Order::Recall { .. } => "recall".to_string(),
            Order::Retreat => "retreat".to_string(),
            Order::Ride => "ride".to_string(),
            Order::Screen { ward, from } => format!("screen {ward}{}", from.map_or(String::new(), |f| format!(" from {f}"))),
            Order::Charge { target } => format!("charge {target}"),
            Order::Withdraw { to } => format!("withdraw ({:.1},{:.1})", to.x, to.y),
            Order::Regroup { to } => format!("regroup ({:.1},{:.1})", to.x, to.y),
            Order::Build { work, .. } => format!("build work {work}{}", if s.working { " (working)" } else { "" }),
        };
        let detached = if s.detached { " detached" } else { "" };
        let reserve = if s.reserve.is_some() { " reserve" } else { "" };
        let queued = if s.queue.is_empty() { String::new() } else { format!(" +{} queued", s.queue.len()) };
        let way = if s.how == How::default() { String::new() } else { format!(" [{}]", describe_how(&s.how)) };
        format!(
            "{} {name} {} {}/{} ({:.1},{:.1}) face {:.2} {:?} morale {:.0} {order}{detached}{reserve}{way}{queued}",
            s.id,
            s.unit.name(),
            s.alive,
            s.full,
            s.x,
            s.y,
            s.facing,
            s.state,
            s.morale
        )
    }

    /// The nearest open tile centre to `p` within the front's snap radius, or `p` if it is open. A point off the
    /// map is first brought inside it (by the men's edge margin): a front's end or a station can fall outside, and
    /// an anchor sent there walks off the map, where its men cannot follow and the cohesion gate holds it for good.
    pub fn open_near(&self, p: P) -> P {
        let m = self.tune.movement.edge_margin;
        let p = P::new(p.x.clamp(m, self.map.wf() - m), p.y.clamp(m, self.map.hf() - m));
        if self.walkable(p) {
            return p;
        }
        let (cx, cy) = (p.x.floor() as i32, p.y.floor() as i32);
        let mut best: Option<(f64, i32, P)> = None;
        let r = self.tune.front.snap_r;
        for y in cy - r..=cy + r {
            for x in cx - r..=cx + r {
                let Some(i) = self.map.idx(x, y) else { continue };
                if !self.map.tiles[i].passable() {
                    continue;
                }
                let q = P::new(x as f64 + 0.5, y as f64 + 0.5);
                let d = q.dist(p);
                if best.is_none_or(|(bd, bi, _)| d < bd || (d == bd && (i as i32) < bi)) {
                    best = Some((d, i as i32, q));
                }
            }
        }
        best.map_or(p, |(_, _, q)| q)
    }

    /// Whether a man can walk the straight line from `a` to `b`.
    pub(crate) fn line_walkable(&self, a: P, b: P) -> bool {
        path::line_walkable(&self.map, a, b)
    }

    /// The slope pace for a step along `dir` from `p` (03-land.md §1): climbing slows, never below 0.6; no
    /// downhill bonus. Forest ×0.7.
    pub(crate) fn ground_pace(&self, p: P, dir: P) -> f64 {
        let mv = &self.tune.movement;
        let forest = if self.map.tile_at(p) == Tile::Forest { mv.forest_pace } else { 1.0 };
        let ahead = P::new(p.x + dir.x * mv.slope_probe, p.y + dir.y * mv.slope_probe);
        let slope = (self.map.height_at(ahead.x, ahead.y) - self.map.height_at(p.x, p.y)) / mv.slope_probe;
        let hill = if slope > 0.0 { (1.0 - mv.slope_pace * slope).max(mv.slope_min) } else { 1.0 };
        forest * hill
    }

    pub(crate) fn height(&self, p: P) -> f64 {
        self.map.height_at(p.x, p.y)
    }
}

/// A ring's radius for `n` men `gap` apart round its rim.
fn ring_radius(n: usize, gap: f64) -> f64 {
    (n as f64 * gap / std::f64::consts::TAU).max(gap)
}

/// A company's standing way, in words, for `describe`.
fn describe_how(h: &How) -> String {
    let mut parts: Vec<String> = Vec::new();
    if h.stance != Stance::Normal {
        parts.push(format!("{:?}", h.stance).to_lowercase());
    }
    if let Some(p) = h.pace {
        parts.push(format!("{p:?}").to_lowercase());
    }
    if h.shape != Shape::Block {
        parts.push(format!("{:?}", h.shape).to_lowercase());
    }
    if let Some(n) = h.files {
        parts.push(format!("{n} files"));
    }
    if let Some(k) = h.spacing {
        parts.push(format!("spacing {k}"));
    }
    if let Some(p) = h.pursue {
        parts.push(if p { "pursue".into() } else { "no pursuit".into() });
    }
    if h.priority != Priority::Nearest {
        parts.push(format!("{:?}", h.priority).to_lowercase());
    }
    parts.join(", ")
}

fn hash_how(f: &mut Fnv, h: &How) {
    f.u32(h.stance as u32);
    f.u32(h.pursue.map_or(2, |p| p as u32));
    f.u32(h.pace.map_or(9, |p| p as u32));
    f.u32(h.shape as u32);
    f.u32(h.files.map_or(u32::MAX, |n| n as u32));
    f.f64(h.spacing.unwrap_or(f64::MAX));
    let (code, arg) = match h.priority {
        Priority::Nearest => (0, 0),
        Priority::Kind { kind } => (1, kind as u32),
        Priority::Unit { unit } => (2, unit as u32),
        Priority::Ranged => (3, 0),
        Priority::Shaken => (4, 0),
        Priority::Weakest => (5, 0),
        Priority::Strongest => (6, 0),
        Priority::Commander => (7, 0),
        Priority::Attacking { id } => (8, id as u32),
        Priority::Squad { id } => (9, id as u32),
    };
    f.u32(code);
    f.u32(arg);
}

fn hash_order(f: &mut Fnv, o: &Order) {
    let pts = |f: &mut Fnv, ps: &[P]| {
        for p in ps {
            f.f64(p.x);
            f.f64(p.y);
        }
    };
    match o {
        Order::Hold { face } => {
            f.u32(0);
            f.f64(face.unwrap_or(f64::MAX));
        }
        Order::Move { to, via, fight, face } => {
            f.u32(1);
            pts(f, std::slice::from_ref(to));
            pts(f, via);
            f.u32(*fight as u32);
            f.f64(face.unwrap_or(f64::MAX));
        }
        Order::Attack { target, via } => {
            f.u32(2);
            f.u32(*target as u32);
            pts(f, via);
        }
        Order::Take { site, via } => {
            f.u32(3);
            f.u32(*site as u32);
            pts(f, via);
        }
        Order::Follow => f.u32(4),
        Order::Guard { ward } => {
            f.u32(5);
            f.u32(*ward as u32);
        }
        Order::Recall { until } => {
            f.u32(6);
            f.u32(*until);
        }
        Order::Retreat => f.u32(7),
        Order::Ride => f.u32(8),
        Order::Screen { ward, from } => {
            f.u32(9);
            f.u32(*ward as u32);
            f.u32(from.map_or(u32::MAX, |x| x as u32));
        }
        Order::Charge { target } => {
            f.u32(10);
            f.u32(*target as u32);
        }
        Order::Withdraw { to } => {
            f.u32(11);
            pts(f, std::slice::from_ref(to));
        }
        Order::Regroup { to } => {
            f.u32(12);
            pts(f, std::slice::from_ref(to));
        }
        Order::Build { work, at } => {
            f.u32(13);
            f.u32(*work as u32);
            pts(f, std::slice::from_ref(at));
        }
    }
}

/// `hash32` salts for the tick's per-entity jitter.
const SALT_COOLDOWN0: u32 = 101;
const SALT_COOLDOWN: u32 = 102;
const SALT_TARGET: u32 = 103;
const SALT_SCATTER_X: u32 = 104;
const SALT_SCATTER_Y: u32 = 105;
const SALT_PACK_X: u32 = 106;
const SALT_PACK_Y: u32 = 107;
