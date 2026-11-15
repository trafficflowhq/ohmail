//! THE SHELL'S OWN WORDS: every sentence the Rust side draws, in English and German, in one table.
//!
//! The window speaks the app's catalogue (`apps/webapp/messages`); what the OPERATING SYSTEM draws
//! for this process cannot: the menu bar, the tray, the update item and its dialogs, the progress
//! window's title and the relaunch question. Those are here, keyed, beside each other, so a key
//! one language lacks is a compile error rather than a blank item.
//!
//! English is the text the shell has always drawn, byte for byte. Which language is spoken is
//! `shell_language.rs`'s question, answered once per run; this file only holds the words and the
//! pure selectors each surface reads them through. Tauri-free, so every rule here is a plain test.
//!
//! The platform's own items (About, Hide, Undo, Minimize…) are `os`: `None` in English, so muda's
//! per-platform text stands exactly as before; German names each one through muda's text argument.

/// The languages the shell speaks. The same two the window's catalogue has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    En,
    De,
}

impl Language {
    pub const ALL: [Language; 2] = [Language::En, Language::De];

    /// The tag the window and the kept file use.
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    pub fn tag(self) -> &'static str {
        match self {
            Language::En => "en",
            Language::De => "de",
        }
    }

    /// The language a tag names, exactly: no trimming, no case folding, no subtags.
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    pub fn from_tag(tag: &str) -> Option<Language> {
        Language::ALL.into_iter().find(|l| l.tag() == tag)
    }
}

/// Declares `Words` from one list of keys, so the struct and the test's row list cannot differ.
macro_rules! words {
    ($($key:ident),* $(,)?) => {
        /// One language's words. Every field is a key; a language without one does not compile.
        #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
        pub struct Words {
            $(pub $key: &'static str,)*
            /// The platform's own items, named. `None` leaves muda's own text, per platform.
            pub os: Option<OsWords>,
        }

        impl Words {
            /// Every key and its text, in declaration order.
            #[cfg(test)]
            pub fn rows(&self) -> Vec<(&'static str, &'static str)> {
                vec![$((stringify!($key), self.$key)),*]
            }
        }
    };
}

words! {
    menu_file, menu_edit, menu_view, menu_window, menu_help,
    view_ohbox, view_reads, view_receipts, view_screener, view_triage,
    cmd_compose, cmd_settings, cmd_search, cmd_palette, cmd_shortcuts,
    quit_app,
    update_check, update_checking, update_downloading, update_restart,
    update_by_package, update_by_software_centre, update_by_app_store, update_by_nightly, update_not_self,
    ready_title, ready_message, ready_now, ready_later,
    none_title, none_message,
    unverified_title, unverified_message,
    failed_title, failed_fetch, failed_install, failed_retry, failed_close,
    progress_title,
    tray_serving, tray_lan_only, tray_degraded, tray_off, tray_open,
    relaunch_title, relaunch_message, relaunch_button,
}

/// The platform's own menu items, named in a language muda has no text of its own for.
pub struct OsWords {
    pub about: &'static str,
    pub hide: &'static str,
    pub hide_others: &'static str,
    pub show_all: &'static str,
    pub quit: &'static str,
    pub undo: &'static str,
    pub redo: &'static str,
    pub cut: &'static str,
    pub copy: &'static str,
    pub paste: &'static str,
    pub select_all: &'static str,
    pub minimize: &'static str,
    pub maximize: &'static str,
    pub fullscreen: &'static str,
    pub close_window: &'static str,
}

/// One of the platform's own items, as the menu builds it. Two are built only by some builds, by
/// `menu.rs`'s own conditions: the platform's Quit where the app has none of its own, and Close
/// Window in the engine build's File menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OsItem {
    About,
    Hide,
    HideOthers,
    ShowAll,
    #[cfg_attr(all(feature = "local-engine", not(target_os = "linux")), allow(dead_code))]
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Maximize,
    Fullscreen,
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    CloseWindow,
}

impl OsItem {
    #[cfg(test)]
    pub const ALL: [OsItem; 15] = [
        OsItem::About,
        OsItem::Hide,
        OsItem::HideOthers,
        OsItem::ShowAll,
        OsItem::Quit,
        OsItem::Undo,
        OsItem::Redo,
        OsItem::Cut,
        OsItem::Copy,
        OsItem::Paste,
        OsItem::SelectAll,
        OsItem::Minimize,
        OsItem::Maximize,
        OsItem::Fullscreen,
        OsItem::CloseWindow,
    ];
}

/// What host mode's tray says about itself.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayLine {
    Serving,
    LanOnly,
    Degraded,
    Off,
}

/// Which half of an update did not work.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateFailure {
    Fetch,
    Install,
}

/// One native dialog's words: its title, its sentence, and its buttons where it names them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dialog {
    pub title: &'static str,
    pub message: String,
    pub accept: Option<&'static str>,
    pub decline: Option<&'static str>,
}

