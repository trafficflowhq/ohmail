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

/// The scope every fixture process is launched in unless a test says otherwise.
const SCOPE: &str = "/user.slice/user-1000.slice/session-2.scope";

/// A `/proc` entry written THE WAY THE KERNEL WRITES ONE.
///
/// `comm` is CAPPED AT 15 CHARACTERS here, because that is what `TASK_COMM_LEN` does to it on the
/// running machine. Every fixture in this file used to write the untruncated name, so the double
/// did not fail the way production fails and a rule that could never match on Linux passed for a
/// year. `cmdline` carries the whole path, NUL-separated, which is where the full name survives.
fn write_proc(root: &PathBuf, pid: u32, exe: &str, ppid: u32, rss_kb: Option<u64>) {
    write_proc_as(root, pid, exe, ppid, rss_kb, Some(SCOPE), true);
}

fn write_proc_as(
    root: &PathBuf,
    pid: u32,
    exe: &str,
    ppid: u32,
    rss_kb: Option<u64>,
    scope: Option<&str>,
    with_cmdline: bool,
) {
    let dir = root.join(pid.to_string());
    fs::create_dir_all(&dir).expect("pid dir");
    let name = exe.rsplit('/').next().unwrap_or(exe);
    let comm: String = name.chars().take(TASK_COMM_LEN - 1).collect();
    // The real field order: pid, (comm), state, ppid, then the rest.
    fs::write(&dir.join("stat"), format!("{pid} ({comm}) S {ppid} 1 1 0 -1 0 0 0\n")).expect("stat");
    if with_cmdline {
        // NUL-separated, and the body ends with one — as the kernel writes it.
        fs::write(&dir.join("cmdline"), format!("{exe}\0-scanForwards\0")).expect("cmdline");
    }
    if let Some(scope) = scope {
        fs::write(&dir.join("cgroup"), format!("0::{scope}\n")).expect("cgroup");
    }
    let status = match rss_kb {
        Some(kb) => format!("Name:\t{comm}\nVmPeak:\t 999999 kB\nVmRSS:\t {kb} kB\nThreads:\t58\n"),
        None => format!("Name:\t{comm}\nThreads:\t58\n"),
    };
    fs::write(&dir.join("status"), status).expect("status");
}

/// Where the app's own binaries live on a Linux install, so the fixtures carry real argv paths.
const WEBKIT_LIBEXEC: &str = "/usr/lib/webkit2gtk-4.1";

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
    write_proc(&root, 99, "/usr/bin/ohmail", 1, Some(180_000)); // the shell itself
    write_proc(&root, 10, &format!("{WEBKIT_LIBEXEC}/WebKitWebProcess"), 99, Some(944_128));
    write_proc(&root, 11, &format!("{WEBKIT_LIBEXEC}/WebKitNetworkProcess"), 99, Some(21_504));
    // Another app's renderer: ours by neither descent nor scope.
    write_proc_as(
        &root,
        12,
        &format!("{WEBKIT_LIBEXEC}/WebKitWebProcess"),
        500,
        Some(700_000),
        Some("/user.slice/user-1000.slice/session-9.scope"),
        true,
    );
    write_proc(&root, 13, "/usr/bin/node", 99, Some(325_000)); // the engine sidecar, not a webview
    fs::write(&root.join("cpuinfo"), "not a pid\n").expect("noise");

    let found = webkit_children_in(&root, 99);

    assert_eq!(found.len(), 2, "only our own WebKit children: {found:?}");
    assert_eq!(found[0], Child { pid: 10, name: "WebKitWebProcess".into(), rss_kb: Some(944_128) });
    assert_eq!(found[1], Child { pid: 11, name: "WebKitNetworkProcess".into(), rss_kb: Some(21_504) });
    // The name in the line is this module's word and not the kernel's truncated copy, which is
    // what the `stat` file of pid 10 actually holds.
    let stat = fs::read_to_string(root.join("10").join("stat")).expect("stat");
    assert!(stat.contains("(WebKitWebProces)"), "the fixture must carry the kernel's cap: {stat}");
    let _ = fs::remove_dir_all(&root);
}

