//! The land's hash for three maps (docs/spec/03-land.md §10: "bit-identical either way"), natively (`cargo test`)
//! and compiled to WASM under Node (`npm run test:wasm`). Both must match `land.hashes`. After a deliberate change to
//! the land, rewrite it with `UPDATE_GOLDEN=1 cargo test -p sim-wasm --test land`.

use sim::land;
use sim::map::{MapKind, MapOpts, generate};

const CASES: [(MapKind, u16, u32); 3] = [(MapKind::Keep, 48, 4), (MapKind::Ford, 48, 7), (MapKind::Keep, 80, 4)];

fn hashes() -> String {
    CASES
        .iter()
        .map(|&(kind, width, seed)| {
            let l = land::make(&generate(seed, MapOpts { kind, width }));
            format!("{kind:?}/{width} seed {seed}: {:016x}\n", l.hash())
        })
        .collect()
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn native_land_matches_the_golden_hashes() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/land.hashes");
    let got = hashes();
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(path, &got).unwrap();
    }
    let want = std::fs::read_to_string(path).expect("no golden file: run once with UPDATE_GOLDEN=1");
    assert_eq!(got, want, "native land hashes differ from {path}");
    println!("native land: {} hashes match the golden file", got.lines().count());
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen_test::wasm_bindgen_test]
fn wasm_land_matches_the_native_golden_hashes() {
    assert_eq!(hashes(), include_str!("land.hashes"));
}
