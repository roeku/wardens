//! The rules of THE WARDENS. No I/O, no clock, no randomness except the seeded `hash32` and `Rng`.
//! The boundary and the determinism rules are in docs/engine/ENGINE.md.

pub mod battle;
pub mod contracts;
pub mod hash;
pub mod map;
pub mod math;
pub mod rng;
pub mod text;
pub mod tune;

/// Shown by the harness and logged by the browser's WASM smoke test.
pub const VERSION: &str = concat!("wardens-sim ", env!("CARGO_PKG_VERSION"));
