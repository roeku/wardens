//! The extended grid: the map plus `BORDER` tiles of country past every edge (03-land.md §4 "Outside the
//! map"). Inside the map every tile and height is the rules' own; outside, the river runs on, woods, rocks,
//! lakes and pools come from noise, and the ground rises away from the field.

use super::BORDER;
use super::scape::Scape;
use crate::contracts::P;
use crate::map::{BattleMap, HEIGHT_STEP, Tile, WATER_Y};
use crate::math::{hyp, lerp, smoothstep};
use crate::rng::{fbm, jit, noise};

/// What the ground is, per extended tile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ground {
    Open,
    Forest,
    Rock,
    Water,
    Ford,
    /// A rules road tile that is not a ford. Painted as grass: the drawn road follows the smoothed line.
    Road,
}

/// The river past the north and south edges wanders at most this far from where it left the map.
const RIVER_WANDER: i32 = 2;
/// Chance per row that the river drifts a column, as inside the map (§3a).
const RIVER_DRIFT: f64 = 0.3;
const RIVER_SALT: u32 = 31;
/// Lakes only more than this far out, pools more than this.
const LAKE_OUT: f64 = 3.0;
const POOL_OUT: f64 = 2.5;
/// Woods thicken outward: the threshold drops by `out·0.01`, at most 0.12.
const WOOD_THIN_PER_TILE: f64 = 0.01;
const WOOD_THIN_MAX: f64 = 0.12;
/// Peaks reach full height 9 tiles out.
const PEAK_REACH: f64 = 9.0;
const PEAK_SALT: u32 = 14;
/// The seam: outside heights blend in over 2 tiles past the edge.
const SEAM: f64 = 2.0;
/// Smoothed tile-mask radii, as the map's relief uses them (§3d).
const MASK_WATER: f64 = 1.2;
const MASK_ROCK: f64 = 0.8;
const MASK_WOOD: f64 = 1.5;
/// Outside the map, where the water mask passes 0.45 the bed is held below the surface: 0.05 down at the
/// threshold, deepening by 0.6 per unit of mask toward the channel's middle.
const RIVER_BED_AT: f64 = 0.45;
const RIVER_BED_DEPTH: f64 = 0.05;
const RIVER_BED_SLOPE: f64 = 0.6;

pub struct Ext {
    /// The map's size in tiles.
    pub w: i32,
    pub h: i32,
    /// The extended grid's size in tiles; tile (0, 0) is the map's (−BORDER, −BORDER).
    pub ew: usize,
    pub eh: usize,
    pub cls: Vec<Ground>,
    /// Half-tile samples over the extended grid, `(2ew+1) × (2eh+1)`, row-major from the north.
    pub heights: Vec<f32>,
}

impl Ext {
    pub fn new(m: &BattleMap, sc: &Scape) -> Ext {
        let (w, h) = (m.w as i32, m.h as i32);
        let (ew, eh) = ((w + 2 * BORDER) as usize, (h + 2 * BORDER) as usize);
        let north = river_beyond(m, -1);
        let south = river_beyond(m, 1);
        let mut cls = Vec::with_capacity(ew * eh);
        for ey in 0..eh as i32 {
            let ty = ey - BORDER;
            let river = if ty < 0 {
                north.get((-ty - 1) as usize).copied()
            } else if ty >= h {
                south.get((ty - h) as usize).copied()
            } else {
                None
            };
            for ex in 0..ew as i32 {
                let tx = ex - BORDER;
                cls.push(match m.idx(tx, ty) {
                    Some(i) => match m.tiles[i] {
                        Tile::Open => Ground::Open,
                        Tile::Forest => Ground::Forest,
                        Tile::Rock => Ground::Rock,
                        Tile::Water => Ground::Water,
                        Tile::Road if m.ford[i] => Ground::Ford,
                        Tile::Road => Ground::Road,
                    },
                    None => beyond(m.seed, sc, w, h, tx, ty, river),
                });
            }
        }
        Ext { w, h, ew, eh, cls, heights: Vec::new() }
    }

