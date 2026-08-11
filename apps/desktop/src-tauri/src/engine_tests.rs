//! The engine lifecycle, against a real child process.
//!
//! Nothing here is a mock. Every test that says "the engine" starts an actual operating-system
//! process, over an actual pipe, and the assertions are about processes: whether one is running,
//! whether it is gone, how many times it was started. A supervisor tested against a fake process
//! table would prove nothing about the failure this module exists to prevent — an engine left
//! running after the app has quit, holding an authenticated IMAP connection against a server that
//! caps them.
//!
//! The stand-in engine is Node, which is what the real engine is. It speaks the same frames and
//! honours the same stdin-EOF contract, so a test that passes here is a test about this shell's
//! half of the protocol rather than about a script that was written to agree with it.

use super::*;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

/// The stand-in engine. Modes, in the order the tests use them:
///
///  · `serve`           — announce ready, then leave when stdin ends. What the real one does.
///  · `serve-then-die`  — announce ready, then exit non-zero after a moment.
///  · `serve-deaf`      — announce ready and then ignore stdin entirely. Never leaves.
///  · `die`             — exit 1 without ever announcing. What a locked data directory looks like.
///  · `noise`           — announce ready, then write a line of prose to the frame stream.
///  · `echo`            — answer every request with a response describing what it received.
///  · `mute`            — accept requests and answer none. A wedged engine, which is what the
///                        run-end drain exists for.
///
/// The three request modes decode frames the same way the real engine does — an 8-byte preamble
/// then a JSON header then a body — so a test that passes is a test about this shell's half of the
/// protocol rather than about a script written to agree with it.
///
/// Every mode appends a line to `$FAKE_LOG` on start and on exit, which is how a test counts
/// starts and proves an exit independently of anything this shell reports about itself.
const FAKE_ENGINE_JS: &str = r#"
const fs = require("node:fs");
const mode = process.argv[2];
const log = process.env.FAKE_LOG;
const note = (what) => { if (log) fs.appendFileSync(log, what + " " + process.pid + "\n"); };
note("start");
process.on("exit", () => note("exit"));

// WHAT THIS CHILD ACTUALLY INHERITED, for the one test that is about inheritance. Off unless the
// test asks for it, so every other test's log lines are unchanged and its counts still mean what
// they meant.
if (process.env.FAKE_REPORT_ENV) {
  for (const name of process.env.FAKE_REPORT_ENV.split(",")) {
    note("env " + name + "=" + (process.env[name] ?? "<unset>"));
  }
}

// One line on stderr, in the shape the real engine's logger emits: a JSON object per line, already
// redacted by the time it leaves that process. It is here so a test can prove the shell forwards
// the engine's own diagnostics to the log file rather than only its own account of them.
process.stderr.write(JSON.stringify({ level: "info", msg: "fake engine up", mode }) + "\n");

function frame(header, body) {
  const h = Buffer.from(JSON.stringify(header), "utf8");
  const b = body ?? Buffer.alloc(0);
  const pre = Buffer.alloc(8);
  pre.writeUInt32BE(h.length, 0);
  pre.writeUInt32BE(b.length, 4);
  process.stdout.write(Buffer.concat([pre, h, b]));
}
const ready = () => frame({
  v: 1, t: "ready", baseUrl: "http://sidecar",
  sessionToken: "tok_" + "a".repeat(24),
  accountId: "acc-1", userId: "usr-1", mailboxId: "mbx-1",
  credentialState: "ready",
});

if (mode === "die") { process.exit(1); }

ready();

// The real engine leaves when its stdin ends; `serve-deaf` is the one that does not.
if (mode !== "serve-deaf") {
  process.stdin.on("end", () => process.exit(0));
}

if (mode === "echo" || mode === "mute") {
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 8) return;
      const hl = buf.readUInt32BE(0);
      const bl = buf.readUInt32BE(4);
      if (buf.length < 8 + hl + bl) return;
      const header = JSON.parse(buf.subarray(8, 8 + hl).toString("utf8"));
      const body = buf.subarray(8 + hl, 8 + hl + bl);
      buf = buf.subarray(8 + hl + bl);
      if (mode === "mute") continue;
      // The answer describes the request, so a test can prove what actually crossed the pipe —
      // the method, the URL, every header the shell composed, and the body's bytes.
      const said = Buffer.from(JSON.stringify({
        method: header.method, url: header.url, h: header.h, body: body.toString("utf8"),
      }), "utf8");
      frame({
        v: 1, t: "res", id: header.id, status: 200, statusText: "OK",
        h: [["content-type", "application/json"]], sc: [],
      }, said);
    }
  });
}
process.stdin.resume();

if (mode === "serve-then-die") { setTimeout(() => process.exit(9), 60); }
if (mode === "noise") { setTimeout(() => process.stdout.write("a stray console.log\n"), 30); }
setInterval(() => {}, 1000);
"#;

/// Node, which the engine is written in and which every build of this app already needs.
fn node() -> String {
    std::env::var("OHMAIL_TEST_NODE").unwrap_or_else(|_| "node".to_string())
}

static SEQ: AtomicU32 = AtomicU32::new(0);

