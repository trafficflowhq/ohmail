//! The staged release and its one rename, driven on real files: what lands is whole, the image is
//! replaced by a rename and never written in place, and a failure leaves it exactly as it was.

use super::{
    apply, discard, forget_failure, read_failure, read_policy, read_record, read_staged, replace, stage,
    staged_path, write_failure, write_policy, Failure, PolicyRead, Record, FAILED_FILE, POLICY_FILE,
    RECORD_FILE,
};
use std::fs;
use std::path::{Path, PathBuf};

/// A folder of the case's own, an image in it, and an app data folder beside it.
pub(crate) struct Bed {
    pub(crate) root: PathBuf,
    pub(crate) image: PathBuf,
    pub(crate) data: PathBuf,
}

impl Bed {
    pub(crate) fn new(name: &str) -> Bed {
        let root = std::env::temp_dir().join(format!("ohmail-stage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (apps, data) = (root.join("Apps"), root.join("data"));
        fs::create_dir_all(&apps).unwrap();
        fs::create_dir_all(&data).unwrap();
        let image = apps.join("ohmail-linux-x86_64.AppImage");
        fs::write(&image, b"the old image").unwrap();
        set_mode(&image, 0o755);
        Bed { root, image, data }
    }

    pub(crate) fn record(&self, version: &str, signature: &str) -> Record {
        Record { image: self.image.clone(), version: version.into(), signature: signature.into() }
    }

    /// Every name in the image's folder and in the data folder.
    fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = [self.image.parent().unwrap(), self.data.as_path()]
            .iter()
            .flat_map(|dir| fs::read_dir(dir).unwrap())
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Bed {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

#[cfg(not(unix))]
fn set_mode(_: &Path, _: u32) {}

#[test]
fn a_staged_release_is_whole_beside_the_image_and_its_record_names_it() {
    let bed = Bed::new("stage");
    let release = vec![7u8; 300 * 1024];
    stage(&bed.data, &bed.record("0.30.6", "sig"), &release).unwrap();

    let staged = staged_path(&bed.image).unwrap();
    assert_eq!(staged.file_name().unwrap(), ".ohmail-linux-x86_64.AppImage.ohmail-update");
    assert_eq!(staged.parent(), bed.image.parent());
    assert_eq!(read_staged(&bed.image).unwrap(), release);
    assert_eq!(read_record(&bed.data), Some(bed.record("0.30.6", "sig")));
    assert_eq!(fs::read(&bed.image).unwrap(), b"the old image", "staging touched the image");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&staged).unwrap().permissions().mode() & 0o777, 0o600);
    }
    // Nothing else was left: no `.part`, no stray file.
    assert_eq!(
        bed.names(),
        [".ohmail-linux-x86_64.AppImage.ohmail-update", "ohmail-linux-x86_64.AppImage", RECORD_FILE]
    );
}

#[cfg(unix)]
#[test]
fn applying_is_one_rename_with_the_images_mode_and_an_open_handle_still_reads_the_old_image() {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let bed = Bed::new("apply");
    let release = vec![9u8; 200 * 1024];
    stage(&bed.data, &bed.record("0.30.6", "sig"), &release).unwrap();
    let before = fs::metadata(&bed.image).unwrap().ino();
    let mut running = fs::File::open(&bed.image).unwrap();

    apply(&bed.image).unwrap();

    assert_eq!(fs::read(&bed.image).unwrap(), release, "the image is not the staged release, whole");
    assert_ne!(fs::metadata(&bed.image).unwrap().ino(), before, "the image was written in place, not renamed over");
    assert_eq!(fs::metadata(&bed.image).unwrap().permissions().mode() & 0o777, 0o755, "the image lost its mode");
    let mut old = Vec::new();
    running.read_to_end(&mut old).unwrap();
    assert_eq!(old, b"the old image", "a handle opened before the rename no longer reads the old image");
    assert!(!staged_path(&bed.image).unwrap().exists(), "the staged release is still beside the image");
}

#[test]
fn replacing_from_memory_writes_beside_and_lands_whole() {
    let bed = Bed::new("replace");
    let release = vec![3u8; 150 * 1024];
    replace(&bed.image, &release).unwrap();
    assert_eq!(fs::read(&bed.image).unwrap(), release);
    assert_eq!(bed.names(), ["ohmail-linux-x86_64.AppImage"], "replace left a file behind");
}

#[test]
fn a_write_that_fails_leaves_the_image_byte_for_byte_and_records_nothing() {
    let bed = Bed::new("failed-write");
    // The `.part` name taken by a folder: the write cannot open it, as a full or read-only disk cannot.
    let staged = staged_path(&bed.image).unwrap();
    let mut part = staged.clone().into_os_string();
    part.push(".part");
    fs::create_dir(&part).unwrap();

    assert!(stage(&bed.data, &bed.record("0.30.6", "sig"), b"new").is_err());
    assert!(replace(&bed.image, b"new").is_err());

    assert_eq!(fs::read(&bed.image).unwrap(), b"the old image", "a failed write changed the image");
    assert!(!staged.exists());
    assert_eq!(read_record(&bed.data), None, "a record names a release that is not on disk");
}

#[test]
fn discard_removes_the_staged_release_and_its_record_and_nothing_else() {
    let bed = Bed::new("discard");
    stage(&bed.data, &bed.record("0.30.6", "sig"), b"new").unwrap();
    fs::write(bed.image.parent().unwrap().join("notes.txt"), b"mine").unwrap();
    write_policy(&bed.data, "auto").unwrap();

    discard(&bed.data, &bed.image);

    assert_eq!(bed.names(), ["notes.txt", "ohmail-linux-x86_64.AppImage", POLICY_FILE]);
    assert_eq!(fs::read(&bed.image).unwrap(), b"the old image");
}

#[test]
fn a_record_that_does_not_parse_is_no_record() {
    let bed = Bed::new("garbled-record");
    fs::write(bed.data.join(RECORD_FILE), b"{\"image\": 7}").unwrap();
    assert_eq!(read_record(&bed.data), None);
    fs::write(bed.data.join(RECORD_FILE), b"not json").unwrap();
    assert_eq!(read_record(&bed.data), None);
}

#[test]
fn a_failed_install_is_kept_whole_and_forgotten_by_its_one_name() {
    let bed = Bed::new("failure");
    assert_eq!(read_failure(&bed.data), None);
    let failure = Failure { version: "0.30.7".into(), error_class: "Io".into(), at: "quit".into(), at_unix_ms: 1_761_000_000_000 };
    write_failure(&bed.data, &failure).unwrap();
    assert_eq!(read_failure(&bed.data), Some(failure));
    stage(&bed.data, &bed.record("0.30.7", "sig"), b"new").unwrap();
    forget_failure(&bed.data);
    assert_eq!(read_failure(&bed.data), None);
    assert_eq!(read_record(&bed.data), Some(bed.record("0.30.7", "sig")), "forgetting the failure took the record");
    fs::write(bed.data.join(FAILED_FILE), b"{\"version\": \"0.30.7\"}").unwrap();
    assert_eq!(read_failure(&bed.data), None, "a failure missing its fields was read");
}

#[test]
fn the_policy_file_is_read_as_written_and_absent_is_absent() {
    let bed = Bed::new("policy");
    assert_eq!(read_policy(&bed.data), PolicyRead::Missing);
    write_policy(&bed.data, "ask").unwrap();
    assert_eq!(read_policy(&bed.data), PolicyRead::Text("ask\n".into()));
    write_policy(&bed.data, "auto").unwrap();
    assert_eq!(read_policy(&bed.data), PolicyRead::Text("auto\n".into()));
    assert_eq!(bed.names().iter().filter(|n| n.ends_with(".part")).count(), 0);
}
