//! THE LOCAL ENGINE'S LIFECYCLE — start it with the app, watch it while it runs, and make
//! certain it is gone when the app is.
//!
//! Compiled only under the `local-engine` feature, which is OFF by default. The shell that ships
//! today is an interface preview with no engine in the bundle, and a dormant spawn path inside it
//! would be a capability the preview carries without using. The feature is the artifact boundary:
//! with it off this file is not in the binary at all, so the preview's "it talks to nobody" is a
//! property of the build rather than of a runtime branch that happened not to be taken.
//!
//! ── THE CONTRACT, WHICH IS THE ENGINE'S AND NOT INVENTED HERE ──────────────────────────────
//!
//! The engine is a Node process that speaks **length-prefixed frames over its own stdin and
//! stdout**. There is no TCP listener, no port and no socket: the only party that can reach it is
//! the process holding the pipe, which is this one. Four consequences shape everything below.
//!
//!  1. **stdout is the wire.** Diagnostics go to stderr; the engine goes as far as replacing its
//!     own `process.stdout.write` so that a stray `console.log` cannot inject bytes into a frame.
//!     A length-prefixed stream has no resync point, so a malformed frame is unrecoverable by
//!     construction and the only correct response is to tear the process down.
//!  2. **Closing its stdin is how you ask it to leave.** The engine answers EOF on stdin by
//!     refusing new requests, letting in-flight ones finish, closing IMAP and closing its
//!     database — in that order, because closing the database under a live handler is what
//!     corrupts the local mirror. So the graceful stop here is a `drop`, not a signal.
//!  3. **That same EOF is the orphan defence, and it works even when this process is killed.**
//!     Nothing else holds the write end of that pipe. If the shell dies — cleanly, by panic, or
//!     by `kill -9` — the kernel closes it, the engine reads EOF and shuts itself down. A stray
//!     engine holding an authenticated IMAP connection is therefore not merely handled on the
//!     quit path; it is structurally impossible while the pipe stays private to this process.
//!     **Never hand that stdin to a second child, and never leak the handle.**
//!  4. **Configuration travels in the environment**, and the engine invents nothing: it needs a
//!     data directory and a mailbox to open. The mailbox PASSWORD does not travel that way — it is
//!     typed once and sealed into the engine's own store under a per-install key, and the
//!     environment carries the key instead. See {@link REQUIRED_ENGINE_VARS}.
//!
//! ── THE TWO THINGS THIS SHELL OWNS BESIDES THE PROCESS ─────────────────────────────────────
//!
//! **One item in the operating system's keystore**, and one only: the per-install key the engine
//! seals the mailbox password under. It is minted on first run and handed over at spawn, so the
//! password is typed once and the environment carries a key rather than a secret. See the
//! "one per-install key" section near the bottom of this file.
//!
//! **One log file.** The engine writes its diagnostics to its stderr, and a packaged app has no
//! stderr anybody can read — a double-clicked `.app`, `.exe` or `.desktop` entry has its standard
//! streams pointed at nothing, so every line this shell and its engine produce is discarded
//! exactly when somebody most needs to read one. Both therefore also go to a size-capped file
//! under the platform's own log directory. See [`LogFile`].
//!
//! ── WHAT "RUNNING" MEANS ───────────────────────────────────────────────────────────────────
//!
//! A live pid is not a running engine. The engine announces itself with a single unsolicited
//! `ready` frame once it is serving, and everything that can go wrong at start — a data directory
//! another copy already holds, a credential the keystore did not supply, a schema migration that
//! failed — produces a process that exists and will never serve. So {@link EngineState::Serving}
//! is reached by reading that frame, never by observing that the spawn succeeded.
//!
//! ── EXACTLY ONE ENGINE PER MAILBOX ─────────────────────────────────────────────────────────
//!
//! Two copies of the app launched at once do not produce two engines, and the defence is not in
//! this file. The engine takes an exclusive `O_CREAT|O_EXCL` lock on its data directory before it
//! dials anything, so the second one fails while starting and exits — before an IMAP socket is
//! opened and before any claim is written to the mailbox. The supervisor's part is only to not
//! make that worse: it retries a bounded number of times and then stays down with a reason,
//! rather than hammering a directory another process legitimately owns.

use crate::config::{self, Config, Mode};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;

// ── The frame codec's constants. Mirrored from the engine's own codec ─────────────────────────
//
// These four numbers are the engine's, and a disagreement is a stream that cannot be read. They
// are duplicated here because the shell is Rust and the engine is TypeScript; there is no shared
// artifact to import. `frame_contract_is_the_engines` in the test module records the source, and
// the honest limitation is that it can only assert what this file says, not what the engine says
// — the engine is not published to this repository, so nothing here can compare the two.
const PROTOCOL_VERSION: u64 = 1;
const PREAMBLE_BYTES: usize = 8;
const MAX_HEADER_BYTES: u32 = 64 * 1024;
const MAX_BODY_BYTES: u32 = 32 * 1024 * 1024;

/// The engine's file name inside the app's own resources.
///
/// **`.mjs`, and the extension is load-bearing rather than cosmetic.** The bundle is ESM, and it
/// used to be extensionless — which worked only because it was executed through its own
/// `#!/usr/bin/env node` line and because Node 22.7+ enables module-syntax DETECTION by default.
/// Handed to a runtime by name, an extensionless file's module type is a heuristic over its
/// contents; `.mjs` makes it a fact, on every Node that will ever run this and regardless of what
/// `package.json` happens to sit above it. The bundle still carries its shebang and its execute bit,
/// because running it straight off a checkout is a real thing people do — but nothing SHIPPED
/// depends on the kernel knowing how to run a text file, which is what lets one launch shape work
/// on all three platforms.
pub const ENGINE_FILE_NAME: &str = "ohmail-engine.mjs";

/// Where the packaged engine sits under the app's resource directory: `engine/bin/`, with its
/// migration journal one level up at `engine/drizzle/`.
///
/// **THE TWO HALVES ARE NOT INDEPENDENT, AND THE RELATIONSHIP IS THE ENGINE'S, NOT OURS.** The
/// bundle composes its journal path as `dirname(import.meta.url)/../drizzle`, and esbuild rewrites
/// `import.meta.url` to the OUTPUT file's own URL — so the journal must sit exactly one directory
/// above the bundle or the engine dies in `migrate()` with `ENOENT`, after a successful spawn and a
/// successful start. `scripts/stage-desktop-resources.mjs` is what lays this out and
/// `scripts/verify-engine-boot.mjs` is what watches it fail when it is wrong.
const ENGINE_RESOURCE_DIR: [&str; 2] = ["engine", "bin"];

/// Where the vendored Node runtime sits under the app's resource directory.
const RUNTIME_RESOURCE_DIR: &str = "runtime";

/// An explicit path to the engine bundle, which overrides looking in the app's resources.
pub const ENGINE_PATH_VAR: &str = "OHMAIL_ENGINE";

/// An explicit path to the Node runtime the engine is run with. An operator's override, and the
/// first thing [`resolve_node`] consults.
pub const NODE_PATH_VAR: &str = "OHMAIL_NODE";

/// Where the local mirror lives. Supplied by the shell when the environment does not name one.
pub const DATA_DIR_VAR: &str = "OHMAIL_DATA_DIR";

/// What the shell refuses to spawn the engine without. Naming them beats starting a process whose
/// only outcome is a failed start or an install that can never store a credential.
///
/// The first two are the engine's own requirement: it refuses to start without a mailbox to open,
/// and it invents neither. The third is this shell's, and the distinction matters —
///
/// **The key is the shell's, and the password is not.** The engine seals the mailbox password into
/// its local store under a per-install key-encryption key and reads it back on every later launch,
/// so the environment carries the key and the password is typed once, over the bridge. An engine
/// started WITHOUT a key still runs and still serves the mirror; what it cannot do is store a
/// password, so the user types one into a field that answers 503. That is a worse failure than not
/// starting, because it looks like the product working right up until it does not — which is why
/// the key is on this list even though the engine does not demand it.
///
/// `OHMAIL_IMAP_PASS` was on this list and is deliberately gone: requiring it would mean the
/// password travelled in process state on every launch, which is exactly what sealing it removed.
/// The engine still accepts one if the environment happens to carry it, and this shell never
/// composes it.
pub const REQUIRED_ENGINE_VARS: [&str; 3] = ["OHMAIL_IMAP_HOST", "OHMAIL_IMAP_USER", "OHMAIL_KEK"];

/// The same list for the CLOUD door, where none of the IMAP settings exists.
///
/// A hosted mirror has no mail server to name and no username to log in with — it has an account,
/// reached at a URL, and the shell knows both because the person who signed in told it. The KEK is
/// on this list for exactly the reason it is on the local one: without it the engine comes up,
/// serves, accepts a sign-in and then cannot seal the session, so the next launch is signed out
/// again with nothing on screen able to say why.
///
/// The hosted SESSION is deliberately absent, and that is the whole shape of the cloud door: the
/// engine establishes it itself over the bridge, and the shell holds no credential of any kind.
pub const REQUIRED_CLOUD_VARS: [&str; 3] =
    ["OHMAIL_CLOUD_URL", "OHMAIL_MAILBOX_ADDRESS", "OHMAIL_KEK"];

/// How many times the engine may be started before the shell gives up: one start and three
/// restarts.
///
/// A restart loop against an engine that cannot start is worse than staying down. Every failure
/// mode that is worth restarting for is transient (a crash, a killed process); every one that is
/// not — a locked data directory, a missing credential, a corrupt mirror — fails identically on
/// every attempt, and retrying it forever burns CPU, fills the log and hides the cause.
pub const MAX_STARTS: u32 = 4;

/// A run that served for at least this long, and actually served, is treated as healthy: the
/// restart budget resets. Without this an app left open for a week would spend its fourth restart
/// on the fourth unrelated crash and then refuse to come back.
pub const HEALTHY_FOR: Duration = Duration::from_secs(60);

const RESTART_BACKOFF_BASE: Duration = Duration::from_secs(1);
const RESTART_BACKOFF_CAP: Duration = Duration::from_secs(8);

/// The four durations the supervisor's behaviour is defined by, in one place so a test can watch
/// a five-second grace period expire without taking five seconds.
///
/// A parameter and not an environment variable: a knob read from the environment is a knob a
/// shipped app has, and the shipped app has exactly one set of timings — [`Timings::default`],
/// which is the constants above and is asserted to be.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timings {
    pub stop_grace: Duration,
    pub healthy_for: Duration,
    pub backoff_base: Duration,
    pub backoff_cap: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Timings {
            stop_grace: STOP_GRACE,
            healthy_for: HEALTHY_FOR,
            backoff_base: RESTART_BACKOFF_BASE,
            backoff_cap: RESTART_BACKOFF_CAP,
        }
    }
}

/// How long the engine gets to finish leaving after its stdin is closed, before it is killed.
///
/// A judgement, not a measurement. What it has to cover is the engine's documented shutdown
/// order — finish in-flight requests, close IMAP, close the database — and the one unbounded term
/// in it is a sync cycle already in progress, which the engine stops re-entering but does not
/// cancel. Long enough that an ordinary quit is never killed; short enough that quitting the app
/// is not something a user waits on. The escalation is a hard kill of a process that may be
/// mid-write, which is the whole reason there is a grace period at all.
pub const STOP_GRACE: Duration = Duration::from_secs(5);

/// How often the supervisor looks at the child. Small enough to be invisible, large enough to
/// cost nothing.
const POLL: Duration = Duration::from_millis(25);

/// A string that must never reach a log, a panic message or a `Debug` derive.
///
/// The engine's `ready` frame carries the per-launch session token — the credential the UI will
/// authenticate with. It travels in-band on a pipe nobody else holds, and it stays that way only
/// if nothing prints it. A newtype makes that a property of the type rather than of every author
/// who ever formats an `EngineState`.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// The only way to read it. Deliberately noisy at the call site.
    ///
    /// Unused outside the tests today, and allowed rather than deleted: the UI wiring slice is
    /// what calls it, and a redaction type that only exists once there is something to redact is
    /// a redaction type that gets added after the first leak.
    #[allow(dead_code)]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// Whether the engine has a mailbox password it can use. Straight off the `ready` frame.
///
/// Serving is not the same as connected, and the difference is the whole reason this travels: the
/// engine comes up and serves the local mirror whether or not it can log in, because a missing
/// password is a prompt rather than a broken app. Without this the shell's only evidence would be
/// that nothing ever syncs, which looks identical to a slow first sync and to an unreachable
/// server.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialState {
    /// There is a password to log in with.
    Ready,
    /// Nothing stored and nothing supplied. Ask for one; nothing is broken and nothing is lost.
    Absent,
    /// A password is stored and this install's key does not open it. Re-entering it re-seals it.
    Unreadable,
    /// The engine sent a value this shell does not know. Newer engine, older shell.
    Unknown,
}

impl CredentialState {
    fn parse(value: Option<&str>) -> CredentialState {
        match value {
            Some("ready") => CredentialState::Ready,
            Some("absent") => CredentialState::Absent,
            Some("unreadable") => CredentialState::Unreadable,
            // ABSENT IS NOT THE FALLBACK, AND THAT IS DELIBERATE. An engine built before this field
            // existed sends nothing, and reading that as "no password" would put a password prompt
            // in front of somebody whose mailbox is working. Unknown says what is true — the shell
            // does not know — and the surface treats it as "carry on".
            _ => CredentialState::Unknown,
        }
    }

    /// The word that goes on screen and in a log line.
    pub fn as_str(self) -> &'static str {
        match self {
            CredentialState::Ready => "ready",
            CredentialState::Absent => "absent",
            CredentialState::Unreadable => "unreadable",
            CredentialState::Unknown => "unknown",
        }
    }
}

/// What the engine said when it started serving.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ready {
    pub base_url: String,
    pub account_id: String,
    pub user_id: String,
    pub mailbox_id: String,
    /// The per-launch bearer token. Never persisted by the engine, never logged by this shell.
    pub session_token: Secret,
    /// See [`CredentialState`]. The value at launch; a password entered later takes effect on the
    /// next one, which is the engine's own rule about its IMAP credentials.
    pub credential_state: CredentialState,
}

/// How a run of the engine ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exit {
    /// `None` on Unix when a signal ended it — which includes this shell's own kill.
    pub code: Option<i32>,
    /// Whether it ever reached `ready`. A process that exits without serving is a start failure,
    /// not a crash, and the two want different words in the log.
    pub served: bool,
    pub ran: Duration,
}

