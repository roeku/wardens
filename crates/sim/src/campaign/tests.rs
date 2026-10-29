//! The campaign's checks, each printing its counts (AGENTS.md rule 4). The harness's `campaign --checks` runs the
//! same checks over many seeds with whole campaigns; these run a few, quickly.

use super::auto::{Policy, play};
use super::*;
use crate::bots::BotKind;
use crate::map::{MapKind, MapOpts, generate};

fn new(seed: u32) -> Campaign {
    Campaign::create(seed, &Opts::default(), Tune::default())
}

#[test]
fn the_same_seed_makes_the_same_campaign() {
    let (mut same, mut differ) = (0, 0);
    for seed in 1..=20 {
        same += usize::from(new(seed).save() == new(seed).save());
        differ += usize::from(new(seed).save() != new(seed + 1).save());
    }
    assert_eq!((same, differ), (20, 20));
    println!("campaign determinism: {same} of 20 seeds create alike, {differ} of 20 differ from the next seed");
}

#[test]
fn the_muster_offers_what_the_spec_says() {
    let (mut bands, mut seasoned, mut commanders, mut veterans) = (0, 0, 0, 0);
    for seed in 1..=50 {
        let c = new(seed);
        assert_eq!(c.bands.len(), 7, "3 more bands than banners");
        assert_eq!(c.commanders.len(), 6, "2 more commanders than banners");
        for b in &c.bands {
            let full = c.tune.unit_spec(b.unit).unwrap().men;
            assert_eq!((b.men, b.rank), if b.seasoned { (full - 2, 1) } else { (full, 0) });
            assert!(matches!(b.unit, Unit::Spear | Unit::Shield | Unit::Archer | Unit::Horse));
        }
        bands += c.bands.len();
        seasoned += c.bands.iter().filter(|b| b.seasoned).count();
        commanders += c.commanders.len();
        veterans += c.commanders.iter().filter(|m| m.veteran).count();
    }
    let share = seasoned as f64 / bands as f64;
    assert!((0.2..0.4).contains(&share), "seasoned share {share}");
    println!("muster: 50 seeds, {bands} bands ({seasoned} seasoned, {:.0}%), {commanders} commanders ({veterans} veterans)", share * 100.0);
}

#[test]
fn planting_swaps_stands_down_and_fills_the_banners() {
    let mut c = new(5);
    c.plant(0, 0).unwrap();
    c.plant(1, 0).unwrap();
    assert_eq!((c.bands[0].commander, c.commanders[0].band, c.commanders[1].band), (Some(1), None, Some(0)), "a swap with a free commander");
    c.plant(0, 1).unwrap();
    c.plant(0, 0).unwrap();
    assert_eq!((c.bands[0].commander, c.bands[1].commander, c.commanders[1].band), (Some(0), Some(1), Some(1)), "two planted commanders swap bands");
    c.plant(2, 2).unwrap();
    c.plant(3, 3).unwrap();
    assert!(c.plant(4, 4).is_err(), "a fifth company needs a fifth banner");
    assert!(c.set_out(0).is_ok(), "four banners, four companies: the warband sets out");
    assert_eq!(c.companies.len(), 4);
    let mut d = new(5);
    assert!(d.set_out(0).is_err(), "no setting out with empty banners");
    d.auto_muster().unwrap();
    d.stand_down(d.bands.iter().find_map(|b| b.commander).unwrap()).unwrap();
    assert!(d.set_out(0).is_err());
    println!("muster: plant, swap, stand down, the banner limit and set_out's checks hold (6 checks)");
}

#[test]
fn links_go_one_row_on_within_one_lane() {
    let (mut links, mut rows0) = (0, 0);
    for seed in 1..=50 {
        let c = new(seed);
        for p in &c.places {
            if p.step == 0 {
                assert_eq!(p.kind, PlaceKind::Holdfast, "row 0 is all holdfasts");
                rows0 += 1;
            }
            for &to in &p.links {
                let q = c.place(to).unwrap();
                if q.kind == PlaceKind::Keep {
                    assert_eq!(p.step + 1, 5);
                } else {
                    assert_eq!(q.step, p.step + 1);
                    assert!(q.lane.abs_diff(p.lane) <= 1, "lane {} to {}", p.lane, q.lane);
                }
                links += 1;
            }
        }
    }
    println!("road: 50 seeds, {links} links one row on within ±1 lane, {rows0} row-0 holdfasts");
}

#[test]
fn garrisons_follow_the_formula() {
    let mut c = new(9);
    c.auto_muster().unwrap();
    c.set_out(c.reachable()[0]).unwrap();
    let w = c.warband_worth();
    let mut n = 0;
    for p in c.places.clone().iter().filter(|p| p.kind.held()) {
        let g = c.garrison(p);
        let worth: f64 = g.iter().map(|k| k.men.unwrap() as f64 * c.tune.unit_spec(k.unit).unwrap().worth(&c.tune.rank, 0)).sum();
        let want = (0.80 + 0.075 * p.step as f64) * c.tune.campaign.warband_factor * w;
        let kinds = 3 + usize::from(p.step >= 2) + usize::from(p.step >= 4) + usize::from(p.kind == PlaceKind::Keep);
        assert_eq!(g.len(), kinds, "{:?} step {}", p.kind, p.step);
        assert!((worth / want - 1.0).abs() < 0.25, "worth {worth:.0} want {want:.0}");
        assert!(g.iter().all(|k| k.rank == (p.step / 3) as u8));
        n += 1;
    }
    println!("garrisons: {n} held places, kinds, rank and worth (share·factor·W = share·{:.0}) as the formula", c.tune.campaign.warband_factor * w);
}

