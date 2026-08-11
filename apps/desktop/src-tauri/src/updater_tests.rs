//! The updater's biting tests — the deliverable, not the feature.
//!
//! An updater fetches and runs new code, so the two failures that matter are a
//! TAMPERED payload being installed and a DOWNGRADE being installed. Both are
//! proven here by watching the refusal happen, not by trusting that a library
//! would refuse: a guard nobody has seen go red is not evidence.
//!
//! `tampered_payload_is_refused` reproduces exactly what `tauri-plugin-updater`
//! does at download time — unwrap tauri's base64 envelope, hand the inner
//! minisign bytes to `minisign-verify`, verify against the SAME public key that
//! ships in `tauri.conf.json` — over a committed fixture signed with the SAME
//! private key now held in `~/.ohmail/secrets.env`. It exercises the signature
//! layer and the real key material; it does not drive the plugin's HTTP path.
//!
//! `downgrade_is_refused` drives `should_offer`, the version gate the install
//! path actually calls, table-driven across the boundary cases.

//! The flow's own tests are below the two above: the update UI is one menu item and one dialog,
//! and both of them read a pure value (`Flow`), so what a person is shown — and, more importantly,
//! what they are NOT shown twice — is something these drive directly.

use super::{should_offer, Flow, Press, Signal, Stage};
use base64::Engine as _;
use std::fs;
use std::path::PathBuf;

const BASE64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn fixtures_dir() -> PathBuf {
    manifest_dir().join("../test/fixtures/updater")
}

/// The public key exactly as the client trusts it: read from the shipped
/// `tauri.conf.json` so the test breaks if the committed key is ever changed
/// without re-signing the fixture. Same targeted scan as `build.rs`.
fn shipped_pubkey() -> String {
    let conf = fs::read_to_string(manifest_dir().join("tauri.conf.json")).unwrap();
    let needle = "\"pubkey\"";
    let start = conf.find(needle).unwrap() + needle.len();
    let rest = &conf[start..];
    let colon = rest.find(':').unwrap();
    let after = &rest[colon + 1..];
    let open = after.find('"').unwrap();
    let value = &after[open + 1..];
    let close = value.find('"').unwrap();
    value[..close].to_string()
}

/// tauri wraps both the public key and the signature as base64 over the whole
/// minisign file text; unwrap that and parse the minisign content.
fn minisign_public_key() -> minisign_verify::PublicKey {
    let text = String::from_utf8(BASE64.decode(shipped_pubkey().trim()).unwrap()).unwrap();
    minisign_verify::PublicKey::decode(&text).unwrap()
}

fn minisign_signature(sig_b64: &str) -> minisign_verify::Signature {
    let text = String::from_utf8(BASE64.decode(sig_b64.trim()).unwrap()).unwrap();
    minisign_verify::Signature::decode(&text).unwrap()
}

#[test]
fn valid_payload_is_accepted() {
    // The positive control. If this cannot pass, the negative result below
    // proves nothing — it might be refusing everything.
    let pk = minisign_public_key();
    let payload = fs::read(fixtures_dir().join("payload.bin")).unwrap();
    let sig_b64 = fs::read_to_string(fixtures_dir().join("payload.bin.sig")).unwrap();
    let sig = minisign_signature(&sig_b64);

    assert!(
        pk.verify(&payload, &sig, true).is_ok(),
        "the committed signature must verify against the shipped public key — \
         if it does not, the pubkey in tauri.conf.json and the fixture signature disagree"
    );
}

#[test]
fn tampered_payload_is_refused() {
    // Sign an archive, corrupt one byte, watch the verification refuse. This is
    // the RCE surface: a payload that does not match its signature must never be
    // accepted for install.
    let pk = minisign_public_key();
    let payload = fs::read(fixtures_dir().join("payload.bin")).unwrap();
    let sig_b64 = fs::read_to_string(fixtures_dir().join("payload.bin.sig")).unwrap();
    let sig = minisign_signature(&sig_b64);

    // One byte, flipped — the smallest possible tamper.
    let mut tampered = payload.clone();
    tampered[0] ^= 0x01;
    assert_ne!(tampered, payload, "the tamper must actually change the bytes");

    assert!(
        pk.verify(&tampered, &sig, true).is_err(),
        "a one-byte-tampered payload MUST be refused — the updater would otherwise \
         install whatever a MITM or a compromised feed served"
    );
}

