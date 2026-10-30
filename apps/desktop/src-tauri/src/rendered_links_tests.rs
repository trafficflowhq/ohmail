//! The links on screen: what the new-window door admits, how a report is kept and bounded, and the
//! line a refusal writes. Each case names the mutation it was watched go red against.

use super::*;
use crate::engine::{popup_route, Activation, PopupRoute};

/// The address the row was read with on the Linux AppImage: no message drew it.
const PROBE: &str = "https://example.invalid/?data=walk-1";

fn reported(surface: &str, urls: &[&str]) -> Rendered {
    let mut set = Rendered::default();
    set.report(surface, &owned(urls)).expect("the report was refused");
    set
}

fn owned(urls: &[&str]) -> Vec<String> {
    urls.iter().map(|u| u.to_string()).collect()
}

/// THE ROW'S PROBE. Mutation: admit on shape alone (drop the membership check) → both refusal
/// asserts go red. The positive control is the same address once a renderer reported it, on the
/// person's click, and the opener is handed the caller's own bytes.
#[test]
fn an_address_no_renderer_drew_is_refused_at_the_door() {
    let empty = Rendered::default();
    let refused = admitted(PROBE, Some(&empty)).expect_err("an address nothing drew was admitted");
    assert_eq!(refused.why, Why::Unrendered);
    assert!(refused.sentence.starts_with("ohmail: this is not an address the app opens"), "{}", refused.sentence);
    for activation in [Activation::Person, Activation::Script] {
        assert_eq!(
            popup_route(PROBE, Some(&empty), activation),
            PopupRoute::Refused { url: PROBE.to_string(), why: Why::Unrendered }
        );
    }

    let set = reported("s1", &[PROBE]);
    let opened = admitted(PROBE, Some(&set)).expect("a reported link was refused");
    assert_eq!(opened.as_ptr(), PROBE.as_ptr(), "the opener must get the caller's own bytes");
    assert_eq!(opened.len(), PROBE.len());
    assert_eq!(popup_route(PROBE, Some(&set), Activation::Person), PopupRoute::Browser(PROBE.to_string()));
}

/// A SCRIPT OPENS NOTHING, reported or the shell's own: the refusal names the gesture, in its own
/// word. Mutation: open on the set alone → red; name the refusal `unrendered` → red.
#[test]
fn a_link_on_screen_asked_for_by_a_script_is_refused_for_its_gesture() {
    let set = reported("s1", &[PROBE]);
    for url in [PROBE, OWN_LINKS[0]] {
        assert_eq!(
            popup_route(url, Some(&set), Activation::Script),
            PopupRoute::Refused { url: url.to_string(), why: Why::Gesture }
        );
        assert_eq!(popup_route(url, Some(&set), Activation::Person), PopupRoute::Browser(url.to_string()));
    }
    assert_eq!(Why::Gesture.word(), "gesture");
    assert_eq!(
        refusal_line(Door::Popup, Why::Gesture, PROBE),
        r#"{"service":"shell","event":"open_refused","door":"popup","why":"gesture","hostClass":"public"}"#
    );
}

/// EXACT, AFTER ONE SERIALISATION. Mutation: compare the raw strings (no `key_of`) → the spelling
/// rows go red; compare by host or by prefix → the variant rows go red.
#[test]
fn the_comparison_is_exact_after_the_parsers_own_serialisation() {
    let set = reported("s1", &["https://evil.test/"]);
    for variant in ["https://evil.test/?d=1", "https://evil.test/#x", "https://evil.test/a", "http://evil.test/", "https://evil.test:8443/"] {
        assert!(admitted(variant, Some(&set)).is_err(), "{variant} rode on a reported https://evil.test/");
    }

    // The window reports `URL.href`; the new-window door sees the webview's URL re-serialised by the
    // `url` crate, and the app document's opener hands over `URL.href` again. One spelling each.
    for (reported_as, opened_as) in [
        ("https://example.test/", "HTTPS://EXAMPLE.TEST"),
        ("http://example.test/", "http://example.test:80/"),
        ("https://bücher.example/ü", "https://xn--bcher-kva.example/%C3%BC"),
        ("https://example.test/a?b=1&c=2#f", "https://example.test/a?b=1&c=2#f"),
        ("https://example.test/?ids=1|2", "https://example.test/?ids=1|2"),
        ("HTTP://EXAMPLE.TEST/Path", "http://example.test/Path"),
    ] {
        let set = reported("s1", &[reported_as]);
        assert_eq!(admitted(opened_as, Some(&set)).map(str::len), Ok(opened_as.len()), "{reported_as} → {opened_as}");
        assert_eq!(
            popup_route(opened_as, Some(&set), Activation::Person),
            PopupRoute::Browser(opened_as.to_string()),
            "{opened_as}"
        );
    }
}

