//! When WebKitGTK gives memory back, for this whole process.
//!
//! The window once also asked for the document-viewer cache model with the back/forward cache
//! off. That ask ran before the window existed and never took effect; applied from the one
//! `setup`, a 15-minute image-heavy walk read the same renderer RSS and private memory as without
//! it (2026-09-26, three builds side by side), so it was removed rather than applied.

/// When WebKit should start giving memory back, and when it should start being rude about it.
///
/// These are FRACTIONS OF THE LIMIT below, which is the shape WebKitGTK takes them in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pressure {
    /// The ceiling the fractions are of, in MiB.
    pub limit_mib: u32,
    /// Start releasing caches here. WebKitGTK's own default is a third of the limit.
    pub conservative: f64,
    /// Release everything releasable here.
    pub strict: f64,
    /// How often the limit is checked, in seconds.
    pub poll_s: f64,
}

/// The ask. `kill` is not here and is never set: WebKitGTK can be told to KILL the web process
/// at a threshold, and a mail window that vanishes to save memory is a worse outcome than the
/// memory. Absent means disabled, which is the default, and making it unrepresentable is the
/// point of it not being a field.
pub const PRESSURE: Pressure =
    Pressure { limit_mib: 1024, conservative: 0.33, strict: 0.5, poll_s: 15.0 };

#[cfg(target_os = "linux")]
mod gtk_sink {
    use webkit2gtk::WebsiteDataManager;

    /// The process-wide pressure settings, set before any web context exists.
    pub fn pressure(p: super::Pressure) {
        let mut s = webkit2gtk::MemoryPressureSettings::new();
        s.set_memory_limit(p.limit_mib);
        s.set_conservative_threshold(p.conservative);
        s.set_strict_threshold(p.strict);
        s.set_poll_interval(p.poll_s);
        WebsiteDataManager::set_memory_pressure_settings(&mut s);
    }
}

/// Tell WebKitGTK when to give memory back, for this whole PROCESS.
///
/// Called from the top of `main`, before anything builds a window, because the WebKitGTK call
/// behind it is process-global and is read when the first web context is created — after that a
/// caller is talking to a context that has already taken its settings. There is no per-window
/// form of it: the crate's other spelling is a builder property, and the builder belongs to wry.
///
/// IT INITIALISES GTK ITSELF, and that is not tidiness. `MemoryPressureSettings::new` asserts GTK
/// is up and PANICS if it is not — measured on the guest, "GTK has not been initialized", every
/// launch, no window at all — and at the top of `main` it is not: the runtime initialises it while
/// it builds. `gtk::init` is idempotent and the runtime calls it again a moment later, so doing it
/// here buys the one seam where this setting can still be read: after GTK, before the first web
/// context. A failure to initialise is reported and is not fatal — an app that will not start
/// because it could not ask for a memory budget has turned a saving into an outage.
pub fn apply_process_pressure() {
    #[cfg(target_os = "linux")]
    {
        if let Err(e) = gtk::init() {
            eprintln!("ohmail: no memory-pressure budget was asked for: {e}");
            return;
        }
        gtk_sink::pressure(PRESSURE);
    }
}

#[cfg(test)]
#[path = "webview_budget_tests.rs"]
mod tests;
