//! HOST MODE — publish this install's mail engine to the user's OWN tailnet, and nothing wider.
//!
//! ── WHAT THIS MODULE IS, IN ONE PARAGRAPH ───────────────────────────────────────────────────
//!
//! With host mode on, the engine this shell already supervises opens a second door: a listener
//! bound to `127.0.0.1` and nothing else, which Tailscale publishes to the user's tailnet as
//! `https://<machine>.<tailnet>.ts.net` — TLS terminated by Tailscale with a real certificate,
//! reachable only from devices signed into the same tailnet. The mail never touches anyone's
//! servers: the phone talks to the laptop, over a network the user owns. This module is the
//! shell's half of that arrangement — the persisted setting, the environment the engine is
//! spawned with, the `tailscale` invocations, the tray icon and close-to-hide lifecycle, and the
//! start-at-login registration — and the ENGINE's half (the listener, its request guard, its
//! refusals) deliberately lives in the engine, which validates everything this module passes it.
//!
//! On top of that, the operator may OPT IN to SAME-NETWORK ACCESS: one chosen LAN interface
//! the engine also binds — plain HTTP, API-only (the secure-context ruling lives in the engine's
//! `host-lan.ts`), and the no-Tailscale path: with a LAN address chosen, host mode arms without
//! any tailnet, serves apps on the user's own network, and reports the tailnet half's absence
//! truthfully instead of refusing. This module's share is the persisted choice, one more spawn
//! variable ([`HOST_LAN_VAR`]), and the LAN door's own signal slot — never a `tailscale` call.
//!
//! ── THE INVARIANT THIS FILE IS PINNED TO ────────────────────────────────────────────────────
//!
//! **`tailscale serve`, never `tailscale funnel`.** Serve publishes to the user's own tailnet;
//! funnel publishes to the public internet, which would falsify "reachable only by your own
//! devices" in one word. The invocations are composed by [`serve_arm_args`] and
//! [`serve_disarm_args`] from constants, nothing else in this crate runs `tailscale`, and the
//! test suite holds the composed strings to "serve and never funnel" — a test written by watching
//! it fail against the funnel spelling, not by assuming it would. The published target is pinned
//! the same way: `http://127.0.0.1:<port>`, a loopback literal, so the only path onto the tailnet
//! is through Tailscale's own authentication.
//!
//! ── WHAT THE SHELL DECIDES AND WHAT IT DELIBERATELY DOES NOT ────────────────────────────────
//!
//! The shell decides WHETHER host mode is armed (a persisted setting the user chose), WHICH port
//! the engine binds, and WHAT origin Tailscale will serve — derived from `tailscale status`'s
//! MagicDNS name at each launch, because tailnet names change and a stored copy would go stale.
//! It validates NONE of those values beyond their shape here: the engine owns validation, refuses
//! garbage by degrading host mode with a logged reason, and keeps serving the window either way.
//! A shell that second-guessed the engine's rules would be a second copy of them, wrong first.
//!
//! ── LIFECYCLE: CLOSE HIDES ONLY WHEN THE USER ASKED FOR AN ALWAYS-ON ROLE ───────────────────
//!
//! Armed, the window's close button hides the app (tray icon, dock icon withdrawn on macOS)
//! because closing the window must not cut the phone off mid-read. Disarmed, closing the window
//! stops the engine and ends the app exactly as it always has — [`lifecycle_action`] is the whole
//! decision, written as a function so the disarmed column can be held to today's behaviour by a
//! test rather than by review. Quit — from the tray or the menu — always reaps the engine.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::config;
use crate::engine::{self, EngineState, Found, Plan, Shell};

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;

// ── The frozen spawn contract: three variables always, the assets path when packaged ────────

/// Arms the engine's host door. The engine reads the EXACT string "1" and nothing else — the
/// same absent-must-not-select-the-dangerous-branch rule the engine applies, spelled for an
/// environment where every value is a string.
pub const HOST_MODE_VAR: &str = "OHMAIL_HOST_MODE";

/// The loopback port the engine's host door binds — and the fixed target `tailscale serve`
/// proxies to. 1–65535; port 0 ("any free port") is refused at every entrance, because a
/// registration pointing at a port the kernel picked is a registration pointing at nothing.
pub const HOST_PORT_VAR: &str = "OHMAIL_HOST_PORT";

/// The origin Tailscale serves — `https://<machine>.<tailnet>.ts.net`, derived from
/// `tailscale status`'s own answer at launch. Passed through VERBATIM: the engine validates it,
/// and a garbage value degrades host mode over there with a logged reason rather than being
/// second-guessed here.
pub const HOST_ORIGIN_VAR: &str = "OHMAIL_HOST_ORIGIN";

/// The built browser client the engine's host door serves to a phone — the host-client dist,
/// packaged into the app bundle as the `host-client` resource (`tauri.engine.conf.json`) and
/// resolved from the bundle's own resource directory at each launch, the `OHMAIL_DATA_DIR`
/// idiom: a path the shell knows and the engine merely receives. Passed only when the packaged
/// directory actually holds an `index.html`; absent, the engine degrades the door to API-only
/// with a logged reason (`host_assets_missing`) — its rule, not re-implemented here.
pub const HOST_ASSETS_VAR: &str = "OHMAIL_HOST_ASSETS";

/// The LAN interface address the engine ALSO binds — same-network access without Tailscale
/// The operator's explicit choice, persisted in `host.json` and passed VERBATIM: the
/// engine validates it (`resolveLanBind`) and a garbage value degrades the LAN half alone with
/// a logged reason (`host_lan_config_invalid`). The engine's LAN door is API-only by ruling —
/// a plain-http network origin is no secure context for the browser client — and it serves an
/// honest explainer to any browser that lands there.
pub const HOST_LAN_VAR: &str = "OHMAIL_LAN_BIND";

/// The values one armed spawn composes. Derived fresh each launch, never stored whole —
/// the PORT is the persisted setting, the ORIGIN is whatever the tailnet says today (`None`
/// when the tailnet had nothing to say and the LAN choice is what keeps host mode useful),
/// the LAN address is the persisted operator choice, and the ASSETS path is wherever this
/// launch's bundle keeps its packaged host-client (None on a build that packages none — the
/// engine then serves its API alone). At least one of `origin`/`lan` is always `Some`:
/// [`HostBoot::detect_with`] composes no spawn otherwise, because an armed engine with neither
/// a served origin nor a LAN address has no door anybody could reach.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostSpawn {
    pub port: u16,
    pub origin: Option<String>,
    pub lan: Option<String>,
    pub assets: Option<PathBuf>,
}

/// The environment pairs, exactly — the whole of what an armed spawn adds. The mode and port
/// always; the origin iff the tailnet probe found one; the LAN address iff the operator chose
/// one; the assets pair iff this bundle packages a host client.
pub fn env_for(spawn: &HostSpawn) -> Vec<(OsString, OsString)> {
    let mut pairs = vec![
        (OsString::from(HOST_MODE_VAR), OsString::from("1")),
        (OsString::from(HOST_PORT_VAR), OsString::from(spawn.port.to_string())),
    ];
    if let Some(origin) = &spawn.origin {
        pairs.push((OsString::from(HOST_ORIGIN_VAR), OsString::from(origin.clone())));
    }
    if let Some(lan) = &spawn.lan {
        pairs.push((OsString::from(HOST_LAN_VAR), OsString::from(lan.clone())));
    }
    if let Some(assets) = &spawn.assets {
        pairs.push((OsString::from(HOST_ASSETS_VAR), OsString::from(assets.as_os_str())));
    }
    pairs
}

/// The packaged host-client, or `None` when this bundle carries none (the preview, a dev run).
/// `index.html` is the probe because it is the one file the engine's static handler cannot serve
/// without — the same test it applies on its own side before serving anything.
pub fn packaged_host_client(resources: Option<&Path>) -> Option<PathBuf> {
    let dir = resources?.join("host-client");
    dir.join("index.html").is_file().then_some(dir)
}

