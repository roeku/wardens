//! The sim's maths. Transcendental functions go through `libm`, so native and WASM agree bit for bit;
//! `sqrt`, `floor`, `abs` and the basic operators are IEEE-exact everywhere (docs/engine/ENGINE.md).

use std::f64::consts::{PI, TAU};

use crate::contracts::P;

impl P {
    pub const fn new(x: f64, y: f64) -> P {
        P { x, y }
    }

    pub fn dist(self, o: P) -> f64 {
        hyp(o.x - self.x, o.y - self.y)
    }

    /// Unit vector of `angle` (sim coordinates: x east, y south, so facing = atan2(dy, dx)).
    pub fn from_angle(angle: f64) -> P {
        P::new(cos(angle), sin(angle))
    }

    /// The point `fwd` along `heading` and `left` to its left (left = (f.y, −f.x), docs/spec/06-voice.md §6).
    pub fn offset(self, heading: f64, fwd: f64, left: f64) -> P {
        let f = P::from_angle(heading);
        P::new(self.x + f.x * fwd + f.y * left, self.y + f.y * fwd - f.x * left)
    }
}

/// Our own hypotenuse: `f64::hypot` is not guaranteed bit-identical across platforms.
pub fn hyp(x: f64, y: f64) -> f64 {
    (x * x + y * y).sqrt()
}

pub fn sin(x: f64) -> f64 {
    libm::sin(x)
}

pub fn cos(x: f64) -> f64 {
    libm::cos(x)
}

pub fn atan2(y: f64, x: f64) -> f64 {
    libm::atan2(y, x)
}

pub fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// `t·t·(3 − 2t)`, for t already in [0, 1].
pub fn smooth01(t: f64) -> f64 {
    t * t * (3.0 - 2.0 * t)
}

pub fn smoothstep(e0: f64, e1: f64, x: f64) -> f64 {
    smooth01(((x - e0) / (e1 - e0)).clamp(0.0, 1.0))
}

/// An angle wrapped into (−π, π].
pub fn wrap(mut a: f64) -> f64 {
    while a > PI {
        a -= TAU;
    }
    while a <= -PI {
        a += TAU;
    }
    a
}

/// `from` turned toward `to` by at most `max` radians.
pub fn turn(from: f64, to: f64, max: f64) -> f64 {
    let d = wrap(to - from);
    if d.abs() <= max { to } else { wrap(from + max * d.signum()) }
}
