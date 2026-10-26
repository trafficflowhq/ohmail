//! The marker a run leaves, the line the next start writes for it, and the clean exit that leaves none.

use super::*;

fn fresh(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ohmail-unclean-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn a_marker_left_by_the_last_run_is_logged_with_its_age_on_the_next_start() {
    let dir = fresh("left");
    assert_eq!(arm_in(&dir, 4242, SystemTime::now()), None, "a first start has nothing to report");
    // The run that wrote it vanished; the next start comes 25 minutes later.
    let line = arm_in(&dir, 4343, SystemTime::now() + Duration::from_secs(1500))
        .expect("the left marker was not reported");
    let json: serde_json::Value = serde_json::from_str(&line).expect("the line is not JSON");
    assert_eq!(json["service"], "shell");
    assert_eq!(json["event"], "previous_run_ended_unclean");
    let age = json["ageSec"].as_u64().expect("no age");
    assert!((1500..=1502).contains(&age), "age {age}");
    assert_eq!(json["pid"], 4242);
    // No path, so no user name, and nothing else.
    assert!(!line.contains('/') && !line.contains('\\'), "{line}");
    assert_eq!(json.as_object().map(|o| o.len()), Some(4), "{line}");
    // The new run holds the marker now.
    assert_eq!(std::fs::read_to_string(dir.join(MARKER_FILE)).ok().as_deref(), Some("4343\n"));
}

#[test]
fn a_clean_exit_leaves_no_marker_and_the_next_start_reports_nothing() {
    let dir = fresh("clean");
    assert_eq!(arm_in(&dir, 4242, SystemTime::now()), None);
    assert!(dir.join(MARKER_FILE).exists(), "the start wrote no marker");
    clear_in(&dir, 4242);
    assert!(!dir.join(MARKER_FILE).exists(), "the clean exit left its marker");
    assert_eq!(arm_in(&dir, 4343, SystemTime::now()), None);
}

#[test]
fn a_leaving_copy_never_takes_the_marker_of_the_copy_that_replaced_it() {
    let dir = fresh("restart");
    arm_in(&dir, 4343, SystemTime::now());
    clear_in(&dir, 4242);
    assert!(dir.join(MARKER_FILE).exists(), "the old copy removed the new copy's marker");
}

#[test]
fn a_marker_with_no_readable_pid_is_still_reported() {
    let dir = fresh("garbled");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(MARKER_FILE), "").unwrap();
    let line = arm_in(&dir, 4343, SystemTime::now()).expect("an empty marker was not reported");
    let json: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(json["event"], "previous_run_ended_unclean");
    assert!(json.get("pid").is_none(), "{line}");
}

#[cfg(target_os = "linux")]
#[test]
fn a_session_end_signal_quits_through_the_clean_exit_and_leaves_no_marker() {
    let dir = fresh("session-end");
    let pid = std::process::id();
    let context = gtk::glib::MainContext::default();
    let _owner = context.acquire().expect("the default main context is held elsewhere");
    let leaving = dir.clone();
    quit_on_session_end(move || clear_in(&leaving, pid));
    // Logout or shutdown (SIGTERM), then a closed terminal (SIGHUP), each on a running marker.
    for signal in ["-TERM", "-HUP"] {
        arm_in(&dir, pid, SystemTime::now());
        let sent = std::process::Command::new("kill").arg(signal).arg(pid.to_string()).status();
        assert!(sent.map(|s| s.success()).unwrap_or(false), "kill {signal} failed");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while dir.join(MARKER_FILE).exists() && std::time::Instant::now() < deadline {
            context.iteration(false);
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!dir.join(MARKER_FILE).exists(), "{signal} left the marker");
    }
}
