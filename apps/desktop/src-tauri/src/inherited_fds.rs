//! A RESTART STARTS THE NEW COPY AS A LAUNCH DOES: WITH STDIN, STDOUT AND STDERR, AND NOTHING ELSE.
//!
//! The AppImage runtime starts this process holding two descriptors without close-on-exec: the
//! read end of its keep-alive pipe and its mount directory at 1023. Its FUSE server exits once no
//! process holds that read end. `tauri::process::restart` spawns the new image with every
//! inheritable descriptor, so the new runtime, the new app and its web processes kept the old
//! pipe, and the replaced image stayed mounted, its deleted file open, until the new app quit.

/// What a launch handed this process: every descriptor above stderr without close-on-exec. The
/// standard library, GLib and WebKit open everything close-on-exec, so the flag is the tell.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn handed_in(open: &[(i32, bool)]) -> Vec<i32> {
    open.iter()
        .filter(|&&(fd, close_on_exec)| fd > 2 && !close_on_exec)
        .map(|&(fd, _)| fd)
        .collect()
}

#[cfg(target_os = "linux")]
mod sys {
    // glibc's `fcntl`. The command and flag values are the kernel's generic ones on every arch.
    extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }
    const F_GETFD: i32 = 1;
    const F_SETFD: i32 = 2;
    pub const FD_CLOEXEC: i32 = 1;

    /// The descriptor's flags, or `None` where it is not open.
    pub fn flags(fd: i32) -> Option<i32> {
        // SAFETY: F_GETFD reads the descriptor's flag word and touches no memory.
        let flags = unsafe { fcntl(fd, F_GETFD) };
        (flags >= 0).then_some(flags)
    }

    pub fn set_flags(fd: i32, flags: i32) -> bool {
        // SAFETY: F_SETFD writes the descriptor's flag word and nothing else.
        unsafe { fcntl(fd, F_SETFD, flags) == 0 }
    }
}

/// Every open descriptor and whether it is close-on-exec. The listing's own descriptor is closed
/// by the time the flags are read, so it reads as not open.
#[cfg(target_os = "linux")]
pub fn open_descriptors() -> Vec<(i32, bool)> {
    let Ok(listing) = std::fs::read_dir("/proc/self/fd") else { return Vec::new() };
    let fds: Vec<i32> = listing
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
        .collect();
    fds.into_iter()
        .filter_map(|fd| Some((fd, sys::flags(fd)? & sys::FD_CLOEXEC != 0)))
        .collect()
}

/// Mark what the launch handed in close-on-exec, just before the restart spawns the new copy.
/// Nothing is closed: this process runs from the old mount until it exits, and the processes it
/// already started hold their own copies. Returns how many were marked.
#[cfg(target_os = "linux")]
pub fn withhold_from_the_restart() -> usize {
    handed_in(&open_descriptors())
        .into_iter()
        .filter(|&fd| {
            sys::flags(fd).is_some_and(|flags| sys::set_flags(fd, flags | sys::FD_CLOEXEC))
        })
        .count()
}

/// Windows' installer ends this process and relaunches the app itself, and a macOS bundle has no
/// runtime handing it a keep-alive: there is nothing to withhold.
#[cfg(not(target_os = "linux"))]
pub fn withhold_from_the_restart() -> usize {
    0
}

#[cfg(test)]
#[path = "inherited_fds_tests.rs"]
pub(crate) mod tests;
