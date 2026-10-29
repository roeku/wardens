//! Garrisons (01-flow §4 "Garrison size"; 04-battle §7 "Difficulty"):
//! - **Kinds:** shield, spear, archer to start; +spear from step 2; +archer if dangerous; +horse from step 4;
//!   +shield at the keep. Each kind is a blight unit (`CampaignTune::blight`: spear → blight-men, shield → trolls,
//!   archer and horse → drakes; out/decisions-d5-campaign.md).
//! - **Size:** the garrison is worth `share · factor · W`: the share `0.80 + 0.075·step + 0.15·danger` of the
//!   warband's size W (its men × worth), scaled with a factor (the spec's 0.6; 0.9 against the blight, see
//!   `CampaignTune::warband_factor`). Each company is its unit's full count × `m`, the one factor that makes the
//!   garrison worth that.
//! - **Rank** `floor(step/3)`.
//! - **The ford** has no garrison: its raiders' waves keep `round(len·m)` companies each.

use super::{Campaign, Place, PlaceKind};
use crate::battle::Company;
use crate::contracts::Kind;
use crate::units::Unit;

impl Campaign {
    /// The garrison rule's kinds for a place.
    pub fn garrison_kinds(&self, p: &Place) -> Vec<Kind> {
        let t = &self.tune.campaign;
        let mut k = vec![Kind::Shield, Kind::Spear, Kind::Archer];
        if p.step >= t.spear_from {
            k.push(Kind::Spear);
        }
        if p.danger > 0 {
            k.push(Kind::Archer);
        }
        if p.step >= t.horse_from {
            k.push(Kind::Horse);
        }
        if p.kind == PlaceKind::Keep {
            k.push(Kind::Shield);
        }
        k
    }

    /// The blight's unit for a kind of the garrison rule.
    pub fn blight_unit(&self, k: Kind) -> Unit {
        let b = &self.tune.campaign.blight;
        match k {
            Kind::Shield => b.shield,
            Kind::Archer => b.archer,
            Kind::Horse => b.horse,
            _ => b.spear,
        }
    }

    /// The share of full size at a place: `0.80 + 0.075·step + 0.15·danger`.
    pub fn share(&self, p: &Place) -> f64 {
        let t = &self.tune.campaign;
        t.share[0] + t.share[1] * p.step as f64 + t.share[2] * p.danger as f64
    }

    /// Men × worth (rank 0) of companies of `units` at their full count.
    fn full_worth(&self, units: impl Iterator<Item = Unit>) -> f64 {
        units.map(|u| self.tune.unit_spec(u).map_or(0.0, |s| s.men as f64 * s.worth(&self.tune.rank, 0))).sum()
    }

    /// The garrison's units at full count, before scaling: the rule's kinds, or the ford's waves.
    fn garrison_units(&self, p: &Place) -> Vec<Unit> {
        match p.kind {
            PlaceKind::Ford => self.tune.places.ford.waves.iter().flatten().copied().collect(),
            PlaceKind::Camp => Vec::new(),
            _ => self.garrison_kinds(p).into_iter().map(|k| self.blight_unit(k)).collect(),
        }
    }

    /// What the garrison is worth (men × worth): the share of the warband's worth W scaled by `warband_factor`,
    /// `share · factor · W`.
    pub fn garrison_worth(&self, p: &Place) -> f64 {
        self.share(p) * self.tune.campaign.warband_factor * self.warband_worth()
    }

    /// The garrison's size factor `m` at a place: each company is its unit's full count × `m`, so the garrison is
    /// worth `garrison_worth`.
    pub fn garrison_share(&self, p: &Place) -> f64 {
        let full = self.full_worth(self.garrison_units(p).into_iter());
        if full > 0.0 { self.garrison_worth(p) / full } else { 0.0 }
    }

    pub fn garrison_rank(&self, p: &Place) -> u8 {
        (p.step / self.tune.campaign.rank_every.max(1)).min(self.tune.campaign.max_rank as u32) as u8
    }

    /// The garrison's companies at a place (none at a ford or a camp): unnamed blight companies, the broodlord
    /// commanding them all (D-14).
    pub fn garrison(&self, p: &Place) -> Vec<Company> {
        if !p.kind.held() {
            return Vec::new();
        }
        let m = self.garrison_share(p);
        let rank = self.garrison_rank(p);
        self.garrison_kinds(p)
            .into_iter()
            .map(|k| {
                let unit = self.blight_unit(k);
                let full = self.tune.unit_spec(unit).map_or(1, |s| s.men) as f64;
                let mut c = Company::of(unit, "");
                c.rank = rank;
                c.men = Some(((full * m).round() as u16).max(1));
                c
            })
            .collect()
    }

    /// The ford's raider waves for a place: each wave keeps `round(len·m)` companies (at least `wave_min`), cycling
    /// through its units if it grows.
    pub fn raider_waves(&self, p: &Place) -> Vec<Vec<Unit>> {
        let m = self.garrison_share(p);
        self.tune
            .places
            .ford
            .waves
            .iter()
            .map(|w| {
                if w.is_empty() {
                    return Vec::new();
                }
                let n = ((w.len() as f64 * m).round() as usize).max(self.tune.campaign.wave_min);
                (0..n).map(|k| w[k % w.len()]).collect()
            })
            .collect()
    }

    /// What holds a place, by unit: `(unit, men, companies)`, in the units' order.
    pub fn garrison_listing(&self, p: &Place) -> Vec<(Unit, u32, u32)> {
        let mut out: Vec<(Unit, u32, u32)> = Vec::new();
        let mut add = |u: Unit, men: u32| match out.iter_mut().find(|e| e.0 == u) {
            Some(e) => {
                e.1 += men;
                e.2 += 1;
            }
            None => out.push((u, men, 1)),
        };
        match p.kind {
            PlaceKind::Ford => {
                for w in self.raider_waves(p) {
                    for u in w {
                        add(u, self.tune.unit_spec(u).map_or(0, |s| s.men as u32));
                    }
                }
            }
            _ => {
                for c in self.garrison(p) {
                    add(c.unit, c.men.unwrap_or(0) as u32);
                }
            }
        }
        out.sort_by_key(|e| e.0);
        out
    }
}
