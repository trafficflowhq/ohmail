//! The navigation lock (`navigation.rs`): the predicate in each platform's spelling, the guard as
//! `lock` builds it, the refusal's line, the link door, and two censuses: every webview this crate
//! constructs is born inside `navigation::lock(`, and no config window is left for Tauri to create.

use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::utils::config::{parse, Csp};
use tauri::utils::platform::Target;

const EVERY: [(Own, &str); 3] = [
    (Own::Scheme, "tauri://localhost"),
    (Own::Localhost { https: false }, "http://tauri.localhost"),
    (Own::Localhost { https: true }, "https://tauri.localhost"),
];

fn url(raw: &str) -> Url {
    Url::parse(raw).unwrap_or_else(|e| panic!("{raw}: {e}"))
}

#[test]
fn each_platform_admits_its_own_origin_and_no_other_spelling_of_it() {
    for (own, home) in EVERY {
        for path in ["", "/", "/index.html", "/updater.html", "/?renderer=reloaded#history", "/#/settings"] {
            assert!(admits(&url(&format!("{home}{path}")), own, None), "{home}{path} refused under {own:?}");
        }
        for (other, there) in EVERY {
            if other != own {
                assert!(!admits(&url(&format!("{there}/")), own, None), "{there} admitted under {own:?}");
            }
        }
    }
}

#[test]
fn the_outside_is_refused_in_every_spelling() {
    for (own, _) in EVERY {
        for outside in [
            "https://example.com/",
            "http://example.com/",
            "http://127.0.0.1:8080/",
            "http://127.0.0.1/",
            "http://[::1]:1420/",
            "http://localhost:1420/",
            "file:///etc/passwd",
            "data:text/html,<script>alert(1)</script>",
            "javascript:alert(1)",
            "http://tauri.localhost.evil/",
            "https://tauri.localhost.evil/",
            "tauri://localhost.evil/",
            "tauri://evil/",
            "http://tauri.localhost:8080/",
            "http://someone@tauri.localhost/",
            "tauri://someone@localhost/",
            "ipc://localhost/engine_status",
            "http://ipc.localhost/engine_status",
            "asset://localhost/x",
            "blob:tauri://localhost/0b0f2b1e-0000-4000-8000-000000000000",
            "about:blank",
            "about:srcdoc#top",
            "mailto:someone@example.test",
        ] {
            assert!(!admits(&url(outside), own, None), "{outside} admitted under {own:?}");
        }
    }
}

#[test]
fn the_message_frame_is_admitted_by_its_exact_address() {
    for (own, _) in EVERY {
        assert!(admits(&url(MESSAGE_FRAME), own, None), "the message frame refused under {own:?}");
    }
}

#[test]
fn dev_url_is_admitted_only_in_a_debug_build() {
    let dev = url("http://localhost:1420/");
    assert_eq!(dev_origin(Some(&dev), false), None);
    assert_eq!(dev_origin(None, true), None);
    let debug = dev_origin(Some(&dev), true);
    assert_eq!(debug.as_ref(), Some(&dev));
    for (own, _) in EVERY {
        assert!(admits(&url("http://localhost:1420/src/main.tsx"), own, debug.as_ref()));
        for other in ["http://localhost:1421/", "https://localhost:1420/", "http://127.0.0.1:1420/", "http://localhost.evil:1420/"] {
            assert!(!admits(&url(other), own, debug.as_ref()), "{other} admitted beside the dev origin");
        }
        assert!(!admits(&url("http://localhost:1420/"), own, dev_origin(Some(&dev), false).as_ref()));
    }
}

/// The shipped base config with a `devUrl`, as `tauri dev` hands one to a debug build.
fn base_with_dev(dev: &str) -> Config {
    let mut config: Config = serde_json::from_str(include_str!("../tauri.conf.json")).expect("the base parses");
    config.build.dev_url = Some(url(dev));
    config
}

