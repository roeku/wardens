//! The campaign's WASM face (docs/engine/contracts/campaign.md §2–§4): the `Campaign` object the screens drive
//! between battles, the battles it makes (with the blight's bot already set on team 1), and `Battle.custom` for the
//! war table. Every call returns or throws; nothing here keeps state of its own.

use sim::campaign::{Campaign as Sim, Opts};
use sim::tune::Tune;
use wasm_bindgen::prelude::*;

use crate::{Battle, compat};

/// One campaign: the road, the muster, the warband, the broodlords, and the end's chronicle and Hall data.
#[wasm_bindgen]
pub struct Campaign {
    inner: Sim,
}

fn err(e: String) -> JsError {
    JsError::new(&e)
}

/// A battle made by the campaign or the war table, its enemy's bot set on team 1.
fn fought(b: sim::battle::Battle, enemy: Option<sim::bots::BotKind>) -> Result<Battle, JsError> {
    let mut w = Battle::wrap(b);
    if let Some(k) = enemy {
        w.bots[1] = Some(compat::bot(&k.name(), 1).map_err(err)?);
    }
    Ok(w)
}

#[wasm_bindgen]
impl Campaign {
    /// A new campaign: `opts_json` is `{campaign: "warden", banners: 4}` (both optional).
    pub fn create(seed: u32, opts_json: &str) -> Result<Campaign, JsError> {
        let opts: Opts = if opts_json.trim().is_empty() { Opts::default() } else { serde_json::from_str(opts_json)? };
        Ok(Campaign { inner: Sim::create(seed, &opts, Tune::default()) })
    }

    /// A saved campaign; throws on a version mismatch (discard the save, 01-flow §5).
    pub fn load(save_json: &str) -> Result<Campaign, JsError> {
        Ok(Campaign { inner: Sim::load(save_json, Tune::default()).map_err(err)? })
    }

    /// The whole campaign as JSON, only between battles; throws during 'battle'.
    pub fn save(&self) -> Result<String, JsError> {
        self.inner.save().map_err(err)
    }

    /// The state (contract §3).
    pub fn state_json(&self) -> String {
        self.inner.state().to_string()
    }

    /// The muster: drops a commander on a band; swaps if the band had one.
    pub fn plant(&mut self, commander: u32, band: u32) -> Result<(), JsError> {
        self.inner.plant(commander, band).map_err(err)
    }

    /// The muster: lifts a commander off his company.
    pub fn stand_down(&mut self, commander: u32) -> Result<(), JsError> {
        self.inner.stand_down(commander).map_err(err)
    }

    /// The debug hook's muster: every banner given its best company.
    pub fn auto_muster(&mut self) -> Result<(), JsError> {
        self.inner.auto_muster().map_err(err)
    }

    /// 'muster' | 'map' → 'march' toward a reachable place; throws for any other.
    pub fn set_out(&mut self, place: u32) -> Result<(), JsError> {
        self.inner.set_out(place).map_err(err)
    }

    /// The peaceful battle on the road map: only team 0, the warband at its place (at the muster, the captain and
    /// every band on the muster ground). Squad 0 is the captain; squad k+1 is company k (band k at the muster).
    pub fn road_battle(&self) -> Battle {
        Battle::wrap(self.inner.road_battle())
    }

    /// 'march' → 'battle', or 'camp' at a camp (the wounded mend at once).
    pub fn arrive(&mut self) -> Result<(), JsError> {
        self.inner.arrive().map_err(err)
    }

    /// The battle at the current place, from its start, seed `hash32(seed, step, place)`, with the blight's bot
    /// (garrison, or raiders at the ford) already playing team 1. Squad 0 is the captain, squad k+1 company k.
    pub fn battle(&self) -> Result<Battle, JsError> {
        let f = self.inner.battle().map_err(err)?;
        fought(f.battle, f.enemy)
    }

    /// Applies a finished battle (the one `battle()` made); returns the tally (contract §4).
    pub fn finish(&mut self, battle: &Battle) -> Result<String, JsError> {
        let t = self.inner.finish(&battle.inner).map_err(err)?;
        Ok(serde_json::to_string(&t)?)
    }

    /// Camp: +1 rank for one company, once per camp.
    pub fn honour(&mut self, company: u32) -> Result<(), JsError> {
        self.inner.honour(company).map_err(err)
    }

    /// 'camp' → 'map'.
    pub fn break_camp(&mut self) -> Result<(), JsError> {
        self.inner.break_camp().map_err(err)
    }

    /// The chronicle (contract §3 `chronicle`), as it stands.
    pub fn chronicle_json(&self) -> String {
        self.inner.chronicle().to_string()
    }

    /// What this campaign adds to the Hall (contract §3 `hall`), as it stands.
    pub fn hall_json(&self) -> String {
        self.inner.hall().to_string()
    }
}

#[wasm_bindgen]
impl Battle {
    /// The war table's battle (01-flow §3.3): `{kind: field|night|keep|hold|village|ford, size: 4|6|9, strength:
    /// easy|fair|hard, land}`, with the enemy's bot already playing team 1.
    pub fn custom(seed: u32, json: &str) -> Result<Battle, JsError> {
        let c = sim::campaign::custom::custom(seed, json, &Tune::default()).map_err(err)?;
        fought(sim::battle::Battle::new(seed, c.opts, &c.setup, c.tune), Some(c.enemy))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_campaign_api_walks_a_muster_to_a_battle() {
        let mut c = Campaign::create(7, r#"{"banners":4}"#).unwrap();
        let s: serde_json::Value = serde_json::from_str(&c.state_json()).unwrap();
        assert_eq!(s["phase"], "muster");
        assert_eq!(s["muster"]["bands"].as_array().unwrap().len(), 7);
        assert_eq!(s["muster"]["commanders"].as_array().unwrap().len(), 6);
        assert_eq!(s["road"]["places"].as_array().unwrap().len(), 16);
        let road = c.road_battle();
        assert_eq!((road.inner.map.w, road.inner.squads.len()), (119, 8));
        c.auto_muster().unwrap();
        let first = c.inner.reachable()[0];
        c.set_out(first).unwrap();
        c.arrive().unwrap();
        let b = c.battle().unwrap();
        assert!(b.bots[1].is_some());
        assert!(c.inner.save().is_err(), "no saving in battle");
        let custom = Battle::custom(3, r#"{"kind":"village","size":6,"strength":"hard","land":"any"}"#).unwrap();
        assert_eq!(custom.inner.map.kind, sim::map::MapKind::Town);
        println!("campaign api: muster of 7 bands and 6 commanders, 16 places, a road of 119x40 with 8 squads, a battle at place {first} with its bot; custom village of {} squads", custom.inner.squads.len());
    }
}