struct Fixture {
    dir: PathBuf,
    script: PathBuf,
    log: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Fixture {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("ohmail-engine-test-{}-{name}-{n}", std::process::id()));
        fs::create_dir_all(&dir).expect("temp dir");
        let script = dir.join("fake-engine.cjs");
        fs::write(&script, FAKE_ENGINE_JS).expect("write fake engine");
        let log = dir.join("starts.log");
        Fixture { dir, script, log }
    }

    fn launch(&self, mode: &str) -> Launch {
        Launch {
            program: PathBuf::from(node()),
            args: vec![self.script.clone().into_os_string(), OsString::from(mode)],
            env: vec![(OsString::from("FAKE_LOG"), self.log.clone().into_os_string())],
            unset: Vec::new(),
        }
    }

    fn lines(&self) -> Vec<String> {
        fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn starts(&self) -> usize {
        self.lines().iter().filter(|l| l.starts_with("start ")).count()
    }

    fn exits(&self) -> usize {
        self.lines().iter().filter(|l| l.starts_with("exit ")).count()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Fast timings. The behaviour under test is the ordering and the bounds, not the numbers —
/// [`default_timings_are_the_shipped_ones`] is what pins the numbers.
fn quick() -> Timings {
    Timings {
        stop_grace: Duration::from_millis(400),
        healthy_for: Duration::from_secs(60),
        backoff_base: Duration::from_millis(20),
        backoff_cap: Duration::from_millis(40),
    }
}

fn wait_for(mut done: impl FnMut() -> bool, within: Duration, what: &str) {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if done() {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out after {within:?} waiting for {what}");
}

/// Is this process id one the operating system still knows about?
///
/// `kill -0` is the portable probe — it asks the kernel and changes nothing. Unix only, and it
/// shells out rather than take a dependency on libc for one line in one test.
///
/// It PANICS when the probe itself cannot be run. An earlier version used `ps -p` and returned
/// `false` when the command failed, which made `assert!(!alive(pid))` pass on a machine where the
/// probe did not work — a guard that cannot fail, asserting nothing, in the one test that exists
/// to catch a leaked process. A probe that cannot run must be a red test, not a quiet true.
#[cfg(unix)]
fn alive(pid: u32) -> bool {
    for kill in ["/bin/kill", "/usr/bin/kill"] {
        let status = Command::new(kill)
            .arg("-0")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        match status {
            Ok(status) => return status.success(),
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            Err(err) => panic!("could not run {kill} to probe pid {pid}: {err}"),
        }
    }
    panic!("no kill(1) to probe pid {pid} with — this test cannot tell a live process from a dead one");
}

// ── The plan: what runs, and whether anything runs at all ───────────────────────────────────

fn env_of(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect()
}

/// The app's resource directory in these tests, and the two paths under it the plan composes.
const RES: &str = "/apps/ohmail/resources";
fn res() -> &'static Path {
    Path::new(RES)
}
fn engine_at() -> PathBuf {
    engine_path_in(res())
}
fn node_at() -> PathBuf {
    vendored_node_in(res())
}

/// A filesystem, as a list. `Runnable` for everything named, `Nothing` for everything else.
///
/// The probe is a parameter to `plan_with` precisely so this can exist: every branch below —
/// including the two that only happen on a broken install — is reachable without a temp directory,
/// and none of them depends on what happens to be installed on the machine running the suite.
fn fs_with(paths: &[PathBuf]) -> impl Fn(&Path) -> Found + '_ {
    move |p: &Path| {
        if paths.iter().any(|q| q == p) {
            Found::Runnable
        } else {
            Found::Nothing
        }
    }
}

/// The ordinary shipped install: an engine and a vendored runtime, both in the app's resources.
fn packaged() -> Vec<PathBuf> {
    vec![engine_at(), node_at()]
}

fn full_env() -> HashMap<String, String> {
    env_of(&[
        ("OHMAIL_IMAP_HOST", "imap.example.org"),
        ("OHMAIL_IMAP_USER", "someone@example.org"),
        // A key, not a password. The engine seals the password into its own store under this and
        // reads it back on later launches, so the environment never has to carry one.
        ("OHMAIL_KEK", &"0".repeat(64)),
    ])
}

#[test]
fn an_explicit_engine_path_wins_over_the_one_in_the_apps_resources() {
    let mut env = full_env();
    let elsewhere = PathBuf::from("/opt/ohmail/engine.mjs");
    env.insert(ENGINE_PATH_VAR.to_string(), elsewhere.display().to_string());
    let there = vec![elsewhere.clone(), node_at()];
    let plan = plan(&|k| env.get(k).cloned(), Some(res()), Some(Path::new("/data")), &fs_with(&there));
    match plan {
        Plan::Spawn(launch) => {
            assert_eq!(launch.args, vec![elsewhere.into_os_string()]);
            assert_eq!(launch.env, vec![(OsString::from(DATA_DIR_VAR), OsString::from("/data"))]);
        }
        other => panic!("expected a spawn plan, got {other:?}"),
    }
}

/// THE LAUNCH SHAPE, AND IT IS THE WHOLE POINT OF THIS SLICE.
///
/// The engine is not executed; a Node runtime is, with the engine as its argument. It used to be the
/// other way round — `Launch::program` was the bundle itself, run through its `#!` line — and that
/// shape has no Windows implementation at all: there is no shebang mechanism there, and `plan`
/// composed `ohmail-engine.exe`, a file the bundler has never produced. One shape on all three
/// platforms is what this asserts.
#[test]
fn the_runtime_is_spawned_and_the_engine_is_its_argument() {
    let env = full_env();
    let plan = plan(&|k| env.get(k).cloned(), Some(res()), Some(Path::new("/data")), &fs_with(&packaged()));
    match plan {
        Plan::Spawn(launch) => {
            assert_eq!(launch.program, node_at(), "the program must be the Node runtime");
            assert_eq!(launch.args, vec![engine_at().into_os_string()], "the engine is the argument");
        }
        other => panic!("expected a spawn plan, got {other:?}"),
    }
}

/// The two paths under the resource directory, pinned. They are a contract with
/// `scripts/stage-desktop-resources.mjs` and with `bundle.resources` in the engine build's config
/// overlay: a change on either side that is not made on the other produces an app that packages
/// cleanly and reports "no engine" when it is opened.
#[test]
fn the_packaged_layout_is_the_one_the_bundler_stages() {
    assert!(engine_at().ends_with("engine/bin/ohmail-engine.mjs"), "{}", engine_at().display());
    assert_eq!(engine_at().parent().unwrap().parent().unwrap(), Path::new(RES).join("engine"));
    assert!(node_at().starts_with(Path::new(RES).join("runtime")));
    // `.mjs` rather than an extensionless file: the bundle is ESM and is now handed to node BY NAME,
    // where an extensionless file's module type is Node's syntax heuristic rather than a fact.
    assert_eq!(ENGINE_FILE_NAME, "ohmail-engine.mjs");
}

#[test]
fn a_missing_mailbox_is_named_and_nothing_is_started() {
    let mut env = full_env();
    env.remove("OHMAIL_IMAP_HOST");
    let plan = plan(&|k| env.get(k).cloned(), Some(res()), Some(Path::new("/data")), &fs_with(&packaged()));
    assert_eq!(
        plan,
        Plan::Inert(EngineState::NotConfigured { missing: vec!["OHMAIL_IMAP_HOST".to_string()] })
    );
}

#[test]
fn without_a_key_nothing_is_started() {
    // The engine WOULD start without one. It would also refuse to store the password the user is
    // about to type, which is a mailbox that works until the app is closed — so the shell treats
    // a missing key as a reason not to start rather than as a reason to start and hope.
    let mut env = full_env();
    env.remove("OHMAIL_KEK");
    let plan = plan(&|k| env.get(k).cloned(), Some(res()), Some(Path::new("/data")), &fs_with(&packaged()));
    assert_eq!(
        plan,
        Plan::Inert(EngineState::NotConfigured { missing: vec!["OHMAIL_KEK".to_string()] })
    );
}

#[test]
fn the_mailbox_password_is_never_required_and_never_composed() {
    // It was required, and requiring it is what put a password in process state on every launch.
    // The engine still accepts one; this shell does not hand one over, and a launch without one
    // is the ordinary case rather than a first-run exception.
    assert!(!REQUIRED_ENGINE_VARS.contains(&"OHMAIL_IMAP_PASS"));
    let env = full_env();
    assert!(!env.contains_key("OHMAIL_IMAP_PASS"));
    match plan(&|k| env.get(k).cloned(), Some(res()), Some(Path::new("/data")), &fs_with(&packaged())) {
        Plan::Spawn(launch) => {
            let names: Vec<&OsString> = launch.env.iter().map(|(k, _)| k).collect();
            assert_eq!(names, vec![&OsString::from(DATA_DIR_VAR)]);
        }
        other => panic!("expected a spawn plan, got {other:?}"),
    }
}

#[test]
fn a_launch_prints_the_names_of_its_environment_and_none_of_the_values() {
    // The keystore slice puts a key in this field. A derived Debug would put that key in the
    // first panic message that formats a plan.
    let launch = Launch {
        program: PathBuf::from("/apps/ohmail/resources/runtime/node"),
        args: vec![],
        env: vec![(OsString::from("OHMAIL_KEK"), OsString::from("deadbeef-do-not-print"))],
        unset: Vec::new(),
    };
    let printed = format!("{launch:?}");
    assert!(printed.contains("OHMAIL_KEK"));
    assert!(!printed.contains("deadbeef-do-not-print"), "an environment value was printed: {printed}");
}

#[test]
fn an_empty_credential_counts_as_missing() {
    let mut env = full_env();
    env.insert("OHMAIL_IMAP_USER".to_string(), "   ".to_string());
    let plan = plan(&|k| env.get(k).cloned(), Some(res()), Some(Path::new("/data")), &fs_with(&packaged()));
    assert_eq!(
        plan,
        Plan::Inert(EngineState::NotConfigured { missing: vec!["OHMAIL_IMAP_USER".to_string()] })
    );
}

#[test]
fn with_no_data_directory_from_either_source_nothing_is_started() {
    let env = full_env();
    let plan = plan(&|k| env.get(k).cloned(), Some(res()), None, &fs_with(&packaged()));
    assert_eq!(
        plan,
        Plan::Inert(EngineState::NotConfigured { missing: vec![DATA_DIR_VAR.to_string()] })
    );
}

#[test]
fn an_environment_data_directory_beats_the_shells_own() {
    let mut env = full_env();
    env.insert(DATA_DIR_VAR.to_string(), "/elsewhere".to_string());
    let plan = plan(&|k| env.get(k).cloned(), Some(res()), Some(Path::new("/data")), &fs_with(&packaged()));
    match plan {
        Plan::Spawn(launch) => {
            assert_eq!(launch.env, vec![(OsString::from(DATA_DIR_VAR), OsString::from("/elsewhere"))]);
        }
        other => panic!("expected a spawn plan, got {other:?}"),
    }
}

#[test]
fn a_build_with_no_engine_beside_it_is_not_an_error() {
    // Nothing at that path, and nothing retries: this is the interface preview, which is what the
    // shell has shipped since it existed.
    let engine = Engine::spawn_with(
        Launch {
            program: PathBuf::from("/nonexistent/ohmail/node"),
            args: vec![],
            env: vec![],
            unset: Vec::new(),
        },
        quick(),
    );
    wait_for(|| matches!(engine.state(), EngineState::Absent { .. }), Duration::from_secs(5), "the absent state");
    engine.stop();
}

// ── Finding a Node to run the engine with ───────────────────────────────────────────────────
//
// The engine is a Node program, and until this slice the shell relied on the bundle's
// `#!/usr/bin/env node` line plus whatever was on the child's PATH. That is true in a terminal and
// false in every way a shipped app is actually opened: a Finder or launchd launch on macOS gets
// `/usr/bin:/bin:/usr/sbin:/sbin` — no Homebrew, no nvm, no node — and Windows has no shebang
// mechanism at all. So the runtime is resolved explicitly, and the order is the thing under test.

#[test]
fn the_vendored_runtime_wins_over_anything_installed_on_the_machine() {
    // THE ONE THAT MAKES THE DOWNLOAD STANDALONE. A machine with its own node must still run the
    // node that shipped inside the app: it is a known version, and preferring the user's would make
    // "it works on a clean machine" depend on the machine.
    let env = env_of(&[("PATH", "/usr/local/bin:/usr/bin")]);
    let there = vec![node_at(), PathBuf::from("/usr/local/bin/node"), PathBuf::from("/opt/homebrew/bin/node")];
    let found = resolve_node(&|k| env.get(k).cloned(), Some(&node_at()), &fs_with(&there));
    assert_eq!(found, Some(node_at()));
}

#[test]
fn an_operators_override_wins_over_the_vendored_runtime() {
    let mine = PathBuf::from("/opt/node22/bin/node");
    let env = env_of(&[(NODE_PATH_VAR, "/opt/node22/bin/node")]);
    let there = vec![mine.clone(), node_at()];
    let look = fs_with(&there);
    assert_eq!(resolve_node(&|k| env.get(k).cloned(), Some(&node_at()), &look), Some(mine));
}

#[test]
fn an_override_that_is_not_runnable_falls_through_rather_than_failing() {
    // An override naming something that is not there is a mistake, not an instruction to give up:
    // the vendored runtime is still the right answer and the app still works. The alternative —
    // refusing outright — turns a typo in an environment variable into an app that will not start.
    let env = env_of(&[(NODE_PATH_VAR, "/opt/nothing-here/node")]);
    let there = vec![node_at()];
    let look = fs_with(&there);
    assert_eq!(resolve_node(&|k| env.get(k).cloned(), Some(&node_at()), &look), Some(node_at()));
}

#[test]
fn a_development_build_with_no_vendored_runtime_finds_one_on_the_path() {
    // No resources, which is what `cargo run` from the workspace looks like.
    //
    // BOTH HALVES OF THE PATH ARE COMPOSED, NOT SPELLED. `resolve_node` splits PATH on the
    // platform's own separator and looks for the platform's own executable name — `;` and
    // `node.exe` on Windows, `:` and `node` everywhere else. Writing either by hand asserts a
    // Unix-only fact: with a literal `:` the Windows split returned ONE entry, `/nope:/opt/…`,
    // and looked in it for a `node.exe` that was never going to be there, so this test failed on
    // Windows for a reason that has nothing to do with the branch it is named after.
    //
    // The directory is deliberately NOT one of DEFAULT_NODE_LOCATIONS. It used to be
    // `/usr/local/bin`, which IS a default on both macOS and Linux, so `resolve_node` answered
    // from the defaults loop and returned before PATH was ever consulted — the test passed on
    // those platforms without exercising the fallback it exists to prove.
    let dir = Path::new("/opt/dev-tools/bin");
    let on_path = dir.join(node_file_name());
    let path_var =
        std::env::join_paths([Path::new("/nope"), dir]).expect("neither entry contains a separator");
    let env = env_of(&[("PATH", path_var.to_str().expect("the composed PATH is utf-8"))]);
    let there = vec![on_path.clone()];
    assert_eq!(
        resolve_node(&|k| env.get(k).cloned(), None, &fs_with(&there)),
        Some(on_path),
    );
}

#[test]
fn present_but_not_executable_is_not_a_runtime() {
    // RUNNABLE, NOT MERELY PRESENT. A file without the execute bit fails the spawn with a permission
    // error rather than NotFound — a different sentence for the same absence, and one that sends
    // whoever reads it looking for the wrong thing. This is also the shape of the real packaging
    // failure being guarded against: a bundler that copies the vendored node WITHOUT its mode.
    let env = env_of(&[("PATH", "/usr/local/bin")]);
    let look = |p: &Path| if p == node_at() { Found::File } else { Found::Nothing };
    assert_eq!(resolve_node(&|k| env.get(k).cloned(), Some(&node_at()), &look), None);
}

#[test]
fn a_build_whose_runtime_was_stripped_says_so_and_names_the_way_out() {
    // The engine is there and the runtime is not — a modified or half-copied install. It must not
    // report "not configured" at somebody whose environment is perfectly fine, and it must not
    // report "no engine" about an engine that is right there.
    let env = full_env();
    let there = vec![engine_at()];
    let look = fs_with(&there);
    match plan(&|k| env.get(k).cloned(), Some(res()), Some(Path::new("/data")), &look) {
        Plan::Inert(EngineState::Failed { reason, last }) => {
            assert!(last.is_none(), "nothing ran, so there is no exit to report");
            assert!(reason.contains(NODE_PATH_VAR), "the escape hatch is not named: {reason}");
            assert!(reason.contains("Node"), "{reason}");
        }
        other => panic!("expected a failed plan naming the runtime, got {other:?}"),
    }
}

#[test]
fn a_build_with_no_engine_in_its_resources_is_the_preview_and_not_a_failure() {
    // The interface preview is a real artifact, not a broken one. It has a runtime available and no
    // engine, and the honest state is `Absent` with the path it looked at — the same state this
    // shell reported for its whole life before the engine was packaged with it.
    //
    // It cannot be discovered by spawning any more, which is why the check exists at all: the spawn
    // is now `node`, and `node` is there. A missing engine would surface as a module error and a
    // non-zero exit, i.e. as a crash loop against a build that is behaving exactly as intended.
    let env = full_env();
    let there = vec![node_at()];
    let look = fs_with(&there);
    match plan(&|k| env.get(k).cloned(), Some(res()), Some(Path::new("/data")), &look) {
        Plan::Inert(EngineState::Absent { looked_for }) => {
            assert_eq!(looked_for, engine_at().display().to_string());
        }
        other => panic!("expected an absent plan, got {other:?}"),
    }
}

#[test]
fn the_engine_does_not_need_the_execute_bit_because_nothing_executes_it() {
    // It is handed to node BY NAME. Requiring the bit would report "no engine" about an engine that
    // is present and perfectly usable — a real risk, since the bit survives four repackagers
    // (dmg, deb, AppImage, NSIS) and only three of them have a mode field at all.
    let env = full_env();
    let look = |p: &Path| {
        if p == engine_at() { Found::File } else if p == node_at() { Found::Runnable } else { Found::Nothing }
    };
    match plan(&|k| env.get(k).cloned(), Some(res()), Some(Path::new("/data")), &look) {
        Plan::Spawn(launch) => assert_eq!(launch.args, vec![engine_at().into_os_string()]),
        other => panic!("expected a spawn plan, got {other:?}"),
    }
}

#[test]
fn with_no_resource_directory_at_all_nothing_is_started() {
    let env = full_env();
    match plan(&|k| env.get(k).cloned(), None, Some(Path::new("/data")), &fs_with(&packaged())) {
        Plan::Inert(EngineState::Absent { looked_for }) => {
            assert!(looked_for.contains(ENGINE_PATH_VAR), "{looked_for}");
        }
        other => panic!("expected an absent plan, got {other:?}"),
    }
}

/// The real probe, against a real file, in both directions. Everything above injects a filesystem;
/// this is the one test that pins what the SHIPPED predicate actually answers — without it the
/// injected tests would all be consistent with a `look` that was wrong.
#[test]
#[cfg(unix)]
fn the_shipped_probe_tells_runnable_from_merely_present() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new("probe");
    let plain = fixture.dir.join("plain.mjs");
    fs::write(&plain, "// not executable\n").expect("write");
    fs::set_permissions(&plain, fs::Permissions::from_mode(0o644)).expect("chmod");
    assert_eq!(look(&plain), Found::File);

    let runnable = fixture.dir.join("runnable");
    fs::write(&runnable, "#!/bin/sh\n").expect("write");
    fs::set_permissions(&runnable, fs::Permissions::from_mode(0o755)).expect("chmod");
    assert_eq!(look(&runnable), Found::Runnable);

    assert_eq!(look(&fixture.dir), Found::Nothing, "a directory is not a file");
    assert_eq!(look(&fixture.dir.join("nothing-here")), Found::Nothing);
}

