//! What the window may hand this shell for a notice, and what the shell shows for it: a kind and its
//! numbers, read closed; the words the shell's own, in both languages and the window's catalogue's.

use super::*;
use serde_json::json;

/// Every notice the window can hand over, one of each shape.
fn every_notice() -> Vec<serde_json::Value> {
    let mut all = vec![
        json!({ "kind": "ohbox", "count": 1 }),
        json!({ "kind": "ohbox", "count": 12 }),
        json!({ "kind": "screener", "count": 1 }),
        json!({ "kind": "screener", "count": 3 }),
        json!({ "kind": "scheduled", "outcome": "sent", "count": 1 }),
        json!({ "kind": "scheduled", "outcome": "sent", "count": 2 }),
        json!({ "kind": "scheduled", "outcome": "failed", "count": 1 }),
        json!({ "kind": "scheduled", "outcome": "failed", "count": 9999 }),
    ];
    for change in ["paired", "revoked"] {
        for device in [json!("desktop"), json!("phone"), json!("browser"), serde_json::Value::Null] {
            all.push(json!({ "kind": "pairing", "change": change, "device": device }));
        }
    }
    all
}

#[test]
fn every_notice_the_window_hands_over_is_read() {
    for value in every_notice() {
        assert!(read(&value).is_ok(), "{value} was refused");
    }
    assert_eq!(read(&json!({ "kind": "ohbox", "count": 4 })), Ok(Notice::Ohbox { count: 4 }));
    assert_eq!(
        read(&json!({ "kind": "scheduled", "outcome": "failed", "count": 2 })),
        Ok(Notice::Scheduled { outcome: Outcome::Failed, count: 2 })
    );
    assert_eq!(
        read(&json!({ "kind": "pairing", "change": "revoked", "device": null })),
        Ok(Notice::Pairing { change: Change::Revoked, device: None })
    );
}

#[test]
fn the_old_title_and_body_are_refused() {
    // What the window used to hand the command: a sentence of its own, under any kind or none.
    assert_eq!(read(&json!({ "title": "ohmail", "body": "One new message for you." })), Err(Refused::UnknownKind));
    assert_eq!(
        read(&json!({ "kind": "ohbox", "count": 1, "title": "ohmail", "body": "One new message for you." })),
        Err(Refused::Members)
    );
    assert_eq!(read(&json!("One new message for you.")), Err(Refused::NotAnObject));
    assert_eq!(read(&json!(["ohbox", 1])), Err(Refused::NotAnObject));
    assert_eq!(read(&serde_json::Value::Null), Err(Refused::NotAnObject));
}

#[test]
fn a_mail_kind_with_a_member_too_many_is_refused_whole() {
    for value in every_notice() {
        for (name, extra) in [
            ("subject", json!("Zqsubject Thursday")),
            ("sender", json!("zqsender@example.org")),
            ("reason", json!("Zqreason no connection")),
            ("label", json!({ "as": "title", "text": "Zqtitle" })),
            ("title", json!("Zqtitle")),
            ("body", json!("Zqbody")),
            ("data", json!({ "to": "message" })),
            ("count2", json!(1)),
        ] {
            let mut planted = value.clone();
            planted.as_object_mut().unwrap().insert(name.to_string(), extra);
            assert_eq!(read(&planted), Err(Refused::Members), "{planted} was read");
        }
    }
    // And one too few.
    assert_eq!(read(&json!({ "kind": "ohbox" })), Err(Refused::Members));
    assert_eq!(read(&json!({ "kind": "scheduled", "count": 1 })), Err(Refused::Members));
    assert_eq!(read(&json!({ "kind": "pairing", "change": "paired" })), Err(Refused::Members));
}

