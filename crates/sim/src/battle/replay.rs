//! A replay: the seed, the map options, the tick reached and the command log (docs/spec/01-flow.md §8).
//! Harness sessions are replays, re-simulated on every call; the determinism tests replay one natively and
//! in WASM and compare the hashes. A replay may name bots for either side: they are deterministic, so they are
//! re-run with it rather than logged.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Battle, Setup};
use crate::bots::{Bot, BotKind};
use crate::contracts::{Team, Tick};
use crate::map::MapOpts;
use crate::tune::Tune;

/// A bot playing one side of a replay, by name (`garrison`, `general0..2`, `commander`, `charge`, `idle`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BotSlot {
    pub team: Team,
    pub bot: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Replay {
    pub seed: u32,
    #[serde(default)]
    pub map: MapOpts,
    pub tick: Tick,
    #[serde(default)]
    pub log: Vec<crate::contracts::Command>,
    /// The tuning override it was made with, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tune: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bots: Vec<BotSlot>,
    /// The armies by name (`Setup::named`): empty or `blight` is what the map kind opens with, `mirror` the
    /// symmetric human field of day 3.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub setup: String,
}

impl Replay {
    pub fn new(seed: u32, map: MapOpts) -> Replay {
        Replay { seed, map, tick: 0, log: Vec::new(), tune: None, bots: Vec::new(), setup: String::new() }
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
        let mut b = Battle::new(self.seed, self.map, &Setup::named(&self.setup, self.map.kind)?, tune);
        for c in &self.log {
            b.apply(c.clone());
        }
        Ok(b)
    }

    fn bots(&self) -> Result<Vec<Bot>, String> {
        self.bots.iter().map(|s| BotKind::parse(&s.bot).map(|k| Bot::new(k, s.team))).collect()
    }

    /// Steps `b` to `tick`, the replay's bots thinking before every tick.
    fn advance(b: &mut Battle, bots: &mut [Bot], tick: Tick) {
        while b.tick < tick {
            for bot in bots.iter_mut() {
                for c in bot.think(b) {
                    b.apply(c);
                }
            }
            b.step(1);
        }
    }

    /// The battle re-simulated up to `tick`.
    pub fn run(&self) -> Result<Battle, String> {
        let mut b = self.battle()?;
        let mut bots = self.bots()?;
        Self::advance(&mut b, &mut bots, self.tick);
        Ok(b)
    }

    /// The map's hash, then the state hash at every `every` ticks from 0 through `tick`, one per line.
    pub fn hashes(&self, every: Tick) -> Result<String, String> {
        let mut b = self.battle()?;
        let mut bots = self.bots()?;
        let mut out = format!("map {:016x}\n", b.map.hash());
        loop {
            out += &format!("{} {:016x}\n", b.tick, b.hash());
            if b.tick + every > self.tick {
                break;
            }
            let to = b.tick + every;
            Self::advance(&mut b, &mut bots, to);
        }
        Ok(out)
    }
}