// ── Starting, and what "running" means ──────────────────────────────────────────────────────

#[test]
fn the_engine_is_running_when_it_says_it_is_serving() {
    let fixture = Fixture::new("serving");
    let engine = Engine::spawn_with(fixture.launch("serve"), quick());

    wait_for(
        || matches!(engine.state(), EngineState::Serving { .. }),
        Duration::from_secs(20),
        "the engine to announce itself",
    );
    assert_eq!(engine.state(), EngineState::Serving { mailbox_id: "mbx-1".to_string() });
    assert_eq!(fixture.starts(), 1);

    let ready = engine.ready().expect("a serving engine has said ready");
    assert_eq!(ready.base_url, "http://sidecar");
    assert_eq!(ready.mailbox_id, "mbx-1");
    assert_eq!(ready.session_token.expose(), format!("tok_{}", "a".repeat(24)));

    #[cfg(unix)]
    assert!(alive(engine.pid().expect("a running engine has a pid")), "the engine process is running");

    // AND IT KEEPS RUNNING, because this process is holding its stdin open.
    //
    // Added after a mutation went the wrong colour: replacing the piped stdin with `Stdio::null()`
    // left every behavioural test green, because a null stdin is EOF and the engine leaving
    // immediately looks like the engine leaving politely. The pipe being OPEN — and privately
    // held — is the invariant, and this is the line that can see it.
    thread::sleep(Duration::from_millis(300));
    assert_eq!(
        engine.state(),
        EngineState::Serving { mailbox_id: "mbx-1".to_string() },
        "still serving a moment later"
    );
    assert!(engine.last_exit().is_none(), "nothing has ended: {:?}", engine.last_exit());
    assert_eq!(fixture.exits(), 0, "the engine has not left: {:?}", fixture.lines());

    engine.stop();
}

#[test]
fn a_process_that_never_says_ready_is_never_reported_as_serving() {
    // The whole reason `ready` is the signal: a locked data directory, a missing credential or a
    // failed migration all produce a process that exists and will never serve.
    let fixture = Fixture::new("never-ready");
    let engine = Engine::spawn_with(fixture.launch("die"), quick());

    wait_for(
        || matches!(engine.state(), EngineState::Failed { .. }),
        Duration::from_secs(30),
        "the restart budget to run out",
    );
    assert!(engine.ready().is_none(), "nothing ever announced itself");
    match engine.state() {
        EngineState::Failed { last: Some(exit), .. } => {
            assert!(!exit.served, "the run never served");
            assert_eq!(exit.code, Some(1));
        }
        other => panic!("expected a failed state carrying the last exit, got {other:?}"),
    }
    engine.stop();
}

// ── Quitting: the defect this slice exists to prevent ───────────────────────────────────────

