//! Text commands that mirror the marks and the order language (docs/spec/01-flow.md §8; 08-orders.md §3–§7), for
//! the harness and typed orders. `format` writes a deed back as the same text, so `parse(format(d)) == d`.
//!
//! The spec's seven:
//! `march X Y [fight] [via X Y]… [face A]` · `send WHO X Y [fight] [via X Y]… [face A]` · `attack WHO FOE [via X Y]…` ·
//! `take WHO SITE [via X Y]…` · `front X1 Y1 X2 Y2 …` · `hold [WHO]` · `recall WHO` · `rally`.
//!
//! The order language:
//! - ways (`Set`): `stance WHO normal|aggressive|defensive|holdfire|skirmish` · `pace WHO walk|quick|double` ·
//!   `form WHO line|column|wedge|square|shieldwall|loose|tight` · `files WHO N` · `pursue WHO on|off` ·
//!   `priority WHO nearest|weakest|strongest|commander|UNIT|attacking:ID` · `set WHO KEY=VALUE…` (keys `stance`,
//!   `pace`, `form`, `files`, `pursue`, `priority`);
//! - `with KEY=VALUE… COMMAND`: the command carried out with those modifiers;
//! - `wait TRIGGER COMMAND` with TRIGGER `done` · `signal N` · `after S` · `near X Y R` · `breaks ID` · `captain` ·
//!   `nightfall` · `dawn`; `then COMMAND` is `wait done COMMAND`; `signal [N]` gives the signal (0 when none);
//! - `guard WHO WARD` · `screen WHO WARD [from FOE]` · `charge WHO [FOE]` · `withdraw WHO [X Y]` · `regroup WHO` ·
//!   `reserve WHO` · `commit WHO [FOE]` · `face WHO A` · `advance` · `build WHO stakes|barricade|bridge|watchtower X Y
//!   [A]`;
//! - or a deed as JSON.
//!
//! WHO is `army`, a squad id, a commander's name, or several joined by `+` (`WIL+ODA`, `1+2`); FOE is a squad id,
//! optionally written `E<id>`; WARD a squad id or name (`me` is the captain); A an angle in radians,
//! `atan2(dy, dx)` (y south).

use crate::battle::Battle;
use crate::contracts::{Deed, How, Kind, P, Pace, Priority, Shape, SquadId, Stance, Team, When, Who, Work};
use crate::units::Unit;

pub fn parse(b: &Battle, team: Team, text: &str) -> Result<Deed, String> {
    let text = text.trim();
    if text.starts_with('{') {
        return serde_json::from_str(text).map_err(|e| format!("deed JSON: {e}"));
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    deed(b, team, &words)
}

/// A cursor over the words after the verb.
struct Args<'a> {
    verb: String,
    words: &'a [&'a str],
    at: usize,
}

impl<'a> Args<'a> {
    fn next(&mut self) -> Result<&'a str, String> {
        let w = self.words.get(self.at).copied().ok_or_else(|| format!("{}: missing argument {}", self.verb, self.at + 1))?;
        self.at += 1;
        Ok(w)
    }

    fn peek(&self) -> Option<&'a str> {
        self.words.get(self.at).copied()
    }

    fn eat(&mut self, word: &str) -> bool {
        if self.peek().is_some_and(|w| w.eq_ignore_ascii_case(word)) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn num(&mut self) -> Result<f64, String> {
        number(self.next()?)
    }

    fn point(&mut self) -> Result<P, String> {
        Ok(P::new(self.num()?, self.num()?))
    }

    fn rest(&self) -> &'a [&'a str] {
        &self.words[self.at..]
    }

    fn done(&self) -> Result<(), String> {
        match self.peek() {
            None => Ok(()),
            Some(w) => Err(format!("{}: unexpected {w}", self.verb)),
        }
    }

    /// `[via X Y]…`
    fn via(&mut self) -> Result<Vec<P>, String> {
        let mut via = Vec::new();
        while self.eat("via") {
            via.push(self.point()?);
        }
        Ok(via)
    }
}

