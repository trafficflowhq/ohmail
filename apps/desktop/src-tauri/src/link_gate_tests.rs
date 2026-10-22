//! The gesture gate (`link_gate.rs`): the activation each engine's mark answers, and, from the
//! sources on every platform, that each engine reads its own mark, that macOS alone takes tauri's
//! `window.open` door, and that the gate is armed once the window exists. The engines' own
//! behaviour is measured live (a real click, Enter on a focused link, a script's open); these hold
//! the wiring that measurement depends on.

use super::*;

/// Source with its comment lines removed, so a needle is code and never prose.
fn code(src: &str) -> String {
    src.lines().filter(|line| !line.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
}

/// The body of the item that starts at `signature`, to the brace that closes it.
fn body_of<'a>(src: &'a str, signature: &str) -> &'a str {
    let at = src.find(signature).unwrap_or_else(|| panic!("{signature} is not in the source"));
    let open = at + src[at..].find('{').expect("an opening brace");
    let mut depth = 0usize;
    for (offset, c) in src[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &src[open..=open + offset];
                }
            }
            _ => {}
        }
    }
    panic!("{signature} does not close")
}

/// THE MARKS, AND THE FAIL-CLOSED ONE. Mutations: invert either helper → its rows go red; read
/// the macOS preference the wrong way round → a window opened by script reads as the person's.
#[test]
fn each_engines_mark_is_the_persons_or_a_scripts() {
    assert_eq!(activation_of(true), Activation::Person);
    assert_eq!(activation_of(false), Activation::Script);
    // WKWebView asks only during a gesture while scripts may not open windows; when they may,
    // any request could be a script's.
    assert_eq!(of_popup_policy(false), Activation::Person);
    assert_eq!(of_popup_policy(true), Activation::Script);
    assert_eq!(Activation::of(true), Activation::Person);
    assert_eq!(Activation::of(false), Activation::Script);
}

#[test]
fn a_failure_to_arm_is_one_line_with_a_reason() {
    assert_eq!(
        unarmed_line("no_window"),
        r#"{"service":"shell","event":"link_gate","armed":false,"reason":"no_window"}"#
    );
}

/// WEBKITGTK: the preference pinned, every `create` routed by its own `is_user_gesture`, and no
/// view ever answered. Mutation: route with a constant activation → the gesture needle goes red.
#[test]
fn webkitgtk_reads_is_user_gesture_and_raises_no_window() {
    let gate = code(include_str!("link_gate.rs"));
    let linux = body_of(&gate, "#[cfg(target_os = \"linux\")]\nfn hook<");
    assert!(linux.contains("set_javascript_can_open_windows_automatically(false)"), "the preference is not pinned");
    assert!(linux.contains("connect_create("), "no create handler");
    assert!(
        linux.contains("route_and_deliver(&app, url.as_str(), activation_of(action.is_user_gesture()))"),
        "a create request is not routed by its own gesture mark"
    );
    assert!(linux.contains("        None\n    });"), "the create handler answers a view");
}

/// WEBVIEW2: the request's `IsUserInitiated`, a handler of the shell's own after wry's, and the
/// window denied. Mutation: drop `SetHandled(true)` or read a constant → red.
#[test]
fn webview2_reads_is_user_initiated_and_denies() {
    let gate = code(include_str!("link_gate.rs"));
    let windows = body_of(&gate, "#[cfg(target_os = \"windows\")]\nfn hook<");
    assert!(windows.contains("args.IsUserInitiated(&mut by_person)"), "IsUserInitiated is not read");
    assert!(
        windows.contains("route_and_deliver(&app, &url, activation_of(by_person.as_bool()))"),
        "the request is not routed by its own activation"
    );
    assert!(windows.contains("args.SetHandled(true)"), "the window is not denied");
    assert!(windows.contains("add_NewWindowRequested(&handler, &mut token)"), "the handler is not registered");
}

/// WKWEBVIEW: the main window built with scripts unable to open windows, a new window (no target
/// frame) answered in front of wry's delegate with the live preference and cancelled, and every
/// other selector forwarded rather than listed. Mutation: forward a new window to wry's delegate,
/// or read the preference once at build → red.
#[test]
fn wkwebview_takes_new_windows_in_front_of_wrys_delegate() {
    let mac = code(include_str!("link_gate_macos.rs"));
    let configuration = body_of(&mac, "pub fn configuration(");
    assert!(configuration.contains("setJavaScriptCanOpenWindowsAutomatically(false)"), "scripts may open windows");
    let decide = body_of(&mac, "fn decide_policy(");
    assert!(decide.contains("action.targetFrame() }.is_none()"), "a new window is not told apart");
    assert!(
        decide.contains("javaScriptCanOpenWindowsAutomatically()")
            && decide.contains("crate::link_gate::of_popup_policy(can_open)"),
        "the activation is not the live preference"
    );
    let new_window = &decide[..decide.find("return;").expect("the new-window arm returns")];
    assert!(new_window.contains("WKNavigationActionPolicy::Cancel"), "a new window is raised");
    assert!(!new_window.contains("webView_decidePolicyForNavigationAction"), "a new window goes to wry's delegate");
    assert!(mac.contains("#[unsafe(method(respondsToSelector:))]"), "wry's selectors are not answered");
    assert!(mac.contains("#[unsafe(method(forwardingTargetForSelector:))]"), "wry's selectors are not forwarded");
    assert!(mac.contains("let _ = Retained::into_raw(gate);"), "the weakly held gate is not kept");
}

/// THE BUILD: tauri's `window.open` door on macOS and nowhere else (WebKitGTK's and WebView2's
/// requests reach the gate, and a second handler would route each one twice), the configuration on
/// macOS, and the gate armed after the window exists. Mutation: attach `on_new_window` under the
/// feature alone → red; arm before `build()` → red.
#[test]
fn the_main_window_takes_tauris_door_on_macos_only_and_is_armed_after_it_is_built() {
    let menu = code(include_str!("menu.rs"));
    let build = body_of(&menu, "fn build_main_window<");
    let gated = "#[cfg(all(feature = \"local-engine\", target_os = \"macos\"))]\n    let builder = {";
    let at = build.find(gated).expect("the macOS arm of the build");
    assert_eq!(build.matches(".on_new_window(").count(), 1, "on_new_window is attached more than once");
    let door = build.find(".on_new_window(").expect("the window.open door");
    assert!(door > at && door < build[at..].find("};").map_or(0, |end| at + end), "on_new_window is not macOS only");
    assert!(build.contains("with_webview_configuration(configuration)"), "macOS takes WebKit's default");
    let built = build.find("builder.build()?;").expect("the build");
    let armed = build.find("crate::link_gate::arm(app.handle());").expect("the gate is never armed");
    assert!(armed > built, "the gate is armed before the window exists");

    let engine = code(include_str!("engine.rs"));
    let at = engine.find("pub fn on_new_window<").expect("tauri's door");
    assert!(
        engine[..at].trim_end().ends_with("#[cfg(all(feature = \"local-engine\", target_os = \"macos\"))]"),
        "on_new_window is compiled beyond macOS"
    );
    assert!(body_of(&engine, "pub fn on_new_window<").contains("crate::link_gate::opener_activation(&features)"));
}
