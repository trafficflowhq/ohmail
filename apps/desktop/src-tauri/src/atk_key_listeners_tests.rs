//! A listener removed during GTK's key delivery reaches GTK only once the delivery has returned,
//! and every key still reaches every live listener exactly once.

use super::*;
use std::cell::RefCell;
use std::sync::atomic::{AtomicU32, Ordering};

use gtk::atk::ffi::{atk_add_key_event_listener, atk_remove_key_event_listener};
use gtk::glib::{self, ControlFlow, MainContext, MainLoop, Priority};

unsafe extern "C" fn listener_a(_: *mut AtkKeyEventStruct, _: gpointer) -> c_int {
    0
}

unsafe extern "C" fn listener_b(_: *mut AtkKeyEventStruct, _: gpointer) -> c_int {
    0
}

fn data(n: usize) -> gpointer {
    n as gpointer
}

/// The book with a delivery stack, the sweeps it schedules and the keys it hands to GTK.
#[derive(Default)]
struct Sim {
    book: Book,
    depth: u32,
    scheduled: u32,
    removed: Vec<c_uint>,
    held: u32,
}

impl Sim {
    fn add(&mut self, key: c_uint, func: AtkKeySnoopFunc, data: gpointer) {
        self.book.record(key, Forward::new(func, data));
    }
    fn remove(&mut self, key: c_uint) {
        self.scheduled += self.book.retire(key, self.depth) as u32;
    }
    fn enter(&mut self) {
        self.depth += 1;
    }
    fn leave(&mut self) {
        self.depth -= 1;
        self.scheduled += self.book.returned(self.depth) as u32;
    }
    /// Runs every scheduled sweep at the current depth.
    fn idle(&mut self) {
        while self.scheduled > 0 {
            self.scheduled -= 1;
            if let Some(swept) = self.book.sweep(self.depth) {
                self.removed.extend(swept.keys);
                self.held += swept.held;
            }
        }
    }
}

#[test]
fn a_removal_during_a_delivery_reaches_gtk_once_after_it_returns() {
    let mut sim = Sim::default();
    sim.add(1, Some(listener_a), data(1));
    sim.enter();
    sim.remove(1);
    sim.idle();
    assert!(sim.removed.is_empty());
    sim.leave();
    sim.idle();
    assert_eq!(sim.removed, vec![1]);
    assert_eq!(sim.held, 1);
    sim.idle();
    assert_eq!(sim.removed, vec![1]);
}

#[test]
fn nested_deliveries_wait_for_the_outermost_to_return() {
    let mut sim = Sim::default();
    sim.add(1, Some(listener_a), data(1));
    sim.enter();
    sim.enter();
    sim.remove(1);
    sim.leave();
    sim.idle();
    assert!(sim.removed.is_empty());
    sim.leave();
    sim.idle();
    assert_eq!(sim.removed, vec![1]);
}

#[test]
fn a_sweep_that_fires_mid_delivery_hands_nothing_over_and_is_scheduled_again() {
    let mut sim = Sim::default();
    sim.add(1, Some(listener_a), data(1));
    sim.remove(1);
    assert_eq!(sim.scheduled, 1);
    sim.enter();
    sim.idle();
    assert!(sim.removed.is_empty());
    sim.leave();
    assert_eq!(sim.scheduled, 1);
    sim.idle();
    assert_eq!(sim.removed, vec![1]);
    assert_eq!(sim.held, 0);
}

#[test]
fn re_adding_the_pair_whose_removal_is_pending_keeps_its_key_and_removes_nothing() {
    let mut sim = Sim::default();
    sim.add(1, Some(listener_a), data(1));
    sim.enter();
    sim.remove(1);
    assert_eq!(sim.book.revive(Some(listener_a), data(1)), Some(1));
    assert_eq!(sim.book.revive(Some(listener_a), data(1)), None);
    sim.leave();
    sim.idle();
    assert!(sim.removed.is_empty());
}

#[test]
fn a_different_pair_is_not_revived() {
    let mut sim = Sim::default();
    sim.add(1, Some(listener_a), data(1));
    sim.remove(1);
    assert_eq!(sim.book.revive(Some(listener_b), data(1)), None);
    assert_eq!(sim.book.revive(Some(listener_a), data(2)), None);
    sim.idle();
    assert_eq!(sim.removed, vec![1]);
}

#[test]
fn unknown_keys_still_reach_gtk_repeats_once_and_key_zero_never() {
    let mut sim = Sim::default();
    sim.add(1, Some(listener_a), data(1));
    sim.remove(7);
    sim.remove(1);
    sim.remove(1);
    sim.remove(0);
    sim.idle();
    assert_eq!(sim.removed, vec![7, 1]);
}

