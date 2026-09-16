//! What the cap is allowed to be, and that it reaches the child and nothing else.

use super::{apply_to_engine, ARENA_MAX_VAR, ENGINE_ARENA_MAX};
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
