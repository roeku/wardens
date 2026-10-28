//! The scatter (03-land.md §4 "Scatter", §5): trees, boulders, bushes, small stones, field fences and hedges,
//! and haystacks, as flat instance arrays. Each part is one shape the view draws instanced: the instance's
//! 4×4 matrix (column-major, as three.js stores it) and its colour (0..1 RGB, the hex value unconverted).

use super::ext::{Ext, Ground};
use super::fields::Field;
use super::paint::{Class, Painted};
use super::scape::{Fence, Hedge, Scape, Species, pick};
use super::BORDER;
use crate::contracts::P;
use crate::map::BattleMap;
use crate::math::{atan2, cos, hyp, sin};
use crate::rng::{fbm, hash32};

const TAU: f64 = std::f64::consts::TAU;

/// One instanced shape: 16 floats of matrix and 3 of colour per instance.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Parts {
    pub mat: Vec<f32>,
    pub col: Vec<f32>,
}

impl Parts {
    pub fn count(&self) -> usize {
        self.col.len() / 3
    }

    /// An instance at `at` (three.js axes: x east, y up, z south), turned `yaw` about y after tilting `tilt`
    /// about its own z, scaled by `scale` along its own axes: `T · Ry(yaw) · Rz(tilt) · S`.
    pub fn push(&mut self, at: [f64; 3], yaw: f64, tilt: f64, scale: [f64; 3], colour: u32) {
        let (cy, sy, ct, st) = (cos(yaw), sin(yaw), cos(tilt), sin(tilt));
        let cols = [[cy * ct, st, -sy * ct], [-cy * st, ct, sy * st], [sy, 0.0, cy]];
        for (c, s) in cols.iter().zip(scale) {
            self.mat.extend([(c[0] * s) as f32, (c[1] * s) as f32, (c[2] * s) as f32, 0.0]);
        }
        self.mat.extend([at[0] as f32, at[1] as f32, at[2] as f32, 1.0]);
        self.col.extend(rgb(colour));
    }
}

pub fn rgb(c: u32) -> [f32; 3] {
    [((c >> 16) & 0xff) as f32 / 255.0, ((c >> 8) & 0xff) as f32 / 255.0, (c & 0xff) as f32 / 255.0]
}

/// The five shapes: boxes (trunks, posts, rails, walls), icosahedra (crowns, bushes), 7-sided cones (conifer
/// tiers), dodecahedra (stones) and 7-sided cones again for haystacks, which get no foliage speckle.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Scatter {
    pub wood: Parts,
    pub leaf: Parts,
    pub tier: Parts,
    pub stone: Parts,
    pub hay: Parts,
}

const SCATTER_SALT: u32 = 91;
const FIELD_EDGE_SALT: u32 = 92;
const TWO_32: f64 = 4_294_967_296.0;
/// Forest tiles: 2 trees inside the map, 3 outside, times `thick`.
const TREES_INSIDE: f64 = 2.0;
const TREES_OUTSIDE: f64 = 3.0;
const JITTER: (f64, f64) = (0.1, 0.8);
const TREE_SCALE: (f64, f64) = (0.8, 0.5);
const SPECIES_FREQ: f64 = 1.0 / 8.0;
const SPECIES_AT: f64 = 0.55;
/// Rock tiles: 40% get a boulder of scale 0.25–0.55.
const BOULDER_CHANCE: f64 = 0.4;
const BOULDER_SCALE: (f64, f64) = (0.25, 0.3);
/// Open grass: a lone tree (`scape.lone`), else a bush, else a small stone (out/decisions-land.md).
const BUSH_CHANCE: f64 = 0.07;
const SMALL_STONE_CHANCE: f64 = 0.05;
const BUSH_SCALE: (f64, f64) = (0.2, 0.2);
const SMALL_STONE_SCALE: (f64, f64) = (0.12, 0.12);
/// Lone trees never in the deploy zone (x < 7) or within 3 of a site.
const LONE_EDGE_X: f64 = 7.0;
const LONE_SITE_GAP: f64 = 3.0;
/// Stones: scaled (s, .7s, .9s), turned at random and tilted up to ±0.25 rad, sunk to 0.2s above ground.
const STONE_SHAPE: [f64; 3] = [1.0, 0.7, 0.9];
const STONE_TILT: f64 = 0.5;
const STONE_LIFT: f64 = 0.2;
/// Bushes: scaled (1.2s, s, 1.2s), centred 0.45s above the ground.
const BUSH_WIDE: f64 = 1.2;
const BUSH_LIFT: f64 = 0.45;
/// Every trunk and post sinks this far into the ground, so slopes never show a gap under it.
const SINK: f64 = 0.04;

