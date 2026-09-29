//! ONE RESTORE, WHICHEVER UNDO RUNS IT. A pairing started from a hosting door stands host mode
//! down; every way it can end short of an acceptance puts back `host.json`, start-at-login and the
//! tailnet route, and names the other computer when a session was left there.

use std::cell::Cell;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use crate::config::{self, HostSnapshot, Undone};
use crate::engine::{self, Shell, ShellPaths};

const PAIRED: &str = "https://192.168.1.24:8443";

fn pairing_door() -> serde_json::Value {
    serde_json::json!({ "mode": "cloud", "flavor": "desktop-host", "cloudUrl": PAIRED, "hostPin": "a".repeat(43) })
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ohmail-pairing-undo-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch root");
    dir
}

fn bytes_under(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(bytes) = fs::read(&path) {
                out.push((path, bytes));
            }
        }
    }
    out.sort();
    out
}

/// A local door that is hosting, beside a frozen hosted copy, and the snapshot a switch takes.
fn hosting(name: &str, autostart: Option<bool>) -> (PathBuf, HostSnapshot) {
    let root = scratch(name);
    let door = config::Config::Local(config::LocalDoor {
        imap_host: "imap.example.test".into(),
        imap_user: "reader".into(),
        imap_port: 993,
        imap_secure: true,
        smtp: None,
        address: Some("reader@example.test".into()),
        pending: false,
    });
    config::write(&root.join(config::CONFIG_FILE_NAME), &door).expect("door");
    fs::create_dir_all(root.join("engine-local/pgdata")).expect("local store");
    fs::write(root.join("engine-local/pgdata/PG_VERSION"), b"17 local").unwrap();
    fs::create_dir_all(root.join("engine-cloud")).expect("frozen copy");
    fs::write(root.join("engine-cloud/mirror-owner"), b"frozen").unwrap();
    let path = root.join(config::HOST_FILE_NAME);
    config::write_host(&path, &config::HostSettings { enabled: true, port: 3311, lan: None, published: None })
        .expect("host.json");
    let snapshot = HostSnapshot { file: fs::read_to_string(&path).unwrap(), autostart };
    (root, snapshot)
}

fn stand_down_on_disk(root: &Path) {
    let off = config::HostSettings { enabled: false, port: 3311, lan: None, published: Some(3311) };
    config::write_host(&root.join(config::HOST_FILE_NAME), &off).expect("stood down");
}

fn paths_of(root: &Path) -> ShellPaths {
    ShellPaths { app_data: Some(root.to_path_buf()), resources: None, downloads: None }
}

fn with_key() {
    std::env::set_var(engine::KEK_VAR, "0".repeat(64));
}

