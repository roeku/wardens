//! The road between battles (docs/spec/03-land.md §9 "The road"): a land of its own, drawn by the same view as a
//! battle, as a peaceful battle.
//!
//! - **Size.** `W = 2·8 + 23 (the muster ground) + 13·6 (the steps) + 2 = 119`, `H = 40`.
//! - **Nodes.** The Hall at (5.5, 20.5); places at `x = 8 + 3 + 23 + step·13 ± 1.5`, `y = H·(0.2 + 0.3·lane) ± 2`,
//!   snapped to tile centres.
//! - **Links** come from the campaign (hall → row 0, each place → the next row within ±1 lane, the last row → the
//!   keep). Each is a straight road; where one crosses the river, the river is a ford.
//! - **Tiles.** The river at `x = floor(W·0.47 + (fbm(seed+5, y·0.08) − 0.5)·10)`, 2 wide. Kept open: within 4 of a
//!   place, within 1.8 of a link, and the muster ground. Elsewhere ponds, forest and rock by noise.
//! - **Sites** stand at the nodes in the kinds the view already draws (out/decisions-d5-campaign.md): the hall a
//!   keep of ours, a holdfast a tower, a village a town, a ford a village, a camp a shrine (its fire), the keep the
//!   keep.
//!
//! Generation constants are named consts like the other maps' (DECISIONS.md D-05): they define what a seed looks
//! like. The place-kind roll is the campaign's (crates/sim/src/campaign/road.rs).

use super::{BattleMap, MapKind, SiteKind, Tile, relief};
use crate::contracts::{P, SiteId, Team};
use crate::rng::{fbm, jitter};

/// The road's size in tiles.
pub const W: u16 = 119;
pub const H: u16 = 40;
/// The Hall of Banners, where the warband musters.
pub const HALL: P = P::new(5.5, 20.5);
/// The muster ground: columns `[MUSTER_X0, MUSTER_X1)`, every row.
pub const MUSTER_X0: f64 = 8.0;
pub const MUSTER_X1: f64 = MUSTER_X0 + MUSTER_W;
const MUSTER_W: f64 = 23.0;
/// Places start this far east of the muster ground, one step every `STEP_W`.
const STEP_IN: f64 = 3.0;
const STEP_W: f64 = 13.0;
/// Lane rows: `H·(LANE_Y0 + LANE_DY·lane)`.
const LANE_Y0: f64 = 0.2;
const LANE_DY: f64 = 0.3;
/// A place's jitter about its slot, ± tiles.
const JITTER_X: f64 = 1.5;
const JITTER_Y: f64 = 2.0;
const SALT_X: u32 = 0x726f_0001;
const SALT_Y: u32 = 0x726f_0002;
/// The river: `floor(W·0.47 + (fbm(seed+5, y·0.08) − 0.5)·10)`, 2 wide.
const RIVER_X: f64 = 0.47;
const RIVER_WANDER: f64 = 10.0;
const RIVER_FREQ: f64 = 0.08;
const RIVER_SEED: u32 = 5;
const RIVER_SALT: u32 = 0x726f_0003;
/// Kept open: within this of a place (and the hall), within this of a link.
const OPEN_PLACE: f64 = 4.0;
const OPEN_LINK: f64 = 1.8;
/// River tiles this close to a place are a ford, so no place stands in the water (chosen).
const DRY_PLACE: f64 = 2.0;
/// Link tiles within this of the straight road are road tiles (chosen: one tile wide).
const PAVE: f64 = 0.6;
/// Elsewhere (MEADOW's `road` parameters, chosen; every place is MEADOW today, so the per-land blend with weight
/// `exp(−d/2.5)` is MEADOW's own): a pond where `fbm(seed+3, x·.13, y·.13) > POOLS`, forest where
/// `fbm(seed+1, x·.11, y·.11) > WOOD`, rock where `fbm(seed+2, x·.16, y·.16) > ROCK`.
const POOLS: f64 = 0.74;
const WOOD: f64 = 0.6;
const ROCK: f64 = 0.72;
const POOL_FREQ: f64 = 0.13;
const WOOD_FREQ: f64 = 0.11;
const ROCK_FREQ: f64 = 0.16;
const SALT_POOL: u32 = 0x726f_0004;
const SALT_WOOD: u32 = 0x726f_0005;
const SALT_ROCK: u32 = 0x726f_0006;