/// A REPORT REPLACES, AN EMPTY ONE REMOVES, AND EVERY CAP HOLDS. Mutations: append instead of
/// replace → the replaced link stays admitted; drop the surface cap → the first surface survives;
/// drop the per-surface cap → the last entry is admitted; fail the whole report on one bad entry →
/// the siblings are refused.
#[test]
fn a_report_replaces_removes_and_is_bounded() {
    let mut set = reported("s1", &["https://a.test/"]);
    set.report("s1", &owned(&["https://b.test/"])).expect("replace");
    assert!(admitted("https://a.test/", Some(&set)).is_err(), "a replaced link is still admitted");
    assert!(admitted("https://b.test/", Some(&set)).is_ok());
    assert_eq!(set.report("s1", &[]), Ok(Trimmed::default()));
    assert!(admitted("https://b.test/", Some(&set)).is_err(), "an empty report did not remove the surface");
    assert!(set.surface_ids().is_empty());
    assert_eq!(set.bytes(), 0);

    // One surface too many: the oldest goes, and the report says so.
    let mut set = Rendered::default();
    for i in 0..SURFACES_MAX {
        set.report(&format!("s{i}"), &[format!("https://s{i}.test/")]).expect("report");
    }
    let trim = set.report("last", &owned(&["https://last.test/"])).expect("report");
    assert_eq!(trim, Trimmed { dropped: 0, evicted: 1 });
    assert!(admitted("https://s0.test/", Some(&set)).is_err(), "the oldest surface outlived the cap");
    assert!(admitted("https://s1.test/", Some(&set)).is_ok());
    assert!(admitted("https://last.test/", Some(&set)).is_ok());
    assert_eq!(set.surface_ids().len(), SURFACES_MAX);

    // One entry too many in one report: the first are kept.
    let many: Vec<String> = (0..=PER_SURFACE_MAX).map(|i| format!("https://example.test/{i}")).collect();
    let mut set = Rendered::default();
    assert_eq!(set.report("s1", &many).expect("report").dropped, 1);
    assert!(admitted(&many[PER_SURFACE_MAX - 1], Some(&set)).is_ok());
    assert!(admitted(&many[PER_SURFACE_MAX], Some(&set)).is_err(), "the entry past the cap was kept");

    // A bad entry is dropped alone, and a duplicate is not a drop.
    let mut set = Rendered::default();
    let trim = set
        .report("s1", &owned(&["https://example.test/x y", "https://ok.test/", "javascript:alert(1)", "https://ok.test/", "cid:p@x.test"]))
        .expect("one bad entry failed the whole report");
    assert_eq!(trim.dropped, 3);
    assert!(admitted("https://ok.test/", Some(&set)).is_ok());

    // The surface id: printable ASCII, at most SURFACE_ID_MAX.
    let mut set = Rendered::default();
    assert!(set.report(&"s".repeat(SURFACE_ID_MAX), &owned(&["https://ok.test/"])).is_ok());
    for bad in ["s".repeat(SURFACE_ID_MAX + 1), String::new(), "«r1»".to_string(), "a b".to_string()] {
        assert!(set.report(&bad, &owned(&["https://ok.test/"])).is_err(), "surface id {bad:?} was taken");
    }
}

