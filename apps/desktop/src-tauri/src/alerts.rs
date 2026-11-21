//! THE CALENDAR'S ALERTS, SET AHEAD: WHAT THE WINDOW HANDS THIS SHELL, WHO HEARS ONE, AND WHAT IT SAYS.
//!
//! A hidden window's timers are slowed by the system, so an alert that must ring at its minute is
//! rung by this process. The window hands over one account's alerts as a set, whole each time, and
//! this file is everything the shell does with it. Tauri-free, so every rule is a plain test
//! (`alerts_tests.rs`); the command that reads a set and the thread that shows an alert are in
//! `engine.rs`, beside the notice they resemble.
//!
//! WHAT IS HANDED OVER is read closed ([`read`]). A set is its scope and its alerts and nothing
//! else; an alert is exactly eight members: two ids, two instants, a yes or no, a lead in whole
//! minutes, an event's label and its acts. A label is the word `busy`, the word `event`, or a title,
//! which is cleaned to one line here whatever cleaned it before. No member can hold a sentence, a
//! place or a person, and a member too many refuses the whole set. This shell shows no button on a
//! notice, so an alert that names any act is refused too.
//!
//! WHO HEARS ONE. A set is taken only under the mailbox this shell is serving, and the moment an
//! alert is due the shell asks again ([`Book::due`]): is the mailbox it serves now still the one the
//! set was made under, does the alert still stand in the set held now, and is it no later than an
//! alert may ring. Asked while nobody is signed in, or under another mailbox, the book drops
//! everything it holds: what was set under the account left never waits to fire. An event that
//! moved, an alarm that was removed and an invitation that was declined are simply missing from the
//! next set the window hands over. The window's own book follows the same rule
//! (`packages/client-engine/src/notices/ring.ts`), and one table of cases holds both
//! (`packages/client-engine/test/notice-ring-cases.json`).
//!
//! WHAT IT SAYS ([`compose`]). The title field is the event's label: its cleaned title, or the
//! shell's own word. The body is the shell's own words for the lead and nothing else. This shell
//! has no zone rules, so it says how long until the start and not the clock time.

use crate::notice::clean_title;
use crate::words::{AlertWords, Language};
use std::collections::{HashMap, HashSet};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// The most alerts a set holds: the window's own bound (`AHEAD_MAX`).
pub const MOST: usize = 64;
/// The longest lead, in minutes, four weeks: the window's own bound (`NOTICE_LEAD_MAX_MIN`).
pub const LEAD_MAX_MIN: u64 = 40_320;
/// How far ahead a set reaches, in milliseconds, eight days: the window's own bound (`AHEAD_DAYS`).
pub const AHEAD_MS: u64 = 8 * 86_400_000;
/// How late an alert may still ring, in milliseconds: the window's own bound (`AHEAD_LATE_MS`).
pub const LATE_MS: u64 = 120_000;
/// The last instant a date can name, in milliseconds since the epoch.
const INSTANT_MAX_MS: u64 = 8_640_000_000_000_000;
/// The longest id of an alert, and of an event or a scope.
const ALERT_ID_MAX: usize = 160;
const ID_MAX: usize = 128;
/// The longest title text looked at before it is cleaned, in bytes.
const TITLE_IN_MAX: usize = 4096;
/// A set was made by the window a moment before it is read here: that much past the window is let in.
const READ_SLACK_MS: u64 = 60_000;
/// The longest the ringing thread sleeps while an alert waits, so that a computer that slept
/// through an alert's minute finds out soon after it wakes; and how long it sleeps with none.
pub const POLL: Duration = Duration::from_secs(30);
pub const IDLE: Duration = Duration::from_secs(600);

/// How an event is named: its cleaned title, or one of the shell's two words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Label {
    Title(String),
    Busy,
    Event,
}

/// One alert of one occurrence. No member can hold a sentence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alert {
    pub id: String,
    pub event_id: String,
    pub at_ms: u64,
    pub start_ms: u64,
    pub all_day: bool,
    pub label: Label,
    pub lead_min: u32,
}

/// One account's alerts, ascending by their minute, each id once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Set {
    pub scope: String,
    pub alerts: Vec<Alert>,
}

