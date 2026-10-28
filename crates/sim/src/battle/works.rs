//! Field works (docs/spec/08-orders.md §7): stakes, barricades, bridges and watchtowers, laid out by an order,
//! built over `work_s` seconds by a company that cannot fight while it works (an attack interrupts it), and torn
//! down by foes who reach them. Works are data (`tune::WorksTune`): `{work_s, footprint, hp, mods, blocks}`.
//!
//! Effects, once built:
//! - **stakes:** a charge into a man behind them loses its bonus and takes the stakes' `charge_taken` mod (×0.4);
//! - **barricade:** its tiles block movement; arrows from in front at men behind it take its `arrow_taken` mod;
//! - **bridge:** its water tiles become a crossing that A* and the men use;
//! - **watchtower:** a company manning it sees and (ranged) shoots further by its `sight` and `range` mods.

use super::anchor::Facing;
use super::orders::Refused;
use super::{Battle, DT, Order, SquadState};
use crate::contracts::{P, Team, Work as WorkKind};
use crate::map::{Tile, path};
use crate::tune::WorkSpec;

/// A field work on the field (08-orders.md §7). The view draws `Battle.works`: `built` rises from 0 to 1 as it is
/// built; a razed work stays in the list, torn down.
#[derive(Clone, Debug, PartialEq)]
pub struct Work {
    pub id: u16,
    pub kind: WorkKind,
    pub team: Team,
    /// The centre of its footprint.
    pub at: P,
    /// The way its front faces (toward the enemy); a bridge's crossing runs along it.
    pub face: f64,
    /// 0..1 built.
    pub built: f64,
    pub hp: f64,
    pub max_hp: f64,
    /// Torn down: no longer stands, its tiles given back.
    pub razed: bool,
    /// The tiles it changes once built (a barricade's become rock, a bridge's water road), each with the tile it
    /// had.
    pub tiles: Vec<(usize, Tile)>,
    /// A bridge's landings on either bank (the footprint's ends for the others).
    pub ends: [P; 2],
    /// Along the line, and across it.
    pub size: [f64; 2],
}

impl Work {
    /// Built and not torn down: its effects hold.
    pub fn standing(&self) -> bool {
        self.built >= 1.0 && !self.razed
    }

    /// `p` in the work's frame: (ahead of its centre along its face, to its left).
    pub fn local(&self, p: P) -> (f64, f64) {
        let f = P::from_angle(self.face);
        let (dx, dy) = (p.x - self.at.x, p.y - self.at.y);
        (dx * f.x + dy * f.y, dx * f.y - dy * f.x)
    }

    /// The distance from `p` to the work's footprint (0 inside it).
    pub fn reach_of(&self, p: P) -> f64 {
        let (a, l) = self.local(p);
        let (ha, hl) = (self.size[1] / 2.0, self.size[0] / 2.0);
        let (da, dl) = ((a.abs() - ha).max(0.0), (l.abs() - hl).max(0.0));
        (da * da + dl * dl).sqrt()
    }
}

/// A bridge's water tiles (each with the tile it was), its two landings, and its centre.
type Crossing = (Vec<(usize, Tile)>, [P; 2], P);

impl Battle {
    fn work_spec(&self, kind: WorkKind) -> &WorkSpec {
        self.tune.works.get(kind)
    }