/// Why the shell is not restarting the engine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EngineState {
    /// There is no engine to run. The window is the interface preview, which is what the shell
    /// has always been; this is not an error and nothing retries.
    Absent { looked_for: String },
    /// There is an engine, and nothing to point it at — or no key to seal a credential under.
    /// Naming the variables beats starting a process that fails, or one that runs and then
    /// refuses to remember the password somebody just typed.
    NotConfigured { missing: Vec<String> },
    /// The operating system's keystore would not give up this install's key, or take a new one.
    ///
    /// Distinct from every other refusal because the recovery is the user's rather than ours —
    /// unlocking a keychain, granting an app access it was denied. Nothing is started: an engine
    /// without a key serves the mirror and then refuses to remember a password somebody typed,
    /// which is a worse failure than a window that says what is wrong.
    NoKey { reason: String },
    Starting { attempt: u32 },
    /// Serving: the `ready` frame arrived.
    Serving { mailbox_id: String },
    Restarting { attempt: u32, delay: Duration, last: Exit },
    /// Asked to leave, and gone.
    Stopped,
    /// Down and staying down. `reason` is a sentence, because it is the only thing anyone will
    /// have to work from.
    Failed { reason: String, last: Option<Exit> },
}

/// Everything needed to start the engine once.
#[derive(Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// Overlaid on the shell's own environment, which the engine otherwise inherits.
    pub env: Vec<(OsString, OsString)>,
    /// Variables REMOVED from what the child would otherwise inherit.
    ///
    /// Inheritance is the default and is right for almost everything. It is wrong for one case:
    /// the cloud door, where an `OHMAIL_IMAP_*` left in this process's environment is a variable
    /// the engine refuses to start with — and correctly so, since a cloud install must have no
    /// path to a mailbox at all. Overwriting with an empty string would also work, because the
    /// engine reads empty as absent; removing says what is meant. See `config::unset_for`.
    pub unset: Vec<OsString>,
}

impl fmt::Debug for Launch {
    /// Names its environment and prints no value.
    ///
    /// Nothing composed here is secret TODAY — it is one data directory — and this is written
    /// before it is needed rather than after: the keystore slice's whole job is to put a key in
    /// this field, and a derived `Debug` would put that key in the first panic message that
    /// formats a `Plan`. The seam is known, so the redaction goes in with the seam.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Launch")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("env", &self.env.iter().map(|(k, _)| k).collect::<Vec<_>>())
            .field("unset", &self.unset)
            .finish()
    }
}

/// What the shell decided to do about the engine, before doing any of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    Spawn(Launch),
    /// Nothing to run, and a state that says why.
    Inert(EngineState),
}

/// What one look at a path found.
///
/// Three answers and not two, because the engine and the runtime are held to DIFFERENT bars and
/// collapsing them gets one of the two wrong. The engine bundle is handed to Node by name, so a
/// readable regular file is all it has to be. The runtime is executed, so it has to be executable —
/// **runnable, not merely present**: a directory at that path, or a file without the execute bit,
/// would fail the spawn with a permission error rather than `NotFound`, which is a *different
/// sentence* for the same absence and sends whoever reads it looking for the wrong thing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Found {
    /// Nothing there, or a directory. Neither an engine nor a runtime.
    Nothing,
    /// A regular file. Enough to hand to a Node runtime by name.
    File,
    /// A regular file this process could execute. On Windows every regular file is this, which is
    /// the honest answer on a platform where executability is the loader's decision and not a bit.
    Runnable,
}

/// One look at one path, against the real filesystem. The shipped shell's probe; the tests pass
/// their own so every branch of [`plan_with`] is reachable without a temp directory.
pub fn look(path: &Path) -> Found {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => {
            if executable(&meta) {
                Found::Runnable
            } else {
                Found::File
            }
        }
        _ => Found::Nothing,
    }
}

