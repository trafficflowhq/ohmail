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
//!
//! A downgrade guard is only as good as the version it is handed, and `latest.json`
//! is unsigned — so the group under `signed_release` proves where that version comes
//! from. `versioned_signature_carries_the_version_and_still_verifies_the_payload`
//! signs the same fixture bytes under the name the release pipeline now uses;
//! `forged_version_claim_is_refused` edits the version claim inside the signature and
//! watches verification refuse, which is the property the guard rests on;
//! `a_payload_with_no_signed_version_is_not_offered` pins what happens to every
//! artifact signed before 0.13.3.

//! The flow's own tests are below the two above: the update UI is one menu item and one dialog,
//! and both of them read a pure value (`Flow`), so what a person is shown — and, more importantly,
//! what they are NOT shown twice — is something these drive directly.

use super::{should_install, should_offer, signed_release, Flow, Press, Signal, Stage};
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

// ─── THE FEED'S VERSION CLAIM IS NOT THE ONE THE GUARD USES ──────────────────────────
//
// `downgrade_is_refused` above proves the COMPARISON. These prove the thing that makes
// the comparison worth anything: that the version fed into it comes from signed material,
// so a feed writer holding no key cannot choose it.

/// The committed fixture signed the way `release-feeds.yml` signs — `<version>@<asset>`.
fn versioned_sig_b64() -> String {
    fs::read_to_string(fixtures_dir().join("payload-versioned.bin.sig")).unwrap()
}

#[test]
fn versioned_signature_carries_the_version_and_still_verifies_the_payload() {
    // The positive control, and it is doing two jobs at once. The fixture was signed with
    // the REAL release key over the SAME payload bytes as `payload.bin.sig`, under the
    // name `0.13.3@ohmail-linux-x86_64.AppImage`. So this asserts both halves of the
    // pipeline change: putting a version in the signed name does not disturb the payload
    // signature, and the version comes back out.
    let pk = minisign_public_key();
    let payload = fs::read(fixtures_dir().join("payload.bin")).unwrap();
    let sig_b64 = versioned_sig_b64();
    let sig = minisign_signature(&sig_b64);
    assert!(
        pk.verify(&payload, &sig, true).is_ok(),
        "a versioned signing name must not change what the signature says about the bytes"
    );

    let signed = signed_release(&sig_b64).expect("the signed name must yield a version");
    assert_eq!(signed.version, semver::Version::parse("0.13.3").unwrap());
    assert_eq!(signed.asset, "ohmail-linux-x86_64.AppImage");
}

#[test]
fn forged_version_claim_is_refused() {
    // THE LOAD-BEARING ONE. `signed_release` does not verify anything and runs before
    // `download`, so the reason a forged version claim cannot reach an install is that
    // minisign's global signature covers the trusted comment. Watch that refusal.
    //
    // Editing the trusted comment is exactly what an attacker who wanted to keep a
    // genuine old payload while claiming a new version would have to do.
    let pk = minisign_public_key();
    let payload = fs::read(fixtures_dir().join("payload.bin")).unwrap();

    let text = String::from_utf8(BASE64.decode(versioned_sig_b64().trim()).unwrap()).unwrap();
    assert!(
        text.contains("file:0.13.3@"),
        "the fixture must carry the version being forged away, or this proves nothing"
    );
    let forged = text.replace("file:0.13.3@", "file:99.0.0@");
    let forged_b64 = BASE64.encode(forged.as_bytes());

    // The forgery does what the attacker wanted: the guard now reads 99.0.0. So the guard
    // alone would let it through, which is precisely why the next assertion is the one
    // that matters.
    let signed = signed_release(&forged_b64).expect("the forged name still parses");
    assert_eq!(
        signed.version,
        semver::Version::parse("99.0.0").unwrap(),
        "the edit must actually change what the guard reads"
    );

    let sig = minisign_signature(&forged_b64);
    assert!(
        pk.verify(&payload, &sig, true).is_err(),
        "a trusted comment edited to claim a different version MUST fail verification — \
         the version is signed metadata or the downgrade guard is decoration"
    );

    // WHICH comment, precisely. minisign covers the TRUSTED comment in its global
    // signature and leaves the untrusted one out, so editing the untrusted line changes
    // nothing and must still verify. Without this the assertion above would also pass if
    // verification simply broke on any edit anywhere, which would prove nothing about
    // where a release may put a fact an attacker cannot move.
    let relabelled = text.replace(
        "untrusted comment: signature from tauri secret key",
        "untrusted comment: anything at all",
    );
    assert_ne!(relabelled, text, "the untrusted comment must actually have changed");
    let sig = minisign_signature(&BASE64.encode(relabelled.as_bytes()));
    assert!(
        pk.verify(&payload, &sig, true).is_ok(),
        "the UNTRUSTED comment is not covered by the signature — if editing it breaks \
         verification, this test is not measuring what it claims to"
    );
}

