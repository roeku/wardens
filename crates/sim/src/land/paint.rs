//! Ground painting, per texel (03-land.md §4 "Ground painting", 02-look.md §4 "Ground texture"): 12 texels per
//! tile over the extended grid, each a colour picked from a ramp by ordered dithering between two steps.

use super::ext::{Ext, Ground};
use super::fields::{Crop, Field};
use super::roads::seg_dist;
use super::scape::Scape;
use super::{BORDER, TEX};
use crate::contracts::P;
use crate::map::{BattleMap, SiteKind, WATER_Y};
use crate::math::lerp;
use crate::rng::{fbm, hash32, noise};

/// What a texel was painted as. Tufts and flowers go only on `Grass`; the scatter reads it too.
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    Grass = 0,
    Forest,
    Rock,
    Water,
    Ford,
    Road,
    Field,
    Yard,
    /// Grass worn at a road's verge, or a pebble shore: no tufts, flowers or bushes.
    Edge,
}

pub struct Painted {
    /// Texels across and down.
    pub tw: usize,
    pub th: usize,
    pub rgba: Vec<u8>,
    pub class: Vec<Class>,
}

impl Painted {
    /// The class of the texel under map point `p` (`Rock` off the painted area).
    pub fn class_at(&self, p: P) -> Class {
        let tx = ((p.x + BORDER as f64) * TEX as f64).floor();
        let ty = ((p.y + BORDER as f64) * TEX as f64).floor();
        if tx < 0.0 || ty < 0.0 || tx >= self.tw as f64 || ty >= self.th as f64 {
            return Class::Rock;
        }
        self.class[ty as usize * self.tw + tx as usize]
    }
}

/// The 4×4 Bayer matrix, used everywhere as `(m + 0.5)/16`.
pub const BAYER: [u8; 16] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

pub fn bayer(x: usize, y: usize) -> f64 {
    (BAYER[(y & 3) * 4 + (x & 3)] as f64 + 0.5) / 16.0
}

/// The ramp step at position `f` (0..1), dithered between its two nearest steps by `b`.
pub fn ramp(r: &[u32], f: f64, b: f64) -> u32 {
    let p = f.clamp(0.0, 1.0) * (r.len() - 1) as f64;
    let i = p.floor() as usize;
    if i + 1 < r.len() && p - i as f64 > b { r[i + 1] } else { r[i] }
}

/// Noise grids are sampled at quarter tiles and read bilinearly.
const GRID_PER_TILE: usize = 4;
const TEX_PER_CELL: usize = TEX / GRID_PER_TILE;
/// Grid channels.
const WARP_X: usize = 0;
const WARP_Y: usize = 1;
const PATCH: usize = 2;
const DRY: usize = 3;
const MEADOW_N: usize = 4;
const FINE: usize = 5;
const WOB: usize = 6;
const CHANNELS: usize = 7;

/// Edge warp: tiles are looked up through `(noise(seed, 1.7x, 1.7y) − .5)·.7`.
const WARP_FREQ: f64 = 1.7;
const WARP_AMP: f64 = 0.7;
const WARP_SALT_X: u32 = 71;
const WARP_SALT_Y: u32 = 72;
const PATCH_FREQ: f64 = 0.18;
const DRY_FREQ: f64 = 0.09;
const MEADOW_FREQ: f64 = 0.22;
/// A finer single-octave noise for texture within a ramp, and a wobble for road and yard edges.
const FINE_FREQ: f64 = 0.8;
const FINE_SALT: u32 = 73;
const WOB_FREQ: f64 = 1.3;
const WOB_SALT: u32 = 74;

