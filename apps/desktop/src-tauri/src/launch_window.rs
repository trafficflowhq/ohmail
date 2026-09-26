//! THE WINDOW OPENS ON ITS OWN CANVAS, NEVER ON A BLANK SURFACE.
//!
//! Measured on the Omarchy guest against 0.25.1: the window was created visible and showed GTK's
//! own surface for 0.2-0.6 s before the web view's first frame, every launch; an Apple-silicon
//! machine under Asahi showed that moment pink. The window is created hidden (`tauri.conf.json`).
//! With a canvas kept from the last launch it is painted that colour and shown before the event
//! loop runs, so its first frame is the canvas and it appears as fast as it always did. With none
//! kept (a first launch) it stays hidden until the page reports its first frame composed, with
//! that frame's canvas, or [`FALLBACK`] passes: WebKitGTK paints nothing while hidden, so there is
//! no paint to wait for. Every report keeps its canvas for the next launch.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long a first launch's page may take to report before the window is shown without it. A
/// page that died shows at this bound; a launch with a kept canvas never waits at all.
pub const FALLBACK: Duration = Duration::from_millis(1500);

/// The kept canvas, beside the app's other files: `#rrggbb` and a newline, nothing else.
pub const CANVAS_FILE: &str = "window-canvas";

/// An opaque sRGB colour.
pub type Rgb = (u8, u8, u8);

/// `#rrggbb` and nothing else. The page sends what it computed, so every other spelling is a
/// page that went wrong, and the window keeps the colour it already has.
pub fn parse_canvas(text: &str) -> Option<Rgb> {
    let hex = text.trim().strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let n = u32::from_str_radix(hex, 16).ok()?;
    Some(((n >> 16) as u8, (n >> 8) as u8, n as u8))
}

#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub fn format_canvas((r, g, b): Rgb) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// The canvas the last launch reported. Bounded: the file is eight bytes when this app wrote it.
pub fn read_kept(dir: &Path) -> Option<Rgb> {
    use std::io::Read;
    let mut text = String::new();
    std::fs::File::open(dir.join(CANVAS_FILE)).ok()?.take(32).read_to_string(&mut text).ok()?;
    parse_canvas(&text)
}

/// Keep a canvas for the next launch, written only when it changed. Best effort: a lost write
/// costs the next launch its native background and nothing else.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub fn keep(dir: &Path, canvas: Rgb) -> std::io::Result<()> {
    if read_kept(dir) == Some(canvas) {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{CANVAS_FILE}.tmp"));
    std::fs::write(&tmp, format!("{}\n", format_canvas(canvas)))?;
    std::fs::rename(&tmp, dir.join(CANVAS_FILE))
}

/// What the window is asked to do. The shipped one is the main window; the tests' one records.
pub trait Surface: Send + Sync + 'static {
    /// The native background: the window's own surface and the web view's before its first frame.
    fn paint(&self, canvas: Rgb);
    /// Whether there was a window to show.
    fn show(&self) -> bool;
}

/// One launch's window: shown exactly once, by whichever of its doors arrives first.
pub struct Launch<S: Surface> {
    surface: S,
    shown: AtomicBool,
    dir: Option<PathBuf>,
    started: Instant,
}

impl<S: Surface> Launch<S> {
    /// With a kept canvas the window is painted and shown now; without one it stays hidden.
    pub fn new(surface: S, dir: Option<PathBuf>) -> Self {
        let kept = dir.as_deref().and_then(read_kept);
        let launch = Launch { surface, shown: AtomicBool::new(false), dir, started: Instant::now() };
        if let Some(canvas) = kept {
            launch.surface.paint(canvas);
            launch.show();
        }
        launch
    }

    /// Whether the window is already on screen.
    pub fn is_shown(&self) -> bool {
        self.shown.load(Ordering::SeqCst)
    }

