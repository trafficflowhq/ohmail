//! WHICH DOOR THIS INSTALL CAME IN BY, written down so the next launch knows.
//!
//! ── WHY A FILE AND NOT AN ENVIRONMENT VARIABLE ─────────────────────────────────────────────
//!
//! The engine is configured through its environment, and for a developer starting it by hand that
//! is exactly right. It is useless for the product: a person who double-clicks the app and types
//! their mail server into a window has no shell to export anything from, and the setting has to
//! survive a quit. So the shell keeps one small JSON file beside the app's own data, and composes
//! the engine's environment from it at every spawn. The environment still wins where it is set —
//! that is the development path and the only way a launch can be reproduced by hand.
//!
//! ── TWO DOORS, TWO DATA DIRECTORIES, AND THE ONE THAT MUST NOT BE CROSSED ──────────────────
//!
//! LOCAL organizes the user's own IMAP mailbox from this machine. CLOUD mirrors a hosted account
//! and never opens IMAP at all. They are different engines with different databases, and the
//! directory each writes to is derived from the mode — `engine-local/` and `engine-cloud/` under
//! the app's data directory — so switching doors cannot mix one mirror into the other. **The
//! directory a switch leaves behind is FROZEN, never deleted.** Nothing in this file removes a
//! mirror: the mail is on the user's server or in the hosted account, this machine's copy is a
//! convenience, and a door switch that silently destroyed the old one would make going back
//! expensive for no reason.
//!
//! ── THE ONE COMPOSITION THAT IS SAFETY-CRITICAL ────────────────────────────────────────────
//!
//! `OHMAIL_MODE=cloud`. The engine chooses its branch from that single variable, and its default
//! branch is the LOCAL organizer. A cloud door spawned without it therefore runs the organizer —
//! and if this process's own environment happens to carry an IMAP host (a developer's shell, a
//! launcher script), that organizer would open a real mailbox the hosted worker is already
//! organizing. Two organizers on one mailbox is the failure the whole dual-mode design exists to
//! prevent, and it would arrive here, from an absent variable.
//!
//! It is defended twice, deliberately. {@link env_for} sets the mode explicitly for the cloud door
//! — asserted by a test that watches the assertion fail when the line is removed — and
//! {@link unset_for} names every `OHMAIL_IMAP_*` the shell knows about so an inherited one cannot
//! reach the child. The engine has a third defence of its own: in cloud mode it refuses to start at
//! all if any `OHMAIL_IMAP_*` is present. Three independent locks, because the cost of the failure
//! is somebody's mailbox being reorganized by two engines at once.
//!
//! ── AND WHAT IS NEVER IN THIS FILE ─────────────────────────────────────────────────────────
//!
//! A password, a token, or anything else a person would be upset to find in plain text under their
//! home directory. The mailbox password is typed into the running app and sealed by the ENGINE into
//! its own store under the per-install key; the hosted session is established by the engine and
//! sealed the same way. Neither ever passes through this process. {@link parse} refuses a
//! configuration carrying a secret-shaped field rather than storing it, so that stays true by
//! refusal rather than by everybody remembering.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;

/// Which engine this install runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The local organizer, against the user's own IMAP server.
    Local,
    /// The read-only mirror of a hosted account.
    Cloud,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Local => "local",
            Mode::Cloud => "cloud",
        }
    }

    /// The subdirectory this mode's mirror lives in, under the app's data directory.
    ///
    /// Per-mode and not shared: the two engines write different schemas into different databases,
    /// and one directory holding both is one lock contended by two incompatible readers.
    pub fn dir_name(self) -> &'static str {
        match self {
            Mode::Local => "engine-local",
            Mode::Cloud => "engine-cloud",
        }
    }
}

/// The send server, when the user's provider has one worth naming.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Smtp {
    pub host: String,
    pub port: u16,
    /// Implicit TLS: true for 465, false for 587 STARTTLS.
    pub secure: bool,
}

/// The local door: the user's own mailbox, opened from this machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalDoor {
    pub imap_host: String,
    pub imap_user: String,
    pub imap_port: u16,
    pub imap_secure: bool,
    pub smtp: Option<Smtp>,
    /// The address the mailbox is known by, when it differs from the login.
    pub address: Option<String>,
}

