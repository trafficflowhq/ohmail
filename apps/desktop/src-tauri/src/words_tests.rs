//! The shell's words: English is today's, German holds the same keys, and each selector picks its
//! language's text.

use super::*;

/// Every English word, as the shell drew it before the table existed.
const TODAY: [(&str, &str); 47] = [
    ("menu_file", "File"),
    ("menu_edit", "Edit"),
    ("menu_view", "View"),
    ("menu_window", "Window"),
    ("menu_help", "Help"),
    ("view_ohbox", "Ohbox"),
    ("view_reads", "News"),
    ("view_receipts", "Receipts"),
    ("view_screener", "Screener"),
    ("view_triage", "Answer Later"),
    ("cmd_compose", "New Message"),
    ("cmd_settings", "Settings\u{2026}"),
    ("cmd_search", "Search Mail\u{2026}"),
    ("cmd_palette", "Command Palette\u{2026}"),
    ("cmd_shortcuts", "Keyboard Shortcuts"),
    ("quit_app", "Quit ohmail"),
    ("update_check", "Check for Updates\u{2026}"),
    ("update_checking", "Checking for Updates\u{2026}"),
    ("update_downloading", "Downloading ohmail {version}\u{2026}"),
    ("update_restart", "Restart to Install {version}"),
    ("update_by_package", "Updates Come from Your Package Manager"),
    ("update_by_software_centre", "Updates Come from Your Software Centre"),
    ("update_by_app_store", "Updates Come from the App Store"),
    ("update_by_nightly", "Updates Come with the Next Night's Build"),
    ("update_not_self", "This Build Does Not Update Itself"),
    ("ready_title", "Update ready"),
    ("ready_message", "ohmail {version} is ready to install. ohmail will restart to finish."),
    ("ready_now", "Restart now"),
    ("ready_later", "Later"),
    ("none_title", "No updates"),
    ("none_message", "ohmail is up to date."),
    ("unverified_title", "Update not installed"),
    (
        "unverified_message",
        "ohmail could not confirm which version the available update is, so nothing was installed. The version you have is unchanged.",
    ),
    ("failed_title", "ohmail update"),
    ("failed_fetch", "ohmail could not fetch the update. Check your connection and try again."),
    ("failed_install", "ohmail could not install the update. Try again in a moment."),
    ("failed_retry", "Try again"),
    ("failed_close", "Close"),
    ("progress_title", "Updating ohmail"),
    ("tray_serving", "Serving your tailnet"),
    ("tray_lan_only", "Serving your network only"),
    ("tray_degraded", "Host mode needs attention"),
    ("tray_off", "Host mode off"),
    ("tray_open", "Open ohmail"),
    ("relaunch_title", "ohmail's window stopped"),
    ("relaunch_message", "ohmail's window stopped again. Relaunch ohmail to open it."),
    ("relaunch_button", "Relaunch"),
];

#[test]
fn english_is_the_text_the_shell_always_drew() {
    assert_eq!(EN.rows(), TODAY.to_vec());
}

#[test]
fn both_languages_hold_the_same_keys() {
    let keys = |w: &Words| w.rows().into_iter().map(|(k, _)| k).collect::<Vec<_>>();
    assert_eq!(keys(&DE), keys(&EN));
}

/// The `{…}` holes of a template, in order.
fn holes(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        let close = rest[open..].find('}').map(|c| open + c + 1).unwrap_or(rest.len());
        out.push(&rest[open..close]);
        rest = &rest[close..];
    }
    out
}

#[test]
fn no_word_is_empty_padded_or_typed_with_three_dots_and_every_hole_is_in_both() {
    for language in Language::ALL {
        let w = Words::of(language);
        for (key, text) in w.rows() {
            assert!(!text.is_empty(), "{language:?} {key} is empty");
            assert_eq!(text.trim(), text, "{language:?} {key} is padded");
            assert!(!text.contains("..."), "{language:?} {key} has three dots for an ellipsis");
            assert!(!text.contains("  "), "{language:?} {key} has a double space");
        }
    }
    for ((key, en), (_, de)) in EN.rows().into_iter().zip(DE.rows()) {
        assert_eq!(holes(de), holes(en), "{key}: the German holes are not the English ones");
        for hole in holes(en) {
            assert_eq!(hole, "{version}", "{key}: a hole `fill` does not fill");
        }
    }
}

