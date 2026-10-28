//! The land's dressing (docs/spec/03-land.md §4–§6, MEADOW only for now): the painted ground at 12 texels per
//! tile, the heights over the map and 18 tiles of country past every edge, roads, fields, and the scatter of
//! trees, stones, bushes, fences and haystacks as flat instance arrays.
//!
//! Visual only: the rules never read it. Deterministic from the map's seed through `hash32`, `Rng` and the value
//! noise of rng.rs. Its constants are named consts like the map's (DECISIONS.md D-05): they define what a seed
//! looks like. Choices the spec leaves open are in out/decisions-land.md.

mod ext;
mod fields;
mod paint;
mod roads;
mod scape;
mod scatter;

use crate::contracts::P;
use crate::hash::Fnv;
use crate::map::BattleMap;

pub use fields::{Crop, Field};
pub use paint::Class;
pub use scape::{Beyond, Fence, Hedge, MEADOW, Scape, Species};
pub use scatter::{Parts, Scatter};

/// Tiles of scenery drawn past every edge, so there is never a void.
pub const BORDER: i32 = 18;
/// Texels painted per tile.
pub const TEX: usize = 12;

pub struct Land {
    /// The map's size in tiles.
    pub map_w: u32,
    pub map_h: u32,
    /// The extended grid in tiles, `(w + 2·BORDER) × (h + 2·BORDER)`; its north-west corner is at map
    /// (−BORDER, −BORDER).
    pub ew: u32,
    pub eh: u32,
    /// The painted ground, `ew·TEX × eh·TEX` texels of RGBA, row-major from the north.
    pub rgba: Vec<u8>,
    /// Heights every half tile over the extended grid, `(2ew+1) × (2eh+1)`, row-major from the north. Inside
    /// the map they are exactly the map's own.
    pub heights: Vec<f32>,
    /// Per extended tile, 1 where a water quad is drawn (within 2 tiles of water or a ford).
    pub water: Vec<u8>,
    pub roads: Vec<Vec<P>>,
    pub fields: Vec<Field>,
    pub scatter: Scatter,
}

/// The land for `m` in MEADOW.
pub fn make(m: &BattleMap) -> Land {
    make_with(m, &MEADOW)
}

pub fn make_with(m: &BattleMap, sc: &Scape) -> Land {
    let mut ext = ext::Ext::new(m, sc);
    let roads = roads::make(m, &mut ext);
    ext.make_heights(m, sc);
    let fields = fields::place(m, &ext, &roads, sc);
    let painted = paint::paint(m, &ext, &roads, &fields, sc);
    let scatter = scatter::scatter(m, &ext, &painted, &fields, sc);
    let water = paint::near_water(&ext).into_iter().map(u8::from).collect();
    Land {
        map_w: m.w as u32,
        map_h: m.h as u32,
        ew: ext.ew as u32,
        eh: ext.eh as u32,
        rgba: painted.rgba,
        heights: ext.heights,
        water,
        roads,
        fields,
        scatter,
    }
}

impl Land {
    /// Texels across and down.
    pub fn tex_w(&self) -> u32 {
        self.ew * TEX as u32
    }

    pub fn tex_h(&self) -> u32 {
        self.eh * TEX as u32
    }

    /// FNV-1a over everything the view draws, for the native-vs-WASM check.
    pub fn hash(&self) -> u64 {
        let mut f = Fnv::default();
        f.u32(self.ew);
        f.u32(self.eh);
        f.bytes(&self.rgba);
        for &h in &self.heights {
            f.f32(h);
        }
        f.bytes(&self.water);
        let s = &self.scatter;
        for p in [&s.wood, &s.leaf, &s.tier, &s.stone, &s.hay] {
            f.u32(p.count() as u32);
            for &v in p.mat.iter().chain(&p.col) {
                f.f32(v);
            }
        }
        f.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::{MapKind, MapOpts, WIDTHS, generate};

    #[test]
    fn land_is_sized_and_keeps_the_maps_heights() {
        for (kind, width) in [(MapKind::Keep, 48), (MapKind::Ford, 64), (MapKind::Town, 80)] {
            let m = generate(4, MapOpts { kind, width });
            let l = make(&m);
            let b = BORDER as u32;
            assert_eq!((l.ew, l.eh), (m.w as u32 + 2 * b, m.h as u32 + 2 * b));
            assert_eq!(l.rgba.len() as u32, l.tex_w() * l.tex_h() * 4);
            let (hw, mw) = (l.ew as usize * 2 + 1, m.heights_w());
            assert_eq!(l.heights.len(), hw * (l.eh as usize * 2 + 1));
            for j in 0..m.heights_h() {
                for i in 0..mw {
                    let k = (j + 2 * BORDER as usize) * hw + i + 2 * BORDER as usize;
                    assert_eq!(l.heights[k].to_bits(), m.heights[j * mw + i].to_bits(), "{kind:?} sample ({i}, {j})");
                }
            }
            assert!(l.heights.iter().all(|h| h.is_finite()));
            let s = &l.scatter;
            println!(
                "land {kind:?}/{width}: {}×{} texels, {} roads, {} fields; instances wood {} leaf {} tier {} stone {} hay {}",
                l.tex_w(),
                l.tex_h(),
                l.roads.len(),
                l.fields.len(),
                s.wood.count(),
                s.leaf.count(),
                s.tier.count(),
                s.stone.count(),
                s.hay.count()
            );
        }
        assert_eq!(make(&generate(4, MapOpts { kind: MapKind::Keep, width: 48 })).tex_w(), 1008);
        let _ = WIDTHS;
    }

    #[test]
    fn land_is_deterministic() {
        let m = generate(7, MapOpts { kind: MapKind::Ford, width: 48 });
        let (a, b) = (make(&m), make(&m));
        assert_eq!(a.hash(), b.hash());
        println!("land determinism: hash {:016x}", a.hash());
    }

    /// `cargo test --release -p sim land_timings -- --nocapture --ignored` prints make()'s time per width.
    #[test]
    #[ignore]
    fn land_timings() {
        for width in WIDTHS {
            for kind in [MapKind::Keep, MapKind::Ford] {
                let m = generate(4, MapOpts { kind, width });
                let runs = 5;
                let t = std::time::Instant::now();
                for _ in 0..runs {
                    std::hint::black_box(make(&m));
                }
                println!("land make {kind:?}/{width}: {:.1} ms", t.elapsed().as_secs_f64() * 1000.0 / runs as f64);
                // Phase by phase.
                let sc = &MEADOW;
                let mut lap = std::time::Instant::now();
                let mut phase = |name: &str| {
                    let ms = lap.elapsed().as_secs_f64() * 1000.0;
                    lap = std::time::Instant::now();
                    format!("{name} {ms:.1}")
                };
                let mut e = ext::Ext::new(&m, sc);
                let p0 = phase("ext");
                let roads = roads::make(&m, &mut e);
                let p1 = phase("roads");
                e.make_heights(&m, sc);
                let p2 = phase("heights");
                let fields = fields::place(&m, &e, &roads, sc);
                let p3 = phase("fields");
                let painted = paint::paint(&m, &e, &roads, &fields, sc);
                let p4 = phase("paint");
                std::hint::black_box(scatter::scatter(&m, &e, &painted, &fields, sc));
                let p5 = phase("scatter");
                println!("  {p0}, {p1}, {p2}, {p3}, {p4}, {p5} ms");
            }
        }
    }
}
