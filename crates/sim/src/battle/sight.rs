//! Step 11, sight (03-land.md §8): one byte per tile per team, 0 never seen, 1 seen before, 2 in sight. Every 8
//! ticks every 2 is demoted to 1, then circles of sight are stamped: each squad
//! `(6.5 + hillSight)·(0.6 at night) + min(spread, 3)`, owned towers 9 and other sites 4, plus hillSight, with
//! `hillSight = min(3, height·1.5)`; burning houses light radius 4, and at night each side's torches give its companies
//! away within their spread + 0.8 (places.rs).

use super::Battle;
use crate::contracts::P;
use crate::map::SiteKind;

impl Battle {
    pub(super) fn update_sight(&mut self) {
        let t = self.tune.sight.clone();
        let night = if self.night { t.night } else { 1.0 };
        for team in 0..2u8 {
            let mut circles: Vec<(P, f64)> = Vec::new();
            for (i, s) in self.squads.iter().enumerate() {
                if s.team != team || !s.on_field() || s.alive == 0 {
                    continue;
                }
                let c = self.centre(i);
                let hill = (self.height(c) * t.hill_k).min(t.hill_cap);
                circles.push((c, (t.base + hill + self.work_bonus(c, team, "sight")) * night + self.spread(i).min(t.spread_cap)));
            }
            for (site, st) in self.map.sites.iter().zip(&self.sites) {
                if st.owner == Some(team) {
                    let hill = (self.height(site.at) * t.hill_k).min(t.hill_cap);
                    let r = if site.kind == SiteKind::Tower { t.tower } else { t.site };
                    circles.push((site.at, r + hill));
                }
            }
            // Burning houses, and the other side's torches at night (places.rs).
            self.place_sight(team, &mut circles);
            let (w, h) = (self.map.w as i32, self.map.h as i32);
            let fog = &mut self.fog[team as usize];
            for v in fog.iter_mut() {
                if *v == 2 {
                    *v = 1;
                }
            }
            for (c, r) in circles {
                let (x0, x1) = (((c.x - r).floor() as i32).max(0), ((c.x + r).ceil() as i32).min(w - 1));
                let (y0, y1) = (((c.y - r).floor() as i32).max(0), ((c.y + r).ceil() as i32).min(h - 1));
                for y in y0..=y1 {
                    for x in x0..=x1 {
                        if P::new(x as f64 + 0.5, y as f64 + 0.5).dist(c) <= r {
                            fog[(y * w + x) as usize] = 2;
                        }
                    }
                }
            }
        }
    }
}