#[cfg(unix)]
fn executable(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable(_meta: &fs::Metadata) -> bool {
    true
}

/// `node` on Unix, `node.exe` on Windows.
fn node_file_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

/// The Node runtime the engine will be run with, or `None` when this machine has none.
///
/// ── THE SHIPPED APP CARRIES ITS OWN NODE, AND THAT IS THE POINT ─────────────────────────────
///
/// The engine is a Node program. Until this shell resolved a runtime it relied on the bundle's
/// `#!/usr/bin/env node` line and on `node` being on the child's `PATH` — which is true in a
/// terminal and false everywhere a shipped app is actually opened. A Finder or launchd launch on
/// macOS has a `PATH` of `/usr/bin:/bin:/usr/sbin:/sbin`: no Homebrew, no nvm, no node. A Windows
/// shell has no shebang mechanism at all, so a text file with a `#!` line is not executable by any
/// means — the spawn fails with a format error whatever `PATH` says. So the runtime is resolved
/// HERE, explicitly, and passed to the child as `<node> <engine.js>`.
///
/// Order, most specific first:
///
///  1. [`NODE_PATH_VAR`] — an operator's exact override, and the escape hatch the failure message
///     names.
///  2. The **vendored** runtime in the app's own resources. This is the one that must win on a
///     normal machine: it is what makes the download standalone, and it is a known-good version
///     rather than whatever the user happens to have.
///  3. The platform's usual package locations — Homebrew on Apple silicon and then the Intel/older
///     prefix on macOS, `/usr/local/bin` then `/usr/bin` on Linux, the default installer directory
///     on Windows. A development checkout has no vendored runtime and this is what covers it.
///  4. Whatever the inherited `PATH` already carries.
///
/// Every candidate has to come back [`Found::Runnable`].
pub fn resolve_node(
    get: &dyn Fn(&str) -> Option<String>,
    vendored: Option<&Path>,
    look: &dyn Fn(&Path) -> Found,
) -> Option<PathBuf> {
    let consider = |path: PathBuf| -> Option<PathBuf> { (look(&path) == Found::Runnable).then_some(path) };

    if let Some(explicit) = get(NODE_PATH_VAR).filter(|v| !v.trim().is_empty()) {
        if let Some(found) = consider(PathBuf::from(explicit)) {
            return Some(found);
        }
    }
    if let Some(found) = vendored.and_then(|p| consider(p.to_path_buf())) {
        return Some(found);
    }
    for candidate in DEFAULT_NODE_LOCATIONS {
        if let Some(found) = consider(PathBuf::from(candidate)) {
            return Some(found);
        }
    }
    // `PATH` last, and split with the platform's own separator — `;` on Windows, where a `:` split
    // would cut every entry in half at its drive letter.
    let separator = if cfg!(windows) { ';' } else { ':' };
    for dir in get("PATH").unwrap_or_default().split(separator) {
        if dir.trim().is_empty() {
            continue;
        }
        if let Some(found) = consider(Path::new(dir).join(node_file_name())) {
            return Some(found);
        }
    }
    None
}

#[cfg(target_os = "macos")]
const DEFAULT_NODE_LOCATIONS: &[&str] = &["/opt/homebrew/bin/node", "/usr/local/bin/node"];
#[cfg(target_os = "windows")]
const DEFAULT_NODE_LOCATIONS: &[&str] = &[r"C:\Program Files\nodejs\node.exe"];
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const DEFAULT_NODE_LOCATIONS: &[&str] = &["/usr/local/bin/node", "/usr/bin/node"];

/// Decide whether there is an engine to start, and how.
///
/// `look` is the ONLY way this function touches the filesystem, and it is a parameter so the whole
/// decision stays a function of its arguments — the tests drive every branch without a temp
/// directory, and the shipped shell passes [`look`].
///
/// It used to touch nothing at all: whether the engine existed was answered by trying to start it
/// and reading `NotFound` back. **That stopped working when the spawn stopped being the engine.**
/// What is spawned now is the Node runtime, which exists; a missing engine would come back as a
/// module error on the child's stderr and a non-zero exit — i.e. as a crash loop rather than as the
/// interface preview it actually is. So presence is asked before the spawn, once, and the preview's
/// honest state survives the change.
///
/// ── WHY THE PROBE IS INJECTED RATHER THAN THIS LIVING ONE LAYER UP ──────────────────────────
///
/// The obvious alternative is to keep this function literally filesystem-free and resolve the
/// engine and the runtime in [`ShellPaths::plan_now`], which already reads a file and a keystore.
/// It was refused for two reasons. The decision is ONE decision — is there an engine, is there
/// something to run it with, is it configured — and splitting it would leave `plan_now`
/// post-processing a `Plan::Spawn` to swap its own `program` and `args` back in, which is a second
/// place for the launch shape to drift from the first. And `plan_now` is the layer the tests cannot
/// reach: it opens the real keystore. Injecting the probe keeps every branch below reachable from a
/// test — including the two that only exist on a broken install — where moving it up would make the
/// real filesystem the only implementation any of them ever ran against.
///
/// ── ONE RESIDUAL, NAMED RATHER THAN LEFT TO BE FOUND ────────────────────────────────────────
///
/// The runtime is resolved ONCE, here, and the resulting [`Launch`] is what the supervisor restarts
/// from. A Node that disappears mid-run — a Homebrew upgrade under a development build using the
/// PATH fallback — therefore fails all remaining restarts identically instead of re-resolving. It
/// cannot happen to a shipped install, whose runtime is inside its own bundle and goes away only
/// with the app.
pub fn plan(
    get: &dyn Fn(&str) -> Option<String>,
    resources: Option<&Path>,
    data_dir_fallback: Option<&Path>,
    look: &dyn Fn(&Path) -> Found,
) -> Plan {
    plan_with(get, resources, data_dir_fallback, &REQUIRED_ENGINE_VARS, look)
}

/// [`plan`], with the list of variables the door in question cannot start without.
///
/// The list is a parameter because the two doors need different ones and everything else about the
/// decision is identical: where the engine is, whether the data directory is known, and what to
/// report when something is missing. A second copy of this function per door would be two places
/// for the resource-layout rule to drift.
pub fn plan_with(
    get: &dyn Fn(&str) -> Option<String>,
    resources: Option<&Path>,
    data_dir_fallback: Option<&Path>,
    required: &[&str],
    look: &dyn Fn(&Path) -> Found,
) -> Plan {
    let engine = match get(ENGINE_PATH_VAR).filter(|v| !v.trim().is_empty()) {
        Some(explicit) => PathBuf::from(explicit),
        None => match resources {
            Some(dir) => engine_path_in(dir),
            None => {
                return Plan::Inert(EngineState::Absent {
                    looked_for: format!(
                        "{ENGINE_PATH_VAR} is not set and this app's resource directory could not be resolved"
                    ),
                })
            }
        },
    };

    // NO ENGINE IS NOT AN ERROR — it is the interface preview, which is what this shell shipped for
    // its whole life before the engine was packaged with it. A regular file is the whole bar: the
    // bundle is handed to Node by name, so it does not need the execute bit and refusing one that
    // lacks it would report "no engine" about an engine that is right there.
    if look(&engine) == Found::Nothing {
        return Plan::Inert(EngineState::Absent { looked_for: engine.display().to_string() });
    }

    // THE RUNTIME AFTER THE ENGINE AND BEFORE THE CONFIGURATION. A build with no engine has nothing
    // to say about Node; a build WITH one and no runtime is broken in a way no amount of correct
    // configuration fixes, and saying so beats naming three environment variables at somebody whose
    // real problem is a stripped install.
    let vendored = resources.map(vendored_node_in);
    let Some(node) = resolve_node(get, vendored.as_deref(), look) else {
        return Plan::Inert(EngineState::Failed {
            reason: format!(
                "ohmail could not find the Node runtime its mail engine runs on. This build should \
                 carry its own; if it was modified, reinstall ohmail — or set {NODE_PATH_VAR} to a \
                 Node 20+ binary and open ohmail again."
            ),
            last: None,
        });
    };

    let mut missing: Vec<String> = required
        .iter()
        .filter(|name| get(name).filter(|v| !v.trim().is_empty()).is_none())
        .map(|name| (*name).to_string())
        .collect();

    let data_dir = match get(DATA_DIR_VAR).filter(|v| !v.trim().is_empty()) {
        Some(explicit) => Some(OsString::from(explicit)),
        None => data_dir_fallback.map(|p| p.as_os_str().to_os_string()),
    };
    if data_dir.is_none() {
        missing.push(DATA_DIR_VAR.to_string());
    }

    if !missing.is_empty() {
        return Plan::Inert(EngineState::NotConfigured { missing });
    }

    // THE PROGRAM IS THE RUNTIME AND THE ENGINE IS ITS ARGUMENT — on every platform, deliberately.
    //
    // The obvious alternative is to exec the bundle directly and let its `#!` line find Node, which
    // is what this shell did and what the macOS client did before it. It cannot be made to work on
    // Windows at all: there is no shebang mechanism, so a text file is not executable by any means
    // the loader has, and `plan` used to compose `ohmail-engine.exe` — a name the bundler has never
    // emitted. Keeping the direct-exec shape on the two platforms where it CAN work and a second
    // shape on the third would have meant two launch paths, of which only one was ever exercised.
    // One shape, everywhere, and the shebang stays in the file for the developer who runs it by hand.
    Plan::Spawn(Launch {
        program: node,
        args: vec![engine.into_os_string()],
        // ONLY THE DATA DIRECTORY, AND THAT INCLUDES NOT COMPOSING A PASSWORD.
        //
        // Everything else the engine reads is already in the environment this process was given
        // and the child inherits it, so re-listing the variables here would be a second copy of
        // the engine's configuration contract, drifting from the first. The data directory is the
        // exception because it is the one value the shell KNOWS rather than reads: it is derived
        // from the app's own identifier.
        //
        // A first launch looks exactly like every later one. The shell hands over a key, never a
        // password; the password is typed once into the running app and sealed into the engine's
        // store, and the launch after that opens the mailbox from the store. There is no
        // first-run special case to get wrong, and no launch on which a password sits in process
        // state that anything running as this user could read.
        env: vec![(OsString::from(DATA_DIR_VAR), data_dir.expect("checked above"))],
        unset: Vec::new(),
    })
}

/// Where the packaged engine bundle is, given the app's resource directory. One spelling, so the
/// plan and anything that wants to report the layout cannot disagree about it.
pub fn engine_path_in(resources: &Path) -> PathBuf {
    resources.join(ENGINE_RESOURCE_DIR.iter().collect::<PathBuf>()).join(ENGINE_FILE_NAME)
}

/// Where the vendored runtime is, given the app's resource directory.
pub fn vendored_node_in(resources: &Path) -> PathBuf {
    resources.join(RUNTIME_RESOURCE_DIR).join(node_file_name())
}

// ── The supervisor ───────────────────────────────────────────────────────────────────────────

struct Shared {
    state: EngineState,
    /// The way into the engine's stdin, and the only one that exists.
    ///
    /// The pipe itself belongs to a writer thread; this is the channel that feeds it. Dropping
    /// this is still the graceful stop — the thread's receiver ends, the thread returns, the
    /// `ChildStdin` it owns is dropped, and the engine reads EOF. Every property the module header
    /// claims for the raw handle therefore still holds, including the orphan defence: nothing else
    /// in this process or any other holds the write end.
    ///
    /// It is a channel rather than the handle because of what a WRITE does. A 32 MB request would
    /// otherwise be written while holding the state mutex — the same mutex the supervisor takes on
    /// every poll to check the kill deadline — so a full pipe would stall the one loop whose job is
    /// to notice that the engine has stopped reading.
    stdin: Option<SyncSender<Vec<u8>>>,
    /// The current child, while there is one. Test-visible so a test can prove a process is gone
    /// rather than trust that this file reaped it.
    pid: Option<u32>,
    ready: Option<Ready>,
    /// How the last run ended, as the operating system reported it. An exit status exists only
    /// for a process that has terminated and been reaped, which makes this the one piece of
    /// evidence about a dead engine that does not come from this file's own bookkeeping.
    last_exit: Option<Exit>,
    /// Set by the frame reader when the stream stops being readable as frames. Unrecoverable.
    fault: Option<String>,
    stop: bool,
    /// When the current child must be killed if it has not left by itself.
    deadline: Option<Instant>,
    finished: bool,
    /// The next correlation id. Minted here rather than in the webview, so a page cannot collide
    /// two requests onto one id and read somebody else's answer.
    next_id: u64,
    /// Requests sent and not yet answered.
    ///
    /// EMPTIED ON EVERY RUN END, and that is the bridge's liveness mechanism rather than a timer.
    /// A promise that never settles is the worst failure a bridge can have — the UI shows a
    /// spinner for ever and no log says why — so when the engine goes away, every waiter is failed
    /// with a transport error. `HttpAdapter` turns a thrown fetch into a retryable
    /// `MutationRejectedError`, which is the shape it already handles.
    ///
    /// A per-request DEADLINE was considered and refused. The one 12 s bound this product does
    /// have is confined to the attachment LIST on purpose, because aborting a mutation and
    /// retrying it is how one send becomes two. The failure a timer would catch here — an
    /// engine alive but wedged — is a residual this file accepts and the sync surface reports.
    waiting: HashMap<u64, Sender<Result<EngineResponse, String>>>,
}

struct Inner {
    shared: Mutex<Shared>,
    cv: Condvar,
    timings: Timings,
}

fn new_shared(state: EngineState, finished: bool) -> Shared {
    Shared {
        state,
        stdin: None,
        pid: None,
        ready: None,
        last_exit: None,
        fault: None,
        stop: false,
        deadline: None,
        finished,
        next_id: 1,
        waiting: HashMap::new(),
    }
}

/// The engine, its supervisor thread, and the handle that stops both.
pub struct Engine {
    inner: Arc<Inner>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Engine {
    /// An engine that was never going to run: no binary, or nothing to configure it with.
    pub fn inert(state: EngineState) -> Engine {
        log_state(&state);
        Engine {
            inner: Arc::new(Inner {
                shared: Mutex::new(new_shared(state, true)),
                cv: Condvar::new(),
                timings: Timings::default(),
            }),
            thread: Mutex::new(None),
        }
    }

    /// Start the engine and supervise it until [`Engine::stop`] or the restart budget runs out.
    pub fn spawn(launch: Launch) -> Engine {
        Engine::spawn_with(launch, Timings::default())
    }

    pub fn spawn_with(launch: Launch, timings: Timings) -> Engine {
        let inner = Arc::new(Inner {
            shared: Mutex::new(new_shared(EngineState::Starting { attempt: 1 }, false)),
            cv: Condvar::new(),
            timings,
        });
        let worker = Arc::clone(&inner);
        let thread = thread::Builder::new()
            .name("ohmail-engine".into())
            .spawn(move || supervise(worker, launch))
            .expect("ohmail: failed to start the engine supervisor thread");
        Engine { inner, thread: Mutex::new(Some(thread)) }
    }

    /// ── THE THREE READERS, AND WHY THEY HAVE NO CALLER IN THE APP YET ────────────────────
    ///
    /// What the shell knows about the engine, and the seam the UI wiring slice takes:
    /// `base_url` and `session_token` are what a client over the bridge needs, and `state` is
    /// what a strip that says "the engine stopped" would render. That slice is where the webview
    /// gains a way to hear about any of it — which is a Tauri permission, and permissions are
    /// added by the slice that has a use for them, never in advance.
    ///
    /// Allowed rather than deleted because the tests are the caller: an accessor removed now
    /// comes back with the first surface, and the supervisor would ship untested in between.
    #[allow(dead_code)]
    pub fn state(&self) -> EngineState {
        self.inner.shared.lock().expect("engine state").state.clone()
    }

    #[allow(dead_code)]
    pub fn ready(&self) -> Option<Ready> {
        self.inner.shared.lock().expect("engine state").ready.clone()
    }

    /// The running engine's process id, while there is one.
    #[allow(dead_code)]
    pub fn pid(&self) -> Option<u32> {
        self.inner.shared.lock().expect("engine state").pid
    }

    /// How the last run ended, straight from the operating system's exit status.
    #[allow(dead_code)]
    pub fn last_exit(&self) -> Option<Exit> {
        self.inner.shared.lock().expect("engine state").last_exit
    }

    /// Ask the engine to leave, wait for it, and kill it if it will not. Idempotent, and safe to
    /// call from a window-close and again from the app's exit.
    pub fn stop(&self) {
        {
            let mut s = self.inner.shared.lock().expect("engine state");
            if !s.stop {
                s.stop = true;
                s.deadline = Some(Instant::now() + self.inner.timings.stop_grace);
                // ORDER: the stop flag is set before the pipe is closed, under the same lock the
                // supervisor takes to read it. The other order races — the child exits cleanly,
                // the supervisor sees an exit with no stop pending, and restarts the engine the
                // user just quit.
                if s.stdin.take().is_some() {
                    log_line(format_args!(
                        "stopping — closed its input; up to {}ms to finish",
                        self.inner.timings.stop_grace.as_millis()
                    ));
                }
            }
        }
        self.inner.cv.notify_all();
        if let Some(handle) = self.thread.lock().expect("engine thread").take() {
            let _ = handle.join();
        }
    }
}

impl Drop for Engine {
    /// Belt and braces. Tauri's run loop can end the process without unwinding, which is why the
    /// shell also calls [`Engine::stop`] explicitly — but an `Engine` dropped for any other
    /// reason must not leave a child behind either.
    fn drop(&mut self) {
        self.stop();
    }
}

// ── The shell around the engine: which door, and the power to change it ──────────────────────
//
// ── WHY THIS EXISTS AND `Engine` DOES NOT DO IT ──────────────────────────────────────────────
//
// An `Engine` is one run of one child under one configuration, and that is the right shape for it:
// its supervisor thread owns a `Launch` and cannot be handed a different one. What the product
// needs on top is the ability to CHANGE the configuration while the app is open — a person picks a
// door, types their mail server, and expects the app to start working without quitting it. That is
// a lifetime one level up: stop this engine, write the new configuration down, start a different
// engine. `Shell` is that level, and it is also the thing the window's commands are given, so the
// engine underneath can be replaced without the commands holding a stale handle.
//
// ── THE PIECES IT OWNS ───────────────────────────────────────────────────────────────────────
//
//  · the app's own paths, so a spawn does not have to reach back into Tauri;
//  · the per-install key, resolved from the keystore once per plan (see `install_key`);
//  · the configuration file, which is the only durable answer to "which door";
//  · the current engine, behind a lock, replaced whole rather than mutated.

/// Where this install's things are. Resolved once from the Tauri app.
pub struct ShellPaths {
    /// The app's data directory. `config.json` sits in it and the per-mode mirrors under it.
    pub app_data: Option<PathBuf>,
    /// The app's RESOURCE directory — where the engine and its Node runtime are looked for when
    /// nothing names them explicitly.
    ///
    /// **Tauri's, and not derived from the executable's own directory, because the three platforms
    /// do not agree on the relationship.** A macOS bundle puts resources in `Contents/Resources/`
    /// while the binary is in `Contents/MacOS/`; a Linux `.deb` puts the binary in `/usr/bin` and
    /// its resources in `/usr/lib/ohmail/`; Windows puts both in the install directory. Composing
    /// that mapping here would be a second copy of something the framework already owns, and it is
    /// the copy that would be wrong on whichever platform nobody tested.
    pub resources: Option<PathBuf>,
}

impl ShellPaths {
    pub fn config_path(&self) -> Option<PathBuf> {
        self.app_data.as_ref().map(|d| d.join(config::CONFIG_FILE_NAME))
    }

    /// The configuration this install came in by, if it has one.
    pub fn config(&self) -> Option<Config> {
        self.config_path().as_deref().and_then(config::read)
    }

    /// Decide what to start, from the stored configuration or from the environment.
    ///
    /// ── THE PRECEDENCE, WHICH IS DELIBERATELY NOT "CONFIG WINS EVERYWHERE" ──────────────────
    ///
    /// A stored configuration composes the engine's environment ENTIRELY: its data directory, its
    /// mode and its settings, all derived from the door it names. Nothing inherited can contribute,
    /// which is the point — a stale `OHMAIL_DATA_DIR` left in somebody's shell must not silently
    /// point a cloud door at a local door's mirror.
    ///
    /// With NO stored configuration the shell falls back to reading the environment, which is the
    /// development path and the only way a launch is reproducible by hand. That fallback keeps its
    /// historic data directory — the app's data root, not a per-mode subdirectory — because
    /// changing it would move an existing developer's mirror out from under them for no gain.
    ///
    /// The KEY is resolved here in both cases and never comes from the file. The environment wins
    /// where it is set; otherwise the keystore answers, and a keystore that will not is
    /// [`EngineState::NoKey`] rather than a launch without a key — an engine with no key comes up,
    /// serves, accepts a password and then cannot store it, which is the failure that looks like
    /// the product working right up until it does not.
    pub fn plan_now(&self, config: Option<&Config>) -> Plan {
        let from_env = std::env::var(KEK_VAR).ok().filter(|v| !v.trim().is_empty());
        let key = match from_env {
            Some(key) => Ok(key),
            None => install_key(self.app_data.as_deref()),
        };
        let key = match key {
            Ok(key) => key,
            Err(reason) => return Plan::Inert(EngineState::NoKey { reason }),
        };

        let stored;
        let config = match config {
            Some(c) => Some(c),
            None => {
                stored = self.config();
                stored.as_ref()
            }
        };

        let resources = self.resources.as_deref();
        match config {
            Some(config) => {
                let Some(root) = self.app_data.as_deref() else {
                    return Plan::Inert(EngineState::NotConfigured {
                        missing: vec![DATA_DIR_VAR.to_string()],
                    });
                };
                let mut env = config::env_for(config, root);
                env.push((OsString::from(KEK_VAR), OsString::from(key)));

                // The composed environment answers first and the process's own second, so the
                // "missing" report below is about what will ACTUALLY be handed over.
                let composed: Vec<(String, String)> = env
                    .iter()
                    .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
                    .collect();
                let get = move |name: &str| -> Option<String> {
                    composed
                        .iter()
                        .find(|(k, _)| k == name)
                        .map(|(_, v)| v.clone())
                        .or_else(|| std::env::var(name).ok())
                };
                let required: &[&str] = match config.mode() {
                    Mode::Local => &REQUIRED_ENGINE_VARS,
                    Mode::Cloud => &REQUIRED_CLOUD_VARS,
                };
                match plan_with(&get, resources, None, required, &look) {
                    Plan::Spawn(mut launch) => {
                        // `plan_with` decided WHETHER and WHERE; the environment is composed here,
                        // whole, replacing the single data-directory pair it put there.
                        launch.env = env;
                        launch.unset = config::unset_for(config);
                        Plan::Spawn(launch)
                    }
                    inert => inert,
                }
            }
            None => {
                let resolved = key.clone();
                let get = move |name: &str| -> Option<String> {
                    if name == KEK_VAR {
                        Some(resolved.clone())
                    } else {
                        std::env::var(name).ok()
                    }
                };
                match plan(&get, resources, self.app_data.as_deref(), &look) {
                    Plan::Spawn(mut launch) => {
                        // Composed here rather than in `plan`, because `plan` touches nothing
                        // outside its arguments and the keystore is emphatically outside them.
                        // `Launch`'s `Debug` prints the NAMES of its environment and never the
                        // values — written before there was a value worth hiding, for this line.
                        launch.env.push((OsString::from(KEK_VAR), OsString::from(key)));
                        Plan::Spawn(launch)
                    }
                    inert => inert,
                }
            }
        }
    }
}

/// The app's engine, its configuration, and the two actions that change either.
pub struct Shell {
    paths: ShellPaths,
    /// Replaced whole on a reconfigure. `Arc` because a command may be answering out of it while
    /// another is swapping it, and the answer must come from the engine it started against.
    engine: Mutex<Arc<Engine>>,
}

impl Shell {
    /// THE LOG IS OPENED FIRST, because the states worth reading about are the ones the shell can
    /// reach before it has started anything: a keystore that would not answer, an engine that is
    /// not there, a variable nobody set. Opening it later would put exactly the lines a person
    /// needs on a stream a packaged app discards.
    ///
    /// The path comes from the platform rather than from this file — `~/Library/Logs/<id>` on
    /// macOS, `~/.local/share/<id>/logs` on Linux, `%APPDATA%\<id>\logs` on Windows — so the file
    /// is where that platform's users and its crash reporters already look. A failure to open one
    /// is reported and is not fatal: an app that will not start because it could not open its log
    /// has turned a diagnostic into an outage.
    pub fn open_log(app: &tauri::App) {
        use tauri::Manager;
        match app.path().app_log_dir() {
            Ok(dir) => {
                if let Err(reason) = install_log_file(dir.join(LOG_FILE_NAME)) {
                    log_line(format_args!("no log file — {reason}"));
                }
            }
            Err(err) => {
                log_line(format_args!("no log file — this platform named no log directory ({err})"))
            }
        }
    }

    pub fn paths(app: &tauri::App) -> ShellPaths {
        use tauri::Manager;
        ShellPaths {
            app_data: app.path().app_data_dir().ok(),
            resources: app.path().resource_dir().ok(),
        }
    }

    /// Open the log, work out the plan, and start whatever it says.
    pub fn start(app: &tauri::App) -> Shell {
        Shell::open_log(app);
        let paths = Shell::paths(app);
        let engine = match paths.plan_now(None) {
            Plan::Spawn(launch) => Engine::spawn(launch),
            Plan::Inert(state) => Engine::inert(state),
        };
        Shell { paths, engine: Mutex::new(Arc::new(engine)) }
    }

    /// For tests and for the commands: the engine as it is right now.
    pub fn engine(&self) -> Arc<Engine> {
        Arc::clone(&self.engine.lock().expect("shell engine"))
    }

    /// Ask the engine to leave. Idempotent, and safe from a window-close and again from the exit.
    pub fn stop(&self) {
        self.engine().stop();
    }

    /// Replace the running engine with one started from `next`.
    ///
    /// STOP BEFORE SPAWN, ALWAYS. The engine takes an exclusive lock on its data directory, so a
    /// new one started before the old one has gone fails to start — and it fails in the way that
    /// looks worst, because "another copy already holds this directory" is also what a genuine
    /// second instance of the app reports.
    fn replace(&self, plan: Plan) {
        let mut slot = self.engine.lock().expect("shell engine");
        slot.stop();
        *slot = Arc::new(match plan {
            Plan::Spawn(launch) => Engine::spawn(launch),
            Plan::Inert(state) => Engine::inert(state),
        });
    }

    /// Write down which door this install comes in by, and restart the engine behind it.
    ///
    /// The configuration is written BEFORE the engine is touched: a write that fails leaves a
    /// running engine and an unchanged file, which is the state somebody can retry from. The
    /// reverse order would take the app down to report a full disk.
    pub fn configure(&self, value: &serde_json::Value) -> Result<serde_json::Value, String> {
        let config = config::parse(value)?;
        let path = self.paths.config_path().ok_or_else(|| {
            "this computer named no place for the app to keep its settings".to_string()
        })?;
        config::write(&path, &config)?;
        log_line(format_args!(
            "configured for the {} door; the engine's data directory is {}",
            config.mode().as_str(),
            config.mode().dir_name()
        ));
        self.replace(self.paths.plan_now(Some(&config)));
        Ok(self.status())
    }

    /// Forget the account: clear the engine's sealed secrets, stop it, and forget the door.
    ///
    /// ── WHAT IS REMOVED, AND THE MUCH LONGER LIST OF WHAT IS NOT ────────────────────────────
    ///
    /// Removed: the credential the engine sealed (the mailbox password on the local door, the
    /// hosted session on the cloud one) and `config.json`. That is all of it.
    ///
    /// NOT removed, each for its own reason:
    ///
    ///  · **The mirror.** Either door's mirror is a copy — of the user's own server, or of a hosted
    ///    account — and a door switch freezes the directory it leaves rather than deleting it.
    ///    Signing out to look at the other door and back should not cost a full re-sync.
    ///  · **The keystore item.** The per-install key is per INSTALL, not per account: it is what
    ///    the NEXT account's credential will be sealed under, and deleting it would make every
    ///    frozen mirror's stored credential permanently unreadable rather than merely unused.
    ///
    /// The clear goes over the BRIDGE when the engine is serving, because the local door's sealed
    /// password lives inside the mirror's database and only the engine can reach it. The cloud
    /// door's sealed session is a file, so it is also removed directly — which is what covers the
    /// case where the engine was not serving and there was nothing to ask.
    pub fn logout(&self) -> Result<serde_json::Value, String> {
        let config = self.paths.config();

        if let Some(config) = &config {
            let path = match config.mode() {
                Mode::Local => "/local/stored-login",
                Mode::Cloud => "/cloud/session",
            };
            let answer = self.engine().request(EngineRequest {
                method: "DELETE".to_string(),
                url: path.to_string(),
                headers: Vec::new(),
                body: Vec::new(),
            });
            match answer {
                // BEST EFFORT, and the fallbacks below are why that is not a shrug. An engine that
                // is not serving has nothing in memory to clear, and the file removal covers the
                // durable half. Reporting a failure here would refuse a sign-out because the thing
                // being signed out of was already down.
                Ok(res) if (200..300).contains(&res.status) => {}
                Ok(res) => log_line(format_args!(
                    "signing out: the engine answered {} to {path}; the sealed session is removed \
                     from disk regardless",
                    res.status
                )),
                Err(reason) => log_line(format_args!(
                    "signing out: the engine could not be asked to clear its stored credential \
                     ({reason}); the sealed session is removed from disk regardless"
                )),
            }
        }

        // The engine goes down before the files move: it holds the data directory, and removing a
        // file underneath a process that has it open is the kind of thing that works on one
        // platform and does not on another.
        self.engine().stop();

        if let (Some(Config::Cloud(_)), Some(root)) = (&config, self.paths.app_data.as_deref()) {
            if let Err(reason) = config::remove_sealed_session(root, Mode::Cloud) {
                log_line(format_args!("signing out: {reason}"));
            }
        }

        if let Some(path) = self.paths.config_path() {
            config::remove(&path)?;
        }
        log_line(format_args!("signed out; the mirror and this install's key are left as they are"));

        // NOT a re-plan. After a sign-out the honest state is "nothing is configured", and
        // re-planning would start an engine again from whatever the environment happens to say —
        // which on a developer's machine is the door the person just left.
        self.replace(Plan::Inert(EngineState::NotConfigured {
            missing: vec![config::CONFIG_FILE_NAME.to_string()],
        }));
        Ok(self.status())
    }

    /// What the window renders. See [`status_json`]; this adds the facts only the shell holds.
    pub fn status(&self) -> serde_json::Value {
        let mut out = status_json(&self.engine());
        if let Some(object) = out.as_object_mut() {
            match self.paths.config() {
                Some(config) => {
                    object.insert("mode".into(), config.mode().as_str().into());
                    if let Some(address) = config.address() {
                        object.insert("address".into(), address.into());
                    }
                }
                // NAMED RATHER THAN OMITTED. A window that reads an absent `mode` as "still
                // loading" would spin for ever on a fresh install, which is exactly the state that
                // most needs to reach the door picker.
                None => {
                    object.insert("mode".into(), serde_json::Value::Null);
                }
            }
        }
        out
    }
}

impl Inner {
    fn set_state(&self, state: EngineState) {
        log_state(&state);
        self.shared.lock().expect("engine state").state = state;
    }

    fn stopping(&self) -> bool {
        self.shared.lock().expect("engine state").stop
    }

    /// Sleep, unless and until the engine is asked to stop. Returns true if it was.
    fn sleep_unless_stopped(&self, d: Duration) -> bool {
        let guard = self.shared.lock().expect("engine state");
        let (guard, _) = self
            .cv
            .wait_timeout_while(guard, d, |s| !s.stop)
            .expect("engine state");
        guard.stop
    }

    fn finish(&self) {
        let mut s = self.shared.lock().expect("engine state");
        s.finished = true;
        s.stdin = None;
    }
}

fn supervise(inner: Arc<Inner>, launch: Launch) {
    let mut attempt: u32 = 1;
    loop {
        if inner.stopping() {
            inner.set_state(EngineState::Stopped);
            break;
        }
        inner.set_state(EngineState::Starting { attempt });

        let mut command = Command::new(&launch.program);
        // NO CONSOLE WINDOW BEHIND THE ENGINE ON WINDOWS.
        //
        // `main.rs` builds this app for the `windows` subsystem, so the shell itself has no console.
        // The child does not inherit that: `node.exe` is a CONSOLE-subsystem program, and spawning
        // one from a GUI process makes Windows allocate a console for it — a black window that sits
        // beside the app for the whole of the engine's life and reappears on every restart. It is
        // invisible on macOS and Linux, and it did not exist at all while the engine was executed
        // through a shebang, so nothing about the port would have surfaced it.
        //
        // 0x08000000 is `CREATE_NO_WINDOW`, spelled out rather than pulled from `winapi` for one
        // constant. The engine's stderr is piped and teed to the log file either way, so nothing a
        // console would have shown is lost.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        command
            .args(&launch.args)
            // Piped, all three, and each for its own reason. stdin because the write end must
            // belong to this process and nothing else — that is the graceful stop and the orphan
            // defence at once. stdout because it is the frame stream. stderr because inheriting
            // it on a windowed build hands the child a handle that may not exist, and because a
            // pipe nobody drains blocks the writer once it fills.
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // REMOVE FIRST, THEN SET. The two lists never overlap today, and doing it in this order
        // means they never can: a variable that is both cleared and composed keeps the composed
        // value, which is the one the shell decided on.
        for key in &launch.unset {
            command.env_remove(key);
        }
        for (key, value) in &launch.env {
            command.env(key, value);
        }

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                inner.set_state(EngineState::Absent {
                    looked_for: launch.program.display().to_string(),
                });
                break;
            }
            Err(err) => {
                inner.set_state(EngineState::Failed {
                    reason: format!("the engine at {} could not be started: {err}", launch.program.display()),
                    last: None,
                });
                break;
            }
        };

        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let stdin = child.stdin.take().expect("stdin was piped");
        // BOUNDED, so a UI that outruns the engine is refused rather than buffered without limit.
        // The bound is on frames in flight to the pipe, not on bytes: each one has already passed
        // the pending-request cap, which is the real admission control.
        let (to_engine, from_shell) = mpsc::sync_channel::<Vec<u8>>(16);
        let writer = thread::spawn(move || write_frames(stdin, from_shell));
        {
            let mut s = inner.shared.lock().expect("engine state");
            s.stdin = Some(to_engine);
            s.pid = Some(child.id());
            s.ready = None;
            s.fault = None;
            // THE DEADLINE BELONGS TO ONE RUN, AND CARRYING IT INTO THE NEXT KILLS THE NEXT.
            //
            // Found by the crash-loop tests rather than reasoned about: a run torn down for a
            // protocol fault leaves a deadline in the past, so the following child was killed on
            // the supervisor's first pass — before it had executed far enough to do anything.
            // The restart budget then burnt itself out against a healthy engine, and every
            // symptom pointed at the engine instead of at this line.
            //
            // A stop that arrived between the check above and this lock is the one case where the
            // deadline is still live, and it must survive: that child is already being asked to
            // leave and nothing else will ask again.
            if s.stop {
                s.stdin = None;
            } else {
                s.deadline = None;
            }
        }

        let reader_inner = Arc::clone(&inner);
        let reader = thread::spawn(move || read_frames(stdout, &reader_inner));
        let forwarder = thread::spawn(move || forward_diagnostics(stderr));

        let started = Instant::now();
        let status = wait_for_exit(&inner, &mut child);
        let _ = reader.join();
        let _ = forwarder.join();

        let ran = started.elapsed();
        let (served, fault) = {
            let mut s = inner.shared.lock().expect("engine state");
            // THE SENDER GOES BEFORE THE JOIN, AND THE OTHER ORDER DEADLOCKS.
            //
            // `write_frames` loops over its receiver, which only ends when every sender is dropped
            // — and this field is the last one. Joining first therefore waits for a thread that is
            // waiting for this line, for ever, on every single run end. Found by the drain test
            // hanging rather than reasoned about; the symptom was an app that never noticed its
            // engine had died, which is precisely the failure the drain exists to prevent.
            s.stdin = None;
            s.pid = None;
            (s.ready.is_some(), s.fault.take())
        };
        let _ = writer.join();
        // EVERY WAITER, FAILED, BEFORE ANYTHING ELSE IS DECIDED.
        //
        // This run cannot answer another request: the process is gone and its `ready` is about to
        // be replaced. Whether the shell restarts, quits or gives up, a request that was in flight
        // when the engine died is a request that will never be answered, and saying so is the only
        // honest outcome — the alternative is a caller waiting on a channel whose sender is held by
        // a map nobody will ever look at again.
        drain_waiting(
            &inner,
            fault.as_deref().unwrap_or("the engine stopped before it answered this request"),
        );
        let exit = Exit { code: status.code(), served, ran };
        inner.shared.lock().expect("engine state").last_exit = Some(exit);

        // NOT INDEPENDENTLY OBSERVABLE, AND SAID SO RATHER THAN LEFT LOOKING LOAD-BEARING.
        //
        // Removing this alone leaves every test green: the restart is refused twice more below —
        // by the interruptible delay, and by the check at the top of the loop. What it buys is
        // honesty rather than correctness. Without it a quit walks through `Restarting` and logs
        // "restarting in 20ms" about an engine nobody is going to restart, and the state a
        // surface would render during a quit says the opposite of what is happening.
        if inner.stopping() {
            log_exit(&exit, fault.as_deref());
            inner.set_state(EngineState::Stopped);
            break;
        }
        log_exit(&exit, fault.as_deref());

        // A run that actually served, for long enough to have been useful, is not evidence of a
        // crash loop. Reset the budget so an app left open for days can still recover.
        if served && ran >= inner.timings.healthy_for {
            attempt = 0;
        }
        attempt += 1;
        if attempt > MAX_STARTS {
            inner.set_state(EngineState::Failed {
                reason: format!(
                    "the engine failed {MAX_STARTS} starts in a row, so the shell stopped restarting it. \
                     Quit ohmail and open it again once the cause is fixed — if another copy of ohmail \
                     is already running, that is the cause."
                ),
                last: Some(exit),
            });
            break;
        }

        let delay = backoff(attempt, inner.timings);
        inner.set_state(EngineState::Restarting { attempt, delay, last: exit });
        if inner.sleep_unless_stopped(delay) {
            inner.set_state(EngineState::Stopped);
            break;
        }
    }
    inner.finish();
}

