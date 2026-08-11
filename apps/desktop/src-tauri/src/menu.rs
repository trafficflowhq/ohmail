//! THE MENU BAR — the one piece of user interface this process owns.
//!
//! Everything else a person sees is React inside the webview, deliberately: one design system,
//! one set of screens, and no second look-and-feel to keep in step. A menu bar is the exception
//! because it cannot be anything else — it is drawn by the operating system, it is where a Mac
//! user looks for an application's commands, and its accelerators have to work before the page
//! has focus.
//!
//! ── ONE OWNER, BECAUSE `Builder::setup` REPLACES AND DOES NOT COMPOSE ───────────────────────
//!
//! The menu is installed from `setup`, and a second `setup` on the same builder silently
//! overwrites the first — so a file that installed a menu of its own would delete this one with
//! nothing failing to say so. This module is therefore the only place `app.set_menu` is called.
//! `updater.rs` still owns the updater: it contributes the id of its item and handles the event
//! for it, on its own `on_menu_event`, which unlike `setup` genuinely appends.
//!
//! ── WHAT IS IN THE BAR, AND WHY EACH PART IS THERE ─────────────────────────────────────────
//!
//!   * **ohmail** — About, Settings (⌘,), the update item, the platform's hide items, and Quit.
//!     This is where a Mac user looks for an application's own commands, and a bar whose first
//!     menu held two items was the clearest sign this app had no menu worth opening. The update
//!     item's TEXT belongs to `updater.rs`, which changes it as the flow moves — it is the app's
//!     only update affordance, because a button in the page would need a permission the webview
//!     is deliberately not granted.
//!   * **File** — "New Message" on ⌘N, and Close Window. ⌘N is the shortcut every mail client on
//!     the platform has; the shared client binds `c` for the same thing, and both now work.
//!   * **Edit** — the platform's own undo/cut/copy/paste/select-all items. These are not
//!     decoration. On macOS a webview gets ⌘C and ⌘V from the menu bar, so an app with no Edit
//!     menu is an app where you cannot copy a line out of your own mail. They are the system's
//!     items rather than commands of ours: the webview is never told about them.
//!   * **View** — the five places mail lives on ⌘1…⌘5, plus Search and the command palette.
//!   * **Window** — minimize, zoom and full screen, the platform's own.
//!   * **Help** — the keyboard shortcut sheet the client already draws for `?`.
//!
//! Everything that reaches the WEBVIEW is compiled only into the engine-bearing build, because
//! it is the only one whose window is permitted to hear an event: the published preview grants
//! the webview nothing, so those items there would be items that do nothing. What is left in the
//! preview is the platform's own — About, Quit, Edit, Window — every one of which works without
//! the page being told anything.
//!
//! ── HOW A MENU ITEM REACHES THE CLIENT ─────────────────────────────────────────────────────
//!
//! It does not act. It EMITS, on one of two events, and the frontend does the rest:
//!
//!   * `menu:navigate` carries a VIEW ID, and the frontend calls the same navigation function
//!     its rail, its command palette and its bare number keys call;
//!   * `menu:command` carries a COMMAND ID — compose, settings, search, the palette, the
//!     shortcut sheet — and the frontend runs whatever it already runs for that command.
//!
//! Two events rather than one union, because the two payloads are different KINDS of name and
//! the frontend closes each union separately: a shell one version ahead can name a view this
//! bundle does not have, or a command it does not have, and in both cases the honest response is
//! to do nothing rather than to guess. Sharing one event would make an unknown view and an
//! unknown command indistinguishable.
//!
//! The alternative — the shell driving the webview's location, or synthesising key events — would
//! be a second implementation of routing and of the keymap, in a language that cannot see the
//! client's own rules about either.

use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// The event a chosen navigation item emits. The frontend's `native.ts` listens for this name.
pub const MENU_NAVIGATE_EVENT: &str = "menu:navigate";

/// What a navigation item's id starts with, so one prefix test tells them from every other item.
pub const NAVIGATE_PREFIX: &str = "view:";

/// The event a chosen COMMAND item emits. Distinct from navigation — see the module header.
pub const MENU_COMMAND_EVENT: &str = "menu:command";

/// What a command item's id starts with. A different prefix, so one test tells the two apart.
pub const COMMAND_PREFIX: &str = "cmd:";

