//! HOST MODE, held to its contract.
//!
//! Three invariants carry this module, and each has a test written by WATCHING it fail:
//!
//!  · **serve, never funnel** — every `tailscale` invocation this shell can compose is checked
//!    for the word that would publish somebody's mail to the public internet. Shown red by
//!    editing `serve_arm_args` to spell `funnel`, then restored.
//!  · **the spawn contract is three variables always, plus the assets path when the bundle
//!    packages a host client** — names, values, and the rule that a disarmed launch is
//!    BYTE-IDENTICAL to one from a build that predates host mode. Shown red by changing the
//!    armed value to "true" (the engine arms on "1" exactly), then restored.
//!  · **disarmed is today's lifecycle** — the decision table's disarmed column stops the engine
//!    on a destroyed window and touches nothing on a close request, which is the behaviour every
//!    install without the setting keeps. Shown red by making the disarmed Destroyed cell do
//!    nothing, then restored.

use super::*;
use std::cell::RefCell;
use std::collections::HashMap;

// ── The spawn contract ────────────────────────────────────────────────────────────────────────

fn env_map(pairs: &[(OsString, OsString)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
        .collect()
}

#[test]
fn the_armed_spawn_composes_exactly_three_variables_with_the_frozen_spellings() {
    // …when the bundle packages no host client. The assets pair is the ONE optional member of
    // the contract; the frozen three never move.
    let spawn =
        HostSpawn { port: 3311, origin: Some("https://mac.tail1234.ts.net".to_string()), lan: None, assets: None };
    let pairs = env_for(&spawn);
    assert_eq!(pairs.len(), 3);
    let env = env_map(&pairs);
    // "1" EXACTLY — the engine arms on that string and nothing else, so "true" here would be a
    // host mode that silently never turns on. Watch it fail: change the value in `env_for`.
    assert_eq!(env.get("OHMAIL_HOST_MODE").map(String::as_str), Some("1"));
    assert_eq!(env.get("OHMAIL_HOST_PORT").map(String::as_str), Some("3311"));
    assert_eq!(
        env.get("OHMAIL_HOST_ORIGIN").map(String::as_str),
        Some("https://mac.tail1234.ts.net")
    );
    assert!(env.get("OHMAIL_HOST_ASSETS").is_none());
}

#[test]
fn a_packaged_host_client_adds_the_assets_variable_and_only_that() {
    let spawn = HostSpawn {
        port: 3311,
        origin: Some("https://mac.tail1234.ts.net".to_string()),
        lan: None,
        assets: Some(PathBuf::from("/bundle/resources/host-client")),
    };
    let pairs = env_for(&spawn);
    assert_eq!(pairs.len(), 4);
    let env = env_map(&pairs);
    assert_eq!(
        env.get("OHMAIL_HOST_ASSETS").map(String::as_str),
        Some("/bundle/resources/host-client")
    );
    // The frozen three ride unchanged beside it.
    assert_eq!(env.get("OHMAIL_HOST_MODE").map(String::as_str), Some("1"));
    assert_eq!(env.get("OHMAIL_HOST_PORT").map(String::as_str), Some("3311"));
}

#[test]
fn the_packaged_host_client_is_found_by_its_index_and_absent_otherwise() {
    // A real directory, because the probe is a filesystem fact: resources with a host-client
    // holding index.html answer the dir; an empty host-client, or no resources, answer None —
    // the engine then serves API-only, which is the safe branch by construction.
    let resources = std::env::temp_dir().join(format!("ohmail-host-assets-{}", std::process::id()));
    let dir = resources.join("host-client");
    std::fs::create_dir_all(&dir).expect("mkdir");
    assert_eq!(packaged_host_client(Some(&resources)), None, "no index.html yet");
    std::fs::write(dir.join("index.html"), "<!doctype html>").expect("write");
    assert_eq!(packaged_host_client(Some(&resources)), Some(dir.clone()));
    assert_eq!(packaged_host_client(None), None);
    let _ = std::fs::remove_dir_all(&resources);
}

#[test]
fn the_origin_is_passed_through_verbatim_and_never_validated_here() {
    // The engine owns validation and degrades host mode over garbage with a logged reason; a
    // shell-side check would be a second copy of the engine's rules. So garbage crosses AS IS.
    let spawn = HostSpawn { port: 1, origin: Some("not a url at all".to_string()), lan: None, assets: None };
    let env = env_map(&env_for(&spawn));
    assert_eq!(env.get("OHMAIL_HOST_ORIGIN").map(String::as_str), Some("not a url at all"));
}

fn a_launch() -> engine::Launch {
    engine::Launch {
        program: std::path::PathBuf::from("/usr/bin/node"),
        args: vec![OsString::from("/apps/engine.mjs")],
        env: vec![(OsString::from("OHMAIL_DATA_DIR"), OsString::from("/data"))],
        unset: Vec::new(),
    }
}

fn a_spawn() -> HostSpawn {
    HostSpawn { port: 3311, origin: Some("https://mac.tail1234.ts.net".to_string()), lan: None, assets: None }
}

#[test]
fn a_disarmed_plan_is_byte_identical_whatever_the_door() {
    // The contract is EQUALITY, not "no host variables": a disarmed launch is the launch a build
    // without host mode composes, and any drift — an extra variable, a reordered one — fails here.
    for mode in [None, Some(config::Mode::Local), Some(config::Mode::Cloud)] {
        let plan = Plan::Spawn(a_launch());
        assert_eq!(extend_plan(plan.clone(), mode, None), plan);
    }
}

#[test]
fn an_armed_plan_grows_the_three_variables_on_the_local_door_only() {
    let spawn = a_spawn();
    let extended = extend_plan(Plan::Spawn(a_launch()), Some(config::Mode::Local), Some(&spawn));
    let Plan::Spawn(launch) = extended else { panic!("the plan stopped spawning") };
    assert_eq!(launch.env.len(), a_launch().env.len() + 3);
    let env = env_map(&launch.env);
    assert_eq!(env.get("OHMAIL_HOST_MODE").map(String::as_str), Some("1"));
    assert_eq!(env.get("OHMAIL_HOST_PORT").map(String::as_str), Some("3311"));
    // …and the launch it grew FROM is intact — program, args, the data directory.
    assert_eq!(launch.program, a_launch().program);
    assert_eq!(launch.args, a_launch().args);
}

#[test]
fn the_cloud_door_never_gets_a_host_door_even_armed() {
    // The cloud door mirrors a hosted account; an armed setting left over from the local door
    // must not follow the user through a door switch. Equality again: byte-identical.
    let spawn = a_spawn();
    let plan = Plan::Spawn(a_launch());
    assert_eq!(extend_plan(plan.clone(), Some(config::Mode::Cloud), Some(&spawn)), plan);
    // No stored door at all — the development env-fallback path — is also never extended.
    assert_eq!(extend_plan(plan.clone(), None, Some(&spawn)), plan);
}

#[test]
fn an_inert_plan_stays_inert() {
    let inert = Plan::Inert(EngineState::Stopped);
    assert_eq!(extend_plan(inert.clone(), Some(config::Mode::Local), Some(&a_spawn())), inert);
}

// ── The invocations: serve, never funnel ─────────────────────────────────────────────────────

#[test]
fn the_arm_invocation_is_serve_bg_https_443_onto_the_loopback_literal() {
    // EXACT equality — the invocation is the security boundary, so it is pinned character for
    // character rather than by properties alone.
    assert_eq!(
        serve_arm_args(3311),
        [
            "serve".to_string(),
            "--bg".to_string(),
            "--https=443".to_string(),
            "http://127.0.0.1:3311".to_string(),
        ]
    );
}

#[test]
fn the_disarm_invocation_is_the_clis_documented_off_switch() {
    assert_eq!(
        serve_disarm_args(),
        ["serve".to_string(), "--https=443".to_string(), "off".to_string()]
    );
    assert_eq!(status_args(), ["status", "--json"]);
}

#[test]
fn no_invocation_this_shell_can_compose_says_funnel() {
    // `tailscale funnel` publishes to the PUBLIC INTERNET — one word away from falsifying
    // "reachable only by your own devices". Every composable invocation is swept, and the sweep
    // was watched failing: spell `serve_arm_args`'s first element "funnel" and the assertion
    // names it.
    for port in [1u16, 443, 3311, 65535] {
        let all: Vec<String> = serve_arm_args(port)
            .into_iter()
            .chain(serve_disarm_args())
            .chain(status_args().iter().map(|s| s.to_string()))
            .collect();
        for word in &all {
            assert!(!word.contains("funnel"), "an invocation contains {word:?}");
        }
        assert!(all.iter().any(|w| w == "serve" || w == "status"));
    }
}

#[test]
fn the_published_target_is_loopback_and_carries_the_exact_port() {
    // The bind census, at the spawn config: what Tailscale proxies TO is the loopback literal
    // and nothing else — never 0.0.0.0, never a tailnet interface, never a hostname a resolver
    // could move.
    for port in [1u16, 8080, 65535] {
        let target = serve_arm_args(port)[3].clone();
        assert_eq!(target, format!("http://127.0.0.1:{port}"));
    }
}

// ── Finding the CLI ──────────────────────────────────────────────────────────────────────────

fn no_env(_: &str) -> Option<String> {
    None
}

fn fs_with(paths: &'static [&'static str]) -> impl Fn(&Path) -> Found {
    move |p: &Path| {
        if paths.iter().any(|q| Path::new(q) == p) {
            Found::Runnable
        } else {
            Found::Nothing
        }
    }
}

