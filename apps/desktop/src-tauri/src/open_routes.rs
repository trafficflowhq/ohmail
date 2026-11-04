//! THE LINUX OPENER'S ROUTES. A link leaves for the person's browser through the desktop portal's
//! OpenURI first (the route Wayland desktops and sandboxes honour, launched in the person's own
//! session), then `xdg-open`, then `gio open`. A route is called refused only by its own answer, and
//! the window hears one refusal only when every route refused. Only http(s) reaches a route
//! ([`external_url`]): OpenURI opens any scheme's handler. No shell: the address is one argument or
//! one D-Bus string, and no log line carries it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::thread;
use std::time::Duration;

use crate::engine::{external_url, run_opener, scrub_bundled_environment, LINK_ASK_HOLD, NO_OPENER, OPENER_VERDICT};

/// The sentence a refusal starts with: the shell's own since links first opened.
const REFUSED: &str = "ohmail: this computer would not open a browser";

/// How long the portal's call is waited for, and then its answer: the opener's own verdict.
const PORTAL_CALL: Duration = OPENER_VERDICT;
const PORTAL_VERDICT: Duration = OPENER_VERDICT;

/// How long a portal still deciding (its dialog up) is listened to before the next route runs.
const PORTAL_LATE: Duration = LINK_ASK_HOLD;

const PORTAL_NAME: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const OPEN_URI: &str = "org.freedesktop.portal.OpenURI";
const REQUEST: &str = "org.freedesktop.portal.Request";

/// Where distributions put `gio`, tried before `PATH`.
pub const GIO_LOCATIONS: &[&str] = &["/usr/bin/gio", "/usr/local/bin/gio"];

/// What one route answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Handed on: the browser has the address, or a handler started with it.
    Opened,
    /// The portal took the call and has not answered yet. Not a refusal.
    Pending,
    /// The person said no in the portal's own dialog: nothing else is tried, nothing is said.
    Declined,
    /// The route answered no, in the word given.
    Refused(String),
    /// The route is not on this computer: no bus, no portal, no program.
    Absent(String),
}

impl Verdict {
    /// The log line's word: `opened|pending|declined|refused:<code>|absent:<why>`.
    fn word(&self) -> String {
        let code = |s: &str| -> String { s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect() };
        match self {
            Verdict::Opened => "opened".to_string(),
            Verdict::Pending => "pending".to_string(),
            Verdict::Declined => "declined".to_string(),
            Verdict::Refused(why) => format!("refused:{}", code(why)),
            Verdict::Absent(why) => format!("absent:{}", code(why)),
        }
    }
}

/// One OpenURI request in flight: the portal's answer codes as they come, and the way to stop
/// listening (closing the request's connection ends its listener).
pub struct PortalRequest {
    pub answers: mpsc::Receiver<u32>,
    pub end: Box<dyn FnOnce() + Send>,
}

/// Why there is no request: no portal to ask, or a portal that said no to the call itself.
pub enum Miss {
    Absent(String),
    Refused(String),
}

pub trait Portal: Send + Sync {
    /// Ask the portal to open `uri`.
    fn open_uri(&self, uri: &str) -> Result<PortalRequest, Miss>;
}

/// How long the portal's answer is waited for before the window hears, and how long after that.
pub struct Bounds {
    pub verdict: Duration,
    pub late: Duration,
}

/// The portal's answer code, in the spec's words: 0 done, 1 the person cancelled, 2 anything else.
fn answered(code: u32) -> Verdict {
    match code {
        0 => Verdict::Opened,
        1 => Verdict::Declined,
        n => Verdict::Refused(format!("response_{n}")),
    }
}

