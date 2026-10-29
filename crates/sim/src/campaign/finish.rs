//! The aftermath of a battle (contract §4 `finish`; 01-flow §4):
//! - **Losses:** each company keeps the men who lived (those who fled with a routing company live too).
//! - **Commanders:** a commander who falls breaks his company: it is no more. After a won battle, each fallen
//!   commander was only wounded with an even chance and returns. The survivors of a broken company follow an heir
//!   as a new company when they are at least 4 and there is room (at most 5 companies); otherwise they fill the
//!   emptiest ranks, and any left over go home.
//! - **Ranks:** a company gains a rank as its kills pass 6, 18 and 36; a company of the freed gains one for each
//!   battle survived and wears the colours (joins the line) at rank 2. Ranks run 0–3.
//! - **The freed** (a village taken) found a company under a new commander if there is room and they are at least
//!   4; otherwise they fill the emptiest ranks.
//! - **The place:** won, it is done and the warband stands there; its row is passed (villages passed by burn out).
//!   Lost, the warband falls back to where it came from and the place's danger rises by 1.
//! - **Its broodlord:** brought down (his colours hang from the company nearest where he fell), or, if the battle
//!   was won without it, escaped: back first, a rank harder.
//! - **The end:** the keep taken, the captain fallen, or the warband gone.

use serde::{Deserialize, Serialize};

use super::{Campaign, Company, End, Fallen, FoeState, Last, Phase, PlaceKind};
use crate::battle::{Battle, HouseState};
use crate::contracts::{Kind, Tick};
use crate::rng::jitter;
use crate::units::Unit;

const SALT_WOUNDED: u32 = 0x6361_0050;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TallyCompany {
    pub id: u32,
    pub lost: u16,
    pub joined: u16,
    pub rank_up: bool,
    pub fell: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TallyFoe {
    pub id: u32,
    pub state: FoeState,
    /// The company that brought him down.
    pub by: Option<u32>,
}

/// What a battle did to the campaign (contract §4).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Tally {
    pub won: bool,
    /// The battle's reason (04-battle §8), or the campaign's end when it ended here.
    pub reason: String,
    pub companies: Vec<TallyCompany>,
    /// Commanders who fell, and those who were only wounded and returned.
    pub fallen: Vec<String>,
    pub returned: Vec<String>,
    /// Freed men who joined the warband, and the people freed in the village.
    pub freed: u32,
    pub people: u32,
    /// The company the freed founded, or none.
    pub new_company: Option<String>,
    /// Companies founded by heirs of fallen commanders.
    pub heirs: Vec<String>,
    /// Men who went home: no ranks had room for them.
    pub home: u32,
    pub foe: Option<TallyFoe>,
    /// Villages that burnt out while the warband was away.
    pub burnt: Vec<u32>,
    /// The phase the campaign is in now.
    pub phase: String,
}

/// One company's battle, read from the sim.
struct Read {
    /// Men alive at the end, the commander not counted, and whether he lives.
    men: u16,
    commander: bool,
    dead: u16,
    kills: u32,
}

/// Whether man `k` lived through the battle (fleeing with a routed company is living).
fn lived(b: &Battle, k: usize) -> bool {
    let m = &b.soldiers[k];
    m.alive || m.died_at == Tick::MAX
}