/// Add the host variables to a plan that is about to spawn — or leave it BYTE-IDENTICAL.
///
/// The dangerous branch requires all three of: a plan that spawns, the LOCAL door, and an armed
/// spawn in hand. Anything else returns the plan exactly as it arrived — asserted by equality in
/// the tests, because "disarmed is today's launch" is a contract, not a tendency. The cloud door
/// is excluded by name: it mirrors a hosted account, has no host door, and an armed setting left
/// over from the local door must not follow the user through a door switch.
pub fn extend_plan(mut plan: Plan, mode: Option<config::Mode>, spawn: Option<&HostSpawn>) -> Plan {
    if let (Plan::Spawn(launch), Some(config::Mode::Local), Some(spawn)) = (&mut plan, mode, spawn)
    {
        launch.env.extend(env_for(spawn));
    }
    plan
}

// ── The tailscale invocations, composed from constants and from nothing else ────────────────

/// The tailnet-facing port Tailscale serves on. 443, so the phone's browser needs no port in the
/// address and gets an ordinary secure origin.
pub const TAILSCALE_PUBLIC_PORT: u16 = 443;

/// Publish the engine's loopback door to the tailnet: `serve --bg --https=443 http://127.0.0.1:<port>`.
///
/// `--bg` makes the registration persistent in the Tailscale daemon rather than tied to a
/// foreground process, which is the shape an always-on role needs. The target is a LOOPBACK
/// LITERAL — the engine binds nothing else, and this invocation must agree with it.
pub fn serve_arm_args(port: u16) -> [String; 4] {
    [
        "serve".to_string(),
        "--bg".to_string(),
        format!("--https={TAILSCALE_PUBLIC_PORT}"),
        format!("http://127.0.0.1:{port}"),
    ]
}

/// Withdraw the registration: `serve --https=443 off` — the CLI's own documented off-switch
/// ("To disable the proxy, run: tailscale serve --https=443 off").
pub fn serve_disarm_args() -> [String; 3] {
    ["serve".to_string(), format!("--https={TAILSCALE_PUBLIC_PORT}"), "off".to_string()]
}

/// The probe: `status --json`, whose answer carries the backend state and this machine's
/// MagicDNS name.
pub fn status_args() -> [&'static str; 2] {
    ["status", "--json"]
}

/// Where a machine without Tailscale is sent — the vendor's own download page, opened in the
/// user's browser through the same opener every external link goes through. A constant, so the
/// window names an intent and never an address.
pub const TAILSCALE_DOWNLOAD_URL: &str = "https://tailscale.com/download";

// ── Finding the CLI ──────────────────────────────────────────────────────────────────────────

/// An operator's exact override, symmetrical with the engine's own `OHMAIL_NODE`.
pub const TAILSCALE_PATH_VAR: &str = "OHMAIL_TAILSCALE";

/// Where the CLI usually is, most specific first — then `PATH`, in [`find_tailscale`].
///
/// On macOS the app-store/system-extension install does NOT put `tailscale` on anybody's `PATH`;
/// the CLI lives inside the app bundle, which is why that path is first and why a bare `PATH`
/// probe would call a working install absent. The Homebrew locations follow for the CLI-only
/// install. Windows installs to Program Files; Linux packages put it on the ordinary bin dirs.
#[cfg(target_os = "macos")]
const TAILSCALE_LOCATIONS: &[&str] = &[
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
];
#[cfg(target_os = "windows")]
const TAILSCALE_LOCATIONS: &[&str] = &[r"C:\Program Files\Tailscale\tailscale.exe"];
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const TAILSCALE_LOCATIONS: &[&str] = &["/usr/bin/tailscale", "/usr/sbin/tailscale"];

/// `tailscale` on Unix, `tailscale.exe` on Windows — for the `PATH` fallback only.
fn tailscale_file_name() -> &'static str {
    if cfg!(windows) {
        "tailscale.exe"
    } else {
        "tailscale"
    }
}

/// The Tailscale CLI, or `None` when this machine has none. The same shape as the engine's
/// runtime resolution and injectable for the same reason: every branch is reachable from a test
/// without an installed Tailscale.
pub fn find_tailscale(
    get: &dyn Fn(&str) -> Option<String>,
    look: &dyn Fn(&Path) -> Found,
) -> Option<PathBuf> {
    let consider =
        |path: PathBuf| -> Option<PathBuf> { (look(&path) == Found::Runnable).then_some(path) };

    if let Some(explicit) = get(TAILSCALE_PATH_VAR).filter(|v| !v.trim().is_empty()) {
        if let Some(found) = consider(PathBuf::from(explicit)) {
            return Some(found);
        }
    }
    for candidate in TAILSCALE_LOCATIONS {
        if let Some(found) = consider(PathBuf::from(candidate)) {
            return Some(found);
        }
    }
    let separator = if cfg!(windows) { ';' } else { ':' };
    for dir in get("PATH").unwrap_or_default().split(separator) {
        if dir.trim().is_empty() {
            continue;
        }
        if let Some(found) = consider(Path::new(dir).join(tailscale_file_name())) {
            return Some(found);
        }
    }
    None
}

// ── Running it, and reading what it said ─────────────────────────────────────────────────────

/// One run of the CLI, or the fact that there was no CLI to run.
///
/// Deliberately NO stderr field: a refusal's own words go to the log at the one place the real
/// CLI runs ([`run_tailscale`]), and everything downstream maps exit codes to TYPED states — so
/// there is no path on which a stderr dump could reach the window, by construction.
pub enum CliResult {
    /// No binary anywhere this module looks. The guided answer is "install Tailscale".
    Missing,
    Ran {
        /// `None` when a signal ended it (Unix).
        code: Option<i32>,
        stdout: String,
    },
}

/// Run the real CLI. Everything above this function takes the runner as a parameter so the
/// guided-state mapping is provable without an installed Tailscale; this is the one
/// implementation the shipped shell passes.
///
/// No timeout, stated rather than hidden: `tailscale status`/`serve` answer against a local
/// daemon in milliseconds or fail fast when it is down. A wedged daemon that accepts the
/// connection and never answers would hold the calling command — a residual accepted here and
/// covered by the live rehearsal rather than by a watchdog thread over one subprocess.
fn run_tailscale(args: &[String]) -> CliResult {
    let get = |name: &str| std::env::var(name).ok();
    let Some(cli) = find_tailscale(&get, &engine::look) else {
        return CliResult::Missing;
    };
    let mut command = std::process::Command::new(&cli);
    // No console window behind the CLI on Windows — the same flag, for the same reason, as the
    // engine spawn: this is a GUI process and the child would otherwise get a console allocated.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    match command.args(args).output() {
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // A refusal's own words go to the LOG, where somebody debugging can read them; the
            // window only ever gets the typed state the callers map this result to.
            if !output.status.success() {
                let first = stderr.lines().next().unwrap_or("").trim();
                engine::log_line(format_args!(
                    "tailscale {} exited with {:?}{}{}",
                    args.first().map(String::as_str).unwrap_or(""),
                    output.status.code(),
                    if first.is_empty() { "" } else { ": " },
                    first
                ));
            }
            CliResult::Ran {
                code: output.status.code(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            }
        }
        // A binary that vanished between the look and the exec is the same guided answer as no
        // binary at all.
        Err(_) => CliResult::Missing,
    }
}

/// What the probe learned, reduced to the decisions this shell makes from it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Probe {
    Running { dns_name: String, version: String },
    /// The backend runs but announced no MagicDNS name — MagicDNS off, or a tailnet mid-setup.
    /// There is nothing to serve an origin AS, so host mode cannot arm.
    NoDnsName { version: String },
    NotLoggedIn,
    NotRunning,
}

