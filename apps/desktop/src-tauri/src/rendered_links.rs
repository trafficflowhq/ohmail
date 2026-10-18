//! THE LINKS ON SCREEN. `open_external` and the message frame's new-window door used to open any
//! http(s) address [`external_url`] admitted by shape, so whatever got a string to either door —
//! app code holding a value out of a message, a sanitizer miss that raised a frame navigation into
//! the macOS link door — could hand it to the person's browser. Both doors now open an address only
//! when it is a link the window's renderers reported as they drew it (a message frame's anchors,
//! the prose path's, the editor's in a draft or a signature, the Screener's unsubscribe link, the
//! minted account page), kept here per surface in a bounded set, or one of the shell's own constant
//! links ([`OWN_LINKS`]).
//!
//! The set is what the RENDERER reports, so a script already running in the window can report an
//! address and then open it; what this closes is a door handed an address no renderer drew.
//! Addresses are compared in the URL parser's own serialisation, so the webview's navigation URL
//! and the browser's `URL.href` agree; the opener is always handed the caller's own bytes. A
//! refusal is one log line naming the door, the reason and the host's class, never the address:
//! the log travels in diagnostic files.

use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;
use tauri::Url;

use crate::engine::external_url;

/// Surfaces kept, oldest evicted past it. One per mounted renderer, and a conversation mounts one
/// per message with no bound on the thread's length, so this sits past any thread a person reads;
/// [`BYTES_MAX`] is the memory bound.
pub const SURFACES_MAX: usize = 1024;

/// Links kept from one report; past it the rest are dropped and the first kept.
pub const PER_SURFACE_MAX: usize = 2048;

/// Bytes of link text kept across every surface; past it the oldest surfaces go. One report never
/// keeps more than this, so the newest surface always fits.
pub const BYTES_MAX: usize = 4 * 1024 * 1024;

/// The longest surface id taken. Printable ASCII only; anything else fails the report.
pub const SURFACE_ID_MAX: usize = 64;

/// THE SHELL'S OWN LINKS: the constant addresses the window draws as links that no message
/// supplied — each mail provider's app-password help page (`helpUrl` in
/// `packages/client-engine/src/providers.ts`, shown by the door chooser's provider picker), in
/// `URL.href` form. `desktop-rendered-links.test.tsx` holds this list equal to that file's. The web
/// client's self-host guide is not here: the desktop window draws no link to it, and a
/// `github.com/trafficflowhq` address in the binary is one `build.yml`'s first-party list refuses.
pub const OWN_LINKS: [&str; 7] = [
    "https://myaccount.google.com/apppasswords",
    "https://support.microsoft.com/account-billing/manage-app-passwords-for-two-step-verification-d6dc8c6d-4bf7-4851-ad95-6d07799387e9",
    "https://account.apple.com/account/manage",
    "https://login.yahoo.com/account/security",
    "https://app.fastmail.com/settings/security/apppasswords",
    "https://support.gmx.com/pop-imap/imap/index.html",
    "https://www.infomaniak.com/en/support/faq/2224",
];

/// The sentence a window hears for an address that is not a link on screen, in
/// [`external_url`]'s own wording.
const UNRENDERED: &str = "ohmail: this is not an address the app opens (it is not a link on screen)";

/// The links each surface reported, oldest surface first.
#[derive(Debug, Default)]
pub struct Rendered {
    surfaces: VecDeque<(String, HashSet<String>)>,
    bytes: usize,
}

/// What one report could not keep: entries refused by shape or past a cap, and older surfaces
/// evicted to make room. Counts only.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Trimmed {
    pub dropped: usize,
    pub evicted: usize,
}

impl Rendered {
    /// Replace one surface's links with `urls`; an empty list removes the surface. Each entry is
    /// judged alone — a shape refusal or a cap drops it and its siblings stay — and only a surface
    /// id this shell does not keep fails the report.
    pub fn report(&mut self, surface: &str, urls: &[String]) -> Result<Trimmed, String> {
        if surface.is_empty() || surface.len() > SURFACE_ID_MAX || !surface.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("ohmail: that is not a surface the shell keeps links for".to_string());
        }
        self.remove(surface);
        let mut trimmed = Trimmed::default();
        let mut kept = HashSet::new();
        let mut bytes = 0;
        for raw in urls {
            let Some(key) = key_of(raw) else {
                trimmed.dropped += 1;
                continue;
            };
            if kept.contains(&key) {
                continue;
            }
            if kept.len() == PER_SURFACE_MAX || bytes + key.len() > BYTES_MAX {
                trimmed.dropped += 1;
                continue;
            }
            bytes += key.len();
            kept.insert(key);
        }
        if kept.is_empty() {
            return Ok(trimmed);
        }
        self.bytes += bytes;
        self.surfaces.push_back((surface.to_string(), kept));
        while self.surfaces.len() > 1 && (self.surfaces.len() > SURFACES_MAX || self.bytes > BYTES_MAX) {
            if let Some((_, gone)) = self.surfaces.pop_front() {
                self.bytes -= bytes_of(&gone);
                trimmed.evicted += 1;
            }
        }
        Ok(trimmed)
    }

    fn remove(&mut self, surface: &str) {
        if let Some(at) = self.surfaces.iter().position(|(id, _)| id == surface) {
            if let Some((_, gone)) = self.surfaces.remove(at) {
                self.bytes -= bytes_of(&gone);
            }
        }
    }

    /// Whether any surface holds this comparison key ([`key_of`]).
    pub fn holds(&self, key: &str) -> bool {
        self.surfaces.iter().any(|(_, links)| links.contains(key))
    }

    #[cfg(test)]
    pub fn surface_ids(&self) -> Vec<&str> {
        self.surfaces.iter().map(|(id, _)| id.as_str()).collect()
    }

    #[cfg(test)]
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

