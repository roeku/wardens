//! Thin wasm-bindgen wrapper around `sim` (docs/engine/ENGINE.md): the battle with its bots, the packed per-frame
//! buffers and event ring the view reads without a copy (`frame`), and the land. Campaign comes later.

mod compat;
mod frame;

use sim::battle::Replay;
use sim::contracts::{Command, Team};
use sim::map::MapOpts;
use wasm_bindgen::prelude::*;

use compat::Brain;
use frame::Frame;

#[wasm_bindgen]
pub fn version() -> String {
    sim::VERSION.to_string()
}

/// A replay's map hash and state hashes every `every` ticks, as `harness hashes` prints them.
#[wasm_bindgen]
pub fn replay_hashes(replay_json: &str, every: u32) -> Result<String, JsError> {
    Replay::from_json(replay_json).and_then(|r| r.hashes(every)).map_err(|e| JsError::new(&e))
}

/// The player's team: whose fog the frame carries.
const PLAYER: Team = 0;

/// A battle, the bots that play its sides, and the packed per-frame buffers (contracts `soldier_buf`, `squad_buf`,
/// the event ring). Call `sync()` once per frame, then read the buffers through typed-array views at the `*_ptr()`
/// addresses; re-create the views when `memory.buffer` or `layout()` changes.
#[wasm_bindgen]
pub struct Battle {
    inner: sim::battle::Battle,
    frame: Frame,
    bots: [Option<Box<dyn Brain>>; 2],
}

