//! A WINDOW PROCESS THAT DIES LEAVES HOW IT ENDED.
//!
//! `renderer_gone` says WebKit noticed; it cannot say how the web process ended, and WebKit itself
//! says nothing on stderr when it kills one or one crashes. Two things can. The exit status, which
//! the kernel keeps for this process (the web process is its child and GLib reaps it): [`arm`]
//! holds a pidfd per web process and reads the status at each death with `WNOWAIT`, or from the
//! pidfd once GLib has reaped it, and never reaps, signals or traces anything. And what other code
//! wrote to stderr before it went (aborts from glibc, GLib or Mesa), which a launcher-started app
//! discards: [`install`] points fd 2 at `stderr.log` beside `engine.log`, while the shell's own
//! lines keep going to the launch's stderr ([`launch_stderr`]). Linux only; elsewhere every
//! function here does nothing and [`launch_stderr`] is plain stderr.
#![cfg_attr(not(target_os = "linux"), allow(dead_code, unused_imports))]

use std::io::{self, Write};
use std::time::Duration;

/// How long a death waits for its status to become readable.
pub const READ_BOUND: Duration = Duration::from_secs(3);
/// Web processes held at once; the oldest goes first.
pub const HELD_MAX: usize = 8;
/// `stderr.log`'s size before its tail moves to `stderr.log.old`.
pub const STDERR_CAP: u64 = 256 * 1024;
pub const STDERR_FILE: &str = "stderr.log";
/// `0` keeps stderr where the launch pointed it.
pub const SWITCH: &str = "OHMAIL_STDERR_LOG";

/// `si_code` values for a child that ended, the kernel's on every arch.
pub const CLD_EXITED: i32 = 1;
pub const CLD_KILLED: i32 = 2;
pub const CLD_DUMPED: i32 = 3;

/// How a process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum How {
    Signal { signo: i32, core: bool },
    Exited(i32),
}

/// Where the reading came from, or why there is none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// The child was still unreaped: `waitid(.., WNOWAIT)`.
    Waitid,
    /// GLib had reaped it: the status the kernel keeps on the pidfd (6.15 and later).
    PidfdInfo,
    /// Reaped, and this kernel keeps no status on the pidfd.
    Unread,
    /// No web process was held and none was left unreaped.
    NotHeld,
    /// The kernel refused a pidfd.
    Unsupported,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Waitid => "waitid",
            Method::PidfdInfo => "pidfd_info",
            Method::Unread => "unread",
            Method::NotHeld => "not_held",
            Method::Unsupported => "unsupported",
        }
    }
}

/// One death's reading. Without a status, the pid is withheld too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Exit {
    pub pid: Option<u32>,
    pub how: Option<How>,
    pub method: Method,
}

impl Exit {
    pub fn unread(method: Method) -> Exit {
        Exit { pid: None, how: None, method }
    }
}

/// A raw wait status as `waitpid` and `PIDFD_INFO_EXIT` give it. A stop is not an end.
pub fn decode_status(status: i32) -> Option<How> {
    match status & 0x7f {
        0 => Some(How::Exited((status >> 8) & 0xff)),
        0x7f => None,
        signo => Some(How::Signal { signo, core: status & 0x80 != 0 }),
    }
}

/// `si_code` and `si_status` as `waitid` gives them.
pub fn decode_siginfo(code: i32, status: i32) -> Option<How> {
    match code {
        CLD_EXITED => Some(How::Exited(status)),
        CLD_KILLED => Some(How::Signal { signo: status, core: false }),
        CLD_DUMPED => Some(How::Signal { signo: status, core: true }),
        _ => None,
    }
}