/// Open `url` by the first route that takes it: the portal, then `xdg-open`, then `gio open`.
/// `late` hears the refusal of a portal that decided after the window was answered, once.
pub fn open_with(
    url: &str,
    portal: &dyn Portal,
    xdg_open: Option<PathBuf>,
    gio: Option<PathBuf>,
    bounds: Bounds,
    late: impl FnOnce(String) + Send + 'static,
) -> Result<(), String> {
    let url = external_url(url)?;
    let host = tauri::Url::parse(url).map_or("none", |u| crate::navigation::host_class(&u));
    let programs = Programs { xdg_open, gio };
    let first = match portal.open_uri(url) {
        Err(Miss::Absent(why)) => Verdict::Absent(why),
        Err(Miss::Refused(why)) => Verdict::Refused(why),
        Ok(PortalRequest { answers, end }) => match answers.recv_timeout(bounds.verdict) {
            Ok(code) => {
                end();
                answered(code)
            }
            Err(RecvTimeoutError::Disconnected) => {
                end();
                Verdict::Refused("closed".to_string())
            }
            Err(RecvTimeoutError::Timeout) => {
                let owned = url.to_string();
                let bound = bounds.late;
                thread::spawn(move || decide_late(&owned, answers, end, &programs, bound, host, late));
                log(&routes_line(&Verdict::Pending, None, None, false, host));
                return Ok(());
            }
        },
    };
    if matches!(first, Verdict::Opened | Verdict::Declined) {
        log(&routes_line(&first, None, None, false, host));
        return Ok(());
    }
    let (xdg, gio) = run_programs(url, &programs);
    log(&routes_line(&first, Some(&xdg), gio.as_ref(), false, host));
    verdict_of(&first, &xdg, gio.as_ref())
}

/// After a portal still deciding: its late yes or no is only logged; a late refusal, a closed
/// request or the bound passing runs `xdg-open`, then `gio`, once. Their exits are judged by the
/// opener's verdict and never waited for past it: a later exit may be the browser's own.
fn decide_late(
    url: &str,
    answers: mpsc::Receiver<u32>,
    end: Box<dyn FnOnce() + Send>,
    programs: &Programs,
    bound: Duration,
    host: &'static str,
    late: impl FnOnce(String),
) {
    let got = answers.recv_timeout(bound);
    end();
    let portal = match got {
        Ok(code @ (0 | 1)) => {
            log(&routes_line(&answered(code), None, None, true, host));
            return;
        }
        Ok(code) => answered(code),
        Err(RecvTimeoutError::Disconnected) => Verdict::Refused("closed".to_string()),
        Err(RecvTimeoutError::Timeout) => Verdict::Refused("timeout".to_string()),
    };
    let (xdg, gio) = run_programs(url, programs);
    log(&routes_line(&portal, Some(&xdg), gio.as_ref(), true, host));
    if let Err(sentence) = verdict_of(&portal, &xdg, gio.as_ref()) {
        late(sentence);
    }
}

/// The two programs behind the portal, found before the open.
struct Programs {
    xdg_open: Option<PathBuf>,
    gio: Option<PathBuf>,
}

/// `xdg-open`, then `gio open` when `xdg-open` did not open; `gio`'s verdict is `None` untried.
fn run_programs(url: &str, programs: &Programs) -> (Verdict, Option<Verdict>) {
    let xdg = spawned(programs.xdg_open.as_deref(), &[url]);
    if xdg == Verdict::Opened {
        return (xdg, None);
    }
    (xdg, Some(spawned(programs.gio.as_deref(), &["open", url])))
}

/// One program route, judged by the shell's opener verdict: exit 0 or still running opened it.
fn spawned(program: Option<&Path>, args: &[&str]) -> Verdict {
    let Some(program) = program else {
        return Verdict::Absent("not_installed".to_string());
    };
    match run_opener(route_command(program, args), REFUSED) {
        Ok(()) => Verdict::Opened,
        Err(sentence) => Verdict::Refused(exit_word(&sentence)),
    }
}

/// The one way a route's program runs: absolute, the address as one argument, no stdin or stdout
/// (a browser handing off writes there), the bundle's wiring scrubbed, the launch's stderr kept.
fn route_command(program: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::null());
    scrub_bundled_environment(&mut command);
    command
}