/// The cloud door: a hosted account, mirrored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudDoor {
    pub cloud_url: String,
    pub address: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Config {
    Local(LocalDoor),
    Cloud(CloudDoor),
}

impl Config {
    pub fn mode(&self) -> Mode {
        match self {
            Config::Local(_) => Mode::Local,
            Config::Cloud(_) => Mode::Cloud,
        }
    }

    /// The mailbox this install is for, as a person would recognise it.
    pub fn address(&self) -> Option<&str> {
        match self {
            Config::Local(l) => l.address.as_deref().or(Some(l.imap_user.as_str())),
            Config::Cloud(c) => Some(c.address.as_str()),
        }
    }
}

/// What the file is called inside the app's data directory.
pub const CONFIG_FILE_NAME: &str = "config.json";

/// The hosted service's own base — the address every build before the self-hosted door used.
///
/// Named here for ONE purpose: deciding whether a cloud door is the managed service or somebody's
/// own server, which is what scopes the operator CA in [`env_for`]. Nothing is defaulted from it.
pub const MANAGED_CLOUD_BASE: &str = "https://api.ohmail.app";

/// A cloud door's address, refused rather than stored when it is not one this app may dial.
///
/// ── WHY THE SHELL CHECKS THIS AT ALL, WHEN THE ENGINE ALSO DOES ─────────────────────────────
///
/// Because this is the TRUST BOUNDARY and the engine is downstream of it. `engine_configure` is one
/// of the commands the window holds, and this function is what stands between a value that window
/// chose and a settings file on disk that every later launch reads. Raised by review of the
/// self-hosted door: the reasoning "the address comes from configuration, not from a request" is
/// worth nothing while configuration is itself a command the same window can issue.
///
/// Deliberately CONSERVATIVE rather than clever. There is no URL parser in this process — the app's
/// manifest is published and licence-audited, and a dependency for four lines is not the trade — so
/// this refuses the shapes that turn string concatenation into a different request, and leaves
/// canonicalization to the engine, which has a real parser and re-composes the base from its parts:
///
///  · a scheme other than `http://` or `https://`, so nothing but the two dialable schemes lands;
///  · `#`, which is the sharp one. Every URL the engine composes is `base + path`, so a fragment in
///    the base makes the path part of a fragment that is never sent — `http://h:p#/` + `/hello`
///    goes out as `GET /` at that address, and so does every other route;
///  · `?`, for the same class of reason;
///  · `@`, which is how credentials ride inside an authority;
///  · whitespace and control characters, which the URL standard strips rather than rejects, so a
///    value carrying them means something different after parsing than it looks like here — and a
///    line break in particular is what the mirror-owner record's framing had to be hardened against.
///
/// A value this accepts may still be refused by the engine's own parse, which is the intended
/// order: two gates, the strict one where the parser is.
fn checked_cloud_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let scheme_ok = trimmed.starts_with("https://") || trimmed.starts_with("http://");
    if !scheme_ok {
        return Err(
            "the cloud door's address must begin with https:// (or http:// for a server on this \
             machine)"
                .to_string(),
        );
    }
    if trimmed.contains('#') || trimmed.contains('?') || trimmed.contains('@') {
        return Err(
            "the cloud door's address may not carry a query, a fragment or a sign-in".to_string(),
        );
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("the cloud door's address may not contain spaces or control characters".to_string());
    }
    Ok(trimmed.to_string())
}

/// Whether a cloud door points at somebody's OWN server rather than at the hosted service.
///
/// Compared with the trailing slash and the case of the scheme+host folded, because
/// `https://api.ohmail.app/` and `https://API.ohmail.app` are the same address and must not be
/// mistaken for a self-hosted one — that mistake would hand the operator CA to the managed door,
/// which is the whole thing [`env_for`]'s scoping exists to prevent.
fn is_self_hosted_cloud(cloud_url: &str) -> bool {
    let fold = |s: &str| s.trim().trim_end_matches('/').to_lowercase();
    fold(cloud_url) != fold(MANAGED_CLOUD_BASE)
}