/// The generic Linux numbers (x86-64, arm64).
const SIGNALS: &[(i32, &str)] = &[
    (1, "SIGHUP"),
    (2, "SIGINT"),
    (3, "SIGQUIT"),
    (4, "SIGILL"),
    (5, "SIGTRAP"),
    (6, "SIGABRT"),
    (7, "SIGBUS"),
    (8, "SIGFPE"),
    (9, "SIGKILL"),
    (10, "SIGUSR1"),
    (11, "SIGSEGV"),
    (12, "SIGUSR2"),
    (13, "SIGPIPE"),
    (14, "SIGALRM"),
    (15, "SIGTERM"),
    (24, "SIGXCPU"),
    (25, "SIGXFSZ"),
    (31, "SIGSYS"),
];

pub fn signal_name(signo: i32) -> &'static str {
    SIGNALS.iter().find(|(n, _)| *n == signo).map_or("other", |(_, name)| name)
}

/// The diagnostic line: numbers, and words from this file's tables only.
pub fn exit_line(exit: &Exit, stderr_lines: Option<u64>) -> String {
    let null = || "null".to_string();
    let (signal, signo, core, status) = match exit.how {
        Some(How::Signal { signo, core }) => {
            (format!("\"{}\"", signal_name(signo)), signo.to_string(), core.to_string(), null())
        }
        Some(How::Exited(code)) => (null(), null(), null(), code.to_string()),
        None => (null(), null(), null(), null()),
    };
    let pid = exit.pid.map_or_else(null, |p| p.to_string());
    let lines = stderr_lines.map_or_else(null, |n| n.to_string());
    format!(
        "{{\"service\":\"shell\",\"event\":\"renderer_exit\",\"pid\":{pid},\"signal\":{signal},\"signo\":{signo},\"core\":{core},\"exitStatus\":{status},\"method\":\"{}\",\"stderrLines\":{lines}}}",
        exit.method.as_str()
    )
}

/// The marker's words in `stderr.log`.
pub fn marker_words(exit: &Exit) -> String {
    let pid = exit.pid.map_or_else(|| "?".to_string(), |p| p.to_string());
    let how = match (exit.how, exit.method) {
        (Some(How::Signal { signo, .. }), _) if signal_name(signo) == "other" => format!("signal {signo}"),
        (Some(How::Signal { signo, .. }), _) => signal_name(signo).to_string(),
        (Some(How::Exited(code)), _) => format!("exit {code}"),
        (None, Method::NotHeld) => "not held".to_string(),
        (None, method) => method.as_str().to_string(),
    };
    format!("window process {pid} ended: {how}")
}

/// Whether to keep stderr: never a terminal's, and never when switched off.
pub fn keeps_stderr(tty: bool, switch: Option<&str>) -> Result<(), &'static str> {
    if switch == Some("0") {
        return Err("switched_off");
    }
    if tty {
        return Err("terminal");
    }
    Ok(())
}

/// The launch's own stderr, where the shell's lines go once fd 2 is `stderr.log`.
pub struct LaunchStderr;

impl Write for LaunchStderr {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        #[cfg(target_os = "linux")]
        if let Some(fd) = linux::launch_fd() {
            // SAFETY: a write from a live buffer to a descriptor this module keeps open.
            let n = unsafe { libc::write(fd, buf.as_ptr().cast(), buf.len()) };
            return if n < 0 { Err(io::Error::last_os_error()) } else { Ok(n as usize) };
        }
        io::stderr().write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        io::stderr().flush()
    }
}

pub fn launch_stderr() -> LaunchStderr {
    LaunchStderr
}

/// Stderr for a child that may outlive the app (the browser the opener starts): the launch's.
pub fn launch_stderr_for_child() -> std::process::Stdio {
    #[cfg(target_os = "linux")]
    if let Some(fd) = linux::launch_copy() {
        return std::process::Stdio::from(fd);
    }
    std::process::Stdio::inherit()
}

/// Before the runtime is built (setup starts a web process): fd 2 to `stderr.log`, unless stderr
/// is a terminal or `OHMAIL_STDERR_LOG=0`. Any failure leaves fd 2 as launched.
pub fn install(identifier: &str) {
    #[cfg(target_os = "linux")]
    linux::install(identifier);
    #[cfg(not(target_os = "linux"))]
    let _ = identifier;
}

