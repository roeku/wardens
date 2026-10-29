//! The road (01-flow §4; 03-land §9): six steps, five rows of three places and then the keep alone. From lane L the
//! warband may go to lanes L±1. Row 0 is all holdfasts; later rows roll each place's kind. Place ids run row by
//! row (`step·lanes + lane`), the keep last; the hall is not a place (`at: null`).

use serde::{Deserialize, Serialize};

use super::names::{self, PLACES, SALT_PLACE};
use super::tune::CampaignTune;
use crate::contracts::P;
use crate::map::SiteKind;
use crate::map::names::onset;
use crate::map::road::{HALL, RoadLayout, RoadNode, place_at};
use crate::rng::jitter;

const SALT_KIND: u32 = 0x6361_0010;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlaceKind {
    Holdfast,
    Village,
    Ford,
    Camp,
    Keep,
}

impl PlaceKind {
    pub fn name(self) -> &'static str {
        match self {
            PlaceKind::Holdfast => "holdfast",
            PlaceKind::Village => "village",
            PlaceKind::Ford => "ford",
            PlaceKind::Camp => "camp",
            PlaceKind::Keep => "keep",
        }
    }

    /// A broodlord can hold it: the garrisoned places (the ford has raiders, the camp nobody).
    pub fn held(self) -> bool {
        matches!(self, PlaceKind::Holdfast | PlaceKind::Village | PlaceKind::Keep)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Place {
    pub id: u32,
    pub step: u32,
    pub lane: u32,
    pub kind: PlaceKind,
    pub name: String,
    pub at: P,
    /// The places of the next row it leads to.
    pub links: Vec<u32>,
    /// Taken (or rested at): the warband has been here and won.
    pub done: bool,
    /// Rises by 1 each time the warband loses here.
    pub danger: u32,
    /// A village's houses still standing (0 = burnt out); others 0.
    pub houses: u16,
    /// The broodlord holding it (a foe id).
    pub foe: Option<u32>,
}

/// The places of the road for `seed`: kinds rolled, positions jittered, links made, names given (none like the
/// names in `avoid`).
pub fn roll(seed: u32, t: &CampaignTune, avoid: &[String]) -> Vec<Place> {
    let (rows, lanes) = (t.rows.max(1), t.lanes.max(1));
    let mut places = Vec::new();
    for step in 0..rows {
        for lane in 0..lanes {
            let id = step * lanes + lane;
            let kind = if step == 0 { PlaceKind::Holdfast } else { kind_roll(t, jitter(seed, id, SALT_KIND)) };
            places.push(Place {
                id,
                step,
                lane,
                kind,
                name: String::new(),
                at: place_at(seed, id, step, lane),
                links: Vec::new(),
                done: false,
                danger: 0,
                houses: if kind == PlaceKind::Village { t.houses } else { 0 },
                foe: None,
            });
        }
    }
    let keep = rows * lanes;
    let mid = (lanes - 1) / 2;
    places.push(Place {
        id: keep,
        step: rows,
        lane: mid,
        kind: PlaceKind::Keep,
        name: String::new(),
        at: place_at(seed, keep, rows, mid),
        links: Vec::new(),
        done: false,
        danger: 0,
        houses: 0,
        foe: None,
    });
    // Links: each place to the next row's within ±1 lane; the last row to the keep.
    for p in places.iter_mut().filter(|p| p.kind != PlaceKind::Keep) {
        p.links = if p.step + 1 == rows {
            vec![keep]
        } else {
            let lo = p.lane.saturating_sub(1);
            let hi = (p.lane + 1).min(lanes - 1);
            (lo..=hi).map(|l| (p.step + 1) * lanes + l).collect()
        };
    }
    // Names: distinct first sounds along the road where the pool allows.
    let mut taken: Vec<String> = Vec::new();
    let mut sounds: Vec<String> = Vec::new();
    for p in places.iter_mut() {
        let n = names::pick(PLACES, seed, p.id, SALT_PLACE, &taken, &sounds, avoid);
        sounds.push(onset(&n));
        taken.push(n.clone());
        p.name = n;
    }
    places
}

fn kind_roll(t: &CampaignTune, r: f64) -> PlaceKind {
    let k = &t.roll;
    let total = k.camp + k.village + k.ford + k.holdfast;
    let r = r * total;
    if r < k.camp {
        PlaceKind::Camp
    } else if r < k.camp + k.village {
        PlaceKind::Village
    } else if r < k.camp + k.village + k.ford {
        PlaceKind::Ford
    } else {
        PlaceKind::Holdfast
    }
}

/// The hall links to every place of row 0.
pub fn hall_links(places: &[Place]) -> Vec<u32> {
    places.iter().filter(|p| p.step == 0).map(|p| p.id).collect()
}

/// The road as the map draws it: a site per place in a kind the view already draws (a holdfast a tower, a village a
/// town, a ford a village, a camp a shrine with its fire, the keep the keep; done places ours, held ones the
/// blight's), the hall last as a keep of ours; links as straight roads.
pub fn layout(places: &[Place]) -> RoadLayout {
    let mut nodes: Vec<RoadNode> = places
        .iter()
        .map(|p| {
            let (site, held) = match p.kind {
                PlaceKind::Holdfast => (SiteKind::Tower, true),
                PlaceKind::Village => (SiteKind::Town, true),
                PlaceKind::Ford => (SiteKind::Village, false),
                PlaceKind::Camp => (SiteKind::Shrine, false),
                PlaceKind::Keep => (SiteKind::Keep, true),
            };
            let owner = if p.done && p.kind != PlaceKind::Camp {
                Some(0)
            } else if held {
                Some(1)
            } else {
                None
            };
            RoadNode { at: p.at, site, owner }
        })
        .collect();
    let hall = nodes.len();
    nodes.push(RoadNode { at: HALL, site: SiteKind::Keep, owner: Some(0) });
    let mut links: Vec<(usize, usize)> = hall_links(places).into_iter().map(|id| (hall, id as usize)).collect();
    for p in places {
        for &to in &p.links {
            links.push((p.id as usize, to as usize));
        }
    }
    RoadLayout { nodes, links }
}
