//! Input and marks (day 4; docs/spec/01-flow.md §2, 02-look.md §7, 04-battle.md §4, 08-orders.md §1 and §6): what
//! the input layer and its marks read from the battle. Each company's order as something to draw (its verb, the
//! point or company or site it goes for, the waypoints left, whether it is detached and where its order flag
//! stands, and the deeds waiting in its queue with their triggers), the sites' capture, a drawn front's plan as
//! preview bars without ordering anything, and `flush` so an order given (while paused too) shows at once.
//! Its own `impl Battle` block, so each part of day 4 adds exports without touching the others' files.

use serde_json::{Value, json};
use sim::battle::{Battle as Sim, Order, Pending};
use sim::contracts::{Deed, Kind, P, Team};
use sim::math::atan2;
use wasm_bindgen::prelude::*;

use crate::Battle;

#[wasm_bindgen]
impl Battle {
    /// Applies the commands due now without stepping, so an order given shows at once, while paused too
    /// (01-flow.md §2 "Orders still work while paused"). The bots think first for this tick, exactly as the next
    /// `step` would before applying the queue (a bot thinks at most once a tick, so that step does not think
    /// again): the battle and its log are the ones the next tick would have given.
    pub fn flush(&mut self) {
        for bot in self.bots.iter_mut().flatten() {
            for cmd in bot.think(&self.inner) {
                self.inner.apply(cmd);
            }
        }
        self.inner.flush();
    }

    /// `team`'s orders for drawing, as JSON: `{captain, held, squads: [...], army: [waiting...]}`. Each company on
    /// the field: `{id, order, state, detached, reserve, working, c: [x,y] (its centre), to?: [x,y], target?,
    /// site?, ward?, fight?, via: [[x,y]...], flag?: [x,y], waits: [...]}`; each waiting deed: `{when, deed, text,
    /// signalled, to?: [x,y]}` with `when` and `deed` in the contract's JSON.
    pub fn orders_json(&self, team: u8) -> String {
        let b = &self.inner;
        let squads: Vec<Value> = (0..b.squads.len()).filter(|&j| b.squads[j].team == team && b.squads[j].on_field()).map(|j| order_json(b, j)).collect();
        let army: Vec<Value> = b.waiting[team as usize & 1].iter().map(|p| pending_json(b, team, p)).collect();
        json!({ "captain": b.captain_of(team), "held": b.held[team as usize & 1], "squads": squads, "army": army }).to_string()
    }

    /// The sites and their capture (04-battle.md §8): `{r, sites: [{id, kind, x, y, owner, by, progress}]}`, where
    /// `r` is the capture radius, `owner` and `by` a team or null, and `progress` 0..1 toward `by`.
    pub fn sites_json(&self) -> String {
        let b = &self.inner;
        let sites: Vec<Value> = b
            .map
            .sites
            .iter()
            .zip(&b.sites)
            .map(|(s, st)| json!({ "id": s.id, "kind": format!("{:?}", s.kind).to_lowercase(), "x": s.at.x, "y": s.at.y, "owner": st.owner, "by": st.by, "progress": st.progress }))
            .collect();
        json!({ "r": b.tune.outcome.capture_r, "sites": sites }).to_string()
    }

    /// Each company as hit-testing and the marks need it, as JSON: `[{id, team, kind, unit, name, radius, ranged,
    /// captain, face}]` (its kind, unit and body radius do not change in a battle); `face` is the commander's look
    /// from the campaign, 0 to derive it from the id.
    pub fn squads_json(&self) -> String {
        let b = &self.inner;
        let out: Vec<Value> = b
            .squads
            .iter()
            .map(|s| {
                json!({ "id": s.id, "team": s.team, "kind": format!("{:?}", s.kind).to_lowercase(), "unit": s.unit.name(), "name": s.name, "radius": s.spec.radius, "ranged": s.spec.ranged(), "captain": s.kind == Kind::Captain, "face": s.face })
            })
            .collect();
        Value::Array(out).to_string()
    }

