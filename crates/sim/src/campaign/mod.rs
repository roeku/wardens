//! The campaign (docs/spec/01-flow.md §3–§5; docs/engine/contracts/campaign.md): the road, the muster, the
//! garrisons and their broodlords, the battle at each place and its aftermath, camps, and the end with its
//! chronicle and Hall data. Pure and deterministic: the same seed always gives the same campaign, and every roll
//! is `hash32(seed, …)` or the seeded `Rng`. The state is serde and saved whole, versioned (`v`), between battles.
//!
//! Phases: `muster → march → battle | camp → map → march → … → won | lost`. A battle is made by `battle()` and its
//! outcome applied by `finish()`. Choices the spec leaves open are in out/decisions-d5-campaign.md.

pub mod auto;
mod battle;
pub mod custom;
mod finish;
mod foes;
mod garrison;
mod muster;
pub mod names;
pub mod road;
mod state;
#[cfg(test)]
mod tests;
pub mod tune;

use serde::{Deserialize, Serialize};

pub use battle::Fight;
pub use finish::{Tally, TallyCompany, TallyFoe};
pub use road::{Place, PlaceKind};
pub use tune::CampaignTune;

use crate::contracts::{P, Way};
use crate::map::BattleMap;
use crate::rng::hash32;
use crate::tune::Tune;
use crate::units::Unit;

/// The save's version: a save of another version is discarded (01-flow §5).
pub const VERSION: u32 = 1;

const SALT_FACE: u32 = 0x6361_0020;
const SALT_FOE_FACE: u32 = 0x6361_0021;
const SALT_CAPTAIN_FACE: u32 = 0x6361_0022;
const SALT_WAY: u32 = 0x6361_0023;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Muster,
    Map,
    March,
    Battle,
    Camp,
    Won,
    Lost,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Phase::Muster => "muster",
            Phase::Map => "map",
            Phase::March => "march",
            Phase::Battle => "battle",
            Phase::Camp => "camp",
            Phase::Won => "won",
            Phase::Lost => "lost",
        }
    }
}

/// A band of men waiting at the muster under its village's linen banner (01-flow §3.4).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Band {
    pub id: u32,
    pub unit: Unit,
    pub men: u16,
    pub seasoned: bool,
    /// Its own rank (seasoned bands are rank 1).
    pub rank: u8,
    pub village: String,
    pub commander: Option<u32>,
    /// Where it waits on the muster ground.
    pub at: P,
}

/// A commander standing before the hall: a way, and the kind it suits.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Commander {
    pub id: u32,
    pub name: String,
    pub way: Way,
    pub face: u32,
    /// Back from an earlier campaign (a plume): brings a rank.
    pub veteran: bool,
    pub band: Option<u32>,
    pub at: P,
}

/// The kind a way suits (04-battle.md §6).
pub fn suits(way: Way) -> Unit {
    match way {
        Way::Stubborn => Unit::Shield,
        Way::Reckless => Unit::Horse,
        Way::Steady => Unit::Archer,
        Way::Veteran => Unit::Spear,
    }
}

pub const WAYS: [Way; 4] = [Way::Stubborn, Way::Reckless, Way::Steady, Way::Veteran];

pub fn way_name(w: Way) -> &'static str {
    match w {
        Way::Stubborn => "stubborn",
        Way::Reckless => "reckless",
        Way::Steady => "steady",
        Way::Veteran => "veteran",
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct Last {
    pub lost: u16,
    pub joined: u16,
}

/// A company of the warband: its commander's name, way and face, its men as they stand.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Company {
    pub id: u32,
    pub name: String,
    pub unit: Unit,
    pub men: u16,
    pub full: u16,
    pub rank: u8,
    pub way: Way,
    pub face: u32,
    /// The freed: in their own clothes, in the reserve, until rank 2.
    pub freed: bool,
    pub kills: u32,
    pub battles: u32,
    /// Broodlords this company brought down (foe ids).
    pub colours: Vec<u32>,
    pub last: Last,
    /// The commander (a person id) and whether he is a veteran.
    pub commander: u32,
    pub veteran: bool,
    pub village: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Captain {
    pub name: String,
    pub hp: f64,
    pub hp_max: f64,
    pub face: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FoeState {
    Waiting,
    Escaped,
    Down,
}

/// An enemy commander: one of the eight broodlords, or the nest's lord.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Foe {
    pub id: u32,
    pub name: String,
    pub way: Way,
    pub rank: u8,
    pub face: u32,
    pub place: Option<u32>,
    pub state: FoeState,
    /// The nest's lord, at the keep.
    pub lord: bool,
    /// The warband has fought him.
    pub met: bool,
    /// The company that brought him down.
    pub by: Option<u32>,
}

/// A commander who fell.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Fallen {
    pub id: u32,
    pub name: String,
    pub face: u32,
    pub way: Way,
    pub rank: u8,
    pub unit: Unit,
    pub step: u32,
    pub place: Option<u32>,
}