#[test]
fn a_forged_untrusted_comment_cannot_move_the_version() {
    // THE ONE THAT CAUGHT A REAL HOLE IN THIS GUARD. A minisign signature file has four
    // lines and only lines 1-3 are signed; line 0, the UNTRUSTED comment, is covered by
    // nothing and anyone may rewrite it. `signed_release` originally scanned for the first
    // line beginning `trusted comment: `, so writing that prefix into LINE 0 made it read
    // an attacker's version — while the signature still verified, because
    // `Signature::decode` reads the real comment at line 2 positionally and never looks at
    // line 0.
    //
    // The fixture is a genuine signature over `payload.bin` with line 0 replaced. It MUST
    // still verify: a fixture that failed verification would prove nothing, because the
    // whole danger is that this passes every signature check there is.
    let pk = minisign_public_key();
    let payload = fs::read(fixtures_dir().join("payload.bin")).unwrap();
    let forged_b64 = fs::read_to_string(fixtures_dir().join("payload-forged-untrusted.bin.sig")).unwrap();

    let text = String::from_utf8(BASE64.decode(forged_b64.trim()).unwrap()).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert!(
        lines[0].starts_with("trusted comment: ") && lines[0].contains("99.0.0@"),
        "line 0 must carry the forged claim, or this test is not measuring the hole"
    );
    assert!(
        lines[2].starts_with("trusted comment: ") && lines[2].contains("0.13.3@"),
        "line 2 must still carry the real, signed claim"
    );

    assert!(
        pk.verify(&payload, &minisign_signature(&forged_b64), true).is_ok(),
        "the forged fixture MUST still verify — the untrusted comment is not signed, which \
         is exactly why reading it is unsafe and why `download` cannot catch this"
    );

    // And the version read is the SIGNED one, from line 2.
    let signed = signed_release(&forged_b64).expect("line 2 still yields a version");
    assert_eq!(
        signed.version,
        semver::Version::parse("0.13.3").unwrap(),
        "the version must come from the signed line, never from the rewritable one"
    );

    // Which makes the whole thing a refusal: the feed advertises what it forged into line 0,
    // and the signed line disagrees.
    assert_eq!(
        should_install("0.9.0", "99.0.0", &forged_b64),
        None,
        "a signature whose untrusted comment claims 99.0.0 must install nothing"
    );
}

#[test]
fn a_payload_with_no_signed_version_is_not_offered() {
    // Every release up to and including 0.13.2 was signed under its bare asset name, so
    // there is no version in the trusted comment. `None` is the honest answer, and `run`
    // treats `None` as nothing-to-offer: bytes this client cannot establish a version for
    // are not installed. `payload.bin.sig` IS such a signature — `file:payload.bin`.
    let legacy = fs::read_to_string(fixtures_dir().join("payload.bin.sig")).unwrap();
    let text = String::from_utf8(BASE64.decode(legacy.trim()).unwrap()).unwrap();
    assert!(
        text.contains("file:payload.bin"),
        "this fixture is standing in for a pre-0.13.3 signature; it must be unversioned"
    );
    assert!(
        signed_release(&legacy).is_none(),
        "an artifact signed without a version must not yield one"
    );
}

