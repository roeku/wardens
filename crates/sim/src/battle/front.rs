//! Formations (04-battle.md §4): the drawn front (`planFront`) and the line to a point.

use super::{Battle, How, Order, SquadState};
use crate::contracts::{Kind, P, SquadId, Team};
use crate::math::atan2;

/// What a company is in a front: the line, the bows behind it, the horse on the ends, or the reserve.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Role {
    Line,
    Bows,
    Horse,
    Reserve,
}

/// The arc-length parametrised polyline of a front.
struct Poly {
    pts: Vec<P>,
    cum: Vec<f64>,
}

impl Poly {
    fn new(line: &[P]) -> Poly {
        let mut pts: Vec<P> = Vec::new();
        for &p in line {
            if pts.last().is_none_or(|q: &P| q.dist(p) > 1e-9) {
                pts.push(p);
            }
        }
        let mut cum = vec![0.0];
        for w in pts.windows(2) {
            cum.push(cum.last().copied().unwrap_or(0.0) + w[0].dist(w[1]));
        }
        Poly { pts, cum }
    }

    fn len(&self) -> f64 {
        self.cum.last().copied().unwrap_or(0.0)
    }

    /// The point `s` along the line, clamped to its ends.
    fn at(&self, s: f64) -> P {
        let s = s.clamp(0.0, self.len());
        let i = self.cum.partition_point(|&c| c <= s).clamp(1, self.pts.len().max(2) - 1);
        if self.pts.len() < 2 {
            return self.pts[0];
        }
        let (a, b) = (self.pts[i - 1], self.pts[i]);
        let seg = self.cum[i] - self.cum[i - 1];
        let t = if seg > 0.0 { (s - self.cum[i - 1]) / seg } else { 0.0 };
        P::new(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
    }

    /// The unit tangent at `s`, taken over ±`span` so a wobble doesn't swing a squad round.
    fn tangent(&self, s: f64, span: f64) -> P {
        let (a, b) = (self.at(s - span), self.at(s + span));
        let d = a.dist(b);
        if d > 1e-9 { P::new((b.x - a.x) / d, (b.y - a.y) / d) } else { P::new(1.0, 0.0) }
    }
}

impl Battle {
    fn role(&self, i: usize) -> Role {
        let s = &self.squads[i];
        if s.freed {
            Role::Reserve
        } else if s.spec.ranged() {
            Role::Bows
        } else if s.kind == Kind::Horse || s.spec.beast && s.team == 0 {
            Role::Horse
        } else {
            Role::Line
        }
    }

    /// `threatPoint`: the 1/(1+d)-weighted centroid of the visible enemies within 24 tiles of `from`, else the
    /// enemy keep or deploy point.
    pub fn threat_point(&self, team: Team, from: P) -> P {
        let r = self.tune.front.threat_r;
        let (mut x, mut y, mut w) = (0.0, 0.0, 0.0);
        for m in &self.soldiers {
            if !m.alive || self.squads[m.squad as usize].team == team || !self.sees(team, m.pos()) {
                continue;
            }
            let d = m.pos().dist(from);
            if d <= r {
                let k = 1.0 / (1.0 + d);
                x += m.x * k;
                y += m.y * k;
                w += k;
            }
        }
        if w > 0.0 { P::new(x / w, y / w) } else { self.map.deploy[1 - (team as usize & 1)] }
    }

