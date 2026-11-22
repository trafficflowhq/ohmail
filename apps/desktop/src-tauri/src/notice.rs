//! THE NOTICE THE WINDOW HANDS THIS SHELL, AND THE WORDS THE SHELL SHOWS FOR IT.
//!
//! A notice is read on a locked screen by whoever stands there, and it stays listed until somebody
//! dismisses it. So the window does not hand over a sentence: it hands over a kind and its numbers
//! and closed words, the way the gate answered it, and this file writes the title and the body in
//! the shell's own language ([`crate::words::NoticeWords`]). A window that could post any title and
//! any body would be a door for whatever reached the page; this one can only choose among the
//! sentences below.
//!
//! The reading is closed. The value must be an object; its `kind` must be one of the four mail
//! kinds; it must hold exactly that kind's members, each of its own type and range. Anything else,
//! a member too many included, is refused whole and nothing is shown. Tauri-free, so every rule is
//! a plain test (`notice_tests.rs`).

use crate::words::{Language, NoticeWords};

/// The signed-in document's agenda. Each line has a clock value and one bounded event label.
#[cfg(feature = "local-engine")]
pub fn summary_fields(
    value: &serde_json::Value, opening: Option<&serde_json::Value>, lang: Language,
) -> Option<(String, String)> {
    let count = value["count"].as_u64()?;
    let events = opening?["summary"].as_array()?;
    if value.as_object()?.len() != 2 || count > COUNT_MAX || events.len() > 12 ||
        count < events.len() as u64 { return None }
    let words = crate::words::AlertWords::of(lang);
    let (title, all_day, empty, more) = match lang {
        Language::De => ("Heute im Kalender", "Ganztägig", "Heute keine Termine", "weitere"),
        Language::En => ("Today in Calendar", "All day", "No events today", "more"),
    };
    let mut lines = Vec::with_capacity(events.len() + 1);
    for event in events {
        if event.as_object()?.len() != 2 { return None }
        let time = event.get("time")?;
        let at = if time.is_null() { all_day } else {
            let time = time.as_str()?;
            let (hour, minute) = time.split_once(':')?;
            if hour.len() != 2 || minute.len() != 2 ||
                !time.bytes().all(|c| c.is_ascii_digit() || c == b':') ||
                hour.parse::<u8>().ok()? > 23 || minute.parse::<u8>().ok()? > 59 { return None }
            time
        };
        let label = event["label"].as_object()?;
        let text = match label.get("as")?.as_str()? {
            "title" if label.len() == 2 => clean_title(label.get("text")?.as_str()?)?,
            "busy" if label.len() == 1 => words.busy.to_owned(),
            "event" if label.len() == 1 => words.event.to_owned(),
            _ => return None,
        };
        lines.push(format!("{at} · {text}"));
    }
    if count > events.len() as u64 {
        lines.push(format!("+{} {more}", count - events.len() as u64));
    }
    let body = if lines.is_empty() { empty.to_owned() } else { lines.join("\n") };
    #[cfg(target_os = "linux")]
    let body = body.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    Some((title.to_owned(), body))
}

/// The largest count a notice says: the window's own bound (`NOTICE_COUNT_MAX`).
pub const COUNT_MAX: u64 = 9999;

/// The longest title this shell shows, in characters: the window's own bound (`NOTICE_TEXT_MAX`).
pub const TITLE_MAX: usize = 80;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Sent,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Change {
    Paired,
    Revoked,
}

/// The kind of device a pairing names, from the server's own list. Never a label a device chose.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Device {
    Desktop,
    Phone,
    Browser,
}

/// One notice, as the shell shows it. The mail kinds; no member can hold a word of a letter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Notice {
    Ohbox { count: u32 },
    Screener { count: u32 },
    Scheduled { outcome: Outcome, count: u32 },
    Pairing { change: Change, device: Option<Device> },
}

/// Why a value is not a notice. Says which rule, never what the value held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    NotAnObject,
    UnknownKind,
    Members,
    Count,
    Word,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let rule = match self {
            Refused::NotAnObject => "not an object",
            Refused::UnknownKind => "a kind this shell does not show",
            Refused::Members => "members other than the kind's own",
            Refused::Count => "a count out of its range",
            Refused::Word => "a word outside its closed list",
        };
        write!(f, "the notice was refused: {rule}")
    }
}