/// Wait for this run of the engine to end, killing it if it has been asked to leave and has not.
fn wait_for_exit(inner: &Arc<Inner>, child: &mut Child) -> ExitStatus {
    let mut killed = false;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status,
            Ok(None) => {}
            Err(err) => {
                // The child cannot be observed. Killing it is the only thing left that keeps the
                // guarantee this file exists for.
                log_line(format_args!("cannot observe the engine ({err}); killing it"));
                let _ = child.kill();
                return child.wait().unwrap_or_else(|_| exit_status_unavailable());
            }
        }

        let deadline = {
            let mut s = inner.shared.lock().expect("engine state");
            // A malformed frame is unrecoverable: a length-prefixed stream has no resync point, so
            // once the two ends disagree about where a frame starts, every later byte is misread.
            // Ask it to leave the same way a quit does, and hold it to the same deadline.
            if s.fault.is_some() && s.deadline.is_none() {
                s.stdin = None;
                s.deadline = Some(Instant::now() + inner.timings.stop_grace);
            }
            s.deadline
        };

        if let Some(deadline) = deadline {
            if !killed && Instant::now() >= deadline {
                killed = true;
                log_line(format_args!(
                    "still running {}ms after being asked to leave; killing it",
                    inner.timings.stop_grace.as_millis()
                ));
                let _ = child.kill();
            }
        }
        thread::sleep(POLL);
    }
}

fn backoff(attempt: u32, timings: Timings) -> Duration {
    let shift = attempt.saturating_sub(2).min(16);
    let delay = timings.backoff_base.saturating_mul(1u32 << shift);
    delay.min(timings.backoff_cap)
}

// ── Reading the wire ─────────────────────────────────────────────────────────────────────────