/// THE READING THE RUNNING BUILD GAVE, replayed against the rule.
///
/// Read off an Omarchy guest on 2026-09-12 while an external sampler held the same two processes
/// at 1 057 332 kB: pid 2752936 and pid 2753026, both children of the shell at 2752819, `comm`
/// `WebKitNetworkPr` and `WebKitWebProces`. Fifteen characters each, because that is all `comm`
/// has. The shipped rule asked whether those strings START WITH a sixteen- and a twenty-character
/// name, found nothing, and the shell reported an empty child list for a webview holding a
/// gigabyte.
#[test]
fn the_kernels_truncated_comm_is_what_the_rule_must_read() {
    assert_eq!(webkit_name_of_comm("WebKitWebProces"), Some("WebKitWebProcess"));
    assert_eq!(webkit_name_of_comm("WebKitNetworkPr"), Some("WebKitNetworkProcess"));
    assert_eq!(webkit_name_of_comm("WebKitGPUProces"), Some("WebKitGPUProcess"));

    // THE POSITIVE CONTROL. The untruncated names — which no Linux kernel writes into `comm` and
    // which every fixture here used to — still classify, so the rule is not merely inverted.
    for name in WEBKIT_PROCESS_NAMES {
        assert_eq!(webkit_name_of_comm(name), Some(*name), "{name}");
    }

    // And it is not "anything that begins with WebKit": the length floor refuses a short prefix.
    assert_eq!(webkit_name_of_comm("WebKit"), None);
    assert_eq!(webkit_name_of_comm("WebKitWeb"), None);
    assert_eq!(webkit_name_of_comm("node"), None);
    assert_eq!(webkit_name_of_comm(""), None);

    // The defect itself, on the record: the comparison the shipped build made cannot succeed.
    assert!(!"WebKitWebProces".starts_with("WebKitWebProcess"));
    assert!(!"WebKitNetworkPr".starts_with("WebKitNetworkProcess"));
}

/// The rule is the ARGUMENT VECTOR, and `comm` is only the fallback.
#[test]
fn a_webkit_process_is_classified_by_its_arguments() {
    let argv = "/usr/lib/webkit2gtk-4.1/WebKitWebProcess\0 7\0";
    assert_eq!(argv0_basename(argv), Some("WebKitWebProcess".to_string()));
    assert_eq!(argv0_basename("ohmail\0"), Some("ohmail".to_string()));
    // A kernel thread and a process already gone both have an empty body: no classification from
    // an empty string — the caller falls back to `comm`.
    assert_eq!(argv0_basename(""), None);
    assert_eq!(argv0_basename("\0\0"), None);
    assert_eq!(argv0_basename("/usr/lib/"), None);

    assert_eq!(webkit_name_of_argv("WebKitWebProcess"), Some("WebKitWebProcess"));
    assert_eq!(webkit_name_of_argv("WebKitNetworkProcess"), Some("WebKitNetworkProcess"));
    assert_eq!(webkit_name_of_argv("WebKitGPUProcess"), Some("WebKitGPUProcess"));
    assert_eq!(webkit_name_of_argv("node"), None);
    assert_eq!(webkit_name_of_argv("ohmail"), None);
    // The fifteen-character spelling is what `comm` gives and is NOT what argv gives: the argv
    // rule reads whole names, and a truncated one there would be a different bug.
    assert_eq!(webkit_name_of_argv("WebKitWebProces"), None);
}

