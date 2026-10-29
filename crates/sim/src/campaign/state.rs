//! The campaign as the screens read it (contract §3 `state_json`), and the end's chronicle and Hall data.

use serde_json::{Value, json};

use super::{Campaign, FoeState, Phase, suits, way_name};
use crate::contracts::P;
use crate::map::road::{H, HALL, MUSTER_X0, MUSTER_X1, W};

fn pt(p: P) -> Value {
    json!({ "x": p.x, "y": p.y })
}

impl Campaign {
    /// The state (contract §3).
    pub fn state(&self) -> Value {
        let reachable = self.reachable();
        let places: Vec<Value> = self
            .places
            .iter()
            .map(|p| {
                let garrison: Vec<Value> =
                    self.garrison_listing(p).into_iter().map(|(u, n, k)| json!({ "unit": u.name(), "n": n, "companies": k })).collect();
                json!({
                    "id": p.id,
                    "step": p.step,
                    "lane": p.lane,
                    "kind": p.kind.name(),
                    "name": p.name,
                    "at": pt(p.at),
                    "links": p.links,
                    "reachable": reachable.contains(&p.id),
                    "done": p.done,
                    "danger": p.danger,
                    "houses": p.houses,
                    "foe": p.foe,
                    "garrison": garrison,
                    "share": self.garrison_share(p),
                    "rank": self.garrison_rank(p),
                    "site": p.id,
                })
            })
            .collect();
        let companies: Vec<Value> = self
            .companies
            .iter()
            .enumerate()
            .map(|(k, c)| {
                json!({
                    "id": c.id, "name": c.name, "unit": c.unit.name(), "men": c.men, "full": c.full, "rank": c.rank,
                    "way": way_name(c.way), "face": c.face, "freed": c.freed, "kills": c.kills, "battles": c.battles,
                    "colours": c.colours, "last": { "lost": c.last.lost, "joined": c.last.joined },
                    "veteran": c.veteran, "village": c.village, "squad": k + 1,
                })
            })
            .collect();
        let bands: Vec<Value> = self
            .bands
            .iter()
            .map(|b| {
                let c = b.commander.and_then(|id| self.commanders.iter().find(|c| c.id == id));
                json!({
                    "id": b.id, "unit": b.unit.name(), "men": b.men, "seasoned": b.seasoned,
                    "rank": c.map_or(b.rank, |c| self.planted_rank(c, b)), "village": b.village, "commander": b.commander,
                    "at": pt(b.at), "squad": b.id + 1,
                })
            })
            .collect();
        let commanders: Vec<Value> = self
            .commanders
            .iter()
            .map(|c| {
                json!({
                    "id": c.id, "name": c.name, "way": way_name(c.way), "face": c.face, "veteran": c.veteran,
                    "suits": suits(c.way).name(), "band": c.band, "at": pt(c.at),
                })
            })
            .collect();
        let foes: Vec<Value> = self
            .foes
            .iter()
            .map(|f| {
                json!({
                    "id": f.id, "name": f.name, "way": way_name(f.way), "rank": f.rank, "face": f.face, "place": f.place,
                    "state": state_name(f.state), "lord": f.lord, "met": f.met, "by": f.by,
                })
            })
            .collect();
        let fallen: Vec<Value> = self
            .fallen
            .iter()
            .map(|f| json!({ "name": f.name, "face": f.face, "way": way_name(f.way), "rank": f.rank, "unit": f.unit.name(), "step": f.step, "place": f.place }))
            .collect();
        let planted = self.bands.iter().filter(|b| b.commander.is_some()).count();
        json!({
            "v": self.v,
            "seed": self.seed,
            "campaign": self.campaign,
            "phase": self.phase.name(),
            "step": self.step,
            "at": self.at,
            "from": self.from,
            "to": self.to,
            "day": self.day,
            "battles": self.battles,
            "honoured": self.honoured,
            "road": {
                "w": W, "h": H, "hall": pt(HALL),
                "muster": { "x0": MUSTER_X0, "y0": 0, "x1": MUSTER_X1, "y1": H },
                "hall_links": super::road::hall_links(&self.places),
                "places": places,
            },
            "warband": {
                "captain": { "name": self.captain.name, "hp": self.captain.hp, "hp_max": self.captain.hp_max, "face": self.captain.face },
                "companies": companies,
            },
            "muster": { "banners": self.banners, "planted": planted, "ready": planted as u32 >= self.banners, "bands": bands, "commanders": commanders },
            "foes": foes,
            "fallen": fallen,
            "last": self.last,
            "chronicle": self.end.as_ref().map(|_| self.chronicle()),
            "hall": self.end.as_ref().map(|_| self.hall()),
        })
    }

    /// The chronicle (01-flow §3.9): the commanders side by side, the living in colour and the fallen in grey; a gold
    /// frame if won; the enemy commanders met, grey if brought down.
    pub fn chronicle(&self) -> Value {
        let mut commanders: Vec<Value> = self
            .companies
            .iter()
            .map(|c| json!({ "name": c.name, "face": c.face, "way": way_name(c.way), "rank": c.rank, "unit": c.unit.name(), "alive": true, "colours": c.colours.len() }))
            .collect();
        commanders.extend(self.fallen.iter().map(|f| json!({ "name": f.name, "face": f.face, "way": way_name(f.way), "rank": f.rank, "unit": f.unit.name(), "alive": false, "colours": 0 })));
        let foes: Vec<Value> = self
            .foes
            .iter()
            .filter(|f| f.met)
            .map(|f| json!({ "name": f.name, "face": f.face, "lord": f.lord, "down": f.state == FoeState::Down }))
            .collect();
        let (won, reason) = self.end.as_ref().map_or((false, String::new()), |e| (e.won, e.reason.clone()));
        json!({
            "won": won, "reason": reason, "frame": if won { "gold" } else { "grey" },
            "commanders": commanders, "foes": foes, "days": self.day, "battles": self.battles,
            "captain": { "name": self.captain.name, "face": self.captain.face, "alive": self.captain.hp > 0.0 },
        })
    }

    /// What this campaign adds to the Hall (01-flow §3.10): the fallen commanders' banners (up to 24), the enemy
    /// colours taken (up to 12), and the commanders who lived (veterans for a later campaign, 07-progression §2).
    pub fn hall(&self) -> Value {
        let t = &self.tune.campaign;
        let fallen: Vec<Value> = self.fallen.iter().take(t.hall_fallen).map(|f| json!({ "name": f.name, "face": f.face, "way": way_name(f.way), "rank": f.rank, "unit": f.unit.name() })).collect();
        let colours: Vec<Value> = self
            .foes
            .iter()
            .filter(|f| f.state == FoeState::Down)
            .take(t.hall_colours)
            .map(|f| {
                let by = f.by.and_then(|id| self.companies.iter().find(|c| c.id == id)).map(|c| c.name.clone());
                json!({ "name": f.name, "face": f.face, "lord": f.lord, "by": by })
            })
            .collect();
        let veterans: Vec<Value> = if self.phase == Phase::Won || self.phase == Phase::Lost {
            self.companies.iter().map(|c| json!({ "name": c.name, "face": c.face, "way": way_name(c.way), "rank": c.rank })).collect()
        } else {
            Vec::new()
        };
        let won = self.end.as_ref().is_some_and(|e| e.won);
        json!({ "campaign": self.campaign, "seed": self.seed, "won": won, "fallen": fallen, "colours": colours, "veterans": veterans })
    }
}

fn state_name(s: FoeState) -> &'static str {
    match s {
        FoeState::Waiting => "waiting",
        FoeState::Escaped => "escaped",
        FoeState::Down => "down",
    }
}
