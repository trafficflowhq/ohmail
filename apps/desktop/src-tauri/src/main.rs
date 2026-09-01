// No console window behind the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The whole Rust side. ohmail Desktop is a window around a static bundle: there
// are no commands for the webview to call, and capabilities/main.json grants it
// nothing. Window geometry, title, CSP and icons are declarative in
// tauri.conf.json — code here would only be a second place for them to disagree.
//
// ── THE ONE THING THE WEBVIEW STILL CANNOT DO, AND THIS PROCESS NOW CAN ────────
//
// The app carries an auto-updater (`updater.rs`), and that is the single place
// this binary reaches the network: pinned HTTPS requests to its own GitHub
// Releases feed and to the signed artifact that feed names, and every payload
// minisign-verified before it may install. It is Rust-side on purpose — the
// webview is granted no updater permission, so the four locks that assert "the
// page reaches nothing" stay literally true while the PROCESS makes the request.
// `updater.rs` carries the reasoning; `attach` and `on_launch` here are the only
// places it is hooked up.
//
// `on_launch` is the check that happens without being asked, once, shortly after
// the window opens. It says nothing at all unless it finds a newer release, and
// it installs nothing on its own: the payload is fetched and verified, and one
// dialog then asks whether to restart into it. An updater whose only trigger is a
// menu item is an updater nobody runs.
//
// ── THE ONE PIECE OF INTERFACE THIS PROCESS DRAWS ─────────────────────────────
//
// The menu bar (`menu.rs`), because it cannot be anything else: it belongs to the
// operating system, and its accelerators have to work before the page has focus.
// Everything else a person sees is React inside the webview. The bar has exactly
// one owner, and that is not an aesthetic preference — a menu is installed from
// `Builder::setup`, and a second `setup` REPLACES the first silently.
//
// ── THE ONE THING THIS FILE DOES BEYOND OPENING A WINDOW ──────────────────────
//
// Under the `local-engine` feature — OFF by default, and off in every build
// published so far — the shell also owns the lifetime of the local engine: it
// starts it with the app, lets the window choose which mailbox the install is
// for, and makes certain the engine is gone when the app is. That is process
// lifecycle, not a capability the webview gains for free: with the feature off
// the permission list stays empty, because the frontend calls nothing and no
// command is registered for it to call. `engine.rs` and `config.rs` carry the
// reasoning; the lines here are the only places any of it is hooked up.
//
// What is held across the run is a `Shell` rather than an `Engine`, and the
// difference is load-bearing: a reconfigure REPLACES the engine, so a handle to
// one particular engine would stop the wrong process on quit — the one that had
// already been swapped out — and leave the live one behind. `Shell::stop` always
// stops the current one.
//
// The hooks are BOTH of the ones that exist, and they are not redundant.
// Destroying the last window ends the app on Windows and Linux, so `Exit`
// covers a quit; it does not on macOS, where a closed window can leave the
// process running — and an engine outliving the window it belonged to is
// exactly the stray process this exists to prevent. `Shell::stop` is idempotent,
// so a platform that fires both pays nothing for it.
//
// HOST MODE bends exactly one of those rules, on the user's explicit say-so.
// With host mode armed — this install publishing its mail engine to the user's
// own tailnet, so a phone reads mail through this process — closing the window
// must not cut the phone off: the close becomes a hide, a tray icon is the way
// back, and the engine's lifetime belongs to the APP (the tray's Quit, or the
// platform's) rather than to the window. Disarmed is the behaviour above,
// unchanged. The whole policy is `host::lifecycle_action`, one function whose
// disarmed column is held to today's behaviour by test; the closure at the
// bottom of this file only maps events into it and performs what it says.

#[cfg(feature = "local-engine")]
mod config;
#[cfg(feature = "local-engine")]
mod default_mail;
#[cfg(feature = "local-engine")]
mod engine;
#[cfg(feature = "local-engine")]
mod host;
// WHO DRAWS THE FRAME — the app, or the compositor. Always compiled, because the answer
// decides whether this binary builds a menu bar at all and that is not a feature-gated
// question: on a tiling Wayland compositor the compositor owns the frame, so ohmail draws
// neither a title bar nor a menu bar there. Pure and Tauri-free; `menu.rs` performs it, from
// the one `setup` this binary has.
mod frame;
mod menu;
// The Omarchy theme feed — on an Omarchy desktop the window follows the system theme live.
// Two modules on purpose: `omarchy_core` is the Tauri-free machinery a standalone harness
// can compile and run against a real install (its header says why that matters on a machine
// with no Rust toolchain), `omarchy` is the command, the event and the thread.
#[cfg(feature = "local-engine")]
mod omarchy;
#[cfg(feature = "local-engine")]
mod omarchy_core;
mod updater;

