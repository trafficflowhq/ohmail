//! Every file the update flow writes, and nothing else: a verified release staged beside the
//! AppImage it will replace, the record naming that release, Settings' install policy, and an
//! automatic install that failed, for the next launch to say.
//!
//! `updater.rs` writes nothing itself. Each write here goes through a `.part` name, an fsync, a
//! rename and an fsync of the folder, and the image is only ever replaced by one `rename(2)`: a
//! kill or a power loss at any moment leaves the old image or the new one, whole. The plugin's own
//! AppImage install moved the image away and wrote the new one in its place, so an exit mid-write
//! left an image that would not start.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// The staged release's record, in the app's data folder.
pub const RECORD_FILE: &str = "update-staged.json";

/// Settings → Updates' switch, in the app's data folder: `auto` or `ask`.
pub const POLICY_FILE: &str = "update-install";

/// An install at quit or at launch that failed, in the app's data folder.
pub const FAILED_FILE: &str = "update-failed";

/// What the failure says: the release, the class of the error, where (`quit` or `launch`), when.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub version: String,
    pub error_class: String,
    pub at: String,
    pub at_unix_ms: u64,
}

/// What the record says: the image the release is for, its version and its signature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub image: PathBuf,
    pub version: String,
    pub signature: String,
}

impl Record {
    fn to_json(&self) -> Option<String> {
        let image = self.image.to_str()?;
        Some(
            serde_json::json!({ "image": image, "version": self.version, "signature": self.signature })
                .to_string(),
        )
    }

    fn from_json(text: &str) -> Option<Record> {
        let value: serde_json::Value = serde_json::from_str(text).ok()?;
        let field = |name: &str| value.get(name)?.as_str().map(str::to_string);
        Some(Record {
            image: PathBuf::from(field("image")?),
            version: field("version")?,
            signature: field("signature")?,
        })
    }
}

/// `.<image name>.ohmail-update`, beside the image: the one place a release is staged for it.
pub fn staged_path(image: &Path) -> Option<PathBuf> {
    let mut name = std::ffi::OsString::from(".");
    name.push(image.file_name()?);
    name.push(".ohmail-update");
    Some(image.with_file_name(name))
}

/// `$APPIMAGE`, resolved: the file the next launch starts.
pub fn running_image() -> Option<PathBuf> {
    let image = std::env::var_os("APPIMAGE").filter(|value| !value.is_empty())?;
    fs::canonicalize(image).ok()
}

fn not_an_image() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "no file name to stage beside")
}

fn part_path(path: &Path) -> PathBuf {
    let mut part = path.as_os_str().to_os_string();
    part.push(".part");
    PathBuf::from(part)
}

#[cfg(unix)]
fn create_private(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let file = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    // A `.part` left by a killed run keeps its old mode through `create`.
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

#[cfg(not(unix))]
fn create_private(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create(true).truncate(true).open(path)
}

/// The rename made durable. After the rename it is best effort: a folder that refuses an fsync
/// (macOS answers `F_FULLFSYNC` on some) has still renamed, and must not read as a failed apply.
#[cfg(unix)]
fn sync_folder(path: &Path) {
    let folder = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    if let Ok(folder) = File::open(folder) {
        let _ = folder.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_folder(_: &Path) {}

/// `bytes` at `path`, through a `.part` beside it: written, fsynced, renamed, the folder fsynced.
fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let part = part_path(path);
    let written = (|| {
        let mut file = create_private(&part)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&part, path)
    })();
    match &written {
        Ok(()) => sync_folder(path),
        Err(_) => {
            let _ = fs::remove_file(&part);
        }
    }
    written
}

/// Stage a verified release beside `record.image` and record it in `dir`. The release goes first,
/// so a record never names a release that is not whole on disk.
pub fn stage(dir: &Path, record: &Record, bytes: &[u8]) -> io::Result<()> {
    let staged = staged_path(&record.image).ok_or_else(not_an_image)?;
    let json = record.to_json().ok_or_else(not_an_image)?;
    write_atomically(&staged, bytes)?;
    let recorded = fs::create_dir_all(dir).and_then(|()| write_atomically(&dir.join(RECORD_FILE), json.as_bytes()));
    if recorded.is_err() {
        let _ = fs::remove_file(&staged);
    }
    recorded
}

/// The record in `dir`, when one is there and parses.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub fn read_record(dir: &Path) -> Option<Record> {
    let mut text = String::new();
    File::open(dir.join(RECORD_FILE)).ok()?.take(64 * 1024).read_to_string(&mut text).ok()?;
    Record::from_json(&text)
}

