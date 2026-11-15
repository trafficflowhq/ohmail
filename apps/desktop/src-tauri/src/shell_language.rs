//! WHICH LANGUAGE THE SHELL SPEAKS, chosen by the window and kept for the next launch.
//!
//! The window knows the person's language (`DesktopLocale.tsx`, kept in its own storage); the
//! shell draws its menu bar and tray before the page has run a line, so it cannot ask. The window
//! TELLS it, through `set_shell_language`, and the shell keeps the tag in one file beside the
//! app's others. The next launch reads that file once, right after the runtime is built and before
//! the menu or the tray exists, and speaks that language for the whole run.
//!
//! ONE LANGUAGE PER RUN, on purpose. A bar relabelled live would need every platform item rebuilt
//! (muda's English defaults cannot be put back by `set_text`), and a half-relabelled bar is worse
//! than one that follows at the next start. So the command keeps the choice and answers whether
//! the shell already speaks it.
//!
//! Nothing kept, a file unreadable, or anything but the two tags is English: today's shell. The
//! published preview has no window commands at all, so it never settles and always speaks English.
//! Only the engine build reaches the channel, which is why its half is allowed to lie unused here.

use std::path::Path;
use std::sync::OnceLock;

use crate::words::{Language, Words};

/// The language kept for the next launch, beside the app's other files: the tag and a newline.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub const KEPT_FILE: &str = "shell-language";

/// The answer to anything that is not one of the two tags. It never repeats what it was given.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub const REFUSED: &str = "not a language ohmail speaks";

/// The answer when the choice could not be written down for the next launch.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub const NOT_KEPT: &str = "the language could not be kept";

/// The language of this run, settled once.
static SPOKEN: OnceLock<Language> = OnceLock::new();

/// The language the last choice kept, when it is one of the two. Bounded read: the file holds
/// three bytes.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub fn read_kept(dir: &Path) -> Option<Language> {
    use std::io::Read;
    let mut text = String::new();
    std::fs::File::open(dir.join(KEPT_FILE)).ok()?.take(16).read_to_string(&mut text).ok()?;
    let tag = text.strip_suffix('\n').unwrap_or(&text);
    Language::from_tag(tag.strip_suffix('\r').unwrap_or(tag))
}

/// Keep a language for the next launch, written only when it changed, by a temporary file and a
/// rename so a launch never reads half a tag.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub fn keep(dir: &Path, language: Language) -> std::io::Result<()> {
    if read_kept(dir) == Some(language) {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{KEPT_FILE}.tmp"));
    std::fs::write(&tmp, format!("{}\n", language.tag()))?;
    std::fs::rename(&tmp, dir.join(KEPT_FILE))
}

/// The language a launch speaks: the kept one, or English.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub fn at_launch(dir: Option<&Path>) -> Language {
    dir.and_then(read_kept).unwrap_or(Language::En)
}

/// The window's choice: one of the two tags exactly, kept for the next launch. Answers `true`
/// when this run already speaks it and `false` when the next launch will.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub fn take(dir: Option<&Path>, tag: &str, spoken: Language) -> Result<bool, &'static str> {
    let language = Language::from_tag(tag).ok_or(REFUSED)?;
    let dir = dir.ok_or(NOT_KEPT)?;
    keep(dir, language).map_err(|_| NOT_KEPT)?;
    Ok(language == spoken)
}

/// Settle this run's language from the kept file. Called once from `main`, right after the runtime
/// is built: before `setup` builds the menu and before host mode stands up the tray.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub fn settle<R: tauri::Runtime>(app: &tauri::App<R>) {
    use tauri::Manager;
    let dir = app.path().app_data_dir().ok();
    let _ = SPOKEN.set(at_launch(dir.as_deref()));
}

/// The language this run speaks. English until `settle` has run, and in a build that never does.
pub fn spoken() -> Language {
    SPOKEN.get().copied().unwrap_or(Language::En)
}

/// The words of the language this run speaks.
pub fn words() -> &'static Words {
    Words::of(spoken())
}

/// The window's choice of language for the shell's own words, from the main window only. Answers
/// `true` when this run already speaks it and `false` when the next launch will.
#[cfg(feature = "local-engine")]
#[tauri::command]
pub fn set_shell_language<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    language: String,
) -> Result<bool, String> {
    use tauri::Manager;
    if window.label() != "main" {
        return Err("the shell's language is the main window's".into());
    }
    let dir = window.app_handle().path().app_data_dir().ok();
    take(dir.as_deref(), &language, spoken()).map_err(String::from)
}

#[cfg(test)]
#[path = "shell_language_tests.rs"]
mod tests;