    /// Lays out a work for company `i` to build (or finds the same work, unfinished, to help with): checks the
    /// ground, works out its tiles and where the company stands to build. Returns the work's id and the spot.
    pub(super) fn lay_work(&mut self, team: Team, i: usize, kind: WorkKind, at: P, face: f64) -> Result<(u16, P), Refused> {
        if !at.x.is_finite() || !at.y.is_finite() || !face.is_finite() {
            return Err((self.here(team), "build: not a place".into()));
        }
        let m = self.tune.movement.edge_margin;
        if at.x < m || at.y < m || at.x > self.map.wf() - m || at.y > self.map.hf() - m {
            return Err((at, "build: off the field".into()));
        }
        // Helping: the same kind, ours, unfinished and standing within a tile.
        if let Some(w) = self.works.iter().find(|w| w.kind == kind && w.team == team && !w.razed && w.built < 1.0 && w.at.dist(at) <= 1.0) {
            let (id, w) = (w.id, w.clone());
            let spot = self.build_spot(&w, self.centre(i));
            return Ok((id, spot));
        }
        if self.works.iter().any(|w| !w.razed && w.at.dist(at) < 1.0) {
            return Err((at, "build: another work stands there".into()));
        }
        let spec = self.work_spec(kind).clone();
        let mut work = Work {
            id: self.works.len() as u16,
            kind,
            team,
            at,
            face,
            built: 0.0,
            hp: spec.hp,
            max_hp: spec.hp,
            razed: false,
            tiles: Vec::new(),
            ends: [at.offset(face, -spec.footprint[1] / 2.0, 0.0), at.offset(face, spec.footprint[1] / 2.0, 0.0)],
            size: spec.footprint,
        };
        if kind == WorkKind::Bridge {
            let (tiles, ends, centre) = self.bridge_tiles(at, face, &spec).map_err(|why| (at, why))?;
            work.tiles = tiles;
            work.ends = ends;
            work.at = centre;
            work.size = [spec.footprint[0], ends[0].dist(ends[1])];
        } else {
            if !self.map.passable(at) {
                return Err((at, "build: not on open ground".into()));
            }
            if spec.blocks {
                work.tiles = self.footprint_tiles(&work);
                if work.tiles.iter().any(|&(_, t)| !t.passable()) {
                    return Err((at, "build: the ground is blocked".into()));
                }
            }
        }
        let spot = self.build_spot(&work, self.centre(i));
        if path::astar(&self.map, self.open_near(self.centre(i)), spot).is_none() {
            return Err((spot, "build: unreachable".into()));
        }
        let id = work.id;
        self.works.push(work);
        Ok((id, spot))
    }

    /// The tiles whose centres lie inside a work's footprint (at least the tile under its centre).
    fn footprint_tiles(&self, w: &Work) -> Vec<(usize, Tile)> {
        let r = (w.size[0].max(w.size[1]) / 2.0).ceil() as i32 + 1;
        let (cx, cy) = (w.at.x.floor() as i32, w.at.y.floor() as i32);
        let mut out = Vec::new();
        for y in cy - r..=cy + r {
            for x in cx - r..=cx + r {
                let Some(i) = self.map.idx(x, y) else { continue };
                let (a, l) = w.local(P::new(x as f64 + 0.5, y as f64 + 0.5));
                if a.abs() <= w.size[1] / 2.0 + 1e-9 && l.abs() <= w.size[0] / 2.0 + 1e-9 {
                    out.push((i, self.map.tiles[i]));
                }
            }
        }
        if out.is_empty()
            && let Some(i) = self.map.idx(cx, cy)
        {
            out.push((i, self.map.tiles[i]));
        }
        out
    }

    /// A bridge across the water at `at` along `face`: the water tiles of the crossing (`footprint[0]` lines
    /// wide), its two landings, and its centre. Refused where there is no water within a tile and a half, or the
    /// water is wider than `footprint[1]`.
    fn bridge_tiles(&self, at: P, face: f64, spec: &WorkSpec) -> Result<Crossing, String> {
        const STEP: f64 = 0.25;
        let water = |p: P| self.map.tile_at(p) == Tile::Water;
        // The water nearest `at` along the crossing.
        let mut c = None;
        for k in 0..=6 {
            for t in [k as f64 * STEP, -(k as f64) * STEP] {
                let p = at.offset(face, t, 0.0);
                if c.is_none() && water(p) {
                    c = Some(p);
                }
            }
        }
        let c = c.ok_or("build: no water to bridge here")?;
        let half = spec.footprint[1] / 2.0;
        // Out along the crossing each way to the first dry ground.
        let bank = |sign: f64| -> Option<f64> {
            let mut t = 0.0;
            while t <= spec.footprint[1] {
                if self.map.tile_at(c.offset(face, sign * t, 0.0)).passable() {
                    return Some(t);
                }
                t += STEP;
            }
            None
        };
        let (Some(a), Some(b)) = (bank(-1.0), bank(1.0)) else { return Err("build: the water is too wide to bridge".into()) };
        if a + b > spec.footprint[1] + 1e-9 || a > half * 2.0 {
            return Err("build: the water is too wide to bridge".into());
        }
        let ends = [c.offset(face, -a, 0.0), c.offset(face, b, 0.0)];
        let lines = spec.footprint[0].round().max(1.0) as i32;
        let mut tiles: Vec<(usize, Tile)> = Vec::new();
        for k in 0..lines {
            let lateral = k as f64 - (lines as f64 - 1.0) / 2.0;
            let mut t = -a;
            while t <= b {
                let p = c.offset(face, t, lateral);
                if let Some(i) = self.map.idx(p.x.floor() as i32, p.y.floor() as i32)
                    && self.map.tiles[i] == Tile::Water
                    && !tiles.iter().any(|&(j, _)| j == i)
                {
                    tiles.push((i, Tile::Water));
                }
                t += STEP;
            }
        }
        tiles.sort_unstable_by_key(|&(i, _)| i);
        let centre = P::new((ends[0].x + ends[1].x) / 2.0, (ends[0].y + ends[1].y) / 2.0);
        Ok((tiles, ends, centre))
    }