/// A process with no `cmdline` falls back to `comm`, and is still found.
#[test]
fn a_process_with_no_arguments_falls_back_to_the_capped_name() {
    let root = proc_tree("noargv");
    write_proc(&root, 99, "/usr/bin/ohmail", 1, Some(180_000));
    write_proc_as(&root, 20, "WebKitGPUProcess", 99, Some(60_000), Some(SCOPE), false);

    let found = webkit_children_in(&root, 99);

    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0], Child { pid: 20, name: "WebKitGPUProcess".into(), rss_kb: Some(60_000) });
    assert!(!root.join("20").join("cmdline").exists(), "the fixture must have no cmdline");
    let _ = fs::remove_dir_all(&root);
}

/// THE GROUP HALF, on its own.
///
/// Descent and scope are two independent readings of "is it ours", and a `/proc` snapshot's
/// `ppid` can name a pid the kernel has since reused. A row that passes the pid relation and sits
/// in another session's scope is refused; a row whose scope cannot be read narrows nothing, because
/// an unreadable file must never turn into a renderer costing zero.
#[test]
fn a_process_in_another_scope_is_not_ours_even_as_a_child() {
    let root = proc_tree("scope");
    write_proc(&root, 99, "/usr/bin/ohmail", 1, Some(180_000));
    write_proc(&root, 30, &format!("{WEBKIT_LIBEXEC}/WebKitWebProcess"), 99, Some(900_000));
    write_proc_as(
        &root,
        31,
        &format!("{WEBKIT_LIBEXEC}/WebKitWebProcess"),
        99,
        Some(700_000),
        Some("/user.slice/user-1000.slice/session-9.scope"),
        true,
    );

    let found = webkit_children_in(&root, 99);

    assert_eq!(found.iter().map(|c| c.pid).collect::<Vec<_>>(), vec![30], "{found:?}");

    // NO SCOPE IS NOT A FILTER, both ways round.
    assert!(same_scope(Some(SCOPE), Some(SCOPE)));
    assert!(!same_scope(Some(SCOPE), Some("/user.slice/other.scope")));
    assert!(same_scope(None, Some(SCOPE)));
    assert!(same_scope(Some(SCOPE), None));
    assert_eq!(parse_cgroup_scope(&format!("0::{SCOPE}\n")), Some(SCOPE.to_string()));
    // A v1 body names controllers, not a scope, and answers nothing rather than a guess.
    assert_eq!(parse_cgroup_scope("12:pids:/user.slice\n11:memory:/user.slice\n"), None);
    assert_eq!(parse_cgroup_scope("0::\n"), None);
    assert_eq!(parse_cgroup_scope(""), None);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_child_with_no_figure_is_unmeasured_and_not_zero() {
    let root = proc_tree("unmeasured");
    write_proc(&root, 20, "WebKitWebProcess", 99, None);
    let found = webkit_children_in(&root, 99);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].rss_kb, None);

    let line = vitals_line(&found, 5);
    assert!(line.contains("\"rssKb\":null"), "{line}");
    // A child with no figure is a DIFFERENT absent state from no children at all, and says so.
    assert!(line.contains("\"reason\":\"no_figures\""), "{line}");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_line_carries_the_service_event_and_a_total() {
    let children = vec![
        Child { pid: 10, name: "WebKitWebProcess".into(), rss_kb: Some(900_000) },
        Child { pid: 11, name: "WebKitNetworkProcess".into(), rss_kb: Some(20_000) },
    ];
    let line = vitals_line(&children, 10);

    assert!(line.contains("\"service\":\"shell\""), "{line}");
    assert!(line.contains("\"measured\":true"), "{line}");
    assert!(line.contains("\"reason\":null"), "a measured pass carries no reason: {line}");
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
    let line = vitals_line(&[], 5);
    assert!(line.contains("\"measured\":false"), "{line}");
    assert!(line.contains("\"totalRssKb\":null"), "{line}");
}