/// The file an operator drops their own certificate authority's root into.
///
/// The same name the engine's refusal tells them to use and the same name the door's address step
/// shows before they ever see that refusal — `apps/sidecar/src/cloud-origin.ts`'s
/// `OPERATOR_CA_FILE`, which is the copy this one must never drift from. It is spelled here rather
/// than shared because this process links no JavaScript;
/// `the_operator_ca_file_is_spelled_the_same_way_in_the_engine` reads the TypeScript and fails if
/// the two ever disagree.
///
/// See {@link env_for} for what it does and why it is a file rather than a switch.
pub const OPERATOR_CA_FILE: &str = "cloud-ca.pem";

/// Field names a configuration may never carry.
///
/// Matched as SUBSTRINGS of the lower-cased key, at every depth, and the refusal is a hard error
/// rather than a silent drop. A dropped field would mean a caller believing it had stored a
/// password that this file quietly did not — and then a mailbox that never connects, with nothing
/// anywhere saying why. The secrets travel to the engine over the bridge and are sealed there; see
/// this module's header.
const SECRET_KEY_FRAGMENTS: [&str; 6] = ["pass", "secret", "token", "credential", "kek", "auth"];

fn refuse_secrets(value: &serde_json::Value) -> Result<(), String> {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let lower = key.to_ascii_lowercase();
                if let Some(bad) = SECRET_KEY_FRAGMENTS.iter().find(|f| lower.contains(*f)) {
                    return Err(format!(
                        "the configuration carries a field named \"{key}\", and \"{bad}\" is not \
                         something the shell stores. Passwords and sessions are typed into the app \
                         and sealed by the engine under this install's key; nothing secret is \
                         written to {CONFIG_FILE_NAME}"
                    ));
                }
                refuse_secrets(child)?;
            }
            Ok(())
        }
        serde_json::Value::Array(items) => items.iter().try_for_each(refuse_secrets),
        _ => Ok(()),
    }
}