fn deed(b: &Battle, team: Team, words: &[&str]) -> Result<Deed, String> {
    let Some((verb, rest)) = words.split_first() else {
        return Err("empty command".into());
    };
    let verb = verb.to_ascii_lowercase();
    let mut a = Args { verb: verb.clone(), words: rest, at: 0 };
    let deed = match verb.as_str() {
        "march" | "send" => {
            let who = if verb == "march" { Who::Army } else { who(b, team, a.next()?)? };
            let to = a.point()?;
            let fight = a.eat("fight");
            let via = a.via()?;
            let face = if a.eat("face") { Some(a.num()?) } else { None };
            Deed::Move { who, to, via, fight, face }
        }
        "attack" => {
            let who = who(b, team, a.next()?)?;
            let target = foe(a.next()?)?;
            Deed::Attack { who, target, via: a.via()? }
        }
        "take" => {
            let who = who(b, team, a.next()?)?;
            let site = id(a.next()?)?;
            Deed::Take { who, site, via: a.via()? }
        }
        "front" => {
            if rest.len() < 4 || rest.len() % 2 == 1 {
                return Err("front: give two or more x y pairs".into());
            }
            let line = rest.chunks(2).map(|c| Ok(P::new(number(c[0])?, number(c[1])?))).collect::<Result<_, String>>()?;
            a.at = rest.len();
            Deed::Front { line }
        }
        "hold" => Deed::Hold { who: if a.peek().is_some() { who(b, team, a.next()?)? } else { Who::Army } },
        "recall" => match who(b, team, a.next()?)? {
            Who::Squad { id } => Deed::Recall { id },
            Who::Army | Who::Squads { .. } => return Err("recall: name a company".into()),
        },
        "rally" => Deed::Rally,
        "stance" | "pace" | "form" | "files" | "pursue" | "priority" => {
            let who = who(b, team, a.next()?)?;
            let mut how = How::default();
            set_key(&mut how, &verb, a.next()?)?;
            Deed::Set { who, how }
        }
        "set" => {
            let who = who(b, team, a.next()?)?;
            let how = keys(&mut a)?;
            if how == How::default() {
                return Err("set: give KEY=VALUE".into());
            }
            Deed::Set { who, how }
        }
        "with" => {
            let how = keys(&mut a)?;
            let inner = deed(b, team, a.rest())?;
            a.at = rest.len();
            Deed::With { how, deed: Box::new(inner) }
        }
        "wait" | "then" => {
            let until = if verb == "then" { When::Done } else { trigger(&mut a)? };
            let inner = deed(b, team, a.rest())?;
            a.at = rest.len();
            Deed::Wait { until, deed: Box::new(inner) }
        }
        "signal" => Deed::Signal { n: if a.peek().is_some() { a.next()?.parse().map_err(|_| "signal: a number 0–255".to_string())? } else { 0 } },
        "guard" => Deed::Guard { who: who(b, team, a.next()?)?, ward: ward(b, team, a.next()?)? },
        "screen" => {
            let who = who(b, team, a.next()?)?;
            let ward = ward(b, team, a.next()?)?;
            let from = if a.eat("from") { Some(foe(a.next()?)?) } else { None };
            Deed::Screen { who, ward, from }
        }
        "charge" => Deed::Charge { who: who(b, team, a.next()?)?, target: if a.peek().is_some() { Some(foe(a.next()?)?) } else { None } },
        "withdraw" => Deed::Withdraw { who: who(b, team, a.next()?)?, to: if a.peek().is_some() { Some(a.point()?) } else { None } },
        "regroup" => Deed::Regroup { who: who(b, team, a.next()?)? },
        "reserve" => Deed::Reserve { who: who(b, team, a.next()?)? },
        "commit" => Deed::Commit { who: who(b, team, a.next()?)?, target: if a.peek().is_some() { Some(foe(a.next()?)?) } else { None } },
        "face" => Deed::Face { who: who(b, team, a.next()?)?, face: a.num()? },
        "advance" => Deed::Advance,
        "build" => {
            let who = who(b, team, a.next()?)?;
            let work = match a.next()?.to_ascii_lowercase().as_str() {
                "stakes" => Work::Stakes,
                "barricade" => Work::Barricade,
                "bridge" => Work::Bridge,
                "watchtower" | "tower" => Work::Watchtower,
                other => return Err(format!("build: no work {other} (stakes, barricade, bridge, watchtower)")),
            };
            let at = a.point()?;
            let face = if a.peek().is_some() { a.num()? } else { 0.0 };
            Deed::Build { who, work, at, face }
        }
        other => return Err(format!("unknown command: {other}")),
    };
    a.done()?;
    Ok(deed)
}

