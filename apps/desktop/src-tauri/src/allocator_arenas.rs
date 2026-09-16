//! How many allocator arenas the ENGINE the shell spawns is allowed.
//!
//! glibc gives a contending thread its own arena — the main one on the brk heap, each other one a
//! 64 MiB mmap'd region. Measured on the Omarchy guest, capping them in the WEBVIEW's process is a
//! redistribution and not a saving: the per-thread arenas fell from 115 908 kB to 34 836 kB and the
//! brk heap rose from 69 024 kB to 157 576 kB, with the process's own RSS unmoved. So this is set
//! for the ENGINE CHILD ONLY, on the command that spawns it, never for this process and never
//! process-wide — a cap the renderer pays for and does not benefit from is a cost with no return.
//!
//! Linux only: no other platform's allocator reads it.

use std::process::Command;

/// The cap the engine is spawned with, or `None` while no measurement asks for one.
///
/// Set from the engine's own settled reading, never copied from the renderer's — the two
/// processes were measured apart because they allocate differently.
pub const ENGINE_ARENA_MAX: Option<&str> = None;

/// The variable glibc reads. Named once, here.
pub const ARENA_MAX_VAR: &str = "MALLOC_ARENA_MAX";

/// Put the cap on the engine's command, if there is one to put.
///
/// On the command and not in this process's environment: glibc reads the variable when a process
/// starts, so a child spawned with it gets it, and nothing else does.
pub fn apply_to_engine(command: &mut Command) {
    if cfg!(target_os = "linux") {
        if let Some(value) = ENGINE_ARENA_MAX {
            command.env(ARENA_MAX_VAR, value);
        }
    }
}

#[cfg(test)]
#[path = "allocator_arenas_tests.rs"]
mod tests;
