//! The preview's staging and its scheme, against the stand-in engine (`engine_tests.rs`, mode
//! `stage`), which writes the part into the file the shell named exactly as the real one does.

use super::*;
use crate::engine::tests::{quick, wait_for, Fixture};
use crate::engine::EngineState;
use std::time::Duration;

const ID: &str = "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c3d2e";
const MIB: usize = 1024 * 1024;

fn staging_engine(f: &Fixture, bytes: usize, status: Option<u16>) -> Engine {
    let mut launch = f.launch("stage");
    launch.env.push(("FAKE_STAGE_BYTES".into(), bytes.to_string().into()));
    if let Some(s) = status {
        launch.env.push(("FAKE_STAGE_STATUS".into(), s.to_string().into()));
    }
    let engine = Engine::spawn_with(launch, quick());
    wait_for(|| matches!(engine.state(), EngineState::Serving { .. }), Duration::from_secs(10), "Serving");
    engine
}

fn root_of(f: &Fixture) -> PathBuf {
    let root = f.dir.join("opened");
    fs::create_dir_all(&root).expect("root");
    root
}

fn pattern(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i.wrapping_mul(31) & 255) as u8).collect()
}

fn parts_in(root: &Path) -> usize {
    fs::read_dir(root).map(|d| d.flatten().count()).unwrap_or(0)
}

fn token_of(v: &serde_json::Value) -> String {
    v["token"].as_str().expect("token").to_string()
}

/// AN 8 AND A 40 MiB PICTURE ARE STAGED AND SERVED WHOLE, by token, as the type staged.
#[test]
fn an_8_and_a_40_mib_image_preview_is_served_whole() {
    for n in [8 * MIB, 40 * MIB] {
        let f = Fixture::new("preview-image");
        let engine = staging_engine(&f, n, None);
        let root = root_of(&f);
        let previews = Previews::default();
        let staged = stage_preview(&engine, &root, &previews, ID, "image/png").expect("staged");
        assert_eq!(staged["size"], n as u64);
        let token = token_of(&staged);
        assert_eq!(staged["url"], preview_url(&token));
        assert!(staged.get("text64").is_none(), "an image's bytes came back to the window");
        let res = answer(&previews, &root, "main", "GET", &format!("/{token}"));
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(res.headers()["x-content-type-options"], "nosniff");
        assert_eq!(res.headers()["content-security-policy"], "default-src 'none'; sandbox");
        assert!(res.body() == &pattern(n), "the {n}-byte picture was not served whole");
        engine.stop(crate::engine::Leaving::Quit);
    }
}

/// TEXT COMES BACK INLINE UNDER THE CAP, AND ABOVE IT ONLY AS "TOO LARGE"; NO FILE STAYS EITHER WAY.
#[test]
fn text_comes_back_inline_under_the_cap_and_not_above_it() {
    use base64::Engine as _;
    // The value is the measured one (38 MiB of renderer at 2 MiB, 51 at 4), pinned as a number.
    assert_eq!(TEXT_PREVIEW_MAX_BYTES, 2 * 1024 * 1024);
    let cap = TEXT_PREVIEW_MAX_BYTES as usize;
    for (n, inline) in [(MIB, true), (cap, true), (cap + 1, false), (2 * MIB + 1, false), (4 * MIB, false), (40 * MIB, false)] {
        let f = Fixture::new("preview-text");
        let engine = staging_engine(&f, n, None);
        let root = root_of(&f);
        let previews = Previews::default();
        let got = stage_preview(&engine, &root, &previews, ID, "text/plain; charset=utf-8").expect("staged");
        if inline {
            let text = base64::engine::general_purpose::STANDARD.decode(got["text64"].as_str().expect("text64")).expect("b64");
            assert!(text == pattern(n), "the {n}-byte text did not come back whole");
        } else {
            assert_eq!(got["tooLarge"], true, "{n} bytes came back as text, not as too large");
            assert!(got.get("text64").is_none(), "{n} bytes of text crossed to the window");
        }
        assert_eq!(parts_in(&root), 0, "a text preview left its staged file");
        assert_eq!(previews.len(), 0);
        engine.stop(crate::engine::Leaving::Quit);
    }
}