/// `KEY=VALUE` words at the cursor, merged into one `How`.
fn keys(a: &mut Args) -> Result<How, String> {
    let mut how = How::default();
    while let Some((k, v)) = a.peek().and_then(|w| w.split_once('=')) {
        set_key(&mut how, &k.to_ascii_lowercase(), v)?;
        a.at += 1;
    }
    Ok(how)
}

fn set_key(h: &mut How, key: &str, v: &str) -> Result<(), String> {
    let v = v.to_ascii_lowercase();
    match key {
        "stance" => {
            h.stance = Some(match v.as_str() {
                "normal" | "fireatwill" | "fire_at_will" => Stance::Normal,
                "aggressive" => Stance::Aggressive,
                "defensive" | "holdground" | "hold_ground" => Stance::Defensive,
                "holdfire" | "hold_fire" => Stance::HoldFire,
                "skirmish" => Stance::Skirmish,
                _ => return Err(format!("stance: no {v} (normal, aggressive, defensive, holdfire, skirmish)")),
            })
        }
        "pace" => {
            h.pace = Some(match v.as_str() {
                "walk" => Pace::Walk,
                "quick" => Pace::Quick,
                "double" => Pace::Double,
                _ => return Err(format!("pace: no {v} (walk, quick, double)")),
            })
        }
        "form" | "shape" => {
            h.shape = Some(match v.as_str() {
                "line" => Shape::Line,
                "column" => Shape::Column,
                "wedge" => Shape::Wedge,
                "square" | "ring" => Shape::Square,
                "shieldwall" | "shield_wall" => Shape::ShieldWall,
                "loose" => Shape::Loose,
                "tight" => Shape::Tight,
                _ => return Err(format!("form: no {v} (line, column, wedge, square, shieldwall, loose, tight)")),
            })
        }
        "files" => h.files = Some(v.parse().map_err(|_| format!("files: not a number: {v}"))?),
        "pursue" => {
            h.pursue = Some(match v.as_str() {
                "on" | "yes" | "true" => true,
                "off" | "no" | "false" => false,
                _ => return Err(format!("pursue: on or off, not {v}")),
            })
        }
        "priority" => {
            h.priority = Some(match v.as_str() {
                "nearest" => Priority::Nearest,
                "weakest" | "shaken" => Priority::Weakest,
                "strongest" => Priority::Strongest,
                "commander" | "broodlord" => Priority::Commander,
                other => match other.strip_prefix("attacking:") {
                    Some(id) => Priority::Attacking { squad: foe_or_own(id)? },
                    None => Priority::Unit { unit: Unit::parse(other).ok_or_else(|| format!("priority: no {other} (nearest, weakest, strongest, commander, attacking:ID, or a unit)"))?.id() },
                },
            })
        }
        _ => return Err(format!("no modifier {key} (stance, pace, form, files, pursue, priority)")),
    }
    Ok(())
}

