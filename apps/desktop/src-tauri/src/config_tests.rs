//! WHICH DOOR, AND THE ONE COMPOSITION THAT MUST NOT BE GOT WRONG.
//!
//! Read `config.rs`'s header first. The short version of what these tests are for: the engine picks
//! its branch from `OHMAIL_MODE`, its DEFAULT branch is the local organizer, and a cloud door
//! spawned without that variable would run the organizer against whatever mailbox the environment
//! happens to name — a second organizer on an account the hosted worker already holds.
//!
//! {@link cloud_mode_is_composed_for_a_cloud_door} is the test that exists for exactly that.
//! Delete the `OHMAIL_MODE` line from `env_for` and it goes red; restore it and it goes green.

use super::*;
use std::collections::HashMap;

fn env_map(pairs: &[(std::ffi::OsString, std::ffi::OsString)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
        .collect()
}

fn local_door() -> Config {
    Config::Local(LocalDoor {
        imap_host: "imap.example.org".to_string(),
        imap_user: "someone@example.org".to_string(),
        imap_port: 993,
        imap_secure: true,
        smtp: Some(Smtp { host: "smtp.example.org".to_string(), port: 587, secure: false }),
        address: None,
    })
}

fn cloud_door() -> Config {
    Config::Cloud(CloudDoor {
        cloud_url: "https://api.ohmail.app".to_string(),
        address: "someone@ohmail.app".to_string(),
    })
}

// ── The composition ─────────────────────────────────────────────────────────────────────────

#[test]
fn cloud_mode_is_composed_for_a_cloud_door() {
    // THE TEST THIS FILE EXISTS FOR. `OHMAIL_MODE=cloud` is what selects the read-only mirror; its
    // absence selects the LOCAL ORGANIZER, which is the branch that opens a real mailbox. A cloud
    // install that reached it would become a second organizer of an account the hosted worker
    // already holds — the failure the whole dual-mode design is built to make impossible.
    //
    // Watch it fail: remove the `OHMAIL_MODE` push from `config::env_for`'s cloud branch.
    let env = env_map(&env_for(&cloud_door(), Path::new("/data")));
    assert_eq!(
        env.get("OHMAIL_MODE").map(String::as_str),
        Some("cloud"),
        "a cloud door composed no OHMAIL_MODE — this launch would run the LOCAL ORGANIZER"
    );
}

#[test]
fn a_cloud_door_composes_nothing_that_could_open_a_mailbox() {
    // The second half of the same guarantee, stated positively: not one IMAP or SMTP setting is
    // composed for a cloud door, so even an engine that ignored OHMAIL_MODE would have nothing to
    // dial. Two independent locks, because one of them is a single missing line away from useless.
    let env = env_map(&env_for(&cloud_door(), Path::new("/data")));
    let dialable: Vec<&String> = env
        .keys()
        .filter(|k| k.starts_with("OHMAIL_IMAP_") || k.starts_with("OHMAIL_SMTP_"))
        .collect();
    assert!(dialable.is_empty(), "a cloud door composed a mail-server setting: {dialable:?}");
    assert_eq!(env.get("OHMAIL_CLOUD_URL").map(String::as_str), Some("https://api.ohmail.app"));
    assert_eq!(env.get("OHMAIL_MAILBOX_ADDRESS").map(String::as_str), Some("someone@ohmail.app"));
}

#[test]
fn a_local_door_composes_the_mail_server_and_no_mode() {
    let env = env_map(&env_for(&local_door(), Path::new("/data")));
    // No OHMAIL_MODE: the engine's default branch IS the local organizer, and a second spelling of
    // that fact is a second thing that can disagree with it.
    assert_eq!(env.get("OHMAIL_MODE"), None);
    assert_eq!(env.get("OHMAIL_IMAP_HOST").map(String::as_str), Some("imap.example.org"));
    assert_eq!(env.get("OHMAIL_IMAP_USER").map(String::as_str), Some("someone@example.org"));
    assert_eq!(env.get("OHMAIL_IMAP_PORT").map(String::as_str), Some("993"));
    assert_eq!(env.get("OHMAIL_IMAP_SECURE").map(String::as_str), Some("1"));
    // 587 STARTTLS is spelled "0" exactly, which is the only value the engine reads as insecure.
    assert_eq!(env.get("OHMAIL_SMTP_HOST").map(String::as_str), Some("smtp.example.org"));
    assert_eq!(env.get("OHMAIL_SMTP_SECURE").map(String::as_str), Some("0"));
}

#[test]
fn the_password_is_never_composed_by_either_door() {
    // The engine seals it; the shell never holds it. A composition that carried one would put a
    // live credential in process state for the life of the engine, which is what sealing removed.
    for config in [local_door(), cloud_door()] {
        let env = env_map(&env_for(&config, Path::new("/data")));
        assert!(!env.contains_key("OHMAIL_IMAP_PASS"), "a password was composed for {config:?}");
        assert!(!env.contains_key("OHMAIL_CLOUD_ACCESS_TOKEN"));
        assert!(!env.contains_key("OHMAIL_CLOUD_REFRESH_TOKEN"));
    }
}

#[test]
fn the_two_doors_never_share_a_data_directory() {
    let root = Path::new("/data");
    let local = env_map(&env_for(&local_door(), root));
    let cloud = env_map(&env_for(&cloud_door(), root));
    let l = local.get("OHMAIL_DATA_DIR").expect("a local data directory");
    let c = cloud.get("OHMAIL_DATA_DIR").expect("a cloud data directory");
    assert_ne!(l, c, "a door switch would put both engines' mirrors in one directory");
    assert!(l.ends_with("engine-local"), "{l}");
    assert!(c.ends_with("engine-cloud"), "{c}");
    assert_eq!(data_dir(root, Mode::Cloud), root.join("engine-cloud"));
}

#[test]
fn only_the_cloud_door_clears_the_inherited_mail_server_settings() {
    let cleared: Vec<String> =
        unset_for(&cloud_door()).iter().map(|v| v.to_string_lossy().into_owned()).collect();
    // Every name the engine's own refusal looks at. One left off is one that reaches the child and
    // makes the engine refuse to start — a working install turned into a puzzling failure.
    for name in ["OHMAIL_IMAP_HOST", "OHMAIL_IMAP_USER", "OHMAIL_IMAP_PORT", "OHMAIL_IMAP_SECURE", "OHMAIL_IMAP_PASS"] {
        assert!(cleared.iter().any(|c| c == name), "{name} is not cleared for a cloud door");
    }
    // The local door clears nothing: inheritance is how a developer configures it by hand.
    assert!(unset_for(&local_door()).is_empty());
}

// ── Reading what the window sent ────────────────────────────────────────────────────────────

#[test]
fn a_configuration_carrying_a_secret_is_refused_rather_than_stored() {
    // The shell writes this file in plain text under the user's home. The refusal is what keeps
    // "nothing secret is in it" true by construction rather than by everybody remembering — and it
    // is a refusal and not a silent drop, because a caller that believed it had stored a password
    // would produce a mailbox that never connects with nothing anywhere saying why.
    for payload in [
        serde_json::json!({ "mode": "local", "host": "h", "user": "u", "password": "hunter2" }),
        serde_json::json!({ "mode": "local", "imap": { "host": "h", "user": "u", "pass": "hunter2" } }),
        serde_json::json!({ "mode": "cloud", "cloudUrl": "https://c", "address": "a@b", "accessToken": "t" }),
        serde_json::json!({ "mode": "cloud", "cloudUrl": "https://c", "address": "a@b", "kek": "00" }),
        serde_json::json!({ "mode": "local", "host": "h", "user": "u", "smtp": { "host": "s", "authSecret": "x" } }),
    ] {
        let err = parse(&payload).expect_err(&format!("a secret was accepted: {payload}"));
        assert!(err.contains("sealed"), "the refusal does not say where secrets go: {err}");
    }
}

#[test]
fn a_local_door_needs_a_server_and_a_username_and_nothing_else() {
    let parsed = parse(&serde_json::json!({ "mode": "local", "host": "imap.h", "user": "u@h" }))
        .expect("a minimal local door");
    match parsed {
        Config::Local(l) => {
            assert_eq!(l.imap_host, "imap.h");
            assert_eq!(l.imap_user, "u@h");
            assert_eq!(l.imap_port, 993, "the default is implicit TLS on 993");
            assert!(l.imap_secure);
            assert!(l.smtp.is_none(), "an unconfigured send server is absent, not invented");
        }
        other => panic!("{other:?}"),
    }
    assert!(parse(&serde_json::json!({ "mode": "local", "user": "u@h" })).is_err());
    assert!(parse(&serde_json::json!({ "mode": "local", "host": "imap.h" })).is_err());
}

#[test]
fn a_cloud_door_needs_the_service_and_the_address() {
    let parsed = parse(&serde_json::json!({
        "mode": "cloud", "cloudUrl": "https://api.ohmail.app", "address": "a@ohmail.app",
    }))
    .expect("a cloud door");
    assert_eq!(parsed.mode(), Mode::Cloud);
    assert_eq!(parsed.address(), Some("a@ohmail.app"));
    assert!(parse(&serde_json::json!({ "mode": "cloud", "address": "a@b" })).is_err());
    assert!(parse(&serde_json::json!({ "mode": "cloud", "cloudUrl": "https://c" })).is_err());
}

#[test]
fn a_mode_this_app_does_not_have_is_named_rather_than_guessed() {
    let err = parse(&serde_json::json!({ "mode": "hybrid" })).expect_err("a third door");
    assert!(err.contains("hybrid"), "{err}");
    assert!(parse(&serde_json::json!({ "host": "h", "user": "u" })).is_err(), "no mode at all");
    assert!(parse(&serde_json::json!("local")).is_err(), "not an object");
}

#[test]
fn a_port_outside_the_range_is_refused_rather_than_truncated() {
    // 65536 truncated to a u16 is 0, and 0 is a port the engine would dial. Refusing says what is
    // wrong while somebody is still looking at the field they typed it into.
    assert!(parse(&serde_json::json!({ "mode": "local", "host": "h", "user": "u", "port": 65536 })).is_err());
    assert!(parse(&serde_json::json!({ "mode": "local", "host": "h", "user": "u", "port": 0 })).is_err());
    // A port that arrived as a string still parses: an HTML number input hands over a string.
    match parse(&serde_json::json!({ "mode": "local", "host": "h", "user": "u", "port": "143" })) {
        Ok(Config::Local(l)) => assert_eq!(l.imap_port, 143),
        other => panic!("{other:?}"),
    }
}

// ── The file ────────────────────────────────────────────────────────────────────────────────

#[test]
fn what_is_written_is_what_comes_back() {
    let dir = std::env::temp_dir().join(format!("ohmail-config-test-{}", std::process::id()));
    let path = dir.join(CONFIG_FILE_NAME);
    let _ = fs::remove_dir_all(&dir);

    // Absent is None and not an error: a fresh install has no file, and that is the state that
    // sends the window to the door picker.
    assert_eq!(read(&path), None);

    for config in [local_door(), cloud_door()] {
        write(&path, &config).expect("write");
        assert_eq!(read(&path).as_ref(), Some(&config));
        // And it round-trips through the wire shape the window sends, so the file a person edits
        // by hand and the object the command takes are the same thing.
        assert_eq!(parse(&to_json(&config)).as_ref(), Ok(&config));
    }

    // A corrupt file reads as "not configured" rather than as a refusal to start: the recovery is
    // identical either way, and an app that will not open is the worse of the two.
    fs::write(&path, "{ this is not json").expect("write");
    assert_eq!(read(&path), None);

    remove(&path).expect("remove");
    assert!(!path.exists());
    remove(&path).expect("removing an absent file is not an error");
    let _ = fs::remove_dir_all(&dir);
}

/// THE SETTINGS FILE IS REPLACED, NEVER TRUNCATED IN PLACE — asserted on the INODE.
///
/// This is the whole reason {@link write_private} exists. `fs::write` opens the target `O_TRUNC`,
/// so for the width of that write the file is empty or half-written — and {@link read} correctly
/// reads an unparseable file as `None`, which is an install that has forgotten which door it came
/// in by while its mailbox and sealed credential sit intact behind it. The local door writes this
/// file TWICE now (the engine has to be replaced once the password is sealed), so the window is
/// entered twice per first connect.
///
/// ── WHY THE INODE AND NOT A FORCED FAILURE ──────────────────────────────────────────────────
///
/// The first version of this test forced a failure by occupying the staging path with a
/// directory. That could only work while the staging name was PREDICTABLE, and the fixed staging
/// name turned out to be a defect of its own — two `#[tauri::command(async)]` configures share
/// it, and one can rename the other's emptied inode over the live file. Making the name unique
/// per call fixed that and took the test's grip with it.
///
/// The inode is the better assertion anyway, because it names the property directly rather than
/// a symptom of it: replacing a file by rename gives the path a NEW inode; truncating it in
/// place keeps the old one. No failure has to be injected, nothing depends on the staging name,
/// and it holds for any user including root — where a permissions-based forcing would have
/// silently stopped being a test.
///
/// **Watched red against `fs::write`:** the inode is unchanged and the assertion names it.
#[cfg(unix)]
#[test]
fn the_settings_file_is_replaced_rather_than_truncated_in_place() {
    use std::os::unix::fs::MetadataExt;

    let dir = std::env::temp_dir().join(format!("ohmail-config-atomic-{}", std::process::id()));
    let path = dir.join(CONFIG_FILE_NAME);
    let _ = fs::remove_dir_all(&dir);

    let first = local_door();
    write(&path, &first).expect("write");
    assert_eq!(read(&path).as_ref(), Some(&first));
    let before = fs::metadata(&path).expect("stat").ino();

    let second = cloud_door();
    write(&path, &second).expect("write");
    assert_eq!(read(&path).as_ref(), Some(&second), "the new configuration must be readable");
    let after = fs::metadata(&path).expect("stat").ino();

    assert_ne!(
        before, after,
        "the settings file kept its inode across a write, so it was truncated in place rather \
         than replaced — the window this function exists to close is open again"
    );

    // The host-mode file carries the identical hazard — an unreadable file there reads as "host
    // mode off", which silently un-publishes a running install — and the identical fix.
    let host_path = dir.join(HOST_FILE_NAME);
    write_host(&host_path, &HostSettings { enabled: true, port: 3311, lan: None }).expect("write");
    let host_before = fs::metadata(&host_path).expect("stat").ino();
    write_host(&host_path, &HostSettings { enabled: false, port: 3311, lan: None }).expect("write");
    assert_ne!(
        host_before,
        fs::metadata(&host_path).expect("stat").ino(),
        "the host-mode file was truncated in place rather than replaced"
    );

    let _ = fs::remove_dir_all(&dir);
}

/// TWO WRITES NEVER SHARE A STAGING NAME, which is the whole of the concurrency fix.
///
/// The first version of {@link write_private} used a constant `.tmp`, on the stated reasoning
/// that these writes are serialized. They are not: `engine_configure` and the host-mode commands
/// are `#[tauri::command(async)]` and nothing takes a writer lock, so two can be in flight at
/// once. Sharing one staging name is worse than the truncating write it replaced — A fills its
/// staging file, B opens the SAME path `O_TRUNC` and empties it, A renames B's empty inode over
/// the live settings file, and an empty configuration is published by a write that reported
/// success.
///
/// This is a one-line assertion for a defect that a concurrency test could only reach by luck.
#[test]
fn two_writes_never_share_a_staging_name() {
    let path = std::env::temp_dir().join(CONFIG_FILE_NAME);
    let first = staging_path(&path);
    let second = staging_path(&path);
    assert_ne!(
        first, second,
        "two overlapping writes would stage into the same file and publish each other's bytes"
    );
    // And a staging file is never the target itself.
    assert_ne!(first, path);
    assert_eq!(first.parent(), path.parent(), "staging must be in the target's own directory");
}

/// A WRITE LEAVES NO STAGING FILE BEHIND — not on the way through, and not per call.
///
/// The staging name is unique per call now, so nothing reuses it: litter here would accumulate
/// for the life of the install rather than being overwritten by the next write. This walks the
/// directory after several writes and asserts the settings files are the ONLY things in it.
#[test]
fn writing_repeatedly_leaves_only_the_files_it_owns() {
    let dir = std::env::temp_dir().join(format!("ohmail-config-litter-{}", std::process::id()));
    let path = dir.join(CONFIG_FILE_NAME);
    let host_path = dir.join(HOST_FILE_NAME);
    let _ = fs::remove_dir_all(&dir);

    for _ in 0..5 {
        write(&path, &local_door()).expect("write");
        write(&path, &cloud_door()).expect("write");
        write_host(&host_path, &HostSettings { enabled: true, port: 3311, lan: None })
            .expect("write");
    }

    let mut left: Vec<String> = fs::read_dir(&dir)
        .expect("read_dir")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    let mut expected = vec![CONFIG_FILE_NAME.to_string(), HOST_FILE_NAME.to_string()];
    expected.sort();
    assert_eq!(left, expected, "a staging file survived a successful write");

    let _ = fs::remove_dir_all(&dir);
}

// ── The host-mode file ──────────────────────────────────────────────────────────────────────

#[test]
fn the_host_setting_round_trips_and_everything_broken_reads_as_disabled() {
    let dir = std::env::temp_dir().join(format!("ohmail-host-config-test-{}", std::process::id()));
    let path = dir.join(HOST_FILE_NAME);
    let _ = fs::remove_dir_all(&dir);

    // Absent is None: the safe branch, which is every install that never turned host mode on.
    assert_eq!(read_host(&path), None);

    for settings in [
        HostSettings { enabled: true, port: 3311, lan: None },
        // Disabled keeps its port, so re-arming can offer the same one back.
        HostSettings { enabled: false, port: 3311, lan: None },
        HostSettings { enabled: true, port: 65535, lan: None },
    ] {
        write_host(&path, &settings).expect("write");
        assert_eq!(read_host(&path), Some(settings));
    }

    // THE DANGEROUS BRANCH NEEDS A WELL-FORMED `true`. A corrupt byte, a wrong type, a missing
    // field — none of them may select a network-published engine.
    for broken in [
        "{ not json",
        r#"{ "enabled": "true", "port": 3311 }"#, // a string is not the boolean true
        r#"{ "enabled": true }"#,                 // no port: nothing to bind, nothing to serve
        r#"{ "enabled": true, "port": 0 }"#,      // port 0 is "any", and the registration needs ONE
        r#"{ "enabled": true, "port": 70000 }"#,  // not a port
        r#"{ "enabled": true, "port": "3311" }"#, // hand-edited as a string: refused, not repaired
        "[]",
    ] {
        fs::write(&path, broken).expect("write");
        assert_eq!(read_host(&path), None, "{broken} was read as a setting");
    }

    // ── The LAN choice ───────────────────────────────────────────────────────────────────
    // Round-trips verbatim; an older file (no `lan` key) reads as OFF; null and empty read as
    // OFF; a wrong TYPE refuses the whole file, same rule as `enabled` — a hand-edited value
    // this cannot read must not be half-honoured.
    let with_lan = HostSettings {
        enabled: true,
        port: 3311,
        lan: Some("192.168.1.23".to_string()),
    };
    write_host(&path, &with_lan).expect("write");
    assert_eq!(read_host(&path), Some(with_lan));
    fs::write(&path, r#"{ "enabled": true, "port": 3311 }"#).expect("write");
    assert_eq!(
        read_host(&path),
        Some(HostSettings { enabled: true, port: 3311, lan: None }),
        "a file from before the LAN option must read with the LAN half off"
    );
    fs::write(&path, r#"{ "enabled": true, "port": 3311, "lan": null }"#).expect("write");
    assert_eq!(read_host(&path).and_then(|s| s.lan), None);
    fs::write(&path, r#"{ "enabled": true, "port": 3311, "lan": "  " }"#).expect("write");
    assert_eq!(read_host(&path).and_then(|s| s.lan), None);
    fs::write(&path, r#"{ "enabled": true, "port": 3311, "lan": 42 }"#).expect("write");
    assert_eq!(read_host(&path), None, "a mistyped lan value must refuse the whole file");

    // Private at rest, like the door file: which port an install publishes on is nobody else's
    // business on a shared machine.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        write_host(&path, &HostSettings { enabled: true, port: 3311, lan: None }).expect("write");
        let mode = fs::metadata(&path).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let _ = fs::remove_dir_all(&dir);
}