#[test]
fn quitting_leaves_no_engine_behind() {
    let fixture = Fixture::new("quit");
    let engine = Engine::spawn_with(fixture.launch("serve"), quick());
    wait_for(
        || matches!(engine.state(), EngineState::Serving { .. }),
        Duration::from_secs(20),
        "the engine to announce itself",
    );
    let pid = engine.pid().expect("a running engine has a pid");

    engine.stop();

    assert_eq!(engine.state(), EngineState::Stopped);
    // Three independent proofs, because "the supervisor says it stopped it" is the claim under
    // test rather than evidence for it: the engine ran its own exit handler, the kernel gave us
    // an exit status for it, and the kernel no longer has the process.
    assert_eq!(fixture.exits(), 1, "the engine ran its exit handler: {:?}", fixture.lines());
    assert_eq!(engine.last_exit().expect("the run ended").code, Some(0));
    #[cfg(unix)]
    assert!(!alive(pid), "process {pid} is gone");
    let _ = pid;
}

#[test]
fn quitting_closes_the_engines_input_rather_than_killing_it() {
    // The distinction matters: EOF on stdin is what makes the engine finish its in-flight work,
    // close IMAP and close its database in that order. A kill skips all three.
    let fixture = Fixture::new("graceful");
    let engine = Engine::spawn_with(fixture.launch("serve"), quick());
    wait_for(
        || matches!(engine.state(), EngineState::Serving { .. }),
        Duration::from_secs(20),
        "the engine to announce itself",
    );

    let began = Instant::now();
    engine.stop();

    // It left of its own accord, well inside the grace period — it was asked, not killed.
    assert!(
        began.elapsed() < quick().stop_grace,
        "left in {:?}, which is inside the {:?} grace period",
        began.elapsed(),
        quick().stop_grace
    );
    assert_eq!(fixture.exits(), 1);
}

#[test]
fn an_engine_that_ignores_the_ask_is_killed_rather_than_left_running() {
    let fixture = Fixture::new("deaf");
    let engine = Engine::spawn_with(fixture.launch("serve-deaf"), quick());
    wait_for(
        || matches!(engine.state(), EngineState::Serving { .. }),
        Duration::from_secs(20),
        "the engine to announce itself",
    );
    let pid = engine.pid().expect("a running engine has a pid");

    let began = Instant::now();
    engine.stop();

    assert!(began.elapsed() >= quick().stop_grace, "the grace period was waited out before killing");
    assert_eq!(engine.state(), EngineState::Stopped);
    // No exit line: a killed process does not run its own exit handler, which is exactly why this
    // case needs the operating system's account of it rather than the engine's.
    assert_eq!(fixture.exits(), 0);
    #[cfg(unix)]
    assert_eq!(
        engine.last_exit().expect("the run ended").code,
        None,
        "a signal ended it, and the kernel reaped it"
    );
    #[cfg(unix)]
    assert!(!alive(pid), "process {pid} is gone");
    let _ = pid;
}

#[test]
fn stopping_twice_is_the_same_as_stopping_once() {
    // The shell stops the engine when the window is destroyed and again when the app exits, and
    // on Windows and Linux both fire.
    let fixture = Fixture::new("twice");
    let engine = Engine::spawn_with(fixture.launch("serve"), quick());
    wait_for(
        || matches!(engine.state(), EngineState::Serving { .. }),
        Duration::from_secs(20),
        "the engine to announce itself",
    );
    engine.stop();
    engine.stop();
    assert_eq!(engine.state(), EngineState::Stopped);
    assert_eq!(fixture.starts(), 1, "nothing was restarted by the second stop");
}

#[test]
fn a_stopped_engine_is_not_restarted() {
    let fixture = Fixture::new("no-resurrect");
    let engine = Engine::spawn_with(fixture.launch("serve"), quick());
    wait_for(
        || matches!(engine.state(), EngineState::Serving { .. }),
        Duration::from_secs(20),
        "the engine to announce itself",
    );
    engine.stop();
    thread::sleep(Duration::from_millis(300));
    assert_eq!(fixture.starts(), 1);
    assert_eq!(engine.state(), EngineState::Stopped);
}

// ── Supervision: noticing, restarting, and knowing when to stop ─────────────────────────────

#[test]
fn an_engine_that_dies_is_noticed_and_restarted_a_bounded_number_of_times() {
    let fixture = Fixture::new("crashloop");
    let engine = Engine::spawn_with(fixture.launch("serve-then-die"), quick());

    wait_for(
        || matches!(engine.state(), EngineState::Failed { .. }),
        Duration::from_secs(30),
        "the restart budget to run out",
    );
    assert_eq!(fixture.starts(), MAX_STARTS as usize, "one start and three restarts: {:?}", fixture.lines());

    match engine.state() {
        EngineState::Failed { reason, last: Some(exit) } => {
            assert!(exit.served, "each run did serve before dying");
            assert_eq!(exit.code, Some(9));
            assert!(reason.contains("stopped restarting"), "the reason says it gave up: {reason}");
            assert!(reason.contains("another copy"), "the reason names the likely cause: {reason}");
        }
        other => panic!("expected a failed state, got {other:?}"),
    }

    // And it stays down. A supervisor that gave up and then quietly tried again would be the
    // restart loop with extra steps.
    thread::sleep(Duration::from_millis(400));
    assert_eq!(fixture.starts(), MAX_STARTS as usize);
    engine.stop();
}

#[test]
fn a_stray_write_to_the_frame_stream_is_fatal_to_that_run() {
    // The engine goes to some length to keep its stdout pure, because a length-prefixed stream
    // has no resync point. If prose ever reaches it anyway, the only correct response is to end
    // the run — and to say so, because the symptom otherwise appears nowhere near the cause.
    let fixture = Fixture::new("noise");
    let engine = Engine::spawn_with(fixture.launch("noise"), quick());

    wait_for(
        || matches!(engine.state(), EngineState::Failed { .. }),
        Duration::from_secs(30),
        "the restart budget to run out",
    );
    assert_eq!(fixture.starts(), MAX_STARTS as usize);
    assert_eq!(fixture.exits(), MAX_STARTS as usize, "every run ended: {:?}", fixture.lines());
    engine.stop();
}

#[test]
fn stopping_during_a_restart_delay_does_not_wait_the_delay_out() {
    let mut timings = quick();
    timings.backoff_base = Duration::from_secs(30);
    timings.backoff_cap = Duration::from_secs(30);
    let fixture = Fixture::new("interrupt-backoff");
    let engine = Engine::spawn_with(fixture.launch("die"), timings);

    wait_for(
        || matches!(engine.state(), EngineState::Restarting { .. }),
        Duration::from_secs(20),
        "the supervisor to enter its restart delay",
    );
    let began = Instant::now();
    engine.stop();
    assert!(began.elapsed() < Duration::from_secs(5), "stop returned in {:?}", began.elapsed());
    assert_eq!(engine.state(), EngineState::Stopped);
}

#[test]
fn the_restart_delay_backs_off_and_is_capped() {
    let t = Timings::default();
    assert_eq!(backoff(2, t), Duration::from_secs(1));
    assert_eq!(backoff(3, t), Duration::from_secs(2));
    assert_eq!(backoff(4, t), Duration::from_secs(4));
    assert_eq!(backoff(9, t), RESTART_BACKOFF_CAP);
}

// ── The contract, and the things that must never be printed ─────────────────────────────────

#[test]
fn the_session_token_is_not_printable() {
    // The `ready` frame carries the credential the UI authenticates with. It travels in-band on a
    // pipe nobody else holds, and it stays private only if nothing formats it.
    let ready = Ready {
        base_url: "http://sidecar".to_string(),
        account_id: "acc-1".to_string(),
        user_id: "usr-1".to_string(),
        mailbox_id: "mbx-1".to_string(),
        session_token: Secret("tok_do_not_print_me".to_string()),
        credential_state: CredentialState::Ready,
    };
    let printed = format!("{ready:?}");
    assert!(!printed.contains("tok_do_not_print_me"), "the token reached a Debug output: {printed}");
    assert!(printed.contains("<redacted>"));
    assert_eq!(ready.session_token.expose(), "tok_do_not_print_me");
}

#[test]
fn the_serving_state_names_the_mailbox_and_nothing_else() {
    // Deliberately not the data directory: a path under the user's home carries their account
    // name, and the shell that set it already knows what it is.
    let state = EngineState::Serving { mailbox_id: "mbx-1".to_string() };
    let printed = format!("{state:?}");
    assert!(printed.contains("mbx-1"));
    assert!(!printed.to_lowercase().contains("token"));
}

#[test]
fn frame_contract_is_the_engines() {
    // These four numbers belong to the engine's codec, not to this shell. They are asserted here
    // so that changing one is a deliberate act with a red test attached — this file cannot reach
    // the engine's own source, so it cannot do better than that, and saying so is the point.
    assert_eq!(PROTOCOL_VERSION, 1);
    assert_eq!(PREAMBLE_BYTES, 8);
    assert_eq!(MAX_HEADER_BYTES, 64 * 1024);
    assert_eq!(MAX_BODY_BYTES, 32 * 1024 * 1024);
}

#[test]
fn default_timings_are_the_shipped_ones() {
    let t = Timings::default();
    assert_eq!(t.stop_grace, STOP_GRACE);
    assert_eq!(t.healthy_for, HEALTHY_FOR);
    assert_eq!(t.backoff_base, RESTART_BACKOFF_BASE);
    assert_eq!(t.backoff_cap, RESTART_BACKOFF_CAP);
    assert_eq!(MAX_STARTS, 4);
}