fn string_at(map: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn required_string(
    map: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<String, String> {
    string_at(map, key).ok_or_else(|| format!("the configuration needs a {key}"))
}

/// A port, or the default. Refuses a value outside 1..=65535 rather than truncating it.
fn port_at(
    map: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    default: u16,
) -> Result<u16, String> {
    match map.get(key) {
        None | Some(serde_json::Value::Null) => Ok(default),
        Some(v) => {
            let n = v
                .as_u64()
                .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
                .ok_or_else(|| format!("{key} is not a port number"))?;
            if n == 0 || n > u16::MAX as u64 {
                return Err(format!("{key} is not a port number"));
            }
            Ok(n as u16)
        }
    }
}

/// A boolean that may arrive as a boolean or as the string the wire spells it with.
fn bool_at(map: &serde_json::Map<String, serde_json::Value>, key: &str, default: bool) -> bool {
    match map.get(key) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => !matches!(s.trim(), "0" | "false" | ""),
        _ => default,
    }
}

/// Read a configuration out of what the window sent, or say why it is not one.
pub fn parse(value: &serde_json::Value) -> Result<Config, String> {
    refuse_secrets(value)?;
    let map = value
        .as_object()
        .ok_or_else(|| "the configuration is not an object".to_string())?;
    let mode = string_at(map, "mode").unwrap_or_default();
    match mode.as_str() {
        "local" => {
            // `imap` may be flat or nested; the window sends one shape and a hand-written file may
            // well use the other, and neither is worth a puzzling error.
            let imap = map.get("imap").and_then(|v| v.as_object()).unwrap_or(map);
            let smtp = match map.get("smtp").and_then(|v| v.as_object()) {
                Some(s) => Some(Smtp {
                    host: required_string(s, "host")?,
                    port: port_at(s, "port", 587)?,
                    secure: bool_at(s, "secure", port_at(s, "port", 587)? == 465),
                }),
                None => None,
            };
            Ok(Config::Local(LocalDoor {
                imap_host: required_string(imap, "host").map_err(|_| {
                    "the local door needs the mail server's address".to_string()
                })?,
                imap_user: required_string(imap, "user").map_err(|_| {
                    "the local door needs the username the mail server knows you by".to_string()
                })?,
                imap_port: port_at(imap, "port", 993)?,
                imap_secure: bool_at(imap, "secure", true),
                smtp,
                address: string_at(map, "address"),
            }))
        }
        "cloud" => Ok(Config::Cloud(CloudDoor {
            cloud_url: checked_cloud_url(
                &required_string(map, "cloudUrl")
                    .map_err(|_| "the cloud door needs the hosted service's address".to_string())?,
            )?,
            address: required_string(map, "address")
                .map_err(|_| "the cloud door needs the mailbox address".to_string())?,
        })),
        other if other.is_empty() => Err("the configuration needs a mode".to_string()),
        other => Err(format!(
            "\"{other}\" is not a mode; this app has two doors, \"local\" and \"cloud\""
        )),
    }
}

/// The configuration as it is written to disk. The inverse of {@link parse}.
pub fn to_json(config: &Config) -> serde_json::Value {
    match config {
        Config::Local(l) => {
            let mut out = serde_json::json!({
                "mode": "local",
                "imap": {
                    "host": l.imap_host,
                    "user": l.imap_user,
                    "port": l.imap_port,
                    "secure": l.imap_secure,
                },
            });
            if let Some(smtp) = &l.smtp {
                out["smtp"] = serde_json::json!({
                    "host": smtp.host, "port": smtp.port, "secure": smtp.secure,
                });
            }
            if let Some(address) = &l.address {
                out["address"] = serde_json::Value::String(address.clone());
            }
            out
        }
        Config::Cloud(c) => serde_json::json!({
            "mode": "cloud",
            "cloudUrl": c.cloud_url,
            "address": c.address,
        }),
    }
}

/// Where this mode's mirror lives. See the module header — per-mode, and never shared.
pub fn data_dir(root: &Path, mode: Mode) -> PathBuf {
    root.join(mode.dir_name())
}

/// The engine's environment, composed from the configuration and the app's data directory.
///
/// **`OHMAIL_MODE=cloud` on the cloud branch is the safety-critical line in this file.** Read the
/// module header before touching it; the engine's DEFAULT branch is the local organizer, so an
/// omission here is not a missing feature, it is a second organizer on somebody's mailbox.
///
/// Everything else is settings the shell holds and the engine reads. There is deliberately no
/// password and no token: see the header.
pub fn env_for(config: &Config, root: &Path) -> Vec<(OsString, OsString)> {
    let pair = |k: &str, v: String| (OsString::from(k), OsString::from(v));
    let dir = data_dir(root, config.mode());
    let mut env = vec![(
        OsString::from(crate::engine::DATA_DIR_VAR),
        dir.into_os_string(),
    )];

    // ── THE OPERATOR'S OWN CERTIFICATE AUTHORITY, IF THEY HAVE PUT ONE HERE ─────────────────
    //
    // A person running their own ohmail server on a private name — `ohmail.test`, `mail.lan`,
    // anything only their DNS knows — issues their own certificates, because no public authority
    // can validate such a name. That is correct, and the shipped compose stack does exactly it.
    //
    // The engine is a Node process, and Node does NOT read the operating system's trust store: it
    // verifies against its own compiled-in roots. So a certificate from the operator's CA fails
    // there no matter what they have installed on the machine, and the app cannot see their server
    // at all. Measured against a real stack: a default handshake threw
    // `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, and the same handshake with this variable pointed at the
    // stack's exported root came back authorized.
    //
    // `NODE_EXTRA_CA_CERTS` ADDS a root. It never replaces the built-in set and never relaxes
    // verification, which is the whole reason this is the mechanism rather than an "allow
    // self-signed" switch: there is no way, anywhere in this app, to turn certificate checking off.
    //
    // COMPOSED ONLY WHEN THE FILE IS THERE. Node prints a warning for a path that does not exist,
    // on every launch, at every user — so the absent case must compose nothing. It is checked at
    // spawn rather than cached, so an operator who drops the file in and reopens the app is
    // covered, which is what the door's sentence tells them to do.
    //
    // ── AND ONLY ON A SELF-HOSTED CLOUD DOOR. THIS SAID "BOTH DOORS", AND THAT WAS WRONG ─────
    //
    // The variable is process-wide inside the engine it is given to: it widens who may satisfy
    // hostname verification for EVERY connection that process makes. The first version composed it
    // for both doors on the reasoning that an operator with a private CA on their IMAP server has
    // the same problem — true, and it ignored what else is in reach. A file left behind after
    // somebody moves back to the hosted service would then be trusted by the MANAGED door, so
    // whoever holds that CA key could present a certificate for `api.ohmail.app` and receive the
    // account's bearer and refresh token; on the local door, one for the user's own IMAP and SMTP
    // host, and receive the mailbox password. Raised by review of this slice.
    //
    // Scoped here, the blast radius is exactly the server the operator installed it for, and that
    // is structural rather than careful: a cloud-door engine composes NO IMAP or SMTP settings at
    // all (see the branch below, and `unset_for`, and the engine's own refusal to start in cloud
    // mode with any `OHMAIL_IMAP_*` present), so the only host it can dial is its configured base.
    // The managed base is excluded by name, so the door that holds the hosted session never runs
    // with a widened trust pool.
    //
    // A per-origin trust store would be tighter still — the CA attached to one HTTP client for one
    // hostname instead of to the process — and it is not what this does. What it needs is a custom
    // TLS dispatcher threaded through the bearer client, the mirror and the write-through proxy;
    // said plainly rather than implied, because the sentence above is the bound that actually holds
    // today.
    let self_hosted_cloud = match config {
        Config::Cloud(c) => is_self_hosted_cloud(&c.cloud_url),
        Config::Local(_) => false,
    };
    if self_hosted_cloud {
        let ca = root.join(OPERATOR_CA_FILE);
        if ca.is_file() {
            env.push((OsString::from("NODE_EXTRA_CA_CERTS"), ca.into_os_string()));
        }
    }
    match config {
        Config::Local(l) => {
            // No `OHMAIL_MODE` at all: the engine's default branch IS the local organizer, and
            // naming it here would be a second spelling of the same fact for the branch that does
            // not need one. The cloud branch below is where the variable is load-bearing.
            env.push(pair("OHMAIL_IMAP_HOST", l.imap_host.clone()));
            env.push(pair("OHMAIL_IMAP_USER", l.imap_user.clone()));
            env.push(pair("OHMAIL_IMAP_PORT", l.imap_port.to_string()));
            // The engine reads "0" and nothing else as "not implicit TLS", so the false case is
            // spelled exactly that way and every other value means secure.
            env.push(pair(
                "OHMAIL_IMAP_SECURE",
                if l.imap_secure { "1" } else { "0" }.to_string(),
            ));
            if let Some(smtp) = &l.smtp {
                env.push(pair("OHMAIL_SMTP_HOST", smtp.host.clone()));
                env.push(pair("OHMAIL_SMTP_PORT", smtp.port.to_string()));
                env.push(pair(
                    "OHMAIL_SMTP_SECURE",
                    if smtp.secure { "1" } else { "0" }.to_string(),
                ));
            }
            if let Some(address) = &l.address {
                env.push(pair("OHMAIL_MAILBOX_ADDRESS", address.clone()));
            }
        }
        Config::Cloud(c) => {
            // ── THE LINE. Removing it does not break a test about this function's shape; it
            // breaks `cloud_mode_is_composed_for_a_cloud_door`, which exists for exactly this
            // mutation. See the module header for what happens without it.
            env.push(pair("OHMAIL_MODE", "cloud".to_string()));
            env.push(pair("OHMAIL_CLOUD_URL", c.cloud_url.clone()));
            env.push(pair("OHMAIL_MAILBOX_ADDRESS", c.address.clone()));
        }
    }
    env
}

/// Variables that must not reach the child, whatever this process inherited.
///
/// Only the cloud door has any, and they are the IMAP settings: this process's own environment may
/// carry them (a developer's shell, a launcher script), the child inherits everything not
/// overridden, and the engine refuses to start in cloud mode if it finds one. Clearing them here
/// turns "the app will not start and the log says something about IMAP" into a launch that works.
///
/// It is a list of NAMES and not a prefix sweep, because a sweep would need the child's inherited
/// environment enumerated on this side, and `Command::env_remove` takes names. The list is the
/// engine's own documented `OHMAIL_IMAP_*` surface.
pub fn unset_for(config: &Config) -> Vec<OsString> {
    match config {
        Config::Local(_) => Vec::new(),
        Config::Cloud(_) => [
            "OHMAIL_IMAP_HOST",
            "OHMAIL_IMAP_USER",
            "OHMAIL_IMAP_PORT",
            "OHMAIL_IMAP_SECURE",
            "OHMAIL_IMAP_PASS",
            "OHMAIL_SMTP_HOST",
            "OHMAIL_SMTP_PORT",
            "OHMAIL_SMTP_SECURE",
        ]
        .iter()
        .map(OsString::from)
        .collect(),
    }
}

/// Read the stored configuration, or `None` when there is none / it cannot be read.
///
/// A file that exists and does not parse is `None` and not an error: the recovery is identical
/// either way — the app asks which door to come in by — and turning a corrupt byte into a refusal
/// to start would leave somebody with an app that will not open and a file they cannot see.
pub fn read(path: &Path) -> Option<Config> {
    let raw = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    parse(&value).ok()
}

/// Every staging file this process makes gets its own number. See {@link staging_path}.
static STAGING_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Where a replacement for `path` is staged: the same name in the SAME directory — which is what
/// makes the rename below a rename and not a copy across filesystems — with a suffix that is
/// UNIQUE TO ONE CALL.
///
/// ── THE FIXED NAME WAS A BUG, AND IT UNDID THE FIX IT WAS PART OF ──────────────────────────
///
/// This started as a constant `.tmp`, on the reasoning that these writes are serialized: one
/// configure command, driven by one window. That reasoning was WRONG, and a review checked it
/// where I had only asserted it — `engine_configure` and the host-mode commands are declared
/// `#[tauri::command(async)]`, so two invocations genuinely overlap, and nothing takes a writer
/// lock. Two writers sharing one staging name is worse than the truncating write this function
/// replaced: A creates and fills its staging file, B opens the SAME path `O_TRUNC` and empties
/// it, A renames B's now-empty inode over the live settings file — an empty configuration
/// published by a write that reported success, which is the exact failure this function exists
/// to make impossible, reached by a route the fixed name introduced.
///
/// The pid keeps two installs apart; the counter keeps two calls in one process apart.
///
/// THE RESIDUAL, STATED RATHER THAN SWEPT. A fixed name self-collected — the next write reused
/// it — and unique names do not: a crash between the create and the rename leaves one staging
/// file that nothing will reuse. Every failure this function can OBSERVE removes its own file
/// (see {@link write_private}); what is left is the crash case, which is a couple of hundred
/// bytes beside a file the app rewrites rarely. Collecting them would mean `read_dir` in this
/// module, and this module's filesystem reach is deliberately a short, asserted list — a
/// directory scan here buys less than the capability costs. If it ever needs collecting, the
/// place is the app's own startup, not the settings writer.
fn staging_path(path: &Path) -> PathBuf {
    let seq = STAGING_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.{seq}.tmp", std::process::id()));
    path.with_file_name(name)
}

/// Replace `path` with `body`, `0600` on Unix, WITHOUT EVER TRUNCATING IT.
///
/// ── WHY THIS IS NOT `fs::write` ────────────────────────────────────────────────────────────
///
/// `fs::write` opens the target `O_TRUNC`: for the width of that write the settings file is empty
/// or half-written, and {@link read} treats a file that does not parse as `None` — deliberately,
/// since the recovery is "ask which door" either way. So a crash, a power cut or an ENOSPC inside
/// that window left an install that had FORGOTTEN ITS DOOR, with the mailbox and the sealed
/// credential both intact behind it. Every configure has always written this way; the local door
/// now configures twice (the engine has to be replaced once the password is sealed, or a first
/// connect never syncs), which doubled the exposure and is what made it worth closing.
///
/// The replacement is staged beside the target and renamed over it. `rename(2)` is atomic on
/// POSIX, and `std::fs::rename` replaces an existing file on Windows too, so a reader sees either
/// the whole previous configuration or the whole new one and never a truncated byte. `sync_all`
/// before the rename is the other half: publishing a name that points at unflushed bytes would
/// reintroduce the same empty file by a different route.
///
/// The staging name is UNIQUE PER CALL — {@link staging_path} says why a fixed one was a defect.
fn write_private(path: &Path, body: &[u8]) -> Result<(), String> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("{} could not be created ({err})", parent.display()))?;
    }
    // EVERY failure from here on removes the staging file it made. Not tidiness: with unique
    // names nothing else will ever reuse that path, so a failure that returned without cleaning
    // up would leave litter for the life of the install.
    let failed = |err: std::io::Error, staged: &Path| -> String {
        let _ = fs::remove_file(staged);
        format!("{} could not be written ({err})", path.display())
    };

    // `create_new` rather than `create` + `truncate`, which matters for one reason worth naming:
    // it refuses to follow a SYMLINK someone left at that path. This directory is the user's own,
    // so the threat is another account on a shared machine, and the cost of the stricter open is
    // one retry — a path already taken is our own litter from a crashed run whose pid the system
    // has since handed out again, and a different number is all that needs.
    let (mut file, staged) = {
        let mut opened = None;
        for _ in 0..8 {
            let candidate = staging_path(path);
            let mut opts = fs::OpenOptions::new();
            opts.write(true).create_new(true);
            // Created private, rather than created world-readable and chmodded a moment later:
            // the mode has to hold for the file's whole life, and `fs::write` left a window
            // where it did not.
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            match opts.open(&candidate) {
                Ok(f) => {
                    opened = Some((f, candidate));
                    break;
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                // Nothing to clean up: this is the call that would have created the file.
                Err(err) => {
                    return Err(format!("{} could not be written ({err})", path.display()))
                }
            }
        }
        opened.ok_or_else(|| {
            format!("{} could not be written (no free staging name)", path.display())
        })?
    };

    file.write_all(body).map_err(|err| failed(err, &staged))?;
    // The bytes have to be on the disk BEFORE the rename publishes them, or a power cut between
    // the two leaves the new name pointing at an empty file.
    file.sync_all().map_err(|err| failed(err, &staged))?;
    drop(file);

    // A chmod that failed is an error, not a shrug: the mode is the whole reason this comment
    // block exists, and a file that stayed world-readable behind an Ok would never be looked at.
    // (With `create_new` + `mode(0o600)` the file is already private; this covers the platforms
    // and filesystems where the open's mode is not honoured verbatim.)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staged, fs::Permissions::from_mode(0o600)).map_err(|err| {
            let _ = fs::remove_file(&staged);
            format!("{} could not be made private ({err})", path.display())
        })?;
    }

    fs::rename(&staged, path).map_err(|err| failed(err, &staged))?;

    // Durability of the NAME, as distinct from the bytes: without this the rename can still be
    // lost by a crash even though the file it points at is on the disk. Best effort on purpose —
    // some filesystems refuse `fsync` on a directory descriptor, and turning that refusal into a
    // failed configure would be a worse bug than the durability gap it closes. The rename is
    // already atomic, so what is at risk here is only "did the last write survive a power cut",
    // never "is the file half-written".
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        let _ = fs::File::open(parent).and_then(|dir| dir.sync_all());
    }

    Ok(())
}

