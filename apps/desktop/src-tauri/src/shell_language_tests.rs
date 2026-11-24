//! The language channel: two tags exactly, kept for the next launch, English otherwise.

use super::*;

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ohmail-shell-language-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn kept_text(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(KEPT_FILE)).ok()
}

#[test]
fn nothing_kept_is_english() {
    let dir = scratch("nothing");
    assert_eq!(at_launch(None), Language::En);
    assert_eq!(at_launch(Some(&dir)), Language::En);
    assert_eq!(read_kept(&dir), None);
}

#[test]
fn a_choice_is_kept_and_the_next_launch_speaks_it() {
    let dir = scratch("kept");
    assert_eq!(take(Some(&dir), "de", Language::En), Ok(false), "English does not speak German yet");
    assert_eq!(kept_text(&dir).as_deref(), Some("de\n"));
    assert_eq!(at_launch(Some(&dir)), Language::De);
    assert_eq!(take(Some(&dir), "de", Language::De), Ok(true), "a German run already speaks it");
    assert_eq!(take(Some(&dir), "en", Language::De), Ok(false));
    assert_eq!(kept_text(&dir).as_deref(), Some("en\n"), "returning to English is kept too");
    assert_eq!(at_launch(Some(&dir)), Language::En);
    assert_eq!(take(Some(&dir), "en", Language::En), Ok(true));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn anything_but_the_two_tags_is_refused_and_the_file_is_left_alone() {
    let dir = scratch("refused");
    keep(&dir, Language::De).unwrap();
    let huge = "d".repeat(1 << 20);
    for junk in ["", "DE", "de-CH", " de", "de ", "de\n", "fr", "english", huge.as_str()] {
        let answer = take(Some(&dir), junk, Language::En);
        assert_eq!(answer, Err(REFUSED), "{:?} was taken", &junk[..junk.len().min(12)]);
        assert_eq!(kept_text(&dir).as_deref(), Some("de\n"), "a refusal touched the kept file");
    }
    assert!(!REFUSED.contains("fr"), "the refusal repeats its argument");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_choice_with_nowhere_to_keep_it_is_not_taken() {
    assert_eq!(take(None, "de", Language::En), Err(NOT_KEPT));
    assert_eq!(take(None, "fr", Language::En), Err(REFUSED));
    // A directory that cannot be made: its parent is a file.
    let dir = scratch("blocked");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("not-a-dir");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(take(Some(&file.join("inner")), "de", Language::En), Err(NOT_KEPT));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn junk_in_the_kept_file_reads_as_english() {
    let dir = scratch("junk");
    std::fs::create_dir_all(&dir).unwrap();
    for junk in ["", "DE\n", "de-CH\n", " de\n", "de\n\n", "fr\n", "dede", "de\nen\n"] {
        std::fs::write(dir.join(KEPT_FILE), junk).unwrap();
        assert_eq!(read_kept(&dir), None, "{junk:?} read as a language");
        assert_eq!(at_launch(Some(&dir)), Language::En);
    }
    std::fs::write(dir.join(KEPT_FILE), [b'd', b'e', 0xff, b'\n']).unwrap();
    assert_eq!(at_launch(Some(&dir)), Language::En, "bytes that are not text read as a language");
    std::fs::write(dir.join(KEPT_FILE), format!("de\n{}", " ".repeat(4096))).unwrap();
    assert_eq!(at_launch(Some(&dir)), Language::En, "a long file read as a language");
    // A tag written by hand, with or without its newline, is read.
    for written in ["de", "de\n", "de\r\n"] {
        std::fs::write(dir.join(KEPT_FILE), written).unwrap();
        assert_eq!(at_launch(Some(&dir)), Language::De, "{written:?}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn keeping_writes_only_on_a_change() {
    let dir = scratch("change");
    keep(&dir, Language::De).unwrap();
    // A folder nothing can be written in: keeping the same language again writes nothing, so it
    // still succeeds there, and a change cannot be written.
    let mut perms = std::fs::metadata(&dir).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&dir, perms.clone()).unwrap();
    let same = keep(&dir, Language::De);
    let other = take(Some(&dir), "en", Language::De);
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    std::fs::set_permissions(&dir, perms).unwrap();
    assert!(same.is_ok(), "an unchanged choice was written: {same:?}");
    if other.is_err() {
        // Not as root, which writes anyway: the change was refused and the old choice stands.
        assert_eq!(other, Err(NOT_KEPT));
        assert_eq!(at_launch(Some(&dir)), Language::De);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_unsettled_run_speaks_english() {
    // No test settles the run: `settle` needs the real app, and before it the shell is English.
    assert_eq!(spoken(), Language::En);
    assert_eq!(words().rows(), crate::words::EN.rows());
}