#[test]
fn downgrade_is_refused() {
    // The version gate `run` applies before it will fetch, let alone install, anything.
    // Table-driven across the boundary cases; bare semver, no `-preview` left to
    // make the ordering subtle.
    let cases: &[(&str, &str, bool)] = &[
        // installed, candidate, may we offer it?
        ("0.5.0", "0.5.0", false), // the same release — never an update
        ("0.5.0", "0.5.1", true),  // patch newer
        ("0.5.0", "0.6.0", true),  // minor newer
        ("0.5.0", "1.0.0", true),  // major newer
        ("0.6.0", "0.5.0", false), // a downgrade — refused
        ("0.5.1", "0.5.0", false), // a patch downgrade — refused
        ("1.0.0", "0.9.9", false), // a major downgrade — refused
    ];
    for &(installed, candidate, expected) in cases {
        let got = should_offer(
            &semver::Version::parse(installed).unwrap(),
            &semver::Version::parse(candidate).unwrap(),
        );
        assert_eq!(
            got, expected,
            "should_offer(installed={installed}, candidate={candidate}) expected {expected}"
        );
    }
}

/// Drive the flow to the point where the one dialog is owed.
fn ready() -> Flow {
    let mut flow = Flow::default();
    flow.apply(Signal::CheckStarted);
    flow.apply(Signal::Offered("0.9.2".into()));
    flow.apply(Signal::Downloaded);
    flow
}

#[test]
fn one_press_takes_it_from_available_to_ready() {
    // The happy path, stage by stage, and what the menu item says at each — because the item IS
    // the affordance: the webview is granted nothing, so there is no banner to fall back on.
    let mut flow = Flow::default();
    assert_eq!(flow.stage(), &Stage::Idle);
    assert_eq!(flow.press(), Press::Check);
    assert_eq!(flow.menu_label(), "Check for Updates…");
    assert!(flow.menu_enabled());

    flow.apply(Signal::CheckStarted);
    assert_eq!(flow.stage(), &Stage::Checking);
    // Disabled while a check runs: a second press must not start a second check, and an item that
    // looks live and does nothing is worse than one that is visibly busy.
    assert_eq!(flow.press(), Press::Nothing);
    assert!(!flow.menu_enabled());
    assert!(!flow.may_start_check());

    flow.apply(Signal::Offered("0.9.2".into()));
    assert_eq!(flow.stage(), &Stage::Downloading("0.9.2".into()));
    assert!(!flow.menu_enabled());
    assert_eq!(flow.menu_label(), "Downloading ohmail 0.9.2…");
    // NOTHING IS ASKED YET, and nothing is installed. The payload is being fetched and verified;
    // the consent gates the install, which is the next stage.
    assert!(!flow.should_prompt());

    flow.apply(Signal::Downloaded);
    assert_eq!(flow.stage(), &Stage::Ready("0.9.2".into()));
    assert_eq!(flow.menu_label(), "Restart to Install 0.9.2");
    assert!(flow.menu_enabled());
    // THE ONE DIALOG IS OWED HERE and nowhere else. `prompt_ready` shows it exactly when this is
    // true, so this assertion is the dialog appearing.
    assert!(flow.should_prompt());
    // And the press that answers it installs, rather than starting another check.
    assert_eq!(flow.press(), Press::Restart);
}