thread_local! {
    static SEEN: RefCell<Vec<(*mut AtkKeyEventStruct, gpointer)>> = const { RefCell::new(Vec::new()) };
}

unsafe extern "C" fn seen(event: *mut AtkKeyEventStruct, data: gpointer) -> c_int {
    SEEN.with(|s| s.borrow_mut().push((event, data)));
    1
}

#[test]
fn a_removed_listener_is_not_called_before_the_sweep_and_a_live_one_gets_gtks_event() {
    let mut event: AtkKeyEventStruct = unsafe { std::mem::zeroed() };
    let forward = Forward::new(Some(seen), data(5));
    let at = &*forward as *const Forward as gpointer;
    assert_eq!(unsafe { trampoline(&mut event, at) }, 1);
    forward.removed.set(true);
    assert_eq!(unsafe { trampoline(&mut event, at) }, 0);
    assert_eq!(SEEN.with(|s| s.borrow().clone()), vec![(&mut event as *mut _, data(5))]);
}

#[test]
fn the_lines_carry_only_fixed_words_and_counts() {
    assert_eq!(held_line(2), r#"{"service":"shell","event":"atk_key_listener","held":2}"#);
    assert_eq!(UNARMED_LINE, r#"{"service":"shell","event":"atk_key_guard","armed":false,"reason":"no_toolkit"}"#);
}

// GTK 3's listener list, faithfully: append on add; remove unlinks and frees, here marks dead; the
// delivery loop reads `next` after each call.
struct Link {
    key: c_uint,
    func: AtkKeySnoopFunc,
    data: gpointer,
    next: *mut Link,
    dead: bool,
}

thread_local! {
    static HEAD: Cell<*mut Link> = const { Cell::new(std::ptr::null_mut()) };
    static LAST_KEY: Cell<c_uint> = const { Cell::new(0) };
    static REMOVED: RefCell<Vec<c_uint>> = const { RefCell::new(Vec::new()) };
    static CALLS: RefCell<Vec<(&'static str, *mut AtkKeyEventStruct, gpointer)>> = const { RefCell::new(Vec::new()) };
}

unsafe extern "C" fn toolkit_add(func: AtkKeySnoopFunc, data: gpointer) -> c_uint {
    let key = LAST_KEY.get() + 1;
    LAST_KEY.set(key);
    let link = Box::into_raw(Box::new(Link { key, func, data, next: std::ptr::null_mut(), dead: false }));
    let mut at = HEAD.get();
    if at.is_null() {
        HEAD.set(link);
    } else {
        while !(*at).next.is_null() {
            at = (*at).next;
        }
        (*at).next = link;
    }
    key
}

unsafe extern "C" fn toolkit_remove(key: c_uint) {
    let mut prev: *mut Link = std::ptr::null_mut();
    let mut at = HEAD.get();
    while !at.is_null() {
        if (*at).key == key {
            if prev.is_null() { HEAD.set((*at).next) } else { (*prev).next = (*at).next }
            (*at).dead = true;
            REMOVED.with(|r| r.borrow_mut().push(key));
            return;
        }
        prev = at;
        at = (*at).next;
    }
}

fn deliver(event: *mut AtkKeyEventStruct) -> c_int {
    let mut answer = 0;
    let mut at = HEAD.get();
    while !at.is_null() {
        unsafe {
            answer |= (*at).func.unwrap()(event, (*at).data);
            assert!(!(*at).dead, "the delivery stepped onto a removed link");
            at = (*at).next;
        }
    }
    answer
}

fn links() -> Vec<c_uint> {
    let mut keys = Vec::new();
    let mut at = HEAD.get();
    while !at.is_null() {
        unsafe {
            keys.push((*at).key);
            at = (*at).next;
        }
    }
    keys
}

fn removed() -> Vec<c_uint> {
    REMOVED.with(|r| r.borrow().clone())
}

fn calls() -> Vec<(&'static str, *mut AtkKeyEventStruct, gpointer)> {
    CALLS.with(|c| std::mem::take(&mut *c.borrow_mut()))
}

fn call(name: &'static str, event: *mut AtkKeyEventStruct, data: gpointer) {
    CALLS.with(|c| c.borrow_mut().push((name, event, data)));
}

static LEAVING: AtomicU32 = AtomicU32::new(0);
static REJOINED: AtomicU32 = AtomicU32::new(0);
static REJOINS: AtomicU32 = AtomicU32::new(0);

/// The bridge's shape: wait for the clients on a private loop, and hear there that the last left.
fn wait_privately(step: impl FnMut() -> ControlFlow + Send + 'static) {
    let context = MainContext::new();
    let main_loop = MainLoop::new(Some(&context), false);
    let quit = main_loop.clone();
    let mut step = step;
    glib::idle_source_new(None, Priority::DEFAULT, move || {
        let flow = step();
        quit.quit();
        flow
    })
    .attach(Some(&context));
    context.with_thread_default(|| main_loop.run()).unwrap();
}

unsafe extern "C" fn kept(event: *mut AtkKeyEventStruct, data: gpointer) -> c_int {
    call("kept", event, data);
    1
}

unsafe extern "C" fn leaving(event: *mut AtkKeyEventStruct, data: gpointer) -> c_int {
    call("leaving", event, data);
    wait_privately(|| {
        unsafe { atk_remove_key_event_listener(LEAVING.load(Ordering::SeqCst)) };
        ControlFlow::Break
    });
    0
}

unsafe extern "C" fn rejoining(event: *mut AtkKeyEventStruct, data: gpointer) -> c_int {
    call("rejoining", event, data);
    if REJOINS.fetch_add(1, Ordering::SeqCst) > 0 {
        return 0;
    }
    let at = data as usize;
    wait_privately(move || {
        unsafe {
            atk_remove_key_event_listener(REJOINED.load(Ordering::SeqCst));
            REJOINED.store(atk_add_key_event_listener(Some(rejoining), at as gpointer), Ordering::SeqCst);
        }
        ControlFlow::Break
    });
    0
}

unsafe extern "C" fn counted(event: *mut AtkKeyEventStruct, data: gpointer) -> c_int {
    call("counted", event, data);
    0
}

unsafe extern "C" fn modal(event: *mut AtkKeyEventStruct, data: gpointer) -> c_int {
    call("modal", event, data);
    let before = removed().len();
    for _ in 0..4 {
        MainContext::default().iteration(false);
    }
    if removed().len() != before {
        call("modal-loop-removed", event, data);
    }
    0
}

#[test]
fn a_listener_that_leaves_during_its_delivery_is_removed_after_gtks_loop_has_moved_on() {
    unsafe {
        let class = gtk::glib::gobject_ffi::g_type_class_ref(gtk::atk::ffi::atk_util_get_type()) as *mut AtkUtilClass;
        (*class).add_key_event_listener = Some(toolkit_add);
        (*class).remove_key_event_listener = Some(toolkit_remove);
    }
    guard();
    let mut event: AtkKeyEventStruct = unsafe { std::mem::zeroed() };
    let ev = &mut event as *mut AtkKeyEventStruct;
    let idle = || MainContext::default().iteration(false);

    // The last client leaves while its listener waits.
    let leaving_key = unsafe { atk_add_key_event_listener(Some(leaving), data(11)) };
    LEAVING.store(leaving_key, Ordering::SeqCst);
    let kept_key = unsafe { atk_add_key_event_listener(Some(kept), data(12)) };
    assert_eq!(deliver(ev), 1);
    assert_eq!(calls(), vec![("leaving", ev, data(11)), ("kept", ev, data(12))]);
    assert_eq!(links().len(), 2);
    assert!(removed().is_empty());
    idle();
    assert_eq!(links().len(), 1);
    assert_eq!(removed().len(), 1);
    assert_eq!(deliver(ev), 1);
    assert_eq!(calls(), vec![("kept", ev, data(12))]);

    // A client leaves and another arrives in the same wait: the listener is delivered once.
    let first = unsafe { atk_add_key_event_listener(Some(rejoining), data(13)) };
    REJOINED.store(first, Ordering::SeqCst);
    assert_eq!(deliver(ev), 1);
    assert_eq!(calls(), vec![("kept", ev, data(12)), ("rejoining", ev, data(13))]);
    assert_eq!(REJOINED.load(Ordering::SeqCst), first);
    idle();
    assert_eq!(removed().len(), 1);
    assert_eq!(deliver(ev), 1);
    assert_eq!(calls(), vec![("kept", ev, data(12)), ("rejoining", ev, data(13))]);

    // A modal loop inside a delivery runs a sweep already scheduled: it removes nothing.
    let counted_key = unsafe { atk_add_key_event_listener(Some(counted), data(14)) };
    unsafe { atk_add_key_event_listener(Some(modal), data(15)) };
    unsafe { atk_remove_key_event_listener(REJOINED.load(Ordering::SeqCst)) };
    unsafe { atk_remove_key_event_listener(counted_key) };
    assert_eq!(deliver(ev), 1);
    assert_eq!(calls(), vec![("kept", ev, data(12)), ("modal", ev, data(15))]);
    idle();
    assert_eq!(removed().len(), 3);
    assert_eq!(links().len(), 2);
    assert!(links().contains(&kept_key));
}
