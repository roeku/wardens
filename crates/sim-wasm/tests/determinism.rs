//! The same replay as crates/sim/tests/determinism.rs, compiled to WASM and run under Node
//! (`npm run test:wasm`). Both must match the golden file, so native and WASM agree bit for bit.
#![cfg(target_arch = "wasm32")]

use wasm_bindgen_test::wasm_bindgen_test;

const REPLAY: &str = include_str!("../../sim/tests/fixtures/replay.json");
const GOLDEN: &str = include_str!("../../sim/tests/fixtures/replay.hashes");

#[wasm_bindgen_test]
fn wasm_replay_matches_the_native_golden_hashes() {
    let got = sim_wasm::replay_hashes(REPLAY, 300).unwrap_or_else(|_| panic!("replay failed"));
    assert_eq!(got, GOLDEN);
}
