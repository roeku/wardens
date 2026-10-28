//! Headless harness (docs/spec/01-flow.md §8). A session is a replay (seed + command log) kept in
//! `out/sessions/<name>.json` and re-simulated on every call, so an agent can play and check the game
//! without a browser.

mod draw;
mod sweep;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use sim::battle::{BotSlot, Replay};
use sim::bots::BotKind;
use sim::contracts::{Command, Source, TICK_HZ};
use sim::map::{MapKind, MapOpts};
use sim::tune::Tune;

const SESSIONS: &str = "out/sessions";
const LOOKS: &str = "out/look";

#[derive(Parser)]
#[command(version = sim::VERSION, about = "Play THE WARDENS headless")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Play a session: new, do, wait, look, undo.
    Play {
        session: String,
        #[command(subcommand)]
        act: Act,
    },
    /// Print a replay file's map hash and state hashes every N ticks.
    Hashes {
        file: PathBuf,
        #[arg(long, default_value_t = 300)]
        every: u32,
    },
    /// Bot against bot over many seeds: outcomes, experience numbers and the jitter metrics, e.g.
    /// `sweep --map field --us charge --them general1 --seeds 40`. PROTO_TUNE, if set, overrides the tuning.
    Sweep {
        /// keep, town, ford or field.
        #[arg(long, default_value = "field")]
        map: String,
        /// 48, 64 or 80.
        #[arg(long, default_value_t = 48)]
        width: u16,
        /// Team 0's bot: commander, charge or idle (or any bot).
        #[arg(long, default_value = "commander")]
        us: String,
        /// Team 1's bot: general0..2 or garrison (default: general1 on the field, garrison otherwise).
        #[arg(long)]
        them: Option<String>,
        /// The armies: blight (the warband against the blight) or mirror (the symmetric human field).
        #[arg(long, default_value = "blight")]
        setup: String,
        #[arg(long, default_value_t = 30)]
        seeds: u32,
        /// The first seed.
        #[arg(long, default_value_t = 1)]
        from: u32,
        /// One row per seed.
        #[arg(long)]
        verbose: bool,
    },
}