#[test]
fn a_word_or_a_number_out_of_its_list_is_refused() {
    for count in [json!(0), json!(-1), json!(10000), json!(1.5), json!("3"), serde_json::Value::Null, json!(u64::MAX)] {
        assert_eq!(read(&json!({ "kind": "ohbox", "count": count })), Err(Refused::Count), "count {count}");
    }
    assert_eq!(read(&json!({ "kind": "cal_alert", "count": 1 })), Err(Refused::UnknownKind));
    assert_eq!(read(&json!({ "kind": "OHBOX", "count": 1 })), Err(Refused::UnknownKind));
    assert_eq!(read(&json!({ "kind": 1, "count": 1 })), Err(Refused::UnknownKind));
    assert_eq!(read(&json!({ "kind": "scheduled", "outcome": "maybe", "count": 1 })), Err(Refused::Word));
    assert_eq!(read(&json!({ "kind": "scheduled", "outcome": 1, "count": 1 })), Err(Refused::Word));
    assert_eq!(read(&json!({ "kind": "pairing", "change": "joined", "device": null })), Err(Refused::Word));
    // The label a pairing device chose for itself is a sentence, and never a device.
    for device in [json!("the hall's phone"), json!("Phone"), json!(""), json!(3), json!({ "kind": "phone" })] {
        assert_eq!(
            read(&json!({ "kind": "pairing", "change": "paired", "device": device })),
            Err(Refused::Word),
            "device {device}"
        );
    }
}

#[test]
fn a_title_comes_out_as_one_clean_line() {
    // Markup, a line break and a direction control: the markup stays text, the rest goes.
    let planted = "<b>Zqtitle</b>\nsecond line\u{202E}gnp.exe\u{200B}\u{2028}end\r\n";
    assert_eq!(clean_title(planted).as_deref(), Some("<b>Zqtitle</b> second linegnp.exe end"));
    assert_eq!(clean_title("\u{0007}\u{200F}\u{2066}x\u{2069}\u{FEFF}").as_deref(), Some("x"));
    assert_eq!(clean_title("  \n\t\u{2029} "), None);
    assert_eq!(clean_title(""), None);
    // Cut at eighty characters, never on a space.
    let long = "word ".repeat(10_000);
    let cut = clean_title(&long).unwrap();
    assert!(cut.chars().count() <= TITLE_MAX, "{} characters", cut.chars().count());
    assert!(!cut.ends_with(' '));
    assert_eq!(clean_title(&"é".repeat(200)).unwrap().chars().count(), TITLE_MAX);
}

/// The code points of `list` ("0041" or "0041-005A"), as ranges.
fn ranges(list: &serde_json::Value) -> Vec<(u32, u32)> {
    let hex = |h: &str| u32::from_str_radix(h, 16).unwrap_or_else(|e| panic!("{h}: {e}"));
    let list = list.as_array().expect("a list of code points");
    list.iter()
        .map(|item| {
            let text = item.as_str().expect("a code point in hex");
            match text.split_once('-') {
                Some((from, to)) => (hex(from), hex(to)),
                None => (hex(text), hex(text)),
            }
        })
        .collect()
}

#[test]
fn a_title_spaces_drops_and_keeps_each_character_as_the_windows_table_says() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/client-engine/test/notice-text-dropped.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("could not read {}: {e}", path.display()));
    let table: serde_json::Value = serde_json::from_str(&text).expect("the table is JSON");
    let (space, dropped) = (ranges(&table["space"]), ranges(&table["dropped"]));
    let within = |list: &[(u32, u32)], cp: u32| list.iter().any(|(from, to)| (*from..=*to).contains(&cp));
    let mut wrong = Vec::new();
    for c in (0..=0x10FFFFu32).filter_map(char::from_u32) {
        let cp = c as u32;
        let want = if within(&space, cp) {
            "a b".to_string()
        } else if within(&dropped, cp) {
            "ab".to_string()
        } else {
            format!("a{c}b")
        };
        if clean_title(&format!("a{c}b")).as_deref() != Some(want.as_str()) {
            wrong.push(format!("{cp:04X}"));
        }
    }
    assert!(wrong.is_empty(), "{} characters differ from the window's table, the first: {:?}", wrong.len(), &wrong[..wrong.len().min(24)]);
}

