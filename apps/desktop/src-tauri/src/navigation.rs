//! THE NAVIGATION LOCK. Tauri admits every navigation a window does not refuse itself
//! (`manager/webview.rs`), so a script that ever ran in a window could take it to a page that none
//! of SECURITY.md's other locks governs. Every webview builder in this crate is born through
//! [`lock`] (`navigation_tests.rs` holds every builder to it), and [`admits`] is the one rule each
//! window's handler applies. A refusal is one line naming the scheme's class and the host's, never
//! the address.

use std::borrow::Cow;
use std::net::{Ipv4Addr, Ipv6Addr};
use tauri::http::{header, HeaderValue, Request, Response};
use tauri::{Config, Manager, Runtime, Url, WebviewWindowBuilder};

/// The app's own origin as each platform's webview serves it (Tauri's `tauri_protocol_url`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Own {
    /// `tauri://localhost`: WebKit, on macOS and Linux.
    Scheme,
    /// `http://tauri.localhost`, or `https://` under `useHttpsScheme`: WebView2, on Windows.
    Localhost { https: bool },
}

impl Own {
    /// A platform's spelling: WebView2 serves wry's `http(s)://` workaround, WebKit the scheme.
    pub fn of(webview2: bool, use_https_scheme: bool) -> Own {
        if webview2 {
            Own::Localhost { https: use_https_scheme }
        } else {
            Own::Scheme
        }
    }

    /// This build's, by Tauri's own test (`cfg!(windows) || cfg!(target_os = "android")`).
    pub fn this_build(use_https_scheme: bool) -> Own {
        Own::of(cfg!(any(windows, target_os = "android")), use_https_scheme)
    }

    fn holds(self, url: &Url) -> bool {
        let (scheme, host) = match self {
            Own::Scheme => ("tauri", "localhost"),
            Own::Localhost { https: false } => ("http", "tauri.localhost"),
            Own::Localhost { https: true } => ("https", "tauri.localhost"),
        };
        url.scheme() == scheme
            && url.host_str() == Some(host)
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
    }
}

/// The message body's document: a `srcdoc` frame (`MessageBody.tsx`). WebKit asks this handler
/// about a subframe's load as well as the window's (wry 0.55 filters neither `decide-policy` nor
/// `decidePolicyForNavigationAction` by frame); WebView2 asks only about the top level.
pub const MESSAGE_FRAME: &str = "about:srcdoc";

/// THE PREDICATE: the app's own origin, the message frame, and `devUrl` in a debug build.
pub fn admits(url: &Url, own: Own, dev: Option<&Url>) -> bool {
    own.holds(url) || url.as_str() == MESSAGE_FRAME || dev.is_some_and(|dev| same_origin(url, dev))
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// The `devUrl` a window may load: none in a release build, which serves only its own assets.
pub fn dev_origin(configured: Option<&Url>, debug_build: bool) -> Option<Url> {
    configured.filter(|_| debug_build).cloned()
}

/// A refused navigation goes nowhere, on every platform. A link leaves only as the webview's own
/// new-window request on the person's click (`link_gate.rs`); WKWebView asks this guard about
/// that request too, and the gate answers it before the guard is asked.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Admitted,
    /// Refused, with the one line that says so.
    Refused(String),
}

/// One navigation, decided. Pure, so every arm is driven by test on any platform.
pub fn decide(url: &Url, own: Own, dev: Option<&Url>) -> Verdict {
    if admits(url, own, dev) {
        Verdict::Admitted
    } else {
        Verdict::Refused(refusal_line(url))
    }
}

/// The refusal's line, in the shell's JSON shape: two closed classes and nothing of the address.
pub fn refusal_line(url: &Url) -> String {
    format!(
        "{{\"service\":\"shell\",\"event\":\"navigation_refused\",\"scheme\":\"{}\",\"hostClass\":\"{}\"}}",
        scheme_class(url),
        host_class(url)
    )
}

