//! The battle map: tiles, sites and heights (docs/spec/03-land.md §1–§3). Generation constants are named
//! consts rather than tuning: changing one changes every seed's map (DECISIONS.md D-05).

mod assault;
mod field;
mod ford;
pub mod names;
pub mod path;
mod relief;
pub mod road;

use serde::{Deserialize, Serialize};

use crate::contracts::{P, SiteId, Team};
use crate::hash::Fnv;
use crate::rng::Rng;

/// The water surface, below the land's mean.
pub const WATER_Y: f64 = -0.22;
/// Heights are sampled every half tile.
pub const HEIGHT_STEP: f64 = 0.5;
/// A site's capture radius; two rings may not overlap.
pub const CAPTURE_R: f64 = 1.8;
pub const WIDTHS: [u16; 3] = [48, 64, 80];
const ATTEMPTS: u32 = 80;
const ATTEMPT_SEED_MUL: u32 = 7919;
const AREA_BASE: f64 = 48.0 * 27.0;

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tile {
    Open = 0,
    /// Passable at 0.7 speed.
    Forest = 1,
    Rock = 2,
    Water = 3,
    /// A road or a ford: full speed and a cheaper path cost.
    Road = 4,
}

impl Tile {
    pub fn passable(self) -> bool {
        !matches!(self, Tile::Rock | Tile::Water)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SiteKind {
    Keep,
    Town,
    Village,
    Shrine,
    Tower,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Site {
    pub id: SiteId,
    pub kind: SiteKind,
    pub at: P,
    pub owner: Option<Team>,
}

/// Which battle the map is for: an assault on a keep or a town (village under the torch), a ford rescue, or an
/// open-field skirmish with mirrored halves; or the road between battles (03-land.md §9), a peaceful battle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MapKind {
    Keep,
    Town,
    Ford,
    Field,
    Road,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct MapOpts {
    pub kind: MapKind,
    pub width: u16,
}

impl Default for MapOpts {
    fn default() -> MapOpts {
        MapOpts { kind: MapKind::Keep, width: map_size_for(4) }
    }
}

/// 80 tiles wide for 8 or more companies, 64 for 5 to 7, 48 otherwise.
pub fn map_size_for(squads: usize) -> u16 {
    match squads {
        8.. => 80,
        5..=7 => 64,
        _ => 48,
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Hill {
    pub at: P,
    pub r: f64,
    pub h: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BattleMap {
    pub kind: MapKind,
    /// The attempt's seed (`seed·7919 + attempt`), which every later noise lookup uses.
    pub seed: u32,
    pub w: u16,
    pub h: u16,
    pub tiles: Vec<Tile>,
    /// Road tiles that cross the river.
    pub ford: Vec<bool>,
    /// The river's west column per row, or empty when there is no river.
    pub river: Vec<i32>,
    pub sites: Vec<Site>,
    /// [attacker, defender].
    pub deploy: [P; 2],
    pub retreat: [P; 2],
    /// `(2w+1) × (2h+1)` samples, row-major from the north, in tiles.
    pub heights: Vec<f32>,
    pub hills: Vec<Hill>,
    pub roads: Vec<Vec<P>>,
    pub farms: Vec<P>,
}

/// Generates the map for `seed`, retrying `seed·7919 + attempt` up to 80 times until it is valid. The road (its own
/// size, 119×40) is the campaign of that seed's road, with every place still held by the blight.
pub fn generate(seed: u32, opts: MapOpts) -> BattleMap {
    if opts.kind == MapKind::Road {
        return crate::campaign::road_map(seed);
    }
    let width = if WIDTHS.contains(&opts.width) { opts.width } else { map_size_for(4) };
    let mut last = None;
    for attempt in 0..ATTEMPTS {
        let s = seed.wrapping_mul(ATTEMPT_SEED_MUL).wrapping_add(attempt);
        let m = match opts.kind {
            MapKind::Keep | MapKind::Town => assault::make(s, width, opts.kind),
            MapKind::Ford => ford::make(s, width),
            MapKind::Field => field::make(s, width),
            MapKind::Road => unreachable!("the road is made above"),
        };
        if m.valid() {
            return m;
        }
        last = Some(m);
    }
    last.expect("ATTEMPTS > 0")
}

impl BattleMap {
    fn blank(kind: MapKind, seed: u32, w: u16) -> BattleMap {
        let h = (w as f64 * 9.0 / 16.0).round() as u16;
        let n = w as usize * h as usize;
        BattleMap {
            kind,
            seed,
            w,
            h,
            tiles: vec![Tile::Open; n],
            ford: vec![false; n],
            river: Vec::new(),
            sites: Vec::new(),
            deploy: [P::new(0.0, 0.0); 2],
            retreat: [P::new(0.0, 0.0); 2],
            heights: Vec::new(),
            hills: Vec::new(),
            roads: Vec::new(),
            farms: Vec::new(),
        }
    }

    /// 1, about 1.78 or about 2.78: terrain and site counts scale with it.
    pub fn area(&self) -> f64 {
        self.w as f64 * self.h as f64 / AREA_BASE
    }

    pub fn wf(&self) -> f64 {
        self.w as f64
    }

    pub fn hf(&self) -> f64 {
        self.h as f64
    }

    pub fn idx(&self, x: i32, y: i32) -> Option<usize> {
        let inside = x >= 0 && y >= 0 && x < self.w as i32 && y < self.h as i32;
        inside.then(|| y as usize * self.w as usize + x as usize)
    }

    /// The tile at (x, y); outside the map counts as rock.
    pub fn tile(&self, x: i32, y: i32) -> Tile {
        self.idx(x, y).map_or(Tile::Rock, |i| self.tiles[i])
    }

    pub fn tile_at(&self, p: P) -> Tile {
        self.tile(p.x.floor() as i32, p.y.floor() as i32)
    }

    pub fn passable(&self, p: P) -> bool {
        self.tile_at(p).passable()
    }

    fn set(&mut self, x: i32, y: i32, t: Tile) {
        if let Some(i) = self.idx(x, y) {
            self.tiles[i] = t;
        }
    }

    /// Tile centres within `r` of `c`.
    fn tiles_near(&self, c: P, r: f64) -> Vec<(i32, i32)> {
        let (x0, x1) = ((c.x - r).floor() as i32, (c.x + r).ceil() as i32);
        let (y0, y1) = ((c.y - r).floor() as i32, (c.y + r).ceil() as i32);
        let mut out = Vec::new();
        for y in y0.max(0)..=y1.min(self.h as i32 - 1) {
            for x in x0.max(0)..=x1.min(self.w as i32 - 1) {
                if P::new(x as f64 + 0.5, y as f64 + 0.5).dist(c) <= r {
                    out.push((x, y));
                }
            }
        }
        out
    }

    /// Turns the listed tile types within `r` of `c` into open ground.
    fn clear(&mut self, c: P, r: f64, which: &[Tile]) {
        for (x, y) in self.tiles_near(c, r) {
            if which.contains(&self.tile(x, y)) {
                self.set(x, y, Tile::Open);
            }
        }
    }

    /// An ellipse of `t` over open ground with ragged edges: a tile is inside when
    /// `((x+.5−cx)/rx)² + ((y+.5−cy)/ry)² ≤ 1 + (r−0.5)·0.35`, with a fresh `r` per tile (§3a step 2).
    fn blob(&mut self, rng: &mut Rng, c: P, rx: f64, ry: f64, t: Tile) {
        let reach = 1.1;
        let (x0, x1) = ((c.x - rx * reach).floor() as i32, (c.x + rx * reach).ceil() as i32);
        let (y0, y1) = ((c.y - ry * reach).floor() as i32, (c.y + ry * reach).ceil() as i32);
        for y in y0.max(0)..=y1.min(self.h as i32 - 1) {
            for x in x0.max(0)..=x1.min(self.w as i32 - 1) {
                let r = rng.r();
                let (dx, dy) = ((x as f64 + 0.5 - c.x) / rx, (y as f64 + 0.5 - c.y) / ry);
                if dx * dx + dy * dy <= 1.0 + (r - 0.5) * 0.35 && self.tile(x, y) == Tile::Open {
                    self.set(x, y, t);
                }
            }
        }
    }

    /// The river, 2 tiles wide from its west column; it drifts ±1 with probability 0.3 per row, within
    /// [0.375W, 0.58W], except on the rows in `still`.
    fn river(&mut self, rng: &mut Rng, start: i32, still: &[i32]) {
        let (lo, hi) = ((self.wf() * 0.375).ceil() as i32, (self.wf() * 0.58).floor() as i32);
        let mut x = start.clamp(lo, hi);
        for y in 0..self.h as i32 {
            if !still.contains(&y) && rng.r() < 0.3 {
                x = (x + if rng.r() < 0.5 { -1 } else { 1 }).clamp(lo, hi);
            }
            self.river.push(x);
            self.set(x, y, Tile::Water);
            self.set(x + 1, y, Tile::Water);
        }
    }

    /// Makes `rows` of the river into a ford: road tiles, flagged.
    fn ford_rows(&mut self, rows: impl IntoIterator<Item = i32>) {
        for y in rows {
            let Some(&x) = self.river.get(y as usize) else { continue };
            for fx in [x, x + 1] {
                if let Some(i) = self.idx(fx, y) {
                    self.tiles[i] = Tile::Road;
                    self.ford[i] = true;
                }
            }
        }
    }

    fn add_site(&mut self, kind: SiteKind, at: P, owner: Option<Team>) {
        let id = self.sites.len() as SiteId;
        self.sites.push(Site { id, kind, at, owner });
    }

    /// Every site reachable from the attacker's deploy point, and no two capture rings overlapping.
    fn valid(&self) -> bool {
        let rings_apart = self.sites.iter().enumerate().all(|(i, a)| {
            self.sites[i + 1..].iter().all(|b| a.at.dist(b.at) >= CAPTURE_R * 2.0)
        });
        let reachable = self.sites.iter().all(|s| path::astar(self, self.deploy[0], s.at).is_some());
        let roads = self.kind != MapKind::Ford || self.roads.len() == 2;
        let across = self.kind != MapKind::Field || path::astar(self, self.deploy[0], self.deploy[1]).is_some();
        rings_apart && reachable && roads && across
    }

    pub fn heights_w(&self) -> usize {
        self.w as usize * 2 + 1
    }

    pub fn heights_h(&self) -> usize {
        self.h as usize * 2 + 1
    }

    /// The height at (x, y) in tiles, read bilinearly from the half-tile samples.
    pub fn height_at(&self, x: f64, y: f64) -> f64 {
        let (hw, hh) = (self.heights_w(), self.heights_h());
        if self.heights.is_empty() {
            return 0.0;
        }
        let u = (x / HEIGHT_STEP).clamp(0.0, (hw - 1) as f64);
        let v = (y / HEIGHT_STEP).clamp(0.0, (hh - 1) as f64);
        let (i, j) = ((u.floor() as usize).min(hw - 2), (v.floor() as usize).min(hh - 2));
        let (tx, ty) = (u - i as f64, v - j as f64);
        let at = |i: usize, j: usize| self.heights[j * hw + i] as f64;
        let top = at(i, j) + (at(i + 1, j) - at(i, j)) * tx;
        let bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tx;
        top + (bottom - top) * ty
    }

    pub fn hash(&self) -> u64 {
        let mut f = Fnv::default();
        f.u32(self.seed);
        f.u32(self.w as u32);
        f.u32(self.h as u32);
        f.bytes(&self.tiles.iter().map(|&t| t as u8).collect::<Vec<_>>());
        for s in &self.sites {
            f.u32(s.kind as u32);
            f.f64(s.at.x);
            f.f64(s.at.y);
        }
        for &h in &self.heights {
            f.f32(h);
        }
        f.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_are_valid_and_sized() {
        let mut counts = Vec::new();
        for kind in [MapKind::Keep, MapKind::Town, MapKind::Ford, MapKind::Field] {
            for width in WIDTHS {
                let mut sites = 0;
                for seed in 1..=20 {
                    let m = generate(seed, MapOpts { kind, width });
                    assert!(m.valid(), "{kind:?} {width} seed {seed} is not valid");
                    assert_eq!(m.h, (width as f64 * 9.0 / 16.0).round() as u16);
                    assert_eq!(m.heights.len(), m.heights_w() * m.heights_h());
                    assert!(m.heights.iter().all(|h| h.is_finite()));
                    sites += m.sites.len();
                }
                counts.push(format!("{kind:?}/{width}: 20 maps, {sites} sites"));
            }
        }
        println!("maps: {}", counts.join("; "));
    }

    #[test]
    fn same_seed_same_map() {
        let a = generate(42, MapOpts::default());
        let b = generate(42, MapOpts::default());
        assert_eq!(a.hash(), b.hash());
        assert_ne!(a.hash(), generate(43, MapOpts::default()).hash());
        println!("map determinism: 3 maps hashed");
    }

    /// D-13: where men stand (passable ground that is not a ford), the drawn ground is never under the water and
    /// never lifted by a neighbouring crag. Sampled on a quarter-tile grid inside every such tile.
    #[test]
    fn dry_ground_is_drawn_dry_and_flat_by_crags() {
        let (mut samples, mut wet, mut steep) = (0, 0, 0);
        for kind in [MapKind::Keep, MapKind::Town, MapKind::Ford, MapKind::Field] {
            for seed in 1..=12 {
                let m = generate(seed, MapOpts { kind, width: 48 });
                for y in 0..m.h as i32 {
                    for x in 0..m.w as i32 {
                        let i = m.idx(x, y).unwrap();
                        if !m.tiles[i].passable() || m.ford[i] {
                            continue;
                        }
                        let next_to_rock = (-1..=1).any(|dy| (-1..=1).any(|dx| m.tile(x + dx, y + dy) == Tile::Rock));
                        for (u, v) in [(0.25, 0.25), (0.5, 0.5), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)] {
                            let h = m.height_at(x as f64 + u, y as f64 + v);
                            samples += 1;
                            wet += (h < WATER_Y) as usize;
                            // A crag's foot: open ground beside rock is not raised steeply above its own centre.
                            let centre = m.height_at(x as f64 + 0.5, y as f64 + 0.5);
                            steep += (next_to_rock && (h - centre).abs() > 0.6) as usize;
                        }
                    }
                }
            }
        }
        println!("dry ground: {samples} samples on 48 maps, {wet} under the water, {steep} on a crag's slope");
        assert_eq!(wet, 0, "dry ground drawn under the water");
        assert_eq!(steep, 0, "dry ground drawn on a crag");
    }
}