fn trigger(a: &mut Args) -> Result<When, String> {
    Ok(match a.next()?.to_ascii_lowercase().as_str() {
        "done" => When::Done,
        "signal" => When::Signal { n: a.next()?.parse().map_err(|_| "wait signal: a number 0–255".to_string())? },
        "after" => When::After { s: a.num()? },
        "near" => When::EnemyNear { at: a.point()?, r: a.num()? },
        "breaks" => When::Breaks { squad: foe_or_own(a.next()?)? },
        "captain" => When::CaptainAttacked,
        "nightfall" | "night" => When::Nightfall,
        "dawn" => When::Dawn,
        other => return Err(format!("wait: no trigger {other} (done, signal N, after S, near X Y R, breaks ID, captain, nightfall, dawn)")),
    })
}

pub fn format(deed: &Deed) -> String {
    let who = |w: &Who| match w {
        Who::Army => "army".to_string(),
        Who::Squad { id } => id.to_string(),
        Who::Squads { ids } => ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join("+"),
    };
    let fight = |f: bool| if f { " fight" } else { "" };
    let via = |v: &[P]| v.iter().map(|p| format!(" via {} {}", p.x, p.y)).collect::<String>();
    let face = |f: &Option<f64>| f.map_or(String::new(), |a| format!(" face {a}"));
    match deed {
        Deed::Move { who: Who::Army, to, fight: f, via: v, face: a } => format!("march {} {}{}{}{}", to.x, to.y, fight(*f), via(v), face(a)),
        Deed::Move { who: w, to, fight: f, via: v, face: a } => format!("send {} {} {}{}{}{}", who(w), to.x, to.y, fight(*f), via(v), face(a)),
        Deed::Attack { who: w, target, via: v } => format!("attack {} E{target}{}", who(w), via(v)),
        Deed::Take { who: w, site, via: v } => format!("take {} {site}{}", who(w), via(v)),
        Deed::Front { line } => {
            let pts: Vec<String> = line.iter().map(|p| format!("{} {}", p.x, p.y)).collect();
            format!("front {}", pts.join(" "))
        }
        Deed::Hold { who: w } => format!("hold {}", who(w)),
        Deed::Recall { id } => format!("recall {id}"),
        Deed::Rally => "rally".into(),
        Deed::Set { who: w, how } => {
            let kv = how_keys(how);
            match kv.as_slice() {
                [(k, v)] => format!("{k} {} {v}", who(w)),
                _ => format!("set {} {}", who(w), kv.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(" ")),
            }
        }
        Deed::With { how, deed } => {
            let kv: Vec<String> = how_keys(how).iter().map(|(k, v)| format!("{k}={v}")).collect();
            if kv.is_empty() { format(deed) } else { format!("with {} {}", kv.join(" "), format(deed)) }
        }
        Deed::Wait { until, deed } => {
            let t = match until {
                When::Done => "done".to_string(),
                When::Signal { n } => format!("signal {n}"),
                When::After { s } => format!("after {s}"),
                When::EnemyNear { at, r } => format!("near {} {} {r}", at.x, at.y),
                When::Breaks { squad } => format!("breaks {squad}"),
                When::CaptainAttacked => "captain".into(),
                When::Nightfall => "nightfall".into(),
                When::Dawn => "dawn".into(),
            };
            format!("wait {t} {}", format(deed))
        }
        Deed::Signal { n } => format!("signal {n}"),
        Deed::Guard { who: w, ward } => format!("guard {} {ward}", who(w)),
        Deed::Screen { who: w, ward, from } => format!("screen {} {ward}{}", who(w), from.map_or(String::new(), |f| format!(" from E{f}"))),
        Deed::Charge { who: w, target } => format!("charge {}{}", who(w), target.map_or(String::new(), |t| format!(" E{t}"))),
        Deed::Withdraw { who: w, to } => format!("withdraw {}{}", who(w), to.map_or(String::new(), |p| format!(" {} {}", p.x, p.y))),
        Deed::Regroup { who: w } => format!("regroup {}", who(w)),
        Deed::Reserve { who: w } => format!("reserve {}", who(w)),
        Deed::Commit { who: w, target } => format!("commit {}{}", who(w), target.map_or(String::new(), |t| format!(" E{t}"))),
        Deed::Face { who: w, face } => format!("face {} {face}", who(w)),
        Deed::Advance => "advance".into(),
        Deed::Build { who: w, work, at, face } => {
            let name = match work {
                Work::Stakes => "stakes",
                Work::Barricade => "barricade",
                Work::Bridge => "bridge",
                Work::Watchtower => "watchtower",
            };
            format!("build {} {name} {} {} {face}", who(w), at.x, at.y)
        }
    }
}

