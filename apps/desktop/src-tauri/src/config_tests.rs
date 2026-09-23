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
        address: Some("someone@ohmail.app".to_string()),
        flavor: None,
        host_pin: None,
        identity_pending: false,
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
fn every_door_hands_the_engine_the_commit_this_shell_was_built_from() {
    // ── DESKTOP-ENGINE-CANNOT-REPORT-ITS-BUILD-SHA-WITHOUT-THE-RUST-SHELL ────────────────────
    //
    // The download is one artifact with two halves and only the window could name its commit.
    // With this pair the engine publishes the same value at `/health`, so the shipped shell and
    // the shipped engine can be compared with each other instead of taken on trust.
    //
    // Watch it fail: remove the push from `env_for_door` and both doors compose no commit.
    for config in [local_door(), cloud_door()] {
        let env = env_map(&env_for(&config, Path::new("/data")));
        let commit = env
            .get(crate::engine::BUILD_COMMIT_VAR)
            .unwrap_or_else(|| panic!("no build commit was composed for {config:?}"));
        // 40 hex from a stamped build, `unknown` from a tree that could not know — and NEVER
        // empty, which is the one answer that would read as "this key is not in use".
        assert!(
            commit == "unknown"
                || (commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit())),
            "the composed build commit is neither a commit nor `unknown`: {commit:?}"
        );
    }
    // The candidate walk's composition carries it too — a candidate engine is the same build.
    let dir = std::env::temp_dir().join(format!("ohmail-build-commit-{}", std::process::id()));
    let env = env_map(&env_for_in(&cloud_door(), &dir, &candidate_data_dir(&dir)).expect("composed"));
    assert!(env.contains_key(crate::engine::BUILD_COMMIT_VAR));
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

// ── The pending door: the browser approval's first boot, with no address ────────────────────

#[test]
fn the_pending_door_composes_a_flag_and_its_door_file_and_no_address() {
    let door = parse(&serde_json::json!({
        "mode": "cloud", "cloudUrl": "https://api.ohmail.app", "identityPending": true,
    }))
    .expect("the pending door");
    assert!(door.is_identity_pending());
    assert_eq!(door.address(), None);
    let root = Path::new("/data");
    let env = env_map(&env_for(&door, root));
    assert_eq!(env.get("OHMAIL_MODE").map(String::as_str), Some("cloud"));
    assert_eq!(env.get(IDENTITY_PENDING_VAR).map(String::as_str), Some("1"));
    let expected = root.join(CONFIG_FILE_NAME).to_string_lossy().into_owned();
    assert_eq!(env.get(DOOR_FILE_VAR), Some(&expected));
    assert!(!env.contains_key("OHMAIL_MAILBOX_ADDRESS"), "an empty address reached the engine");
    // Round trip, so a hand-written pending file reads as the same door.
    assert_eq!(parse(&to_json(&door)).expect("round trip"), door);
    // And an ordinary hosted door composes neither half.
    let hosted = env_map(&env_for(&cloud_door(), root));
    assert!(!hosted.contains_key(IDENTITY_PENDING_VAR) && !hosted.contains_key(DOOR_FILE_VAR));
}

#[test]
fn the_pending_door_is_the_exact_boolean_and_carries_nothing_a_claim_decides() {
    for near_miss in [serde_json::json!("true"), serde_json::json!(1), serde_json::json!(false)] {
        let refused = parse(&serde_json::json!({
            "mode": "cloud", "cloudUrl": "https://api.ohmail.app", "identityPending": near_miss,
        }))
        .expect_err("a near-miss is not the pending door");
        assert!(refused.contains("needs the mailbox address"), "{refused}");
    }
    for extra in [
        serde_json::json!({ "address": "someone@ohmail.app" }),
        serde_json::json!({ "flavor": "desktop-host", "hostPin": "A2Z_abcdefghijklmnopqrstuvwxyz0123456789-xyz" }),
    ] {
        let mut value = serde_json::json!({
            "mode": "cloud", "cloudUrl": "https://api.ohmail.app", "identityPending": true,
        });
        for (k, v) in extra.as_object().unwrap() {
            value[k] = v.clone();
        }
        let refused = parse(&value).expect_err("a pending door naming what its claim decides");
        assert!(refused.contains("waiting for its account"), "{refused}");
    }
}

#[test]
fn only_ohmail_cloud_is_set_up_by_a_browser_with_no_address() {
    let refused = parse(&serde_json::json!({
        "mode": "cloud", "cloudUrl": "https://ohmail.example.com/api", "identityPending": true,
    }))
    .expect_err("a pending door on somebody's own server can never be completed");
    assert!(refused.contains("only ohmail Cloud"), "{refused}");
}

