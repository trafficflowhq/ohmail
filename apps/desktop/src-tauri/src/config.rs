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
//! directory a switch leaves behind is FROZEN, never deleted.** The mail is on the user's server
//! or in the hosted account, this machine's copy is a convenience, and a door switch that silently
//! destroyed the old one would make going back expensive for no reason. The one removal here is a
//! pairing's set-aside copy, retired once the pairing is accepted (the foot of this file).
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

/// Which shape of server a cloud door opens. `None` is every door written before the fourth one.
///
/// A STRING AND NOT AN ENUM OF ONE, because the value's authority is the SERVER's own greeting —
/// the engine's probe reads `flavor` out of `/hello` and the window hands back what it was told.
/// A closed Rust enum here would make the shell the authority on a vocabulary it does not own, and
/// a server announcing a flavor this build has not heard of must degrade to "a cloud door" rather
/// than fail to parse a settings file the app has already written.
pub type DoorFlavor = Option<String>;

/// The flavor that changes how the door behaves rather than merely how it is labelled.
pub const DESKTOP_HOST_FLAVOR: &str = "desktop-host";

/// The cloud door: a hosted account, a server the person runs, or another computer's desktop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloudDoor {
    pub cloud_url: String,
    /// **`None` ONLY on a desktop-host door and the pending door** (`identity_pending`), and the
    /// absence is a fact rather than a gap.
    ///
    /// The other two cloud doors are entered by naming a mailbox: somebody types the address they
    /// sign in with, and the mirror is that address's. A pairing link names a COMPUTER. Which
    /// mailbox this install ends up reading is the host's answer to the redeem, and it is not
    /// known — by anyone — at the moment the door is written.
    ///
    /// It is kept optional HERE rather than made optional on the shared cloud shape, so that an
    /// absent address on the hosted door stays what it has always been: a mirror belonging to
    /// nobody, refused at parse.
    pub address: Option<String>,
    /// See {@link DoorFlavor}. `None` means a door written before the fourth one existed.
    pub flavor: DoorFlavor,
    /// base64url `SHA-256(SubjectPublicKeyInfo)` of the paired computer's key, from the link.
    ///
    /// Written together with `flavor: "desktop-host"` and never apart from it: a desktop-host door
    /// with no pin cannot authenticate what answers at its address at all, so the two are one
    /// fact. `None` on every other door, where the platform's trust store is the authority.
    pub host_pin: Option<String>,
    /// THE HOSTED DOOR BEFORE ITS ACCOUNT IS KNOWN — the browser approval's first boot.
    ///
    /// A positive fact, never an absent address: the engine is told "identity pending" and adopts
    /// the account at the first approval claim, writing `config.json`'s door itself. `true` only on
    /// the managed service with no address, flavor or pin (`parse`); never written to disk here.
    pub identity_pending: bool,
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
    ///
    /// `None` on a desktop-host door until the pairing has answered — see `CloudDoor::address`.
    /// Callers that render this must show nothing rather than a placeholder: a hostname in a field
    /// that says "your mailbox" is a false state, and this door's own label comes from its address
    /// bar (`baseUrl`) rather than from here.
    pub fn address(&self) -> Option<&str> {
        match self {
            Config::Local(l) => l.address.as_deref().or(Some(l.imap_user.as_str())),
            Config::Cloud(c) => c.address.as_deref(),
        }
    }

    /// Is this the door that opens another computer's desktop?
    pub fn is_desktop_host(&self) -> bool {
        matches!(self, Config::Cloud(c) if c.flavor.as_deref() == Some(DESKTOP_HOST_FLAVOR))
    }

    /// Is this the hosted door waiting for its account? See `CloudDoor::identity_pending`.
    pub fn is_identity_pending(&self) -> bool {
        matches!(self, Config::Cloud(c) if c.identity_pending)
    }
}

/// The engine's "identity pending" flag, composed only for the door above and always as `1`.
pub const IDENTITY_PENDING_VAR: &str = "OHMAIL_IDENTITY_PENDING";

/// Where the pending door's claim writes this install's door — this directory's `config.json`.
pub const DOOR_FILE_VAR: &str = "OHMAIL_DOOR_FILE";

/// What the file is called inside the app's data directory.
pub const CONFIG_FILE_NAME: &str = "config.json";

