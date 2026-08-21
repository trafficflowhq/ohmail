//! THE OS'S DEFAULT MAIL APP — reading whether it is this one, and asking to make it so.
//!
//! Registering the `mailto` scheme (the deep-link config in `tauri.engine.conf.json`, plus the
//! installer's registry keys on Windows) only makes this app a CANDIDATE: every platform keeps
//! "which mail app opens mailto links" as the user's own setting, and rightly so. This module is
//! the shell's two commands about that setting, and the boundary each platform draws is respected
//! rather than worked around:
//!
//!  · **macOS** answers a Launch Services question and, on request, hands the change to the
//!    system — `LSSetDefaultHandlerForURLScheme`, which Apple documents as SETTING the handler.
//!    macOS interposes its own consent dialog for some scheme changes and not for others (a
//!    verified headless set-and-restore on this scheme went through with nobody answering any
//!    dialog), so nothing here claims a dialog exists: the person pressed this app's own "Make
//!    default", the request is that consent, and the row re-reads the state and reports what
//!    actually happened. Two symbols from frameworks this process already links; no third-party
//!    code.
//!  · **Windows** is read-only by design. The default lives in `UserChoice`, whose `Hash` value
//!    exists precisely so a program cannot write it, so the honest request is to OPEN the
//!    Settings page where the person makes the choice — `ms-settings:defaultapps`, a constant
//!    address the shell owns, through the same opener every other outbound address uses. The
//!    installer's Capabilities registration is what makes ohmail appear on that page at all.
//!  · **Linux** delegates to `xdg-settings`, the freedesktop tool whose whole job this is. It
//!    both reads and writes the setting; a desktop that refuses it (or lacks it) is reported as
//!    a state, never a stack trace.
//!
//! The window gets a CLOSED VOCABULARY — `default`, `not-default`, `unknown` — plus, from the
//! request, which of the three shapes the platform action took, so the copy on screen can say
//! what actually happened ("macOS is asking you now" is a different sentence from "Settings has
//! been opened"). The decisions below are pure functions over what a platform tool answered,
//! host.rs's convention, so the whole table is testable on a machine that has none of the three
//! platforms' tools installed — which is also why the tables and decision functions compile on
//! every platform (each carries an `allow(dead_code)` for the two platforms whose runner never
//! calls it; the tests call all of them, everywhere).

#[cfg(windows)]
use crate::engine;

/// The bundle id macOS knows this app by — `identifier` in `tauri.conf.json`, and the value
/// Launch Services answers with once this app is the mailto handler. `desktop-shell.test.ts`
/// holds the two spellings together.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MACOS_BUNDLE_ID: &str = "io.ohmail.desktop";

/// The ProgId the Windows installer registers for mailto (`windows/hooks.nsh`), and therefore
/// the value `UserChoice\ProgId` holds once the user has picked ohmail. The two spellings are
/// held together by `desktop-shell.test.ts`.
#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_PROG_ID: &str = "ohmail.mailto";

/// The desktop-entry file name the Linux bundles install — the bundler names it after the
/// product (`ohmail.desktop`), and it is the value `xdg-settings` reads and writes for the
/// mailto handler.
#[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
const LINUX_DESKTOP_ID: &str = "ohmail.desktop";

/// The Settings page Windows keeps the choice on. A CONSTANT, like Tailscale's download page:
/// the window names an intent, never an address.
#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_SETTINGS_URL: &str = "ms-settings:defaultapps";

/// What the OS says about the mailto handler, in the three words the window is allowed to see.
///
/// `Unknown` is an honest answer, not an error: a platform tool that is missing, a query that
/// failed, a desktop with no `xdg-settings` — none of those mean "not default", and a row that
/// claimed either way would be guessing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MailDefault {
    Default,
    NotDefault,
    Unknown,
}

impl MailDefault {
    pub fn as_str(self) -> &'static str {
        match self {
            MailDefault::Default => "default",
            MailDefault::NotDefault => "not-default",
            MailDefault::Unknown => "unknown",
        }
    }
}

/// Which shape the platform's request takes — returned by [`default_mail_request`] so the window
/// can say what is about to happen instead of guessing from the platform.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)] // each variant is constructed on exactly one platform; tests name all three
pub enum RequestOutcome {
    /// macOS: the change is in the system's hands — it may confirm with its own dialog or apply
    /// directly (see the module doc); the answer arrives as a changed status on a later read,
    /// or not at all.
    SystemDialog,
    /// Windows: the Settings page is open; the person picks ohmail under Email there.
    SettingsOpened,
    /// Linux: `xdg-settings` wrote the setting; the fresh state says whether it took.
    Set,
}