/// THE BYTE BOUND: one report keeps at most BYTES_MAX, and a second big one evicts the first.
/// Mutation: drop the byte cap → nothing is dropped and the first surface survives.
#[test]
fn the_link_text_kept_is_bounded_in_bytes() {
    let big = |tag: &str| -> Vec<String> {
        (0..PER_SURFACE_MAX).map(|i| format!("https://{tag}.test/{i}/{}", "a".repeat(3000))).collect()
    };
    let mut set = Rendered::default();
    let first = set.report("s1", &big("one")).expect("report");
    assert!(first.dropped > 0, "a report past the byte bound kept everything");
    assert!(set.bytes() <= BYTES_MAX);
    let second = set.report("s2", &big("two")).expect("report");
    assert_eq!(second.evicted, 1, "the older surface was not evicted to make room");
    assert_eq!(set.surface_ids(), ["s2"]);
    assert!(set.bytes() <= BYTES_MAX);
}

/// THE SHELL'S OWN LINKS open with nothing on screen, and only themselves. Mutation: drop the
/// `OWN_LINKS` arm → every help link is refused; match them by host → the last row is admitted.
#[test]
fn the_shells_own_links_need_no_report() {
    let empty = Rendered::default();
    for own in OWN_LINKS {
        assert_eq!(external_url(own), Ok(own), "{own} fails the shape gate");
        assert_eq!(key_of(own).as_deref(), Some(own), "{own} is not in its own comparison form");
        assert_eq!(admitted(own, Some(&empty)), Ok(own));
    }
    for not_own in ["https://ohmail.app/", "https://myaccount.google.com/", "https://myaccount.google.com/apppasswords?x=1"] {
        assert!(admitted(not_own, Some(&empty)).is_err(), "{not_own} passed as one of the shell's own links");
    }
}

/// NO SET, NO OPEN — the injected default is the refusing branch. Mutation: answer `Ok` when the
/// state is missing → every row goes red.
#[test]
fn without_the_managed_set_nothing_opens() {
    assert_eq!(admitted(OWN_LINKS[0], None).map_err(|r| r.why), Err(Why::Unrendered));
    assert_eq!(admitted(PROBE, None).map_err(|r| r.why), Err(Why::Unrendered));
    assert_eq!(
        popup_route(PROBE, None, Activation::Person),
        PopupRoute::Refused { url: PROBE.to_string(), why: Why::Unrendered }
    );
    // The shape still answers first, with its own sentence.
    let shape = admitted("https://example.test/\"x", None).expect_err("a bad shape was admitted");
    assert_eq!(shape.why, Why::Shape);
    assert_eq!(shape.sentence, external_url("https://example.test/\"x").unwrap_err());
}

/// THE LINE CARRIES NO PART OF THE ADDRESS. Mutation: put the host (or the URL) in the line → red.
#[test]
fn a_refusal_line_names_no_part_of_the_address() {
    let url = "https://example.test/reset/TOKEN?d=secret#f";
    for why in [Why::Shape, Why::Unrendered, Why::Gesture, Why::Opener] {
        let line = refusal_line(Door::Popup, why, url);
        for part in ["TOKEN", "secret", "reset", "example.test", "#f"] {
            assert!(!line.contains(part), "{line} carries {part}");
        }
    }
    assert_eq!(
        refusal_line(Door::Popup, Why::Unrendered, url),
        r#"{"service":"shell","event":"open_refused","door":"popup","why":"unrendered","hostClass":"public"}"#
    );
    assert_eq!(
        refusal_line(Door::Popup, Why::Shape, "http://192.168.1.10/x"),
        r#"{"service":"shell","event":"open_refused","door":"popup","why":"shape","hostClass":"private"}"#
    );
    assert_eq!(
        refusal_line(Door::Popup, Why::Opener, "not a url"),
        r#"{"service":"shell","event":"open_refused","door":"popup","why":"opener","hostClass":"none"}"#
    );
    assert_eq!(
        trimmed_line(Trimmed { dropped: 3, evicted: 1 }),
        r#"{"service":"shell","event":"rendered_links_trimmed","dropped":3,"evicted":1}"#
    );
}