/// `run_opener`'s sentence as one word: `exit_<n>`, `signal_<n>`, or `spawn`.
pub fn exit_word(sentence: &str) -> String {
    let number = |key: &str| -> Option<String> {
        let digits: String = sentence.split(key).nth(1)?.chars().take_while(char::is_ascii_digit).collect();
        (!digits.is_empty()).then_some(digits)
    };
    if let Some(n) = number("exit status: ") {
        return format!("exit_{n}");
    }
    if let Some(n) = number("signal: ") {
        return format!("signal_{n}");
    }
    "spawn".to_string()
}

/// What the window hears: opened; the remedy when this computer has no route at all; or one
/// refusal naming each route's answer, and never the address.
fn verdict_of(portal: &Verdict, xdg: &Verdict, gio: Option<&Verdict>) -> Result<(), String> {
    if *xdg == Verdict::Opened || gio == Some(&Verdict::Opened) {
        return Ok(());
    }
    let absent = |v: &Verdict| matches!(v, Verdict::Absent(_));
    if absent(portal) && absent(xdg) && gio.is_some_and(absent) {
        return Err(NO_OPENER.to_string());
    }
    Err(format!(
        "{REFUSED} (portal: {}; xdg-open: {}; gio: {})",
        portal.word(),
        xdg.word(),
        gio.map_or_else(|| "untried".to_string(), Verdict::word)
    ))
}

/// The one line an open writes, in the shell's JSON shape: each route's word and the host's class.
pub fn routes_line(portal: &Verdict, xdg: Option<&Verdict>, gio: Option<&Verdict>, late: bool, host: &str) -> String {
    let word = |v: Option<&Verdict>| v.map_or_else(|| "untried".to_string(), Verdict::word);
    format!(
        "{{\"service\":\"shell\",\"event\":\"open_routes\",\"portal\":\"{}\",\"xdgOpen\":\"{}\",\"gio\":\"{}\",\"late\":{late},\"hostClass\":\"{host}\"}}",
        portal.word(),
        word(xdg),
        word(gio)
    )
}

fn log(line: &str) {
    crate::engine::log_json_line(line);
}

/// The request object the portal makes for `unique_name`'s call carrying `token`, which is where
/// its Response is emitted: subscribed to before the call.
pub fn request_path(unique_name: &str, token: &str) -> String {
    let sender = unique_name.trim_start_matches(':').replace('.', "_");
    format!("{PORTAL_PATH}/request/{sender}/{token}")
}

/// A handle token: `ohmail_` and 16 hex characters from the OS source.
pub fn new_token() -> Result<String, String> {
    let mut raw = [0u8; 8];
    getrandom::fill(&mut raw).map_err(|err| format!("no random bytes ({err})"))?;
    Ok(format!("ohmail_{}", raw.iter().map(|b| format!("{b:02x}")).collect::<String>()))
}

/// The OpenURI call's options: the handle token, and nothing that asks the person to choose.
pub fn open_uri_options(token: &str) -> Vec<(&'static str, String)> {
    vec![("handle_token", token.to_string())]
}

/// A D-Bus error by name: no portal or no OpenURI here is absent; anything the portal said is a
/// refusal, named by the error's last word.
pub fn miss_named(name: &str) -> Miss {
    match name {
        "org.freedesktop.DBus.Error.ServiceUnknown" | "org.freedesktop.DBus.Error.NameHasNoOwner" => {
            Miss::Absent("no_portal".to_string())
        }
        "org.freedesktop.DBus.Error.UnknownMethod"
        | "org.freedesktop.DBus.Error.UnknownInterface"
        | "org.freedesktop.DBus.Error.UnknownObject" => Miss::Absent("no_openuri".to_string()),
        other => Miss::Refused(other.rsplit('.').next().unwrap_or(other).to_string()),
    }
}

/// Where a refusal decided after the window was answered goes; `engine::manage` registers it. With
/// none, a late refusal is only logged.
type LateSink = Box<dyn Fn(&str) + Send + Sync>;
static LATE_REFUSAL: OnceLock<LateSink> = OnceLock::new();