/// Read `tailscale status --json`. `BackendState` and `Self.DNSName` are the two facts used;
/// everything unrecognisable maps to [`Probe::NotRunning`], which guides toward "start
/// Tailscale" — the honest default for an answer this shell cannot read.
pub fn parse_status(raw: &str) -> Probe {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Probe::NotRunning;
    };
    let version = parsed
        .get("Version")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    match parsed.get("BackendState").and_then(serde_json::Value::as_str) {
        Some("Running") => {
            let dns_name = parsed
                .get("Self")
                .and_then(|s| s.get("DNSName"))
                .and_then(serde_json::Value::as_str)
                .map(|name| name.trim().trim_end_matches('.').to_string())
                .unwrap_or_default();
            if dns_name.is_empty() {
                Probe::NoDnsName { version }
            } else {
                Probe::Running { dns_name, version }
            }
        }
        // Both are "signed out" to the person fixing it: log in (or approve the machine) in the
        // Tailscale app.
        Some("NeedsLogin") | Some("NeedsMachineAuth") => Probe::NotLoggedIn,
        // Stopped, Starting, NoState, or a state this build has never heard of.
        _ => Probe::NotRunning,
    }
}

/// The served origin for a MagicDNS name. `https` and nothing else: Tailscale terminates TLS
/// with a real certificate for exactly this name, so the phone gets a secure browser context.
pub fn origin_for(dns_name: &str) -> String {
    format!("https://{}", dns_name.trim().trim_end_matches('.'))
}

// ── The guided states: every way this can be not-working, each with a NAME ──────────────────

/// Why host mode is off or degraded — a closed vocabulary the window maps to guidance, never a
/// stderr dump. Every CLI failure and every engine-side signal reduces to one of these.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Problem {
    /// No Tailscale CLI on this machine. Guide: install it (see [`TAILSCALE_DOWNLOAD_URL`]).
    NoCli,
    /// The CLI is there and its daemon is not running (or answered unreadably). Guide: start it.
    NotRunning,
    /// Running and signed out (or awaiting machine approval). Guide: sign in.
    NotLoggedIn,
    /// Running with no MagicDNS name to serve as. Guide: enable MagicDNS on the tailnet.
    NoDnsName,
    /// The CLI is present, the daemon answered, and `serve` still refused — a first-class state
    /// of its own, because "installed and refusing" needs different words from "not installed".
    /// The refusal's own text goes to the log; the window gets this name.
    ServeRefused,
    /// Host mode is enabled in settings while this install is not on the local door. The cloud
    /// door mirrors a hosted account and has no host door to publish.
    LocalDoorRequired,
    /// Armed, and the engine is not serving — starting, restarting, or down.
    EngineNotServing,
    /// Armed and serving, and the engine has not yet said whether its host door bound. The
    /// listener starts moments after the ready announcement, so this is the transient state.
    ListenerPending,
    /// The engine said it skipped its host listener (armed without both knobs).
    ListenerSkipped,
    /// The engine said the listener could not bind — the port is taken, or the kernel refused.
    ListenerFailed,
    /// The engine refused the host configuration it was handed and degraded host-off.
    HostConfigInvalid,
}

impl Problem {
    /// The wire spelling the window reads. A closed union on that side too.
    pub fn as_str(self) -> &'static str {
        match self {
            Problem::NoCli => "no-cli",
            Problem::NotRunning => "not-running",
            Problem::NotLoggedIn => "not-logged-in",
            Problem::NoDnsName => "no-dns-name",
            Problem::ServeRefused => "serve-refused",
            Problem::LocalDoorRequired => "local-door-required",
            Problem::EngineNotServing => "engine-not-serving",
            Problem::ListenerPending => "listener-pending",
            Problem::ListenerSkipped => "listener-skipped",
            Problem::ListenerFailed => "listener-failed",
            Problem::HostConfigInvalid => "host-config-invalid",
        }
    }
}

/// This machine's tailnet identity, when the probe finds one worth serving as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TailnetIdentity {
    pub dns_name: String,
    pub origin: String,
    pub version: String,
}

/// Probe the tailnet through an injected runner. Every failure is a [`Problem`].
pub fn probe_with(run: &dyn Fn(&[String]) -> CliResult) -> Result<TailnetIdentity, Problem> {
    let args: Vec<String> = status_args().iter().map(|s| s.to_string()).collect();
    match run(&args) {
        CliResult::Missing => Err(Problem::NoCli),
        CliResult::Ran { code: Some(0), stdout, .. } => match parse_status(&stdout) {
            Probe::Running { dns_name, version } => {
                let origin = origin_for(&dns_name);
                Ok(TailnetIdentity { dns_name, origin, version })
            }
            Probe::NoDnsName { .. } => Err(Problem::NoDnsName),
            Probe::NotLoggedIn => Err(Problem::NotLoggedIn),
            _ => Err(Problem::NotRunning),
        },
        // A non-zero `status` is the daemon not answering — the CLI's own "failed to connect to
        // local tailscaled" case. The stderr goes to the caller's log, never to the window.
        CliResult::Ran { .. } => Err(Problem::NotRunning),
    }
}

/// Publish the loopback door through an injected runner. Port 0 is refused HERE as well as at
/// the command that takes it from the window — the frozen contract says 1–65535 and a second
/// gate on a constant-composed invocation is cheap.
pub fn arm_serve_with(
    run: &dyn Fn(&[String]) -> CliResult,
    port: u16,
) -> Result<(), Problem> {
    if port == 0 {
        return Err(Problem::ServeRefused);
    }
    match run(&serve_arm_args(port)) {
        CliResult::Missing => Err(Problem::NoCli),
        CliResult::Ran { code: Some(0), .. } => Ok(()),
        CliResult::Ran { .. } => Err(Problem::ServeRefused),
    }
}

/// Withdraw the registration through an injected runner.
pub fn disarm_serve_with(run: &dyn Fn(&[String]) -> CliResult) -> Result<(), Problem> {
    match run(&serve_disarm_args()) {
        CliResult::Missing => Err(Problem::NoCli),
        CliResult::Ran { code: Some(0), .. } => Ok(()),
        CliResult::Ran { .. } => Err(Problem::ServeRefused),
    }
}

// ── The publication order: the engine holds the port FIRST, the tailnet route comes LAST ─────
//
// `tailscale serve` proxies the tailnet onto `127.0.0.1:<port>` for WHATEVER is listening there.
// Run before the engine's own listener holds that port, the route would briefly — or, after a
// bind failure, indefinitely — expose some unrelated loopback service to every tailnet device.
// So no publication happens until the engine has SAID `host_listening` on the exact port, and
// every publication carries the arming generation it was started under, so a disarm that
// happened in between wins.

/// What one look at the engine tells a waiting publication.
pub enum ListenerPoll {
    /// The engine is down for good this run — stopped, failed, never configured. Nothing to wait
    /// for.
    EngineGone,
    /// Still alive; the engine's host signal so far, if any. `None` while it boots.
    Waiting(Option<HostSignal>),
}

/// How long a publication waits for the engine's listener: 150 × 200ms = 30 seconds, which is a
/// cold local-store boot with room to spare. Expiring reads as listener-pending — armed,
/// unpublished, and safe — never as a route.
const LISTENER_WAIT_TRIES: u32 = 150;
const LISTENER_WAIT_STEP: std::time::Duration = std::time::Duration::from_millis(200);

/// Wait until the engine's host listener holds a port, or say why it never will. Injectable so
/// every branch is a test, with `wait` at zero.
pub fn await_listening_with(
    tries: u32,
    wait: std::time::Duration,
    poll: &dyn Fn() -> ListenerPoll,
) -> Result<u16, Problem> {
    for attempt in 0..tries {
        match poll() {
            ListenerPoll::EngineGone => return Err(Problem::EngineNotServing),
            ListenerPoll::Waiting(Some(HostSignal::Listening { port })) => return Ok(port),
            ListenerPoll::Waiting(Some(HostSignal::Skipped)) => {
                return Err(Problem::ListenerSkipped)
            }
            ListenerPoll::Waiting(Some(HostSignal::Failed)) => return Err(Problem::ListenerFailed),
            ListenerPoll::Waiting(Some(HostSignal::ConfigInvalid)) => {
                return Err(Problem::HostConfigInvalid)
            }
            ListenerPoll::Waiting(None) => {
                if attempt + 1 < tries {
                    std::thread::sleep(wait);
                }
            }
        }
    }
    Err(Problem::ListenerPending)
}

