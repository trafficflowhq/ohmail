//! How a window process ended, read without reaping it, and what other code wrote to stderr.

use super::*;

#[test]
fn a_raw_wait_status_names_the_signal_the_core_or_the_exit() {
    let signal = |signo, core| Some(How::Signal { signo, core });
    assert_eq!(decode_status(0x0b), signal(11, false));
    assert_eq!(decode_status(0x8b), signal(11, true));
    assert_eq!(decode_status(0x09), signal(9, false));
    assert_eq!(decode_status(0x86), signal(6, true));
    assert_eq!(decode_status(0x0300), Some(How::Exited(3)));
    assert_eq!(decode_status(0), Some(How::Exited(0)));
    assert_eq!(decode_status(40), signal(40, false));
    // Stopped is not an end.
    assert_eq!(decode_status(0x137f), None);
    assert_eq!(signal_name(11), "SIGSEGV");
    assert_eq!(signal_name(9), "SIGKILL");
    assert_eq!(signal_name(6), "SIGABRT");
    assert_eq!(signal_name(40), "other");
}

#[test]
fn a_siginfo_names_the_same_three_ends() {
    assert_eq!(decode_siginfo(CLD_KILLED, 9), Some(How::Signal { signo: 9, core: false }));
    assert_eq!(decode_siginfo(CLD_DUMPED, 11), Some(How::Signal { signo: 11, core: true }));
    assert_eq!(decode_siginfo(CLD_EXITED, 3), Some(How::Exited(3)));
    assert_eq!(decode_siginfo(5, 0), None);
}