impl RequestOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            RequestOutcome::SystemDialog => "system-dialog",
            RequestOutcome::SettingsOpened => "settings-opened",
            RequestOutcome::Set => "set",
        }
    }
}

/* ── the decisions, as pure functions over what a platform tool answered ───────────────────────
 *
 * Each platform's probe is reduced to an `Option<String>` before it gets here — `None` for "the
 * tool is missing or the call failed", `Some(answer)` for whatever it said — so the mapping from
 * answer to state is a table a test drives directly, on every platform. */

/// macOS: the bundle id Launch Services answered with, compared case-insensitively — bundle ids
/// are case-insensitive to the OS, and a handler string is not worth a false "not default" over
/// casing.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn state_from_handler(handler: Option<&str>, ours: &str) -> MailDefault {
    match handler {
        None => MailDefault::Unknown,
        Some(id) => {
            if id.eq_ignore_ascii_case(ours) {
                MailDefault::Default
            } else {
                MailDefault::NotDefault
            }
        }
    }
}

/// Windows: the `ProgId` value under `UserChoice`, out of `reg.exe query` output.
///
/// The output's shape is stable across Windows versions — a header line, then
/// `    ProgId    REG_SZ    <value>` — and this reads it as fields rather than by column: the
/// value is the third whitespace-separated token onward, joined back so a ProgId containing a
/// space (none does today) would survive.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn prog_id_from_reg_output(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        let mut fields = line.split_whitespace();
        if fields.next() != Some("ProgId") {
            continue;
        }
        if fields.next() != Some("REG_SZ") {
            continue;
        }
        let value = fields.collect::<Vec<_>>().join(" ");
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

/// Windows: the state, from the query's outcome. A query that RAN and found no `UserChoice` is
/// a machine where no app holds the choice — "not default" is the true answer there, where a
/// missing `reg.exe` (which does not happen on real Windows) is not a fact about the choice.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn state_from_reg(ran: bool, prog_id: Option<&str>, ours: &str) -> MailDefault {
    if !ran {
        return MailDefault::Unknown;
    }
    match prog_id {
        Some(id) if id == ours => MailDefault::Default,
        _ => MailDefault::NotDefault,
    }
}

/// Linux: the desktop entry `xdg-settings get` printed, trimmed. An empty answer is a desktop
/// where nothing holds the scheme — "not default" — where a tool that is missing or refused is
/// `Unknown`, the guided state.
#[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
pub fn state_from_xdg(answer: Option<&str>, ours: &str) -> MailDefault {
    match answer {
        None => MailDefault::Unknown,
        Some(out) => {
            let entry = out.trim();
            if entry == ours {
                MailDefault::Default
            } else {
                MailDefault::NotDefault
            }
        }
    }
}

/* ── the argv tables, composed from constants so a test can pin them on every platform ──────── */

/// The registry key Windows keeps the user's mailto choice under. HKCU, because the choice is
/// per-user — the same hive the per-user installer writes.
#[cfg_attr(not(windows), allow(dead_code))]
const USERCHOICE_KEY: &str =
    r"HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\mailto\UserChoice";

#[cfg_attr(not(windows), allow(dead_code))]
fn reg_query_args() -> [String; 4] {
    [
        "query".into(),
        USERCHOICE_KEY.into(),
        "/v".into(),
        "ProgId".into(),
    ]
}

#[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
fn xdg_get_args() -> [String; 3] {
    [
        "get".into(),
        "default-url-scheme-handler".into(),
        "mailto".into(),
    ]
}

#[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
fn xdg_set_args() -> [String; 4] {
    [
        "set".into(),
        "default-url-scheme-handler".into(),
        "mailto".into(),
        LINUX_DESKTOP_ID.into(),
    ]
}

/* ── the platform probes — the only functions here that touch the OS ─────────────────────────── */

/// macOS Launch Services, over four CoreFoundation symbols and two Launch Services symbols from
/// frameworks this process already links (the same shape as `security_ffi` in `engine.rs` — no
/// third-party code joins the audit).
///
/// `LSCopyDefaultHandlerForURLScheme` is the read; deprecated in the headers for years and still
/// the one supported way to ASK (the replacement answers with an application URL, which is a
/// worse fit — the bundle id is what this app is named by). `LSSetDefaultHandlerForURLScheme` is
/// the request, and on every macOS this app runs on it does not set anything by itself: the OS
/// shows its own consent dialog naming both apps, and the user's click is what changes the
/// setting.
#[cfg(target_os = "macos")]
mod launch_services {
    use std::ffi::c_void;

