//! The per-frame packed buffers (docs/engine/ENGINE.md "The boundary", contracts `soldier_buf`, `squad_buf`, the
//! event ring): flat f32/u32 vectors in WASM memory that TypeScript reads through typed-array views, without a
//! copy. `sync` refills them from the battle once per frame. They are reserved generously at battle start; if one
//! outgrows its reserve it moves, and `layout` counts that so the views know to re-create themselves.

use sim::battle::{Battle, SquadState};
use sim::contracts::{EVENT_WORDS, Kind, Team, soldier_buf as sb, squad_buf as qb};

use crate::compat;

/// 04-battle.md §9: faces the direction of motion when moving faster than this, tiles/s.
const FACE_MOTION: f64 = 0.35;
/// 04-battle.md §9: a man walks (and so can walk backwards) above this pace, tiles/s.
const WALK_MIN: f64 = 0.2;

pub struct Frame {
    pub sf32: Vec<f32>,
    pub su32: Vec<u32>,
    pub strikes: Vec<u32>,
    pub ticks: Vec<u32>,
    pub qf32: Vec<f32>,
    pub qu32: Vec<u32>,
    /// The squad's unit (contracts `squad_buf`, the second u32 per squad).
    pub qunit: Vec<u32>,
    pub events: Vec<u32>,
    pub fog: Vec<u8>,
    pub soldiers: usize,
    pub squads: usize,
    /// Bumped whenever a buffer moves (re-create the views).
    pub layout: u32,
}

/// Flags `sync` returns.
pub const FOG_CHANGED: u32 = 1;

impl Frame {
    pub fn new(b: &Battle) -> Frame {
        let n = b.soldiers.len();
        let cap = (2 * n).max(1024);
        let qcap = (2 * b.squads.len()).max(128);
        let tiles = b.map.w as usize * b.map.h as usize;
        let mut f = Frame {
            sf32: Vec::with_capacity(cap * sb::F32_FIELDS),
            su32: Vec::with_capacity(cap),
            strikes: Vec::with_capacity(cap),
            ticks: Vec::with_capacity(cap * sb::TICK_FIELDS),
            qf32: Vec::with_capacity(qcap * qb::F32_FIELDS),
            qu32: Vec::with_capacity(qcap),
            qunit: Vec::with_capacity(qcap),
            events: Vec::with_capacity(4096 * EVENT_WORDS),
            fog: vec![255; tiles],
            soldiers: 0,
            squads: 0,
            layout: 0,
        };
        f.resize(cap, qcap);
        f
    }

    /// Soldier capacity (entries, not floats).
    pub fn cap(&self) -> usize {
        self.su32.len()
    }

    pub fn squad_cap(&self) -> usize {
        self.qu32.len()
    }

    fn resize(&mut self, cap: usize, qcap: usize) {
        let ptrs = |f: &Frame| [f.sf32.as_ptr() as usize, f.su32.as_ptr() as usize, f.strikes.as_ptr() as usize, f.ticks.as_ptr() as usize, f.qf32.as_ptr() as usize, f.qu32.as_ptr() as usize, f.qunit.as_ptr() as usize];
        let before = ptrs(self);
        self.sf32.resize(cap * sb::F32_FIELDS, 0.0);
        self.su32.resize(cap, 0);
        self.strikes.resize(cap, 0);
        self.ticks.resize(cap * sb::TICK_FIELDS, sb::NEVER);
        self.qf32.resize(qcap * qb::F32_FIELDS, 0.0);
        self.qu32.resize(qcap, 0);
        self.qunit.resize(qcap, 0);
        let after = ptrs(self);
        if before != after {
            self.layout += 1;
        }
    }