/// The navigable places, in menu order — id, label, accelerator.
///
/// FIVE, and the same five the client's rail lists first: the three streams, the Screener and the
/// triage piles. Search has its own key, Settings is not somewhere anybody flicks to, and tags
/// are the user's own and change while the app is open — a menu rebuilt from them would be a
/// menu that moves under the pointer.
///
/// The ids are the frontend's route names. They are written down in two languages, here and in
/// `src/native.ts`, because a Rust binary and a TypeScript bundle share no artifact to import
/// one from; what keeps them in step is that the frontend REFUSES a payload it does not
/// recognise, so a name that drifts is an item that does nothing rather than an item that lands
/// somewhere wrong.
#[cfg(feature = "local-engine")]
pub const VIEWS: [(&str, &str, &str); 5] = [
    ("ohbox", "Ohbox", "CmdOrCtrl+1"),
    ("reads", "Reads", "CmdOrCtrl+2"),
    ("receipts", "Receipts", "CmdOrCtrl+3"),
    ("screener", "Screener", "CmdOrCtrl+4"),
    ("triage", "Answer Later", "CmdOrCtrl+5"),
];

/// The view a menu id names, or `None` for every other item in the bar.
///
/// Split out from the handler so the rule can be tested without starting a windowing system. It
/// is deliberately a prefix test and not a list membership test: the ids are composed from
/// [`VIEWS`] at build time, and a second enumeration here would be a second place for the list to
/// be wrong.
pub fn navigate_target(id: &str) -> Option<&str> {
    id.strip_prefix(NAVIGATE_PREFIX).filter(|view| !view.is_empty())
}

/// The command a menu id names, or `None` for every other item in the bar.
///
/// The same shape as [`navigate_target`] and separate from it on purpose: the two payloads name
/// different kinds of thing and the frontend closes a different union for each.
pub fn command_target(id: &str) -> Option<&str> {
    id.strip_prefix(COMMAND_PREFIX).filter(|cmd| !cmd.is_empty())
}

/// The commands the bar can ask the client to run — id, label, accelerator.
///
/// Every one of them is something the client ALREADY does, reached by a key or by the palette.
/// The menu is a second way to the one implementation, never a second implementation: an id here
/// with no handler in `src/native.ts` is an item that does nothing, which is why the frontend
/// refuses a payload it does not recognise rather than falling back to something plausible.
///
/// ⌘, and ⌘N are the platform's conventions and are not negotiable on a Mac. ⌘F and ⌘K are the
/// client's own — the search view and the command palette — given menu entries because a command
/// nobody can find is a command that does not exist. The shortcut sheet is on ⌘/ beside the `?`
/// the client already binds.
#[cfg(feature = "local-engine")]
pub const COMMANDS: [(&str, &str, &str); 5] = [
    ("compose", "New Message", "CmdOrCtrl+N"),
    ("settings", "Settings…", "CmdOrCtrl+,"),
    ("search", "Search Mail…", "CmdOrCtrl+F"),
    ("palette", "Command Palette…", "CmdOrCtrl+K"),
    ("shortcuts", "Keyboard Shortcuts", "CmdOrCtrl+/"),
];

/// One command item, by id, built from [`COMMANDS`].
///
/// Looked up rather than positional: the menus below place these in four different submenus, and
/// an index would make a reordering of the table silently move Settings into the File menu.
#[cfg(feature = "local-engine")]
fn command_item<R: Runtime>(app: &AppHandle<R>, id: &str) -> tauri::Result<tauri::menu::MenuItem<R>> {
    let (_, label, accelerator) = COMMANDS
        .iter()
        .find(|(cmd, _, _)| *cmd == id)
        .expect("ohmail: a menu asked for a command that is not in COMMANDS");
    MenuItemBuilder::with_id(format!("{COMMAND_PREFIX}{id}"), label)
        .accelerator(accelerator)
        .build(app)
}

/// Install the menu, and route the items this module owns.
///
/// Called from `main.rs` in EVERY build. `on_menu_event` appends rather than replaces, so this
/// handler and the updater's coexist; `setup` does not, which is why this is the only file that
/// installs a menu.
pub fn attach<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            // A failed emit is not worth taking the app down for: the window may be closing,
            // and the cost is one menu item that did nothing.
            if let Some(view) = navigate_target(id) {
                let _ = app.emit(MENU_NAVIGATE_EVENT, view);
            } else if let Some(command) = command_target(id) {
                let _ = app.emit(MENU_COMMAND_EVENT, command);
            }
        })
        .setup(|app| {
            install(app.handle())?;
            Ok(())
        })
}

