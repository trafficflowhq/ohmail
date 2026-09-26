//! How the allocator of the ENGINE the shell spawns is set: its arena cap and its mmap threshold.
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
/// Two, from the engine's own settled reading on main: 462.0 MB capped against 509.1 MB
/// uncapped over a 15-minute tail, 47.2 MB saved at twenty-two times the larger arm's own
/// spread, one arena block instead of seven, and idle CPU identical. Never copied from the
/// renderer's, which measured the same cap as a pure redistribution — the two processes
/// allocate differently and were measured apart for that reason.
pub const ENGINE_ARENA_MAX: Option<&str> = Some("2");

/// The variable glibc reads. Named once, here.
pub const ARENA_MAX_VAR: &str = "MALLOC_ARENA_MAX";

/// The fixed mmap threshold the engine is spawned with, in bytes, or `None`.
///
/// The JavaScript engine optimizes the store's WebAssembly on background threads, in 32 KiB
/// zone segments from malloc. Under glibc's sliding threshold those segments are carved from an
/// arena and stay resident once the compile is over, by an amount that depends on timing; a
/// FIXED threshold maps each one and hands it back when it is freed. Measured at the engine's
/// boot line under the cap above: 368.3-439.6 MB without it, 335.7-337.5 MB with it, the
/// optimizing tier kept.
pub const ENGINE_MMAP_THRESHOLD: Option<&str> = Some("32768");

/// The variable glibc reads for it, trailing underscore included. Named once, here.
pub const MMAP_THRESHOLD_VAR: &str = "MALLOC_MMAP_THRESHOLD_";

/// Put the cap and the threshold on the engine's command, where there is one to put.
///
/// On the command and not in this process's environment: glibc reads the variables when a
/// process starts, so a child spawned with them gets them, and nothing else does.
pub fn apply_to_engine(command: &mut Command) {
    if cfg!(target_os = "linux") {
        if let Some(value) = ENGINE_ARENA_MAX {
            command.env(ARENA_MAX_VAR, value);
        }
        if let Some(value) = ENGINE_MMAP_THRESHOLD {
            command.env(MMAP_THRESHOLD_VAR, value);
        }
    }
}

#[cfg(test)]
#[path = "allocator_arenas_tests.rs"]
mod tests;
