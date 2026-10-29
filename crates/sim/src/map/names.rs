//! Names for the map's features (docs/spec/06-voice.md §4b): every site, the river, each ford, the most prominent
//! hills and the largest woods get a short, plain, sayable name, so the captain can say "hold the ridge" and the
//! voice brain can name it back. Pure and deterministic: the same map always gives the same names.
//!
//! - One word each, from a pool per feature kind (the keep is the NEST; villages MILL, BARN, FOLD…).
//! - Distinct first sounds across the map where the pools allow, so speech-to-text and the player can tell
//!   them apart; never a command word, a kind word, a foe word, or a word that sounds like a company's name.
//! - Which word of a pool a feature gets is `hash32(map seed, feature index, salt)`, so maps differ but a map is
//!   always named the same.

use serde::Serialize;

use super::{BattleMap, SiteKind, Tile};
use crate::contracts::P;
use crate::rng::hash32;

/// At most this many hills are named: the most prominent (radius × height).
pub const MAX_HILLS: usize = 3;
/// At most this many woods are named: the largest.
pub const MAX_WOODS: usize = 4;
/// A wood is at least this many forest tiles, 4-connected.
pub const MIN_WOOD: usize = 8;

const SALT_SITE: u32 = 0x6e61_0001;
const SALT_FORD: u32 = 0x6e61_0002;
const SALT_HILL: u32 = 0x6e61_0003;
const SALT_WOOD: u32 = 0x6e61_0004;

const KEEP: &[&str] = &["NEST", "LAIR", "DEN"];
const TOWN: &[&str] = &["TOWN", "BURGH", "WICK"];
const VILLAGE: &[&str] = &[
    "MILL", "BARN", "FOLD", "CROFT", "GRANGE", "THORPE", "KILN", "DAIRY", "SMITHY", "ORCHARD", "NOOK", "PADDOCK",
];
const SHRINE: &[&str] = &["SHRINE", "CAIRN", "CHAPEL", "ALTAR", "HENGE"];
const TOWER: &[&str] = &["SPIRE", "LOOKOUT", "BEACON", "TURRET", "BELFRY"];
const RIVER: &[&str] = &["RIVER"];
const FORD: &[&str] = &["FORD", "WADE", "SHALLOWS", "SHOAL", "STEPS", "GRAVEL"];
const HILL: &[&str] = &["RIDGE", "KNOLL", "TOR", "BARROW", "FELL", "CRAG", "HUMP", "MOUND", "DOWNS", "BLUFF"];
const WOOD: &[&str] = &[
    "OAKWOOD", "ASHWOOD", "ELMWOOD", "BIRCHES", "HAZELS", "PINES", "THICKET", "COPSE", "GROVE", "LARCHES", "YEWS",
];

/// Words a feature may never be called: the order language's verbs, selectors, kinds, foes, works and the words the
/// voice's fast path listens for (web/src/voice/{orders,field}.ts).
const NEVER: &[&str] = &[
    "ADVANCE", "ALL", "ARCHER", "ARCHERS", "ARMY", "ATTACK", "BACK", "BARRICADE", "BLIGHT", "BLIGHTMEN", "BOW", "BOWS",
    "BRIDGE", "BROODLORD", "BUILD", "CAPTAIN", "CAVALRY", "CENTRE", "CHARGE", "COLUMN", "COMMIT", "COVER", "DRAKE",
    "DRAKES", "FACE", "FIRE", "FREE", "FRESH", "FRONT", "GO", "GUARD", "HALT", "HERE", "HOLD", "HORSE", "LEFT", "LEVY",
    "LINE", "LOOSE", "MARCH", "MARK", "ME", "MOVE", "NOW", "PIKE", "PIKES", "RALLY", "REAR", "REGROUP", "RESERVE",
    "REST", "RIDERS", "RIGHT", "SCREEN", "SHIELD", "SHIELDS", "SIGNAL", "SPEAR", "SPEARS", "SQUARE", "STAKES", "STAND",
    "STOP", "TAKE", "TOWER", "TROLL", "TROLLS", "WAIT", "WALL", "WATCHTOWER", "WEDGE", "WELL", "WILL", "WITHDRAW",
];

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NamedHill {
    pub name: String,
    pub at: P,
    pub r: f64,
}

/// A wood: 4-connected forest tiles, with their bounding box in whole tiles (`x1`, `y1` inclusive).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NamedWood {
    pub name: String,
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
    pub tiles: usize,
}