    pub type CFStringRef = *const c_void;
    const UTF8: u32 = 0x0800_0100; // kCFStringEncodingUTF8

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithBytes(
            alloc: *const c_void,
            bytes: *const u8,
            num_bytes: isize,
            encoding: u32,
            is_external_representation: u8,
        ) -> CFStringRef;
        fn CFStringGetCString(
            the_string: CFStringRef,
            buffer: *mut u8,
            buffer_size: isize,
            encoding: u32,
        ) -> u8;
        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSCopyDefaultHandlerForURLScheme(scheme: CFStringRef) -> CFStringRef;
        fn LSSetDefaultHandlerForURLScheme(scheme: CFStringRef, handler: CFStringRef) -> i32;
    }

    fn cf(text: &str) -> CFStringRef {
        unsafe {
            CFStringCreateWithBytes(
                std::ptr::null(),
                text.as_ptr(),
                text.len() as isize,
                UTF8,
                0,
            )
        }
    }

    /// The bundle id of the current mailto handler, or `None` when the OS holds no answer.
    pub fn default_mailto_handler() -> Option<String> {
        unsafe {
            let scheme = cf("mailto");
            if scheme.is_null() {
                return None;
            }
            let handler = LSCopyDefaultHandlerForURLScheme(scheme);
            CFRelease(scheme);
            if handler.is_null() {
                return None;
            }
            // Bundle ids are short ASCII in practice; 512 is generous and a longer one answers
            // `None` rather than truncating into a different id.
            let mut buffer = [0u8; 512];
            let ok = CFStringGetCString(handler, buffer.as_mut_ptr(), buffer.len() as isize, UTF8);
            CFRelease(handler);
            if ok == 0 {
                return None;
            }
            let len = buffer.iter().position(|&b| b == 0)?;
            String::from_utf8(buffer[..len].to_vec()).ok()
        }
    }

    /// Ask macOS to make `bundle_id` the mailto handler. `0` means the request was accepted —
    /// macOS may confirm with its own dialog or apply the change directly (Apple documents the
    /// call as setting the handler); only a later read answers what it did.
    pub fn request_mailto_handler(bundle_id: &str) -> i32 {
        unsafe {
            let scheme = cf("mailto");
            let handler = cf(bundle_id);
            if scheme.is_null() || handler.is_null() {
                if !scheme.is_null() {
                    CFRelease(scheme);
                }
                if !handler.is_null() {
                    CFRelease(handler);
                }
                return -1;
            }
            let status = LSSetDefaultHandlerForURLScheme(scheme, handler);
            CFRelease(scheme);
            CFRelease(handler);
            status
        }
    }
}

/// Windows: `reg.exe query`, from its own directory rather than `PATH`, no console window.
/// `None` when the tool could not run OR the registry could not be read; `Some(stdout)` for an
/// ANSWER. A non-zero exit with "unable to find the specified registry key" is `reg.exe`
/// answering (no UserChoice is set) and stays `Some("")` — but only after the control query
/// below confirms the registry itself is readable, because an access failure exits the same way
/// and must surface as `Unknown` rather than as "not default".
#[cfg(windows)]
fn run_reg(args: &[String]) -> Option<String> {
    match run_reg_raw(args) {
        None => None,
        Some((true, stdout)) => Some(stdout),
        Some((false, stdout)) => {
            // Non-zero exit. Key-absent and registry-failure BOTH look like this (empty stdout,
            // a localized stderr sentence), and only the first is an answer. `reg.exe`'s error
            // text cannot be matched — it is localized — so the discriminator is a control
            // query against a key every user hive has: if the registry answers THAT, the first
            // failure meant "no such key" (an answer: nothing is set); if even the control
            // query fails, reg or the hive is broken and the honest state is `Unknown`, not
            // "not-default" (an external review caught the old conflation claiming "Another
            // app" over an access error).
            let control: Vec<String> = vec!["query".into(), r"HKCU\Software".into()];
            match run_reg_raw(&control) {
                Some((true, _)) => Some(stdout),
                _ => None,
            }
        }
    }
}

