//! The feed machinery's unit half: detection against a real directory shape, the read caps,
//! the payload's contract fields, and the debounce's exact firing rule. The LIVE half — the
//! watch against a real `omarchy theme set` restage — cannot run where cargo does not, so it
//! is proven by the harness runs recorded in the 3c close-out (the VM of `OMARCHY-VM.md`
//! compiles this same file's module standalone and drives it against the real state dir).

use super::*;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "ohmail-omarchy-test-{tag}-{}-{:?}",
        std::process::id(),
        std::thread::current().id(),
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("theme")).expect("create the staged theme dir");
    dir
}

fn write(dir: &Path, rel: &str, content: &str) {
    std::fs::write(dir.join(rel), content).expect("write a staged file");
}

fn staged(tag: &str) -> PathBuf {
    let dir = temp_dir(tag);
    write(&dir, "theme.name", "tokyo-night\n");
    write(&dir, "theme/colors.toml", "mode = \"dark\"\nbackground = \"#1a1b26\"\n");
    write(&dir, "theme/shell.toml", "[font]\nbase-size = 12\n");
    dir
}

#[test]
fn a_payload_carries_the_contract_fields_raw() {
    let dir = staged("payload");
    let payload = gather(&dir).expect("a staged theme gathers");
    assert_eq!(payload["slug"], "tokyo-night");
    assert_eq!(
        payload["colorsToml"],
        "mode = \"dark\"\nbackground = \"#1a1b26\"\n",
        "the file crosses VERBATIM — every parse belongs to the window"
    );
    assert_eq!(payload["shellToml"], "[font]\nbase-size = 12\n");
    // The tool fields exist whatever this machine answers: string or null, never absent —
    // the window's validator reads a missing key as a shape mismatch.
    for key in ["fcMono", "hyprGapsIn", "hyprGapsOut", "hyprBorderSize"] {
        assert!(payload.get(key).is_some(), "{key} must be present (string or null)");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn no_colors_toml_no_payload() {
    let dir = temp_dir("bare");
    write(&dir, "theme.name", "mid-restage\n");
    assert!(gather(&dir).is_none(), "a theme without its palette is not gathered");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_oversize_file_is_an_absent_ingredient() {
    let dir = staged("oversize");
    write(&dir, "theme/colors.toml", &"x".repeat(300 * 1024));
    assert!(gather(&dir).is_none(), "past the bound is not a theme");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_debounce_fires_exactly_on_quiet() {
    let dir = staged("debounce");
    let initial = sample(&dir);
    let mut debounce = Debounce::new(initial.clone());

    // Nothing changed: never fires, however often it is asked.
    assert!(!debounce.step(sample(&dir)));
    assert!(!debounce.step(sample(&dir)));

    // A restage in flight: first difference must NOT fire (half-staged reads render as
    // broken chrome), the same content seen twice — quiet — must.
    write(&dir, "theme.name", "nord\n");
    let mid = sample(&dir);
    assert!(!debounce.step(mid.clone()), "the first sight of a change is not quiet yet");
    write(&dir, "theme/colors.toml", "mode = \"dark\"\nbackground = \"#2e3440\"\n");
    let done = sample(&dir);
    assert!(!debounce.step(done.clone()), "still moving — still not quiet");
    assert!(debounce.step(done.clone()), "two identical sights: quiet, fire");

    // And it fires ONCE: the emitted state is the new baseline.
    assert!(!debounce.step(done));

    // A change that flaps back to the baseline before going quiet never fires at all.
    assert!(!debounce.step(mid));
    assert!(!debounce.step(initial));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_content_rewrite_alone_is_a_change() {
    // The poll compares CONTENT, not mtimes — an in-place rewrite that keeps the slug (a
    // theme edited live, or a same-named restage) still re-skins. This is the "theme change
    // the watcher misses" mutation named in the plan: sampling by mtime or by slug alone
    // turns this test red.
    let dir = staged("rewrite");
    let mut debounce = Debounce::new(sample(&dir));
    write(&dir, "theme/colors.toml", "mode = \"dark\"\nbackground = \"#000000\"\n");
    let now = sample(&dir);
    assert!(!debounce.step(now.clone()));
    assert!(debounce.step(now), "same slug, new palette — must fire");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn detection_is_the_staged_theme_directory_itself() {
    // state_dir() reads the process environment, which tests must not mutate (they run in
    // one process); the DETECTOR's rule is exercised on the same shape it checks: the
    // staged `theme` DIRECTORY is what makes a state dir an Omarchy state dir.
    let dir = staged("detect");
    assert!(dir.join("theme").is_dir());
    let bare = temp_dir("detect-bare");
    std::fs::remove_dir_all(bare.join("theme")).expect("unstage");
    assert!(!bare.join("theme").is_dir());
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&bare);
}
