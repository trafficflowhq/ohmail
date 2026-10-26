//! A DEAD RENDERER IS NEVER LEFT AS A FRAME.
//!
//! When the web content process dies the window keeps its last frame and answers nothing: on 0.25.1
//! an accessibility focus killed WebKitGTK's web process and only a relaunch helped. The first death
//! reloads the page with a mark it reads to say so; a second within [`WINDOW`] offers a relaunch
//! instead, so a page that dies on load is never a reload loop. Linux hooks WebKitGTK's
//! `web-process-terminated` and Windows WebView2's `ProcessFailed`, both from [`arm`]. macOS
//! (the builder's `on_web_content_process_terminate`) takes the same [`Deaths`] and is not hooked yet.
#![cfg_attr(not(any(target_os = "linux", target_os = "windows")), allow(dead_code))]

use std::path::Path;
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

    /// A death no reload can reach (WebView2's browser process is gone with every page in it):
    /// the relaunch is offered once, and never twice.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn on_fatal(&mut self, now: Instant) -> Action {
        self.last = Some(now);
        if self.offered {
            return Action::AlreadyOffered;
        }
        self.offered = true;
        Action::OfferRelaunch
    }
}

/// What one WebView2 process failure is, by its `COREWEBVIEW2_PROCESS_FAILED_KIND` value.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// The page's renderer exited (1) or stopped answering (2): the page is gone, reload it.
    Renderer(&'static str),
    /// The browser process exited (0), taking the webview with it: only a relaunch helps.
    Browser,
    /// A GPU, utility, helper or frame renderer process, which does not take the page with it.
    Ignored,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn windows_failure(kind: i32) -> Failure {
    match kind {
        1 => Failure::Renderer("render_exited"),
        2 => Failure::Renderer("render_unresponsive"),
        0 => Failure::Browser,
        _ => Failure::Ignored,
    }
}

/// The page's own address with the mark, keeping the view it showed (the hash) and nothing else.
pub fn reload_uri(current: &str) -> String {
    let (before, hash) = current.find('#').map_or((current, ""), |at| current.split_at(at));
    let base = before.split('?').next().unwrap_or(before);
    format!("{base}?{RELOADED_MARK}{hash}")
}

/// What the machine looked like when the process died: WebKit says `crashed` both for a real
/// crash and for the kernel's OOM kill, and these numbers tell the two apart. On systemd desktops
/// that start each app in its own unit (`OOMPolicy=stop`), an OOM kill of the renderer ends the
/// whole app, so a toast with `crashed` there is a crash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Context {
    /// Whole minutes since the watch was armed.
    pub uptime_min: u64,
    /// `MemAvailable` when WebKit reports the death, in kB: after the dead process's memory is
    /// freed, so it never shows the renderer's own size. `None` when it could not be read.
    pub mem_available_kb: Option<u64>,
    /// OOM kills of this app's own processes since the previous death (or launch); `None` when
    /// either reading failed.
    pub oom_kills: Option<u64>,
}

/// `MemAvailable` from a `/proc/meminfo` body, in kB; any other unit is no reading.
pub fn parse_mem_available_kb(meminfo: &str) -> Option<u64> {
    let rest = meminfo.lines().find_map(|l| l.strip_prefix("MemAvailable:"))?;
    let mut parts = rest.split_whitespace();
    let kb = parts.next()?.parse().ok()?;
    (parts.next() == Some("kB")).then_some(kb)
}

/// The `oom_kill` counter from a cgroup v2 `memory.events` body.
pub fn parse_oom_kill(events: &str) -> Option<u64> {
    events.lines().find_map(|l| l.strip_prefix("oom_kill ")).and_then(|n| n.trim().parse().ok())
}

/// OOM kills charged to this app's own cgroup v2 (`proc_self` is `/proc/self`, `cgroup_root`
/// `/sys/fs/cgroup`). The kernel charges a kill to the victim's cgroup and its parents, never to
/// a sibling, so another program's kill is not counted; outside Flatpak the renderer shares the
/// shell's cgroup. `None` on cgroup v1, in the root cgroup, or when a file cannot be read.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn own_oom_kills_in(proc_self: &Path, cgroup_root: &Path) -> Option<u64> {
    let membership = std::fs::read_to_string(proc_self.join("cgroup")).ok()?;
    let scope = membership.lines().find_map(|l| l.strip_prefix("0::"))?.trim().trim_start_matches('/');
    if scope.is_empty() {
        return None;
    }
    std::fs::read_to_string(cgroup_root.join(scope).join("memory.events")).ok().as_deref().and_then(parse_oom_kill)
}

/// The context of a death at `now`, read from `proc_root` (`/proc`) and `cgroup_root`. `oom_before`
/// is the app's own OOM count at the previous death (or launch) and is re-based to this one's.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn context_in(
    proc_root: &Path,
    cgroup_root: &Path,
    armed_at: Instant,
    oom_before: &mut Option<u64>,
    now: Instant,
) -> Context {
    let mem_available_kb =
        std::fs::read_to_string(proc_root.join("meminfo")).ok().as_deref().and_then(parse_mem_available_kb);
    let current = own_oom_kills_in(&proc_root.join("self"), cgroup_root);
    let oom_kills = oom_before.zip(current).map(|(before, now)| now.saturating_sub(before));
    if current.is_some() {
        *oom_before = current;
    }
    Context { uptime_min: now.saturating_duration_since(armed_at).as_secs() / 60, mem_available_kb, oom_kills }
}