#[derive(Subcommand)]
enum Act {
    /// Start a session. PROTO_TUNE, if set, is kept with it as a tuning override.
    New {
        seed: u32,
        /// keep, town, ford or field.
        #[arg(long, default_value = "keep")]
        map: String,
        /// 48, 64 or 80.
        #[arg(long, default_value_t = 48)]
        width: u16,
        /// A bot playing team 0 alongside your orders (re-run with the replay, never logged).
        #[arg(long)]
        us: Option<String>,
        /// A bot playing team 1, e.g. garrison or general1.
        #[arg(long)]
        them: Option<String>,
        /// The armies: blight or mirror.
        #[arg(long, default_value = "blight")]
        setup: String,
    },
    /// Give an order now, e.g. `do march 20 13.5`, `do send BORS 18 6`, `do attack army E6`.
    Do {
        #[arg(long, default_value_t = 0)]
        team: u8,
        #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
        words: Vec<String>,
    },
    /// Let time pass.
    Wait { seconds: f64 },
    /// Print the state and draw out/look/<session>.png.
    Look,
    /// Drop the last order.
    Undo,
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<(), String> {
    match cli.cmd {
        Cmd::Hashes { file, every } => {
            let replay = Replay::from_json(&fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?)?;
            print!("{}", replay.hashes(every)?);
            Ok(())
        }
        Cmd::Play { session, act } => play(&session, act),
        Cmd::Sweep { map, width, us, them, setup, seeds, from, verbose } => {
            let kind = map_kind(&map)?;
            sim::battle::Setup::named(&setup, kind)?;
            let them = them.unwrap_or_else(|| if kind == MapKind::Field { "general1".into() } else { "garrison".into() });
            let tune = match std::env::var("PROTO_TUNE") {
                Ok(over) => Tune::with_override(&serde_json::from_str(&over).map_err(|e| format!("PROTO_TUNE: {e}"))?)?,
                Err(_) => Tune::default(),
            };
            let opts = sweep::Opts { kind, setup, width, us: BotKind::parse(&us)?, them: BotKind::parse(&them)?, seeds, from, verbose, tune };
            let started = std::time::Instant::now();
            let runs = sweep::sweep(&opts);
            sweep::report(&opts, &runs);
            println!("ran in {:.1} s", started.elapsed().as_secs_f64());
            Ok(())
        }
    }
}

fn map_kind(map: &str) -> Result<MapKind, String> {
    Ok(match map {
        "keep" => MapKind::Keep,
        "town" => MapKind::Town,
        "ford" => MapKind::Ford,
        "field" => MapKind::Field,
        other => return Err(format!("unknown map {other}: keep, town, ford or field")),
    })
}

fn play(session: &str, act: Act) -> Result<(), String> {
    let file = Path::new(SESSIONS).join(format!("{session}.json"));
    if let Act::New { seed, map, width, us, them, setup } = act {
        let kind = map_kind(&map)?;
        sim::battle::Setup::named(&setup, kind)?;
        let mut replay = Replay::new(seed, MapOpts { kind, width });
        if setup != "blight" {
            replay.setup = setup;
        }
        for (team, bot) in [(0, us), (1, them)] {
            if let Some(bot) = bot {
                BotKind::parse(&bot)?;
                replay.bots.push(BotSlot { team, bot });
            }
        }
        if let Ok(over) = std::env::var("PROTO_TUNE") {
            replay.tune = Some(serde_json::from_str(&over).map_err(|e| format!("PROTO_TUNE: {e}"))?);
        }
        save(&file, &replay)?;
        print!("{}", replay.run()?.describe());
        return Ok(());
    }
    let mut replay = load(&file)?;
    match act {
        Act::New { .. } => unreachable!(),
        Act::Do { team, words } => {
            let mut b = replay.run()?;
            let deed = sim::text::parse(&b, team, &words.join(" "))?;
            let cmd = Command { tick: replay.tick, team, deed, src: Source::Typed, note: None };
            let refused = b.refusals.len();
            b.apply(cmd.clone());
            b.flush();
            replay.log.push(cmd.clone());
            save(&file, &replay)?;
            match b.refusals.get(refused) {
                Some(r) => println!("tick {}: {} -> REFUSED at ({:.1},{:.1}): {}", cmd.tick, sim::text::format(&cmd.deed), r.at.x, r.at.y, r.why),
                None => println!("tick {}: {} -> ok", cmd.tick, sim::text::format(&cmd.deed)),
            }
        }
        Act::Wait { seconds } => {
            let from = replay.tick;
            replay.tick += (seconds * TICK_HZ as f64).round() as u32;
            save(&file, &replay)?;
            let b = replay.run()?;
            println!("tick {} ({:.1} s) hash {:016x}", b.tick, b.time(), b.hash());
            for r in b.refusals.iter().filter(|r| r.tick >= from) {
                println!("REFUSED tick {} at ({:.1},{:.1}): {}", r.tick, r.at.x, r.at.y, r.why);
            }
        }
        Act::Look => {
            let b = replay.run()?;
            print!("{}", b.describe());
            fs::create_dir_all(LOOKS).map_err(|e| e.to_string())?;
            let png = Path::new(LOOKS).join(format!("{session}.png"));
            draw::top_down(&b).save(&png).map_err(|e| format!("{}: {e}", png.display()))?;
            println!("png: {}", png.display());
        }
        Act::Undo => match replay.log.pop() {
            Some(cmd) => {
                save(&file, &replay)?;
                println!("undone: tick {}: {}", cmd.tick, sim::text::format(&cmd.deed));
            }
            None => println!("nothing to undo"),
        },
    }
    Ok(())
}

fn load(file: &Path) -> Result<Replay, String> {
    let json = fs::read_to_string(file).map_err(|_| format!("no session at {} (start one with `new <seed>`)", file.display()))?;
    Replay::from_json(&json)
}

fn save(file: &Path, replay: &Replay) -> Result<(), String> {
    fs::create_dir_all(SESSIONS).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(replay).map_err(|e| e.to_string())?;
    fs::write(file, json + "\n").map_err(|e| format!("{}: {e}", file.display()))
}
