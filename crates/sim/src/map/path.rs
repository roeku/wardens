//! Pathfinding (docs/spec/03-land.md §1): 8-connected A* with no corner cutting, an octile heuristic and
//! ties broken on tile index, then string-pulled with a 0.35-step line-of-walk test.

use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::f64::consts::SQRT_2;

use super::{BattleMap, Tile};
use crate::contracts::P;

const FOREST_COST: f64 = 1.45;
const ROAD_COST: f64 = 0.85;
const WALK_STEP: f64 = 0.35;

const NEIGHBOURS: [(i32, i32); 8] = [(0, -1), (1, 0), (0, 1), (-1, 0), (1, -1), (1, 1), (-1, 1), (-1, -1)];

#[derive(PartialEq)]
struct Open {
    f: f64,
    idx: usize,
}

impl Eq for Open {}

impl Ord for Open {
    /// Reversed for a min-heap: lowest f first, then lowest tile index.
    fn cmp(&self, o: &Open) -> Ordering {
        o.f.total_cmp(&self.f).then(o.idx.cmp(&self.idx))
    }
}

impl PartialOrd for Open {
    fn partial_cmp(&self, o: &Open) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

fn octile(dx: i32, dy: i32) -> f64 {
    let (dx, dy) = (dx.abs() as f64, dy.abs() as f64);
    dx + dy + (SQRT_2 - 2.0) * dx.min(dy)
}

/// Tile centres from `from`'s tile to `to`'s tile, or `None` if either is blocked or no way exists.
pub fn astar(m: &BattleMap, from: P, to: P) -> Option<Vec<P>> {
    let (sx, sy) = (from.x.floor() as i32, from.y.floor() as i32);
    let (gx, gy) = (to.x.floor() as i32, to.y.floor() as i32);
    let (start, goal) = (m.idx(sx, sy)?, m.idx(gx, gy)?);
    if !m.tiles[start].passable() || !m.tiles[goal].passable() {
        return None;
    }
    let w = m.w as usize;
    let n = m.tiles.len();
    let mut g = vec![f64::INFINITY; n];
    let mut came = vec![usize::MAX; n];
    let mut closed = vec![false; n];
    let mut open = BinaryHeap::new();
    g[start] = 0.0;
    open.push(Open { f: octile(gx - sx, gy - sy), idx: start });
    while let Some(Open { idx, .. }) = open.pop() {
        if idx == goal {
            let (mut path, mut at) = (vec![goal], goal);
            while came[at] != usize::MAX {
                at = came[at];
                path.push(at);
            }
            path.reverse();
            return Some(path.into_iter().map(|i| P::new((i % w) as f64 + 0.5, (i / w) as f64 + 0.5)).collect());
        }
        if closed[idx] {
            continue;
        }
        closed[idx] = true;
        let (x, y) = ((idx % w) as i32, (idx / w) as i32);
        for (dx, dy) in NEIGHBOURS {
            let (nx, ny) = (x + dx, y + dy);
            let Some(ni) = m.idx(nx, ny) else { continue };
            let t = m.tiles[ni];
            if closed[ni] || !t.passable() {
                continue;
            }
            let diagonal = dx != 0 && dy != 0;
            if diagonal && !(m.tile(x + dx, y).passable() && m.tile(x, y + dy).passable()) {
                continue;
            }
            let step = if diagonal { SQRT_2 } else { 1.0 };
            let cost = step
                * match t {
                    Tile::Forest => FOREST_COST,
                    Tile::Road => ROAD_COST,
                    _ => 1.0,
                };
            let ng = g[idx] + cost;
            if ng < g[ni] {
                g[ni] = ng;
                came[ni] = idx;
                open.push(Open { f: ng + octile(gx - nx, gy - ny), idx: ni });
            }
        }
    }
    None
}

/// True if a man can walk the straight line from `a` to `b`, tested every 0.35 tiles.
pub fn line_walkable(m: &BattleMap, a: P, b: P) -> bool {
    let d = a.dist(b);
    let steps = (d / WALK_STEP).ceil().max(1.0) as u32;
    (0..=steps).all(|i| {
        let t = i as f64 / steps as f64;
        m.passable(P::new(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t))
    })
}

/// Step of the strict line test, tiles.
const CLEAR_STEP: f64 = 0.25;

/// True if a man can walk the straight line from `a` to `b` with no corner cutting: every tile sampled every
/// 0.25 is passable, and where the line steps diagonally from one tile to the next, both tiles beside the
/// corner are passable too (as A* requires). Men move one axis at a time, so a line through a corner between
/// two rocks would wedge them.
pub fn line_clear(m: &BattleMap, a: P, b: P) -> bool {
    let d = a.dist(b);
    let steps = (d / CLEAR_STEP).ceil().max(1.0) as u32;
    let tile = |t: f64| P::new(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    let (mut px, mut py) = (a.x.floor() as i32, a.y.floor() as i32);
    for i in 0..=steps {
        let p = tile(i as f64 / steps as f64);
        let (x, y) = (p.x.floor() as i32, p.y.floor() as i32);
        if !m.tile(x, y).passable() {
            return false;
        }
        if x != px && y != py && !(m.tile(x, py).passable() && m.tile(px, y).passable()) {
            return false;
        }
        (px, py) = (x, y);
    }
    true
}

/// A* then string-pulling with the strict line test: a man's personal route.
pub fn route_clear(m: &BattleMap, from: P, to: P) -> Option<Vec<P>> {
    let tiles = astar(m, from, to)?;
    let mut out = Vec::new();
    let mut at = from;
    let mut i = 0;
    while i < tiles.len() {
        let mut j = tiles.len() - 1;
        while j > i && !line_clear(m, at, tiles[j]) {
            j -= 1;
        }
        out.push(tiles[j]);
        at = tiles[j];
        i = j + 1;
    }
    if let Some(last) = out.last_mut()
        && line_clear(m, *last, to)
    {
        *last = to;
    }
    Some(out)
}

/// String-pulls a path: from each kept point, skip to the farthest point still in a walkable line.
pub fn pull(m: &BattleMap, from: P, path: &[P]) -> Vec<P> {
    let mut out = Vec::new();
    let mut at = from;
    let mut i = 0;
    while i < path.len() {
        let mut j = path.len() - 1;
        while j > i && !line_walkable(m, at, path[j]) {
            j -= 1;
        }
        out.push(path[j]);
        at = path[j];
        i = j + 1;
    }
    out
}

/// A* then string-pulling: the waypoints a squad walks from `from` to `to`, ending exactly at `to`.
pub fn route(m: &BattleMap, from: P, to: P) -> Option<Vec<P>> {
    let tiles = astar(m, from, to)?;
    let mut ways = pull(m, from, &tiles);
    if let Some(last) = ways.last_mut() {
        *last = to;
    }
    Some(ways)
}
