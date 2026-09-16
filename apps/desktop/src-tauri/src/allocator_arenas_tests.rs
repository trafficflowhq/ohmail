//! The cap is a number a child can read, and an existing value wins.

use super::{apply, ARENA_MAX, ARENA_MAX_VAR};

#[test]
fn the_cap_is_a_positive_integer_glibc_will_parse() {
    let n: u32 = ARENA_MAX.parse().expect("the cap must parse as a number");
    assert!(n >= 1, "an arena cap of zero would be glibc's default, not a cap");
    assert!(n <= 8, "a cap this high is not a cap: the measured five arenas would all survive");
}

#[test]
fn the_variable_is_the_one_glibc_reads() {
    assert_eq!(ARENA_MAX_VAR, "MALLOC_ARENA_MAX");
}

#[test]
#[cfg(target_os = "linux")]
fn an_operator_who_set_it_keeps_their_value() {
    // Serial by construction: this test owns the variable for its own process. The arm that
    // matters is the SECOND call — a default that overwrote an operator's value would be a
    // setting the app took away from them.
    unsafe { std::env::set_var(ARENA_MAX_VAR, "7") };
    apply();
    assert_eq!(std::env::var(ARENA_MAX_VAR).ok().as_deref(), Some("7"));
    unsafe { std::env::remove_var(ARENA_MAX_VAR) };
    apply();
    assert_eq!(std::env::var(ARENA_MAX_VAR).ok().as_deref(), Some(ARENA_MAX));
    unsafe { std::env::remove_var(ARENA_MAX_VAR) };
}
