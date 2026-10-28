//! Fields (03-land.md §4 "Fields"): striped crops round villages, towns and farms, and a few beyond the map.

use std::f64::consts::TAU;

use super::BORDER;
use super::ext::{Ext, Ground};
use super::roads::seg_dist;
use super::scape::Scape;
use crate::contracts::P;
use crate::map::{BattleMap, SiteKind};
use crate::math::{cos, hyp, sin};
use crate::rng::{Rng, hash32, jit};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Crop {
    Wheat,
    Barley,
    Plough,
    Meadow,
}

const CROPS: [Crop; 4] = [Crop::Wheat, Crop::Barley, Crop::Plough, Crop::Meadow];

impl Crop {
    /// Grain fields get haystacks.
    pub fn grain(self) -> bool {
        matches!(self, Crop::Wheat | Crop::Barley)
    }
}

/// An axis-aligned field in map tiles, `x0..x1 × y0..y1`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Field {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub crop: Crop,
    /// Rows run along x (stripes change with y), else along y.
    pub along_x: bool,
}

impl Field {
    /// The distance from `p` to the field (0 inside).
    pub fn dist(&self, p: P) -> f64 {
        let dx = (self.x0 - p.x).max(p.x - self.x1).max(0.0);
        let dy = (self.y0 - p.y).max(p.y - self.y1).max(0.0);
        hyp(dx, dy)
    }

    fn overlaps(&self, o: &Field, gap: f64) -> bool {
        self.x0 - gap < o.x1 && o.x0 - gap < self.x1 && self.y0 - gap < o.y1 && o.y0 - gap < self.y1
    }
}

const FIELD_SALT: u32 = 41;
const GRID_SALT: u32 = 42;
/// Tries per farmed point: `round(7·farm)`.
const TRIES_PER_FARM: f64 = 7.0;
const DIST_BASE: f64 = 2.8;
const DIST_TOWN: f64 = 1.6;
const DIST_SPAN: f64 = 3.5;
const SIZE_W: (f64, f64) = (1.6, 3.8);
const SIZE_H: (f64, f64) = (1.4, 3.4);
const ROAD_GAP: f64 = 0.9;
const SITE_GAP: f64 = 1.7;
const FIELD_GAP: f64 = 0.4;
/// The farmland grid's spacing, in tiles.
const GRID: f64 = 7.0;
const BEYOND_FIELDS: usize = 14;
/// Tries for the fields beyond the map, and how far past the edge they must lie.
const BEYOND_TRIES: u32 = 400;
const BEYOND_OUT: f64 = 1.0;