#[test]
fn the_guard_reads_dev_url_through_the_debug_flag_and_lock_passes_the_builds_own() {
    let config = base_with_dev("http://localhost:1420/");
    let page = url("http://localhost:1420/index.html");
    assert!(guard(&config, true, None)(&page), "a debug build refused its devUrl");
    assert!(!guard(&config, false, None)(&page), "a release build admitted a devUrl");
    let (_, home) = EVERY.into_iter().find(|(own, _)| *own == Own::this_build(false)).expect("this build's spelling");
    assert!(guard(&config, false, None)(&url(&format!("{home}/index.html"))));
    assert!(!guard(&config, true, None)(&url("https://example.com/")));
    let source = code_of(include_str!("navigation.rs"));
    assert!(
        source.contains(".on_navigation(guard(config, cfg!(debug_assertions), door))"),
        "lock no longer hands the guard this build's own debug flag"
    );
}

#[test]
fn this_build_spells_its_origin_the_way_tauri_serves_it() {
    #[cfg(any(windows, target_os = "android"))]
    assert_eq!(Own::this_build(false), Own::Localhost { https: false });
    #[cfg(not(any(windows, target_os = "android")))]
    assert_eq!(Own::this_build(false), Own::Scheme);
    assert_eq!(Own::of(true, true), Own::Localhost { https: true });
    assert_eq!(Own::of(false, true), Own::Scheme);
}

/// The spelling is read against what each platform's build compiles in (`window_csp_tests.rs`'s
/// merge): the overlay's command scheme and the app's origin are the same wry choice, so they move
/// together or this reads red.
#[test]
fn each_platforms_spelling_agrees_with_its_overlays_command_scheme() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    for (target, webview2) in [(Target::Linux, false), (Target::MacOS, false), (Target::Windows, true)] {
        let (merged, _) = parse::read_from(target, dir).expect("the config and its overlay parse");
        let config: Config = serde_json::from_value(merged).expect("the merged config is a Tauri config");
        let own = Own::of(webview2, uses_https_scheme(&config));
        let (home, ipc) = match own {
            Own::Scheme => ("tauri://localhost/", "ipc:"),
            Own::Localhost { https: false } => ("http://tauri.localhost/", "http://ipc.localhost"),
            Own::Localhost { https: true } => ("https://tauri.localhost/", "https://ipc.localhost"),
        };
        let Some(Csp::Policy(policy)) = config.app.security.csp else { panic!("{target}: no CSP policy") };
        assert!(policy.contains(&format!("connect-src {ipc};")), "{target}: the overlay does not name {ipc}: {policy}");
        assert!(admits(&url(home), own, None), "{target}: {home} refused");
    }
}