impl<R: tauri::Runtime> HostRuntime<R> {
    /// Publish the tailnet route — after the listener, under the serve lock, gated on the
    /// generation. `Ok(true)` published; `Ok(false)` the world moved (a disarm or a re-arm won)
    /// and NOTHING ran; `Err` names why the listener never held the port or why serve refused.
    ///
    /// Injectable poll and runner, because the order in here IS the security property: the test
    /// that drives a failed listener through this function asserts the runner was never called,
    /// and was watched go red against the reversed order.
    fn publish_when_listening_with(
        &self,
        port: u16,
        generation: u64,
        tries: u32,
        wait: std::time::Duration,
        poll: &dyn Fn() -> ListenerPoll,
        run: &dyn Fn(&[String]) -> CliResult,
    ) -> Result<bool, Problem> {
        let bound = await_listening_with(tries, wait, poll)?;
        if bound != port {
            // The engine bound a different port than this arming asked for — configuration
            // drift, and a route onto it would proxy the wrong thing.
            return Err(Problem::HostConfigInvalid);
        }
        let _serialized = self.serve_ops.lock().expect("serve ops");
        if self.generation.load(Ordering::SeqCst) != generation {
            return Ok(false);
        }
        arm_serve_with(run, port)?;
        self.published.store(true, Ordering::SeqCst);
        Ok(true)
    }

    /// The shipped publication: the real engine as the poll, the real CLI as the runner.
    fn publish_when_listening(&self, port: u16, generation: u64) -> Result<bool, Problem> {
        let poll = || {
            let engine = self.shell.engine();
            match engine.state() {
                // Terminal for this run's listener. Starting/Restarting keep waiting — the
                // signal is per-run and a healthy restart will announce again.
                EngineState::Stopped
                | EngineState::Failed { .. }
                | EngineState::Absent { .. }
                | EngineState::NotConfigured { .. }
                | EngineState::NoKey { .. } => ListenerPoll::EngineGone,
                _ => ListenerPoll::Waiting(engine.host_signal()),
            }
        };
        self.publish_when_listening_with(
            port,
            generation,
            LISTENER_WAIT_TRIES,
            LISTENER_WAIT_STEP,
            &poll,
            &|args| run_tailscale(args),
        )
    }
}

// ── What the engine says about its host door, read off its diagnostics ──────────────────────

/// The engine's own account of its host listener, read from the diagnostic lines it already
/// writes: one JSON object per line, an `event` field naming what happened. The shell forwards
/// every line to the log unchanged; this is the one vocabulary it ALSO acts on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostSignal {
    Listening { port: u16 },
    Skipped,
    Failed,
    ConfigInvalid,
}

/// The host signal one diagnostic line carries, or `None` for every other line the engine says.
///
/// Held to the line's own grammar: a JSON object whose `event` is one of the four names. The
/// cheap substring test in front is so the megabytes of ordinary diagnostics never pay for a
/// JSON parse. The LAN door's `host_lan_*` events are deliberately NOT in this vocabulary —
/// they are a separate slot ([`lan_signal_of_line`]), because one launch can carry both and a
/// later LAN line must not overwrite what the loopback listener said.
pub fn signal_of_line(line: &str) -> Option<HostSignal> {
    if !line.contains("host_") {
        return None;
    }
    let parsed = serde_json::from_str::<serde_json::Value>(line).ok()?;
    match parsed.get("event").and_then(serde_json::Value::as_str) {
        Some("host_listening") => {
            let port = parsed.get("port").and_then(serde_json::Value::as_u64)?;
            if port == 0 || port > u16::MAX as u64 {
                return None;
            }
            Some(HostSignal::Listening { port: port as u16 })
        }
        Some("host_listener_skipped") => Some(HostSignal::Skipped),
        Some("host_listen_failed") => Some(HostSignal::Failed),
        Some("host_config_invalid") => Some(HostSignal::ConfigInvalid),
        _ => None,
    }
}

/// The engine's own account of its LAN door — `host_lan_listening`, `host_lan_listen_failed`,
/// `host_lan_config_invalid` — read off the same diagnostic stream, into its own slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LanSignal {
    Listening { port: u16 },
    Failed,
    ConfigInvalid,
}

/// The LAN signal one diagnostic line carries, or `None` for every other line.
pub fn lan_signal_of_line(line: &str) -> Option<LanSignal> {
    if !line.contains("host_lan_") {
        return None;
    }
    let parsed = serde_json::from_str::<serde_json::Value>(line).ok()?;
    match parsed.get("event").and_then(serde_json::Value::as_str) {
        Some("host_lan_listening") => {
            let port = parsed.get("port").and_then(serde_json::Value::as_u64)?;
            if port == 0 || port > u16::MAX as u64 {
                return None;
            }
            Some(LanSignal::Listening { port: port as u16 })
        }
        Some("host_lan_listen_failed") => Some(LanSignal::Failed),
        // A skip (armed with an address but no port) cannot happen from this shell's own spawn —
        // it always passes both — but a state the engine can say needs a reading here, and "a
        // knob is missing" is a configuration fact, not a bind failure.
        Some("host_lan_skipped") | Some("host_lan_config_invalid") => Some(LanSignal::ConfigInvalid),
        _ => None,
    }
}

// ── The lifecycle decision, as a function a test can hold to the contract ───────────────────

/// The three window-and-app events the decision is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowSignal {
    MainCloseRequested,
    MainDestroyed,
    Exit,
}

/// What the shell does about one of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LifecycleAction {
    StopEngine,
    HideInsteadOfClose,
    Nothing,
}

/// The whole close/quit policy, in one place.
///
/// DISARMED is today's behaviour, held by test: a destroyed main window stops the engine (on
/// macOS the process outlives its window, and an engine outliving the window it belonged to is
/// the stray process this shell exists to prevent), a close request passes through untouched,
/// and exit stops the engine. ARMED changes exactly two cells: the close request becomes a hide
/// — the phone must keep reading mail through a window the laptop's owner closed — and the
/// destroyed window stops nothing, because with host mode on the engine's lifetime belongs to
/// the APP (the tray's Quit, or the platform's), not to the window. Exit reaps in both columns,
/// always.
pub fn lifecycle_action(armed: bool, signal: WindowSignal) -> LifecycleAction {
    match (armed, signal) {
        (_, WindowSignal::Exit) => LifecycleAction::StopEngine,
        (false, WindowSignal::MainDestroyed) => LifecycleAction::StopEngine,
        (false, WindowSignal::MainCloseRequested) => LifecycleAction::Nothing,
        (true, WindowSignal::MainCloseRequested) => LifecycleAction::HideInsteadOfClose,
        (true, WindowSignal::MainDestroyed) => LifecycleAction::Nothing,
    }
}

// ── What one launch decided about host mode ─────────────────────────────────────────────────

/// The launch-time decision: read the setting, check the door, probe the tailnet, and say what
/// the spawn gets and what the tray should report. Pure input to [`manage`] and to
/// `Shell::start`; computed once in `main.rs` before the engine starts.
pub struct HostBoot {
    /// The persisted setting said ON and this install is on the local door. Drives the tray,
    /// close-to-hide, and the armed lifecycle column — even when degraded, because the USER's
    /// choice is armed and the tray is where the degradation is reported.
    pub armed: bool,
    pub port: Option<u16>,
    /// The operator's persisted LAN choice, carried whether or not a spawn exists — the window
    /// renders the same-network row from the CHOICE, and its live state from the engine's own
    /// LAN signal.
    pub lan: Option<String>,
    /// The spawn's variables, present when there is a door anybody could reach: the probe found
    /// an identity, or the operator chose a LAN address (the no-Tailscale path).
    pub spawn: Option<HostSpawn>,
    /// Why the tailnet half is absent (or the mode inapplicable), when it is. With a LAN choice
    /// this coexists with a spawn: armed, serving same-network, tailnet degraded — three truths.
    pub problem: Option<Problem>,
}

