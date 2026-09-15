//! What WebKitGTK is told this window is: one document, not a browser.
//!
//! The webview is left at `WEBKIT_CACHE_MODEL_WEB_BROWSER` with the back/forward page cache on —
//! the settings a browser with a history and many tabs wants. This window shows exactly one
//! document and has no history to go back to, so both are budget spent on a feature that does not
//! exist. The pair is applied together and asserted together: setting one and not the other is
//! the half-applied form this module exists to make unrepresentable.
//!
//! Linux only. WKWebView has the same pair and is a separate change.

/// How much WebKitGTK should keep for a page it may show again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Model {
    /// One document, shown once. The smallest of the three.
    DocumentViewer,
    /// A document with links followed inside it.
    DocumentBrowser,
    /// A history and many tabs. WebKitGTK's default, and what this window used to ask for.
    WebBrowser,
}

/// The two settings this window asks for, and the only place either is named.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ask {
    pub cache_model: Model,
    /// The back/forward cache. This window never navigates back.
    pub page_cache: bool,
}

/// One window, one document, no history.
pub const ASK: Ask = Ask { cache_model: Model::DocumentViewer, page_cache: false };

/// Anything the ask can be carried to. The shipped one is the webview; the tests' one records
/// what it was asked, so a pair applied by halves fails rather than passes quietly.
pub trait Sink {
    fn set_cache_model(&mut self, model: Model);
    fn set_page_cache(&mut self, enabled: bool);
}

/// Carry the whole ask. Both calls, always, in this order.
pub fn apply_to<S: Sink>(sink: &mut S, ask: Ask) {
    sink.set_cache_model(ask.cache_model);
    sink.set_page_cache(ask.page_cache);
}

#[cfg(target_os = "linux")]
mod gtk_sink {
    use super::{Ask, Model, Sink};
    use webkit2gtk::{CacheModel, SettingsExt, WebContextExt, WebViewExt};

    impl From<Model> for CacheModel {
        fn from(m: Model) -> Self {
            match m {
                Model::DocumentViewer => CacheModel::DocumentViewer,
                Model::DocumentBrowser => CacheModel::DocumentBrowser,
                Model::WebBrowser => CacheModel::WebBrowser,
            }
        }
    }

    struct WebKit<'a>(&'a webkit2gtk::WebView);

    impl Sink for WebKit<'_> {
        fn set_cache_model(&mut self, model: Model) {
            if let Some(context) = WebViewExt::context(self.0) {
                context.set_cache_model(model.into());
            }
        }
        fn set_page_cache(&mut self, enabled: bool) {
            if let Some(settings) = WebViewExt::settings(self.0) {
                settings.set_enable_page_cache(enabled);
            }
        }
    }

    /// Apply the ask to the app's one window, and SAY SO when it cannot be applied. A budget that
    /// silently failed to be asked for reads exactly like one that was granted, which is the shape
    /// this whole module is a fix for — so both the missing window and the refused call are named.
    pub fn apply<R: tauri::Runtime>(app: &tauri::AppHandle<R>, ask: Ask) {
        use tauri::Manager;
        let Some(window) = app.get_webview_window("main") else {
            eprintln!("ohmail: no main window to ask for a webview budget");
            return;
        };
        if let Err(e) = window.with_webview(move |platform| {
            let view = platform.inner();
            super::apply_to(&mut WebKit(&view), ask);
        }) {
            eprintln!("ohmail: the webview budget was not applied: {e}");
        }
    }
}

/// Ask WebKitGTK for this window's budget. Off Linux this is nothing yet.
pub fn apply<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(target_os = "linux")]
    gtk_sink::apply(app, ASK);
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

#[cfg(test)]
#[path = "webview_budget_tests.rs"]
mod tests;