fn main() {
    let mut builder = tauri::Builder::default();
    // The commands the window may call, registered in `engine.rs` so that this file names none
    // of them. With the feature off the line is not compiled and the builder is untouched.
    #[cfg(feature = "local-engine")]
    {
        builder = engine::attach(builder);
    }
    // The auto-updater: the two plugins and the handler for its menu item. Always
    // compiled — it ships in the published binary.
    builder = updater::attach(builder);
    // The menu bar, and the ONE `setup` that installs it. It goes on after the
    // updater because it names that module's item id; the order of the two calls
    // is otherwise immaterial, since `on_menu_event` appends and `setup` is only
    // used here. See `menu.rs` for why a second `setup` would be a silent bug.
    builder = menu::attach(builder);

    let app = builder
        .build(tauri::generate_context!())
        .expect("ohmail: failed to start the Tauri runtime");

    // HOST MODE IS DECIDED BEFORE THE ENGINE STARTS, because the decision is part of the spawn:
    // an armed install's engine gets three extra environment variables (`host.rs` carries the
    // whole design), and an engine's environment is fixed at its spawn. The log is opened first
    // — `open_log` is idempotent and `Shell::start` still opens it for the default path — so the
    // probe's outcome lands somewhere a person can read it.
    #[cfg(feature = "local-engine")]
    let host_boot = {
        engine::Shell::open_log(&app);
        host::HostBoot::detect(&engine::Shell::paths(&app))
    };
    #[cfg(feature = "local-engine")]
    let shell = std::sync::Arc::new(engine::Shell::start(&app, host_boot.spawn.clone()));
    #[cfg(feature = "local-engine")]
    engine::manage(&app, std::sync::Arc::clone(&shell));
    // The tray, the serve re-assertion, and the state the window reads — armed installs only;
    // a disarmed one gets a dormant struct and none of the machinery.
    #[cfg(feature = "local-engine")]
    let host_runtime = host::manage(&app, std::sync::Arc::clone(&shell), host_boot);

    // The Omarchy theme feed. On an Omarchy system this spawns the watch that re-skins the
    // window when the desktop theme changes; everywhere else it is one directory stat and a
    // return. It sits after the window's grant (`engine::manage`) so the first event can
    // never race the capability that lets the window hear it.
    #[cfg(feature = "local-engine")]
    omarchy::watch(app.handle().clone());

    // The one unrequested request this binary makes. Spawned, so nothing here waits on a feed.
    updater::on_launch(app.handle());

    app.run(move |_app, _event| {
        // The close/quit policy is `host::lifecycle_action` — ONE function, tested against the
        // contract that disarmed is exactly the behaviour above this feature existed: Destroyed
        // stops the engine, a close request passes through, Exit stops. Armed swaps the close
        // request for a hide (the tray is the way back) and leaves the engine's lifetime to the
        // app rather than to the window. This closure only maps events to that function and
        // performs what it says.
        #[cfg(feature = "local-engine")]
        {
            // macOS reopen — the dock or app icon of an already-running app. After an armed
            // close hid the window (and withdrew the dock icon), this activation is the OTHER
            // way back in beside the tray, and the only one left if the tray failed to build.
            // Showing an already-visible window is a no-op, so this needs no armed check.
            //
            // cfg'd to macOS because `RunEvent::Reopen` IS: tauri compiles the variant out of
            // the enum everywhere else, so an unguarded match arm is a compile error on
            // Windows and Linux — not a dead branch. The event cannot fire off macOS (no dock),
            // so the guard removes nothing those platforms ever had.
            #[cfg(target_os = "macos")]
            if matches!(&_event, tauri::RunEvent::Reopen { .. }) {
                host::show_main_window(_app);
            }
            let signal = match &_event {
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { .. },
                    ..
                } if label == "main" => Some(host::WindowSignal::MainCloseRequested),
                tauri::RunEvent::WindowEvent {
                    label, event: tauri::WindowEvent::Destroyed, ..
                } if label == "main" => Some(host::WindowSignal::MainDestroyed),
                tauri::RunEvent::Exit => Some(host::WindowSignal::Exit),
                _ => None,
            };
            if let Some(signal) = signal {
                match host::lifecycle_action(host_runtime.armed(), signal) {
                    host::LifecycleAction::StopEngine => shell.stop(),
                    host::LifecycleAction::HideInsteadOfClose => {
                        if let tauri::RunEvent::WindowEvent {
                            event: tauri::WindowEvent::CloseRequested { api, .. },
                            ..
                        } = &_event
                        {
                            api.prevent_close();
                        }
                        host::hide_main_window(_app);
                    }
                    host::LifecycleAction::Nothing => {}
                }
            }
        }
    });
}