pub fn set_late_refusal(sink: impl Fn(&str) + Send + Sync + 'static) {
    let _ = LATE_REFUSAL.set(Box::new(sink));
}

/// Open `url` through the routes this computer has, on the shell's own bounds.
pub fn open(url: &str) -> Result<(), String> {
    let owned = url.to_string();
    open_with(
        url,
        &ZbusPortal { address: None },
        crate::engine::xdg_open_program(),
        gio_program(),
        Bounds { verdict: PORTAL_VERDICT, late: PORTAL_LATE },
        move |sentence| {
            crate::engine::log_line(format_args!("a link was not opened: {sentence}"));
            if let Some(sink) = LATE_REFUSAL.get() {
                sink(&owned);
            }
        },
    )
}

/// `gio`, looked for as `xdg-open` is: the usual places, then `PATH` minus the AppDir.
fn gio_program() -> Option<PathBuf> {
    let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
    crate::engine::find_program("gio", GIO_LOCATIONS, std::env::var_os("PATH").as_deref(), appdir.as_deref())
}

/// The desktop portal: one private connection per open, never starting a portal that is not
/// running (a stopped one would stall the open and could open the page twice).
struct ZbusPortal {
    /// The session bus when `None`; a test's own bus otherwise.
    address: Option<String>,
}

impl Portal for ZbusPortal {
    fn open_uri(&self, uri: &str) -> Result<PortalRequest, Miss> {
        let token = new_token().map_err(|_| Miss::Absent("no_token".to_string()))?;
        let held = Arc::new(Held::default());
        let (called_tx, called_rx) = mpsc::channel();
        let (answer_tx, answers) = mpsc::channel();
        let (address, owned, asking) = (self.address.clone(), uri.to_string(), Arc::clone(&held));
        thread::spawn(move || {
            let _ = called_tx.send(ask_portal(address.as_deref(), &owned, &token, &asking, answer_tx));
        });
        // The call carries no timeout of its own (zbus applies one only without flags): the bound
        // is this wait, and a call still out after it is ended with its connection.
        match called_rx.recv_timeout(PORTAL_CALL) {
            Ok(Ok(())) => Ok(PortalRequest { answers, end: Box::new(move || held.end()) }),
            Ok(Err(miss)) => {
                held.end();
                Err(miss)
            }
            Err(_) => {
                held.end();
                crate::engine::log_line(format_args!(
                    "the desktop portal did not answer in time; the next route may open this link a second time"
                ));
                Err(Miss::Absent("timeout".to_string()))
            }
        }
    }
}

/// One open's connection, closed once: `end` closes the one kept so far, and one made after `end`
/// is never kept, so its maker closes it.
#[derive(Default)]
struct Held(Mutex<Hold>);

#[derive(Default)]
struct Hold {
    conn: Option<zbus::blocking::Connection>,
    ended: bool,
}

impl Held {
    fn hold(&self) -> std::sync::MutexGuard<'_, Hold> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Keep `conn` for `end`; false once the open has ended.
    fn keep(&self, conn: &zbus::blocking::Connection) -> bool {
        let mut hold = self.hold();
        if !hold.ended {
            hold.conn = Some(conn.clone());
        }
        !hold.ended
    }

    fn ended(&self) -> bool {
        self.hold().ended
    }

    /// The open has its answer, or waits no longer: closing the connection ends its listeners.
    fn end(&self) {
        let conn = {
            let mut hold = self.hold();
            hold.ended = true;
            hold.conn.take()
        };
        if let Some(conn) = conn {
            let _ = conn.close();
        }
    }
}