#[test]
fn a_refusal_is_one_line_of_two_closed_classes_and_nothing_of_the_address() {
    for (refused, scheme, class) in [
        ("https://secret.example.com/inbox?token=abc#x", "https", "public"),
        ("http://127.0.0.1:8080/x", "http", "loopback"),
        ("http://[::1]:1420/", "http", "loopback"),
        ("http://[::ffff:127.0.0.1]/", "http", "loopback"),
        ("http://localhost:3000/", "http", "loopback"),
        ("http://localhost./", "http", "loopback"),
        ("https://tauri.localhost/", "https", "loopback"),
        ("http://0.0.0.0:8080/", "http", "loopback"),
        ("http://tauri.localhost.evil/", "http", "public"),
        ("http://192.168.1.10/", "http", "private"),
        ("http://10.1.2.3/", "http", "private"),
        ("http://172.16.0.1/", "http", "private"),
        ("http://169.254.169.254/latest/meta-data/", "http", "private"),
        ("http://[fd00::1]/", "http", "private"),
        ("http://[fe80::1]/", "http", "private"),
        ("file:///home/someone/mail.eml", "file", "none"),
        ("data:text/html,<p>hello</p>", "data", "none"),
        ("javascript:alert(document.cookie)", "javascript", "none"),
        ("about:blank", "about", "none"),
        ("blob:tauri://localhost/0b0f2b1e-0000-4000-8000-000000000000", "blob", "none"),
        ("tauri://evil/", "tauri", "public"),
        ("mailto:someone@example.test", "mailto", "none"),
        ("x-token-0123456789abcdef://host.example/", "other", "public"),
    ] {
        assert_eq!(
            refusal_line(&url(refused)),
            format!(r#"{{"service":"shell","event":"navigation_refused","scheme":"{scheme}","hostClass":"{class}"}}"#),
            "{refused}"
        );
    }
}

#[test]
fn a_refused_address_goes_to_the_link_door_only_when_the_door_takes_it() {
    let link = url("https://example.com/a-link-in-a-message");
    let offered = Mutex::new(Vec::<String>::new());
    let takes = |u: &str| {
        offered.lock().unwrap().push(u.to_string());
        true
    };
    let declines = |_: &str| false;
    for (own, home) in EVERY {
        let asked = AtomicBool::new(false);
        let watching = |_: &str| {
            asked.store(true, Ordering::SeqCst);
            true
        };
        assert_eq!(decide(&url(&format!("{home}/")), own, None, Some(&watching)), Verdict::Admitted);
        assert_eq!(decide(&url(MESSAGE_FRAME), own, None, Some(&watching)), Verdict::Admitted);
        assert!(!asked.load(Ordering::SeqCst), "an admitted page was offered to the link door");
        assert_eq!(decide(&link, own, None, Some(&takes)), Verdict::Handed);
        assert_eq!(decide(&link, own, None, Some(&declines)), Verdict::Refused(refusal_line(&link)));
        assert_eq!(decide(&link, own, None, None), Verdict::Refused(refusal_line(&link)));
    }
    assert_eq!(offered.into_inner().unwrap(), vec![link.as_str().to_string(); 3]);
}

#[test]
fn only_the_webview_that_asks_the_guard_about_new_windows_gets_a_link_door() {
    #[cfg(target_os = "macos")]
    assert!(ASKED_ABOUT_NEW_WINDOWS);
    #[cfg(not(target_os = "macos"))]
    assert!(!ASKED_ABOUT_NEW_WINDOWS);
    let menu = code_of(include_str!("menu.rs"));
    assert!(menu.contains("if !crate::navigation::ASKED_ABOUT_NEW_WINDOWS {"), "menu.rs no longer asks first");
    assert!(menu.contains("crate::engine::link_door(app.clone())"), "the main window lost its link door");
}

/* ── THE CENSUSES ─────────────────────────────────────────────────────────────────────────── */

/// Rust with its comments and its literals' bodies blanked, newlines kept so a line stays true. A
/// small lexer rather than two regexes: a `/*` inside a string is not a comment, and a census that
/// took one for a comment would skip the code after it, builder included.
fn code_of(src: &str) -> String {
    let b = src.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let rest = &b[i..];
        let len = if rest.starts_with(b"//") {
            rest.iter().position(|&c| c == b'\n').unwrap_or(rest.len())
        } else if rest.starts_with(b"/*") {
            block_comment_len(rest)
        } else if let Some(len) = raw_string_len(b, i) {
            len
        } else if rest[0] == b'"' {
            string_len(rest)
        } else if let Some(len) = (rest[0] == b'\'').then(|| char_len(&src[i..])).flatten() {
            len
        } else {
            out.push(rest[0]);
            i += 1;
            continue;
        };
        out.extend(rest[..len].iter().map(|&c| if c == b'\n' { b'\n' } else { b' ' }));
        i += len;
    }
    String::from_utf8(out).expect("blanking keeps the text UTF-8")
}

fn block_comment_len(rest: &[u8]) -> usize {
    let (mut depth, mut j) = (0usize, 0usize);
    while j < rest.len() {
        if rest[j..].starts_with(b"/*") {
            depth += 1;
            j += 2;
        } else if rest[j..].starts_with(b"*/") {
            depth -= 1;
            j += 2;
            if depth == 0 {
                return j;
            }
        } else {
            j += 1;
        }
    }
    rest.len()
}

