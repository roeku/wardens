//! The muster (01-flow §3.4): bands of men under their villages' linen banners, each spear, shield, bow or horse,
//! raw or (30%) seasoned with 2 fewer men at rank 1; 3 more bands than banners. Commanders before the hall, 2 more
//! than banners, each with a way and the kind it suits; some veterans. Lift a commander and plant them at a band;
//! lifting stands one down, dropping one on a company swaps them. When every banner has its company the warband
//! falls in and sets out.

use super::names::{self, BROODLORDS, COMMANDERS, SALT_COMMANDER, SALT_VILLAGE, VILLAGES};
use super::{Band, Campaign, Commander, Company, Last, Phase, WAYS, suits};
use crate::contracts::P;
use crate::map::names::onset;
use crate::map::road::{HALL, MUSTER_X0, MUSTER_X1};
use crate::rng::{Rng, hash32, jitter};
use crate::units::Unit;

const SALT_SHUFFLE_KINDS: u32 = 0x6361_0030;
const SALT_SHUFFLE_WAYS: u32 = 0x6361_0031;
const SALT_KIND: u32 = 0x6361_0032;
const SALT_SEASONED: u32 = 0x6361_0033;
const SALT_VETERAN: u32 = 0x6361_0034;
const SALT_WAY_ROLL: u32 = 0x6361_0035;
/// The kinds a band may be.
const KINDS: [Unit; 4] = [Unit::Spear, Unit::Shield, Unit::Archer, Unit::Horse];
/// Commanders stand in a line before the hall, this far east of it and this far apart (chosen).
const COMMANDER_X: f64 = 4.0;
const COMMANDER_GAP: f64 = 2.0;
/// Bands wait in the meadows across the muster ground, this far from its east edge and this far apart (chosen).
const BAND_X: f64 = 7.0;
const BAND_GAP: f64 = 5.0;

/// A seeded shuffle.
pub(super) fn shuffle<T>(seed: u32, salt: u32, v: &mut [T]) {
    let mut r = Rng::new(hash32(seed, 0, salt));
    for i in (1..v.len()).rev() {
        let j = (r.next_u32() as usize) % (i + 1);
        v.swap(i, j);
    }
}

impl Campaign {
    /// The bands and commanders at the muster. The first four bands are one of each kind and the first four
    /// commanders one of each way (shuffled), so every muster offers every pairing; the rest are rolled.
    pub(super) fn muster_up(&mut self) {
        let t = self.tune.campaign.clone();
        let seed = self.seed;
        let n_bands = (self.banners + t.extra_bands) as usize;
        let mut kinds: Vec<Unit> = KINDS.to_vec();
        shuffle(seed, SALT_SHUFFLE_KINDS, &mut kinds);
        let (mut villages, mut village_sounds) = (Vec::<String>::new(), Vec::<String>::new());
        for k in 0..n_bands {
            let id = k as u32;
            let unit = kinds.get(k).copied().unwrap_or(KINDS[hash32(seed, id, SALT_KIND) as usize % KINDS.len()]);
            let seasoned = jitter(seed, id, SALT_SEASONED) < t.seasoned;
            let full = self.tune.unit_spec(unit).map(|s| s.men).unwrap_or(10);
            let men = if seasoned { full.saturating_sub(t.seasoned_fewer).max(1) } else { full };
            let village = names::pick(VILLAGES, seed, id, SALT_VILLAGE, &villages, &village_sounds, &[]);
            village_sounds.push(onset(&village));
            villages.push(village.clone());
            let y = HALL.y + (k as f64 - (n_bands as f64 - 1.0) / 2.0) * BAND_GAP;
            self.bands.push(Band {
                id,
                unit,
                men,
                seasoned,
                rank: if seasoned { t.seasoned_rank } else { 0 },
                village,
                commander: None,
                at: P::new(MUSTER_X1 - BAND_X, y.clamp(2.5, crate::map::road::H as f64 - 2.5)),
            });
        }
        let n_commanders = (self.banners + t.extra_commanders) as usize;
        let mut ways = WAYS.to_vec();
        shuffle(seed, SALT_SHUFFLE_WAYS, &mut ways);
        for k in 0..n_commanders {
            let id = self.person();
            let way = ways.get(k).copied().unwrap_or(WAYS[hash32(seed, id, SALT_WAY_ROLL) as usize % WAYS.len()]);
            let name = self.new_name(id);
            let y = HALL.y + (k as f64 - (n_commanders as f64 - 1.0) / 2.0) * COMMANDER_GAP;
            self.commanders.push(Commander {
                id,
                name,
                way,
                face: self.face_of(id),
                veteran: jitter(seed, id, SALT_VETERAN) < t.veteran,
                band: None,
                at: P::new(MUSTER_X0 + COMMANDER_X - 2.5, y),
            });
        }
    }

    /// A commander's name for person `id`: unlike every commander and broodlord already named, with a first sound
    /// none of the living has where the pool allows.
    pub(super) fn new_name(&self, id: u32) -> String {
        let mut taken: Vec<String> = self.commanders.iter().map(|c| c.name.clone()).collect();
        taken.extend(self.companies.iter().map(|c| c.name.clone()));
        taken.extend(self.fallen.iter().map(|f| f.name.clone()));
        let mut sounds: Vec<String> = self.commanders.iter().filter(|c| c.band.is_some() || self.phase == Phase::Muster).map(|c| onset(&c.name)).collect();
        sounds.extend(self.companies.iter().map(|c| onset(&c.name)));
        sounds.extend(self.foes.iter().map(|f| onset(&f.name)));
        let avoid: Vec<String> = self.foes.iter().map(|f| f.name.clone()).chain(self.places.iter().map(|p| p.name.clone())).collect();
        names::pick(COMMANDERS, self.seed, id, SALT_COMMANDER, &taken, &sounds, &avoid)
    }

