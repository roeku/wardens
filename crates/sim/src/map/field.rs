//! The open field (docs/spec/03-land.md §3c): a symmetric skirmish. Only the west half is generated (rocks
//! `(1+2r)·area`, forests `(2+2r)·area`, clear x < 8) and mirrored onto the east; hills come in mirrored pairs
//! (r 3.4–5.8, h 0.8–1.5) with an optional hill in the centre, and after relief every height is averaged with
//! its mirror. A gentle road curves `mid → mid+2 → mid+3 → mid+2 → mid`; farms come in mirrored pairs.

use super::{BattleMap, Hill, MapKind, Tile, relief};
use crate::contracts::P;
use crate::rng::Rng;

const CLEAR_X: i32 = 8;
const DEPLOY_X: f64 = 6.0;
const HILL_R: (f64, f64) = (3.4, 2.4);
const HILL_H: (f64, f64) = (0.8, 0.7);
const HILL_EDGE_X: f64 = 7.0;
const HILL_TRIES: u32 = 80;
/// Hill pairs: `max(1, round(0.8·area))`, so about as many hills as the assault map's `1.6·area`.
const HILL_PAIRS_PER_AREA: f64 = 0.8;
const CENTRE_HILL_CHANCE: f64 = 0.5;
/// The road's rise toward the middle, in rows below `mid`, at x = 0, W/4, W/2, 3W/4, W.
const ROAD_RISE: [f64; 5] = [0.0, 2.0, 3.0, 2.0, 0.0];
const ROAD_STEP: f64 = 0.25;
const FARM_PAIRS_PER_AREA: f64 = 1.5;
const FARM_GAP: f64 = 4.0;
const FARM_TRIES: u32 = 20;

