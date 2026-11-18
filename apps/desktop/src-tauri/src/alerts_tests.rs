//! The calendar's alerts in this shell: what the window may hand it, read closed; who hears an alert
//! and when, by the table the window's own book is held to; and what an alert says, in both
//! languages and the window's catalogue's.

use super::*;
use serde_json::json;
use std::sync::Arc;

const MIN: u64 = 60_000;
/// Tuesday 10 November 2026, 14:00 UTC.
const TWO: u64 = 1_794_319_200_000;

/// A file of the window's own tests, read where the repository keeps it.
impl Alerts {
    fn pass(&self, live: &Live, now_ms: u64) -> (Vec<Alert>, Duration, u64) {
        let mut due = Vec::new();
        let (sleep, turn) = self.dispatch(|| live.clone(), || now_ms, || true, |alert, _| due.push(alert.clone()));
        (due, sleep, turn)
    }
}

fn table(name: &str) -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/client-engine/test").join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("could not read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} is not JSON: {e}", path.display()))
}

/// An alert as the window makes it: ten minutes before `start_ms`, titled.
fn alert(event: &str, start_ms: u64, lead: u64) -> serde_json::Value {
    json!({
        "id": format!("{event}.{start_ms}.{lead}"), "eventId": event, "atMs": start_ms - lead * MIN, "startMs": start_ms,
        "allDay": false, "label": { "as": "title", "text": "Catalogue weekly" }, "leadMin": lead, "acts": [],
    })
}

fn weekly() -> serde_json::Value {
    alert("ev-weekly", TWO, 10)
}

fn set_of(scope: &str, alerts: Vec<serde_json::Value>) -> serde_json::Value {
    json!({ "scope": scope, "alerts": alerts })
}

fn serving(mailbox: &str) -> Live {
    Live::Mailbox(mailbox.to_string(), 0)
}

/// `base` with `member` replaced by `value`.
fn with(base: &serde_json::Value, member: &str, value: serde_json::Value) -> serde_json::Value {
    let mut planted = base.clone();
    planted.as_object_mut().unwrap().insert(member.to_string(), value);
    planted
}

fn refusal(alert: serde_json::Value) -> Result<Set, Refused> {
    read(&set_of("mb-1", vec![alert]), &serving("mb-1"), TWO - 20 * MIN)
}

#[test]
fn a_set_as_the_window_makes_it_is_read() {
    let now = TWO - 20 * MIN;
    let read_set = read(&set_of("mb-1", vec![weekly(), alert("ev-books", TWO + 180 * MIN, 60)]), &serving("mb-1"), now).unwrap();
    assert_eq!(read_set.scope, "mb-1");
    assert_eq!(read_set.alerts.len(), 2);
    assert_eq!(
        read_set.alerts[0],
        Alert {
            id: format!("ev-weekly.{TWO}.10"),
            event_id: "ev-weekly".into(),
            at_ms: TWO - 10 * MIN,
            start_ms: TWO,
            all_day: false,
            label: Label::Title("Catalogue weekly".into()),
            lead_min: 10,
        }
    );
    assert_eq!(refusal(with(&weekly(), "label", json!({ "as": "busy" }))).unwrap().alerts[0].label, Label::Busy);
    assert_eq!(refusal(with(&weekly(), "label", json!({ "as": "event" }))).unwrap().alerts[0].label, Label::Event);
    // An empty set is a set: it takes everything back.
    assert_eq!(read(&set_of("mb-1", vec![]), &serving("mb-1"), now), Ok(Set { scope: "mb-1".into(), alerts: vec![] }));
}

#[test]
fn a_label_outside_its_closed_forms_is_refused() {
    for label in [
        json!("Busy"),
        json!(null),
        json!(["title", "x"]),
        json!({ "as": "titled", "text": "x" }),
        json!({ "as": "private" }),
        json!({ "as": "busy", "text": "Zqtitle" }),
        json!({ "as": "event", "why": 1 }),
        json!({ "as": "title" }),
        json!({ "as": "title", "text": 7 }),
        json!({ "as": "title", "text": "" }),
        json!({ "as": "title", "text": "\u{200B}\u{202E}\n" }),
        json!({ "as": "title", "text": "x", "html": "<b>x</b>" }),
        json!({ "as": "title", "text": "x".repeat(5000) }),
        json!({ "as": 1 }),
        json!({}),
    ] {
        assert_eq!(refusal(with(&weekly(), "label", label.clone())), Err(Refused::Label), "label {label}");
    }
}

