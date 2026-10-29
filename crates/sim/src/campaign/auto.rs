//! Whole campaigns played headless with simple policies (01-flow §8; AGENTS.md rule 4), for the harness's
//! `campaign` command and the tests: the debug muster, a road choice, every battle fought by the warband's bot
//! against the place's (the garrison at holdfasts, villages and the keep; the raiders at fords), and the camp's
//! honour. Deterministic: a seed always plays the same campaign.
//!
//! **The road choice** (chosen): a camp when the warband is below 70% of its men or the captain below half his hp;
//! else a village with houses standing (its freed are the only new men); else the place with the smallest garrison
//! share; ties to the lower id. **The honour** goes to the company with the most kills (ties to the lower id).

use super::{Campaign, Phase, PlaceKind};
use crate::battle::Battle;
use crate::bots::{Bot, BotKind};
use crate::contracts::{Command, Deed, Kind, P, Source, TICK_HZ, Who};
use crate::tune::Tune;

/// Seconds simulated past a battle's own time limit before it counts as stalled.
const GRACE_S: f64 = 60.0;
/// The road choice rests below this share of the warband's men, or of the captain's hp.
const REST_MEN: f64 = 0.7;
const REST_HP: f64 = 0.5;
/// The leader-only policy re-sends the captain this often, s (chosen: as the charge bot thinks).
const LEADER_THINK_S: f64 = 1.0;
/// The sensible bot withdraws below these shares (chosen).
const WITHDRAW_HP: f64 = 0.35;
const WITHDRAW_MEN: f64 = 0.35;
/// A campaign is cut off after this many battles (it cannot need more: 6 steps and a few losses each).
const MAX_BATTLES: u32 = 40;

/// What one campaign did, for the harness's counts.
#[derive(Clone, Debug, Default)]
pub struct Played {
    pub seed: u32,
    pub won: bool,
    /// Why it ended: `keep taken`, `captain fell`, `warband gone`, or `stalled`/`cut off` if it could not end.
    pub reason: String,
    /// Steps reached (the row reached: 6 is the keep taken).
    pub steps: u32,
    pub battles: u32,
    pub battles_won: u32,
    pub camps: u32,
    pub days: u32,
    pub men_lost: u32,
    pub fallen: u32,
    pub returned: u32,
    pub heirs: u32,
    pub new_companies: u32,
    pub freed: u32,
    pub villages_freed: u32,
    pub villages_burnt: u32,
    pub foes_down: u32,
    pub foes_escaped: u32,
    /// Seconds of battle simulated.
    pub sim_s: f64,
    /// Battles the sensible bot broke off, withdrawing the captain to his own edge.
    pub withdrawals: u32,
    /// The phases the campaign stood in between battles, in order, with its save there (for the round trip).
    pub saves: Vec<(String, String)>,
    /// One line per battle: place kind and step, the warband's and the garrison's men, the outcome and why, the
    /// captain's hp before and after.
    pub log: Vec<String>,
}

/// Plays `seed`'s campaign with `us` as the warband's bot. With `keep_saves`, every between-battle state's save is
/// kept in `saves`.
/// Who plays the warband: one of the sim's bots, or the leader-only policy (01-flow §8 "leader-only": only the
/// captain is ordered; the companies follow him).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    Bot(BotKind),
    Leader,
}

impl Policy {
    /// `leader`, or any bot's name (`commander`, `charge`, `idle`, ...).
    pub fn parse(s: &str) -> Result<Policy, String> {
        if s == "leader" { Ok(Policy::Leader) } else { BotKind::parse(s).map(Policy::Bot) }
    }

    pub fn name(self) -> String {
        match self {
            Policy::Bot(k) => k.name(),
            Policy::Leader => "leader".into(),
        }
    }
}

/// The leader-only policy: every `LEADER_THINK_S` the captain is sent, fighting, at the place's keep or town (the
/// army follows), or at the ford's main crossing.
fn lead(b: &Battle) -> Option<Command> {
    if b.outcome().is_some() || !b.tick.is_multiple_of((LEADER_THINK_S * TICK_HZ as f64) as u32) {
        return None;
    }
    let deed = match (&b.places.ford, b.map.sites.first()) {
        (Some(f), _) => Deed::Move { who: Who::Army, to: f.crossing[0], via: Vec::new(), fight: true, face: None },
        (None, Some(s)) => Deed::Take { who: Who::Army, site: s.id, via: Vec::new() },
        _ => return None,
    };
    Some(Command { tick: b.tick, team: 0, deed, src: Source::Bot, note: None })
}