pub(super) fn make(seed: u32, w: u16) -> BattleMap {
    let mut m = BattleMap::blank(MapKind::Field, seed, w);
    let mut rng = Rng::new(seed);
    let (wf, hf, area) = (m.wf(), m.hf(), m.area());
    let half = wf / 2.0;

    // The west half: rocks, then forests, never closer than the deploy clearing.
    for _ in 0..((1.0 + rng.r() * 2.0) * area).round() as u32 {
        let c = P::new(CLEAR_X as f64 + rng.r() * (half - CLEAR_X as f64), 2.0 + rng.r() * (hf - 4.0));
        let (rx, ry) = (1.2 + rng.r() * 2.2, 1.0 + rng.r() * 2.0);
        m.blob(&mut rng, c, rx, ry, Tile::Rock);
    }
    for _ in 0..((2.0 + rng.r() * 2.0) * area).round() as u32 {
        let c = P::new(CLEAR_X as f64 + rng.r() * (half - CLEAR_X as f64), 2.0 + rng.r() * (hf - 4.0));
        let (rx, ry) = (2.0 + rng.r() * 3.0, 1.5 + rng.r() * 2.5);
        m.blob(&mut rng, c, rx, ry, Tile::Forest);
    }
    for y in 0..m.h as i32 {
        for x in 0..CLEAR_X {
            m.set(x, y, Tile::Open);
        }
    }

    // The road, laid on the west half and mirrored with it.
    let mid = (hf / 2.0).floor() + 0.5;
    let road: Vec<P> = ROAD_RISE.iter().enumerate().map(|(i, &dy)| P::new((wf * i as f64 / 4.0).clamp(0.5, wf - 0.5), mid + dy)).collect();
    // 4-connected: a diagonal step also paves the tile beside it, so the road never joins only at a corner.
    let mut last: Option<(i32, i32)> = None;
    for seg in road.windows(2) {
        let steps = (seg[0].dist(seg[1]) / ROAD_STEP).ceil() as u32;
        for k in 0..=steps {
            let t = k as f64 / steps.max(1) as f64;
            let p = P::new(seg[0].x + (seg[1].x - seg[0].x) * t, seg[0].y + (seg[1].y - seg[0].y) * t);
            let (x, y) = (p.x.floor() as i32, p.y.floor() as i32);
            if p.x < half {
                m.set(x, y, Tile::Road);
                if let Some((lx, ly)) = last
                    && lx != x
                    && ly != y
                {
                    m.set(x, ly, Tile::Road);
                }
            }
            last = Some((x, y));
        }
    }

    // Mirror the west half onto the east.
    let wi = m.w as i32;
    for y in 0..m.h as i32 {
        for x in 0..wi / 2 {
            let t = m.tile(x, y);
            m.set(wi - 1 - x, y, t);
        }
    }
    m.deploy = [P::new(DEPLOY_X, hf / 2.0), P::new(wf - DEPLOY_X, hf / 2.0)];
    m.retreat = [P::new(0.5, hf / 2.0), P::new(wf - 0.5, hf / 2.0)];
    m.roads = vec![road.clone()];

    // Hills in mirrored pairs, then perhaps one in the centre; relief's own stream.
    let mut hr = relief::relief_rng(&m);
    let pairs = ((HILL_PAIRS_PER_AREA * area).round() as usize).max(1);
    let overlaps = |hills: &[Hill], at: P, r: f64| hills.iter().any(|o| o.at.dist(at) < o.r + r);
    for _ in 0..HILL_TRIES {
        if m.hills.len() >= pairs * 2 {
            break;
        }
        let r = HILL_R.0 + hr.r() * HILL_R.1;
        let h = HILL_H.0 + hr.r() * HILL_H.1;
        let room = (half - 1.0 - r - (HILL_EDGE_X + r)).max(0.0);
        let at = P::new(HILL_EDGE_X + r + hr.r() * room, hf * 0.14 + hr.r() * hf * 0.72);
        let twin = P::new(wf - at.x, at.y);
        if !overlaps(&m.hills, at, r) && !overlaps(&m.hills, twin, r) && at.dist(twin) >= 2.0 * r {
            m.hills.push(Hill { at, r, h });
            m.hills.push(Hill { at: twin, r, h });
        }
    }
    if hr.r() < CENTRE_HILL_CHANCE {
        let r = HILL_R.0 + hr.r() * HILL_R.1;
        let h = HILL_H.0 + hr.r() * HILL_H.1;
        let at = P::new(half, hf * 0.14 + hr.r() * hf * 0.72);
        if !overlaps(&m.hills, at, r) {
            m.hills.push(Hill { at, r, h });
        }
    }

    // Farms in mirrored pairs, away from the road.
    let dense: Vec<P> = road
        .windows(2)
        .flat_map(|s| {
            let n = (s[0].dist(s[1]) / 0.5).ceil() as u32;
            (0..=n).map(move |k| {
                let t = k as f64 / n.max(1) as f64;
                P::new(s[0].x + (s[1].x - s[0].x) * t, s[0].y + (s[1].y - s[0].y) * t)
            })
        })
        .collect();
    for _ in 0..(FARM_PAIRS_PER_AREA * area).round() as u32 {
        for _ in 0..FARM_TRIES {
            let p = P::new(2.0 + rng.r() * (half - 3.0), 2.0 + rng.r() * (hf - 4.0));
            let twin = P::new(wf - p.x, p.y);
            let clear = dense.iter().all(|q| q.dist(p) >= FARM_GAP && q.dist(twin) >= FARM_GAP);
            if clear && m.tile_at(p) == Tile::Open && m.tile_at(twin) == Tile::Open {
                m.farms.push(p);
                m.farms.push(twin);
                break;
            }
        }
    }

    relief::heights(&mut m);
    let (hw, hh) = (m.heights_w(), m.heights_h());
    for j in 0..hh {
        for i in 0..hw / 2 {
            let (a, b) = (j * hw + i, j * hw + hw - 1 - i);
            let v = ((m.heights[a] as f64 + m.heights[b] as f64) / 2.0) as f32;
            m.heights[a] = v;
            m.heights[b] = v;
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use crate::map::{MapKind, MapOpts, WIDTHS, generate};

    #[test]
    fn the_field_is_mirrored() {
        let mut checked = 0;
        for width in WIDTHS {
            for seed in 1..=10 {
                let m = generate(seed, MapOpts { kind: MapKind::Field, width });
                let w = m.w as i32;
                for y in 0..m.h as i32 {
                    for x in 0..w {
                        assert_eq!(m.tile(x, y), m.tile(w - 1 - x, y), "{width} seed {seed} tile {x},{y}");
                    }
                }
                let hw = m.heights_w();
                for j in 0..m.heights_h() {
                    for i in 0..hw {
                        assert_eq!(m.heights[j * hw + i], m.heights[j * hw + hw - 1 - i]);
                    }
                }
                checked += 1;
            }
        }
        println!("field: {checked} maps mirrored in tiles and heights");
    }
}