#[test]
fn english_keeps_the_platforms_own_items_and_german_names_all_fifteen() {
    assert!(EN.os.is_none());
    for item in OsItem::ALL {
        assert_eq!(EN.os_item(item), None, "English named {item:?}");
        let de = DE.os_item(item).unwrap_or_else(|| panic!("German does not name {item:?}"));
        assert!(!de.is_empty() && de.trim() == de && !de.contains('&'), "{item:?}: {de:?}");
    }
    let mut named: Vec<_> = OsItem::ALL.iter().map(|i| DE.os_item(*i).unwrap()).collect();
    named.sort_unstable();
    named.dedup();
    assert_eq!(named.len(), OsItem::ALL.len(), "two platform items share a German name");
}

#[test]
fn a_tag_is_one_of_two_exactly() {
    for language in Language::ALL {
        assert_eq!(Language::from_tag(language.tag()), Some(language));
    }
    for junk in ["", "EN", "De", "de-CH", "de_DE", " de", "de\n", "fr", "deutsch"] {
        assert_eq!(Language::from_tag(junk), None, "{junk:?} read as a language");
    }
    assert_eq!(Language::from_tag(&"de".repeat(500_000)), None);
}

/// The window's catalogue, read where the repository keeps it.
fn catalogue(tag: &str) -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../webapp/messages/{tag}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("could not read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} is not JSON: {e}", path.display()))
}

#[test]
fn the_places_and_the_refused_update_are_the_windows_own_words() {
    for language in Language::ALL {
        let messages = catalogue(language.tag());
        let say = |group: &str, key: &str| -> String {
            messages[group][key]
                .as_str()
                .unwrap_or_else(|| panic!("{}: no {group}.{key}", language.tag()))
                .to_string()
        };
        let w = Words::of(language);
        for (id, key) in [
            ("ohbox", "ohbox"),
            ("reads", "reads"),
            ("receipts", "receipts"),
            ("screener", "screener"),
            ("triage", "replyLater"),
        ] {
            assert_eq!(w.view(id), Some(say("rail", key).as_str()), "{language:?} {id}");
        }
        assert_eq!(w.unverified_message, say("update", "refused"), "{language:?}");
    }
    // Off the Mac, Undo is the act the window's German calls "Rückgängig"; its "Widerrufen" is
    // Revoke (a device code, an invite), so the Edit menu must not say that.
    if !cfg!(target_os = "macos") {
        let de = catalogue("de");
        assert_eq!(DE.os_item(OsItem::Undo), de["ohbox"]["undo"].as_str());
        assert_ne!(DE.os_item(OsItem::Undo), de["devices"]["revoke"].as_str());
    }
}

#[test]
fn each_selector_picks_its_languages_words() {
    for language in Language::ALL {
        let w = Words::of(language);
        for id in ["ohbox", "reads", "receipts", "screener", "triage"] {
            assert!(w.view(id).is_some(), "{language:?} has no label for the view {id}");
        }
        for id in ["compose", "settings", "search", "palette", "shortcuts"] {
            assert!(w.command(id).is_some(), "{language:?} has no label for the command {id}");
        }
        assert_eq!(w.view("settings"), None);
        assert_eq!(w.command("ohbox"), None);
        assert_eq!(w.command(""), None);
    }
    assert_eq!(EN.command("settings"), Some("Settings\u{2026}"));
    assert_eq!(DE.command("settings"), Some("Einstellungen \u{2026}"));
    assert_eq!(DE.view("triage"), Some("Später antworten"));

    assert_eq!(EN.tray_line(TrayLine::Serving), "Serving your tailnet");
    assert_eq!(EN.tray_line(TrayLine::LanOnly), "Serving your network only");
    assert_eq!(EN.tray_line(TrayLine::Degraded), "Host mode needs attention");
    assert_eq!(EN.tray_line(TrayLine::Off), "Host mode off");
    assert_eq!(DE.tray_line(TrayLine::Serving), "Für dein Tailnet erreichbar");
    assert_eq!(DE.tray_line(TrayLine::Off), "Host-Modus aus");
}

