//! The harness's top-down picture: tiles coloured by type and shaded by height (dimmed where team 0's fog has
//! never seen, a little where it is not in sight now), sites as squares in their owner's colour, each squad's
//! order as a line from its anchor, arrows in flight, the fallen as dark dots, and every living man as a dot at his
//! body's size: ringed red when in contact (or breathing), pale when his company routs. Colours from docs/spec/02-look.md §4.

use image::{Rgb, RgbImage};
use sim::battle::{Battle, Order, SquadState};
use sim::contracts::{Kind, P, Tick};
use sim::map::{SiteKind, Tile};

const PX: u32 = 12;

const GRASS: [u8; 3] = [0x5d, 0x8a, 0x33];
const FOREST: [u8; 3] = [0x2f, 0x5e, 0x24];
const ROCK: [u8; 3] = [0x6b, 0x64, 0x5b];
const WATER: [u8; 3] = [0x4d, 0x85, 0x94];
const ROAD: [u8; 3] = [0xa0, 0x7f, 0x50];
const FORD: [u8; 3] = [0x8b, 0x85, 0x74];
const INK: [u8; 3] = [0x16, 0x12, 0x0f];
const CREAM: [u8; 3] = [0xf1, 0xea, 0xd6];
const ATTACK: [u8; 3] = [0xe0, 0x53, 0x3f];
const GOLD: [u8; 3] = [0xe8, 0xc3, 0x4a];
const NEUTRAL: [u8; 3] = [0xd8, 0xcf, 0xb4];
const FALLEN: [u8; 3] = [0x3a, 0x2c, 0x26];
const FOLLOW: [u8; 3] = [0x9a, 0xb0, 0x8c];
const TEAM: [[u8; 3]; 2] = [[0x3a, 0x8d, 0xbd], [0xc6, 0x48, 0x33]];
const TEAM_LIGHT: [[u8; 3]; 2] = [[0x78, 0xc5, 0xe6], [0xef, 0x8e, 0x70]];
const ROUT: [[u8; 3]; 2] = [[0xc8, 0xe4, 0xf0], [0xf6, 0xd0, 0xc4]];

