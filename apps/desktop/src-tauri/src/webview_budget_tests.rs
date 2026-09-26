//! The process-wide pressure ask: thresholds WebKitGTK can take, and no kill threshold.

use super::*;

#[test]
fn the_thresholds_are_fractions_in_order() {
    assert!(PRESSURE.conservative > 0.0 && PRESSURE.conservative < PRESSURE.strict);
    assert!(PRESSURE.strict < 1.0, "a strict threshold at the limit releases nothing before it");
    assert!(PRESSURE.limit_mib > 0 && PRESSURE.poll_s > 0.0);
}

#[test]
fn the_per_window_ask_is_gone_and_no_kill_threshold_exists() {
    let src = include_str!("webview_budget.rs");
    let code: String = src.lines().filter(|l| !l.trim_start().starts_with("//")).collect();
    assert!(!code.contains("set_cache_model") && !code.contains("set_enable_page_cache"));
    assert!(!code.contains("set_kill_threshold"));
}