/// Write the configuration, creating the directory if it is not there.
///
/// Mode `0600` on Unix. Nothing secret is in it — see the header — but it names a mail server and a
/// username, which is nobody else's business on a shared machine. Replaced rather than truncated —
/// see {@link write_private} for why that distinction is the whole point.
pub fn write(path: &Path, config: &Config) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(&to_json(config))
        .map_err(|err| format!("the configuration could not be encoded ({err})"))?;
    write_private(path, &body)
}

/// Forget which door this install came in by. Absent is not an error.
pub fn remove(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("{} could not be removed ({err})", path.display())),
    }
}

// ── HOST MODE: the second setting this module keeps, in its own file ───────────────────────────
//
// Host mode publishes this install's mail engine to the user's own tailnet, so a phone can read
// mail through this process. Whether it is on — and which loopback port the engine's host door
// binds — has to survive a quit, exactly like the door choice above. It is a SECOND file rather
// than a field of `config.json` because the two are written by different hands: the window's
// door-configure command writes `config.json` whole from what it sent, and a host-mode setting
// stored inside it would be silently dropped by every reconfigure that did not know to carry it.
//
// The same refusal discipline as the door file: nothing secret is ever in it (it is one boolean
// and one port number), and a file that does not parse is DISABLED rather than an error — the
// dangerous branch (a network-published engine) must never be selected by a corrupt byte, only
// by a well-formed `true` somebody asked for.