pub fn top_down(b: &Battle) -> RgbImage {
    let m = &b.map;
    let fog = b.fog(0);
    let mut img = RgbImage::new(m.w as u32 * PX, m.h as u32 * PX);
    for (py, px, pixel) in img.enumerate_pixels_mut().map(|(x, y, p)| (y, x, p)) {
        let (x, y) = ((px as f64 + 0.5) / PX as f64, (py as f64 + 0.5) / PX as f64);
        let (tx, ty) = (x.floor() as i32, y.floor() as i32);
        let base = match m.tile(tx, ty) {
            Tile::Open => GRASS,
            Tile::Forest => FOREST,
            Tile::Rock => ROCK,
            Tile::Water => WATER,
            Tile::Road if m.idx(tx, ty).is_some_and(|i| m.ford[i]) => FORD,
            Tile::Road => ROAD,
        };
        let seen = m.idx(tx, ty).map_or(0, |i| fog[i]);
        let dim = match seen {
            0 => 0.55,
            1 => 0.8,
            _ => 1.0,
        };
        let shade = (1.0 + m.height_at(x, y) * 0.18).clamp(0.6, 1.4) * dim;
        *pixel = Rgb(base.map(|c| (c as f64 * shade).min(255.0) as u8));
    }
    for (s, st) in m.sites.iter().zip(&b.sites) {
        let colour = st.owner.map_or(NEUTRAL, |t| TEAM_LIGHT[t as usize]);
        let half = if matches!(s.kind, SiteKind::Keep | SiteKind::Town) { 9 } else { 5 };
        square(&mut img, s.at, half, INK);
        square(&mut img, s.at, half - 1, colour);
    }
    // Field works (08-orders §7): the footprint in its side's colour, filled as far as it is built; razed ones dark.
    for w in &b.works {
        let colour = if w.razed { FALLEN } else if w.built >= 1.0 { TEAM_LIGHT[w.team as usize & 1] } else { NEUTRAL };
        let f = P::from_angle(w.face);
        let left = P::new(f.y, -f.x);
        let (half_l, half_d) = (w.size[0] / 2.0, w.size[1] / 2.0);
        let steps = 8;
        for j in 0..=steps {
            let a = -half_d + w.size[1] * j as f64 / steps as f64;
            if (j as f64 / steps as f64) > w.built.max(0.15) && !w.razed && w.built < 1.0 {
                continue;
            }
            let c = P::new(w.at.x + f.x * a, w.at.y + f.y * a);
            line(&mut img, P::new(c.x - left.x * half_l, c.y - left.y * half_l), P::new(c.x + left.x * half_l, c.y + left.y * half_l), colour);
        }
        line(&mut img, P::new(w.at.x - f.x * half_d, w.at.y - f.y * half_d), P::new(w.at.x + f.x * (half_d + 0.6), w.at.y + f.y * (half_d + 0.6)), INK);
    }
    for k in b.soldiers.iter().filter(|k| !k.alive && k.died_at != Tick::MAX) {
        square(&mut img, P::new(k.x, k.y), 1, FALLEN);
    }
    for (i, s) in b.squads.iter().enumerate() {
        if !s.on_field() {
            continue;
        }
        let from = P::new(s.x, s.y);
        let to = match &s.order {
            Order::Hold { .. } | Order::Retreat | Order::Ride => None,
            Order::Move { to, via, .. } => Some((via.first().copied().unwrap_or(*to), CREAM)),
            Order::Attack { target, .. } => b.squads.get(*target as usize).map(|_| (b.centre(*target as usize), ATTACK)),
            Order::Take { site, .. } => m.sites.get(*site as usize).map(|t| (t.at, GOLD)),
            Order::Follow | Order::Recall { .. } => b.station_at(i).map(|p| (p, FOLLOW)),
            Order::Guard { ward } | Order::Screen { ward, .. } => Some((b.centre(*ward as usize), FOLLOW)),
            Order::Charge { target } => b.squads.get(*target as usize).map(|_| (b.centre(*target as usize), ATTACK)),
            Order::Withdraw { to } | Order::Regroup { to } => Some((*to, CREAM)),
            Order::Build { at, .. } => Some((*at, GOLD)),
        };
        if let Some((to, colour)) = to {
            line(&mut img, from, to, colour);
        }
        if let Some(t) = s.threat {
            line(&mut img, b.centre(i), b.centre(t as usize), ATTACK);
        }
    }
    for a in &b.arrows {
        let t = &b.soldiers[a.target];
        let d = P::new(a.x, a.y).dist(P::new(t.x, t.y)).max(1e-9);
        let tail = P::new(a.x - (t.x - a.x) / d * 0.4, a.y - (t.y - a.y) / d * 0.4);
        line(&mut img, tail, P::new(a.x, a.y), CREAM);
    }
    for (idx, k) in b.soldiers.iter().enumerate() {
        if !k.alive {
            continue;
        }
        let s = &b.squads[k.squad as usize];
        let team = s.team as usize & 1;
        let colour = match (s.kind, s.leader) {
            (Kind::Captain, _) => GOLD,
            _ if s.state == SquadState::Routing => ROUT[team],
            (_, Some(l)) if l == idx => TEAM_LIGHT[team],
            _ => TEAM[team],
        };
        let ring = if k.engaged { ATTACK } else { INK };
        // Beasts are drawn at their size (a man's radius 0.32 is the 2-pixel dot).
        let half = (s.spec.radius * PX as f64 * 0.55).round().max(2.0) as i64;
        square(&mut img, P::new(k.x, k.y), half, ring);
        square(&mut img, P::new(k.x, k.y), half - 1, colour);
    }
    img
}

fn put(img: &mut RgbImage, x: i64, y: i64, c: [u8; 3]) {
    if x >= 0 && y >= 0 && (x as u32) < img.width() && (y as u32) < img.height() {
        img.put_pixel(x as u32, y as u32, Rgb(c));
    }
}

fn square(img: &mut RgbImage, at: P, half: i64, c: [u8; 3]) {
    let (cx, cy) = ((at.x * PX as f64) as i64, (at.y * PX as f64) as i64);
    for y in cy - half..=cy + half {
        for x in cx - half..=cx + half {
            put(img, x, y, c);
        }
    }
}

fn line(img: &mut RgbImage, a: P, b: P, c: [u8; 3]) {
    let n = (a.dist(b) * PX as f64).ceil().max(1.0) as i64;
    for i in 0..=n {
        let t = i as f64 / n as f64;
        put(img, ((a.x + (b.x - a.x) * t) * PX as f64) as i64, ((a.y + (b.y - a.y) * t) * PX as f64) as i64, c);
    }
}