/// A BATCH IS ITS REPORTS, IN ORDER: a later report of the same surface wins, an empty one removes
/// it, and the caps hold exactly as one report at a time holds them. Mutations: apply the batch in
/// reverse → the replaced link stays and the removed surface survives; sum nothing → the trim reads
/// zero; skip `report` and insert directly → the per-surface cap no longer drops.
#[test]
fn a_batch_applies_its_reports_in_order_under_the_same_caps() {
    let mut set = reported("old", &["https://old.test/"]);
    let surfaces: Vec<String> = ["s1", "s2", "s1", "old"].iter().map(|s| s.to_string()).collect();
    let urls = vec![
        owned(&["https://a.test/"]),
        owned(&["https://b.test/", "javascript:alert(1)"]),
        owned(&["https://c.test/"]),
        Vec::new(),
    ];
    let trim = set.report_batch(&surfaces, &urls, &no_asks(surfaces.len())).expect("the batch was refused");
    assert_eq!(trim, Trimmed { dropped: 1, evicted: 0 });
    assert!(admitted("https://a.test/", Some(&set)).is_err(), "a surface's earlier report outlived its later one");
    assert!(admitted("https://b.test/", Some(&set)).is_ok());
    assert!(admitted("https://c.test/", Some(&set)).is_ok());
    assert!(admitted("https://old.test/", Some(&set)).is_err(), "the batch's empty report did not remove the surface");
    assert_eq!(set.surface_ids(), ["s2", "s1"]);

    let many: Vec<String> = (0..=PER_SURFACE_MAX).map(|i| format!("https://example.test/{i}")).collect();
    let mut set = Rendered::default();
    let trim = set.report_batch(&["s1".to_string()], &[many.clone()], &no_asks(1)).expect("report");
    assert_eq!(trim.dropped, 1, "the per-surface cap did not hold inside a batch");
    assert!(admitted(&many[PER_SURFACE_MAX], Some(&set)).is_err());
}

/// ONE BAD SURFACE REFUSES THE WHOLE BATCH, BEFORE ANYTHING IS APPLIED; so does a batch whose two
/// lists do not pair up. Mutations: check each id as it is applied → the first report lands before
/// the refusal; zip the lists without the length check → the unpaired batch is taken.
#[test]
fn a_batch_with_a_malformed_surface_changes_nothing() {
    let mut set = reported("kept", &["https://kept.test/"]);
    for bad in ["s".repeat(SURFACE_ID_MAX + 1), String::new(), "«r1»".to_string(), "a b".to_string()] {
        let surfaces = vec!["s1".to_string(), bad.clone()];
        let urls = vec![owned(&["https://first.test/"]), owned(&["https://second.test/"])];
        assert!(set.report_batch(&surfaces, &urls, &no_asks(2)).is_err(), "surface id {bad:?} was taken");
        assert!(admitted("https://first.test/", Some(&set)).is_err(), "a refused batch applied its first report");
        assert!(admitted("https://kept.test/", Some(&set)).is_ok(), "a refused batch touched what was kept");
    }
    let unpaired = set.report_batch(&["s1".to_string(), "s2".to_string()], &[owned(&["https://first.test/"])], &no_asks(2));
    assert!(unpaired.is_err(), "a batch with more surfaces than lists was taken");
    assert!(admitted("https://first.test/", Some(&set)).is_err());
    assert_eq!(set.surface_ids(), ["kept"]);
    assert_eq!(set.report_batch(&[], &[], &[]), Ok(Trimmed::default()));
}

/// A surface's marked links, none of them.
fn no_asks(surfaces: usize) -> Vec<Vec<String>> {
    vec![Vec::new(); surfaces]
}

