//! The campaign's numbers (docs/spec/01-flow.md §4; 04-battle.md §6–§7), one table hooked into `Tune::campaign`,
//! so a JSON override (`PROTO_TUNE='{"campaign":{...}}'`) can replace any of them for the harness. Numbers the spec
//! gives are its own; chosen ones are marked and recorded in out/decisions-d5-campaign.md.

use serde::{Deserialize, Serialize};

use crate::units::Unit;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct CampaignTune {
    /// The road: five rows of three places, then the keep alone (01-flow §4).
    pub rows: u32,
    pub lanes: u32,
    /// Later rows roll each place's kind: camp 24%, village 22%, ford 20%, holdfast 34% (row 0 is all holdfasts).
    pub roll: KindRoll,
    /// The muster (01-flow §3.4): banners (the warband's companies), and 3 more bands and 2 more commanders.
    pub banners: u32,
    pub extra_bands: u32,
    pub extra_commanders: u32,
    /// A band is seasoned with this chance: 2 fewer men, rank 1, already in colours.
    pub seasoned: f64,
    pub seasoned_fewer: u16,
    pub seasoned_rank: u8,
    /// A commander is a veteran (a plume; back from an earlier campaign, 07-progression §2) with this chance, and
    /// brings this many ranks to the company he leads (chosen).
    pub veteran: f64,
    pub veteran_rank: u8,
    /// A commander planted on the kind his way suits gives the company this many ranks (04-battle §6).
    pub suited_rank: u8,
    /// Ranks run 0–3 (04-battle §2).
    pub max_rank: u8,
    /// The captain's name.
    pub captain: String,
    /// Garrison share `(0.80 + 0.075·step + 0.15·danger)` of full size (01-flow §4; 04-battle §7).
    pub share: [f64; 3],
    /// The garrison is scaled by the warband's size with this factor: it is worth `share · factor · W`, W the
    /// warband's men × worth. The spec's factor is 0.6 (01-flow §4); against the blight 0.6 measured too easy for
    /// the balance bands (01-flow §8), so 0.9 (deviation, out/decisions-d5-campaign.md).
    pub warband_factor: f64,
    /// Garrison rank `floor(step / rank_every)`.
    pub rank_every: u32,
    /// Garrison kinds: shield, spear, archer to start; +spear from step 2; +archer if dangerous; +horse from step 4;
    /// +shield at the keep.
    pub spear_from: u32,
    pub horse_from: u32,
    /// The blight's unit for each human kind of the garrison rule (chosen).
    pub blight: BlightMap,
    /// The ford's raiders: each wave keeps `round(len · m)` of its companies, at least this many (chosen).
    pub wave_min: usize,
    /// Broodlords: eight captains plus the nest's lord. An escaped broodlord returns this many ranks harder; the
    /// nest's lord stands this many ranks above the keep's garrison (chosen).
    pub broodlords: u32,
    pub escaped_rank: u8,
    pub lord_rank: u8,
    /// After a won battle, a fallen commander was only wounded with this chance (01-flow §4: half the fallen).
    pub wounded: f64,
    /// After a won battle, this share of the fallen men were only wounded and return to their company (01-flow §4
    /// "half the fallen were only wounded", read for the men too; out/decisions-d5-campaign.md).
    pub wounded_men: f64,
    /// At most this many companies (the freed found one, an heir leads the survivors, only below it).
    pub max_companies: u32,
    /// The freed found a company, and the survivors of a broken company follow an heir, when at least this many.
    pub found_min: u16,
    /// The freed gain a rank per battle survived and wear the colours (join the line) at this rank.
    pub freed_colours: u8,
    /// A village has this many houses (04-battle §8: 5 houses of 3 people).
    pub houses: u16,
    /// Camp: mend 35% of each company's missing men and half the captain's missing hp; honour is +1 rank.
    pub mend: f64,
    pub heal: f64,
    pub honour_rank: u8,
    /// The Hall keeps at most 24 fallen commanders' banners and 12 enemy colours (03-land §7).
    pub hall_fallen: usize,
    pub hall_colours: usize,
}

/// The chances of a later row's place kinds, in this order.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct KindRoll {
    pub camp: f64,
    pub village: f64,
    pub ford: f64,
    pub holdfast: f64,
}

/// The blight's unit for each kind of the garrison rule.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BlightMap {
    pub spear: Unit,
    pub shield: Unit,
    pub archer: Unit,
    pub horse: Unit,
}

impl Default for CampaignTune {
    fn default() -> CampaignTune {
        CampaignTune {
            rows: 5,
            lanes: 3,
            roll: KindRoll { camp: 0.24, village: 0.22, ford: 0.20, holdfast: 0.34 },
            banners: 4,
            extra_bands: 3,
            extra_commanders: 2,
            seasoned: 0.30,
            seasoned_fewer: 2,
            seasoned_rank: 1,
            veteran: 0.25,
            veteran_rank: 1,
            suited_rank: 1,
            max_rank: 3,
            captain: "CAPTAIN".into(),
            share: [0.80, 0.075, 0.15],
            warband_factor: 0.9,
            rank_every: 3,
            spear_from: 2,
            horse_from: 4,
            blight: BlightMap { spear: Unit::BlightMan, shield: Unit::Troll, archer: Unit::Drake, horse: Unit::Drake },
            wave_min: 1,
            broodlords: 8,
            escaped_rank: 1,
            lord_rank: 1,
            wounded: 0.5,
            wounded_men: 0.5,
            max_companies: 5,
            found_min: 4,
            freed_colours: 2,
            houses: 5,
            mend: 0.35,
            heal: 0.5,
            honour_rank: 1,
            hall_fallen: 24,
            hall_colours: 12,
        }
    }
}
