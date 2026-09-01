//! WHO DRAWS THE FRAME — the truth table, driven rather than described.
//!
//! Two of the environments below are transcribed from real machines rather than invented, and
//! that is what makes them worth having: `omarchy()` is the environment of the Hyprland session
//! process on an Omarchy 4.0.2 install (read out of `/proc/<hyprland>/environ`), and `gnome()`
//! is this project's own development desktop, GNOME on Wayland. The rule has to answer both
//! correctly, and the second one is the case where getting it wrong takes somebody's title bar
//! away for no reason.

use super::*;

/// A session, as a lookup the rule can be driven with.
fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
    move |key| pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| (*v).to_string())
}

/// Omarchy 4.0.2, Hyprland 0.56.2 — the session process's own environment, verbatim (the
/// entries a window's frame could depend on). `OMARCHY_PATH` is in here because it IS in the
/// real one; the rule reads it nowhere, which is the point of including it.
const OMARCHY: &[(&str, &str)] = &[
    ("DESKTOP_SESSION", "hyprland"),
    ("OMARCHY_PATH", "/usr/share/omarchy"),
    ("XDG_CURRENT_DESKTOP", "Hyprland"),
    ("XDG_SESSION_DESKTOP", "Hyprland"),
    ("XDG_SESSION_TYPE", "wayland"),
    ("XDG_RUNTIME_DIR", "/run/user/1000"),
];

/// This repository's own desktop: Zorin OS 18 (GNOME) on Wayland. Note the COLON-SEPARATED
/// `XDG_CURRENT_DESKTOP` — the specification says it is a list, and a substring test over it is
/// the obvious wrong implementation of the rule above.
const GNOME: &[(&str, &str)] = &[
    ("DESKTOP_SESSION", "zorin"),
    ("XDG_CURRENT_DESKTOP", "zorin:GNOME"),
    ("XDG_SESSION_DESKTOP", "zorin"),
    ("XDG_SESSION_TYPE", "wayland"),
    ("WAYLAND_DISPLAY", "wayland-0"),
    ("GDK_BACKEND", "wayland"),
];

#[test]
fn a_real_omarchy_session_hands_the_frame_to_the_compositor() {
    assert_eq!(decide(env(OMARCHY)), Frame::CompositorOwns);
    assert_eq!(compositor(env(OMARCHY)), Some("hyprland"));
    assert!(!decide(env(OMARCHY)).decorations());
    assert!(!decide(env(OMARCHY)).menu_bar());
}

/// THE CASE THAT MUST NOT REGRESS. GNOME, KDE, Xfce and every other stacking desktop keep the
/// title bar and the menu bar they have always had.
#[test]
fn a_real_gnome_wayland_session_keeps_its_decorations() {
    assert_eq!(decide(env(GNOME)), Frame::AppDraws);
    assert_eq!(compositor(env(GNOME)), None);
    assert!(decide(env(GNOME)).decorations());
    assert!(decide(env(GNOME)).menu_bar());
}

/// The distribution is not the signal, and this is the case that says so: Omarchy's own
/// packages and paths, with a GNOME session on top. Detection keyed on `/etc/os-release`,
/// `OMARCHY_PATH` or the staged-theme directory would strip this window's title bar; keyed on
/// the compositor it does not.
#[test]
fn omarchy_running_a_stacking_desktop_keeps_its_decorations() {
    let mixed = [
        ("OMARCHY_PATH", "/usr/share/omarchy"),
        ("XDG_CURRENT_DESKTOP", "GNOME"),
        ("XDG_SESSION_DESKTOP", "gnome"),
        ("XDG_SESSION_TYPE", "wayland"),
    ];
    assert_eq!(decide(env(&mixed)), Frame::AppDraws);
}

/// …and the mirror image: Hyprland on a distribution that has never heard of Omarchy is the
/// same window with the same two frames, and gets the same answer.
#[test]
fn hyprland_anywhere_is_the_same_window() {
    for distro in ["arch", "fedora", "nixos"] {
        let session = [
            ("DISTRO", distro),
            ("XDG_CURRENT_DESKTOP", "Hyprland"),
            ("XDG_SESSION_TYPE", "wayland"),
        ];
        assert_eq!(decide(env(&session)), Frame::CompositorOwns, "{distro}");
    }
}

/// Every compositor in the table, by both spellings of the desktop name, and none of them
/// dependent on case — `XDG_CURRENT_DESKTOP` is written `Hyprland` by Omarchy and `sway` by
/// sway, and the specification blesses neither.
#[test]
fn every_tiling_compositor_in_the_table_is_recognised_either_case() {
    for name in TILING_WAYLAND {
        for spelling in [name.to_string(), name.to_uppercase()] {
            let by_current = [("XDG_CURRENT_DESKTOP", spelling.as_str()), ("XDG_SESSION_TYPE", "wayland")];
            assert_eq!(compositor(env(&by_current)), Some(name), "{spelling} via XDG_CURRENT_DESKTOP");
            let by_session = [("XDG_SESSION_DESKTOP", spelling.as_str()), ("XDG_SESSION_TYPE", "wayland")];
            assert_eq!(compositor(env(&by_session)), Some(name), "{spelling} via XDG_SESSION_DESKTOP");
        }
    }
}