#[test]
fn an_operators_override_wins_over_every_packaged_location() {
    let get = |name: &str| (name == TAILSCALE_PATH_VAR).then(|| "/opt/ts/tailscale".to_string());
    let look = fs_with(&["/opt/ts/tailscale"]);
    assert_eq!(find_tailscale(&get, &look), Some(PathBuf::from("/opt/ts/tailscale")));
}

#[test]
fn the_platforms_usual_locations_are_probed_before_path() {
    // The FIRST platform location wins over a PATH entry, because on macOS the app-store install
    // puts the CLI inside the app bundle and on no PATH at all — a PATH-first probe would call a
    // working install absent.
    let first = TAILSCALE_LOCATIONS[0];
    let get = |name: &str| (name == "PATH").then(|| "/somewhere/bin".to_string());
    let both = move |p: &Path| {
        if p == Path::new(first) || p == Path::new("/somewhere/bin").join(tailscale_file_name()) {
            Found::Runnable
        } else {
            Found::Nothing
        }
    };
    assert_eq!(find_tailscale(&get, &both), Some(PathBuf::from(first)));
}

#[test]
fn path_is_the_fallback_and_nothing_found_is_none() {
    let get = |name: &str| (name == "PATH").then(|| "/somewhere/bin".to_string());
    let on_path = fs_with(&[]);
    assert_eq!(find_tailscale(&get, &on_path), None);
    let look = move |p: &Path| {
        if p == Path::new("/somewhere/bin").join(tailscale_file_name()) {
            Found::Runnable
        } else {
            Found::Nothing
        }
    };
    assert_eq!(
        find_tailscale(&get, &look),
        Some(Path::new("/somewhere/bin").join(tailscale_file_name()))
    );
    assert_eq!(find_tailscale(&no_env, &fs_with(&[])), None);
}

