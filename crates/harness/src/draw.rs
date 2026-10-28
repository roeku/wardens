//! The harness's top-down picture: tiles coloured by type and shaded by height, sites as squares, every
//! man as a dot, and each squad's order as a line from its anchor. Colours from docs/spec/02-look.md §4.

use image::{Rgb, RgbImage};
use sim::battle::{Battle, Order};
use sim::contracts::{Kind, P};
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
const TEAM: [[u8; 3]; 2] = [[0x3a, 0x8d, 0xbd], [0xc6, 0x48, 0x33]];
const TEAM_LIGHT: [[u8; 3]; 2] = [[0x78, 0xc5, 0xe6], [0xef, 0x8e, 0x70]];

pub fn top_down(b: &Battle) -> RgbImage {
    let m = &b.map;
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
        let shade = (1.0 + m.height_at(x, y) * 0.18).clamp(0.6, 1.4);
        *pixel = Rgb(base.map(|c| (c as f64 * shade).min(255.0) as u8));
    }
    for s in &m.sites {
        let colour = s.owner.map_or(NEUTRAL, |t| TEAM_LIGHT[t as usize]);
        let half = if matches!(s.kind, SiteKind::Keep | SiteKind::Town) { 9 } else { 5 };
        square(&mut img, s.at, half, INK);
        square(&mut img, s.at, half - 1, colour);
    }
    for s in &b.squads {
        let from = P::new(s.x, s.y);
        let to = match &s.order {
            Order::Hold { .. } => None,
            Order::Move { to, .. } => Some((*to, CREAM)),
            Order::Attack { target, .. } => b.squads.get(*target as usize).map(|t| (P::new(t.x, t.y), ATTACK)),
            Order::Take { site, .. } => m.sites.get(*site as usize).map(|t| (t.at, GOLD)),
        };
        if let Some((to, colour)) = to {
            line(&mut img, from, to, colour);
        }
    }
    for k in &b.soldiers {
        if !k.alive {
            continue;
        }
        let s = &b.squads[k.squad as usize];
        let colour = match (s.kind, k.slot) {
            (Kind::Captain, _) => GOLD,
            (_, 0) if !s.name.is_empty() => TEAM_LIGHT[s.team as usize],
            _ => TEAM[s.team as usize],
        };
        square(&mut img, P::new(k.x, k.y), 2, INK);
        square(&mut img, P::new(k.x, k.y), 1, colour);
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