/// The portal call, off the opener's thread: connect, find the portal's own connection, listen at
/// the predicted request path, call OpenURI there, and follow the handle it returns if it differs.
fn ask_portal(
    address: Option<&str>,
    uri: &str,
    token: &str,
    held: &Held,
    answers: mpsc::Sender<u32>,
) -> Result<(), Miss> {
    let builder = match address {
        None => zbus::blocking::connection::Builder::session(),
        Some(address) => zbus::blocking::connection::Builder::address(address),
    };
    let conn =
        builder.and_then(|builder| builder.method_timeout(PORTAL_CALL).build()).map_err(|err| miss_of(&err))?;
    if !held.keep(&conn) {
        let _ = conn.close();
        return Err(Miss::Absent("timeout".to_string()));
    }
    let unique =
        conn.unique_name().map(|name| name.to_string()).ok_or_else(|| Miss::Absent("no_bus".to_string()))?;
    let portal = portal_owner(&conn).map_err(|err| miss_of(&err))?;
    let predicted = request_path(&unique, token);
    listen(&conn, &portal, &predicted, held, answers.clone()).map_err(|err| miss_of(&err))?;
    if held.ended() {
        return Err(Miss::Absent("timeout".to_string()));
    }
    let options: HashMap<&str, zbus::zvariant::Value<'_>> = open_uri_options(token)
        .into_iter()
        .map(|(key, value)| (key, zbus::zvariant::Value::from(value)))
        .collect();
    let handle = zbus::blocking::Proxy::new(&conn, &portal, PORTAL_PATH, OPEN_URI)
        .and_then(|proxy| {
            proxy.call_with_flags::<_, _, zbus::zvariant::OwnedObjectPath>(
                "OpenURI",
                zbus::proxy::MethodFlags::NoAutoStart.into(),
                &("", uri, options),
            )
        })
        .map_err(|err| miss_of(&err))?
        .ok_or_else(|| Miss::Refused("no_handle".to_string()))?;
    if handle.as_str() != predicted && listen(&conn, &portal, handle.as_str(), held, answers).is_err() {
        // Unheard, the request reads as still deciding and the late bound decides it.
        crate::engine::log_line(format_args!("the desktop portal's request could not be listened to"));
    }
    Ok(())
}

/// The connection holding the portal's name, asked of the bus, which starts nothing. The listener and
/// the call are addressed to it: a listener on the name itself has zbus watch the name's owner, and
/// that watch's removal, queued when the listener is dropped, never runs after the close and holds
/// the socket open.
fn portal_owner(conn: &zbus::blocking::Connection) -> zbus::Result<zbus::names::OwnedUniqueName> {
    let reply = conn.call_method(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        Some("org.freedesktop.DBus"),
        "GetNameOwner",
        &PORTAL_NAME,
    )?;
    reply.body().deserialize()
}

/// The request's Response at `path`, from the portal's own connection only, forwarded once; the
/// listener ends when the answer comes or the connection closes. None starts once the open has
/// ended: a close that raced the subscription would leave it waiting for good.
fn listen(
    conn: &zbus::blocking::Connection,
    portal: &zbus::names::OwnedUniqueName,
    path: &str,
    held: &Held,
    answers: mpsc::Sender<u32>,
) -> zbus::Result<()> {
    let signals = zbus::blocking::Proxy::new_owned(conn.clone(), portal.clone(), path.to_string(), REQUEST)?
        .receive_signal("Response")?;
    if held.ended() {
        return Ok(());
    }
    thread::spawn(move || {
        for message in signals {
            if let Ok((code, _)) =
                message.body().deserialize::<(u32, HashMap<String, zbus::zvariant::OwnedValue>)>()
            {
                let _ = answers.send(code);
                return;
            }
        }
    });
    Ok(())
}

fn miss_of(err: &zbus::Error) -> Miss {
    use zbus::DBusError;
    match err {
        zbus::Error::MethodError(name, _, _) => miss_named(name.as_str()),
        zbus::Error::FDO(fdo) => miss_named(fdo.name().as_str()),
        zbus::Error::InputOutput(io) if io.kind() == std::io::ErrorKind::TimedOut => {
            Miss::Absent("timeout".to_string())
        }
        zbus::Error::InputOutput(_) | zbus::Error::Address(_) | zbus::Error::Handshake(_) => {
            Miss::Absent("no_bus".to_string())
        }
        _ => Miss::Refused("dbus".to_string()),
    }
}

#[cfg(test)]
#[path = "open_routes_tests.rs"]
mod tests;