/// Where a CANDIDATE door's engine keeps its scratch: its own directory, beside the two real ones
/// and never either of them.
///
/// The paired door's first step asks whether the computer at a pasted address is the one the link
/// came from, and a fresh install has no engine to ask. So the shell starts one FOR THE CANDIDATE
/// — and it is pointed here rather than at `engine-cloud`, so that a refused candidate has written
/// nothing a real door will ever read and the whole of it can be removed by removing one
/// directory. A candidate is a question about somebody else's machine, not a door.
pub const CANDIDATE_DIR_NAME: &str = "engine-candidate";

/// The candidate engine's directory under the app's data root.
pub fn candidate_data_dir(root: &Path) -> PathBuf {
    root.join(CANDIDATE_DIR_NAME)
}

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
///  · a host this process cannot read as written. The URL standard MAPS and DECODES a host, so
///    `api%2Eohmail.app` and the fullwidth spelling are both the hosted service to the engine and
///    a different server to any fold available here — see [`door_host`];
///  · `http://` for anything but LOOPBACK. The refusal below has always promised that and this
///    function did not enforce it, so a stored door could put the mailbox password and the
///    authenticator code on the wire in the clear;
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
    // A HOST THIS PROCESS CANNOT READ IS REFUSED, NOT MERELY DISTRUSTED. Withholding the operator
    // CA from it silently would be the worse half of the same bug: the handshake then fails with
    // an issuer error and the refusal tells the operator to install the file they already have.
    let host = match door_host(trimmed) {
        Some(h) => h,
        None => {
            return Err(
                "the cloud door's address must name a plain host — letters, digits, dots, dashes \
                 or an address in brackets — and an international name in its punycode form"
                    .to_string(),
            )
        }
    };
    // CLEARTEXT REACHES THIS COMPUTER AND NOWHERE ELSE. The window refuses it twice already
    // (`cloud-origin.ts`'s `normalizeOrigin`, `doors.ts`'s `hostLinkProblem`); this is the same
    // floor where the value is WRITTEN, which is the boundary the engine is downstream of. Not
    // every value arriving here is typed: a paired computer's base comes back through the probe.
    if trimmed.starts_with("http://") && !is_loopback(&host) {
        return Err(
            "the cloud door's address may only use http:// for a server on this machine; \
             anywhere else it would send the password in the clear"
                .to_string(),
        );
    }
    Ok(trimmed.to_string())
}

/// The HOST a cloud door's address names, lower-cased — or `None` when it names none this process
/// can read as written.
///
/// The engine's `normalizeOrigin` is this rule with a real URL parser behind it. This process links
/// none, so the reduction is by hand and the host alphabet is stated POSITIVELY, because the URL
/// standard both MAPS and DECODES a host: `api%2Eohmail.app` percent-decodes and the fullwidth
/// spelling IDNA-maps, each onto the hosted service — while any fold available here reads somebody
/// else's server and hands it the operator CA. A backslash is a third: the standard reads it as a
/// SEPARATOR, so `api.ohmail.app\evil` is the hosted service to the engine — refused here rather
/// than reinterpreted, the same conservatism `#` and `?` get. ADMITTED: letters, digits, `.`, `-`,
/// `_`, or a bracketed address. Everything else is `None` — userinfo included, so a credential
/// cannot ride inside an authority — which [`checked_cloud_url`] refuses and every other caller
/// reads as "cannot be established", never as a default.
fn door_host(cloud_url: &str) -> Option<String> {
    let trimmed = cloud_url.trim();
    let rest = if let Some(r) = trimmed.strip_prefix("https://") {
        r
    } else if let Some(r) = trimmed.strip_prefix("http://") {
        r
    } else {
        return None;
    };

    // The authority runs to the first delimiter.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }

    // A bracketed address carries its port after the bracket; anywhere else a second colon means
    // this is not an authority this function can read.
    let (host, port_text) = if authority.starts_with('[') {
        let close = authority.find(']')?;
        let (h, tail) = authority.split_at(close + 1);
        match tail {
            "" => (h, None),
            t => (h, Some(t.strip_prefix(':')?)),
        }
    } else {
        match authority.split_once(':') {
            None => (authority, None),
            Some((h, p)) if !p.contains(':') => (h, Some(p)),
            Some(_) => return None,
        }
    };

    // The port is VALIDATED and then DISCARDED: an unreadable one means this address cannot be
    // established, and a readable one tells nobody anything — a forged certificate names the host,
    // so no port can make one safe. An absent or empty port is the scheme's default, which is what
    // the standard makes of `https://h:`.
    match port_text {
        None | Some("") => {}
        Some(p) if p.bytes().all(|b| b.is_ascii_digit()) => match p.parse::<u32>() {
            Ok(n) if n <= 65535 => {}
            _ => return None,
        },
        Some(_) => return None,
    }

    let host = host.to_ascii_lowercase();
    let readable = if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        !inner.is_empty() && inner.bytes().all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.')
    } else {
        !host.is_empty()
            && host
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-_".contains(&b))
    };
    if readable {
        Some(host)
    } else {
        None
    }
}

