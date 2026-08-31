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
//! tag exists, which is exactly how this one was verified (the VM of `OMARCHY-VM.md`; the
//! close-out records the runs). Keep it that way: anything Tauri belongs in `omarchy.rs`.
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
//! release workflow. A 500 ms re-read of three small files costs nothing measurable, needs no
//! platform branch, and — because it compares CONTENT, not mtimes — cannot be fooled by an
//! in-place rewrite that keeps size and second. `omarchy theme set` restages over ~3 s
//! (measured, `OMARCHY-VM.md`), so the debounce below waits for two identical consecutive
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

/// What the poll compares: the active theme's identity and content, by VALUE. Everything the
/// restage touches that the mapping reads is in here — a change to any of the three is a
/// theme change, and nothing else is.
#[derive(Clone, PartialEq, Eq)]
pub struct Sample {
    name: Option<String>,
    colors: Option<String>,
    shell: Option<String>,
}

/// Read the current sample. Never fails — an unreadable file is an absent ingredient.
pub fn sample(current: &Path) -> Sample {
    Sample {
        name: read_capped(&current.join("theme.name"), NAME_MAX),
        colors: read_capped(&current.join("theme").join("colors.toml"), FILE_MAX),
        shell: read_capped(&current.join("theme").join("shell.toml"), FILE_MAX),
    }
}

/// One tool's stdout, verbatim, bounded — or `None` for a tool that is missing, failed, or
/// answered something no real invocation answers. `fc-match` and `hyprctl` both exit fast;
/// they are run only at gather time (a theme change), never on the poll.
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
    let mut debounce = Debounce::new(sample(current));
    loop {
        std::thread::sleep(poll);
        if debounce.step(sample(current)) {
            if let Some(payload) = gather(current) {
                emit(payload);
            }
        }
    }
}

#[cfg(test)]
#[path = "omarchy_core_tests.rs"]
mod tests;
