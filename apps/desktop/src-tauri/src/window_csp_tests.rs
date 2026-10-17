//! The main window's content policy as Tauri itself reads it: `tauri.conf.json` merged with each
//! platform's overlay by `tauri-utils`' `parse::read_from` (the merge codegen compiles in), parsed
//! as a whole `Config`. Each platform's `connect-src` names its webview's one spelling of the
//! in-process command scheme, every other directive is the base's, and the base stays `'none'`.
//! `desktop-shell.test.ts` holds the same census against `src/window-csp.ts` and the built meta.

use std::path::Path;
use tauri::utils::config::{parse, Config, Csp};
use tauri::utils::platform::Target;

fn policy_of(config: Config, what: &str) -> String {
    match config.app.security.csp {
        Some(Csp::Policy(policy)) => policy,
        other => panic!("{what}: the CSP is not one policy string: {other:?}"),
    }
}

/// What a build for `target` compiles in, and how many config files the merge read.
fn compiled_for(target: Target) -> (String, usize) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let (merged, files) = parse::read_from(target, dir).expect("the config and its overlay parse");
    let config: Config = serde_json::from_value(merged).expect("the merged config is a Tauri config");
    (policy_of(config, &target.to_string()), files.len())
}

fn base() -> String {
    let config: Config = serde_json::from_str(include_str!("../tauri.conf.json")).expect("the base parses");
    policy_of(config, "the base")
}

fn sources<'a>(policy: &'a str, name: &str) -> Option<Vec<&'a str>> {
    policy.split(';').map(str::trim).find_map(|directive| {
        let mut words = directive.split_whitespace();
        (words.next() == Some(name)).then(|| words.collect())
    })
}

#[test]
fn each_overlay_names_its_webviews_spelling_of_the_command_scheme_and_nothing_else() {
    let base = base();
    for (target, own) in [
        (Target::Linux, "ipc:"),
        (Target::MacOS, "ipc:"),
        (Target::Windows, "http://ipc.localhost"),
    ] {
        let (policy, files) = compiled_for(target);
        assert_eq!(files, 2, "{target}: the base and its overlay were both read");
        assert_eq!(sources(&policy, "connect-src"), Some(vec![own]), "{target}: {policy}");
        let expected = base.replace("connect-src 'none';", &format!("connect-src {own};"));
        assert_eq!(policy, expected, "{target}: only connect-src differs from the base");
    }
}

#[test]
fn the_base_is_closed_and_a_platform_without_an_overlay_keeps_it() {
    assert_eq!(sources(&base(), "connect-src"), Some(vec!["'none'"]));
    let (policy, files) = compiled_for(Target::Android);
    assert_eq!(files, 1, "no Android overlay exists");
    assert_eq!(policy, base());
}
