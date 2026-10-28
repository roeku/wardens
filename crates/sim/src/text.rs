//! Text commands that mirror the marks (docs/spec/01-flow.md §8), for the harness and typed orders:
//!
//! `march X Y [fight]` · `send WHO X Y [fight]` · `attack WHO FOE` · `take WHO SITE` ·
//! `front X1 Y1 X2 Y2 …` · `hold [WHO]` · `recall WHO` · `rally`, or a deed as JSON.
//!
//! WHO is `army`, a squad id or a commander's name; FOE is a squad id, optionally written `E<id>`.

use crate::battle::Battle;
use crate::contracts::{Deed, P, SquadId, Team, Who};

pub fn parse(b: &Battle, team: Team, text: &str) -> Result<Deed, String> {
    let text = text.trim();
    if text.starts_with('{') {
        return serde_json::from_str(text).map_err(|e| format!("deed JSON: {e}"));
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    let Some((verb, args)) = words.split_first() else {
        return Err("empty command".into());
    };
    let arg = |i: usize| args.get(i).copied().ok_or_else(|| format!("{verb}: missing argument {}", i + 1));
    let fight = |i: usize| args.get(i).is_some_and(|w| w.eq_ignore_ascii_case("fight"));
    let deed = match verb.to_ascii_lowercase().as_str() {
        "march" => Deed::Move { who: Who::Army, to: point(arg(0)?, arg(1)?)?, via: Vec::new(), fight: fight(2), face: None },
        "send" => Deed::Move { who: who(b, team, arg(0)?)?, to: point(arg(1)?, arg(2)?)?, via: Vec::new(), fight: fight(3), face: None },
        "attack" => Deed::Attack { who: who(b, team, arg(0)?)?, target: id(arg(1)?.trim_start_matches(['E', 'e']))?, via: Vec::new() },
        "take" => Deed::Take { who: who(b, team, arg(0)?)?, site: id(arg(1)?)?, via: Vec::new() },
        "front" => {
            if args.len() < 4 || args.len() % 2 == 1 {
                return Err("front: give two or more x y pairs".into());
            }
            Deed::Front { line: args.chunks(2).map(|c| point(c[0], c[1])).collect::<Result<_, _>>()? }
        }
        "hold" => Deed::Hold { who: args.first().map_or(Ok(Who::Army), |w| who(b, team, w))? },
        "recall" => match who(b, team, arg(0)?)? {
            Who::Squad { id } => Deed::Recall { id },
            Who::Army => return Err("recall: name a company".into()),
        },
        "rally" => Deed::Rally,
        other => return Err(format!("unknown command: {other}")),
    };
    Ok(deed)
}

pub fn format(deed: &Deed) -> String {
    let who = |w: &Who| match w {
        Who::Army => "army".to_string(),
        Who::Squad { id } => id.to_string(),
    };
    let fight = |f: bool| if f { " fight" } else { "" };
    match deed {
        Deed::Move { who: Who::Army, to, fight: f, .. } => format!("march {} {}{}", to.x, to.y, fight(*f)),
        Deed::Move { who: w, to, fight: f, .. } => format!("send {} {} {}{}", who(w), to.x, to.y, fight(*f)),
        Deed::Attack { who: w, target, .. } => format!("attack {} E{target}", who(w)),
        Deed::Take { who: w, site, .. } => format!("take {} {site}", who(w)),
        Deed::Front { line } => {
            let pts: Vec<String> = line.iter().map(|p| format!("{} {}", p.x, p.y)).collect();
            format!("front {}", pts.join(" "))
        }
        Deed::Hold { who: w } => format!("hold {}", who(w)),
        Deed::Recall { id } => format!("recall {id}"),
        Deed::Rally => "rally".into(),
    }
}

fn point(x: &str, y: &str) -> Result<P, String> {
    let n = |s: &str| s.parse::<f64>().map_err(|_| format!("not a number: {s}"));
    Ok(P::new(n(x)?, n(y)?))
}

fn id(s: &str) -> Result<u16, String> {
    s.parse().map_err(|_| format!("not an id: {s}"))
}

fn who(b: &Battle, team: Team, w: &str) -> Result<Who, String> {
    if w.eq_ignore_ascii_case("army") {
        return Ok(Who::Army);
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