    /// The ground at tile (tx, ty) in map coordinates; past the extended grid, its nearest edge tile.
    pub fn tile(&self, tx: i32, ty: i32) -> Ground {
        let ex = (tx + BORDER).clamp(0, self.ew as i32 - 1) as usize;
        let ey = (ty + BORDER).clamp(0, self.eh as i32 - 1) as usize;
        self.cls[ey * self.ew + ex]
    }

    pub fn at(&self, p: P) -> Ground {
        self.tile(p.x.floor() as i32, p.y.floor() as i32)
    }

    /// How far `p` lies outside the map's rectangle (0 inside).
    pub fn out(&self, x: f64, y: f64) -> f64 {
        out_of(self.w, self.h, x, y)
    }

    /// Clears woods and rock outside the map within `r` of any point of `lines`, so roads run on open ground.
    pub fn clear_along(&mut self, lines: &[Vec<P>], r: f64) {
        for p in lines.iter().flatten() {
            let (x0, x1) = ((p.x - r).floor() as i32, (p.x + r).floor() as i32);
            let (y0, y1) = ((p.y - r).floor() as i32, (p.y + r).floor() as i32);
            for ty in y0..=y1 {
                for tx in x0..=x1 {
                    let inside = tx >= 0 && ty >= 0 && tx < self.w && ty < self.h;
                    let (ex, ey) = (tx + BORDER, ty + BORDER);
                    if inside || ex < 0 || ey < 0 || ex >= self.ew as i32 || ey >= self.eh as i32 {
                        continue;
                    }
                    let k = ey as usize * self.ew + ex as usize;
                    let near = hyp(tx as f64 + 0.5 - p.x, ty as f64 + 0.5 - p.y) <= r;
                    if near && matches!(self.cls[k], Ground::Forest | Ground::Rock) {
                        self.cls[k] = Ground::Open;
                    }
                }
            }
        }
    }

    /// Fills `heights`: the map's own samples inside, the outside relief beyond, blended over 2 tiles at the seam.
    pub fn make_heights(&mut self, m: &BattleMap, sc: &Scape) {
        let masks = Masks::new(self);
        let (hw, hh) = (self.ew * 2 + 1, self.eh * 2 + 1);
        let (mw, mh) = (m.heights_w() as i32, m.heights_h() as i32);
        let b2 = BORDER * 2;
        let mut out = Vec::with_capacity(hw * hh);
        for j in 0..hh as i32 {
            for i in 0..hw as i32 {
                let (mi, mj) = (i - b2, j - b2);
                if mi >= 0 && mj >= 0 && mi < mw && mj < mh && !m.heights.is_empty() {
                    out.push(m.heights[(mj * mw + mi) as usize]);
                    continue;
                }
                let (x, y) = (mi as f64 * HEIGHT_STEP, mj as f64 * HEIGHT_STEP);
                let o = self.out(x, y);
                let inner = m.height_at(x.clamp(0.0, m.wf()), y.clamp(0.0, m.hf()));
                let outer = beyond_height(m, sc, &masks, x, y, o);
                out.push(lerp(inner, outer, smoothstep(0.0, SEAM, o)) as f32);
            }
        }
        self.heights = out;
    }

    /// The ground's height at (x, y), interpolated on the same two triangles per half-tile cell as the terrain
    /// mesh (corners a=(i,j), b=(i,j+1), c=(i+1,j+1), d=(i+1,j); triangles abd and bcd).
    pub fn height(&self, x: f64, y: f64) -> f64 {
        let (i, j, fu, fv) = self.cell(x, y);
        let hw = self.ew * 2 + 1;
        let at = |i: usize, j: usize| self.heights[j * hw + i] as f64;
        let (a, b, c, d) = (at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j));
        if fu + fv <= 1.0 { a + (d - a) * fu + (b - a) * fv } else { c + (b - c) * (1.0 - fu) + (d - c) * (1.0 - fv) }
    }

    /// The ground's slope (height per tile) at (x, y), on the mesh's triangle.
    pub fn slope(&self, x: f64, y: f64) -> f64 {
        let (i, j, fu, fv) = self.cell(x, y);
        let hw = self.ew * 2 + 1;
        let at = |i: usize, j: usize| self.heights[j * hw + i] as f64;
        let (a, b, c, d) = (at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j));
        let (gx, gy) = if fu + fv <= 1.0 { (d - a, b - a) } else { (c - b, c - d) };
        hyp(gx, gy) / HEIGHT_STEP
    }

    fn cell(&self, x: f64, y: f64) -> (usize, usize, f64, f64) {
        let (hw, hh) = (self.ew * 2 + 1, self.eh * 2 + 1);
        let u = ((x + BORDER as f64) / HEIGHT_STEP).clamp(0.0, (hw - 1) as f64);
        let v = ((y + BORDER as f64) / HEIGHT_STEP).clamp(0.0, (hh - 1) as f64);
        let (i, j) = ((u.floor() as usize).min(hw - 2), (v.floor() as usize).min(hh - 2));
        (i, j, u - i as f64, v - j as f64)
    }
}