/// A PASS THAT FOUND NOTHING CANNOT LOOK HEALTHY, AND CANNOT LOOK LIKE THE OTHER ABSENCE.
///
/// The shipped Linux build wrote `"measured":true,"totalRssKb":0,"children":[]` beside a webview
/// holding 1 057 332 kB — the exact reading this module's own comment calls the one that must never
/// be inventable. `vitals_line` now takes no `measured` flag at all, so there is no argument a
/// caller can get wrong: the state is derived, and the three readings are told apart by name.
#[test]
fn a_pass_that_classified_no_children_names_that_and_is_never_measured() {
    let line = vitals_line(&[], 5);
    assert!(line.contains("\"measured\":false"), "{line}");
    assert!(line.contains("\"reason\":\"no_children_classified\""), "{line}");
    assert!(line.contains("\"totalRssKb\":null"), "{line}");
    assert!(line.contains("\"children\":[]"), "{line}");
    // And never the reading that shipped.
    assert!(!line.contains("\"totalRssKb\":0"), "{line}");

    assert_eq!(reading_of(&[]), Reading::NoChildrenClassified);
    assert_eq!(Reading::NoChildrenClassified.reason(), Some("no_children_classified"));
    assert_eq!(Reading::NoFigures.reason(), Some("no_figures"));
    assert_eq!(Reading::Measured.reason(), None);
    assert!(!Reading::NoChildrenClassified.measured());
    assert!(!Reading::NoFigures.measured());
    assert!(Reading::Measured.measured());

    let no_figures = vec![Child { pid: 1, name: "WebKitWebProcess".into(), rss_kb: None }];
    assert_eq!(reading_of(&no_figures), Reading::NoFigures);
    let measured = vec![Child { pid: 1, name: "WebKitWebProcess".into(), rss_kb: Some(10) }];
    assert_eq!(reading_of(&measured), Reading::Measured);

    // Every line this function can produce parses, whichever reading it carries.
    for children in [&[][..], &no_figures[..], &measured[..]] {
        let _: serde_json::Value =
            serde_json::from_str(&vitals_line(children, 5)).expect("valid JSON");
    }
}

