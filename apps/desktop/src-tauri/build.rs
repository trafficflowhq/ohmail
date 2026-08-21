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
/// Every command the window may call — the whole list, in one place.
///
/// Each name here becomes an `allow-…`/`deny-…` permission pair in the manifest tauri compiles;
/// `LOCAL_ENGINE_CAPABILITY` in `engine.rs` grants the `allow-…` half at runtime. The two lists
/// have to agree, and the failure when they do not is NOT a refused command: tauri resolves a
/// runtime capability with an internal `unwrap()`, so a granted permission this list never
/// produced used to be an abort at launch, on every install, before the window existed — 0.9.7
/// shipped exactly that, with `open_external`/`open_attachment` granted and not declared. Two
/// defences now, one at each end: this list is baked into the binary (`OHMAIL_WINDOW_COMMANDS`
/// below) so `engine.rs` checks the grant BEFORE tauri sees it and degrades instead of dying,
/// and `every_granted_permission_is_declared_by_the_build` in `engine_tests.rs` holds the two
/// lists together at test time.
const WINDOW_COMMANDS: &[&str] = &[
    "engine_status",
    "engine_request",
    "engine_configure",
    "engine_logout",
    // The two pieces of native chrome the WINDOW drives: what is unread is a fact about
    // mail, so the client decides and the shell performs.
    "notify",
    "set_badge",
    // The one place this window may reach the WEB, and it may not name it: the command
    // takes a key and `engine.rs`'s table decides which of a handful of ohmail.app pages
    // that means.
    "open_link",
    // The one place the window may hand this process an address of its own — an http/https
    // link a person clicked inside a message, opened in the user's browser, never in the
    // webview. `engine.rs` validates the URL; this line is what makes the command reachable.
    "open_external",
    // The bytes of one attachment and a display name, written under the shell's own
    // directory and opened in the platform's usual viewer. Same shape: `engine.rs` owns the
    // path discipline, this line makes the command exist at all.
    "open_attachment",
    // HOST MODE — publishing the engine's loopback door to the user's OWN tailnet, driven
    // entirely through this shell's commands (`src/host.rs` carries the reasoning). The window
    // reads a typed state, probes the tailnet, arms and disarms (the serve invocation is
    // composed from constants and pinned by test to serve-never-funnel), toggles start-at-login
    // through the shell rather than the autostart plugin's own permissions, and can open
    // Tailscale's download page — one more CONSTANT address the shell owns, no URL argument.
    "host_state",
    "tailscale_status",
    "tailscale_serve_arm",
    "tailscale_serve_disarm",
    "autostart_get",
    "autostart_set",
    "open_tailscale_download",
    // The mailto activation the shell is holding, taken exactly once — a cold-start click
    // launches the app before the window can hear any event, so the window ASKS instead of
    // listening. The answer is the raw link; `src/mailto.ts` in the window is its one parser.
    "mailto_claim",
    // THE OS'S DEFAULT MAIL APP (`src/default_mail.rs`). A read of the current handler's state
    // in a three-word vocabulary, and a request that takes each platform's own sanctioned path
    // — macOS's consent dialog, the Windows Settings page (a constant address, the window still
    // naming no URL), `xdg-settings set` on Linux — and never writes a registry value.
    "default_mail_status",
    "default_mail_request",
];

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

    let engine = std::env::var_os("CARGO_FEATURE_LOCAL_ENGINE").is_some();
    let mut attributes = tauri_build::Attributes::new();
    if engine {
        attributes =
            attributes.app_manifest(tauri_build::AppManifest::new().commands(WINDOW_COMMANDS));
    }
    // The same list, baked into the binary so `engine.rs` can compare the runtime grant
    // against what was actually declared instead of letting tauri abort over the difference.
    // Emitted in every build — empty with the feature off, matching the manifest above, and
    // so that `env!` resolves regardless of features.
    println!(
        "cargo:rustc-env=OHMAIL_WINDOW_COMMANDS={}",
        if engine { WINDOW_COMMANDS.join(",") } else { String::new() }
    );
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
