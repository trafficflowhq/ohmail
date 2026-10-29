//! THE OMARCHY FEED'S MACHINERY — detection, the raw read, and the quiet-debounced watch.
//!
//! On an Omarchy system (and honestly detected as one, never guessed from "Linux") the
//! desktop's own theme is a live source for the ohmarchy face: `omarchy theme set` restages
//! `~/.local/state/omarchy/current/theme/` and this module notices, gathers the RAW material,
//! and hands it up. `omarchy.rs` is the thin Tauri layer over it — the command and the event.
//!
//! ── WHY THIS FILE IS std + serde_json AND NOTHING ELSE ──────────────────────────────────────
//!
//! Deliberately no Tauri type anywhere in it, for a reason this repository keeps paying for:
//! there is no Rust toolchain on the machine that writes this code — the tag workflow's cargo
//! build is the one compiler that ever sees it. A module with zero dependencies beyond what
//! `Cargo.toml` already carries for every build (`serde_json` is a direct dependency) is a
//! module a throwaway harness can compile and RUN against a real Omarchy install before the
//! tag exists — which is exactly how this one was verified, against a live Omarchy 4.0.2
//! system. Keep it that way: anything Tauri belongs in `omarchy.rs`.
//!
//! ── RAW TEXT OUT, EVERY PARSE IN THE WINDOW ─────────────────────────────────────────────────
//!
//! The payload carries file contents and tool stdout VERBATIM (bounded), never parsed values.
//! The window's `packages/tokens/omarchy/` modules own every rule that turns system fact into
//! token value, because that is the layer with tests against the 22 real themes — and a format
//! surprise there degrades to "that slot keeps its default" instead of to a shell-side parse
//! error nobody can see. The shell's only judgments are: which files, which tools, how big is
//! too big, and when a restage has gone quiet.
//!
//! ── THE WATCH IS A POLL, AND THAT IS A DECISION, NOT A SHORTCUT ─────────────────────────────
//!
//! inotify is the obvious mechanism and it is not used, on the conservative-compile rule
//! above: the `notify` crate would be a new dependency compiled first by the release tag, and
//! raw inotify FFI is exactly the kind of code that must never meet its first compiler in a
//! release workflow. A 500 ms re-read of a few small files costs nothing measurable, needs no
//! platform branch, and — because it compares CONTENT, not mtimes — cannot be fooled by an
//! in-place rewrite that keeps size and second. `omarchy theme set` restages over ~3 s
//! (measured on a real install), so the debounce below waits for two identical consecutive
//! samples — quiet — rather than firing on the first difference and reading a half-staged
//! directory.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// A `colors.toml` is under a kilobyte and a generated `shell.toml` a few; a megabyte-scale
/// file at these paths is not a theme, and refusing it here bounds what can ever cross the
/// bridge into the window.
const FILE_MAX: u64 = 256 * 1024;
/// `theme.name` is one slug line.
const NAME_MAX: u64 = 4 * 1024;
/// fc-match answers a family list, hyprctl a one-line JSON object.
const STDOUT_MAX: usize = 4 * 1024;

/// How often the watch re-reads, and how long "quiet" is (one interval).
pub const POLL: Duration = Duration::from_millis(500);

/// Polls between two reads of Hyprland's live gaps and border (2 s): `hyprctl keyword`, `eval`
/// or a reloaded config moves them with no file under the state dir changing.
pub const HYPR_EVERY: u32 = 4;

/// The Omarchy 4 state directory — `$XDG_STATE_HOME`/`~/.local/state` + `omarchy/current` —
/// IF this system is an Omarchy one: the staged `theme` DIRECTORY inside it is the v4 active-
/// theme mechanism itself (a directory, not the symlink older docs assumed), so its presence
/// is the honest detector. Absent → `None` → no watcher, no thread, no cost.
pub fn state_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_STATE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|v| !v.is_empty())
                .map(|home| PathBuf::from(home).join(".local").join("state"))
        })?;
    let current = base.join("omarchy").join("current");
    if current.join("theme").is_dir() {
        Some(current)
    } else {
        None
    }
}

