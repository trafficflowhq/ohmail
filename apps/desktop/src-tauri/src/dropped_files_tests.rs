//! The drop watch (`dropped_files.rs`): a drag's data and its drop paired in either order and only
//! from another program; the held drop taken once within ten seconds; each file opened once and
//! read in bounded chunks by the take's token; names only, never a path. Driven with an injected
//! clock and real files in a directory of the test's own.

use super::*;
use std::fs;

const MIB: usize = 1024 * 1024;

/// A directory of this test's own, removed when it goes.
struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Self {
        let token = crate::attachment_preview::token().expect("a token");
        let dir = std::env::temp_dir().join(format!("ohmail-dropped-{tag}-{}-{token}", std::process::id()));
        fs::create_dir_all(&dir).expect("scratch");
        Self(dir)
    }

    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, bytes).expect("write");
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Every platform's opener, for the cases that are not about the descriptor's kind.
fn portable(path: &Path) -> Result<Reader, (Taken, u64)> {
    File::open(path).and_then(Reader::of).map_err(|_| (Taken::Unreadable, 0))
}

fn no_kind(_: &str) -> String {
    String::new()
}

fn pattern(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i.wrapping_mul(31) & 255) as u8).collect()
}

fn token_of(answer: &serde_json::Value) -> String {
    answer["drop"].as_str().expect("a drop token").to_string()
}

/// One taken file read to its end through `chunk`, as the window reads it: the bytes and each
/// chunk's size.
fn read_all(dropped: &DroppedFiles, token: &str, index: usize, now: Instant) -> Result<(Vec<u8>, Vec<usize>), String> {
    use base64::Engine as _;
    let (mut bytes, mut sizes) = (Vec::new(), Vec::new());
    loop {
        let answer = dropped.chunk(token, index, now)?;
        let chunk = base64::engine::general_purpose::STANDARD
            .decode(answer["bytes64"].as_str().expect("bytes64"))
            .expect("base64");
        sizes.push(chunk.len());
        bytes.extend(chunk);
        if answer["end"] == true {
            return Ok((bytes, sizes));
        }
        assert!(sizes.len() < 64, "the chunks never ended");
    }
}

/// The webview's drag signals as `hook` gets them, every drag on ONE drag context: GTK's Wayland
/// backend makes one drop context per seat and hands it to every drag.
#[derive(Clone, Copy)]
enum Gtk {
    DragMotion,
    /// `drag-data-received` with a `text/uri-list` of these local files, from another program.
    DataReceived(&'static [&'static str]),
    /// The same from a drag this webview started.
    OwnDataReceived(&'static [&'static str]),
    /// Also emitted by GTK right before `drag-drop`.
    DragLeave,
    DragDrop,
    /// A turn of the main loop, where a leave's deferred reset runs.
    Idle,
}
use Gtk::*;

const TAX: &str = "/home/u/Documents/tax-return.pdf";
/// A file from the file manager dropped on the view: its data on the first motion, then GTK's
/// leave and drop.
const DROP_TAX: &[Gtk] = &[DragMotion, DataReceived(&[TAX]), DragMotion, DragLeave, DragDrop, Idle];
/// The same file dragged across the window on its way to another program.
const PASS_TAX: &[Gtk] = &[DragMotion, DataReceived(&[TAX]), DragMotion, DragLeave, Idle];
/// A recipient chip moved from To to Cc, or text moved in the body: the page's own drag, no uri-list.
const MOVE_CHIP: &[Gtk] = &[DragMotion, DragMotion, DragLeave, DragDrop, Idle];

/// The names a take answers after these signals, driven as `hook` drives the pairing and the shelf;
/// `None` when nothing is held.
fn held_after(signals: &[Gtk]) -> Option<Vec<String>> {
    let mut pairing = DragPairing::default();
    let dropped = DroppedFiles::default();
    let mut leaves = Vec::new();
    let local = |paths: &[&str]| paths.iter().map(PathBuf::from).collect::<Vec<_>>();
    for signal in signals {
        match *signal {
            DragMotion => pairing.motion(),
            DataReceived(paths) => pairing.data(true, local(paths)),
            OwnDataReceived(paths) => pairing.data(false, local(paths)),
            DragLeave => leaves.push(pairing.left()),
            DragDrop => dropped.hold(pairing.dropped(), Instant::now()),
            Idle => leaves.drain(..).for_each(|epoch| pairing.settle_leave(epoch)),
        }
    }
    let answer = dropped.take_with(Instant::now(), |_| Err((Taken::Unreadable, 0)), no_kind).expect("take");
    let files = answer["files"].as_array()?;
    Some(files.iter().map(|f| f["name"].as_str().unwrap_or_default().to_string()).collect())
}