/// Read frames until the stream ends: record the engine's `ready`, hand each answer to whoever is
/// waiting for it, and skip everything else.
///
/// **A body is read into memory only when something is waiting for it.** A frame body may be 32 MB,
/// so buffering one nobody asked for would be the largest allocation in this shell, and an unknown
/// correlation id is exactly that — a late answer to a request that has already been failed. The
/// reader still has to consume those bytes, and does, by skipping them: a pipe nobody drains blocks
/// the writer once it fills, and an engine blocked on a write it can never finish is a hang with no
/// symptom anywhere near its cause.
fn read_frames(mut stdout: ChildStdout, inner: &Arc<Inner>) {
    let mut preamble = [0u8; PREAMBLE_BYTES];
    loop {
        match read_exact_or_eof(&mut stdout, &mut preamble) {
            Ok(true) => {}
            // EOF, at a frame boundary or part-way through one. Either way the engine is going
            // away and this is not a protocol fault — a partial frame at EOF is a process that
            // died mid-write, which the exit status describes better than this thread could.
            Ok(false) | Err(_) => return,
        }

        let header_len = u32::from_be_bytes([preamble[0], preamble[1], preamble[2], preamble[3]]);
        let body_len = u32::from_be_bytes([preamble[4], preamble[5], preamble[6], preamble[7]]);
        // Both caps are checked before a single byte of either is allocated, and a breach is
        // fatal rather than skipped: a length that is wrong means the stream has already lost
        // frame alignment, and there is nothing to resynchronise to.
        if header_len == 0 || header_len > MAX_HEADER_BYTES {
            fault(inner, format!(
                "a frame declared a {header_len}-byte header, outside 1..{MAX_HEADER_BYTES} — the engine is \
                 not speaking this protocol, or something wrote to its stdout"
            ));
            return;
        }
        if body_len > MAX_BODY_BYTES {
            fault(inner, format!("a frame declared a {body_len}-byte body, over the {MAX_BODY_BYTES}-byte cap"));
            return;
        }

        let mut header = vec![0u8; header_len as usize];
        match read_exact_or_eof(&mut stdout, &mut header) {
            Ok(true) => {}
            Ok(false) | Err(_) => return,
        }

        let action = match accept_header(&header, inner) {
            Ok(action) => action,
            Err(message) => {
                fault(inner, message);
                return;
            }
        };

        match action {
            Answer::None => {
                if !skip(&mut stdout, body_len as u64) {
                    return;
                }
            }
            Answer::Failed { id, message } => {
                if !skip(&mut stdout, body_len as u64) {
                    return;
                }
                deliver(inner, id, Err(message));
            }
            Answer::Response { id, status, status_text, headers } => {
                let mut body = vec![0u8; body_len as usize];
                match read_exact_or_eof(&mut stdout, &mut body) {
                    Ok(true) => {}
                    // The engine died part-way through a response. The waiter is failed by the
                    // run-end drain rather than here, which is the one place that knows why.
                    Ok(false) | Err(_) => return,
                }
                deliver(inner, id, Ok(EngineResponse { status, status_text, headers, body }));
            }
        }
    }
}

/// What one frame header asks the reader to do next.
enum Answer {
    /// Nothing is waiting for this. Skip the body.
    None,
    Response { id: u64, status: u16, status_text: String, headers: Vec<(String, String)> },
    /// The engine could not produce a response at all — distinct from a 5xx, which IS a response.
    Failed { id: u64, message: String },
}

/// Hand one answer to its waiter. A missing waiter is not an error: the request was already failed
/// by a run-end drain, and the engine had no way to know that before it wrote.
fn deliver(inner: &Arc<Inner>, id: u64, answer: Result<EngineResponse, String>) {
    let waiter = inner.shared.lock().expect("engine state").waiting.remove(&id);
    if let Some(waiter) = waiter {
        let _ = waiter.send(answer);
    }
}

/// Fail every outstanding request. See [`Shared::waiting`] — this is the bridge's liveness rule.
fn drain_waiting(inner: &Arc<Inner>, reason: &str) {
    let waiting: Vec<_> = {
        let mut s = inner.shared.lock().expect("engine state");
        s.waiting.drain().map(|(_, tx)| tx).collect()
    };
    for waiter in waiting {
        let _ = waiter.send(Err(reason.to_string()));
    }
}

/// Inspect one frame header. `Err` is a protocol fault and ends the stream.
fn accept_header(header: &[u8], inner: &Arc<Inner>) -> Result<Answer, String> {
    let parsed: serde_json::Value = serde_json::from_slice(header)
        .map_err(|err| format!("a frame header was not JSON: {err}"))?;

    match parsed.get("v").and_then(serde_json::Value::as_u64) {
        Some(PROTOCOL_VERSION) => {}
        other => {
            return Err(format!(
                "a frame declared protocol version {}, and this shell speaks {PROTOCOL_VERSION}",
                other.map_or_else(|| "nothing".to_string(), |v| v.to_string())
            ))
        }
    }

    let kind = parsed.get("t").and_then(serde_json::Value::as_str);

    // ── An answer to something this shell asked for ────────────────────────────────────────
    //
    // A missing or non-integer id is a protocol fault rather than a frame to ignore: the id is how
    // one answer is told from another, and a stream that has stopped supplying it is a stream whose
    // remaining bytes cannot be trusted to belong to anybody in particular.
    if kind == Some("res") || kind == Some("err") {
        let id = parsed
            .get("id")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| format!("a {} frame carried no correlation id", kind.unwrap_or("?")))?;

        if kind == Some("err") {
            let code = parsed.get("code").and_then(serde_json::Value::as_str).unwrap_or("engine_failed");
            let message = parsed.get("message").and_then(serde_json::Value::as_str).unwrap_or("");
            return Ok(Answer::Failed { id, message: format!("{code}: {message}") });
        }

        // Only when somebody is waiting. See the note on `read_frames`: an unknown id is a late
        // answer to a request that has already been failed, and reading its body would be an
        // allocation of up to 32 MB in service of nothing.
        if !inner.shared.lock().expect("engine state").waiting.contains_key(&id) {
            return Ok(Answer::None);
        }

        let status = parsed
            .get("status")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "a res frame carried no status".to_string())?;
        let status_text = parsed
            .get("statusText")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        let mut headers: Vec<(String, String)> = Vec::new();
        if let Some(pairs) = parsed.get("h").and_then(serde_json::Value::as_array) {
            for pair in pairs {
                if let Some(kv) = pair.as_array() {
                    if let (Some(k), Some(v)) = (
                        kv.first().and_then(serde_json::Value::as_str),
                        kv.get(1).and_then(serde_json::Value::as_str),
                    ) {
                        headers.push((k.to_string(), v.to_string()));
                    }
                }
            }
        }
        // `sc` — the response's Set-Cookie array — is deliberately dropped rather than forwarded.
        // The engine is bearer-only (`allowCookieAuth: false`) and mints no cookies; the field
        // exists on the wire so that stays true by evidence rather than by nobody having looked,
        // and there is no cookie jar on this side of the bridge for one to go into.
        return Ok(Answer::Response {
            id,
            status: status.min(u64::from(u16::MAX)) as u16,
            status_text,
            headers,
        });
    }

    if kind != Some("ready") {
        return Ok(Answer::None);
    }

    let field = |name: &str| -> Result<String, String> {
        parsed
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("the engine's ready frame carried no {name}"))
    };
    let ready = Ready {
        base_url: field("baseUrl")?,
        account_id: field("accountId")?,
        user_id: field("userId")?,
        mailbox_id: field("mailboxId")?,
        session_token: Secret(field("sessionToken")?),
        // OPTIONAL, so an engine built before this field existed still starts. Absent reads as
        // `Unknown` and never as `Absent` — see `CredentialState::parse`.
        credential_state: CredentialState::parse(
            parsed.get("credentialState").and_then(serde_json::Value::as_str),
        ),
    };

    let mailbox_id = ready.mailbox_id.clone();
    {
        let mut s = inner.shared.lock().expect("engine state");
        if s.ready.is_some() {
            return Err("the engine announced itself twice; a launch serves once".to_string());
        }
        s.ready = Some(ready);
    }
    // The mailbox id, and nothing else. Not the token, and not the data directory: a directory
    // under the user's home carries their account name, and the shell that set it already knows.
    inner.set_state(EngineState::Serving { mailbox_id });
    Ok(Answer::None)
}

fn fault(inner: &Arc<Inner>, message: String) {
    log_line(format_args!("{message}"));
    let mut s = inner.shared.lock().expect("engine state");
    if s.fault.is_none() {
        s.fault = Some(message);
    }
}

/// Fill `buf`. `Ok(false)` means the stream ended before any of it arrived or part-way through.
fn read_exact_or_eof<R: Read>(reader: &mut R, buf: &mut [u8]) -> io::Result<bool> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => return Ok(false),
            Ok(n) => filled += n,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
            Err(err) => return Err(err),
        }
    }
    Ok(true)
}

fn skip<R: Read>(reader: &mut R, mut remaining: u64) -> bool {
    let mut scratch = [0u8; 64 * 1024];
    while remaining > 0 {
        let want = remaining.min(scratch.len() as u64) as usize;
        match reader.read(&mut scratch[..want]) {
            Ok(0) => return false,
            Ok(n) => remaining -= n as u64,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return false,
        }
    }
    true
}

// ── Writing the wire ─────────────────────────────────────────────────────────────────────────

/// One request, on its way to the engine. Composed from what the webview asked for, plus the
/// authorization the webview never sees.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineRequest {
    pub method: String,
    /// Absolute or root-relative. Composed against the engine's own `baseUrl`.
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// What the engine answered. A status of any kind means the app ran; a transport failure is an
/// `Err` out of [`Engine::request`] instead, which is the shape a dead socket gives a browser.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// How many requests may be outstanding before the shell refuses to send another.
///
/// Admission control, not a performance knob. Without it a page in a loop could queue unboundedly
/// against an engine that has stopped answering, and the first symptom would be memory rather than
/// a message. The API this bridges is a delta-sync client: a drain, a body fetch and a handful of
/// mutations are in flight at once, never dozens.
pub const MAX_PENDING_REQUESTS: usize = 32;

/// Own the engine's stdin and write whatever the shell hands over, in order.
///
/// One thread, so two concurrent requests can never interleave a preamble with somebody else's
/// body — the frame stream has no resync point, so that would end the connection. When the channel
/// closes, this returns and drops the handle: that is the EOF the engine answers by leaving, and it
/// is why [`Engine::stop`] drops a sender rather than a pipe.
fn write_frames(mut stdin: ChildStdin, frames: Receiver<Vec<u8>>) {
    for frame in frames {
        if stdin.write_all(&frame).is_err() || stdin.flush().is_err() {
            // The engine is not reading. Nothing to report here — the supervisor is about to
            // observe the exit, and it is the one that knows how the run ended.
            return;
        }
    }
}

/// A root-relative path, against the base the engine announced when it started serving.
///
/// **The window may not name a host, so this side has to.** The webview's whole bundle is checked
/// for the absence of an address — that is what makes "this page can reach nothing but the shell"
/// something a reader can verify rather than a claim — so its client addresses the engine with
/// paths alone: `/sync?since=0`, `/mailboxes`, `/local/ai`. The engine parses what arrives with the
/// platform's `Request`, which takes an absolute URL and rejects a relative one outright. The
/// `baseUrl` in the ready frame exists for exactly this join.
///
/// Anything already absolute is passed through untouched: the shell composes, it never rewrites.
fn absolute_url(base: &str, url: &str) -> String {
    if url.starts_with('/') {
        format!("{}{}", base.trim_end_matches('/'), url)
    } else {
        url.to_string()
    }
}

