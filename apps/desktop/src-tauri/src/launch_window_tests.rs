//! The launch window: shown exactly once, never before its canvas is painted, and never left
//! hidden. The recorder keeps every call in order, so a show before its paint fails here.

use super::*;
use std::sync::Mutex;

/// Records every call in order; `absent` is a window that does not exist yet.
#[derive(Clone, Default)]
struct Rec(Arc<Mutex<Vec<String>>>, Arc<AtomicBool>);

impl Rec {
    fn calls(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

impl Surface for Rec {
    fn paint(&self, canvas: Rgb) {
        self.0.lock().unwrap().push(format!("paint {}", format_canvas(canvas)));
    }
    fn show(&self) -> bool {
        if self.1.load(Ordering::SeqCst) {
            self.0.lock().unwrap().push("no window".to_string());
            return false;
        }
        self.0.lock().unwrap().push("show".to_string());
        true
    }
}

/// A directory of this test's own, removed first so a previous run cannot answer for this one.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ohmail-launch-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn a_canvas_is_hash_and_six_hex_digits_and_nothing_else() {
    assert_eq!(parse_canvas("#1a1b26"), Some((0x1a, 0x1b, 0x26)));
    assert_eq!(parse_canvas(" #1A1B26\n"), Some((0x1a, 0x1b, 0x26)));
    for bad in ["", "1a1b26", "#1a1b2", "#1a1b266", "#gg1b26", "rgb(26, 27, 38)", "#1a1b26;x", "#+1a1b2"] {
        assert_eq!(parse_canvas(bad), None, "{bad:?} must not be read as a colour");
    }
}

#[test]
fn the_kept_canvas_round_trips_and_is_written_only_when_it_changed() {
    let dir = scratch("keep");
    assert_eq!(read_kept(&dir), None, "no file is no canvas");
    keep(&dir, (0x1a, 0x1b, 0x26)).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join(CANVAS_FILE)).unwrap(), "#1a1b26\n");
    assert_eq!(read_kept(&dir), Some((0x1a, 0x1b, 0x26)));
    // The same colour in another spelling is not rewritten: the file stays as it was.
    std::fs::write(dir.join(CANVAS_FILE), "#1A1B26\n").unwrap();
    keep(&dir, (0x1a, 0x1b, 0x26)).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join(CANVAS_FILE)).unwrap(), "#1A1B26\n");
    keep(&dir, (0xe3, 0xe4, 0xe8)).unwrap();
    assert_eq!(read_kept(&dir), Some((0xe3, 0xe4, 0xe8)));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_kept_file_that_is_not_a_canvas_is_no_canvas() {
    let dir = scratch("junk");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(CANVAS_FILE), format!("#1a1b26{}", "x".repeat(1 << 20))).unwrap();
    assert_eq!(read_kept(&dir), None, "a long file is read to its bound and refused");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_kept_canvas_paints_the_window_and_shows_it_at_once() {
    let dir = scratch("new");
    keep(&dir, (0x1a, 0x1b, 0x26)).unwrap();
    let rec = Rec::default();
    let launch = Launch::new(rec.clone(), Some(dir.clone()));
    assert!(launch.is_shown());
    assert_eq!(rec.calls(), vec!["paint #1a1b26", "show"], "painted, then shown, never the reverse");
    // A theme changed since: this launch's report paints the new canvas and keeps it for the next.
    assert!(launch.ready(Some("#13141c")).is_none(), "already shown");
    assert_eq!(rec.calls(), vec!["paint #1a1b26", "show", "paint #13141c"]);
    assert_eq!(read_kept(&dir), Some((0x13, 0x14, 0x1c)));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_first_launch_stays_hidden_until_something_shows_it() {
    let rec = Rec::default();
    let launch = Launch::new(rec.clone(), Some(scratch("first")));
    assert!(!launch.is_shown());
    assert!(rec.calls().is_empty(), "nothing kept: not painted and not shown");
}

#[test]
fn the_report_paints_its_canvas_before_the_show_and_keeps_it() {
    let dir = scratch("ready");
    let rec = Rec::default();
    let launch = Launch::new(rec.clone(), Some(dir.clone()));
    assert!(launch.ready(Some("#13141c")).is_some());
    assert_eq!(rec.calls(), vec!["paint #13141c", "show"]);
    assert_eq!(read_kept(&dir), Some((0x13, 0x14, 0x1c)), "kept for the next launch");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_report_without_a_canvas_still_shows_the_window() {
    let dir = scratch("nocanvas");
    let rec = Rec::default();
    let launch = Launch::new(rec.clone(), Some(dir.clone()));
    assert!(launch.ready(Some("rgba(0, 0, 0, 0)")).is_some());
    assert!(Launch::new(Rec::default(), None).ready(None).is_some());
    assert_eq!(rec.calls(), vec!["show"], "no paint, and never a hidden window");
    assert_eq!(read_kept(&dir), None, "nothing kept");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_window_is_shown_exactly_once() {
    let rec = Rec::default();
    let launch = Launch::new(rec.clone(), None);
    assert!(launch.ready(None).is_some(), "the first show is the one that happens");
    assert!(launch.ready(None).is_none(), "a reload's report shows nothing again");
    assert!(launch.show().is_none());
    assert_eq!(rec.calls(), vec!["show"]);
}

#[test]
fn a_page_that_never_reports_is_shown_after_the_bound() {
    let rec = Rec::default();
    let launch = Arc::new(Launch::new(rec.clone(), None));
    let said = Arc::new(Mutex::new(None));
    let slot = Arc::clone(&said);
    let bound = Duration::from_millis(150);
    let fallback = arm_fallback(Arc::clone(&launch), bound, move |at| *slot.lock().unwrap() = Some(at));
    std::thread::sleep(Duration::from_millis(40));
    assert!(rec.calls().is_empty(), "still hidden inside the bound");
    fallback.join().unwrap();
    assert_eq!(rec.calls(), vec!["show"], "shown by the bound");
    let at = said.lock().unwrap().expect("the fallback's show is said");
    assert!(at >= bound, "not before the bound: {at:?}");
}

#[test]
fn the_bound_shows_nothing_after_the_page_reported() {
    let rec = Rec::default();
    let launch = Arc::new(Launch::new(rec.clone(), None));
    assert!(launch.ready(None).is_some());
    let said = Arc::new(Mutex::new(false));
    let slot = Arc::clone(&said);
    arm_fallback(Arc::clone(&launch), Duration::from_millis(10), move |_| *slot.lock().unwrap() = true)
        .join()
        .unwrap();
    assert_eq!(rec.calls(), vec!["show"]);
    assert!(!*said.lock().unwrap(), "the bound says nothing when it showed nothing");
}

#[test]
fn the_bound_is_short_enough_that_a_first_launch_never_looks_dead() {
    // Only a first launch waits for it; a page that died appears inside a second and a half.
    assert!(FALLBACK >= Duration::from_millis(1000), "{FALLBACK:?}");
    assert!(FALLBACK <= Duration::from_millis(1500), "{FALLBACK:?}");
}

#[test]
fn a_window_that_does_not_exist_yet_is_not_counted_as_shown() {
    // Measured: the config window is created when the loop starts, so an early show found none and,
    // counted as shown, disarmed every later door and left the app invisible.
    let dir = scratch("absent");
    keep(&dir, (0x1a, 0x1b, 0x26)).unwrap();
    let rec = Rec::default();
    rec.1.store(true, Ordering::SeqCst);
    let launch = Arc::new(Launch::new(rec.clone(), Some(dir.clone())));
    assert!(!launch.is_shown(), "no window: not shown");
    rec.1.store(false, Ordering::SeqCst);
    arm_fallback(Arc::clone(&launch), Duration::from_millis(10), |_| ()).join().unwrap();
    assert!(launch.is_shown(), "the bound shows it once the window exists");
    assert_eq!(rec.calls(), vec!["paint #1a1b26", "no window", "show"]);
    let _ = std::fs::remove_dir_all(&dir);
}
