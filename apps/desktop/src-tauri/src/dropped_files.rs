//! FILES DROPPED ON THE WINDOW FROM ANOTHER PROGRAM, READ BY THE SHELL.
//!
//! WebKitGTK hands a file manager's drop to the page as `text/uri-list` with its data withheld and
//! no File objects, and its own default inserts the path as text where the drop lands. The shell
//! sees the same drop natively: the webview's `drag-data-received` carries the URIs and `drag-drop`
//! the drop. A drop is held only when the drag over the view delivered its URIs before its drop, as
//! WebKit needs them for the drop it hands the page, and came from another program: a drag a page
//! script starts has this webview as its source widget and is never held, so no script can make a
//! drop. Each drop replaces the last, and one that brought no files leaves nothing. The window
//! takes the latest drop once, within ten seconds, by a command that takes nothing, and reads each
//! file in chunks by the token the take answered. Each file is opened once, at the take, and read
//! only from that descriptor. No command takes a path, a URI or a name, and no log line carries
//! one. Only Linux arms the watch; elsewhere nothing is ever held and a take answers nothing.

use std::collections::VecDeque;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

#[cfg(test)]
#[path = "dropped_files_tests.rs"]
mod tests;

/// How long a drop waits for the compose it landed on to take it.
pub(crate) const HOLD_FOR: Duration = Duration::from_secs(10);
/// How long a taken file stays open for its reads.
pub(crate) const READ_FOR: Duration = Duration::from_secs(120);
/// The most files one take opens; every entry past it answers `unreadable`.
pub(crate) const MAX_FILES: usize = 100;
/// The most takes whose files stay open at once; the oldest is closed first.
pub(crate) const MAX_CLAIMS: usize = 4;
/// The most bytes one chunk carries, before base64.
pub(crate) const CHUNK_BYTES: usize = 1024 * 1024;

/// The drag over the webview and what it delivered, followed by its own signals: GTK's drag
/// context cannot tell drags apart, as its Wayland backend hands one context to every drag of a
/// seat. So a drag starts at the first motion after a drop or a settled leave, where WebKit asks
/// for its data again, and nothing of it outlives its drop or its leave.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Default)]
pub(crate) struct DragPairing {
    over: bool,
    /// The local files the drag's `text/uri-list` named; none when this process started it.
    paths: Vec<PathBuf>,
    /// Moves on at each new drag and each drop, which a leave's deferred reset must not undo.
    epoch: u64,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
impl DragPairing {
    /// The pointer moved over the view.
    pub(crate) fn motion(&mut self) {
        if !self.over {
            *self = Self { over: true, paths: Vec::new(), epoch: self.epoch + 1 };
        }
    }

    /// The drag's URIs arrived, as local paths. With no drag over the view they came after its drop
    /// or its leave, and WebKit drops without them.
    pub(crate) fn data(&mut self, from_another_program: bool, paths: Vec<PathBuf>) {
        if self.over {
            self.paths = if from_another_program { paths } else { Vec::new() };
        }
    }

    /// The drag left the view: the epoch its deferred [`Self::settle_leave`] must find. GTK also
    /// emits a leave right before a drop, so the reset waits for that drop to pass.
    pub(crate) fn left(&self) -> u64 {
        self.epoch
    }

    /// The leave stands, unless a drop or a new drag came since: the drag and its data go.
    pub(crate) fn settle_leave(&mut self, epoch: u64) {
        if self.epoch == epoch {
            self.over = false;
            self.paths.clear();
        }
    }

    /// The drag was dropped on the view: the files it delivered before the drop, if any.
    pub(crate) fn dropped(&mut self) -> Vec<PathBuf> {
        let paths = std::mem::take(&mut self.paths);
        *self = Self { over: false, paths: Vec::new(), epoch: self.epoch + 1 };
        paths
    }
}

/// The local files a `text/uri-list` names: what GLib decodes as a `file:` URI with no host or
/// `localhost`, absolute. Anything else names nothing this computer can open and is left out.
/// An entry with a raw `#` or `?` is left out before GLib reads it: GLib 2.80 drops a fragment or
/// a query and answers a path nobody dropped, and a file named with either arrives as %23 or %3F.
#[cfg(target_os = "linux")]
pub(crate) fn local_paths<S: AsRef<str>>(uris: &[S]) -> Vec<PathBuf> {
    uris.iter()
        .filter_map(|uri| {
            let uri = uri.as_ref().trim();
            if uri.contains(['#', '?']) {
                return None;
            }
            let (path, host) = gtk::glib::filename_from_uri(uri).ok()?;
            let here = host.as_deref().map_or(true, |h| h.is_empty() || h.eq_ignore_ascii_case("localhost"));
            (here && path.is_absolute()).then_some(path)
        })
        .collect()
}

/// What one dropped file answers the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Taken {
    Ok,
    TooLarge,
    Unreadable,
}