/// A `req` frame: preamble, header JSON, body. Mirrors the engine's codec — see the constants at
/// the top of this file, and the note there about there being no shared artifact to import.
fn encode_request(id: u64, req: &EngineRequest, token: &str) -> Result<Vec<u8>, String> {
    let mut headers: Vec<serde_json::Value> = Vec::with_capacity(req.headers.len() + 1);
    for (name, value) in &req.headers {
        // THE CALLER DOES NOT GET TO SUPPLY THIS ONE. The per-launch session token is the engine's
        // credential and it lives on this side of the bridge; a webview that could set the header
        // could also read back what it set, and the whole point of `Secret` is that the token never
        // reaches a page. Dropping it here rather than rejecting the request keeps a stray
        // `Authorization` from a client library harmless instead of fatal.
        if name.eq_ignore_ascii_case("authorization") {
            continue;
        }
        headers.push(serde_json::json!([name, value]));
    }
    headers.push(serde_json::json!(["authorization", format!("Bearer {token}")]));

    let header = serde_json::json!({
        "v": PROTOCOL_VERSION,
        "t": "req",
        "id": id,
        "method": req.method,
        "url": req.url,
        "h": headers,
    });
    let header_bytes = serde_json::to_vec(&header).map_err(|err| format!("could not encode the request: {err}"))?;
    if header_bytes.len() > MAX_HEADER_BYTES as usize {
        return Err(format!("the request's headers are over the {MAX_HEADER_BYTES}-byte cap"));
    }
    if req.body.len() > MAX_BODY_BYTES as usize {
        return Err(format!("the request body is over the {MAX_BODY_BYTES}-byte cap"));
    }

    let mut frame = Vec::with_capacity(PREAMBLE_BYTES + header_bytes.len() + req.body.len());
    frame.extend_from_slice(&(header_bytes.len() as u32).to_be_bytes());
    frame.extend_from_slice(&(req.body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&header_bytes);
    frame.extend_from_slice(&req.body);
    Ok(frame)
}

impl Engine {
    /// Ask the engine one question and wait for its answer.
    ///
    /// Blocks the calling thread. There is no timer — see [`Shared::waiting`] — so the ways this
    /// returns are: the engine answered, the engine went away, or the shell would not send it.
    ///
    /// **The authorization is added here and cannot be supplied by the caller.** That is what lets
    /// the webview run the unmodified Cloud sync client against a local engine: it needs no token,
    /// so there is none for it to leak, log or store.
    pub fn request(&self, req: EngineRequest) -> Result<EngineResponse, String> {
        let rx = {
            let mut s = self.inner.shared.lock().expect("engine state");

            // A NAMED REFUSAL PER STATE, because "the request failed" is the one answer that helps
            // nobody. Everything except `Serving` means there is no engine listening, and the
            // reason a surface should render differs in each case.
            let (token, base) = match (&s.state, &s.ready) {
                (EngineState::Serving { .. }, Some(ready)) => {
                    (ready.session_token.expose().to_string(), ready.base_url.clone())
                }
                (EngineState::Serving { .. }, None) => {
                    return Err("the engine is serving but announced no session".to_string())
                }
                (EngineState::Absent { .. }, _) => {
                    return Err("there is no local engine in this build".to_string())
                }
                (EngineState::NotConfigured { missing }, _) => {
                    return Err(format!("the engine has not been configured: nothing set {}", missing.join(", ")))
                }
                (EngineState::NoKey { reason }, _) => return Err(reason.clone()),
                (EngineState::Starting { .. }, _) => {
                    return Err("the engine is still starting".to_string())
                }
                (EngineState::Restarting { .. }, _) => {
                    return Err("the engine stopped and is being restarted".to_string())
                }
                (EngineState::Stopped, _) => return Err("the engine has stopped".to_string()),
                (EngineState::Failed { reason, .. }, _) => return Err(reason.clone()),
            };

            if s.waiting.len() >= MAX_PENDING_REQUESTS {
                return Err(format!(
                    "{MAX_PENDING_REQUESTS} requests are already waiting on the engine; this one was not sent"
                ));
            }
            let writer = match s.stdin.clone() {
                Some(writer) => writer,
                None => return Err("the engine's input has been closed".to_string()),
            };

            let id = s.next_id;
            s.next_id += 1;
            // COMPOSED HERE, against what the engine announced — see [`absolute_url`].
            let req = EngineRequest { url: absolute_url(&base, &req.url), ..req };
            let frame = encode_request(id, &req, &token)?;

            let (tx, rx) = mpsc::channel();
            s.waiting.insert(id, tx);
            // Under the lock ON PURPOSE, and this is the same ordering argument `stop()` makes: a
            // send that raced the run-end drain would leave a waiter registered against a run that
            // has already been drained, and nothing would ever answer it.
            if writer.send(frame).is_err() {
                s.waiting.remove(&id);
                return Err("the engine stopped reading its input".to_string());
            }
            rx
        };

        rx.recv()
            .unwrap_or_else(|_| Err("the engine went away before it answered".to_string()))
    }
}

/// Forward the engine's diagnostics to this process's stderr and to the log file, verbatim.
///
/// Verbatim, and not prefixed: the engine emits one JSON object per line through a redacting
/// logger, and a prefix would make every line unparseable by whatever reads them. **The redaction
/// is the engine's, and the file inherits it** — this thread copies bytes and never composes a
/// line, so there is no place here for a secret to be added to one.
///
/// The thread's real job is to keep the pipe drained; a pipe nobody reads fills and blocks the
/// writer, and an engine blocked on a log line is an engine that has stopped serving mail. The
/// file is written on this thread for the same reason it is written at all — a queue would be one
/// more thing to lose on the way to a crash — and a failed write is dropped rather than retried.
///
/// A read can land mid-line, and this deliberately does not reassemble: the file is a copy of the
/// stream, so a chunk boundary inside a JSON object is written exactly where it fell and the next
/// chunk completes it. Reordering cannot happen — one reader, one writer, in order.
fn forward_diagnostics(mut stderr: ChildStderr) {
    let mut buf = [0u8; 8 * 1024];
    loop {
        match stderr.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => {
                let _ = io::stderr().write_all(&buf[..n]);
                tee_to_log(&buf[..n]);
            }
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

// ── Saying what happened, somewhere it can still be read afterwards ──────────────────────────
//
// ── WHY THERE IS A FILE AT ALL ───────────────────────────────────────────────────────────────
//
// Every line below used to go to this process's stderr and nowhere else, which is fine for a
// binary somebody started from a terminal and useless for the way this app is actually opened. A
// double-clicked bundle inherits no console: on macOS and Linux the streams are pointed at the
// window server's own sink, on Windows a `windows_subsystem = "windows"` build has no console at
// all. So the one account of what happened — the engine's own diagnostics, and this shell's
// account of starting, restarting and giving up — was being written to a stream nobody could
// read, precisely in the case where somebody needs to read it.
//
// ── WHAT MAY BE IN IT ────────────────────────────────────────────────────────────────────────
//
// The same thing that was already allowed on stderr, and nothing more. Two rules, both older than
// this file's log and both unchanged by it: the engine's own logger redacts before a byte reaches
// its stderr, and on this side nothing formats a [`Secret`] or a [`Launch`]'s environment values —
// `Secret`'s `Debug` prints `<redacted>` and `Launch`'s prints the NAMES of its variables. A file
// makes those two rules load-bearing rather than academic, because a line written to a discarded
// stream is a line nobody could have copied into a bug report.

/// What the log file is called inside the platform's log directory.
pub const LOG_FILE_NAME: &str = "engine.log";

/// How large the log may grow before the current one is rolled aside.
///
/// A judgement about disk rather than about content: five megabytes is a few hundred thousand
/// lines, which is more than any single session produces and small enough that a machine that has
/// been running ohmail for a year has not quietly given up a gigabyte to it. Exactly one previous
/// generation is kept, so the ceiling is ten megabytes and there is no rotation schedule to get
/// wrong.
pub const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// The current log file, and how much has been written to it.
///
/// The size is tracked rather than stat'ed per line: a `metadata()` call per log line would be a
/// syscall per line for a number this is the only writer of. It is seeded from the file's real
/// length on open, so an append to an existing log rotates at the right point rather than five
/// megabytes later.
struct LogFile {
    path: PathBuf,
    file: File,
    written: u64,
}

impl LogFile {
    fn open(path: PathBuf) -> io::Result<LogFile> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        // APPEND, so a relaunch adds to the account of the last one instead of erasing it. The
        // rotation below is what bounds the file; truncating on open would bound it by throwing
        // away the run somebody is most likely to be asking about.
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(LogFile { path, file, written })
    }

    /// `engine.log` → `engine.log.old`. One generation, replaced each time.
    fn previous(&self) -> PathBuf {
        let mut name = self.path.file_name().unwrap_or_default().to_os_string();
        name.push(".old");
        self.path.with_file_name(name)
    }

    /// Write, rotating first if this would take the file over the cap.
    ///
    /// A single write LARGER than the cap is written anyway, over the cap, rather than split or
    /// dropped: the alternative is a truncated diagnostic, which is the one kind of log line that
    /// can mislead. The next write rotates it away.
    fn write(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        if self.written.saturating_add(bytes.len() as u64) > LOG_MAX_BYTES {
            let _ = self.rotate();
        }
        if self.file.write_all(bytes).is_ok() {
            self.written = self.written.saturating_add(bytes.len() as u64);
            // Flushed per write, on purpose. The lines that matter most are the last ones before a
            // crash, and a buffered log loses exactly those.
            let _ = self.file.flush();
        }
    }

    fn rotate(&mut self) -> io::Result<()> {
        // `rename` replaces an existing `.old` in one step on every platform this ships to, so
        // there is no window in which neither generation exists.
        fs::rename(&self.path, self.previous())?;
        self.file = OpenOptions::new().create(true).append(true).open(&self.path)?;
        self.written = 0;
        Ok(())
    }
}

/// The log file, once the app has told this module where to put one.
///
/// A module-level handle because [`log_line`] takes no context and never will: it is called from
/// the supervisor thread, the reader thread and the app's own thread, and threading a writer
/// through all three would put the log in every signature in this file. `None` until
/// [`install_log_file`] succeeds — the tests and the development path run without one, and a
/// missing log file must never be a reason for the app not to start.
static LOG: Mutex<Option<LogFile>> = Mutex::new(None);

/// Point the log at a file. Replaces whatever was there.
fn install_log_file(path: PathBuf) -> Result<(), String> {
    let log = LogFile::open(path.clone())
        .map_err(|err| format!("{} could not be opened ({err})", path.display()))?;
    *LOG.lock().map_err(|_| "the log file's lock is poisoned".to_string())? = Some(log);
    Ok(())
}

/// Copy bytes to the log file, if there is one. Never fails, never panics, never blocks the caller
/// on anything but the one write.
fn tee_to_log(bytes: &[u8]) {
    if let Ok(mut guard) = LOG.lock() {
        if let Some(log) = guard.as_mut() {
            log.write(bytes);
        }
    }
}

fn log_line(args: fmt::Arguments<'_>) {
    let line = format!("ohmail engine: {args}\n");
    // `write!` and not `eprintln!`: a windowed build may have no stderr at all, and `eprintln!`
    // panics when the write fails. A lost log line must never take the app down.
    let _ = io::stderr().write_all(line.as_bytes());
    tee_to_log(line.as_bytes());
}

fn log_state(state: &EngineState) {
    match state {
        EngineState::Absent { looked_for } => {
            log_line(format_args!("no engine in this build ({looked_for}); the window is the interface preview"));
        }
        EngineState::NotConfigured { missing } => {
            log_line(format_args!("not started — nothing set {}", missing.join(", ")));
        }
        EngineState::NoKey { reason } => log_line(format_args!("not started — {reason}")),
        EngineState::Starting { attempt } => {
            log_line(format_args!("starting (attempt {attempt} of {MAX_STARTS})"));
        }
        EngineState::Serving { mailbox_id } => {
            log_line(format_args!("serving mailbox {mailbox_id}"));
        }
        EngineState::Restarting { attempt, delay, .. } => {
            log_line(format_args!(
                "restarting in {}ms (attempt {attempt} of {MAX_STARTS})",
                delay.as_millis()
            ));
        }
        EngineState::Stopped => log_line(format_args!("stopped")),
        EngineState::Failed { reason, .. } => log_line(format_args!("{reason}")),
    }
}

fn log_exit(exit: &Exit, fault: Option<&str>) {
    let how = match exit.code {
        Some(0) => "exited cleanly".to_string(),
        Some(code) => format!("exited with code {code}"),
        None => "was killed".to_string(),
    };
    let served = if exit.served { "after serving" } else { "without ever serving" };
    match fault {
        Some(_) => log_line(format_args!("{how} {served}, {:.1}s in, after a protocol fault", exit.ran.as_secs_f32())),
        None => log_line(format_args!("{how} {served}, {:.1}s in", exit.ran.as_secs_f32())),
    }
}

#[cfg(unix)]
fn exit_status_unavailable() -> ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    ExitStatus::from_raw(-1)
}

#[cfg(windows)]
fn exit_status_unavailable() -> ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    ExitStatus::from_raw(1)
}

// ── The one per-install key ──────────────────────────────────────────────────────────────────
//
// The native shell owns the keystore and holds exactly one per-install
// key-encryption key. The engine seals the mailbox password into its own database under that key
// and reads it back on every later launch, so the password is typed once and the environment
// carries the key instead of the secret.
//
// It is ONE key per install rather than one keystore item per mailbox, and that is the decision
// worth stating: one key scales to any number of mailboxes and reuses the envelope encryption the
// rest of the product already has, where a keystore item per mailbox would be a second
// credential-at-rest design competing with the first.
//
// ── WHAT LOSING IT COSTS ────────────────────────────────────────────────────────────────────
//
// The stored password, and nothing else. The local mirror is an ordinary unencrypted database and
// the mailbox on the user's own server is the master, so a lost key is a prompt rather than a
// catastrophe: type the password again and it is re-sealed. Deleting the data directory and this
// one keystore item removes the install completely, and every message stays where it is.

/// The environment variable the engine reads its key from.
pub const KEK_VAR: &str = "OHMAIL_KEK";

/// Where the key lives in the operating system's keystore.
///
/// The service name is the product rather than the bundle identifier on purpose: two artifacts of
/// this app must never end up with two different keys for one data directory, and a bundle id is
/// exactly the thing that differs between them.
pub const KEYSTORE_SERVICE: &str = "ohmail";
pub const KEYSTORE_ENTRY: &str = "install-key";

/// Where the SAME key already lives on a Mac that has run the SwiftUI client.
///
/// ── WHY THIS IS NOT A DUPLICATE OF THE CONSTANTS ABOVE ──────────────────────────────────────
///
/// The two clients are one product and one install. The macOS client mints its per-install key
/// under its own bundle identifier and the account name `kek.v1`, and it has been doing so since
/// before this shell owned a keystore at all — so on a Mac where that client has ever run, the key
/// that opens the stored mailbox password is at THOSE coordinates and nowhere else.
///
/// A build that only ever looked at `ohmail` / `install-key` would find nothing, mint a fresh key,
/// hand it to the engine, and the engine would report the stored password as unreadable: a
/// password somebody typed months ago, gone, with nothing on screen able to say why. So the miss
/// is a reason to look one place further before minting, and that is the whole of this addition.
///
/// **The item is copied and never moved**, and that stays right even though the macOS client is
/// retired. The handover replaces that app rather than uninstalling it, and it can be interrupted:
/// a user who declines the update, or whose install never checks again, still has a working client
/// whose stored password only that key opens. Moving the item would break it for them to save a
/// syscall here. Two readers of one key is also exactly the arrangement the design already has —
/// one key per install, not one per artifact — so the copy is the state this converges on rather
/// than a temporary one.
#[cfg(target_os = "macos")]
pub const LEGACY_KEYSTORE_SERVICE: &str = "io.ohmail.desktop";
#[cfg(target_os = "macos")]
pub const LEGACY_KEYSTORE_ENTRY: &str = "kek.v1";

/// A 32-byte AES-256 key, lower-case hex. The engine validates the same shape and refuses anything
/// else, so getting this wrong is a startup failure rather than a mailbox that will not open later.
fn is_key(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// What one look in the operating system's keystore found.
///
/// Four answers and not two, because "there is no key here" and "there is something here I cannot
/// read" have opposite consequences: the first is a first run, the second is somebody's sealed
/// password. Collapsing them is how a migration mints over a credential it should have adopted.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Stored {
    /// A value of the right shape. Usable as-is.
    Key(String),
    /// There is an item at those coordinates and it is not a key this app wrote.
    Foreign,
    /// Nothing at those coordinates. The keystore itself answered.
    Empty,
    /// The keystore would not answer.
    Refused(String),
}

/// Every way this function is allowed to touch a keystore, and nothing else.
///
/// A struct rather than six positional closures because the ORDER below is the whole of the
/// correctness, and a call site that reads `own:` / `older:` / `file:` states which place is being
/// described. The `Default` is "every keystore is empty and nothing may be minted", so a test names
/// only the steps it is about and any step it forgot is inert rather than quietly plausible.
struct Keystores<'a> {
    /// This app's own file beside its data. See [`KEYSTORE_FILE`].
    file: &'a dyn Fn() -> Stored,
    /// This app's item in the operating system's keystore.
    own: &'a dyn Fn() -> Stored,
    /// Where an earlier version of this app kept the same key.
    older: &'a dyn Fn() -> Stored,
    /// Put a key in the operating system's keystore, proving it reads back.
    write_keystore: &'a dyn Fn(&str) -> Result<(), String>,
    /// Put a key in the file, proving it reads back. `Err` on platforms that have no such file.
    write_file: &'a dyn Fn(&str) -> Result<(), String>,
    /// Fresh random bytes. Stores nothing — the two writers above are the only writers.
    mint: &'a dyn Fn() -> Result<String, String>,
}

impl Default for Keystores<'_> {
    fn default() -> Self {
        Keystores {
            file: &|| Stored::Empty,
            own: &|| Stored::Empty,
            older: &|| Stored::Empty,
            write_keystore: &|_| Ok(()),
            write_file: &|_| Ok(()),
            mint: &|| Err("nothing may be minted here".to_string()),
        }
    }
}