impl HostBoot {
    /// Host mode off — the launch every install without the setting gets, byte-identical to the
    /// builds that predate host mode.
    pub fn disarmed() -> HostBoot {
        HostBoot { armed: false, port: None, lan: None, spawn: None, problem: None }
    }

    /// Decide from the stored setting, the stored door, an injected probe, and the packaged
    /// host-client (resolved by the caller — a filesystem fact, injected so every branch is a
    /// test without a bundle).
    pub fn detect_with(
        settings: Option<config::HostSettings>,
        mode: Option<config::Mode>,
        probe: &dyn Fn() -> Result<TailnetIdentity, Problem>,
        assets: Option<PathBuf>,
    ) -> HostBoot {
        let Some(settings) = settings.filter(|s| s.enabled) else {
            return HostBoot::disarmed();
        };
        if mode != Some(config::Mode::Local) {
            // Enabled in settings, inapplicable at this door. NOT armed: the lifecycle and the
            // tray follow the door that is actually open, and the setting waits in its file.
            return HostBoot {
                armed: false,
                port: Some(settings.port),
                lan: settings.lan,
                spawn: None,
                problem: Some(Problem::LocalDoorRequired),
            };
        }
        match probe() {
            Ok(identity) => HostBoot {
                armed: true,
                port: Some(settings.port),
                lan: settings.lan.clone(),
                spawn: Some(HostSpawn {
                    port: settings.port,
                    origin: Some(identity.origin),
                    lan: settings.lan,
                    assets,
                }),
                problem: None,
            },
            // Armed with the tailnet degraded. WITH a LAN choice the engine still spawns its
            // doors — origin absent, LAN present — because same-network access is exactly the
            // path that owes nothing to the tailnet (the no-Tailscale flow); the problem is
            // still reported, because the tailnet half the user also asked for is not serving.
            // WITHOUT one, the engine spawns with no host variables at all (the safe branch):
            // an armed engine with neither a served origin nor a LAN address has no door
            // anybody could reach.
            Err(problem) => HostBoot {
                armed: true,
                port: Some(settings.port),
                lan: settings.lan.clone(),
                spawn: settings.lan.map(|lan| HostSpawn {
                    port: settings.port,
                    origin: None,
                    lan: Some(lan),
                    assets,
                }),
                problem: Some(problem),
            },
        }
    }

    /// The shipped detection: the real settings file, the real door, the real CLI, the real
    /// bundle resources.
    pub fn detect(paths: &engine::ShellPaths) -> HostBoot {
        let settings = paths
            .app_data
            .as_deref()
            .map(|dir| dir.join(config::HOST_FILE_NAME))
            .and_then(|path| config::read_host(&path));
        let mode = paths.config().map(|c| c.mode());
        let boot = HostBoot::detect_with(
            settings,
            mode,
            &|| probe_with(&|args| run_tailscale(args)),
            packaged_host_client(paths.resources.as_deref()),
        );
        match (&boot.spawn, &boot.problem) {
            (Some(spawn), problem) => {
                match &spawn.origin {
                    Some(origin) => engine::log_line(format_args!(
                        "host mode armed: the engine's host door binds 127.0.0.1:{} and the \
                         tailnet serves {}",
                        spawn.port, origin
                    )),
                    None => engine::log_line(format_args!(
                        "host mode armed without a tailnet identity ({}); the engine serves \
                         same-network access only on port {}",
                        problem.map(Problem::as_str).unwrap_or("unknown"),
                        spawn.port
                    )),
                }
                if spawn.lan.is_some() {
                    engine::log_line(format_args!(
                        "host mode: same-network access is chosen; the engine's LAN door binds \
                         the configured interface on port {}",
                        spawn.port
                    ));
                }
            }
            (None, Some(problem)) => engine::log_line(format_args!(
                "host mode is enabled and cannot publish this launch ({}); the engine starts \
                 without its host door",
                problem.as_str()
            )),
            (None, None) => {}
        }
        boot
    }
}

// ── The runtime state the window and the tray read ───────────────────────────────────────────

/// The tray's three ids. Prefixed so the menu bar's own handler (which routes by prefix) can
/// never mistake one for a navigation or command item.
const TRAY_ID: &str = "host";
const TRAY_STATE_ID: &str = "host:state";
const TRAY_OPEN_ID: &str = "host:open";
const TRAY_QUIT_ID: &str = "host:quit";

/// The state line's four sentences. Short, because a tray menu is not a place to explain — the
/// window's own screens carry the guidance, keyed off the typed problem. The same-network line
/// exists so a LAN-only install (the no-Tailscale path) is not told it "needs attention" for
/// ever about a tailnet it deliberately does not have — while still not claiming the tailnet.
const TRAY_LINE_SERVING: &str = "Serving your tailnet";
const TRAY_LINE_LAN_ONLY: &str = "Serving your network only";
const TRAY_LINE_DEGRADED: &str = "Host mode needs attention";
const TRAY_LINE_OFF: &str = "Host mode off";

struct TrayHandles<R: tauri::Runtime> {
    icon: tauri::tray::TrayIcon<R>,
    state_line: tauri::menu::MenuItem<R>,
}

/// Everything the shell knows about host mode while the app runs. Managed state; the commands
/// below and the tray read it, the arm/disarm commands write it.
pub struct HostRuntime<R: tauri::Runtime> {
    shell: Arc<Shell>,
    /// Where `host.json` lives, resolved once — `None` on a machine that named no data dir.
    settings_path: Option<PathBuf>,
    armed: AtomicBool,
    /// Bumped on every arm and every stand-down. A publication carries the generation it was
    /// started under and publishes NOTHING if the world moved — otherwise a launch-time
    /// publication scheduled behind a slow daemon could re-publish a port the user had just
    /// disarmed, leaving the shell reporting off while the tailnet still proxies.
    generation: AtomicU64,
    /// Whether the CURRENT arming has actually completed its `tailscale serve` registration.
    /// "Serving" is claimed only when this is true AND the engine's listener holds the port —
    /// an armed install whose publication has not happened yet is degraded, not serving.
    published: AtomicBool,
    /// Serializes every `tailscale serve` mutation, so an in-flight publication and a disarm's
    /// off-switch cannot interleave; whichever runs second under this lock decides the end state,
    /// and the generation check under the same lock makes that the disarm.
    serve_ops: Mutex<()>,
    port: Mutex<Option<u16>>,
    origin: Mutex<Option<String>>,
    /// The operator's LAN choice as it stands — `None` when same-network access is off. What
    /// `host_state` reports as `lan`; the live half (`lanState`) comes from the engine's own
    /// LAN signal, never from this field.
    lan: Mutex<Option<String>>,
    /// The launch- or arm-time problem. `None` when nothing stands between this install and
    /// serving (the tri-state still derives listener-pending from the engine's own signals).
    problem: Mutex<Option<Problem>>,
    tray: Mutex<Option<TrayHandles<R>>>,
}

impl<R: tauri::Runtime> HostRuntime<R> {
    /// Read by the run loop on every window event; a plain load, because the answer can change
    /// while the app runs (the enable ceremony arms without a relaunch).
    pub fn armed(&self) -> bool {
        self.armed.load(Ordering::SeqCst)
    }

    /// The tri-state the tray line and the window's screens render, with its reason.
    fn tri_state(&self) -> (&'static str, Option<Problem>) {
        if !self.armed() {
            return ("off", *self.problem.lock().expect("host problem"));
        }
        if let Some(problem) = *self.problem.lock().expect("host problem") {
            return ("degraded", Some(problem));
        }
        let engine = self.shell.engine();
        if !matches!(engine.state(), EngineState::Serving { .. }) {
            return ("degraded", Some(Problem::EngineNotServing));
        }
        match engine.host_signal() {
            // "Serving" needs BOTH halves true: the engine holds the loopback port AND the
            // tailnet registration has actually been made under the current arming. A listener
            // without the route is not reachable from anybody's phone, and saying "serving"
            // about it would be the tray lying in the exact state somebody is debugging.
            Some(HostSignal::Listening { .. }) if self.published.load(Ordering::SeqCst) => {
                ("serving", None)
            }
            Some(HostSignal::Listening { .. }) => ("degraded", Some(Problem::ListenerPending)),
            Some(HostSignal::Skipped) => ("degraded", Some(Problem::ListenerSkipped)),
            Some(HostSignal::Failed) => ("degraded", Some(Problem::ListenerFailed)),
            Some(HostSignal::ConfigInvalid) => ("degraded", Some(Problem::HostConfigInvalid)),
            None => ("degraded", Some(Problem::ListenerPending)),
        }
    }