#[test]
fn a_lead_out_of_its_range_is_refused() {
    for lead in [json!(-1), json!(1.5), json!("10"), json!(null), json!(40_321), json!(u64::MAX), json!([10])] {
        assert_eq!(refusal(with(&weekly(), "leadMin", lead.clone())), Err(Refused::Lead), "lead {lead}");
    }
    // Any whole number of minutes within four weeks is a lead: an event's own alarm from its provider.
    for lead in [0u64, 1, 7, 45, 90, 1441, 20_000, 40_320] {
        let start = TWO + 30 * 86_400_000;
        let far = alert("ev-far", start, lead);
        let now = start - lead * MIN - MIN;
        assert!(read(&set_of("mb-1", vec![far]), &serving("mb-1"), now).is_ok(), "lead {lead} was refused");
    }
}

#[test]
fn a_set_of_another_scope_is_refused() {
    let now = TWO - 20 * MIN;
    let set = set_of("mb-1", vec![weekly()]);
    // The window names an account this shell is not serving, or nobody is served, or it cannot be said now.
    assert_eq!(read(&set, &serving("mb-2"), now), Err(Refused::AnotherScope));
    assert_eq!(read(&set, &serving("mb-10"), now), Err(Refused::AnotherScope));
    assert_eq!(read(&set, &serving("MB-1"), now), Err(Refused::AnotherScope));
    assert_eq!(read(&set, &Live::Nobody, now), Err(Refused::AnotherScope));
    assert_eq!(read(&set, &Live::Unknown, now), Err(Refused::AnotherScope));
    assert_eq!(read(&set_of("mb-1", vec![]), &serving("mb-2"), now), Err(Refused::AnotherScope));
    // A scope that is no account's id is refused before anyone is asked who is served.
    for scope in [json!("demo:fixtures"), json!(""), json!("a scope"), json!("x".repeat(129)), json!(7), json!(null)] {
        let planted = with(&set, "scope", scope.clone());
        assert_eq!(read(&planted, &serving("demo:fixtures"), now), Err(Refused::Scope), "scope {scope}");
    }
    // An alert whose id is another event's, another start's or another lead's is not this alert's.
    for id in [json!("ev-other.1794319200000.10"), json!(format!("ev-weekly.{}.10", TWO + 1)), json!(format!("ev-weekly.{TWO}.5")), json!("an id with words"), json!(7)] {
        assert_eq!(refusal(with(&weekly(), "id", id.clone())), Err(Refused::Id), "id {id}");
    }
    for event in [json!("ev weekly"), json!(""), json!("x".repeat(129)), json!("a/b"), json!(null)] {
        assert_eq!(refusal(with(&weekly(), "eventId", event.clone())), Err(Refused::Id), "event {event}");
    }
}