    /// Where a front drawn along `line_json` (`[{x,y}...]`, as the input would send it) would put `team`'s companies,
    /// without ordering anything (04-battle.md §4 "Preview while drawing"): `{tap, fight, face, bars: [{id, x, y,
    /// face, files, len, role}], captain: {x, y} | null}`. `tap` is a line too short to be a front (the army
    /// marches to its middle, `march`). Undefined when the side has no captain.
    pub fn plan_front_preview(&self, team: u8, line_json: &str) -> Result<Option<String>, JsError> {
        let line: Vec<P> = serde_json::from_str(line_json)?;
        Ok(preview_front(&self.inner, team, &line).map(|p| p.to_json().to_string()))
    }
}

fn pt(p: P) -> Value {
    json!([p.x, p.y])
}

/// Company `j`'s order as the marks draw it.
fn order_json(b: &Sim, j: usize) -> Value {
    let s = &b.squads[j];
    let mut o = json!({
        "id": j,
        "order": s.order.name(),
        "state": s.state.name(),
        "detached": s.detached,
        "reserve": s.reserve.is_some(),
        "working": s.working,
        "c": pt(b.centre(j)),
        "via": s.order.via().iter().map(|&p| pt(p)).collect::<Vec<_>>(),
    });
    let m = o.as_object_mut().expect("an object");
    let mut to: Option<P> = None;
    match &s.order {
        Order::Hold { .. } => to = s.detached.then_some(s.post),
        Order::Move { to: t, fight, .. } => {
            to = Some(*t);
            m.insert("fight".into(), json!(fight));
        }
        Order::Attack { target, .. } | Order::Charge { target } => {
            to = b.squads.get(*target as usize).map(|_| b.centre(*target as usize));
            m.insert("target".into(), json!(target));
        }
        Order::Take { site, .. } => {
            to = b.map.sites.get(*site as usize).map(|x| x.at);
            m.insert("site".into(), json!(site));
        }
        Order::Guard { ward } | Order::Screen { ward, .. } => {
            to = b.squads.get(*ward as usize).map(|_| b.centre(*ward as usize));
            m.insert("ward".into(), json!(ward));
        }
        Order::Withdraw { to: t } | Order::Regroup { to: t } => to = Some(*t),
        Order::Build { at, work } => {
            to = Some(*at);
            m.insert("work".into(), json!(work));
        }
        Order::Recall { .. } => to = b.captain_at(s.team),
        Order::Follow | Order::Retreat | Order::Ride => {}
    }
    if let Some(p) = to {
        m.insert("to".into(), pt(p));
    }
    // A detached company plants its order flag where its order points (01-flow.md §2 "What a tap does").
    m.insert("flag".into(), if s.detached { to.map_or(Value::Null, pt) } else { Value::Null });
    m.insert("waits".into(), Value::Array(s.queue.iter().map(|p| pending_json(b, s.team, p)).collect()));
    o
}

/// A waiting deed (08-orders.md §6) and the point its faint mark goes to.
fn pending_json(b: &Sim, team: Team, p: &Pending) -> Value {
    json!({
        "when": serde_json::to_value(&p.when).unwrap_or(Value::Null),
        "deed": serde_json::to_value(&p.deed).unwrap_or(Value::Null),
        "text": sim::text::format(&p.deed),
        "signalled": p.signalled,
        "to": deed_point(b, team, &p.deed).map_or(Value::Null, pt),
    })
}