pub fn out_of(w: i32, h: i32, x: f64, y: f64) -> f64 {
    let dx = (-x).max(x - w as f64).max(0.0);
    let dy = (-y).max(y - h as f64).max(0.0);
    hyp(dx, dy)
}

/// The river's west column on each row past the north (`dir` −1) or south (`dir` 1) edge, wandering at most
/// ±2 from where it left the map. Empty when the map has no river.
fn river_beyond(m: &BattleMap, dir: i32) -> Vec<i32> {
    let Some(&edge) = (if dir < 0 { m.river.first() } else { m.river.last() }) else { return Vec::new() };
    let mut x = edge;
    (1..=BORDER)
        .map(|k| {
            let row = if dir < 0 { -k } else { m.h as i32 - 1 + k };
            if jit(m.seed, 0, row, RIVER_SALT) < RIVER_DRIFT {
                let step = if jit(m.seed, 1, row, RIVER_SALT) < 0.5 { -1 } else { 1 };
                x = (x + step).clamp(edge - RIVER_WANDER, edge + RIVER_WANDER);
            }
            x
        })
        .collect()
}

/// The ground of an outside tile: the river, then lakes and pools, rock, and woods that thicken outward.
fn beyond(seed: u32, sc: &Scape, w: i32, h: i32, tx: i32, ty: i32, river: Option<i32>) -> Ground {
    let b = &sc.beyond;
    let (x, y) = (tx as f64 + 0.5, ty as f64 + 0.5);
    if river.is_some_and(|rx| tx == rx || tx == rx + 1) {
        return Ground::Water;
    }
    let o = out_of(w, h, x, y);
    if b.lake < 1.0 && o > LAKE_OUT && fbm(seed.wrapping_add(12), x / 10.0, y / 10.0, 12) > b.lake {
        return Ground::Water;
    }
    if b.pools < 1.0 && o > POOL_OUT && fbm(seed.wrapping_add(13), x / 3.5, y / 3.5, 13) > b.pools {
        return Ground::Water;
    }
    if fbm(seed.wrapping_add(9), x / 5.0, y / 5.0, 9) > b.rock {
        return Ground::Rock;
    }
    if fbm(seed.wrapping_add(3), x / 7.0, y / 7.0, 3) > b.wood - (o * WOOD_THIN_PER_TILE).min(WOOD_THIN_MAX) {
        return Ground::Forest;
    }
    Ground::Open
}

