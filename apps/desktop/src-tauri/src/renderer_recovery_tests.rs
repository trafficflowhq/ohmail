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
fn the_line_names_the_reason_the_answer_and_the_numbers_that_tell_a_kill_from_a_crash() {
    let ctx = Context { uptime_min: 42, mem_available_kb: Some(812_345), oom_kills: Some(1) };
    assert_eq!(
        line("crashed", Action::Reload, &ctx),
        r#"{"service":"shell","event":"renderer_gone","reason":"crashed","action":"reloaded","uptimeMin":42,"memAvailableKb":812345,"oomKills":1}"#
    );
    let unread = Context { uptime_min: 0, mem_available_kb: None, oom_kills: None };
    let v: serde_json::Value = serde_json::from_str(&line("memory_limit", Action::OfferRelaunch, &unread)).unwrap();
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["action", "event", "memAvailableKb", "oomKills", "reason", "service", "uptimeMin"]);
    assert_eq!(v["action"], "relaunch_offered");
    // A figure that could not be read is null, never a zero that reads as "no memory left".
    assert!(v["memAvailableKb"].is_null() && v["oomKills"].is_null());
    assert_eq!(v["uptimeMin"], 0);
}

#[test]
fn mem_available_is_read_in_the_kernels_kb_and_nothing_else() {
    let meminfo = "MemTotal:       16314600 kB\nMemFree:          401234 kB\nMemAvailable:    1234567 kB\n";
    assert_eq!(parse_mem_available_kb(meminfo), Some(1_234_567));
    assert_eq!(parse_mem_available_kb("MemAvailable:    1234 MB\n"), None);
    assert_eq!(parse_mem_available_kb("MemTotal:       16314600 kB\nMemFree: 1 kB\n"), None);
    assert_eq!(parse_mem_available_kb("MemAvailable: lots kB\n"), None);
}

const EVENTS: &str = "low 0\nhigh 0\nmax 4\noom 2\noom_kill 3\noom_group_kill 0\n";

#[test]
fn oom_kill_is_the_cgroups_counter_and_nothing_like_it() {
    assert_eq!(parse_oom_kill(EVENTS), Some(3));
    assert_eq!(parse_oom_kill("oom_group_kill 1\noom 2\n"), None);
    assert_eq!(parse_oom_kill(""), None);
}

const SCOPE: &str = "user.slice/user-1000.slice/user@1000.service/app.slice/app-ohmail.scope";

/// A `/proc` beside a `/sys/fs/cgroup`, each file present only when given.
fn fixture(name: &str, meminfo: Option<&str>, membership: Option<&str>, events: Option<&str>) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("ohmail-rr-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("proc/self")).unwrap();
    std::fs::create_dir_all(root.join("cgroup").join(SCOPE)).unwrap();
    if let Some(m) = meminfo {
        std::fs::write(root.join("proc/meminfo"), m).unwrap();
    }
    if let Some(c) = membership {
        std::fs::write(root.join("proc/self/cgroup"), c).unwrap();
    }
    if let Some(e) = events {
        set_events(&root, e);
    }
    root
}

fn set_events(root: &Path, events: &str) {
    std::fs::write(root.join("cgroup").join(SCOPE).join("memory.events"), events).unwrap();
}

#[test]
fn only_kills_charged_to_the_apps_own_cgroup_are_counted() {
    let root = fixture("own", None, Some(&format!("0::/{SCOPE}\n")), Some(EVENTS));
    assert_eq!(own_oom_kills_in(&root.join("proc/self"), &root.join("cgroup")), Some(3));
    // Another program's kill lands on its own scope (or only on the parents), never on ours.
    let sibling = root.join("cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/app-other.scope");
    std::fs::create_dir_all(&sibling).unwrap();
    std::fs::write(sibling.join("memory.events"), "oom_kill 9\n").unwrap();
    std::fs::write(root.join("cgroup/user.slice/memory.events"), "oom_kill 12\n").unwrap();
    assert_eq!(own_oom_kills_in(&root.join("proc/self"), &root.join("cgroup")), Some(3));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn no_cgroup_v2_reading_is_null_never_zero() {
    let at = |name: &str, membership: Option<&str>, events: Option<&str>| {
        let root = fixture(name, None, membership, events);
        let n = own_oom_kills_in(&root.join("proc/self"), &root.join("cgroup"));
        let _ = std::fs::remove_dir_all(&root);
        n
    };
    // cgroup v1: no unified line.
    assert_eq!(at("v1", Some("12:memory:/user.slice\n1:name=systemd:/user.slice\n"), Some(EVENTS)), None);
    // The root cgroup has no memory.events; neither has a scope without the memory controller.
    assert_eq!(at("root", Some("0::/\n"), Some(EVENTS)), None);
    assert_eq!(at("noevents", Some(&format!("0::/{SCOPE}\n")), None), None);
    assert_eq!(at("noself", None, Some(EVENTS)), None);
}

#[test]
fn each_death_counts_the_kills_since_the_one_before_and_minutes_since_arming() {
    let root = fixture("all", Some("MemAvailable:  2048 kB\n"), Some(&format!("0::/{SCOPE}\n")), Some("oom_kill 5\n"));
    let (proc_root, cgroups) = (root.join("proc"), root.join("cgroup"));
    let t0 = Instant::now();
    let mut before = Some(3);
    let ctx = context_in(&proc_root, &cgroups, t0, &mut before, t0 + Duration::from_secs(61 * 60));
    assert_eq!(ctx, Context { uptime_min: 61, mem_available_kb: Some(2048), oom_kills: Some(2) });
    assert_eq!(before, Some(5));
    // The next death, with no kill since, reads 0: the first death's kills are not carried.
    assert_eq!(context_in(&proc_root, &cgroups, t0, &mut before, t0).oom_kills, Some(0));
    set_events(&root, "oom_kill 6\n");
    assert_eq!(context_in(&proc_root, &cgroups, t0, &mut before, t0).oom_kills, Some(1));
    // A counter that reads lower than before (a new scope, a reset) is 0, not a wrap.
    let mut higher = Some(9);
    assert_eq!(context_in(&proc_root, &cgroups, t0, &mut higher, t0).oom_kills, Some(0));
    // No reading before: this delta is unknown, and the next death counts from this one.
    let mut unknown = None;
    assert_eq!(context_in(&proc_root, &cgroups, t0, &mut unknown, t0).oom_kills, None);
    assert_eq!(unknown, Some(6));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn an_unreadable_file_gives_null_and_the_rest_is_still_read() {
    let t0 = Instant::now();
    let root = fixture("nomem", None, Some(&format!("0::/{SCOPE}\n")), Some("oom_kill 1\n"));
    let mut before = Some(1);
    assert_eq!(
        context_in(&root.join("proc"), &root.join("cgroup"), t0, &mut before, t0 + Duration::from_secs(59)),
        Context { uptime_min: 0, mem_available_kb: None, oom_kills: Some(0) }
    );
    let _ = std::fs::remove_dir_all(&root);
    let root = fixture("nocount", Some("MemAvailable: 7 kB\n"), Some(&format!("0::/{SCOPE}\n")), None);
    let mut before = Some(1);
    assert_eq!(
        context_in(&root.join("proc"), &root.join("cgroup"), t0, &mut before, t0),
        Context { uptime_min: 0, mem_available_kb: Some(7), oom_kills: None }
    );
    // An unreadable count keeps the last good baseline for the next death.
    assert_eq!(before, Some(1));
    let _ = std::fs::remove_dir_all(&root);
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