/// Why a value is not a set of alerts. Says which rule, never what the value held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    NotAnObject,
    Members,
    Scope,
    Superseded,
    AnotherScope,
    TooMany,
    Id,
    Instant,
    Flag,
    Lead,
    Label,
    Acts,
    Order,
    Window,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let rule = match self {
            Refused::NotAnObject => "not an object",
            Refused::Members => "members other than its own",
            Refused::Superseded => "a schedule from an earlier window update",
            Refused::Scope => "a scope that is no account's",
            Refused::AnotherScope => "a scope that is not the mailbox this app is serving",
            Refused::TooMany => "more alerts than a set holds",
            Refused::Id => "an id that is not the alert's own",
            Refused::Instant => "a time that is no instant, or not the start less the lead",
            Refused::Flag => "a yes or no that is neither",
            Refused::Lead => "a lead out of its range",
            Refused::Label => "a label outside its closed forms",
            Refused::Acts => "an act this app shows no button for",
            Refused::Order => "alerts out of order, or one twice",
            Refused::Window => "an alert further ahead than a set reaches",
        };
        write!(f, "the alerts were refused: {rule}")
    }
}

/// Who this shell is signed in as, for an alert: a mailbox it serves, nobody at all, or not known
/// at this moment (an engine between two runs, which is no sign-out).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Live {
    Nobody,
    Unknown,
    Mailbox(String, u64),
}

/// Who the shell is signed in as, from the two things it knows: whether this install has a door at
/// all (none after a sign-out), and the mailbox its engine last announced. A door with no
/// announcement is an engine between two runs: not known, which is no sign-out.
#[cfg(test)]
pub fn live_of(door: bool, announced: Option<&str>) -> Live {
    match (door, announced) {
        (false, _) => Live::Nobody,
        (true, Some(mailbox)) if !mailbox.is_empty() => Live::Mailbox(mailbox.to_string(), 0),
        (true, _) => Live::Unknown,
    }
}

/// Is `text` an id of at most `max` characters: letters, digits, `.`, `_`, `-` and `also`.
fn is_id(text: &str, max: usize, also: char) -> bool {
    !text.is_empty() && text.len() <= max && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') || c == also)
}

type Members = serde_json::Map<String, serde_json::Value>;

/// The members of `value` when it is an object holding exactly `names`.
fn exactly<'a>(value: &'a serde_json::Value, names: &[&str]) -> Result<&'a Members, Refused> {
    let members = value.as_object().ok_or(Refused::NotAnObject)?;
    if members.len() != names.len() || !names.iter().all(|name| members.contains_key(*name)) {
        return Err(Refused::Members);
    }
    Ok(members)
}

/// An event's label: the word `busy` or `event` alone, or a title with its text and nothing else,
/// cleaned to one line. The one reader of a label in this shell.
pub(crate) fn read_label(value: &serde_json::Value) -> Result<Label, Refused> {
    let members = value.as_object().ok_or(Refused::Label)?;
    match (members.get("as").and_then(serde_json::Value::as_str), members.len()) {
        (Some("busy"), 1) => Ok(Label::Busy),
        (Some("event"), 1) => Ok(Label::Event),
        (Some("title"), 2) => {
            let text = members.get("text").and_then(serde_json::Value::as_str).ok_or(Refused::Label)?;
            if text.len() > TITLE_IN_MAX {
                return Err(Refused::Label);
            }
            clean_title(text).map(Label::Title).ok_or(Refused::Label)
        }
        _ => Err(Refused::Label),
    }
}

fn read_alert(value: &serde_json::Value) -> Result<Alert, Refused> {
    let m = exactly(value, &["id", "eventId", "atMs", "startMs", "allDay", "label", "leadMin", "acts"])?;
    let event_id = m["eventId"].as_str().filter(|text| is_id(text, ID_MAX, ':')).ok_or(Refused::Id)?;
    let instant = |name: &str| m[name].as_u64().filter(|ms| *ms <= INSTANT_MAX_MS).ok_or(Refused::Instant);
    let (at_ms, start_ms) = (instant("atMs")?, instant("startMs")?);
    let all_day = m["allDay"].as_bool().ok_or(Refused::Flag)?;
    let lead = m["leadMin"].as_u64().filter(|min| *min <= LEAD_MAX_MIN).ok_or(Refused::Lead)?;
    // The minute it rings is the start less the lead, and its id is its event, its start and its lead.
    if start_ms.checked_sub(lead * 60_000) != Some(at_ms) {
        return Err(Refused::Instant);
    }
    let id = m["id"].as_str().ok_or(Refused::Id)?;
    if id.len() > ALERT_ID_MAX || id != format!("{event_id}.{start_ms}.{lead}") {
        return Err(Refused::Id);
    }
    let label = read_label(&m["label"])?;
    if !m["acts"].as_array().is_some_and(Vec::is_empty) {
        return Err(Refused::Acts);
    }
    Ok(Alert { id: id.to_string(), event_id: event_id.to_string(), at_ms, start_ms, all_day, label, lead_min: lead as u32 })
}

