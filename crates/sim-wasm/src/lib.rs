//! Thin wasm-bindgen wrapper around `sim` (docs/engine/ENGINE.md). Battle, Campaign and Land come later.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    sim::VERSION.to_string()
}