/// The outside relief at (x, y), `o` tiles past the edge: the map's base noise at a larger amplitude, ground
/// rising toward the horizon, optional peaks, and then the map's own hills and tile masks (§3d), so the river
/// keeps its channel and outside rocks stand up as crags.
fn beyond_height(m: &BattleMap, sc: &Scape, masks: &Masks, x: f64, y: f64, o: f64) -> f64 {
    let (s, b) = (m.seed, &sc.beyond);
    let water = masks.read(&masks.water, x, y);
    let (rock, wood) = (masks.read(&masks.rock, x, y), masks.read(&masks.wood, x, y));
    let mut h = (fbm(s.wrapping_add(1), x * 0.06, y * 0.06, 1) - 0.5) * 0.9;
    // North, east, south, west: the strongest edge this point lies past. The river cuts its valley through the
    // rising ground and peaks, so it keeps flowing instead of climbing out of the bowl.
    let past = [y < 0.0, x > m.wf(), y > m.hf(), x < 0.0];
    let side = (0..4).filter(|&k| past[k]).map(|k| b.sides[k]).fold(0.0, f64::max) * (1.0 - water.min(1.0));
    h += (o * b.rise).min(b.cap) * side * (0.6 + fbm(s.wrapping_add(2), x * 0.1, y * 0.1, 2) * 0.8);
    if b.peak > 0.0 {
        let ridge = 1.0 - (2.0 * noise(s, x * 0.16, y * 0.16, PEAK_SALT) - 1.0).abs();
        h += b.peak * ridge * ridge * (o / PEAK_REACH).min(1.0) * side;
    }
    for hill in &m.hills {
        let t = hyp(x - hill.at.x, y - hill.at.y) / hill.r;
        if t < 1.0 {
            let q = 1.0 - t * t;
            h += hill.h * q * q;
        }
    }
    if rock > 0.15 {
        h += (rock - 0.15) * (2.3 + fbm(s.wrapping_add(4), x * 0.5, y * 0.5, 4) * 1.4);
    }
    h += wood * 0.12;
    h -= (water * 1.6).min(1.0) * 0.75;
    // Over the river's own tiles the bed always lies under the surface, as a ford's does inside the map (§3d).
    if water > RIVER_BED_AT {
        h = h.min(WATER_Y - RIVER_BED_DEPTH - (water - RIVER_BED_AT) * RIVER_BED_SLOPE);
    }
    if water < 0.02 {
        h = h.max(WATER_Y + 0.08);
    }
    h
}

/// Smoothed tile masks over the extended grid, as the relief's (§3d): each tile of a type stamps a cone
/// `max(0, 1 − d/(r+0.5))` (the strongest wins), read bilinearly between tile centres. Fords count as water
/// here: outside the map there are none, and at the seam the map's own heights win.
struct Masks {
    ew: usize,
    eh: usize,
    water: Vec<f32>,
    rock: Vec<f32>,
    wood: Vec<f32>,
}

impl Masks {
    fn new(e: &Ext) -> Masks {
        let stamp = |is: &dyn Fn(Ground) -> bool, r: f64| {
            let reach = r + 0.5;
            let k = reach.ceil() as i32;
            let mut out = vec![0f32; e.cls.len()];
            for (n, _) in e.cls.iter().enumerate().filter(|&(_, &g)| is(g)) {
                let (cx, cy) = ((n % e.ew) as i32, (n / e.ew) as i32);
                for y in (cy - k).max(0)..=(cy + k).min(e.eh as i32 - 1) {
                    for x in (cx - k).max(0)..=(cx + k).min(e.ew as i32 - 1) {
                        let v = (1.0 - hyp((x - cx) as f64, (y - cy) as f64) / reach) as f32;
                        let o = &mut out[y as usize * e.ew + x as usize];
                        *o = o.max(v);
                    }
                }
            }
            out
        };
        Masks {
            ew: e.ew,
            eh: e.eh,
            water: stamp(&|g| matches!(g, Ground::Water | Ground::Ford), MASK_WATER),
            rock: stamp(&|g| g == Ground::Rock, MASK_ROCK),
            wood: stamp(&|g| g == Ground::Forest, MASK_WOOD),
        }
    }

    /// Bilinear between tile centres at map point (x, y).
    fn read(&self, mask: &[f32], x: f64, y: f64) -> f64 {
        let u = (x + BORDER as f64 - 0.5).clamp(0.0, (self.ew - 1) as f64);
        let v = (y + BORDER as f64 - 0.5).clamp(0.0, (self.eh - 1) as f64);
        let (i, j) = ((u.floor() as usize).min(self.ew - 2), (v.floor() as usize).min(self.eh - 2));
        let (tx, ty) = (u - i as f64, v - j as f64);
        let at = |i: usize, j: usize| mask[j * self.ew + i] as f64;
        lerp(lerp(at(i, j), at(i + 1, j), tx), lerp(at(i, j + 1), at(i + 1, j + 1), tx), ty)
    }
}