/// Grass: `f = (patch − .28)·2.1 + (fine − .5)·.2`, +0.14 within `NEAR_ROAD` of a road's centre line.
const GRASS_PATCH_AT: f64 = 0.28;
const GRASS_PATCH_K: f64 = 2.1;
const GRASS_FINE_K: f64 = 0.2;
const NEAR_ROAD_LIFT: f64 = 0.14;
const NEAR_ROAD: f64 = 1.0;
/// The dry ramp's threshold is dithered over this width, so dry patches stipple at their edge.
const DRY_DITHER: f64 = 0.04;
/// Roads: half-width `.44 ± .08` (noise), ruts at `0.12 ± 0.04` from the centre, pale edges beyond 0.24.
const ROAD_HALF: f64 = 0.44;
const ROAD_WOBBLE: f64 = 0.16;
const RUT_AT: f64 = 0.12;
const RUT_HALF: f64 = 0.04;
const ROAD_EDGE: f64 = 0.24;
const RUT_DARKEN: f64 = 0.45;
const EDGE_PALEN: f64 = 0.3;
/// Worn verges (dirt[2]) fade out over this width past the road's edge.
const VERGE_W: f64 = 0.14;
/// The road distance field reaches this far; beyond, a texel is "far" from any road.
const ROAD_REACH: f64 = 1.0;
const ROAD_FAR: f32 = 9.0;
/// Yards: within `yardR ± 0.3` (noise) of a site.
const YARD_WOBBLE: f64 = 0.6;
/// Fields: stripes every 1/3.2 tile across the rows, light 0.65 / dark 0.3; a darker furrow at the edge.
const STRIPES_PER_TILE: f64 = 3.2;
const STRIPE_LIGHT: f64 = 0.65;
const STRIPE_DARK: f64 = 0.3;
const FURROW_W: f64 = 0.09;
/// Rock: cracks where `|noise(3.5x) − .5| < .03` (×0.45); a turf cap on tops flatter than `CAP_SLOPE`.
const CRACK_FREQ: f64 = 3.5;
const CRACK_W: f64 = 0.03;
const CRACK_DARKEN: f64 = 0.45;
const CRACK_SALT: u32 = 75;
const CAP_SLOPE: f64 = 0.45;
const LICHEN_RATE: u32 = (0.03 * 4_294_967_296.0) as u32;
const LICHEN_SALT: u32 = 76;
const PEBBLE_SALT: u32 = 77;
/// Pebble shores: grass near water lower than `WATER_Y + SHORE_H ± wobble`.
const SHORE_H: f64 = 0.1;
const SHORE_WOBBLE: f64 = 0.08;
/// Tufts on a 3×3-texel cell grid; wildflowers on 2×2 cells; a 4×4-tile patch keeps one flower colour.
const TUFT_CELL: usize = 3;
const TUFT_SALT: u32 = 78;
const FLOWER_CELL: usize = 2;
const FLOWER_SALT: u32 = 79;
const FLOWER_PATCH: f64 = 4.0;
const FLOWER_PATCH_SALT: u32 = 80;
const FLOWER_NEIGHBOUR: f64 = 0.25;
const FLOWER_MEADOW_AT: f64 = 0.56;
const FLOWER_BASE: f64 = 0.05;
const FLOWER_SLOPE: f64 = 0.9;
const FLOWER_SPARSE: f64 = 0.012;

pub fn yard_r(kind: SiteKind) -> f64 {
    match kind {
        SiteKind::Keep => 2.6,
        SiteKind::Town => 3.0,
        SiteKind::Village => 1.9,
        _ => 1.2,
    }
}

const TWO_32: f64 = 4_294_967_296.0;

fn unit(h: u32) -> f64 {
    h as f64 / TWO_32
}

