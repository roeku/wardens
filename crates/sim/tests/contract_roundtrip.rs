//! The order language's JSON (08-orders) reads the same in Rust as the TypeScript contract writes it.

use sim::contracts::{Deed, How, Priority, Stance, When, Who};

#[test]
fn nested_deeds_round_trip() {
    let json = r#"{"do":"wait","until":{"on":"signal","n":0},"deed":{"do":"with","how":{"stance":"hold_fire","priority":{"by":"unit","unit":7}},"deed":{"do":"attack","who":{"t":"squads","ids":[3,4]},"target":6}}}"#;
    let d: Deed = serde_json::from_str(json).unwrap();
    let Deed::Wait { until: When::Signal { n: 0 }, deed } = &d else { panic!("{d:?}") };
    let Deed::With { how, deed } = deed.as_ref() else { panic!("{deed:?}") };
    assert_eq!(how, &How { stance: Some(Stance::HoldFire), priority: Some(Priority::Unit { unit: 7 }), ..How::default() });
    assert!(matches!(deed.as_ref(), Deed::Attack { who: Who::Squads { ids }, target: 6, .. } if ids == &[3, 4]));
    assert_eq!(serde_json::from_str::<Deed>(&serde_json::to_string(&d).unwrap()).unwrap(), d);
    println!("contract: a 3-deep wait/with/attack deed round-trips");
}