/// THE BUDGET LINE IS REACHABLE ON LINUX AGAIN — the consequence the defect had.
///
/// `renderer_memory_high` fires off the sum over the classified children, so a rule that matched
/// nothing made the sum 0 and the crossing unreachable on every Linux install. The end-to-end
/// path is driven here: a fixture `/proc` holding the guest's own two processes, over budget.
#[test]
fn the_budget_crossing_is_reachable_from_a_linux_process_table() {
    let root = proc_tree("budget");
    write_proc(&root, 2_752_819, "/usr/bin/ohmail", 1, Some(180_000));
    let net = format!("{WEBKIT_LIBEXEC}/WebKitNetworkProcess");
    let web = format!("{WEBKIT_LIBEXEC}/WebKitWebProcess");
    write_proc(&root, 2_752_936, &net, 2_752_819, Some(21_504));
    write_proc(&root, 2_753_026, &web, 2_752_819, Some(1_600_000));

    let found = webkit_children_in(&root, 2_752_819);

    assert_eq!(found.len(), 2, "{found:?}");
    let total: u64 = found.iter().filter_map(|c| c.rss_kb).sum();
    assert_eq!(total, 1_621_504);
    assert!(reading_of(&found).measured());
    assert!(
        crossed_budget(None, total, RENDERER_BUDGET_KB),
        "the crossing this defect made unreachable on Linux"
    );
    let _ = fs::remove_dir_all(&root);
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

/* ── THE OTHER TWO PLATFORMS, against fixture process tables ────────────────────────────────────
 *
 * Neither macOS nor Windows can be read from this host, and the readers that call the operating
 * system are three functions each. Everything that DECIDES — which process belongs to this app,
 * which name is one of the webview's, what unit the figure is in — is above them and is driven
 * here with tables written by hand, so the rule is watched on every platform's CI rather than only
 * on the one it runs on.
 */

fn row(pid: u32, name: &str, ppid: u32, rss_kb: Option<u64>) -> ProcRow {
    ProcRow { pid, name: name.to_string(), ppid, rss_kb }
}

#[test]
fn a_macos_helper_is_named_by_its_bundle_namespace() {
    assert!(is_macos_webkit_helper("com.apple.WebKit.WebContent"));
    assert!(is_macos_webkit_helper("com.apple.WebKit.Networking"));
    assert!(is_macos_webkit_helper("com.apple.WebKit.GPU"));
    // The sandboxed variants carry suffixes, which is why the rule is a prefix.
    assert!(is_macos_webkit_helper("com.apple.WebKit.WebContent.Development"));
    // Not the engine, not the app, not somebody else's framework.
    assert!(!is_macos_webkit_helper("node"));
    assert!(!is_macos_webkit_helper("ohmail"));
    assert!(!is_macos_webkit_helper("com.apple.CoreLocationAgent"));
}

#[test]
fn macos_takes_this_apps_helpers_and_leaves_every_other_process() {
    let table = vec![
        row(10, "com.apple.WebKit.WebContent", 99, Some(944_128)),
        row(11, "com.apple.WebKit.Networking", 99, Some(21_504)),
        row(12, "node", 99, Some(325_000)),               // our engine sidecar, not the webview
        row(13, "com.apple.WebKit.WebContent", 500, Some(700_000)), // another app's renderer
    ];

    let found = helpers_of(&table, 99, is_macos_webkit_helper, false);

    assert_eq!(found.len(), 2, "only our own WebKit helpers: {found:?}");
    assert_eq!(found[0], Child { pid: 10, name: "com.apple.WebKit.WebContent".into(), rss_kb: Some(944_128) });
    assert_eq!(found[1], Child { pid: 11, name: "com.apple.WebKit.Networking".into(), rss_kb: Some(21_504) });
    assert!(measured_of(&found));
}

#[test]
fn a_macos_app_whose_helpers_are_not_its_children_reports_unmeasured() {
    // WebKit starts its content processes as XPC services on this platform, and a service launchd
    // started has launchd as its parent. The reading is then ABSENT, never zero.
    let table = vec![row(10, "com.apple.WebKit.WebContent", 1, Some(944_128))];

    let found = helpers_of(&table, 99, is_macos_webkit_helper, false);

    assert!(found.is_empty(), "{found:?}");
    assert!(!measured_of(&found));
    let line = vitals_line(&found, 5);
    assert!(line.contains("\"measured\":false"), "{line}");
    assert!(line.contains("\"totalRssKb\":null"), "{line}");
}

#[test]
fn windows_walks_the_whole_family_because_the_memory_is_a_grandchild() {
    // WebView2 starts ONE browser process as the app's child; that process starts the renderer,
    // the GPU process and the utilities — which is where the memory is.
    let table = vec![
        row(200, "msedgewebview2.exe", 99, Some(40_000)),   // the browser process
        row(201, "msedgewebview2.exe", 200, Some(910_000)), // the renderer
        row(202, "MSEdgeWebView2.exe", 200, Some(120_000)), // the GPU process, as the OS spells it
        row(203, "ohmail.exe", 99, Some(80_000)),           // this app's own second process
        row(204, "msedgewebview2.exe", 900, Some(700_000)), // another app's WebView2
    ];

    let found = helpers_of(&table, 99, is_webview2_helper, true);

    assert_eq!(found.len(), 3, "the browser process and both of its children: {found:?}");
    assert_eq!(found.iter().map(|c| c.pid).collect::<Vec<_>>(), vec![200, 201, 202]);
    assert_eq!(found.iter().filter_map(|c| c.rss_kb).sum::<u64>(), 1_070_000);

    // THE CONTROL FOR THE WALK ITSELF: with direct children only, the 910 MB renderer is missed
    // and the line would report 40 MB for a webview costing a gigabyte.
    let children_only = helpers_of(&table, 99, is_webview2_helper, false);
    assert_eq!(children_only.len(), 1, "{children_only:?}");
    assert_eq!(children_only[0].pid, 200);
}

#[test]
fn a_process_table_that_points_at_itself_does_not_hang_the_walk() {
    // A snapshot is not a tree: a reused pid can make a row its own ancestor, and a reporting
    // thread that trusts the table terminates is a hang nobody sees.
    let table = vec![
        row(10, "msedgewebview2.exe", 11, Some(1)),
        row(11, "msedgewebview2.exe", 10, Some(2)),
        row(12, "msedgewebview2.exe", 99, Some(3)),
    ];

    let found = helpers_of(&table, 99, is_webview2_helper, true);

    assert_eq!(found.iter().map(|c| c.pid).collect::<Vec<_>>(), vec![12]);
}

#[test]
fn the_two_platforms_that_answer_in_bytes_are_converted_once() {
    // macOS's `ri_phys_footprint` and Windows's `WorkingSetSize` are bytes; Linux's `VmRSS` is
    // already kB. No page size enters either conversion, which is the whole point of both.
    assert_eq!(kb_of_bytes(0), 0);
    assert_eq!(kb_of_bytes(1_073_741_824), 1_048_576);
    assert_eq!(kb_of_bytes(1_023), 0, "a sub-kilobyte figure floors, and never rounds up to one");
}

#[test]
fn a_pass_that_read_no_figure_is_not_a_measurement() {
    assert!(!measured_of(&[]));
    assert!(!measured_of(&[Child { pid: 1, name: "com.apple.WebKit.GPU".into(), rss_kb: None }]));
    assert!(measured_of(&[
        Child { pid: 1, name: "com.apple.WebKit.GPU".into(), rss_kb: None },
        Child { pid: 2, name: "com.apple.WebKit.WebContent".into(), rss_kb: Some(10) },
    ]));
}

/* ── `ui_vitals` — the window's own line, composed here and never forwarded ───────────────────── */

#[test]
fn the_ui_line_carries_the_service_event_and_the_whole_vocabulary() {
    let reported = serde_json::json!({
        "shellPaintedMs": 412,
        "listUsableMs": 1_180,
        "engineReadyMs": 1_640,
        "openP50Ms": 88,
        "openP95Ms": 143,
        "openCount": 61,
        "switchP50Ms": 54,
        "switchP95Ms": 120,
        "switchCount": 30,
        "searchP50Ms": 210,
        "searchP95Ms": 470,
        "searchCount": 20,
        "longFrames": 7,
        "longTasks": 1,
        "deriveMs": 196,
        "deriveP50Ms": 41,
        "deriveP95Ms": 98,
        "deriveCount": 1_312,
        "notifiesPer5min": 2_000,
        "uptimeMin": 35,
    });

    let line = ui_vitals_line(&reported);

    assert!(line.contains("\"service\":\"ui\""), "{line}");
    assert!(line.contains("\"event\":\"ui_vitals\""), "{line}");
    assert!(line.contains("\"deriveMs\":196"), "{line}");
    // The derivation's four numbers all reach the line: the worst pass, what the window was
    // usually like, and how many bumps paid for it.
    assert!(line.contains("\"deriveP50Ms\":41"), "{line}");
    assert!(line.contains("\"deriveP95Ms\":98"), "{line}");
    assert!(line.contains("\"deriveCount\":1312"), "{line}");
    assert!(line.contains("\"notifiesPer5min\":2000"), "{line}");
    assert!(line.contains("\"longFrames\":7"), "{line}");
    let parsed: serde_json::Value = serde_json::from_str(&line).expect("valid JSON");
    for name in UI_VITALS_FIELDS {
        assert!(parsed.get(name).is_some(), "{name} is missing from {line}");
    }
}

#[test]
fn nothing_the_window_wrote_can_reach_the_log_as_text() {
    // THE PROPERTY THIS PATH EXISTS FOR. A subject, an address or a folder name is not something
    // the shell can forward wrongly, because it forwards nothing: the keys are the constant's and
    // every value is a number or null.
    let reported = serde_json::json!({
        "openP95Ms": "re: your invoice",
        "subject": "re: your invoice",
        "folder": "Accounts",
        "deriveMs": 196,
    });

    let line = ui_vitals_line(&reported);

    assert!(!line.contains("invoice"), "{line}");
    assert!(!line.contains("Accounts"), "{line}");
    assert!(!line.contains("subject"), "{line}");
    assert!(line.contains("\"openP95Ms\":null"), "a field that is not a number is absent: {line}");
    assert!(line.contains("\"deriveMs\":196"), "{line}");
    let _: serde_json::Value = serde_json::from_str(&line).expect("valid JSON");
}

#[test]
fn a_derivation_field_the_vocabulary_does_not_carry_is_dropped() {
    // THE NEGATIVE HALF of the derivation fields above. A window on a newer build reporting a
    // percentile this shell has never heard of must not put the key into the log — the vocabulary
    // is this file's, and a reader keys on it. `deriveP99Ms` is the sibling most likely to be
    // added next, which is exactly why it is the one asked about.
    let line = ui_vitals_line(&serde_json::json!({ "deriveP99Ms": 640, "deriveP95Ms": 98 }));

    assert!(!line.contains("deriveP99Ms"), "an un-allowlisted sibling reached the line: {line}");
    assert!(!line.contains("640"), "its VALUE reached the line: {line}");
    assert!(line.contains("\"deriveP95Ms\":98"), "the allowlisted one still reads: {line}");
}

#[test]
fn an_unreported_or_impossible_number_is_null_and_never_zero() {
    let line = ui_vitals_line(&serde_json::json!({ "openP50Ms": -1, "openCount": 0, "deriveCount": 0 }));

    assert!(line.contains("\"shellPaintedMs\":null"), "not reported yet: {line}");
    assert!(line.contains("\"openP50Ms\":null"), "a negative duration is not a measurement: {line}");
    assert!(line.contains("\"openCount\":0"), "zero opens IS a measurement: {line}");
    // And the same distinction on the derivation, which is the one a reader acts on: a window that
    // derived nothing reports a count of 0 with null percentiles, never zero milliseconds.
    assert!(line.contains("\"deriveCount\":0"), "zero derivations IS a measurement: {line}");
    assert!(line.contains("\"deriveP95Ms\":null"), "no derivation means no milliseconds: {line}");
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

/// NO NAME LONGER THAN `comm` IS EVER COMPARED AGAINST A `comm` THE SHIPPED WAY ROUND.
///
/// The defect was one character of direction: `comm.starts_with("WebKitWebProcess")` against a
/// string the kernel caps at fifteen. This refuses that shape coming back — for any of the names,
/// in any file — and `apps/desktop/test/renderer-vitals-linux-comm.test.ts` replays it over a
/// recorded Linux process table, so the rule is read from outside the crate too.
#[test]
fn no_rule_compares_a_comm_against_a_name_longer_than_a_comm() {
    let src = include_str!("vitals.rs");
    let code: String = src
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            !(t.starts_with("//") || t.starts_with("//!") || t.starts_with("///"))
        })
        .collect::<Vec<_>>()
        .join("\n");

    for name in WEBKIT_PROCESS_NAMES {
        if name.len() <= TASK_COMM_LEN - 1 {
            continue;
        }
        let shipped = format!("comm.starts_with(\"{name}\")");
        assert!(!code.contains(&shipped), "the truncation defect is back: {shipped}");
    }
    // The rule reads argv, and the fallback reads the cap.
    assert!(code.contains("fn webkit_name_of_argv"), "the argv rule is gone");
    assert!(code.contains("TASK_COMM_LEN - 1"), "the fallback no longer reads the kernel's cap");
    // And the line derives `measured` rather than taking it.
    assert!(
        code.contains("fn vitals_line(children: &[Child], uptime_min: u64)"),
        "vitals_line takes a measured flag again, which is the state that must not be passable"
    );
}
