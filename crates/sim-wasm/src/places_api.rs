//! Places: structures, villages, the ford, the night and field works as the view draws them (day 4).
//! Its own `impl Battle` block, so each part of day 4 adds exports without touching the others' files.
//!
//! Per frame: `places_sync()` refills flat f32 records (sites, houses, the ford's groups, the lights, the works) in
//! buffers kept here; the view reads them through typed-array views at `places_ptr(which)` with
//! `places_len(which)` records of `places_stride(which)` floats (re-create a view when the pointer or
//! `memory.buffer` changes). Nothing allocates once the buffers have grown. `places_info()` is the static layout as
//! JSON (houses' footprints, the ford's routes, the wagons), read once.

use std::cell::RefCell;

use serde_json::json;
use sim::battle::{Light, LightKind, Order};
use sim::contracts::Work as WorkKind;
use sim::map::{MapKind, SiteKind};
use wasm_bindgen::prelude::*;

use crate::Battle;

/// Which buffer: the sites, the town's houses, the ford's groups, the night's lights, the field works.
pub const SITES: u32 = 0;
pub const HOUSES: u32 = 1;
pub const GROUPS: u32 = 2;
pub const LIGHTS: u32 = 3;
pub const WORKS: u32 = 4;

/// Floats per record. Sites: id, kind (0 keep, 1 town, 2 village, 3 shrine, 4 tower), x, y, owner (−1 none),
/// progress 0..1, capturing team (−1 none), spare. Houses: x, y, width, depth, state (0 standing, 1 burning,
/// 2 fallen, 3 doused), burnt 0..1, seconds in that state, people. Groups: squad (−1 before it comes), far ford,
/// done, saved, men on the field, x, y, running. Lights: x, y, reach (tiles), strength, kind (0 torch, 1 burning
/// house, 2 ruin, 3 fire), of (the torch-bearer's soldier, the house, the site; −1 the wagons). Works: id, kind
/// (0 stakes, 1 barricade, 2 bridge, 3 watchtower), team, x, y, face, built 0..1, hp share, razed, end a x, y, end b
/// x, y, length, depth, at work (a company building it now).
pub const STRIDES: [usize; 5] = [8, 8, 8, 6, 16];
/// The buffers in their order (`places_ptr`'s argument).
pub const WHICH: [u32; 5] = [SITES, HOUSES, GROUPS, LIGHTS, WORKS];

#[derive(Default)]
struct Bufs {
    data: [Vec<f32>; 5],
    lights: Vec<Light>,
}

thread_local! {
    static BUFS: RefCell<Bufs> = RefCell::new(Bufs::default());
}

fn site_kind(k: SiteKind) -> f32 {
    match k {
        SiteKind::Keep => 0.0,
        SiteKind::Town => 1.0,
        SiteKind::Village => 2.0,
        SiteKind::Shrine => 3.0,
        SiteKind::Tower => 4.0,
    }
}

fn team(t: Option<u8>) -> f32 {
    t.map_or(-1.0, |t| t as f32)
}