/// The release staged for `image`. The path comes from the image, never from a record.
pub fn read_staged(image: &Path) -> io::Result<Vec<u8>> {
    fs::read(staged_path(image).ok_or_else(not_an_image)?)
}

/// The staged release takes the image's place: the image's mode, one rename, the folder fsynced.
pub fn apply(image: &Path) -> io::Result<()> {
    let staged = staged_path(image).ok_or_else(not_an_image)?;
    fs::set_permissions(&staged, fs::metadata(image)?.permissions())?;
    fs::rename(&staged, image)?;
    sync_folder(image);
    Ok(())
}

/// The press's and the quit's install: `bytes` written beside the image, then renamed over it.
pub fn replace(image: &Path, bytes: &[u8]) -> io::Result<()> {
    write_atomically(&staged_path(image).ok_or_else(not_an_image)?, bytes)?;
    apply(image)
}

/// The staged release and its record go: exactly those two names.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub fn discard(dir: &Path, image: &Path) {
    if let Some(staged) = staged_path(image) {
        let _ = fs::remove_file(staged);
    }
    forget_record(dir);
}

/// The record goes, once its release is in the image's place.
pub fn forget_record(dir: &Path) {
    let _ = fs::remove_file(dir.join(RECORD_FILE));
}

/// The policy file as read: absent, its text, or there and unreadable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyRead {
    Missing,
    Text(String),
    Unreadable,
}

pub fn read_policy(dir: &Path) -> PolicyRead {
    let file = match File::open(dir.join(POLICY_FILE)) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return PolicyRead::Missing,
        Err(_) => return PolicyRead::Unreadable,
    };
    let mut text = String::new();
    match file.take(64).read_to_string(&mut text) {
        Ok(_) => PolicyRead::Text(text),
        Err(_) => PolicyRead::Unreadable,
    }
}

#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub fn write_policy(dir: &Path, word: &str) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    write_atomically(&dir.join(POLICY_FILE), format!("{word}\n").as_bytes())
}

#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub fn write_failure(dir: &Path, failure: &Failure) -> io::Result<()> {
    let json = serde_json::json!({
        "version": failure.version,
        "errorClass": failure.error_class,
        "at": failure.at,
        "atUnixMs": failure.at_unix_ms,
    });
    fs::create_dir_all(dir)?;
    write_atomically(&dir.join(FAILED_FILE), json.to_string().as_bytes())
}

/// The failure in `dir`, when one is there and parses.
pub fn read_failure(dir: &Path) -> Option<Failure> {
    let mut text = String::new();
    File::open(dir.join(FAILED_FILE)).ok()?.take(4 * 1024).read_to_string(&mut text).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let field = |name: &str| value.get(name)?.as_str().map(str::to_string);
    Some(Failure {
        version: field("version")?,
        error_class: field("errorClass")?,
        at: field("at")?,
        at_unix_ms: value.get("atUnixMs")?.as_u64()?,
    })
}

pub fn forget_failure(dir: &Path) {
    let _ = fs::remove_file(dir.join(FAILED_FILE));
}

/// May this process write `path` (`access(2)`, `W_OK`)? Asked before an install at quit, which
/// must never reach a password prompt.
#[cfg(unix)]
pub fn writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    // libc's `access`; `W_OK` is 2 on every Unix.
    extern "C" {
        fn access(path: *const std::ffi::c_char, mode: i32) -> i32;
    }
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return false };
    unsafe { access(path.as_ptr(), 2) == 0 }
}

#[cfg(not(unix))]
pub fn writable(_: &Path) -> bool {
    true
}

#[cfg(test)]
#[path = "appimage_stage_tests.rs"]
pub(crate) mod tests;
