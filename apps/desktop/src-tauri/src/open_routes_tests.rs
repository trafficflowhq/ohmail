//! The Linux opener's routes, driven with a fake portal and stand-in programs. Nothing here reaches
//! the session bus or a browser: `ZbusPortal` is built only on a bus a test starts itself, with a
//! stand-in portal on it, and no test calls `open`.

use super::*;
use crate::inherited_fds::tests::live_process;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

static SEQ: AtomicU32 = AtomicU32::new(0);

/// A billing page's address: a `~` in the path and a fragment.
const BILLING: &str = "https://vercel.example/acme-team/~/settings/billing#spend-management";

const LONG: Duration = Duration::from_secs(10);

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("ohmail-routes-{}-{name}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::SeqCst)));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// A stand-in program: writes its argument count, each argument, its stdin, its stdout and its
/// library path to `<name>.seen`, then exits `code`.
fn stand_in(dir: &Path, name: &str, code: i32) -> PathBuf {
    let path = dir.join(name);
    let seen = dir.join(format!("{name}.seen"));
    fs::write(
        &path,
        format!(
            "#!/bin/sh\nin=$(readlink /proc/$$/fd/0); out=$(readlink /proc/$$/fd/1)\n\
             {{ echo \"argc=$#\"; for a in \"$@\"; do echo \"arg=$a\"; done; echo \"stdin=$in\"; \
             echo \"stdout=$out\"; echo \"LD_LIBRARY_PATH=${{LD_LIBRARY_PATH-unset}}\"; }} > '{}'\nexit {code}\n",
            seen.display()
        ),
    )
    .expect("write the stand-in");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("make the stand-in runnable");
    path
}

/// What a stand-in wrote, or `None` when it never ran.
fn seen(dir: &Path, name: &str) -> Option<String> {
    fs::read_to_string(dir.join(format!("{name}.seen"))).ok()
}

fn args_of(seen: &str) -> Vec<&str> {
    seen.lines().filter_map(|l| l.strip_prefix("arg=")).collect()
}

#[derive(Clone, Copy, Debug)]
enum Says {
    Absent,
    Refused,
    Code(u32),
    Withhold,
}

/// A portal that answers as told and writes down every address it was handed.
struct FakePortal {
    says: Says,
    asked: Mutex<Vec<String>>,
    held: Mutex<Option<mpsc::Sender<u32>>>,
    ended: Arc<AtomicBool>,
}

impl FakePortal {
    fn new(says: Says) -> FakePortal {
        FakePortal { says, asked: Mutex::new(Vec::new()), held: Mutex::new(None), ended: Arc::new(AtomicBool::new(false)) }
    }

    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }

    /// The answer a withheld request gives now.
    fn answer(&self, code: u32) {
        self.held.lock().unwrap().as_ref().expect("no request is withheld").send(code).expect("nobody listens");
    }
}

impl Portal for FakePortal {
    fn open_uri(&self, uri: &str) -> Result<PortalRequest, Miss> {
        self.asked.lock().unwrap().push(uri.to_string());
        let (tx, answers) = mpsc::channel();
        let ended = Arc::clone(&self.ended);
        let end: Box<dyn FnOnce() + Send> = Box::new(move || ended.store(true, Ordering::SeqCst));
        match self.says {
            Says::Absent => Err(Miss::Absent("no_portal".to_string())),
            Says::Refused => Err(Miss::Refused("NotAllowed".to_string())),
            Says::Code(code) => {
                tx.send(code).expect("send");
                Ok(PortalRequest { answers, end })
            }
            Says::Withhold => {
                *self.held.lock().unwrap() = Some(tx);
                Ok(PortalRequest { answers, end })
            }
        }
    }
}

fn bounds() -> Bounds {
    Bounds { verdict: Duration::from_millis(50), late: LONG }
}

/// The late sink and its listener: a sentence per call, and the channel closes when the sink is
/// dropped uncalled.
fn late_sink() -> (impl FnOnce(String) + Send + 'static, mpsc::Receiver<String>) {
    let (tx, rx) = mpsc::channel();
    (move |sentence: String| tx.send(sentence).expect("listener gone"), rx)
}

