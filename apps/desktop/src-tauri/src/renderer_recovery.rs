//! A DEAD RENDERER IS NEVER LEFT AS A FRAME.
//!
//! When the web content process dies the window keeps its last frame and answers nothing: on 0.25.1
//! an accessibility focus killed WebKitGTK's web process and only a relaunch helped. The first death
//! reloads the page with a mark it reads to say so; a second within [`WINDOW`] offers a relaunch
//! instead, so a page that dies on load is never a reload loop. Linux hooks WebKitGTK's
//! `web-process-terminated`. macOS (WKWebView `webViewWebContentProcessDidTerminate:`, which Tauri
//! exposes as `Builder::on_web_content_process_terminate`) and Windows (WebView2 `ProcessFailed`)
//! take the same [`Deaths`] and are not hooked yet.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::time::{Duration, Instant};

/// A second death this soon after the first is a pattern, not luck: a relaunch is offered.
pub const WINDOW: Duration = Duration::from_secs(300);

/// The query the reloaded page reads (`apps/desktop/src/renderer-reloaded.ts`) and then drops.
pub const RELOADED_MARK: &str = "renderer=reloaded";

/// What one death is answered with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Load the page again, marked, so it says what happened.
    Reload,
    /// Reloading again could loop: ask to relaunch the app instead.
    OfferRelaunch,
    /// The relaunch is already on screen; nothing loads under it.
    AlreadyOffered,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Reload => "reloaded",
            Action::OfferRelaunch => "relaunch_offered",
            Action::AlreadyOffered => "relaunch_already_offered",
        }
    }
}

/// The deaths this window has had. One per window, shared by the signal and nothing else.
#[derive(Debug, Default)]
pub struct Deaths {
    last: Option<Instant>,
    offered: bool,
}

impl Deaths {
    /// Record a death at `now` and say what answers it.
    pub fn on_death(&mut self, now: Instant) -> Action {
        let recent = self.last.is_some_and(|at| now.saturating_duration_since(at) < WINDOW);
        self.last = Some(now);
        if !recent {
            return Action::Reload;
        }
        if self.offered {
            return Action::AlreadyOffered;
        }
        self.offered = true;
        Action::OfferRelaunch
    }
}

/// The page's own address with the mark, keeping the view it showed (the hash) and nothing else.
pub fn reload_uri(current: &str) -> String {
    let (before, hash) = current.find('#').map_or((current, ""), |at| current.split_at(at));
    let base = before.split('?').next().unwrap_or(before);
    format!("{base}?{RELOADED_MARK}{hash}")
}

/// The diagnostic line, in the shell's JSON shape: why the process ended and what answered it.
pub fn line(reason: &str, action: Action) -> String {
    format!(
        "{{\"service\":\"shell\",\"event\":\"renderer_gone\",\"reason\":\"{reason}\",\"action\":\"{}\"}}",
        action.as_str()
    )
}

pub const RELAUNCH_TITLE: &str = "ohmail's window stopped";
pub const RELAUNCH_MESSAGE: &str = "ohmail's window stopped again. Relaunch ohmail to open it.";
pub const RELAUNCH_BUTTON: &str = "Relaunch";
pub const QUIT_BUTTON: &str = "Quit";

fn emit(line: &str) {
    #[cfg(feature = "local-engine")]
    crate::engine::log_json_line(line);
    #[cfg(not(feature = "local-engine"))]
    {
        use std::io::Write;
        let _ = std::io::stderr().write_all(format!("{line}\n").as_bytes());
    }
}

/// The relaunch, asked natively: it needs no renderer, so it cannot die the way the page did.
fn offer_relaunch<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let answer = app.clone();
    app.dialog()
        .message(RELAUNCH_MESSAGE)
        .title(RELAUNCH_TITLE)
        .buttons(MessageDialogButtons::OkCancelCustom(RELAUNCH_BUTTON.into(), QUIT_BUTTON.into()))
        .show(move |relaunch| {
            // Both through the event loop's own exit, so the engine is stopped on the way out.
            if relaunch {
                answer.request_restart();
            } else {
                answer.exit(0);
            }
        });
}

#[cfg(target_os = "linux")]
fn reason_name(reason: webkit2gtk::WebProcessTerminationReason) -> &'static str {
    use webkit2gtk::WebProcessTerminationReason as Why;
    match reason {
        Why::Crashed => "crashed",
        Why::ExceededMemoryLimit => "memory_limit",
        Why::TerminatedByApi => "terminated_by_api",
        _ => "unknown",
    }
}

/// From the one `setup`, where the config window exists: watch its web process from now on.
pub fn arm<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(target_os = "linux")]
    {
        use std::sync::{Arc, Mutex};
        use tauri::Manager;
        let Some(window) = app.get_webview_window("main") else {
            emit("{\"service\":\"shell\",\"event\":\"renderer_watch\",\"armed\":false,\"reason\":\"no_window\"}");
            return;
        };
        let handle = app.clone();
        let deaths = Arc::new(Mutex::new(Deaths::default()));
        let armed = window.with_webview(move |platform| {
            use webkit2gtk::WebViewExt;
            platform.inner().connect_web_process_terminated(move |view, reason| {
                // A poisoned lock still answers: a reload is the safe default for one death.
                let action = deaths
                    .lock()
                    .map(|mut d| d.on_death(Instant::now()))
                    .unwrap_or(Action::Reload);
                emit(&line(reason_name(reason), action));
                match action {
                    Action::Reload => match view.uri() {
                        Some(uri) => view.load_uri(&reload_uri(&uri)),
                        None => view.reload(),
                    },
                    Action::OfferRelaunch => offer_relaunch(&handle),
                    Action::AlreadyOffered => {}
                }
            });
        });
        if armed.is_err() {
            emit("{\"service\":\"shell\",\"event\":\"renderer_watch\",\"armed\":false,\"reason\":\"no_webview\"}");
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

#[cfg(test)]
#[path = "renderer_recovery_tests.rs"]
mod tests;