// ── The bridge: a request down the pipe, an answer back ─────────────────────────────────────
//
// The transport is what makes `engine.rs` load-bearing rather than a lifecycle nobody consults.
// Everything below runs against a real child over a real pipe, for the reason stated at the top of
// this file: a correlation map tested against a fake stream would prove nothing about the failure
// that matters, which is a UI waiting for ever on an engine that is not going to answer.

/// Wait until the engine reports `Serving`, or fail saying what it reported instead.
fn serving(engine: &Engine) {
    wait_for(|| matches!(engine.state(), EngineState::Serving { .. }), Duration::from_secs(10), "Serving");
}

fn get(path: &str) -> EngineRequest {
    EngineRequest {
        method: "GET".to_string(),
        url: format!("http://sidecar{path}"),
        headers: vec![("accept".to_string(), "application/json".to_string())],
        body: Vec::new(),
    }
}

#[test]
fn a_request_crosses_the_pipe_and_the_answer_comes_back() {
    let f = Fixture::new("echo");
    let engine = Engine::spawn_with(f.launch("echo"), quick());
    serving(&engine);

    let answer = engine.request(get("/mailboxes")).expect("the engine answered");
    assert_eq!(answer.status, 200);
    assert_eq!(answer.status_text, "OK");
    assert!(answer.headers.iter().any(|(k, v)| k == "content-type" && v == "application/json"));

    // The body is the engine's own account of what it received, so this asserts what crossed the
    // pipe rather than what this process believes it sent.
    let said: serde_json::Value = serde_json::from_slice(&answer.body).expect("json");
    assert_eq!(said["method"], "GET");
    assert_eq!(said["url"], "http://sidecar/mailboxes");

    engine.stop();
}

#[test]
fn the_shell_adds_the_authorization_and_the_caller_cannot() {
    // THE POINT OF THE WHOLE ARRANGEMENT. The per-launch session token is the engine's credential;
    // it reaches the child and never the caller. A caller that could set the header could also read
    // back what it set, which is the one way a token gets out of this process.
    let f = Fixture::new("auth");
    let engine = Engine::spawn_with(f.launch("echo"), quick());
    serving(&engine);

    let mut req = get("/health");
    req.headers.push(("Authorization".to_string(), "Bearer i-chose-this".to_string()));
    let answer = engine.request(req).expect("the engine answered");

    let said: serde_json::Value = serde_json::from_slice(&answer.body).expect("json");
    let headers = said["h"].as_array().expect("headers");
    let auth: Vec<&str> = headers
        .iter()
        .filter(|pair| pair[0].as_str().is_some_and(|k| k.eq_ignore_ascii_case("authorization")))
        .map(|pair| pair[1].as_str().unwrap_or(""))
        .collect();
    assert_eq!(auth.len(), 1, "exactly one authorization reached the engine: {auth:?}");
    assert_eq!(auth[0], format!("Bearer tok_{}", "a".repeat(24)));
    assert!(!auth[0].contains("i-chose-this"), "the caller's authorization was forwarded");

    engine.stop();
}

#[test]
fn a_root_relative_path_is_composed_against_the_engines_own_base() {
    // THE JOIN NOBODY WAS TESTING, and it was broken.
    //
    // The window's client addresses the engine with root-relative paths — `/sync?since=0`,
    // `/mailboxes` — because naming a host in the webview's bundle is the one thing that bundle
    // must never do. The engine parses what arrives with the platform's `Request`, which requires
    // an absolute URL and throws on a relative one; the whole point of the `baseUrl` in the ready
    // frame is that this side owns the composition.
    //
    // Every layer was tested with its own convention and nothing tested the seam: the Rust tests
    // below compose absolute URLs by hand, and the engine's own end-to-end suite drives a client
    // that already carries a base. So a root-relative request — the only kind the window actually
    // sends — reached the engine verbatim and came back as a transport failure.
    let f = Fixture::new("relative");
    let engine = Engine::spawn_with(f.launch("echo"), quick());
    serving(&engine);

    let answer = engine
        .request(EngineRequest {
            method: "GET".to_string(),
            url: "/sync?since=0".to_string(),
            headers: Vec::new(),
            body: Vec::new(),
        })
        .expect("the engine answered");
    let said: serde_json::Value = serde_json::from_slice(&answer.body).expect("json");
    assert_eq!(said["url"], "http://sidecar/sync?since=0");

    // An absolute URL is passed through untouched — the shell composes, it does not rewrite.
    let answer = engine.request(get("/mailboxes")).expect("the engine answered");
    let said: serde_json::Value = serde_json::from_slice(&answer.body).expect("json");
    assert_eq!(said["url"], "http://sidecar/mailboxes");

    engine.stop();
}