    /// Whether the engine's LAN door holds its socket right now — read off the engine's own
    /// signal, like the loopback listener's tri-state input.
    fn lan_listening(&self) -> bool {
        matches!(self.shell.engine().lan_signal(), Some(LanSignal::Listening { .. }))
    }

    /// The same-network half's own wire state, or `Null` when no LAN address is chosen (or host
    /// mode is off). A closed vocabulary the window mirrors: serving / pending / failed /
    /// invalid — the engine's LAN signal, told as it stands.
    fn lan_state_json(&self) -> serde_json::Value {
        if !self.armed() || self.lan.lock().expect("host lan").is_none() {
            return serde_json::Value::Null;
        }
        let engine = self.shell.engine();
        if !matches!(engine.state(), EngineState::Serving { .. }) {
            return serde_json::json!("pending");
        }
        serde_json::json!(match engine.lan_signal() {
            Some(LanSignal::Listening { .. }) => "serving",
            Some(LanSignal::Failed) => "failed",
            Some(LanSignal::ConfigInvalid) => "invalid",
            None => "pending",
        })
    }

    /// What `host_state` answers — and the one place its shape is composed.
    fn state_json(&self, autostart: Option<bool>) -> serde_json::Value {
        let (state, problem) = self.tri_state();
        serde_json::json!({
            "enabled": self.armed(),
            "port": *self.port.lock().expect("host port"),
            "origin": *self.origin.lock().expect("host origin"),
            "lan": *self.lan.lock().expect("host lan"),
            "lanState": self.lan_state_json(),
            "state": state,
            "problem": problem.map(Problem::as_str),
            "autostart": autostart,
        })
    }

    fn set_problem(&self, problem: Option<Problem>) {
        *self.problem.lock().expect("host problem") = problem;
    }

    /// The answer to a REFUSED attempt: the runtime's real state — an already-armed install
    /// stays armed, a disarmed one stays off — with `problem` naming what THIS attempt hit.
    /// Fabricating a bare "off" here would have the refusal and the very next `host_state`
    /// disagreeing about `enabled`.
    fn refusal_json(&self, problem: Problem, autostart: Option<bool>) -> serde_json::Value {
        let mut out = self.state_json(autostart);
        out["problem"] = serde_json::Value::String(problem.as_str().to_string());
        out
    }

    /// Refresh the tray's state line from the tri-state. Called from the refresher thread and
    /// from arm/disarm; menu item setters proxy to the main thread themselves.
    fn refresh_tray_line(&self) {
        let (state, _) = self.tri_state();
        // "Degraded" with a live LAN door is the no-Tailscale install doing exactly what was
        // asked of it — say what serves, not only what does not.
        let lan_only = state == "degraded"
            && self.lan.lock().expect("host lan").is_some()
            && self.lan_listening();
        let text = match state {
            "serving" => TRAY_LINE_SERVING,
            "degraded" if lan_only => TRAY_LINE_LAN_ONLY,
            "degraded" => TRAY_LINE_DEGRADED,
            _ => TRAY_LINE_OFF,
        };
        if let Some(handles) = self.tray.lock().expect("host tray").as_ref() {
            let _ = handles.state_line.set_text(text);
        }
    }
}

/// Build the runtime from the boot decision, hand it to the app, and stand the tray up when the
/// boot said armed. Called from `main.rs` after the shell has started the engine.
pub fn manage<R: tauri::Runtime>(
    app: &tauri::App<R>,
    shell: Arc<Shell>,
    boot: HostBoot,
) -> Arc<HostRuntime<R>> {
    use tauri::Manager;
    let runtime = Arc::new(HostRuntime {
        shell,
        settings_path: app
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join(config::HOST_FILE_NAME)),
        armed: AtomicBool::new(boot.armed),
        generation: AtomicU64::new(0),
        published: AtomicBool::new(false),
        serve_ops: Mutex::new(()),
        port: Mutex::new(boot.port),
        origin: Mutex::new(boot.spawn.as_ref().and_then(|s| s.origin.clone())),
        lan: Mutex::new(boot.lan.clone()),
        problem: Mutex::new(boot.problem),
        tray: Mutex::new(None),
    });
    app.manage(Arc::clone(&runtime));

    if boot.armed {
        stand_up_tray(app.handle(), &runtime);
        // The launch publication, when the probe found an identity: wait for the engine's own
        // listener to hold the port, THEN `serve --bg` (normally a no-op — the registration is
        // persistent in the daemon — but it heals one lost to a reset). Off the startup path,
        // and generation-gated: a disarm clicked before this runs wins, and this publishes
        // nothing. A LAN-only spawn (origin None — the no-Tailscale path) publishes NOTHING:
        // there is no loopback listener to wait for and no tailnet to route, and the wait would
        // only end in `listener-skipped` overwriting the truthful tailnet problem.
        if let Some(spawn) = boot.spawn.filter(|s| s.origin.is_some()) {
            let runtime = Arc::clone(&runtime);
            let generation = runtime.generation.load(Ordering::SeqCst);
            std::thread::spawn(move || {
                match runtime.publish_when_listening(spawn.port, generation) {
                    Ok(true) => {}
                    Ok(false) => return, // stood down while waiting; the stand-down spoke
                    Err(problem) => {
                        engine::log_line(format_args!(
                            "host mode: the launch publication did not happen ({})",
                            problem.as_str()
                        ));
                        runtime.set_problem(Some(problem));
                    }
                }
                runtime.refresh_tray_line();
            });
        }
    }
    runtime
}

