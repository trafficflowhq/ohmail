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
// `updater.rs` carries the reasoning; `attach`, `on_launch`, and in the engine build
// the launch's `apply_staged_at_launch` and the last event's `install_on_quit`, are
// the places it is hooked up.
//
// `on_launch` is the check that happens without being asked, once, shortly after
// the window opens. It says nothing at all unless it finds a newer release; the
// payload is fetched and verified, and with Settings' switch on (the default) it
// goes in at the next quit or launch, or now on Restart. An updater whose only
// trigger is a menu item is an updater nobody runs.
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

// The in-app preview's staged images and the scheme that serves them by token.
#[cfg(feature = "local-engine")]
mod attachment_preview;
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
// Every window stays on the app's own origin. Always compiled: every build opens windows, and
// `navigation::lock` is the one way any of them is built.
mod navigation;
// The Omarchy theme feed — on an Omarchy desktop the window follows the system theme live.
// Two modules on purpose: `omarchy_core` is the Tauri-free machinery a standalone harness
// can compile and run against a real install (its header says why that matters on a machine
// with no Rust toolchain), `omarchy` is the command, the event and the thread.
#[cfg(feature = "local-engine")]
mod omarchy;
#[cfg(feature = "local-engine")]
mod omarchy_core;
mod updater;
// The files the update flow writes: a release staged beside the AppImage, its record, and
// Settings' install policy. Always compiled: every build's AppImage press replaces by rename.
mod appimage_stage;
// WHAT THE RENDERER COSTS. `engine_vitals` measures the sidecar, which is the process that
// behaved correctly; the webview was never measured and that is where a 4.1 GB session went.
// Feature-gated with the engine because it
// writes to the engine's own log; Tauri-free otherwise, so its tests need no toolchain beyond
// cargo and it reads a fixture /proc tree rather than the real one.
#[cfg(feature = "local-engine")]
mod vitals;
// The generated half of the line above: the renderer ceiling `vitals.rs` reports against, written
// out of the one budget table rather than spelled here. Gated with `vitals`, its only reader.
#[cfg(feature = "local-engine")]
mod perf_budgets;
// The links on screen: what the new-window door may open besides the shell's own links. Gated with
// the engine: the plain build opens nothing.
#[cfg(feature = "local-engine")]
mod rendered_links;
// The gesture gate: each engine's new-window hook, which opens a link only on the person's own
// click or key press. Gated with the engine, like the door it feeds.
#[cfg(feature = "local-engine")]
mod link_gate;

// What WebKitGTK keeps for a window that shows one document. Always compiled: the published
// preview opens the same window and asks for the same budget.
mod webview_budget;

// How WebKitGTK hands frames to the window (shared memory, not DMA-BUF, on Hyprland). Always
// compiled; a no-op off Linux.
mod webkit_buffers;

#[cfg(target_os = "linux")]
mod gtk_text_dpi;

// Key listeners an accessibility client leaves mid-delivery are removed once GTK's delivery has
// returned. Always compiled: every Linux build runs GTK's accessibility bridge.
#[cfg(target_os = "linux")]
mod atk_key_listeners;

// The window opens hidden and is shown on its own canvas once the page has composed its first
// frame, or at a bound. Always compiled: every build opens the same hidden window.
mod launch_window;

// A web process that dies is reloaded once with a sentence, and a second death offers a relaunch
// instead of a dead frame. Always compiled: every build opens the same window.
mod renderer_recovery;

// How each web process ended, read without reaping it, and other code's stderr kept beside the log.
#[cfg(feature = "local-engine")]
mod last_words;

// What a restart hands the new copy: stdio, and none of the descriptors this launch was handed.
// Always compiled: both restarts, the update's and the renderer's relaunch, go through it.
mod inherited_fds;

// How many allocator arenas the engine this shell spawns may have. Applied to that child's
// command in `engine.rs`, never to this process — `allocator_arenas.rs` has the measurement.
mod allocator_arenas;

// Settings → Text size as the webview's zoom everywhere, and the text DPI pin held for the run on
// Linux. Always compiled: every build opens the same window (issue #14).
mod text_scale;

// A run that vanished (a GTK or WebKit crash) is logged on the next start. Always compiled.
mod unclean_exit;

