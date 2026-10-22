//! The macOS half of the gesture gate (`link_gate.rs`).
//!
//! WKWebView asks its navigation delegate about a new window (an action whose target frame is nil)
//! before it raises one, and with `javaScriptCanOpenWindowsAutomatically` off it asks only during
//! a gesture. wry's delegate hands every action to the navigation lock, so a gate stands in front
//! of it: a new window is routed here, with the live preference as its activation, and cancelled.
//! Every other action, and every other selector wry's delegate answers, goes to it unchanged
//! (`respondsToSelector:` and `forwardingTargetForSelector:`, never a list written out here), so
//! its page-load and pending-script handling keep running.

use std::ffi::c_void;

use block2::Block;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject, Sel};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_web_kit::{
    WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKWebView, WKWebViewConfiguration,
};

use crate::engine::Activation;

/// What the gate does with a new-window request: the shell's route, without the runtime's type.
pub type Route = Box<dyn Fn(&str, Activation)>;

pub struct GateIvars {
    /// wry's own delegate: every navigation that is not a new window, and every other selector.
    inner: Retained<ProtocolObject<dyn WKNavigationDelegate>>,
    route: Route,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and the gate implements no `Drop`.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = GateIvars]
    struct NewWindowGate;

    impl NewWindowGate {
        /// Its own selectors and wry's: WebKit reads these once, when the delegate is set.
        #[unsafe(method(respondsToSelector:))]
        fn responds_to_selector(&self, selector: Sel) -> bool {
            let own: bool = unsafe { msg_send![super(self), respondsToSelector: selector] };
            own || self.ivars().inner.respondsToSelector(selector)
        }

        /// Whatever the gate does not answer itself goes to wry's delegate as it is.
        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target_for_selector(&self, selector: Sel) -> *mut AnyObject {
            let inner = &self.ivars().inner;
            if inner.respondsToSelector(selector) {
                Retained::as_ptr(inner).cast::<AnyObject>().cast_mut()
            } else {
                unsafe { msg_send![super(self), forwardingTargetForSelector: selector] }
            }
        }
    }

    unsafe impl NSObjectProtocol for NewWindowGate {}

    unsafe impl WKNavigationDelegate for NewWindowGate {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_policy(
            &self,
            webview: &WKWebView,
            action: &WKNavigationAction,
            handler: &Block<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            // A new window: routed with the live preference as its activation, and never raised.
            if unsafe { action.targetFrame() }.is_none() {
                let url = unsafe { action.request() }.URL().and_then(|url| url.absoluteString());
                if let Some(url) = url {
                    let can_open = unsafe {
                        webview.configuration().preferences().javaScriptCanOpenWindowsAutomatically()
                    };
                    (self.ivars().route)(&url.to_string(), crate::link_gate::of_popup_policy(can_open));
                }
                handler.call((WKNavigationActionPolicy::Cancel,));
                return;
            }
            // Every other navigation is the lock's, through wry's delegate.
            let inner = &self.ivars().inner;
            if inner.respondsToSelector(sel!(webView:decidePolicyForNavigationAction:decisionHandler:)) {
                unsafe { inner.webView_decidePolicyForNavigationAction_decisionHandler(webview, action, handler) };
            } else {
                handler.call((WKNavigationActionPolicy::Cancel,));
            }
        }
    }
);

/// Stand the gate in front of wry's delegate on the main window's webview, on the main thread.
/// It is leaked once: WKWebView holds its delegate weakly, and the window lives as long as the app.
pub fn install(webview: *mut c_void, route: Route) -> Result<(), &'static str> {
    let mtm = MainThreadMarker::new().ok_or("not_main_thread")?;
    // tauri hands the webview over retained once (`PlatformWebview::inner`); taken back here.
    let webview: Retained<WKWebView> = unsafe { Retained::from_raw(webview.cast()) }.ok_or("no_webview")?;
    let inner = unsafe { webview.navigationDelegate() }.ok_or("no_delegate")?;
    let gate = mtm.alloc::<NewWindowGate>().set_ivars(GateIvars { inner, route });
    let gate: Retained<NewWindowGate> = unsafe { msg_send![super(gate), init] };
    unsafe { webview.setNavigationDelegate(Some(ProtocolObject::from_ref(&*gate))) };
    let _ = Retained::into_raw(gate);
    Ok(())
}

/// The main window's configuration: macOS lets a script open windows unless told otherwise, so
/// the preference is off before the webview exists. `None` off the main thread, where the window
/// keeps WebKit's default and the gate reads every request as a script's.
pub fn configuration() -> Option<Retained<WKWebViewConfiguration>> {
    let Some(mtm) = MainThreadMarker::new() else {
        super::unarmed("not_main_thread");
        return None;
    };
    let configuration = unsafe { WKWebViewConfiguration::new(mtm) };
    unsafe { configuration.preferences().setJavaScriptCanOpenWindowsAutomatically(false) };
    Some(configuration)
}

/// tauri's `window.open` door (`engine::on_new_window`): the opener's live preference.
pub fn opener_activation(features: &tauri::webview::NewWindowFeatures) -> Activation {
    let can_open = unsafe {
        features.opener().webview.configuration().preferences().javaScriptCanOpenWindowsAutomatically()
    };
    super::of_popup_policy(can_open)
}