/// Is this host this computer, so a cleartext connection never leaves it?
///
/// The engine's set exactly (`cloud-origin.ts`'s `isLoopbackHost`): `localhost` and any name under
/// it, all of `127.0.0.0/8`, and `::1` as an authority spells it. DELIBERATELY NOT "private" or
/// "link-local" — `10.x`, `192.168.x` and `169.254.x` are reachable from every other machine on
/// that network, which is where an on-path peer would be. The DNS root dot is NOT folded here and
/// an uncompressed `[0:0:0:0:0:0:0:1]` is not admitted: nothing here canonicalizes either, and no
/// is the safe answer to a spelling this function cannot reduce.
fn is_loopback(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") || host == "[::1]" {
        return true;
    }
    let octets: Vec<&str> = host.split('.').collect();
    octets.len() == 4
        && octets[0] == "127"
        && octets
            .iter()
            .all(|o| o.bytes().all(|b| b.is_ascii_digit()) && o.parse::<u8>().is_ok())
}

/// Whether a cloud door points at somebody's OWN server rather than at the hosted service.
///
/// Compared on the HOST, with the DNS root dot folded at the comparison and nowhere else. Not on
/// the whole string: a trailing slash, a folded case, `:443`, a composed `/api` and the root dot
/// are all the same server, and reading any of them as self-hosted hands the operator CA to the
/// door holding the hosted session — the whole thing [`env_for`]'s scoping exists to prevent. Not
/// on the port either: a forged certificate names the host, so a port cannot make one safe. A host
/// that cannot be ESTABLISHED on either side is NOT self-hosted, the fail-closed rule the engine's
/// `mirrorIsForeign` applies to a mirror's owner.
fn is_self_hosted_cloud(cloud_url: &str) -> bool {
    let root = |h: &str| h.trim_end_matches('.').to_string();
    match (door_host(cloud_url), door_host(MANAGED_CLOUD_BASE)) {
        (Some(door), Some(managed)) => root(&door) != root(&managed),
        _ => false,
    }
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

/// The record beside the file above: the origin the authority was installed for, and its digest.
///
/// A certificate authority is a statement about a NAME, so the file alone cannot say whose server
/// it belongs to — and the shell handed it to whatever self-hosted door was configured, which is
/// the finding this record closes. See [`operator_ca_for`].
pub const OPERATOR_CA_RECORD_FILE: &str = "cloud-ca.json";

/// A door's ORIGIN — scheme, host and non-default port, lower-cased, with no path.
///
/// [`door_host`] is the reader that decides whether an address can be read at all, and it
/// deliberately DISCARDS the port: no port can make a forged certificate safe, so trust WIDTH is a
/// question about the host. Identity is a different question — two ports on one machine are two
/// servers to whoever runs them — so the record keeps the port that function throws away. The
/// scheme's own default (`:443` on https, `:80` on http) and the DNS root dot are folded, as they
/// are in [`is_self_hosted_cloud`]: they name the same server, and a record that did not fold them
/// would withhold a working authority over a character somebody retyped.
fn door_origin(cloud_url: &str) -> Option<String> {
    let host = door_host(cloud_url)?;
    let host = host.trim_end_matches('.').to_string();
    let trimmed = cloud_url.trim();
    let (scheme, rest) = match trimmed.strip_prefix("https://") {
        Some(rest) => ("https", rest),
        None => ("http", trimmed.strip_prefix("http://")?),
    };
    // The authority's port, read the way `door_host` reads it — that function VALIDATED it (digits,
    // 1..=65535) and then dropped it, so nothing unreadable reaches the parse below.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let port_text = if authority.starts_with('[') {
        let close = authority.find(']')?;
        match authority.split_at(close + 1).1 {
            "" => None,
            tail => Some(tail.strip_prefix(':')?),
        }
    } else {
        match authority.split_once(':') {
            None => None,
            Some((_, p)) if !p.contains(':') => Some(p),
            Some(_) => return None,
        }
    };
    let port = match port_text {
        None | Some("") => None,
        Some(p) => Some(p.parse::<u32>().ok()?),
    };
    let port = match (scheme, port) {
        ("https", Some(443)) | ("http", Some(80)) => None,
        (_, p) => p,
    };
    Some(match port {
        Some(p) => format!("{scheme}://{host}:{p}"),
        None => format!("{scheme}://{host}"),
    })
}

