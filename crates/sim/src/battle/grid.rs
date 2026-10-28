//! The neighbour grid (04-battle.md §1 step 1): living soldiers sorted into 1-tile cells by a counting sort, with
//! a per-cell bitmask of the teams present. Rebuilt every tick; nothing allocates once it has grown.

use super::{Battle, SquadState};
use crate::contracts::P;

#[derive(Clone, Debug, Default)]
pub(super) struct Grid {
    w: usize,
    h: usize,
    /// `start[c]..start[c+1]` indexes `items` for cell `c`.
    start: Vec<u32>,
    items: Vec<u32>,
    teams: Vec<u8>,
    fill: Vec<u32>,
}

impl Grid {
    pub(super) fn new(w: usize, h: usize) -> Grid {
        Grid { w, h, start: vec![0; w * h + 1], items: Vec::new(), teams: vec![0; w * h], fill: vec![0; w * h] }
    }

    fn cell(&self, p: P) -> usize {
        let x = (p.x.floor() as i64).clamp(0, self.w as i64 - 1) as usize;
        let y = (p.y.floor() as i64).clamp(0, self.h as i64 - 1) as usize;
        y * self.w + x
    }

    /// Calls `f` with every soldier in the cells that overlap the square of half-side `r` round `p`, cell by
    /// cell from the north-west, in id order within a cell.
    pub(super) fn visit(&self, p: P, r: f64, mut f: impl FnMut(usize)) {
        let x0 = ((p.x - r).floor() as i64).max(0) as usize;
        let y0 = ((p.y - r).floor() as i64).max(0) as usize;
        let x1 = ((p.x + r).floor() as i64).min(self.w as i64 - 1);
        let y1 = ((p.y + r).floor() as i64).min(self.h as i64 - 1);
        if x1 < 0 || y1 < 0 {
            return;
        }
        for y in y0..=y1 as usize {
            for x in x0..=x1 as usize {
                let c = y * self.w + x;
                for &k in &self.items[self.start[c] as usize..self.start[c + 1] as usize] {
                    f(k as usize);
                }
            }
        }
    }

    /// Whether any soldier of a team other than `team` stands in the cells round `p` within `r`.
    pub(super) fn foes_near(&self, p: P, r: f64, team: u8) -> bool {
        let mask = !(1u8 << team);
        let x0 = ((p.x - r).floor() as i64).max(0) as usize;
        let y0 = ((p.y - r).floor() as i64).max(0) as usize;
        let x1 = ((p.x + r).floor() as i64).min(self.w as i64 - 1);
        let y1 = ((p.y + r).floor() as i64).min(self.h as i64 - 1);
        if x1 < 0 || y1 < 0 {
            return false;
        }
        (y0..=y1 as usize).any(|y| (x0..=x1 as usize).any(|x| self.teams[y * self.w + x] & mask != 0))
    }
}

impl Battle {
    /// Step 1: the counting sort of the living into cells.
    pub(super) fn rebucket(&mut self) {
        let g = &mut self.grid;
        g.fill.iter_mut().for_each(|c| *c = 0);
        g.teams.iter_mut().for_each(|t| *t = 0);
        let live = |k: usize| {
            let m = &self.soldiers[k];
            m.alive && !matches!(self.squads[m.squad as usize].state, SquadState::Fled)
        };
        let mut count = 0;
        for k in 0..self.soldiers.len() {
            if live(k) {
                let c = g.cell(self.soldiers[k].pos());
                g.fill[c] += 1;
                g.teams[c] |= 1 << (self.squads[self.soldiers[k].squad as usize].team & 7);
                count += 1;
            }
        }
        let mut at = 0u32;
        for c in 0..g.fill.len() {
            g.start[c] = at;
            at += g.fill[c];
            g.fill[c] = g.start[c];
        }
        let n = g.fill.len();
        g.start[n] = at;
        g.items.resize(count, 0);
        for k in 0..self.soldiers.len() {
            if live(k) {
                let c = g.cell(self.soldiers[k].pos());
                g.items[g.fill[c] as usize] = k as u32;
                g.fill[c] += 1;
            }
        }
    }
}