pub fn place(m: &BattleMap, ext: &Ext, roads: &[Vec<P>], sc: &Scape) -> Vec<Field> {
    let mut rng = Rng::new(hash32(m.seed, 0, FIELD_SALT));
    let mut fields = Vec::new();
    let ok = |f: &Field, fields: &[Field]| fits(f, m, ext, roads, fields);

    // Farmed points: villages and towns, the map's farms, and the farmland grid.
    let mut farmed: Vec<(P, bool)> = m
        .sites
        .iter()
        .filter(|s| matches!(s.kind, SiteKind::Village | SiteKind::Town))
        .map(|s| (s.at, s.kind == SiteKind::Town))
        .collect();
    farmed.extend(m.farms.iter().map(|&p| (p, false)));
    if sc.farmland > 0.0 {
        let (nx, ny) = ((m.wf() / GRID).ceil() as i32, (m.hf() / GRID).ceil() as i32);
        for gy in 0..ny {
            for gx in 0..nx {
                if jit(m.seed, gx, gy, GRID_SALT) < sc.farmland {
                    let jx = jit(m.seed, gx, gy, GRID_SALT + 1);
                    let jy = jit(m.seed, gx, gy, GRID_SALT + 2);
                    farmed.push((P::new((gx as f64 + jx) * GRID, (gy as f64 + jy) * GRID), false));
                }
            }
        }
    }
    let tries = (TRIES_PER_FARM * sc.farm).round() as u32;
    for (at, town) in farmed {
        for _ in 0..tries {
            let a = rng.r() * TAU;
            let d = DIST_BASE + if town { DIST_TOWN } else { 0.0 } + rng.r() * DIST_SPAN;
            let c = P::new(at.x + cos(a) * d, at.y + sin(a) * d);
            let f = field(&mut rng, c);
            if ok(&f, &fields) {
                fields.push(f);
            }
        }
    }

    // 14 more beyond the map.
    let (ew, eh) = (ext.ew as f64, ext.eh as f64);
    let mut placed = 0;
    for _ in 0..BEYOND_TRIES {
        if placed >= BEYOND_FIELDS {
            break;
        }
        let c = P::new(rng.r() * ew - BORDER as f64, rng.r() * eh - BORDER as f64);
        let f = field(&mut rng, c);
        let beyond = [P::new(f.x0, f.y0), P::new(f.x1, f.y0), P::new(f.x0, f.y1), P::new(f.x1, f.y1)]
            .iter()
            .all(|p| ext.out(p.x, p.y) >= BEYOND_OUT);
        if beyond && ok(&f, &fields) {
            fields.push(f);
            placed += 1;
        }
    }
    fields
}

/// A field centred on `c`: 1.6–3.8 × 1.4–3.4 tiles, a random crop, rows along x or y.
fn field(rng: &mut Rng, c: P) -> Field {
    let fw = SIZE_W.0 + rng.r() * (SIZE_W.1 - SIZE_W.0);
    let fh = SIZE_H.0 + rng.r() * (SIZE_H.1 - SIZE_H.0);
    let crop = CROPS[((rng.r() * CROPS.len() as f64) as usize).min(CROPS.len() - 1)];
    let along_x = rng.r() < 0.5;
    Field { x0: c.x - fw / 2.0, y0: c.y - fh / 2.0, x1: c.x + fw / 2.0, y1: c.y + fh / 2.0, crop, along_x }
}

/// On open tiles only, at least 0.9 from a road and 1.7 from a site, and not within 0.4 of another field.
fn fits(f: &Field, m: &BattleMap, ext: &Ext, roads: &[Vec<P>], fields: &[Field]) -> bool {
    let border = BORDER as f64;
    let inside_ext = f.x0 > -border && f.y0 > -border && f.x1 < m.wf() + border && f.y1 < m.hf() + border;
    if !inside_ext || fields.iter().any(|o| f.overlaps(o, FIELD_GAP)) {
        return false;
    }
    for ty in f.y0.floor() as i32..=f.y1.floor() as i32 {
        for tx in f.x0.floor() as i32..=f.x1.floor() as i32 {
            if ext.tile(tx, ty) != Ground::Open {
                return false;
            }
        }
    }
    if m.sites.iter().any(|s| f.dist(s.at) < SITE_GAP) {
        return false;
    }
    // A road comes within 0.9 when a segment passes within 0.9 of the field's rectangle.
    let c = P::new((f.x0 + f.x1) / 2.0, (f.y0 + f.y1) / 2.0);
    let half = hyp(f.x1 - f.x0, f.y1 - f.y0) / 2.0;
    !roads.iter().flat_map(|r| r.windows(2)).any(|s| {
        seg_dist(c, s[0], s[1]) < half + ROAD_GAP && seg_rect_near(s[0], s[1], f, ROAD_GAP)
    })
}

/// True if segment a–b passes within `gap` of the field: sampled every tenth of a tile.
fn seg_rect_near(a: P, b: P, f: &Field, gap: f64) -> bool {
    let n = (a.dist(b) / 0.1).ceil().max(1.0) as u32;
    (0..=n).any(|k| {
        let t = k as f64 / n as f64;
        f.dist(P::new(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) < gap
    })
}