#[cfg(target_os = "macos")]
#[test]
fn the_first_macos_location_is_the_app_bundles_cli() {
    // The system-extension install registers NO path anywhere a shell looks; the CLI lives
    // inside the bundle. This being first is the difference between finding a normal install
    // and telling its owner to install what they already have.
    assert_eq!(TAILSCALE_LOCATIONS[0], "/Applications/Tailscale.app/Contents/MacOS/Tailscale");
}

// ── Reading the probe ────────────────────────────────────────────────────────────────────────

const STATUS_RUNNING: &str = r#"{
  "Version": "1.86.2-t1234",
  "BackendState": "Running",
  "Self": { "DNSName": "mac.tail1234.ts.net.", "Online": true }
}"#;

const STATUS_STOPPED: &str = r#"{ "Version": "1.86.2", "BackendState": "Stopped", "Self": { "DNSName": "" } }"#;

const STATUS_NEEDS_LOGIN: &str = r#"{ "Version": "1.86.2", "BackendState": "NeedsLogin" }"#;

const STATUS_NO_SELF: &str = r#"{ "Version": "1.86.2", "BackendState": "Running" }"#;

#[test]
fn a_running_tailnet_yields_its_magicdns_name_without_the_trailing_dot() {
    assert_eq!(
        parse_status(STATUS_RUNNING),
        Probe::Running { dns_name: "mac.tail1234.ts.net".to_string(), version: "1.86.2-t1234".to_string() }
    );
    assert_eq!(origin_for("mac.tail1234.ts.net."), "https://mac.tail1234.ts.net");
}