/// A colon-separated list is matched by TOKEN and never by substring. `wayfire:sway-ish` must
/// not read as sway, and `Hyprland` inside a longer token is not Hyprland.
#[test]
fn the_desktop_name_is_a_list_of_tokens_not_a_haystack() {
    let list = [("XDG_CURRENT_DESKTOP", "wlroots:sway:X-Generic"), ("XDG_SESSION_TYPE", "wayland")];
    assert_eq!(compositor(env(&list)), Some("sway"));

    for impostor in ["hyprland-shell", "notsway", "riverside", "nirivana", "dwlb"] {
        let session = [("XDG_CURRENT_DESKTOP", impostor), ("XDG_SESSION_TYPE", "wayland")];
        assert_eq!(compositor(env(&session)), None, "{impostor} is not a compositor in the table");
    }
}

/// The compositor's own socket is an independent way in — a session started from a tty where
/// nothing wrote `XDG_CURRENT_DESKTOP` still says which compositor it is.
#[test]
fn a_compositors_own_socket_is_enough_on_its_own() {
    for (variable, name) in TILING_SOCKETS {
        let session = [(variable, "/run/user/1000/whatever.sock"), ("XDG_SESSION_TYPE", "wayland")];
        assert_eq!(compositor(env(&session)), Some(name), "{variable}");
        assert_eq!(decide(env(&session)), Frame::CompositorOwns, "{variable}");
    }
}

/// An EMPTY socket variable is not a compositor. Exported-but-unset is what a shell profile
/// leaves behind, and it must read as absence.
#[test]
fn an_empty_socket_variable_proves_nothing() {
    for (variable, _) in TILING_SOCKETS {
        let session = [(variable, ""), ("XDG_SESSION_TYPE", "wayland")];
        assert_eq!(compositor(env(&session)), None, "{variable} is empty");
    }
}

/// X11 IS NOT THE FAULT. Under X11 the window manager decides, GTK asks and is refused, and a
/// tiling X11 window manager already produces a frameless window — so the rule must not fire
/// there, even when the desktop name is one of the five.
#[test]
fn an_x11_session_is_left_alone_however_it_is_named() {
    let x11 = [("XDG_CURRENT_DESKTOP", "Hyprland"), ("XDG_SESSION_TYPE", "x11")];
    assert_eq!(compositor(env(&x11)), None);
    assert_eq!(decide(env(&x11)), Frame::AppDraws);

    // …and a session with no type at all and no Wayland socket is not Wayland either.
    let bare = [("XDG_CURRENT_DESKTOP", "sway")];
    assert_eq!(compositor(env(&bare)), None);
}

/// A live `WAYLAND_DISPLAY` is enough to make it a Wayland session when nothing set the type.
#[test]
fn a_live_wayland_socket_is_enough_to_make_it_wayland() {
    let session = [("XDG_CURRENT_DESKTOP", "river"), ("WAYLAND_DISPLAY", "wayland-1")];
    assert_eq!(compositor(env(&session)), Some("river"));
    // …and an empty one is not a socket.
    let empty = [("XDG_CURRENT_DESKTOP", "river"), ("WAYLAND_DISPLAY", "")];
    assert_eq!(compositor(env(&empty)), None);
}

/// The escape hatch, both directions, over the top of whatever was detected.
#[test]
fn the_override_wins_in_both_directions() {
    for yes in ["1", "true", "on", "yes", " 1 "] {
        let mut session = OMARCHY.to_vec();
        session.push((OVERRIDE, yes));
        assert_eq!(decide(env(&session)), Frame::AppDraws, "{yes} on Omarchy");
    }
    for no in ["0", "false", "off", "no", " 0 "] {
        let mut session = GNOME.to_vec();
        session.push((OVERRIDE, no));
        assert_eq!(decide(env(&session)), Frame::CompositorOwns, "{no} on GNOME");
    }
}

/// A value that means neither is not an override. Guessing at `OHMAIL_DECORATIONS=maybe` would
/// make a typo silently change somebody's window.
#[test]
fn an_unrecognised_override_is_not_an_override() {
    for junk in ["", "maybe", "2", "please"] {
        let mut omarchy = OMARCHY.to_vec();
        omarchy.push((OVERRIDE, junk));
        assert_eq!(decide(env(&omarchy)), Frame::CompositorOwns, "{junk:?} on Omarchy");
        let mut gnome = GNOME.to_vec();
        gnome.push((OVERRIDE, junk));
        assert_eq!(decide(env(&gnome)), Frame::AppDraws, "{junk:?} on GNOME");
    }
}

/// The log line exists exactly where somebody would go looking for it, and nowhere else.
#[cfg(target_os = "linux")]
#[test]
fn it_says_something_only_when_it_changed_something() {
    assert_eq!(describe(env(GNOME)), None);
    let said = describe(env(OMARCHY)).expect("an Omarchy session says what it did");
    assert!(said.contains("hyprland"), "{said}");
    assert!(said.contains(OVERRIDE), "{said} does not say how to get the decorations back");

    let mut forced = GNOME.to_vec();
    forced.push((OVERRIDE, "0"));
    let said = describe(env(&forced)).expect("an override says so too");
    assert!(said.contains(OVERRIDE), "{said}");
}

/// The two questions are answered from one decision, so a window cannot end up with a menu bar
/// and no title bar to hang it under.
#[test]
fn the_title_bar_and_the_menu_bar_go_together() {
    for frame in [Frame::AppDraws, Frame::CompositorOwns] {
        assert_eq!(frame.decorations(), frame.menu_bar());
    }
}
