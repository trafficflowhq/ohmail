//! What the cap and the threshold may be, and that they reach the child and nothing else.

use super::{
    apply_to_engine, ARENA_MAX_VAR, ENGINE_ARENA_MAX, ENGINE_MMAP_THRESHOLD, MMAP_THRESHOLD_VAR,
};
use std::process::Command;

#[test]
fn the_variable_is_the_one_glibc_reads() {
    assert_eq!(ARENA_MAX_VAR, "MALLOC_ARENA_MAX");
}

#[test]
fn a_cap_that_exists_is_a_number_glibc_will_parse() {
    // Absent is the state while no measurement asks for a cap, and it is not a failure. What is
    // refused is a cap that is present and meaningless: zero is glibc's own default rather than a
    // cap, and anything high enough to admit every arena measured is not one either.
    if let Some(value) = ENGINE_ARENA_MAX {
        let n: u32 = value.parse().expect("the cap must parse as a number");
        assert!(n >= 1, "an arena cap of zero is glibc's default, not a cap");
        assert!(n <= 8, "a cap this high would admit every arena the engine was measured holding");
    }
}

#[test]
fn the_cap_never_touches_this_process() {
    // The whole point of putting it on the command: the webview's process was measured paying for
    // a cap it does not benefit from. If this ever sets the variable here, that cost comes back.
    let before = std::env::var_os(ARENA_MAX_VAR);
    let mut command = Command::new("/bin/true");
    apply_to_engine(&mut command);
    assert_eq!(std::env::var_os(ARENA_MAX_VAR), before);
}

#[test]
fn the_threshold_variable_is_the_one_glibc_reads() {
    assert_eq!(MMAP_THRESHOLD_VAR, "MALLOC_MMAP_THRESHOLD_");
}

#[test]
fn a_threshold_that_exists_hands_the_compile_segments_back() {
    // The optimizing compiler's zone segments are 32 KiB: above that they are carved from an
    // arena again (64 KiB measured partial), and below a page every small allocation is a map.
    if let Some(value) = ENGINE_MMAP_THRESHOLD {
        let n: u32 = value.parse().expect("the threshold must parse as a number of bytes");
        assert!(n >= 4096, "a threshold below a page maps every small allocation");
        assert!(n <= 32 * 1024, "above 32 KiB the compile segments stay in the arenas");
    }
}

#[test]
fn the_threshold_reaches_the_engine_command_on_linux() {
    let mut command = Command::new("/bin/true");
    apply_to_engine(&mut command);
    let set = command
        .get_envs()
        .find(|(key, _)| *key == MMAP_THRESHOLD_VAR)
        .and_then(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()));
    if cfg!(target_os = "linux") {
        assert_eq!(set.as_deref(), ENGINE_MMAP_THRESHOLD);
    } else {
        assert_eq!(set, None, "no other platform's allocator reads it");
    }
}

#[test]
fn the_threshold_never_touches_this_process() {
    let before = std::env::var_os(MMAP_THRESHOLD_VAR);
    let mut command = Command::new("/bin/true");
    apply_to_engine(&mut command);
    assert_eq!(std::env::var_os(MMAP_THRESHOLD_VAR), before);
}