/// Build the tray — icon, state line, Open, Quit — and start the thread that keeps the state
/// line true. Idempotent: a tray already standing is left standing.
fn stand_up_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>, runtime: &Arc<HostRuntime<R>>) {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let mut slot = runtime.tray.lock().expect("host tray");
    if slot.is_some() {
        return;
    }
    let built: tauri::Result<TrayHandles<R>> = (|| {
        // Disabled: it is a statement, not an action. Its text follows the tri-state.
        let state_line = MenuItem::with_id(app, TRAY_STATE_ID, TRAY_LINE_DEGRADED, false, None::<&str>)?;
        let open = MenuItem::with_id(app, TRAY_OPEN_ID, "Open ohmail", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit ohmail", true, None::<&str>)?;
        let separator = PredefinedMenuItem::separator(app)?;
        let menu = Menu::with_items(
            app,
            &[
                &state_line as &dyn tauri::menu::IsMenuItem<R>,
                &separator as &dyn tauri::menu::IsMenuItem<R>,
                &open as &dyn tauri::menu::IsMenuItem<R>,
                &quit as &dyn tauri::menu::IsMenuItem<R>,
            ],
        )?;
        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .menu(&menu)
            .show_menu_on_left_click(true)
            .tooltip("ohmail")
            .on_menu_event(|app, event| match event.id().as_ref() {
                TRAY_OPEN_ID => show_main_window(app),
                // The tray's Quit is the app's quit: the exit event stops the engine on the same
                // path the menu bar's Quit has always taken.
                TRAY_QUIT_ID => app.exit(0),
                _ => {}
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        let icon = builder.build(app)?;
        Ok(TrayHandles { icon, state_line })
    })();
    match built {
        Ok(handles) => {
            *slot = Some(handles);
            drop(slot);
            runtime.refresh_tray_line();
            // The refresher: the line must go stale-proof without the window asking — the tray
            // is exactly the surface somebody looks at when the window is closed. It ends itself
            // when the tray comes down. Beyond re-reading the line it does two slower jobs:
            //
            //  · every minute it re-probes the tailnet, because "serving" claimed off an
            //    arm-time probe would otherwise outlive a daemon somebody stopped or signed
            //    out of — the recoverable tailnet states are set and cleared here, and states
            //    this probe cannot judge (a serve refusal, the engine's own listener) are
            //    left alone;
            //  · when the arming is not yet published (the engine's listener was slow, or a
            //    restart re-announced), it completes the publication under the same
            //    generation gate the arm and the launch use.
            let runtime = Arc::clone(runtime);
            std::thread::spawn(move || {
                const RECHECK_EVERY: u32 = 15; // × 4s ≈ every minute
                let recoverable = |p: Problem| {
                    matches!(
                        p,
                        Problem::NoCli
                            | Problem::NotRunning
                            | Problem::NotLoggedIn
                            | Problem::NoDnsName
                    )
                };
                let mut tick: u32 = 0;
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if runtime.tray.lock().expect("host tray").is_none() {
                        return;
                    }
                    tick = tick.wrapping_add(1);
                    if runtime.armed() {
                        if !runtime.published.load(Ordering::SeqCst) {
                            let port = *runtime.port.lock().expect("host port");
                            let blocked = runtime
                                .problem
                                .lock()
                                .expect("host problem")
                                .map(|p| p != Problem::ListenerPending)
                                .unwrap_or(false)
                                // A LAN-only arming (no tailnet identity — the no-Tailscale
                                // path) has no publication to complete: this run's engine holds
                                // no loopback listener, and the route would proxy nothing.
                                || runtime.origin.lock().expect("host origin").is_none();
                            if let (Some(port), false) = (port, blocked) {
                                let generation = runtime.generation.load(Ordering::SeqCst);
                                // One try, no wait: this tick only publishes when the signal
                                // is already there; failures become the typed problem, which
                                // also stops this from hammering a refusing CLI every 4s.
                                match runtime.publish_when_listening_with(
                                    port,
                                    generation,
                                    1,
                                    std::time::Duration::ZERO,
                                    &|| {
                                        ListenerPoll::Waiting(
                                            runtime.shell.engine().host_signal(),
                                        )
                                    },
                                    &|args| run_tailscale(args),
                                ) {
                                    Ok(true) => runtime.set_problem(None),
                                    Ok(false) => {}
                                    Err(Problem::ListenerPending) => {}
                                    Err(problem) => runtime.set_problem(Some(problem)),
                                }
                            }
                        }
                        if tick % RECHECK_EVERY == 0 {
                            let current = *runtime.problem.lock().expect("host problem");
                            match probe_with(&|args| run_tailscale(args)) {
                                Ok(_) => {
                                    if current.map(recoverable).unwrap_or(false) {
                                        runtime.set_problem(None);
                                    }
                                }
                                Err(problem) => {
                                    if current.map(recoverable).unwrap_or(true) {
                                        runtime.set_problem(Some(problem));
                                    }
                                }
                            }
                        }
                    }
                    runtime.refresh_tray_line();
                }
            });
        }
        Err(err) => {
            engine::log_line(format_args!(
                "host mode: the tray icon could not be built ({err}); host mode continues \
                 without it and the window remains the way in"
            ));
        }
    }
}

impl<R: tauri::Runtime> HostRuntime<R> {
    /// Take the tray down. The refresher thread notices the empty slot and ends.
    fn take_down_tray(&self) {
        if let Some(handles) = self.tray.lock().expect("host tray").take() {
            // Dropping the handle removes the icon; `set_visible(false)` first so platforms that
            // defer the drop do not leave a ghost icon until the next event-loop turn.
            let _ = handles.icon.set_visible(false);
        }
    }
}

/// Bring the main window back from the tray. On macOS the dock icon returns first — an
/// Accessory-policy app cannot take focus.
pub fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Hide the main window into the tray. On macOS the dock icon withdraws too — a hidden window
/// with a dock icon reads as a hung app, and the tray is the way back.
pub fn hide_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

// ── The commands the window may call ─────────────────────────────────────────────────────────

/// What the window's autostart toggle reads. `None` when the platform's manager errored —
/// distinct from off, because "unknown" must not render as an unchecked box somebody re-checks.
fn autostart_enabled<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<bool> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().ok()
}

/// Host mode as the window renders it: setting, port, origin, tri-state, typed problem, and the
/// start-at-login registration.
#[tauri::command(async)]
pub fn host_state<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, Arc<HostRuntime<R>>>,
) -> serde_json::Value {
    host.state_json(autostart_enabled(&app))
}

/// The tailnet as it stands: `{state, dnsName, version}` on a running tailnet, or a typed
/// guided state naming what to fix. Never a stderr dump.
#[tauri::command(async)]
pub fn tailscale_status() -> serde_json::Value {
    match probe_with(&|args| run_tailscale(args)) {
        Ok(identity) => serde_json::json!({
            "state": "running",
            "dnsName": identity.dns_name,
            "version": identity.version,
        }),
        Err(problem) => serde_json::json!({ "state": problem.as_str() }),
    }
}