/// The notice `value` is, or why it is none.
pub fn read(value: &serde_json::Value) -> Result<Notice, Refused> {
    let members = value.as_object().ok_or(Refused::NotAnObject)?;
    let kind = members.get("kind").and_then(serde_json::Value::as_str).ok_or(Refused::UnknownKind)?;
    let own: &[&str] = match kind {
        "ohbox" | "screener" => &["kind", "count"],
        "scheduled" => &["kind", "outcome", "count"],
        "pairing" => &["kind", "change", "device"],
        _ => return Err(Refused::UnknownKind),
    };
    if members.len() != own.len() || !own.iter().all(|name| members.contains_key(*name)) {
        return Err(Refused::Members);
    }
    let count = || -> Result<u32, Refused> {
        let n = members.get("count").and_then(serde_json::Value::as_u64).ok_or(Refused::Count)?;
        if (1..=COUNT_MAX).contains(&n) {
            Ok(n as u32)
        } else {
            Err(Refused::Count)
        }
    };
    let word = |name: &str| members.get(name).and_then(serde_json::Value::as_str).ok_or(Refused::Word);
    match kind {
        "ohbox" => Ok(Notice::Ohbox { count: count()? }),
        "screener" => Ok(Notice::Screener { count: count()? }),
        "scheduled" => {
            let outcome = match word("outcome")? {
                "sent" => Outcome::Sent,
                "failed" => Outcome::Failed,
                _ => return Err(Refused::Word),
            };
            Ok(Notice::Scheduled { outcome, count: count()? })
        }
        _ => {
            let change = match word("change")? {
                "paired" => Change::Paired,
                "revoked" => Change::Revoked,
                _ => return Err(Refused::Word),
            };
            let device = match members.get("device") {
                Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(d)) => Some(match d.as_str() {
                    "desktop" => Device::Desktop,
                    "phone" => Device::Phone,
                    "browser" => Device::Browser,
                    _ => return Err(Refused::Word),
                }),
                _ => return Err(Refused::Word),
            };
            Ok(Notice::Pairing { change, device })
        }
    }
}

/// One of a pair of sentences by the count: the one for a single thing, or the many with `{count}` filled.
fn counted(one: &str, many: &str, count: u32) -> String {
    if count == 1 {
        one.to_string()
    } else {
        many.replace("{count}", &count.to_string())
    }
}

/// The title and the body this shell shows for `notice`, in `language`. The title is cleaned once
/// more whatever wrote it; the body is the shell's own words and numbers, nothing else.
pub fn compose(notice: &Notice, language: Language) -> (String, String) {
    let w: &NoticeWords = NoticeWords::of(language);
    let (title, body) = match *notice {
        Notice::Ohbox { count } => (w.ohbox_title, counted(w.ohbox_one, w.ohbox_many, count)),
        Notice::Screener { count } => (w.screener_title, counted(w.screener_one, w.screener_many, count)),
        Notice::Scheduled { outcome: Outcome::Sent, count } => (w.sent_title, counted(w.sent_one, w.sent_many, count)),
        Notice::Scheduled { outcome: Outcome::Failed, count } => {
            (w.failed_title, counted(w.failed_one, w.failed_many, count))
        }
        Notice::Pairing { change: Change::Paired, device } => (
            w.paired_title,
            match device {
                Some(Device::Desktop) => w.paired_desktop,
                Some(Device::Phone) => w.paired_phone,
                Some(Device::Browser) => w.paired_browser,
                None => w.paired_unknown,
            }
            .to_string(),
        ),
        Notice::Pairing { change: Change::Revoked, device } => (
            w.revoked_title,
            match device {
                Some(Device::Desktop) => w.revoked_desktop,
                Some(Device::Phone) => w.revoked_phone,
                Some(Device::Browser) => w.revoked_browser,
                None => w.revoked_unknown,
            }
            .to_string(),
        ),
    };
    (clean_title(title).unwrap_or_default(), body)
}

/// Is `c` a character a title never shows: a control, a direction control, or a character with no
/// width or no mark of its own. The window's own list (`cleanNoticeText`), held equal by one table
/// both tests read (`packages/client-engine/test/notice-text-dropped.json`); white space, the line
/// and paragraph separators among it, is collapsed before this is asked.
fn dropped(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{061C}' | '\u{200E}' | '\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2066}'..='\u{2069}'
                | '\u{00AD}' | '\u{180E}'
                | '\u{200B}'..='\u{200D}'
                | '\u{2060}'..='\u{2064}'
                | '\u{FEFF}'
                | '\u{034F}' | '\u{115F}' | '\u{1160}' | '\u{3164}' | '\u{FFA0}' | '\u{2800}'
                | '\u{FE00}'..='\u{FE0F}'
                | '\u{e0000}'..='\u{e007f}'
                | '\u{e0100}'..='\u{e01ef}'
        )
}

/// A title as one line: what a title never shows taken out, white space collapsed to single
/// spaces, cut at [`TITLE_MAX`] characters. `None` when nothing is left. Markup is not read: a title
/// field draws text as text, and the body never holds a title's words.
pub fn clean_title(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut gap = false;
    let mut kept = 0usize;
    for c in raw.chars() {
        if c.is_whitespace() {
            gap = !out.is_empty();
            continue;
        }
        if dropped(c) {
            continue;
        }
        if kept + usize::from(gap) + 1 > TITLE_MAX {
            break;
        }
        if gap {
            out.push(' ');
            kept += 1;
            gap = false;
        }
        out.push(c);
        kept += 1;
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
#[path = "notice_tests.rs"]
mod tests;