impl Taken {
    fn word(self) -> &'static str {
        match self {
            Taken::Ok => "ok",
            Taken::TooLarge => "too_large",
            Taken::Unreadable => "unreadable",
        }
    }
}

/// One taken file, read only from the descriptor the take opened and never by its path again.
pub(crate) struct Reader {
    file: File,
    size: u64,
    done: u64,
    modified: Option<SystemTime>,
}

impl Reader {
    /// A reader of `file` as it stands now: its size and modification time are what every chunk
    /// is held to.
    pub(crate) fn of(file: File) -> std::io::Result<Self> {
        let meta = file.metadata()?;
        Ok(Self { file, size: meta.len(), done: 0, modified: meta.modified().ok() })
    }

    /// The next at most [`CHUNK_BYTES`] bytes, and whether they are the last. A file written in
    /// place since the take is refused, as a browser refuses a picked file that changed.
    fn next(&mut self) -> Result<(Vec<u8>, bool), String> {
        let want = (self.size - self.done).min(CHUNK_BYTES as u64) as usize;
        let mut chunk = vec![0u8; want];
        let mut got = 0;
        while got < want {
            match self.file.read(&mut chunk[got..]) {
                Ok(0) => return Err(changed()),
                Ok(n) => got += n,
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return Err("ohmail: the dropped file could not be read".into()),
            }
        }
        let now = self.file.metadata().map_err(|_| changed())?;
        if now.len() != self.size || now.modified().ok() != self.modified {
            return Err(changed());
        }
        self.done += want as u64;
        Ok((chunk, self.done == self.size))
    }
}

fn changed() -> String {
    "ohmail: the dropped file changed after it was dropped".into()
}

/// Open one dropped path once, for reading only, and judge the descriptor it gave: a regular file
/// up to the send ceiling. `O_NONBLOCK` so a FIFO cannot hold the take, `O_NOCTTY` so a terminal
/// never becomes this process's. A file over the ceiling is closed unread.
#[cfg(target_os = "linux")]
pub(crate) fn open(path: &Path) -> Result<Reader, (Taken, u64)> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| (Taken::Unreadable, 0))?;
    let meta = file.metadata().map_err(|_| (Taken::Unreadable, 0))?;
    if !meta.file_type().is_file() {
        return Err((Taken::Unreadable, 0));
    }
    if meta.len() > crate::engine::ATTACHMENT_MAX_BYTES as u64 {
        return Err((Taken::TooLarge, meta.len()));
    }
    Reader::of(file).map_err(|_| (Taken::Unreadable, 0))
}

/// The type GIO guesses from the name alone, or "" where it can only say octet-stream.
#[cfg(target_os = "linux")]
pub(crate) fn kind_of(name: &str) -> String {
    if name.is_empty() {
        return String::new();
    }
    let (guess, _) = gtk::gio::content_type_guess(Some(name), &[]);
    if guess.as_str() == "application/octet-stream" {
        String::new()
    } else {
        guess.to_string()
    }
}

/// The name the window shows: the last component only, lossy UTF-8, no control characters.
pub(crate) fn shown_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().chars().filter(|c| !c.is_control()).collect())
        .unwrap_or_default()
}

/// The one line a take writes: counts, never a path or a name.
pub(crate) fn take_line(ok: usize, too_large: usize, unreadable: usize) -> String {
    format!(
        "{{\"service\":\"shell\",\"event\":\"dropped_files\",\"taken\":{},\"ok\":{ok},\"too_large\":{too_large},\"unreadable\":{unreadable}}}",
        ok + too_large + unreadable
    )
}

/// The line a failure to arm writes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn unarmed_line(reason: &str) -> String {
    format!("{{\"service\":\"shell\",\"event\":\"dropped_files\",\"armed\":false,\"reason\":\"{reason}\"}}")
}

/// One take's files, open for their reads, by the take's token.
struct Claim {
    token: String,
    at: Instant,
    readers: Vec<Option<Reader>>,
}