/// Where a deed points, for its mark: its place, its target's centre, its site, its front's middle.
fn deed_point(b: &Sim, team: Team, d: &Deed) -> Option<P> {
    let centre = |id: u16| b.squads.get(id as usize).map(|_| b.centre(id as usize));
    match d {
        Deed::Move { to, .. } => Some(*to),
        Deed::Attack { target, .. } => centre(*target),
        Deed::Charge { target, .. } | Deed::Commit { target, .. } => target.and_then(centre),
        Deed::Take { site, .. } => b.map.sites.get(*site as usize).map(|s| s.at),
        Deed::Front { line } => line.get(line.len() / 2).copied(),
        Deed::Guard { ward, .. } | Deed::Screen { ward, .. } => centre(*ward),
        Deed::Withdraw { to, .. } => *to,
        Deed::Build { at, .. } => Some(*at),
        Deed::Recall { .. } | Deed::Rally => b.captain_at(team),
        Deed::With { deed, .. } | Deed::Wait { deed, .. } => deed_point(b, team, deed),
        _ => None,
    }
}

// ------------------------------------------------------------------------------------------- the front's preview

/// What a company is in a front (04-battle.md §4): the line, the bows behind it, the horse on its ends, the reserve.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Role {
    Line,
    Bows,
    Horse,
    Reserve,
}

impl Role {
    fn name(self) -> &'static str {
        match self {
            Role::Line => "line",
            Role::Bows => "bows",
            Role::Horse => "horse",
            Role::Reserve => "reserve",
        }
    }
}

/// One company's bar in the preview: where its anchor (the middle of its front rank) will stand, facing, and its
/// frontage.
#[derive(Clone, Debug, PartialEq)]
pub struct Bar {
    pub id: usize,
    pub at: P,
    pub face: f64,
    pub files: Option<u16>,
    /// The bar's length in tiles (04-battle.md §4: files × file gap for the line, 3 for bows, 2.2 for horse, 4.2
    /// for a beast).
    pub len: f64,
    role: Role,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Preview {
    /// Under the front's length: a tap, the army marching to `march`.
    pub tap: bool,
    pub march: Option<P>,
    /// Drawn toward the threat: it fights and the captain rides.
    pub fight: bool,
    pub face: f64,
    pub bars: Vec<Bar>,
    /// The captain's spot behind the line (where he would stand; when the line fights he rides from there).
    pub captain: Option<P>,
}

impl Preview {
    fn to_json(&self) -> Value {
        let bars: Vec<Value> = self
            .bars
            .iter()
            .map(|r| json!({ "id": r.id, "x": r.at.x, "y": r.at.y, "face": r.face, "files": r.files, "len": r.len, "role": r.role.name() }))
            .collect();
        json!({
            "tap": self.tap,
            "march": self.march.map(|p| json!({ "x": p.x, "y": p.y })),
            "fight": self.fight,
            "face": self.face,
            "bars": bars,
            "captain": self.captain.map(|p| json!({ "x": p.x, "y": p.y })),
        })
    }
}

/// The arc-length parametrised polyline of a front (as the sim's `planFront` reads it).
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

    fn tangent(&self, s: f64, span: f64) -> P {
        let (a, b) = (self.at(s - span), self.at(s + span));
        let d = a.dist(b);
        if d > 1e-9 { P::new((b.x - a.x) / d, (b.y - a.y) / d) } else { P::new(1.0, 0.0) }
    }
}

fn role(b: &Sim, i: usize) -> Role {
    let s = &b.squads[i];
    if s.freed || s.reserve.is_some() {
        Role::Reserve
    } else if s.spec.ranged() {
        Role::Bows
    } else if s.kind == Kind::Horse || s.spec.pack || s.spec.beast && s.team == 0 {
        Role::Horse
    } else {
        Role::Line
    }
}

/// 04-battle.md §4's bar lengths, tiles: archers 3, horse 2.2, a beast 4.2, the line its files × the file gap.
const BAR_BOWS: f64 = 3.0;
const BAR_HORSE: f64 = 2.2;
const BAR_BEAST: f64 = 4.2;
/// A foot company in the reserve keeps its own frontage: drawn as 02-look.md §7's spear-and-shield bar.
const BAR_FOOT: f64 = 3.0;

