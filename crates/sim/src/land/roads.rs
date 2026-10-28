//! Roads (03-land.md §4 "Roads"). A map that brings its own roads (the ford's routes) has them densified;
//! otherwise a main road runs from the west edge at the deploy row through the sites to the keep, the other
//! sites get spurs, and a last road leaves the keep off the east edge. Every road runs on past the map's
//! edge to the end of the painted country, and is smoothed 6 passes, never onto water or rock.

use super::BORDER;
use super::ext::{Ext, Ground};
use crate::contracts::P;
use crate::map::path::astar;
use crate::map::BattleMap;

/// Roads are densified to points every half tile.
pub const ROAD_STEP: f64 = 0.5;
const SMOOTH_PASSES: u32 = 6;
const SMOOTH_K: f64 = 0.5;
/// A site joins the main road when it lies ahead within this slope (|dy| ≤ dx·1, 45°); the rest get spurs.
const MAIN_SLOPE: f64 = 1.0;
/// A road ending within this of a map edge runs on past it.
const EDGE_NEAR: f64 = 1.0;
/// Outside the map, woods and rock are cleared this close to a road.
const OUTSIDE_CLEAR: f64 = 1.5;
/// Rows tried, in order, for where the keep's road leaves the east edge (the keep's row first).
const EAST_ROWS: [f64; 7] = [0.0, -1.0, 1.0, -2.0, 2.0, -3.0, 3.0];

pub fn make(m: &BattleMap, ext: &mut Ext) -> Vec<Vec<P>> {
    let raw = if m.roads.is_empty() { build(m) } else { m.roads.clone() };
    let mut roads: Vec<Vec<P>> =
        raw.into_iter().filter(|r| r.len() >= 2).map(|r| densify(&run_on(m, r), ROAD_STEP)).collect();
    ext.clear_along(&roads, OUTSIDE_CLEAR);
    for r in &mut roads {
        smooth(r, ext);
    }
    roads
}

/// The assault map's roads: the main road, the spurs and the keep's road east.
fn build(m: &BattleMap) -> Vec<Vec<P>> {
    let Some(main) = m.sites.first() else { return Vec::new() };
    let start = P::new(0.5, m.deploy[0].y.floor() + 0.5);
    let mut rest: Vec<_> = m.sites[1..].iter().collect();
    rest.sort_by(|a, b| a.at.x.total_cmp(&b.at.x).then(a.id.cmp(&b.id)));
    let mut stops = vec![start];
    let mut spurs = Vec::new();
    for s in rest {
        let at = *stops.last().expect("start");
        let dx = s.at.x - at.x;
        if dx > 0.0 && (s.at.y - at.y).abs() <= dx * MAIN_SLOPE && s.at.x < main.at.x {
            stops.push(s.at);
        } else {
            spurs.push(s.at);
        }
    }
    stops.push(main.at);
    let mut road: Vec<P> = Vec::new();
    for leg in stops.windows(2) {
        let Some(way) = astar(m, leg[0], leg[1]) else { continue };
        let skip = usize::from(road.last() == way.first());
        road.extend(way.into_iter().skip(skip));
    }
    let mut out = Vec::new();
    for s in spurs {
        let near = road.iter().copied().min_by(|a, b| a.dist(s).total_cmp(&b.dist(s)));
        if let Some(way) = near.and_then(|n| astar(m, s, n)) {
            out.push(way);
        }
    }
    // The keep's road east: to the edge tile on the keep's row, or the nearest open row beside it.
    let east = EAST_ROWS.iter().find_map(|&dy| astar(m, main.at, P::new(m.wf() - 0.5, main.at.y + dy)));
    if let Some(way) = east {
        out.push(way);
    }
    out.insert(0, road);
    out
}

/// Runs a road that ends near a map edge straight on to the end of the painted country.
fn run_on(m: &BattleMap, mut r: Vec<P>) -> Vec<P> {
    let reach = BORDER as f64;
    let away = |p: P| -> Option<P> {
        if p.x < EDGE_NEAR {
            Some(P::new(-reach, p.y))
        } else if p.x > m.wf() - EDGE_NEAR {
            Some(P::new(m.wf() + reach, p.y))
        } else if p.y < EDGE_NEAR {
            Some(P::new(p.x, -reach))
        } else if p.y > m.hf() - EDGE_NEAR {
            Some(P::new(p.x, m.hf() + reach))
        } else {
            None
        }
    };
    if let Some(end) = away(r[r.len() - 1]) {
        r.push(end);
    }
    if let Some(end) = away(r[0]) {
        r.insert(0, end);
    }
    r
}

/// Points every `step` along the polyline, keeping its corners.
pub fn densify(r: &[P], step: f64) -> Vec<P> {
    let mut out = vec![r[0]];
    for seg in r.windows(2) {
        let (a, b) = (seg[0], seg[1]);
        let n = (a.dist(b) / step).ceil().max(1.0) as u32;
        for k in 1..=n {
            let t = k as f64 / n as f64;
            out.push(P::new(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
        }
    }
    out
}

/// 6 passes, each moving every inner point halfway toward its neighbours' midpoint, unless that lands on water
/// or rock. The ends stay put.
fn smooth(r: &mut [P], ext: &Ext) {
    for _ in 0..SMOOTH_PASSES {
        let prev = r.to_vec();
        for i in 1..r.len().saturating_sub(1) {
            let mid = P::new((prev[i - 1].x + prev[i + 1].x) * 0.5, (prev[i - 1].y + prev[i + 1].y) * 0.5);
            let q = P::new(prev[i].x + (mid.x - prev[i].x) * SMOOTH_K, prev[i].y + (mid.y - prev[i].y) * SMOOTH_K);
            if !matches!(ext.at(q), Ground::Water | Ground::Rock) {
                r[i] = q;
            }
        }
    }
}

/// The distance from `p` to segment `a`–`b`.
pub fn seg_dist(p: P, a: P, b: P) -> f64 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 { (((p.x - a.x) * dx + (p.y - a.y) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
    p.dist(P::new(a.x + dx * t, a.y + dy * t))
}