/// Build and install the bar.
///
/// Two halves, and the split is the artifact boundary rather than a preference. Everything the
/// PLATFORM performs — About, Quit, Hide, the Edit items, the Window items — is built in every
/// build, because none of it needs the page to be told anything. Everything that reaches the
/// WEBVIEW is behind the feature, because only that build's window is granted the permission to
/// hear an event.
fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    /* THE UPDATE ITEM, built here and SPOKEN FOR ELSEWHERE. Its text is not a constant: it is the
       whole of the app's update interface, so it reports the check, the download and the one press
       that installs, and `updater.rs` owns every one of those sentences. This file decides only
       that it sits in the application menu, which is where a Mac user looks for it. The initial
       text comes from that module too, so the bar and the flow cannot start out disagreeing. */
    let check_item = MenuItemBuilder::with_id(
        crate::updater::CHECK_FOR_UPDATES_ID,
        crate::updater::MENU_LABEL_IDLE,
    )
    .build(app)?;
    crate::updater::adopt_menu_item(app, check_item.clone());

    /* THE PLATFORM'S OWN ABOUT PANEL, not a screen of ours. It reads the bundle's name, version
       and copyright, which is exactly the set of facts an About box is for, and it is drawn by
       the operating system — so it is correct in every build including the one whose webview is
       granted nothing. The fuller "About ohmail" — who publishes this, which build, where the
       privacy pages are — lives in Settings, where a person can copy out of it. */
    let about = AboutMetadataBuilder::new()
        .name(Some("ohmail"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .copyright(Some("Copyright (c) 2026 TrafficFlow GmbH"))
        .build();

    // Shadowed rather than mutated, for the reason the View menu below is: the preview build
    // has no Settings item to add, and a `mut` it never writes to is a warning in that build.
    let app_menu = SubmenuBuilder::new(app, "ohmail").about(Some(about));
    #[cfg(feature = "local-engine")]
    let app_menu = {
        let settings = command_item(app, "settings")?;
        app_menu.separator().item(&settings)
    };
    let app_menu = app_menu
        .separator()
        .item(&check_item)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    // The system's own editing items. Nothing here is a command of ours and nothing reaches the
    // webview as one — the platform applies them to whatever has focus, which is the page.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    /* WINDOW. The platform's items, and the reason they are worth the four lines: without a
       Window menu ⌘M does not minimise and there is no way to full-screen the app from the bar —
       two things every Mac user expects to find and neither of which the page can provide. */
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .fullscreen()
        .build()?;

    let menu = MenuBuilder::new(app).item(&app_menu);

    /* FILE, and it exists for one item. ⌘N is what a mail client is expected to answer with a
       new message, on every platform; the shared client binds `c` for the same action and both
       reach the same place. Close Window is beside it because a File menu with one item in it
       reads as unfinished, and because ⌘W is the other key a window is expected to answer. */
    #[cfg(feature = "local-engine")]
    let menu = {
        let compose = command_item(app, "compose")?;
        let file = SubmenuBuilder::new(app, "File")
            .item(&compose)
            .separator()
            .close_window()
            .build()?;
        menu.item(&file)
    };

    let menu = menu.item(&edit_menu);

    // Shadowed rather than mutated, so the default build declares no `mut` it never uses — the
    // View submenu exists only where a window is permitted to hear about a chosen item.
    #[cfg(feature = "local-engine")]
    let menu = {
        let mut view = SubmenuBuilder::new(app, "View");
        for (id, label, accelerator) in VIEWS {
            let item = MenuItemBuilder::with_id(format!("{NAVIGATE_PREFIX}{id}"), label)
                .accelerator(accelerator)
                .build(app)?;
            view = view.item(&item);
        }
        let search = command_item(app, "search")?;
        let palette = command_item(app, "palette")?;
        view = view.separator().item(&search).item(&palette);
        menu.item(&view.build()?)
    };

    let menu = menu.item(&window_menu);

    /* HELP holds the shortcut sheet and nothing else. It is the sheet the client already draws
       for `?`, given a home in the bar because a keyboard-first product whose key list can only
       be found with a key is a product whose key list is not found. */
    #[cfg(feature = "local-engine")]
    let menu = {
        let sheet = command_item(app, "shortcuts")?;
        menu.item(&SubmenuBuilder::new(app, "Help").item(&sheet).build()?)
    };

    app.set_menu(menu.build()?)?;
    Ok(())
}

#[cfg(test)]
#[path = "menu_tests.rs"]
mod tests;