#[test]
fn what_is_shown_is_the_shells_own_words_with_the_title_cleaned_and_nothing_else() {
    for language in Language::ALL {
        for value in every_notice() {
            let notice = read(&value).unwrap();
            let (title, body) = compose(&notice, language);
            assert!(!title.is_empty() && !body.is_empty(), "{language:?} {value}");
            assert_eq!(clean_title(&title).as_deref(), Some(title.as_str()), "{language:?} {value}: the title is not clean");
            // A notification server may draw the body with markup: nothing of it can be read so.
            assert!(!body.contains('<') && !body.contains('&') && !body.contains('{'), "{language:?} {value}: {body}");
            assert!(!body.contains('\n') && !title.contains('\n'));
            let count = value.get("count").and_then(serde_json::Value::as_u64);
            if let Some(n) = count.filter(|n| *n > 1) {
                assert!(body.contains(&n.to_string()), "{language:?} {value}: {body}");
            }
        }
    }
    assert_eq!(compose(&Notice::Ohbox { count: 1 }, Language::En), ("New mail".into(), "One new message for you.".into()));
    assert_eq!(compose(&Notice::Ohbox { count: 4 }, Language::De), ("Neue Mail".into(), "4 neue Nachrichten für dich.".into()));
    assert_eq!(
        compose(&Notice::Pairing { change: Change::Paired, device: Some(Device::Phone) }, Language::En).1,
        "A phone can now read your mail."
    );
}

/// The window's catalogue, read where the repository keeps it.
fn catalogue(tag: &str) -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../webapp/messages/{tag}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("could not read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} is not JSON: {e}", path.display()))
}

#[test]
fn the_shell_says_what_the_browser_says() {
    for language in Language::ALL {
        let messages = catalogue(language.tag());
        let say = |key: &str| -> String {
            messages["frame"]["systemNotice"][key]
                .as_str()
                .unwrap_or_else(|| panic!("{language:?}: frame.systemNotice.{key} is missing"))
                .to_string()
        };
        let w = NoticeWords::of(language);
        let plural = |one: &str, many: &str| format!("{{count, plural, one {{{one}}} other {{{}}}}}", many.replace("{count}", "#"));
        let select = |desktop: &str, phone: &str, browser: &str, unknown: &str| {
            format!("{{device, select, desktop {{{desktop}}} phone {{{phone}}} browser {{{browser}}} other {{{unknown}}}}}")
        };
        assert_eq!(say("ohboxTitle"), w.ohbox_title, "{language:?}");
        assert_eq!(say("ohboxBody"), plural(w.ohbox_one, w.ohbox_many), "{language:?}");
        assert_eq!(say("screenerTitle"), w.screener_title, "{language:?}");
        assert_eq!(say("screenerBody"), plural(w.screener_one, w.screener_many), "{language:?}");
        assert_eq!(say("sentTitle"), w.sent_title, "{language:?}");
        assert_eq!(say("sentBody"), plural(w.sent_one, w.sent_many), "{language:?}");
        assert_eq!(say("failedTitle"), w.failed_title, "{language:?}");
        assert_eq!(say("failedBody"), plural(w.failed_one, w.failed_many), "{language:?}");
        assert_eq!(say("pairedTitle"), w.paired_title, "{language:?}");
        assert_eq!(
            say("pairedBody"),
            select(w.paired_desktop, w.paired_phone, w.paired_browser, w.paired_unknown),
            "{language:?}"
        );
        assert_eq!(say("revokedTitle"), w.revoked_title, "{language:?}");
        assert_eq!(
            say("revokedBody"),
            select(w.revoked_desktop, w.revoked_phone, w.revoked_browser, w.revoked_unknown),
            "{language:?}"
        );
    }
}

#[test]
fn a_refusal_names_its_rule_and_nothing_the_value_held() {
    let planted = json!({ "kind": "ohbox", "count": 1, "subject": "Zqsubject" });
    let said = read(&planted).unwrap_err().to_string();
    assert!(!said.to_lowercase().contains("zq"), "{said}");
    assert!(said.contains("refused"), "{said}");
}