/// A FILE DROPPED ON THE VIEW IS HELD, once, from the data its drag delivered before the drop;
/// data that arrives after the drop is held by nobody (WebKit dropped without it), not even by a
/// drop with no motion before it. Mutation: take data with no drag over the view → red.
#[test]
fn a_file_dropped_after_its_drag_delivered_its_data_is_held() {
    assert_eq!(held_after(DROP_TAX), Some(vec!["tax-return.pdf".to_string()]));
    let late = [DragMotion, DragLeave, DragDrop, Idle, DataReceived(&[TAX]), DragDrop];
    assert_eq!(held_after(&late), None);

    let mut pairing = DragPairing::default();
    pairing.motion();
    pairing.data(true, vec![PathBuf::from(TAX)]);
    assert_eq!(pairing.dropped(), [PathBuf::from(TAX)]);
    assert!(pairing.dropped().is_empty(), "one drag's files were handed over twice");
}

/// A LEAVE'S DEFERRED RESET SPARES THE DROP GTK EMITS RIGHT AFTER IT, AND THE NEXT DRAG.
/// Mutation: settle a leave whatever came since → red.
#[test]
fn a_leaves_deferred_reset_spares_the_drop_after_it_and_the_next_drag() {
    // The first drop's leave settles only once the next drag has moved in and delivered its data.
    let signals = [
        DragMotion, DataReceived(&["/a.txt"]), DragLeave, DragDrop,
        DragMotion, DataReceived(&[TAX]), Idle, DragLeave, DragDrop, Idle,
    ];
    assert_eq!(held_after(&signals), Some(vec!["tax-return.pdf".to_string()]));
}

/// A FILE THAT ONLY PASSES OVER THE WINDOW IS NEVER HELD, whatever drop came before or after it
/// on the same context. Mutation: no deferred reset at a leave → the second goes red.
#[test]
fn a_file_that_only_passes_over_is_never_held_beside_another_drop() {
    assert_eq!(held_after(&[MOVE_CHIP, PASS_TAX].concat()), None, "held at its first motion after a chip drop");
    assert_eq!(held_after(&[PASS_TAX, MOVE_CHIP].concat()), None, "held by the next chip drop");
    assert_eq!(held_after(&[PASS_TAX, &[DragDrop]].concat()), None, "held by a drop with no motion");
}

/// A DROP THAT BRINGS NO FILES CLEARS AN EARLIER ONE, so a take never answers an earlier drag.
#[test]
fn a_drop_without_files_clears_the_one_before_it() {
    assert_eq!(held_after(&[DROP_TAX, MOVE_CHIP].concat()), None);
}

/// A DRAG THIS PROCESS STARTED IS NEVER HELD: a page script's `dragstart` can put any `file:` URI
/// on the drag. Mutation: drop the `from_another_program` test → red.
#[test]
fn a_drag_this_process_started_is_never_held() {
    let own = [DragMotion, OwnDataReceived(&["/etc/passwd"]), DragMotion, DragLeave, DragDrop, Idle];
    assert_eq!(held_after(&own), None);
}

/// ONLY LOCAL `file:` URIS BECOME PATHS, decoded by GLib: percent escapes, `localhost`, a bare
/// `file:/path`, no other host, no other scheme, no fragment or query, nothing relative.
#[cfg(target_os = "linux")]
#[test]
fn only_local_file_uris_become_paths() {
    let uris = [
        "file:///tmp/a%20b.txt",
        "file://localhost/tmp/c.pdf",
        "FILE:///tmp/D.TXT",
        "file://otherhost/tmp/e",
        "https://example.org/f",
        "file:relative",
        "file:///tmp/g#fragment",
        "file:///tmp/i?q=1",
        "",
        "file:/tmp/h",
    ];
    assert_eq!(
        local_paths(&uris),
        ["/tmp/a b.txt", "/tmp/c.pdf", "/tmp/D.TXT", "/tmp/h"].map(PathBuf::from)
    );
}