impl Campaign {
    /// Applies a finished battle (contract §2 `finish`): only the battle `battle()` made for this place.
    pub fn finish(&mut self, b: &Battle) -> Result<Tally, String> {
        if self.phase != Phase::Battle {
            return Err(format!("no battle to finish during '{}'", self.phase.name()));
        }
        let place = self.at.ok_or("no place fought at")?;
        if b.seed != self.battle_seed(place) {
            return Err(format!("battle seed {} is not this place's ({})", b.seed, self.battle_seed(place)));
        }
        let (winner, why) = b.outcome().ok_or("the battle is not over")?;
        let won = winner == 0;
        let t = self.tune.campaign.clone();
        let p = self.place(place).cloned().ok_or("no such place")?;

        // The captain.
        let cap = b.squads.iter().position(|s| s.team == 0 && s.kind == Kind::Captain).ok_or("no captain in the battle")?;
        let cap_man = b.squads[cap].soldiers[0];
        let captain_lives = lived(b, cap_man) && b.soldiers[cap_man].hp > 0.0;
        self.captain.hp = if captain_lives { super::hp_kept(b.soldiers[cap_man].hp.clamp(1.0, self.captain.hp_max)) } else { 0.0 };

        // Each company as the battle left it (squad k+1 is company k).
        let order: Vec<(u32, String)> = self.companies.iter().map(|c| (c.id, c.name.clone())).collect();
        let mut reads = Vec::with_capacity(self.companies.len());
        for (j, c) in self.companies.iter().enumerate() {
            let s = b.squads.get(j + 1).filter(|s| s.team == 0 && s.name == c.name).ok_or(format!("company {} is not squad {}", c.name, j + 1))?;
            let commanded = s.commanded;
            let others = if commanded { &s.soldiers[1..] } else { &s.soldiers[..] };
            let men = others.iter().filter(|&&k| lived(b, k)).count() as u16;
            let commander = commanded && !s.commander_fell;
            let dead = s.soldiers.len() as u16 - men - u16::from(commander);
            reads.push(Read { men, commander, dead, kills: s.kills });
        }

        let mut tally = Tally {
            won,
            reason: why.name().to_string(),
            companies: Vec::new(),
            fallen: Vec::new(),
            returned: Vec::new(),
            freed: 0,
            people: b.places.freed_people,
            new_company: None,
            heirs: Vec::new(),
            home: 0,
            foe: None,
            burnt: Vec::new(),
            phase: String::new(),
        };
        self.battles += 1;
        let mut broken: Vec<(Company, u16)> = Vec::new();
        let mut kept: Vec<Company> = Vec::new();
        for (j, (mut c, r)) in std::mem::take(&mut self.companies).into_iter().zip(reads).enumerate() {
            let before = c.rank;
            c.battles += 1;
            let mut commander = r.commander;
            let mut lost = r.dead;
            if !commander && won && jitter(self.seed, self.battles << 8 | j as u32, SALT_WOUNDED) < t.wounded {
                commander = true;
                lost -= 1;
                tally.returned.push(c.name.clone());
            }
            // After a won battle, the wounded among the fallen men return too (`wounded_men` of them, rounded down).
            let mut men = r.men;
            if won {
                let back = ((r.dead.saturating_sub(u16::from(!r.commander)) as f64) * t.wounded_men).floor() as u16;
                men += back;
                lost -= back;
            }
            // Ranks from kills: one for each of 6, 18 and 36 passed.
            let passed = self.tune.rank.kills.iter().filter(|&&k| c.kills < k && c.kills + r.kills >= k).count() as u8;
            c.kills += r.kills;
            c.rank = (c.rank + passed).min(t.max_rank);
            c.last = Last { lost, joined: 0 };
            if !commander {
                tally.fallen.push(c.name.clone());
                tally.companies.push(TallyCompany { id: c.id, lost, joined: 0, rank_up: false, fell: true });
                self.fallen.push(Fallen { id: c.commander, name: c.name.clone(), face: c.face, way: c.way, rank: c.rank, unit: c.unit, step: p.step, place: Some(place) });
                broken.push((c, men));
                continue;
            }
            c.men = men + 1;
            if c.freed {
                c.rank = (c.rank + 1).min(t.max_rank);
                if c.rank >= t.freed_colours {
                    c.freed = false;
                }
            }
            tally.companies.push(TallyCompany { id: c.id, lost, joined: 0, rank_up: c.rank > before, fell: false });
            kept.push(c);
        }
        self.companies = kept;
        let room = t.max_companies.max(self.banners) as usize;

        // A broken company's survivors follow an heir, or fill other ranks.
        for (old, men) in broken {
            if men >= t.found_min && self.companies.len() < room {
                let c = self.new_company(old.unit, men, old.full, old.freed, &old.village);
                tally.heirs.push(c.name.clone());
                tally.companies.push(TallyCompany { id: c.id, lost: 0, joined: men, rank_up: false, fell: false });
                self.companies.push(c);
            } else {
                tally.home += self.fill(men, &mut tally) as u32;
            }
        }

        // The freed of a village taken: those who fell in and lived, or, when taking the village ended the battle
        // before they could fall in (they join at the next tick's start), the 6 it sends.
        let fell_in: u16 = b.places.freed.iter().map(|&sq| b.squads[sq as usize].soldiers.iter().filter(|&&k| lived(b, k)).count() as u16).sum();
        // A village won another way (no defenders left, the broodlord down) is taken all the same: everyone in the
        // houses still standing is freed.
        let people = if won && p.kind == PlaceKind::Village && b.places.freed_people == 0 {
            b.places.houses.iter().filter(|h| matches!(h.state, HouseState::Standing | HouseState::Burning)).map(|h| h.people as u32).sum()
        } else {
            b.places.freed_people
        };
        tally.people = people;
        let waiting = if b.places.freed.is_empty() { people.min(self.tune.places.town.freed_men as u32) as u16 } else { 0 };
        let freed = fell_in + waiting;
        tally.freed = freed as u32;
        if freed > 0 {
            if freed >= t.found_min && self.companies.len() < room {
                let c = self.new_company(Unit::Levy, freed, freed, true, &p.name);
                tally.new_company = Some(c.name.clone());
                tally.companies.push(TallyCompany { id: c.id, lost: 0, joined: freed, rank_up: false, fell: false });
                self.companies.push(c);
            } else {
                tally.home += self.fill(freed, &mut tally) as u32;
            }
        }
        for tc in &tally.companies {
            if let Some(c) = self.companies.iter_mut().find(|c| c.id == tc.id) {
                c.last.joined = tc.joined;
            }
        }

        // The broodlord.
        if let Some(f) = p.foe {
            self.foes[f as usize].met = true;
            let general = b.squads.iter().position(|s| s.team == 1 && s.kind == Kind::Captain);
            let down = general.is_some_and(|g| b.squads[g].soldiers.iter().all(|&k| !lived(b, k)));
            if down {
                let body = general.map(|g| b.soldiers[b.squads[g].soldiers[0]].pos());
                let by = body.and_then(|at| nearest_company(b, &order, at));
                let foe = &mut self.foes[f as usize];
                foe.state = FoeState::Down;
                foe.place = None;
                foe.by = by;
                self.places[place as usize].foe = None;
                if let Some(id) = by
                    && let Some(c) = self.companies.iter_mut().find(|c| c.id == id)
                {
                    c.colours.push(f);
                }
                tally.foe = Some(TallyFoe { id: f, state: FoeState::Down, by });
            } else if won {
                self.places[place as usize].foe = None;
                self.escape(f);
                tally.foe = Some(TallyFoe { id: f, state: FoeState::Escaped, by: None });
            } else {
                tally.foe = Some(TallyFoe { id: f, state: FoeState::Waiting, by: None });
            }
        }

        // The place.
        if won {
            self.places[place as usize].done = true;
            if p.kind != PlaceKind::Keep {
                self.advance(p.step);
            }
            self.phase = Phase::Map;
        } else {
            self.places[place as usize].danger += 1;
            self.at = self.from;
            self.from = None;
            self.to = None;
            self.phase = Phase::Map;
        }

        // The end.
        let end = if !captain_lives {
            Some(End { won: false, reason: "captain fell".into() })
        } else if won && p.kind == PlaceKind::Keep {
            Some(End { won: true, reason: "keep taken".into() })
        } else if self.companies.is_empty() {
            Some(End { won: false, reason: "warband gone".into() })
        } else {
            None
        };
        if let Some(e) = end {
            self.phase = if e.won { Phase::Won } else { Phase::Lost };
            tally.reason = e.reason.clone();
            self.end = Some(e);
        }
        tally.burnt = std::mem::take(&mut self.burnt);
        tally.phase = self.phase.name().to_string();
        self.last = Some(tally.clone());
        Ok(tally)
    }

