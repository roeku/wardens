//! Day 4's places replays (crates/sim/tests/determinism.rs `the_places_replays_match_the_golden_hashes`), compiled to
//! WASM and run under Node (`npm run test:wasm`): the village under the torch with its night, and the ford with its
//! civilians and raiders. Native and WASM must both match the golden files.
#![cfg(target_arch = "wasm32")]

use wasm_bindgen_test::wasm_bindgen_test;

const TOWN: &str = include_str!("../../sim/tests/fixtures/town.json");
const TOWN_GOLDEN: &str = include_str!("../../sim/tests/fixtures/town.hashes");
const FORD: &str = include_str!("../../sim/tests/fixtures/ford.json");
const FORD_GOLDEN: &str = include_str!("../../sim/tests/fixtures/ford.hashes");

#[wasm_bindgen_test]
fn wasm_town_replay_matches_the_native_golden_hashes() {
    let got = sim_wasm::replay_hashes(TOWN, 300).unwrap_or_else(|_| panic!("replay failed"));
    assert_eq!(got, TOWN_GOLDEN);
}

#[wasm_bindgen_test]
fn wasm_ford_replay_matches_the_native_golden_hashes() {
    let got = sim_wasm::replay_hashes(FORD, 300).unwrap_or_else(|_| panic!("replay failed"));
    assert_eq!(got, FORD_GOLDEN);
}
