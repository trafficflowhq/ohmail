//! The auto-updater — Rust-side, and deliberately nowhere near the webview.
//!
//! ── WHY THIS LIVES IN RUST AND NOT IN THE UI ──────────────────────────────────
//!
//! The shell's promise is that the webview reaches nothing: `capabilities/main.json`
//! grants it no permission, its CSP is `connect-src 'none'`, and `offline-guard.ts`
//! seals `fetch`/`XMLHttpRequest`/`WebSocket` inside the page. Putting a
//! "Check for updates" button in the React UI would mean granting the webview an
//! updater permission and breaking all of that. So the updater lives entirely
//! here, and its only trigger is a NATIVE menu item ("Check for Updates…"). The
//! webview gains nothing; the PROCESS makes one deliberate request, and only when
//! the user asks. It is symmetric with the macOS client, where the same command
//! is a menu item too.
//!
//! ── WHAT IT WILL AND WILL NOT DO ──────────────────────────────────────────────
//!
//!   * ONE endpoint, pinned in `tauri.conf.json` (`plugins.updater.endpoints`):
//!     the project's own GitHub Releases `latest.json` feed, over HTTPS. Nothing
//!     else is reachable.
//!   * NOTIFY-AND-INSTALL, never silent. The user is asked before a byte is
//!     installed, and asked again before the restart that finishes it.
//!   * EVERY payload is minisign-verified against `plugins.updater.pubkey` by
//!     `tauri-plugin-updater` before it is allowed to install — a tampered
//!     payload is refused. That verification, and the committed key material it
//!     runs against, is exercised in `updater_tests.rs`.
//!   * A DOWNGRADE (or a reinstall of the same version) is refused. The plugin
//!     already applies that rule when it decides whether to offer an update at
//!     all; `should_offer` re-applies it, on the exact version we are about to
//!     install, because an updater is a remote-code path and the comparison is
//!     ours to get right.
//!
//! The menu item that triggers it is built by `menu.rs`, which owns the whole bar;
//! this module owns its id, the handler for it, and everything below that.
//!
//! The feed itself (`latest.json` and the signed artifacts it points at) is
//! produced and published by the release pipeline — this module is only the
//! client's side of that contract. The feed schema it expects is tauri's own:
//! `{ "version", "notes", "pub_date", "platforms": { "<target>-<arch>":
//! { "signature", "url" } } }`.

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

/// The id the menu item carries and the menu-event handler matches on.
pub const CHECK_FOR_UPDATES_ID: &str = "check-for-updates";

/// Register the updater, the dialog it prompts through, and the handler for its
/// menu item. Called from `main.rs` in EVERY build — the updater ships in the
/// published binary, unlike the feature-gated engine.
///
/// THE MENU ITSELF IS NOT BUILT HERE ANY MORE, and the move was forced rather
/// than tidied: a menu is installed from `Builder::setup`, and a second `setup`
/// on the same builder REPLACES the first with nothing failing to say so. Once
/// the app grew a second menu (navigation, under the engine feature) two files
/// installing menus would have meant one of them silently winning. `menu.rs`
/// owns the bar and contributes this item by id; `on_menu_event` genuinely
/// appends, so the handler below is still this module's own.
pub fn attach<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|app, event| {
            if event.id().as_ref() == CHECK_FOR_UPDATES_ID {
                // User-initiated: report "you're up to date" as well as offering
                // an update. A scheduled/startup check would call this with
                // `user_initiated = false` so it stays silent when there is
                // nothing to offer — that is the seam a later slice hangs off.
                check(app.clone(), true);
            }
        })
}

/// Check the pinned feed and, if there is a newer signed release, notify and —
/// on consent — install it. Runs off the main thread so the menu returns at
/// once; all UI is native dialogs.
fn check<R: Runtime>(app: AppHandle<R>, user_initiated: bool) {
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(e) => {
                notify(&app, "ohmail update", &format!("The updater could not start: {e}"));
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => prompt_and_install(app, update).await,
            Ok(None) => {
                if user_initiated {
                    notify(&app, "No updates", "ohmail is up to date.");
                }
            }
            Err(e) => notify(&app, "ohmail update", &format!("The update check failed: {e}")),
        }
    });
}

/// The consent-gated install. The signature check has already been arranged by
/// the plugin (it verifies against `plugins.updater.pubkey` during the download);
/// what this adds is the version gate and the two consent prompts.
async fn prompt_and_install<R: Runtime>(app: AppHandle<R>, update: tauri_plugin_updater::Update) {
    // Defense-in-depth downgrade guard. If either version fails to parse we do
    // NOT fall through to installing — a feed advertising an unparseable version
    // is exactly the kind of thing an updater must not act on.
    match (
        semver::Version::parse(&update.current_version),
        semver::Version::parse(&update.version),
    ) {
        (Ok(installed), Ok(candidate)) if should_offer(&installed, &candidate) => {}
        _ => {
            notify(
                &app,
                "ohmail update",
                &format!(
                    "Ignoring offered version {}: it is not newer than the installed {}.",
                    update.version, update.current_version
                ),
            );
            return;
        }
    }

    let version = update.version.clone();
    let consented = app
        .dialog()
        .message(format!(
            "ohmail {version} is available. Install it now? ohmail will restart to finish."
        ))
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install".into(),
            "Later".into(),
        ))
        .blocking_show();
    if !consented {
        return;
    }

    match update.download_and_install(|_downloaded, _total| {}, || {}).await {
        Ok(()) => {
            let restart = app
                .dialog()
                .message(format!(
                    "ohmail {version} was installed. Restart now to use it?"
                ))
                .title("Update installed")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Restart".into(),
                    "Later".into(),
                ))
                .blocking_show();
            if restart {
                app.restart();
            }
        }
        Err(e) => notify(&app, "ohmail update", &format!("The update failed to install: {e}")),
    }
}

/// A single-button native notice.
fn notify<R: Runtime>(app: &AppHandle<R>, title: &str, message: &str) {
    app.dialog().message(message).title(title).blocking_show();
}

/// Offer `candidate` only if it is strictly newer than what is installed. Equal
/// (a reinstall of the same release) and older (a downgrade) are both refused.
/// This is the whole of the downgrade rule, and it is a plain semver comparison
/// because the version is now bare semver everywhere — there is no `-preview`
/// pre-release suffix left to make the ordering subtle.
pub fn should_offer(installed: &semver::Version, candidate: &semver::Version) -> bool {
    candidate > installed
}

#[cfg(test)]
#[path = "updater_tests.rs"]
mod tests;