#[test]
fn every_other_backend_state_maps_to_its_guided_answer() {
    assert_eq!(parse_status(STATUS_STOPPED), Probe::NotRunning);
    assert_eq!(parse_status(STATUS_NEEDS_LOGIN), Probe::NotLoggedIn);
    assert_eq!(
        parse_status(r#"{ "BackendState": "NeedsMachineAuth" }"#),
        Probe::NotLoggedIn
    );
    // Running with no Self (or an empty name) is its own state: there is nothing to serve AS.
    assert_eq!(parse_status(STATUS_NO_SELF), Probe::NoDnsName { version: "1.86.2".to_string() });
    // Unreadable answers guide toward "start Tailscale" rather than pretending to know more.
    assert_eq!(parse_status("not json"), Probe::NotRunning);
    assert_eq!(parse_status(r#"{ "BackendState": "SomethingNew" }"#), Probe::NotRunning);
}

// ── The guided-state mapping, through an injected runner ─────────────────────────────────────

/// A runner as a script: each call pops the next answer and records the arguments it got.
struct FakeCli {
    calls: RefCell<Vec<Vec<String>>>,
    answer: Box<dyn Fn(&[String]) -> CliResult>,
}

impl FakeCli {
    fn answering(answer: impl Fn(&[String]) -> CliResult + 'static) -> FakeCli {
        FakeCli { calls: RefCell::new(Vec::new()), answer: Box::new(answer) }
    }
    fn run(&self, args: &[String]) -> CliResult {
        self.calls.borrow_mut().push(args.to_vec());
        (self.answer)(args)
    }
}

fn ran(code: i32, stdout: &str) -> CliResult {
    CliResult::Ran { code: Some(code), stdout: stdout.to_string() }
}

#[test]
fn a_missing_cli_is_no_cli_everywhere() {
    let cli = FakeCli::answering(|_| CliResult::Missing);
    assert_eq!(probe_with(&|args| cli.run(args)), Err(Problem::NoCli));
    assert_eq!(arm_serve_with(&|args| cli.run(args), 3311), Err(Problem::NoCli));
    assert_eq!(disarm_serve_with(&|args| cli.run(args)), Err(Problem::NoCli));
}

#[test]
fn a_daemon_that_does_not_answer_is_not_running() {
    // The CLI's own words for this case are "failed to connect to local tailscaled", on stderr;
    // the log gets them at the run site, this mapping sees only the exit.
    let cli = FakeCli::answering(|_| ran(1, ""));
    assert_eq!(probe_with(&|args| cli.run(args)), Err(Problem::NotRunning));
}

#[test]
fn the_probe_runs_status_json_and_yields_the_identity() {
    let cli = FakeCli::answering(|_| ran(0, STATUS_RUNNING));
    let identity = probe_with(&|args| cli.run(args)).expect("a running tailnet");
    assert_eq!(identity.origin, "https://mac.tail1234.ts.net");
    assert_eq!(identity.dns_name, "mac.tail1234.ts.net");
    assert_eq!(cli.calls.borrow().as_slice(), [vec!["status".to_string(), "--json".to_string()]]);
}

#[test]
fn signed_out_and_nameless_tailnets_are_their_own_guided_states() {
    let cli = FakeCli::answering(|_| ran(0, STATUS_NEEDS_LOGIN));
    assert_eq!(probe_with(&|args| cli.run(args)), Err(Problem::NotLoggedIn));
    let cli = FakeCli::answering(|_| ran(0, STATUS_NO_SELF));
    assert_eq!(probe_with(&|args| cli.run(args)), Err(Problem::NoDnsName));
}

#[test]
fn arming_runs_the_pinned_invocation_and_a_refusal_is_serve_refused() {
    let cli = FakeCli::answering(|_| ran(0, ""));
    assert_eq!(arm_serve_with(&|args| cli.run(args), 3311), Ok(()));
    assert_eq!(cli.calls.borrow().as_slice(), [serve_arm_args(3311).to_vec()]);

    // "CLI present but serve refused" is a FIRST-CLASS state: the daemon answered and said no —
    // an operator policy, an unsupported version — and the guidance for it is different from
    // both "not installed" and "not running". The refusal's text goes to the log, never here.
    let cli = FakeCli::answering(|_| ran(1, ""));
    assert_eq!(arm_serve_with(&|args| cli.run(args), 3311), Err(Problem::ServeRefused));
}

#[test]
fn port_zero_is_refused_before_anything_runs() {
    // The frozen contract says 1–65535: port 0 is "any free port", and a registration pointing
    // at a port the kernel picked is a registration pointing at nothing.
    let cli = FakeCli::answering(|_| ran(0, ""));
    assert_eq!(arm_serve_with(&|args| cli.run(args), 0), Err(Problem::ServeRefused));
    assert!(cli.calls.borrow().is_empty(), "port 0 reached the CLI");
}

#[test]
fn disarming_runs_the_pinned_off_switch() {
    let cli = FakeCli::answering(|_| ran(0, ""));
    assert_eq!(disarm_serve_with(&|args| cli.run(args)), Ok(()));
    assert_eq!(cli.calls.borrow().as_slice(), [serve_disarm_args().to_vec()]);
}

// ── The engine's listener signals, off its diagnostic lines ──────────────────────────────────

#[test]
fn the_four_listener_events_are_read_and_everything_else_is_not() {
    // The exact line shape the engine's logger emits: one JSON object, `event` naming what
    // happened, payload fields at the top level.
    let listening = r#"{"ts":"2026-08-18T10:00:00.000Z","level":"info","service":"sidecar","event":"host_listening","port":3311}"#;
    assert_eq!(signal_of_line(listening), Some(HostSignal::Listening { port: 3311 }));
    let skipped = r#"{"level":"info","service":"sidecar","event":"host_listener_skipped","reason":"armed with a port but no origin"}"#;
    assert_eq!(signal_of_line(skipped), Some(HostSignal::Skipped));
    let failed = r#"{"level":"error","service":"sidecar","event":"host_listen_failed","errorClass":"Error"}"#;
    assert_eq!(signal_of_line(failed), Some(HostSignal::Failed));
    let invalid = r#"{"level":"info","service":"sidecar","event":"host_config_invalid","reason":"port"}"#;
    assert_eq!(signal_of_line(invalid), Some(HostSignal::ConfigInvalid));

    // Everything else the engine says — including lines that merely mention the words — is not
    // a signal. A signal is an EVENT, not a substring.
    assert_eq!(signal_of_line(r#"{"event":"sync_complete","count":9}"#), None);
    assert_eq!(signal_of_line(r#"{"event":"send_failed","route":"/host_listening"}"#), None);
    assert_eq!(signal_of_line("plain prose mentioning host_listening"), None);
    // A listening claim without a usable port is refused rather than read as port 0.
    assert_eq!(signal_of_line(r#"{"event":"host_listening"}"#), None);
    assert_eq!(signal_of_line(r#"{"event":"host_listening","port":0}"#), None);
    assert_eq!(signal_of_line(r#"{"event":"host_listening","port":70000}"#), None);
}

// ── The lifecycle table ──────────────────────────────────────────────────────────────────────

#[test]
fn disarmed_is_todays_lifecycle_cell_for_cell() {
    // THE CONTRACT CELL: a destroyed main window stops the engine. This is the line every
    // install without host mode lives by, and the one an armed build must not change for them.
    // Watch it fail: make the disarmed Destroyed arm return Nothing.
    assert_eq!(
        lifecycle_action(false, WindowSignal::MainDestroyed),
        LifecycleAction::StopEngine
    );
    // A close request passes through untouched — no prevent, no hide — exactly as before this
    // module existed, when nothing listened for it at all.
    assert_eq!(lifecycle_action(false, WindowSignal::MainCloseRequested), LifecycleAction::Nothing);
    assert_eq!(lifecycle_action(false, WindowSignal::Exit), LifecycleAction::StopEngine);
}

#[test]
fn armed_hides_on_close_leaves_the_engine_on_destroy_and_still_reaps_on_exit() {
    assert_eq!(
        lifecycle_action(true, WindowSignal::MainCloseRequested),
        LifecycleAction::HideInsteadOfClose
    );
    // Armed, the engine's lifetime belongs to the app: a destroyed window (a platform path that
    // skirts the close request) must not take the phone's mail down with it.
    assert_eq!(lifecycle_action(true, WindowSignal::MainDestroyed), LifecycleAction::Nothing);
    // Quit reaps, armed or not. There is no cell in which Exit leaves an engine behind.
    assert_eq!(lifecycle_action(true, WindowSignal::Exit), LifecycleAction::StopEngine);
}

// ── The boot decision ────────────────────────────────────────────────────────────────────────

fn probe_ok() -> Result<TailnetIdentity, Problem> {
    Ok(TailnetIdentity {
        dns_name: "mac.tail1234.ts.net".to_string(),
        origin: "https://mac.tail1234.ts.net".to_string(),
        version: "1.86.2".to_string(),
    })
}

#[test]
fn no_setting_and_a_disabled_setting_both_boot_disarmed() {
    let boot = HostBoot::detect_with(None, Some(config::Mode::Local), &probe_ok, None);
    assert!(!boot.armed);
    assert!(boot.spawn.is_none() && boot.problem.is_none());
    let off = config::HostSettings { enabled: false, port: 3311, lan: None };
    let boot = HostBoot::detect_with(Some(off), Some(config::Mode::Local), &probe_ok, None);
    assert!(!boot.armed && boot.spawn.is_none());
}

#[test]
fn enabled_on_the_wrong_door_is_off_with_its_reason_and_probes_nothing() {
    let on = config::HostSettings { enabled: true, port: 3311, lan: None };
    let probe_must_not_run = || -> Result<TailnetIdentity, Problem> {
        panic!("the probe ran for a door that has no host mode")
    };
    for mode in [Some(config::Mode::Cloud), None] {
        let boot = HostBoot::detect_with(Some(on.clone()), mode, &probe_must_not_run, None);
        assert!(!boot.armed);
        assert_eq!(boot.problem, Some(Problem::LocalDoorRequired));
        assert!(boot.spawn.is_none());
    }
}

#[test]
fn enabled_on_the_local_door_arms_with_the_probed_origin() {
    let on = config::HostSettings { enabled: true, port: 3311, lan: None };
    let boot = HostBoot::detect_with(Some(on), Some(config::Mode::Local), &probe_ok, None);
    assert!(boot.armed);
    assert_eq!(
        boot.spawn,
        Some(HostSpawn { port: 3311, origin: Some("https://mac.tail1234.ts.net".to_string()), lan: None, assets: None })
    );
    assert_eq!(boot.problem, None);
}

#[test]
fn the_packaged_assets_ride_the_armed_spawn() {
    let on = config::HostSettings { enabled: true, port: 3311, lan: None };
    let assets = Some(PathBuf::from("/bundle/resources/host-client"));
    let boot =
        HostBoot::detect_with(Some(on), Some(config::Mode::Local), &probe_ok, assets.clone());
    assert_eq!(boot.spawn.expect("armed").assets, assets);
}

#[test]
fn a_failed_probe_arms_degraded_and_spawns_the_safe_branch() {
    // The user chose an always-on role, so the lifecycle and the tray follow the CHOICE — armed
    // — while the engine spawns WITHOUT the host variables, because a host door with no origin
    // to guard against is a door the engine would refuse anyway. The problem is what the tray
    // and the window report.
    let on = config::HostSettings { enabled: true, port: 3311, lan: None };
    let boot = HostBoot::detect_with(Some(on), Some(config::Mode::Local), &|| {
        Err(Problem::NotLoggedIn)
    }, None);
    assert!(boot.armed);
    assert!(boot.spawn.is_none());
    assert_eq!(boot.problem, Some(Problem::NotLoggedIn));
}

// ── The constants the guided states hang off ─────────────────────────────────────────────────

#[test]
fn the_download_page_is_the_vendors_and_the_wire_names_are_a_closed_vocabulary() {
    assert_eq!(TAILSCALE_DOWNLOAD_URL, "https://tailscale.com/download");
    // The wire spellings the window's union closes over. A rename here is a rename THERE.
    let names: Vec<&str> = [
        Problem::NoCli,
        Problem::NotRunning,
        Problem::NotLoggedIn,
        Problem::NoDnsName,
        Problem::ServeRefused,
        Problem::LocalDoorRequired,
        Problem::EngineNotServing,
        Problem::ListenerPending,
        Problem::ListenerSkipped,
        Problem::ListenerFailed,
        Problem::HostConfigInvalid,
    ]
    .iter()
    .map(|p| p.as_str())
    .collect();
    assert_eq!(
        names,
        [
            "no-cli",
            "not-running",
            "not-logged-in",
            "no-dns-name",
            "serve-refused",
            "local-door-required",
            "engine-not-serving",
            "listener-pending",
            "listener-skipped",
            "listener-failed",
            "host-config-invalid",
        ]
    );
}

// ── The publication order: no route until the engine holds the port ──────────────────────────

use std::cell::Cell;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

/// An armed runtime with no app behind it. The publication path under test reads the ENGINE
/// through an injected poll and the CLI through an injected runner, so the shell here is inert
/// scaffolding — only the generation, the lock and the flags are real.
fn armed_runtime() -> HostRuntime<tauri::Wry> {
    HostRuntime {
        shell: Arc::new(engine::Shell::inert_for_tests()),
        settings_path: None,
        armed: AtomicBool::new(true),
        generation: AtomicU64::new(0),
        published: AtomicBool::new(false),
        serve_ops: Mutex::new(()),
        port: Mutex::new(Some(3311)),
        origin: Mutex::new(None),
        lan: Mutex::new(None),
        problem: Mutex::new(None),
        tray: Mutex::new(None),
    }
}

fn listening(port: u16) -> ListenerPoll {
    ListenerPoll::Waiting(Some(HostSignal::Listening { port }))
}

#[test]
fn no_route_is_published_until_the_engine_holds_the_port() {
    // THE ORDER IS THE SECURITY PROPERTY. `tailscale serve` proxies onto the loopback port for
    // WHATEVER is listening there; published before the engine's bind, a route would expose an
    // unrelated loopback service to the whole tailnet — and keep exposing it after the engine's
    // bind then failed. So a failed listener must mean the runner was NEVER CALLED.
    //
    // Watched failing: reorder `publish_when_listening_with` to run serve before the await and
    // this test names the invocation that ran.
    let runtime = armed_runtime();
    let cli = FakeCli::answering(|_| ran(0, ""));
    let outcome = runtime.publish_when_listening_with(
        3311,
        0,
        3,
        Duration::ZERO,
        &|| ListenerPoll::Waiting(Some(HostSignal::Failed)),
        &|args| cli.run(args),
    );
    assert_eq!(outcome, Err(Problem::ListenerFailed));
    assert!(cli.calls.borrow().is_empty(), "a route was published for a listener that failed");
    assert!(!runtime.published.load(Ordering::SeqCst));
}

#[test]
fn a_publication_whose_generation_moved_publishes_nothing() {
    // The disarm race: a publication scheduled at launch (or by a slow arm) must lose to a
    // stand-down that happened while it waited — otherwise the shell reports host mode off
    // while Tailscale still proxies the port. The stand-down bumps the generation; a
    // publication carrying the old one runs NOTHING.
    let runtime = armed_runtime();
    runtime.generation.fetch_add(1, Ordering::SeqCst); // the stand-down happened
    let cli = FakeCli::answering(|_| ran(0, ""));
    let outcome = runtime.publish_when_listening_with(
        3311,
        0, // started under the old generation
        1,
        Duration::ZERO,
        &|| listening(3311),
        &|args| cli.run(args),
    );
    assert_eq!(outcome, Ok(false));
    assert!(cli.calls.borrow().is_empty(), "a stale publication ran the CLI");
    assert!(!runtime.published.load(Ordering::SeqCst));
}

#[test]
fn a_current_publication_runs_the_pinned_invocation_once_and_marks_published() {
    let runtime = armed_runtime();
    let cli = FakeCli::answering(|_| ran(0, ""));
    let outcome = runtime.publish_when_listening_with(
        3311,
        0,
        1,
        Duration::ZERO,
        &|| listening(3311),
        &|args| cli.run(args),
    );
    assert_eq!(outcome, Ok(true));
    assert_eq!(cli.calls.borrow().as_slice(), [serve_arm_args(3311).to_vec()]);
    assert!(runtime.published.load(Ordering::SeqCst));
}

#[test]
fn a_listener_on_a_different_port_never_publishes() {
    // Configuration drift: the engine announced a bind, on a port this arming did not ask for.
    // A route onto the asked-for port would proxy whatever else sits there.
    let runtime = armed_runtime();
    let cli = FakeCli::answering(|_| ran(0, ""));
    let outcome = runtime.publish_when_listening_with(
        3311,
        0,
        1,
        Duration::ZERO,
        &|| listening(4400),
        &|args| cli.run(args),
    );
    assert_eq!(outcome, Err(Problem::HostConfigInvalid));
    assert!(cli.calls.borrow().is_empty());
}

#[test]
fn a_serve_refusal_after_a_good_listener_is_typed_and_unpublished() {
    let runtime = armed_runtime();
    let cli = FakeCli::answering(|_| ran(1, ""));
    let outcome = runtime.publish_when_listening_with(
        3311,
        0,
        1,
        Duration::ZERO,
        &|| listening(3311),
        &|args| cli.run(args),
    );
    assert_eq!(outcome, Err(Problem::ServeRefused));
    assert!(!runtime.published.load(Ordering::SeqCst));
}

// ── Waiting on the listener ──────────────────────────────────────────────────────────────────

#[test]
fn the_wait_reads_every_signal_and_expiry_is_pending() {
    assert_eq!(await_listening_with(1, Duration::ZERO, &|| listening(3311)), Ok(3311));
    assert_eq!(
        await_listening_with(1, Duration::ZERO, &|| ListenerPoll::Waiting(Some(
            HostSignal::Skipped
        ))),
        Err(Problem::ListenerSkipped)
    );
    assert_eq!(
        await_listening_with(1, Duration::ZERO, &|| ListenerPoll::Waiting(Some(
            HostSignal::ConfigInvalid
        ))),
        Err(Problem::HostConfigInvalid)
    );
    assert_eq!(
        await_listening_with(1, Duration::ZERO, &|| ListenerPoll::EngineGone),
        Err(Problem::EngineNotServing)
    );
    // Nothing said within the budget is PENDING — armed, unpublished, safe — never a route.
    assert_eq!(
        await_listening_with(3, Duration::ZERO, &|| ListenerPoll::Waiting(None)),
        Err(Problem::ListenerPending)
    );
}

#[test]
fn a_listener_that_takes_a_few_polls_is_still_found() {
    let polls = Cell::new(0u32);
    let outcome = await_listening_with(5, Duration::ZERO, &|| {
        polls.set(polls.get() + 1);
        if polls.get() < 3 {
            ListenerPoll::Waiting(None)
        } else {
            listening(3311)
        }
    });
    assert_eq!(outcome, Ok(3311));
    assert_eq!(polls.get(), 3);
}

// ── The LAN fallback: the spawn's optional halves, the boot's no-Tailscale branch ────────────

#[test]
fn a_lan_only_spawn_composes_mode_port_and_lan_and_no_origin() {
    // The no-Tailscale path: the probe found nothing, the operator chose an interface. The
    // engine must NOT receive OHMAIL_HOST_ORIGIN (there is no served origin to allow-list) and
    // MUST receive the LAN address verbatim.
    let spawn = HostSpawn {
        port: 3311,
        origin: None,
        lan: Some("192.168.1.23".to_string()),
        assets: None,
    };
    let pairs = env_for(&spawn);
    assert_eq!(pairs.len(), 3);
    let env = env_map(&pairs);
    assert_eq!(env.get("OHMAIL_HOST_MODE").map(String::as_str), Some("1"));
    assert_eq!(env.get("OHMAIL_HOST_PORT").map(String::as_str), Some("3311"));
    assert_eq!(env.get("OHMAIL_LAN_BIND").map(String::as_str), Some("192.168.1.23"));
    assert!(env.get("OHMAIL_HOST_ORIGIN").is_none());
}

#[test]
fn a_tailnet_spawn_with_a_lan_choice_carries_both_doors() {
    let spawn = HostSpawn {
        port: 3311,
        origin: Some("https://mac.tail1234.ts.net".to_string()),
        lan: Some("10.0.0.7".to_string()),
        assets: None,
    };
    let env = env_map(&env_for(&spawn));
    assert_eq!(
        env.get("OHMAIL_HOST_ORIGIN").map(String::as_str),
        Some("https://mac.tail1234.ts.net")
    );
    assert_eq!(env.get("OHMAIL_LAN_BIND").map(String::as_str), Some("10.0.0.7"));
}

#[test]
fn a_failed_probe_with_a_lan_choice_still_spawns_the_lan_door_and_keeps_the_problem() {
    // The fallback's whole point: no Tailscale, same-network access anyway. Armed, the LAN-only spawn
    // exists — origin None, the chosen address riding — and the tailnet problem is REPORTED
    // rather than swallowed, because the user also asked for a tailnet half that is not serving.
    let on = config::HostSettings {
        enabled: true,
        port: 3311,
        lan: Some("192.168.1.23".to_string()),
    };
    let boot = HostBoot::detect_with(Some(on), Some(config::Mode::Local), &|| {
        Err(Problem::NoCli)
    }, None);
    assert!(boot.armed);
    assert_eq!(boot.problem, Some(Problem::NoCli));
    assert_eq!(boot.lan.as_deref(), Some("192.168.1.23"));
    assert_eq!(
        boot.spawn,
        Some(HostSpawn {
            port: 3311,
            origin: None,
            lan: Some("192.168.1.23".to_string()),
            assets: None,
        })
    );
}

#[test]
fn a_failed_probe_without_a_lan_choice_still_spawns_nothing() {
    // The pre-LAN contract, re-pinned beside its new sibling: with neither a tailnet identity
    // nor a LAN choice there is no door anybody could reach, so the safe branch spawns the
    // engine with no host variables at all.
    let on = config::HostSettings { enabled: true, port: 3311, lan: None };
    let boot = HostBoot::detect_with(Some(on), Some(config::Mode::Local), &|| {
        Err(Problem::NoCli)
    }, None);
    assert!(boot.armed && boot.spawn.is_none());
    assert_eq!(boot.problem, Some(Problem::NoCli));
}

#[test]
fn the_lan_choice_rides_a_healthy_tailnet_boot_too() {
    let on = config::HostSettings {
        enabled: true,
        port: 3311,
        lan: Some("10.0.0.7".to_string()),
    };
    let boot = HostBoot::detect_with(Some(on), Some(config::Mode::Local), &probe_ok, None);
    let spawn = boot.spawn.expect("armed");
    assert_eq!(spawn.origin.as_deref(), Some("https://mac.tail1234.ts.net"));
    assert_eq!(spawn.lan.as_deref(), Some("10.0.0.7"));
    assert_eq!(boot.problem, None);
}

// ── The LAN signal: its own slot, its own grammar ─────────────────────────────────────────────

#[test]
fn lan_signal_lines_parse_into_their_own_vocabulary() {
    assert_eq!(
        lan_signal_of_line(r#"{"event":"host_lan_listening","address":"192.168.1.23","port":3311}"#),
        Some(LanSignal::Listening { port: 3311 })
    );
    assert_eq!(
        lan_signal_of_line(r#"{"event":"host_lan_listen_failed"}"#),
        Some(LanSignal::Failed)
    );
    assert_eq!(
        lan_signal_of_line(r#"{"event":"host_lan_config_invalid"}"#),
        Some(LanSignal::ConfigInvalid)
    );
    assert_eq!(
        lan_signal_of_line(r#"{"event":"host_lan_skipped"}"#),
        Some(LanSignal::ConfigInvalid)
    );
    // Garbage ports and everything else stay None.
    assert_eq!(lan_signal_of_line(r#"{"event":"host_lan_listening","port":0}"#), None);
    assert_eq!(lan_signal_of_line(r#"{"event":"host_lan_firewall_blocked","port":0}"#), None);
    assert_eq!(lan_signal_of_line(r#"{"event":"host_listening","port":3311}"#), None);
    assert_eq!(lan_signal_of_line("plain text"), None);
}

/// THE BLOCKED ARM — bound, serving, and the machine's own firewall admitting nothing.
///
/// Without this arm the line parses to `None`, the slot keeps the `host_lan_listening` that
/// arrived a moment earlier, and the pane goes on saying "serving" over a door no phone can
/// reach — the exact overclaim the engine went to the trouble of detecting, folded back into a
/// flattering default. That is the same shape as `CredentialState::parse`'s `Unknown` mapping,
/// and it is why a new engine state is never only a TypeScript change.
#[test]
fn a_firewalled_lan_door_parses_as_blocked_and_is_still_a_listening_socket() {
    assert_eq!(
        lan_signal_of_line(r#"{"event":"host_lan_firewall_blocked","port":6245,"reason":"…"}"#),
        Some(LanSignal::Blocked { port: 6245 })
    );
    // It arrives AFTER the listening line and outranks it: the door is up either way, and this
    // one carries the fact the earlier line could not know.
    let listening = lan_signal_of_line(r#"{"event":"host_lan_listening","port":6245}"#);
    let blocked = lan_signal_of_line(r#"{"event":"host_lan_firewall_blocked","port":6245}"#);
    assert_eq!(listening, Some(LanSignal::Listening { port: 6245 }));
    assert_ne!(listening, blocked);
    // And it is NOT a bind failure. Nothing about the app went wrong.
    assert_ne!(blocked, Some(LanSignal::Failed));

    // THE TRAY'S QUESTION IS NOT THE SOCKET'S, and this calls the SHIPPED predicate.
    //
    // `lan_serves_network` gates the tray line "Serving your network only". A first draft widened
    // it to include `Blocked` on the reasoning that the door is genuinely up, which made the tray
    // claim service to a network that could not reach it.
    //
    // The first version of this assertion re-implemented the match here instead of calling the
    // real thing, and **widening the real thing left it green** — a guard that watched a copy of
    // itself. That is why the predicate is now a free function and why this line calls it.
    assert!(lan_serves_network(listening));
    assert!(
        !lan_serves_network(blocked),
        "a firewalled door must not read as serving a network"
    );
}

#[test]
fn the_two_signal_slots_never_read_each_others_lines() {
    // One launch can hold BOTH listeners, and the tailnet publication gates on the loopback
    // slot — a LAN line read into it would publish a route against the wrong evidence.
    let lan_line = r#"{"event":"host_lan_listening","address":"192.168.1.23","port":3311}"#;
    assert_eq!(signal_of_line(lan_line), None);
    let host_line = r#"{"event":"host_listening","port":3311}"#;
    assert_eq!(lan_signal_of_line(host_line), None);
    assert_eq!(signal_of_line(host_line), Some(HostSignal::Listening { port: 3311 }));
}

// ── The armed spawn's environment is EXACTLY the spawn's pairs — inherited values cleared ─────

#[test]
fn an_armed_spawn_unsets_every_host_variable_it_does_not_define() {
    // `Launch.env` OVERLAYS the shell's own inherited environment (engine.rs applies `unset`
    // first, then `env`), so a pair the spawn merely OMITS would otherwise be filled by a stale
    // value in the desktop's own environment — an inherited OHMAIL_LAN_BIND opening a LAN
    // listener the UI reports as off, or an inherited OHMAIL_HOST_ORIGIN steering a LAN-only
    // arming's request guard. The contract: an armed extension unsets ALL host variables, and
    // the ones the spawn defines come back through `env` (remove-first-then-set).
    let lan_only = HostSpawn {
        port: 3311,
        origin: None,
        lan: Some("192.168.1.23".to_string()),
        assets: None,
    };
    let extended = extend_plan(Plan::Spawn(a_launch()), Some(config::Mode::Local), Some(&lan_only));
    let Plan::Spawn(launch) = extended else { panic!("the plan stopped spawning") };
    for var in ["OHMAIL_HOST_MODE", "OHMAIL_HOST_PORT", "OHMAIL_HOST_ORIGIN", "OHMAIL_LAN_BIND", "OHMAIL_HOST_ASSETS"] {
        assert!(
            launch.unset.iter().any(|k| k == var),
            "{var} must be cleared from the inherited environment on an armed spawn"
        );
    }
    // The defined pairs still arrive — remove-first-then-set keeps the composed values.
    let env = env_map(&launch.env);
    assert_eq!(env.get("OHMAIL_LAN_BIND").map(String::as_str), Some("192.168.1.23"));
    assert!(env.get("OHMAIL_HOST_ORIGIN").is_none());
}