/// What the host-mode file is called inside the app's data directory.
pub const HOST_FILE_NAME: &str = "host.json";

/// The persisted host-mode setting: whether it is armed, the loopback port the engine's
/// host door binds (which is also the target `tailscale serve` proxies to), and — when the
/// operator chose one — the LAN interface address the engine ALSO binds for same-network
/// access without Tailscale (API-only; the engine's `host-lan.ts` carries the decision).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostSettings {
    pub enabled: bool,
    pub port: u16,
    /// The chosen LAN address, verbatim — the ENGINE validates it (`resolveLanBind`) and a
    /// garbage value degrades the LAN half over there with a logged reason. `None` is off,
    /// which is the default: same-network access is opt-in on top of host mode's own opt-in.
    pub lan: Option<String>,
}

/// Read the host-mode setting. Absent, unreadable, malformed, or carrying port 0 all read as
/// DISABLED — the safe branch by construction, never by a value happening to be missing.
///
/// Port 0 is refused by name rather than passed along: it would mean "any free port", and the
/// port here is the fixed target a `tailscale serve` registration points at — a port the kernel
/// picks is a registration pointing at nothing.
pub fn read_host(path: &Path) -> Option<HostSettings> {
    let raw = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    let map = value.as_object()?;
    // A BOOLEAN, not anything truthy-looking: a hand-edited `"true"` is somebody who meant ON,
    // and reading it as off-with-a-port would look like a setting quietly ignored. The whole
    // file is refused instead, which reads as "never configured" — same recovery, honest state.
    let enabled = match map.get("enabled") {
        Some(serde_json::Value::Bool(b)) => *b,
        _ => return None,
    };
    let port = map.get("port").and_then(serde_json::Value::as_u64)?;
    if port == 0 || port > u16::MAX as u64 {
        return None;
    }
    // The LAN choice: absent and null are OFF (every file written before the option existed); a non-empty string
    // travels verbatim for the engine to judge; anything else refuses the whole file — the same
    // rule as `enabled`, because a hand-edited value this cannot read must not be half-honoured.
    let lan = match map.get("lan") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
        }
        _ => return None,
    };
    Some(HostSettings { enabled, port: port as u16, lan })
}