/// A template's `{version}`, filled. The only hole any of these sentences has.
pub fn fill(template: &str, version: &str) -> String {
    template.replace("{version}", version)
}

/// English: the text the shell has always drawn, copied byte for byte.
pub const EN: Words = Words {
    menu_file: "File",
    menu_edit: "Edit",
    menu_view: "View",
    menu_window: "Window",
    menu_help: "Help",
    view_ohbox: "Ohbox",
    view_reads: "News",
    view_receipts: "Receipts",
    view_screener: "Screener",
    view_triage: "Answer Later",
    cmd_compose: "New Message",
    cmd_settings: "Settings…",
    cmd_search: "Search Mail…",
    cmd_palette: "Command Palette…",
    cmd_shortcuts: "Keyboard Shortcuts",
    quit_app: "Quit ohmail",
    update_check: "Check for Updates…",
    update_checking: "Checking for Updates…",
    update_downloading: "Downloading ohmail {version}…",
    update_restart: "Restart to Install {version}",
    update_by_package: "Updates Come from Your Package Manager",
    update_by_software_centre: "Updates Come from Your Software Centre",
    update_by_app_store: "Updates Come from the App Store",
    update_by_nightly: "Updates Come with the Next Night's Build",
    update_not_self: "This Build Does Not Update Itself",
    ready_title: "Update ready",
    ready_message: "ohmail {version} is ready to install. ohmail will restart to finish.",
    ready_now: "Restart now",
    ready_later: "Later",
    none_title: "No updates",
    none_message: "ohmail is up to date.",
    unverified_title: "Update not installed",
    unverified_message: "ohmail could not confirm which version the available update is, so nothing \
                         was installed. The version you have is unchanged.",
    failed_title: "ohmail update",
    failed_fetch: "ohmail could not fetch the update. Check your connection and try again.",
    failed_install: "ohmail could not install the update. Try again in a moment.",
    failed_retry: "Try again",
    failed_close: "Close",
    progress_title: "Updating ohmail",
    tray_serving: "Serving your tailnet",
    tray_lan_only: "Serving your network only",
    tray_degraded: "Host mode needs attention",
    tray_off: "Host mode off",
    tray_open: "Open ohmail",
    relaunch_title: "ohmail's window stopped",
    relaunch_message: "ohmail's window stopped again. Relaunch ohmail to open it.",
    relaunch_button: "Relaunch",
    os: None,
};

/// German. The five places and the refused update are the window's catalogue's own words.
pub const DE: Words = Words {
    menu_file: "Datei",
    menu_edit: "Bearbeiten",
    menu_view: "Ansicht",
    menu_window: "Fenster",
    menu_help: "Hilfe",
    view_ohbox: "Ohbox",
    view_reads: "News",
    view_receipts: "Belege",
    view_screener: "Screener",
    view_triage: "Später antworten",
    cmd_compose: "Neue Nachricht",
    cmd_settings: "Einstellungen …",
    cmd_search: "Mails durchsuchen …",
    cmd_palette: "Befehlspalette …",
    cmd_shortcuts: "Tastaturkürzel",
    quit_app: "ohmail beenden",
    update_check: "Nach Updates suchen …",
    update_checking: "Suche nach Updates …",
    update_downloading: "ohmail {version} wird geladen …",
    update_restart: "Neu starten und {version} installieren",
    update_by_package: "Updates kommen über deine Paketverwaltung",
    update_by_software_centre: "Updates kommen über deine Softwareverwaltung",
    update_by_app_store: "Updates kommen über den App Store",
    update_by_nightly: "Updates kommen mit dem Build der nächsten Nacht",
    update_not_self: "Dieser Build aktualisiert sich nicht selbst",
    ready_title: "Update bereit",
    ready_message: "ohmail {version} kann installiert werden. Zum Abschließen startet ohmail neu.",
    ready_now: "Jetzt neu starten",
    ready_later: "Später",
    none_title: "Keine Updates",
    none_message: "ohmail ist auf dem neuesten Stand.",
    unverified_title: "Update nicht installiert",
    unverified_message: "ohmail konnte nicht bestätigen, welche Version das verfügbare Update hat — \
                         installiert wurde deshalb nichts. Deine Version bleibt unverändert.",
    failed_title: "Update für ohmail",
    failed_fetch: "ohmail konnte das Update nicht laden. Prüfe deine Verbindung und versuche es noch einmal.",
    failed_install: "ohmail konnte das Update nicht installieren. Versuche es gleich noch einmal.",
    failed_retry: "Erneut versuchen",
    failed_close: "Schließen",
    // The progress window's page (`updater-window.ts`) speaks English only; its title bar follows
    // the page, so one window never mixes two languages. Both get German together.
    progress_title: EN.progress_title,
    tray_serving: "Für dein Tailnet erreichbar",
    tray_lan_only: "Nur in deinem Netzwerk erreichbar",
    tray_degraded: "Host-Modus braucht Aufmerksamkeit",
    tray_off: "Host-Modus aus",
    tray_open: "ohmail öffnen",
    relaunch_title: "Das ohmail-Fenster ist stehen geblieben",
    relaunch_message: "Das ohmail-Fenster ist erneut stehen geblieben. Neu starten, um es wieder zu öffnen.",
    relaunch_button: "Neu starten",
    os: Some(OsWords {
        about: "Über ohmail",
        hide: "ohmail ausblenden",
        hide_others: "Andere ausblenden",
        show_all: "Alle einblenden",
        quit: "ohmail beenden",
        // Apple's word on the Mac; elsewhere the window's own word for Undo, where "Widerrufen" is Revoke.
        undo: if cfg!(target_os = "macos") { "Widerrufen" } else { "Rückgängig" },
        redo: "Wiederholen",
        cut: "Ausschneiden",
        copy: "Kopieren",
        paste: "Einfügen",
        select_all: "Alles auswählen",
        minimize: "Minimieren",
        maximize: if cfg!(target_os = "macos") { "Zoomen" } else { "Maximieren" },
        fullscreen: "Vollbild",
        close_window: "Fenster schließen",
    }),
};

