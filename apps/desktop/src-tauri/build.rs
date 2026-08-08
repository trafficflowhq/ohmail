// THE COMMANDS THE WINDOW MAY CALL — declared here, or no capability can grant them.
//
// Tauri resolves a capability against a manifest built at compile time, and a command that is not
// named here has no `allow-…` permission for anything to reference. That makes this list the real
// boundary rather than the capability files: it is not possible to grant what was never declared.
//
// It is conditional on the same feature that compiles the engine's lifetime in, and the two halves
// have to agree. With the feature off this declares nothing, `main.rs` registers no handler and no
// capability is added, so the published shell's window can still call nothing at all — a property
// of the binary rather than of a list somebody could edit. A build script reads a feature as
// `CARGO_FEATURE_<NAME>`, upper-cased with hyphens turned into underscores.
fn main() {
    // PACKAGING GATE — never ship an updater that would trust an unsigned feed.
    //
    // The auto-updater fetches and executes new code, so it MUST verify every
    // payload against `plugins.updater.pubkey`. A build whose pubkey is missing
    // or empty would silently accept whatever the feed served — remote code
    // execution to every user. This runs on every `cargo build`/`cargo check`
    // (and therefore every `tauri build`), before any of the heavy compile, so
    // an empty pubkey fails packaging fast and loudly rather than producing an
    // installer that trusts nobody's signature. Its negative control lives in
    // `test/desktop-shell.test.ts` — empty the pubkey and the guard bites.
    assert_updater_pubkey();

    let mut attributes = tauri_build::Attributes::new();
    if std::env::var_os("CARGO_FEATURE_LOCAL_ENGINE").is_some() {
        attributes = attributes.app_manifest(tauri_build::AppManifest::new().commands(&[
            "engine_status",
            "engine_request",
            "engine_configure",
            "engine_logout",
            // The two pieces of native chrome the WINDOW drives: what is unread is a fact about
            // mail, so the client decides and the shell performs. Declared here like the four
            // above, because a command absent from this list has no `allow-…` permission for the
            // capability to reference and the app panics on launch rather than at compile time.
            "notify",
            "set_badge",
            // The one place this window may reach the WEB, and it may not name it: the command
            // takes a key and `engine.rs`'s table decides which of a handful of ohmail.app pages
            // that means. Declared here for the same reason as the six above — an undeclared
            // command has no permission to grant, and the app panics on launch rather than at
            // compile time.
            "open_link",
        ]));
    }
    tauri_build::try_build(attributes).expect("ohmail: failed to build the Tauri context");
}

/// Fail the build unless `plugins.updater.pubkey` in tauri.conf.json is a
/// non-empty, base64-shaped minisign public key. Deliberately does not pull a
/// JSON parser into the build graph: the config is machine-formatted and the
/// only value named `pubkey` is the updater's, so a targeted scan is enough and
/// keeps the build-dependency list at exactly `tauri-build`.
fn assert_updater_pubkey() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let conf = std::fs::read_to_string("tauri.conf.json")
        .expect("ohmail: cannot read tauri.conf.json to verify the updater pubkey");

    let key = extract_json_string(&conf, "pubkey").unwrap_or_else(|| {
        panic!(
            "ohmail: plugins.updater.pubkey is missing from tauri.conf.json — \
             refusing to package an updater that would trust an unsigned feed"
        )
    });

    assert!(
        key.len() >= 40 && key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')),
        "ohmail: plugins.updater.pubkey is empty or malformed ({} chars) — \
         refusing to package an updater that would trust an unsigned feed",
        key.len()
    );
}

/// Return the string value of the first `"<field>": "<value>"` in `src`.
fn extract_json_string(src: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\"");
    let start = src.find(&needle)? + needle.len();
    let rest = &src[start..];
    let colon = rest.find(':')?;
    let after = &rest[colon + 1..];
    let open = after.find('"')?;
    let value = &after[open + 1..];
    let close = value.find('"')?;
    Some(value[..close].to_string())
}