/// What a launch does with the operator's certificate authority, and why.
enum OperatorCa {
    /// Compose it: the record names this door, and the file is the one the record was written for.
    Compose(PathBuf),
    /// Withhold it, carrying the sentence that says whose authority it is and what to do next.
    Withhold(String),
    /// None is installed here. The ordinary case, and it says nothing.
    Absent,
}

/// Decide the authority for `cloud_url`: composed only for the origin it was installed for.
///
/// A file with NO record predates this build, so it is ADOPTED ONCE — the record is written for the
/// door configured at that moment and the authority composed, which is what carries a working
/// self-host through the upgrade. A later door change to another origin gets no authority and the
/// sentence names whose it is. The file is never removed; the RECORD is the thing to remove, and
/// the sentence says so, because re-installing an authority for the door you are on is the one
/// case where re-adopting is what the person means.
///
/// `adopt` is false on the candidate walk: a candidate is a question about somebody else's machine
/// rather than a door, and binding this install's authority to one would be a record nobody chose.
fn operator_ca_for(root: &Path, cloud_url: &str, adopt: bool) -> OperatorCa {
    let ca = root.join(OPERATOR_CA_FILE);
    if !ca.is_file() {
        return OperatorCa::Absent;
    }
    let Some(origin) = door_origin(cloud_url) else {
        return OperatorCa::Withhold(format!(
            "this door's address names no server this app can read, so {OPERATOR_CA_FILE} is not \
             being used to check the server's identity"
        ));
    };
    let digest = match fs::read(&ca) {
        Ok(bytes) => sha256_hex(&bytes),
        Err(err) => {
            return OperatorCa::Withhold(format!(
                "{OPERATOR_CA_FILE} could not be read ({err}), so it is not being used to check \
                 this server's identity"
            ))
        }
    };
    let record = root.join(OPERATOR_CA_RECORD_FILE);
    match read_ca_record(&record) {
        Some((installed_for, installed_sha)) if installed_for == origin && installed_sha == digest => {
            OperatorCa::Compose(ca)
        }
        Some((installed_for, _)) if installed_for != origin => OperatorCa::Withhold(format!(
            "the certificate authority installed here belongs to {installed_for}, and this door is \
             {origin}, so it is not being used to check this server's identity. Remove \
             {OPERATOR_CA_RECORD_FILE} from this app's data folder to install the authority for \
             the door you are on."
        )),
        Some((installed_for, _)) => OperatorCa::Withhold(format!(
            "{OPERATOR_CA_FILE} has changed since it was installed for {installed_for}, so it is \
             not being used to check this server's identity. Remove {OPERATOR_CA_RECORD_FILE} from \
             this app's data folder to install the file that is there now."
        )),
        None if !adopt => OperatorCa::Withhold(format!(
            "{OPERATOR_CA_FILE} names no server it was installed for, and a candidate walk does \
             not claim one"
        )),
        None => match write_ca_record(&record, &origin, &digest) {
            Ok(()) => OperatorCa::Compose(ca),
            Err(reason) => OperatorCa::Withhold(format!(
                "{OPERATOR_CA_FILE} names no server it was installed for and the record could not \
                 be written ({reason}), so it is not being used to check this server's identity"
            )),
        },
    }
}

/// The file's digest, lower-case hex. The record's other half: an origin on its own would be a
/// statement about whatever bytes happen to be in the file now.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut out = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// The record, or `None` when there is none or it cannot be read.
///
/// Unreadable reads as ABSENT — the rule [`read`] keeps for the door file. A record is a note this
/// app wrote to itself, and a corrupt byte in it must not strand somebody's own server behind a
/// refusal they cannot see; adopting again for the door in front of them is the same decision the
/// upgrade makes, and anyone who can rewrite this file can write a record of their own anyway.
fn read_ca_record(path: &Path) -> Option<(String, String)> {
    let raw = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    let map = value.as_object()?;
    Some((string_at(map, "origin")?, string_at(map, "sha256")?))
}