/// Decide which key this launch uses, given only the ability to look, to copy and to mint.
///
/// Split out from [`install_key`] so the ORDER can be tested without a keychain: the order is the
/// whole of the correctness here, and on a developer's machine the real keystore holds their real
/// key, so a test that drove it would either be testing their install or destroying it.
///
/// ── THE ORDER, AND WHY EACH STEP IS WHERE IT IS ─────────────────────────────────────────────
///
///  1. **The file, first, and authoritative once it exists.** See [`KEYSTORE_FILE`] for why there
///     is a file at all. It is read BEFORE the operating system's keystore, and that order is not
///     a preference — it is the only order that cannot orphan a password. The file is written when
///     the keystore holds no key or would not give one up; if a later launch consulted the keystore
///     first and that keystore had meanwhile started answering again, it would hand back the key
///     from BEFORE the fallback, and the password sealed under the file's key would not open. One
///     of the two has to win every time, and it has to be the one that is always readable.
///  2. **This app's own keystore item.** A key here is the answer — and it is mirrored into the
///     file on the way out, so that the NEXT launch is promptless even if this app's signature has
///     changed in between. Mirroring while the key is still readable is what makes the fallback
///     cost nothing: the alternative is to write the file only once the keystore has already
///     refused, by which time the key that opens the stored password is exactly what is missing.
///  3. **A present-but-wrong item refuses, and does not fall through.** Overwriting it would mint a
///     key that cannot open the credential the previous one sealed, turning a recoverable state
///     ("re-enter your password") into a silent one. So does looking at the older item instead:
///     whatever is in this one, something wrote it.
///  4. **A keystore that will not give up this app's own key falls back to the file.** It does not
///     stop the launch. The keystore has answered "no" about THIS app's coordinates, so the older
///     item below is unreadable for the same reason and a key minted back into the keystore would
///     be unreadable on the next launch for the same reason again — that is the loop this branch
///     exists to break. A fresh key goes in the file, where nothing about this app's signature can
///     make it unreadable, and the launch continues so the person can type their password once and
///     have it stick. The file write is REQUIRED here: without it there is nowhere left, and
///     pretending otherwise is what makes a password vanish between restarts.
///  5. **The older item, before minting.** See [`LEGACY_KEYSTORE_SERVICE`]. Copied into this app's
///     coordinates, never moved, and a copy that fails is logged rather than fatal — the key was
///     read, it opens the credential, and refusing the launch over a bookkeeping failure would cost
///     the user a working mailbox to save a syscall on the next launch.
///  6. **A refusal from the older item stops the launch.** This is the one branch where minting
///     would be actively harmful: step 2 has already proved the keystore ANSWERS about this app's
///     own coordinates, so an error HERE means there is an item that this binary was not allowed to
///     read. Minting over that silently orphans a sealed password; saying so lets somebody grant
///     the access or delete the item on purpose.
///  7. **Only then, a fresh key.**
fn resolve_install_key(k: &Keystores) -> Result<String, String> {
    if let Stored::Key(key) = (k.file)() {
        return Ok(key);
    }

    let refusal = match (k.own)() {
        Stored::Key(key) => {
            // Best-effort, and deliberately not fatal: the key is in hand and this launch works
            // either way. What the mirror buys is the launch AFTER the next update.
            if let Err(reason) = (k.write_file)(&key) {
                log_line(format_args!(
                    "this install's key could not be mirrored to {KEYSTORE_FILE} ({reason}) — the app \
                     works, but a future update may have to ask for your mailbox password again"
                ));
            }
            return Ok(key);
        }
        Stored::Foreign => {
            return Err(format!(
                "the {KEYSTORE_SERVICE} key in this computer's keystore is not a key this app wrote. \
                 Remove the {KEYSTORE_SERVICE} / {KEYSTORE_ENTRY} item and open ohmail again — you will \
                 be asked for your mailbox password once more, and no mail is affected"
            ))
        }
        Stored::Refused(err) => Some(err),
        Stored::Empty => None,
    };

    if let Some(err) = refusal {
        let key = (k.mint)()?;
        (k.write_file)(&key).map_err(|file| {
            format!(
                "this computer's keystore would not give up this app's key ({err}), and a key file \
                 could not be written beside this app's data either ({file})"
            )
        })?;
        log_line(format_args!(
            "this computer's keystore would not give up this app's key ({err}), so this install's key \
             is now kept in {KEYSTORE_FILE} beside its data instead. If you are asked for your mailbox \
             password once more, that is why — it will be remembered from then on"
        ));
        return Ok(key);
    }

    match (k.older)() {
        Stored::Key(key) => {
            if let Err(reason) = (k.write_keystore)(&key) {
                // Not fatal. The key is in hand and it opens what it opened before; the copy is an
                // optimisation for later launches, and a launch that works is worth more than one.
                log_line(format_args!(
                    "this install's key was read from where an earlier version of ohmail kept it, and \
                     could not be copied to {KEYSTORE_SERVICE} / {KEYSTORE_ENTRY} ({reason})"
                ));
            } else {
                log_line(format_args!(
                    "adopted this install's existing key — copied to {KEYSTORE_SERVICE} / {KEYSTORE_ENTRY}, \
                     and the original was left where it is"
                ));
            }
            // Mirrored for the same reason as step 2, and just as non-fatally.
            let _ = (k.write_file)(&key);
            Ok(key)
        }
        Stored::Refused(err) => Err(format!(
            "this computer's keystore has a key from an earlier version of ohmail and would not give it \
             up ({err}). Allow ohmail access to it when asked and open the app again — minting a new key \
             instead would leave your stored mailbox password unreadable"
        )),
        Stored::Foreign | Stored::Empty => {
            let key = (k.mint)()?;
            // The keystore ANSWERED about this app's own coordinates at step 2, so it is working
            // and a key it accepts is the right place for a first run. The write must prove itself:
            // a mint that is not stored is a password that vanishes at the next restart.
            (k.write_keystore)(&key)?;
            let _ = (k.write_file)(&key);
            Ok(key)
        }
    }
}

/// One look at one keystore item.
fn look_up(entry: &keyring::Entry) -> Stored {
    match entry.get_password() {
        Ok(existing) if is_key(&existing) => Stored::Key(existing),
        Ok(_) => Stored::Foreign,
        Err(keyring::Error::NoEntry) => Stored::Empty,
        // Translated HERE, at the edge, so every message built from a refusal downstream — the log
        // line, the fallback's composed error, the `NoKey` sentence on screen — says the same true
        // thing without each of them having to know about macOS errno statuses.
        Err(err) => Stored::Refused(plainly(&err.to_string())),
    }
}

/// Where the previous generation of this app kept the same key, on the one platform that has one.
///
/// `Empty` everywhere else, which is the honest answer: there is nothing to migrate FROM on a
/// machine where no earlier version ever stored anything.
#[cfg(target_os = "macos")]
fn look_up_older() -> Stored {
    match keyring::Entry::new(LEGACY_KEYSTORE_SERVICE, LEGACY_KEYSTORE_ENTRY) {
        Ok(entry) => look_up(&entry),
        Err(err) => Stored::Refused(err.to_string()),
    }
}

#[cfg(not(target_os = "macos"))]
fn look_up_older() -> Stored {
    Stored::Empty
}

/// Write a key and prove it can be read back.
///
/// READ IT BACK BEFORE IT IS USED. A `set` that reports success and a `get` that returns nothing is
/// a real keystore failure mode, and finding it now costs one syscall — finding it on the next
/// launch costs the password the user is about to type. Used by both writers below, so the
/// adopted key gets the same guarantee the minted one always had.
fn store_and_read_back(entry: &keyring::Entry, key: &str) -> Result<(), String> {
    entry
        .set_password(key)
        .map_err(|err| format!("this computer's keystore would not store a key ({err})"))?;
    match entry.get_password() {
        Ok(stored) if stored == key => Ok(()),
        _ => Err(
            "this computer's keystore accepted a key and did not give it back, so a password stored \
             now could not be read after a restart"
                .to_string(),
        ),
    }
}

/// Ask the keychain without letting it ask the user anything.
///
/// ── WHY A LOOKUP MUST NOT BE ALLOWED TO PUT A WINDOW ON SCREEN ──────────────────────────────
///
/// When macOS will not let this binary read an item — see [`KEYSTORE_FILE`] for why a rebuild is
/// enough to cause that — its FIRST move is not to return an error. It is to put up a dialog asking
/// for the login password, and to block the calling thread until somebody answers.
///
/// The key is resolved while the shell is working out what to start, so that block is the app
/// hanging on launch with no window of its own up yet: measured at over ten minutes, ended only by
/// killing the process. With interaction turned off the same call returns `errSecAuthFailed`
/// immediately and the fallback below has something to work with.
///
/// It is turned back on when this guard drops, including on the early returns out of
/// [`resolve_install_key`] — the setting is process-wide, and leaving it off would silently change
/// how every later keychain call behaves.
///
/// **What this costs:** a keychain that is merely LOCKED can no longer ask the user to unlock it,
/// and is treated as a refusal. That is survivable here and nowhere near as bad as the hang,
/// because a launch that ever succeeded has already mirrored the key into the file — so a locked
/// keychain is only reached by an install that has never once got this far, which is exactly the
/// case where there is nothing yet to orphan.
#[cfg(target_os = "macos")]
struct NoKeychainPrompts(u8);

#[cfg(target_os = "macos")]
mod security_ffi {
    // Two symbols from a framework this process already links — `security-framework` is in the
    // dependency graph under the keyring crate — so this adds no third-party code to audit.
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        pub fn SecKeychainGetUserInteractionAllowed(state: *mut u8) -> i32;
        pub fn SecKeychainSetUserInteractionAllowed(state: u8) -> i32;
    }
}

#[cfg(target_os = "macos")]
impl NoKeychainPrompts {
    fn hold() -> Self {
        let mut was: u8 = 1;
        // A failure to READ the setting is not a reason to skip turning it off: the hang is the
        // thing being prevented, and restoring "allowed" is the safe assumption either way.
        unsafe {
            security_ffi::SecKeychainGetUserInteractionAllowed(&mut was);
            security_ffi::SecKeychainSetUserInteractionAllowed(0);
        }
        NoKeychainPrompts(was)
    }
}

#[cfg(target_os = "macos")]
impl Drop for NoKeychainPrompts {
    fn drop(&mut self) {
        unsafe {
            security_ffi::SecKeychainSetUserInteractionAllowed(self.0);
        }
    }
}

/// Nothing to suppress: no other platform's keystore blocks a lookup on a dialog.
#[cfg(not(target_os = "macos"))]
struct NoKeychainPrompts;

#[cfg(not(target_os = "macos"))]
impl NoKeychainPrompts {
    fn hold() -> Self {
        NoKeychainPrompts
    }
}

/// Say what a keystore error MEANS, where the platform's own words are actively misleading.
///
/// macOS reports a refused keychain item through an errno-shaped `OSStatus` — `errSecErrnoBase`
/// (100000) plus a POSIX errno — and the errno it picks up for a denied read is 28, `ENOSPC`. So a
/// keychain that will not hand over an item surfaces, through the keyring crate, as
/// `Platform failure: UNIX[No space left on device]` on a machine with hundreds of gigabytes free.
/// `SecCopyErrorMessageString(100028)` is exactly that string, and a write to the same keychain in
/// the same second succeeds — the disk is not the problem and never was.
///
/// Printed unedited it sends people to delete files, which cannot help, and hides the one fact that
/// would: an app whose signature changed can no longer read what its previous signature wrote.
fn plainly(err: &str) -> String {
    if err.contains("No space left on device") {
        return format!(
            "{err} — which is how macOS reports a keychain item it will not hand over, and does not \
             mean the disk is full"
        );
    }
    err.to_string()
}

/// Where this install's key is kept when the operating system's keystore will not keep it.
///
/// ── WHY A FILE EXISTS AT ALL, WHEN THERE IS A PERFECTLY GOOD KEYCHAIN ───────────────────────
///
/// Because on macOS the keychain cannot do this job for these builds, and that is a property of
/// how they are signed rather than a bug to be fixed here.
///
/// macOS records, against every keychain item, which code may read it. For an application signed
/// with a Team ID it records `teamid:…`, which is stable for the life of the product. For an
/// AD-HOC signed application there is no team to record, so it records `cdhash:…` — the hash of
/// that exact binary. Every rebuild produces a different binary and therefore a different cdhash,
/// so **each new version of an ad-hoc signed app is, to the keychain, a different application** and
/// is refused the item the previous one wrote. It is refused through the errno-shaped status
/// [`plainly`] exists to translate.
///
/// The failure that produced this file: after an update the app could not read its own key, and
/// [`resolve_install_key`] correctly refused to mint over an item it could not read — so the engine
/// never started, so nothing could seal a password, so re-entering the password did not stick, and
/// the next restart failed identically. A loop with no way out from inside the app.
///
/// ── WHAT IT COSTS, STATED PLAINLY ────────────────────────────────────────────────────────────
///
/// The key sits in a file next to the data it protects, readable by this user, where the keychain
/// would have kept it behind the login password. That is a real reduction and it is not disguised
/// here. Three things bound it: the file is `0600`; it holds only the key that seals the stored
/// mailbox password, which is re-derived by typing that password again; and it sits beside a local
/// mirror that is an ordinary unencrypted database, so anything that can read this file can already
/// read the mail. The mailbox on the user's own server remains the master.
///
/// The keychain is still tried first on a machine where it works, and still written on every path
/// that mints — a Developer ID signed build, or any platform whose keystore is stable across
/// updates, never reads this file because [`resolve_install_key`] never has cause to write it.
pub const KEYSTORE_FILE: &str = "install-key";

/// One look at the file. `Empty` when there is no file, or no directory to hold one.
fn look_up_file(app_data: Option<&Path>) -> Stored {
    let Some(path) = app_data.map(|d| d.join(KEYSTORE_FILE)) else {
        return Stored::Empty;
    };
    match fs::read_to_string(&path) {
        Ok(text) => {
            let text = text.trim();
            if is_key(text) {
                Stored::Key(text.to_string())
            } else {
                // Not `Refused`: a file of the wrong shape is not somebody's sealed key and must
                // not stop a launch. The keystore below is asked, and a good key overwrites this.
                Stored::Foreign
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Stored::Empty,
        Err(err) => Stored::Refused(err.to_string()),
    }
}

/// Write the key to the file, at `0600`, and prove it can be read back.
///
/// Created with the mode already set rather than written and then `chmod`ed — a key that is briefly
/// world-readable is a key that leaked, and the window is exactly as long as somebody's backup
/// daemon needs. The same readback discipline as [`store_and_read_back`], for the same reason: a
/// write that reports success and reads back empty costs the password the user is about to type.
fn write_key_file(app_data: Option<&Path>, key: &str) -> Result<(), String> {
    let Some(dir) = app_data else {
        return Err("this app has no data directory to keep a key in".to_string());
    };
    fs::create_dir_all(dir)
        .map_err(|err| format!("the folder for this app's data could not be made ({err})"))?;
    let path = dir.join(KEYSTORE_FILE);

    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|err| format!("a key file could not be made beside this app's data ({err})"))?;
    file.write_all(key.as_bytes())
        .map_err(|err| format!("this app's key file could not be written ({err})"))?;
    file.sync_all()
        .map_err(|err| format!("this app's key file could not be flushed to disk ({err})"))?;
    drop(file);

    // An existing file keeps the mode it was created with, so a file from an earlier run — or one
    // restored by a backup tool that widened it — is tightened here rather than trusted.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("this app's key file could not be made private ({err})"))?;
    }

    match look_up_file(app_data) {
        Stored::Key(stored) if stored == key => Ok(()),
        _ => Err(
            "this app's key file was written and did not read back, so a password stored now could \
             not be read after a restart"
                .to_string(),
        ),
    }
}

/// Read this install's key — from the file, this app's keystore item, the one an earlier version
/// stored, or minted on first run, in that order and for the reasons on [`resolve_install_key`].
///
/// Compiled only under the `local-engine` feature, like everything else in this file — the preview
/// stores nothing and therefore needs nowhere to store it.
fn install_key(app_data: Option<&Path>) -> Result<String, String> {
    // Held across every lookup and every write below, and released when this function returns.
    let _quiet = NoKeychainPrompts::hold();

    let entry = keyring::Entry::new(KEYSTORE_SERVICE, KEYSTORE_ENTRY)
        .map_err(|err| format!("this computer's keystore could not be opened ({err})"))?;

    resolve_install_key(&Keystores {
        file: &|| look_up_file(app_data),
        own: &|| look_up(&entry),
        older: &look_up_older,
        write_keystore: &|key| store_and_read_back(&entry, key),
        write_file: &|key| write_key_file(app_data, key),
        mint: &|| {
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes)
                .map_err(|err| format!("this computer would not supply random bytes for a new key ({err})"))?;
            Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
        },
    })
}