/// A `How`'s set fields as (key, value) words, in a fixed order.
fn how_keys(h: &How) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    if let Some(s) = h.stance {
        out.push((
            "stance",
            match s {
                Stance::Normal => "normal",
                Stance::Aggressive => "aggressive",
                Stance::Defensive => "defensive",
                Stance::HoldFire => "holdfire",
                Stance::Skirmish => "skirmish",
            }
            .to_string(),
        ));
    }
    if let Some(p) = h.pace {
        out.push(("pace", format!("{p:?}").to_ascii_lowercase()));
    }
    if let Some(s) = h.shape {
        out.push(("form", if s == Shape::ShieldWall { "shieldwall".into() } else { format!("{s:?}").to_ascii_lowercase() }));
    }
    if let Some(n) = h.files {
        out.push(("files", n.to_string()));
    }
    if let Some(p) = h.pursue {
        out.push(("pursue", if p { "on" } else { "off" }.to_string()));
    }
    if let Some(p) = h.priority {
        out.push((
            "priority",
            match p {
                Priority::Nearest => "nearest".to_string(),
                Priority::Weakest => "weakest".to_string(),
                Priority::Strongest => "strongest".to_string(),
                Priority::Commander => "commander".to_string(),
                Priority::Attacking { squad } => format!("attacking:{squad}"),
                Priority::Unit { unit } => Unit::ALL.get(unit as usize).map_or(format!("unit{unit}"), |u| u.name().to_string()),
            },
        ));
    }
    out
}

fn number(s: &str) -> Result<f64, String> {
    s.parse::<f64>().ok().filter(|v| v.is_finite()).ok_or_else(|| format!("not a number: {s}"))
}

fn id(s: &str) -> Result<u16, String> {
    s.parse().map_err(|_| format!("not an id: {s}"))
}

/// A foe's id: `6` or `E6`.
fn foe(s: &str) -> Result<SquadId, String> {
    id(s.trim_start_matches(['E', 'e']))
}

/// Any squad's id, ours or theirs (`E6` or `6`).
fn foe_or_own(s: &str) -> Result<SquadId, String> {
    foe(s)
}

/// A ward: a squad id or a company's name; `me` or `captain` is our captain.
fn ward(b: &Battle, team: Team, w: &str) -> Result<SquadId, String> {
    if w.eq_ignore_ascii_case("me") || w.eq_ignore_ascii_case("captain") {
        return b.squads.iter().find(|s| s.team == team && s.kind == Kind::Captain).map(|s| s.id).ok_or_else(|| "no captain".to_string());
    }
    match who(b, team, w)? {
        Who::Squad { id } => Ok(id),
        _ => Err(format!("name one company, not {w}")),
    }
}

