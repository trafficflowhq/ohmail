//! How many allocator arenas this app's processes are allowed.
//!
//! glibc gives a contending thread its own arena — the main one on the brk heap, each other one a
//! 64 MiB mmap'd region it grows into. The webview's process runs dozens of threads, and on a
//! machine without a working GPU driver ten of them are the software rasteriser's. Measured on the
//! Omarchy guest, five arenas held 186 MB of a 716 MB renderer: a quarter of the process, in the
//! allocator rather than in anything the app put there.
//!
//! The cap is an ENVIRONMENT variable and not a `mallopt` call because the process that holds that
//! memory is a CHILD: glibc reads this tunable once, at ITS startup, so the shell sets it for
//! everything it spawns. It is written as the first statement of `main`, before any thread exists
//! — writing the environment of a process that is already threaded is a data race.
//!
//! Linux only: Windows and macOS do not use glibc's allocator and neither reads this.

/// The cap. Two, because two and four measured the same memory and two is the smaller promise.
pub const ARENA_MAX: &str = "2";

/// The variable glibc reads. Named once, here.
pub const ARENA_MAX_VAR: &str = "MALLOC_ARENA_MAX";

/// Cap the arenas for this process and every process it spawns.
///
/// # Safety
/// Called as the first statement of `main`, where this program is single-threaded. `set_var` is
/// unsound beside another thread reading the environment, which is why the call site is fixed and
/// asserted by `desktop-shell.test.ts` rather than left to a reader's care.
pub fn apply() {
    #[cfg(target_os = "linux")]
    if std::env::var_os(ARENA_MAX_VAR).is_none() {
        // An operator who set it keeps their value: this is a default, not a policy.
        unsafe { std::env::set_var(ARENA_MAX_VAR, ARENA_MAX) };
    }
}

#[cfg(test)]
#[path = "allocator_arenas_tests.rs"]
mod tests;
