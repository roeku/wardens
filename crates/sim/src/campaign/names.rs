//! The campaign's names (01-flow §6; 06-voice §4b; docs/engine/contracts/campaign.md §3): one or two syllables, a
//! different first sound each within a set the player says together, never a command or common word, and never
//! like another name in play. The rules are map/names.rs's (`onset`, `alike`, `NEVER`); these are the pools.
//!
//! Commanders and broodlords share one set of first sounds (the voice names both in battle); places and the bands'
//! home villages each have their own. A pool word is picked from a hashed start, so campaigns differ but a seed is
//! always named the same.

use crate::map::names::{NEVER, alike, onset};
use crate::rng::hash32;

pub const COMMANDERS: &[&str] = &[
    "ODA", "TAM", "IVO", "GARETH", "CORM", "DUNN", "FENN", "JORY", "LUNED", "NIALL", "PERYN", "SIOR", "ULF", "VANNA",
    "YSOLT", "ELWIN", "ALDO", "BRAN", "DRUST", "GWEN", "THEO", "SHONA", "TREV", "FRIDA", "GRETA", "BLY", "CLEM", "PRYCE",
    "MAIR", "HUW", "RUNA", "OSWY", "EDRIC", "KENNA", "MERIN", "TEGAN", "CADOC", "AERON",
];

pub const BROODLORDS: &[&str] = &[
    "GRAX", "MORG", "SKARN", "VOLK", "THRAKK", "ZUL", "KRUUL", "DRAEG", "UZGOR", "BRAKA", "NARG", "FEX", "HROTH", "GLOM",
    "YARG", "OSK", "SLURK", "RAKH", "IRKA", "EGROTH", "PUSK", "TOGG", "CHUUL",
];

pub const PLACES: &[&str] = &[
    "ASHBY", "BRENT", "COLBY", "DERWEN", "ELM", "FARLEY", "HAWLEY", "IVEL", "LINDEN", "MALHAM", "OAKLEY", "PENRITH",
    "QUINTON", "ROWAN", "SELBY", "THORNE", "UFFORD", "VEXLEY", "WARTON", "YARROW", "ZENNOR", "CHAD", "SHAP", "STOKE",
    "CRAYLE", "DRYBECK", "FLAXBY", "GLEN", "PRESTON", "TRENT", "SLADE", "SKELL", "SNAITH", "SWALE", "GARTH", "NORTON",
];

pub const VILLAGES: &[&str] = &[
    "ASH", "BRIGG", "COMBE", "DENE", "EYAM", "FOSS", "GOLE", "HOLME", "IFORD", "KIRK", "LEA", "MOSS", "NESS", "OXTON",
    "PEEL", "RYE", "SKEW", "THWAITE", "ULLOCK", "YEADON",
];

pub const SALT_COMMANDER: u32 = 0x6361_0001;
pub const SALT_BROODLORD: u32 = 0x6361_0002;
pub const SALT_PLACE: u32 = 0x6361_0003;
pub const SALT_VILLAGE: u32 = 0x6361_0004;

/// A word of `pool` for `index`, from a hashed start: the first that is not `taken`, not a command word or like one,
/// not like any of `avoid` or `taken`, and whose first sound is not in `sounds`; failing that, the first unlike one;
/// failing that, the first free one; failing that, the pool's word with a number.
pub fn pick(pool: &[&str], seed: u32, index: u32, salt: u32, taken: &[String], sounds: &[String], avoid: &[String]) -> String {
    let start = hash32(seed, index, salt) as usize % pool.len();
    let order: Vec<&str> = (0..pool.len()).map(|k| pool[(start + k) % pool.len()]).collect();
    let free = |n: &&str| !taken.iter().any(|t| t == n) && !NEVER.contains(n) && !NEVER.iter().any(|w| alike(w, n));
    let unlike = |n: &&str| !avoid.iter().chain(taken).any(|a| alike(a, n));
    let strict = order.iter().find(|n| free(n) && unlike(n) && !sounds.contains(&onset(n)));
    let loose = || order.iter().find(|n| free(n) && unlike(n));
    match strict.or_else(loose).or_else(|| order.iter().find(|n| free(n))) {
        Some(n) => n.to_string(),
        None => {
            let base = order[0];
            (2..).map(|k| format!("{base}{k}")).find(|n| !taken.contains(n)).unwrap_or_else(|| base.to_string())
        }
    }
}

/// Whether every name's first sound differs, for the tests.
pub fn distinct_sounds(names: &[&str]) -> bool {
    let mut seen: Vec<String> = Vec::new();
    for n in names {
        let o = onset(n);
        if seen.contains(&o) {
            return false;
        }
        seen.push(o);
    }
    true
}

/// One or two syllables: runs of vowels (Y counts) in the word.
pub fn syllables(word: &str) -> usize {
    let mut n = 0;
    let mut in_vowel = false;
    for c in word.chars() {
        let v = "AEIOUY".contains(c);
        if v && !in_vowel {
            n += 1;
        }
        in_vowel = v;
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pools_are_sayable() {
        let mut checked = 0;
        for pool in [COMMANDERS, BROODLORDS, PLACES, VILLAGES] {
            for w in pool {
                assert!(!NEVER.contains(w), "{w} is a command word");
                assert!(!NEVER.iter().any(|n| alike(n, w)), "{w} sounds like a command word");
                assert!((1..=2).contains(&syllables(w)), "{w} has {} syllables", syllables(w));
                checked += 1;
            }
        }
        println!("campaign names: {checked} pool words, each 1–2 syllables and unlike every command word");
    }
}