pub fn paint(m: &BattleMap, ext: &Ext, roads: &[Vec<P>], fields: &[Field], sc: &Scape) -> Painted {
    let (tw, th) = (ext.ew * TEX, ext.eh * TEX);
    let seed = m.seed;
    let grid = Grid::new(ext, seed);
    let road_d = road_field(roads, tw, th);
    let field_id = field_map(fields, tw, th);
    let near_site = near_sites(m, ext);
    let near_water = near_water(ext);

    let mut rgba = vec![0u8; tw * th * 4];
    let mut class = vec![Class::Grass; tw * th];
    let texel = 1.0 / TEX as f64;
    let origin = -(BORDER as f64);

    let mut row = vec![[0f32; CHANNELS]; grid.gw];
    for ty in 0..th {
        let y = origin + (ty as f64 + 0.5) * texel;
        grid.row(ty, &mut row);
        for tx in 0..tw {
            let x = origin + (tx as f64 + 0.5) * texel;
            let k = ty * tw + tx;
            let b = bayer(tx, ty);
            let n = Grid::along(&row, tx);
            let rd = road_d[k] as f64;
            let (ex, ey) = (tx / TEX, ty / TEX);

            // The tile under the warped point decides water, ford, rock and wood.
            let g = ext.at(P::new(x + n[WARP_X], y + n[WARP_Y]));
            let site = near_site[ey * ext.ew + ex];
            let yard = site > 0 && {
                let s = &m.sites[site as usize - 1];
                P::new(x, y).dist(s.at) < yard_r(s.kind) + (n[WOB] - 0.5) * YARD_WOBBLE
            };
            let road_half = ROAD_HALF + (n[WOB] - 0.5) * ROAD_WOBBLE;

            let (cl, col) = match g {
                Ground::Water => (Class::Water, ramp(sc.bed, 0.3 + n[FINE] * 0.5, b)),
                Ground::Ford => {
                    let jag = unit(hash32(seed, k as u32, PEBBLE_SALT)) - 0.5;
                    (Class::Ford, ramp(sc.pebble, 0.5 + (n[FINE] - 0.5) * 0.6 + jag * 0.5, b))
                }
                _ if yard => {
                    let f = 0.5 + (n[FINE] - 0.5) * 0.5 + (n[PATCH] - 0.5) * 0.3;
                    (Class::Yard, ramp(sc.yard, f, b))
                }
                _ if rd < road_half => {
                    let mut f = 0.5 + (n[FINE] - 0.5) * 0.4;
                    if (rd - RUT_AT).abs() < RUT_HALF {
                        f -= RUT_DARKEN;
                    } else if rd > ROAD_EDGE {
                        f += EDGE_PALEN;
                    }
                    (Class::Road, ramp(sc.dirt, f, b))
                }
                _ if field_id[k] > 0 => {
                    let fl = &fields[field_id[k] as usize - 1];
                    (Class::Field, field_colour(fl, x, y, n[FINE], b, sc))
                }
                Ground::Rock => (Class::Rock, rock_colour(ext, seed, k, x, y, &n, b, sc)),
                Ground::Forest => {
                    let f = (n[PATCH] - 0.3) * 1.6 + (n[FINE] - 0.5) * 0.3;
                    (Class::Forest, ramp(sc.moss, f, b))
                }
                Ground::Open | Ground::Road => {
                    let shore = near_water[ey * ext.ew + ex]
                        && ext.height(x, y) < WATER_Y + SHORE_H + (n[WOB] - 0.5) * SHORE_WOBBLE;
                    if shore {
                        (Class::Edge, ramp(sc.pebble, n[FINE], b))
                    } else if rd < road_half + VERGE_W && 1.0 - (rd - road_half) / VERGE_W > b {
                        (Class::Edge, sc.dirt[2])
                    } else {
                        let lift = if rd < NEAR_ROAD { NEAR_ROAD_LIFT } else { 0.0 };
                        let f = (n[PATCH] - GRASS_PATCH_AT) * GRASS_PATCH_K + (n[FINE] - 0.5) * GRASS_FINE_K + lift;
                        let dry = n[DRY] > sc.dry_at + (b - 0.5) * DRY_DITHER;
                        (Class::Grass, ramp(if dry { sc.dry } else { sc.grass }, f, b))
                    }
                }
            };
            class[k] = cl;
            put(&mut rgba, k, col);
        }
    }

    stamp_tufts(&mut rgba, &class, tw, th, seed, sc);
    stamp_flowers(&mut rgba, &class, &grid, tw, th, seed, sc);
    Painted { tw, th, rgba, class }
}

fn put(rgba: &mut [u8], k: usize, c: u32) {
    rgba[k * 4] = (c >> 16) as u8;
    rgba[k * 4 + 1] = (c >> 8) as u8;
    rgba[k * 4 + 2] = c as u8;
    rgba[k * 4 + 3] = 255;
}

fn field_colour(fl: &Field, x: f64, y: f64, fine: f64, b: f64, sc: &Scape) -> u32 {
    let edge = (x - fl.x0).min(fl.x1 - x).min(y - fl.y0).min(fl.y1 - y);
    let across = if fl.along_x { y - fl.y0 } else { x - fl.x0 };
    let light = (across * STRIPES_PER_TILE).floor() as i64 % 2 == 0;
    let stripe = if edge < FURROW_W {
        0.0
    } else if light {
        STRIPE_LIGHT
    } else {
        STRIPE_DARK
    };
    let f = stripe + (fine - 0.5) * 0.15;
    let r = match fl.crop {
        Crop::Wheat => sc.wheat,
        Crop::Barley => sc.barley,
        Crop::Plough => sc.plough,
        Crop::Meadow => sc.meadow,
    };
    ramp(r, f, b)
}