#[wasm_bindgen]
impl Battle {
    /// Refills the places buffers from the battle (once per frame, after `sync`). Returns the number of lights.
    pub fn places_sync(&self) -> u32 {
        let b = &self.inner;
        BUFS.with(|cell| {
            let bufs = &mut *cell.borrow_mut();
            let [sites, houses, groups, lights, works] = &mut bufs.data;
            sites.clear();
            for (s, st) in b.map.sites.iter().zip(&b.sites) {
                sites.extend_from_slice(&[s.id as f32, site_kind(s.kind), s.at.x as f32, s.at.y as f32, team(st.owner), st.progress as f32, team(st.by), 0.0]);
            }
            houses.clear();
            let burn_s = b.tune.places.town.burn_s;
            for h in &b.places.houses {
                let age = if h.since == u32::MAX { 0.0 } else { b.tick.saturating_sub(h.since) as f64 / 30.0 };
                houses.extend_from_slice(&[h.at.x as f32, h.at.y as f32, h.size.0 as f32, h.size.1 as f32, h.state as u32 as f32, h.burnt(b.tick, burn_s) as f32, age as f32, h.people as f32]);
            }
            groups.clear();
            if let Some(f) = &b.places.ford {
                for g in &f.groups {
                    let (men, at, run) = match g.squad {
                        Some(id) if !g.done => {
                            let s = &b.squads[id as usize];
                            let c = b.centre(id as usize);
                            (s.alive as f32, c, (s.spec.speed > b.tune.places.ford.walk) as u32 as f32)
                        }
                        _ => (0.0, f.entry, 0.0),
                    };
                    groups.extend_from_slice(&[g.squad.map_or(-1.0, |s| s as f32), g.far as u32 as f32, g.done as u32 as f32, g.saved as f32, men, at.x as f32, at.y as f32, run]);
                }
            }
            b.lights(&mut bufs.lights);
            lights.clear();
            for l in &bufs.lights {
                let kind = match l.kind {
                    LightKind::Torch => 0.0,
                    LightKind::House => 1.0,
                    LightKind::Ruin => 2.0,
                    LightKind::Fire => 3.0,
                };
                let of = if l.of == u32::MAX { -1.0 } else { l.of as f32 };
                lights.extend_from_slice(&[l.at.x as f32, l.at.y as f32, l.reach as f32, l.strength as f32, kind, of]);
            }
            works.clear();
            for w in &b.works {
                let kind = match w.kind {
                    WorkKind::Stakes => 0.0,
                    WorkKind::Barricade => 1.0,
                    WorkKind::Bridge => 2.0,
                    WorkKind::Watchtower => 3.0,
                };
                let at_work = b.squads.iter().any(|s| s.working && matches!(s.order, Order::Build { work, .. } if work == w.id));
                works.extend_from_slice(&[
                    w.id as f32,
                    kind,
                    w.team as f32,
                    w.at.x as f32,
                    w.at.y as f32,
                    w.face as f32,
                    w.built as f32,
                    if w.max_hp > 0.0 { (w.hp / w.max_hp).clamp(0.0, 1.0) as f32 } else { 0.0 },
                    w.razed as u32 as f32,
                    w.ends[0].x as f32,
                    w.ends[0].y as f32,
                    w.ends[1].x as f32,
                    w.ends[1].y as f32,
                    w.size[0] as f32,
                    w.size[1] as f32,
                    at_work as u32 as f32,
                ]);
            }
            (lights.len() / STRIDES[LIGHTS as usize]) as u32
        })
    }

    /// The address of a places buffer (`SITES` 0, `HOUSES` 1, `GROUPS` 2, `LIGHTS` 3, `WORKS` 4).
    pub fn places_ptr(&self, which: u32) -> usize {
        BUFS.with(|cell| cell.borrow().data.get(which as usize).map_or(0, |v| v.as_ptr() as usize))
    }

    /// Records in a places buffer after the last `places_sync`.
    pub fn places_len(&self, which: u32) -> u32 {
        BUFS.with(|cell| cell.borrow().data.get(which as usize).map_or(0, |v| (v.len() / STRIDES[which as usize]) as u32))
    }

    /// Floats per record of a places buffer.
    pub fn places_stride(&self, which: u32) -> u32 {
        WHICH.iter().position(|&w| w == which).map_or(0, |k| STRIDES[k] as u32)
    }

    /// How dark it is, 0..1 (02-look.md §3): easing in after nightfall, out after dawn. Fed to the CELL pass.
    pub fn night_level(&self) -> f64 {
        self.inner.night_level()
    }

    /// Seconds since nightfall (negative before it), for the torches the view lights in order.
    pub fn night_s(&self) -> f64 {
        match self.inner.places.nightfall {
            Some(nf) => (self.inner.tick as f64 - nf as f64) / 30.0,
            None => -1.0,
        }
    }

