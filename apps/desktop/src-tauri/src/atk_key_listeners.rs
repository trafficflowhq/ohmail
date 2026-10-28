//! Key listeners an accessibility client leaves while GTK is delivering a key to them.
//!
//! GTK 3 hands every key press to ATK's key listeners in a loop that reads the next list link
//! after each call. The AT-SPI bridge's listener waits for its clients inside that call, and when
//! the last client goes away during the wait it removes the listener there: GTK frees the link the
//! loop stands on and the whole app dies on SIGSEGV. A screen reader that quits or restarts while
//! you type is enough. This wraps ATK's add and remove hooks so that a removal reaches GTK only
//! once no delivery is on the stack.
//!
//! The bridge's listener also waits on its registry for every key. A slow registry makes each key
//! hold the UI thread while input queues up faster than it drains, and the window never repaints
//! again. So forwarding gets a time budget: past a short burst it may hold the thread at most half
//! the time, and a reply later than `SLOW` stops offering keys for a pause that doubles up to
//! `LAST_PAUSE`. A key not offered gets 0, as the bridge itself answers after its own timeout.
//! A release is offered exactly when its press was. The wrapper reads only a key's type and
//! hardware code, and logs neither.

use std::cell::{Cell, RefCell};
use std::os::raw::{c_int, c_uint};
use std::sync::{Once, OnceLock};
use std::time::{Duration, Instant};

use gtk::atk::ffi::{AtkKeyEventStruct, AtkKeySnoopFunc, AtkUtilClass, ATK_KEY_EVENT_RELEASE};
use gtk::glib::ffi::{gboolean, gpointer, G_PRIORITY_HIGH, G_SOURCE_REMOVE};

type AddFn = unsafe extern "C" fn(AtkKeySnoopFunc, gpointer) -> c_uint;
type RemoveFn = unsafe extern "C" fn(c_uint);

/// A reply this late, about a hundred times a healthy round trip, pauses the offers.
const SLOW: Duration = Duration::from_millis(400);
const FIRST_PAUSE: Duration = Duration::from_secs(2);
const LAST_PAUSE: Duration = Duration::from_secs(30);
/// Forwarding time allowed before the half-the-time rule bites.
const BURST: Duration = Duration::from_millis(500);
const LINE_GAP: Duration = Duration::from_secs(60);

/// One listener as the client added it. GTK holds its address as the data of `trampoline`.
pub(crate) struct Forward {
    func: AtkKeySnoopFunc,
    data: gpointer,
    removed: Cell<bool>,
    /// Hardware codes of the presses this listener was given and whose release is due.
    offered: RefCell<Vec<u16>>,
}

impl Forward {
    pub(crate) fn new(func: AtkKeySnoopFunc, data: gpointer) -> Box<Forward> {
        Box::new(Forward { func, data, removed: Cell::new(false), offered: RefCell::new(Vec::new()) })
    }

    /// A press is offered when the budget admits it; a release only when its press was.
    fn offer(&self, event: Option<&AtkKeyEventStruct>) -> bool {
        let Some(event) = event else { return admit() };
        let code = event.keycode;
        if event.type_ == ATK_KEY_EVENT_RELEASE {
            let mut offered = self.offered.borrow_mut();
            let Some(at) = offered.iter().position(|c| *c == code) else { return false };
            offered.swap_remove(at);
            return true;
        }
        if !admit() {
            return false;
        }
        let mut offered = self.offered.borrow_mut();
        if !offered.contains(&code) {
            offered.push(code);
        }
        true
    }

    fn same(&self, func: AtkKeySnoopFunc, data: gpointer) -> bool {
        self.func.map(|f| f as usize) == func.map(|f| f as usize) && self.data == data
    }
}

/// What a sweep hands to GTK, and the forwards to drop once GTK has let go of them.
pub(crate) struct Swept {
    pub(crate) keys: Vec<c_uint>,
    pub(crate) forwards: Vec<Box<Forward>>,
    pub(crate) held: u32,
}

/// The listeners GTK holds for us and the removals waiting for the stack to clear.
#[derive(Default)]
pub(crate) struct Book {
    live: Vec<(c_uint, Box<Forward>)>,
    /// Each key, and whether its removal was asked during a delivery.
    pending: Vec<(c_uint, bool)>,
    /// A sweep is scheduled.
    armed: bool,
}

impl Book {
    /// A client re-adding the pair whose removal is pending gets the old key back, so the
    /// listener is never in GTK's list twice.
    pub(crate) fn revive(&mut self, func: AtkKeySnoopFunc, data: gpointer) -> Option<c_uint> {
        let at = self.pending.iter().position(|(key, _)| {
            self.live.iter().any(|(k, f)| k == key && f.same(func, data))
        })?;
        let (key, _) = self.pending.remove(at);
        if let Some((_, f)) = self.live.iter().find(|(k, _)| *k == key) {
            f.removed.set(false);
        }
        Some(key)
    }