impl Words {
    /// The table of a language.
    pub fn of(language: Language) -> &'static Words {
        match language {
            Language::En => &EN,
            Language::De => &DE,
        }
    }

    /// A View item's label, by the view id `menu.rs` gives it.
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    pub fn view(&self, id: &str) -> Option<&'static str> {
        match id {
            "ohbox" => Some(self.view_ohbox),
            "reads" => Some(self.view_reads),
            "receipts" => Some(self.view_receipts),
            "screener" => Some(self.view_screener),
            "triage" => Some(self.view_triage),
            _ => None,
        }
    }

    /// A command item's label, by the command id `menu.rs` gives it.
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    pub fn command(&self, id: &str) -> Option<&'static str> {
        match id {
            "compose" => Some(self.cmd_compose),
            "settings" => Some(self.cmd_settings),
            "search" => Some(self.cmd_search),
            "palette" => Some(self.cmd_palette),
            "shortcuts" => Some(self.cmd_shortcuts),
            _ => None,
        }
    }

    /// The text a platform item is built with: `None` keeps the platform's own.
    pub fn os_item(&self, item: OsItem) -> Option<&'static str> {
        let os = self.os.as_ref()?;
        Some(match item {
            OsItem::About => os.about,
            OsItem::Hide => os.hide,
            OsItem::HideOthers => os.hide_others,
            OsItem::ShowAll => os.show_all,
            OsItem::Quit => os.quit,
            OsItem::Undo => os.undo,
            OsItem::Redo => os.redo,
            OsItem::Cut => os.cut,
            OsItem::Copy => os.copy,
            OsItem::Paste => os.paste,
            OsItem::SelectAll => os.select_all,
            OsItem::Minimize => os.minimize,
            OsItem::Maximize => os.maximize,
            OsItem::Fullscreen => os.fullscreen,
            OsItem::CloseWindow => os.close_window,
        })
    }

    /// Host mode's state line in the tray.
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    pub fn tray_line(&self, line: TrayLine) -> &'static str {
        match line {
            TrayLine::Serving => self.tray_serving,
            TrayLine::LanOnly => self.tray_lan_only,
            TrayLine::Degraded => self.tray_degraded,
            TrayLine::Off => self.tray_off,
        }
    }

    /// The one question the update flow asks: a verified release is ready.
    pub fn update_ready(&self, version: &str) -> Dialog {
        Dialog {
            title: self.ready_title,
            message: fill(self.ready_message, version),
            accept: Some(self.ready_now),
            decline: Some(self.ready_later),
        }
    }

    /// A press that found nothing newer.
    pub fn update_none(&self) -> Dialog {
        Dialog { title: self.none_title, message: self.none_message.to_string(), accept: None, decline: None }
    }

    /// A press that found a release this client will not install.
    pub fn update_unverified(&self) -> Dialog {
        Dialog {
            title: self.unverified_title,
            message: self.unverified_message.to_string(),
            accept: None,
            decline: None,
        }
    }

    /// An update that could not be fetched or installed, with a retry.
    pub fn update_failed(&self, failure: UpdateFailure) -> Dialog {
        Dialog {
            title: self.failed_title,
            message: match failure {
                UpdateFailure::Fetch => self.failed_fetch,
                UpdateFailure::Install => self.failed_install,
            }
            .to_string(),
            accept: Some(self.failed_retry),
            decline: Some(self.failed_close),
        }
    }

    /// The window's web process stopped a second time: one button, which relaunches.
    pub fn relaunch(&self) -> Dialog {
        Dialog {
            title: self.relaunch_title,
            message: self.relaunch_message.to_string(),
            accept: Some(self.relaunch_button),
            decline: None,
        }
    }
}

#[cfg(test)]
#[path = "words_tests.rs"]
mod tests;