#[test]
fn the_dialog_is_asked_once_and_later_is_remembered_for_the_run() {
    // The whole point of the rewrite: the app used to ask before the download AND again before the
    // restart. It now asks once, and "Later" spends the question rather than the payload.
    let mut flow = ready();
    assert!(flow.should_prompt(), "the first offer must be made");

    flow.apply(Signal::Deferred);
    assert!(
        !flow.should_prompt(),
        "'Later' must not be asked again — a second dialog for the same payload is the stacking \
         this flow exists to remove"
    );
    // The payload is still ready and the item still says so: "Later" is not "no".
    assert_eq!(flow.stage(), &Stage::Ready("0.9.2".into()));
    assert_eq!(flow.menu_label(), "Restart to Install 0.9.2");
    assert_eq!(
        flow.press(),
        Press::Restart,
        "after 'Later' the menu item must still be the way to install it — otherwise the answer \
         is a dead end until the app is relaunched"
    );

    // And nothing re-opens the question. A stray signal from work that finished late must not put
    // a second dialog on screen.
    for signal in [Signal::Downloaded, Signal::CheckStarted, Signal::Offered("0.9.2".into())] {
        flow.apply(signal);
        assert!(!flow.should_prompt(), "the question must stay spent for this run");
    }
}

#[test]
fn a_check_cannot_start_while_one_is_running_or_while_a_payload_waits() {
    // `check` refuses on `may_start_check`, so this is the guard against a second feed request and
    // against replacing a verified download with an identical one.
    let mut flow = Flow::default();
    assert!(flow.may_start_check(), "idle must be checkable");

    flow.apply(Signal::CheckStarted);
    assert!(!flow.may_start_check());
    flow.apply(Signal::Offered("0.9.2".into()));
    assert!(!flow.may_start_check(), "a download in flight is not a moment to re-check");
    flow.apply(Signal::Downloaded);
    assert!(
        !flow.may_start_check(),
        "a payload is already verified and waiting — re-checking would fetch it again"
    );
}

#[test]
fn a_failure_leaves_a_way_to_try_again() {
    // No dead ends. Whatever failed, the flow returns to a stage whose press is another check —
    // which is the same thing the error dialog's "Try again" button calls.
    for at in [Signal::CheckStarted, Signal::Offered("0.9.2".into())] {
        let mut flow = Flow::default();
        flow.apply(Signal::CheckStarted);
        if at != Signal::CheckStarted {
            flow.apply(at);
        }
        flow.apply(Signal::Failed);
        assert_eq!(flow.stage(), &Stage::Failed);
        assert_eq!(flow.press(), Press::Check, "a failure must be retryable from the bar");
        assert!(flow.may_start_check());
        assert!(flow.menu_enabled());
        assert_eq!(flow.menu_label(), "Check for Updates…");
        // A failure has nothing to prompt about.
        assert!(!flow.should_prompt());

        // And the retry genuinely runs: the same item, pressed again, starts a fresh check.
        flow.apply(Signal::CheckStarted);
        assert_eq!(flow.stage(), &Stage::Checking);
    }
}

#[test]
fn an_install_that_fails_does_not_leave_the_bar_promising_a_restart() {
    // `install_and_restart` signals `Failed` when the install refuses. The item must stop offering
    // a restart it can no longer perform, and must offer the only thing left instead.
    let mut flow = ready();
    flow.apply(Signal::Failed);
    assert_eq!(flow.stage(), &Stage::Failed);
    assert_eq!(flow.press(), Press::Check);
    assert_eq!(flow.menu_label(), "Check for Updates…");
}

#[test]
fn a_check_that_finds_nothing_says_nothing_and_leaves_the_bar_alone() {
    let mut flow = Flow::default();
    flow.apply(Signal::CheckStarted);
    flow.apply(Signal::NothingOffered);
    assert_eq!(flow.stage(), &Stage::Idle);
    assert_eq!(flow.menu_label(), "Check for Updates…");
    assert!(!flow.should_prompt(), "there is nothing to prompt about");
    assert!(flow.may_start_check());
}

#[test]
fn late_work_cannot_drag_the_flow_backwards() {
    // Signals arrive from spawned tasks. One that finishes after the flow has moved on must be
    // ignored rather than able to reopen a stage — a `Downloaded` landing on an idle flow would
    // otherwise put "Restart to Install" on the bar with nothing behind it.
    let mut flow = Flow::default();
    for signal in [
        Signal::Downloaded,
        Signal::Offered("0.9.2".into()),
        Signal::Deferred,
        Signal::NothingOffered,
        Signal::Failed,
    ] {
        flow.apply(signal);
        assert_eq!(flow.stage(), &Stage::Idle, "an idle flow must stay idle");
        assert_eq!(flow.press(), Press::Check);
    }
}
