//! WHICH VARIANT OF THE APP THIS BINARY IS: the released one, or a nightly preview of the next
//! major version.
//!
//! A preview runs beside a released install on the same computer, and a newer build that opened
//! the released install's store would migrate it, which cannot be taken back. So a preview is a
//! different app to the operating system: its own identifier (`tauri.preview.conf.json`), and with
//! it its own data and log folders, and under the `preview` cargo feature its own keystore item
//! (`engine.rs`), no update of its own (`updater.rs`), no claim on mail links (`default_mail.rs`)
//! and no door to anything but a private or local server (`config.rs`).
//!
//! The identifier comes from a bundler overlay and the rest from a cargo feature, and a build with
//! one and not the other still compiles. [`variant_agrees`] is asked once at startup and refuses
//! such a binary before it has opened anything.

#[cfg(test)]
#[path = "variant_tests.rs"]
mod tests;

/// The identifier of a preview, as `tauri.preview.conf.json` writes it. Not an extension of the
/// released one on purpose: no prefix match or glob over one can reach the other's folder.
pub const PREVIEW_IDENTIFIER: &str = "io.ohmail.preview";

/// Was this binary compiled as a preview?
pub const PREVIEW: bool = cfg!(feature = "preview");

/// Do the bundler's identifier and the cargo feature name the same variant?
///
/// Two refusals: the preview's identifier on a binary compiled without the feature would share
/// the released app's keystore item, and the feature under any other identifier would open that
/// identifier's folder with a preview's code.
pub fn variant_agrees(identifier: &str, preview_feature: bool) -> Result<(), String> {
    match (identifier == PREVIEW_IDENTIFIER, preview_feature) {
        (true, true) | (false, false) => Ok(()),
        (true, false) => Err(format!(
            "this build carries the preview's identifier ({PREVIEW_IDENTIFIER}) but was compiled \
             without the preview feature, so it opens nothing"
        )),
        (false, true) => Err(format!(
            "this build was compiled as a preview but carries the identifier {identifier}, not \
             {PREVIEW_IDENTIFIER}, so it opens nothing"
        )),
    }
}