// Trees (§5), in units of the tree's scale s.
const TRUNK_W: f64 = 0.11;
const TRUNK_OAK_CONIFER: u32 = 0x56391f;
const OAK_TRUNK: f64 = 0.5;
const OAK_CROWN: f64 = 0.36;
/// Oak blobs as (x, y, z, sx, sy, sz) in units of the crown radius over the trunk's top: two low, one broad
/// middle, two small on top.
const OAK_BLOBS: [[f64; 6]; 5] = [
    [-0.48, 0.15, 0.12, 0.72, 0.68, 0.72],
    [0.46, 0.2, -0.14, 0.7, 0.66, 0.7],
    [0.0, 0.62, 0.0, 1.12, 0.86, 1.12],
    [-0.26, 1.18, -0.1, 0.6, 0.56, 0.6],
    [0.3, 1.1, 0.18, 0.56, 0.52, 0.56],
];
/// The ramp step offset of each oak blob above the tree's base step: low darker, top lighter.
const OAK_STEPS: [usize; 5] = [0, 0, 1, 2, 2];
const PINE_TRUNK: f64 = 0.25;
const PINE_TIERS: usize = 4;
const PINE_R: f64 = 0.38;
const PINE_TAPER: f64 = 0.2;
const PINE_H: f64 = 0.55;
const PINE_STEP: f64 = 0.3;
const POPLAR_TRUNK: f64 = 0.3;
/// Poplar blobs: 3 tall slim blobs, (y over the trunk, radius, half-height) in units of s.
const POPLAR_BLOBS: [[f64; 3]; 3] = [[0.35, 0.2, 0.42], [0.82, 0.17, 0.38], [1.2, 0.12, 0.28]];

// Field edges (§4, §5).
const FENCE_CHANCE: f64 = 0.45;
const HEDGE_CHANCE: f64 = 0.5;
const POST_GAP: f64 = 0.36;
const POST: [f64; 3] = [0.05, 0.27, 0.05];
const POST_COLOUR: u32 = 0x6a4a2e;
const RAIL_H: [f64; 2] = [0.11, 0.21];
const RAIL: [f64; 2] = [0.028, 0.025];
const RAIL_COLOUR: u32 = 0x86603a;
const HEDGE_BUSH_GAP: f64 = 0.45;
const HEDGE_POPLAR_GAP: f64 = 0.8;
const HEDGE_BUSH_SCALE: (f64, f64) = (0.2, 0.08);
const WALL_LEN: f64 = 1.05;
const WALL_H: (f64, f64) = (0.2 * 0.8, 0.2 * 0.5);
const WALL_D: f64 = 0.13;
const WALL_GAP: f64 = 0.6;
const WALL_COLOURS: [u32; 4] = [0x7a756a, 0x8a8478, 0x6c675d, 0x9a9486];
/// Haystacks: `Cone(.24, .34, 7)`, 1 or 2 per grain field, at least 0.4 inside its edge.
const HAY: [f64; 2] = [0.24, 0.34];
const HAY_COLOUR: u32 = 0xc9a24a;
const HAY_MARGIN: f64 = 0.4;

/// Rolls in [0, 1) for one place: `roll(n)` is the n-th independent draw.
struct Rolls {
    seed: u32,
    id: u32,
    salt: u32,
}

impl Rolls {
    fn r(&self, n: u32) -> f64 {
        hash32(self.seed, self.id, self.salt.wrapping_add(n * 7)) as f64 / TWO_32
    }
}

