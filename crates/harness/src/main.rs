//! Headless harness (docs/spec/01-flow.md §8). A session is a replay (seed + command log) kept in
//! `out/sessions/<name>.json` and re-simulated on every call, so an agent can play and check the game
//! without a browser.

mod draw;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use sim::battle::Replay;
use sim::contracts::{Command, Source, TICK_HZ};
use sim::map::{MapKind, MapOpts};

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
}

#[derive(Subcommand)]
enum Act {
    /// Start a session. PROTO_TUNE, if set, is kept with it as a tuning override.
    New {
        seed: u32,
        /// keep, town or ford.
        #[arg(long, default_value = "keep")]
        map: String,
        /// 48, 64 or 80.
        #[arg(long, default_value_t = 48)]
        width: u16,
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
    }
}

fn play(session: &str, act: Act) -> Result<(), String> {
    let file = Path::new(SESSIONS).join(format!("{session}.json"));
    if let Act::New { seed, map, width } = act {
        let kind = match map.as_str() {
            "keep" => MapKind::Keep,
            "town" => MapKind::Town,
            "ford" => MapKind::Ford,
            other => return Err(format!("unknown map {other}: keep, town or ford")),
        };
        let mut replay = Replay::new(seed, MapOpts { kind, width });
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
