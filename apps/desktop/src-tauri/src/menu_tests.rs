//! The menu's rules, as far as they can be checked without a windowing system.
//!
//! Building a real menu needs an event loop and a display, which a headless test runner has
//! neither of — so what is asserted here is the part that decides BEHAVIOUR: which ids mean
//! "navigate", which view each one names, and that the accelerators are the five distinct keys
//! the frontend expects. The rest of the bar (that it appears, that ⌘C copies) is a property of
//! the platform's own items and is checked by opening the app.

use super::*;

#[test]
fn only_the_navigation_items_navigate() {
    assert_eq!(navigate_target("view:ohbox"), Some("ohbox"));
    // Every other item in the bar, including the one this module builds beside them.
    assert_eq!(navigate_target(crate::updater::CHECK_FOR_UPDATES_ID), None);
    assert_eq!(navigate_target("quit"), None);
    assert_eq!(navigate_target(""), None);
    // A prefix with nothing after it is not a view. Emitting an empty payload would put the
    // frontend on its fallback route, which looks like the menu going to the wrong place.
    assert_eq!(navigate_target("view:"), None);
}

/// The prefix is not merely a convention: `navigate_target` is the whole test for "is this ours",
/// so an id that HAPPENS to start with the prefix is treated as a view. Recorded rather than
/// defended, because the ids are composed from `VIEWS` and nothing else can mint one.
#[test]
fn the_prefix_is_what_marks_an_item_as_navigation() {
    assert!(NAVIGATE_PREFIX.ends_with(':'));
    assert_eq!(navigate_target("view:anything"), Some("anything"));
}

#[cfg(feature = "local-engine")]
#[test]
fn the_view_menu_is_five_distinct_places_on_five_distinct_keys() {
    let ids: Vec<&str> = VIEWS.iter().map(|(id, _, _)| *id).collect();
    let accelerators: Vec<&str> = VIEWS.iter().map(|(_, _, key)| *key).collect();

    assert_eq!(ids, ["ohbox", "reads", "receipts", "screener", "triage"]);
    assert_eq!(
        accelerators,
        ["CmdOrCtrl+1", "CmdOrCtrl+2", "CmdOrCtrl+3", "CmdOrCtrl+4", "CmdOrCtrl+5"],
    );

    // No duplicates in either column: two items on one key is a key that does whichever the
    // platform happened to register last, and two ids in one menu is one place unreachable.
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), ids.len());
    let mut keys = accelerators.clone();
    keys.sort_unstable();
    keys.dedup();
    assert_eq!(keys.len(), accelerators.len());
}

/// Every view id round-trips through the id the menu item actually carries.
///
/// This is the half that would break silently: the item's id is composed as
/// `"{NAVIGATE_PREFIX}{id}"` in `install`, and the handler takes it apart again. If the two ever
/// disagreed the menu would emit a name the frontend does not recognise and nothing would
/// navigate, with no error anywhere.
#[cfg(feature = "local-engine")]
#[test]
fn every_view_survives_the_round_trip_through_a_menu_id() {
    for (id, label, _) in VIEWS {
        let composed = format!("{NAVIGATE_PREFIX}{id}");
        assert_eq!(navigate_target(&composed), Some(id));
        assert!(!label.is_empty(), "{id} has no label to render");
    }
}

/// The event name is the one the frontend listens for. Two spellings would be a menu that emits
/// into nothing, which looks exactly like a menu that was never wired up.
#[test]
fn the_event_is_named_for_what_it_does() {
    assert_eq!(MENU_NAVIGATE_EVENT, "menu:navigate");
}

/// A command id is a command and a view id is not, in both directions.
///
/// The two prefixes are the whole discrimination — `attach` asks `navigate_target` first and
/// `command_target` second — so an id that satisfied both would emit on the navigation channel
/// and never on the command one, which is a menu item that quietly goes to the wrong place.
#[test]
fn commands_and_views_cannot_be_mistaken_for_each_other() {
    assert_eq!(command_target("cmd:compose"), Some("compose"));
    assert_eq!(command_target("view:ohbox"), None);
    assert_eq!(navigate_target("cmd:compose"), None);
    assert_eq!(command_target("cmd:"), None);
    assert_eq!(command_target(""), None);
    assert_eq!(command_target(crate::updater::CHECK_FOR_UPDATES_ID), None);
    assert_ne!(NAVIGATE_PREFIX, COMMAND_PREFIX);
}

#[test]
fn the_command_event_is_named_for_what_it_does() {
    assert_eq!(MENU_COMMAND_EVENT, "menu:command");
    assert_ne!(MENU_COMMAND_EVENT, MENU_NAVIGATE_EVENT);
}

/// The bar's own accelerators, and the platform's, may not collide.
///
/// Two items on one key is a key that does whichever the platform registered last. The view items
/// already hold ⌘1…⌘5; these five hold the letters, and the ones the platform's own items claim
/// (⌘Q, ⌘W, ⌘M, ⌘C, ⌘V, ⌘X, ⌘A, ⌘Z) are named here so a new command cannot take one back.
#[cfg(feature = "local-engine")]
#[test]
fn every_command_has_its_own_key_and_none_of_the_platforms() {
    const PLATFORM: [&str; 8] = [
        "CmdOrCtrl+Q", "CmdOrCtrl+W", "CmdOrCtrl+M",
        "CmdOrCtrl+C", "CmdOrCtrl+V", "CmdOrCtrl+X", "CmdOrCtrl+A", "CmdOrCtrl+Z",
    ];

    let mut keys: Vec<&str> = COMMANDS.iter().map(|(_, _, key)| *key).collect();
    keys.extend(VIEWS.iter().map(|(_, _, key)| *key));
    for key in &keys {
        assert!(!PLATFORM.contains(key), "{key} is the platform's own");
    }
    let before = keys.len();
    keys.sort_unstable();
    keys.dedup();
    assert_eq!(keys.len(), before, "two menu items share one accelerator");

    let mut ids: Vec<&str> = COMMANDS.iter().map(|(id, _, _)| *id).collect();
    assert_eq!(ids, ["compose", "settings", "search", "palette", "shortcuts"]);
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), COMMANDS.len());

    for (id, label, _) in COMMANDS {
        assert_eq!(command_target(&format!("{COMMAND_PREFIX}{id}")), Some(id));
        assert!(!label.is_empty(), "{id} has no label to render");
    }
}

/// The two conventions a Mac user does not think of as ours.
#[cfg(feature = "local-engine")]
#[test]
fn the_platform_conventions_are_where_a_mac_user_expects_them() {
    let key = |want: &str| COMMANDS.iter().find(|(id, _, _)| *id == want).unwrap().2;
    assert_eq!(key("compose"), "CmdOrCtrl+N");
    assert_eq!(key("settings"), "CmdOrCtrl+,");
}
