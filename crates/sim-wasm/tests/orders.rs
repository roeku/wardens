//! The order-language replay (crates/sim/tests/fixtures/orders.json: a held start, ways, waits and signals, field
//! works built and torn down, a reserve, charge, withdraw, guard, screen, face; 08-orders.md), compiled to WASM and
//! run under Node (`npm run test:wasm`). It must match the native golden file bit for bit.
#![cfg(target_arch = "wasm32")]

use wasm_bindgen_test::wasm_bindgen_test;

const REPLAY: &str = include_str!("../../sim/tests/fixtures/orders.json");
const GOLDEN: &str = include_str!("../../sim/tests/fixtures/orders.hashes");

#[wasm_bindgen_test]
fn wasm_orders_replay_matches_the_native_golden_hashes() {
    let got = sim_wasm::replay_hashes(REPLAY, 300).unwrap_or_else(|_| panic!("replay failed"));
    assert_eq!(got, GOLDEN);
}