#[allow(clippy::too_many_arguments)]
fn rock_colour(ext: &Ext, seed: u32, k: usize, x: f64, y: f64, n: &[f64; CHANNELS], b: f64, sc: &Scape) -> u32 {
    if hash32(seed, k as u32, LICHEN_SALT) < LICHEN_RATE {
        return sc.lichen;
    }
    if ext.slope(x, y) < CAP_SLOPE {
        return ramp(sc.moss, 0.45 + (n[FINE] - 0.5) * 0.6 + (n[PATCH] - 0.5) * 0.4, b);
    }
    let c = ramp(sc.rock, 0.55 + (n[FINE] - 0.5) * 0.7 + (n[PATCH] - 0.5) * 0.4, b);
    if (noise(seed, x * CRACK_FREQ, y * CRACK_FREQ, CRACK_SALT) - 0.5).abs() < CRACK_W {
        let d = |v: u32| ((v & 0xff) as f64 * CRACK_DARKEN) as u32;
        return (d(c >> 16) << 16) | (d(c >> 8) << 8) | d(c);
    }
    c
}

/// Tufts: a light blade (`grass[4]`) with its dark root (`grass[0]`) just below it on screen, in a 3×3 cell.
fn stamp_tufts(rgba: &mut [u8], class: &[Class], tw: usize, th: usize, seed: u32, sc: &Scape) {
    let (cw, ch) = (tw / TUFT_CELL, th / TUFT_CELL);
    let limit = (sc.tufts * TWO_32) as u64;
    for cy in 0..ch {
        for cx in 0..cw {
            let h = hash32(seed, (cy * cw + cx) as u32, TUFT_SALT);
            if (h as u64) >= limit {
                continue;
            }
            // The blade sits at x 1..2, y 0..1 of the cell; the root at (x−1, y+1) shows straight below it.
            let bx = cx * TUFT_CELL + 1 + ((h >> 8) & 1) as usize;
            let by = cy * TUFT_CELL + ((h >> 9) & 1) as usize;
            let (blade, root) = (by * tw + bx, (by + 1) * tw + bx - 1);
            if class[blade] == Class::Grass && class[root] == Class::Grass {
                put(rgba, blade, sc.grass[sc.grass.len() - 1]);
                put(rgba, root, sc.grass[0]);
            }
        }
    }
}

/// Wildflowers: one texel in some 2×2 cells, denser where the meadow noise is high; colours by 4×4-tile patch.
fn stamp_flowers(rgba: &mut [u8], class: &[Class], grid: &Grid, tw: usize, th: usize, seed: u32, sc: &Scape) {
    let (cw, ch) = (tw / FLOWER_CELL, th / FLOWER_CELL);
    let patches_w = ((tw / TEX) as f64 / FLOWER_PATCH).ceil() as u32 + 1;
    for cy in 0..ch {
        for cx in 0..cw {
            let h = hash32(seed, (cy * cw + cx) as u32, FLOWER_SALT);
            let (fx, fy) = (cx * FLOWER_CELL + (h & 1) as usize, cy * FLOWER_CELL + ((h >> 1) & 1) as usize);
            let k = fy * tw + fx;
            if class[k] != Class::Grass {
                continue;
            }
            let meadow = grid.read(fx, fy)[MEADOW_N];
            let density = if meadow > FLOWER_MEADOW_AT {
                FLOWER_BASE + (meadow - FLOWER_MEADOW_AT) * FLOWER_SLOPE
            } else {
                FLOWER_SPARSE
            } * sc.flowers_k;
            // The density test uses the hash's top bits; the low bits placed the flower.
            if unit(h & 0xffff_fffc) >= density {
                continue;
            }
            let (px, py) = (
                (fx as f64 / TEX as f64 / FLOWER_PATCH) as u32,
                (fy as f64 / TEX as f64 / FLOWER_PATCH) as u32,
            );
            let pick = hash32(seed, cy as u32 * cw as u32 + cx as u32, FLOWER_SALT + 1);
            let (px, py) = if unit(pick) < FLOWER_NEIGHBOUR {
                if pick & 1 == 0 { (px + 1, py) } else { (px, py + 1) }
            } else {
                (px, py)
            };
            let c = hash32(seed, py * patches_w + px, FLOWER_PATCH_SALT) as usize % sc.flowers.len();
            put(rgba, k, sc.flowers[c]);
        }
    }
}