fn raw_string_len(b: &[u8], i: usize) -> Option<usize> {
    if i > 0 && (b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_') {
        return None;
    }
    let mut j = i + usize::from(b[i] == b'b');
    if b.get(j) != Some(&b'r') {
        return None;
    }
    j += 1;
    let hashes = b[j..].iter().take_while(|&&c| c == b'#').count();
    j += hashes;
    if b.get(j) != Some(&b'"') {
        return None;
    }
    j += 1;
    let close: Vec<u8> = std::iter::once(b'"').chain(std::iter::repeat_n(b'#', hashes)).collect();
    let end = b[j..].windows(close.len()).position(|w| w == close.as_slice())?;
    Some(j + end + close.len() - i)
}

fn string_len(rest: &[u8]) -> usize {
    let mut j = 1;
    while j < rest.len() {
        match rest[j] {
            b'\\' => j += 2,
            b'"' => return j + 1,
            _ => j += 1,
        }
    }
    rest.len()
}

/// A char literal at a `'`, or `None` for a lifetime (`'a`, `'static`).
fn char_len(rest: &str) -> Option<usize> {
    let mut chars = rest.char_indices().skip(1);
    let (_, first) = chars.next()?;
    if first == '\\' {
        return rest.get(3..)?.find('\'').map(|end| 3 + end + 1);
    }
    let (at, second) = chars.next()?;
    (second == '\'').then_some(at + 1)
}

const CONSTRUCTORS: [(&str, &str); 6] = [
    ("WebviewWindowBuilder", "new"),
    ("WebviewWindowBuilder", "from_config"),
    ("WebviewWindow", "builder"),
    ("WebviewBuilder", "new"),
    ("WebviewBuilder", "from_config"),
    ("Webview", "builder"),
];

/// Every place `code` constructs a webview, as (line, born inside `navigation::lock(`).
fn builder_sites(code: &str) -> Vec<(usize, bool)> {
    let b = code.as_bytes();
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut sites = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !ident(b[i]) || (i > 0 && ident(b[i - 1])) {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && ident(b[i]) {
            i += 1;
        }
        let tail: String = code[i..].chars().filter(|c| !c.is_whitespace()).take(160).collect();
        if !constructs(&code[start..i], &tail) {
            continue;
        }
        let path = code[..start].trim_end_matches(|c: char| c.is_ascii_alphanumeric() || c == '_' || c == ':');
        sites.push((code[..start].matches('\n').count() + 1, path.trim_end().ends_with("navigation::lock(")));
    }
    sites
}

fn constructs(name: &str, tail: &str) -> bool {
    let tail = without_turbofish(tail);
    CONSTRUCTORS.iter().filter(|(ty, _)| *ty == name).any(|(_, method)| {
        let after = tail.strip_prefix("::").and_then(|t| t.strip_prefix(method));
        after.is_some_and(|after| after.starts_with('(') || after.starts_with("::<"))
    })
}

fn without_turbofish(tail: &str) -> &str {
    let Some(rest) = tail.strip_prefix("::<") else { return tail };
    let mut depth = 1;
    for (at, c) in rest.char_indices() {
        match c {
            '<' => depth += 1,
            '>' => {
                depth -= 1;
                if depth == 0 {
                    return &rest[at + 1..];
                }
            }
            _ => {}
        }
    }
    tail
}

fn crate_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("the crate's sources") {
        let path = entry.expect("an entry").path();
        if path.is_dir() {
            crate_sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") && !path.to_string_lossy().ends_with("_tests.rs") {
            out.push(path);
        }
    }
}

