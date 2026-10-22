//! THE GESTURE GATE. A link leaves for the person's browser only as the webview's own new-window
//! request, and only when the webview itself counted a click or a key press of the person's behind
//! it. Nothing is minted for the page (a script in it could read a token); each engine marks a
//! request itself, and counts an assistive press as the person's:
//!
//!  · WebKitGTK: `is_user_gesture()` on the request's navigation action, read in the `create`
//!    signal. WebKit sets it while it handles a trusted pointer, key or AT-SPI press, and carries
//!    it through that event's own timers and promises for under about a second.
//!    `javascript-can-open-windows-automatically` is pinned off (its default), so a script's popup
//!    never reaches the signal.
//!  · WKWebView (macOS): the same WebKit flag, with no public reader per request. With
//!    `javaScriptCanOpenWindowsAutomatically` off (macOS defaults it on; the main window is built
//!    with it off) WebKit asks about a new window only during a gesture, so the preference, read
//!    live at each request, is the activation, and on is a script's. `link_gate_macos.rs` answers
//!    a new window (an action with no target frame) in front of wry's delegate, which keeps every
//!    other navigation; tauri's `window.open` door is `engine::on_new_window`.
//!  · WebView2 (Windows): `IsUserInitiated` on `NewWindowRequested`, Chromium's transient
//!    activation (about 5 s, one popup per activation).
//!
//! Every request goes through `engine::route_and_deliver` and is denied: no second window exists.
//! Arming is asynchronous; until it lands, and if it never does, no link opens. WebKitGTK raises
//! no window without a `create` handler, wry's own WebView2 handler denies, and on macOS wry's
//! delegate hands the request to the navigation lock, which refuses it. A failure to arm is one
//! log line.

use crate::engine::Activation;

#[cfg(target_os = "macos")]
#[path = "link_gate_macos.rs"]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{configuration, opener_activation};

/// The request's own mark, where the engine has one (WebKitGTK's `is_user_gesture`, WebView2's
/// `IsUserInitiated`).
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn activation_of(user_gesture: bool) -> Activation {
    Activation::of(user_gesture)
}

/// WKWebView's answer: with `javaScriptCanOpenWindowsAutomatically` off a request comes only from
/// a gesture; on, any script could have raised it, so it is a script's.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn of_popup_policy(can_open_automatically: bool) -> Activation {
    Activation::of(!can_open_automatically)
}

/// The line a failure to arm writes, in the shell's JSON shape.
pub fn unarmed_line(reason: &str) -> String {
    format!("{{\"service\":\"shell\",\"event\":\"link_gate\",\"armed\":false,\"reason\":\"{reason}\"}}")
}

fn unarmed(reason: &str) {
    crate::engine::log_json_line(&unarmed_line(reason));
}

/// Arm the main window's gate, once, from `menu.rs` after the window is built.
pub fn arm<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        unarmed("no_window");
        return;
    };
    let handle = app.clone();
    if window.with_webview(move |platform| hook(&platform, handle)).is_err() {
        unarmed("no_webview");
    }
}

/// WebKitGTK: pin the preference, then route every `create` and answer it with no view.
#[cfg(target_os = "linux")]
fn hook<R: tauri::Runtime>(platform: &tauri::webview::PlatformWebview, app: tauri::AppHandle<R>) {
    use webkit2gtk::{SettingsExt, URIRequestExt, WebViewExt};
    let view = platform.inner();
    match WebViewExt::settings(&view) {
        Some(settings) => settings.set_javascript_can_open_windows_automatically(false),
        None => unarmed("no_settings"),
    }
    view.connect_create(move |_, action| {
        if let Some(url) = action.request().and_then(|request| request.uri()) {
            crate::engine::route_and_deliver(&app, url.as_str(), activation_of(action.is_user_gesture()));
        }
        None
    });
}

/// WebView2: a second `NewWindowRequested` handler, after wry's, which has already denied the
/// window; this one reads the address and the activation, routes, and stays denied.
#[cfg(target_os = "windows")]
fn hook<R: tauri::Runtime>(platform: &tauri::webview::PlatformWebview, app: tauri::AppHandle<R>) {
    let handler = webview2_com::NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let mut uri = Default::default();
        unsafe { args.Uri(&mut uri)? };
        let url = webview2_com::take_pwstr(uri);
        let mut by_person = Default::default();
        unsafe { args.IsUserInitiated(&mut by_person)? };
        crate::engine::route_and_deliver(&app, &url, activation_of(by_person.as_bool()));
        unsafe { args.SetHandled(true) }
    }));
    let mut token = 0i64;
    let registered = unsafe {
        platform.controller().CoreWebView2().and_then(|core| core.add_NewWindowRequested(&handler, &mut token))
    };
    if registered.is_err() {
        unarmed("no_new_window_handler");
    }
}

/// WKWebView: the gate in front of wry's navigation delegate (`link_gate_macos.rs`).
#[cfg(target_os = "macos")]
fn hook<R: tauri::Runtime>(platform: &tauri::webview::PlatformWebview, app: tauri::AppHandle<R>) {
    let route: macos::Route = Box::new(move |url, activation| {
        crate::engine::route_and_deliver(&app, url, activation);
    });
    if let Err(reason) = macos::install(platform.inner(), route) {
        unarmed(reason);
    }
}

/// No gate is written for any other webview, so no link opens there.
#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn hook<R: tauri::Runtime>(_platform: &tauri::webview::PlatformWebview, _app: tauri::AppHandle<R>) {
    unarmed("unsupported_platform");
}

#[cfg(test)]
#[path = "link_gate_tests.rs"]
mod tests;
