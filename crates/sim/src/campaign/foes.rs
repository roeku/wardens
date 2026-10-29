//! Enemy commanders (01-flow §4): eight broodlords plus the nest's lord. The broodlords are shuffled across the
//! current row and the next (a held place each: holdfasts and villages; the ford has raiders and the camp no one),
//! the lord at the keep. Broodlords left behind on a passed row go back to the queue; one who escaped a battle
//! returns first, a rank harder.
//!
//! A broodlord stands as his place's broodlord: the blight side's captain-kind commander (D-14), whose fall costs
//! every other blight company 25 morale and loses the battle (out/decisions-d5-campaign.md).

use super::muster::shuffle;
use super::{Campaign, Foe, FoeState, PlaceKind, SALT_FOE_FACE, WAYS, face};
use crate::rng::hash32;

const SALT_QUEUE: u32 = 0x6361_0040;
const SALT_FOE_WAY: u32 = 0x6361_0041;

impl Campaign {
    /// The eight broodlords and the lord, named, with ways and faces; the queue shuffled.
    pub(super) fn raise_foes(&mut self) {
        let n = self.tune.campaign.broodlords;
        for id in 0..=n {
            let name = self.foe_name(id);
            self.foes.push(Foe {
                id,
                name,
                way: WAYS[hash32(self.seed, id, SALT_FOE_WAY) as usize % WAYS.len()],
                rank: 0,
                face: face(self.seed, id, SALT_FOE_FACE),
                place: None,
                state: FoeState::Waiting,
                lord: id == n,
                met: false,
                by: None,
            });
        }
        let mut q: Vec<u32> = (0..n).collect();
        shuffle(self.seed, SALT_QUEUE, &mut q);
        self.queue = q;
    }

    /// Fills the held places of the current row and the next from the queue, in place order; the lord holds the
    /// keep.
    pub(super) fn place_foes(&mut self) {
        let (step, rows) = (self.step, self.tune.campaign.rows);
        for i in 0..self.places.len() {
            let p = &self.places[i];
            if p.done || p.foe.is_some() || !p.kind.held() {
                continue;
            }
            let id = p.id;
            let foe = if p.kind == PlaceKind::Keep {
                self.foes.iter().find(|f| f.lord && f.state != FoeState::Down).map(|f| f.id)
            } else if p.step < rows && (p.step == step || p.step == step + 1) && !self.queue.is_empty() {
                Some(self.queue.remove(0))
            } else {
                None
            };
            if let Some(f) = foe {
                self.places[i].foe = Some(f);
                let foe = &mut self.foes[f as usize];
                foe.place = Some(id);
                foe.state = FoeState::Waiting;
            }
        }
    }

    /// A broodlord left behind goes back to the queue, after any who escaped.
    pub(super) fn recall_foe(&mut self, f: u32) {
        let foe = &mut self.foes[f as usize];
        foe.place = None;
        if !foe.lord {
            self.queue.push(f);
        }
    }

    /// A broodlord who lived through a lost battle of his: a rank harder, first in the queue.
    pub(super) fn escape(&mut self, f: u32) {
        let (rank, max) = (self.tune.campaign.escaped_rank, self.tune.campaign.max_rank);
        let foe = &mut self.foes[f as usize];
        foe.rank = (foe.rank + rank).min(max);
        foe.state = FoeState::Escaped;
        foe.place = None;
        if !foe.lord {
            self.queue.insert(0, f);
        }
    }
}