/// A ford: a run of ford rows across the river, named at its middle row.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NamedFord {
    pub name: String,
    pub at: P,
}

/// The river: its columns from the westmost to the eastmost tile of water (`x1` inclusive), and its fords north to
/// south.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NamedRiver {
    pub name: String,
    pub x0: i32,
    pub x1: i32,
    pub fords: Vec<NamedFord>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Names {
    /// One name per site, by site id.
    pub sites: Vec<String>,
    pub river: Option<NamedRiver>,
    pub hills: Vec<NamedHill>,
    pub woods: Vec<NamedWood>,
}

impl Names {
    /// Every name, in the order they were given.
    pub fn all(&self) -> Vec<&str> {
        let mut out: Vec<&str> = self.sites.iter().map(String::as_str).collect();
        if let Some(r) = &self.river {
            out.push(&r.name);
            out.extend(r.fords.iter().map(|f| f.name.as_str()));
        }
        out.extend(self.hills.iter().map(|h| h.name.as_str()));
        out.extend(self.woods.iter().map(|w| w.name.as_str()));
        out
    }
}

/// Names the map's features. `avoid` holds the companies' names (both sides): no feature sounds like one.
pub fn name_features(m: &BattleMap, avoid: &[&str]) -> Names {
    let mut namer = Namer { seed: m.seed, taken: Vec::new(), avoid: avoid.iter().map(|s| s.to_uppercase()).collect() };
    // Sites first, in id order (the keep or town is site 0), so the places a player fights over get the first pick.
    let sites = m
        .sites
        .iter()
        .enumerate()
        .map(|(i, s)| {
            match s.kind {
                // The one keep or town is always called by its pool's first word: the NEST.
                SiteKind::Keep => namer.first(KEEP),
                SiteKind::Town => namer.first(TOWN),
                SiteKind::Village => namer.pick(VILLAGE, i as u32, SALT_SITE),
                SiteKind::Shrine => namer.pick(SHRINE, i as u32, SALT_SITE),
                SiteKind::Tower => namer.pick(TOWER, i as u32, SALT_SITE),
            }
        })
        .collect();
    let river = river(m).map(|(x0, x1, fords)| {
        let name = namer.first(RIVER);
        // The widest ford (the main one; ties north) is the FORD, the others take the pool's other words.
        let main = (0..fords.len()).max_by(|&a, &b| fords[a].1.cmp(&fords[b].1).then(b.cmp(&a)));
        let mut named: Vec<Option<String>> = vec![None; fords.len()];
        if let Some(k) = main {
            named[k] = Some(namer.first(FORD));
        }
        for (i, n) in named.iter_mut().enumerate() {
            if n.is_none() {
                *n = Some(namer.pick(&FORD[1..], i as u32, SALT_FORD));
            }
        }
        let fords = fords.into_iter().zip(named).map(|((at, _), name)| NamedFord { name: name.unwrap_or_default(), at }).collect();
        NamedRiver { name, x0, x1, fords }
    });
    let hills = prominent_hills(m)
        .into_iter()
        .enumerate()
        .map(|(i, (at, r))| NamedHill { name: namer.pick(HILL, i as u32, SALT_HILL), at, r })
        .collect();
    let woods = woods(m)
        .into_iter()
        .enumerate()
        .map(|(i, w)| NamedWood { name: namer.pick(WOOD, i as u32, SALT_WOOD), ..w })
        .collect();
    Names { sites, river, hills, woods }
}

struct Namer {
    seed: u32,
    taken: Vec<String>,
    avoid: Vec<String>,
}

impl Namer {
    /// The pool's first word if it is free, else as `pick`.
    fn first(&mut self, pool: &[&str]) -> String {
        if !self.taken.iter().any(|t| t == pool[0]) && !self.avoid.iter().any(|a| alike(a, pool[0])) {
            self.taken.push(pool[0].to_string());
            return pool[0].to_string();
        }
        self.pick(pool, 0, 0)
    }

