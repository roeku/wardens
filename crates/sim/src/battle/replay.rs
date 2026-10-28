//! A replay: the seed, the map options, the tick reached and the command log (docs/spec/01-flow.md §8).
//! Harness sessions are replays, re-simulated on every call; the determinism tests replay one natively and
//! in WASM and compare the hashes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Battle, Setup};
use crate::contracts::{Command, Tick};
use crate::map::MapOpts;
use crate::tune::Tune;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Replay {
    pub seed: u32,
    #[serde(default)]
    pub map: MapOpts,
    pub tick: Tick,
    #[serde(default)]
    pub log: Vec<Command>,
    /// The tuning override it was made with, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tune: Option<Value>,
}

impl Replay {
    pub fn new(seed: u32, map: MapOpts) -> Replay {
        Replay { seed, map, tick: 0, log: Vec::new(), tune: None }
    }

    pub fn from_json(json: &str) -> Result<Replay, String> {
        serde_json::from_str(json).map_err(|e| format!("replay: {e}"))
    }

    /// The battle at tick 0 with the whole log queued.
    pub fn battle(&self) -> Result<Battle, String> {
        let tune = match &self.tune {
            Some(over) => Tune::with_override(over)?,
            None => Tune::default(),
        };
        let mut b = Battle::new(self.seed, self.map, &Setup::default(), tune);
        for c in &self.log {
            b.apply(c.clone());
        }
        Ok(b)
    }

    /// The battle re-simulated up to `tick`.
    pub fn run(&self) -> Result<Battle, String> {
        let mut b = self.battle()?;
        b.run_to(self.tick);
        Ok(b)
    }

    /// The map's hash, then the state hash at every `every` ticks from 0 through `tick`, one per line.
    pub fn hashes(&self, every: Tick) -> Result<String, String> {
        let mut b = self.battle()?;
        let mut out = format!("map {:016x}\n", b.map.hash());
        loop {
            out += &format!("{} {:016x}\n", b.tick, b.hash());
            if b.tick + every > self.tick {
                break;
            }
            b.step(every);
        }
        Ok(out)
    }
}