#[test]
fn a_member_too_many_or_too_few_refuses_the_whole_set() {
    let now = TWO - 20 * MIN;
    for (name, extra) in [
        ("title", json!("Zqtitle")),
        ("body", json!("Zqbody 14:00 in the main hall")),
        ("place", json!("Zqplace")),
        ("notes", json!("Zqnotes")),
        ("organizer", json!("zqorganizer@example.org")),
        ("scope", json!("mb-1")),
        ("url", json!("https://calls.example/zqlink")),
        ("sound", json!("default")),
    ] {
        let planted = with(&weekly(), name, extra);
        assert_eq!(refusal(planted.clone()), Err(Refused::Members), "{planted} was read");
        // One such alert beside a good one refuses both.
        assert_eq!(read(&set_of("mb-1", vec![weekly(), planted]), &serving("mb-1"), now), Err(Refused::Members));
    }
    for missing in ["id", "eventId", "atMs", "startMs", "allDay", "label", "leadMin", "acts"] {
        let mut less = weekly();
        less.as_object_mut().unwrap().remove(missing);
        assert_eq!(refusal(less), Err(Refused::Members), "without {missing}");
    }
    let set = set_of("mb-1", vec![weekly()]);
    assert_eq!(read(&with(&set, "live", json!(true)), &serving("mb-1"), now), Err(Refused::Members));
    assert_eq!(read(&json!({ "scope": "mb-1" }), &serving("mb-1"), now), Err(Refused::Members));
    assert_eq!(read(&json!({ "alerts": [] }), &serving("mb-1"), now), Err(Refused::Members));
    assert_eq!(read(&with(&set, "alerts", json!("none")), &serving("mb-1"), now), Err(Refused::Members));
    for not in [json!(null), json!("set"), json!([set.clone()]), json!(7)] {
        assert_eq!(read(&not, &serving("mb-1"), now), Err(Refused::NotAnObject));
    }
    assert_eq!(refusal(json!("alert")), Err(Refused::NotAnObject));
}

#[test]
fn a_time_a_flag_an_act_an_order_or_a_count_out_of_its_rule_is_refused() {
    let now = TWO - 20 * MIN;
    for (member, value) in [("atMs", json!(-1)), ("atMs", json!(1.5)), ("atMs", json!("0")), ("startMs", json!(8_640_000_000_000_001u64)), ("startMs", json!(null))] {
        assert_eq!(refusal(with(&weekly(), member, value.clone())), Err(Refused::Instant), "{member} {value}");
    }
    // The minute it rings is the start less the lead: nobody hands another one in.
    assert_eq!(refusal(with(&weekly(), "atMs", json!(TWO - 9 * MIN))), Err(Refused::Instant));
    assert_eq!(refusal(with(&weekly(), "atMs", json!(TWO))), Err(Refused::Instant));
    assert_eq!(refusal(alert_with_start_before_its_lead()), Err(Refused::Instant));
    for flag in [json!("false"), json!(0), json!(null)] {
        assert_eq!(refusal(with(&weekly(), "allDay", flag)), Err(Refused::Flag));
    }
    // This shell shows no button on a notice: an alert that names any act is refused.
    for acts in [json!(["join"]), json!(["again"]), json!(["open"]), json!("join"), json!(null), json!({ "0": "join" })] {
        assert_eq!(refusal(with(&weekly(), "acts", acts.clone())), Err(Refused::Acts), "acts {acts}");
    }
    let later = alert("ev-books", TWO + 180 * MIN, 60);
    assert_eq!(read(&set_of("mb-1", vec![later.clone(), weekly()]), &serving("mb-1"), now), Err(Refused::Order));
    assert_eq!(read(&set_of("mb-1", vec![weekly(), weekly()]), &serving("mb-1"), now), Err(Refused::Order));
    let many: Vec<_> = (0..=MOST as u64).map(|i| alert("ev-many", TWO + i * MIN, 10)).collect();
    assert_eq!(read(&set_of("mb-1", many.clone()), &serving("mb-1"), now), Err(Refused::TooMany));
    assert!(read(&set_of("mb-1", many[..MOST].to_vec()), &serving("mb-1"), now).is_ok());
    // Nothing further ahead than a set reaches; what the window made a moment ago is let in.
    let edge = alert("ev-edge", now + AHEAD_MS + 10 * MIN, 10);
    assert!(read(&set_of("mb-1", vec![edge.clone()]), &serving("mb-1"), now).is_ok());
    assert!(read(&set_of("mb-1", vec![edge]), &serving("mb-1"), now - 30_000).is_ok());
    let beyond = alert("ev-beyond", now + AHEAD_MS + 12 * MIN, 10);
    assert_eq!(read(&set_of("mb-1", vec![beyond]), &serving("mb-1"), now), Err(Refused::Window));
}

