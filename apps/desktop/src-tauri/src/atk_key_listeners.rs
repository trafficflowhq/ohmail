//! Key listeners an accessibility client leaves while GTK is delivering a key to them.
//!
//! GTK 3 hands every key press to ATK's key listeners in a loop that reads the next list link
//! after each call. The AT-SPI bridge's listener waits for its clients inside that call, and when
//! the last client goes away during the wait it removes the listener there: GTK frees the link the
//! loop stands on and the whole app dies on SIGSEGV. A screen reader that quits or restarts while
//! you type is enough. This wraps ATK's add and remove hooks so that a removal reaches GTK only
//! once no delivery is on the stack. Every key still reaches every live listener exactly once,
//! with GTK's own event; the wrapper never reads a key.

use std::cell::Cell;
use std::os::raw::{c_int, c_uint};
use std::sync::{Once, OnceLock};

use gtk::atk::ffi::{AtkKeyEventStruct, AtkKeySnoopFunc, AtkUtilClass};
use gtk::glib::ffi::{gboolean, gpointer, G_PRIORITY_HIGH, G_SOURCE_REMOVE};

type AddFn = unsafe extern "C" fn(AtkKeySnoopFunc, gpointer) -> c_uint;
type RemoveFn = unsafe extern "C" fn(c_uint);

/// One listener as the client added it. GTK holds its address as the data of `trampoline`.
pub(crate) struct Forward {
    func: AtkKeySnoopFunc,
    data: gpointer,
    removed: Cell<bool>,
}

impl Forward {
    pub(crate) fn new(func: AtkKeySnoopFunc, data: gpointer) -> Box<Forward> {
        Box::new(Forward { func, data, removed: Cell::new(false) })
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

thread_local! {
    static BOOK: Cell<Book> = Cell::new(Book::default());
    static DEPTH: Cell<u32> = const { Cell::new(0) };
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
    let data = (*forward).data;
    set_depth(depth() + 1);
    let answer = func(event, data);
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