/// A REQUEST FOR ANYTHING BUT A TOKEN THIS PROCESS STAGED IN ITS OWN FOLDER IS REFUSED.
#[test]
fn a_request_outside_the_staging_folder_is_refused() {
    let f = Fixture::new("preview-scope");
    let root = root_of(&f);
    let outside = f.dir.join("outside");
    fs::create_dir_all(&outside).expect("outside");
    let secret = outside.join("secret.png");
    fs::write(&secret, b"not yours").expect("secret");
    let previews = Previews::default();
    let good = "0123456789abcdef0123456789abcdef";
    let inside = root.join(format!("{}.part", "a".repeat(32)));
    fs::write(&inside, b"pixels").expect("inside");
    previews.insert(Staged { token: good.into(), path: inside.clone(), size: 6, mime: "image/png" });
    // A table entry naming a file outside the folder, as a bug elsewhere could plant one.
    let planted = "fedcba9876543210fedcba9876543210";
    previews.insert(Staged { token: planted.into(), path: secret.clone(), size: 9, mime: "image/png" });
    assert_eq!(answer(&previews, &root, "main", "GET", &format!("/{good}")).status(), StatusCode::OK);

    let secret_path = secret.to_string_lossy().into_owned();
    for path in [
        "/../../etc/passwd".to_string(),
        "/..%2f..%2fetc%2fpasswd".to_string(),
        "/etc/passwd".to_string(),
        secret_path.clone(),
        format!("/{secret_path}"),
        format!("/{}", good.to_uppercase()),
        format!("/{good}/x"),
        format!("/{good}/../{good}"),
        format!("//{good}"),
        format!("/{planted}"),
        "/00000000000000000000000000000000".to_string(),
        String::new(),
        "/".to_string(),
    ] {
        let res = answer(&previews, &root, "main", "GET", &path);
        assert_eq!(res.status(), StatusCode::NOT_FOUND, "{path:?} was served");
        assert!(res.body().is_empty(), "{path:?} answered with a body");
    }
    assert_eq!(answer(&previews, &root, "updater", "GET", &format!("/{good}")).status(), StatusCode::FORBIDDEN);
    assert_eq!(answer(&previews, &root, "main", "POST", &format!("/{good}")).status(), StatusCode::METHOD_NOT_ALLOWED);

    // A staged file swapped for a link to a file outside, or grown since, is refused too.
    #[cfg(unix)]
    {
        fs::remove_file(&inside).expect("rm");
        std::os::unix::fs::symlink(&secret, &inside).expect("link");
        assert_eq!(answer(&previews, &root, "main", "GET", &format!("/{good}")).status(), StatusCode::NOT_FOUND);
        fs::remove_file(&inside).expect("rm link");
    }
    // The same swap on Windows: a file symlink (the CI runner is elevated, which creating one
    // needs), refused because canonicalize resolves it to a path outside the staging folder.
    #[cfg(windows)]
    {
        fs::remove_file(&inside).expect("rm");
        std::os::windows::fs::symlink_file(&secret, &inside).expect("link (needs an elevated or Developer Mode session)");
        assert_eq!(answer(&previews, &root, "main", "GET", &format!("/{good}")).status(), StatusCode::NOT_FOUND);
        fs::remove_file(&inside).expect("rm link");
    }
    fs::write(&inside, b"pixels and more").expect("grown");
    assert_eq!(answer(&previews, &root, "main", "GET", &format!("/{good}")).status(), StatusCode::NOT_FOUND);
    assert_eq!(fs::read(&secret).expect("secret"), b"not yours");
}

/// THE STAGED FILE GOES WHEN THE PREVIEW CLOSES, WHEN IT IS EVICTED, AND WHEN THE APP EXITS.
#[test]
fn the_staged_file_is_removed_on_release_eviction_and_exit() {
    let f = Fixture::new("preview-cleanup");
    let engine = staging_engine(&f, 4096, None);
    let root = root_of(&f);
    let previews = Previews::default();
    let a = token_of(&stage_preview(&engine, &root, &previews, ID, "image/jpeg").expect("a"));
    let b = token_of(&stage_preview(&engine, &root, &previews, ID, "image/webp").expect("b"));
    assert_eq!(parts_in(&root), 2);
    previews.release(&a);
    assert_eq!(parts_in(&root), 1, "the closed preview's file stayed");
    assert_eq!(answer(&previews, &root, "main", "GET", &format!("/{a}")).status(), StatusCode::NOT_FOUND);
    assert_eq!(answer(&previews, &root, "main", "GET", &format!("/{b}")).status(), StatusCode::OK);
    previews.release("0123456789abcdef0123456789abcdef");
    previews.release(&a);
    assert_eq!(parts_in(&root), 1);
    let more: Vec<String> = (0..PREVIEWS_KEPT)
        .map(|_| token_of(&stage_preview(&engine, &root, &previews, ID, "image/gif").expect("more")))
        .collect();
    assert_eq!(previews.len(), PREVIEWS_KEPT);
    assert_eq!(parts_in(&root), PREVIEWS_KEPT, "an evicted preview left its file");
    assert_eq!(answer(&previews, &root, "main", "GET", &format!("/{b}")).status(), StatusCode::NOT_FOUND);
    assert_eq!(answer(&previews, &root, "main", "GET", &format!("/{}", more[0])).status(), StatusCode::OK);
    previews.release_all();
    assert_eq!(parts_in(&root), 0, "the exit left staged files");
    assert_eq!(previews.len(), 0);
    engine.stop(crate::engine::Leaving::Quit);
}