#[wasm_bindgen]
impl Battle {
    /// A battle from a seed and map options as JSON, e.g. `{"kind":"keep","width":48}`, with the default armies.
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32, map_json: &str) -> Result<Battle, JsError> {
        let map = serde_json::from_str(map_json)?;
        let inner = Replay::new(seed, map).battle().map_err(|e| JsError::new(&e))?;
        Ok(Battle::wrap(inner))
    }

    /// A battle with a named army (`default`, or `big`: nine companies a side; 01-flow.md §5 `?army=`).
    pub fn muster(seed: u32, map_json: &str, army: &str) -> Result<Battle, JsError> {
        let opts: MapOpts = serde_json::from_str(map_json)?;
        let inner = compat::muster(seed, opts, army).map_err(|e| JsError::new(&e))?;
        Ok(Battle::wrap(inner))
    }

    /// Sets the bot that plays `team`: `garrison`, `general0..2`, `commander`, `charge`, `idle`, or `none` (no bot).
    /// A bot thinks every tick and its commands go through the order queue like anyone's.
    pub fn set_bot(&mut self, team: u8, kind: &str) -> Result<(), JsError> {
        let slot = self.bots.get_mut(team as usize).ok_or_else(|| JsError::new("team is 0 or 1"))?;
        *slot = if kind == "none" { None } else { Some(compat::bot(kind, team).map_err(|e| JsError::new(&e))?) };
        Ok(())
    }

    /// Advances `n` fixed ticks of 1/30 s; before each, the bots think and their commands are queued.
    pub fn step(&mut self, n: u32) {
        for _ in 0..n {
            for bot in self.bots.iter_mut().flatten() {
                for cmd in bot.think(&self.inner) {
                    self.inner.apply(cmd);
                }
            }
            self.inner.step(1);
        }
    }

    /// Queues a `Command` given as JSON (contracts.ts).
    pub fn apply(&mut self, command_json: &str) -> Result<(), JsError> {
        let cmd: Command = serde_json::from_str(command_json)?;
        self.inner.apply(cmd);
        Ok(())
    }

    pub fn tick(&self) -> u32 {
        self.inner.tick
    }

    /// The state hash as 16 hex digits.
    pub fn hash(&self) -> String {
        format!("{:016x}", self.inner.hash())
    }

    #[wasm_bindgen(getter)]
    pub fn map_w(&self) -> u16 {
        self.inner.map.w
    }

    #[wasm_bindgen(getter)]
    pub fn map_h(&self) -> u16 {
        self.inner.map.h
    }

    /// Height samples every half tile, `(2w+1) × (2h+1)`, row-major from the north (a copy).
    pub fn heights(&self) -> Vec<f32> {
        self.inner.map.heights.clone()
    }

    /// One byte per tile: 0 open, 1 forest, 2 rock, 3 water, 4 road (a copy).
    pub fn tiles(&self) -> Vec<u8> {
        self.inner.map.tiles.iter().map(|&t| t as u8).collect()
    }

    /// The map as JSON, for `Land`'s constructor in the land worker.
    pub fn map_json(&self) -> Result<String, JsError> {
        Ok(serde_json::to_string(&self.inner.map)?)
    }

    /// The land for this battle's map, made here on the calling thread.
    pub fn land(&self) -> Land {
        Land { inner: sim::land::make(&self.inner.map) }
    }

    // ------------------------------------------------------------------------------------- per-frame buffers

    /// Refills the soldier and squad buffers and the player's fog from the battle. Returns flags: 1 = the fog
    /// changed since the last sync.
    pub fn sync(&mut self) -> u32 {
        self.frame.sync(&self.inner, PLAYER)
    }

    /// Moves the events since the last drain into the event ring and returns how many there are
    /// (`EVENT_WORDS` u32 each at `events_ptr()`: code, tick, x f32, y f32, a, b).
    pub fn drain_events(&mut self) -> u32 {
        self.frame.drain(&mut self.inner) as u32
    }

    /// Bumped whenever a buffer moved: re-create the typed-array views.
    pub fn layout(&self) -> u32 {
        self.frame.layout
    }

    /// Soldiers in the buffers after the last sync, and the room reserved for them.
    pub fn soldier_count(&self) -> u32 {
        self.frame.soldiers as u32
    }

    pub fn soldier_cap(&self) -> u32 {
        self.frame.cap() as u32
    }

    /// `soldier_buf::F32_FIELDS` f32 per soldier.
    pub fn soldier_f32_ptr(&self) -> usize {
        self.frame.sf32.as_ptr() as usize
    }

    /// One bit-packed u32 per soldier (contracts `soldier_buf`).
    pub fn soldier_u32_ptr(&self) -> usize {
        self.frame.su32.as_ptr() as usize
    }

    /// One strike counter per soldier.
    pub fn soldier_strikes_ptr(&self) -> usize {
        self.frame.strikes.as_ptr() as usize
    }

    /// `soldier_buf::TICK_FIELDS` u32 per soldier: the tick he was last hit, the tick he died (`NEVER` if not).
    pub fn soldier_ticks_ptr(&self) -> usize {
        self.frame.ticks.as_ptr() as usize
    }

    pub fn squad_count(&self) -> u32 {
        self.frame.squads as u32
    }

    pub fn squad_cap(&self) -> u32 {
        self.frame.squad_cap() as u32
    }

    /// `squad_buf::F32_FIELDS` f32 per squad.
    pub fn squad_f32_ptr(&self) -> usize {
        self.frame.qf32.as_ptr() as usize
    }

    /// One bit-packed u32 per squad (contracts `squad_buf`).
    pub fn squad_u32_ptr(&self) -> usize {
        self.frame.qu32.as_ptr() as usize
    }

    pub fn events_ptr(&self) -> usize {
        self.frame.events.as_ptr() as usize
    }

    /// Room in the event ring, in events.
    pub fn events_cap(&self) -> u32 {
        (self.frame.events.capacity() / sim::contracts::EVENT_WORDS) as u32
    }

    /// The player's fog, one byte per map tile (0 never seen, 1 seen before, 2 in sight), row-major from the north.
    pub fn fog_ptr(&self) -> usize {
        self.frame.fog.as_ptr() as usize
    }

    pub fn fog_len(&self) -> u32 {
        self.frame.fog.len() as u32
    }

    /// The result once decided, as JSON `{"winner":team,"why":"…"}`; undefined until then.
    pub fn outcome(&self) -> Option<String> {
        compat::outcome(&self.inner).map(|(winner, why)| serde_json::json!({ "winner": winner, "why": why }).to_string())
    }

    /// Seconds of daylight in this battle (the light is the clock, 02-look.md §3).
    pub fn day_s(&self) -> f64 {
        compat::day_s(&self.inner)
    }

    /// The commander's name of a squad (empty for none), for the dev hooks.
    pub fn squad_name(&self, id: u16) -> String {
        self.inner.squads.get(id as usize).map(|s| s.name.clone()).unwrap_or_default()
    }

    /// The whole state as text (the harness's `look`), for the dev hooks.
    pub fn describe(&self) -> String {
        self.inner.describe()
    }
}