    /// Dev only (the shots): this battle again from tick 0, same seed, map and armies, under a tuning override
    /// (JSON, as `PROTO_TUNE`), e.g. `{"outcome":{"battle_s":100}}` so night falls while the town still burns. The map
    /// does not depend on the tuning, so the land drawn stays right.
    pub fn retune(&mut self, tune_json: &str) -> Result<(), JsError> {
        let over: serde_json::Value = serde_json::from_str(tune_json)?;
        let tune = sim::tune::Tune::with_override(&over).map_err(|e| JsError::new(&e))?;
        let b = &self.inner;
        let opts = sim::map::MapOpts { kind: b.map.kind, width: b.map.w };
        self.inner = sim::battle::Battle::new(b.seed, opts, &sim::battle::Setup::for_map(opts.kind), tune);
        Ok(())
    }

    /// The places' layout as JSON, read once: the map kind; the town's site and its houses' footprints and burn
    /// time; the ford's entry, exit, crossings, routes and wagons.
    pub fn places_info(&self) -> String {
        let b = &self.inner;
        let p = |q: sim::contracts::P| json!([q.x, q.y]);
        let kind = match b.map.kind {
            MapKind::Keep => "keep",
            MapKind::Town => "town",
            MapKind::Ford => "ford",
            MapKind::Field => "field",
            MapKind::Road => "road",
        };
        let houses: Vec<_> = b.places.houses.iter().map(|h| json!({ "at": p(h.at), "w": h.size.0, "d": h.size.1 })).collect();
        let ford = b.places.ford.as_ref().map(|f| {
            json!({
                "entry": p(f.entry),
                "exit": p(f.exit),
                "crossing": [p(f.crossing[0]), p(f.crossing[1])],
                "wagons": p(f.wagons),
                "routes": b.map.roads.iter().map(|r| r.iter().map(|&q| p(q)).collect::<Vec<_>>()).collect::<Vec<_>>(),
            })
        });
        json!({
            "kind": kind,
            "town": b.places.town,
            "houses": houses,
            "burn_s": b.tune.places.town.burn_s,
            "smoulder_s": b.tune.places.town.smoulder_s,
            "doused_s": b.tune.places.town.doused_s,
            "ford": ford,
            "torch": { "first_s": b.tune.places.night.torch_first_s, "step_s": b.tune.places.night.torch_step_s, "foe_s": b.tune.places.night.foe_torch_s },
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim::map::MapOpts;

    #[test]
    fn places_pack_sites_houses_groups_lights_and_works() {
        let town = Battle::wrap(sim::battle::Battle::new(3, MapOpts { kind: MapKind::Town, width: 48 }, &sim::battle::Setup::default(), Default::default()));
        let mut town = town;
        town.inner.run_to(30 * 30);
        let n = town.places_sync();
        let (sites, houses) = (town.places_len(SITES), town.places_len(HOUSES));
        assert_eq!(sites as usize, town.inner.map.sites.len());
        assert_eq!(houses, 5);
        let burning = BUFS.with(|c| c.borrow().data[HOUSES as usize].chunks(8).filter(|h| h[4] == 1.0).count());
        assert_eq!(burning, 1, "the first house burns from 22 s");
        let info: serde_json::Value = serde_json::from_str(&town.places_info()).unwrap();
        assert_eq!(info["kind"], "town");
        let mut ford = Battle::wrap(sim::battle::Battle::new(5, MapOpts { kind: MapKind::Ford, width: 48 }, &sim::battle::Setup::ford(), Default::default()));
        ford.inner.run_to(40 * 30);
        ford.places_sync();
        let groups = ford.places_len(GROUPS);
        let came = BUFS.with(|c| c.borrow().data[GROUPS as usize].chunks(8).filter(|g| g[0] >= 0.0).count());
        assert_eq!((groups, came), (4, 2), "two of four groups have come by 40 s");
        let info: serde_json::Value = serde_json::from_str(&ford.places_info()).unwrap();
        assert!(info["ford"]["wagons"].is_array());
        println!("places: town {sites} sites, {houses} houses (1 burning), {n} lights; ford {groups} groups ({came} come), {} lights", ford.places_len(LIGHTS));
    }
}