/// THE MARKED LINKS (`asks`): every mark a report carries is kept for the session, compared in the
/// parser's own form, whether or not the report keeps its link and at no byte of the links' own;
/// a replaced or evicted surface's marks keep asking; a batch whose ask lists do not pair with its
/// surfaces changes nothing. Mutations: keep a mark only beside a kept link → the unkept row; count
/// a mark's bytes with the links' → the byte row; let marks go with their surface's next report →
/// the replaced row, or with its eviction → the evicted row; drop the ask lists' length check →
/// the unpaired row.
#[test]
fn every_reported_mark_asks_for_the_session() {
    let mut set = Rendered::default();
    let trim = set
        .report_asking(
            "s1",
            &owned(&["https://a.test/", "https://b.test/"]),
            &owned(&["HTTPS://A.TEST", "https://a.test/", "https://unkept.test/", "javascript:alert(1)"]),
        )
        .expect("the report was refused");
    assert_eq!(trim, Trimmed { dropped: 1, evicted: 0 });
    assert!(set.asks("https://a.test/"), "a marked link was not kept");
    assert!(asked("https://A.test", Some(&set)), "the mark is not compared in the parser's own form");
    assert!(!set.asks("https://b.test/") && !asked("https://b.test/", Some(&set)));
    assert!(set.asks("https://unkept.test/"), "a mark whose link the report did not keep was dropped");
    assert_eq!(set.bytes(), "https://a.test/".len() + "https://b.test/".len());

    set.report_asking("s1", &owned(&["https://a.test/"]), &[]).expect("replace");
    assert!(set.asks("https://a.test/"), "a replaced report's mark stopped asking");
    assert!(admitted("https://a.test/", Some(&set)).is_ok());

    let mut set = Rendered::default();
    set.report_asking("old", &owned(&["https://a.test/"]), &owned(&["https://a.test/"])).expect("report");
    for i in 0..SURFACES_MAX {
        set.report(&format!("s{i}"), &[format!("https://s{i}.test/")]).expect("report");
    }
    assert!(admitted("https://a.test/", Some(&set)).is_err(), "an evicted surface's link outlived it");
    assert!(set.asks("https://a.test/"), "an evicted surface's mark went with it");
    assert!(!asked("https://a.test/", None), "no set asked about a link");

    let mut set = reported("kept", &["https://kept.test/"]);
    let unpaired = set.report_batch(&["s1".to_string()], &[owned(&["https://first.test/"])], &[]);
    assert!(unpaired.is_err(), "a batch with no ask list for its surface was taken");
    assert!(admitted("https://first.test/", Some(&set)).is_err());
}

/// A link of exactly `len` bytes in its comparison form.
fn link_of_len(tag: usize, len: usize) -> String {
    let head = format!("https://e.ee/{tag}/");
    format!("{head}{}", "a".repeat(len - head.len()))
}

/// `first`, then links of their own that bring one report to exactly `total` bytes.
fn filled_to(total: usize, first: &[&str]) -> Vec<String> {
    let mut urls = owned(first);
    let mut left = total - first.iter().map(|u| u.len()).sum::<usize>();
    while left > 0 {
        let len = if left > 4096 { (left - 64).min(4000) } else { left };
        let head = format!("https://pad.ee/{}/", urls.len());
        urls.push(format!("{head}{}", "a".repeat(len - head.len())));
        left -= len;
    }
    urls
}

/// A MARK WHOSE LINK A BOUND DROPPED STILL ASKS: a letter's marked link past PER_SURFACE_MAX links,
/// or past BYTES_MAX, is not kept, and another surface holding the same address unmarked (the
/// Screener's unsubscribe page, a second letter, a plain-text one) does not open it on a press, in
/// separate reports or one batch. Marked first in a report that fills the byte bound, it asks too.
/// Mutation: keep a mark only beside a kept link → each press past a bound opens.
#[test]
fn a_mark_whose_link_a_bound_dropped_still_asks() {
    let marked = "https://evil.example/login";
    let route = |set: &Rendered| popup_route(marked, Some(set), Activation::Person);
    let mut past_the_count: Vec<String> = (0..PER_SURFACE_MAX).map(|i| format!("https://pad.example/{i}")).collect();
    past_the_count.push(marked.to_string());
    let mut past_the_bytes = filled_to(BYTES_MAX, &[]);
    past_the_bytes.push(marked.to_string());
    for urls in [past_the_count, past_the_bytes] {
        let mut set = Rendered::default();
        let trim = set.report_asking("letter", &urls, &owned(&[marked])).expect("report");
        assert!(admitted(marked, Some(&set)).is_err(), "the link past the bound was kept");
        set.report("screener", &owned(&[marked])).expect("report");
        assert_eq!(route(&set), PopupRoute::Ask(marked.to_string()), "a mark went with its dropped link");
        assert_eq!(trim.dropped, 1, "only the link past the bound is dropped");

        let mut set = Rendered::default();
        let surfaces = ["letter".to_string(), "screener".to_string()];
        set.report_batch(&surfaces, &[urls, owned(&[marked])], &[owned(&[marked]), Vec::new()]).expect("batch");
        assert_eq!(route(&set), PopupRoute::Ask(marked.to_string()), "inside one batch");
    }

    let mut set = Rendered::default();
    let trim = set.report_asking("s1", &filled_to(BYTES_MAX, &[marked]), &owned(&[marked])).expect("report");
    assert_eq!(trim, Trimmed::default());
    assert_eq!(set.bytes(), BYTES_MAX);
    assert_eq!(route(&set), PopupRoute::Ask(marked.to_string()));
}