/// Write the host-mode setting. Same discipline as {@link write}: the directory is created if it
/// is not there, and the file is `0600` on Unix — it is nobody's business on a shared machine
/// whether this install publishes to a tailnet, or on which port.
pub fn write_host(path: &Path, settings: &HostSettings) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(&serde_json::json!({
        "enabled": settings.enabled,
        "port": settings.port,
        "lan": settings.lan,
    }))
    .map_err(|err| format!("the host-mode setting could not be encoded ({err})"))?;
    // Replaced rather than truncated, for the identical reason: `read_host` reads a file that does
    // not parse as "host mode off", so a torn write here silently un-publishes a running install.
    write_private(path, &body)
}

/// What the cloud engine seals its hosted session into, under this install's key.
///
/// Named here rather than in `engine.rs` because this module is the one that knows where each door
/// keeps its things, and because `engine.rs` deliberately reaches the filesystem for its log file
/// and nothing else — a guard over that file's `fs::` calls says so, and moving a file removal in
/// there would have relaxed it.
pub const CLOUD_SESSION_SEAL: &str = "cloud-tokens.seal";

/// Remove the sealed hosted session from the cloud door's directory.
///
/// ── WHY THE SHELL DOES THIS AT ALL, WHEN THE ENGINE ALSO DOES ─────────────────────────────────
///
/// Signing out asks the engine to drop the session first, over the bridge, and that is the path
/// that runs almost every time. This is the one that covers the case the bridge cannot: an engine
/// that was never serving — it failed to start, it is mid-restart, the app has just been opened on
/// a broken install — has nothing in memory to clear and no way to be asked. A sealed session left
/// behind by a sign-out is a live credential to somebody's mail.
///
/// ONE FILE. Not the mirror, not the cursor: a door switch freezes the directory it leaves.
/// Absent is not an error — a sign-out on a door that was never signed in is a no-op, and running
/// this twice must not fail the second time.
pub fn remove_sealed_session(root: &Path, mode: Mode) -> Result<(), String> {
    let path = data_dir(root, mode).join(CLOUD_SESSION_SEAL);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("{} could not be removed ({err})", path.display())),
    }
}