#[test]
fn every_webview_in_the_crate_is_born_through_the_lock() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    crate_sources(&src, &mut files);
    let (mut sites, mut unlocked) = (Vec::new(), Vec::new());
    for path in &files {
        let name = path.strip_prefix(&src).expect("under src").display().to_string();
        for (line, locked) in builder_sites(&code_of(&fs::read_to_string(path).expect("a source"))) {
            sites.push(format!("{name}:{line}"));
            if !locked {
                unlocked.push(format!("{name}:{line}"));
            }
        }
    }
    assert_eq!(unlocked, Vec::<String>::new(), "a webview built outside navigation::lock");
    for file in ["menu.rs", "updater.rs"] {
        assert!(sites.iter().any(|s| s.starts_with(&format!("{file}:"))), "no window found in {file}; read {sites:?}");
    }
}

#[test]
fn the_census_names_a_webview_built_without_the_lock_in_every_spelling() {
    for planted in [
        "let w = tauri::WebviewWindowBuilder::new(app, \"x\", url).build();",
        "let w = WebviewWindowBuilder::from_config(app, &c)?;",
        "let w = tauri::WebviewWindow::builder(app, \"x\", url);",
        "let v = tauri::webview::WebviewBuilder::new(\"x\", url);",
        "let v = WebviewBuilder::from_config(&c);",
        "let v = tauri::Webview::builder(\"x\", url);",
        "let w = WebviewWindowBuilder::<R, _>::new(app, \"x\", url);",
        "let w = lock(WebviewWindowBuilder::new(app, \"x\", url), c, None);",
        "let glob = \"src/**/*.rs\"; let w = WebviewWindowBuilder::new(app, \"x\", url);",
        "let q = '\"'; let w = WebviewWindowBuilder::new(app, \"x\", url);",
    ] {
        assert_eq!(builder_sites(&code_of(planted)), vec![(1, false)], "{planted}");
    }
}

#[test]
fn the_census_admits_a_locked_webview_and_reads_no_comment_or_string() {
    let locked = "let w = crate::navigation::lock(\n    tauri::WebviewWindowBuilder::new(app, \"x\", url),\n    c,\n    None,\n);";
    assert_eq!(builder_sites(&code_of(locked)), vec![(2, true)]);
    let prose = "// WebviewWindowBuilder::new(app)\n/* WebviewBuilder::new(\"x\") /* nested */ */\n\
                 let s = \"WebviewWindow::builder(\";\nlet r = r#\"Webview::builder(\"#;\n\
                 use tauri::{WebviewWindowBuilder, WebviewUrl};\nfn f<'a>(b: WebviewWindowBuilder<'a, R, M>) {}";
    assert_eq!(builder_sites(&code_of(prose)), Vec::<(usize, bool)>::new());
}

/// Labels of the windows a config leaves for Tauri to create at launch, outside any builder here:
/// `create` defaults to true, so only an explicit `false` keeps a window out of this list.
fn created_by_tauri(config: &serde_json::Value) -> Vec<String> {
    let windows = config["app"]["windows"].as_array().cloned().unwrap_or_default();
    let label = |w: &serde_json::Value| w["label"].as_str().unwrap_or("(no label)").to_string();
    windows.iter().filter(|w| w["create"] != serde_json::json!(false)).map(label).collect()
}

#[test]
fn no_config_window_is_left_for_tauri_to_create_outside_the_lock() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let (mut read, mut windows) = (0, 0);
    for entry in fs::read_dir(dir).expect("the crate") {
        let path = entry.expect("an entry").path();
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if !(name.starts_with("tauri") && name.ends_with(".conf.json")) {
            continue;
        }
        let config: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).expect("a config")).expect("JSON");
        read += 1;
        windows += config["app"]["windows"].as_array().map_or(0, Vec::len);
        assert_eq!(created_by_tauri(&config), Vec::<String>::new(), "{name}");
    }
    assert!(read >= 2 && windows >= 1, "read {read} configs naming {windows} windows: the wrong directory");
    let planted = serde_json::json!({"app": {"windows": [{"label": "a"}, {"label": "b", "create": true}, {"label": "c", "create": false}]}});
    assert_eq!(created_by_tauri(&planted), vec!["a", "b"]);
}