fn number(n: Option<u64>) -> String {
    n.map_or_else(|| "null".to_owned(), |n| n.to_string())
}

/// The diagnostic line, in the shell's JSON shape: why the process ended, what answered it, and
/// the numbers that tell an OOM kill from a crash. Numbers and fixed words only.
pub fn line(reason: &str, action: Action, ctx: &Context) -> String {
    format!(
        "{{\"service\":\"shell\",\"event\":\"renderer_gone\",\"reason\":\"{reason}\",\"action\":\"{}\",\"uptimeMin\":{},\"memAvailableKb\":{},\"oomKills\":{}}}",
        action.as_str(),
        ctx.uptime_min,
        number(ctx.mem_available_kb),
        number(ctx.oom_kills)
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
            // The quit waits for the engine after the loop (`leave_the_process`); a restart exits
            // from inside it, so the relaunch waits for the engine first, as the update's does.
            // Both wait for an install still writing (the install fence, `updater.rs`).
            if relaunch {
                crate::updater::after_the_engine(&answer, || {
                    crate::inherited_fds::withhold_from_the_restart();
                    crate::unclean_exit::clear();
                    answer.request_restart();
                });
            } else {
                crate::updater::quit(&answer, 0);
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

/// Load the page again with the mark, keeping its view; a page whose address cannot be read
/// reloads as it is.
#[cfg(target_os = "windows")]
fn reload_page(url: tauri::Result<tauri::Url>, navigate: impl Fn(tauri::Url), reload: impl Fn()) {
    match url.ok().and_then(|u| tauri::Url::parse(&reload_uri(u.as_str())).ok()) {
        Some(next) => navigate(next),
        None => reload(),
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
        let armed_at = Instant::now();
        let oom_before = Mutex::new(own_oom_kills_in(Path::new("/proc/self"), Path::new("/sys/fs/cgroup")));
        let armed = window.with_webview(move |platform| {
            use webkit2gtk::WebViewExt;
            platform.inner().connect_web_process_terminated(move |view, reason| {
                // A poisoned lock still answers: a reload is the safe default for one death.
                let now = Instant::now();
                let action = deaths.lock().map(|mut d| d.on_death(now)).unwrap_or(Action::Reload);
                let ctx = {
                    let mut before = oom_before.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    context_in(Path::new("/proc"), Path::new("/sys/fs/cgroup"), armed_at, &mut before, now)
                };
                emit(&line(reason_name(reason), action, &ctx));
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
    #[cfg(target_os = "windows")]
    {
        use std::sync::{Arc, Mutex};
        use tauri::Manager;
        let Some(window) = app.get_webview_window("main") else {
            emit("{\"service\":\"shell\",\"event\":\"renderer_watch\",\"armed\":false,\"reason\":\"no_window\"}");
            return;
        };
        let handle = app.clone();
        let page = window.clone();
        let deaths = Arc::new(Mutex::new(Deaths::default()));
        let armed_at = Instant::now();
        let armed = window.with_webview(move |platform| {
            use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND;
            // Raised on the thread that owns the webview, which is the event loop's, so the page
            // calls below are answered in place rather than queued behind this handler.
            let handler = webview2_com::ProcessFailedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                unsafe { args.ProcessFailedKind(&mut kind)? };
                let now = Instant::now();
                let (reason, action) = match windows_failure(kind.0) {
                    Failure::Ignored => return Ok(()),
                    Failure::Renderer(reason) => {
                        (reason, deaths.lock().map(|mut d| d.on_death(now)).unwrap_or(Action::Reload))
                    }
                    Failure::Browser => (
                        "browser_exited",
                        deaths.lock().map(|mut d| d.on_fatal(now)).unwrap_or(Action::OfferRelaunch),
                    ),
                };
                let ctx = Context {
                    uptime_min: now.saturating_duration_since(armed_at).as_secs() / 60,
                    mem_available_kb: None,
                    oom_kills: None,
                };
                emit(&line(reason, action, &ctx));
                match action {
                    Action::Reload => reload_page(
                        page.url(),
                        |next| {
                            let _ = page.navigate(next);
                        },
                        || {
                            let _ = page.reload();
                        },
                    ),
                    Action::OfferRelaunch => offer_relaunch(&handle),
                    Action::AlreadyOffered => {}
                }
                Ok(())
            }));
            let mut token = 0i64;
            let registered = unsafe {
                platform.controller().CoreWebView2().and_then(|core| core.add_ProcessFailed(&handler, &mut token))
            };
            if registered.is_err() {
                emit("{\"service\":\"shell\",\"event\":\"renderer_watch\",\"armed\":false,\"reason\":\"no_process_failed\"}");
            }
        });
        if armed.is_err() {
            emit("{\"service\":\"shell\",\"event\":\"renderer_watch\",\"armed\":false,\"reason\":\"no_webview\"}");
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    let _ = app;
}

#[cfg(test)]
#[path = "renderer_recovery_tests.rs"]
mod tests;