/// Quarter-tile noise grids over the extended area, interleaved by channel, read bilinearly per texel.
struct Grid {
    gw: usize,
    v: Vec<[f32; CHANNELS]>,
}

impl Grid {
    fn new(ext: &Ext, seed: u32) -> Grid {
        let (gw, gh) = (ext.ew * GRID_PER_TILE + 1, ext.eh * GRID_PER_TILE + 1);
        let step = 1.0 / GRID_PER_TILE as f64;
        let origin = -(BORDER as f64);
        let mut v = Vec::with_capacity(gw * gh);
        for j in 0..gh {
            let y = origin + j as f64 * step;
            for i in 0..gw {
                let x = origin + i as f64 * step;
                v.push([
                    ((noise(seed, x * WARP_FREQ, y * WARP_FREQ, WARP_SALT_X) - 0.5) * WARP_AMP) as f32,
                    ((noise(seed, x * WARP_FREQ, y * WARP_FREQ, WARP_SALT_Y) - 0.5) * WARP_AMP) as f32,
                    fbm(seed.wrapping_add(5), x * PATCH_FREQ, y * PATCH_FREQ, 5) as f32,
                    fbm(seed.wrapping_add(6), x * DRY_FREQ, y * DRY_FREQ, 6) as f32,
                    fbm(seed.wrapping_add(11), x * MEADOW_FREQ, y * MEADOW_FREQ, 11) as f32,
                    noise(seed, x * FINE_FREQ, y * FINE_FREQ, FINE_SALT) as f32,
                    noise(seed, x * WOB_FREQ, y * WOB_FREQ, WOB_SALT) as f32,
                ]);
            }
        }
        Grid { gw, v }
    }

    /// The grid read down to texel row `ty`'s centre, every column: the vertical half of the bilinear read.
    fn row(&self, ty: usize, out: &mut [[f32; CHANNELS]]) {
        let j = ty / TEX_PER_CELL;
        let fy = ((ty % TEX_PER_CELL) as f32 + 0.5) / TEX_PER_CELL as f32;
        let (top, bottom) = (&self.v[j * self.gw..(j + 1) * self.gw], &self.v[(j + 1) * self.gw..(j + 2) * self.gw]);
        for ((o, t), b) in out.iter_mut().zip(top).zip(bottom) {
            for ch in 0..CHANNELS {
                o[ch] = t[ch] + (b[ch] - t[ch]) * fy;
            }
        }
    }

    /// Every channel at texel column `tx`'s centre along a row from `row`: the horizontal half.
    fn along(row: &[[f32; CHANNELS]], tx: usize) -> [f64; CHANNELS] {
        let i = tx / TEX_PER_CELL;
        let fx = ((tx % TEX_PER_CELL) as f32 + 0.5) / TEX_PER_CELL as f32;
        let (a, b) = (&row[i], &row[i + 1]);
        let mut out = [0.0; CHANNELS];
        for (ch, o) in out.iter_mut().enumerate() {
            *o = (a[ch] + (b[ch] - a[ch]) * fx) as f64;
        }
        out
    }

    /// Every channel at texel (tx, ty)'s centre. A grid cell spans 3 texels, so the weights are 1/6, 1/2, 5/6.
    fn read(&self, tx: usize, ty: usize) -> [f64; CHANNELS] {
        let (i, j) = (tx / TEX_PER_CELL, ty / TEX_PER_CELL);
        let fx = ((tx % TEX_PER_CELL) as f64 + 0.5) / TEX_PER_CELL as f64;
        let fy = ((ty % TEX_PER_CELL) as f64 + 0.5) / TEX_PER_CELL as f64;
        let (a, b) = (&self.v[j * self.gw + i], &self.v[j * self.gw + i + 1]);
        let (c, d) = (&self.v[(j + 1) * self.gw + i], &self.v[(j + 1) * self.gw + i + 1]);
        let mut out = [0.0; CHANNELS];
        for (ch, o) in out.iter_mut().enumerate() {
            let top = lerp(a[ch] as f64, b[ch] as f64, fx);
            let bottom = lerp(c[ch] as f64, d[ch] as f64, fx);
            *o = lerp(top, bottom, fy);
        }
        out
    }
}

