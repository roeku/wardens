//! Shared contracts between the Rust sim and the TypeScript view/input/voice/sound.
//! Agree on these on day 1, before the work splits. Mirrored in contracts.ts; keep them in step.
//! Units: tiles (x east, y south), seconds, radians (0 = +x, counter-clockwise toward -y is NOT used:
//! facing is atan2(dy, dx) in sim coordinates, y pointing south).

use serde::{Deserialize, Serialize};

pub const TICK_HZ: u32 = 30;

pub type Tick = u32;
pub type Team = u8; // 0 = player, 1 = enemy
pub type SquadId = u16;
pub type SiteId = u16;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Kind { Spear, Shield, Archer, Horse, Levy, Folk, Captain, Beast }

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Way { Stubborn, Reckless, Steady, Veteran }

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct P { pub x: f64, pub y: f64 }

/// Who an order is for. `Army` means the captain leads and companies keep stations;
/// a company id means a detached order (the company plants an order flag).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Who {
    Army,
    Squad { id: SquadId },
    /// Several companies at once, each as if ordered alone (08-orders §2).
    Squads { ids: Vec<SquadId> },
}

// ---------------------------------------------------------------------------------------------
// The order language (docs/spec/08-orders.md): modifiers and triggers wrap any deed, so new
// verbs, ways and timings compose instead of multiplying variants.
// ---------------------------------------------------------------------------------------------

/// How an order is carried out (08-orders §5). Unset fields keep the company's current way.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct How {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stance: Option<Stance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pace: Option<Pace>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<Shape>,
    /// Files in the front rank: a thin line is many, a deep one few.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<u16>,
    /// Chase routers (true) or let them go (false).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pursue: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Stance { Normal, Aggressive, Defensive, HoldFire, Skirmish }

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Pace { Walk, Quick, Double }

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Shape { Line, Column, Wedge, Square, ShieldWall, Loose, Tight }

/// Which enemy a company goes for first (08-orders §4–§5). `unit` is `sim::units::Unit::id()`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "by", rename_all = "snake_case")]
pub enum Priority { Nearest, Unit { unit: u8 }, Weakest, Strongest, Commander, Attacking { squad: SquadId } }

/// When a waiting order runs (08-orders §6). Triggers read only sim state; signals arrive as Commands.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "on", rename_all = "snake_case")]
pub enum When {
    /// After the company's current order completes ("…, then …").
    Done,
    /// On the captain's signal ("wait for my mark" … "now!"); 0 is the plain "now" / "go".
    Signal { n: u8 },
    After { s: f64 },
    /// Any enemy within `r` tiles of `at` ("when they reach the ford").
    EnemyNear { at: P, r: f64 },
    /// That company routs ("if the shields break").
    Breaks { squad: SquadId },
    CaptainAttacked,
    Nightfall,
    Dawn,
}

/// A field work (08-orders §7).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Work { Stakes, Barricade, Bridge, Watchtower }

