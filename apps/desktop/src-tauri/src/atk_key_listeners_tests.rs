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
    assert_eq!(
        paused_line(ms(450), Duration::from_secs(2)),
        r#"{"service":"shell","event":"atk_key_paused","ms":450,"pause_ms":2000}"#
    );
    assert_eq!(resumed_line(7), r#"{"service":"shell","event":"atk_key_resumed","held_back":7}"#);
}

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

fn reset_budget() {
    BUDGET.with(|b| b.set(Budget::default()));
    CLOCK.with(|c| c.set(None));
}

#[test]
fn a_listener_answering_in_milliseconds_is_offered_every_key() {
    let mut budget = Budget::default();
    let start = Instant::now();
    for i in 0..300u64 {
        let at = start + ms(i * 1000 / 30);
        assert!(budget.admit(at), "key {i}");
        assert_eq!(budget.charge(at + ms(5), ms(5)), None);
    }
    assert_eq!(budget.resumed(start + ms(10_000)), None);
}

#[test]
fn pauses_double_to_thirty_seconds_and_one_reply_in_time_resets_them() {
    let mut budget = Budget::default();
    let mut at = Instant::now();
    let mut pauses = Vec::new();
    for _ in 0..6 {
        while !budget.admit(at) {
            at += ms(100);
        }
        at += ms(450);
        pauses.push(budget.charge(at, ms(450)).unwrap().as_secs());
    }
    assert_eq!(pauses, [2, 4, 8, 16, 30, 30]);
    assert!(!budget.admit(at + ms(29_000)));
    assert!(budget.admit(at + ms(30_000)));
    assert_eq!(budget.charge(at + ms(30_005), ms(5)), None);
    assert_eq!(budget.charge(at + ms(30_500), ms(450)), Some(Duration::from_secs(2)));
}

#[test]
fn back_to_back_slowish_replies_hold_the_thread_at_most_half_the_time_after_a_burst() {
    let mut budget = Budget::default();
    let start = Instant::now();
    let (mut at, mut charged) = (start, Duration::ZERO);
    while at < start + Duration::from_secs(10) {
        if budget.admit(at) {
            at += ms(90);
            assert_eq!(budget.charge(at, ms(90)), None);
            charged += ms(90);
        } else {
            at += ms(1);
        }
    }
    assert!(charged <= ms(5_500 + 90), "{charged:?}");
    assert!(charged >= ms(5_000), "{charged:?}");
}

#[test]
fn the_held_back_count_comes_right_after_a_pause_and_otherwise_once_a_minute() {
    let mut budget = Budget::default();
    let at = Instant::now();
    assert!(budget.admit(at));
    assert_eq!(budget.charge(at + ms(450), ms(450)), Some(Duration::from_secs(2)));
    assert!(!budget.admit(at + ms(1_000)));
    assert!(!budget.admit(at + ms(2_000)));
    assert!(budget.admit(at + ms(2_500)));
    assert_eq!(budget.resumed(at + ms(2_500)), Some(2));
    // Held back by the debt alone, within the minute: counted, not yet said.
    for step in [3_000, 3_300, 3_600] {
        assert!(budget.admit(at + ms(step)));
        assert_eq!(budget.resumed(at + ms(step)), None);
        budget.charge(at + ms(step), ms(300));
    }
    assert!(!budget.admit(at + ms(3_700)));
    assert!(budget.admit(at + ms(4_000)));
    assert_eq!(budget.resumed(at + ms(4_000)), None);
    assert!(budget.admit(at + ms(62_500)));
    assert_eq!(budget.resumed(at + ms(62_500)), Some(1));
    assert_eq!(budget.resumed(at + ms(62_600)), None);
}

thread_local! {
    static KEYS: RefCell<Vec<(c_int, u16)>> = const { RefCell::new(Vec::new()) };
}

unsafe extern "C" fn keys(event: *mut AtkKeyEventStruct, _: gpointer) -> c_int {
    KEYS.with(|k| k.borrow_mut().push(((*event).type_, (*event).keycode)));
    0
}

#[test]
fn a_release_is_offered_exactly_when_its_press_was() {
    reset_budget();
    let at = Instant::now();
    CLOCK.with(|c| c.set(Some(at)));
    let forward = Forward::new(Some(keys), data(31));
    let to = &*forward as *const Forward as gpointer;
    let press_release = |type_: c_int, code: u16| {
        let mut event = key(type_, code);
        assert_eq!(unsafe { trampoline(&mut event, to) }, 0);
    };
    press_release(0, 50);
    assert_eq!(with_budget(|b| b.charge(at, SLOW)), Some(FIRST_PAUSE));
    press_release(0, 51);
    press_release(1, 51);
    press_release(1, 50);
    press_release(1, 50);
    CLOCK.with(|c| c.set(Some(at + Duration::from_secs(3))));
    press_release(0, 52);
    press_release(0, 52);
    press_release(1, 52);
    press_release(1, 52);
    assert_eq!(KEYS.with(|k| k.take()), vec![(0, 50), (1, 50), (0, 52), (0, 52), (1, 52)]);
    reset_budget();
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

/// GTK's hooks are process-wide: stub them, then wrap them, once for every hook-level test.
fn install_stub_toolkit() {
    static STUBBED: Once = Once::new();
    STUBBED.call_once(|| unsafe {
        let class = gtk::glib::gobject_ffi::g_type_class_ref(gtk::atk::ffi::atk_util_get_type()) as *mut AtkUtilClass;
        (*class).add_key_event_listener = Some(toolkit_add);
        (*class).remove_key_event_listener = Some(toolkit_remove);
    });
    guard();
}

fn key(type_: c_int, keycode: u16) -> AtkKeyEventStruct {
    let mut event: AtkKeyEventStruct = unsafe { std::mem::zeroed() };
    event.type_ = type_;
    event.keycode = keycode;
    event
}

fn count(name: &str) -> usize {
    calls().iter().filter(|(n, _, _)| *n == name).count()
}

unsafe extern "C" fn late_once(event: *mut AtkKeyEventStruct, data: gpointer) -> c_int {
    call("late_once", event, data);
    if count_late() == 1 {
        std::thread::sleep(Duration::from_millis(450));
    }
    0
}

fn count_late() -> usize {
    CALLS.with(|c| c.borrow().iter().filter(|(n, _, _)| *n == "late_once").count())
}

#[test]
fn a_reply_that_comes_too_late_gets_its_release_and_not_the_next_key() {
    install_stub_toolkit();
    reset_budget();
    unsafe { atk_add_key_event_listener(Some(late_once), data(21)) };
    for (type_, keycode) in [(0, 38), (1, 38), (0, 39), (1, 39)] {
        let mut event = key(type_, keycode);
        assert_eq!(deliver(&mut event), 0);
    }
    assert_eq!(count("late_once"), 2);
}

#[test]
fn a_listener_that_leaves_during_its_delivery_is_removed_after_gtks_loop_has_moved_on() {
    install_stub_toolkit();
    reset_budget();
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
