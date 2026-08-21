//! The default-mail table, driven end to end without any of the three platforms' tools.
//!
//! Everything the module DECIDES is a pure function, so every branch below runs on every
//! platform — the Linux mapping is proven on the macOS runner and the Windows parse on the
//! Linux one. What is left uncovered by construction is the four lines per platform that call
//! the real tool; those are the live-verification rows in the release notes, not tests.

use super::*;

/* ── the wire vocabulary — the strings native.ts matches on ─────────────────────────────────── */

#[test]
fn the_three_states_and_three_outcomes_are_the_wire_spellings() {
    assert_eq!(MailDefault::Default.as_str(), "default");
    assert_eq!(MailDefault::NotDefault.as_str(), "not-default");
    assert_eq!(MailDefault::Unknown.as_str(), "unknown");
    assert_eq!(RequestOutcome::SystemDialog.as_str(), "system-dialog");
    assert_eq!(RequestOutcome::SettingsOpened.as_str(), "settings-opened");
    assert_eq!(RequestOutcome::Set.as_str(), "set");
}

/* ── macOS: the handler comparison ──────────────────────────────────────────────────────────── */

#[test]
fn no_answer_from_launch_services_is_unknown_never_a_guess() {
    assert_eq!(state_from_handler(None, "io.ohmail.desktop"), MailDefault::Unknown);
}

#[test]
fn the_handler_comparison_is_case_insensitive_because_bundle_ids_are() {
    assert_eq!(
        state_from_handler(Some("io.ohmail.desktop"), "io.ohmail.desktop"),
        MailDefault::Default
    );
    assert_eq!(
        state_from_handler(Some("IO.Ohmail.Desktop"), "io.ohmail.desktop"),
        MailDefault::Default
    );
    assert_eq!(
        state_from_handler(Some("com.apple.mail"), "io.ohmail.desktop"),
        MailDefault::NotDefault
    );
}

/* ── Windows: the reg.exe parse and the UserChoice mapping ──────────────────────────────────── */

#[test]
fn the_prog_id_is_read_out_of_real_reg_output() {
    // The shape reg.exe has printed since Windows XP: blank line, key path, indented value row.
    let output = "\r\n\
        HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\mailto\\UserChoice\r\n\
        \x20   ProgId    REG_SZ    ohmail.mailto\r\n\r\n";
    assert_eq!(prog_id_from_reg_output(output), Some("ohmail.mailto".into()));
}

#[test]
fn other_value_rows_and_empty_output_answer_none() {
    assert_eq!(prog_id_from_reg_output(""), None);
    assert_eq!(
        prog_id_from_reg_output("    Hash    REG_SZ    2ZumyzXO/2k="),
        None
    );
    // A ProgId row whose value is missing is not an answer.
    assert_eq!(prog_id_from_reg_output("    ProgId    REG_SZ    "), None);
}

#[test]
fn a_prog_id_containing_a_space_survives_the_field_split() {
    assert_eq!(
        prog_id_from_reg_output("    ProgId    REG_SZ    Some ProgId"),
        Some("Some ProgId".into())
    );
}

#[test]
fn userchoice_maps_to_the_three_states() {
    // The query could not run at all: unknown, never a claim.
    assert_eq!(state_from_reg(false, None, "ohmail.mailto"), MailDefault::Unknown);
    // Ran and found us.
    assert_eq!(
        state_from_reg(true, Some("ohmail.mailto"), "ohmail.mailto"),
        MailDefault::Default
    );
    // Ran and found somebody else — ProgIds are exact, not case-folded: Windows preserves the
    // registered casing and ours is fixed by the installer.
    assert_eq!(
        state_from_reg(true, Some("Outlook.URL.mailto.15"), "ohmail.mailto"),
        MailDefault::NotDefault
    );
    // Ran and found no UserChoice: no app holds the choice, which is honestly "not default".
    assert_eq!(state_from_reg(true, None, "ohmail.mailto"), MailDefault::NotDefault);
}

/* ── Linux: the xdg-settings mapping ────────────────────────────────────────────────────────── */

#[test]
fn xdg_answers_map_to_the_three_states() {
    assert_eq!(state_from_xdg(None, "ohmail.desktop"), MailDefault::Unknown);
    assert_eq!(state_from_xdg(Some("ohmail.desktop\n"), "ohmail.desktop"), MailDefault::Default);
    assert_eq!(state_from_xdg(Some(""), "ohmail.desktop"), MailDefault::NotDefault);
    assert_eq!(
        state_from_xdg(Some("org.gnome.Evolution.desktop\n"), "ohmail.desktop"),
        MailDefault::NotDefault
    );
}

/* ── the argv tables — pinned so a refactor cannot quietly change what is executed ──────────── */

#[test]
fn the_reg_query_asks_for_exactly_the_userchoice_prog_id() {
    assert_eq!(
        reg_query_args(),
        [
            "query".to_string(),
            r"HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\mailto\UserChoice"
                .to_string(),
            "/v".to_string(),
            "ProgId".to_string(),
        ]
    );
}

#[test]
fn the_xdg_invocations_name_the_mailto_scheme_and_this_apps_desktop_entry() {
    assert_eq!(
        xdg_get_args(),
        ["get".to_string(), "default-url-scheme-handler".into(), "mailto".into()]
    );
    assert_eq!(
        xdg_set_args(),
        [
            "set".to_string(),
            "default-url-scheme-handler".into(),
            "mailto".into(),
            "ohmail.desktop".into(),
        ]
    );
}

/* ── the identities the OS knows this app by ────────────────────────────────────────────────── */

#[test]
fn the_three_platform_identities_are_the_registered_ones() {
    // tauri.conf.json's `identifier`; desktop-shell.test.ts holds the JSON side.
    assert_eq!(MACOS_BUNDLE_ID, "io.ohmail.desktop");
    // windows/hooks.nsh registers exactly this ProgId; desktop-shell.test.ts holds that side.
    assert_eq!(WINDOWS_PROG_ID, "ohmail.mailto");
    // The bundler names the desktop entry after the product.
    assert_eq!(LINUX_DESKTOP_ID, "ohmail.desktop");
    // The one address the request may open on Windows — a Settings page, never a registry write.
    assert_eq!(WINDOWS_SETTINGS_URL, "ms-settings:defaultapps");
}