/// From `Shell::open_log`: one line when stderr is not kept, or kept somewhere else.
pub fn attach(log_dir: Option<&std::path::Path>) {
    #[cfg(target_os = "linux")]
    if let Some(line) = linux::attach_line(log_dir) {
        crate::engine::log_json_line(&line);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = log_dir;
}

/// Before a restart: fd 2 back to the launch's stderr, so the new copy starts as a launch does.
pub fn hand_back() {
    #[cfg(target_os = "linux")]
    linux::hand_back();
}

#[cfg(target_os = "linux")]
pub use linux::arm;
#[cfg(all(test, target_os = "linux"))]
use linux::{hold, read_death, Kept};

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use crate::vitals::{parse_stat_parent, webkit_children_in};
    use std::fs::{File, OpenOptions};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::os::unix::fs::{FileExt, OpenOptionsExt, PermissionsExt};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
    use std::sync::Mutex;
    use std::time::Instant;

    const WEB_PROCESS: &str = "WebKitWebProcess";
    const KEEPER_EVERY: Duration = Duration::from_secs(2);
    const POLL_STEP: Duration = Duration::from_millis(100);
    // `struct pidfd_info` (VER0, 64 bytes): `mask` at 0, `exit_code` at 60.
    const PIDFD_INFO_EXIT: u64 = 1 << 3;
    const PIDFD_INFO_SIZE: usize = 64;
    const PIDFD_GET_INFO: u64 = (3 << 30) | ((PIDFD_INFO_SIZE as u64) << 16) | (0xFF << 8) | 11;

    /// The launch's stderr, copied close-on-exec before fd 2 moved.
    static LAUNCH: AtomicI32 = AtomicI32::new(-1);
    static KEPT: Mutex<Option<Kept>> = Mutex::new(None);
    /// The folder `stderr.log` is in, or why stderr is not kept.
    static OUTCOME: Mutex<Option<Result<PathBuf, &'static str>>> = Mutex::new(None);
    static UNSUPPORTED: AtomicBool = AtomicBool::new(false);

    pub fn launch_fd() -> Option<RawFd> {
        let fd = LAUNCH.load(Ordering::Acquire);
        (fd >= 0).then_some(fd)
    }

    pub fn launch_copy() -> Option<OwnedFd> {
        let fd = launch_fd()?;
        // SAFETY: F_DUPFD_CLOEXEC makes a new descriptor, owned from here on.
        let copy = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
        (copy >= 0).then(|| unsafe { OwnedFd::from_raw_fd(copy) })
    }

    /// `stderr.log` through its own descriptor: where the last marker ended, and the lines a
    /// rotation took past it.
    pub struct Kept {
        pub(super) file: File,
        path: PathBuf,
        cap: u64,
        mark_at: u64,
        carried: u64,
    }

    impl Kept {
        pub fn open(path: PathBuf, cap: u64) -> io::Result<Kept> {
            let file =
                OpenOptions::new().read(true).append(true).create(true).mode(0o600).open(&path)?;
            let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
            let mark_at = file.metadata()?.len();
            Ok(Kept { file, path, cap, mark_at, carried: 0 })
        }

        fn newlines(&self, from: u64, to: u64) -> u64 {
            let mut buf = [0u8; 8192];
            let (mut at, mut count) = (from, 0);
            while at < to {
                let want = ((to - at) as usize).min(buf.len());
                match self.file.read_at(&mut buf[..want], at) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        count += buf[..n].iter().filter(|b| **b == b'\n').count() as u64;
                        at += n as u64;
                    }
                }
            }
            count
        }

        /// Over the cap: the last `cap` bytes to `.old` (written whole, then renamed), and the live
        /// file truncated through this descriptor. Every writer appends, so they go on at zero.
        pub fn rotate_if_over(&mut self) -> io::Result<bool> {
            let len = self.file.metadata()?.len();
            if len <= self.cap {
                return Ok(false);
            }
            let mut tail = vec![0u8; self.cap as usize];
            self.file.read_exact_at(&mut tail, len - self.cap)?;
            let old = self.path.with_extension("log.old");
            let partial = self.path.with_extension("log.old.partial");
            {
                let mut out = OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(0o600)
                    .open(&partial)?;
                out.write_all(&tail)?;
            }
            std::fs::rename(&partial, &old)?;
            let leaving = self.newlines(self.mark_at.min(len), len);
            self.carried += leaving;
            self.file.set_len(0)?;
            self.mark_at = 0;
            Ok(true)
        }

        /// `<stamp> --- <words> ---`, and the lines written since the marker before it.
        pub fn marker(&mut self, words: &str) -> Option<u64> {
            let len = self.file.metadata().ok()?.len();
            let lines = self.carried + self.newlines(self.mark_at.min(len), len);
            let stamp = crate::engine::utc_stamp(std::time::SystemTime::now());
            let _ = self.file.write_all(format!("{stamp} --- {words} ---\n").as_bytes());
            self.mark_at = self.file.metadata().map(|m| m.len()).unwrap_or(len);
            self.carried = 0;
            Some(lines)
        }
    }

    pub fn install(identifier: &str) {
        let outcome = keep(identifier);
        if let Ok(mut slot) = OUTCOME.lock() {
            *slot = Some(outcome);
        }
    }

    fn keep(identifier: &str) -> Result<PathBuf, &'static str> {
        // SAFETY: isatty reads the descriptor's type and touches no memory.
        let tty = unsafe { libc::isatty(2) } == 1;
        keeps_stderr(tty, std::env::var(SWITCH).ok().as_deref())?;
        // Tauri's `app_log_dir` on Linux, so the file sits beside `engine.log`.
        let dir = dirs::data_local_dir().ok_or("no_data_dir")?.join(identifier).join("logs");
        std::fs::create_dir_all(&dir).map_err(|_| "no_folder")?;
        let mut kept = Kept::open(dir.join(STDERR_FILE), STDERR_CAP).map_err(|_| "not_opened")?;
        // SAFETY: both calls make or replace descriptors this process owns; a failure changes nothing.
        let launch = unsafe { libc::fcntl(2, libc::F_DUPFD_CLOEXEC, 3) };
        if launch < 0 {
            return Err("no_stderr");
        }
        if unsafe { libc::dup2(kept.file.as_raw_fd(), 2) } < 0 {
            drop(unsafe { OwnedFd::from_raw_fd(launch) });
            return Err("not_moved");
        }
        LAUNCH.store(launch, Ordering::Release);
        kept.marker(&format!("ohmail {} started, pid {}", env!("CARGO_PKG_VERSION"), std::process::id()));
        if let Ok(mut slot) = KEPT.lock() {
            *slot = Some(kept);
        }
        let _ = std::thread::Builder::new().name("stderr-keeper".into()).spawn(|| loop {
            std::thread::sleep(KEEPER_EVERY);
            if let Ok(mut slot) = KEPT.lock() {
                if let Some(kept) = slot.as_mut() {
                    let _ = kept.rotate_if_over();
                }
            }
        });
        Ok(dir)
    }

    pub fn attach_line(log_dir: Option<&Path>) -> Option<String> {
        let outcome = OUTCOME.lock().ok()?.clone()?;
        match outcome {
            Ok(dir) if Some(dir.as_path()) == log_dir => None,
            Ok(_) => Some(
                "{\"service\":\"shell\",\"event\":\"stderr_log\",\"kept\":true,\"folder\":\"not_beside_engine_log\"}"
                    .to_string(),
            ),
            Err(reason) => Some(format!(
                "{{\"service\":\"shell\",\"event\":\"stderr_log\",\"kept\":false,\"reason\":\"{reason}\"}}"
            )),
        }
    }

    pub fn hand_back() {
        if let Some(launch) = launch_fd() {
            // SAFETY: dup2 replaces fd 2 with a copy of a descriptor this module keeps open.
            unsafe { libc::dup2(launch, 2) };
        }
    }

    /// One web process, held by a pidfd.
    pub struct Pidfd {
        pid: u32,
        fd: OwnedFd,
    }

    fn open_pidfd(pid: u32) -> Option<OwnedFd> {
        // SAFETY: pidfd_open takes two integers; a pidfd is always close-on-exec.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0 as libc::c_uint) };
        if fd < 0 {
            if io::Error::last_os_error().raw_os_error() == Some(libc::ENOSYS) {
                UNSUPPORTED.store(true, Ordering::Relaxed);
            }
            return None;
        }
        Some(unsafe { OwnedFd::from_raw_fd(fd as RawFd) })
    }

    fn child_of(proc_root: &Path, pid: u32, me: u32) -> bool {
        std::fs::read_to_string(proc_root.join(pid.to_string()).join("stat"))
            .ok()
            .and_then(|stat| parse_stat_parent(&stat))
            .is_some_and(|(_, ppid)| ppid == me)
    }

    /// Hold `pid` if it is this process's child, checked after the pidfd pins it.
    pub fn hold(held: &mut Vec<Pidfd>, pid: u32, me: u32, proc_root: &Path) -> bool {
        if held.iter().any(|p| p.pid == pid) {
            return false;
        }
        let Some(fd) = open_pidfd(pid) else { return false };
        if !child_of(proc_root, pid, me) {
            return false;
        }
        held.push(Pidfd { pid, fd });
        if held.len() > HELD_MAX {
            held.remove(0);
        }
        true
    }

    /// At each commit: drop what already ended, hold the web processes not yet held.
    fn hold_children(held: &mut Vec<Pidfd>, me: u32, proc_root: &Path) {
        held.retain(|p| peek(p).is_none());
        for child in webkit_children_in(proc_root, me) {
            if child.name == WEB_PROCESS {
                hold(held, child.pid, me, proc_root);
            }
        }
    }

    /// `waitid(P_PIDFD, .., WEXITED|WNOHANG|WNOWAIT)`: the end, if there is one, left unreaped.
    fn waitid_peek(fd: RawFd) -> Result<Option<(i32, i32)>, i32> {
        loop {
            // SAFETY: a zeroed siginfo_t is valid, and waitid writes only into it.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let rc = unsafe {
                libc::waitid(
                    libc::P_PIDFD,
                    fd as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if rc != 0 {
                let errno = io::Error::last_os_error().raw_os_error().unwrap_or(0);
                if errno == libc::EINTR {
                    continue;
                }
                return Err(errno);
            }
            // SAFETY: the union's child fields are the ones waitid fills.
            return Ok((unsafe { info.si_pid() } != 0).then(|| (info.si_code, unsafe { info.si_status() })));
        }
    }

    /// The raw wait status the kernel keeps on a pidfd once the process is reaped (6.15 and later).
    fn exit_info(fd: RawFd) -> Option<i32> {
        #[repr(C, align(8))]
        struct Info([u8; PIDFD_INFO_SIZE]);
        let mut info = Info([0; PIDFD_INFO_SIZE]);
        info.0[..8].copy_from_slice(&PIDFD_INFO_EXIT.to_ne_bytes());
        // SAFETY: the kernel writes at most the 64 bytes the request number names.
        if unsafe { libc::ioctl(fd, PIDFD_GET_INFO as _, info.0.as_mut_ptr()) } != 0 {
            return None;
        }
        let mask = u64::from_ne_bytes(info.0[..8].try_into().ok()?);
        (mask & PIDFD_INFO_EXIT != 0).then(|| i32::from_ne_bytes([info.0[60], info.0[61], info.0[62], info.0[63]]))
    }

    /// The end of a held process, or `None` while it runs.
    fn peek(p: &Pidfd) -> Option<Exit> {
        match waitid_peek(p.fd.as_raw_fd()) {
            Ok(None) => None,
            Ok(Some((code, status))) => Some(match decode_siginfo(code, status) {
                Some(how) => Exit { pid: Some(p.pid), how: Some(how), method: Method::Waitid },
                None => Exit::unread(Method::Unread),
            }),
            Err(libc::ECHILD) => Some(match exit_info(p.fd.as_raw_fd()).and_then(decode_status) {
                Some(how) => Exit { pid: Some(p.pid), how: Some(how), method: Method::PidfdInfo },
                None => Exit::unread(Method::Unread),
            }),
            Err(_) => None,
        }
    }

    /// A web process child that ended and is not reaped yet, read the same way.
    fn unreaped_child(me: u32, proc_root: &Path) -> Option<Exit> {
        webkit_children_in(proc_root, me).into_iter().filter(|c| c.name == WEB_PROCESS).find_map(|c| {
            let fd = open_pidfd(c.pid)?;
            child_of(proc_root, c.pid, me).then(|| peek(&Pidfd { pid: c.pid, fd }))?
        })
    }

    fn wait_on(held: &[Pidfd], step: Duration) {
        if held.is_empty() {
            std::thread::sleep(step);
            return;
        }
        let mut fds: Vec<libc::pollfd> =
            held.iter().map(|p| libc::pollfd { fd: p.fd.as_raw_fd(), events: libc::POLLIN, revents: 0 }).collect();
        // SAFETY: `fds` is a live array of `fds.len()` pollfd records.
        unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, step.as_millis() as libc::c_int) };
    }

    /// The death's reading, newest held first, within `bound`. The read descriptor is closed.
    pub fn read_death(held: &mut Vec<Pidfd>, me: u32, proc_root: &Path, bound: Duration) -> Exit {
        let deadline = Instant::now() + bound;
        loop {
            for i in (0..held.len()).rev() {
                if let Some(exit) = peek(&held[i]) {
                    held.remove(i);
                    return exit;
                }
            }
            if let Some(exit) = unreaped_child(me, proc_root) {
                return exit;
            }
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            wait_on(held, (deadline - now).min(POLL_STEP));
        }
        let method = if UNSUPPORTED.load(Ordering::Relaxed) { Method::Unsupported } else { Method::NotHeld };
        Exit::unread(method)
    }

    fn report(exit: &Exit) {
        let lines = KEPT.lock().ok().and_then(|mut slot| slot.as_mut()?.marker(&marker_words(exit)));
        crate::engine::log_json_line(&exit_line(exit, lines));
    }

    /// From the one `setup`, after `renderer_recovery::arm`: hold the main view's web processes at
    /// each commit, and read how each one ended when it dies.
    pub fn arm<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
        use std::sync::Arc;
        use tauri::Manager;
        let Some(window) = app.get_webview_window("main") else { return };
        let me = std::process::id();
        let held: Arc<Mutex<Vec<Pidfd>>> = Arc::default();
        let _ = window.with_webview(move |platform| {
            use webkit2gtk::{LoadEvent, WebViewExt};
            let view = platform.inner();
            let on_commit = Arc::clone(&held);
            view.connect_load_changed(move |_, event| {
                if event == LoadEvent::Committed {
                    if let Ok(mut held) = on_commit.lock() {
                        hold_children(&mut held, me, Path::new("/proc"));
                    }
                }
            });
            view.connect_web_process_terminated(move |_, _| {
                let mut taken = held.lock().map(|mut h| std::mem::take(&mut *h)).unwrap_or_default();
                let back = Arc::clone(&held);
                let _ = std::thread::Builder::new().name("last-words".into()).spawn(move || {
                    let exit = read_death(&mut taken, me, Path::new("/proc"), READ_BOUND);
                    if let Ok(mut held) = back.lock() {
                        let newer = std::mem::take(&mut *held);
                        *held = taken;
                        held.extend(newer);
                        let over = held.len().saturating_sub(HELD_MAX);
                        held.drain(..over);
                    }
                    report(&exit);
                });
            });
        });
    }
}

#[cfg(test)]
#[path = "last_words_tests.rs"]
mod tests;