// The window's CSP per platform, read through Tauri's own config merge: each overlay names its
// webview's one spelling of the command scheme, and the base stays closed.
#[cfg(test)]
#[path = "window_csp_tests.rs"]
mod window_csp_tests;

fn main() {
    // WHEN WEBKIT SHOULD GIVE MEMORY BACK. Process-global and read when the FIRST web context is
    // created, which wry does while the runtime is built — so it is set here, beside the arena
    // cap, and there is no window to apply it to yet. `webview_budget.rs` has the thresholds and
    // why the kill threshold is not among them.
    webview_budget::apply_process_pressure();
    // On Hyprland, frames reach the window through shared memory; read with the first web context.
    webkit_buffers::apply();

    // GTK applies the desktop's text scale to WebKit's whole canvas. Pin GTK's text DPI to its
    // 96-DPI baseline in both directions, but leave the monitor's scale alone. GTK is already up.
    #[cfg(target_os = "linux")]
    if gtk::is_initialized_main_thread() {
        use gtk::prelude::GtkSettingsExt;
        if let Some(settings) = gtk::Settings::default() {
            if let Some(dpi) = gtk_text_dpi::pinned_dpi(settings.gtk_xft_dpi()) {
                settings.set_gtk_xft_dpi(dpi);
            }
        }
        atk_key_listeners::guard();
    }

    let mut builder = tauri::Builder::default();
    // The pin above, held for the run: GTK re-reads the desktop's text scale live, and a change was
    // measured to shrink a running window. `text_scale.rs` re-applies the same policy on notify.
    text_scale::keep_text_dpi_pinned();
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
    // The preview's page has no command to report its first frame with, so its window is shown
    // when the document has loaded. The engine build registers the report with its commands.
    #[cfg(not(feature = "local-engine"))]
    {
        builder = launch_window::attach(builder);
    }

    let context = tauri::generate_context!();
    // Other code's stderr to `stderr.log` beside the log, before setup starts a web process. The
    // identifier is the context's: the Flatpak overlay changes it.
    #[cfg(feature = "local-engine")]
    last_words::install(&context.config().identifier);
    let app = builder
        .build(context)
        .expect("ohmail: failed to start the Tauri runtime");

    // HOST MODE IS DECIDED BEFORE THE ENGINE STARTS, because the decision is part of the spawn:
    // an armed install's engine gets three extra environment variables (`host.rs` carries the
    // whole design), and an engine's environment is fixed at its spawn. The log is opened first
    // — `open_log` is idempotent and `Shell::start` still opens it for the default path — so the
    // probe's outcome lands somewhere a person can read it.
    #[cfg(feature = "local-engine")]
    let (host_boot, launch_undone) = {
        engine::Shell::open_log(&app);
        // A release staged beside the AppImage that no quit installed goes in now, before the
        // engine or the window starts, and the app restarts into it.
        updater::apply_staged_at_launch(&app);
        let paths = engine::Shell::paths(&app);
        // A pairing the last run never settled puts its replaced door back before anything reads
        // it; what that undo took back is finished below, once the shell and host mode exist.
        let undone = engine::recover_door_switch(&paths);
        (host::HostBoot::detect(&paths), undone)
    };
    // After the build (a second instance has left) and the log's open: a marker the last run left
    // is one line, and this run's goes in its place.
    unclean_exit::arm(&app);
    #[cfg(target_os = "linux")]
    {
        let handle = app.handle().clone();
        unclean_exit::quit_on_session_end(move || updater::quit(&handle, 0));
    }
    #[cfg(feature = "local-engine")]
    let shell = std::sync::Arc::new(engine::Shell::start(&app, host_boot.plan()));
    #[cfg(feature = "local-engine")]
    shell.note_pairing_left(launch_undone.session_left_at.clone());
    #[cfg(feature = "local-engine")]
    engine::manage(&app, std::sync::Arc::clone(&shell));
    // The tray, the serve re-assertion, and the state the window reads — armed installs only;
    // a disarmed one gets a dormant struct and none of the machinery.
    #[cfg(feature = "local-engine")]
    let host_runtime = host::manage(&app, std::sync::Arc::clone(&shell), host_boot, &launch_undone);

    // The Omarchy theme feed. On an Omarchy system this spawns the watch that re-skins the
    // window when the desktop theme changes; everywhere else it is one directory stat and a
    // return. It sits after the window's grant (`engine::manage`) so the first event can
    // never race the capability that lets the window hear it.
    #[cfg(feature = "local-engine")]
    omarchy::watch(app.handle().clone());

    // The one unrequested request this binary makes. Spawned, so nothing here waits on a feed.
    updater::on_launch(app.handle());

    // The renderer's own vitals, every five minutes beside the engine's. It starts after the
    // window exists so the first pass can find the webview's processes, and it volunteers them
    // to the kernel's OOM killer: when this app is the heaviest thing on the machine, it should
    // be what gets reclaimed rather than whichever neighbour was most polite.
    #[cfg(feature = "local-engine")]
    vitals::start();

    #[cfg(feature = "local-engine")]
    let quitting = std::sync::Arc::clone(&shell);
    let on_event = move |_app: &tauri::AppHandle, _event: tauri::RunEvent| {
        // THE INSTALL FENCE, in every build (`updater.rs`): an exit this app did not ask for waits
        // for an install still writing, as a quit does, and the loop's last event lets no install
        // start under the exit.
        match &_event {
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                updater::on_exit_requested(_app, *code, api)
            }
            tauri::RunEvent::Exit => updater::at_exit(),
            _ => {}
        }
        // A clean exit; a restart's Exit comes before the new copy starts.
        if matches!(&_event, tauri::RunEvent::Exit) {
            unclean_exit::clear();
        }
        // The preview's staged files go with the app.
        #[cfg(feature = "local-engine")]
        if matches!(&_event, tauri::RunEvent::Exit) {
            use tauri::Manager;
            if let Some(previews) = _app.try_state::<attachment_preview::Previews>() {
                previews.release_all();
            }
        }
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
                    // NOBODY WAITS HERE, and that is the whole of it: this arm only makes sure
                    // the engine is on its way out. The waiting is below, after the loop.
                    host::LifecycleAction::StopEngine => {
                        shell.begin_stop(engine::Leaving::Quit);
                    }
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
                    // THE CLOSE PRESS ON AN INSTALL THAT IS NOT HOSTING, and the whole of the
                    // freeze: measured, the press reached `Destroyed`'s `stop()` in 11 ms and it
                    // returned 3 004 ms later with the window still on screen. The policy is
                    // unchanged — this still ends the app and still stops the engine — but the
                    // window goes first; `leave_then_exit` carries why the close has to be
                    // refused for a hide to take effect at all.
                    //
                    // WINDOWS AND LINUX ONLY, and that cfg is policy rather than a workaround:
                    // there, destroying the last window ends the app. On macOS a closed window is
                    // not a quit, so the close proceeds as before and `Destroyed` starts the same
                    // off-thread stop.
                    host::LifecycleAction::Nothing => {
                        #[cfg(not(target_os = "macos"))]
                        if signal == host::WindowSignal::MainCloseRequested {
                            if let tauri::RunEvent::WindowEvent {
                                event: tauri::WindowEvent::CloseRequested { api, .. },
                                ..
                            } = &_event
                            {
                                api.prevent_close();
                            }
                            // The hide is `leave_then_exit`'s: an install still writing keeps the
                            // window, saying so, until the install returns.
                            shell.leave_then_exit(_app, engine::SHUTDOWN_BOUND);
                        }
                    }
                }
            }
        }
        // A ready release goes in as the app goes, after the engine was told to leave above.
        #[cfg(feature = "local-engine")]
        if matches!(&_event, tauri::RunEvent::Exit) {
            updater::install_on_quit(_app);
        }
    };

    // THE ONE PLACE A QUIT IS ALLOWED TO WAIT, and it is after the loop rather than inside it.
    // `run_return` hands the loop's exit code back instead of ending the process itself, so the
    // engine can be waited for with no window on screen and no handler blocking the loop —
    // measured, waiting inside the callback keeps the window mapped for the whole wait, because a
    // run loop can flush neither its own hide nor its own destroy from inside a handler.
    // `leave_the_process` is in `engine.rs` rather than here because this file is compiled into
    // EVERY build, and what it does not contain is a property of the shipped binary.
    #[cfg(feature = "local-engine")]
    engine::leave_the_process(&quitting, app.run_return(on_event));
    // The preview has no engine and nothing to wait for, so its loop owns the exit as it always
    // has.
    #[cfg(not(feature = "local-engine"))]
    app.run(on_event);
}