/// The set `value` is, or why it is none. `live` is who this shell serves now: a set is taken only
/// under that mailbox, so a window cannot set alerts for an account this shell is not signed in as.
pub fn read(value: &serde_json::Value, live: &Live, now_ms: u64) -> Result<Set, Refused> {
    let m = exactly(value, &["scope", "alerts"])?;
    let scope = m["scope"].as_str().filter(|text| is_id(text, ID_MAX, '~')).ok_or(Refused::Scope)?;
    if !matches!(live, Live::Mailbox(serving, _) if serving == scope) {
        return Err(Refused::AnotherScope);
    }
    let list = m["alerts"].as_array().ok_or(Refused::Members)?;
    if list.len() > MOST {
        return Err(Refused::TooMany);
    }
    let mut alerts: Vec<Alert> = Vec::with_capacity(list.len());
    let mut ids = HashSet::new();
    for item in list {
        let alert = read_alert(item)?;
        if alert.at_ms > now_ms.saturating_add(AHEAD_MS + READ_SLACK_MS) {
            return Err(Refused::Window);
        }
        if alerts.last().is_some_and(|before| before.at_ms > alert.at_ms) || !ids.insert(alert.id.clone()) {
            return Err(Refused::Order);
        }
        alerts.push(alert);
    }
    Ok(Set { scope: scope.to_string(), alerts })
}

/// May `alert` ring now? The set held was made under the mailbox served now, the alert still stands
/// in it at the same minute, that minute has come, and no longer ago than an alert may ring late.
pub fn may_ring(alert: &Alert, held: Option<&Set>, live: Option<&str>, now_ms: u64) -> bool {
    let (Some(held), Some(live)) = (held, live) else {
        return false;
    };
    if !is_id(live, ID_MAX, '~') || held.scope != live {
        return false;
    }
    if !held.alerts.iter().any(|standing| standing.id == alert.id && standing.at_ms == alert.at_ms) {
        return false;
    }
    now_ms >= alert.at_ms && now_ms - alert.at_ms <= LATE_MS
}

/// The one set this shell holds, and what it has rung of it.
#[derive(Default)]
pub struct Book {
    held: Option<Set>,
    session: u64,
    rung: HashMap<String, u64>,
}

impl Book {
    /// Take a set whole: the one before is gone. Another account's set also forgets what was rung.
    pub fn set(&mut self, set: Set) {
        if self.held.as_ref().is_some_and(|held| held.scope != set.scope) {
            self.rung.clear();
        }
        self.held = Some(set);
    }

    /// Nothing is held and nothing rings.
    pub fn clear(&mut self) {
        self.held = None;
        self.rung.clear();
    }

    /// The ids of the alerts held, in the set's order.
    pub fn ids(&self) -> Vec<String> {
        self.held.as_ref().map(|held| held.alerts.iter().map(|alert| alert.id.clone()).collect()).unwrap_or_default()
    }

    /// The minute of the next alert not yet asked for.
    pub fn next_at(&self) -> Option<u64> {
        self.held.as_ref()?.alerts.iter().find(|alert| !self.rung.contains_key(&alert.id)).map(|alert| alert.at_ms)
    }