pub fn play(seed: u32, policy: Policy, tune: &Tune, keep_saves: bool) -> Played {
    let us = match policy {
        Policy::Bot(k) => k,
        Policy::Leader => BotKind::Idle,
    };
    let mut c = Campaign::create(seed, &super::Opts::default(), tune.clone());
    let mut out = Played { seed, ..Played::default() };
    let save = |c: &Campaign, out: &mut Played| {
        if keep_saves {
            out.saves.push((c.phase.name().to_string(), c.save().expect("a save between battles")));
        }
    };
    save(&c, &mut out);
    c.auto_muster().expect("the muster");
    save(&c, &mut out);
    loop {
        match c.phase {
            Phase::Muster | Phase::Map => {
                let Some(to) = choose(&c) else {
                    out.reason = "no road".into();
                    break;
                };
                c.set_out(to).expect("a reachable place");
                save(&c, &mut out);
                c.arrive().expect("arriving");
            }
            Phase::Camp => {
                out.camps += 1;
                save(&c, &mut out);
                if let Some(best) = c.companies.iter().max_by(|a, b| a.kills.cmp(&b.kills).then(b.id.cmp(&a.id))).map(|k| k.id) {
                    c.honour(best).expect("an honour");
                }
                c.break_camp().expect("breaking camp");
                save(&c, &mut out);
            }
            Phase::Battle => {
                if c.battles >= MAX_BATTLES {
                    out.reason = "cut off".into();
                    break;
                }
                let f = c.battle().expect("the battle");
                let mut b = f.battle;
                let here = c.at.and_then(|id| c.place(id)).cloned().expect("a place");
                let ours: u32 = c.companies.iter().map(|k| k.men as u32).sum();
                let theirs: usize = b.squads.iter().filter(|s| s.team == 1).map(|s| s.soldiers.len()).sum();
                let hp0 = c.captain.hp;
                let mut bots = [Some(Bot::new(us, 0)), f.enemy.map(|k| Bot::new(k, 1))];
                let limit = ((b.time_limit() + GRACE_S) * TICK_HZ as f64) as u32;
                let start = standing_men(&b, 0);
                let mut withdrawing = false;
                while b.outcome().is_none() && b.tick < limit {
                    if us == BotKind::Commander && here.danger == 0 && !withdrawing && should_withdraw(&b, start) {
                        withdrawing = true;
                        out.withdrawals += 1;
                        withdraw(&mut b);
                    }
                    for bot in bots.iter_mut().flatten() {
                        if withdrawing && bot.team == 0 {
                            continue;
                        }
                        for cmd in bot.think(&b) {
                            b.apply(cmd);
                        }
                    }
                    if policy == Policy::Leader
                        && let Some(cmd) = lead(&b)
                    {
                        b.apply(cmd);
                    }
                    b.step(1);
                }
                out.sim_s += b.time();
                if b.outcome().is_none() {
                    out.reason = "stalled".into();
                    break;
                }
                let t = c.finish(&b).expect("finishing the battle");
                out.log.push(format!(
                    "{:>8} step {} danger {} | ours {:>2} in {} companies vs {:>2} (+waves) | {} {:<12} at {:>5.0} s | captain {:>3.0} -> {:>3.0} | lost {:>2} fell {}",
                    here.kind.name(),
                    here.step,
                    here.danger,
                    ours,
                    t.companies.len(),
                    theirs,
                    if t.won { "won " } else { "LOST" },
                    b.outcome().map_or("", |(_, r)| r.name()),
                    b.time(),
                    hp0,
                    c.captain.hp,
                    t.companies.iter().map(|k| k.lost as u32).sum::<u32>(),
                    t.fallen.len()
                ));
                out.battles += 1;
                out.battles_won += u32::from(t.won);
                out.men_lost += t.companies.iter().map(|k| k.lost as u32).sum::<u32>();
                out.fallen += t.fallen.len() as u32;
                out.returned += t.returned.len() as u32;
                out.heirs += t.heirs.len() as u32;
                out.new_companies += u32::from(t.new_company.is_some());
                out.freed += t.freed;
                if let Some(f) = &t.foe {
                    match f.state {
                        super::FoeState::Down => out.foes_down += 1,
                        super::FoeState::Escaped => out.foes_escaped += 1,
                        super::FoeState::Waiting => {}
                    }
                }
                save(&c, &mut out);
            }
            Phase::Won | Phase::Lost => {
                out.won = c.phase == Phase::Won;
                out.reason = c.end.as_ref().map_or_else(String::new, |e| e.reason.clone());
                break;
            }
            Phase::March => unreachable!("arrive follows set_out"),
        }
    }
    out.steps = c.step + u32::from(c.phase == Phase::Won);
    out.days = c.day;
    out.villages_freed = c.places.iter().filter(|p| p.kind == PlaceKind::Village && p.done).count() as u32;
    out.villages_burnt = c.places.iter().filter(|p| p.kind == PlaceKind::Village && !p.done && p.houses == 0).count() as u32;
    out
}