pub fn scatter(m: &BattleMap, ext: &Ext, painted: &Painted, fields: &[Field], sc: &Scape) -> Scatter {
    let mut out = Scatter::default();
    let seed = m.seed;
    for ey in 0..ext.eh {
        for ex in 0..ext.ew {
            let (tx, ty) = (ex as i32 - BORDER, ey as i32 - BORDER);
            let inside = m.idx(tx, ty).is_some();
            let roll = Rolls { seed, id: (ey * ext.ew + ex) as u32, salt: SCATTER_SALT };
            let at = |a: u32, b: u32| {
                P::new(tx as f64 + JITTER.0 + roll.r(a) * JITTER.1, ty as f64 + JITTER.0 + roll.r(b) * JITTER.1)
            };
            match ext.cls[ey * ext.ew + ex] {
                Ground::Forest => {
                    let n = ((if inside { TREES_INSIDE } else { TREES_OUTSIDE }) * sc.thick).round() as u32;
                    for k in 0..n {
                        let base = 10 + k * 8;
                        let p = at(base, base + 1);
                        if matches!(painted.class_at(p), Class::Road | Class::Yard | Class::Field) {
                            continue;
                        }
                        let wood = fbm(seed.wrapping_add(7), p.x * SPECIES_FREQ, p.y * SPECIES_FREQ, 7) > SPECIES_AT;
                        let species = pick(sc.woods[if wood { 0 } else { 1 }], roll.r(base + 2));
                        let s = TREE_SCALE.0 + roll.r(base + 3) * TREE_SCALE.1;
                        let shade = hash32(seed, roll.id, SCATTER_SALT + base + 4);
                        let h = ext.height(p.x, p.y);
                        tree(&mut out, sc, species, p, h, s, roll.r(base + 5) * TAU, shade);
                    }
                }
                Ground::Rock => {
                    if roll.r(0) < BOULDER_CHANCE {
                        let p = at(1, 2);
                        let s = BOULDER_SCALE.0 + roll.r(3) * BOULDER_SCALE.1;
                        stone(&mut out.stone, sc, p, ext.height(p.x, p.y), s, &roll);
                    }
                }
                Ground::Open => {
                    let p = at(1, 2);
                    if painted.class_at(p) != Class::Grass {
                        continue;
                    }
                    let r = roll.r(0);
                    let lone = sc.lone[if inside { 0 } else { 1 }];
                    let h = ext.height(p.x, p.y);
                    if r < lone {
                        let clear = !(inside && p.x < LONE_EDGE_X) && m.sites.iter().all(|s| s.at.dist(p) >= LONE_SITE_GAP);
                        if clear {
                            let s = TREE_SCALE.0 + roll.r(3) * TREE_SCALE.1;
                            let shade = hash32(seed, roll.id, SCATTER_SALT + 4);
                            tree(&mut out, sc, sc.lone_species, p, h, s, roll.r(5) * TAU, shade);
                        }
                    } else if r < lone + BUSH_CHANCE {
                        let s = BUSH_SCALE.0 + roll.r(3) * BUSH_SCALE.1;
                        let shade = hash32(seed, roll.id, SCATTER_SALT + 5);
                        bush(&mut out.leaf, sc, p, h, s, roll.r(4) * TAU, shade);
                    } else if r < lone + BUSH_CHANCE + SMALL_STONE_CHANCE {
                        let s = SMALL_STONE_SCALE.0 + roll.r(3) * SMALL_STONE_SCALE.1;
                        stone(&mut out.stone, sc, p, h, s, &roll);
                    }
                }
                Ground::Water | Ground::Ford | Ground::Road => {}
            }
        }
    }
    for (n, f) in fields.iter().enumerate() {
        field_edges(&mut out, ext, sc, f, Rolls { seed, id: n as u32, salt: FIELD_EDGE_SALT });
    }
    out
}