    /// A new company under a new commander: an heir's, or the freed's.
    fn new_company(&mut self, unit: Unit, men: u16, full: u16, freed: bool, village: &str) -> Company {
        let person = self.person();
        let name = self.new_name(person);
        let id = self.company_id();
        Company {
            id,
            name,
            unit,
            men,
            full: full.max(men),
            rank: 0,
            way: self.way_of(person),
            face: self.face_of(person),
            freed,
            kills: 0,
            battles: 0,
            colours: Vec::new(),
            last: Last { lost: 0, joined: men },
            commander: person,
            veteran: false,
            village: village.to_string(),
        }
    }

    /// `n` men fill the emptiest ranks, one at a time (most men missing first, then the lower id). Returns those
    /// with no room left, who go home.
    fn fill(&mut self, mut n: u16, tally: &mut Tally) -> u16 {
        while n > 0 {
            let Some(c) = self.companies.iter_mut().filter(|c| c.men < c.full).max_by(|a, b| (a.full - a.men).cmp(&(b.full - b.men)).then(b.id.cmp(&a.id))) else {
                break;
            };
            c.men += 1;
            n -= 1;
            let id = c.id;
            match tally.companies.iter_mut().find(|tc| tc.id == id) {
                Some(tc) => tc.joined += 1,
                None => tally.companies.push(TallyCompany { id, lost: 0, joined: 1, rank_up: false, fell: false }),
            }
        }
        n
    }
}

/// The company (of the battle's `order`: squad k+1 is company k) with a living man nearest `at`, ties to the lower
/// id: whose banner the broodlord's colours hang from.
fn nearest_company(b: &Battle, order: &[(u32, String)], at: crate::contracts::P) -> Option<u32> {
    let mut best: Option<(f64, u32)> = None;
    for (j, (id, name)) in order.iter().enumerate() {
        let Some(s) = b.squads.get(j + 1).filter(|s| s.team == 0 && &s.name == name) else { continue };
        for &k in &s.soldiers {
            let m = &b.soldiers[k];
            if !m.alive {
                continue;
            }
            let d = m.pos().dist(at);
            if best.is_none_or(|(bd, bid)| d < bd || (d == bd && *id < bid)) {
                best = Some((d, *id));
            }
        }
    }
    best.map(|(_, id)| id)
}