#[test]
fn every_cloud_door_clears_the_inherited_door_facts_it_composes_itself() {
    // Removed first and composed after (`supervise`), so each door keeps exactly its own: a
    // developer's exported address cannot give the pending door an owner.
    let cleared: Vec<String> =
        unset_for(&cloud_door()).iter().map(|v| v.to_string_lossy().into_owned()).collect();
    for name in ["OHMAIL_MAILBOX_ADDRESS", "OHMAIL_HOST_PIN", IDENTITY_PENDING_VAR, DOOR_FILE_VAR] {
        assert!(cleared.iter().any(|c| c == name), "{name} is not cleared for a cloud door");
    }
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

/// THE FOURTH DOOR — another computer's desktop, which is a cloud door with two differences.
///
/// A pairing link names a COMPUTER, not a mailbox, so this is the one cloud door that may carry no
/// address: which mailbox the install ends up reading is the host's answer to the redeem, and it is
/// not known by anyone at the moment the door is written. And its address is one no certificate
/// authority can vouch for, so the door carries the fingerprint the link brought instead.
#[test]
fn a_desktop_host_door_carries_a_fingerprint_and_may_carry_no_address() {
    let parsed = parse(&serde_json::json!({
        "mode": "cloud",
        "cloudUrl": "https://desk.tail1234.ts.net",
        "flavor": "desktop-host",
        "hostPin": "A2Z_abcdefghijklmnopqrstuvwxyz0123456789-xyz",
    }))
    .expect("a paired-desktop door");
    assert_eq!(parsed.mode(), Mode::Cloud);
    assert!(parsed.is_desktop_host());
    // NOTHING RATHER THAN A PLACEHOLDER. A hostname in a field that says "your mailbox" is a false
    // state, and this door's label comes from its address bar rather than from here.
    assert_eq!(parsed.address(), None);
}

#[test]
fn the_flavor_and_the_fingerprint_are_one_fact_in_both_directions() {
    // A desktop-host door with no pin cannot authenticate what answers at its address at all.
    let no_pin = parse(&serde_json::json!({
        "mode": "cloud", "cloudUrl": "https://desk.example", "flavor": "desktop-host",
    }))
    .expect_err("a paired door with no identity");
    assert!(no_pin.contains("identity"), "{no_pin}");

    // And a pin on any other door is a value nothing reads — worse than useless, because a later
    // reader takes it for protection that is in force.
    let stray = parse(&serde_json::json!({
        "mode": "cloud", "cloudUrl": "https://api.ohmail.app", "address": "a@ohmail.app",
        "hostPin": "A2Z_abcdefghijklmnopqrstuvwxyz0123456789-xyz",
    }))
    .expect_err("a fingerprint on a door that cannot use one");
    assert!(stray.contains("another computer"), "{stray}");
}

#[test]
fn only_the_paired_door_may_omit_the_address() {
    // The hosted and self-hosted doors are entered by naming a mailbox. An absent address there is
    // a mirror belonging to nobody, and it stays refused.
    let hosted = parse(&serde_json::json!({
        "mode": "cloud", "cloudUrl": "https://api.ohmail.app",
    }))
    .expect_err("a hosted door with no mailbox");
    assert!(hosted.contains("mailbox address"), "{hosted}");

    // An unrecognised flavor is a cloud door like any other — it must NOT unlock the omission.
    let odd = parse(&serde_json::json!({
        "mode": "cloud", "cloudUrl": "https://api.ohmail.app", "flavor": "something-new",
    }))
    .expect_err("an unknown flavor with no mailbox");
    assert!(odd.contains("mailbox address"), "{odd}");
}

#[test]
fn a_flavor_this_build_has_not_heard_of_still_parses() {
    // The vocabulary's authority is the SERVER's greeting, not this file. A door already written
    // to disk must keep opening after the vocabulary grows, so an unknown flavor degrades to
    // "a cloud door" rather than failing to parse a settings file this app has itself written.
    let parsed = parse(&serde_json::json!({
        "mode": "cloud", "cloudUrl": "https://api.ohmail.app", "address": "a@ohmail.app",
        "flavor": "something-new",
    }))
    .expect("an unfamiliar flavor");
    assert_eq!(parsed.mode(), Mode::Cloud);
    assert!(!parsed.is_desktop_host());
}

#[test]
fn a_door_written_before_the_fourth_one_is_unchanged_through_a_round_trip() {
    // Every existing install is this shape. The three new keys are OMITTED rather than written as
    // null, so a door this build rewrites is byte-identical to what an older build would read.
    let original = serde_json::json!({
        "mode": "cloud", "cloudUrl": "https://api.ohmail.app", "address": "a@ohmail.app",
    });
    let parsed = parse(&original).expect("an existing hosted door");
    assert_eq!(to_json(&parsed), original);
}

#[test]
fn the_paired_door_hands_the_engine_the_fingerprint_and_no_mailbox() {
    let dir = std::path::PathBuf::from("/tmp/ohmail-config-test");
    let door = Config::Cloud(CloudDoor {
        cloud_url: "https://desk.tail1234.ts.net".to_string(),
        address: None,
        flavor: Some("desktop-host".to_string()),
        host_pin: Some("A2Z_abcdefghijklmnopqrstuvwxyz0123456789-xyz".to_string()),
        identity_pending: false,
    });
    let env = env_map(&env_for(&door, &dir));

    // THE SAFETY-CRITICAL LINE IS STILL THERE. A paired door is a cloud door, and an engine
    // spawned without this would run the local organizer against whatever the environment names.
    assert_eq!(env.get("OHMAIL_MODE").map(String::as_str), Some("cloud"));
    assert_eq!(
        env.get("OHMAIL_HOST_PIN").map(String::as_str),
        Some("A2Z_abcdefghijklmnopqrstuvwxyz0123456789-xyz"),
    );
    // OMITTED, not blank: the engine reads an empty value as absent, and a door that named an
    // empty mailbox would be claiming a mirror belongs to "".
    assert!(!env.contains_key("OHMAIL_MAILBOX_ADDRESS"), "{env:?}");
}

#[test]
fn no_other_door_hands_the_engine_a_fingerprint() {
    let dir = std::path::PathBuf::from("/tmp/ohmail-config-test");
    for door in [cloud_door(), self_hosted_door()] {
        let env = env_map(&env_for(&door, &dir));
        assert!(!env.contains_key("OHMAIL_HOST_PIN"), "{env:?}");
        assert!(env.contains_key("OHMAIL_MAILBOX_ADDRESS"), "{env:?}");
    }
}

/// THE FINGERPRINT IS NOT A SECRET, and the secret filter must keep agreeing.
///
/// `refuse_secrets` rejects any key containing "pass", "secret", "token", "credential", "kek" or
/// "auth" — anywhere, at any depth — and it runs BEFORE the door is parsed. `hostPin` clears that
/// filter today by containing none of them, which is correct: the value is a hash of a public key,
/// printed on another machine's screen for somebody to carry across a room. The PAIRING TOKEN is
/// the secret here, and it goes down the bridge and never through a command argument.
///
/// This is pinned because the failure mode is silent and total: add "pin" to that list and every
/// paired door stops parsing, with a message about passwords, on a value that is not one.
#[test]
fn the_pairing_fingerprint_is_not_read_as_a_secret() {
    parse(&serde_json::json!({
        "mode": "cloud",
        "cloudUrl": "https://desk.tail1234.ts.net",
        "flavor": "desktop-host",
        "hostPin": "A2Z_abcdefghijklmnopqrstuvwxyz0123456789-xyz",
    }))
    .expect("a fingerprint must not be mistaken for a credential");

    // The control, so "not refused" is not merely the filter having stopped working: a genuinely
    // secret-shaped key on the same door is still refused.
    let refused = parse(&serde_json::json!({
        "mode": "cloud",
        "cloudUrl": "https://desk.tail1234.ts.net",
        "flavor": "desktop-host",
        "hostPin": "A2Z_abcdefghijklmnopqrstuvwxyz0123456789-xyz",
        "pairToken": "the-single-use-code",
    }))
    .expect_err("a pairing token in the settings file");
    assert!(refused.contains("token"), "{refused}");
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
    write_host(&host_path, &HostSettings { enabled: true, port: 3311, lan: None, published: None }).expect("write");
    let host_before = fs::metadata(&host_path).expect("stat").ino();
    write_host(&host_path, &HostSettings { enabled: false, port: 3311, lan: None, published: None }).expect("write");
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
        write_host(&host_path, &HostSettings { enabled: true, port: 3311, lan: None, published: None })
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
        HostSettings { enabled: true, port: 3311, lan: None, published: None },
        // Disabled keeps its port, so re-arming can offer the same one back.
        HostSettings { enabled: false, port: 3311, lan: None, published: None },
        HostSettings { enabled: true, port: 65535, lan: None, published: None },
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
        published: None,
    };
    write_host(&path, &with_lan).expect("write");
    assert_eq!(read_host(&path), Some(with_lan));
    fs::write(&path, r#"{ "enabled": true, "port": 3311 }"#).expect("write");
    assert_eq!(
        read_host(&path),
        Some(HostSettings { enabled: true, port: 3311, lan: None, published: None }),
        "a file from before the LAN option must read with the LAN half off"
    );
    fs::write(&path, r#"{ "enabled": true, "port": 3311, "lan": null }"#).expect("write");
    assert_eq!(read_host(&path).and_then(|s| s.lan), None);
    fs::write(&path, r#"{ "enabled": true, "port": 3311, "lan": "  " }"#).expect("write");
    assert_eq!(read_host(&path).and_then(|s| s.lan), None);
    fs::write(&path, r#"{ "enabled": true, "port": 3311, "lan": 42 }"#).expect("write");
    assert_eq!(read_host(&path), None, "a mistyped lan value must refuse the whole file");

    // ── The stood-down port ──────────────────────────────────────────────────────────────
    // Same three rules as the LAN choice, for the field that decides whether a disarmed install
    // keeps holding the loopback port a tailnet route may still point at: it round-trips, an
    // older file reads as nothing held, and a value this cannot read refuses the whole file
    // rather than being half-honoured into a bind on some other port.
    let stood_down =
        HostSettings { enabled: false, port: 3311, lan: None, published: Some(3311) };
    write_host(&path, &stood_down).expect("write");
    assert_eq!(read_host(&path), Some(stood_down));
    fs::write(&path, r#"{ "enabled": false, "port": 3311 }"#).expect("write");
    assert_eq!(
        read_host(&path).map(|s| s.published),
        Some(None),
        "a file from before the hold must read as nothing held"
    );
    fs::write(&path, r#"{ "enabled": false, "port": 3311, "published": null }"#).expect("write");
    assert_eq!(read_host(&path).map(|s| s.published), Some(None));
    for broken in [
        r#"{ "enabled": false, "port": 3311, "published": 0 }"#,
        r#"{ "enabled": false, "port": 3311, "published": 70000 }"#,
        r#"{ "enabled": false, "port": 3311, "published": "3311" }"#,
    ] {
        fs::write(&path, broken).expect("write");
        assert_eq!(read_host(&path), None, "{broken} was read as a port to hold");
    }

    // Private at rest, like the door file: which port an install publishes on is nobody else's
    // business on a shared machine.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        write_host(&path, &HostSettings { enabled: true, port: 3311, lan: None, published: None }).expect("write");
        let mode = fs::metadata(&path).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let _ = fs::remove_dir_all(&dir);
}

// ── The operator's own certificate authority ────────────────────────────────────────────────
//
// A person self-hosting on a private name issues their own certificates, and Node does not read
// the operating system's trust store — so without this variable the engine cannot see their
// server at all, whatever they have installed on the machine. See `env_for`.

/// A cloud door pointed at somebody's OWN server — the only door the operator CA belongs to.
fn self_hosted_door() -> Config {
    Config::Cloud(CloudDoor {
        cloud_url: "https://ohmail.example.com/api".to_string(),
        address: Some("someone@example.com".to_string()),
        flavor: None,
        host_pin: None,
        identity_pending: false,
    })
}

#[test]
fn an_operator_ca_reaches_only_the_self_hosted_door() {
    let dir = std::env::temp_dir().join(format!("ohmail-config-ca-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir");

    // ABSENT: nothing is composed anywhere. Node prints a warning for a path that does not exist,
    // on every launch, at every user — so the empty case has to compose nothing at all.
    for config in [local_door(), cloud_door(), self_hosted_door()] {
        let env = env_map(&env_for(&config, &dir));
        assert!(
            !env.contains_key("NODE_EXTRA_CA_CERTS"),
            "a CA path was composed with no file there, for {config:?}"
        );
    }

    let ca = dir.join(OPERATOR_CA_FILE);
    fs::write(&ca, "-----BEGIN CERTIFICATE-----\n").expect("write");

    // PRESENT, AND ONLY ON THE SELF-HOSTED DOOR.
    assert_eq!(
        env_map(&env_for(&self_hosted_door(), &dir))
            .get("NODE_EXTRA_CA_CERTS")
            .map(String::as_str),
        Some(ca.to_string_lossy().as_ref()),
        "the operator's CA did not reach the engine it was installed for"
    );

    // THE TWO DOORS IT MUST NOT REACH, and this is the finding rather than a tidiness rule. The
    // variable widens who may satisfy hostname verification for every connection that engine makes.
    // A file left behind after somebody moves back to the hosted service would let whoever holds
    // that CA key present a certificate for api.ohmail.app and receive the account's bearer and
    // refresh token; on the local door, one for the user's own IMAP and SMTP host, and receive the
    // mailbox password.
    for config in [local_door(), cloud_door()] {
        let env = env_map(&env_for(&config, &dir));
        assert!(
            !env.contains_key("NODE_EXTRA_CA_CERTS"),
            "the operator's CA widened trust for {config:?}, which is not the server it was for"
        );
    }

    // A DIRECTORY of that name is not a certificate file, and must not be composed as one.
    fs::remove_file(&ca).expect("rm");
    fs::create_dir_all(&ca).expect("mkdir");
    assert!(!env_map(&env_for(&self_hosted_door(), &dir)).contains_key("NODE_EXTRA_CA_CERTS"));

    let _ = fs::remove_dir_all(&dir);
}

/// A SECOND self-hosted door, at somebody else's server — the door the authority above may not
/// reach. Both are "not the managed service", which is exactly why a KIND could not tell them apart.
fn another_self_hosted_door() -> Config {
    Config::Cloud(CloudDoor {
        cloud_url: "https://mail.other.example/api".to_string(),
        address: Some("someone@other.example".to_string()),
        flavor: None,
        host_pin: None,
        identity_pending: false,
    })
}

/// A self-hosted door at a given address, for the spellings that name one server.
fn door_at(cloud_url: &str) -> Config {
    Config::Cloud(CloudDoor {
        cloud_url: cloud_url.to_string(),
        address: Some("someone@example.com".to_string()),
        flavor: None,
        host_pin: None,
        identity_pending: false,
    })
}

#[test]
fn an_operator_ca_is_composed_only_for_the_server_it_was_installed_for() {
    // THE FINDING. The scoping above is a KIND — "not the managed service" — so an authority
    // installed for server A was handed to a door at server B, and whoever holds A's key could
    // then issue a certificate for B's name and receive B's bearer traffic. The record beside the
    // file is what turns that kind into a NAME.
    let dir = std::env::temp_dir().join(format!("ohmail-config-ca-id-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir");
    let ca = dir.join(OPERATOR_CA_FILE);
    let record = dir.join(OPERATOR_CA_RECORD_FILE);
    fs::write(&ca, "-----BEGIN CERTIFICATE-----\nthe operator's own root\n").expect("write");

    // THE UPGRADE PATH, MEASURED RATHER THAN ASSUMED: a file installed before this build has no
    // record, and it is ADOPTED ONCE for the door configured at that moment. A working self-host
    // survives the upgrade; an adopt-once that could drop one would be the worse bug.
    assert!(!record.exists(), "the fixture wrote a record the upgrade path must not have");
    assert_eq!(
        env_map(&env_for(&self_hosted_door(), &dir))
            .get("NODE_EXTRA_CA_CERTS")
            .map(String::as_str),
        Some(ca.to_string_lossy().as_ref()),
        "a legacy file was not adopted for the door configured at the first launch after upgrade",
    );
    let written = fs::read_to_string(&record).expect("the adoption wrote no record");
    assert!(written.contains("https://ohmail.example.com"), "the record names no origin: {written}");

    // THE ROW ITSELF: a later door change to another origin gets no authority.
    assert!(
        !env_map(&env_for(&another_self_hosted_door(), &dir)).contains_key("NODE_EXTRA_CA_CERTS"),
        "the authority installed for one server reached a door at another",
    );
    // …and nothing was DROPPED on the way: the file is still there and its own door still gets it.
    assert!(ca.is_file(), "the file was removed rather than withheld");
    assert!(
        env_map(&env_for(&self_hosted_door(), &dir)).contains_key("NODE_EXTRA_CA_CERTS"),
        "the door the authority belongs to lost it",
    );
    assert_eq!(
        fs::read_to_string(&record).expect("record"),
        written,
        "the door that was refused rewrote the record",
    );

    // THE SPELLINGS THAT NAME ONE SERVER keep it: the default port, a folded case, a trailing root
    // dot and a composed `/api` are the same machine, and a record that did not fold them would
    // withhold a working authority over a character somebody retyped.
    for spelling in [
        "https://ohmail.example.com",
        "https://OHMAIL.example.com:443/api",
        "https://ohmail.example.com./api",
        "  https://ohmail.example.com/api/  ",
    ] {
        assert!(
            env_map(&env_for(&door_at(spelling), &dir)).contains_key("NODE_EXTRA_CA_CERTS"),
            "{spelling:?} lost the authority installed for that server",
        );
    }
    // A PORT IS PART OF THE IDENTITY, though it is not part of the trust width: two ports on one
    // machine are two servers to whoever runs them.
    assert!(
        !env_map(&env_for(&door_at("https://ohmail.example.com:8443"), &dir))
            .contains_key("NODE_EXTRA_CA_CERTS"),
        "a door at another port on that host was given the record's authority",
    );

    // A FILE WHOSE BYTES CHANGED is not the file the record was written for, so the record is no
    // longer a statement about it.
    fs::write(&ca, "-----BEGIN CERTIFICATE-----\nsomebody else's root\n").expect("write");
    assert!(
        !env_map(&env_for(&self_hosted_door(), &dir)).contains_key("NODE_EXTRA_CA_CERTS"),
        "a replaced file was composed under the previous file's record",
    );
    // THE REMEDY THE SENTENCE NAMES: remove the RECORD, never the file. The next launch adopts
    // what is there now, for the door in front of it.
    fs::remove_file(&record).expect("rm record");
    assert!(
        env_map(&env_for(&self_hosted_door(), &dir)).contains_key("NODE_EXTRA_CA_CERTS"),
        "removing the record did not re-install the authority for the door in front of it",
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_candidate_walk_never_adopts_the_operator_ca() {
    // A candidate is a question about somebody else's machine rather than a door (see
    // `CANDIDATE_DIR_NAME`), so a walk must not bind this install's authority to the machine it is
    // asking about — the real door chosen afterwards would then be refused an authority nobody
    // withdrew, by a record nobody wrote on purpose.
    let dir = std::env::temp_dir().join(format!("ohmail-config-ca-cand-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir");
    fs::write(dir.join(OPERATOR_CA_FILE), "-----BEGIN CERTIFICATE-----\nroot\n").expect("write");
    let record = dir.join(OPERATOR_CA_RECORD_FILE);
    let candidate = candidate_data_dir(&dir);

    let env = env_map(&env_for_in(&self_hosted_door(), &dir, &candidate).expect("composed"));
    assert!(!env.contains_key("NODE_EXTRA_CA_CERTS"), "a candidate walk adopted the authority");
    assert!(!record.exists(), "a candidate walk wrote a record binding the file to its question");

    // A record the install itself made composes for the candidate like any other launch: what the
    // walk may not do is CREATE one.
    env_for(&self_hosted_door(), &dir);
    assert!(record.exists(), "the door's own launch wrote no record");
    let env = env_map(&env_for_in(&self_hosted_door(), &dir, &candidate).expect("composed"));
    assert!(
        env.contains_key("NODE_EXTRA_CA_CERTS"),
        "a candidate at the recorded origin was refused the authority the install already adopted",
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_managed_base_is_recognised_through_its_harmless_spellings() {
    // A trailing slash, a folded case, the DEFAULT PORT SPELLED OUT and the DNS root dot are all
    // the same address. Reading any of them as self-hosted would hand the operator CA to the door
    // that holds the hosted session — the exact thing the scoping exists to prevent — so the
    // comparison is between ORIGINS and not between strings. `:443` is the one that was live:
    // review 6 found it accepted as somebody's own server.
    let dir = std::env::temp_dir().join(format!("ohmail-config-ca-sp-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir");
    fs::write(dir.join(OPERATOR_CA_FILE), "-----BEGIN CERTIFICATE-----\n").expect("write");

    for spelling in [
        "https://api.ohmail.app",
        "https://api.ohmail.app/",
        "https://API.ohmail.app",
        "  https://api.ohmail.app  ",
        "https://api.ohmail.app:443",
        "https://api.ohmail.app:443/",
        "https://API.ohmail.app:0443",
        "https://api.ohmail.app.",
        "https://api.ohmail.app.:443/",
        // WHAT THE SELF-HOST DOOR COMPOSES. Typing the hosted service's own host into it gives
        // `<origin>/api` (`self-host.ts`'s `selfHostBase`) and nothing there refuses that host —
        // so this spelling is one a person can produce through the window, not by hand.
        "https://api.ohmail.app/api",
        // A PORT CANNOT MAKE A FORGED CERTIFICATE SAFE: it names the host and nothing else.
        "https://api.ohmail.app:8443",
    ] {
        let door = Config::Cloud(CloudDoor {
            cloud_url: spelling.to_string(),
            address: Some("someone@ohmail.app".to_string()),
            flavor: None,
            host_pin: None,
            identity_pending: false,
        });
        assert!(
            !env_map(&env_for(&door, &dir)).contains_key("NODE_EXTRA_CA_CERTS"),
            "{spelling:?} was read as a self-hosted server"
        );
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_hostile_cloud_address_is_refused_before_it_reaches_the_settings_file() {
    // THE TRUST BOUNDARY. `engine_configure` is a command the WINDOW holds, so "the address comes
    // from configuration rather than from a request" is worth nothing on its own — this function is
    // what stands between a value that window chose and a file every later launch reads.
    //
    // `#` is the sharp one: every URL the engine composes is base + path, so a fragment in the base
    // makes the path part of a fragment that is never sent, and `http://h:p#/` + `/hello` goes out
    // as `GET /` at that address.
    for hostile in [
        r#"{ "mode": "cloud", "cloudUrl": "http://127.0.0.1:9000#/", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "https://h.example?x=1", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "https://me:pw@h.example", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "file:///etc/passwd", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "ftp://h.example", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "https://h.example\nhttps://evil.example", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "https://h.example with a space", "address": "a@b.example" }"#,
    ] {
        let value: serde_json::Value = serde_json::from_str(hostile).expect("fixture json");
        assert!(parse(&value).is_err(), "the shell accepted {hostile}");
    }

    // …and the shapes an operator actually types still pass, trimmed.
    for ok in [
        r#"{ "mode": "cloud", "cloudUrl": "https://ohmail.example.com/api", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "http://localhost:8080/api", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "  https://api.ohmail.app  ", "address": "a@b.example" }"#,
    ] {
        let value: serde_json::Value = serde_json::from_str(ok).expect("fixture json");
        let parsed = parse(&value).unwrap_or_else(|e| panic!("the shell refused {ok}: {e}"));
        match parsed {
            Config::Cloud(c) => assert_eq!(c.cloud_url, c.cloud_url.trim()),
            Config::Local(_) => panic!("a cloud configuration parsed as a local door"),
        }
    }
}

#[test]
fn it_never_relaxes_verification_to_reach_a_private_server() {
    // THE CLAIM THE DOOR MAKES OUT LOUD: ohmail verifies certificates and has no way to skip it.
    // `NODE_EXTRA_CA_CERTS` only ADDS a root. `NODE_TLS_REJECT_UNAUTHORIZED=0` would turn checking
    // off wholesale, and it is exactly the shortcut a future change reaches for when a self-hoster
    // reports that their server is unreachable. This is the line that stops it landing quietly.
    let dir = std::env::temp_dir().join(format!("ohmail-config-ca-strict-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir");
    fs::write(dir.join(OPERATOR_CA_FILE), "-----BEGIN CERTIFICATE-----\n").expect("write");

    for config in [local_door(), cloud_door()] {
        let env = env_map(&env_for(&config, &dir));
        assert!(!env.contains_key("NODE_TLS_REJECT_UNAUTHORIZED"), "for {config:?}");
        // Nor smuggled in through the options variable, which would be invisible in a key scan.
        let options = env.get("NODE_OPTIONS").cloned().unwrap_or_default();
        assert!(!options.contains("insecure"), "NODE_OPTIONS carried {options:?}");
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cleartext_is_admitted_for_this_computer_and_refused_everywhere_else() {
    // THE DOOR'S OWN REFUSAL ALREADY SAYS "or http:// for a server on this machine" — and this
    // file accepted cleartext for ANY host, so a stored door could post the mailbox password and
    // the authenticator code to an on-path peer while the app promised TLS. The window refuses it
    // twice already (`cloud-origin.ts`'s `normalizeOrigin`, `doors.ts`'s `hostLinkProblem`); this
    // is the same floor at the boundary the engine is downstream of, and it is not only typed
    // values that arrive here — a paired computer answers its own base (`proveHostLink`).
    for remote in [
        r#"{ "mode": "cloud", "cloudUrl": "http://example.com", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "http://10.0.2.2:1234/api", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "http://192.168.1.9", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "http://169.254.1.1:8080", "address": "a@b.example" }"#,
        // A LOOPBACK SPELLING THAT IS NOT LOOPBACK: a name that merely contains one.
        r#"{ "mode": "cloud", "cloudUrl": "http://localhost.example.com", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "http://127.0.0.1.example.com", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "http://[2001:db8::1]:8080", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "http://127.0.0.256", "address": "a@b.example" }"#,
        // THE ROOT DOT IS NOT FOLDED HERE and an uncompressed literal is not recognised — the
        // engine's `isLoopbackHost` does neither either, and no is the safe answer to a spelling
        // neither of them reduces. (The comparison in `is_self_hosted_cloud` folds the dot; this
        // one must not, or `http://localhost.` would become admitted cleartext.)
        r#"{ "mode": "cloud", "cloudUrl": "http://localhost.", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "http://127.0.0.1.", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "http://[0:0:0:0:0:0:0:1]", "address": "a@b.example" }"#,
    ] {
        let value: serde_json::Value = serde_json::from_str(remote).expect("fixture json");
        let err = parse(&value).expect_err("cleartext was stored for a remote host");
        assert!(err.contains("this machine"), "the refusal does not name the rule: {err} ({remote})");
    }

    // …AND THIS COMPUTER IS STILL REACHABLE, which is the door the shipped compose stack opens.
    for here in [
        r#"{ "mode": "cloud", "cloudUrl": "http://localhost:8080/api", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "http://127.0.0.1:9000/api", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "http://127.1.2.3/api", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "http://[::1]:9000/api", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "http://ohmail.localhost:3000", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "https://ohmail.example.com/api", "address": "a@b.example" }"#,
    ] {
        let value: serde_json::Value = serde_json::from_str(here).expect("fixture json");
        parse(&value).unwrap_or_else(|e| panic!("the shell refused {here}: {e}"));
    }
}

#[test]
fn a_host_this_process_cannot_read_as_written_is_refused_rather_than_distrusted() {
    // THE URL STANDARD MAPS AND DECODES A HOST, and this process has no parser that does either:
    // `api%2Eohmail.app` percent-decodes and the fullwidth spelling IDNA-maps, each onto the hosted
    // service, while any fold available here reads somebody else's server and hands it the operator
    // CA. Refused rather than merely distrusted, because withholding the CA in silence is the worse
    // half of the same bug — the handshake then fails with an issuer error and the refusal tells the
    // operator to install the file they already installed.
    for unreadable in [
        r#"{ "mode": "cloud", "cloudUrl": "https://ａｐｉ.ohmail.app", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "https://api%2Eohmail.app", "address": "a@b.example" }"#,
        // The standard reads a backslash as a SEPARATOR, so this names the hosted service too.
        r#"{ "mode": "cloud", "cloudUrl": "https://api.ohmail.app\\evil", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "https://", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "http://", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "https://[::1", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "http://[::1:8080", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "https://h.example:99999", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "https://h.example:8o80", "address": "a@b.example" }"#,
    ] {
        let value: serde_json::Value = serde_json::from_str(unreadable).expect("fixture json");
        let err = parse(&value).expect_err("an unreadable host was stored");
        assert!(err.contains("punycode"), "the refusal does not name the rule: {err} ({unreadable})");
    }

    // …AND EVERY HOST A REAL OPERATOR HAS. An underscore, a bracketed address and a punycoded
    // international name are all admitted by the engine's own parse, so refusing them here would
    // take the door away from somebody rather than close anything.
    for real in [
        r#"{ "mode": "cloud", "cloudUrl": "https://my_server.local/api", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "https://[2001:db8::1]/api", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "https://xn--ida.example/api", "address": "a@b.example" }"#,
        r#"{ "mode": "cloud", "cloudUrl": "https://ohmail.example.com:8443/api", "address": "a@b.example" }"#,
    ] {
        let value: serde_json::Value = serde_json::from_str(real).expect("fixture json");
        parse(&value).unwrap_or_else(|e| panic!("the shell refused {real}: {e}"));
    }
}

#[test]
fn an_address_whose_origin_cannot_be_established_is_never_read_as_self_hosted() {
    // FAIL CLOSED, and the reason is live rather than theoretical: UTS-46 maps the FULLWIDTH
    // spelling of `api.ohmail.app` onto the managed host, so the engine's URL parser dials the
    // hosted service while a fold done without an IDNA table reads somebody else's server — and
    // the operator CA lands on the door holding the hosted session. So an address this module
    // cannot reduce to an origin is NOT self-hosted: it costs a mistyped door its private CA,
    // and it costs a misread managed door nothing.
    let dir = std::env::temp_dir().join(format!("ohmail-config-ca-fc-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir");
    fs::write(dir.join(OPERATOR_CA_FILE), "-----BEGIN CERTIFICATE-----\n").expect("write");

    for unreducible in [
        "https://\u{ff41}\u{ff50}\u{ff49}.ohmail.app",
        "https://api.ohmail.app\u{3002}",
        "https://api%2Eohmail.app",
        "https://user@api.ohmail.app",
        "https://",
        "https://[::1",
        "https://h.example:99999",
        "https://h.example:8o80",
    ] {
        let door = Config::Cloud(CloudDoor {
            cloud_url: unreducible.to_string(),
            address: Some("someone@ohmail.app".to_string()),
            flavor: None,
            host_pin: None,
            identity_pending: false,
        });
        assert!(
            !env_map(&env_for(&door, &dir)).contains_key("NODE_EXTRA_CA_CERTS"),
            "{unreducible:?} was read as a self-hosted server"
        );
    }

    // The positive control, in this test, so a refusal that swallowed every door would not pass.
    assert!(env_map(&env_for(&self_hosted_door(), &dir)).contains_key("NODE_EXTRA_CA_CERTS"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_self_hosted_server_still_gets_the_certificate_authority_it_installed() {
    // The other arm of the same comparison. Teaching it the managed base's harmless spellings must
    // not make every port-carrying, upper-cased or similarly-named address equal to it as well —
    // that would silently take the private CA away from the only door it belongs to.
    //
    // ONE INSTALL PER SPELLING, because these are ten DIFFERENT servers and an authority is now
    // bound to the one it was installed for: sharing a directory would be asking whether a record
    // written for the first of them reaches the other nine, which is the row next door and whose
    // answer is no.
    let root = std::env::temp_dir().join(format!("ohmail-config-ca-sh-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);

    for (n, spelling) in [
        "https://ohmail.example.com/api",
        "https://OHMAIL.example.com:8443/api",
        "https://ohmail.example.com:443/api",
        "http://localhost:8080/api",
        // Neither a prefix nor a suffix of the managed host is the managed host.
        "https://api.ohmail.app.example.com",
        "https://api.ohmail.appx",
        // And the three host shapes the positive alphabet had to keep admitting.
        "https://my_server.local/api",
        "https://[2001:db8::1]/api",
        "https://xn--ida.example/api",
    ]
    .into_iter()
    .enumerate()
    {
        let dir = root.join(format!("install-{n}"));
        fs::create_dir_all(&dir).expect("mkdir");
        fs::write(dir.join(OPERATOR_CA_FILE), "-----BEGIN CERTIFICATE-----\n").expect("write");
        let door = Config::Cloud(CloudDoor {
            cloud_url: spelling.to_string(),
            address: Some("someone@example.com".to_string()),
            flavor: None,
            host_pin: None,
            identity_pending: false,
        });
        assert!(
            env_map(&env_for(&door, &dir)).contains_key("NODE_EXTRA_CA_CERTS"),
            "{spelling:?} lost the certificate authority its operator installed"
        );
    }
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_operator_ca_file_is_spelled_the_same_way_in_the_engine() {
    // THREE PLACES NAME THIS FILE and they are in two languages: this process composes the path,
    // the engine's probe tells an operator where to put it, and the door's address step tells them
    // before they hit the refusal. A drift between them is a sentence that names a file the app
    // does not read — the worst kind of instruction, because following it changes nothing.
    //
    // This process links no JavaScript, so the agreement is checked by reading the source that
    // holds the other copy. Change either spelling alone and this fails.
    let engine = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../sidecar/src/cloud-origin.ts");
    let source = fs::read_to_string(&engine)
        .unwrap_or_else(|e| panic!("could not read {}: {e}", engine.display()));
    let needle = format!("export const OPERATOR_CA_FILE = \"{OPERATOR_CA_FILE}\";");
    assert!(
        source.contains(&needle),
        "the engine does not declare {needle:?} — the shell composes a path to a file nothing names"
    );
}
