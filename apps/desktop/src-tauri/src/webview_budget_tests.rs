//! The window's webview budget: both settings, or the test fails.
//!
//! The defect these guard against is a pair applied by halves — the cache model lowered while the
//! back/forward cache stays on, or the reverse — which costs most of the saving and looks like a
//! fix. So the sink records every call and the tests read the whole record, never one field.

use super::*;

/// A sink that remembers what it was asked, in order.
#[derive(Default)]
struct Recorder {
    calls: Vec<String>,
}

impl Sink for Recorder {
    fn set_cache_model(&mut self, model: Model) {
        self.calls.push(format!("cache_model={model:?}"));
    }
    fn set_page_cache(&mut self, enabled: bool) {
        self.calls.push(format!("page_cache={enabled}"));
    }
}

#[test]
fn the_window_asks_for_a_document_viewer_and_no_page_cache() {
    assert_eq!(ASK.cache_model, Model::DocumentViewer);
    assert!(!ASK.page_cache);
}

#[test]
fn both_settings_are_carried_and_neither_alone() {
    let mut sink = Recorder::default();
    apply_to(&mut sink, ASK);
    assert_eq!(
        sink.calls,
        vec!["cache_model=DocumentViewer".to_string(), "page_cache=false".to_string()],
        "the pair is applied together; one of the two is the half-applied form"
    );
}

#[test]
fn the_ask_is_carried_verbatim_rather_than_reinterpreted() {
    let mut sink = Recorder::default();
    apply_to(&mut sink, Ask { cache_model: Model::WebBrowser, page_cache: true });
    assert_eq!(
        sink.calls,
        vec!["cache_model=WebBrowser".to_string(), "page_cache=true".to_string()],
        "a carrier that ignores its argument would pass every test written against ASK alone"
    );
}

#[test]
fn every_model_maps_to_a_distinct_name() {
    let names: Vec<String> = [Model::DocumentViewer, Model::DocumentBrowser, Model::WebBrowser]
        .iter()
        .map(|m| format!("{m:?}"))
        .collect();
    let mut unique = names.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), names.len(), "two models sharing a name would hide a wrong one");
}