/// One tree of `species` at scale `s` standing on the ground at `p` (height `h`).
#[allow(clippy::too_many_arguments)]
fn tree(out: &mut Scatter, sc: &Scape, species: Species, p: P, h: f64, s: f64, yaw: f64, shade: u32) {
    let (cy, sy) = (cos(yaw), sin(yaw));
    // A local offset (x, y, z) turned by the tree's yaw, in the world.
    let place = |o: [f64; 3]| [p.x + cy * o[0] + sy * o[2], h + o[1], p.y - sy * o[0] + cy * o[2]];
    let trunk = |out: &mut Scatter, len: f64, colour: u32| {
        out.wood.push([p.x, h + len / 2.0 - SINK / 2.0, p.y], yaw, 0.0, [TRUNK_W, len + SINK, TRUNK_W], colour);
    };
    match species {
        Species::Oak => {
            let (t, r) = (OAK_TRUNK * s, OAK_CROWN * s);
            trunk(out, t, TRUNK_OAK_CONIFER);
            let base = (shade % 3) as usize;
            for (b, step) in OAK_BLOBS.iter().zip(OAK_STEPS) {
                let colour = sc.leaf[(base + step).min(sc.leaf.len() - 1)];
                out.leaf.push(place([b[0] * r, t + b[1] * r, b[2] * r]), yaw, 0.0, [b[3] * r, b[4] * r, b[5] * r], colour);
            }
        }
        Species::Pine => {
            let t = PINE_TRUNK * s;
            trunk(out, t, TRUNK_OAK_CONIFER);
            let base = (shade % sc.needle.len() as u32) as usize;
            for k in 0..PINE_TIERS {
                let r = PINE_R * s * (1.0 - PINE_TAPER * k as f64);
                let y = t + k as f64 * PINE_STEP * s + PINE_H * s / 2.0;
                let colour = sc.needle[(base + k / 2).min(sc.needle.len() - 1)];
                // Each tier turned a little more, so the seven sides don't line up.
                out.tier.push(place([0.0, y, 0.0]), yaw + k as f64 * 0.45, 0.0, [r, PINE_H * s, r], colour);
            }
        }
        Species::Poplar => {
            let t = POPLAR_TRUNK * s;
            trunk(out, t, TRUNK_OAK_CONIFER);
            let base = (shade % 3) as usize;
            for (k, b) in POPLAR_BLOBS.iter().enumerate() {
                let colour = sc.leaf[(base + k).min(sc.leaf.len() - 1)];
                out.leaf.push(place([0.0, t + b[0] * s, 0.0]), yaw, 0.0, [b[1] * s, b[2] * s, b[1] * s], colour);
            }
        }
    }
}

fn bush(leaf: &mut Parts, sc: &Scape, p: P, h: f64, s: f64, yaw: f64, shade: u32) {
    let colour = sc.leaf[1 + (shade % 3) as usize];
    leaf.push([p.x, h + BUSH_LIFT * s, p.y], yaw, 0.0, [BUSH_WIDE * s, s, BUSH_WIDE * s], colour);
}

fn stone(parts: &mut Parts, sc: &Scape, p: P, h: f64, s: f64, roll: &Rolls) {
    let yaw = roll.r(20) * TAU;
    let tilt = (roll.r(21) - 0.5) * STONE_TILT;
    let colour = sc.stones[((roll.r(22) * sc.stones.len() as f64) as usize).min(sc.stones.len() - 1)];
    let scale = [STONE_SHAPE[0] * s, STONE_SHAPE[1] * s, STONE_SHAPE[2] * s];
    parts.push([p.x, h + STONE_LIFT * s, p.y], yaw, tilt, scale, colour);
}

