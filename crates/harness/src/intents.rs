//! `harness intents`: the broodlord's intents carried out by the bots (docs/spec/06-voice.md §8), each check printing
//! its counts across seeds (`sim::bots::checks`).

/// Runs the checks whose name contains `filter` (all without one); fails if any fails.
pub fn run(filter: Option<String>) -> Result<(), String> {
    let (mut ran, mut failed) = (0, 0);
    for (name, check) in sim::bots::checks::ALL {
        if filter.as_ref().is_some_and(|f| !name.contains(f.as_str())) {
            continue;
        }
        let c = check();
        ran += 1;
        failed += (!c.pass) as usize;
        println!("{} {}: {}", if c.pass { "PASS" } else { "FAIL" }, c.name, c.counts);
    }
    println!("intents: {} of {ran} checks pass", ran - failed);
    if failed > 0 { Err(format!("{failed} intent checks failed")) } else { Ok(()) }
}