    pub(crate) fn record(&mut self, key: c_uint, forward: Box<Forward>) {
        self.live.push((key, forward));
    }

    /// Queues the removal; true when a sweep must be scheduled now.
    pub(crate) fn retire(&mut self, key: c_uint, depth: u32) -> bool {
        if key == 0 || self.pending.iter().any(|(k, _)| *k == key) {
            return false;
        }
        if let Some((_, f)) = self.live.iter().find(|(k, _)| *k == key) {
            f.removed.set(true);
        }
        self.pending.push((key, depth > 0));
        self.arm(depth)
    }

    /// A delivery returned, leaving `depth` on the stack; true when a sweep must be scheduled.
    pub(crate) fn returned(&mut self, depth: u32) -> bool {
        self.arm(depth)
    }

    fn arm(&mut self, depth: u32) -> bool {
        if depth > 0 || self.armed || self.pending.is_empty() {
            return false;
        }
        self.armed = true;
        true
    }

    /// Nothing while a delivery is on the stack: its return schedules the sweep again.
    pub(crate) fn sweep(&mut self, depth: u32) -> Option<Swept> {
        self.armed = false;
        if depth > 0 {
            return None;
        }
        let pending = std::mem::take(&mut self.pending);
        let mut swept = Swept { keys: Vec::new(), forwards: Vec::new(), held: 0 };
        for (key, held) in pending {
            swept.keys.push(key);
            swept.held += held as u32;
            if let Some(at) = self.live.iter().position(|(k, _)| *k == key) {
                swept.forwards.push(self.live.swap_remove(at).1);
            }
        }
        Some(swept)
    }
}

/// How long forwarding has held the UI thread, and the pause a late reply started.
pub(crate) struct Budget {
    debt: Duration,
    drained_at: Option<Instant>,
    paused_until: Option<Instant>,
    next_pause: Duration,
    held_back: u32,
    line_at: Option<Instant>,
}

impl Default for Budget {
    fn default() -> Budget {
        Budget {
            debt: Duration::ZERO,
            drained_at: None,
            paused_until: None,
            next_pause: FIRST_PAUSE,
            held_back: 0,
            line_at: None,
        }
    }
}

impl Budget {
    /// Drains the debt by half the time since the last key; true when this key may be offered.
    pub(crate) fn admit(&mut self, now: Instant) -> bool {
        if let Some(at) = self.drained_at {
            self.debt = self.debt.saturating_sub(now.saturating_duration_since(at) / 2);
        }
        self.drained_at = Some(now);
        let paused = self.paused_until.is_some_and(|until| now < until);
        if paused || self.debt >= BURST {
            self.held_back = self.held_back.saturating_add(1);
            return false;
        }
        true
    }

    /// After an admitted key: the keys held back since the last line, when a line is due.
    pub(crate) fn resumed(&mut self, now: Instant) -> Option<u32> {
        let after_pause = self.paused_until.take().is_some();
        if self.held_back == 0 {
            return None;
        }
        if !after_pause && self.line_at.is_some_and(|at| now.saturating_duration_since(at) < LINE_GAP) {
            return None;
        }
        self.line_at = Some(now);
        Some(std::mem::take(&mut self.held_back))
    }

    /// Charges one reply; a late one starts a pause and returns its length.
    pub(crate) fn charge(&mut self, now: Instant, took: Duration) -> Option<Duration> {
        self.debt = self.debt.saturating_add(took);
        if took < SLOW {
            self.next_pause = FIRST_PAUSE;
            return None;
        }
        let pause = self.next_pause;
        self.paused_until = Some(now + pause);
        self.next_pause = (pause * 2).min(LAST_PAUSE);
        Some(pause)
    }
}

thread_local! {
    static BOOK: Cell<Book> = Cell::new(Book::default());
    static DEPTH: Cell<u32> = const { Cell::new(0) };
    static BUDGET: Cell<Budget> = Cell::new(Budget::default());
}

#[cfg(test)]
thread_local! {
    static CLOCK: Cell<Option<Instant>> = const { Cell::new(None) };
}

fn now() -> Instant {
    #[cfg(test)]
    if let Some(at) = CLOCK.with(Cell::get) {
        return at;
    }
    Instant::now()
}

fn with_budget<T: Default>(f: impl FnOnce(&mut Budget) -> T) -> T {
    BUDGET
        .try_with(|cell| {
            let mut budget = cell.take();
            let out = f(&mut budget);
            cell.set(budget);
            out
        })
        .unwrap_or_default()
}

fn admit() -> bool {
    let at = now();
    let (admitted, resumed) = with_budget(|budget| {
        let admitted = budget.admit(at);
        (admitted, if admitted { budget.resumed(at) } else { None })
    });
    if let Some(held_back) = resumed {
        emit(&resumed_line(held_back));
    }
    admitted
}

/// GTK's own add and remove, captured once.
static TOOLKIT: OnceLock<(AddFn, RemoveFn)> = OnceLock::new();

