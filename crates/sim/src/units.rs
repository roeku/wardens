//! Units as data (docs/spec/04-battle.md §2 "Unit overrides"): a unit is a base kind plus partial `KindSpec`
//! overrides, `spec = {...KINDS[kind], ...stats}`. The table lives in `Tune::units`, so a JSON override can retune or
//! re-base any unit (`{"units":{"troll":{"stats":{"hp":44}}}}`). Every rule a unit brings is a stat in `KindSpec`,
//! never a test of which unit it is.
//!
//! The blight (docs/spec/00-start-here.md §A2, §A4): blight-men (levy stats), trolls (impact blows, cleave), the
//! wild drake pack (breath and the hunt) and the broodlord, the blight's commander in the general's place.

use serde::{Deserialize, Serialize};

use crate::contracts::Kind;

/// Which unit a company is. The view draws by it; the rules read only the merged `KindSpec` and the base `Kind`.
/// Append new units at the end: the view packs `id()`, so the order never changes.
#[repr(u8)]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Spear,
    Shield,
    Archer,
    Horse,
    Levy,
    Folk,
    Captain,
    BlightMan,
    Troll,
    Drake,
    Broodlord,
}

impl Unit {
    pub const ALL: [Unit; 11] = [
        Unit::Spear,
        Unit::Shield,
        Unit::Archer,
        Unit::Horse,
        Unit::Levy,
        Unit::Folk,
        Unit::Captain,
        Unit::BlightMan,
        Unit::Troll,
        Unit::Drake,
        Unit::Broodlord,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Unit::Spear => "spear",
            Unit::Shield => "shield",
            Unit::Archer => "archer",
            Unit::Horse => "horse",
            Unit::Levy => "levy",
            Unit::Folk => "folk",
            Unit::Captain => "captain",
            Unit::BlightMan => "blightman",
            Unit::Troll => "troll",
            Unit::Drake => "drake",
            Unit::Broodlord => "broodlord",
        }
    }

    pub const fn id(self) -> u8 {
        self as u8
    }

    pub fn parse(s: &str) -> Option<Unit> {
        Unit::ALL.into_iter().find(|u| u.name() == s)
    }

    /// The unit a company of `kind` is when nothing names one. A bare beast is the wild drake, as the beast kind's
    /// placeholder stats were.
    pub fn of_kind(kind: Kind) -> Unit {
        match kind {
            Kind::Spear => Unit::Spear,
            Kind::Shield => Unit::Shield,
            Kind::Archer => Unit::Archer,
            Kind::Horse => Unit::Horse,
            Kind::Levy => Unit::Levy,
            Kind::Folk => Unit::Folk,
            Kind::Captain => Unit::Captain,
            Kind::Beast => Unit::Drake,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_names_are_fixed() {
        let names: Vec<&str> = Unit::ALL.iter().map(|u| u.name()).collect();
        assert_eq!(names, ["spear", "shield", "archer", "horse", "levy", "folk", "captain", "blightman", "troll", "drake", "broodlord"]);
        for (i, u) in Unit::ALL.iter().enumerate() {
            assert_eq!(u.id() as usize, i);
            assert_eq!(Unit::parse(u.name()), Some(*u));
            assert_eq!(serde_json::to_string(u).unwrap(), format!("\"{}\"", u.name()));
        }
        println!("units: {} ids and names fixed", Unit::ALL.len());
    }
}
