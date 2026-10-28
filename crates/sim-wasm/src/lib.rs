//! Thin wasm-bindgen wrapper around `sim` (docs/engine/ENGINE.md). The packed per-frame buffers and the
//! event ring come with the figures on day 2; Campaign comes later.

use sim::battle::Replay;
use sim::contracts::Command;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    sim::VERSION.to_string()
}

/// A replay's map hash and state hashes every `every` ticks, as `harness hashes` prints them.
#[wasm_bindgen]
pub fn replay_hashes(replay_json: &str, every: u32) -> Result<String, JsError> {
    Replay::from_json(replay_json).and_then(|r| r.hashes(every)).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub struct Battle {
    inner: sim::battle::Battle,
}

#[wasm_bindgen]
impl Battle {
    /// A battle from a seed and map options as JSON, e.g. `{"kind":"keep","width":48}`.
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32, map_json: &str) -> Result<Battle, JsError> {
        let map = serde_json::from_str(map_json)?;
        let inner = Replay::new(seed, map).battle().map_err(|e| JsError::new(&e))?;
        Ok(Battle { inner })
    }

    /// Advances `n` fixed ticks of 1/30 s.
    pub fn step(&mut self, n: u32) {
        self.inner.step(n);
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