/// Per texel, the distance to the nearest road's centre line, within `ROAD_REACH` (else `ROAD_FAR`).
fn road_field(roads: &[Vec<P>], tw: usize, th: usize) -> Vec<f32> {
    let mut d = vec![ROAD_FAR; tw * th];
    let t = TEX as f64;
    let b = BORDER as f64;
    for seg in roads.iter().flat_map(|r| r.windows(2)) {
        let (a, c) = (seg[0], seg[1]);
        let x0 = (((a.x.min(c.x) - ROAD_REACH + b) * t).floor().max(0.0)) as usize;
        let x1 = (((a.x.max(c.x) + ROAD_REACH + b) * t).ceil().max(0.0) as usize).min(tw);
        let y0 = (((a.y.min(c.y) - ROAD_REACH + b) * t).floor().max(0.0)) as usize;
        let y1 = (((a.y.max(c.y) + ROAD_REACH + b) * t).ceil().max(0.0) as usize).min(th);
        for ty in y0..y1 {
            let y = (ty as f64 + 0.5) / t - b;
            for tx in x0..x1 {
                let x = (tx as f64 + 0.5) / t - b;
                let v = seg_dist(P::new(x, y), a, c) as f32;
                let o = &mut d[ty * tw + tx];
                if v < *o {
                    *o = v;
                }
            }
        }
    }
    d
}

/// Per texel, 1 + the index of the field covering it, or 0.
fn field_map(fields: &[Field], tw: usize, th: usize) -> Vec<u16> {
    let mut out = vec![0u16; tw * th];
    let t = TEX as f64;
    let b = BORDER as f64;
    for (n, f) in fields.iter().enumerate() {
        let tx0 = ((f.x0 + b) * t - 0.5).ceil().max(0.0) as usize;
        let tx1 = (((f.x1 + b) * t - 0.5).floor().max(-1.0) + 1.0) as usize;
        let ty0 = ((f.y0 + b) * t - 0.5).ceil().max(0.0) as usize;
        let ty1 = (((f.y1 + b) * t - 0.5).floor().max(-1.0) + 1.0) as usize;
        for ty in ty0..ty1.min(th) {
            for tx in tx0..tx1.min(tw) {
                out[ty * tw + tx] = n as u16 + 1;
            }
        }
    }
    out
}

/// Per extended tile, 1 + the index of a site whose yard may reach it, or 0.
fn near_sites(m: &BattleMap, ext: &Ext) -> Vec<u8> {
    let mut out = vec![0u8; ext.ew * ext.eh];
    for (n, s) in m.sites.iter().enumerate() {
        let r = yard_r(s.kind) + YARD_WOBBLE;
        let (x0, x1) = ((s.at.x - r).floor() as i32, (s.at.x + r).floor() as i32);
        let (y0, y1) = ((s.at.y - r).floor() as i32, (s.at.y + r).floor() as i32);
        for ty in y0..=y1 {
            for tx in x0..=x1 {
                let (ex, ey) = (tx + BORDER, ty + BORDER);
                if ex >= 0 && ey >= 0 && (ex as usize) < ext.ew && (ey as usize) < ext.eh {
                    out[ey as usize * ext.ew + ex as usize] = n as u8 + 1;
                }
            }
        }
    }
    out
}

/// Tiles within `WATER_NEAR` (Chebyshev) of water or a ford: where water quads go and shores are painted.
pub const WATER_NEAR: i32 = 2;

pub fn near_water(ext: &Ext) -> Vec<bool> {
    let (ew, eh) = (ext.ew as i32, ext.eh as i32);
    let mut out = vec![false; ext.ew * ext.eh];
    for (k, g) in ext.cls.iter().enumerate() {
        if !matches!(g, Ground::Water | Ground::Ford) {
            continue;
        }
        let (cx, cy) = (k as i32 % ew, k as i32 / ew);
        for y in (cy - WATER_NEAR).max(0)..=(cy + WATER_NEAR).min(eh - 1) {
            for x in (cx - WATER_NEAR).max(0)..=(cx + WATER_NEAR).min(ew - 1) {
                out[(y * ew + x) as usize] = true;
            }
        }
    }
    out
}