#[test]
fn a_request_body_reaches_the_engine_intact() {
    let f = Fixture::new("body");
    let engine = Engine::spawn_with(f.launch("echo"), quick());
    serving(&engine);

    let answer = engine
        .request(EngineRequest {
            method: "POST".to_string(),
            url: "http://sidecar/rules".to_string(),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: br#"{"from":"petra@nordlys.example"}"#.to_vec(),
        })
        .expect("the engine answered");
    let said: serde_json::Value = serde_json::from_slice(&answer.body).expect("json");
    assert_eq!(said["method"], "POST");
    assert_eq!(said["body"], r#"{"from":"petra@nordlys.example"}"#);

    engine.stop();
}

#[test]
fn an_engine_that_dies_mid_request_fails_the_caller_instead_of_hanging() {
    // THE ACCEPTANCE FOR THE WHOLE CORRELATION MAP, and the reason there is no timer in this file.
    //
    // `mute` accepts the request and answers nothing. Killing it must fail the caller — a promise
    // that never settles is a spinner for ever with no log line near the cause. Mutate
    // `drain_waiting` out of the run-end path and this test hangs until the harness kills it,
    // which is exactly what a user would experience.
    let f = Fixture::new("mute");
    let engine = Arc::new(Engine::spawn_with(f.launch("mute"), quick()));
    serving(&engine);

    let asking = Arc::clone(&engine);
    let caller = thread::spawn(move || asking.request(get("/sync")));

    // Give the request time to be written and registered before the engine is taken away.
    thread::sleep(Duration::from_millis(150));
    let pid = engine.pid().expect("a running engine");
    // Taken away the way the platform takes a process away. Windows ships no `kill`, so this
    // shelled out to a program that does not exist there and failed with "could not kill the
    // engine" — a message about the test's own tooling, not about the shell under test. What is
    // asserted is unchanged: a request in flight when the engine dies must FAIL the caller rather
    // than hang for ever. Only the manner of the killing is per-platform. `/T` takes the process
    // tree, which is what `kill -9` on the child amounts to here.
    let killed = if cfg!(windows) {
        std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .status()
            .expect("taskkill runs")
    } else {
        std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .expect("kill runs")
    };
    assert!(killed.success(), "could not kill the engine");

    let answer = caller.join().expect("the calling thread did not panic");
    let err = answer.expect_err("a killed engine answered a request");
    assert!(!err.is_empty(), "the failure said nothing");

    engine.stop();
}

#[test]
fn a_request_before_serving_is_refused_by_name() {
    // Every state that is not `Serving` gets its own sentence, because "the request failed" is the
    // one answer that helps nobody decide what to render.
    let engine = Engine::inert(EngineState::Absent { looked_for: "/nowhere/ohmail-engine".to_string() });
    let err = engine.request(get("/sync")).expect_err("an absent engine answered");
    assert!(err.contains("no local engine"), "{err}");

    let engine = Engine::inert(EngineState::NoKey { reason: "the keystore is locked".to_string() });
    let err = engine.request(get("/sync")).expect_err("a keyless engine answered");
    assert_eq!(err, "the keystore is locked");
}

#[test]
fn the_credential_state_rides_on_the_ready_frame() {
    let f = Fixture::new("cred");
    let engine = Engine::spawn_with(f.launch("echo"), quick());
    serving(&engine);
    assert_eq!(engine.ready().expect("ready").credential_state, CredentialState::Ready);
    engine.stop();
}

#[test]
fn an_engine_that_says_nothing_about_credentials_is_unknown_and_not_absent() {
    // An older engine sends no `credentialState`. Reading that as "no password" would put a
    // password prompt in front of somebody whose mailbox is working.
    assert_eq!(CredentialState::parse(None), CredentialState::Unknown);
    assert_eq!(CredentialState::parse(Some("nonsense")), CredentialState::Unknown);
    assert_eq!(CredentialState::parse(Some("absent")), CredentialState::Absent);
    assert_eq!(CredentialState::parse(Some("unreadable")), CredentialState::Unreadable);
    assert_eq!(CredentialState::parse(Some("ready")), CredentialState::Ready);
}

#[test]
fn the_status_the_window_can_read_carries_no_token() {
    // `engine_status` is the one thing a page may read about the engine, and the token is the one
    // thing it must never contain. Asserted on the serialization rather than on the struct, because
    // the serialization is what crosses.
    let f = Fixture::new("status");
    let engine = Engine::spawn_with(f.launch("echo"), quick());
    serving(&engine);

    let printed = status_json(&engine).to_string();
    assert!(printed.contains("\"state\":\"serving\""), "{printed}");
    assert!(printed.contains("mbx-1"));
    assert!(printed.contains("\"credentialState\":\"ready\""), "{printed}");
    assert!(!printed.contains("tok_"), "the session token reached the window: {printed}");
    assert!(!printed.to_lowercase().contains("sessiontoken"), "{printed}");

    engine.stop();
}

#[test]
fn a_key_is_sixty_four_hex_characters_and_nothing_else() {
    assert!(is_key(&"a".repeat(64)));
    assert!(is_key(&"0123456789abcdef".repeat(4)));
    assert!(!is_key(&"a".repeat(63)));
    assert!(!is_key(&"a".repeat(65)));
    assert!(!is_key(&"g".repeat(64)));
    assert!(!is_key(""));
}

// ── Adopting the key an earlier version of this app stored ──────────────────────────────────
//
// The order is the correctness, and it is driven here rather than against a keychain: the real
// keystore on the machine running these tests holds that person's real key, so a test that used it
// would either be asserting things about their install or writing over it. `resolve_install_key`
// exists as a separate function for exactly this reason — everything it can do, it does through the
// four closures below, and there is no fifth closure that could delete anything.

/// What a run of [`resolve_install_key`] did, in order.
#[derive(Default)]
struct Keystore {
    calls: Mutex<Vec<String>>,
}

impl Keystore {
    fn note(&self, what: &str) {
        self.calls.lock().expect("calls").push(what.to_string());
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("calls").clone()
    }
}

fn a_key(seed: char) -> String {
    seed.to_string().repeat(64)
}

#[test]
fn this_apps_own_key_wins_and_nothing_else_is_consulted() {
    let store = Keystore::default();
    let key = a_key('a');
    let got = resolve_install_key(&Keystores {
        file: &|| {
            store.note("file");
            Stored::Empty
        },
        own: &|| {
            store.note("own");
            Stored::Key(key.clone())
        },
        older: &|| {
            store.note("older");
            Stored::Key(a_key('b'))
        },
        write_keystore: &|_| {
            store.note("adopt");
            Ok(())
        },
        write_file: &|_| {
            store.note("mirror");
            Ok(())
        },
        mint: &|| {
            store.note("mint");
            Ok(a_key('c'))
        },
    });
    assert_eq!(got, Ok(key));
    // Not merely "the right key": the older item is not even READ on the ordinary launch, which is
    // what keeps a migration from costing a keychain round trip on every start for ever. The file is
    // read before it and written after it — the mirror is what makes the NEXT launch promptless once
    // this app's signature changes, and it is the only extra work an ordinary launch does.
    assert_eq!(store.calls(), vec!["file", "own", "mirror"]);
}

#[test]
fn a_key_in_the_file_is_used_and_the_keystore_is_not_consulted_at_all() {
    // THE ANTI-FLIP-FLOP. Once the file holds a key, a password has been sealed under it. A launch
    // that asked the keystore first and got the PRE-fallback key back would seal the next password
    // under a key that does not open the last one — the exact silent orphaning the whole of
    // `resolve_install_key` is arranged to prevent, arrived at from the other direction.
    let store = Keystore::default();
    let key = a_key('d');
    let got = resolve_install_key(&Keystores {
        file: &|| {
            store.note("file");
            Stored::Key(key.clone())
        },
        own: &|| {
            store.note("own");
            Stored::Key(a_key('b'))
        },
        older: &|| {
            store.note("older");
            Stored::Key(a_key('e'))
        },
        ..Default::default()
    });
    assert_eq!(got, Ok(key));
    assert_eq!(store.calls(), vec!["file"], "nothing but the file was touched");
}

#[test]
fn a_keystore_that_will_not_give_up_this_apps_key_falls_back_to_the_file() {
    // THE DEFECT THIS EXISTS TO PREVENT, and it is a loop rather than a single failure.
    //
    // An ad-hoc signed app has no Team ID, so macOS records which code may read a keychain item as
    // `cdhash:…` — the hash of that exact binary. Every rebuild changes it, so every update is a
    // different application as far as the keychain is concerned, and it is refused the item the
    // previous version wrote. Refusing the launch there meant: the engine never started, so no
    // password could be sealed, so typing the password again did not stick, so the next restart
    // failed identically. There was no way out from inside the app.
    let store = Keystore::default();
    let minted = a_key('a');
    let got = resolve_install_key(&Keystores {
        file: &|| {
            store.note("file");
            Stored::Empty
        },
        own: &|| {
            store.note("own");
            Stored::Refused("Platform failure: UNIX[No space left on device]".to_string())
        },
        older: &|| {
            store.note("older");
            panic!("a keystore that refused this app's own item cannot answer for an older one")
        },
        write_keystore: &|_| {
            store.note("adopt");
            panic!("a key written back into a keystore that just refused would be unreadable again")
        },
        write_file: &|key| {
            store.note(&format!("mirror {key}"));
            Ok(())
        },
        mint: &|| {
            store.note("mint");
            Ok(minted.clone())
        },
    });
    assert_eq!(got, Ok(minted.clone()), "the launch continues with a key it can keep");
    assert_eq!(
        store.calls(),
        vec!["file".to_string(), "own".to_string(), "mint".to_string(), format!("mirror {minted}")],
        "the fresh key went to the file and nowhere near the keystore that refused"
    );
}

#[test]
fn a_refused_keystore_and_an_unwritable_file_says_so_rather_than_starting_without_a_key() {
    // The one remaining way to have no key at all. It must name BOTH halves: a message that blamed
    // only the keychain would send somebody to fix the thing that is no longer the obstacle.
    let got = resolve_install_key(&Keystores {
        own: &|| Stored::Refused("the keychain is locked".to_string()),
        write_file: &|_| Err("the disk is read-only".to_string()),
        mint: &|| Ok(a_key('c')),
        ..Default::default()
    });
    let err = got.expect_err("a launch with nowhere to keep its key reported success");
    assert!(err.contains("the keychain is locked"), "the keystore's refusal is named: {err}");
    assert!(err.contains("the disk is read-only"), "the file's refusal is named too: {err}");
}

#[test]
fn the_key_an_earlier_version_stored_is_adopted_rather_than_replaced() {
    // THE DEFECT THIS EXISTS TO PREVENT. Without the older lookup, an install whose key was minted
    // by the previous version of this app finds nothing, mints a fresh key, and the engine reports
    // the mailbox password stored months ago as unreadable — with nothing on screen able to say
    // why.
    let store = Keystore::default();
    let existing = a_key('7');
    let got = resolve_install_key(&Keystores {
        own: &|| {
            store.note("own");
            Stored::Empty
        },
        older: &|| {
            store.note("older");
            Stored::Key(existing.clone())
        },
        write_keystore: &|key| {
            store.note(&format!("adopt {key}"));
            Ok(())
        },
        write_file: &|key| {
            store.note(&format!("mirror {key}"));
            Ok(())
        },
        mint: &|| {
            store.note("mint");
            Ok(a_key('c'))
        },
        ..Default::default()
    });
    assert_eq!(got, Ok(existing.clone()), "the launch uses the key that opens the stored password");
    assert_eq!(
        store.calls(),
        vec![
            "own".to_string(),
            "older".to_string(),
            format!("adopt {existing}"),
            format!("mirror {existing}"),
        ],
        "the older key was read, copied to both places, and nothing was minted"
    );
}

#[test]
fn a_copy_that_fails_does_not_cost_the_launch() {
    // The key is in hand and it opens what it opened before. Refusing to start over a bookkeeping
    // failure would trade a working mailbox for a syscall saved on the next launch.
    let existing = a_key('9');
    let got = resolve_install_key(&Keystores {
        older: &|| Stored::Key(existing.clone()),
        write_keystore: &|_| Err("the keystore is read-only".to_string()),
        write_file: &|_| Err("the folder is read-only".to_string()),
        mint: &|| panic!("nothing may be minted once an existing key has been read"),
        ..Default::default()
    });
    assert_eq!(got, Ok(existing), "neither copy failing costs the launch");
}

#[test]
fn nothing_older_and_nothing_of_ours_mints_exactly_one_key() {
    let store = Keystore::default();
    let minted = a_key('f');
    let got = resolve_install_key(&Keystores {
        own: &|| {
            store.note("own");
            Stored::Empty
        },
        older: &|| {
            store.note("older");
            Stored::Empty
        },
        write_keystore: &|_| {
            store.note("adopt");
            Ok(())
        },
        write_file: &|_| {
            store.note("mirror");
            Ok(())
        },
        mint: &|| {
            store.note("mint");
            Ok(minted.clone())
        },
        ..Default::default()
    });
    assert_eq!(got, Ok(minted));
    // A first run on a working keystore still puts the key THERE first. The file is a mirror of it,
    // not a replacement for it, on every machine where the keystore does its job.
    assert_eq!(store.calls(), vec!["own", "older", "mint", "adopt", "mirror"]);
}

#[test]
fn a_first_run_whose_keystore_will_not_take_the_key_refuses_rather_than_running_without_one() {
    // `write_keystore` failing here is not the bookkeeping failure that `a_copy_that_fails` covers:
    // there is no existing key in hand, so a launch that shrugged this off would serve, accept a
    // password, and have nowhere to put it.
    let got = resolve_install_key(&Keystores {
        write_keystore: &|_| Err("the keystore would not store a key".to_string()),
        mint: &|| Ok(a_key('c')),
        ..Default::default()
    });
    let err = got.expect_err("a mint that was never stored was reported as success");
    assert!(err.contains("would not store a key"), "the refusal says what failed: {err}");
}

#[test]
fn an_item_of_ours_that_is_not_a_key_refuses_without_looking_further() {
    // Something wrote it. Minting over it, or quietly using a different key instead, would seal the
    // next password under a key that does not open the last one.
    let store = Keystore::default();
    let got = resolve_install_key(&Keystores {
        file: &|| {
            store.note("file");
            Stored::Empty
        },
        own: &|| {
            store.note("own");
            Stored::Foreign
        },
        older: &|| {
            store.note("older");
            Stored::Key(a_key('b'))
        },
        write_keystore: &|_| {
            store.note("adopt");
            Ok(())
        },
        write_file: &|_| {
            store.note("mirror");
            Ok(())
        },
        mint: &|| {
            store.note("mint");
            Ok(a_key('c'))
        },
    });
    let err = got.expect_err("a foreign item was accepted");
    assert!(err.contains(KEYSTORE_ENTRY), "the refusal names the item to remove: {err}");
    assert_eq!(store.calls(), vec!["file", "own"]);
}

#[test]
fn a_key_file_of_the_wrong_shape_is_stepped_over_rather_than_obeyed() {
    // Unlike the keystore item above, junk in the file is not evidence that something sealed a
    // password under it — the file is this app's own and nothing else writes there. Refusing would
    // turn a stray edit or a truncated write into an app that will not open at all.
    let store = Keystore::default();
    let key = a_key('b');
    let got = resolve_install_key(&Keystores {
        file: &|| {
            store.note("file");
            Stored::Foreign
        },
        own: &|| {
            store.note("own");
            Stored::Key(key.clone())
        },
        write_file: &|_| {
            store.note("mirror");
            Ok(())
        },
        ..Default::default()
    });
    assert_eq!(got, Ok(key));
    assert_eq!(store.calls(), vec!["file", "own", "mirror"], "the good key overwrites the junk");
}

#[test]
fn an_older_item_that_will_not_be_read_stops_the_launch_rather_than_minting_over_it() {
    // The one branch where minting is actively harmful. The first lookup already proved the
    // keystore answers, so an error on the second means there IS an item here that this binary was
    // not allowed to read — and a fresh key would silently orphan whatever it seals.
    let got = resolve_install_key(&Keystores {
        older: &|| Stored::Refused("access denied".to_string()),
        mint: &|| panic!("a key was minted over an item that could not be read"),
        ..Default::default()
    });
    let err = got.expect_err("a refused older item was ignored");
    assert!(err.contains("unreadable"), "the refusal says what minting would cost: {err}");
}

#[test]
fn an_older_item_of_the_wrong_shape_is_not_adopted() {
    let store = Keystore::default();
    let minted = a_key('e');
    let got = resolve_install_key(&Keystores {
        older: &|| Stored::Foreign,
        write_keystore: &|key| {
            store.note(&format!("adopt {key}"));
            Ok(())
        },
        write_file: &|key| {
            store.note(&format!("mirror {key}"));
            Ok(())
        },
        mint: &|| {
            store.note("mint");
            Ok(minted.clone())
        },
        ..Default::default()
    });
    assert_eq!(got, Ok(minted.clone()));
    assert_eq!(
        store.calls(),
        vec!["mint".to_string(), format!("adopt {minted}"), format!("mirror {minted}")],
        "the minted key is stored, and nothing that is not a key is copied anywhere"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn the_older_coordinates_are_the_ones_the_earlier_version_wrote() {
    // These two strings are the previous version's, not this file's, and a disagreement is a
    // migration that finds nothing. Asserted so that changing one is a deliberate act with a red
    // test attached.
    assert_eq!(LEGACY_KEYSTORE_SERVICE, "io.ohmail.desktop");
    assert_eq!(LEGACY_KEYSTORE_ENTRY, "kek.v1");
    // And they are not this app's own, or the "look one place further" would be looking at itself.
    assert_ne!(LEGACY_KEYSTORE_SERVICE, KEYSTORE_SERVICE);
}

// ── The key file ────────────────────────────────────────────────────────────────────────────
//
// Driven against a real directory rather than through closures, because the things that can go
// wrong here are the file's own properties: its mode, and whether what was written comes back.

#[test]
fn the_key_file_is_written_private_and_reads_back() {
    let f = Fixture::new("keyfile");
    let key = a_key('3');
    write_key_file(Some(&f.dir), &key).expect("write the key file");

    assert_eq!(look_up_file(Some(&f.dir)), Stored::Key(key.clone()), "what went in comes back");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(f.dir.join(KEYSTORE_FILE)).expect("stat").permissions().mode();
        // The key that opens the stored mailbox password. Group and other get nothing at all.
        assert_eq!(mode & 0o777, 0o600, "the key file is readable only by its owner");
    }
}

#[test]
fn a_key_file_left_readable_by_others_is_tightened_when_it_is_rewritten() {
    // A backup tool that restores permissions, or an earlier build that was less careful, must not
    // leave the key world-readable for the rest of the install's life.
    let f = Fixture::new("keyfile-mode");
    let path = f.dir.join(KEYSTORE_FILE);
    fs::write(&path, a_key('1')).expect("an existing, wide-open key file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("widen it");
        write_key_file(Some(&f.dir), &a_key('2')).expect("rewrite");
        let mode = fs::metadata(&path).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "rewriting a wide-open key file closes it");
    }
}

#[test]
fn no_key_file_and_no_data_directory_are_both_simply_empty() {
    let f = Fixture::new("keyfile-absent");
    assert_eq!(look_up_file(Some(&f.dir)), Stored::Empty, "a directory with no key file");
    assert_eq!(look_up_file(None), Stored::Empty, "no directory at all");
    // And a file that is not a key is stepped over rather than refused — see the resolver test.
    fs::write(f.dir.join(KEYSTORE_FILE), "not a key").expect("write junk");
    assert_eq!(look_up_file(Some(&f.dir)), Stored::Foreign);
}

#[test]
fn a_key_file_survives_the_restart_that_the_keychain_did_not() {
    // THE WHOLE POINT, end to end and against a real directory: a keystore that refuses this app's
    // own item leaves a key behind that the NEXT launch finds without asking anyone anything. The
    // second resolve is given a keystore that refuses just as hard, and must not mint again — a
    // second mint would be a second key, and the password sealed under the first would not open.
    let f = Fixture::new("keyfile-restart");
    let refuses = || Stored::Refused("Platform failure: UNIX[No space left on device]".to_string());

    let first = resolve_install_key(&Keystores {
        file: &|| look_up_file(Some(&f.dir)),
        own: &refuses,
        write_file: &|key| write_key_file(Some(&f.dir), key),
        mint: &|| Ok(a_key('c')),
        ..Default::default()
    })
    .expect("the first launch recovers");

    let second = resolve_install_key(&Keystores {
        file: &|| look_up_file(Some(&f.dir)),
        own: &refuses,
        write_file: &|_| panic!("the second launch wrote a key file it should have read"),
        mint: &|| panic!("the second launch minted a second key"),
        ..Default::default()
    })
    .expect("the restart works");

    assert_eq!(first, second, "the restart uses the same key, so what was sealed still opens");
}

#[cfg(target_os = "macos")]
#[test]
fn a_keychain_lookup_cannot_put_a_dialog_on_screen_and_the_setting_is_put_back() {
    // The hang this prevents is not hypothetical: with interaction allowed, reading an item this
    // binary is not permitted to read blocks on a login-password dialog instead of returning an
    // error, and the key is resolved before the app has a window of its own to show it in.
    fn allowed() -> u8 {
        let mut state: u8 = 9;
        unsafe { security_ffi::SecKeychainGetUserInteractionAllowed(&mut state) };
        state
    }

    let before = allowed();
    {
        let _quiet = NoKeychainPrompts::hold();
        assert_eq!(allowed(), 0, "a lookup under this guard cannot block on a dialog");
    }
    // Process-wide, so leaving it off would quietly change every later keychain call in this
    // process — including ones that legitimately want to ask.
    assert_eq!(allowed(), before, "the setting is put back when the guard drops");
}

#[test]
fn the_message_for_a_refused_keychain_does_not_send_anybody_to_free_up_disk_space() {
    // macOS reports a keychain item it will not hand over as `errSecErrnoBase + ENOSPC`, so the
    // keyring crate renders a refusal as "No space left on device" on a machine with plenty. The
    // raw string is kept — it is what a search engine will match — and the correction travels with
    // it, because the fix for a full disk cannot fix this and wastes the one person who can.
    let plain = plainly("Platform failure: UNIX[No space left on device]");
    assert!(plain.contains("No space left on device"), "the platform's own words are kept: {plain}");
    assert!(plain.contains("does not mean the disk is full"), "and contradicted: {plain}");
    assert!(plain.contains("keychain"), "and attributed to the keychain: {plain}");

    // Everything else is passed through untouched — a message this does not understand must not be
    // decorated with a guess.
    assert_eq!(plainly("the keychain is locked"), "the keychain is locked");
}

// ── The log file ────────────────────────────────────────────────────────────────────────────

#[test]
fn the_log_rolls_over_at_the_cap_and_keeps_one_generation() {
    let f = Fixture::new("rotate");
    let path = f.dir.join("engine.log");
    let mut log = LogFile::open(path.clone()).expect("open");

    // Just under the cap, then one more line, so the rotation is caused by the cap rather than by
    // an arbitrary call.
    let chunk = vec![b'x'; 64 * 1024];
    let mut written = 0u64;
    while written + chunk.len() as u64 <= LOG_MAX_BYTES {
        log.write(&chunk);
        written += chunk.len() as u64;
    }
    assert!(!f.dir.join("engine.log.old").exists(), "nothing rotated below the cap");

    log.write(b"the line that crosses it\n");
    let old = f.dir.join("engine.log.old");
    assert!(old.exists(), "the previous generation was kept");
    assert_eq!(fs::metadata(&old).expect("old").len(), written, "the whole of it was kept");
    let current = fs::read_to_string(&path).expect("current");
    assert_eq!(current, "the line that crosses it\n", "the new file starts with the line that rolled it");

    // A SECOND rotation replaces the one generation rather than accumulating them, so the space
    // this can take is bounded at two files however long the app runs.
    log.rotate().expect("the second rotation");
    assert!(!f.dir.join("engine.log.old.old").exists(), "generations do not accumulate");
    assert_eq!(
        fs::read_to_string(&old).expect("old"),
        "the line that crosses it\n",
        "the kept generation is the one that was current"
    );
    assert_eq!(fs::read_to_string(&path).expect("current"), "", "the new current file starts empty");
}

#[test]
fn reopening_a_log_appends_and_rotates_from_the_size_it_found() {
    let f = Fixture::new("reopen");
    let path = f.dir.join("engine.log");
    {
        let mut log = LogFile::open(path.clone()).expect("open");
        log.write(b"first run\n");
    }
    {
        let mut log = LogFile::open(path.clone()).expect("reopen");
        log.write(b"second run\n");
    }
    let text = fs::read_to_string(&path).expect("read");
    assert_eq!(text, "first run\nsecond run\n", "a relaunch adds to the account of the last one");
}

#[test]
fn the_shells_lines_and_the_engines_own_diagnostics_both_reach_the_file() {
    // The two halves of what a person needs and a packaged app throws away: this shell's account of
    // starting and stopping, and the engine's own JSON lines. And the one thing that must never be
    // in either — the per-launch session token, which the `ready` frame carries in-band.
    let f = Fixture::new("logfile");
    let path = f.dir.join("engine.log");
    install_log_file(path.clone()).expect("install the log file");

    let engine = Engine::spawn_with(f.launch("serve"), quick());
    serving(&engine);
    engine.stop();

    // Uninstalled before the assertions so nothing else in this binary can add to the file while it
    // is being read.
    *LOG.lock().expect("log") = None;
    let text = fs::read_to_string(&path).expect("the log file exists");

    assert!(text.contains("serving mailbox mbx-1"), "this shell's own account is missing: {text}");
    assert!(text.contains("stopped"), "the stop was not recorded: {text}");
    assert!(text.contains("fake engine up"), "the engine's own stderr never reached the file: {text}");
    assert!(
        !text.contains("tok_"),
        "the session token reached the log file, which is the one thing it may never do: {text}"
    );
}

// ── The two doors ───────────────────────────────────────────────────────────────────────────

#[test]
fn the_cloud_door_asks_for_the_service_and_the_address_rather_than_a_mail_server() {
    // A hosted mirror has no mail server to name and no username to log in with, so the local
    // door's required list would report two variables that do not exist for it as missing — an
    // install that could never start, with a message about IMAP in front of somebody who chose
    // Cloud precisely to avoid it.
    let env: HashMap<String, String> = HashMap::new();
    let plan = plan_with(
        &|k| env.get(k).cloned(),
        Some(res()),
        Some(Path::new("/data")),
        &REQUIRED_CLOUD_VARS,
        &fs_with(&packaged()),
    );
    match plan {
        Plan::Inert(EngineState::NotConfigured { missing }) => {
            assert_eq!(
                missing,
                vec![
                    "OHMAIL_CLOUD_URL".to_string(),
                    "OHMAIL_MAILBOX_ADDRESS".to_string(),
                    "OHMAIL_KEK".to_string(),
                ]
            );
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_hosted_session_is_never_something_the_shell_refuses_to_start_without() {
    // The engine establishes it ITSELF, over the bridge, and seals it. If the shell demanded one it
    // would have to obtain one — which means holding a credential, which is the whole thing this
    // arrangement removes. A cloud door with a URL, an address and a key is a complete launch.
    assert!(
        !REQUIRED_CLOUD_VARS.iter().any(|v| v.contains("TOKEN")),
        "the shell refuses to start without a hosted token: {REQUIRED_CLOUD_VARS:?}"
    );
    let env = env_of(&[
        ("OHMAIL_CLOUD_URL", "https://api.ohmail.app"),
        ("OHMAIL_MAILBOX_ADDRESS", "someone@ohmail.app"),
        ("OHMAIL_KEK", &"0".repeat(64)),
    ]);
    assert!(matches!(
        plan_with(&|k| env.get(k).cloned(), Some(res()), Some(Path::new("/data")), &REQUIRED_CLOUD_VARS, &fs_with(&packaged())),
        Plan::Spawn(_)
    ));
}

#[test]
fn an_inherited_mail_server_setting_does_not_reach_a_cloud_child() {
    // ── WHY THIS SPAWNS A REAL PROCESS ──────────────────────────────────────────────────────
    //
    // `unset_for` returning the right list is a fact about a list. What matters is whether the
    // variable actually reaches the child, and inheritance is the mechanism under test — so this
    // plants one in THIS process's environment, spawns through the same `supervise` the app uses,
    // and reads what the child saw. A cloud engine that inherited an IMAP host refuses to start,
    // which turns a working install into a puzzling failure; and if it ever did NOT refuse, it
    // would be a second organizer on that mailbox.
    let f = Fixture::new("unset");
    std::env::set_var("OHMAIL_IMAP_HOST", "inherited.example.org");

    let mut launch = f.launch("serve");
    launch.env.push((OsString::from("FAKE_REPORT_ENV"), OsString::from("OHMAIL_IMAP_HOST")));
    launch.unset = crate::config::unset_for(&crate::config::Config::Cloud(crate::config::CloudDoor {
        cloud_url: "https://api.ohmail.app".to_string(),
        address: "someone@ohmail.app".to_string(),
    }));

    let engine = Engine::spawn_with(launch, quick());
    serving(&engine);
    engine.stop();
    std::env::remove_var("OHMAIL_IMAP_HOST");

    let reported: Vec<String> = f.lines().into_iter().filter(|l| l.starts_with("env ")).collect();
    assert!(!reported.is_empty(), "the child reported no environment at all: {:?}", f.lines());
    assert!(
        reported.iter().all(|l| l.contains("OHMAIL_IMAP_HOST=<unset>")),
        "a cloud child inherited a mail server: {reported:?}"
    );
}

#[test]
fn a_local_child_still_inherits_what_the_environment_says() {
    // The other direction, and it is not a symmetry worth breaking: inheritance is how a developer
    // configures the local door by hand, and `unset_for` is empty for it.
    let f = Fixture::new("inherit");
    std::env::set_var("OHMAIL_TEST_INHERITED", "yes");

    let mut launch = f.launch("serve");
    launch.env.push((OsString::from("FAKE_REPORT_ENV"), OsString::from("OHMAIL_TEST_INHERITED")));
    let engine = Engine::spawn_with(launch, quick());
    serving(&engine);
    engine.stop();
    std::env::remove_var("OHMAIL_TEST_INHERITED");

    let reported: Vec<String> = f.lines().into_iter().filter(|l| l.starts_with("env ")).collect();
    assert!(
        reported.iter().any(|l| l.contains("OHMAIL_TEST_INHERITED=yes")),
        "the child inherited nothing: {reported:?}"
    );
}

/// THE ONLY WAY THIS WINDOW CAN NAME A PLACE ON THE WEB, and it cannot name one that is not here.
///
/// The command takes a KEY, not a URL, and this is the reason: a URL argument would mean anything
/// that ever got a string into the page could open an arbitrary address in the user's real
/// browser, signed in to everything they are signed in to. So the table is the boundary, and an
/// unknown key has to be a refusal rather than a fallback.
#[test]
fn the_browser_can_only_be_sent_where_this_table_says() {
    // The queries this table is allowed to carry, written out. It used to be "none at all", which
    // was the right rule right up until one destination needed to name a Settings pane — and the
    // property that rule was standing in for is not "no query", it is "no query anything outside
    // this file could have shaped". So the ban stays, with the admitted values named: a new entry
    // that invents a query still fails here, and so does an existing one that grows a parameter.
    const ALLOWED_QUERIES: [&str; 1] = ["settings=mailboxes"];
    for (key, url) in LINKS {
        assert_eq!(link_for(key), Some(url));
        // Every destination is ours, over TLS.
        assert!(url.starts_with("https://ohmail.app/"), "{key} points at {url}");
        // The fragment comes off first: `#/settings` is a route, not a parameter, and splitting on
        // '?' without it would read the fragment as part of the query and never match.
        let before_hash = url.split_once('#').map_or(url, |(head, _)| head);
        if let Some((_, query)) = before_hash.split_once('?') {
            assert!(
                ALLOWED_QUERIES.contains(&query),
                "{key} carries the query {query}, which this table does not admit"
            );
        }
    }
    assert_eq!(link_for("https://elsewhere.test"), None);
    assert_eq!(link_for(""), None);
    assert_eq!(link_for("Account"), None);
}
