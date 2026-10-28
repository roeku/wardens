//! The ford map (docs/spec/03-land.md §3b): a river crossing to protect. People enter from the east and
//! leave by the west, over a main ford 3 rows deep or a narrow 1-row ford near the top or bottom.

use super::path::astar;
use super::{BattleMap, MapKind, Tile, relief};
use crate::contracts::P;
use crate::rng::Rng;

const EDGE_CLEAR_X: i32 = 2;
const DEPLOY_CLEAR: f64 = 4.5;
const ENTRY_CLEAR: f64 = 5.0;
const ROUTE_CLEAR: f64 = 2.0;
const FAR_ROUTE_CLEAR: f64 = 1.6;
const FARM_GAP: f64 = 4.0;
const FARM_TRIES: u32 = 20;

pub(super) fn make(seed: u32, w: u16) -> BattleMap {
    let mut m = BattleMap::blank(MapKind::Ford, seed, w);
    let mut rng = Rng::new(seed);
    let (wf, hf, area) = (m.wf(), m.hf(), m.area());

    // The river, still within ±1 row of the main ford; the narrow ford near the top or the bottom.
    let ford_y = (hf * 0.36 + rng.r() * hf * 0.28).floor() as i32;
    let narrow_y = if rng.r() < 0.5 { hf * (0.1 + rng.r() * 0.08) } else { hf * (0.82 + rng.r() * 0.08) }.floor() as i32;
    let start = (wf * 0.47 + rng.r() * wf * 0.06).clamp(wf * 0.42, wf * 0.56).floor() as i32;
    m.river(&mut rng, start, &[ford_y - 1, ford_y, ford_y + 1]);
    m.ford_rows(ford_y - 1..=ford_y + 1);
    m.ford_rows([narrow_y]);
    let ford = P::new(m.river[ford_y as usize] as f64 + 0.5, ford_y as f64 + 0.5);
    let narrow = P::new(m.river[narrow_y as usize] as f64 + 0.5, narrow_y as f64 + 0.5);

    let entry = P::new(wf - 0.5, ford.y);
    let exit = P::new(0.5, ford.y);
    m.deploy = [P::new((wf * 0.3).floor() + 0.5, ford.y), P::new(wf - 4.5, 3.5)];
    m.retreat = [P::new(0.5, hf / 2.0), P::new(wf - 0.5, 3.5)];

    // Rocks and forests, (3 + 3r)·area of each; blobs only cover open ground, so never water or the fords.
    for _ in 0..((3.0 + rng.r() * 3.0) * area).round() as u32 {
        let c = P::new(wf * 0.21 + rng.r() * wf * 0.58, 2.0 + rng.r() * (hf - 4.0));
        let (rx, ry) = (1.2 + rng.r() * 2.2, 1.0 + rng.r() * 2.0);
        m.blob(&mut rng, c, rx, ry, Tile::Rock);
    }
    for _ in 0..((3.0 + rng.r() * 3.0) * area).round() as u32 {
        let c = P::new(wf * 0.17 + rng.r() * wf * 0.66, 2.0 + rng.r() * (hf - 4.0));
        let (rx, ry) = (2.0 + rng.r() * 3.0, 1.5 + rng.r() * 2.5);
        m.blob(&mut rng, c, rx, ry, Tile::Forest);
    }

    // Clearings: the west edge, the deploy point and the entry; then round the routes, once found.
    let dry = [Tile::Rock, Tile::Forest];
    for y in 0..m.h as i32 {
        for x in 0..EDGE_CLEAR_X {
            if dry.contains(&m.tile(x, y)) {
                m.set(x, y, Tile::Open);
            }
        }
    }
    m.clear(m.deploy[0], DEPLOY_CLEAR, &dry);
    m.clear(entry, ENTRY_CLEAR, &dry);
    let through = |m: &BattleMap, mid: P| -> Option<Vec<P>> {
        let mut way = astar(m, entry, mid)?;
        way.extend(astar(m, mid, exit)?.into_iter().skip(1));
        Some(way)
    };
    let (Some(main), Some(far)) = (through(&m, ford), through(&m, narrow)) else {
        return m;
    };
    for (route, r) in [(&main, ROUTE_CLEAR), (&far, FAR_ROUTE_CLEAR)] {
        for &p in route {
            m.clear(p, r, &dry);
        }
    }
    for &p in main.iter().chain(&far) {
        if m.tile_at(p) != Tile::Water {
            m.set(p.x.floor() as i32, p.y.floor() as i32, Tile::Road);
        }
    }

    // Farms, each at least 4 tiles from any route.
    for _ in 0..(3.0 * area).round() as u32 {
        for _ in 0..FARM_TRIES {
            let p = P::new(2.0 + rng.r() * (wf - 4.0), 2.0 + rng.r() * (hf - 4.0));
            let clear = main.iter().chain(&far).all(|q| q.dist(p) >= FARM_GAP);
            if clear && m.tile_at(p) == Tile::Open {
                m.farms.push(p);
                break;
            }
        }
    }
    m.roads = vec![main, far];

    relief::apply(&mut m, ford);
    m
}