    /// Refills every buffer from the battle; the fog is `team`'s. Returns `FOG_CHANGED` when the fog bytes differ
    /// from the last sync.
    pub fn sync(&mut self, b: &Battle, team: Team) -> u32 {
        let n = b.soldiers.len();
        let q = b.squads.len();
        if n > self.cap() || q > self.squad_cap() {
            self.resize((2 * n).max(self.cap()), (2 * q).max(self.squad_cap()));
        }
        self.soldiers = n;
        self.squads = q;
        for (k, m) in b.soldiers.iter().enumerate() {
            let s = &b.squads[m.squad as usize];
            let has_commander = !s.name.is_empty() && s.kind != Kind::Captain;
            let routing = s.state == SquadState::Routing;
            let aim = if m.alive { compat::target(b, k).and_then(|j| b.soldiers.get(j)).map(|t| (t.x, t.y)) } else { None };
            // 04-battle.md §9's priority: a breathing beast faces its prey (a drake hunting keeps its eyes on it,
            // springing back included); else the motion when moving; else the target; else the squad's facing
            let moving = m.pace > FACE_MOTION && (m.vx != 0.0 || m.vy != 0.0);
            let face = match aim {
                Some((ax, ay)) if compat::breathes(s) => sim::math::atan2(ay - m.y, ax - m.x),
                _ if moving => sim::math::atan2(m.vy, m.vx),
                Some((ax, ay)) => sim::math::atan2(ay - m.y, ax - m.x),
                None => s.facing,
            };
            // walking against his facing: the stride plays in reverse
            let backing = m.alive && m.pace > WALK_MIN && m.vx * sim::math::cos(face) + m.vy * sim::math::sin(face) < 0.0;
            let bits = m.squad as u32
                | (s.kind as u32 & 0xf) << 16
                | (s.team as u32 & 1) << 20
                | (m.alive as u32) << 21
                | (routing as u32) << 22
                | ((has_commander && m.slot == 0) as u32) << 23
                | ((s.kind == Kind::Captain) as u32) << 24
                | (s.rank as u32 & 3) << 26
                | (compat::engaged(b, k) as u32) << 28
                | (backing as u32) << 29;
            // TODO(day 4): bit 25 recruit, once freed villages add men.
            self.su32[k] = bits;
            self.strikes[k] = m.strikes;
            let o = k * sb::F32_FIELDS;
            let f = &mut self.sf32[o..o + sb::F32_FIELDS];
            f[sb::X] = m.x as f32;
            f[sb::Y] = m.y as f32;
            f[sb::FACE] = face as f32;
            f[sb::SPEED] = m.pace as f32;
            f[sb::HP] = if m.max_hp > 0.0 { (m.hp / m.max_hp).clamp(0.0, 1.0) as f32 } else { 0.0 };
            f[sb::AIM_X] = aim.map_or(f32::NAN, |a| a.0 as f32);
            f[sb::AIM_Y] = aim.map_or(f32::NAN, |a| a.1 as f32);
            let (hit, died) = compat::hit_and_death(b, k);
            self.ticks[k * sb::TICK_FIELDS + sb::HIT_AT] = hit;
            self.ticks[k * sb::TICK_FIELDS + sb::DIED_AT] = if m.alive { sb::NEVER } else { died };
            self.ticks[k * sb::TICK_FIELDS + sb::BREATH_AT] = if m.alive { compat::breath_cycle(b, k) } else { sb::NEVER };
        }
        for (j, s) in b.squads.iter().enumerate() {
            let alive = s.soldiers.iter().filter(|&&k| b.soldiers[k].alive).count();
            let heart = if s.max_morale > 0.0 { (s.morale / s.max_morale).clamp(0.0, 1.0) } else { 0.0 };
            let o = j * qb::F32_FIELDS;
            let f = &mut self.qf32[o..o + qb::F32_FIELDS];
            f[qb::X] = s.x as f32;
            f[qb::Y] = s.y as f32;
            f[qb::FACE] = s.facing as f32;
            f[qb::MORALE] = heart as f32;
            f[qb::LEAN] = ((0.55 - heart) / 0.3).clamp(0.0, 1.0) as f32;
            f[qb::ALIVE_FRAC] = if s.full > 0 { alive as f32 / s.full as f32 } else { 0.0 };
            self.qu32[j] = (s.state as u32 & 0xff)
                | (s.detached as u32) << 8
                | (s.kind as u32 & 0xf) << 9
                | (s.team as u32 & 1) << 13
                | (s.rank as u32 & 3) << 14
                | (s.full.min(255) as u32) << 16
                | (alive.min(255) as u32) << 24;
            self.qunit[j] = compat::unit(s) as u32 & qb::UNIT_MASK;
        }
        self.sync_fog(b, team)
    }