fn who(b: &Battle, team: Team, w: &str) -> Result<Who, String> {
    if w.eq_ignore_ascii_case("army") || w.eq_ignore_ascii_case("everyone") {
        return Ok(Who::Army);
    }
    if w.contains('+') {
        let ids = w
            .split('+')
            .map(|part| match who(b, team, part)? {
                Who::Squad { id } => Ok(id),
                _ => Err(format!("{w}: name companies")),
            })
            .collect::<Result<Vec<_>, String>>()?;
        return Ok(Who::Squads { ids });
    }
    if let Ok(id) = w.parse::<SquadId>() {
        return Ok(Who::Squad { id });
    }
    b.squads
        .iter()
        .find(|s| s.team == team && s.name.eq_ignore_ascii_case(w))
        .map(|s| Who::Squad { id: s.id })
        .ok_or_else(|| format!("no company named {w}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::battle::Setup;
    use crate::map::{MapKind, MapOpts};
    use crate::tune::Tune;

    #[test]
    fn every_deed_reads_back_as_written() {
        let b = Battle::new(7, MapOpts { kind: MapKind::Field, width: 48 }, &Setup::field(), Tune::default());
        let lines = [
            "march 20 13.5",
            "march 20 13.5 fight via 15 10 face 0.5",
            "send 2 18 6 fight",
            "send 1+2 18 6",
            "attack 4 E6 via 12 3",
            "take 1 0",
            "front 14 8 14 19",
            "hold army",
            "hold 3",
            "recall 4",
            "rally",
            "stance 3 holdfire",
            "pace army double",
            "form 1 wedge",
            "form 2 shieldwall",
            "files 1 8",
            "pursue 4 off",
            "priority 4 archer",
            "priority 4 attacking:2",
            "set 1 stance=defensive form=line pursue=on priority=commander",
            "with stance=aggressive pace=double attack 4 E6",
            "wait signal 0 attack 4 E6",
            "wait done hold 1",
            "wait after 5.5 with pace=walk send 2 10 10",
            "wait near 20 13.5 4 charge 4",
            "wait breaks 2 commit army",
            "wait captain guard 1 0",
            "wait nightfall withdraw army",
            "wait dawn regroup 2",
            "signal 3",
            "guard 2 0",
            "screen 2 3 from E7",
            "screen 2 3",
            "charge 4 E6",
            "charge army",
            "withdraw army",
            "withdraw 1 10 12.5",
            "regroup 2",
            "reserve 2",
            "commit 2 E8",
            "commit army",
            "face 1 3.14",
            "advance",
            "build 1 stakes 20 13.5 0",
            "build 2 bridge 24 6.5 3.1",
        ];
        for line in lines {
            let d = parse(&b, 0, line).unwrap_or_else(|e| panic!("{line}: {e}"));
            let back = format(&d);
            assert_eq!(parse(&b, 0, &back).unwrap(), d, "{line} -> {back}");
            assert_eq!(back, line, "written back as given");
        }
        // Names, `then`, the defaults, and JSON.
        let named = parse(&b, 0, "stance REN holdfire").unwrap();
        assert_eq!(named, Deed::Set { who: Who::Squad { id: 3 }, how: How { stance: Some(Stance::HoldFire), ..How::default() } });
        assert_eq!(parse(&b, 0, "wait signal 0 attack BORS E6").unwrap(), parse(&b, 0, "wait signal 0 attack 4 E6").unwrap());
        assert_eq!(parse(&b, 0, "then hold WIL").unwrap(), parse(&b, 0, "wait done hold 1").unwrap());
        assert_eq!(parse(&b, 0, "signal").unwrap(), Deed::Signal { n: 0 });
        assert_eq!(parse(&b, 0, "guard ODA me").unwrap(), Deed::Guard { who: Who::Squad { id: 2 }, ward: 0 });
        assert_eq!(parse(&b, 0, "build WIL stakes 20 13.5").unwrap(), parse(&b, 0, "build 1 stakes 20 13.5 0").unwrap());
        let json = serde_json::to_string(&parse(&b, 0, "with stance=holdfire wait signal 2 charge REN+BORS E7").unwrap()).unwrap();
        assert_eq!(format(&parse(&b, 0, &json).unwrap()), "with stance=holdfire wait signal 2 charge 3+4 E7");
        for bad in ["stance REN calm", "wait soon hold 1", "build 1 moat 2 2", "march 1", "hold 1 2", "set 1"] {
            assert!(parse(&b, 0, bad).is_err(), "{bad}");
        }
        println!("text: {} commands read back as written; names, then, signal, me and JSON read; 6 bad lines refused", lines.len());
    }
}
