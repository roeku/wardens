//! The sim's battle API as the view's buffers read it, in one place: hit and death ticks, each man's target and
//! contact, the fog, the outcome, the bots and the armies. Kept separate so the frame packing does not depend on
//! how the rules name things.

use sim::battle::{Battle, Company, Setup};
use sim::bots::{Bot, BotKind};
use sim::contracts::{Command, Kind, Team, Tick};
use sim::map::{MapKind, MapOpts};
use sim::tune::Tune;

/// The soldier's last hit and death ticks (`Tick::MAX` when never; not alive and never died = left the field).
pub fn hit_and_death(b: &Battle, k: usize) -> (Tick, Tick) {
    let m = &b.soldiers[k];
    (m.hit_at, m.died_at)
}

/// The foe the man strikes or shoots at (a soldier index), if the sim gives one.
pub fn target(b: &Battle, k: usize) -> Option<usize> {
    b.soldiers[k].target
}

/// The man is in contact or shooting this tick.
pub fn engaged(b: &Battle, k: usize) -> bool {
    b.soldiers[k].engaged
}

/// The fog for `team`, one byte per map tile (0 never seen, 1 seen before, 2 in sight).
pub fn fog(b: &Battle, team: Team) -> &[u8] {
    b.fog(team)
}

/// The battle's result once decided: the winning team and why.
pub fn outcome(b: &Battle) -> Option<(Team, String)> {
    b.outcome().map(|(team, why)| (team, format!("{why:?}").to_lowercase()))
}

/// Seconds of daylight: the light's clock runs over them (02-look.md §3). The field's whole length; elsewhere the
/// battle's length less the night that follows the day.
pub fn day_s(b: &Battle) -> f64 {
    let night = if b.map.kind == MapKind::Field { 0.0 } else { b.tune.outcome.night_s };
    b.time_limit() - night
}

/// A battle from a seed, map options and a named army: `default` is what the map kind opens with
/// (`Setup::for_map`); `big` is nine companies a side (01-flow.md §5 `?army=big`).
pub fn muster(seed: u32, opts: MapOpts, army: &str) -> Result<Battle, String> {
    let base = Setup::for_map(opts.kind);
    let setup = match army {
        "" | "default" => base,
        "big" => {
            let ours = [
                (Kind::Spear, "WIL"),
                (Kind::Shield, "ODA"),
                (Kind::Spear, "HAL"),
                (Kind::Shield, "MAB"),
                (Kind::Spear, "TOM"),
                (Kind::Archer, "REN"),
                (Kind::Archer, "IVO"),
                (Kind::Horse, "BORS"),
                (Kind::Horse, "GARETH"),
            ];
            let warband = ours.iter().map(|&(k, n)| Company::new(k, n)).collect();
            // the open field mirrors our army with named companies; a held place has a garrison without commanders
            let garrison = if opts.kind == MapKind::Field {
                let theirs = ["GRIM", "MAUL", "ROOK", "FANG", "VEX", "SKARN", "DREG", "HOLT", "BRAK"];
                ours.iter().zip(theirs).map(|(&(k, _), n)| Company::new(k, n)).collect()
            } else {
                [Kind::Levy, Kind::Levy, Kind::Spear, Kind::Levy, Kind::Levy, Kind::Spear, Kind::Levy, Kind::Archer, Kind::Archer]
                    .into_iter()
                    .map(|k| Company::new(k, ""))
                    .collect()
            };
            Setup { warband, garrison, ..base }
        }
        _ => return Err(format!("no army {army} (default | big)")),
    };
    Ok(Battle::new(seed, opts, &setup, Tune::default()))
}

/// A policy that plays one side: called every tick, its commands are applied before the next tick
/// (01-flow.md §8 "Bots"; every bot goes through the order queue like the player).
pub trait Brain {
    fn think(&mut self, b: &Battle) -> Vec<Command>;
}

impl Brain for Bot {
    fn think(&mut self, b: &Battle) -> Vec<Command> {
        Bot::think(self, b)
    }
}

/// The sim's bot for a name: `garrison`, `general0..2`, `commander`, `charge` or `idle`.
pub fn bot(name: &str, team: Team) -> Result<Box<dyn Brain>, String> {
    let kind = BotKind::parse(name)?;
    Ok(Box::new(Bot::new(kind, team)))
}