/// One `reg.exe` spawn: `None` when it could not run at all; otherwise whether it exited zero,
/// and its stdout. The reading of a non-zero exit belongs to [`run_reg`], not here.
#[cfg(windows)]
fn run_reg_raw(args: &[String]) -> Option<(bool, String)> {
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let reg = std::path::Path::new(&system_root).join("System32").join("reg.exe");
    let mut command = std::process::Command::new(reg);
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match command.args(args).output() {
        Ok(out) => Some((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned())),
        Err(_) => None,
    }
}

/// Linux: `xdg-settings`, looked for where distributions put it and then left to `PATH` — the
/// tool is a portability shim by design, so refusing to fall back to `PATH` would refuse the
/// desktops it exists for. `None` when it is missing or exited non-zero (a desktop it does not
/// understand); `Some(stdout)` for an answer.
#[cfg(not(any(target_os = "macos", windows)))]
fn run_xdg(args: &[String]) -> Option<String> {
    const LOCATIONS: &[&str] = &["/usr/bin/xdg-settings", "/usr/local/bin/xdg-settings"];
    let name = LOCATIONS
        .iter()
        .find(|p| std::path::Path::new(p).is_file())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("xdg-settings"));
    match std::process::Command::new(name).args(args).output() {
        Ok(out) if out.status.success() => Some(String::from_utf8_lossy(&out.stdout).into_owned()),
        _ => None,
    }
}

/* ── the two commands ─────────────────────────────────────────────────────────────────────────── */

/// The platform's answer, per platform. Split from the commands so both can share it.
fn probe() -> MailDefault {
    #[cfg(target_os = "macos")]
    {
        let handler = launch_services::default_mailto_handler();
        state_from_handler(handler.as_deref(), MACOS_BUNDLE_ID)
    }
    #[cfg(windows)]
    {
        match run_reg(&reg_query_args()) {
            None => MailDefault::Unknown,
            Some(stdout) => {
                let prog_id = prog_id_from_reg_output(&stdout);
                state_from_reg(true, prog_id.as_deref(), WINDOWS_PROG_ID)
            }
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let answer = run_xdg(&xdg_get_args());
        state_from_xdg(answer.as_deref(), LINUX_DESKTOP_ID)
    }
}

/// Is ohmail the OS's mail app for mailto links right now? `{ "state": "default" | "not-default"
/// | "unknown" }` — a read, nothing more, safe to call as often as the row is on screen.
#[tauri::command(async)]
pub fn default_mail_status() -> serde_json::Value {
    serde_json::json!({ "state": probe().as_str() })
}

/// Ask the platform to make ohmail the default mail app, the way each platform allows:
/// macOS's own consent dialog, the Windows Settings page, `xdg-settings set` on Linux. The
/// answer carries which of those happened (`how`) and a fresh read (`state`) — on the two
/// platforms where the person still has a dialog or a page in front of them, the fresh read is
/// expected to still say `not-default`, and the window re-reads later.
#[tauri::command(async)]
pub fn default_mail_request() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        let status = launch_services::request_mailto_handler(MACOS_BUNDLE_ID);
        if status != 0 {
            // -10814 is Launch Services for "no such application registered" — the one failure
            // a person can actually cause (an unregistered build run from its own folder);
            // everything else is rare enough that the number is the most honest thing to say.
            return Err(if status == -10814 {
                "macOS does not know this copy of ohmail as a mail app yet. Move it to \
                 Applications and open it once, then try again."
                    .into()
            } else {
                format!("macOS declined the request (Launch Services error {status}).")
            });
        }
        Ok(serde_json::json!({
            "how": RequestOutcome::SystemDialog.as_str(),
            "state": probe().as_str(),
        }))
    }
    #[cfg(windows)]
    {
        // NEVER a registry write: UserChoice is hashed against exactly this kind of programmatic
        // defaulting, and an app that fights that is an app Windows is right to distrust. The
        // Settings page is the supported way, and the installer's Capabilities keys are what put
        // ohmail on it.
        engine::spawn_opener(WINDOWS_SETTINGS_URL)?;
        Ok(serde_json::json!({
            "how": RequestOutcome::SettingsOpened.as_str(),
            "state": probe().as_str(),
        }))
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        if run_xdg(&xdg_set_args()).is_none() {
            return Err(
                "This desktop would not accept the change — xdg-settings is missing or refused. \
                 Your desktop's own settings can still make ohmail the mail app."
                    .into(),
            );
        }
        Ok(serde_json::json!({
            "how": RequestOutcome::Set.as_str(),
            "state": probe().as_str(),
        }))
    }
}

#[cfg(test)]
#[path = "default_mail_tests.rs"]
mod tests;