fn alert_with_start_before_its_lead() -> serde_json::Value {
    json!({
        "id": "ev-early.60000.10", "eventId": "ev-early", "atMs": 0, "startMs": 60_000,
        "allDay": false, "label": { "as": "event" }, "leadMin": 10, "acts": [],
    })
}

#[test]
fn a_refusal_names_its_rule_and_nothing_the_value_held() {
    for planted in [
        with(&weekly(), "body", json!("Zqbody")),
        with(&weekly(), "label", json!({ "as": "Zqlabel" })),
        with(&weekly(), "id", json!("Zqid")),
    ] {
        let said = refusal(planted).unwrap_err().to_string();
        assert!(!said.to_lowercase().contains("zq"), "{said}");
        assert!(said.contains("refused"), "{said}");
    }
    let said = read(&set_of("Zqscope", vec![]), &serving("mb-1"), TWO).unwrap_err().to_string();
    assert!(!said.to_lowercase().contains("zq") && !said.contains("mb-1"), "{said}");
}

/// The table's alert `name`, read the way the command reads one.
fn named(cases: &serde_json::Value, name: &str) -> Alert {
    let raw = cases["alerts"].get(name).unwrap_or_else(|| panic!("the table names no alert {name}")).clone();
    let now = raw["atMs"].as_u64().expect("an instant");
    let set = read(&set_of("mb-1", vec![raw]), &serving("mb-1"), now).unwrap_or_else(|why| panic!("the table's {name}: {why}"));
    set.alerts.into_iter().next().unwrap()
}

#[test]
fn who_hears_an_alert_and_when_is_what_the_windows_table_says() {
    let cases = table("notice-ring-cases.json");
    assert_eq!(cases["lateMs"].as_u64(), Some(LATE_MS));
    let names: Vec<String> = cases["alerts"].as_object().expect("alerts").keys().cloned().collect();
    let name_of = |id: &str| names.iter().find(|name| cases["alerts"][name.as_str()]["id"] == id).cloned().unwrap_or_else(|| id.to_string());
    let scripted = cases["cases"].as_array().expect("cases");
    assert!(scripted.len() >= 14, "{} cases", scripted.len());
    for case in scripted {
        let title = case["name"].as_str().expect("a name");
        let mut book = Book::default();
        for (i, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
            let at = format!("step {} of \"{title}\"", i + 1);
            if let Some(set) = step.get("set") {
                let alerts = set["alerts"].as_array().expect("names").iter().map(|n| named(&cases, n.as_str().unwrap())).collect();
                book.set(Set { scope: set["scope"].as_str().expect("a scope").to_string(), alerts });
            } else if step.get("clear").is_some() {
                book.clear();
            } else if let Some(due) = step.get("due") {
                let minute = named(&cases, due["at"].as_str().expect("an alert")).at_ms as i64 + due["plusMs"].as_i64().expect("plusMs");
                let rang: Vec<String> = book.due(due["live"].as_str(), minute as u64).iter().map(|a| name_of(&a.id)).collect();
                let want: Vec<String> = step["rings"].as_array().map(|r| r.iter().map(|n| n.as_str().unwrap().to_string()).collect()).unwrap_or_default();
                assert_eq!(rang, want, "{at}");
            } else if let Some(next) = step.get("next") {
                assert_eq!(book.next_at(), next.as_str().map(|n| named(&cases, n).at_ms), "{at}");
            } else {
                panic!("{at} is no step");
            }
        }
    }
}

