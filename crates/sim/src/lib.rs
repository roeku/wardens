//! The rules of THE WARDENS. No I/O, no clock, no randomness except the seeded `hash32` and `Rng`.
//! The boundary and the determinism rules are in docs/engine/ENGINE.md.

pub mod contracts;

/// Shown by the harness and logged by the browser's WASM smoke test.
pub const VERSION: &str = concat!("wardens-sim ", env!("CARGO_PKG_VERSION"));
