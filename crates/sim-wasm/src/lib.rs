//! Thin wasm-bindgen wrapper around `sim` (docs/engine/ENGINE.md). The packed per-frame buffers and the
//! event ring come with the figures on day 2; Campaign and Land come later.

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
}
