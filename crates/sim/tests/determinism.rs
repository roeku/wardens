//! Replays the fixture and compares its hashes with the golden file, which the WASM test checks too
//! (crates/sim-wasm/tests/determinism.rs): native and WASM must both produce it. After a deliberate rule
//! change, rewrite it with `UPDATE_GOLDEN=1 cargo test -p sim --test determinism`.

use sim::battle::Replay;

const REPLAY: &str = include_str!("fixtures/replay.json");
const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/replay.hashes");
const EVERY: u32 = 300;

#[test]
fn replay_matches_the_golden_hashes() {
    let got = Replay::from_json(REPLAY).unwrap().hashes(EVERY).unwrap();
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(GOLDEN, &got).unwrap();
    }
    let want = std::fs::read_to_string(GOLDEN).expect("no golden file: run once with UPDATE_GOLDEN=1");
    assert_eq!(got, want, "native hashes differ from {GOLDEN}");
    println!("native replay: {} hashes match the golden file", got.lines().count());
}

#[test]
fn replay_repeats_and_survives_json() {
    let r = Replay::from_json(REPLAY).unwrap();
    let a = r.run().unwrap();
    let b = Replay::from_json(&serde_json::to_string(&r).unwrap()).unwrap().run().unwrap();
    assert_eq!(a.hash(), b.hash());
    assert_eq!(a.tick, 1800);
    assert_eq!(a.log.len(), r.log.len(), "every command is logged, refused or not");
    let why: Vec<&str> = a.refusals.iter().map(|r| r.why.as_str()).collect();
    assert_eq!(why, ["no squad 9 of ours", "no captain"]);
    println!("replay: 2 runs agree, {} commands logged, {} refused", a.log.len(), a.refusals.len());
}