/// Men standing for `team`: alive in its companies on the field and not routing (the captain not counted).
fn standing_men(b: &Battle, team: u8) -> u32 {
    b.squads.iter().filter(|s| s.team == team && s.kind != Kind::Captain && s.kind != Kind::Folk && s.standing()).map(|s| s.alive as u32).sum()
}

/// The sensible bot breaks a battle off by day (by night a living captain wins at dawn) when its captain is below
/// `WITHDRAW_HP` of his hp, or its men standing are below `WITHDRAW_MEN` of those it began with and fewer than the
/// enemy's (chosen; 01-flow §4 "Losing a battle": the captain lives and the warband falls back). It does so only the
/// first time at a place (danger 0): a place it lost once it fights out, so every campaign ends.
fn should_withdraw(b: &Battle, start: u32) -> bool {
    if b.night || b.time() < b.tune.outcome.withdraw_after_s {
        return false;
    }
    let Some(cap) = b.captain_of(0) else { return false };
    let man = &b.soldiers[b.squads[cap].soldiers[0]];
    let ours = standing_men(b, 0);
    man.hp < WITHDRAW_HP * man.max_hp || ((ours as f64) < WITHDRAW_MEN * start as f64 && ours < standing_men(b, 1))
}

/// Everyone recalled, and the army marches for its own edge behind the captain (the battle is lost when he gets
/// there, 04-battle §8).
fn withdraw(b: &mut Battle) {
    let Some(at) = b.captain_at(0) else { return };
    let tick = b.tick;
    for deed in [Deed::Rally, Deed::Move { who: Who::Army, to: P::new(0.6, at.y), via: Vec::new(), fight: false, face: None }] {
        b.apply(Command { tick, team: 0, deed, src: Source::Bot, note: None });
    }
}

/// The road choice.
pub fn choose(c: &Campaign) -> Option<u32> {
    let r = c.reachable();
    let men: u32 = c.companies.iter().map(|k| k.men as u32).sum();
    let full: u32 = c.companies.iter().map(|k| k.full as u32).sum();
    let tired = (full > 0 && (men as f64) < REST_MEN * full as f64) || c.captain.hp < REST_HP * c.captain.hp_max;
    let of = |k: PlaceKind| r.iter().copied().filter(|&id| c.place(id).is_some_and(|p| p.kind == k)).min();
    if tired && let Some(id) = of(PlaceKind::Camp) {
        return Some(id);
    }
    if let Some(id) = r.iter().copied().filter(|&id| c.place(id).is_some_and(|p| p.kind == PlaceKind::Village && p.houses > 0)).min() {
        return Some(id);
    }
    r.iter()
        .copied()
        .filter(|&id| c.place(id).is_some_and(|p| p.kind != PlaceKind::Camp || r.len() == 1))
        .min_by(|&a, &b| {
            let (pa, pb) = (c.place(a).expect("a place"), c.place(b).expect("a place"));
            c.garrison_share(pa).total_cmp(&c.garrison_share(pb)).then(a.cmp(&b))
        })
        .or_else(|| r.first().copied())
}