    /// The page's report. A canvas it computed is painted before the show and kept for the next
    /// launch; anything else is ignored and the window is shown as it is.
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    pub fn ready(&self, canvas: Option<&str>) -> Option<Duration> {
        if let Some(rgb) = canvas.and_then(parse_canvas) {
            self.surface.paint(rgb);
            if let Some(dir) = &self.dir {
                let _ = keep(dir, rgb);
            }
        }
        self.show()
    }

    /// Show the window unless something already has. Answers how long after the launch it was.
    pub fn show(&self) -> Option<Duration> {
        if self.shown.swap(true, Ordering::SeqCst) {
            return None;
        }
        if !self.surface.show() {
            // No window yet: not shown, so the next door (the report, the bound) tries again.
            self.shown.store(false, Ordering::SeqCst);
            return None;
        }
        Some(self.started.elapsed())
    }
}

/// The bound: shown after `after` if nothing else showed it first.
pub fn arm_fallback<S: Surface>(
    launch: Arc<Launch<S>>,
    after: Duration,
    said: impl FnOnce(Duration) + Send + 'static,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        std::thread::sleep(after);
        if let Some(at) = launch.show() {
            said(at);
        }
    })
}

/// The main window, as the launch sees it. Both calls are messages to the event loop, taken in
/// the order sent, so a paint sent before a show lands first.
pub struct MainWindow<R: tauri::Runtime>(pub tauri::AppHandle<R>);

impl<R: tauri::Runtime> Surface for MainWindow<R> {
    fn paint(&self, (r, g, b): Rgb) {
        use tauri::Manager;
        if let Some(window) = self.0.get_webview_window("main") {
            let _ = window.set_background_color(Some(tauri::window::Color(r, g, b, 255)));
        }
    }
    fn show(&self) -> bool {
        use tauri::Manager;
        self.0.get_webview_window("main").is_some_and(|window| window.show().is_ok())
    }
}

type Shipped<R> = Arc<Launch<MainWindow<R>>>;

/// The one line: which of the three showed the window, and when.
fn say(why: &str, after: Duration) {
    let line = format!("the window was shown by {why} {} ms after launch", after.as_millis());
    #[cfg(feature = "local-engine")]
    crate::engine::log_line(format_args!("{line}"));
    #[cfg(not(feature = "local-engine"))]
    {
        use std::io::Write;
        let _ = std::io::stderr().write_all(format!("ohmail: {line}\n").as_bytes());
    }
}

/// From the one `setup`: the config window exists there and is still hidden, so a kept canvas is
/// on it before its first frame. The bound is armed either way and shows nothing once shown.
pub fn prepare<R: tauri::Runtime>(app: &tauri::App<R>) {
    use tauri::Manager;
    let dir = app.path().app_data_dir().ok();
    let launch: Shipped<R> = Arc::new(Launch::new(MainWindow(app.handle().clone()), dir));
    app.manage(Arc::clone(&launch));
    if launch.is_shown() {
        say("the kept canvas", launch.started.elapsed());
    }
    arm_fallback(launch, FALLBACK, |at| say("the fallback", at));
}

/// The page's report that its first frame is composed, with that frame's canvas.
#[cfg(feature = "local-engine")]
#[tauri::command]
pub fn window_ready<R: tauri::Runtime>(app: tauri::AppHandle<R>, canvas: Option<String>) {
    use tauri::Manager;
    if let Some(launch) = app.try_state::<Shipped<R>>() {
        if let Some(at) = launch.ready(canvas.as_deref()) {
            say("the page's report", at);
        }
    }
}

/// The preview's page has no command to report with, so its window is shown when the document
/// has loaded. The engine build waits for the report, which carries the canvas.
#[cfg(not(feature = "local-engine"))]
pub fn attach<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.on_page_load(|webview, payload| {
        use tauri::Manager;
        if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) || webview.label() != "main" {
            return;
        }
        if let Some(launch) = webview.app_handle().try_state::<Shipped<R>>() {
            if let Some(at) = launch.show() {
                say("the document's load", at);
            }
        }
    })
}

#[cfg(test)]
#[path = "launch_window_tests.rs"]
mod tests;
