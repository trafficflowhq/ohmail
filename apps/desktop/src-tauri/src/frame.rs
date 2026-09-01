//! WHO DRAWS THE FRAME — the app, or the compositor.
//!
//! On most desktops a window is a rectangle the application decorates: a title bar with the
//! close button in it, and under that, on Windows and Linux, the menu bar. That is right on
//! GNOME, on KDE, on Windows and on macOS, and it is what this app has always drawn.
//!
//! On a TILING WAYLAND COMPOSITOR it is wrong, and visibly so. The compositor owns every
//! window's geometry and draws its own border around it; it has a keyboard grammar for
//! moving, resizing, tabbing and closing, and no window there has a title bar. An app that
//! draws one anyway gets TWO frames — the compositor's border around the app's own title bar
//! — and spends a row of pixels on buttons the compositor already provides by key. So on
//! those sessions this app draws neither a title bar nor a menu bar, and the compositor's
//! frame is the only one.
//!
//! ── WHY THE COMPOSITOR IS THE SIGNAL AND THE DISTRIBUTION IS NOT ───────────────────────────
//!
//! Omarchy is the system this was reported from, and Omarchy is easy to detect: its
//! `/etc/os-release` says `ID=omarchy`, it installs an `omarchy` binary and it stages a theme
//! under `~/.local/state/omarchy/current` (which is what `omarchy_core::state_dir` reads, for a
//! different question). None of that is the right test HERE, in either direction:
//!
//!   · it is too NARROW — plain Arch, Fedora or NixOS running Hyprland has exactly the same
//!     two frames, and a fix keyed on one distribution leaves every one of those users with
//!     the defect that was reported;
//!   · and it is too BROAD — the frame is a property of the session, not of the packages
//!     installed. Somebody running GNOME on Omarchy wants their title bar, and a test keyed on
//!     the operating system would take it away.
//!
//! What actually decides is which compositor is running, and the desktop-entry specification
//! already has the variable for it: `XDG_CURRENT_DESKTOP`, a colon-separated list the session
//! sets, corroborated by `XDG_SESSION_DESKTOP`. Measured on a real Omarchy 4.0.2 install: the
//! Hyprland session's own environment carries `XDG_CURRENT_DESKTOP=Hyprland`,
//! `XDG_SESSION_DESKTOP=Hyprland`, `XDG_SESSION_TYPE=wayland` — and `OMARCHY_PATH`, which is
//! the distribution fact this deliberately does not read.
//!
//! ── AND WHY WAYLAND IS PART OF THE TEST RATHER THAN AN AFTERTHOUGHT ────────────────────────
//!
//! Under X11 there is nothing to fix: decoration is the window manager's, negotiated through
//! the window manager's own protocol, and a tiling X11 window manager simply does not draw a
//! title bar for a window it manages — GTK asks and is refused, and the result is already
//! frameless. Wayland has no such negotiation that GTK 3 speaks: GTK 3 does not implement
//! `xdg-decoration`, so it draws its own title bar on EVERY Wayland compositor, and the tiling
//! ones then draw their border around it. The double frame is a Wayland-only fault, which is
//! why the session type is a condition and not a detail.
//!
//! ── THE ESCAPE HATCH, FOR THE SAME REASON THE LINUX LAUNCHER HAS ONE ───────────────────────
//!
//! `OHMAIL_DECORATIONS=1` forces the title bar and menu bar back on a session this would
//! otherwise strip them from; `OHMAIL_DECORATIONS=0` strips them anywhere. Both directions,
//! because a detection rule about somebody else's desktop should never be the only answer —
//! and because it is what makes both halves of this testable on a machine that is neither.
//!
//! ── THE COST, STATED RATHER THAN GLOSSED ──────────────────────────────────────────────────
//!
//! No menu bar means no menu ACCELERATORS: Ctrl+N and Ctrl+1…Ctrl+5 are bound to menu items,
//! and an uninstalled menu binds nothing. Every one of those actions is reachable from the
//! page's own keymap (`c` composes, the bare digits switch views, `?` prints the map), which
//! is why this is acceptable — the menu was always a second WAY to the client's own commands
//! and never a second implementation. The one thing that was ONLY in the bar is the update
//! item, and that is why Settings now carries the same flow (`updater.rs`'s `update_press`).

/// Who draws this window's frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Frame {
    /// The app draws a title bar and, on Windows and Linux, a menu bar. Every desktop that is
    /// not a tiling Wayland compositor, and macOS always.
    AppDraws,
    /// The compositor owns the frame: no decorations, no menu bar.
    CompositorOwns,
}

impl Frame {
    /// Whether to ask the platform for decorations. Reads as the window property it sets.
    pub fn decorations(self) -> bool {
        self == Frame::AppDraws
    }

    /// Whether to install a menu bar at all. Same answer, different question — kept separate
    /// because they are separate properties of the window and a future session type could
    /// reasonably want one and not the other.
    pub fn menu_bar(self) -> bool {
        self == Frame::AppDraws
    }
}

/// The environment variable that overrides the detection, in both directions.
pub const OVERRIDE: &str = "OHMAIL_DECORATIONS";

/// The tiling Wayland compositors this recognises by name, lower-cased, as they appear in
/// `XDG_CURRENT_DESKTOP` / `XDG_SESSION_DESKTOP`.
///
/// Five, and each one is a compositor that tiles by default and draws its own border: Hyprland
/// (what Omarchy ships, and the one this was measured against), sway, river, niri and dwl. The
/// list is short on purpose — it is an assertion about how somebody else's desktop behaves, and
/// each entry should be one somebody can check. A stacking Wayland compositor (labwc, Wayfire's
/// default mode) is NOT here: those expect a client to decorate itself, which is what this app
/// already does.
pub const TILING_WAYLAND: [&str; 5] = ["hyprland", "sway", "river", "niri", "dwl"];