#[derive(Default)]
struct Shelf {
    held: Option<(Vec<PathBuf>, Instant)>,
    claims: VecDeque<Claim>,
}

impl Shelf {
    /// The claims older than [`READ_FOR`], out of the shelf; the caller drops them unlocked.
    fn expired(&mut self, now: Instant) -> Vec<Claim> {
        let mut gone = Vec::new();
        while self.claims.front().is_some_and(|c| now.saturating_duration_since(c.at) >= READ_FOR) {
            gone.extend(self.claims.pop_front());
        }
        gone
    }
}

/// The latest drop no compose has taken, and the taken files still open. Managed app state.
#[derive(Default, Clone)]
pub(crate) struct DroppedFiles(Arc<Mutex<Shelf>>);

impl DroppedFiles {
    /// Hold the files of the latest drop on the view in place of any earlier one; a drop that
    /// brought none leaves nothing, so a take never answers an earlier drag.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn hold(&self, paths: Vec<PathBuf>, now: Instant) {
        if let Ok(mut shelf) = self.0.lock() {
            shelf.held = (!paths.is_empty()).then_some((paths, now));
        }
    }

    /// The held drop, once, while it is younger than [`HOLD_FOR`].
    fn take_held(&self, now: Instant) -> Option<Vec<PathBuf>> {
        let (paths, at) = self.0.lock().ok()?.held.take()?;
        (now.saturating_duration_since(at) < HOLD_FOR).then_some(paths)
    }

    /// Take the held drop: `null`, or `{drop, files: [{name, size, type, state}]}` in drop order.
    /// The files are opened here, unlocked, and kept open for [`Self::chunk`].
    pub(crate) fn take_with(
        &self,
        now: Instant,
        open: impl Fn(&Path) -> Result<Reader, (Taken, u64)>,
        kind: impl Fn(&str) -> String,
    ) -> Result<serde_json::Value, String> {
        let Some(paths) = self.take_held(now) else { return Ok(serde_json::Value::Null) };
        let token = crate::attachment_preview::token()?;
        let mut files = Vec::with_capacity(paths.len());
        let mut readers = Vec::with_capacity(paths.len());
        let (mut ok, mut too_large, mut unreadable) = (0, 0, 0);
        for (i, path) in paths.iter().enumerate() {
            let name = shown_name(path);
            let opened = if i < MAX_FILES { open(path) } else { Err((Taken::Unreadable, 0)) };
            let (state, size, reader) = match opened {
                Ok(reader) => (Taken::Ok, reader.size, Some(reader)),
                Err((state, size)) => (state, size, None),
            };
            *match state {
                Taken::Ok => &mut ok,
                Taken::TooLarge => &mut too_large,
                Taken::Unreadable => &mut unreadable,
            } += 1;
            files.push(serde_json::json!({ "name": name, "size": size, "type": kind(&name), "state": state.word() }));
            readers.push(reader);
        }
        let gone = {
            let mut shelf = self.0.lock().map_err(|_| "ohmail: the dropped files' lock is poisoned".to_string())?;
            let mut gone = shelf.expired(now);
            shelf.claims.push_back(Claim { token: token.clone(), at: now, readers });
            while shelf.claims.len() > MAX_CLAIMS {
                gone.extend(shelf.claims.pop_front());
            }
            gone
        };
        drop(gone);
        crate::engine::log_json_line(&take_line(ok, too_large, unreadable));
        Ok(serde_json::json!({ "drop": token, "files": files }))
    }

    /// The next chunk of one taken file: `{bytes64, end}`. The descriptor leaves the shelf for the
    /// read, so no lock is held during it; after `end` it is closed and a further ask is refused.
    pub(crate) fn chunk(&self, token: &str, index: usize, now: Instant) -> Result<serde_json::Value, String> {
        use base64::Engine as _;
        let (reader, gone) = {
            let mut shelf = self.0.lock().map_err(|_| "ohmail: the dropped files' lock is poisoned".to_string())?;
            let gone = shelf.expired(now);
            let claim = shelf.claims.iter_mut().find(|c| c.token == token);
            let reader = claim.and_then(|c| c.readers.get_mut(index)).and_then(Option::take);
            (reader, gone)
        };
        drop(gone);
        let mut reader = reader.ok_or_else(|| "ohmail: no dropped file is open under that name".to_string())?;
        let (bytes, end) = reader.next()?;
        if !end {
            let mut back = Some(reader);
            if let Ok(mut shelf) = self.0.lock() {
                let slot = shelf.claims.iter_mut().find(|c| c.token == token).and_then(|c| c.readers.get_mut(index));
                if let Some(slot) = slot {
                    *slot = back.take();
                }
            }
            // Closed here, unlocked, when its claim went while it was read.
            drop(back);
        }
        Ok(serde_json::json!({ "bytes64": base64::engine::general_purpose::STANDARD.encode(&bytes), "end": end }))
    }

    /// Close every claim at [`READ_FOR`] even when the window never asks again.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    fn close_later(&self) {
        let shelf = Arc::clone(&self.0);
        let _ = std::thread::Builder::new().name("dropped-files".into()).spawn(move || {
            std::thread::sleep(READ_FOR + Duration::from_secs(1));
            let gone = shelf.lock().map(|mut s| s.expired(Instant::now())).unwrap_or_default();
            drop(gone);
        });
    }
}