/// Arm host mode: probe, persist, register start-at-login, respawn the engine with its host
/// door, and — LAST, and only once the engine's own listener holds the loopback port — publish
/// the tailnet route.
///
/// The order is the security property, not a preference. `tailscale serve` proxies onto
/// `127.0.0.1:<port>` for whatever is listening there, so a route installed before the engine
/// binds would expose some unrelated loopback service to every tailnet device — and keep
/// exposing it if the engine's bind then failed. So: a refusal BEFORE anything persists (a
/// failed probe, the wrong door) changes nothing and answers with the current state plus this
/// attempt's problem; a failure AFTER the respawn leaves an armed, DEGRADED, UNPUBLISHED
/// install — safe in the only direction that matters, because no route exists until the port
/// is provably the engine's.
///
/// `autostart` is the enable ceremony's pre-checked line, passed explicitly so unchecking it is
/// part of the same arming rather than a race against it. `lan` is the ceremony's same-network
/// choice — one interface address the operator picked, or `None` for the Tailscale-only default
/// — and it is ALSO what makes the no-Tailscale path real: with a LAN address in hand, a failed
/// probe no longer refuses the arming — the engine spawns with the LAN door alone, nothing is
/// published (there is no tailnet identity to publish), and the probe's problem is reported
/// beside a serving same-network half. Without one, a failed probe refuses exactly as before.
#[tauri::command(async)]
pub fn tailscale_serve_arm<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, Arc<HostRuntime<R>>>,
    port: u16,
    autostart: bool,
    lan: Option<String>,
) -> Result<serde_json::Value, String> {
    if port == 0 {
        // The frozen contract: 1–65535. Port 0 means "any free port", and the registration
        // this command creates points at ONE.
        return Err("host mode needs a fixed port between 1 and 65535".to_string());
    }
    if host.shell.config_mode() != Some(config::Mode::Local) {
        return Ok(host.refusal_json(Problem::LocalDoorRequired, autostart_enabled(&app)));
    }
    // The LAN choice, shaped only (non-empty after trim); the ENGINE rules on the value and a
    // garbage address degrades the LAN half over there with a logged reason.
    let lan = lan.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());
    let run = |args: &[String]| run_tailscale(args);
    // The probed identity, or — WITH a LAN choice — the problem to report beside a LAN-only
    // arming. Without one, a probe refusal changes nothing, exactly as it always has.
    let (identity, tailnet_problem): (Option<TailnetIdentity>, Option<Problem>) =
        match probe_with(&run) {
            Ok(identity) => (Some(identity), None),
            Err(problem) if lan.is_some() => (None, Some(problem)),
            Err(problem) => return Ok(host.refusal_json(problem, autostart_enabled(&app))),
        };

    // The setting first: the file and the runtime agree host mode is ON before any route can
    // exist, so a crash anywhere past this line leaves an armed, unpublished install — never a
    // route the settings deny.
    let path = host
        .settings_path
        .clone()
        .ok_or_else(|| "this computer named no place for the app to keep its settings".to_string())?;
    config::write_host(&path, &config::HostSettings { enabled: true, port, lan: lan.clone() })?;

    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = app.autolaunch();
        let outcome = if autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = outcome {
            engine::log_line(format_args!(
                "host mode: the start-at-login registration could not be updated ({err}); \
                 host mode is on regardless"
            ));
        }
    }

    let generation = host.generation.fetch_add(1, Ordering::SeqCst) + 1;
    host.published.store(false, Ordering::SeqCst);
    host.armed.store(true, Ordering::SeqCst);
    *host.port.lock().expect("host port") = Some(port);
    *host.origin.lock().expect("host origin") =
        identity.as_ref().map(|i| i.origin.clone());
    *host.lan.lock().expect("host lan") = lan.clone();
    host.set_problem(tailnet_problem);
    // The engine respawns with the host variables; the mirror and the stdio door pay one
    // ordinary restart for it, which is the same cost as choosing a door. The assets path is the
    // same resolution the launch detection performs — this bundle's packaged host-client, or
    // None on a build that carries none (the engine then serves API-only and says why).
    let assets = {
        use tauri::Manager;
        packaged_host_client(app.path().resource_dir().ok().as_deref())
    };
    host.shell.set_host_spawn(Some(HostSpawn {
        port,
        origin: identity.as_ref().map(|i| i.origin.clone()),
        lan,
        assets,
    }));
    host.shell.replan();
    stand_up_tray(&app, host.inner());

    // The publication, last, and ONLY with a tailnet identity in hand. This waits for the fresh
    // engine's `host_listening` — seconds, on the door the person is already using — so the
    // ceremony's answer states the finished truth. A LAN-only arming publishes nothing: no
    // loopback listener exists this run and no tailnet could route to it.
    if let Some(identity) = identity {
        match host.publish_when_listening(port, generation) {
            Ok(true) => {
                host.set_problem(None);
                engine::log_line(format_args!(
                    "host mode armed: the engine's host door binds 127.0.0.1:{port} and the \
                     tailnet serves {}",
                    identity.origin
                ));
            }
            Ok(false) => { /* a stand-down won the race and already said so */ }
            Err(problem) => {
                engine::log_line(format_args!(
                    "host mode armed and NOT published ({}); no route exists until the engine \
                     holds the port",
                    problem.as_str()
                ));
                host.set_problem(Some(problem));
            }
        }
    } else {
        engine::log_line(format_args!(
            "host mode armed without a tailnet identity ({}); same-network access only, on the \
             configured interface, port {port}",
            tailnet_problem.map(Problem::as_str).unwrap_or("unknown"),
        ));
    }
    host.refresh_tray_line();
    Ok(host.state_json(autostart_enabled(&app)))
}

/// Everything a disarm does short of restarting the engine: bump the generation (any in-flight
/// publication that has not yet run its serve sees the move and does nothing), withdraw the
/// tailnet registration under the serve lock (one that already published is undone HERE, because
/// the lock orders this off-switch after it), unregister start-at-login, persist OFF, take the
/// tray down, give macOS its dock icon back. Proceeds even when the CLI refuses or is gone — the
/// setting is the user's to turn off on a machine Tailscale has already left — and returns the
/// withdraw refusal, typed, for the caller to report.
///
/// A settings-write failure is returned as `Err` and does NOT undo the stand-down: the runtime
/// is already off, and a stale `enabled: true` on disk is caught at the next launch by the door
/// and probe checks, which publish nothing on their own.
fn stand_down<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    host: &Arc<HostRuntime<R>>,
) -> Result<Option<Problem>, String> {
    host.generation.fetch_add(1, Ordering::SeqCst);
    let withdraw = {
        let _serialized = host.serve_ops.lock().expect("serve ops");
        disarm_serve_with(&|args| run_tailscale(args))
    };
    if let Err(problem) = &withdraw {
        engine::log_line(format_args!(
            "host mode: withdrawing the tailnet registration failed ({}); host mode turns off \
             locally regardless",
            problem.as_str()
        ));
    }
    host.published.store(false, Ordering::SeqCst);

    {
        use tauri_plugin_autostart::ManagerExt;
        if let Err(err) = app.autolaunch().disable() {
            engine::log_line(format_args!(
                "host mode: the start-at-login registration could not be removed ({err})"
            ));
        }
    }

    host.armed.store(false, Ordering::SeqCst);
    *host.origin.lock().expect("host origin") = None;
    host.set_problem(withdraw.as_ref().err().copied());
    host.shell.set_host_spawn(None);
    host.take_down_tray();
    // The dock icon returns on macOS: Accessory policy outliving the tray would strand the app.
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(path) = host.settings_path.as_deref() {
        let port = host.port.lock().expect("host port").unwrap_or(1);
        // The port and the LAN choice survive a disarm so re-arming offers the same ones back.
        let lan = host.lan.lock().expect("host lan").clone();
        config::write_host(path, &config::HostSettings { enabled: false, port, lan })?;
    }
    Ok(withdraw.err())
}

/// Stand host mode down because the SHELL is moving under it — a door switch away from the
/// local organizer, or a sign-out. Both take the engine's host listener away, and a tailnet
/// registration outliving the listener it pointed at would proxy whatever binds that loopback
/// port next. Best-effort by design: the transition itself must not be blocked by a settings
/// write, so a failure is logged and the next launch's own checks (door, probe) publish nothing.
pub fn stand_down_on_shell_transition<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    host: &Arc<HostRuntime<R>>,
    why: &str,
) {
    if !host.armed() {
        return;
    }
    engine::log_line(format_args!("host mode stands down: {why}"));
    if let Err(reason) = stand_down(app, host) {
        engine::log_line(format_args!(
            "host mode: the setting could not be written while standing down ({reason}); the \
             next launch republishes nothing without a door and a probe"
        ));
    }
}

/// Disarm host mode: the stand-down above, then the engine restarts without its host door.
#[tauri::command(async)]
pub fn tailscale_serve_disarm<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, Arc<HostRuntime<R>>>,
) -> Result<serde_json::Value, String> {
    // `stand_down` already records the withdraw refusal, if any, as the runtime problem.
    let _withdraw = stand_down(&app, host.inner())?;
    host.shell.replan();
    engine::log_line(format_args!("host mode disarmed; the engine restarts without its host door"));
    Ok(host.state_json(autostart_enabled(&app)))
}

/// Whether this install starts at login.
#[tauri::command(async)]
pub fn autostart_get<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|err| err.to_string())
}

/// Set the start-at-login registration — the enable ceremony's checkbox, honoured after the
/// ceremony too. Returns the state as the platform then reports it.
///
/// ENABLING requires host mode armed: start-at-login exists here only in service of the
/// always-on role, and a disarmed install registering itself to start with somebody's computer
/// would be new disarmed behaviour — the thing this feature must never add. Disabling is
/// unconditional, because turning a registration OFF is safe from any state.
#[tauri::command(async)]
pub fn autostart_set<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, Arc<HostRuntime<R>>>,
    enabled: bool,
) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    if enabled && !host.armed() {
        return Err(
            "start-at-login belongs to host mode; turn host mode on to start ohmail at login"
                .to_string(),
        );
    }
    let manager = app.autolaunch();
    let outcome = if enabled { manager.enable() } else { manager.disable() };
    outcome.map_err(|err| err.to_string())?;
    manager.is_enabled().map_err(|err| err.to_string())
}

/// Open Tailscale's download page in the user's own browser — the guided way out of the
/// [`Problem::NoCli`] state. The address is [`TAILSCALE_DOWNLOAD_URL`], a constant: the window
/// names an intent, never a URL, which is the same rule every other opener in this shell keeps.
#[tauri::command(async)]
pub fn open_tailscale_download() -> Result<(), String> {
    engine::spawn_opener(TAILSCALE_DOWNLOAD_URL)
}