/// How the campaign ended.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct End {
    pub won: bool,
    /// `keep taken`, `captain fell` or `warband gone`.
    pub reason: String,
}

/// `Campaign.create`'s options (contract §2): `{campaign: "warden", banners: 4}`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Opts {
    pub campaign: String,
    pub banners: u32,
}

impl Default for Opts {
    fn default() -> Opts {
        Opts { campaign: "warden".into(), banners: CampaignTune::default().banners }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Campaign {
    pub v: u32,
    pub seed: u32,
    pub campaign: String,
    pub phase: Phase,
    /// The row the warband chooses from next.
    pub step: u32,
    /// The place the warband stands at; `None` at the hall.
    pub at: Option<u32>,
    /// While marching and fighting: where it came from (it falls back there on a loss) and where it goes.
    pub from: Option<u32>,
    pub to: Option<u32>,
    pub day: u32,
    /// Battles fought (won or lost).
    pub battles: u32,
    pub places: Vec<Place>,
    pub banners: u32,
    pub bands: Vec<Band>,
    pub commanders: Vec<Commander>,
    pub captain: Captain,
    pub companies: Vec<Company>,
    pub foes: Vec<Foe>,
    /// Broodlords waiting to be placed, the next first.
    pub queue: Vec<u32>,
    pub fallen: Vec<Fallen>,
    /// The company honoured at this camp.
    pub honoured: Option<u32>,
    pub end: Option<End>,
    next_person: u32,
    next_company: u32,
    /// Villages that burnt out since the last tally.
    burnt: Vec<u32>,
    /// The last battle's tally.
    pub last: Option<Tally>,
    #[serde(skip)]
    pub tune: Tune,
}

/// The captain's hp as the campaign keeps it: to the hundredth, so a save prints and parses back to the same number
/// (serde_json's parser is not correctly rounded for every 17-digit float).
pub(crate) fn hp_kept(hp: f64) -> f64 {
    (hp * 100.0).round() / 100.0
}

fn face(seed: u32, id: u32, salt: u32) -> u32 {
    hash32(seed, id, salt).max(1)
}

impl Campaign {
    /// A new campaign for `seed`: the road rolled and named, the bands and commanders at the muster, the broodlords
    /// shuffled across the first rows and the lord at the keep.
    pub fn create(seed: u32, opts: &Opts, tune: Tune) -> Campaign {
        let t = tune.campaign.clone();
        let banners = opts.banners.max(1);
        let captain_hp = tune.unit_spec(Unit::Captain).map(|s| s.hp).unwrap_or(tune.kinds.captain.hp);
        let mut c = Campaign {
            v: VERSION,
            seed,
            campaign: if opts.campaign.is_empty() { "warden".into() } else { opts.campaign.clone() },
            phase: Phase::Muster,
            step: 0,
            at: None,
            from: None,
            to: None,
            day: 0,
            battles: 0,
            places: Vec::new(),
            banners,
            bands: Vec::new(),
            commanders: Vec::new(),
            captain: Captain { name: t.captain.clone(), hp: captain_hp, hp_max: captain_hp, face: face(seed, 0, SALT_CAPTAIN_FACE) },
            companies: Vec::new(),
            foes: Vec::new(),
            queue: Vec::new(),
            fallen: Vec::new(),
            honoured: None,
            end: None,
            next_person: 0,
            next_company: 0,
            burnt: Vec::new(),
            last: None,
            tune,
        };
        c.muster_up();
        c.raise_foes();
        let avoid: Vec<String> = c.commanders.iter().map(|m| m.name.clone()).chain(c.foes.iter().map(|f| f.name.clone())).collect();
        c.places = road::roll(seed, &c.tune.campaign, &avoid);
        c.place_foes();
        c
    }

    /// A saved campaign (contract §2 `Campaign.load`); a save of another version is refused.
    pub fn load(json: &str, tune: Tune) -> Result<Campaign, String> {
        let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("save: {e}"))?;
        let ver = v.get("v").and_then(|x| x.as_u64()).unwrap_or(0);
        if ver != VERSION as u64 {
            return Err(format!("save version {ver}, this game reads {VERSION}: discard the save"));
        }
        let mut c: Campaign = serde_json::from_value(v).map_err(|e| format!("save: {e}"))?;
        c.tune = tune;
        Ok(c)
    }

    /// The whole state as JSON, only between battles (01-flow §5).
    pub fn save(&self) -> Result<String, String> {
        if self.phase == Phase::Battle {
            return Err("no saving during a battle: it is refought from its start".into());
        }
        serde_json::to_string(self).map_err(|e| e.to_string())
    }

    fn person(&mut self) -> u32 {
        let id = self.next_person;
        self.next_person += 1;
        id
    }

    fn company_id(&mut self) -> u32 {
        let id = self.next_company;
        self.next_company += 1;
        id
    }

    /// A person's look.
    fn face_of(&self, person: u32) -> u32 {
        face(self.seed, person, SALT_FACE)
    }

    fn way_of(&self, person: u32) -> Way {
        WAYS[hash32(self.seed, person, SALT_WAY) as usize % WAYS.len()]
    }

    pub fn place(&self, id: u32) -> Option<&Place> {
        self.places.get(id as usize)
    }

    /// Where the warband stands: its place, or the hall.
    pub fn at_point(&self) -> P {
        self.at.and_then(|id| self.place(id)).map_or(crate::map::road::HALL, |p| p.at)
    }

    /// The places the warband may set out for now: in the row it chooses from, linked from where it stands.
    pub fn reachable(&self) -> Vec<u32> {
        if !matches!(self.phase, Phase::Muster | Phase::Map) {
            return Vec::new();
        }
        let links = match self.at.and_then(|id| self.place(id)) {
            Some(p) => p.links.clone(),
            None => road::hall_links(&self.places),
        };
        links.into_iter().filter(|&id| self.place(id).is_some_and(|p| p.step == self.step && !p.done)).collect()
    }

    /// Marches for `place` (contract §2 `set_out`): from the muster (once every banner has its company, the
    /// warband falls in) or the map.
    pub fn set_out(&mut self, place: u32) -> Result<(), String> {
        if !matches!(self.phase, Phase::Muster | Phase::Map) {
            return Err(format!("cannot set out during '{}'", self.phase.name()));
        }
        if !self.reachable().contains(&place) {
            return Err(format!("place {place} is not reachable from here"));
        }
        if self.phase == Phase::Muster {
            let planted = self.bands.iter().filter(|b| b.commander.is_some()).count() as u32;
            if planted < self.banners {
                return Err(format!("{planted} of {} banners have their company", self.banners));
            }
            self.fall_in();
        }
        self.from = self.at;
        self.to = Some(place);
        self.phase = Phase::March;
        Ok(())
    }

    /// The column reaches its place (contract §2 `arrive`): a day passes; a camp is the camp phase, anywhere else
    /// the battle.
    pub fn arrive(&mut self) -> Result<(), String> {
        if self.phase != Phase::March {
            return Err(format!("cannot arrive during '{}'", self.phase.name()));
        }
        let to = self.to.ok_or("not marching anywhere")?;
        self.at = Some(to);
        self.spend_day(to);
        if self.place(to).is_some_and(|p| p.kind == PlaceKind::Camp) {
            self.phase = Phase::Camp;
            self.honoured = None;
            self.mend();
        } else {
            self.phase = Phase::Battle;
        }
        Ok(())
    }

    /// A day spent at `here`: every village in sight (this row and the next) loses a house, camps included.
    fn spend_day(&mut self, here: u32) {
        self.day += 1;
        let row = self.place(here).map_or(0, |p| p.step);
        for p in self.places.iter_mut() {
            if p.kind == PlaceKind::Village && !p.done && p.id != here && (p.step == row || p.step == row + 1) && p.houses > 0 {
                p.houses -= 1;
                if p.houses == 0 {
                    self.burnt.push(p.id);
                }
            }
        }
    }

    /// The warband leaves row `row` behind: the villages it passed by burn out, and the broodlords it passed by
    /// go back to the queue.
    fn pass_row(&mut self, row: u32) {
        for i in 0..self.places.len() {
            let p = &mut self.places[i];
            if p.step != row || p.done {
                continue;
            }
            if p.kind == PlaceKind::Village && p.houses > 0 {
                p.houses = 0;
                let id = p.id;
                self.burnt.push(id);
            }
            if let Some(f) = self.places[i].foe.take() {
                self.recall_foe(f);
            }
        }
    }

    /// Camp (01-flow §3.8): the wounded mend, 35% of each company's missing men and half the captain's missing hp.
    fn mend(&mut self) {
        let t = self.tune.campaign.clone();
        for c in self.companies.iter_mut() {
            let missing = c.full.saturating_sub(c.men) as f64;
            c.men = (c.men + (missing * t.mend).round() as u16).min(c.full);
        }
        let cap = &mut self.captain;
        cap.hp = hp_kept((cap.hp + (cap.hp_max - cap.hp) * t.heal).min(cap.hp_max));
    }

    /// Honours one company at camp: +1 rank, once per camp (contract §2 `honour`).
    pub fn honour(&mut self, company: u32) -> Result<(), String> {
        if self.phase != Phase::Camp {
            return Err(format!("no honours during '{}'", self.phase.name()));
        }
        if self.honoured.is_some() {
            return Err("a company was honoured at this camp already".into());
        }
        let (rank, max) = (self.tune.campaign.honour_rank, self.tune.campaign.max_rank);
        let c = self.companies.iter_mut().find(|c| c.id == company).ok_or(format!("no company {company}"))?;
        c.rank = (c.rank + rank).min(max);
        if c.freed && c.rank >= self.tune.campaign.freed_colours {
            c.freed = false;
        }
        self.honoured = Some(company);
        Ok(())
    }

    /// Breaks camp (contract §2 `break_camp`): the camp's row is passed, the road goes on.
    pub fn break_camp(&mut self) -> Result<(), String> {
        if self.phase != Phase::Camp {
            return Err(format!("no camp to break during '{}'", self.phase.name()));
        }
        let here = self.at.ok_or("camp without a place")?;
        let row = self.place(here).map_or(self.step, |p| p.step);
        if let Some(p) = self.places.get_mut(here as usize) {
            p.done = true;
        }
        self.advance(row);
        self.phase = Phase::Map;
        Ok(())
    }

    /// The warband has passed row `row`: the next row is chosen from.
    fn advance(&mut self, row: u32) {
        self.pass_row(row);
        self.step = row + 1;
        self.from = None;
        self.to = None;
        self.place_foes();
    }

    /// The warband's men × worth (its companies, rank by rank).
    pub fn warband_worth(&self) -> f64 {
        self.companies
            .iter()
            .map(|c| {
                let spec = self.tune.unit_spec(c.unit).unwrap_or_else(|_| self.tune.kinds.get(self.tune.unit_kind(c.unit)).clone());
                c.men as f64 * spec.worth(&self.tune.rank, c.rank)
            })
            .sum()
    }

    /// The road map as it stands (03-land §9): done places ours, held ones the blight's.
    pub fn road_map(&self) -> BattleMap {
        crate::map::road::make(self.seed, &road::layout(&self.places))
    }
}

/// The road map of `seed`'s campaign before it is walked (`map::generate` for `MapKind::Road`).
pub fn road_map(seed: u32) -> BattleMap {
    Campaign::create(seed, &Opts::default(), Tune::default()).road_map()
}