/// AN EVICTED SURFACE MAY STILL BE ON SCREEN: its marked addresses keep asking, so a newer surface
/// that evicted it and holds the same address unmarked does not open it on a press. Mutation: let
/// the marks go with the surface → the press opens.
#[test]
fn an_evicted_surfaces_marked_links_keep_asking() {
    let marked = "https://evil.example/login";
    let mut set = Rendered::default();
    set.report_asking("old", &owned(&[marked]), &owned(&[marked])).expect("report");
    let trim = set.report("new", &filled_to(BYTES_MAX, &[marked])).expect("report");
    assert_eq!(trim, Trimmed { dropped: 0, evicted: 1 });
    assert_eq!(set.surface_ids(), ["new"]);
    assert_eq!(popup_route(marked, Some(&set), Activation::Person), PopupRoute::Ask(marked.to_string()));
}

/// AN EVICTED SURFACE'S MARKS ALL KEEP ASKING, 256 KiB of them and one more, and still ask once a
/// later surface reports the address again unmarked, in separate reports and in one batch.
/// Mutations: carry an eviction's marks under a 256 KiB bound of their own, the rest refused → the
/// first press is refused and the press after "later" opens.
#[test]
fn an_evicted_surfaces_marks_ask_when_the_address_is_reported_again() {
    let full: Vec<String> = (0..64).map(|i| link_of_len(i, 4096)).collect();
    assert_eq!(full.iter().map(String::len).sum::<usize>(), 256 * 1024);
    let marked = "https://evil.example/login";
    let route = |set: &Rendered, url: &str| popup_route(url, Some(set), Activation::Person);
    let ask = |url: &str| PopupRoute::Ask(url.to_string());
    let mut set = Rendered::default();
    set.report_asking("full", &full, &full).expect("report");
    set.report_asking("old", &owned(&[marked]), &owned(&[marked])).expect("report");
    let trim = set.report("new", &filled_to(BYTES_MAX, &[marked, &full[0]])).expect("report");
    assert_eq!(trim.evicted, 2);
    assert_eq!(route(&set, &full[0]), ask(&full[0]), "an evicted surface's mark was lost");
    assert_eq!(route(&set, marked), ask(marked), "an evicted surface's last mark did not ask");
    set.report("later", &owned(&[marked])).expect("report");
    assert_eq!(set.surface_ids(), ["later"]);
    assert_eq!(route(&set, marked), ask(marked), "a later report of the address let the press open");

    // "old" is the larger, so "new" evicts it and "later" still fits beside "new".
    let mut set = Rendered::default();
    set.report_asking("full", &full, &full).expect("report");
    set.report_asking("old", &owned(&[marked, link_of_len(99, 1000).as_str()]), &owned(&[marked])).expect("report");
    let surfaces: Vec<String> = ["new", "later"].iter().map(|s| s.to_string()).collect();
    let urls = [filled_to(BYTES_MAX - marked.len(), &[&full[0]]), owned(&[marked])];
    set.report_batch(&surfaces, &urls, &no_asks(2)).expect("batch");
    assert_eq!(set.surface_ids(), ["new", "later"]);
    assert_eq!(route(&set, marked), ask(marked));
}

/// 256 links of 4096 bytes: MARKS_BYTES_MAX of them, to mark.
fn a_mebibyte_of_marks() -> Vec<String> {
    (0..256).map(|i| link_of_len(i, 4096)).collect()
}