#[test]
fn only_a_well_formed_signed_name_yields_a_version() {
    // The parser's whole surface, and every case that must NOT produce a version — a
    // guard that returns a version for malformed input would hand `should_offer` a number
    // an attacker chose.
    let sig = |trusted: &str| {
        let text = format!(
            "untrusted comment: signature from tauri secret key\n\
             RURV2NTwoaEoMQ==\n\
             trusted comment: {trusted}\n\
             zKhvIlGHWG3x67M80tyVDQ==\n"
        );
        BASE64.encode(text.as_bytes())
    };

    let cases: &[(&str, Option<(&str, &str)>)] = &[
        // The shape the pipeline emits.
        (
            "timestamp:1788240000\tfile:0.13.3@ohmail-linux-x86_64.AppImage",
            Some(("0.13.3", "ohmail-linux-x86_64.AppImage")),
        ),
        // Field order is not relied on: `file:` is found, not indexed.
        (
            "file:1.2.3@ohmail.app.tar.gz\ttimestamp:1788240000",
            Some(("1.2.3", "ohmail.app.tar.gz")),
        ),
        // An asset name containing an `@` cannot move where the version is read from —
        // `split_once`, so the FIRST `@` is the separator and the rest is the asset.
        (
            "timestamp:1\tfile:2.0.0@odd@name.AppImage",
            Some(("2.0.0", "odd@name.AppImage")),
        ),
        // Unversioned: every release through 0.13.2.
        ("timestamp:1\tfile:ohmail-linux-x86_64.AppImage", None),
        // A version that is not semver.
        ("timestamp:1\tfile:latest@ohmail-linux-x86_64.AppImage", None),
        // Almost-semver, which is the interesting near-miss: two components, not three.
        ("timestamp:1\tfile:0.13@ohmail-linux-x86_64.AppImage", None),
        // A version with nothing after the separator names no artifact.
        ("timestamp:1\tfile:0.13.3@", None),
        // No `file:` field at all.
        ("timestamp:1788240000", None),
        // The separator without a version in front of it.
        ("timestamp:1\tfile:@ohmail-linux-x86_64.AppImage", None),
    ];

    for &(trusted, expected) in cases {
        let got = signed_release(&sig(trusted));
        match expected {
            Some((version, asset)) => {
                let got = got.unwrap_or_else(|| panic!("expected a version from {trusted:?}"));
                assert_eq!(got.version, semver::Version::parse(version).unwrap(), "{trusted:?}");
                assert_eq!(got.asset, asset, "{trusted:?}");
            }
            None => assert!(got.is_none(), "{trusted:?} must not yield a version, got {got:?}"),
        }
    }

    // And the envelope itself: anything that is not base64 of minisign text is refused
    // rather than panicking. `run` calls this on a string a feed supplied. The last two are
    // truncated files — a positional read must run out of lines rather than index past them.
    for junk in [
        "",
        "not base64!!",
        "aGVsbG8=",                                          // "hello" — one line
        "dW50cnVzdGVkIGNvbW1lbnQ6IHgK",                      // just the untrusted comment
        "dW50cnVzdGVkIGNvbW1lbnQ6IHgKUlVSVjJOVHdvYUVvTVE9PQo=", // two lines, no comment
    ] {
        assert!(signed_release(junk).is_none(), "{junk:?} must not yield a version");
    }

    // LINE 0 IS NEVER READ, at the parser level. `a_forged_untrusted_comment_cannot_move_the
    // _version` proves it on a real signature that still verifies; this proves the parser
    // ignores the line even when line 2 offers nothing, so the answer is None rather than
    // the forged claim.
    let forged_line_0 = BASE64.encode(
        "trusted comment: timestamp:1\tfile:99.0.0@ohmail-linux-x86_64.AppImage\n\
         RURV2NTwoaEoMQ==\n\
         trusted comment: timestamp:1\tfile:ohmail-linux-x86_64.AppImage\n\
         zKhvIlGHWG3x67M80tyVDQ==\n"
            .as_bytes(),
    );
    assert!(
        signed_release(&forged_line_0).is_none(),
        "a trusted-comment prefix in line 0 must be ignored — line 2 is the signed one, and \
         here it carries no version"
    );
}