#[test]
fn each_dialog_is_its_languages_words_with_the_version_filled() {
    assert_eq!(
        EN.update_ready("1.2.3"),
        Dialog {
            title: "Update ready",
            message: "ohmail 1.2.3 is ready to install. ohmail will restart to finish.".into(),
            accept: Some("Restart now"),
            decline: Some("Later"),
        }
    );
    assert_eq!(
        DE.update_ready("2.0.0"),
        Dialog {
            title: "Update bereit",
            message: "ohmail 2.0.0 kann installiert werden. Zum Abschließen startet ohmail neu.".into(),
            accept: Some("Jetzt neu starten"),
            decline: Some("Später"),
        }
    );
    assert_eq!(
        EN.update_none(),
        Dialog { title: "No updates", message: "ohmail is up to date.".into(), accept: None, decline: None }
    );
    assert_eq!(DE.update_none().title, "Keine Updates");
    assert_eq!(EN.update_unverified().title, "Update not installed");
    assert_eq!(EN.update_unverified().message, EN.unverified_message);
    assert_eq!(DE.update_unverified().message, DE.unverified_message);
    assert_eq!(
        EN.update_failed(UpdateFailure::Fetch),
        Dialog {
            title: "ohmail update",
            message: "ohmail could not fetch the update. Check your connection and try again.".into(),
            accept: Some("Try again"),
            decline: Some("Close"),
        }
    );
    assert_eq!(
        EN.update_failed(UpdateFailure::Install).message,
        "ohmail could not install the update. Try again in a moment."
    );
    let de = DE.update_failed(UpdateFailure::Install);
    assert_eq!((de.accept, de.decline), (Some("Erneut versuchen"), Some("Schließen")));
    assert_eq!(
        EN.relaunch(),
        Dialog {
            title: "ohmail's window stopped",
            message: "ohmail's window stopped again. Relaunch ohmail to open it.".into(),
            accept: Some("Relaunch"),
            decline: None,
        }
    );
    for language in Language::ALL {
        let asked = Words::of(language).relaunch();
        let button = asked.accept.unwrap();
        assert!(asked.message.contains(button), "{language:?}: the sentence does not name its button");
        assert_eq!(asked.decline, None, "{language:?}: a second button is what Escape answers");
    }
}

#[test]
fn fill_fills_the_version_and_nothing_else() {
    assert_eq!(fill("ohmail {version}\u{2026}", "1.0.12"), "ohmail 1.0.12\u{2026}");
    assert_eq!(fill("no hole", "1.0.12"), "no hole");
    // A version is text and is never read as a template itself.
    assert_eq!(fill("{version}", "{version}{x}"), "{version}{x}");
}

mod the_update_item_and_its_dialogs {
    use super::*;
    use crate::updater::{dialog_buttons, idle_label, menu_text_in, Flow, InstallKind, Signal};
    use tauri_plugin_dialog::MessageDialogButtons;

    const KINDS: [InstallKind; 10] = [
        InstallKind::AppImage,
        InstallKind::Deb,
        InstallKind::Rpm,
        InstallKind::LinuxPackage,
        InstallKind::Flatpak,
        InstallKind::WindowsSetup,
        InstallKind::MacBundle,
        InstallKind::MacAppStore,
        InstallKind::Preview,
        InstallKind::Unpackaged,
    ];

    /// One flow in each stage: idle, checking, downloading, ready, failed.
    fn stages() -> Vec<Flow> {
        let after = |signals: &[Signal]| {
            let mut flow = Flow::default();
            for s in signals {
                flow.apply(s.clone());
            }
            flow
        };
        vec![
            Flow::default(),
            after(&[Signal::CheckStarted]),
            after(&[Signal::CheckStarted, Signal::Offered("2.0.1".into())]),
            after(&[Signal::CheckStarted, Signal::Offered("2.0.1".into()), Signal::Downloaded]),
            after(&[Signal::CheckStarted, Signal::Failed]),
        ]
    }

    #[test]
    fn the_item_says_each_stage_in_its_language() {
        let said = |w: &Words| stages().iter().map(|f| f.menu_label_in(w)).collect::<Vec<_>>();
        assert_eq!(
            said(&EN),
            [
                "Check for Updates\u{2026}",
                "Checking for Updates\u{2026}",
                "Downloading ohmail 2.0.1\u{2026}",
                "Restart to Install 2.0.1",
                "Check for Updates\u{2026}",
            ]
        );
        assert_eq!(
            said(&DE),
            [
                "Nach Updates suchen \u{2026}",
                "Suche nach Updates \u{2026}",
                "ohmail 2.0.1 wird geladen \u{2026}",
                "Neu starten und 2.0.1 installieren",
                "Nach Updates suchen \u{2026}",
            ]
        );
        assert_eq!(idle_label(&EN), "Check for Updates\u{2026}");
        assert_eq!(idle_label(&DE), "Nach Updates suchen \u{2026}");
    }

