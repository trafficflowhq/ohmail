//! THE OMARCHY FEED'S TAURI FACE — one command, one event, one thread.
//!
//! `omarchy_core.rs` is the machinery (detection, the raw read, the quiet-debounced watch)
//! and is deliberately Tauri-free so a harness can compile and run it where cargo exists and
//! this app's toolchain does not. This file is everything that touches the runtime:
//!
//!  · the `omarchy_theme` COMMAND — the window's pull at mount. The same cold-start
//!    reasoning as `mailto_claim`: an event emitted before the bundle's scripts run is an
//!    event nobody hears, so the window asks once when it is ready. `None` is the honest
//!    answer everywhere that is not an Omarchy system, and the window then does nothing.
//!  · the `omarchy:theme` EVENT — the push when `omarchy theme set` (or any restage) goes
//!    quiet. Same one-way channel as the menu's: the window hears the shell over the one
//!    `core:event:allow-listen` grant it already holds, and can make the shell hear nothing.
//!  · the WATCH thread — spawned only when detection succeeds, so off-Omarchy (macOS,
//!    Windows, every non-Omarchy Linux) this module's whole runtime cost is one directory
//!    stat at launch. The thread is never joined: it sleeps 500 ms between re-reads of three
//!    small files, holds no lock and owns no resource, and the process's exit is its exit —
//!    the same lifetime the platform gives every daemon thread.
//!
//! The payload is RAW material (files and tool stdout, bounded, verbatim) — the window's
//! `packages/tokens/omarchy/` modules own every parse, and the module header of
//! `omarchy_core.rs` says why that boundary is load-bearing.

use crate::omarchy_core;

/// The event the shell emits when the desktop's theme has changed and gone quiet. The
/// frontend's `omarchy.ts` listens for this name; the payload is `gather`'s JSON.
pub const OMARCHY_THEME_EVENT: &str = "omarchy:theme";

/// The window asks: is this an Omarchy system, and what is its theme right now?
///
/// `async` like every command here — the gather runs `fc-match` and `hyprctl`, and a
/// subprocess does not belong on the main thread. `None` means "not Omarchy, or no readable
/// theme": the two are deliberately one answer, because the window's response to both is the
/// same — static defaults, nothing applied, nothing retried.
#[tauri::command(async)]
pub fn omarchy_theme() -> Option<serde_json::Value> {
    omarchy_core::state_dir().and_then(|current| omarchy_core::gather(&current))
}

/// Start following the desktop theme, if there is one to follow. Called once from `main.rs`
/// after the app is built; detection failing is the normal case on two of the three
/// platforms and most of the third, and costs exactly the stat it took to find out.
pub fn watch(app: tauri::AppHandle) {
    let Some(current) = omarchy_core::state_dir() else {
        return;
    };
    crate::engine::log_line(format_args!(
        "omarchy detected; the window follows the desktop theme live"
    ));
    let spawned = std::thread::Builder::new()
        .name("omarchy-theme-watch".into())
        .spawn(move || {
            use tauri::Emitter;
            omarchy_core::watch(&current, omarchy_core::POLL, |payload| {
                // A failed emit is the menu's rule: the window may be closing, and a theme
                // the window did not hear about is re-fetched at its next mount anyway.
                let _ = app.emit(OMARCHY_THEME_EVENT, payload);
            });
        });
    if spawned.is_err() {
        // No thread, no feed — the window still pulls the current theme at mount, so the
        // cost of this failure is live re-skins, not the theme itself.
        crate::engine::log_line(format_args!(
            "the omarchy theme watch thread could not be started; \
             the theme applies at launch and will not follow live changes"
        ));
    }
}