/// The only way anything changes a battle. Taps, drags, voice, bots and the LLM broodlord all produce these.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "do", rename_all = "lowercase")]
pub enum Deed {
    Move { who: Who, to: P, #[serde(default)] via: Vec<P>, #[serde(default)] fight: bool, face: Option<f64> },
    Attack { who: Who, target: SquadId, #[serde(default)] via: Vec<P> },
    Take { who: Who, site: SiteId, #[serde(default)] via: Vec<P> },
    /// A drawn front: the polyline as drawn (simplified at 0.12 tiles). The sim runs planFront.
    Front { line: Vec<P> },
    Hold { who: Who },
    /// Call a detached company back (walks out of its fight; the enemy gets free blows).
    Recall { id: SquadId },
    /// Tap on the captain: everyone recalled, the army halts.
    Rally,
    // The order language (08-orders §3, §5, §6).
    /// `deed` carried out with modifiers; the route stays in the deed's own `via`.
    With { how: How, deed: Box<Deed> },
    /// `deed` held until `until` fires; a waiting order shows as a faint mark.
    Wait { until: When, deed: Box<Deed> },
    /// The captain's signal: releases every waiting order on signal `n`.
    Signal { n: u8 },
    /// Change how companies fight or stand without a new order.
    Set { who: Who, how: How },
    /// Stay by `ward` (a company, or the captain's squad) and defend it: escort, guard, "follow me".
    Guard { who: Who, ward: SquadId },
    /// Stand between `ward` and the nearest threat, or `from` ("shields, cover the archers").
    Screen { who: Who, ward: SquadId, #[serde(default)] from: Option<SquadId> },
    /// Attack now, ignoring the cohesion gate.
    Charge { who: Who, #[serde(default)] target: Option<SquadId> },
    /// Fall back fighting: keep facing the enemy and step back to `to`, or out of contact.
    Withdraw { who: Who, #[serde(default)] to: Option<P> },
    /// Fall back behind the line to recover morale.
    Regroup { who: Who },
    /// Hold a company back out of the line as the reserve.
    Reserve { who: Who },
    /// Send the reserve in, at `target` if given.
    Commit { who: Who, #[serde(default)] target: Option<SquadId> },
    /// Turn toward `face` (radians, atan2(dy, dx) in sim coordinates).
    Face { who: Who, face: f64 },
    /// End the held deployment: the armies may advance (08-orders §8).
    Advance,
    /// Build a field work at `at`, facing `face` (08-orders §7).
    Build { who: Who, work: Work, at: P, #[serde(default)] face: f64 },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source { Tap, Drag, Line, Voice, Typed, Bot, Brain }

/// What goes into the order queue and the replay log.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Command {
    pub tick: Tick,
    pub team: Team,
    pub deed: Deed,
    pub src: Source,
    /// Voice/brain only, for the log; never read by the sim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<serde_json::Value>,
}

/// Why an order was refused. The view shows a red cross at `at`; no words on the field.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Refusal { pub tick: Tick, pub at: P, pub why: String }

// ---------------------------------------------------------------------------------------------
// Per-frame buffers (struct of arrays in WASM memory; TS makes typed-array views over them).
// One entry per soldier slot; `count` live entries. Re-create views if memory.buffer changes, or if the
// layout generation changes (a buffer outgrew its reserve and moved).
// Records are interleaved per entry: soldier k's field F is f32[k * F32_FIELDS + F].
// ---------------------------------------------------------------------------------------------
pub mod soldier_buf {
    // f32 arrays
    pub const X: usize = 0;       // tiles
    pub const Y: usize = 1;       // tiles
    pub const FACE: usize = 2;    // radians, 04-battle §9's priority: motion (pace > 0.35), else target, else squad
    pub const SPEED: usize = 3;   // tiles/s, actual (the low-passed pace)
    pub const HP: usize = 4;      // 0..1 of max
    pub const AIM_X: usize = 5;   // what he strikes or shoots at, tiles; NaN when he has no target
    pub const AIM_Y: usize = 6;
    pub const F32_FIELDS: usize = 7;
    // u32 array, bit-packed:
    //   bits 0..15  squad id
    //   bits 16..19 kind (Kind as u8)
    //   bit  20     team
    //   bit  21     alive
    //   bit  22     routing
    //   bit  23     is commander (soldier 0 of a squad)
    //   bit  24     is captain
    //   bit  25     recruit (still in own clothes)
    //   bits 26..27 rank of the squad (0..3)
    //   bit  28     engaged: in contact or shooting this tick
    //   bit  29     backing: moving against his facing (a drake springing back plays its stride in reverse)
    // second u32 array: `strikes` counter (the view starts a strike animation when it changes)
    // third u32 array, TICK_FIELDS per soldier: the tick he was last hit, the tick he died, and the tick his breath
    // cycle began (a drake: rear, the jet at 0.4 s, the bite at 2.3 s; 04-battle.md §5) — NEVER if not
    pub const HIT_AT: usize = 0;
    pub const DIED_AT: usize = 1;
    pub const BREATH_AT: usize = 2;
    pub const TICK_FIELDS: usize = 3;
    pub const NEVER: u32 = u32::MAX;
}

pub mod squad_buf {
    // f32: anchor x, y, facing, morale (0..1 of max), lean (banner lean from heart), men alive / full
    pub const X: usize = 0;
    pub const Y: usize = 1;
    pub const FACE: usize = 2;
    pub const MORALE: usize = 3;
    pub const LEAN: usize = 4;
    pub const ALIVE_FRAC: usize = 5;
    pub const F32_FIELDS: usize = 6;
    // u32: state (0 idle,1 marching,2 fighting,3 routing,4 fled,5 destroyed) | detached<<8 | selected-by-ui is NOT here (UI state stays in TS)
    //   bits 0..7   state
    //   bit  8      detached
    //   bits 9..12  kind (Kind as u8)
    //   bit  13     team
    //   bits 14..15 rank (0..3)
    //   bits 16..23 full (men at the start, capped at 255)
    //   bits 24..31 men alive (capped at 255)
    // second u32 array, one per squad (`squad_unit_ptr`):
    //   bits 0..7   unit (sim::units::Unit as u8: Spear 0 … Captain 6, BlightMan 7, Troll 8, Drake 9, Broodlord 10)
    //   bits 8..31  free
    pub const UNIT_MASK: u32 = 0xff;
}

/// Words per event in the packed event ring (below).
pub const EVENT_WORDS: usize = 6;

// ---------------------------------------------------------------------------------------------
// Events, drained by TS every frame (sound + view). Packed: [code u32, tick u32, x f32, y f32, a u32, b u32]
// ---------------------------------------------------------------------------------------------
#[repr(u32)]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum EventCode {
    Hit = 1,          // a = victim soldier index, b = attacker kind | (heavy<<8)
    Volley = 2,       // a = squad
    Charge = 3,       // a = squad
    Death = 4,        // a = soldier index
    BannerFall = 5,   // a = squad (company broke)
    CommanderFall = 6,// a = squad
    FoeCommanderFall = 7,
    Rout = 8,         // a = squad
    Rally = 9,        // a = squad
    SiteTaken = 10,   // a = site, b = new owner
    HouseFired = 11,  // a = site, b = house
    HouseLost = 12,
    Freed = 13,       // a = site, b = people
    Saved = 14,       // ford: a = people
    Nightfall = 15,
    Dawn = 16,
    DuskBell = 17,    // day 80% gone
    Breath = 18,      // drake breath start: a = soldier
    Refused = 19,     // order refused at (x,y)
    Outcome = 20,     // a = winner team, b = reason code
}

// ---------------------------------------------------------------------------------------------
// Things the voice brain and the broodlord read: a fog-limited text state (06-voice.md §4b) is built
// by the sim, so the model never sees more than the side it speaks for.
// ---------------------------------------------------------------------------------------------
pub trait Describe {
    /// Compact field state for `team`, as in 06-voice.md §4b. Names must match the per-battle schema enums.
    fn describe_for(&self, team: Team) -> String;
    /// The per-battle JSON schema for the brain (company names, places, features, seen enemy ids as enums).
    fn order_schema_for(&self, team: Team) -> serde_json::Value;
}