    /// Where a company coming from `from` stands to build: `stand_off` behind the work's back edge, or beyond the
    /// bridge's nearer landing.
    fn build_spot(&self, w: &Work, from: P) -> P {
        let so = self.tune.works.stand_off;
        let p = if w.kind == WorkKind::Bridge {
            let (near, far) = if w.ends[0].dist(from) <= w.ends[1].dist(from) { (w.ends[0], w.ends[1]) } else { (w.ends[1], w.ends[0]) };
            let d = near.dist(far).max(1e-9);
            P::new(near.x + (near.x - far.x) / d * so, near.y + (near.y - far.y) / d * so)
        } else {
            w.at.offset(w.face, -(w.size[1] / 2.0 + so), 0.0)
        };
        self.open_near(p)
    }

    /// Step 2 for a company building work `id` from `spot`: it walks there, then works, facing the work's front.
    /// It cannot fight while working; a hit on any of its men interrupts it (it holds where it stands). When the
    /// work is built its effects begin and the order is done.
    pub(super) fn build_step(&mut self, i: usize, id: u16, spot: P, speed: f64) {
        let Some(w) = self.works.get(id as usize).filter(|w| !w.razed).cloned() else {
            self.arrive(i, None);
            return;
        };
        if w.built >= 1.0 {
            self.arrive(i, Some(w.face));
            return;
        }
        let here = P::new(self.squads[i].x, self.squads[i].y);
        if here.dist(spot) > self.tune.works.build_at {
            self.squads[i].working = false;
            self.walk(i, spot, speed, true, Facing::Step);
            self.squads[i].state = SquadState::Marching;
            return;
        }
        let hit = self.squads[i].soldiers.iter().any(|&k| {
            let m = &self.soldiers[k];
            m.alive && m.hit_at != crate::contracts::Tick::MAX && m.hit_at + 1 >= self.tick
        });
        if hit {
            // An attack interrupts the work: the company stands and fights; the work keeps what was built.
            self.tally.interrupts += 1;
            self.set_order(i, Order::Hold { face: None }, None);
            self.squads[i].state = SquadState::Idle;
            return;
        }
        let rate = self.turn_rate(i);
        let s = &mut self.squads[i];
        s.working = true;
        s.state = SquadState::Idle;
        s.path.clear();
        s.facing = crate::math::turn(s.facing, w.face, rate * DT);
        let work_s = self.work_spec(w.kind).work_s.max(DT);
        let wk = &mut self.works[id as usize];
        wk.built = (wk.built + DT / work_s).min(1.0);
        if wk.built >= 1.0 {
            self.finish_work(id as usize);
            self.arrive(i, Some(w.face));
        }
    }

    /// A work is built: its tiles change (a barricade's block, a bridge's cross the water).
    fn finish_work(&mut self, w: usize) {
        self.tally.built += 1;
        let (kind, tiles) = (self.works[w].kind, self.works[w].tiles.clone());
        let blocks = self.work_spec(kind).blocks;
        for (i, _) in tiles {
            if kind == WorkKind::Bridge {
                self.map.tiles[i] = Tile::Road;
            } else if blocks {
                self.map.tiles[i] = Tile::Rock;
            }
        }
        self.works[w].built = 1.0;
    }

