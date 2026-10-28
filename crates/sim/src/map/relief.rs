//! Heights (docs/spec/03-land.md §3d). Relief draws from its own stream, `Rng(seed·92821 + 13)`, so adding
//! relief never moves the layout.

use super::{BattleMap, HEIGHT_STEP, Hill, SiteKind, Tile, WATER_Y};
use crate::contracts::P;
use crate::math::{lerp, smoothstep};
use crate::rng::{Rng, fbm};

const HILL_TRIES: u32 = 80;
const HILL_EDGE_X: f64 = 7.0;
const HILL_MAIN_GAP: f64 = 2.5;
const HILL_RIVER_SHARE: f64 = 0.8;
const MASK_WATER: f64 = 1.2;
const MASK_FORD: f64 = 1.0;
const MASK_ROCK: f64 = 0.8;
const MASK_WOOD: f64 = 1.5;
const PAD_BLEND: f64 = 1.5;
/// Dry ground stays this far above the water (03-land.md §3d step 3).
const LAND_ABOVE_WATER: f64 = 0.08;
/// A sample on the edge between water and dry ground sits just above the waterline.
const BANK_ABOVE_WATER: f64 = 0.02;

pub(super) fn apply(m: &mut BattleMap, main: P) {
    let mut rng = relief_rng(m);
    hills(m, &mut rng, main);
    heights(m);
}

/// Relief's own stream, so adding relief never moves the layout.
pub(super) fn relief_rng(m: &BattleMap) -> Rng {
    Rng::new(m.seed.wrapping_mul(92_821).wrapping_add(13))
}

/// The heights from the map's hills, tiles and sites (§3d steps 2–4).
pub(super) fn heights(m: &mut BattleMap) {
    let masks = Masks::new(m);
    let (hw, hh) = (m.heights_w(), m.heights_h());
    let mut h = Vec::with_capacity(hw * hh);
    for j in 0..hh {
        for i in 0..hw {
            h.push(raw(m, &masks, P::new(i as f64 * HEIGHT_STEP, j as f64 * HEIGHT_STEP)));
        }
    }
    // Level pads under sites, blended back to the raw height over 1.5 tiles.
    for s in &m.sites {
        let r = match s.kind {
            SiteKind::Keep => 3.4,
            SiteKind::Town => 3.6,
            SiteKind::Village => 2.6,
            _ => 2.0,
        };
        let pad = raw(m, &masks, s.at);
        for j in 0..hh {
            for i in 0..hw {
                let d = P::new(i as f64 * HEIGHT_STEP, j as f64 * HEIGHT_STEP).dist(s.at);
                if d < r + PAD_BLEND {
                    let k = j * hw + i;
                    h[k] = lerp(pad, h[k], smoothstep(r, r + PAD_BLEND, d));
                }
            }
        }
    }
    m.heights = h.into_iter().map(|v| v as f32).collect();
}

/// Aims for `max(1, round(1.6·area))` hills in up to 80 tries.
fn hills(m: &mut BattleMap, rng: &mut Rng, main: P) {
    let (wf, hf) = (m.wf(), m.hf());
    let want = ((1.6 * m.area()).round() as usize).max(1);
    for _ in 0..HILL_TRIES {
        if m.hills.len() >= want {
            break;
        }
        let at = P::new(wf * 0.18 + rng.r() * wf * 0.62, hf * 0.14 + rng.r() * hf * 0.72);
        let (r, h) = (3.6 + rng.r() * 2.8, 0.95 + rng.r() * 0.75);
        let wet = m.tiles_near(at, r * HILL_RIVER_SHARE).iter().any(|&(x, y)| m.tile(x, y) == Tile::Water);
        let overlaps = m.hills.iter().any(|o| o.at.dist(at) < o.r + r);
        if at.x - r >= HILL_EDGE_X && at.dist(main) >= r + HILL_MAIN_GAP && !wet && !overlaps {
            m.hills.push(Hill { at, r, h });
        }
    }
}

/// Smoothed tile masks: each tile of a type stamps a cone `max(0, 1 − d/(r+0.5))` over its neighbours
/// (the strongest stamp wins), read bilinearly between tile centres.
struct Masks {
    w: usize,
    h: usize,
    water: Vec<f64>,
    ford: Vec<f64>,
    rock: Vec<f64>,
    wood: Vec<f64>,
}