#[test]
fn xdg_open_refusing_falls_through_to_gio() {
    let _live = live_process();
    let dir = scratch("fall-through");
    let (xdg, gio) = (stand_in(&dir, "xdg-open", 4), stand_in(&dir, "gio", 0));
    let (late, heard) = late_sink();
    open_with(BILLING, &FakePortal::new(Says::Absent), Some(xdg), Some(gio), bounds(), late)
        .expect("gio opened the link, and an open is not a refusal");
    let xdg_seen = seen(&dir, "xdg-open").expect("xdg-open never ran");
    let gio_seen = seen(&dir, "gio").expect("gio never ran after xdg-open refused");
    assert_eq!(args_of(&xdg_seen), [BILLING], "xdg-open got another argv: {xdg_seen}");
    assert_eq!(args_of(&gio_seen), ["open", BILLING], "gio got another argv: {gio_seen}");
    assert!(xdg_seen.contains("argc=1") && gio_seen.contains("argc=2"), "the address was split");
    assert!(matches!(heard.recv_timeout(LONG), Err(mpsc::RecvTimeoutError::Disconnected)), "a late refusal fired");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_portal_that_opens_takes_no_other_route() {
    let _live = live_process();
    let dir = scratch("portal-opens");
    let portal = FakePortal::new(Says::Code(0));
    let (late, heard) = late_sink();
    open_with(BILLING, &portal, Some(stand_in(&dir, "xdg-open", 0)), Some(stand_in(&dir, "gio", 0)), bounds(), late)
        .expect("the portal opened the link");
    assert_eq!(portal.asked(), [BILLING]);
    assert!(seen(&dir, "xdg-open").is_none() && seen(&dir, "gio").is_none(), "a second route ran after the portal opened");
    assert!(portal.ended.load(Ordering::SeqCst), "the portal request was left listening");
    assert!(matches!(heard.recv_timeout(LONG), Err(mpsc::RecvTimeoutError::Disconnected)));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn every_route_refusing_is_one_refusal_naming_each() {
    let _live = live_process();
    let dir = scratch("all-refuse");
    let (xdg, gio) = (stand_in(&dir, "xdg-open", 4), stand_in(&dir, "gio", 2));
    let (late, _heard) = late_sink();
    let said = open_with(BILLING, &FakePortal::new(Says::Code(2)), Some(xdg), Some(gio), bounds(), late)
        .expect_err("three refusals were read as an open");
    assert!(said.starts_with("ohmail: this computer would not open a browser"), "{said}");
    for route in ["portal: refused:response_2", "xdg-open: refused:exit_4", "gio: refused:exit_2"] {
        assert!(said.contains(route), "the refusal does not name {route}: {said}");
    }
    assert!(!said.contains("vercel") && !said.contains("billing"), "the refusal carries the address: {said}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn declining_in_the_portal_tries_nothing_else() {
    let _live = live_process();
    let dir = scratch("declined");
    let (late, heard) = late_sink();
    let portal = FakePortal::new(Says::Code(1));
    open_with(BILLING, &portal, Some(stand_in(&dir, "xdg-open", 0)), Some(stand_in(&dir, "gio", 0)), bounds(), late)
        .expect("the person's own no is not a refusal to say");
    assert!(seen(&dir, "xdg-open").is_none() && seen(&dir, "gio").is_none(), "a route ran over the person's no");
    assert!(matches!(heard.recv_timeout(LONG), Err(mpsc::RecvTimeoutError::Disconnected)), "a late refusal fired");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_portal_still_deciding_is_not_a_refusal_and_a_late_no_runs_the_rest_once() {
    let _live = live_process();
    for (gio_exit, refused_late) in [(2, true), (0, false)] {
        let dir = scratch("pending");
        let portal = FakePortal::new(Says::Withhold);
        let (late, heard) = late_sink();
        let started = Instant::now();
        open_with(BILLING, &portal, Some(stand_in(&dir, "xdg-open", 4)), Some(stand_in(&dir, "gio", gio_exit)), bounds(), late)
            .expect("a portal still deciding was read as a refusal");
        assert!(started.elapsed() < Duration::from_secs(1), "the window waited on a portal still deciding");
        assert!(seen(&dir, "xdg-open").is_none(), "a route ran while the portal was still deciding");
        assert!(matches!(heard.try_recv(), Err(mpsc::TryRecvError::Empty)), "the late listener ended early");
        portal.answer(2);
        if refused_late {
            let sentence = heard.recv_timeout(LONG).expect("every route refused late and nothing said so");
            assert!(sentence.starts_with("ohmail: this computer would not open a browser"), "{sentence}");
            assert!(matches!(heard.recv_timeout(LONG), Err(mpsc::RecvTimeoutError::Disconnected)), "said twice");
        } else {
            assert!(matches!(heard.recv_timeout(LONG), Err(mpsc::RecvTimeoutError::Disconnected)), "gio opened it, yet a refusal fired");
        }
        assert!(seen(&dir, "xdg-open").is_some() && seen(&dir, "gio").is_some(), "the late no did not run the rest");
        assert!(portal.ended.load(Ordering::SeqCst), "the portal request was left listening");
        let _ = fs::remove_dir_all(&dir);
    }
}

#[test]
fn a_late_yes_from_the_portal_runs_nothing_else() {
    let _live = live_process();
    let dir = scratch("late-yes");
    let portal = FakePortal::new(Says::Withhold);
    let (late, heard) = late_sink();
    open_with(BILLING, &portal, Some(stand_in(&dir, "xdg-open", 0)), Some(stand_in(&dir, "gio", 0)), bounds(), late)
        .expect("pending");
    portal.answer(0);
    assert!(matches!(heard.recv_timeout(LONG), Err(mpsc::RecvTimeoutError::Disconnected)));
    assert!(seen(&dir, "xdg-open").is_none() && seen(&dir, "gio").is_none(), "a route ran after the portal opened late");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_portal_gets_the_address_byte_exact_and_a_valid_token() {
    let long = format!("https://e.test/{}", "x".repeat(4096 - "https://e.test/".len()));
    for url in [BILLING, "https://e.test/usage?a=1&b=2|3&c=%2F#top", long.as_str()] {
        let portal = FakePortal::new(Says::Code(0));
        let (late, _heard) = late_sink();
        open_with(url, &portal, None, None, bounds(), late).expect("the portal opened it");
        assert_eq!(portal.asked(), [url], "the portal was handed other bytes");
    }
    let (one, two) = (new_token().expect("a token"), new_token().expect("a token"));
    for token in [&one, &two] {
        assert!(token.starts_with("ohmail_") && token.len() == "ohmail_".len() + 16, "{token}");
        assert!(token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'), "the portal refuses this token: {token}");
    }
    assert_ne!(one, two, "two opens share a request path");
    assert_eq!(open_uri_options(&one), [("handle_token", one.clone())], "the call asks the person to choose");
}

#[test]
fn no_route_on_this_computer_names_the_remedy() {
    let (late, _heard) = late_sink();
    let said = open_with(BILLING, &FakePortal::new(Says::Absent), None, None, bounds(), late).expect_err("nothing opened it");
    assert!(said.contains("install xdg-utils"), "{said}");
}

#[test]
fn a_non_http_address_reaches_no_route() {
    let _live = live_process();
    let dir = scratch("scheme");
    for url in ["file:///etc/passwd", "steam://run/1", "mailto:someone@example.test"] {
        let portal = FakePortal::new(Says::Code(0));
        let (late, _heard) = late_sink();
        let xdg = stand_in(&dir, "xdg-open", 0);
        open_with(url, &portal, Some(xdg), None, bounds(), late).expect_err("a non-http address was opened");
        assert!(portal.asked().is_empty(), "the portal was handed {url}");
        assert!(seen(&dir, "xdg-open").is_none(), "xdg-open was handed {url}");
    }
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn request_path_is_the_portals_own() {
    assert_eq!(request_path(":1.42", "ohmail_x"), "/org/freedesktop/portal/desktop/request/1_42/ohmail_x");
    assert_eq!(request_path(":1.320", "ohmail_t01"), "/org/freedesktop/portal/desktop/request/1_320/ohmail_t01");
}

#[test]
fn spawned_routes_get_null_stdin_stdout_and_no_bundle() {
    let _live = live_process();
    let dir = scratch("stdio");
    let (late, _heard) = late_sink();
    open_with(BILLING, &FakePortal::new(Says::Refused), Some(stand_in(&dir, "xdg-open", 0)), None, bounds(), late)
        .expect("xdg-open opened it after the portal refused");
    let got = seen(&dir, "xdg-open").expect("xdg-open never ran");
    assert!(got.contains("stdin=/dev/null"), "the route read this app's stdin: {got}");
    assert!(got.contains("stdout=/dev/null"), "the route wrote to this app's stdout: {got}");
    assert!(got.contains("LD_LIBRARY_PATH=unset"), "the route was handed this process's library path: {got}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_portal_error_is_absent_only_when_there_is_no_portal() {
    for name in [
        "org.freedesktop.DBus.Error.ServiceUnknown",
        "org.freedesktop.DBus.Error.NameHasNoOwner",
        "org.freedesktop.DBus.Error.UnknownMethod",
        "org.freedesktop.DBus.Error.UnknownInterface",
        "org.freedesktop.DBus.Error.UnknownObject",
    ] {
        assert!(matches!(miss_named(name), Miss::Absent(_)), "{name} read as a refusal");
    }
    for (name, word) in [
        ("org.freedesktop.portal.Error.NotAllowed", "NotAllowed"),
        ("org.freedesktop.DBus.Error.InvalidArgs", "InvalidArgs"),
    ] {
        assert!(matches!(miss_named(name), Miss::Refused(w) if w == word), "{name} is not refused as {word}");
    }
}

#[test]
fn an_opener_s_exit_is_one_word_in_the_line() {
    assert_eq!(exit_word("ohmail: x (exit status: 4)"), "exit_4");
    assert_eq!(exit_word("ohmail: x (signal: 13 (SIGPIPE))"), "signal_13");
    assert_eq!(exit_word("ohmail: x (Permission denied (os error 13))"), "spawn");
    let line = routes_line(&Verdict::Absent("no_bus".into()), Some(&Verdict::Refused("exit_4".into())), None, false, "public");
    assert_eq!(
        line,
        "{\"service\":\"shell\",\"event\":\"open_routes\",\"portal\":\"absent:no_bus\",\"xdgOpen\":\"refused:exit_4\",\"gio\":\"untried\",\"late\":false,\"hostClass\":\"public\"}"
    );
}

#[test]
fn gio_is_looked_for_like_xdg_open() {
    let _live = live_process();
    let dir = scratch("gio-lookup");
    let gio = stand_in(&dir, "gio", 0);
    let path = std::ffi::OsString::from(dir.as_os_str());
    assert_eq!(crate::engine::find_program("gio", &[], Some(&path), None), Some(gio.clone()));
    assert_eq!(crate::engine::find_program("gio", &[], Some(&path), Some(dir.as_path())), None, "the AppDir's own was taken");
    assert_eq!(GIO_LOCATIONS, ["/usr/bin/gio", "/usr/local/bin/gio"]);
    let _ = fs::remove_dir_all(&dir);
}

/// A D-Bus daemon of the test's own, listening in its scratch directory: never the person's session
/// bus, and nothing on it can be started. Stopped when dropped.
struct TestBus {
    daemon: std::process::Child,
    address: String,
    dir: PathBuf,
}

impl TestBus {
    fn start() -> TestBus {
        let dir = scratch("bus");
        let config = dir.join("bus.conf");
        fs::write(
            &config,
            format!(
                "<busconfig><type>session</type><listen>unix:path={}</listen><auth>EXTERNAL</auth>\
                 <policy context=\"default\"><allow send_destination=\"*\"/><allow receive_sender=\"*\"/>\
                 <allow own=\"*\"/></policy></busconfig>\n",
                dir.join("bus").display()
            ),
        )
        .expect("write the bus's configuration");
        let mut daemon = Command::new("dbus-daemon")
            .arg(format!("--config-file={}", config.display()))
            .args(["--nofork", "--print-address=1"])
            .env_remove("DBUS_SESSION_BUS_ADDRESS")
            .env("XDG_RUNTIME_DIR", &dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("dbus-daemon did not start: this test runs a bus of its own with it");
        let mut address = String::new();
        let printed = daemon.stdout.take().expect("the daemon's output");
        std::io::BufRead::read_line(&mut std::io::BufReader::new(printed), &mut address).expect("the bus's address");
        let address = address.trim().to_string();
        assert!(address.starts_with("unix:path="), "dbus-daemon printed no address: {address:?}");
        TestBus { daemon, address, dir }
    }

    /// This process's descriptors connected to the bus: one for each connection not closed on this
    /// side, whatever the bus has done with its own end.
    fn connections(&self) -> usize {
        let daemon = i32::try_from(self.daemon.id()).expect("a pid");
        fs::read_dir("/proc/self/fd")
            .expect("this process's descriptors")
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
            .filter(|&fd| peer_pid(fd) == Some(daemon))
            .count()
    }

    /// `connections` once it is down to `at_most`, or as it stands when `bound` has passed.
    fn connections_down_to(&self, at_most: usize, bound: Duration) -> usize {
        let started = Instant::now();
        loop {
            let now = self.connections();
            if now <= at_most || started.elapsed() > bound {
                return now;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for TestBus {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Whether this process's user has a password-database entry: dbus-daemon refuses every client
/// whose user it cannot look up, so a container run as an unnamed uid cannot host a bus at all.
fn user_is_named() -> bool {
    // SAFETY: the entry is only compared with null, never read.
    unsafe { !libc::getpwuid(libc::getuid()).is_null() }
}

/// A connection to the test's bus, or a failure within `LONG`: zbus reads the bus's welcome
/// without a timeout, and a bus that refuses this user never sends one.
fn connect(address: &str) -> zbus::blocking::Connection {
    let (made, connected) = mpsc::channel();
    let address = address.to_string();
    thread::spawn(move || {
        let _ = made.send(zbus::blocking::connection::Builder::address(address.as_str()).and_then(|b| b.build()));
    });
    connected.recv_timeout(LONG).expect("the test's bus did not answer").expect("the test's bus")
}

/// The process at the other end of socket `fd`, as the kernel recorded it at the connect.
fn peer_pid(fd: i32) -> Option<i32> {
    let mut peer = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `peer` and `len` belong to this frame and are sized for SO_PEERCRED; a descriptor
    // closed or reused since the listing answers for another socket, or fails.
    let rc = unsafe {
        libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_PEERCRED, std::ptr::addr_of_mut!(peer).cast(), &mut len)
    };
    (rc == 0).then_some(peer.pid)
}

/// A stand-in portal on a test's bus: it answers each OpenURI as it was last told, and counts them.
struct BusPortal {
    conn: zbus::blocking::Connection,
    says: Arc<Mutex<Says>>,
    asked: Arc<AtomicU32>,
}

impl BusPortal {
    fn serve(bus: &TestBus) -> BusPortal {
        let conn = connect(&bus.address);
        conn.request_name(PORTAL_NAME).expect("the portal's name on the test's bus");
        let (says, asked) = (Arc::new(Mutex::new(Says::Code(0))), Arc::new(AtomicU32::new(0)));
        let messages = zbus::blocking::MessageIterator::from(&conn);
        let (serving, told, counted) = (conn.clone(), Arc::clone(&says), Arc::clone(&asked));
        thread::spawn(move || {
            for message in messages {
                let Ok(message) = message else { return };
                let header = message.header();
                if header.message_type() != zbus::message::Type::MethodCall
                    || header.member().map(|m| m.as_str()) != Some("OpenURI")
                {
                    continue;
                }
                let Some(sender) = header.sender().map(|name| name.to_string()) else { continue };
                let body = message.body();
                let Ok((_, _, options)) =
                    body.deserialize::<(&str, &str, HashMap<&str, zbus::zvariant::Value<'_>>)>()
                else {
                    continue;
                };
                let Some(zbus::zvariant::Value::Str(token)) = options.get("handle_token") else { continue };
                counted.fetch_add(1, Ordering::SeqCst);
                let handle = request_path(&sender, token.as_str());
                let path = zbus::zvariant::ObjectPath::try_from(handle.as_str()).expect("a request path");
                let says = *told.lock().unwrap();
                match says {
                    Says::Refused => {
                        let _ = serving.reply_error(&header, "org.freedesktop.portal.Error.NotAllowed", &("not allowed",));
                    }
                    Says::Code(code) => {
                        let _ = serving.reply(&header, &(path.clone(),));
                        let results: HashMap<&str, zbus::zvariant::Value<'_>> = HashMap::new();
                        let _ = serving.emit_signal(Some(sender.as_str()), path, REQUEST, "Response", &(code, results));
                    }
                    Says::Withhold | Says::Absent => {
                        let _ = serving.reply(&header, &(path,));
                    }
                }
            }
        });
        BusPortal { conn, says, asked }
    }

    /// Answer the next calls as `says`; `Absent` leaves the bus without a portal.
    fn tell(&self, says: Says) {
        *self.says.lock().unwrap() = says;
        if matches!(says, Says::Absent) {
            self.conn.release_name(PORTAL_NAME).expect("give up the portal's name");
        }
    }

    fn asked(&self) -> u32 {
        self.asked.load(Ordering::SeqCst)
    }
}

/// EVERY OPEN CLOSES ITS BUS CONNECTION, whatever the portal said. A Response listener addressed to
/// the portal's well-known name leaves zbus a watch on that name's owner, whose removal zbus queues
/// on the connection itself when the listener is dropped; queued after the close, the removal never
/// ran and held the socket open for good: one descriptor per open until the process had none left
/// and every link was refused. Counted as this process's sockets to a bus the test starts.
#[test]
fn every_open_closes_its_bus_connection() {
    const OPENS: u32 = 20;
    if !user_is_named() {
        eprintln!("every_open_closes_its_bus_connection: not run, this uid has no passwd entry and no bus serves it");
        return;
    }
    let _live = live_process();
    let bus = TestBus::start();
    let stand_in = BusPortal::serve(&bus);
    let portal = ZbusPortal { address: Some(bus.address.clone()) };
    let mut left_open = Vec::new();
    for (says, refusal) in [
        (Says::Code(0), None),
        (Says::Code(1), None),
        (Says::Code(2), Some("portal: refused:response_2")),
        (Says::Refused, Some("portal: refused:NotAllowed")),
        (Says::Withhold, None),
        (Says::Absent, Some("install xdg-utils")),
    ] {
        stand_in.tell(says);
        let (before, asked) = (bus.connections(), stand_in.asked());
        // A portal still deciding is left after a short verdict and a short late bound.
        let verdict = if matches!(says, Says::Withhold) { Duration::from_millis(50) } else { OPENER_VERDICT };
        for _ in 0..OPENS {
            let said = open_with(BILLING, &portal, None, None, Bounds { verdict, late: Duration::from_millis(100) }, |_| ());
            match refusal {
                None => assert_eq!(said, Ok(()), "{says:?}"),
                Some(word) => assert!(said.as_ref().is_err_and(|s| s.contains(word)), "{says:?}: {said:?}"),
            }
        }
        let expected = if matches!(says, Says::Absent) { 0 } else { OPENS };
        assert_eq!(stand_in.asked() - asked, expected, "{says:?}: the portal was not asked once per open");
        let after = bus.connections_down_to(before, LONG);
        if after != before {
            left_open.push(format!("{says:?}: {} of {OPENS}", after.saturating_sub(before)));
        }
    }
    assert!(left_open.is_empty(), "opens left their bus connection open: {left_open:?}");
}