/// What stands at a node of the road, as the view draws it.
#[derive(Clone, Debug, PartialEq)]
pub struct RoadNode {
    pub at: P,
    pub site: SiteKind,
    pub owner: Option<Team>,
}

/// The road's nodes (the hall last) and links (pairs of node indices), from the campaign.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct RoadLayout {
    pub nodes: Vec<RoadNode>,
    pub links: Vec<(usize, usize)>,
}

/// Where the place `id` at `step` and `lane` stands: its slot plus a seeded jitter, snapped to a tile centre.
pub fn place_at(seed: u32, id: u32, step: u32, lane: u32) -> P {
    let x = MUSTER_X1 + STEP_IN + step as f64 * STEP_W + (jitter(seed, id, SALT_X) * 2.0 - 1.0) * JITTER_X;
    let y = H as f64 * (LANE_Y0 + LANE_DY * lane as f64) + (jitter(seed, id, SALT_Y) * 2.0 - 1.0) * JITTER_Y;
    P::new(x.floor() + 0.5, y.floor() + 0.5)
}

/// The river's west column on row `y`.
pub fn river_x(seed: u32, y: i32) -> i32 {
    let n = fbm(seed.wrapping_add(RIVER_SEED), 0.0, y as f64 * RIVER_FREQ, RIVER_SALT);
    (W as f64 * RIVER_X + (n - 0.5) * RIVER_WANDER).floor() as i32
}

