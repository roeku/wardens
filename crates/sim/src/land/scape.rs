//! Lands (biome tables, docs/spec/03-land.md §6). MEADOW is the base land and the only one painted today; the
//! other lands override parts of it when the road arrives (day 5+). Colours are `0xRRGGBB` and pass to the
//! screen unconverted (02-look.md §1), so a ramp entry is exactly the colour painted.

/// A tree kind (03-land.md §5). MEADOW grows only these two; the rest arrive with their lands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Species {
    Oak,
    Pine,
    /// Hedgerow poplars, for lands whose hedges are poplars.
    Poplar,
}

/// What grows on field edges that have no fence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hedge {
    /// Bushes every 0.45 tiles.
    Bush,
    /// Poplars every 0.8 tiles.
    Poplar,
}

/// What fences a field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fence {
    Wood,
    /// Dry-stone wall.
    Stone,
}

/// The country past the map's edges (03-land.md §4 "Outside the map").
#[derive(Clone, Copy, Debug)]
pub struct Beyond {
    pub wood: f64,
    pub rock: f64,
    pub lake: f64,
    pub pools: f64,
    pub rise: f64,
    pub cap: f64,
    /// Rising-ground weight per edge: north, east, south, west.
    pub sides: [f64; 4],
    pub peak: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Scape {
    pub grass: &'static [u32],
    pub dry: &'static [u32],
    pub dirt: &'static [u32],
    pub moss: &'static [u32],
    pub rock: &'static [u32],
    pub bed: &'static [u32],
    pub pebble: &'static [u32],
    pub yard: &'static [u32],
    pub wheat: &'static [u32],
    pub barley: &'static [u32],
    pub plough: &'static [u32],
    pub meadow: &'static [u32],
    pub flowers: &'static [u32],
    pub lichen: u32,
    /// Stones (02-look.md §4 "stones").
    pub stones: &'static [u32],
    pub leaf: &'static [u32],
    pub needle: &'static [u32],
    /// The colour blended onto the up-facing faces of stones (moss, snow or dust).
    pub coat: u32,
    /// Trampled ground, for the scar overlay.
    pub trample: [u8; 3],
    /// The shallow water colour, 0..1 RGB.
    pub water: [f64; 3],
    /// 0..1: how far the deep colour leans toward the pale end.
    pub deep: f64,
    /// `dry` ramp where the dry noise is above this.
    pub dry_at: f64,
    /// Bare earth where the bare noise is above this (9 = never).
    pub bare_at: f64,
    /// Wildflower density factor.
    pub flowers_k: f64,
    /// Chance of a tuft per 3×3-texel cell.
    pub tufts: f64,
    pub farm: f64,
    pub farmland: f64,
    /// `woods[0]` where `fbm(seed+7, x/8, y/8) > .55`, else `woods[1]`; each a weighted species list.
    pub woods: [&'static [(Species, f64)]; 2],
    pub thick: f64,
    /// Lone-tree chance per open tile: [inside the map, outside it] (out/decisions-land.md).
    pub lone: [f64; 2],
    pub lone_species: Species,
    pub beyond: Beyond,
    pub fence: Fence,
    pub hedge: Hedge,
}

pub const MEADOW: Scape = Scape {
    grass: &[0x3b5e26, 0x4b742c, 0x5d8a33, 0x71a03b, 0x88b347],
    dry: &[0x667a30, 0x7f923a, 0x9aa845, 0xb5ba55],
    dirt: &[0x6a4f30, 0x86663f, 0xa07f50, 0xb99863],
    moss: &[0x294a22, 0x335a27, 0x3f6a2c, 0x4c7a30],
    rock: &[0x3c3834, 0x524c46, 0x6b645b, 0x878073, 0xa39b8c],
    bed: &[0x3d4a3e, 0x4d5a48, 0x5f6a52],
    pebble: &[0x6e6a5c, 0x8b8574, 0xa7a08b],
    yard: &[0x6a5a42, 0x7f6d50, 0x948262, 0xa89674],
    wheat: &[0x8d7432, 0xb39540, 0xcfb055, 0xe0c66e],
    barley: &[0x7c8a3c, 0x98a64a, 0xb3bd5c],
    plough: &[0x4f3a27, 0x654a31, 0x7b5c3d],
    meadow: &[0x4f7a35, 0x618f3d, 0x78a64a],
    flowers: &[0xead35a, 0xf1ece0, 0x6f93db, 0xe2a2bc, 0xd65a46],
    lichen: 0x8e9a5a,
    stones: &[0x5a544d, 0x6b645b, 0x7d766b, 0x8e877a],
    leaf: &[0x2f5e24, 0x3a6e28, 0x46802e, 0x548f34, 0x63a03a],
    needle: &[0x1f4428, 0x25502c, 0x2c5a32],
    coat: 0x5c8038,
    trample: [96, 80, 52],
    water: [0.30, 0.52, 0.58],
    deep: 0.0,
    dry_at: 0.6,
    bare_at: 9.0,
    flowers_k: 1.0,
    tufts: 0.16,
    farm: 1.0,
    farmland: 0.0,
    woods: [&[(Species::Pine, 0.8), (Species::Oak, 0.2)], &[(Species::Pine, 0.15), (Species::Oak, 0.85)]],
    thick: 1.0,
    lone: [0.018, 0.05],
    lone_species: Species::Oak,
    beyond: Beyond {
        wood: 0.6,
        rock: 0.8,
        lake: 9.0,
        pools: 9.0,
        rise: 0.14,
        cap: 3.2,
        sides: [1.0, 1.0, 1.0, 1.0],
        peak: 0.0,
    },
    fence: Fence::Wood,
    hedge: Hedge::Bush,
};

/// A weighted pick from `list` with `r` in [0, 1).
pub fn pick(list: &[(Species, f64)], r: f64) -> Species {
    let total: f64 = list.iter().map(|&(_, w)| w).sum();
    let mut acc = 0.0;
    for &(s, w) in list {
        acc += w / total;
        if r < acc {
            return s;
        }
    }
    list[list.len() - 1].0
}