    /// The alerts that ring now under `live`, in the set's order, each once. Asked under another
    /// mailbox or under nobody, the book drops its set and answers nothing. An alert whose minute
    /// passed too long ago is never rung, now or later.
    pub fn due(&mut self, live: Option<&str>, now_ms: u64) -> Vec<Alert> {
        let Some(held) = self.held.as_ref() else {
            return Vec::new();
        };
        if live != Some(held.scope.as_str()) {
            self.clear();
            return Vec::new();
        }
        // Withdrawals retain recent deliveries. Keep an expired id only while its stale alert
        // remains held, so the clock never wakes again for that alert.
        self.rung.retain(|id, at| now_ms.saturating_sub(*at) <= LATE_MS || held.alerts.iter().any(|a| a.id == *id));
        let mut out = Vec::new();
        for alert in &held.alerts {
            if alert.at_ms > now_ms {
                break;
            }
            if self.rung.insert(alert.id.clone(), alert.at_ms).is_some() {
                continue;
            }
            if may_ring(alert, Some(held), live, now_ms) {
                out.push(alert.clone());
            }
        }
        out
    }
}

/// The book as the command and the ringing thread share it. `turn` moves whenever the book is
/// handed a set or cleared, so a thread about to sleep on an older reading wakes at once.
#[derive(Default)]
pub struct Alerts {
    inner: Mutex<Schedule>,
    woken: Condvar,
}

#[derive(Default)]
struct Schedule {
    book: Book,
    turn: u64,
    document: u64,
    revision: u64,
}

impl Alerts {
    pub fn document(&self) -> u64 { self.inner.lock().expect("alerts").document }

    pub fn with_document<T>(&self, document: u64, submit: impl FnOnce() -> T) -> Option<T> {
        let inner = self.inner.lock().expect("alerts");
        (inner.document == document).then(submit)
    }

    /// A previous document can still have IPC requests in transit. Retire them and its
    /// standing events, keeping recent deliveries so a reload does not repeat an occurrence.
    pub fn start_document(&self) {
        let mut inner = self.inner.lock().expect("alerts");
        inner.document += 1;
        inner.revision = 0;
        if let Some(held) = &mut inner.book.held { held.alerts.clear(); }
        inner.turn += 1;
        self.woken.notify_all();
    }

    pub fn receive_ordered(&self, raw: &serde_json::Value, live: impl FnOnce() -> Live, now: u64, document: u64, session: u64, revision: u64) -> Result<Vec<String>, Refused> {
        let mut inner = self.inner.lock().expect("alerts");
        let live = live();
        let owner = match &live {
            Live::Mailbox(_, generation) => Some(*generation),
            Live::Unknown if inner.book.held.is_some() => Some(inner.book.session),
            _ => None,
        };
        if document != inner.document || owner != Some(session) || revision <= inner.revision {
            return Err(Refused::Superseded);
        }
        let turn = inner.turn;
        let outcome = self.apply(&mut inner, raw, live, now);
        // Even an installation refused during a restart may have withdrawn the prior set.
        if turn != inner.turn { inner.revision = revision; }
        outcome
    }

    #[cfg(test)]
    pub fn receive(&self, value: &serde_json::Value, live: impl FnOnce() -> Live, now_ms: u64) -> Result<Vec<String>, Refused> {
        let mut inner = self.inner.lock().expect("alerts");
        self.apply(&mut inner, value, live(), now_ms)
    }

    fn apply(&self, inner: &mut Schedule, value: &serde_json::Value, live: Live, now_ms: u64) -> Result<Vec<String>, Refused> {
        let withdrawing = live == Live::Unknown;
        let scope = if withdrawing {
            let held = inner.book.held.as_ref().ok_or(Refused::AnotherScope)?;
            Live::Mailbox(held.scope.clone(), inner.book.session)
        } else {
            live
        };
        let set = read(value, &scope, now_ms)?;
        if let Live::Mailbox(_, session) = scope {
            if session != inner.book.session { inner.book.clear(); }
            inner.book.session = session;
        }
        let refused = withdrawing && !set.alerts.is_empty();
        if withdrawing {
            inner.book.set(Set { scope: set.scope, alerts: vec![] });
        } else {
            inner.book.set(set);
        }
        inner.turn += 1;
        self.woken.notify_all();
        if refused { Err(Refused::AnotherScope) } else { Ok(inner.book.ids()) }
    }

    /// Drop everything: a sign-out.
    pub fn clear(&self) {
        let mut inner = self.inner.lock().expect("alerts");
        inner.book.clear();
        inner.document += 1;
        inner.revision = 0;
        inner.turn += 1;
        self.woken.notify_all();
    }