/// Write the record. `0600` and replaced rather than truncated, like every other file this module
/// keeps — a torn record reads as absent, which would adopt the file again for the door of the day.
fn write_ca_record(path: &Path, origin: &str, sha256: &str) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(&serde_json::json!({
        "origin": origin,
        "sha256": sha256,
    }))
    .map_err(|err| format!("the record could not be encoded ({err})"))?;
    write_private(path, &body)
}

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
        "cloud" => {
            let flavor = string_at(map, "flavor");
            let is_host = flavor.as_deref() == Some(DESKTOP_HOST_FLAVOR);
            let host_pin = string_at(map, "hostPin");
            // THE TWO ARE ONE FACT, in both directions, and each direction is a different hazard.
            // A desktop-host door with no pin cannot authenticate what answers at its address; a
            // pin on any other door is a value nothing reads, which is worse than useless because
            // a later reader takes it for protection that is in force.
            if is_host && host_pin.is_none() {
                return Err(
                    "a door that opens another computer needs that computer's identity from the \
                     pairing link"
                        .to_string(),
                );
            }
            if !is_host && host_pin.is_some() {
                return Err(
                    "only a door that opens another computer carries an identity fingerprint"
                        .to_string(),
                );
            }
            let address = string_at(map, "address");
            // THE PENDING DOOR IS THE EXACT BOOLEAN, the rule `read_host` keeps for `enabled`: a
            // truthy near-miss must not boot a hosted door with no address. It carries nothing a
            // later claim decides — no address, and no flavor or pin, which belong to other doors.
            let identity_pending =
                matches!(map.get("identityPending"), Some(serde_json::Value::Bool(true)));
            if identity_pending && (address.is_some() || flavor.is_some() || host_pin.is_some()) {
                return Err(
                    "a door waiting for its account names no address, flavor or computer yet"
                        .to_string(),
                );
            }
            // AN ABSENT ADDRESS IS ADMISSIBLE ONLY HERE. A pairing link names a computer, and
            // which mailbox this install reads is the host's answer to the redeem; the pending door
            // learns its account from the approval claim. Anywhere else it is a mirror of nobody.
            if !is_host && !identity_pending && address.is_none() {
                return Err("the cloud door needs the mailbox address".to_string());
            }
            let cloud_url = checked_cloud_url(
                &required_string(map, "cloudUrl")
                    .map_err(|_| "the cloud door needs the hosted service's address".to_string())?,
            )?;
            // The browser approval is ohmail Cloud's ceremony (the engine refuses it elsewhere), so a
            // pending door on somebody's own server would be a door nothing can ever complete.
            if identity_pending && is_self_hosted_cloud(&cloud_url) {
                return Err(
                    "only ohmail Cloud can be set up by confirming in a browser; your own server \
                     needs its address and your password"
                        .to_string(),
                );
            }
            Ok(Config::Cloud(CloudDoor { cloud_url, address, flavor, host_pin, identity_pending }))
        }
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
        Config::Cloud(c) => {
            let mut out = serde_json::json!({
                "mode": "cloud",
                "cloudUrl": c.cloud_url,
            });
            // OMITTED RATHER THAN NULL for each of the three, so a door written by this build and
            // read by an older one is the shape that build already understands — and so that a
            // round trip through this function is byte-stable for every existing door.
            if let Some(address) = &c.address {
                out["address"] = serde_json::Value::String(address.clone());
            }
            if let Some(flavor) = &c.flavor {
                out["flavor"] = serde_json::Value::String(flavor.clone());
            }
            if let Some(pin) = &c.host_pin {
                out["hostPin"] = serde_json::Value::String(pin.clone());
            }
            if c.identity_pending {
                out["identityPending"] = serde_json::Value::Bool(true);
            }
            out
        }
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
/// [`env_for`] with the engine's data directory replaced — the candidate walk's one use.
///
/// The override is applied BY NAME rather than by position, so it cannot silently stop working the
/// day the data directory stops being the first pair composed; a composition that carried no data
/// directory at all would be a candidate engine pointed at the real mirror, so its absence is a
/// refusal rather than an append.
pub fn env_for_in(
    config: &Config,
    root: &Path,
    dir: &Path,
) -> Result<Vec<(OsString, OsString)>, String> {
    let key = OsString::from(crate::engine::DATA_DIR_VAR);
    let mut env = env_for_door(config, root, false);
    let mut replaced = 0;
    for pair in env.iter_mut() {
        if pair.0 == key {
            pair.1 = dir.as_os_str().to_os_string();
            replaced += 1;
        }
    }
    if replaced != 1 {
        return Err(format!(
            "the candidate environment named the engine's data directory {replaced} times"
        ));
    }
    Ok(env)
}