/// The sim's `planFront` (crates/sim/src/battle/front.rs) computed without ordering anything: the same spots,
/// facings and frontages, checked against the real thing by `preview_matches_the_front_obeyed` below.
pub fn preview_front(b: &Sim, team: Team, line: &[P]) -> Option<Preview> {
    let cap = b.captain_of(team)?;
    let ft = &b.tune.front;
    let gap = b.tune.movement.file_gap;
    let poly = Poly::new(line);
    if poly.pts.is_empty() {
        return None;
    }
    let len = poly.len();
    if len < ft.tap {
        return Some(Preview { tap: true, march: Some(b.open_near(poly.at(len / 2.0))), fight: false, face: 0.0, bars: Vec::new(), captain: None });
    }
    let mid = poly.at(len / 2.0);
    let threat = b.threat_point(team, mid);
    let (p0, p1) = (poly.pts[0], poly.pts[poly.pts.len() - 1]);
    let chord = P::new(p1.x - p0.x, p1.y - p0.y);
    let cl = (chord.x * chord.x + chord.y * chord.y).sqrt().max(1e-9);
    let tan = P::new(chord.x / cl, chord.y / cl);
    let mut n = P::new(-tan.y, tan.x);
    if (threat.x - mid.x) * n.x + (threat.y - mid.y) * n.y < 0.0 {
        n = P::new(-n.x, -n.y);
    }
    let face = atan2(n.y, n.x);
    let companies: Vec<usize> = (0..b.squads.len())
        .filter(|&i| b.squads[i].team == team && b.squads[i].standing() && b.squads[i].kind != Kind::Captain && b.squads[i].alive > 0)
        .collect();
    let centroid = {
        let all: Vec<usize> = companies.iter().copied().chain(std::iter::once(cap)).collect();
        let k = all.len() as f64;
        let (x, y) = all.iter().fold((0.0, 0.0), |(x, y), &i| (x + b.centre(i).x, y + b.centre(i).y));
        P::new(x / k, y / k)
    };
    let fight = (mid.x - centroid.x) * n.x + (mid.y - centroid.y) * n.y > 0.0;
    let along = |i: usize| {
        let c = b.centre(i);
        (c.x - p0.x) * tan.x + (c.y - p0.y) * tan.y
    };
    let by_side = |ids: &mut Vec<usize>| ids.sort_by(|&x, &y| along(x).total_cmp(&along(y)).then(x.cmp(&y)));
    let mut roles: Vec<(usize, Role)> = companies.iter().map(|&i| (i, role(b, i))).collect();
    let has = |roles: &[(usize, Role)], r: Role| roles.iter().any(|&(_, x)| x == r);
    if !has(&roles, Role::Line) {
        let fill = if has(&roles, Role::Bows) { Role::Bows } else { Role::Horse };
        for r in roles.iter_mut().filter(|r| r.1 == fill) {
            r.1 = Role::Line;
        }
    }
    let pick = |r: Role| -> Vec<usize> { roles.iter().filter(|x| x.1 == r).map(|x| x.0).collect() };
    let (mut melee, mut bows, mut horse, mut reserve) = (pick(Role::Line), pick(Role::Bows), pick(Role::Horse), pick(Role::Reserve));
    by_side(&mut melee);
    by_side(&mut bows);
    by_side(&mut horse);
    by_side(&mut reserve);
    let kind_len = |i: usize| {
        let s = &b.squads[i];
        if s.spec.beast {
            BAR_BEAST
        } else if s.kind == Kind::Horse {
            BAR_HORSE
        } else if s.spec.ranged() {
            BAR_BOWS
        } else {
            BAR_FOOT
        }
    };
    let mut bars: Vec<Bar> = Vec::new();
    let seg = len / melee.len().max(1) as f64;
    for (k, &i) in melee.iter().enumerate() {
        let s = (k as f64 + 0.5) * seg;
        let t = poly.tangent(s, ft.tangent);
        let mut ni = P::new(-t.y, t.x);
        if ni.x * n.x + ni.y * n.y < 0.0 {
            ni = P::new(-ni.x, -ni.y);
        }
        let men = b.squads[i].alive.saturating_sub(b.squads[i].leader.is_some() as u16).max(1);
        let hi = ((men as f64 / 2.0).ceil() as u16).max(2);
        let files = ((seg / gap).floor() as u16).min(hi).max(ft.min_files);
        // A beast or horse filling the line keeps its own bar; the line's length is its files.
        let len = if b.squads[i].spec.beast || b.squads[i].kind == Kind::Horse { kind_len(i) } else { files as f64 * gap };
        bars.push(Bar { id: i, at: poly.at(s), face: atan2(ni.y, ni.x), files: Some(files), len, role: Role::Line });
    }
    let behind = |d: f64, lateral: f64| P::new(mid.x - n.x * d + tan.x * lateral, mid.y - n.y * d + tan.y * lateral);
    let nb = bows.len() as f64;
    for (k, &i) in bows.iter().enumerate() {
        bars.push(Bar { id: i, at: behind(ft.bows_back, (k as f64 - (nb - 1.0) / 2.0) * ft.bows_gap), face, files: None, len: kind_len(i), role: Role::Bows });
    }
    let half = nb.max(1.0) * ft.bows_gap / 2.0;
    for (k, &i) in reserve.iter().enumerate() {
        let side = if k % 2 == 0 { -1.0 } else { 1.0 };
        let at = behind(ft.reserve_back, side * (half + ft.bows_gap / 2.0 + ft.bows_gap * (k / 2) as f64));
        bars.push(Bar { id: i, at, face, files: None, len: kind_len(i), role: Role::Reserve });
    }
    let (start, end) = (poly.at(0.0), poly.at(len));
    let (t0, t1) = (poly.tangent(0.0, ft.tangent), poly.tangent(len, ft.tangent));
    let near_end = horse.len() == 1 && along(horse[0]) > len / 2.0;
    for (k, &i) in horse.iter().enumerate() {
        let beyond = ft.horse_beyond + ft.horse_step * (k / 2) as f64 + if b.squads[i].spec.beast { ft.beast_beyond } else { 0.0 };
        let at_end = (k % 2 == 1) != near_end;
        let at = if at_end {
            P::new(end.x + t1.x * beyond - n.x * ft.horse_back, end.y + t1.y * beyond - n.y * ft.horse_back)
        } else {
            P::new(start.x - t0.x * beyond - n.x * ft.horse_back, start.y - t0.y * beyond - n.y * ft.horse_back)
        };
        bars.push(Bar { id: i, at, face, files: None, len: kind_len(i), role: Role::Horse });
    }
    for r in bars.iter_mut() {
        r.at = b.open_near(r.at);
    }
    let back = if bows.is_empty() { ft.captain_back_no_bows } else { ft.captain_back };
    Some(Preview { tap: false, march: None, fight, face, bars, captain: Some(b.open_near(behind(back, 0.0))) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim::contracts::{Command, Source, Who};
    use sim::map::{MapKind, MapOpts};

    fn battle(kind: MapKind, army: &str) -> Sim {
        crate::compat::muster(4, MapOpts { kind, width: 48 }, army).unwrap()
    }

    fn front(b: &mut Sim, line: &[P]) {
        b.apply(Command { tick: b.tick, team: 0, deed: Deed::Front { line: line.to_vec() }, src: Source::Line, note: None });
        b.flush();
    }

    /// Lines across the army's way, toward and away from the foe, straight and bent, on both armies: every bar the
    /// preview draws is exactly where the obeyed front sends that company, facing the same way with the same files.
    #[test]
    fn preview_matches_the_front_obeyed() {
        let mut checked = 0;
        for (kind, army) in [(MapKind::Keep, "default"), (MapKind::Keep, "big"), (MapKind::Field, "big"), (MapKind::Ford, "default")] {
            let base = battle(kind, army);
            let cap = base.captain_at(0).unwrap();
            let lines: Vec<Vec<P>> = vec![
                vec![P::new(cap.x + 4.0, cap.y - 6.0), P::new(cap.x + 4.0, cap.y + 6.0)],
                vec![P::new(cap.x - 3.0, cap.y - 3.0), P::new(cap.x - 1.0, cap.y), P::new(cap.x - 3.0, cap.y + 4.0)],
                vec![P::new(cap.x + 8.0, cap.y - 2.0), P::new(cap.x + 9.0, cap.y + 1.0)],
                vec![P::new(cap.x + 6.0, cap.y + 0.2), P::new(cap.x + 6.5, cap.y + 0.4)],
            ];
            for line in lines {
                let mut b = battle(kind, army);
                b.step(20);
                let p = preview_front(&b, 0, &line).expect("a captain");
                front(&mut b, &line);
                if p.tap {
                    let c = b.captain_of(0).unwrap();
                    let Order::Move { to, .. } = b.squads[c].order else { panic!("a tap marches the army") };
                    assert_eq!(Some(to), p.march);
                    checked += 1;
                    continue;
                }
                for bar in &p.bars {
                    let s = &b.squads[bar.id];
                    let Order::Move { to, face, fight, .. } = s.order else { panic!("{} not moving: {:?}", bar.id, s.order) };
                    assert_eq!(to, bar.at, "squad {} spot", bar.id);
                    assert_eq!(face, Some(bar.face), "squad {} facing", bar.id);
                    assert_eq!(s.files, bar.files, "squad {} files", bar.id);
                    assert_eq!(fight, p.fight);
                    checked += 1;
                }
                let c = b.captain_of(0).unwrap();
                match b.squads[c].order {
                    Order::Ride => assert!(p.fight, "the captain rides only toward the threat"),
                    Order::Move { to, .. } => assert_eq!(Some(to), p.captain),
                    ref o => panic!("captain {o:?}"),
                }
                assert_eq!(p.bars.len(), b.squads.iter().filter(|s| s.team == 0 && s.kind != Kind::Captain && s.standing()).count());
            }
        }
        println!("front preview: {checked} bars and taps match the obeyed front");
        assert!(checked > 20);
    }

    /// The orders as the marks read them: a detached company's flag is its order's point; army waits are listed.
    #[test]
    fn orders_name_the_flag_and_the_waits() {
        let mut b = crate::Battle { inner: battle(MapKind::Keep, "default"), frame: crate::frame::Frame::new(&battle(MapKind::Keep, "default")), bots: [None, None] };
        let id = b.inner.squads.iter().position(|s| s.team == 0 && s.kind == Kind::Spear).unwrap() as u16;
        let cap = b.inner.captain_at(0).unwrap();
        let to = P::new(cap.x + 3.0, cap.y + 2.0);
        b.inner.apply(Command { tick: 0, team: 0, deed: Deed::Move { who: Who::Squad { id }, to, via: vec![], fight: false, face: None }, src: Source::Tap, note: None });
        let wait = Deed::Wait { until: sim::contracts::When::Signal { n: 0 }, deed: Box::new(Deed::Hold { who: Who::Army }) };
        b.inner.apply(Command { tick: 0, team: 0, deed: wait, src: Source::Voice, note: None });
        b.flush();
        let v: Value = serde_json::from_str(&b.orders_json(0)).unwrap();
        let sq = v["squads"].as_array().unwrap().iter().find(|s| s["id"] == id as u64).unwrap();
        assert_eq!(sq["order"], "move");
        assert_eq!(sq["detached"], true);
        assert_eq!(sq["flag"], json!([to.x, to.y]));
        assert_eq!(v["army"].as_array().unwrap().len(), 1);
        assert_eq!(v["army"][0]["when"]["on"], "signal");
        assert_eq!(v["army"][0]["deed"]["do"], "hold");
        let sites: Value = serde_json::from_str(&b.sites_json()).unwrap();
        assert!(!sites["sites"].as_array().unwrap().is_empty());
        println!("orders: squad {id} flag at {:?}; army waits {}", sq["flag"], v["army"]);
    }
}