    /// A work is torn down: it stands no more and its tiles are given back.
    fn raze(&mut self, w: usize) {
        self.tally.razed += 1;
        let work = &mut self.works[w];
        work.razed = true;
        work.hp = 0.0;
        let built = work.built >= 1.0;
        let tiles = work.tiles.clone();
        if built {
            for (i, t) in tiles {
                self.map.tiles[i] = t;
            }
        }
    }

    /// Tick step 4b (08-orders.md §7 "Enemy response"): every foe man standing in reach of a work with no foe of
    /// his own to strike tears at it, `damage × raze` per blow at his interval; at 0 hp it falls.
    pub(super) fn raze_works(&mut self) {
        if self.works.is_empty() {
            return;
        }
        let (c, mv, raze) = (self.tune.combat.clone(), self.tune.movement.clone(), self.tune.works.raze);
        for w in 0..self.works.len() {
            let work = &self.works[w];
            if work.razed {
                continue;
            }
            let r = work.size[0].max(work.size[1]) / 2.0 + c.reach + self.max_radius;
            let mut harm = 0.0;
            self.grid.visit(work.at, r, |k| {
                let m = &self.soldiers[k];
                let s = &self.squads[m.squad as usize];
                if !m.alive || s.team == work.team || !s.standing() || m.target.is_some() || s.working || s.leader == Some(k) {
                    return;
                }
                if work.reach_of(m.pos()) - (s.spec.radius - mv.base_radius) <= c.reach {
                    harm += s.spec.damage * raze * DT / s.spec.interval.max(DT);
                }
            });
            if harm > 0.0 {
                self.tally.raze_harm += harm;
                self.works[w].hp -= harm;
                if self.works[w].hp <= 0.0 {
                    self.raze(w);
                }
            }
        }
    }

    /// Stakes (08-orders.md §7) shielding a man of `team` at `victim` from a charge by a man at `from`: he stands
    /// among or up to `cover_behind` behind standing stakes of his side, and the charge comes from in front.
    pub(super) fn work_stakes(&self, from: P, victim: P, team: Team) -> Option<&WorkSpec> {
        let cover = self.tune.works.cover_behind;
        self.works.iter().filter(|w| w.kind == WorkKind::Stakes && w.team == team && w.standing()).find_map(|w| {
            let (va, vl) = w.local(victim);
            let (fa, _) = w.local(from);
            (vl.abs() <= w.size[0] / 2.0 + 0.5 && va <= w.size[1] / 2.0 && va >= -cover && fa > va).then(|| self.work_spec(w.kind))
        })
    }

    /// Cover from barricades against an arrow from `from` at a man of `team` at `to`: he stands up to
    /// `cover_behind` behind a standing barricade of his side, and the arrow comes from in front of it. The
    /// barricade's `arrow_taken` mods multiply the harm.
    pub(super) fn work_cover(&self, from: P, to: P, team: Team) -> f64 {
        let cover = self.tune.works.cover_behind;
        let mut k = 1.0;
        for w in self.works.iter().filter(|w| w.kind == WorkKind::Barricade && w.team == team && w.standing()) {
            let (ta, tl) = w.local(to);
            let (fa, _) = w.local(from);
            if tl.abs() <= w.size[0] / 2.0 + 0.5 && ta <= 0.0 && ta >= -(w.size[1] / 2.0 + cover) && fa > w.size[1] / 2.0 {
                k = self.work_spec(w.kind).modded("arrow_taken", k);
            }
        }
        k
    }

    /// A manned watchtower at `p` for `team` (within `man_r` of a standing tower of its side): its mod named
    /// `path` (`sight`, `range`) added to 0, the best tower counting.
    pub(super) fn work_bonus(&self, p: P, team: Team, path: &str) -> f64 {
        if self.works.is_empty() {
            return 0.0;
        }
        let r = self.tune.works.man_r;
        self.works
            .iter()
            .filter(|w| w.kind == WorkKind::Watchtower && w.team == team && w.standing() && w.at.dist(p) <= r)
            .map(|w| self.work_spec(w.kind).modded(path, 0.0))
            .fold(0.0, f64::max)
    }
}
