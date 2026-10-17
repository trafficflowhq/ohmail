//! THE IN-APP PREVIEW, WITH NO ATTACHMENT BYTE IN THE WINDOW'S SCRIPT.
//!
//! The window's CSP refuses Tauri's `ipc:` fetch, so every command answer returns through
//! `webview.eval`, and raw bytes cross as a JSON array of numbers: a 40 MiB picture grew the
//! renderer by 1.3 GiB. The preview now names the part by id; the engine streams it into the
//! staging folder (`save_attachment`'s door), and the window loads an image from this scheme by a
//! random token. The scheme maps a token to a file this process staged, never a path to a file.
//! A text part comes back inline only up to [`TEXT_PREVIEW_MAX_BYTES`].

use crate::engine::{
    attachment_dir, is_attachment_id, stage_attachment, staging_path, sweep_attachments, Engine, Shell,
    ATTACHMENT_KEEP, ATTACHMENT_MAX_BYTES,
};
use std::collections::VecDeque;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::http::{header, Response, StatusCode};

#[cfg(test)]
#[path = "attachment_preview_tests.rs"]
mod tests;

/// The webview scheme the window loads a staged image from. Never registered with the OS.
pub(crate) const PREVIEW_SCHEME: &str = "attachment-preview";

/// The most text this process hands the window inline. Measured in WebKitGTK: 2 MiB of text
/// grows the renderer by 38 MiB (the 512 Ki-char `<pre>` is most of it), 4 MiB by 51, 8 MiB by 82.
pub(crate) const TEXT_PREVIEW_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// The BACKSTOP on staged images: past 16 files or 512 MiB the oldest goes. The window owns the
/// real eviction (`STAGED_PREVIEWS_KEPT` in client-engine, 8) and resets what it lets go, so a
/// revisit stages again; this bound only holds a window that lost track (a renderer reload).
const PREVIEWS_KEPT: usize = 16;
const PREVIEW_BYTES_KEPT: u64 = 512 * 1024 * 1024;

/// The only types the scheme serves: the raster images an `<img>` draws and never runs.
const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

struct Staged {
    token: String,
    path: PathBuf,
    size: u64,
    mime: &'static str,
}

/// The staged images the window may load, by token. Managed app state; emptied at exit.
#[derive(Default)]
pub(crate) struct Previews(Mutex<VecDeque<Staged>>);

impl Previews {
    fn insert(&self, staged: Staged) {
        let evicted: Vec<Staged> = match self.0.lock() {
            Ok(mut held) => {
                held.push_back(staged);
                let mut out = Vec::new();
                while held.len() > 1
                    && (held.len() > PREVIEWS_KEPT || held.iter().map(|s| s.size).sum::<u64>() > PREVIEW_BYTES_KEPT)
                {
                    out.extend(held.pop_front());
                }
                out
            }
            Err(_) => vec![staged],
        };
        for old in evicted {
            let _ = fs::remove_file(&old.path);
        }
    }

    fn find(&self, token: &str) -> Option<(PathBuf, u64, &'static str)> {
        let held = self.0.lock().ok()?;
        held.iter().find(|s| s.token == token).map(|s| (s.path.clone(), s.size, s.mime))
    }

    /// Forget one staged image and remove its file. Unknown tokens are a no-op.
    pub(crate) fn release(&self, token: &str) {
        let gone = self.0.lock().ok().and_then(|mut held| {
            let at = held.iter().position(|s| s.token == token)?;
            held.remove(at)
        });
        if let Some(staged) = gone {
            let _ = fs::remove_file(&staged.path);
        }
    }