#[test]
fn the_one_question_asked_the_moment_an_alert_is_due() {
    let now = TWO - 10 * MIN;
    let set = read(&set_of("mb-1", vec![weekly()]), &serving("mb-1"), now).unwrap();
    let ring = set.alerts[0].clone();
    assert!(may_ring(&ring, Some(&set), Some("mb-1"), now));
    assert!(!may_ring(&ring, Some(&set), Some("mb-1"), now - 1), "before its minute");
    assert!(may_ring(&ring, Some(&set), Some("mb-1"), now + LATE_MS));
    assert!(!may_ring(&ring, Some(&set), Some("mb-1"), now + LATE_MS + 1), "too late");
    assert!(!may_ring(&ring, Some(&set), Some("mb-2"), now), "another account");
    assert!(!may_ring(&ring, Some(&set), None, now), "nobody signed in");
    assert!(!may_ring(&ring, Some(&set), Some(""), now), "no scope");
    assert!(!may_ring(&ring, None, Some("mb-1"), now), "no set");
    let other = read(&set_of("mb-1", vec![alert("ev-books", TWO, 10)]), &serving("mb-1"), now).unwrap();
    assert!(!may_ring(&ring, Some(&other), Some("mb-1"), now), "no longer in the set");
}

#[test]
fn a_due_alert_is_rechecked_after_the_platform_answers_whether_it_can_draw() {
    let now = TWO - 10 * MIN;
    for change in ["withdrawn", "private", "signed-out", "another mailbox"] {
        let alerts = Alerts::default();
        let mailbox = std::cell::RefCell::new(serving("mb-1"));
        let set = set_of("mb-1", vec![weekly()]);
        alerts.receive(&set, || mailbox.borrow().clone(), now - MIN).unwrap();
        let mut labels = Vec::new();
        alerts.dispatch(|| mailbox.borrow().clone(), || now, || {
            match change {
                "withdrawn" => { alerts.receive(&set_of("mb-1", vec![]), || mailbox.borrow().clone(), now).unwrap(); }
                "private" => {
                    let private = with(&weekly(), "label", serde_json::json!({"as":"busy"}));
                    alerts.receive(&set_of("mb-1", vec![private]), || mailbox.borrow().clone(), now).unwrap();
                }
                "signed-out" => { *mailbox.borrow_mut() = Live::Nobody; }
                _ => { *mailbox.borrow_mut() = serving("mb-2"); }
            }
            true
        }, |alert, _| labels.push(alert.label.clone()));
        assert_eq!(labels, if change == "private" { vec![Label::Busy] } else { vec![] }, "{change}");
    }
}

#[test]
fn a_delayed_platform_answer_uses_the_lateness_limit_at_the_final_handoff() {
    let due = TWO - 10 * MIN;
    for (delay, draws) in [(LATE_MS, 1), (LATE_MS + 1, 0)] {
        let alerts = Alerts::default();
        alerts.receive(&set_of("mb-1", vec![weekly()]), || serving("mb-1"), due).unwrap();
        let clock = std::cell::Cell::new(due);
        let mut drawn = 0;
        alerts.dispatch(|| serving("mb-1"), || clock.get(), || {
            clock.set(due + delay);
            true
        }, |_, _| drawn += 1);
        assert_eq!(drawn, draws);
    }
}

#[test]
fn an_older_native_delivery_cannot_restore_a_cancelled_or_redacted_schedule() {
    let alerts = Alerts::default();
    let now = TWO - 10 * MIN;
    let doc = alerts.document();
    let wanted = set_of("mb-1", vec![weekly()]);
    let empty = set_of("mb-1", vec![]);
    let private = set_of("mb-1", vec![with(&weekly(), "label", serde_json::json!({"as":"busy"}))]);
    let hand = |set: &serde_json::Value, revision| alerts.receive_ordered(set, || serving("mb-1"), now, doc, 0, revision);
    hand(&empty, 3).unwrap();
    assert!(hand(&wanted, 2).is_err());
    assert!(alerts.pass(&serving("mb-1"), now).0.is_empty());
    hand(&private, 5).unwrap();
    assert!(hand(&wanted, 4).is_err());
    assert_eq!(alerts.pass(&serving("mb-1"), now).0[0].label, Label::Busy);
    alerts.start_document();
    assert!(hand(&wanted, 100).is_err());
    let next = alerts.document();
    assert_ne!(next, doc);
    assert!(alerts.receive_ordered(&wanted, || serving("mb-1"), now, next, 0, 1).is_ok());
    let login = || Live::Mailbox("mb-1".into(), 55);
    assert!(alerts.receive_ordered(&wanted, login, now, next, 0, 101).is_err());
    assert!(alerts.receive_ordered(&wanted, login, now, next, 55, 2).is_ok());
}