/// Each side of a field: a fence (45%), else a hedge (50%); and 1 or 2 haystacks in a grain field.
fn field_edges(out: &mut Scatter, ext: &Ext, sc: &Scape, f: &Field, roll: Rolls) {
    let corners = [P::new(f.x0, f.y0), P::new(f.x1, f.y0), P::new(f.x1, f.y1), P::new(f.x0, f.y1)];
    for side in 0..4u32 {
        let (a, b) = (corners[side as usize], corners[(side as usize + 1) % 4]);
        if roll.r(side * 3) < FENCE_CHANCE {
            match sc.fence {
                Fence::Wood => fence(&mut out.wood, ext, a, b),
                Fence::Stone => wall(&mut out.wood, ext, a, b),
            }
        } else if roll.r(side * 3 + 1) < HEDGE_CHANCE {
            let gap = if sc.hedge == Hedge::Bush { HEDGE_BUSH_GAP } else { HEDGE_POPLAR_GAP };
            let n = (a.dist(b) / gap).floor().max(1.0) as u32;
            for k in 0..=n {
                let t = k as f64 / n as f64;
                let p = P::new(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
                let one = Rolls { seed: roll.seed, id: roll.id * 64 + side * 16 + k, salt: roll.salt + 1 };
                let h = ext.height(p.x, p.y);
                let shade = hash32(roll.seed, one.id, one.salt + 9);
                match sc.hedge {
                    Hedge::Bush => {
                        let s = HEDGE_BUSH_SCALE.0 + one.r(0) * HEDGE_BUSH_SCALE.1;
                        bush(&mut out.leaf, sc, p, h, s, one.r(1) * TAU, shade);
                    }
                    Hedge::Poplar => {
                        let s = TREE_SCALE.0 + one.r(0) * TREE_SCALE.1;
                        tree(out, sc, Species::Poplar, p, h, s, one.r(1) * TAU, shade);
                    }
                }
            }
        }
    }
    if f.crop.grain() {
        let n = if roll.r(13) < 0.5 { 1 } else { 2 };
        for k in 0..n {
            let x = f.x0 + HAY_MARGIN + roll.r(14 + k * 2) * (f.x1 - f.x0 - 2.0 * HAY_MARGIN).max(0.0);
            let y = f.y0 + HAY_MARGIN + roll.r(15 + k * 2) * (f.y1 - f.y0 - 2.0 * HAY_MARGIN).max(0.0);
            let h = ext.height(x, y);
            let at = [x, h + HAY[1] / 2.0 - SINK / 2.0, y];
            out.hay.push(at, roll.r(19 + k) * TAU, 0.0, [HAY[0], HAY[1], HAY[0]], HAY_COLOUR);
        }
    }
}

/// Posts every ~0.36 tiles, and two rails between each pair of posts, following the slope.
fn fence(wood: &mut Parts, ext: &Ext, a: P, b: P) {
    let n = (a.dist(b) / POST_GAP).round().max(1.0) as u32;
    let posts: Vec<(P, f64)> = (0..=n)
        .map(|k| {
            let t = k as f64 / n as f64;
            let p = P::new(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
            (p, ext.height(p.x, p.y))
        })
        .collect();
    for &(p, h) in &posts {
        wood.push([p.x, h + POST[1] / 2.0 - SINK / 2.0, p.y], 0.0, 0.0, [POST[0], POST[1] + SINK, POST[2]], POST_COLOUR);
    }
    for pair in posts.windows(2) {
        let ((p, hp), (q, hq)) = (pair[0], pair[1]);
        let (dx, dz, dh) = (q.x - p.x, q.y - p.y, hq - hp);
        let run = hyp(dx, dz);
        let (yaw, pitch, len) = (atan2(-dz, dx), atan2(dh, run), hyp(run, dh));
        for rh in RAIL_H {
            let at = [(p.x + q.x) / 2.0, (hp + hq) / 2.0 + rh, (p.y + q.y) / 2.0];
            wood.push(at, yaw, pitch, [len, RAIL[0], RAIL[1]], RAIL_COLOUR);
        }
    }
}

/// A dry-stone wall: stones `len·1.05 × .2·(0.8 to 1.3) × .13`, cycling four greys.
fn wall(wood: &mut Parts, ext: &Ext, a: P, b: P) {
    let n = (a.dist(b) / WALL_GAP).round().max(1.0) as u32;
    let (dx, dz) = ((b.x - a.x) / n as f64, (b.y - a.y) / n as f64);
    let len = hyp(dx, dz);
    let yaw = atan2(-dz, dx);
    for k in 0..n {
        let p = P::new(a.x + dx * (k as f64 + 0.5), a.y + dz * (k as f64 + 0.5));
        let hgt = WALL_H.0 + hash32(k, (p.x * 64.0) as i32 as u32, (p.y * 64.0) as i32 as u32) as f64 / TWO_32 * WALL_H.1;
        let h = ext.height(p.x, p.y);
        let colour = WALL_COLOURS[k as usize % WALL_COLOURS.len()];
        wood.push([p.x, h + hgt / 2.0 - SINK / 2.0, p.y], yaw, 0.0, [len * WALL_LEN, hgt + SINK, WALL_D], colour);
    }
}