    /// Remove every staged file: the app is leaving.
    pub(crate) fn release_all(&self) {
        let all: Vec<Staged> = self.0.lock().map(|mut held| held.drain(..).collect()).unwrap_or_default();
        for staged in all {
            let _ = fs::remove_file(&staged.path);
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.0.lock().map(|h| h.len()).unwrap_or(0)
    }
}

/// Remove every staged file (`<32 hex>.part`) left in the staging folder: at launch nothing is
/// staged yet, so whatever is there was left by a crash, a kill or an update install.
pub(crate) fn sweep_staged(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let staged = name.len() == 37
            && name.ends_with(".part")
            && name[..32].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if staged && entry.file_type().is_ok_and(|t| t.is_file()) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// [`sweep_staged`] over this shell's own staging folder (`engine::manage`, after the build, so a
/// second copy the single-instance rule sends away never reaches it).
pub(crate) fn sweep_at_launch(shell: &Shell) {
    if let Ok(root) = attachment_dir(shell) {
        sweep_staged(&root);
    }
}

/// What a declared type previews as: one of the four raster images, text, or nothing.
fn image_type(mime: &str) -> Option<&'static str> {
    let essence = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    IMAGE_TYPES.iter().copied().find(|t| *t == essence)
}
fn is_text(mime: &str) -> bool {
    mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase().starts_with("text/")
}

/// A fresh token: 32 lowercase hex characters from the system's random source.
fn token() -> Result<String, String> {
    let mut raw = [0u8; 16];
    getrandom::fill(&mut raw).map_err(|err| format!("ohmail: this computer would not supply random bytes ({err})"))?;
    Ok(raw.iter().map(|b| format!("{b:02x}")).collect())
}

/// The URL the window loads a token from, in this platform's spelling of a webview scheme.
pub(crate) fn preview_url(token: &str) -> String {
    if cfg!(windows) {
        format!("http://{PREVIEW_SCHEME}.localhost/{token}")
    } else {
        format!("{PREVIEW_SCHEME}://localhost/{token}")
    }
}

/// Stage one attachment for the preview and answer what the window needs, never the image's bytes:
/// `{url, token, size}` for an image, `{size, text64}` for text under the cap, `{size, tooLarge}`
/// above it. A refusal of the part is the engine's `{status, code, message, retryable}`.
pub(crate) fn stage_preview(
    engine: &Engine,
    root: &Path,
    previews: &Previews,
    attachment_id: &str,
    mime_type: &str,
) -> Result<serde_json::Value, serde_json::Value> {
    let refuse = |text: &str| serde_json::Value::String(format!("ohmail: {text}"));
    let image = image_type(mime_type);
    if image.is_none() && !is_text(mime_type) {
        return Err(refuse("this kind of file has no preview here"));
    }
    if !is_attachment_id(attachment_id) {
        return Err(refuse("this is not an attachment this app can preview"));
    }
    sweep_attachments(root, ATTACHMENT_KEEP);
    let staged = staging_path(root).map_err(serde_json::Value::String)?;
    let size = match stage_attachment(engine, &staged, attachment_id) {
        Ok(size) => size,
        Err(err) => {
            let _ = fs::remove_file(&staged);
            return Err(err);
        }
    };
    if let Some(mime) = image {
        let token = token().map_err(|e| {
            let _ = fs::remove_file(&staged);
            serde_json::Value::String(e)
        })?;
        let url = preview_url(&token);
        previews.insert(Staged { token: token.clone(), path: staged, size, mime });
        return Ok(serde_json::json!({ "url": url, "token": token, "size": size }));
    }
    let answer = text_answer(&staged, size);
    let _ = fs::remove_file(&staged);
    answer
}

fn text_answer(staged: &Path, size: u64) -> Result<serde_json::Value, serde_json::Value> {
    use base64::Engine as _;
    if size > TEXT_PREVIEW_MAX_BYTES {
        return Ok(serde_json::json!({ "size": size, "tooLarge": true }));
    }
    let mut head = Vec::with_capacity(size as usize);
    fs::File::open(staged)
        .and_then(|f| f.take(TEXT_PREVIEW_MAX_BYTES + 1).read_to_end(&mut head))
        .map_err(|err| serde_json::Value::String(format!("ohmail: the staged file could not be read ({err})")))?;
    if head.len() as u64 > TEXT_PREVIEW_MAX_BYTES {
        return Ok(serde_json::json!({ "size": head.len(), "tooLarge": true }));
    }
    Ok(serde_json::json!({ "size": head.len(), "text64": base64::engine::general_purpose::STANDARD.encode(&head) }))
}

fn refused(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).unwrap_or_default()
}

/// One request on [`PREVIEW_SCHEME`], answered from the table or refused. Only the main window,
/// only GET, only `/<32 hex>` of a token staged here, and only a file whose real parent is the
/// staging folder and whose size is the one staged. Anything else is a 4xx with no body.
pub(crate) fn answer(previews: &Previews, root: &Path, label: &str, method: &str, path: &str) -> Response<Vec<u8>> {
    if label != "main" {
        return refused(StatusCode::FORBIDDEN);
    }
    if method != "GET" {
        return refused(StatusCode::METHOD_NOT_ALLOWED);
    }
    let token = path.strip_prefix('/').unwrap_or("");
    if token.len() != 32 || !token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return refused(StatusCode::NOT_FOUND);
    }
    let Some((file, size, mime)) = previews.find(token) else { return refused(StatusCode::NOT_FOUND) };
    let real = match (fs::canonicalize(&file), fs::canonicalize(root)) {
        (Ok(real), Ok(real_root)) if real.parent() == Some(real_root.as_path()) => real,
        _ => return refused(StatusCode::NOT_FOUND),
    };
    if size == 0 || size > ATTACHMENT_MAX_BYTES as u64 {
        return refused(StatusCode::NOT_FOUND);
    }
    let body = match fs::read(&real) {
        Ok(body) if body.len() as u64 == size => body,
        _ => return refused(StatusCode::NOT_FOUND),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header("X-Content-Type-Options", "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .body(body)
        .unwrap_or_else(|_| refused(StatusCode::INTERNAL_SERVER_ERROR))
}

/// The scheme's handler (`engine::attach`). The file is read off the UI thread.
pub(crate) fn serve<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    use tauri::Manager;
    let app = ctx.app_handle().clone();
    let label = ctx.webview_label().to_string();
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();
    std::thread::spawn(move || {
        let root = app.try_state::<Arc<Shell>>().and_then(|shell| attachment_dir(&shell).ok());
        let response = match (app.try_state::<Previews>(), root) {
            (Some(previews), Some(root)) => answer(&previews, &root, &label, &method, &path),
            _ => refused(StatusCode::NOT_FOUND),
        };
        responder.respond(response);
    });
}

/// Stage one attachment for the in-app preview. See [`stage_preview`].
#[tauri::command(async)]
pub(crate) fn stage_attachment_preview(
    shell: tauri::State<'_, Arc<Shell>>,
    previews: tauri::State<'_, Previews>,
    attachment_id: String,
    mime_type: String,
) -> Result<serde_json::Value, serde_json::Value> {
    let root = attachment_dir(&shell).map_err(serde_json::Value::String)?;
    stage_preview(&shell.engine(), &root, &previews, &attachment_id, &mime_type)
}

/// The preview closed: remove its staged file. A token this process never staged is a no-op.
#[tauri::command]
pub(crate) fn release_attachment_preview(previews: tauri::State<'_, Previews>, token: String) {
    previews.release(&token);
}