#[test]
fn a_withdrawal_during_a_mailbox_restart_clears_only_its_own_waiting_alerts() {
    let now = TWO - 10 * MIN;
    let alerts = Alerts::default();
    let wanted = set_of("mb-1", vec![weekly()]);
    let empty = set_of("mb-1", vec![]);
    assert!(alerts.receive(&wanted, || serving("mb-1"), now - MIN).is_ok());
    assert!(alerts.receive(&set_of("mb-2", vec![]), || Live::Unknown, now).is_err());
    assert!(alerts.receive(&empty, || serving("mb-2"), now).is_err());
    assert!(alerts.receive(&with(&empty, "extra", serde_json::json!(false)), || Live::Unknown, now).is_err());
    assert_eq!(alerts.pass(&serving("mb-1"), now).0.len(), 1);
    alerts.clear();
    assert!(alerts.receive(&wanted, || serving("mb-1"), now - MIN).is_ok());
    assert_eq!(alerts.receive(&empty, || Live::Unknown, now), Ok(vec![]));
    assert!(alerts.pass(&serving("mb-1"), now).0.is_empty());
}

#[test]
fn a_replacement_during_a_mailbox_restart_cannot_restore_the_earlier_title() {
    let now = TWO - 10 * MIN;
    let alerts = Alerts::default();
    alerts.receive(&set_of("mb-1", vec![weekly()]), || serving("mb-1"), now - MIN).unwrap();
    let private = with(&weekly(), "label", serde_json::json!({"as":"busy"}));
    assert_eq!(alerts.receive(&set_of("mb-1", vec![private]), || Live::Unknown, now), Err(Refused::AnotherScope));
    assert!(alerts.pass(&serving("mb-1"), now).0.is_empty());
}

#[test]
fn the_ringing_thread_drops_everything_when_nobody_is_signed_in_and_nothing_when_it_cannot_tell() {
    let now = TWO - 10 * MIN;
    let set = || set_of("mb-1", vec![weekly(), alert("ev-books", TWO + 180 * MIN, 60)]);
    let alerts = Alerts::default();
    assert_eq!(alerts.receive(&set(), || serving("mb-1"), now - MIN).unwrap(), vec![format!("ev-weekly.{TWO}.10"), format!("ev-books.{}.60", TWO + 180 * MIN)]);

    // Before the minute: nothing rings, and the thread sleeps no longer than its poll.
    let (due, sleep, turn) = alerts.pass(&serving("mb-1"), now - MIN);
    assert!(due.is_empty());
    assert_eq!(sleep, POLL);
    // An engine between two runs: nothing rings, nothing is dropped.
    let (due, sleep, same) = alerts.pass(&Live::Unknown, now);
    assert_eq!(sleep, POLL, "a due alert cannot spin while its mailbox is unknown");
    assert!(due.is_empty());
    assert_eq!(same, turn);
    // The engine is back under the same mailbox: the alert rings, once.
    let (due, sleep, _) = alerts.pass(&serving("mb-1"), now + 1_000);
    assert_eq!(due.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec![format!("ev-weekly.{TWO}.10")]);
    assert_eq!(sleep, POLL);
    assert!(alerts.pass(&serving("mb-1"), now + 2_000).0.is_empty());

    // Signed out: everything goes, and whoever is served next hears nothing of it.
    let (due, sleep, _) = alerts.pass(&Live::Nobody, TWO + 120 * MIN);
    assert!(due.is_empty());
    assert_eq!(sleep, IDLE);
    assert!(alerts.pass(&serving("mb-1"), TWO + 120 * MIN).0.is_empty());

    // Another mailbox served: the same.
    alerts.receive(&set(), || serving("mb-1"), now - MIN).unwrap();
    assert!(alerts.pass(&serving("mb-2"), now).0.is_empty());
    assert!(alerts.pass(&serving("mb-1"), now).0.is_empty());

    // The sign-out's own clear.
    alerts.receive(&set(), || serving("mb-1"), now - MIN).unwrap();
    alerts.clear();
    assert!(alerts.pass(&serving("mb-1"), now).0.is_empty());
    assert_eq!(alerts.receive(&set_of("mb-1", vec![]), || serving("mb-1"), TWO).unwrap(), Vec::<String>::new());
}