#[test]
fn the_line_is_fixed_words_and_numbers_in_a_fixed_order() {
    let segv = Exit {
        pid: Some(1_855_920),
        how: Some(How::Signal { signo: 11, core: false }),
        method: Method::PidfdInfo,
    };
    let line = exit_line(&segv, Some(3));
    assert_eq!(
        line,
        r#"{"service":"shell","event":"renderer_exit","pid":1855920,"signal":"SIGSEGV","signo":11,"core":false,"exitStatus":null,"method":"pidfd_info","stderrLines":3}"#
    );
    let not_held = exit_line(&Exit::unread(Method::NotHeld), None);
    assert_eq!(
        not_held,
        r#"{"service":"shell","event":"renderer_exit","pid":null,"signal":null,"signo":null,"core":null,"exitStatus":null,"method":"not_held","stderrLines":null}"#
    );
    let exited = exit_line(&Exit { pid: Some(7), how: Some(How::Exited(3)), method: Method::Waitid }, Some(0));
    assert!(exited.contains(r#""signal":null,"signo":null,"core":null,"exitStatus":3,"method":"waitid""#), "{exited}");
    let other = exit_line(&Exit { pid: Some(7), how: Some(How::Signal { signo: 40, core: false }), method: Method::Waitid }, None);
    assert!(other.contains(r#""signal":"other","signo":40,"#), "{other}");
    for l in [&line, &not_held, &exited, &other] {
        let v: serde_json::Value = serde_json::from_str(l).expect("the line parses");
        let keys: Vec<&str> = v.as_object().expect("an object").keys().map(String::as_str).collect();
        let mut want = vec!["core", "event", "exitStatus", "method", "pid", "service", "signal", "signo", "stderrLines"];
        want.sort_unstable();
        assert_eq!(keys, want, "{l}");
    }
    assert_eq!(marker_words(&segv), "window process 1855920 ended: SIGSEGV");
    assert_eq!(marker_words(&Exit::unread(Method::NotHeld)), "window process ? ended: not held");
    assert_eq!(marker_words(&Exit { pid: Some(7), how: Some(How::Exited(3)), method: Method::Waitid }), "window process 7 ended: exit 3");
}

#[test]
fn stderr_is_kept_unless_it_is_a_terminal_or_switched_off() {
    assert_eq!(keeps_stderr(false, None), Ok(()));
    assert_eq!(keeps_stderr(false, Some("1")), Ok(()));
    assert_eq!(keeps_stderr(false, Some("")), Ok(()));
    assert_eq!(keeps_stderr(true, None), Err("terminal"));
    assert_eq!(keeps_stderr(false, Some("0")), Err("switched_off"));
    assert_eq!(keeps_stderr(true, Some("0")), Err("switched_off"));
}

#[cfg(target_os = "linux")]
mod live {
    use super::super::*;
    use crate::inherited_fds::tests::live_process;
    use std::io::Write;
    use std::os::unix::process::ExitStatusExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::Instant;

    fn sleeper() -> std::process::Child {
        Command::new("sleep").arg("30").stdin(Stdio::null()).spawn().expect("sleep")
    }

    fn signal(child: &std::process::Child, signo: i32) {
        // SAFETY: the pid is this test's own unreaped child.
        assert_eq!(unsafe { libc::kill(child.id() as i32, signo) }, 0);
    }

    fn kernel_at_least(major: u32, minor: u32) -> bool {
        let release = std::fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default();
        let mut parts = release.trim().split(|c: char| !c.is_ascii_digit()).filter_map(|p| p.parse::<u32>().ok());
        (parts.next().unwrap_or(0), parts.next().unwrap_or(0)) >= (major, minor)
    }

    #[test]
    fn an_unreaped_end_is_read_and_left_for_its_parent_to_reap() {
        let _live = live_process();
        let mut child = sleeper();
        let mut held = Vec::new();
        assert!(hold(&mut held, child.id(), std::process::id(), Path::new("/proc")));
        signal(&child, libc::SIGTERM);
        let exit = read_death(&mut held, std::process::id(), Path::new("/proc"), READ_BOUND);
        assert_eq!(
            exit,
            Exit { pid: Some(child.id()), how: Some(How::Signal { signo: 15, core: false }), method: Method::Waitid }
        );
        assert!(held.is_empty(), "the read descriptor is closed");
        // Read with WNOWAIT: the parent still reaps it and still sees the signal.
        let status = child.wait().expect("the parent reaps its child");
        assert_eq!(status.signal(), Some(15));
    }

    #[test]
    fn an_end_already_reaped_is_read_from_the_pidfd_or_said_unread() {
        let _live = live_process();
        let mut child = sleeper();
        let mut held = Vec::new();
        assert!(hold(&mut held, child.id(), std::process::id(), Path::new("/proc")));
        signal(&child, libc::SIGKILL);
        assert_eq!(child.wait().expect("reaped").signal(), Some(9));
        let exit = read_death(&mut held, std::process::id(), Path::new("/proc"), READ_BOUND);
        if kernel_at_least(6, 15) {
            assert_eq!(
                exit,
                Exit { pid: Some(child.id()), how: Some(How::Signal { signo: 9, core: false }), method: Method::PidfdInfo }
            );
        } else {
            assert_eq!(exit, Exit::unread(Method::Unread));
        }
    }

    #[test]
    fn nothing_held_is_said_after_the_bound() {
        let started = Instant::now();
        let exit = read_death(&mut Vec::new(), std::process::id(), Path::new("/proc"), READ_BOUND);
        assert_eq!(exit, Exit::unread(Method::NotHeld));
        assert!(started.elapsed() >= READ_BOUND);
    }

    #[test]
    fn a_process_that_is_not_this_ones_child_is_not_held() {
        let _live = live_process();
        let mut child = sleeper();
        let mut held = Vec::new();
        // Its pid, claimed by a parent it does not have.
        assert!(!hold(&mut held, child.id(), std::process::id() + 1, Path::new("/proc")));
        assert!(held.is_empty());
        child.kill().expect("the child is this test's to stop");
        child.wait().expect("reaped");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ohmail-last-words-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    #[test]
    fn over_the_cap_the_tail_moves_to_old_and_writers_start_again_at_zero() {
        let dir = scratch("rotate");
        let path = dir.join(STDERR_FILE);
        let mut kept = Kept::open(path.clone(), 64).expect("opened");
        // A writer sharing the file's description, as fd 2 does.
        let mut writer = kept.file.try_clone().expect("a dup");
        writer.write_all(&[b'a'; 40]).expect("write");
        assert!(!kept.rotate_if_over().expect("checked"), "under the cap nothing moves");
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 40);
        assert!(!dir.join("stderr.log.old").exists());
        writer.write_all(&[b'b'; 40]).expect("write");
        assert!(kept.rotate_if_over().expect("rotated"));
        let old = std::fs::read(dir.join("stderr.log.old")).expect("the old file");
        assert_eq!(old, [&[b'a'; 24][..], &[b'b'; 40][..]].concat(), "the last 64 bytes");
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
        assert!(!dir.join("stderr.log.old.partial").exists());
        writer.write_all(b"after\n").expect("write");
        assert_eq!(std::fs::read(&path).unwrap(), b"after\n", "the next write lands at offset 0");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_marker_counts_the_lines_since_the_one_before_across_a_rotation() {
        let dir = scratch("marker");
        let path = dir.join(STDERR_FILE);
        std::fs::write(&path, b"from an earlier run\n").expect("seeded");
        let mut kept = Kept::open(path.clone(), 64).expect("opened");
        let mut writer = kept.file.try_clone().expect("a dup");
        assert_eq!(kept.marker("started"), Some(0), "nothing before the open counts");
        writer.write_all(b"one\ntwo\n").expect("write");
        assert_eq!(kept.marker("first"), Some(2));
        assert_eq!(kept.marker("second"), Some(0));
        writer.write_all(b"three\n").expect("write");
        writer.write_all(&[b'x'; 70]).expect("write");
        writer.write_all(b"\n").expect("write");
        assert!(kept.rotate_if_over().expect("rotated"));
        writer.write_all(b"four\nfive\n").expect("write");
        assert_eq!(kept.marker("third"), Some(4));
        let live = String::from_utf8(std::fs::read(&path).unwrap()).unwrap();
        assert!(live.starts_with("four\nfive\n") && live.ends_with(" --- third ---\n"), "{live}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Where the parent below tells its child which folders to use.
    const CHILD_DATA: &str = "OHMAIL_TEST_LAST_WORDS_DATA";

    /// THE CHILD HALF of the test below and nothing else: it returns at once unless its parent
    /// named a folder. It installs the keeper, then writes once down each path a line can take.
    #[test]
    #[ignore = "the child process of other_codes_stderr_is_kept_and_the_shells_own_is_not"]
    fn child_writes_down_every_path() {
        if std::env::var_os(CHILD_DATA).is_none() {
            return;
        }
        install("app.ohmail.test");
        crate::engine::log_json_line("shell-own");
        // SAFETY: a write of a static buffer to a descriptor this process holds.
        unsafe { libc::write(2, b"in-process\n".as_ptr().cast(), 11) };
        let _ = Command::new("sh").args(["-c", "echo child >&2"]).status();
        let mut opener = Command::new("sh");
        opener.args(["-c", "echo opener >&2"]);
        crate::engine::scrub_bundled_environment(&mut opener);
        let _ = opener.status();
        crate::inherited_fds::withhold_from_the_restart();
        let _ = Command::new("sh").args(["-c", "echo restart >&2"]).status();
    }

    fn run_child(name: &str, switch: Option<&str>) -> (PathBuf, String, Option<String>) {
        let dir = scratch(name);
        let launch = dir.join("launch.err");
        let mut command = Command::new(std::env::current_exe().expect("the test binary"));
        command
            .args(["last_words::tests::live::child_writes_down_every_path", "--exact", "--ignored", "--test-threads=1"])
            .env(CHILD_DATA, "1")
            .env("XDG_DATA_HOME", dir.join("data"))
            .env_remove("OHMAIL_STDERR_LOG")
            .stdin(Stdio::null())
            .stderr(std::fs::File::create(&launch).expect("the launch file"));
        if let Some(value) = switch {
            command.env("OHMAIL_STDERR_LOG", value);
        }
        let out = command.output().expect("the child ran");
        let said = String::from_utf8_lossy(&out.stdout);
        assert!(said.contains("1 passed"), "the child ran nothing: {said}");
        let kept = std::fs::read_to_string(dir.join("data/app.ohmail.test/logs/stderr.log")).ok();
        (dir.clone(), std::fs::read_to_string(&launch).expect("the launch file"), kept)
    }

    fn lines(text: &str) -> Vec<&str> {
        text.lines().filter(|l| !l.contains(" --- ") && !l.starts_with("running ")).collect()
    }

    #[test]
    fn other_codes_stderr_is_kept_and_the_shells_own_is_not() {
        let _live = live_process();
        let (dir, launch, kept) = run_child("reroute", None);
        let kept = kept.expect("stderr.log was written");
        assert!(kept.contains(&format!("--- ohmail {} started, pid ", env!("CARGO_PKG_VERSION"))), "{kept}");
        assert_eq!(lines(&kept), ["in-process", "child"], "{kept}");
        for line in ["shell-own", "opener", "restart"] {
            assert!(launch.lines().any(|l| l == line), "{line} did not reach the launch's stderr: {launch}");
        }
        assert!(!launch.contains("in-process") && !launch.lines().any(|l| l == "child"), "{launch}");
        let _ = std::fs::remove_dir_all(&dir);

        let (dir, launch, kept) = run_child("switched-off", Some("0"));
        assert_eq!(kept, None, "switched off, nothing is kept");
        for line in ["shell-own", "in-process", "child", "opener", "restart"] {
            assert!(launch.lines().any(|l| l == line), "{line}: {launch}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