    /// 04-battle.md §4 "The drawn front". Melee companies split the line evenly (`files = clamp(floor(seg/0.72),
    /// 3, max(2, ceil(men/2)))`), bows 3.2 behind 4.6 apart, reserve 2.6 behind either side of the bows, horse
    /// beyond alternating ends, the captain 5 behind (2.8 with no bows). Everyone faces the normal toward the
    /// threat and keeps its left-to-right order. Drawn toward the threat it fights and the captain rides.
    pub(super) fn plan_front(&mut self, team: Team, cap: usize, line: &[P]) -> Result<(), (P, String)> {
        let ft = self.tune.front.clone();
        let poly = Poly::new(line);
        let len = poly.len();
        if poly.pts.is_empty() {
            return Err((self.captain_at(team).unwrap_or(self.map.deploy[team as usize & 1]), "empty front".into()));
        }
        if len < ft.tap {
            let to = self.open_near(poly.at(len / 2.0));
            self.army_to(team, cap, to, Vec::new(), false, None);
            return Ok(());
        }
        let mid = poly.at(len / 2.0);
        let threat = self.threat_point(team, mid);
        let chord = P::new(poly.pts[poly.pts.len() - 1].x - poly.pts[0].x, poly.pts[poly.pts.len() - 1].y - poly.pts[0].y);
        let cl = (chord.x * chord.x + chord.y * chord.y).sqrt().max(1e-9);
        let tan = P::new(chord.x / cl, chord.y / cl);
        // The normal toward the threat.
        let mut n = P::new(-tan.y, tan.x);
        if (threat.x - mid.x) * n.x + (threat.y - mid.y) * n.y < 0.0 {
            n = P::new(-n.x, -n.y);
        }
        let face = atan2(n.y, n.x);
        let companies: Vec<usize> = (0..self.squads.len())
            .filter(|&i| self.squads[i].team == team && self.squads[i].standing() && self.squads[i].kind != Kind::Captain && self.squads[i].alive > 0)
            .collect();
        let centroid = {
            let all: Vec<usize> = companies.iter().copied().chain(std::iter::once(cap)).collect();
            let k = all.len() as f64;
            let (x, y) = all.iter().fold((0.0, 0.0), |(x, y), &i| (x + self.centre(i).x, y + self.centre(i).y));
            P::new(x / k, y / k)
        };
        let fight = (mid.x - centroid.x) * n.x + (mid.y - centroid.y) * n.y > 0.0;
        let along = |b: &Battle, i: usize| {
            let c = b.centre(i);
            (c.x - poly.pts[0].x) * tan.x + (c.y - poly.pts[0].y) * tan.y
        };
        let by_side = |b: &Battle, ids: &mut Vec<usize>| ids.sort_by(|&x, &y| along(b, x).total_cmp(&along(b, y)).then(x.cmp(&y)));
        let mut roles: Vec<(usize, Role)> = companies.iter().map(|&i| (i, self.role(i))).collect();
        let has = |roles: &[(usize, Role)], r: Role| roles.iter().any(|&(_, x)| x == r);
        if !has(&roles, Role::Line) {
            let fill = if has(&roles, Role::Bows) { Role::Bows } else { Role::Horse };
            for r in roles.iter_mut().filter(|r| r.1 == fill) {
                r.1 = Role::Line;
            }
        }
        let pick = |r: Role| -> Vec<usize> { roles.iter().filter(|x| x.1 == r).map(|x| x.0).collect() };
        let (mut melee, mut bows, mut horse, mut reserve) = (pick(Role::Line), pick(Role::Bows), pick(Role::Horse), pick(Role::Reserve));
        by_side(self, &mut melee);
        by_side(self, &mut bows);
        by_side(self, &mut horse);
        by_side(self, &mut reserve);
        let mut plan: Vec<(usize, P, f64, Option<u16>)> = Vec::new();
        let seg = len / melee.len().max(1) as f64;
        for (k, &i) in melee.iter().enumerate() {
            let s = (k as f64 + 0.5) * seg;
            let t = poly.tangent(s, ft.tangent);
            let mut ni = P::new(-t.y, t.x);
            if ni.x * n.x + ni.y * n.y < 0.0 {
                ni = P::new(-ni.x, -ni.y);
            }
            let men = self.squads[i].alive.saturating_sub(self.squads[i].leader.is_some() as u16).max(1);
            let hi = ((men as f64 / 2.0).ceil() as u16).max(2);
            let files = ((seg / self.tune.movement.file_gap).floor() as u16).min(hi).max(ft.min_files);
            plan.push((i, poly.at(s), atan2(ni.y, ni.x), Some(files)));
        }
        let behind = |d: f64, lateral: f64| P::new(mid.x - n.x * d + tan.x * lateral, mid.y - n.y * d + tan.y * lateral);
        let nb = bows.len() as f64;
        for (k, &i) in bows.iter().enumerate() {
            plan.push((i, behind(ft.bows_back, (k as f64 - (nb - 1.0) / 2.0) * ft.bows_gap), face, None));
        }
        let half = nb.max(1.0) * ft.bows_gap / 2.0;
        for (k, &i) in reserve.iter().enumerate() {
            let side = if k % 2 == 0 { -1.0 } else { 1.0 };
            plan.push((i, behind(ft.reserve_back, side * (half + ft.bows_gap / 2.0 + ft.bows_gap * (k / 2) as f64)), face, None));
        }
        let (start, end) = (poly.at(0.0), poly.at(len));
        let (t0, t1) = (poly.tangent(0.0, ft.tangent), poly.tangent(len, ft.tangent));
        let near_end = horse.len() == 1 && along(self, horse[0]) > len / 2.0;
        for (k, &i) in horse.iter().enumerate() {
            let beyond = ft.horse_beyond + ft.horse_step * (k / 2) as f64 + if self.squads[i].spec.beast { ft.beast_beyond } else { 0.0 };
            let at_end = (k % 2 == 1) != near_end;
            let p = if at_end {
                P::new(end.x + t1.x * beyond - n.x * ft.horse_back, end.y + t1.y * beyond - n.y * ft.horse_back)
            } else {
                P::new(start.x - t0.x * beyond - n.x * ft.horse_back, start.y - t0.y * beyond - n.y * ft.horse_back)
            };
            plan.push((i, p, face, None));
        }
        for (i, p, f, files) in plan {
            let to = self.open_near(p);
            let how = How { files, ..How::default() };
            self.command(i, Order::Move { to, via: Vec::new(), fight, face: Some(f) }, how);
            self.squads[i].detached = false;
        }
        let back = if bows.is_empty() { ft.captain_back_no_bows } else { ft.captain_back };
        if fight {
            self.command(cap, Order::Ride, How::default());
        } else {
            let to = self.open_near(behind(back, 0.0));
            self.command(cap, Order::Move { to, via: Vec::new(), fight: false, face: Some(face) }, How::default());
        }
        self.armies[team as usize].aim = face;
        Ok(())
    }
}

/// 04-battle.md §4 "Line to a point": the heading runs from the group's centroid to `to`; the squads, sorted by
/// lateral offset, stand `gap` apart across it, centred on `to`. Returns each squad's spot and facing. Bots use
/// it for a sally's line (everyone at the slowest's pace needs `pace` on `Deed::Move`; see decisions).
pub fn line_spots(squads: &[(SquadId, P)], to: P, gap: f64) -> Vec<(SquadId, P, f64)> {
    if squads.is_empty() {
        return Vec::new();
    }
    let k = squads.len() as f64;
    let (cx, cy) = squads.iter().fold((0.0, 0.0), |(x, y), (_, p)| (x + p.x, y + p.y));
    let c = P::new(cx / k, cy / k);
    let heading = if c.dist(to) > 1e-9 { atan2(to.y - c.y, to.x - c.x) } else { 0.0 };
    let left = P::new(crate::math::sin(heading), -crate::math::cos(heading));
    let mut order: Vec<(f64, SquadId)> = squads.iter().map(|(id, p)| ((p.x - c.x) * left.x + (p.y - c.y) * left.y, *id)).collect();
    order.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    order
        .iter()
        .enumerate()
        .map(|(j, &(_, id))| {
            let lateral = (j as f64 - (k - 1.0) / 2.0) * gap;
            (id, to.offset(heading, 0.0, lateral), heading)
        })
        .collect()
}

impl SquadState {
    pub fn name(self) -> &'static str {
        match self {
            SquadState::Idle => "idle",
            SquadState::Marching => "marching",
            SquadState::Fighting => "fighting",
            SquadState::Routing => "routing",
            SquadState::Fled => "fled",
            SquadState::Destroyed => "destroyed",
        }
    }
}