    #[test]
    fn every_install_kind_says_its_sentence_in_its_language() {
        for language in Language::ALL {
            let w = Words::of(language);
            for kind in KINDS {
                for flow in stages() {
                    let (label, enabled) = menu_text_in(kind, &flow, false, w);
                    match kind.menu_sentence_in(w) {
                        Some(sentence) => {
                            assert_eq!(label, sentence, "{language:?} {}", kind.as_str());
                            assert!(!enabled, "{language:?} {}: pressable", kind.as_str());
                        }
                        None => assert_eq!(label, flow.menu_label_in(w), "{language:?} {}", kind.as_str()),
                    }
                    // English is the old English, and the enablement never depends on the language.
                    assert_eq!(menu_text_in(kind, &flow, false, &EN), crate::updater::menu_text(kind, &flow, false));
                    assert_eq!(enabled, menu_text_in(kind, &flow, false, &EN).1);
                }
            }
        }
        assert_eq!(InstallKind::Deb.menu_sentence_in(&DE), Some("Updates kommen über deine Paketverwaltung"));
        assert_eq!(InstallKind::Flatpak.menu_sentence_in(&DE), Some("Updates kommen über deine Softwareverwaltung"));
        assert_eq!(InstallKind::MacAppStore.menu_sentence_in(&DE), Some("Updates kommen über den App Store"));
        assert_eq!(InstallKind::Preview.menu_sentence_in(&DE), Some("Updates kommen mit dem Build der nächsten Nacht"));
        assert_eq!(InstallKind::Unpackaged.menu_sentence_in(&DE), Some("Dieser Build aktualisiert sich nicht selbst"));
        assert_eq!(InstallKind::AppImage.menu_sentence_in(&DE), None);
    }

    #[test]
    fn a_dialogs_buttons_are_its_own_words() {
        for language in Language::ALL {
            let w = Words::of(language);
            match dialog_buttons(&w.update_ready("2.0.1")) {
                MessageDialogButtons::OkCancelCustom(now, later) => {
                    assert_eq!((now.as_str(), later.as_str()), (w.ready_now, w.ready_later));
                }
                other => panic!("{language:?}: {other:?}"),
            }
            match dialog_buttons(&w.update_failed(UpdateFailure::Fetch)) {
                MessageDialogButtons::OkCancelCustom(retry, close) => {
                    assert_eq!((retry.as_str(), close.as_str()), (w.failed_retry, w.failed_close));
                }
                other => panic!("{language:?}: {other:?}"),
            }
            match dialog_buttons(&w.relaunch()) {
                MessageDialogButtons::OkCustom(only) => assert_eq!(only, w.relaunch_button),
                other => panic!("{language:?}: {other:?}"),
            }
            assert!(matches!(dialog_buttons(&w.update_none()), MessageDialogButtons::Ok));
        }
        assert!(matches!(
            dialog_buttons(&EN.update_ready("1")),
            MessageDialogButtons::OkCancelCustom(a, b) if a == "Restart now" && b == "Later"
        ));
    }
}

/// The bar's own items: every place and command the menu builds has its language's label, and
/// the table's English column is the English the shell draws.
#[cfg(feature = "local-engine")]
#[test]
fn every_item_the_bar_builds_has_its_languages_label() {
    use crate::menu::{COMMANDS, VIEWS};
    for (id, english, _) in VIEWS {
        assert_eq!(EN.view(id), Some(english), "{id}");
        assert_ne!(DE.view(id), None, "German has no label for the view {id}");
    }
    for (id, english, _) in COMMANDS {
        assert_eq!(EN.command(id), Some(english), "{id}");
        assert_ne!(DE.command(id), None, "German has no label for the command {id}");
    }
    let de: Vec<_> = VIEWS.iter().map(|(id, _, _)| DE.view(id).unwrap()).collect();
    assert_eq!(de, ["Ohbox", "News", "Belege", "Screener", "Später antworten"]);
    let de: Vec<_> = COMMANDS.iter().map(|(id, _, _)| DE.command(id).unwrap()).collect();
    assert_eq!(
        de,
        ["Neue Nachricht", "Einstellungen \u{2026}", "Mails durchsuchen \u{2026}", "Befehlspalette \u{2026}", "Tastaturkürzel"]
    );
}