/// PAST THE MARKS' BOUND, EVERY PRESS ASKS while a surface whose mark found no room may be on
/// screen — evicted, and with the address reported again unmarked, too — and presses open as before
/// once that surface reports again; a mark that was kept still asks. Mutations: no fallback → the
/// presses after "old" open; let eviction end it → the press after "new" opens; keep it past the
/// surface's own next report → the press after it asks; let marks go with eviction → the kept
/// mark's press opens.
#[test]
fn past_the_marks_bound_every_press_asks_until_that_surface_reports_again() {
    let full = a_mebibyte_of_marks();
    assert_eq!(full.iter().map(String::len).sum::<usize>(), MARKS_BYTES_MAX);
    let (marked, honest) = ("https://evil.example/login", "https://shop.example/");
    let route = |set: &Rendered, url: &str| popup_route(url, Some(set), Activation::Person);
    let ask = |url: &str| PopupRoute::Ask(url.to_string());
    let mut set = Rendered::default();
    set.report_asking("full", &full, &full).expect("report");
    set.report("shop", &owned(&[honest])).expect("report");
    assert_eq!(route(&set, honest), PopupRoute::Browser(honest.to_string()));
    let trim = set.report_asking("old", &owned(&[marked]), &owned(&[marked])).expect("report");
    assert_eq!(route(&set, marked), ask(marked));
    assert_eq!(route(&set, honest), ask(honest), "a mark with no room let another press open");
    assert_eq!(trim.dropped, 1, "a mark past the bound was kept");

    set.report("new", &filled_to(BYTES_MAX, &[marked, honest])).expect("report");
    assert_eq!(set.surface_ids(), ["new"]);
    assert_eq!(route(&set, marked), ask(marked), "an evicted surface's lost mark let the press open");
    set.report("later", &owned(&[marked, honest, &full[0]])).expect("report");
    assert_eq!(route(&set, marked), ask(marked), "a later report of the address let the press open");

    set.report("old", &[]).expect("the surface goes");
    assert_eq!(route(&set, marked), PopupRoute::Browser(marked.to_string()), "the fallback outlived its surface");
    assert_eq!(route(&set, honest), PopupRoute::Browser(honest.to_string()));
    assert_eq!(route(&set, &full[0]), ask(&full[0]), "a kept mark stopped asking");
}

/// ONE SURFACE TOO MANY TO FOLLOW: past SURFACES_MAX surfaces whose marks found no room, every
/// press asks for the rest of the session, even once they have all reported again; at
/// SURFACES_MAX, presses open once they have. Mutations: follow no more than fit, and nothing past
/// them → the last press opens; give up one surface early → the first set's press asks.
#[test]
fn past_as_many_short_surfaces_as_surfaces_every_press_asks_for_good() {
    let honest = "https://shop.example/";
    for (short, asks) in [(SURFACES_MAX, false), (SURFACES_MAX + 1, true)] {
        let mut set = Rendered::default();
        set.report_asking("full", &a_mebibyte_of_marks(), &a_mebibyte_of_marks()).expect("report");
        for i in 0..short {
            let mark = format!("https://evil-{i}.example/");
            set.report_asking(&format!("s{i}"), &[mark.clone()], &[mark]).expect("report");
        }
        for i in 0..short {
            set.report(&format!("s{i}"), &[]).expect("the surface goes");
        }
        set.report("shop", &owned(&[honest])).expect("report");
        let route = popup_route(honest, Some(&set), Activation::Person);
        assert_eq!(route == PopupRoute::Ask(honest.to_string()), asks, "{short} short surfaces: {route:?}");
    }
}

/// THE ASK'S LINE CARRIES NO PART OF THE ADDRESS. Mutation: put the host in the line → red.
#[test]
fn an_ask_line_names_no_part_of_the_address() {
    let line = ask_line("https://evil.example/reset/TOKEN?d=secret#f");
    for part in ["TOKEN", "secret", "reset", "evil.example", "#f"] {
        assert!(!line.contains(part), "{line} carries {part}");
    }
    assert_eq!(line, r#"{"service":"shell","event":"link_ask","hostClass":"public"}"#);
}