    fn sync_fog(&mut self, b: &Battle, team: Team) -> u32 {
        let src = compat::fog(b, team);
        let mut changed = false;
        if self.fog.len() != src.len() {
            self.fog.resize(src.len(), 0);
            self.layout += 1;
            changed = true;
        }
        if self.fog[..] != src[..] {
            self.fog.copy_from_slice(src);
            changed = true;
        }
        if changed { FOG_CHANGED } else { 0 }
    }

    /// Moves the battle's pending events into the packed ring: [code, tick, x f32 bits, y f32 bits, a, b] each.
    pub fn drain(&mut self, b: &mut Battle) -> usize {
        let cap = self.events.capacity();
        self.events.clear();
        for e in b.drain_events() {
            self.events.extend_from_slice(&[e.code as u32, e.tick, (e.at.x as f32).to_bits(), (e.at.y as f32).to_bits(), e.a, e.b]);
        }
        if self.events.capacity() != cap {
            self.layout += 1;
        }
        self.events.len() / EVENT_WORDS
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim::battle::Event;
    use sim::contracts::{EventCode, P};
    use sim::map::{MapKind, MapOpts};

    fn battle(army: &str) -> Battle {
        compat::muster(4, MapOpts { kind: MapKind::Keep, width: 48 }, army).unwrap()
    }

    #[test]
    fn sync_packs_every_soldier_and_squad() {
        let mut b = battle("default");
        b.step(30);
        let mut f = Frame::new(&b);
        let flags = f.sync(&b, 0);
        assert_eq!(flags, FOG_CHANGED, "the first sync reports the fog");
        assert_eq!(f.sync(&b, 0), 0, "an unchanged fog is not reported again");
        let fighting = b.soldiers.iter().filter(|m| m.engaged).count();
        assert_eq!(f.su32[..f.soldiers].iter().filter(|&&w| (w >> 28) & 1 == 1).count(), fighting);
        assert_eq!(f.soldiers, b.soldiers.len());
        assert_eq!(f.squads, b.squads.len());
        let mut captains = 0;
        let mut commanders = 0;
        for (k, m) in b.soldiers.iter().enumerate() {
            let w = f.su32[k];
            let s = &b.squads[m.squad as usize];
            assert_eq!(w & 0xffff, m.squad as u32);
            assert_eq!((w >> 16) & 0xf, s.kind as u32);
            assert_eq!((w >> 20) & 1, s.team as u32);
            assert_eq!((w >> 21) & 1, m.alive as u32);
            captains += (w >> 24) & 1;
            commanders += (w >> 23) & 1;
            let o = k * sb::F32_FIELDS;
            assert_eq!(f.sf32[o + sb::X], m.x as f32);
            assert_eq!(f.sf32[o + sb::Y], m.y as f32);
            assert_eq!(f.sf32[o + sb::HP], 1.0);
            assert_eq!(f.sf32[o + sb::AIM_X].is_nan(), m.target.is_none());
            assert_eq!(f.ticks[k * sb::TICK_FIELDS + sb::DIED_AT], sb::NEVER);
        }
        assert_eq!(captains, b.squads.iter().filter(|s| s.kind == Kind::Captain).count() as u32, "our captain and their general");
        assert_eq!(commanders, b.squads.iter().filter(|s| !s.name.is_empty() && s.kind != Kind::Captain).count() as u32);
        for (j, s) in b.squads.iter().enumerate() {
            let w = f.qu32[j];
            assert_eq!(w & 0xff, s.state as u32);
            assert_eq!((w >> 9) & 0xf, s.kind as u32);
            assert_eq!((w >> 13) & 1, s.team as u32);
            assert_eq!((w >> 16) & 0xff, s.full as u32);
            assert_eq!(w >> 24, s.full as u32, "everyone alive");
            assert_eq!(f.qf32[j * qb::F32_FIELDS + qb::MORALE], 1.0);
            assert_eq!(f.qunit[j], compat::unit(s) as u32);
        }
        assert_eq!(f.fog[..], b.fog(0)[..]);
        assert!(f.fog.contains(&2), "our army sees round itself");
        println!("sync: {} soldiers, {} squads, {captains} captains, {commanders} commanders", f.soldiers, f.squads);
    }

    #[test]
    fn deaths_and_hits_are_dated_and_events_packed() {
        let mut b = battle("big");
        let mut f = Frame::new(&b);
        f.sync(&b, 0);
        b.step(5);
        b.soldiers[7].hit_at = 4;
        b.soldiers[9].alive = false;
        b.soldiers[9].died_at = 4;
        b.soldiers[10].alive = false;
        f.sync(&b, 0);
        assert_eq!(f.ticks[7 * sb::TICK_FIELDS + sb::HIT_AT], 4);
        assert_eq!(f.ticks[9 * sb::TICK_FIELDS + sb::DIED_AT], 4);
        assert_eq!(f.ticks[10 * sb::TICK_FIELDS + sb::DIED_AT], sb::NEVER, "left the field, never died");
        assert_eq!(f.ticks[8 * sb::TICK_FIELDS + sb::HIT_AT], sb::NEVER);
        b.events.push(Event { code: EventCode::Death, tick: 4, at: P::new(1.5, 2.25), a: 9, b: 0 });
        assert_eq!(f.drain(&mut b), 1);
        assert_eq!(&f.events[..2], &[EventCode::Death as u32, 4]);
        assert_eq!(f32::from_bits(f.events[2]), 1.5);
        assert_eq!(f32::from_bits(f.events[3]), 2.25);
        assert_eq!(f.events[4], 9);
        assert_eq!(f.drain(&mut b), 0, "drained once");
        assert_eq!(f.ticks[3 * sb::TICK_FIELDS + sb::BREATH_AT], sb::NEVER, "no breath yet");
        b.soldiers[3].cycle = 5;
        f.sync(&b, 0);
        assert_eq!(f.ticks[3 * sb::TICK_FIELDS + sb::BREATH_AT], 5, "the breath cycle is dated by the sim");
        println!("big army: {} soldiers in {} squads", f.soldiers, f.squads);
    }

    #[test]
    fn a_man_stepping_back_from_his_foe_is_backing() {
        let mut b = battle("big");
        b.step(1);
        let foe = b.soldiers.iter().position(|m| b.squads[m.squad as usize].team == 1).unwrap();
        let k = b.soldiers.iter().position(|m| b.squads[m.squad as usize].team == 0 && b.squads[m.squad as usize].kind == Kind::Spear).unwrap();
        let (fx, fy) = (b.soldiers[foe].x, b.soldiers[foe].y);
        let m = &mut b.soldiers[k];
        let (dx, dy) = (fx - m.x, fy - m.y);
        let n = sim::math::hyp(dx, dy);
        // slow (under the motion threshold), facing his target, walking away from it
        m.target = Some(foe);
        m.pace = 0.3;
        m.vx = -0.3 * dx / n;
        m.vy = -0.3 * dy / n;
        let mut f = Frame::new(&b);
        f.sync(&b, 0);
        assert_eq!((f.su32[k] >> 29) & 1, 1, "backing");
        let face = f.sf32[k * sb::F32_FIELDS + sb::FACE] as f64;
        assert!((face - sim::math::atan2(dy, dx)).abs() < 1e-5, "he faces his foe");
        let backing = f.su32[..f.soldiers].iter().filter(|&&w| (w >> 29) & 1 == 1).count();
        assert_eq!(backing, 1, "nobody else walks backwards");
        println!("backing: soldier {k} facing {face:.3}, {backing} backing");
    }
}