#[test]
fn saves_round_trip_and_refuse_another_version() {
    let mut c = new(3);
    let mut phases = Vec::new();
    for _ in 0..3 {
        let s = c.save().unwrap();
        let d = Campaign::load(&s, Tune::default()).unwrap();
        assert_eq!(d.save().unwrap(), s);
        assert_eq!(d.state(), c.state());
        phases.push(c.phase.name());
        match c.phase {
            Phase::Muster if c.companies.is_empty() && c.bands.iter().all(|b| b.commander.is_none()) => c.auto_muster().unwrap(),
            Phase::Muster => c.set_out(c.reachable()[0]).unwrap(),
            _ => {}
        }
    }
    let mut v: serde_json::Value = serde_json::from_str(&c.save().unwrap()).unwrap();
    v["v"] = 2.into();
    assert!(Campaign::load(&v.to_string(), Tune::default()).is_err());
    c.arrive().unwrap();
    assert!(c.save().is_err(), "no saving during a battle");
    println!("saves: {} round trips ({phases:?}), a v2 save refused, none during a battle", phases.len());
}

#[test]
fn whole_campaigns_end_and_replay_alike() {
    let mut rows = Vec::new();
    for seed in [1, 2] {
        let a = play(seed, Policy::Bot(BotKind::Commander), &Tune::default(), true);
        let b = play(seed, Policy::Bot(BotKind::Commander), &Tune::default(), false);
        assert!(matches!(a.reason.as_str(), "keep taken" | "captain fell" | "warband gone"), "seed {seed}: {}", a.reason);
        assert_eq!((a.won, a.battles, a.men_lost, a.days), (b.won, b.battles, b.men_lost, b.days));
        for (phase, s) in &a.saves {
            let d = Campaign::load(s, Tune::default()).unwrap();
            assert_eq!(&d.save().unwrap(), s, "seed {seed} at {phase}");
        }
        rows.push(format!("seed {seed}: {} ({}) in {} battles, {} saves round-trip", if a.won { "won" } else { "lost" }, a.reason, a.battles, a.saves.len()));
    }
    println!("campaigns: {}", rows.join("; "));
}

#[test]
fn the_road_map_is_its_own_land() {
    let m = generate(4, MapOpts { kind: MapKind::Road, width: 48 });
    assert_eq!((m.w, m.h, m.kind), (119, 40, MapKind::Road));
    let c = new(4);
    assert_eq!(m.hash(), c.road_map().hash(), "generate(Road) is the campaign's road");
    let l = crate::land::make(&m);
    assert_eq!((l.map_w, l.map_h), (119, 40));
    let b = c.road_battle();
    assert_eq!((b.squads.len(), b.squads.iter().filter(|s| s.team == 1).count()), (8, 0), "the captain and 7 bands, no foe");
    let mut b = b;
    b.step(300);
    assert!(b.outcome().is_none(), "the road never ends");
    let mut c = c;
    c.auto_muster().unwrap();
    let to = c.reachable()[0];
    c.set_out(to).unwrap();
    let mut r = c.road_battle();
    assert_eq!(r.squads.len(), 1 + c.companies.len(), "the captain and the companies on the march");
    let goal = c.place(to).unwrap().at;
    r.apply(crate::contracts::Command {
        tick: 0,
        team: 0,
        deed: crate::contracts::Deed::Move { who: crate::contracts::Who::Army, to: goal, via: Vec::new(), fight: false, face: None },
        src: crate::contracts::Source::Tap,
        note: None,
    });
    r.step(30 * 40);
    let d = r.captain_at(0).unwrap().dist(goal);
    assert!(d < 3.0, "the column reached its place: {d:.1} away");
    println!(
        "road map: {}x{}, {} sites, land {}x{} texels, {} roads; the road battle ran 300 ticks undecided; the column marched to {} in 40 s ({d:.1} away)",
        m.w,
        m.h,
        m.sites.len(),
        l.tex_w(),
        l.tex_h(),
        l.roads.len(),
        c.place(to).unwrap().name
    );
}

#[test]
fn faces_reach_the_battle_and_old_setups_keep_none() {
    let mut c = new(6);
    c.auto_muster().unwrap();
    c.set_out(c.reachable()[0]).unwrap();
    c.arrive().unwrap();
    let f = c.battle().unwrap();
    let ours: Vec<u32> = f.battle.squads.iter().filter(|s| s.team == 0).map(|s| s.face).collect();
    assert!(ours.iter().all(|&x| x != 0), "every warband face is set: {ours:?}");
    assert_eq!(f.battle.squads[0].face, c.captain.face);
    let old = crate::battle::Battle::new(7, MapOpts { kind: MapKind::Keep, width: 48 }, &crate::battle::Setup::default(), Tune::default());
    assert!(old.squads.iter().all(|s| s.face == 0));
    println!("faces: {} warband squads carry their campaign face; {} squads of the old setup carry 0", ours.len(), old.squads.len());
}

#[test]
fn custom_battles_build_every_kind() {
    let mut n = 0;
    for kind in ["field", "night", "keep", "hold", "village", "ford"] {
        for size in [4, 6, 9] {
            for strength in ["easy", "fair", "hard"] {
                let json = format!(r#"{{"kind":"{kind}","size":{size},"strength":"{strength}","land":"any"}}"#);
                let c = custom::custom(11, &json, &Tune::default()).unwrap();
                let b = crate::battle::Battle::new(11, c.opts, &c.setup, c.tune);
                assert_eq!(b.squads.iter().filter(|s| s.team == 0 && s.kind != crate::contracts::Kind::Captain).count(), size);
                n += 1;
            }
        }
    }
    assert!(custom::custom(1, r#"{"kind":"siege"}"#, &Tune::default()).is_err());
    println!("custom battles: {n} kind × size × strength battles built; an unknown kind refused");
}