/// TAKEN ONCE, WITHIN TEN SECONDS, AND THE LATEST DROP WINS. Mutations: `<=` for `<` on the
/// bound, or keep the held drop after a take → red.
#[test]
fn the_drop_is_taken_once_within_ten_seconds_and_a_newer_one_replaces_it() {
    let s = Scratch::new("take");
    let (a, b) = (s.file("a.txt", b"a"), s.file("b.txt", b"b"));
    let t0 = Instant::now();

    let dropped = DroppedFiles::default();
    dropped.hold(vec![a.clone()], t0);
    let first = dropped.take_with(t0 + HOLD_FOR - Duration::from_millis(1), portable, no_kind).expect("take");
    assert_eq!(first["files"][0]["name"], "a.txt");
    assert!(dropped.take_with(t0 + Duration::from_secs(1), portable, no_kind).expect("take").is_null());

    dropped.hold(vec![a.clone()], t0);
    assert!(dropped.take_with(t0 + HOLD_FOR, portable, no_kind).expect("take").is_null(), "a stale drop was taken");

    dropped.hold(vec![a.clone()], t0);
    dropped.hold(vec![b], t0 + Duration::from_secs(1));
    let latest = dropped.take_with(t0 + Duration::from_secs(2), portable, no_kind).expect("take");
    assert_eq!(latest["files"].as_array().map(Vec::len), Some(1));
    assert_eq!(latest["files"][0]["name"], "b.txt");
    assert_eq!(latest["files"][0]["state"], "ok");
    assert_eq!(latest["files"][0]["size"], 1);

    dropped.hold(vec![a], t0);
    dropped.hold(Vec::new(), t0 + Duration::from_secs(1));
    let after = dropped.take_with(t0 + Duration::from_secs(2), portable, no_kind).expect("take");
    assert!(after.is_null(), "a drop that brought no files left something to take: {after}");
}

/// THE WINDOW GETS NAMES, NEVER PATHS: the last component, control characters stripped.
#[test]
fn the_answer_names_each_file_by_its_last_component_only() {
    let s = Scratch::new("names");
    fs::create_dir_all(s.0.join("deep/er")).expect("dirs");
    let nested = s.file("deep/er/Quarterly report.pdf", b"%PDF");
    let dropped = DroppedFiles::default();
    dropped.hold(vec![nested], Instant::now());
    let answer = dropped.take_with(Instant::now(), portable, no_kind).expect("take");
    assert_eq!(answer["files"][0]["name"], "Quarterly report.pdf");
    let text = answer.to_string();
    assert!(!text.contains(s.0.to_string_lossy().as_ref()), "a path reached the window: {text}");
    assert!(!text.contains("deep"), "a directory reached the window: {text}");
    // No file needed, so Windows, which refuses control characters in names, runs it too.
    assert_eq!(shown_name(Path::new("dir/bell\u{7}name.txt")), "bellname.txt");
    assert_eq!(shown_name(Path::new("/")), "");
}

/// A CONTROL CHARACTER IN A DROPPED FILE'S NAME NEVER REACHES THE WINDOW.
#[cfg(unix)]
#[test]
fn a_dropped_name_reaches_the_window_without_its_control_characters() {
    let s = Scratch::new("bell");
    let dropped = DroppedFiles::default();
    dropped.hold(vec![s.file("bell\u{7}name.txt", b"x")], Instant::now());
    let answer = dropped.take_with(Instant::now(), portable, no_kind).expect("take");
    assert_eq!(answer["files"][0]["name"], "bellname.txt");
    assert_eq!(answer["files"][0]["state"], "ok");
}

/// A FIFO, A FOLDER AND A DEVICE ANSWER `unreadable`, AND THE FIFO DOES NOT HOLD THE TAKE.
/// Mutation: drop `O_NONBLOCK` → the open waits for a writer and the bound below goes red.
#[cfg(target_os = "linux")]
#[test]
fn a_fifo_a_folder_and_a_device_answer_unreadable_and_the_fifo_does_not_block() {
    let s = Scratch::new("kinds");
    let fifo = s.0.join("pipe");
    let c_path = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).expect("c path");
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0, "mkfifo");
    let folder = s.0.join("folder");
    fs::create_dir_all(&folder).expect("folder");
    let plain = s.file("plain.txt", b"plain");

    let dropped = DroppedFiles::default();
    dropped.hold(vec![fifo, folder, PathBuf::from("/dev/null"), plain], Instant::now());
    let (tx, rx) = std::sync::mpsc::channel();
    let taking = dropped.clone();
    std::thread::spawn(move || {
        let _ = tx.send(taking.take_with(Instant::now(), open, no_kind));
    });
    let answer = rx.recv_timeout(Duration::from_secs(10)).expect("the take blocked on the FIFO").expect("take");
    let states: Vec<&str> = answer["files"].as_array().expect("files").iter().map(|f| f["state"].as_str().unwrap_or("")).collect();
    assert_eq!(states, ["unreadable", "unreadable", "unreadable", "ok"]);
    let token = token_of(&answer);
    for index in 0..3 {
        assert!(dropped.chunk(&token, index, Instant::now()).is_err(), "entry {index} was left open");
    }
}