/// Take the latest drop of files from another program, once. No argument: the shell saw the drop.
#[tauri::command(async)]
pub(crate) fn dropped_files_take(dropped: tauri::State<'_, DroppedFiles>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "linux")]
    {
        let answer = dropped.take_with(Instant::now(), open, kind_of)?;
        if !answer.is_null() {
            dropped.close_later();
        }
        Ok(answer)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = dropped;
        Ok(serde_json::Value::Null)
    }
}

/// The next chunk of one taken file, by the take's token and the file's place in its answer.
#[tauri::command(async)]
pub(crate) fn dropped_file_chunk(
    dropped: tauri::State<'_, DroppedFiles>,
    drop: String,
    index: usize,
) -> Result<serde_json::Value, String> {
    dropped.chunk(&drop, index, Instant::now())
}

/// Arm the main window's drop watch, once, from `menu.rs` after the window is built.
#[cfg(target_os = "linux")]
pub fn arm<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        crate::engine::log_json_line(&unarmed_line("no_window"));
        return;
    };
    let handle = app.clone();
    if window.with_webview(move |platform| hook(&platform, handle)).is_err() {
        crate::engine::log_json_line(&unarmed_line("no_webview"));
    }
}

/// The webview's own drag signals, read and paired and never handled: WebKit still takes the
/// drop, and the window decides what it means. No file IO here.
#[cfg(target_os = "linux")]
fn hook<R: tauri::Runtime>(platform: &tauri::webview::PlatformWebview, app: tauri::AppHandle<R>) {
    use gtk::prelude::{DragContextExtManual, WidgetExt};
    use std::cell::RefCell;
    use std::rc::Rc;
    let view = platform.inner();
    let pairing = Rc::new(RefCell::new(DragPairing::default()));
    let on_motion = Rc::clone(&pairing);
    view.connect_drag_motion(move |_, _, _, _, _| {
        on_motion.borrow_mut().motion();
        false
    });
    let on_data = Rc::clone(&pairing);
    view.connect_drag_data_received(move |_, context, _, _, data, _, _| {
        if data.target().name().as_str() != "text/uri-list" {
            return;
        }
        let from_another_program = context.drag_get_source_widget().is_none();
        let paths = if from_another_program {
            let uris: Vec<String> = data.uris().iter().map(|uri| uri.to_string()).collect();
            local_paths(&uris)
        } else {
            Vec::new()
        };
        on_data.borrow_mut().data(from_another_program, paths);
    });
    let on_leave = Rc::clone(&pairing);
    view.connect_drag_leave(move |_, _, _| {
        // Deferred as WebKit defers its own leave (a zero timeout, default priority): GTK emits
        // the drop that follows a leave in the same dispatch.
        let epoch = on_leave.borrow().left();
        let later = Rc::clone(&on_leave);
        gtk::glib::timeout_add_local_once(Duration::ZERO, move || later.borrow_mut().settle_leave(epoch));
    });
    view.connect_drag_drop(move |_, _, _, _, _| {
        let paths = pairing.borrow_mut().dropped();
        hold_in(&app, paths);
        false
    });
}

#[cfg(target_os = "linux")]
fn hold_in<R: tauri::Runtime>(app: &tauri::AppHandle<R>, paths: Vec<PathBuf>) {
    use tauri::Manager;
    if let Some(dropped) = app.try_state::<DroppedFiles>() {
        dropped.hold(paths, Instant::now());
    }
}