/// The distance from `p` to the segment `a`–`b`.
fn seg_dist(p: P, a: P, b: P) -> f64 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 { (((p.x - a.x) * dx + (p.y - a.y) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
    p.dist(P::new(a.x + dx * t, a.y + dy * t))
}

/// The road map for `seed` and the campaign's layout.
pub fn make(seed: u32, layout: &RoadLayout) -> BattleMap {
    let (w, h) = (W as usize, H as usize);
    let n = w * h;
    let mut m = BattleMap {
        kind: MapKind::Road,
        seed,
        w: W,
        h: H,
        tiles: vec![Tile::Open; n],
        ford: vec![false; n],
        river: Vec::with_capacity(h),
        sites: Vec::new(),
        deploy: [P::new(HALL.x + 3.0, HALL.y), HALL],
        retreat: [P::new(0.5, HALL.y), P::new(W as f64 - 0.5, HALL.y)],
        heights: Vec::new(),
        hills: Vec::new(),
        roads: Vec::new(),
        farms: Vec::new(),
    };
    let segs: Vec<(P, P)> = layout.links.iter().map(|&(a, b)| (layout.nodes[a].at, layout.nodes[b].at)).collect();
    let near_link = |p: P, r: f64| segs.iter().any(|&(a, b)| seg_dist(p, a, b) <= r);
    let near_place = |p: P, r: f64| layout.nodes.iter().any(|nd| nd.at.dist(p) <= r);
    // The country: ponds, woods and rock by noise, except where it is kept open.
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let c = P::new(x as f64 + 0.5, y as f64 + 0.5);
            let muster = c.x >= MUSTER_X0 && c.x < MUSTER_X1;
            if muster || near_place(c, OPEN_PLACE) || near_link(c, OPEN_LINK) {
                continue;
            }
            let (fx, fy) = (c.x, c.y);
            let t = if fbm(seed.wrapping_add(3), fx * POOL_FREQ, fy * POOL_FREQ, SALT_POOL) > POOLS {
                Tile::Water
            } else if fbm(seed.wrapping_add(2), fx * ROCK_FREQ, fy * ROCK_FREQ, SALT_ROCK) > ROCK {
                Tile::Rock
            } else if fbm(seed.wrapping_add(1), fx * WOOD_FREQ, fy * WOOD_FREQ, SALT_WOOD) > WOOD {
                Tile::Forest
            } else {
                continue;
            };
            m.set(x, y, t);
        }
    }
    // The links are roads.
    for &(a, b) in &segs {
        for (x, y) in m.tiles_near(P::new((a.x + b.x) / 2.0, (a.y + b.y) / 2.0), a.dist(b) / 2.0 + 1.0) {
            let c = P::new(x as f64 + 0.5, y as f64 + 0.5);
            if seg_dist(c, a, b) <= PAVE {
                m.set(x, y, Tile::Road);
            }
        }
    }
    // The river, 2 wide; a ford wherever a link crosses it, and beside a place.
    for y in 0..h as i32 {
        let rx = river_x(seed, y);
        m.river.push(rx);
        for x in [rx, rx + 1] {
            let Some(i) = m.idx(x, y) else { continue };
            let c = P::new(x as f64 + 0.5, y as f64 + 0.5);
            if near_link(c, OPEN_LINK) || near_place(c, DRY_PLACE) {
                m.tiles[i] = Tile::Road;
                m.ford[i] = true;
            } else {
                m.tiles[i] = Tile::Water;
            }
        }
    }
    for nd in &layout.nodes {
        let id = m.sites.len() as SiteId;
        m.sites.push(super::Site { id, kind: nd.site, at: nd.at, owner: nd.owner });
    }
    m.roads = segs.iter().map(|&(a, b)| vec![a, b]).collect();
    let main = layout.nodes.iter().find(|nd| nd.site == SiteKind::Keep && nd.owner != Some(0)).map_or(P::new(W as f64 - 20.0, HALL.y), |nd| nd.at);
    m.deploy[1] = main;
    relief::apply(&mut m, main);
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::path::astar;

    fn layout(seed: u32) -> RoadLayout {
        let mut nodes = Vec::new();
        for step in 0..5 {
            for lane in 0..3 {
                nodes.push(RoadNode { at: place_at(seed, step * 3 + lane, step, lane), site: SiteKind::Tower, owner: Some(1) });
            }
        }
        nodes.push(RoadNode { at: place_at(seed, 15, 5, 1), site: SiteKind::Keep, owner: Some(1) });
        nodes.push(RoadNode { at: HALL, site: SiteKind::Keep, owner: Some(0) });
        let mut links = vec![(16, 0), (16, 1), (16, 2)];
        for step in 0..4usize {
            for lane in 0..3usize {
                for to in lane.saturating_sub(1)..=(lane + 1).min(2) {
                    links.push((step * 3 + lane, (step + 1) * 3 + to));
                }
            }
        }
        links.extend([(12, 15), (13, 15), (14, 15)]);
        RoadLayout { nodes, links }
    }

    #[test]
    fn the_road_is_sized_crossable_and_named_by_its_nodes() {
        let (mut fords, mut sites, mut wet) = (0, 0, 0);
        for seed in 1..=20 {
            let l = layout(seed);
            let m = make(seed, &l);
            assert_eq!((m.w, m.h), (119, 40));
            assert_eq!(m.heights.len(), m.heights_w() * m.heights_h());
            assert!(m.heights.iter().all(|h| h.is_finite()));
            for s in &m.sites {
                assert!(m.passable(s.at), "seed {seed}: site {} on {:?}", s.id, m.tile_at(s.at));
                assert!(astar(&m, HALL, s.at).is_some(), "seed {seed}: site {} unreachable", s.id);
            }
            for &(a, b) in &l.links {
                assert!(astar(&m, l.nodes[a].at, l.nodes[b].at).is_some(), "seed {seed}: link {a}-{b}");
            }
            fords += m.ford.iter().filter(|&&f| f).count();
            wet += m.tiles.iter().filter(|&&t| t == Tile::Water).count();
            sites += m.sites.len();
        }
        println!("road maps: 20 seeds, {sites} sites all reachable from the hall, every link walkable, {fords} ford tiles, {wet} water tiles");
    }
}