// ── What the window may ask ──────────────────────────────────────────────────────────────────
//
// Six commands, and they are the only thing the webview can call. `engine_status` is what a surface
// renders; `engine_request` is the bridge the client engine's `fetch` goes down; `engine_configure`
// and `engine_logout` are the two that change which door this install came in by. `notify` and
// `set_badge` are the two pieces of native chrome the WINDOW drives rather than the shell: what
// counts as unread is a question about mail, which the client answers and this process has no
// opinion on.
//
// They live in this file for the reason everything else that reaches the webview does: "the
// capability is all in one module, and that module is not compiled into the published build" is a
// statement worth keeping true of a file list rather than of a set of `#[cfg]`s spread about.
//
// THE SESSION TOKEN IS NOT AMONG THEM. `engine_status` does not carry it and `engine_request` adds
// it on this side, so the page holds no credential — which is also what lets the unmodified client
// run here: it authenticates with nothing because it needs to.
//
// AND NEITHER IS ANY OTHER SECRET. `engine_configure` takes settings and refuses a payload carrying
// a password, a token or anything else secret-shaped (`config::parse`). The mailbox password and
// the hosted sign-in travel over `engine_request`, addressed to the engine, and are sealed there —
// so no credential is ever an argument to a shell command, held in this process's memory, or
// written to this process's file.

/// What the shell knows about the engine, as the webview sees it.
///
/// A tagged object rather than a string, because the surface renders different things for different
/// states and matching on prose is how a translated string becomes load-bearing.
#[cfg(feature = "local-engine")]
fn status_json(engine: &Engine) -> serde_json::Value {
    let (state, ready) = {
        let s = engine.inner.shared.lock().expect("engine state");
        (s.state.clone(), s.ready.clone())
    };
    let mut out = match &state {
        EngineState::Absent { looked_for } => {
            serde_json::json!({ "state": "absent", "lookedFor": looked_for })
        }
        EngineState::NotConfigured { missing } => {
            serde_json::json!({ "state": "not_configured", "missing": missing })
        }
        EngineState::NoKey { reason } => serde_json::json!({ "state": "no_key", "reason": reason }),
        EngineState::Starting { attempt } => {
            serde_json::json!({ "state": "starting", "attempt": attempt, "of": MAX_STARTS })
        }
        EngineState::Serving { mailbox_id } => {
            serde_json::json!({ "state": "serving", "mailboxId": mailbox_id })
        }
        EngineState::Restarting { attempt, delay, .. } => serde_json::json!({
            "state": "restarting", "attempt": attempt, "of": MAX_STARTS, "delayMs": delay.as_millis() as u64,
        }),
        EngineState::Stopped => serde_json::json!({ "state": "stopped" }),
        EngineState::Failed { reason, .. } => serde_json::json!({ "state": "failed", "reason": reason }),
    };
    if let (Some(ready), Some(object)) = (ready, out.as_object_mut()) {
        object.insert("accountId".into(), ready.account_id.clone().into());
        object.insert("userId".into(), ready.user_id.clone().into());
        object.insert("mailboxId".into(), ready.mailbox_id.clone().into());
        object.insert("credentialState".into(), ready.credential_state.as_str().into());
        // `baseUrl` and NOT `sessionToken`. The first is a public fact about where to address a
        // request; the second is the credential this shell exists to keep off the page.
        object.insert("baseUrl".into(), ready.base_url.clone().into());
    }
    out
}

#[cfg(feature = "local-engine")]
#[tauri::command(async)]
fn engine_status(shell: tauri::State<'_, Arc<Shell>>) -> serde_json::Value {
    shell.status()
}

/// Choose a door, or change the one already chosen.
///
/// Takes settings and no secret — see the section header. The engine is restarted behind it, so
/// this returns the status AFTER the change: a caller that immediately re-read `engine_status`
/// would race the swap and could see the engine it was replacing.
#[cfg(feature = "local-engine")]
#[tauri::command(async)]
fn engine_configure(
    shell: tauri::State<'_, Arc<Shell>>,
    config: serde_json::Value,
) -> Result<serde_json::Value, String> {
    shell.configure(&config)
}

/// Forget the account on this install: clear the sealed credential, stop the engine, forget the
/// door. The mirror and this install's key stay. See [`Shell::logout`].
#[cfg(feature = "local-engine")]
#[tauri::command(async)]
fn engine_logout(shell: tauri::State<'_, Arc<Shell>>) -> Result<serde_json::Value, String> {
    shell.logout()
}

/// One request, down the pipe and back.
///
/// `async` is load-bearing rather than decoration: Tauri runs a synchronous command on the main
/// thread, and this one blocks until the engine answers. On the main thread that is the window
/// freezing for the length of every request the app makes.
///
/// The answer comes back as raw bytes — a length-prefixed metadata header and then the body —
/// because a mail body is not JSON and re-encoding one through a JSON string would cost a copy and
/// a UTF-8 assumption that attachments break.
#[cfg(feature = "local-engine")]
#[tauri::command(async)]
fn engine_request(
    shell: tauri::State<'_, Arc<Shell>>,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
) -> Result<tauri::ipc::Response, String> {
    // Read ONCE, into an `Arc` this request holds for its whole life. A reconfigure can replace the
    // engine while this is in flight, and the answer must come from the engine the question went to
    // — re-reading the slot for the reply would deliver it against a different child's bookkeeping.
    let answer = shell.engine().request(EngineRequest { method, url, headers, body })?;
    let meta = serde_json::json!({
        "status": answer.status,
        "statusText": answer.status_text,
        "h": answer.headers,
    });
    let meta = serde_json::to_vec(&meta).map_err(|err| format!("could not encode the answer: {err}"))?;
    let mut out = Vec::with_capacity(4 + meta.len() + answer.body.len());
    out.extend_from_slice(&(meta.len() as u32).to_be_bytes());
    out.extend_from_slice(&meta);
    out.extend_from_slice(&answer.body);
    Ok(tauri::ipc::Response::new(out))
}

/// One notice in the operating system's own notification centre.
///
/// ── WHY THE WINDOW ASKS AND THE SHELL SPEAKS ────────────────────────────────────────────────
///
/// The page cannot post a notification: its CSP and the offline guard leave it no way to ask for
/// the permission, and it has no bundle identity for the platform to attribute one to. This
/// process has both. The division is the honest one — the client knows a message arrived, and the
/// shell knows how this operating system tells somebody about it.
///
/// The webview is granted THIS command and NOT the notification plugin's own permissions, which
/// is the difference between "the window may ask for one notice with a title and a body" and "the
/// window may drive the notification API". The plugin is reached only from here.
#[cfg(feature = "local-engine")]
#[tauri::command(async)]
fn notify<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    title: String,
    body: String,
) -> Result<(), String> {
    use tauri_plugin_notification::{NotificationExt, PermissionState};
    // ASK ONCE, AND ONLY WHEN THE ANSWER IS NOT ALREADY KNOWN. A permission prompt on every
    // notification is the behaviour that gets an app's notifications turned off for good; a
    // refusal is reported and never retried in a loop.
    match app.notification().permission_state() {
        Ok(PermissionState::Granted) => {}
        Ok(_) => match app.notification().request_permission() {
            Ok(PermissionState::Granted) => {}
            Ok(_) => return Err("notifications are turned off for ohmail on this computer".into()),
            Err(err) => return Err(format!("this computer would not say whether ohmail may post notifications ({err})")),
        },
        Err(err) => return Err(format!("this computer would not say whether ohmail may post notifications ({err})")),
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|err| format!("the notification could not be shown ({err})"))
}

/// How many pieces of mail the dock or taskbar icon says are waiting. Zero removes the badge.
///
/// The COUNT is the window's, deliberately: what is unread is a fact about mail, and this process
/// has no reader of the mirror and no business acquiring one. All it does is put the number the
/// client already renders in the rail onto the icon.
///
/// Windows has no badge count — it carries an overlay icon instead — so the call is a no-op there
/// rather than an error. A platform that cannot show a badge is not a failure the window should
/// have to handle, and reporting one would put an error in front of somebody over decoration.
#[cfg(feature = "local-engine")]
#[tauri::command(async)]
fn set_badge<R: tauri::Runtime>(app: tauri::AppHandle<R>, count: u32) -> Result<(), String> {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    // `None` and `Some(0)` both remove it; `None` is the spelling that says so.
    let value = if count == 0 { None } else { Some(i64::from(count)) };
    match window.set_badge_count(value) {
        Ok(()) => Ok(()),
        Err(err) if cfg!(windows) => {
            log_line(format_args!("this platform has no badge count ({err})"));
            Ok(())
        }
        Err(err) => Err(format!("the badge could not be set ({err})")),
    }
}

/// THE FEW PLACES ON THE WEB THIS APP MAY OPEN, AND THE ONLY WAY IT CAN NAME ONE.
///
/// A hosted account is administered on the web — the plan, the password, the authenticator, the
/// recovery codes — and every one of those is a step-up ceremony against a server this window
/// cannot reach. Settings had no way to say so beyond a sentence, which leaves somebody reading
/// "manage this on the web" with no way to get there but retyping an address.
///
/// ── THE WINDOW NAMES A PLACE, NEVER A URL ───────────────────────────────────────────────────
///
/// This is the whole of the care, and it is why the argument is a KEY. If the page could pass a
/// URL, then anything that ever got a string into the page — a mail body, a sender's display name,
/// a bug in the sanitizer — could open an arbitrary address in the user's real browser, signed in
/// to everything they are signed in to. So the page passes `"account"` and this table decides what
/// that means. There is no path from a value in the webview to a host in the browser.
///
/// The table is also why the addresses live HERE rather than in the frontend: the bundle is
/// asserted to name no host at all, which is the claim the whole preview artifact rests on.
#[cfg(feature = "local-engine")]
const LINKS: [(&str, &str); 6] = [
    ("account", "https://ohmail.app/mailbox#/settings"),
    ("security", "https://ohmail.app/mailbox#/settings"),
    ("billing", "https://ohmail.app/mailbox#/settings"),
    // The browser half of signing in to a hosted account: the page mints a one-use code and the
    // person types it into the window that opened it. It is the ONE entry here the app opens
    // BEFORE it has a session — the rest are administration of an account it is already serving
    // — and it carries no query for the same reason none of the others does: everything about
    // this address is fixed here, so no value from the page can shape where the browser goes.
    ("link-desktop", "https://ohmail.app/link-desktop"),
    ("privacy", "https://ohmail.app/privacy"),
    ("subprocessors", "https://ohmail.app/subprocessors"),
];

/// The address a key names, or `None`. Split out so the rule is testable without a browser.
#[cfg(feature = "local-engine")]
pub fn link_for(key: &str) -> Option<&'static str> {
    LINKS.iter().find(|(name, _)| *name == key).map(|(_, url)| *url)
}

/// Open one of [`LINKS`] in the user's own browser.
///
/// The platform's own opener, by process rather than by a plugin: `open` on macOS, `xdg-open` on
/// the desktop Unixes, and `cmd /c start` on Windows. That is one fewer dependency to audit for a
/// three-line call, and it opens no socket in this process — the browser makes the request, as
/// itself, with its own cookies. The engine-bearing build already spawns a process (the engine),
/// so this adds no capability to the artifact that was not already there; the PREVIEW compiles
/// none of it.
#[cfg(feature = "local-engine")]
#[tauri::command(async)]
fn open_link(key: String) -> Result<(), String> {
    let url = link_for(&key).ok_or_else(|| format!("ohmail: {key} is not a place this app opens"))?;

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("/usr/bin/open");
        c.arg(url);
        c
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("cmd");
        // The empty string is the window TITLE argument `start` takes; without it a URL
        // containing a space would be read as the title and nothing would open.
        c.args(["/c", "start", "", url]);
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("ohmail: this computer would not open a browser ({err})"))
}

/// The window's grant, and the whole of it.
///
/// Added at runtime rather than as a file in `capabilities/`, because a file there is compiled into
/// EVERY build: the preview would carry a grant for commands it does not have, and "the window can
/// call nothing" would become a claim about a permission list rather than about the binary. This
/// string is in a module the preview does not compile.
///
/// `core:event:allow-listen` is the one runtime permission on the list, and it is one direction
/// only: the window may HEAR what the shell emits — which is how a chosen menu item reaches the
/// frontend's navigation — and has no matching `allow-emit`, so it cannot make the shell hear
/// anything. That asymmetry is what a menu wants, and granting the pair would have been the easy
/// thing to write.
#[cfg(feature = "local-engine")]
const LOCAL_ENGINE_CAPABILITY: &str = r#"{
  "identifier": "local-engine",
  "description": "The window may ask the shell about the local engine, send it one request at a time, choose which mailbox this install is for, sign out of it, post one notification, set the icon's badge, open one of a fixed list of ohmail.app pages in the user's own browser, and listen for the shell's own events. Nothing else: no filesystem, no arbitrary shell command, no network, and no other Tauri core API.",
  "windows": ["main"],
  "permissions": ["allow-engine-status", "allow-engine-request", "allow-engine-configure", "allow-engine-logout", "allow-notify", "allow-set-badge", "allow-open-link", "core:event:allow-listen"]
}"#;

/// Register the seven commands. Called from `main.rs` under the same feature.
///
/// It lives here rather than there so that `main.rs` contains no `invoke_handler` at all — the
/// published shell's "registers no commands" is then a property of a file that is always compiled,
/// rather than of a branch inside one.
///
/// ONE `invoke_handler`, and it has to be: a second call REPLACES the first rather than adding to
/// it, so a command registered anywhere else would take every command here out of the build.
#[cfg(feature = "local-engine")]
pub fn attach<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        // The notification plugin, registered HERE rather than in `main.rs`, so it is in the
        // engine-bearing build and out of the preview's dependency graph entirely — the preview
        // has no mail and therefore nothing to announce. The webview is granted the `notify`
        // command above and none of this plugin's own permissions.
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            engine_status,
            engine_request,
            engine_configure,
            engine_logout,
            notify,
            set_badge,
            open_link
        ])
}

/// Hand the shell to the window, and grant the window the seven commands.
#[cfg(feature = "local-engine")]
pub fn manage(app: &tauri::App, shell: Arc<Shell>) {
    use tauri::Manager;
    app.manage(shell);
    if let Err(err) = app.add_capability(LOCAL_ENGINE_CAPABILITY) {
        // Fatal, and loudly. A window that cannot call the bridge is a window that renders nothing
        // — and silently continuing would produce exactly the failure this slice exists to prevent:
        // an app that looks like it is working and is not.
        panic!("ohmail: the local engine's capability could not be granted: {err}");
    }
}