fn bytes_of(links: &HashSet<String>) -> usize {
    links.iter().map(String::len).sum()
}

/// The comparison form of an address: [`external_url`]'s shape first, then the URL parser's own
/// serialisation. Compared, never spawned.
pub fn key_of(raw: &str) -> Option<String> {
    external_url(raw).ok()?;
    Url::parse(raw).ok().map(String::from)
}

/// The managed state: the links on screen, behind one lock.
#[derive(Default)]
pub struct RenderedLinks(Mutex<Rendered>);

impl RenderedLinks {
    /// Run `f` over the links held. A poisoned lock reads as no set, which refuses.
    pub fn read<T>(&self, f: impl FnOnce(Option<&Rendered>) -> T) -> T {
        let held = self.0.lock().ok();
        f(held.as_deref())
    }
}

/// The doors' read at the moment they decide: the managed set, or `None` — which refuses — before
/// `engine::manage` has put it in.
pub fn read_managed<R: tauri::Runtime, T>(app: &tauri::AppHandle<R>, f: impl FnOnce(Option<&Rendered>) -> T) -> T {
    use tauri::Manager;
    match app.try_state::<RenderedLinks>() {
        Some(links) => links.read(f),
        None => f(None),
    }
}

/// Why an address did not reach the browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    /// [`external_url`] refused it, or it does not parse.
    Shape,
    /// Not a link on screen and not one of [`OWN_LINKS`].
    Unrendered,
    /// Admitted, and the platform's opener failed.
    Opener,
}

impl Why {
    pub fn word(self) -> &'static str {
        match self {
            Why::Shape => "shape",
            Why::Unrendered => "unrendered",
            Why::Opener => "opener",
        }
    }
}

/// A refusal: the class for the log, the sentence for the window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub why: Why,
    pub sentence: String,
}

/// THE PREDICATE BOTH DOORS ASK. [`external_url`]'s shape first, then the address must be one of
/// [`OWN_LINKS`] or a link some surface reported, compared in [`key_of`]'s form. No set (the state
/// is not managed yet) refuses everything. Answers the caller's own bytes, never the comparison
/// form: what was judged is what is spawned.
pub fn admitted<'a>(url: &'a str, set: Option<&Rendered>) -> Result<&'a str, Refusal> {
    let shaped = external_url(url).map_err(|sentence| Refusal { why: Why::Shape, sentence })?;
    let key = Url::parse(shaped).map(String::from).map_err(|_| Refusal {
        why: Why::Shape,
        sentence: "ohmail: this is not an address the app opens (it does not parse)".to_string(),
    })?;
    match set {
        Some(set) if OWN_LINKS.contains(&key.as_str()) || set.holds(&key) => Ok(shaped),
        _ => Err(Refusal { why: Why::Unrendered, sentence: UNRENDERED.to_string() }),
    }
}

/// Which door refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Door {
    /// `open_external`, the app document's opener.
    Command,
    /// The new-window door: `on_new_window`, and `link_door` on macOS.
    Popup,
}

impl Door {
    fn word(self) -> &'static str {
        match self {
            Door::Command => "command",
            Door::Popup => "popup",
        }
    }
}

/// The refusal's line, in the shell's JSON shape: the door, the reason and the host's class
/// (`navigation::host_class`), and nothing of the address.
pub fn refusal_line(door: Door, why: Why, url: &str) -> String {
    let class = Url::parse(url).map_or("none", |u| crate::navigation::host_class(&u));
    format!(
        "{{\"service\":\"shell\",\"event\":\"open_refused\",\"door\":\"{}\",\"why\":\"{}\",\"hostClass\":\"{}\"}}",
        door.word(),
        why.word(),
        class
    )
}

/// Write [`refusal_line`] to the engine's log.
pub fn log_refusal(door: Door, why: Why, url: &str) {
    crate::engine::log_json_line(&refusal_line(door, why, url));
}

/// A report's trim, as counts.
pub fn trimmed_line(trimmed: Trimmed) -> String {
    format!(
        "{{\"service\":\"shell\",\"event\":\"rendered_links_trimmed\",\"dropped\":{},\"evicted\":{}}}",
        trimmed.dropped, trimmed.evicted
    )
}

/// The window's renderers report the http(s) links one surface draws; an empty list removes the
/// surface. SYNC, so a report is applied in IPC order, before a later `open_external`, which is
/// async. Opens nothing.
#[tauri::command]
pub fn rendered_links(set: tauri::State<'_, RenderedLinks>, surface: String, urls: Vec<String>) -> Result<(), String> {
    let trimmed = {
        let mut held = set
            .0
            .lock()
            .map_err(|_| "ohmail: the shell lost its list of links on screen".to_string())?;
        held.report(&surface, &urls)?
    };
    if trimmed != Trimmed::default() {
        crate::engine::log_json_line(&trimmed_line(trimmed));
    }
    Ok(())
}

#[cfg(test)]
#[path = "rendered_links_tests.rs"]
mod tests;
