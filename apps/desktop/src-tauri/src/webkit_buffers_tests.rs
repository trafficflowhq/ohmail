use super::{plan, FORCE_SHM};

fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
    move |key| pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| (*v).to_string())
}

/// The session the failure was seen on: Hyprland, started by a session manager.
const HYPRLAND: &[(&str, &str)] = &[("XDG_SESSION_TYPE", "wayland"), ("WAYLAND_DISPLAY", "wayland-1")];

#[test]
fn asks_for_shared_memory_buffers_on_wayland_when_nobody_chose() {
    assert_eq!(plan(env(HYPRLAND)), Some((FORCE_SHM, "1")));
    assert_eq!(plan(env(&[("WAYLAND_DISPLAY", "wayland-0")])), Some((FORCE_SHM, "1")));
    let listed = [("XDG_SESSION_TYPE", "wayland"), ("GDK_BACKEND", "wayland,x11")];
    assert_eq!(plan(env(&listed)), Some((FORCE_SHM, "1")));
}

#[test]
fn leaves_an_x11_session_on_webkits_default() {
    assert_eq!(plan(env(&[])), None);
    assert_eq!(plan(env(&[("XDG_SESSION_TYPE", "x11"), ("DISPLAY", ":0")])), None);
    assert_eq!(plan(env(&[("WAYLAND_DISPLAY", "")])), None);
}

#[test]
fn leaves_gtk_on_xwayland_on_webkits_default() {
    for backend in ["x11", "x11,wayland", " x11 "] {
        let session = [("XDG_SESSION_TYPE", "wayland"), ("WAYLAND_DISPLAY", "wayland-1"), ("GDK_BACKEND", backend)];
        assert_eq!(plan(env(&session)), None, "{backend:?}");
    }
}

#[test]
fn leaves_a_value_the_person_set_alone() {
    for set in ["0", "1", ""] {
        let session = [("XDG_SESSION_TYPE", "wayland"), (FORCE_SHM, set)];
        assert_eq!(plan(env(&session)), None, "{set:?}");
    }
}

#[test]
fn names_the_variable_webkit_reads() {
    assert_eq!(FORCE_SHM, "WEBKIT_DMABUF_RENDERER_FORCE_SHM");
}