/// A signature envelope whose trusted comment names `version` — the same shape the
/// release pipeline produces, minus a valid key, because `should_install` reads the name
/// and `download` is what checks the key.
fn signed_as(version: &str) -> String {
    let text = format!(
        "untrusted comment: signature from tauri secret key\n\
         RURV2NTwoaEoMQ==\n\
         trusted comment: timestamp:1788240000\tfile:{version}@ohmail-linux-x86_64.AppImage\n\
         zKhvIlGHWG3x67M80tyVDQ==\n"
    );
    BASE64.encode(text.as_bytes())
}

#[test]
fn the_advertised_version_must_equal_the_signed_one() {
    // `should_install` IS the decision `run` makes — driven here, not restated. `advertised`
    // is the feed's claim, which an actor who can write the feed chooses freely; `signed` is
    // what the key vouches for.
    let cases: &[(&str, &str, &str, Option<&str>)] = &[
        // installed, advertised, signed, the version installed (None = offer nothing)
        ("0.13.3", "0.13.4", "0.13.4", Some("0.13.4")), // an honest update
        ("0.13.3", "0.13.3", "0.13.3", None),           // the release already installed
        ("0.13.3", "0.13.4", "0.13.2", None),           // an old payload sold as a new one
        ("0.13.3", "0.13.2", "0.13.4", None),           // inconsistent the other way
        ("0.13.3", "1.0.0", "1.0.0", Some("1.0.0")),    // a major, consistently claimed
        ("1.0.0", "1.0.0", "1.0.0", None),              // a reinstall
    ];
    for &(installed, advertised, signed, expected) in cases {
        let got = should_install(installed, advertised, &signed_as(signed));
        let expected = expected.map(|v| semver::Version::parse(v).unwrap());
        assert_eq!(
            got, expected,
            "installed={installed} advertised={advertised} signed={signed}"
        );
    }

    // Unparseable versions refuse rather than fall through to an install.
    assert_eq!(should_install("0.13.3", "not-a-version", &signed_as("0.13.4")), None);
    assert_eq!(should_install("not-a-version", "0.13.4", &signed_as("0.13.4")), None);
    // And a payload with no signed version at all — every release through 0.13.2.
    assert_eq!(should_install("0.13.3", "0.13.4", &BASE64.encode(
        "untrusted comment: x\nRURV2NTwoaEoMQ==\ntrusted comment: timestamp:1\tfile:ohmail-linux-x86_64.AppImage\nzKhvIlGHWG3x67M80tyVDQ==\n"
    )), None);
}

#[test]
fn the_attack_this_guard_exists_for() {
    // Stated once, on its own, because it is the reason the module changed.
    //
    // An actor who can write `latest.json` and holds NO signing key publishes a manifest
    // claiming 99.0.0 and points it at the genuine, genuinely-signed artifact of an old
    // release. Every byte verifies. The old build's vulnerabilities are public.
    let installed = "0.13.9";
    let advertised = "99.0.0";
    let genuine_old_payload = signed_as("0.9.0");

    assert_eq!(
        should_install(installed, advertised, &genuine_old_payload),
        None,
        "a feed advertising 99.0.0 over an old release's genuine artifact MUST install nothing"
    );

    // And the shape of the mistake, so the refusal above cannot be read as an accident of
    // the ordering: the advertised version alone WOULD have been accepted.
    assert!(
        should_offer(
            &semver::Version::parse(installed).unwrap(),
            &semver::Version::parse(advertised).unwrap(),
        ),
        "99.0.0 is newer than the installed version — comparing the FEED's claim is what \
         made this an install, and comparing the signed one is what makes it a refusal"
    );
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