/// One file, whole, or `None` past the bound / unreadable / not a file. A refusal and an
/// absence are the same answer on purpose: both mean "this ingredient is not available",
/// and the window's fallback (keep the last good theme) is right for either.
fn read_capped(path: &Path, cap: u64) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > cap {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// What the window may say about a staged theme it could not map, each code with the words the
/// log line carries: a closed vocabulary, so no text from the page reaches the log.
pub const REFUSALS: &[(&str, &str)] = &[
    ("no-palette", "its colors.toml has no readable background and foreground"),
    ("missing-accent", "missing accent"),
    ("missing-red", "missing red (and color1)"),
    ("not-a-color", "a color that is not 6-digit hex"),
    ("floor-ink", "its text misses the 4.5:1 contrast floor"),
    ("floor-accent", "its accent misses the contrast floor"),
    ("floor-on-accent", "text on its accent misses the 4.5:1 contrast floor"),
    ("floor-danger", "its red misses the 4.5:1 contrast floor"),
    ("floor-tag", "a tag color misses the 4.5:1 contrast floor"),
];

/// The staged theme's name, as `theme.name` holds it.
pub fn theme_name(current: &Path) -> Option<String> {
    read_capped(&current.join("theme.name"), NAME_MAX)
}

/// The log line for a refused theme, or `None` for a code outside [`REFUSALS`]. A name that is
/// not a plain slug is left out rather than written.
pub fn refusal_line(name: Option<&str>, code: &str) -> Option<String> {
    let why = REFUSALS.iter().find(|entry| entry.0 == code)?.1;
    let slug = name.map(str::trim).filter(|n| {
        !n.is_empty()
            && n.len() <= 64
            && n.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    });
    Some(match slug {
        Some(slug) => format!("omarchy theme \"{slug}\" refused: {why}; the window keeps its last theme"),
        None => format!("omarchy theme refused: {why}; the window keeps its last theme"),
    })
}

/// Past this many staged Hyprland toggles the directory is not Omarchy's.
const TOGGLES_MAX: usize = 64;

/// What the poll compares: the active theme's identity and content, the Hyprland toggles
/// Omarchy stages beside it, and Hyprland's live gaps, by VALUE. A toggle (the window-gaps one)
/// or a gaps change alone changes what the payload reads without touching a theme file.
#[derive(Clone, PartialEq, Eq)]
pub struct Sample {
    name: Option<String>,
    colors: Option<String>,
    shell: Option<String>,
    hypr_toggles: Vec<(String, Option<String>)>,
    hypr: Option<String>,
}

impl Sample {
    /// The same sample with Hyprland's live answers in it (`hypr_reading`).
    pub fn with_hypr(mut self, hypr: Option<String>) -> Self {
        self.hypr = hypr;
        self
    }
}

/// Read the current sample. Never fails — an unreadable file is an absent ingredient.
pub fn sample(current: &Path) -> Sample {
    Sample {
        name: read_capped(&current.join("theme.name"), NAME_MAX),
        colors: read_capped(&current.join("theme").join("colors.toml"), FILE_MAX),
        shell: read_capped(&current.join("theme").join("shell.toml"), FILE_MAX),
        hypr_toggles: hypr_toggles(current),
        hypr: None,
    }
}

/// `<state>/omarchy/toggles/hypr`, beside `current`: each staged toggle's name and content,
/// sorted so the comparison never flaps on directory order.
fn hypr_toggles(current: &Path) -> Vec<(String, Option<String>)> {
    let Some(dir) = current.parent().map(|p| p.join("toggles").join("hypr")) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<std::ffi::OsString> =
        entries.filter_map(|e| e.ok().map(|e| e.file_name())).collect();
    names.sort();
    names.truncate(TOGGLES_MAX);
    names
        .into_iter()
        .map(|n| {
            let content = read_capped(&dir.join(&n), FILE_MAX);
            (n.to_string_lossy().into_owned(), content)
        })
        .collect()
}

/// One tool's stdout, verbatim, bounded — or `None` for a tool that is missing, failed, or
/// answered something no real invocation answers. `fc-match` and `hyprctl` both exit fast;
/// they run at gather time (a theme, toggle or gaps change), and `hyprctl` every `HYPR_EVERY`
/// polls for `hypr_reading`.
fn tool_stdout(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    if text.is_empty() || text.len() > STDOUT_MAX {
        return None;
    }
    Some(text)
}

/// Hyprland's live gaps and border, the three answers `gather` sends, joined: compared on the
/// poll, never parsed here. `None` when Hyprland answers none of them.
fn hypr_reading() -> Option<String> {
    let answers = ["general:gaps_in", "general:gaps_out", "general:border_size"]
        .map(|option| tool_stdout("hyprctl", &["getoption", option, "-j"]));
    if answers.iter().all(Option::is_none) {
        return None;
    }
    Some(answers.map(Option::unwrap_or_default).join("\n"))
}

/// The payload the window maps: the theme's own files plus the system facts, all raw. `None`
/// when there is no readable `colors.toml` — mid-restage, or not a theme — and the window
/// then keeps what it has. Field names are the contract with `packages/tokens/omarchy/`
/// (`OmarchyThemeRaw` in `map.ts`); the window validates every one before use.
pub fn gather(current: &Path) -> Option<serde_json::Value> {
    let s = sample(current);
    let colors = s.colors?;
    Some(serde_json::json!({
        "slug": s.name.as_deref().map(str::trim).unwrap_or(""),
        "colorsToml": colors,
        "shellToml": s.shell,
        "fcMono": tool_stdout("fc-match", &["-f", "%{family}", "monospace"]),
        "hyprGapsIn": tool_stdout("hyprctl", &["getoption", "general:gaps_in", "-j"]),
        "hyprGapsOut": tool_stdout("hyprctl", &["getoption", "general:gaps_out", "-j"]),
        "hyprBorderSize": tool_stdout("hyprctl", &["getoption", "general:border_size", "-j"]),
    }))
}

/// The debounce, as a value the tests can drive without a clock: feed it each poll's sample,
/// and it answers "emit now" exactly when a CHANGED sample has held still for one whole
/// interval — quiet — and not before. `omarchy theme set` stages file after file for ~3 s;
/// firing on the first difference would read (and briefly render) a half-staged theme.
pub struct Debounce {
    last_emitted: Sample,
    pending: Option<Sample>,
}

impl Debounce {
    /// Seeded with the state at watch start: the window PULLS its first theme over the
    /// command, so the watch owes only changes, and the seed is what "changed" means.
    pub fn new(initial: Sample) -> Self {
        Debounce { last_emitted: initial, pending: None }
    }

    /// One poll. `true` = the change is quiet, gather and emit now. The emitted sample
    /// becomes the new baseline even if the gather then fails (a theme that cannot be read
    /// is not retried every interval — the NEXT change, e.g. the restage completing, is a
    /// new difference and fires again).
    pub fn step(&mut self, now: Sample) -> bool {
        if now == self.last_emitted {
            self.pending = None;
            return false;
        }
        match &self.pending {
            Some(candidate) if *candidate == now => {
                self.last_emitted = now;
                self.pending = None;
                true
            }
            _ => {
                self.pending = Some(now);
                false
            }
        }
    }
}

/// The watch itself: poll, debounce, gather, hand the payload to `emit`. Runs forever on the
/// caller's thread — the caller decides the thread and what `emit` does (the app emits a
/// Tauri event; the verification harness prints a line).
pub fn watch<F: FnMut(serde_json::Value)>(current: &Path, poll: Duration, mut emit: F) -> ! {
    let mut hypr = hypr_reading();
    let mut debounce = Debounce::new(sample(current).with_hypr(hypr.clone()));
    let mut tick: u32 = 0;
    loop {
        std::thread::sleep(poll);
        tick = tick.wrapping_add(1);
        if tick % HYPR_EVERY == 0 {
            hypr = hypr_reading();
        }
        if debounce.step(sample(current).with_hypr(hypr.clone())) {
            if let Some(payload) = gather(current) {
                emit(payload);
            }
        }
    }
}

#[cfg(test)]
#[path = "omarchy_core_tests.rs"]
mod tests;