#[test]
fn who_is_signed_in_is_nobody_without_a_door_and_not_known_between_two_runs() {
    assert_eq!(live_of(false, None), Live::Nobody);
    // Signed out, whatever the engine that is going away still says.
    assert_eq!(live_of(false, Some("mb-1")), Live::Nobody);
    assert_eq!(live_of(true, Some("mb-1")), Live::Mailbox("mb-1".into(), 0));
    assert_eq!(live_of(true, None), Live::Unknown);
    assert_eq!(live_of(true, Some("")), Live::Unknown);
}

#[test]
fn a_set_handed_over_wakes_a_sleeping_thread() {
    let alerts = Arc::new(Alerts::default());
    let (_, _, turn) = alerts.pass(&Live::Unknown, TWO);
    let sleeper = {
        let alerts = Arc::clone(&alerts);
        std::thread::spawn(move || {
            let began = std::time::Instant::now();
            alerts.sleep(turn, Duration::from_secs(60));
            began.elapsed()
        })
    };
    std::thread::sleep(Duration::from_millis(50));
    alerts.receive(&set_of("mb-1", vec![]), || serving("mb-1"), TWO).unwrap();
    let slept = sleeper.join().expect("the sleeper");
    assert!(slept < Duration::from_secs(30), "slept {slept:?}");
    // A reading already out of date does not sleep at all.
    let began = std::time::Instant::now();
    alerts.sleep(turn, Duration::from_secs(60));
    assert!(began.elapsed() < Duration::from_secs(30));
}

#[test]
fn a_lead_is_said_as_the_windows_table_says() {
    let rows = table("notice-lead-words.json");
    let rows = rows["rows"].as_array().expect("rows");
    assert!(rows.len() > 30);
    for row in rows {
        let (lead, all_day) = (row["leadMin"].as_u64().unwrap() as u32, row["allDay"].as_bool().unwrap());
        let count = row["count"].as_u64().map(|n| n as u32);
        let want = match (row["as"].as_str().unwrap(), count) {
            ("now", None) => Lead::Now,
            ("today", None) => Lead::Today,
            ("tomorrow", None) => Lead::Tomorrow,
            ("minutes", Some(n)) => Lead::Minutes(n),
            ("hours", Some(n)) => Lead::Hours(n),
            ("days", Some(n)) => Lead::Days(n),
            ("weeks", Some(n)) => Lead::Weeks(n),
            other => panic!("the table says {other:?}"),
        };
        assert_eq!(lead_words(lead, all_day), want, "{lead} {all_day}");
    }
    // Every whole number of the range has words, and they stand for the same minutes.
    for lead in 0..=LEAD_MAX_MIN as u32 {
        let minutes = match lead_words(lead, false) {
            Lead::Now => 0,
            Lead::Minutes(n) => n,
            Lead::Hours(n) => n * 60,
            Lead::Days(n) => n * 1440,
            Lead::Weeks(n) => n * 10_080,
            other => panic!("{lead}: a time of day said as {other:?}"),
        };
        assert_eq!(minutes, lead);
        let days = match lead_words(lead, true) {
            Lead::Today => 0,
            Lead::Tomorrow => 1,
            Lead::Days(n) => n,
            Lead::Weeks(n) => n * 7,
            other => panic!("{lead}: a whole day said as {other:?}"),
        };
        assert_eq!(days, lead.div_ceil(1440));
    }
}

fn shown(label: serde_json::Value, lead: u64, all_day: bool) -> Alert {
    let start = TWO + 40 * 86_400_000;
    let raw = with(&with(&alert("ev-weekly", start, lead), "label", label), "allDay", json!(all_day));
    read(&set_of("mb-1", vec![raw]), &serving("mb-1"), start - lead * MIN).unwrap().alerts.remove(0)
}