fn with_book<T: Default>(f: impl FnOnce(&mut Book) -> T) -> T {
    BOOK.try_with(|cell| {
        let mut book = cell.take();
        let out = f(&mut book);
        cell.set(book);
        out
    })
    .unwrap_or_default()
}

fn depth() -> u32 {
    DEPTH.try_with(Cell::get).unwrap_or(0)
}

fn set_depth(depth: u32) {
    let _ = DEPTH.try_with(|d| d.set(depth));
}

fn schedule() {
    unsafe { gtk::glib::ffi::g_idle_add_full(G_PRIORITY_HIGH, Some(sweep), std::ptr::null_mut(), None) };
}

unsafe extern "C" fn trampoline(event: *mut AtkKeyEventStruct, data: gpointer) -> c_int {
    let forward = data as *const Forward;
    if forward.is_null() || (*forward).removed.get() {
        return 0;
    }
    let Some(func) = (*forward).func else { return 0 };
    if !(*forward).offer(event.as_ref()) {
        return 0;
    }
    let data = (*forward).data;
    set_depth(depth() + 1);
    let start = now();
    let answer = func(event, data);
    let end = now();
    let took = end.saturating_duration_since(start);
    if let Some(pause) = with_budget(|budget| budget.charge(end, took)) {
        emit(&paused_line(took, pause));
    }
    let left = depth().saturating_sub(1);
    set_depth(left);
    if with_book(|book| book.returned(left)) {
        schedule();
    }
    answer
}

unsafe extern "C" fn add(func: AtkKeySnoopFunc, data: gpointer) -> c_uint {
    if let Some(key) = with_book(|book| book.revive(func, data)) {
        return key;
    }
    let Some(&(toolkit_add, _)) = TOOLKIT.get() else { return 0 };
    let forward = Forward::new(func, data);
    let key = toolkit_add(Some(trampoline), &*forward as *const Forward as gpointer);
    with_book(|book| book.record(key, forward));
    key
}

unsafe extern "C" fn remove(key: c_uint) {
    let at = depth();
    if with_book(|book| book.retire(key, at)) {
        schedule();
    }
}

unsafe extern "C" fn sweep(_: gpointer) -> gboolean {
    let at = depth();
    let Some(swept) = with_book(|book| book.sweep(at)) else { return G_SOURCE_REMOVE };
    if let Some(&(_, toolkit_remove)) = TOOLKIT.get() {
        for key in &swept.keys {
            toolkit_remove(*key);
        }
    }
    drop(swept.forwards);
    if swept.held > 0 {
        emit(&held_line(swept.held));
    }
    G_SOURCE_REMOVE
}

pub(crate) fn held_line(held: u32) -> String {
    format!("{{\"service\":\"shell\",\"event\":\"atk_key_listener\",\"held\":{held}}}")
}

pub(crate) fn paused_line(took: Duration, pause: Duration) -> String {
    let (ms, pause_ms) = (took.as_millis(), pause.as_millis());
    format!("{{\"service\":\"shell\",\"event\":\"atk_key_paused\",\"ms\":{ms},\"pause_ms\":{pause_ms}}}")
}

pub(crate) fn resumed_line(held_back: u32) -> String {
    format!("{{\"service\":\"shell\",\"event\":\"atk_key_resumed\",\"held_back\":{held_back}}}")
}

pub(crate) const UNARMED_LINE: &str =
    "{\"service\":\"shell\",\"event\":\"atk_key_guard\",\"armed\":false,\"reason\":\"no_toolkit\"}";

fn emit(line: &str) {
    #[cfg(feature = "local-engine")]
    crate::engine::log_json_line(line);
    #[cfg(not(feature = "local-engine"))]
    {
        use std::io::Write;
        let _ = std::io::stderr().write_all(format!("{line}\n").as_bytes());
    }
}

/// Wrap ATK's key-listener hooks, once, on the main thread after `gtk::init` and before any main
/// loop runs. Without GTK's accessibility (no hooks to wrap) GTK is left as it is.
pub fn guard() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe { install() });
}

unsafe fn install() {
    use gtk::glib::gobject_ffi::g_type_class_ref;
    // The reference is kept: the class must outlive every listener.
    let class = g_type_class_ref(gtk::atk::ffi::atk_util_get_type()) as *mut AtkUtilClass;
    let hooks = class.as_ref().map(|c| (c.add_key_event_listener, c.remove_key_event_listener));
    let Some((Some(toolkit_add), Some(toolkit_remove))) = hooks else {
        emit(UNARMED_LINE);
        return;
    };
    if TOOLKIT.set((toolkit_add, toolkit_remove)).is_err() {
        return;
    }
    (*class).add_key_event_listener = Some(add);
    (*class).remove_key_event_listener = Some(remove);
}

#[cfg(test)]
#[path = "atk_key_listeners_tests.rs"]
mod tests;