#[test]
fn a_kill_after_the_stand_down_finds_the_record_and_the_launch_registers_start_at_login() {
    // The configure's own order, killed right after the stand-down: nothing past it runs.
    let (root, snapshot) = hosting("prefix-kill", Some(true));
    let before = bytes_under(&root);
    let next = config::parse(&pairing_door()).unwrap();
    let path = root.join(config::CONFIG_FILE_NAME);
    let killed = Cell::new(false);
    let ran = engine::switch_in_order(
        || if killed.get() { Err("killed".to_string()) } else { engine::stage_on_disk(&root, &path, &next, Some(&snapshot)) },
        || {
            stand_down_on_disk(&root);
            killed.set(true);
        },
        |_staged| if killed.get() { Err::<(), String>("killed".into()) } else { Ok(()) },
    );
    assert_eq!(ran, Err("killed".to_string()));

    let undone = engine::recover_door_switch(&paths_of(&root));
    assert_eq!(bytes_under(&root), before, "host.json did not come back after a kill past the stand-down");
    assert_eq!(undone.host.as_ref().and_then(|h| h.autostart), Some(true), "{undone:?}");

    let enables = Cell::new(0);
    let said = crate::host::complete_launch_undo_with(true, &undone, &|| { enables.set(enables.get() + 1); Ok(()) }, &|| {});
    assert_eq!((said, enables.get()), (Some(true), 1), "the launch did not register start-at-login again");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_completion_registers_start_at_login_only_where_it_was_on_and_only_on_an_armed_boot() {
    let snap = |autostart| HostSnapshot { file: "{}".into(), autostart };
    let cases: [(bool, Option<HostSnapshot>, usize); 5] = [
        (true, Some(snap(Some(true))), 1),
        (true, Some(snap(Some(false))), 0),
        (true, Some(snap(None)), 0),
        (false, Some(snap(Some(true))), 0),
        (true, None, 0),
    ];
    for (armed, host, want) in cases {
        let enables = Cell::new(0);
        let trays = Cell::new(0);
        let undone = Undone { host: host.clone(), session_left_at: None };
        crate::host::complete_launch_undo_with(armed, &undone, &|| { enables.set(enables.get() + 1); Ok(()) }, &|| trays.set(trays.get() + 1));
        assert_eq!(enables.get(), want, "armed={armed} host={host:?}");
    }
    // The live restore takes the same function: a refused enable is its answer, and the tray still stands.
    let trays = Cell::new(0);
    let said = crate::host::after_restore_with(&snap(Some(true)), &|| Err("denied".into()), &|| trays.set(1), "after a refused pairing");
    assert_eq!((said, trays.get()), (Some(false), 1));
}

#[test]
fn a_staged_switch_whose_set_aside_fails_keeps_its_record_for_the_restore() {
    with_key();
    let (root, snapshot) = hosting("set-aside-fails", Some(true));
    let before = bytes_under(&root);
    let shell = Shell::rooted_for_tests(&root);
    let staged = shell.stage_switch(&pairing_door(), Some(snapshot.clone())).expect("staged");
    assert!(staged.is_some(), "a hosting door's pairing staged no record");
    stand_down_on_disk(&root);
    // A directory where the set-aside goes: the rename refuses, after the record exists.
    fs::create_dir_all(root.join("engine-cloud.replaced")).unwrap();
    fs::write(root.join("engine-cloud.replaced/block"), b"x").unwrap();
    let refused = shell.switch_door_staged(&pairing_door(), true, staged, Some(snapshot.clone()));
    assert!(refused.is_err(), "{refused:?}");
    let kept = config::read_switch(&root).expect("readable").expect("the record went with the failure");
    assert_eq!(kept.host, Some(snapshot));

    fs::remove_dir_all(root.join("engine-cloud.replaced")).unwrap();
    let (_status, undone) = shell.restore_switch_undone(None).expect("the restore");
    assert!(undone.host.is_some());
    assert_eq!(bytes_under(&root), before, "the restore after a failed switch did not put host mode back");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_prior_pairing_s_door_goes_back_under_its_record() {
    // A switch over a pending one puts that door back with the record still on disk, so a kill
    // before the new record is written still restores host mode.
    with_key();
    let (root, snapshot) = hosting("over-pending", Some(true));
    let before = bytes_under(&root);
    stand_down_on_disk(&root);
    let shell = Shell::rooted_for_tests(&root);
    shell.switch_door_with(&pairing_door(), true, Some(snapshot.clone())).expect("the first pairing");
    fs::create_dir_all(root.join("engine-cloud/pgdata")).unwrap();
    let prior = config::read_switch(&root).unwrap().expect("a record");
    let clear = || fs::remove_dir_all(config::candidate_data_dir(&root)).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }).map_err(|e| e.to_string());
    config::undo_door(&root, &root.join(config::CONFIG_FILE_NAME), &prior, &clear).expect("the door back");
    assert_eq!(config::read_switch(&root).unwrap(), Some(prior), "the record went with the door");
    drop(shell);
    engine::recover_door_switch(&paths_of(&root));
    assert_eq!(bytes_under(&root), before);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn an_undo_names_the_computer_only_when_it_discards_a_session_sealed_there() {
    with_key();
    // Killed after the redeem sealed a session in the pairing's own directory: named.
    let (root, snapshot) = hosting("left-at", Some(true));
    stand_down_on_disk(&root);
    {
        let shell = Shell::rooted_for_tests(&root);
        shell.switch_door_with(&pairing_door(), true, Some(snapshot.clone())).expect("the pairing");
        fs::create_dir_all(root.join("engine-cloud")).unwrap();
        fs::write(root.join("engine-cloud").join(config::CLOUD_SESSION_SEAL), b"sealed").unwrap();
    }
    assert_eq!(engine::recover_door_switch(&paths_of(&root)).session_left_at.as_deref(), Some(PAIRED));
    let _ = fs::remove_dir_all(&root);

    // The same kill with nothing sealed: nothing to say.
    let (root, snapshot) = hosting("left-at-none", Some(true));
    stand_down_on_disk(&root);
    Shell::rooted_for_tests(&root).switch_door_with(&pairing_door(), true, Some(snapshot)).expect("the pairing");
    assert_eq!(engine::recover_door_switch(&paths_of(&root)).session_left_at, None);
    let _ = fs::remove_dir_all(&root);

    // Killed before the directory was set aside, over the hosted door's own sealed session: that
    // session is the replaced door's, it stays, and nothing is named.
    let root = scratch("left-at-own");
    let hosted = serde_json::json!({ "mode": "cloud", "cloudUrl": "https://api.ohmail.app", "address": "reader@example.test" });
    config::write(&root.join(config::CONFIG_FILE_NAME), &config::parse(&hosted).unwrap()).unwrap();
    fs::create_dir_all(root.join("engine-cloud")).unwrap();
    fs::write(root.join("engine-cloud").join(config::CLOUD_SESSION_SEAL), b"the hosted session").unwrap();
    let before = bytes_under(&root);
    let next = config::parse(&pairing_door()).unwrap();
    engine::stage_on_disk(&root, &root.join(config::CONFIG_FILE_NAME), &next, None).expect("staged");
    assert_eq!(engine::recover_door_switch(&paths_of(&root)).session_left_at, None);
    assert_eq!(bytes_under(&root), before, "the hosted door's own session moved");
    let _ = fs::remove_dir_all(&root);

    // A restore cut short after the hosted directory went back and before its door did: the
    // pairing's door is on disk over the hosted session, which is not the pairing's, so nothing is named.
    let root = scratch("left-at-cut");
    config::write(&root.join(config::CONFIG_FILE_NAME), &config::parse(&hosted).unwrap()).unwrap();
    fs::create_dir_all(root.join("engine-cloud")).unwrap();
    fs::write(root.join("engine-cloud").join(config::CLOUD_SESSION_SEAL), b"the hosted session").unwrap();
    let before = bytes_under(&root);
    Shell::rooted_for_tests(&root).switch_door_with(&pairing_door(), true, None).expect("the pairing");
    fs::create_dir_all(root.join("engine-cloud/pgdata")).unwrap();
    fs::remove_dir_all(root.join("engine-cloud")).unwrap();
    fs::rename(root.join("engine-cloud.replaced"), root.join("engine-cloud")).unwrap();
    assert_eq!(engine::recover_door_switch(&paths_of(&root)).session_left_at, None);
    assert_eq!(bytes_under(&root), before);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_status_carries_the_computer_a_restore_was_told_of_and_nothing_else() {
    with_key();
    let root = scratch("left-status");
    let shell = Shell::rooted_for_tests(&root);
    shell.restore_switch_undone(Some("not an address".into())).expect("a restore with nothing pending");
    assert!(shell.status().get("pairingLeftAt").is_none(), "{}", shell.status());
    shell.restore_switch_undone(Some(PAIRED.into())).expect("a restore with nothing pending");
    assert_eq!(shell.status()["pairingLeftAt"], serde_json::Value::String(PAIRED.into()));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_restore_during_the_stand_down_waits_for_the_switch_and_undoes_it_whole() {
    // A reloaded window's first read restores a pending switch; one landing while the stand-down
    // withdraws the tailnet route must find no half-taken switch.
    with_key();
    let (root, snapshot) = hosting("restore-mid-stand-down", Some(true));
    let before = bytes_under(&root);
    let shell = Arc::new(Shell::rooted_for_tests(&root));
    let (tx, rx) = mpsc::channel();
    let early = Mutex::new(None);
    let ran = shell.switch_away_with(&pairing_door(), true, Some(snapshot), || {
        let other = Arc::clone(&shell);
        let tx = tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(other.restore_switch_undone(None).map(|(_, undone)| undone.host.is_some()));
        });
        *early.lock().unwrap() = rx.recv_timeout(Duration::from_millis(1_500)).ok();
        stand_down_on_disk(&root);
    });
    let early = early.lock().unwrap().take();
    let hosting_on = config::read_host(&root.join(config::HOST_FILE_NAME)).is_some_and(|h| h.enabled);
    let record = config::switch_path(&root).exists();
    assert!(
        early.is_none(),
        "a restore ran inside the switch: {early:?}; the switch said {ran:?}; host.json on={hosting_on}, record={record}",
    );
    assert!(ran.is_ok(), "{ran:?}");
    assert_eq!(rx.recv_timeout(Duration::from_secs(20)).expect("the restore answered"), Ok(true));
    assert_eq!(bytes_under(&root), before, "host mode was not back after a restore during the stand-down");
    let _ = fs::remove_dir_all(&root);
}