impl Masks {
    fn new(m: &BattleMap) -> Masks {
        let stamp = |is: &dyn Fn(usize) -> bool, r: f64| {
            let reach = r + 0.5;
            let mut out = vec![0.0; m.tiles.len()];
            for (k, _) in m.tiles.iter().enumerate().filter(|&(k, _)| is(k)) {
                let c = P::new((k % m.w as usize) as f64 + 0.5, (k / m.w as usize) as f64 + 0.5);
                for (x, y) in m.tiles_near(c, reach) {
                    let n = y as usize * m.w as usize + x as usize;
                    let v = 1.0 - P::new(x as f64 + 0.5, y as f64 + 0.5).dist(c) / reach;
                    out[n] = f64::max(out[n], v);
                }
            }
            out
        };
        Masks {
            w: m.w as usize,
            h: m.h as usize,
            water: stamp(&|k| m.tiles[k] == Tile::Water, MASK_WATER),
            ford: stamp(&|k| m.ford[k], MASK_FORD),
            rock: stamp(&|k| m.tiles[k] == Tile::Rock, MASK_ROCK),
            wood: stamp(&|k| m.tiles[k] == Tile::Forest, MASK_WOOD),
        }
    }

    fn read(&self, mask: &[f64], p: P) -> f64 {
        let u = (p.x - 0.5).clamp(0.0, (self.w - 1) as f64);
        let v = (p.y - 0.5).clamp(0.0, (self.h - 1) as f64);
        let (i, j) = ((u.floor() as usize).min(self.w - 2), (v.floor() as usize).min(self.h - 2));
        let (tx, ty) = (u - i as f64, v - j as f64);
        let at = |i: usize, j: usize| mask[j * self.w + i];
        lerp(lerp(at(i, j), at(i + 1, j), tx), lerp(at(i, j + 1), at(i + 1, j + 1), tx), ty)
    }
}

/// The tiles a height sample touches (1, 2 or 4: those whose closed square holds it), as the rules see them.
struct Touch {
    water: bool,
    ford: bool,
    /// Passable ground that is not a ford: where men stand.
    dry: bool,
    all_rock: bool,
}

impl Touch {
    fn at(m: &BattleMap, p: P) -> Touch {
        let cells = |v: f64| if v == v.floor() { [v as i32 - 1, v as i32] } else { [v.floor() as i32; 2] };
        let mut t = Touch { water: false, ford: false, dry: false, all_rock: true };
        for y in cells(p.y) {
            for x in cells(p.x) {
                let Some(i) = m.idx(x, y) else { continue };
                let tile = m.tiles[i];
                t.water |= tile == Tile::Water;
                t.ford |= m.ford[i];
                t.dry |= tile.passable() && !m.ford[i];
                t.all_rock &= tile == Tile::Rock;
            }
        }
        t
    }
}

/// The raw height at `p`, before the pads (§3d step 3), made to agree with the rules' tiles (DECISIONS.md D-13):
/// the masks still shape the land, but a crag rises only from samples wholly on rock, dry ground never sinks under
/// the water, and a bank sample sits at the waterline. Men walk only where the rules let them, so they are never
/// drawn standing in the river or up a crag.
fn raw(m: &BattleMap, masks: &Masks, p: P) -> f64 {
    let s = m.seed;
    let touch = Touch::at(m, p);
    let mut h = (fbm(s.wrapping_add(1), p.x * 0.06, p.y * 0.06, 1) - 0.5) * 0.5;
    for hill in &m.hills {
        let t = p.dist(hill.at) / hill.r;
        if t < 1.0 {
            let q = 1.0 - t * t;
            h += hill.h * q * q;
        }
    }
    let (water, ford) = (masks.read(&masks.water, p), masks.read(&masks.ford, p));
    let (rock, wood) = (masks.read(&masks.rock, p), masks.read(&masks.wood, p));
    if rock > 0.15 && touch.all_rock {
        h += (rock - 0.15) * (2.3 + fbm(s.wrapping_add(4), p.x * 0.5, p.y * 0.5, 4) * 1.4);
    }
    h += wood * 0.12;
    h -= (water * 1.6).min(1.0) * 0.75 + ford * 0.2;
    if ford > 0.45 {
        h = h.min(WATER_Y - 0.05);
    }
    if (water < 0.02 && ford < 0.02) || (!touch.water && !touch.ford) {
        h = h.max(WATER_Y + LAND_ABOVE_WATER);
    } else if touch.dry {
        h = h.max(WATER_Y + BANK_ABOVE_WATER);
    }
    h
}
