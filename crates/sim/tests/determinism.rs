//! Replays the fixtures and compares their hashes with the golden files. `replay.json` (a keep battle against the
//! blight's nest, the garrison bot playing team 1 beside logged orders, long enough for drake breath, the block
//! pressing on it and troll impact blows) is checked in WASM too (crates/sim-wasm/tests/determinism.rs): native and
//! WASM must both produce it. `field.json` (the charge bot against general2 and the blight on the open field) and
//! `mirror.json` (the same against the day-3 human field, `Setup::mirror`) are checked natively. After a deliberate
//! rule change, rewrite them with `UPDATE_GOLDEN=1 cargo test -p sim --test determinism`.

use sim::battle::Replay;
use sim::contracts::Source;

const REPLAY: &str = include_str!("fixtures/replay.json");
const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/replay.hashes");
const FIELD: &str = include_str!("fixtures/field.json");
const FIELD_GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/field.hashes");
const MIRROR: &str = include_str!("fixtures/mirror.json");
const MIRROR_GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mirror.hashes");
const EVERY: u32 = 300;

fn check(replay: &str, golden: &str) -> usize {
    let got = Replay::from_json(replay).unwrap().hashes(EVERY).unwrap();
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(golden, &got).unwrap();
    }
    let want = std::fs::read_to_string(golden).expect("no golden file: run once with UPDATE_GOLDEN=1");
    assert_eq!(got, want, "native hashes differ from {golden}");
    got.lines().count()
}

#[test]
fn replay_matches_the_golden_hashes() {
    let n = check(REPLAY, GOLDEN);
    println!("native replay: {n} hashes match the golden file");
}

#[test]
fn bot_battle_matches_the_golden_hashes() {
    let n = check(FIELD, FIELD_GOLDEN);
    let b = Replay::from_json(FIELD).unwrap().run().unwrap();
    println!("native field replay with bots: {n} hashes match; {} commands logged, outcome {:?}", b.log.len(), b.outcome());
}

#[test]
fn the_human_mirror_matches_the_golden_hashes() {
    let n = check(MIRROR, MIRROR_GOLDEN);
    let b = Replay::from_json(MIRROR).unwrap().run().unwrap();
    assert!(b.squads.iter().any(|s| s.name == "GRIM"), "the day-3 human field");
    println!("native mirror replay with bots: {n} hashes match; outcome {:?}", b.outcome());
}

#[test]
fn the_keep_replay_breathes_and_strikes_late() {
    let b = Replay::from_json(REPLAY).unwrap().run().unwrap();
    let t = &b.tally;
    assert!(t.jets > 0 && t.burns > 0 && t.presses > 0 && t.landed > 0, "{t:?}");
    println!("keep replay exercises the blight: {} jets, {} burns, {} press ticks, {} impact blows landed", t.jets, t.burns, t.presses, t.landed);
}

#[test]
fn replay_repeats_and_survives_json() {
    let r = Replay::from_json(REPLAY).unwrap();
    let a = r.run().unwrap();
    let b = Replay::from_json(&serde_json::to_string(&r).unwrap()).unwrap().run().unwrap();
    assert_eq!(a.hash(), b.hash());
    assert_eq!(a.tick, 2700);
    // Every logged command is applied and logged, refused or not, in order; the bot's come on top of them.
    let mut rest = a.log.iter();
    for c in &r.log {
        assert!(rest.any(|x| x.deed == c.deed && x.team == c.team && x.src == c.src), "logged command missing: {c:?}");
    }
    let logged = r.log.len();
    let by_bot = a.log.len() - logged;
    assert!(by_bot > 0 && a.log.iter().filter(|c| c.src == Source::Bot).count() >= by_bot, "the garrison bot gives orders through the queue");
    let why: Vec<&str> = a.refusals.iter().map(|r| r.why.as_str()).collect();
    // Team 1 has its general since day 3, so its army order at tick 1400 is obeyed.
    assert!(why.contains(&"no squad 9 of ours"), "{why:?}");
    println!("replay: 2 runs agree, {logged} commands logged and {by_bot} by the bot, {} refused", a.refusals.len());
}