    /// A word of `pool`, starting at a hashed place: the first that is free, not forbidden, not like a company's
    /// name and with a first sound no other feature has; failing that, the first free one whose first sound is
    /// taken; failing that, a pool word with the next free number word ("MILL TWO" is never needed on today's
    /// maps, but a pool can run dry).
    fn pick(&mut self, pool: &[&str], index: u32, salt: u32) -> String {
        let start = hash32(self.seed, index, salt) as usize % pool.len();
        let order: Vec<&str> = (0..pool.len()).map(|k| pool[(start + k) % pool.len()]).collect();
        let ok = |n: &&str| !self.taken.iter().any(|t| t == n) && !NEVER.contains(n) && !self.avoid.iter().any(|a| alike(a, n));
        let strict = order.iter().find(|n| ok(n) && !self.taken.iter().any(|t| onset(t) == onset(n)));
        let name = match strict.or_else(|| order.iter().find(|n| ok(n))) {
            Some(n) => n.to_string(),
            None => {
                const MORE: [&str; 6] = ["TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN"];
                let base = order[0];
                let n = MORE.iter().map(|m| format!("{base} {m}")).find(|n| !self.taken.contains(n));
                n.unwrap_or_else(|| format!("{base} {}", self.taken.len()))
            }
        };
        self.taken.push(name.clone());
        name
    }
}

/// The first sound of a word: its leading consonants with look-alike spellings folded ("PH" = "F", "KN" = "N",
/// "WR" = "R", a soft C = "S", a hard C or Q = "K"), or its first vowel. "STEPS" and "SHOAL" differ; "CAIRN" and
/// "KILN" do not.
pub fn onset(word: &str) -> String {
    let w = word.to_uppercase();
    let w = if let Some(rest) = w.strip_prefix("PH") {
        format!("F{rest}")
    } else if let Some(rest) = w.strip_prefix("KN").or_else(|| w.strip_prefix("WR")).or_else(|| w.strip_prefix("WH")) {
        format!("{}{rest}", if w.starts_with("KN") { "N" } else if w.starts_with("WR") { "R" } else { "W" })
    } else {
        w
    };
    let mut out = String::new();
    let cs: Vec<char> = w.chars().collect();
    for (i, &c) in cs.iter().enumerate() {
        if "AEIOUY".contains(c) {
            if out.is_empty() {
                out.push(c);
            }
            break;
        }
        let c = match c {
            'C' if cs.get(i + 1).is_some_and(|n| "EIY".contains(*n)) => 'S',
            'C' | 'Q' => 'K',
            c => c,
        };
        out.push(c);
    }
    out
}

/// Too close to a company's name to tell apart by ear: the same word, one edit away, or the same leading sound
/// and consonants ("BORS" and "BARS").
fn alike(a: &str, b: &str) -> bool {
    let consonants = |s: &str| -> String { s.chars().filter(|c| !"AEIOUYHW".contains(*c)).collect() };
    a == b || levenshtein(a, b) <= 1 || (onset(a) == onset(b) && consonants(a) == consonants(b))
}

fn levenshtein(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut prev = row[0];
        row[0] = i;
        for j in 1..=b.len() {
            let keep = row[j];
            row[j] = (row[j] + 1).min(row[j - 1] + 1).min(prev + usize::from(a[i - 1] != b[j - 1]));
            prev = keep;
        }
    }
    row[b.len()]
}

/// A ford's middle and its width in rows.
type FordAt = (P, i32);

/// The river's westmost and eastmost columns and its fords (each run of ford rows is one ford), or None without a
/// river.
fn river(m: &BattleMap) -> Option<(i32, i32, Vec<FordAt>)> {
    let (&x0, &x1) = (m.river.iter().min()?, m.river.iter().max()?);
    let is_ford = |y: i32| m.river.get(y as usize).is_some_and(|&x| m.idx(x, y).is_some_and(|i| m.ford[i]));
    let mut fords = Vec::new();
    let mut y = 0;
    while y < m.h as i32 {
        if is_ford(y) {
            let first = y;
            while is_ford(y + 1) {
                y += 1;
            }
            let mid = (first + y) / 2;
            fords.push((P::new(m.river[mid as usize] as f64 + 1.0, mid as f64 + 0.5), y - first + 1));
        }
        y += 1;
    }
    Some((x0, x1 + 1, fords))
}

/// The most prominent hills, by radius × height, ties by position.
fn prominent_hills(m: &BattleMap) -> Vec<(P, f64)> {
    let mut hs: Vec<_> = m.hills.iter().collect();
    hs.sort_by(|a, b| (b.r * b.h).total_cmp(&(a.r * a.h)).then(a.at.y.total_cmp(&b.at.y)).then(a.at.x.total_cmp(&b.at.x)));
    hs.into_iter().take(MAX_HILLS).map(|h| (h.at, h.r)).collect()
}