    /// Ask the platform outside the lock. While it answers, the person may change the schedule,
    /// the event's privacy or the mailbox. Only the current set can then reach the drawing call.
    pub fn dispatch(
        &self, live: impl Fn() -> Live, now: impl Fn() -> u64, permitted: impl FnOnce() -> bool, mut draw: impl FnMut(&Alert, &Live, u64),
    ) -> (Duration, u64) {
        let due_now = self.inner.lock().expect("alerts").book.next_at().is_some_and(|at| at <= now());
        let expected = live();
        let permission = (due_now && matches!(expected, Live::Mailbox(_, _))).then(permitted);
        let mut inner = self.inner.lock().expect("alerts");
        let now_ms = now();
        let current = live();
        match &current {
            Live::Nobody => inner.book.clear(),
            Live::Mailbox(mailbox, session) if *session != inner.book.session || inner.book.held.as_ref().is_some_and(|set| set.scope != *mailbox) => inner.book.clear(),
            Live::Mailbox(mailbox, _) if current == expected && permission.is_some() => {
                let due = inner.book.due(Some(mailbox), now_ms);
                for alert in &due {
                    if permission == Some(true) && live() == current && may_ring(alert, inner.book.held.as_ref(), Some(mailbox), now()) {
                        draw(alert, &current, inner.document);
                    }
                }
            }
            _ => {}
        }
        let sleep = match inner.book.next_at() {
            None => IDLE,
            Some(_) if current == Live::Unknown => POLL,
            Some(at) => Duration::from_millis(at.saturating_sub(now())).min(POLL),
        };
        (sleep, inner.turn)
    }

    /// Sleep for `at_most`, or until the book has moved past `turn`.
    pub fn sleep(&self, turn: u64, at_most: Duration) {
        let inner = self.inner.lock().expect("alerts");
        let _ = self.woken.wait_timeout_while(inner, at_most, |inner| inner.turn == turn).expect("alerts");
    }
}

/// How an alert says its lead. The window's own rule (`leadWords`), held equal by one table
/// (`packages/client-engine/test/notice-lead-words.json`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lead {
    Now,
    Today,
    Tomorrow,
    Minutes(u32),
    Hours(u32),
    Days(u32),
    Weeks(u32),
}

/// The words' form for `lead_min` minutes before the start. A time of day says the largest unit that
/// divides the lead evenly; a whole day says how many days before the day the alert rings.
pub fn lead_words(lead_min: u32, all_day: bool) -> Lead {
    if all_day {
        return match lead_min.div_ceil(1440) {
            0 => Lead::Today,
            1 => Lead::Tomorrow,
            days if days % 7 == 0 => Lead::Weeks(days / 7),
            days => Lead::Days(days),
        };
    }
    match lead_min {
        0 => Lead::Now,
        min if min % 10_080 == 0 => Lead::Weeks(min / 10_080),
        min if min % 1440 == 0 => Lead::Days(min / 1440),
        min if min % 60 == 0 => Lead::Hours(min / 60),
        min => Lead::Minutes(min),
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

/// The title and the body this shell shows for `alert`, in `language`. The title is the event's
/// label, cleaned once more; the body is the shell's own words for the lead, and never holds a word
/// of the event.
pub fn compose(alert: &Alert, language: Language) -> (String, String) {
    let w: &AlertWords = AlertWords::of(language);
    let title = match &alert.label {
        Label::Title(text) => clean_title(text).unwrap_or_else(|| w.event.to_string()),
        Label::Busy => w.busy.to_string(),
        Label::Event => w.event.to_string(),
    };
    let body = match (lead_words(alert.lead_min, alert.all_day), alert.all_day) {
        (Lead::Now, _) => w.now.to_string(),
        (Lead::Today, _) => w.today.to_string(),
        (Lead::Tomorrow, _) => w.tomorrow.to_string(),
        (Lead::Minutes(n), _) => counted(w.minute_one, w.minute_many, n),
        (Lead::Hours(n), _) => counted(w.hour_one, w.hour_many, n),
        (Lead::Days(n), false) => counted(w.day_one, w.day_many, n),
        (Lead::Weeks(n), false) => counted(w.week_one, w.week_many, n),
        (Lead::Days(n), true) => w.all_days.replace("{count}", &n.to_string()),
        (Lead::Weeks(n), true) => counted(w.all_week_one, w.all_week_many, n),
    };
    (title, body)
}

#[cfg(test)]
#[path = "alerts_tests.rs"]
mod tests;
