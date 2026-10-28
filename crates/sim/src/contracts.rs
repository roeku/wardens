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
pub enum Who { Army, Squad { id: SquadId } }

/// The only way anything changes a battle. Taps, drags, voice, bots and the LLM broodlord all produce these.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "do", rename_all = "lowercase")]
pub enum Deed {
    Move { who: Who, to: P, #[serde(default)] via: Vec<P>, #[serde(default)] fight: bool, face: Option<f64> },
    Attack { who: Who, target: SquadId },
    Take { who: Who, site: SiteId },
    /// A drawn front: the polyline as drawn (simplified at 0.12 tiles). The sim runs planFront.
    Front { line: Vec<P> },
    Hold { who: Who },
    /// Call a detached company back (walks out of its fight; the enemy gets free blows).
    Recall { id: SquadId },
    /// Tap on the captain: everyone recalled, the army halts.
    Rally,
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
// One entry per soldier slot; `count` live entries. Re-create views if memory.buffer changes.
// ---------------------------------------------------------------------------------------------
pub mod soldier_buf {
    // f32 arrays
    pub const X: usize = 0;       // tiles
    pub const Y: usize = 1;       // tiles
    pub const FACE: usize = 2;    // radians
    pub const SPEED: usize = 3;   // tiles/s, actual
    pub const HP: usize = 4;      // 0..1 of max
    pub const F32_FIELDS: usize = 5;
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
    // second u32 array: `strikes` counter (the view starts a strike animation when it changes)
}

pub mod squad_buf {
    // f32: anchor x, y, facing, morale (0..1 of max), lean (banner lean from heart), men alive / full
    pub const F32_FIELDS: usize = 6;
    // u32: state (0 idle,1 marching,2 fighting,3 routing,4 fled,5 destroyed) | detached<<8 | selected-by-ui is NOT here (UI state stays in TS)
}

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