/// A SPARSE FILE OVER THE CEILING ANSWERS `too_large` WITH ITS SIZE AND IS NEVER READ: nothing is
/// left open for it.
#[cfg(target_os = "linux")]
#[test]
fn a_sparse_file_over_the_ceiling_answers_too_large_and_is_never_read() {
    let s = Scratch::new("sparse");
    let big = s.0.join("big.bin");
    let over = crate::engine::ATTACHMENT_MAX_BYTES as u64 + MIB as u64;
    File::create(&big).and_then(|f| f.set_len(over)).expect("sparse file");
    let at_ceiling = s.0.join("ceiling.bin");
    File::create(&at_ceiling).and_then(|f| f.set_len(crate::engine::ATTACHMENT_MAX_BYTES as u64)).expect("file");

    let dropped = DroppedFiles::default();
    dropped.hold(vec![big, at_ceiling], Instant::now());
    let answer = dropped.take_with(Instant::now(), open, no_kind).expect("take");
    assert_eq!(answer["files"][0]["state"], "too_large");
    assert_eq!(answer["files"][0]["size"], over);
    assert_eq!(answer["files"][1]["state"], "ok", "a file AT the ceiling is admitted");
    assert!(dropped.chunk(&token_of(&answer), 0, Instant::now()).is_err(), "the oversized file was opened for reading");
}

/// CHUNKS ARE AT MOST 1 MiB, CONCATENATE TO THE FILE, AND END ONCE; a wrong token or index is
/// refused. Mutation: read the whole file in one chunk → the sizes go red.
#[test]
fn chunks_are_at_most_a_mebibyte_and_concatenate_to_the_file() {
    let s = Scratch::new("chunks");
    let body = pattern(2 * MIB + MIB / 2);
    let path = s.file("photo.jpg", &body);
    let empty = s.file("empty.txt", b"");
    let dropped = DroppedFiles::default();
    dropped.hold(vec![path, empty], Instant::now());
    let answer = dropped.take_with(Instant::now(), portable, no_kind).expect("take");
    let token = token_of(&answer);
    assert_eq!(token.len(), 32);
    assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));

    assert!(dropped.chunk("0".repeat(32).as_str(), 0, Instant::now()).is_err(), "a wrong token was answered");
    assert!(dropped.chunk(&token, 2, Instant::now()).is_err(), "an index past the drop was answered");

    let (bytes, sizes) = read_all(&dropped, &token, 0, Instant::now()).expect("read");
    assert_eq!(sizes, [MIB, MIB, MIB / 2]);
    assert!(bytes == body, "the chunks do not concatenate to the file");
    assert!(dropped.chunk(&token, 0, Instant::now()).is_err(), "a chunk was answered after the end");

    let (nothing, sizes) = read_all(&dropped, &token, 1, Instant::now()).expect("read");
    assert!(nothing.is_empty());
    assert_eq!(sizes, [0]);
}

/// THE BYTES ARE THE FILE OPENED AT THE TAKE, even when its path is replaced afterwards.
/// Mutation: reopen the path for each chunk → the replacement's bytes come back and this goes red.
#[test]
fn the_bytes_are_the_file_opened_at_the_take_even_if_its_path_is_replaced() {
    let s = Scratch::new("replaced");
    let first = pattern(MIB + 17);
    let path = s.file("notes.txt", &first);
    let dropped = DroppedFiles::default();
    dropped.hold(vec![path.clone()], Instant::now());
    let answer = dropped.take_with(Instant::now(), portable, no_kind).expect("take");

    let other = s.file("other.txt", b"something else entirely");
    fs::rename(&other, &path).expect("replace the path");
    let (bytes, _) = read_all(&dropped, &token_of(&answer), 0, Instant::now()).expect("read");
    assert!(bytes == first, "the bytes are not the file that was dropped");
}