/// A compositor's own socket variable, and the compositor it proves.
///
/// An independent way in, for a session started without a display manager: `Hyprland` launched
/// from a tty sets `HYPRLAND_INSTANCE_SIGNATURE` for its children whether or not anything set
/// `XDG_CURRENT_DESKTOP`. Presence of the socket is the compositor saying so itself, which is
/// stronger evidence than the desktop name — but it exists for fewer of them, so it is a second
/// route rather than the only one.
pub const TILING_SOCKETS: [(&str, &str); 3] = [
    ("HYPRLAND_INSTANCE_SIGNATURE", "hyprland"),
    ("SWAYSOCK", "sway"),
    ("NIRI_SOCKET", "niri"),
];

/// Is this session Wayland? `XDG_SESSION_TYPE` is the answer the session manager writes; a live
/// `WAYLAND_DISPLAY` is the answer the compositor writes, and either alone is enough — a
/// compositor started from a tty often sets the second and nothing sets the first.
fn wayland(look: &impl Fn(&str) -> Option<String>) -> bool {
    if look("XDG_SESSION_TYPE").is_some_and(|t| t.eq_ignore_ascii_case("wayland")) {
        return true;
    }
    look("WAYLAND_DISPLAY").is_some_and(|d| !d.is_empty())
}

/// The tiling Wayland compositor this session is running, if it is running one.
///
/// Returns the name from [`TILING_WAYLAND`] rather than a bool, so the log line can say which —
/// a support report that names the compositor is worth more than one that says "some tiling
/// thing". `XDG_CURRENT_DESKTOP` is a COLON-SEPARATED LIST by specification (`zorin:GNOME` on
/// the machine this was written on), so it is split before matching; a substring test there
/// would match `Hyprland` inside a longer word and is not used.
pub fn compositor(look: impl Fn(&str) -> Option<String>) -> Option<&'static str> {
    if !wayland(&look) {
        return None;
    }
    for key in ["XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP"] {
        let Some(value) = look(key) else { continue };
        for token in value.split(':') {
            let token = token.trim();
            if let Some(found) = TILING_WAYLAND.iter().find(|c| token.eq_ignore_ascii_case(c)) {
                return Some(found);
            }
        }
    }
    for (variable, name) in TILING_SOCKETS {
        if look(variable).is_some_and(|v| !v.is_empty()) {
            return Some(name);
        }
    }
    None
}

/// Who draws the frame, given a way to read the environment.
///
/// Pure, and the whole rule: the override first (both directions, so a person on a session this
/// gets wrong is never stuck with it), then the compositor. Driven directly by `frame_tests.rs`
/// rather than described there — the truth table is the feature.
pub fn decide(look: impl Fn(&str) -> Option<String>) -> Frame {
    match look(OVERRIDE).as_deref().map(str::trim) {
        Some("1") | Some("true") | Some("on") | Some("yes") => return Frame::AppDraws,
        Some("0") | Some("false") | Some("off") | Some("no") => return Frame::CompositorOwns,
        // An empty or unrecognised value is not an override. Refusing to guess is the same rule
        // the launcher hook follows for `GDK_BACKEND`: an unset variable means "you decide".
        _ => {}
    }
    if compositor(&look).is_some() {
        Frame::CompositorOwns
    } else {
        Frame::AppDraws
    }
}

/// Who draws the frame on THIS process's session.
///
/// Linux only, and that is a property of the compiled binary rather than of a branch: macOS
/// draws the frame and the global menu bar itself and has no compositor to hand either to, and
/// Windows has no tiling Wayland. Elsewhere this is the constant `AppDraws` and the rule above
/// is not consulted at all.
#[cfg(target_os = "linux")]
pub fn decide_from_env() -> Frame {
    decide(|key| std::env::var(key).ok())
}

#[cfg(not(target_os = "linux"))]
pub fn decide_from_env() -> Frame {
    Frame::AppDraws
}

/// One line for the log, when and only when this changed something.
///
/// Silent in the ordinary case: a message on every launch of every desktop would bury the one
/// launch where somebody is asking why their title bar is missing.
#[cfg(target_os = "linux")]
pub fn describe(look: impl Fn(&str) -> Option<String>) -> Option<String> {
    if decide(&look) == Frame::AppDraws {
        return None;
    }
    Some(match look(OVERRIDE) {
        Some(_) => format!("{OVERRIDE} asks for no window decorations; the menu bar is not built"),
        None => format!(
            "{} owns the window frame; ohmail draws no title bar and no menu bar. \
             Set {OVERRIDE}=1 to keep them.",
            compositor(&look).unwrap_or("the compositor"),
        ),
    })
}

/// Say it, in the build that has no engine log to say it into.
///
/// `write_all` and not `eprintln!`, for `engine::log_line`'s reason: a windowed build may have
/// no stderr at all and `eprintln!` panics when the write fails. A lost log line must never take
/// the app down.
#[cfg(all(target_os = "linux", not(feature = "local-engine")))]
pub fn note(line: &str) {
    use std::io::Write;
    let _ = std::io::stderr().write_all(format!("ohmail: {line}\n").as_bytes());
}

#[cfg(test)]
#[path = "frame_tests.rs"]
mod tests;