pub fn env_for(config: &Config, root: &Path) -> Vec<(OsString, OsString)> {
    env_for_door(config, root, true)
}

/// [`env_for`], with the one decision the candidate walk takes differently: whether a record-less
/// operator CA may be ADOPTED for the door being composed. See [`operator_ca_for`].
fn env_for_door(config: &Config, root: &Path, adopt: bool) -> Vec<(OsString, OsString)> {
    let pair = |k: &str, v: String| (OsString::from(k), OsString::from(v));
    let dir = data_dir(root, config.mode());
    let mut env = vec![(
        OsString::from(crate::engine::DATA_DIR_VAR),
        dir.into_os_string(),
    )];

    // ── WHICH BUILD THE ENGINE IS, ANSWERED BY THE SHELL THAT SPAWNED IT ────────────────────
    //
    // The download is one artifact with two halves: this shell and the engine it runs. The
    // window has always named its own commit (`build-id.ts`), the engine could name none, and
    // `verify-engine-repro.mjs` could therefore compare two local builds and never the shipped
    // pair. Baked by `build.rs` from the same variable the window's label is folded from, handed
    // over here, published at `/health` — so the two halves of one download either name one
    // commit or say `unknown`, and the repro gate refuses both disagreement and `unknown`.
    env.push(pair(
        crate::engine::BUILD_COMMIT_VAR,
        crate::engine::build_commit().to_string(),
    ));

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
    // The managed base is excluded by its HOST, so the door that holds the hosted session never runs
    // with a widened trust pool.
    //
    // A per-origin trust store would be tighter still — the CA attached to one HTTP client for one
    // hostname instead of to the process — and it is not what this does. What it needs is a custom
    // TLS dispatcher threaded through the bearer client, the mirror and the write-through proxy;
    // said plainly rather than implied, because the sentence above is the bound that actually holds
    // today.
    //
    // ── AND ONLY FOR THE SERVER IT WAS INSTALLED FOR. THE SCOPE ABOVE IS A KIND, NOT A NAME ──
    //
    // Everything above narrows the authority to self-hosted doors as a CLASS, which leaves the
    // second half of the same finding open: an operator who moves this install from server A to
    // server B keeps a file installed for A, and A's authority can then issue a certificate for
    // B's name and receive B's bearer traffic. So the file is bound to the origin it was installed
    // for by a record beside it, and `operator_ca_for` composes it for that origin and no other.
    let authority = match config {
        Config::Cloud(c) if is_self_hosted_cloud(&c.cloud_url) => {
            operator_ca_for(root, &c.cloud_url, adopt)
        }
        _ => OperatorCa::Absent,
    };
    match authority {
        OperatorCa::Compose(ca) => {
            env.push((OsString::from("NODE_EXTRA_CA_CERTS"), ca.into_os_string()));
        }
        // LOGGED, not rendered: this shell has no seam for a sentence about a file, and the engine
        // refuses the handshake a moment later with a message about the server. This line is what
        // says which of the two servers the authority on disk belongs to.
        OperatorCa::Withhold(why) => crate::engine::log_line(format_args!("{why}")),
        OperatorCa::Absent => {}
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
            if let Some(address) = &c.address {
                env.push(pair("OHMAIL_MAILBOX_ADDRESS", address.clone()));
            }
            // ── THE PAIRED COMPUTER'S IDENTITY ──────────────────────────────────────────────
            //
            // What turns every connection the engine opens into a pinned one. It is composed only
            // when the door carries it, and `parse` refuses a door that carries it without the
            // flavor or the flavor without it — so this line cannot put a pin on a door where
            // nothing would check it, and cannot leave one off a door that needs it.
            //
            // It is NOT a secret. The fingerprint is a hash of a public key, printed on the other
            // machine's screen for somebody to carry across a room; the rule this file states
            // about credentials never becoming command arguments is about the pairing TOKEN, which
            // goes down the bridge and never through here.
            if let Some(pin) = &c.host_pin {
                env.push(pair("OHMAIL_HOST_PIN", pin.clone()));
            }
            // ── THE PENDING DOOR: a flag and the file its claim writes, never an empty address ──
            // The engine adopts the account at the first approval claim and creates `config.json`
            // with it; the path is this install's own, beside the mirrors.
            if c.identity_pending {
                env.push(pair(IDENTITY_PENDING_VAR, "1".to_string()));
                env.push((
                    OsString::from(DOOR_FILE_VAR),
                    root.join(CONFIG_FILE_NAME).into_os_string(),
                ));
            }
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
        // The four door facts go too: each cloud door composes its own after the removal, and an
        // inherited one would give a pending door an address or a hosted door a pending flag.
        Config::Cloud(_) => [
            "OHMAIL_IMAP_HOST",
            "OHMAIL_IMAP_USER",
            "OHMAIL_IMAP_PORT",
            "OHMAIL_IMAP_SECURE",
            "OHMAIL_IMAP_PASS",
            "OHMAIL_SMTP_HOST",
            "OHMAIL_SMTP_PORT",
            "OHMAIL_SMTP_SECURE",
            "OHMAIL_MAILBOX_ADDRESS",
            "OHMAIL_HOST_PIN",
            IDENTITY_PENDING_VAR,
            DOOR_FILE_VAR,
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
    /// THE PORT A STAND-DOWN LEFT BEHIND, and the reason this file has a second port field.
    ///
    /// [`port`](Self::port) is the port to offer back when the person arms again. This one is
    /// the port host mode actually PUBLISHED and has now stopped serving: a `tailscale serve`
    /// registration points at a fixed loopback port, the withdrawal can refuse or the CLI can
    /// be gone, so the port must stay held rather than fall to whatever binds it next. The
    /// engine holds it on `OHMAIL_HOST_STAND_DOWN` (`host-listener.ts`), and this field is what
    /// carries the fact across a quit. `None` on every install that never armed, and cleared
    /// again the moment host mode is armed — the armed door binds the port itself.
    pub published: Option<u16>,
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
    // The stood-down port: absent and null are "nothing is held" — every file written before
    // this field existed, and every install that never armed. A number outside 1..=65535 refuses
    // the WHOLE file, the same rule `enabled` and `lan` follow: a port this cannot read must not
    // be half-honoured, and the recovery is identical to "never configured".
    let published = match map.get("published") {
        None | Some(serde_json::Value::Null) => None,
        Some(v) => {
            let n = v.as_u64()?;
            if n == 0 || n > u16::MAX as u64 {
                return None;
            }
            Some(n as u16)
        }
    };
    Some(HostSettings { enabled, port: port as u16, lan, published })
}

/// Write the host-mode setting. Same discipline as {@link write}: the directory is created if it
/// is not there, and the file is `0600` on Unix — it is nobody's business on a shared machine
/// whether this install publishes to a tailnet, or on which port.
pub fn write_host(path: &Path, settings: &HostSettings) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(&serde_json::json!({
        "enabled": settings.enabled,
        "port": settings.port,
        "lan": settings.lan,
        "published": settings.published,
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

// ── A DOOR SWITCH THAT HAS NOT BEEN ANSWERED YET ──────────────────────────────────────────────
//
// A pairing started from a door writes its own door before the other computer answers, because
// the redeem needs the configured engine. Until that answer it is PROVISIONAL: the door it
// replaced is kept whole — its `config.json` in the record below, and the directory the new door
// opens set aside with everything in it — so a refusal, a walk out of time, an abandoned window
// or a killed app puts that door back exactly. Only an accepted pairing retires what was set
// aside, which is the copy the new door's own launch used to discard (a mirror of another server).

/// The record of a provisional switch. Its PRESENCE is the provisional state, on disk.
pub const SWITCH_FILE_NAME: &str = "door-switch.json";

/// What a set-aside directory is called beside the one it was: `engine-cloud.replaced`.
pub const REPLACED_SUFFIX: &str = ".replaced";

/// A provisional switch, as its record holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DoorSwitch {
    /// The replaced door's `config.json`, byte for byte, so the restore is that file and no other.
    pub replaced_file: String,
    /// The mode whose directory the NEW door opens.
    pub dir: Mode,
    /// Whether that directory existed and was set aside; `false` means the new door created it.
    pub moved: bool,
}

pub fn switch_path(root: &Path) -> PathBuf {
    root.join(SWITCH_FILE_NAME)
}

/// Where `mode`'s directory is kept while a switch is provisional.
pub fn replaced_store(root: &Path, mode: Mode) -> PathBuf {
    root.join(format!("{}{REPLACED_SUFFIX}", mode.dir_name()))
}

/// The door file's own text when it holds a door this shell can read — what a switch keeps.
pub fn read_door_file(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    parse(&value).ok().map(|_| raw)
}

/// The provisional switch on disk. `Ok(None)` is none; a record that exists and cannot be read is
/// an `Err`, never `None`: its set-aside directory may be somebody's only copy of that door.
pub fn read_switch(root: &Path) -> Result<Option<DoorSwitch>, String> {
    let path = switch_path(root);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("{} could not be read ({err})", path.display())),
    };
    let unreadable = || format!("{} does not hold a door switch this build can read", path.display());
    let value = serde_json::from_str::<serde_json::Value>(&raw).map_err(|_| unreadable())?;
    let replaced_file = value.get("replaced").and_then(|v| v.as_str()).ok_or_else(unreadable)?;
    let dir = match value.get("dir").and_then(|v| v.as_str()) {
        Some("local") => Mode::Local,
        Some("cloud") => Mode::Cloud,
        _ => return Err(unreadable()),
    };
    let moved = value.get("moved").and_then(|v| v.as_bool()).ok_or_else(unreadable)?;
    Ok(Some(DoorSwitch { replaced_file: replaced_file.to_string(), dir, moved }))
}

/// Write the record of a switch from the door in `replaced_file` to a door that opens `dir`'s
/// directory. Written BEFORE anything moves, so every later step is undone from it.
pub fn record_switch(root: &Path, replaced_file: &str, dir: Mode) -> Result<DoorSwitch, String> {
    // A set-aside directory with no record is an accepted switch's unfinished retire.
    retire_replaced(root, dir)?;
    let moved = data_dir(root, dir).exists();
    let body = serde_json::to_vec_pretty(&serde_json::json!({
        "replaced": replaced_file, "dir": dir.as_str(), "moved": moved,
    }))
    .map_err(|err| format!("the door switch could not be encoded ({err})"))?;
    write_private(&switch_path(root), &body)?;
    Ok(DoorSwitch { replaced_file: replaced_file.to_string(), dir, moved })
}

/// Set the new door's directory aside whole. The engine that held it must already be stopped.
pub fn set_aside(root: &Path, switch: &DoorSwitch) -> Result<(), String> {
    if !switch.moved {
        return Ok(());
    }
    let (dir, aside) = (data_dir(root, switch.dir), replaced_store(root, switch.dir));
    fs::rename(&dir, &aside)
        .map_err(|err| format!("{} could not be set aside ({err})", dir.display()))
}

/// Put the replaced door back: its directory where it was, the new door's gone, its
/// `config.json`, and the record last. Every step is safe to run again after a kill mid-way.
pub fn undo_switch(root: &Path, config_path: &Path, switch: &DoorSwitch) -> Result<(), String> {
    let (dir, aside) = (data_dir(root, switch.dir), replaced_store(root, switch.dir));
    // With `moved`, an absent set-aside directory means it is already back where it was.
    if !switch.moved || aside.exists() {
        remove_tree(&dir)?;
    }
    if switch.moved && aside.exists() {
        fs::rename(&aside, &dir)
            .map_err(|err| format!("{} could not be put back ({err})", aside.display()))?;
    }
    write_private(config_path, switch.replaced_file.as_bytes())?;
    remove(&switch_path(root))
}

/// Keep the new door. Removing the record IS the commit, and an `Err` means nothing changed. The
/// set-aside directory follows it; one that would not go is the `Ok` reason, retired at next launch.
pub fn keep_switch(root: &Path, switch: &DoorSwitch) -> Result<Option<String>, String> {
    remove(&switch_path(root))?;
    Ok(retire_replaced(root, switch.dir).err())
}

/// Remove a set-aside directory. Every caller has no record on disk: before one is written, after
/// the commit removed it, or at a launch that read none.
pub fn retire_replaced(root: &Path, mode: Mode) -> Result<(), String> {
    remove_tree(&replaced_store(root, mode))
}

fn remove_tree(dir: &Path) -> Result<(), String> {
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("{} could not be removed ({err})", dir.display())),
    }
}