    /// The broodlords' names, unlike the commanders'.
    pub(super) fn foe_name(&self, id: u32) -> String {
        let taken: Vec<String> = self.foes.iter().map(|f| f.name.clone()).collect();
        let mut sounds: Vec<String> = self.foes.iter().map(|f| onset(&f.name)).collect();
        sounds.extend(self.commanders.iter().map(|c| onset(&c.name)));
        let avoid: Vec<String> = self.commanders.iter().map(|c| c.name.clone()).collect();
        names::pick(BROODLORDS, self.seed, id, names::SALT_BROODLORD, &taken, &sounds, &avoid)
    }

    /// The rank a company under `commander` from `band` starts at: the band's, +1 if the way suits its kind, +1 for
    /// a veteran.
    pub fn planted_rank(&self, commander: &Commander, band: &Band) -> u8 {
        let t = &self.tune.campaign;
        let suited = if suits(commander.way) == band.unit { t.suited_rank } else { 0 };
        let veteran = if commander.veteran { t.veteran_rank } else { 0 };
        (band.rank + suited + veteran).min(t.max_rank)
    }

    /// Drops a commander on a band (contract §2 `plant`): a band that had one swaps them (the other goes to this
    /// one's old band, or stands down); a new company needs a free banner.
    pub fn plant(&mut self, commander: u32, band: u32) -> Result<(), String> {
        if self.phase != Phase::Muster {
            return Err(format!("no planting during '{}'", self.phase.name()));
        }
        let ci = self.commanders.iter().position(|c| c.id == commander).ok_or(format!("no commander {commander}"))?;
        let bi = self.bands.iter().position(|b| b.id == band).ok_or(format!("no band {band}"))?;
        let old = self.commanders[ci].band;
        let other = self.bands[bi].commander;
        if other == Some(commander) {
            return Ok(());
        }
        let planted = self.bands.iter().filter(|b| b.commander.is_some()).count() as u32;
        if other.is_none() && old.is_none() && planted >= self.banners {
            return Err(format!("every banner has its company ({} of {})", planted, self.banners));
        }
        if let Some(o) = other {
            let oi = self.commanders.iter().position(|c| c.id == o).expect("a band's commander exists");
            self.commanders[oi].band = old;
        }
        if let Some(ob) = old {
            let obi = self.bands.iter().position(|b| b.id == ob).expect("a commander's band exists");
            self.bands[obi].commander = other;
        }
        self.commanders[ci].band = Some(band);
        self.bands[bi].commander = Some(commander);
        Ok(())
    }

    /// Lifts a commander off his company (contract §2 `stand_down`).
    pub fn stand_down(&mut self, commander: u32) -> Result<(), String> {
        if self.phase != Phase::Muster {
            return Err(format!("no standing down during '{}'", self.phase.name()));
        }
        let ci = self.commanders.iter().position(|c| c.id == commander).ok_or(format!("no commander {commander}"))?;
        if let Some(b) = self.commanders[ci].band.take()
            && let Some(band) = self.bands.iter_mut().find(|x| x.id == b)
        {
            band.commander = None;
        }
        Ok(())
    }

    /// The debug hook's muster (01-flow §5 `autoMuster()`): every commander stood down, then banner by banner the
    /// best free pair is planted: a suited way first, then a seasoned band, a veteran, more men; ties by the lower
    /// ids.
    pub fn auto_muster(&mut self) -> Result<(), String> {
        if self.phase != Phase::Muster {
            return Err(format!("no muster during '{}'", self.phase.name()));
        }
        for c in self.commanders.iter_mut() {
            c.band = None;
        }
        for b in self.bands.iter_mut() {
            b.commander = None;
        }
        for _ in 0..self.banners {
            let mut best: Option<(u32, u32, u32)> = None;
            for c in self.commanders.iter().filter(|c| c.band.is_none()) {
                for b in self.bands.iter().filter(|b| b.commander.is_none()) {
                    let score = 1000 * u32::from(suits(c.way) == b.unit) + 100 * u32::from(b.seasoned) + 10 * u32::from(c.veteran) + b.men as u32;
                    if best.is_none_or(|(s, _, _)| score > s) {
                        best = Some((score, c.id, b.id));
                    }
                }
            }
            let Some((_, c, b)) = best else { break };
            self.plant(c, b)?;
        }
        Ok(())
    }

    /// The warband falls in: a company for every band with a commander, in band order.
    pub(super) fn fall_in(&mut self) {
        let mut planted: Vec<(Commander, Band)> = Vec::new();
        for b in &self.bands {
            if let Some(cid) = b.commander
                && let Some(c) = self.commanders.iter().find(|c| c.id == cid)
            {
                planted.push((c.clone(), b.clone()));
            }
        }
        for (c, b) in planted {
            let id = self.company_id();
            let rank = self.planted_rank(&c, &b);
            self.companies.push(Company {
                id,
                name: c.name.clone(),
                unit: b.unit,
                men: b.men,
                full: b.men,
                rank,
                way: c.way,
                face: c.face,
                freed: false,
                kills: 0,
                battles: 0,
                colours: Vec::new(),
                last: Last::default(),
                commander: c.id,
                veteran: c.veteran,
                village: b.village.clone(),
            });
        }
    }
}