#[test]
fn the_bars_menus_and_its_quit_are_named_in_each_language() {
    let titles = |w: &Words| [w.menu_file, w.menu_edit, w.menu_view, w.menu_window, w.menu_help];
    assert_eq!(titles(&EN), ["File", "Edit", "View", "Window", "Help"]);
    assert_eq!(titles(&DE), ["Datei", "Bearbeiten", "Ansicht", "Fenster", "Hilfe"]);
    assert_eq!((EN.quit_app, DE.quit_app), ("Quit ohmail", "ohmail beenden"));
    // The platform's own Quit and the app's own say the same in German.
    assert_eq!(DE.os_item(OsItem::Quit), Some(DE.quit_app));
    // Two items take the platform's own German: Apple's on the Mac, Windows' and GTK's elsewhere.
    assert_eq!(DE.os_item(OsItem::Maximize), Some(if cfg!(target_os = "macos") { "Zoomen" } else { "Maximieren" }));
    assert_eq!(DE.os_item(OsItem::Undo), Some(if cfg!(target_os = "macos") { "Widerrufen" } else { "Rückgängig" }));
}

/// The update's progress window draws a page (`updater-window.ts`) that speaks English only, so
/// its title bar does too in every language: one window, one language. German gets its own title
/// together with the page's German.
#[test]
fn the_progress_window_is_titled_in_its_pages_one_language() {
    for language in Language::ALL {
        assert_eq!(Words::of(language).progress_title, "Updating ohmail", "{language:?}");
    }
}

/// Host mode's tray: the tri-state picks the line, the language picks its words.
#[cfg(feature = "local-engine")]
#[test]
fn the_tray_says_each_state_in_its_language() {
    use crate::host::tray_line;
    let states = [("serving", false), ("serving", true), ("degraded", true), ("degraded", false), ("off", false), ("", true)];
    let lines: Vec<_> = states.iter().map(|(s, lan)| tray_line(s, *lan)).collect();
    assert_eq!(
        lines,
        [TrayLine::Serving, TrayLine::Serving, TrayLine::LanOnly, TrayLine::Degraded, TrayLine::Off, TrayLine::Off]
    );
    let said = |w: &Words| lines.iter().map(|l| w.tray_line(*l)).collect::<Vec<_>>();
    assert_eq!(
        said(&EN),
        [
            "Serving your tailnet",
            "Serving your tailnet",
            "Serving your network only",
            "Host mode needs attention",
            "Host mode off",
            "Host mode off",
        ]
    );
    assert_eq!(
        said(&DE),
        [
            "Für dein Tailnet erreichbar",
            "Für dein Tailnet erreichbar",
            "Nur in deinem Netzwerk erreichbar",
            "Host-Modus braucht Aufmerksamkeit",
            "Host-Modus aus",
            "Host-Modus aus",
        ]
    );
    assert_eq!((EN.tray_open, DE.tray_open), ("Open ohmail", "ohmail öffnen"));
}

/// The relaunch question: one button in each language, and the answer read in any of them.
#[test]
fn the_relaunch_question_is_asked_and_answered_in_each_language() {
    use crate::renderer_recovery::{relaunch_answer, relaunch_buttons_in};
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogResult as R};
    for language in Language::ALL {
        let w = Words::of(language);
        match relaunch_buttons_in(w) {
            MessageDialogButtons::OkCustom(only) => assert_eq!(only, w.relaunch_button, "{language:?}"),
            other => panic!("{language:?}: a cancel slot is where Escape lands: {other:?}"),
        }
        assert_eq!(relaunch_answer(&R::Custom(w.relaunch_button.into())), "relaunch", "{language:?}");
    }
    assert_eq!(relaunch_answer(&R::Custom("Neu starten".into())), "relaunch");
    assert_eq!(relaunch_answer(&R::Custom("Relaunch".into())), "relaunch");
    for other in ["neu starten", "Neu starten ", "Quit", "", "Abbrechen"] {
        assert_eq!(relaunch_answer(&R::Custom(other.into())), "dismissed", "{other:?}");
    }
}
