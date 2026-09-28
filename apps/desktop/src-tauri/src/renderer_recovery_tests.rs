//! The answer to each death, the address the reload loads, and the line it leaves.

use super::*;

#[test]
fn the_first_death_reloads() {
    let mut d = Deaths::default();
    assert_eq!(d.on_death(Instant::now()), Action::Reload);
}

#[test]
fn a_second_death_inside_the_window_offers_a_relaunch_and_never_reloads_again() {
    let mut d = Deaths::default();
    let t0 = Instant::now();
    assert_eq!(d.on_death(t0), Action::Reload);
    assert_eq!(d.on_death(t0 + Duration::from_secs(3)), Action::OfferRelaunch);
    // The page is not reloaded under the question, so a third death has nothing to reload.
    assert_eq!(d.on_death(t0 + Duration::from_secs(4)), Action::AlreadyOffered);
}

#[test]
fn a_second_death_after_the_window_is_a_first_death_again() {
    let mut d = Deaths::default();
    let t0 = Instant::now();
    assert_eq!(d.on_death(t0), Action::Reload);
    assert_eq!(d.on_death(t0 + WINDOW + Duration::from_secs(1)), Action::Reload);
    // …and the one after that, soon, is the pattern again.
    assert_eq!(d.on_death(t0 + WINDOW + Duration::from_secs(2)), Action::OfferRelaunch);
}

#[test]
fn the_window_is_short_enough_to_catch_a_page_that_dies_on_load() {
    assert!(WINDOW >= Duration::from_secs(60) && WINDOW <= Duration::from_secs(600));
}

#[test]
fn the_reload_keeps_the_view_and_carries_the_mark() {
    assert_eq!(reload_uri("tauri://localhost/"), "tauri://localhost/?renderer=reloaded");
    assert_eq!(
        reload_uri("tauri://localhost/#history"),
        "tauri://localhost/?renderer=reloaded#history"
    );
    // A mark already there, or any other query, is not carried twice.
    assert_eq!(
        reload_uri("tauri://localhost/?renderer=reloaded#ohbox"),
        "tauri://localhost/?renderer=reloaded#ohbox"
    );
    assert_eq!(reload_uri("http://tauri.localhost/index.html?x=1"), "http://tauri.localhost/index.html?renderer=reloaded");
}

#[test]
fn the_line_names_the_reason_and_the_answer_and_nothing_else() {
    let l = line("crashed", Action::Reload);
    assert_eq!(
        l,
        r#"{"service":"shell","event":"renderer_gone","reason":"crashed","action":"reloaded"}"#
    );
    let v: serde_json::Value = serde_json::from_str(&line("memory_limit", Action::OfferRelaunch)).unwrap();
    assert_eq!(v["action"], "relaunch_offered");
    assert_eq!(v.as_object().unwrap().len(), 4);
}

#[test]
fn the_relaunch_sentence_says_what_happened_and_what_the_button_does() {
    assert!(RELAUNCH_MESSAGE.contains("stopped again"));
    assert!(RELAUNCH_MESSAGE.contains(RELAUNCH_BUTTON));
}

#[test]
fn a_webview2_renderer_that_exits_or_hangs_is_the_page_and_nothing_else_is() {
    // COREWEBVIEW2_PROCESS_FAILED_KIND: 1 render exited, 2 unresponsive, 0 the browser process.
    assert_eq!(windows_failure(1), Failure::Renderer("render_exited"));
    assert_eq!(windows_failure(2), Failure::Renderer("render_unresponsive"));
    assert_eq!(windows_failure(0), Failure::Browser);
    // GPU (6), utility (4), a message frame's renderer (3): the page lives on, nothing is reloaded.
    for kind in [3, 4, 5, 6, 7, 8, 9] {
        assert_eq!(windows_failure(kind), Failure::Ignored, "kind {kind}");
    }
}

#[test]
fn a_browser_process_exit_offers_the_relaunch_once() {
    let mut d = Deaths::default();
    let t0 = Instant::now();
    assert_eq!(d.on_fatal(t0), Action::OfferRelaunch);
    assert_eq!(d.on_fatal(t0 + Duration::from_secs(1)), Action::AlreadyOffered);
    // …and a renderer death after it does not reload under the question.
    assert_eq!(d.on_death(t0 + Duration::from_secs(2)), Action::AlreadyOffered);
}