/// A FILE WRITTEN IN PLACE AFTER THE TAKE IS REFUSED mid-read rather than sent half old, half new.
#[test]
fn a_file_written_in_place_after_the_take_is_refused() {
    use std::io::Write;
    let s = Scratch::new("written");
    let path = s.file("growing.log", &pattern(2 * MIB));
    let dropped = DroppedFiles::default();
    dropped.hold(vec![path.clone()], Instant::now());
    let token = token_of(&dropped.take_with(Instant::now(), portable, no_kind).expect("take"));
    assert_eq!(dropped.chunk(&token, 0, Instant::now()).expect("first chunk")["end"], false);
    fs::OpenOptions::new().append(true).open(&path).and_then(|mut f| f.write_all(b"more")).expect("append");
    assert!(dropped.chunk(&token, 0, Instant::now()).is_err(), "a changed file kept being read");
    assert!(dropped.chunk(&token, 0, Instant::now()).is_err(), "a refused file stayed open");
}

/// TAKEN FILES CLOSE AT TWO MINUTES AND PAST FOUR TAKES.
#[test]
fn taken_files_close_at_two_minutes_and_past_four_takes() {
    let s = Scratch::new("claims");
    let path = s.file("a.txt", &pattern(3 * MIB));
    let t0 = Instant::now();
    let dropped = DroppedFiles::default();

    dropped.hold(vec![path.clone()], t0);
    let old = token_of(&dropped.take_with(t0, portable, no_kind).expect("take"));
    assert!(dropped.chunk(&old, 0, t0 + READ_FOR - Duration::from_millis(1)).is_ok());
    assert!(dropped.chunk(&old, 0, t0 + READ_FOR).is_err(), "a file stayed open past two minutes");

    let tokens: Vec<String> = (0..=MAX_CLAIMS)
        .map(|_| {
            dropped.hold(vec![path.clone()], t0);
            token_of(&dropped.take_with(t0, portable, no_kind).expect("take"))
        })
        .collect();
    assert!(dropped.chunk(&tokens[0], 0, t0).is_err(), "a fifth take left the first one open");
    for token in &tokens[1..] {
        assert!(dropped.chunk(token, 0, t0).is_ok());
    }
}

/// PAST A HUNDRED ENTRIES, `unreadable`, AND THOSE ARE NEVER OPENED.
#[test]
fn entries_past_the_hundredth_answer_unreadable_unopened() {
    let s = Scratch::new("many");
    let path = s.file("same.txt", b"same");
    let opened = std::cell::Cell::new(0);
    let counting = |p: &Path| {
        opened.set(opened.get() + 1);
        portable(p)
    };
    let dropped = DroppedFiles::default();
    dropped.hold(vec![path; MAX_FILES + 1], Instant::now());
    let answer = dropped.take_with(Instant::now(), counting, no_kind).expect("take");
    let files = answer["files"].as_array().expect("files");
    assert_eq!(files.len(), MAX_FILES + 1);
    assert!(files[..MAX_FILES].iter().all(|f| f["state"] == "ok"));
    assert_eq!(files[MAX_FILES]["state"], "unreadable");
    assert_eq!(opened.get(), MAX_FILES);
}

/// THE TYPE IS GIO'S GUESS FROM THE NAME, AND OCTET-STREAM IS SAID AS NOTHING.
#[cfg(target_os = "linux")]
#[test]
fn the_type_is_guessed_from_the_name_and_octet_stream_is_said_as_nothing() {
    assert_eq!(kind_of(""), "");
    for name in ["notes.txt", "photo.jpg", "report.pdf", "no-extension", "blob.bin"] {
        assert_ne!(kind_of(name), "application/octet-stream", "{name}");
    }
}

/// ONE LINE PER TAKE, COUNTS ONLY; and a failure to arm says why.
#[test]
fn a_take_writes_counts_and_a_failure_to_arm_its_reason() {
    assert_eq!(
        take_line(2, 1, 0),
        r#"{"service":"shell","event":"dropped_files","taken":3,"ok":2,"too_large":1,"unreadable":0}"#
    );
    assert_eq!(
        unarmed_line("no_window"),
        r#"{"service":"shell","event":"dropped_files","armed":false,"reason":"no_window"}"#
    );
}
