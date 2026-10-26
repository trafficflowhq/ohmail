//! How WebKitGTK hands its rendered frames to the window, for this whole process.
//!
//! WebKitGTK passes each painted frame to the window as DMA-BUF buffers or through shared memory.
//! On a Hyprland desktop, a letter's frame in the Receipts stream lost its content after a scroll
//! while the card around it stayed drawn. No rig has reproduced it, so whether this switch cures it
//! is not proven; it costs a copy of each frame, so it is asked for on Hyprland only and every other
//! session keeps the default. WebKit reads the variable when the first web context is created. A
//! value the person set, `0` included, is left alone.

use crate::frame;

pub const FORCE_SHM: &str = "WEBKIT_DMABUF_RENDERER_FORCE_SHM";

/// The variable to set, or `None` when the environment already names it or GTK will not run on
/// Hyprland's Wayland.
pub fn plan(read: impl Fn(&str) -> Option<String>) -> Option<(&'static str, &'static str)> {
    if read(FORCE_SHM).is_some() || frame::compositor(&read) != Some("hyprland") {
        return None;
    }
    // GTK takes the first backend GDK_BACKEND lists; x11 first means XWayland.
    let first = read("GDK_BACKEND").map(|b| b.split(',').next().unwrap_or("").trim().to_string());
    (first.as_deref() != Some("x11")).then_some((FORCE_SHM, "1"))
}

/// Set it for this process, before any web context exists. Linux only: no other webview reads it.
pub fn apply() {
    if !cfg!(target_os = "linux") {
        return;
    }
    if let Some((name, value)) = plan(|name| std::env::var_os(name).map(|v| v.to_string_lossy().into_owned())) {
        std::env::set_var(name, value);
    }
}

#[cfg(test)]
#[path = "webkit_buffers_tests.rs"]
mod tests;
