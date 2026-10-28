//! Seeded randomness and value noise (docs/spec/03-land.md §2). The only randomness the sim may use:
//! `hash32(seed, id, salt)` for anything per entity or per tick, and `Rng` only for map generation and setup.

use crate::math::{lerp, smooth01};

const GOLDEN: u32 = 0x9e37_79b9;
const TWO_32: f64 = 4_294_967_296.0;

/// Murmur3/SplitMix-style finaliser over three words. Inputs wrap like the original's `Math.imul` arithmetic,
/// so negative lattice coordinates pass through as `i32 as u32`.
pub fn hash32(a: u32, b: u32, c: u32) -> u32 {
    let mut h = a ^ GOLDEN;
    h = (h ^ (h >> 16)).wrapping_mul(0x85eb_ca6b);
    h ^= b.wrapping_add(0x1656_67b1).wrapping_mul(0xc2b2_ae35);
    h = (h ^ (h >> 13)).wrapping_mul(0xc2b2_ae35);
    h ^= c.wrapping_add(0x27d4_eb2f).wrapping_mul(0x85eb_ca6b);
    h = (h ^ (h >> 16)).wrapping_mul(0x2545_f491);
    h ^ (h >> 15)
}

/// `hash32` as a float in [0, 1).
pub fn unit(a: u32, b: u32, c: u32) -> f64 {
    hash32(a, b, c) as f64 / TWO_32
}

/// Per-entity jitter in [0, 1): `hash32(seed, id, salt) / 2^32` (docs/spec/04-battle.md §1).
pub fn jitter(seed: u32, id: u32, salt: u32) -> f64 {
    unit(seed, id, salt)
}

/// Per-point jitter in [0, 1).
pub fn jit(seed: u32, x: i32, y: i32, salt: u32) -> f64 {
    unit(seed, x.wrapping_mul(131).wrapping_add(y.wrapping_mul(7919)) as u32, salt)
}

/// xorshift32 (13, 17, 5). A zero seed becomes 0x9e3779b9.
#[derive(Clone, Debug)]
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Rng {
        Rng(if seed == 0 { GOLDEN } else { seed })
    }

    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }

    /// The spec's `r`: the next float in [0, 1).
    pub fn r(&mut self) -> f64 {
        self.next_u32() as f64 / TWO_32
    }
}

fn lattice(seed: u32, i: i32, j: i32, salt: u32) -> f64 {
    unit(seed, i.wrapping_mul(374_761).wrapping_add(j.wrapping_mul(668_265)) as u32, salt)
}

/// Value noise in [0, 1): hashed lattice values, smoothstep-blended bilinearly.
pub fn noise(seed: u32, x: f64, y: f64, salt: u32) -> f64 {
    let (fx, fy) = (x.floor(), y.floor());
    let (i, j) = (fx as i32, fy as i32);
    let (tx, ty) = (smooth01(x - fx), smooth01(y - fy));
    let top = lerp(lattice(seed, i, j, salt), lattice(seed, i + 1, j, salt), tx);
    let bottom = lerp(lattice(seed, i, j + 1, salt), lattice(seed, i + 1, j + 1, salt), tx);
    lerp(top, bottom, ty)
}

const FBM_OCTAVES: u32 = 4;
const FBM_GAIN: f64 = 0.5;
const FBM_LACUNARITY: f64 = 2.03;
const FBM_SALT_STEP: u32 = 17;

/// 4 octaves of value noise, normalised to [0, 1). Octave o is salted `salt + o·17`.
pub fn fbm(seed: u32, x: f64, y: f64, salt: u32) -> f64 {
    let (mut sum, mut norm, mut amp, mut freq) = (0.0, 0.0, 1.0, 1.0);
    for o in 0..FBM_OCTAVES {
        sum += amp * noise(seed, x * freq, y * freq, salt.wrapping_add(o * FBM_SALT_STEP));
        norm += amp;
        amp *= FBM_GAIN;
        freq *= FBM_LACUNARITY;
    }
    sum / norm
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference values computed with the spec's JavaScript formula (03-land.md §2) under Node.
    #[test]
    fn hash32_matches_the_js_reference() {
        let cases = [
            ((0, 0, 0), 4_166_330_142),
            ((1, 2, 3), 3_631_840_503),
            ((4, 1_043_026, 7), 31_876_374),
            ((0xffff_ffff, 123_456_789, 42), 3_447_224_609),
            ((92_821, 13, 0), 895_612_554),
            ((7, (-374_761 * 3 + 668_265 * 2) as u32, 1), 530_555_831),
        ];
        for ((a, b, c), want) in cases {
            assert_eq!(hash32(a, b, c), want, "hash32({a}, {b}, {c})");
        }
        println!("hash32: {} reference values match", cases.len());
    }

    #[test]
    fn rng_matches_the_js_reference() {
        let cases: [(u32, [u32; 3]); 3] = [
            (0, [1_359_758_873, 3_761_132_862, 2_075_758_394]),
            (1, [270_369, 67_634_689, 2_647_435_461]),
            (4, [1_081_476, 268_507_140, 1_395_765_508]),
        ];
        for (seed, want) in cases {
            let mut r = Rng::new(seed);
            assert_eq!([r.next_u32(), r.next_u32(), r.next_u32()], want, "seed {seed}");
        }
        println!("rng: {} seeds match", cases.len());
    }

    #[test]
    fn noise_and_fbm_stay_in_range() {
        let mut n = 0;
        for i in 0..400 {
            let (x, y) = (i as f64 * 0.37 - 40.0, i as f64 * 0.91 - 90.0);
            for v in [noise(7, x, y, 3), fbm(7, x, y, 3)] {
                assert!((0.0..1.0).contains(&v), "{v} at ({x}, {y})");
                n += 1;
            }
        }
        println!("noise/fbm: {n} samples in [0, 1)");
    }
}