/// The largest woods: 4-connected forest of at least MIN_WOOD tiles, biggest first, ties north then west.
fn woods(m: &BattleMap) -> Vec<NamedWood> {
    let (w, h) = (m.w as i32, m.h as i32);
    let mut seen = vec![false; m.tiles.len()];
    let mut out = Vec::new();
    for start in 0..m.tiles.len() {
        if seen[start] || m.tiles[start] != Tile::Forest {
            continue;
        }
        let mut wood = NamedWood { name: String::new(), x0: w, y0: h, x1: -1, y1: -1, tiles: 0 };
        let mut stack = vec![start];
        seen[start] = true;
        while let Some(k) = stack.pop() {
            let (x, y) = ((k % w as usize) as i32, (k / w as usize) as i32);
            wood.x0 = wood.x0.min(x);
            wood.x1 = wood.x1.max(x);
            wood.y0 = wood.y0.min(y);
            wood.y1 = wood.y1.max(y);
            wood.tiles += 1;
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                if let Some(n) = m.idx(x + dx, y + dy)
                    && !seen[n]
                    && m.tiles[n] == Tile::Forest
                {
                    seen[n] = true;
                    stack.push(n);
                }
            }
        }
        if wood.tiles >= MIN_WOOD {
            out.push(wood);
        }
    }
    out.sort_by(|a, b| b.tiles.cmp(&a.tiles).then(a.y0.cmp(&b.y0)).then(a.x0.cmp(&b.x0)));
    out.truncate(MAX_WOODS);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::{MapKind, MapOpts, WIDTHS, generate};

    const COMPANIES: [&str; 11] = ["WIL", "ODA", "REN", "BORS", "HAL", "MAB", "TOM", "IVO", "GARETH", "BROODLORD", "CAPTAIN"];

    #[test]
    fn features_get_plain_distinct_names() {
        let (mut maps, mut names, mut clash, mut numbered) = (0, 0, 0, 0);
        let mut lines = Vec::new();
        for kind in [MapKind::Keep, MapKind::Town, MapKind::Ford, MapKind::Field] {
            for width in WIDTHS {
                let (mut n, mut hills, mut woods, mut fords) = (0, 0, 0, 0);
                for seed in 1..=20 {
                    let m = generate(seed, MapOpts { kind, width });
                    let a = name_features(&m, &COMPANIES);
                    assert_eq!(a, name_features(&m, &COMPANIES), "names are deterministic");
                    assert_eq!(a.sites.len(), m.sites.len());
                    let all = a.all();
                    for (i, x) in all.iter().enumerate() {
                        assert!(!all[..i].contains(x), "{kind:?}/{width} seed {seed}: {x} named twice");
                        assert!(!NEVER.contains(x), "{x} is a command word");
                        assert!(!COMPANIES.iter().any(|c| alike(c, x)), "{x} sounds like a company");
                        clash += all[..i].iter().any(|y| onset(y) == onset(x)) as usize;
                        numbered += x.contains(' ') as usize;
                    }
                    if m.kind == MapKind::Keep {
                        assert_eq!(a.sites[0], "NEST", "the keep is the nest");
                    }
                    n += all.len();
                    hills += a.hills.len();
                    woods += a.woods.len();
                    fords += a.river.as_ref().map_or(0, |r| r.fords.len());
                    maps += 1;
                }
                names += n;
                lines.push(format!("{kind:?}/{width}: {n} names ({hills} hills, {woods} woods, {fords} fords)"));
            }
        }
        println!("feature names: {maps} maps, {names} names, {clash} sharing a first sound, {numbered} numbered");
        println!("  {}", lines.join("\n  "));
        let m = generate(4, MapOpts { kind: MapKind::Keep, width: 48 });
        println!("  keep/48 seed 4: {:?}", name_features(&m, &COMPANIES).all());
        assert_eq!(numbered, 0, "a pool ran dry");
    }

    #[test]
    fn first_sounds() {
        assert_eq!(onset("SHOAL"), "SH");
        assert_eq!(onset("STEPS"), "ST");
        assert_eq!(onset("CAIRN"), onset("KILN"));
        assert_eq!(onset("CENTRE"), "S");
        assert_eq!(onset("OAKWOOD"), "O");
        assert_eq!(onset("KNOLL"), "N");
        assert!(alike("BORS", "BARS"));
        assert!(!alike("BORS", "BARN"));
    }
}