#[test]
fn what_is_shown_is_the_label_in_the_title_and_the_shells_own_words_in_the_body() {
    let hostile = "<b>Zqtitle</b>\nsecond line\u{202E}gnp.exe\u{200B}";
    let rows = table("notice-lead-words.json");
    for language in Language::ALL {
        let w = AlertWords::of(language);
        for row in rows["rows"].as_array().unwrap() {
            let (lead, all_day) = (row["leadMin"].as_u64().unwrap(), row["allDay"].as_bool().unwrap());
            let (title, body) = compose(&shown(json!({ "as": "title", "text": hostile }), lead, all_day), language);
            // The title is one clean line, markup as text; the body holds nothing of it.
            assert_eq!(title, "<b>Zqtitle</b> second linegnp.exe", "{language:?} {lead}");
            assert!(!body.is_empty() && !body.to_lowercase().contains("zq"), "{language:?} {lead}: {body}");
            assert!(!body.contains('<') && !body.contains('&') && !body.contains('{') && !body.contains('\n'), "{language:?} {lead}: {body}");
            if let Some(n) = row["count"].as_u64().filter(|n| *n > 1) {
                assert!(body.contains(&n.to_string()), "{language:?} {lead}: {body}");
            }
            assert_eq!(compose(&shown(json!({ "as": "busy" }), lead, all_day), language), (w.busy.to_string(), body.clone()));
            assert_eq!(compose(&shown(json!({ "as": "event" }), lead, all_day), language).0, w.event);
        }
    }
    let said = |lead, all_day, language| compose(&shown(json!({ "as": "event" }), lead, all_day), language);
    assert_eq!(said(10, false, Language::En), ("Event".into(), "Starts in 10 minutes.".into()));
    assert_eq!(said(0, false, Language::En).1, "Starts now.");
    assert_eq!(said(60, false, Language::De), ("Termin".into(), "Beginnt in einer Stunde.".into()));
    assert_eq!(said(45, false, Language::De).1, "Beginnt in 45 Minuten.");
    assert_eq!(said(900, true, Language::En).1, "Tomorrow, all day.");
    assert_eq!(said(2880, true, Language::De).1, "In 2 Tagen, ganztägig.");
    assert_eq!(said(10_080, true, Language::En).1, "In one week, all day.");
}

#[test]
fn the_shell_says_what_the_window_says() {
    for language in Language::ALL {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../webapp/messages/{}.json", language.tag()));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("could not read {}: {e}", path.display()));
        let messages: serde_json::Value = serde_json::from_str(&text).expect("the catalogue is JSON");
        let say = |key: &str| -> String {
            messages["frame"]["systemNotice"][key].as_str().unwrap_or_else(|| panic!("{language:?}: frame.systemNotice.{key} is missing")).to_string()
        };
        let plural = |one: &str, many: &str| format!("{{count, plural, one {{{one}}} other {{{}}}}}", many.replace("{count}", "#"));
        let w = AlertWords::of(language);
        assert_eq!(say("alertBusy"), w.busy, "{language:?}");
        assert_eq!(say("alertEvent"), w.event, "{language:?}");
        assert_eq!(say("alertNow"), w.now, "{language:?}");
        assert_eq!(say("alertMinutes"), plural(w.minute_one, w.minute_many), "{language:?}");
        assert_eq!(say("alertHours"), plural(w.hour_one, w.hour_many), "{language:?}");
        assert_eq!(say("alertDays"), plural(w.day_one, w.day_many), "{language:?}");
        assert_eq!(say("alertWeeks"), plural(w.week_one, w.week_many), "{language:?}");
        assert_eq!(say("alertToday"), w.today, "{language:?}");
        assert_eq!(say("alertTomorrow"), w.tomorrow, "{language:?}");
        assert_eq!(say("alertAllDays"), w.all_days, "{language:?}");
        assert_eq!(say("alertAllWeeks"), plural(w.all_week_one, w.all_week_many), "{language:?}");
    }
}
