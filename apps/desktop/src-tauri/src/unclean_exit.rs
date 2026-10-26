//! A RUN THAT VANISHED IS LOGGED ON THE NEXT START.
//!
//! A crash in GTK or WebKit takes the process with no line of its own. The shell writes a marker
//! (its pid) in the app data directory at start and removes it on a clean exit: the loop's last
//! event, and the step before a restart or the Windows installer ends the process. A marker found
//! at start means the last run ended some other way, and one `previous_run_ended_unclean` line says
//! so with the marker's age (since that run started) and its pid, which a core dump can be matched
//! to. The line carries no path.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

pub const MARKER_FILE: &str = "running.marker";

/// The app data directory, once [`arm`] has run.
static DIR: OnceLock<PathBuf> = OnceLock::new();

/// The line for a marker the last run left.
fn line(age: Option<Duration>, pid: Option<u32>) -> String {
    let mut out = String::from("{\"service\":\"shell\",\"event\":\"previous_run_ended_unclean\"");
    if let Some(age) = age {
        out.push_str(&format!(",\"ageSec\":{}", age.as_secs()));
    }
    if let Some(pid) = pid {
        out.push_str(&format!(",\"pid\":{pid}"));
    }
    out.push('}');
    out
}

/// A start in `dir`: the line for a marker the last run left, then this run's own marker.
pub fn arm_in(dir: &Path, pid: u32, now: SystemTime) -> Option<String> {
    let path = dir.join(MARKER_FILE);
    let left = std::fs::metadata(&path).ok().map(|meta| {
        let age = meta.modified().ok().and_then(|at| now.duration_since(at).ok());
        line(age, read_pid(&path))
    });
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(&path, format!("{pid}\n"));
    left
}

/// A clean exit from `dir`: the marker goes only if `pid` wrote it, so a leaving copy never takes
/// the marker of the copy that replaced it.
pub fn clear_in(dir: &Path, pid: u32) {
    let path = dir.join(MARKER_FILE);
    if read_pid(&path) == Some(pid) {
        let _ = std::fs::remove_file(path);
    }
}

fn read_pid(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// From `main`, once the runtime is built (a second instance has left by then) and the log is open.
pub fn arm(app: &tauri::App) {
    use tauri::Manager;
    let Ok(dir) = app.path().app_data_dir() else { return };
    if let Some(line) = arm_in(&dir, std::process::id(), SystemTime::now()) {
        emit(&line);
    }
    let _ = DIR.set(dir);
}

/// A clean exit: this run's marker goes.
pub fn clear() {
    if let Some(dir) = DIR.get() {
        clear_in(dir, std::process::id());
    }
}

/// The Windows installer did not start after [`clear`]: the run goes on, so its marker comes back.
pub fn rearm() {
    if let Some(dir) = DIR.get() {
        let _ = arm_in(dir, std::process::id(), SystemTime::now());
    }
}

/// Linux: a session's end (SIGTERM at logout or shutdown, SIGHUP) runs `quit`, so the run ends
/// through the loop's Exit. Neither GTK nor tao answers them, and their default leaves the marker.
/// From the main thread, which owns the default main context.
#[cfg(target_os = "linux")]
pub fn quit_on_session_end(quit: impl Fn() + 'static) {
    use gtk::glib;
    let quit = std::rc::Rc::new(quit);
    for signum in [15, 1] {
        let quit = std::rc::Rc::clone(&quit);
        glib::unix_signal_add_local(signum, move || {
            quit();
            glib::ControlFlow::Continue
        });
    }
}

fn emit(line: &str) {
    #[cfg(feature = "local-engine")]
    crate::engine::log_json_line(line);
    #[cfg(not(feature = "local-engine"))]
    {
        use std::io::Write;
        let _ = std::io::stderr().write_all(format!("{line}\n").as_bytes());
    }
}

#[cfg(test)]
#[path = "unclean_exit_tests.rs"]
mod tests;