/// A REFUSED PART IS THE ENGINE'S REFUSAL AND LEAVES NO FILE; A TYPE WITH NO PREVIEW ASKS NOTHING.
#[test]
fn a_refusal_leaves_nothing_and_other_types_are_not_staged() {
    let f = Fixture::new("preview-refused");
    let engine = staging_engine(&f, 4096, Some(413));
    let root = root_of(&f);
    let previews = Previews::default();
    let err = stage_preview(&engine, &root, &previews, ID, "image/png").expect_err("refused");
    assert_eq!(err["status"], 413);
    assert_eq!(err["code"], "payload_too_large");
    assert_eq!(parts_in(&root), 0);
    engine.stop(crate::engine::Leaving::Quit);

    let f = Fixture::new("preview-types");
    let engine = staging_engine(&f, 4096, None);
    let root = root_of(&f);
    for mime in ["image/svg+xml", "application/pdf", "text/html-ish/../x", "application/octet-stream", ""] {
        let staged = stage_preview(&engine, &root, &previews, ID, mime);
        if mime.starts_with("text/") {
            assert!(staged.is_ok(), "{mime}");
        } else {
            assert!(staged.is_err(), "{mime} was staged for a preview");
        }
    }
    assert!(stage_preview(&engine, &root, &previews, "../../etc/passwd", "image/png").is_err());
    assert_eq!(parts_in(&root), 0);
    assert_eq!(previews.len(), 0);
    engine.stop(crate::engine::Leaving::Quit);
}

/// THE BACKSTOP HOLDS A BYTE BOUND TOO: past 512 MiB staged the oldest goes, never the newest.
#[test]
fn the_backstop_evicts_by_bytes_as_well_as_by_count() {
    let f = Fixture::new("preview-bytes");
    let root = root_of(&f);
    let previews = Previews::default();
    let mut paths = Vec::new();
    for i in 0..3u8 {
        let path = root.join(format!("{}.part", format!("{i:x}").repeat(32)));
        fs::write(&path, b"x").expect("staged");
        previews.insert(Staged { token: format!("{i:x}").repeat(32), path: path.clone(), size: 200 * 1024 * 1024, mime: "image/png" });
        paths.push(path);
    }
    assert_eq!(previews.len(), 2, "600 MiB staged is over the byte bound");
    assert!(!paths[0].exists() && paths[1].exists() && paths[2].exists(), "the wrong file went");
    let huge = root.join(format!("{}.part", "f".repeat(32)));
    fs::write(&huge, b"x").expect("huge");
    previews.insert(Staged { token: "f".repeat(32), path: huge.clone(), size: 600 * 1024 * 1024, mime: "image/png" });
    assert_eq!(previews.len(), 1, "the newest is kept even alone over the bound");
    assert!(huge.exists());
}

/// THE TOKEN IS 128 BITS FROM THE OS SOURCE: 32 lowercase hex, fresh each time, every position
/// moving (a counter or a clock would hold its leading characters still).
#[test]
fn a_token_is_sixteen_random_bytes() {
    let tokens: Vec<String> = (0..64).map(|_| token().expect("token")).collect();
    let distinct: std::collections::HashSet<&String> = tokens.iter().collect();
    assert_eq!(distinct.len(), tokens.len(), "a token repeated");
    for t in &tokens {
        assert!(t.len() == 32 && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "{t}");
    }
    for at in 0..32 {
        let seen: std::collections::HashSet<u8> = tokens.iter().map(|t| t.as_bytes()[at]).collect();
        assert!(seen.len() > 1, "position {at} never changed over 64 tokens");
    }
}

/// AT LAUNCH THE STAGED FILES A CRASH OR AN UPDATE LEFT ARE REMOVED, AND NOTHING ELSE.
#[test]
fn the_launch_sweep_takes_only_staged_files() {
    let f = Fixture::new("preview-sweep");
    let root = root_of(&f);
    let left = [root.join(format!("{}.part", "a".repeat(32))), root.join(format!("{}.part", "0123456789abcdef".repeat(2)))];
    for p in &left {
        fs::write(p, b"left").expect("left");
    }
    let other = root.join("notes.txt");
    fs::write(&other, b"keep").expect("other");
    let dir = root.join(format!("{}.part", "b".repeat(32)));
    fs::create_dir_all(&dir).expect("dir");
    // Upper-case hex is not a staged name. A letter no other entry uses: on a case-insensitive
    // filesystem (macOS, Windows) `A…` and `a…` are one file.
    let upper = root.join(format!("{}.part", "C".repeat(32)));
    fs::write(&upper, b"keep").expect("upper");
    sweep_staged(&root);
    assert!(left.iter().all(|p| !p.exists()), "a staged file survived the launch sweep");
    assert!(other.exists() && dir.exists() && upper.exists(), "the sweep took something it never staged");
    sweep_staged(&f.dir.join("absent"));
}

/// THE URL IS THE PLATFORM'S SPELLING OF THIS SCHEME AND CARRIES NOTHING BUT THE TOKEN.
#[test]
fn the_preview_url_names_only_the_token() {
    let t = "0123456789abcdef0123456789abcdef";
    let url = preview_url(t);
    if cfg!(windows) {
        assert_eq!(url, format!("http://attachment-preview.localhost/{t}"));
    } else {
        assert_eq!(url, format!("attachment-preview://localhost/{t}"));
    }
}