fn scheme_class(url: &Url) -> &'static str {
    const NAMED: [&str; 10] = ["https", "http", "file", "data", "javascript", "blob", "about", "tauri", "ipc", "mailto"];
    NAMED.into_iter().find(|named| *named == url.scheme()).unwrap_or("other")
}

pub(crate) fn host_class(url: &Url) -> &'static str {
    let Some(host) = url.host_str().map(|h| h.trim_end_matches('.')).filter(|h| !h.is_empty()) else {
        return "none";
    };
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost") {
        return "loopback";
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<Ipv6Addr>() {
        return match ip.to_ipv4_mapped() {
            Some(mapped) => ipv4_class(mapped),
            None if ip.is_loopback() || ip.is_unspecified() => "loopback",
            None if is_local(ip) => "private",
            None => "public",
        };
    }
    bare.parse::<Ipv4Addr>().map_or("public", ipv4_class)
}

fn ipv4_class(ip: Ipv4Addr) -> &'static str {
    if ip.is_loopback() || ip.is_unspecified() {
        "loopback"
    } else if ip.is_private() || ip.is_link_local() {
        "private"
    } else {
        "public"
    }
}

/// Unique-local (`fc00::/7`) or link-local (`fe80::/10`).
fn is_local(ip: Ipv6Addr) -> bool {
    let first = ip.segments()[0];
    first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80
}

/// Where a line goes: `updater.rs`'s split, for its reason.
fn write(line: &str) {
    #[cfg(feature = "local-engine")]
    crate::engine::log_json_line(line);
    #[cfg(not(feature = "local-engine"))]
    crate::frame::note_line(line);
}

/// Every window takes the main window's `useHttpsScheme`: one spelling app-wide, as the CSP
/// overlays and the bridge's prefix already assume.
pub fn uses_https_scheme(config: &Config) -> bool {
    config.app.windows.iter().find(|w| w.label == "main").is_some_and(|w| w.use_https_scheme)
}

/// The handler a window is built with. [`lock`] passes `cfg!(debug_assertions)`.
pub fn guard(config: &Config, debug_build: bool) -> impl Fn(&Url) -> bool + Send + 'static {
    let own = Own::this_build(uses_https_scheme(config));
    let dev = dev_origin(config.build.dev_url.as_ref(), debug_build);
    move |url| match decide(url, own, dev.as_ref()) {
        Verdict::Admitted => true,
        Verdict::Refused(line) => {
            write(&line);
            false
        }
    }
}

/// The policy a file of the app's own that is not a page is answered with.
pub const NON_DOCUMENT_CSP: &str = "default-src 'none'";

/// THE NON-DOCUMENT RULE. Tauri puts the window's policy on its pages only, and a worker is bound
/// by the policy of its own script's response, not the page's: without this, pdf.js's worker
/// (`src/window-pdfjs.ts`) could fetch, import and eval anything. So every response on the app's
/// scheme that is not `text/html` and carries no policy gets `default-src 'none'`. A page ignores
/// the header on a script, a style or a picture it loads; a policy already set is never replaced.
pub fn confine_non_documents(_request: Request<Vec<u8>>, response: &mut Response<Cow<'static, [u8]>>) {
    let headers = response.headers_mut();
    let document = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|essence| essence.trim().eq_ignore_ascii_case("text/html"));
    if !document && !headers.contains_key(header::CONTENT_SECURITY_POLICY) {
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(NON_DOCUMENT_CSP));
    }
}

/// THE ONE WAY A WEBVIEW IS BUILT HERE: the guard, the scheme it was decided for, and the rule
/// above for every file the app serves itself.
pub fn lock<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    config: &Config,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .use_https_scheme(uses_https_scheme(config))
        .on_navigation(guard(config, cfg!(debug_assertions)))
        .on_web_resource_request(confine_non_documents)
}

#[cfg(test)]
#[path = "navigation_tests.rs"]
mod tests;
