//! The renderer-vitals reader, against fixture `/proc` trees.
//!
//! Every figure the shell reports about memory comes through `parse_vm_rss_kb`, and the reason it
//! reads `VmRSS` rather than `statm` is a platform the incident was measured on: Asahi kernels use
//! 16 KB pages, so a page count multiplied by 4096 is four times too low. The last test in this
//! file refuses that literal in the module's source.

use super::*;
use std::fs;
use std::path::PathBuf;

/// A throwaway `/proc`-shaped tree. Named per test so two can run at once.
fn proc_tree(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("ohmail-vitals-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("fixture root");
    root
}

fn write_proc(root: &PathBuf, pid: u32, comm: &str, ppid: u32, rss_kb: Option<u64>) {
    let dir = root.join(pid.to_string());
    fs::create_dir_all(&dir).expect("pid dir");
    // The real field order: pid, (comm), state, ppid, then the rest.
    fs::write(&dir.join("stat"), format!("{pid} ({comm}) S {ppid} 1 1 0 -1 0 0 0\n")).expect("stat");
    let status = match rss_kb {
        Some(kb) => format!("Name:\t{comm}\nVmPeak:\t 999999 kB\nVmRSS:\t {kb} kB\nThreads:\t58\n"),
        None => format!("Name:\t{comm}\nThreads:\t58\n"),
    };
    fs::write(&dir.join("status"), status).expect("status");
}

#[test]
fn reads_vm_rss_in_the_kernels_own_kilobytes() {
    let status = "Name:\tWebKitWebProcess\nVmPeak:\t 1234 kB\nVmRSS:\t  944128 kB\nThreads:\t58\n";
    assert_eq!(parse_vm_rss_kb(status), Some(944_128));
}

#[test]
fn refuses_a_unit_it_does_not_recognise() {
    // A future kernel unit must read as "no figure" rather than as kB.
    assert_eq!(parse_vm_rss_kb("VmRSS:\t 4 MB\n"), None);
    assert_eq!(parse_vm_rss_kb("VmPeak:\t 4 kB\n"), None);
    assert_eq!(parse_vm_rss_kb(""), None);
}

#[test]
fn a_comm_with_spaces_and_parens_does_not_shift_the_parent() {
    // The usual bug: splitting on whitespace makes `(foo bar)` move ppid by one field.
    let stat = "42 (Web Kit (odd)) S 7 1 1 0 -1 0 0 0\n";
    assert_eq!(parse_stat_parent(stat), Some(("Web Kit (odd)".to_string(), 7)));
}

#[test]
fn finds_only_this_shells_webkit_children() {
    let root = proc_tree("children");
    write_proc(&root, 10, "WebKitWebProcess", 99, Some(944_128));
    write_proc(&root, 11, "WebKitNetworkProcess", 99, Some(21_504));
    write_proc(&root, 12, "WebKitWebProcess", 500, Some(700_000)); // another app's renderer
    write_proc(&root, 13, "node", 99, Some(325_000)); // our engine sidecar, not the webview
    fs::write(&root.join("cpuinfo"), "not a pid\n").expect("noise");

    let found = webkit_children_in(&root, 99);

    assert_eq!(found.len(), 2, "only our own WebKit children: {found:?}");
    assert_eq!(found[0], Child { pid: 10, name: "WebKitWebProcess".into(), rss_kb: Some(944_128) });
    assert_eq!(found[1], Child { pid: 11, name: "WebKitNetworkProcess".into(), rss_kb: Some(21_504) });
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_child_with_no_figure_is_unmeasured_and_not_zero() {
    let root = proc_tree("unmeasured");
    write_proc(&root, 20, "WebKitWebProcess", 99, None);
    let found = webkit_children_in(&root, 99);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].rss_kb, None);

    let line = vitals_line(&found, true, 5);
    assert!(line.contains("\"rssKb\":null"), "{line}");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_line_carries_the_service_event_and_a_total() {
    let children = vec![
        Child { pid: 10, name: "WebKitWebProcess".into(), rss_kb: Some(900_000) },
        Child { pid: 11, name: "WebKitNetworkProcess".into(), rss_kb: Some(20_000) },
    ];
    let line = vitals_line(&children, true, 10);

    assert!(line.contains("\"service\":\"shell\""), "{line}");
    assert!(line.contains("\"event\":\"renderer_vitals\""), "{line}");
    assert!(line.contains("\"totalRssKb\":920000"), "{line}");
    assert!(line.contains("\"uptimeMin\":10"), "{line}");
    assert!(line.contains(&format!("\"budgetKb\":{RENDERER_BUDGET_KB}")), "{line}");
    // It must parse. A log line nothing can read is not telemetry.
    let parsed: serde_json::Value = serde_json::from_str(&line).expect("valid JSON");
    assert_eq!(parsed["children"].as_array().map(|a| a.len()), Some(2));
}

#[test]
fn an_unmeasured_platform_says_so_rather_than_reporting_nothing() {
    // macOS and Windows have no `/proc`: the total is null, not 0.
    let line = vitals_line(&[], false, 5);
    assert!(line.contains("\"measured\":false"), "{line}");
    assert!(line.contains("\"totalRssKb\":null"), "{line}");
}

#[test]
fn the_budget_line_fires_once_per_crossing() {
    let budget = RENDERER_BUDGET_KB;
    // First reading already over: a crossing, because there is no earlier reading under it.
    assert!(crossed_budget(None, budget + 1, budget));
    // Still over: not a new crossing.
    assert!(!crossed_budget(Some(budget + 1), budget + 2, budget));
    // Under, then over again: a real second crossing.
    assert!(crossed_budget(Some(budget - 1), budget + 1, budget));
    // Never over at all.
    assert!(!crossed_budget(Some(10), 20, budget));
    // Exactly at the budget is not over it.
    assert!(!crossed_budget(None, budget, budget));
}

#[test]
fn the_budget_line_names_both_numbers() {
    let line = budget_line(1_700_000);
    assert!(line.contains("\"event\":\"renderer_memory_high\""), "{line}");
    assert!(line.contains("\"totalRssKb\":1700000"), "{line}");
    let _: serde_json::Value = serde_json::from_str(&line).expect("valid JSON");
}

#[test]
fn raising_the_oom_score_writes_the_number_and_a_refusal_is_not_fatal() {
    let root = proc_tree("oom");
    let dir = root.join("30");
    fs::create_dir_all(&dir).expect("pid dir");
    fs::write(&dir.join("oom_score_adj"), "0\n").expect("seed");

    assert!(raise_oom_score(&root, 30, WEBKIT_OOM_SCORE_ADJ));
    let written = fs::read_to_string(dir.join("oom_score_adj")).expect("read back");
    assert_eq!(written.trim(), "300");

    // A pid with no such file — a hardened kernel, or a process that just exited.
    assert!(!raise_oom_score(&root, 31, WEBKIT_OOM_SCORE_ADJ));
    let _ = fs::remove_dir_all(&root);
}

/// NO MEMORY FIGURE IS DERIVED FROM A PAGE-SIZE LITERAL.
///
/// The incident host uses 16 KB pages, so `pages * 4096` reads four times low. This module avoids
/// the arithmetic entirely by reading `VmRSS`, and this census refuses the literal coming back —
/// including through `statm`, which is the file that would require it.
#[test]
fn no_page_size_literal_and_no_statm_read() {
    let src = include_str!("vitals.rs");
    let code: String = src
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            !(t.starts_with("//") || t.starts_with("//!") || t.starts_with("///"))
        })
        .collect::<Vec<_>>()
        .join("\n");

    assert!(!code.contains("4096"), "a page-size literal is back in vitals.rs");
    assert!(!code.contains("16384"), "a page-size literal is back in vitals.rs");
    assert!(!code.contains("statm"), "vitals.rs reads statm, which needs a page size");
    assert!(code.contains("VmRSS:"), "the reader must still read VmRSS");
}