impl Battle {
    fn wrap(inner: sim::battle::Battle) -> Battle {
        let frame = Frame::new(&inner);
        Battle { inner, frame, bots: [None, None] }
    }
}

/// The land's dressing (docs/spec/03-land.md §4–§6): the painted ground, the extended heights and the scatter's
/// instance arrays. The `take_*` methods move each buffer out once (the next call returns it empty), so a worker
/// can transfer it without a second copy.
#[wasm_bindgen]
pub struct Land {
    inner: sim::land::Land,
}

#[wasm_bindgen]
impl Land {
    /// The land for a map given as JSON (`Battle.map_json()`).
    #[wasm_bindgen(constructor)]
    pub fn new(map_json: &str) -> Result<Land, JsError> {
        let map: sim::map::BattleMap = serde_json::from_str(map_json)?;
        Ok(Land { inner: sim::land::make(&map) })
    }

    #[wasm_bindgen(getter)]
    pub fn map_w(&self) -> u32 {
        self.inner.map_w
    }

    #[wasm_bindgen(getter)]
    pub fn map_h(&self) -> u32 {
        self.inner.map_h
    }

    /// Tiles of country past every edge: the extended grid starts at map (−border, −border).
    #[wasm_bindgen(getter)]
    pub fn border(&self) -> i32 {
        sim::land::BORDER
    }

    /// Texels per tile.
    #[wasm_bindgen(getter)]
    pub fn tex(&self) -> u32 {
        sim::land::TEX as u32
    }

    /// The extended grid in tiles.
    #[wasm_bindgen(getter)]
    pub fn ew(&self) -> u32 {
        self.inner.ew
    }

    #[wasm_bindgen(getter)]
    pub fn eh(&self) -> u32 {
        self.inner.eh
    }

    /// The painted ground, `ew·tex × eh·tex` RGBA texels, row-major from the north.
    pub fn take_rgba(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.inner.rgba)
    }

    /// Heights every half tile over the extended grid, `(2ew+1) × (2eh+1)`, row-major from the north.
    pub fn take_heights(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.inner.heights)
    }

    /// Per extended tile, 1 where a water quad is drawn.
    pub fn take_water(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.inner.water)
    }

    /// A scatter part's instance matrices (16 floats each, column-major): wood, leaf, tier, stone or hay.
    pub fn take_mat(&mut self, part: &str) -> Result<Vec<f32>, JsError> {
        Ok(std::mem::take(&mut self.part(part)?.mat))
    }

    /// A scatter part's instance colours (3 floats each, 0..1 RGB).
    pub fn take_col(&mut self, part: &str) -> Result<Vec<f32>, JsError> {
        Ok(std::mem::take(&mut self.part(part)?.col))
    }

    /// The land's FNV-1a hash as 16 hex digits (call before taking any buffer).
    pub fn hash(&self) -> String {
        format!("{:016x}", self.inner.hash())
    }
}

impl Land {
    fn part(&mut self, name: &str) -> Result<&mut sim::land::Parts, JsError> {
        let s = &mut self.inner.scatter;
        Ok(match name {
            "wood" => &mut s.wood,
            "leaf" => &mut s.leaf,
            "tier" => &mut s.tier,
            "stone" => &mut s.stone,
            "hay" => &mut s.hay,
            _ => return Err(JsError::new(&format!("no scatter part {name}"))),
        })
    }
}
