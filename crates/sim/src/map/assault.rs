//! The assault map (docs/spec/03-land.md §3a): a keep, or a town for the village under the torch, in the
//! east; the attacker deploys in the west.

use super::{BattleMap, MapKind, SiteKind, Tile, relief};
use crate::contracts::{P, Team};
use crate::rng::Rng;

pub(super) const DEFENDER: Team = 1;
const RIVER_CHANCE: f64 = 0.55;
const DEPLOY_CLEAR_X: i32 = 7;
const KEEP_CLEAR: f64 = 4.0;
const TOWN_CLEAR: f64 = 4.6;
const SITE_CLEAR: f64 = 2.2;
const SITE_GAP: f64 = 5.5;
const SITE_GAP_TOWN: f64 = 6.8;
const SITE_TRIES: u32 = 12;

pub(super) fn make(seed: u32, w: u16, kind: MapKind) -> BattleMap {
    let mut m = BattleMap::blank(kind, seed, w);
    let mut rng = Rng::new(seed);
    let (wf, hf, area) = (m.wf(), m.hf(), m.area());

    // 1. The keep or town, and the deploy points.
    let main = P::new(wf - 5.5, (hf * 0.26 + rng.r() * hf * 0.46).floor() + 0.5);
    m.deploy = [P::new(4.0, hf / 2.0), main];
    m.retreat = [P::new(0.5, hf / 2.0), main];

    // 3. The river, with 2 to 4 fords each 3 rows deep.
    if rng.r() < RIVER_CHANCE {
        let start = (wf * 0.42 + rng.r() * wf * 0.11).floor() as i32;
        m.river(&mut rng, start, &[]);
        let n = if hf < 30.0 { 2 } else if hf < 40.0 { 3 } else { 4 };
        for i in 0..n {
            let row = ((i as f64 + 0.15 + rng.r() * 0.7) * hf / n as f64).floor() as i32;
            m.ford_rows(row - 1..=row + 1);
        }
    }

    // 4. Rocks, 5. forests.
    for _ in 0..((3.0 + rng.r() * 3.0) * area).round() as u32 {
        let c = P::new(wf * 0.21 + rng.r() * wf * 0.58, 2.0 + rng.r() * (hf - 4.0));
        let (rx, ry) = (1.2 + rng.r() * 2.2, 1.0 + rng.r() * 2.0);
        m.blob(&mut rng, c, rx, ry, Tile::Rock);
    }
    for _ in 0..((2.0 + rng.r() * 3.0) * area).round() as u32 {
        let c = P::new(wf * 0.17 + rng.r() * wf * 0.66, 2.0 + rng.r() * (hf - 4.0));
        let (rx, ry) = (2.0 + rng.r() * 3.0, 1.5 + rng.r() * 2.5);
        m.blob(&mut rng, c, rx, ry, Tile::Forest);
    }

    // 6. Clearings: the deploy zone, and round the keep.
    for y in 0..m.h as i32 {
        for x in 0..DEPLOY_CLEAR_X {
            m.set(x, y, Tile::Open);
        }
    }
    let keep_clear = if kind == MapKind::Town { TOWN_CLEAR } else { KEEP_CLEAR };
    m.clear(main, keep_clear, &[Tile::Rock, Tile::Water, Tile::Forest]);

    // 7. Sites: the keep, village pairs top and bottom, shrines, and towers on the flanks.
    let main_kind = if kind == MapKind::Town { SiteKind::Town } else { SiteKind::Keep };
    m.add_site(main_kind, main, Some(DEFENDER));
    let pairs = (area.round() as u32).max(1);
    let band = wf * 0.3 / pairs as f64;
    for k in 0..pairs {
        let x0 = wf * 0.26 + band * k as f64;
        place(&mut m, &mut rng, SiteKind::Village, None, |r| P::new(x0 + r.r() * band, hf * (0.1 + r.r() * 0.2)));
        place(&mut m, &mut rng, SiteKind::Village, None, |r| P::new(x0 + r.r() * band, hf * (0.7 + r.r() * 0.2)));
    }
    for _ in 0..if area >= 2.0 { 2 } else { 1 } {
        place(&mut m, &mut rng, SiteKind::Shrine, Some(DEFENDER), |r| {
            P::new(wf * (0.55 + r.r() * 0.15), 2.0 + r.r() * (hf - 4.0))
        });
    }
    let first_top = rng.r() < 0.5;
    for i in 0..if area >= 1.5 { 2 } else { 1 } {
        let top = (i % 2 == 0) == first_top;
        let y0 = if top { 0.1 } else { 0.7 };
        place(&mut m, &mut rng, SiteKind::Tower, Some(DEFENDER), |r| {
            P::new(wf * (0.66 + r.r() * 0.14), hf * (y0 + r.r() * 0.2))
        });
    }

    // 8. Reachability is checked by `BattleMap::valid`. Relief comes last, from its own stream.
    relief::apply(&mut m, main);
    m
}

/// Tries up to 12 spots for a site: snapped to a tile centre with y in [2, H−3], at least 5.5 from every
/// other site (6.8 when a town is involved) and with no water within 2.2. Then clears rock and forest
/// within 2.2. A site that finds no spot is left out.
fn place(m: &mut BattleMap, rng: &mut Rng, kind: SiteKind, owner: Option<Team>, spot: impl Fn(&mut Rng) -> P) {
    for _ in 0..SITE_TRIES {
        let p = spot(rng);
        let at = P::new(p.x.floor().clamp(0.0, m.wf() - 1.0) + 0.5, p.y.floor().clamp(2.0, m.hf() - 3.0) + 0.5);
        let crowded = m.sites.iter().any(|s| {
            let town = s.kind == SiteKind::Town || kind == SiteKind::Town;
            s.at.dist(at) < if town { SITE_GAP_TOWN } else { SITE_GAP }
        });
        let wet = m.tiles_near(at, SITE_CLEAR).iter().any(|&(x, y)| m.tile(x, y) == Tile::Water);
        if !crowded && !wet {
            m.clear(at, SITE_CLEAR, &[Tile::Rock, Tile::Forest]);
            m.add_site(kind, at, owner);
            return;
        }
    }
}
