//! What a restart withholds: the rule over a table, and a real child's descriptor table.

use super::*;

#[test]
fn only_what_a_launch_handed_in_is_withheld() {
    // The measured launch: the keep-alive's read end at 3 and the mount directory at 1023 carry
    // no close-on-exec, this process's own descriptors do, and stdio passes whatever its flag.
    let launch =
        [(0, false), (1, false), (2, false), (3, false), (4, true), (9, true), (1023, false)];
    assert_eq!(handed_in(&launch), vec![3, 1023]);
    assert_eq!(handed_in(&[(0, false), (1, false), (2, false), (5, true)]), Vec::<i32>::new());
}

#[cfg(target_os = "linux")]
mod live {
    use super::super::{handed_in, open_descriptors, sys, withhold_from_the_restart};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::process::{Command, Stdio};

    extern "C" {
        fn pipe(fds: *mut i32) -> i32;
    }

    /// A pipe made the way the AppImage runtime makes its keep-alive: `pipe()`, so neither end is
    /// close-on-exec. The write end plays the FUSE server's and is kept out of every child.
    fn keep_alive() -> (OwnedFd, OwnedFd) {
        let mut ends = [-1i32; 2];
        // SAFETY: `ends` is two writable ints, and both descriptors are owned from here on.
        assert_eq!(unsafe { pipe(ends.as_mut_ptr()) }, 0, "pipe()");
        let (reader, writer) =
            unsafe { (OwnedFd::from_raw_fd(ends[0]), OwnedFd::from_raw_fd(ends[1])) };
        let flags = sys::flags(writer.as_raw_fd()).expect("the write end is open");
        assert!(sys::set_flags(writer.as_raw_fd(), flags | sys::FD_CLOEXEC));
        (reader, writer)
    }

    /// `pipe:[<inode>]`: the name `/proc` gives the pipe in every process that holds it.
    fn name_of(fd: i32) -> String {
        let link = std::fs::read_link(format!("/proc/self/fd/{fd}"));
        link.expect("the descriptor's name").to_string_lossy().into_owned()
    }

    /// Does a process started now hold this pipe? Read from the child's own descriptor table,
    /// where the old image's pipe was seen. The restart's spawn is this same `Command::spawn`.
    fn a_child_holds(pipe_name: &str) -> bool {
        let mut child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("sleep");
        let held = std::fs::read_dir(format!("/proc/{}/fd", child.id()))
            .expect("the child's descriptors")
            .filter_map(|entry| std::fs::read_link(entry.ok()?.path()).ok())
            .any(|target| target.to_string_lossy() == pipe_name);
        child.kill().expect("the child is this test's to stop");
        child.wait().expect("reaped");
        held
    }

    #[test]
    fn a_restart_hands_the_new_copy_no_keep_alive() {
        let (reader, _writer) = keep_alive();
        let fd = reader.as_raw_fd();
        let name = name_of(fd);
        assert!(name.starts_with("pipe:["), "{name}");
        // The control: before, the pipe reads as handed in and a child started now inherits it.
        assert!(handed_in(&open_descriptors()).contains(&fd));
        assert!(a_child_holds(&name), "the fixture is not inheritable: the reading is vacuous");

        assert!(withhold_from_the_restart() >= 1);
        assert!(!a_child_holds(&name), "the restarted copy would hold the old image's keep-alive");
        assert!(!handed_in(&open_descriptors()).contains(&fd));
        // Withheld, not closed: this process keeps its reader until it exits.
        assert_eq!(name_of(fd), name);
    }
}
