//! Headless harness (docs/spec/01-flow.md §8). A session is a replay (seed + command log) kept in
//! `out/sessions/<name>.json` and re-simulated on every call, so an agent can play and check the game
//! without a browser.

mod campaign;
mod draw;
mod intents;
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
    /// Run the order language's checks (08-orders §3–§8): one scenario per verb, modifier, trigger and field work,
    /// each printing its counts. `orders hold` runs only those whose name contains the word.
    Orders {
        /// Only checks whose name contains this.
        filter: Option<String>,
    },
    /// Run day 4's places checks (04-battle §7–§8): the town's fires and the freed, the ford's groups and raiders,
    /// the night's torches, relief, level and lights, each printing its counts. `places ford` runs only those whose
    /// name contains the word.
    Places {
        /// Only checks whose name contains this.
        filter: Option<String>,
    },
    /// Run the broodlord's intent checks (06-voice §8): the bots carry out the brain's intents, across seeds.
    Intents {
        /// Only checks whose name contains this.
        filter: Option<String>,
    },
    /// Whole campaigns headless (01-flow §4, §8): `campaign <n> [--seed0 S] [--bot commander|leader|charge|idle]`, seeds on
    /// threads, printing won/lost and why, steps, battles, men lost, commanders fallen and returned, villages freed
    /// and burnt, broodlords down and escaped, and sim and wall time. `--checks` runs the campaign's checks;
    /// `--state` prints a seed's campaign state (contract §3) at the muster. PROTO_TUNE, if set, overrides the
    /// tuning.
    Campaign {
        n: u32,
        #[arg(long, default_value_t = 1)]
        seed0: u32,
        #[arg(long, default_value = "commander")]
        bot: String,
        /// One row per campaign.
        #[arg(long)]
        verbose: bool,
        /// Run the campaign's checks over the n seeds instead.
        #[arg(long)]
        checks: bool,
        /// Print the state of campaign `seed0` at the muster and after the debug muster, and exit.
        #[arg(long)]
        state: bool,
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
        /// Team 1's bot: general0..2, garrison or raiders (default: general1 on the field, raiders at the ford,
        /// garrison otherwise).
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
        /// A held start (08-orders §8): nobody advances until `do advance`.
        #[arg(long)]
        held: bool,
    },
    /// Give an order now, e.g. `do march 20 13.5`, `do send BORS 18 6`, `do attack army E6`, `do stance REN
    /// holdfire`, `do wait signal 0 attack BORS E6`, `do signal`, `do guard ODA 0`, `do withdraw army`,
    /// `do build WIL stakes 20 13.5` (the grammar is in sim::text).
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
        Cmd::Intents { filter } => intents::run(filter),
        Cmd::Campaign { n, seed0, bot, verbose, checks, state } => {
            let tune = match std::env::var("PROTO_TUNE") {
                Ok(over) => Tune::with_override(&serde_json::from_str(&over).map_err(|e| format!("PROTO_TUNE: {e}"))?)?,
                Err(_) => Tune::default(),
            };
            let bot = sim::campaign::auto::Policy::parse(&bot)?;
            if state {
                let mut c = sim::campaign::Campaign::create(seed0, &sim::campaign::Opts::default(), tune);
                println!("{}", serde_json::to_string_pretty(&c.state()).map_err(|e| e.to_string())?);
                c.auto_muster()?;
                println!("{}", serde_json::to_string_pretty(&c.state()["warband"]).map_err(|e| e.to_string())?);
                return Ok(());
            }
            if checks {
                return campaign::checks(n, seed0, bot, &tune);
            }
            campaign::run(&campaign::Opts2 { n, seed0, bot, tune, verbose })
        }
        Cmd::Orders { filter } => {
            let mut failed = 0;
            let mut ran = 0;
            for (name, check) in sim::battle::checks::ALL {
                if filter.as_ref().is_some_and(|f| !name.contains(f.as_str())) {
                    continue;
                }
                let c = check();
                ran += 1;
                failed += (!c.pass) as u32;
                println!("{} {}: {}", if c.pass { "PASS" } else { "FAIL" }, c.name, c.counts);
            }
            println!("orders: {} of {ran} checks pass", ran - failed as usize);
            if failed > 0 { Err(format!("{failed} order checks failed")) } else { Ok(()) }
        }
        Cmd::Places { filter } => {
            let mut failed = 0;
            let mut ran = 0;
            for (name, check) in sim::battle::place_checks::ALL {
                if filter.as_ref().is_some_and(|f| !name.contains(f.as_str())) {
                    continue;
                }
                let c = check();
                ran += 1;
                failed += (!c.pass) as u32;
                println!("{} {}: {}", if c.pass { "PASS" } else { "FAIL" }, c.name, c.counts);
            }
            println!("places: {} of {ran} checks pass", ran - failed as usize);
            if failed > 0 { Err(format!("{failed} places checks failed")) } else { Ok(()) }
        }
        Cmd::Sweep { map, width, us, them, setup, seeds, from, verbose } => {
            let kind = map_kind(&map)?;
            sim::battle::Setup::named(&setup, kind)?;
            let them = them.unwrap_or_else(|| match kind {
                MapKind::Field => "general1".into(),
                MapKind::Ford => "raiders".into(),
                MapKind::Keep | MapKind::Town => "garrison".into(),
                MapKind::Road => "idle".into(),
            });
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
    if let Act::New { seed, map, width, us, them, setup, held } = act {
        let kind = map_kind(&map)?;
        sim::battle::Setup::named(&setup, kind)?;
        let mut replay = Replay::new(seed, MapOpts { kind, width });
        if setup != "blight" {
            replay.setup = setup;
        }
        replay.held = held;
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
            // Orders logged at this very tick are still queued: apply them first, so only this one's refusal shows.
            b.flush();
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
