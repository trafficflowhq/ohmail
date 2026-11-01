//! The auto-updater — Rust-side, and deliberately nowhere near the webview.
//!
//! ── WHY THIS LIVES IN RUST AND NOT IN THE UI ──────────────────────────────────
//!
//! The shell's promise is that the webview reaches nothing: `capabilities/main.json`
//! grants it no permission, its CSP names one source, the in-process command scheme (this module's
//! progress page declares `connect-src 'none'`), and `offline-guard.ts`
//! seals `fetch`/`XMLHttpRequest`/`WebSocket` inside the page. Putting a
//! "Check for updates" button in the React UI would mean granting the webview an
//! updater permission and breaking all of that. So the updater lives entirely
//! here, and everything it puts on screen is native: one menu item and, at most,
//! one dialog. The webview gains nothing; the PROCESS makes the requests.
//!
//! ── AND WHY SETTINGS NOW HAS THE SAME AFFORDANCE, WHICH THIS HEADER USED TO ───
//!    ARGUE AGAINST
//!
//! This paragraph used to read: a banner needs a button, a button needs a command,
//! and a command is the exact permission this design exists to withhold. The first
//! two clauses are still true. The third was true of the PREVIEW build and stopped
//! being true of the one people download, whose window already calls twenty of this
//! shell's commands — so "no command" had quietly become a rule that held in the
//! artifact nobody installs. What is actually withheld is the NETWORK, and that is
//! untouched: `update_state` takes no argument and answers a value, `update_press`
//! takes no argument and does exactly what picking the menu item does. The request,
//! the minisign verification, the version guard, the dialog and the install all stay
//! in this file. The window can ask for a check; it cannot name a feed, see a
//! payload, or install anything.
//!
//! It has to be that way now, because THE MENU BAR IS NOT ALWAYS THERE. On a tiling
//! Wayland compositor the app draws no menu bar at all (`frame.rs`), and a menu item
//! that is the app's only update interface is, on those desktops, no update interface.
//! The preview build keeps the bar as its only affordance, and its launch check and
//! dialog still work; the engine build has both.
//!
//! ── WHAT THE USER ACTUALLY SEES ───────────────────────────────────────────────
//!
//! One decision, asked once, at the end:
//!
//!   1. The app checks the feed shortly after launch, once a day while it stays
//!      open (`update_poll`, driven by `src/update-cadence.ts` on a wall clock),
//!      and whenever the menu item is picked. While a check runs the item says so
//!      and is disabled, so a slow feed is visible where the user just pressed
//!      rather than as dead air.
//!   2. A newer signed release is FETCHED in the background. Nothing is installed
//!      by that: `Update::download` streams the payload, minisign-verifies it and
//!      hands back bytes. A check the user asked for also opens the small progress
//!      window (`src/updater-window.ts`) so the wait is visible; a check nobody
//!      asked for stays silent, and the menu item is the only sign of it.
//!   3. When the payload is verified and waiting, the engine build's window says so in
//!      one quiet line at the foot of its sidebar (`src/update-cadence.ts`), with
//!      Restart beside it; the preview asks natively. With Settings' "Install updates
//!      automatically" on (the default) the release goes in when the app quits, or at
//!      the next launch for an AppImage staged beside itself; with it off it waits for
//!      Restart, and the menu item says "Restart to Install".
//!
//! The app restarts on that press, and at a launch that applied a staged release
//! before any window showed. The installs at quit and at launch happen while no
//! window is on screen, and none happens while a send waits or a draft holds files.
//! A quit that is a restart (the relaunch card's) installs too, and Windows' installer
//! then starts the app again in its place. An install at quit or launch that fails is
//! kept for the next launch, whose window says so; no quit tries that release again.
//!
//! ── WHAT THE WINDOW ADDS TO THAT, AND WHY IT IS NOT A SECOND POLICY ───────────
//!
//! Two of the sentences above are true of THIS FILE and were, for a window nobody
//! closes, the whole story: the check happens once at launch, and "Later" is spent
//! for the run. A mail client is the archetype of a program left running for weeks,
//! so on those installs "checks at launch" meant "checked once", and a verified
//! payload could sit unmentioned for as long as the window stayed open.
//!
//! `src/update-cadence.ts` closes both, from the window and on a wall clock. It
//! gains nothing this file withholds: it calls `update_poll`, which takes no
//! argument and is `check(app, false)` — the launch check's own path — and it calls
//! it only where `Flow::press` already answers `Check`, so it can start a check and
//! cannot install.
//!
//! NOT `update_press`, and that is worth stating because the press was the obvious
//! thing to reuse and is wrong. A press is a person asking, and this file answers a
//! person out loud: a press that finds nothing says "ohmail is up to date", a press
//! that cannot reach the feed says so with a Try-again, a press that finds a release
//! opens the progress window. Each of those is right for somebody who pressed a
//! button and would otherwise face dead air; each is wrong once a day for ever, and
//! a scheduled press would have shown a modal over somebody's mail every twenty-four
//! hours on an install that was already current.
//!
//! The window's ask is a quiet strip, never a dialog: at the first sight of a ready
//! payload, then at most once a day, and at once for a ready a press produced
//! (`pressedAt`). A failing install is bounded on the window's side too —
//! one scheduled check after a refusal, then it stops — so an install that cannot
//! succeed does not turn the one dialog into a daily one.
//!
//! The stamp that makes the cadence possible is `Check::at_unix_ms`, which is wall
//! clock rather than monotonic for the reason its own comment gives. That choice
//! turns out to be load-bearing twice: a suspended machine stops every monotonic
//! clock the platforms offer, so a cadence built on one would postpone itself for
//! as long as a laptop was shut.
//!
//! ── WHAT IT WILL AND WILL NOT DO ──────────────────────────────────────────────
//!
//!   * ONE endpoint, pinned in `tauri.conf.json` (`plugins.updater.endpoints`):
//!     the project's own GitHub Releases `latest.json` feed, over HTTPS. Nothing
//!     else is reachable.
//!   * INSTALLED AT THE NEXT RESTART, by the person's own setting. Downloading and
//!     installing are two separate calls here. The switch (on by default) lets the
//!     release go in at quit or at launch; off, nothing is applied until a press, and a
//!     payload never pressed for is dropped when the app quits. Nothing installs while
//!     the window says a send waits or a draft holds files, and a staged release is
//!     verified again before use.
//!   * EVERY payload is minisign-verified against `plugins.updater.pubkey` by
//!     `tauri-plugin-updater` before `download` will return it — a tampered
//!     payload never becomes bytes this module could install. That verification,
//!     and the committed key material it runs against, is exercised in
//!     `updater_tests.rs`.
//!   * A DOWNGRADE (or a reinstall of the same version) is refused, and refused
//!     against a version THE SIGNING KEY VOUCHES FOR rather than one the feed
//!     asserts. This distinction is the whole guard: `latest.json` is unsigned,
//!     so a feed writer who holds no key could otherwise advertise `99.0.0`
//!     over an old release's genuinely signed artifact and every install would
//!     take the downgrade. `signed_release` reads the version out of the
//!     payload's own minisign trusted comment — signed material — and
//!     `should_offer` compares THAT. A feed whose claim disagrees with what was
//!     signed, or that offers a payload with no signed version at all, is
//!     treated as "nothing to offer" rather than reported: it is not a fact a
//!     user can act on. `signed_release`'s own comment carries the mechanism.
//!   * IT WRITES DOWN WHAT IT DID — three lines per cycle, in the engine log's own JSON shape:
//!     the feed it asked and the version it asked about, what the check found, and what became
//!     of a payload, plus on Windows whether the engine had left before the installer started.
//!     It used to log nothing at all, so answering "which feed did this install
//!     reach" meant reading the compiled endpoint out of the binary. The endpoint
//!     comes from the config rather than a literal here, no payload url is logged, and a failure
//!     is a CLASS rather than a library's error text.
//!   * NO ERROR DEAD ENDS. A failed check or a failed download says one plain
//!     sentence, and only when the user asked for the check; the dialog's other
//!     button tries again. A check nobody asked for fails silently and leaves the
//!     menu item where it was.
//!
//! The menu item that triggers it is built by `menu.rs`, which owns the whole bar;
//! this module owns its id, its text, the handler for it, and everything below.
//!
//! The feed itself (`latest.json` and the signed artifacts it points at) is
//! produced and published by the release pipeline — this module is only the
//! client's side of that contract. The feed schema it expects is tauri's own:
//! `{ "version", "notes", "pub_date", "platforms": { "<target>-<arch>":
//! { "signature", "url" } } }`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

/// The id the menu item carries and the menu-event handler matches on.
pub const CHECK_FOR_UPDATES_ID: &str = "check-for-updates";

/// What that item says when there is nothing in flight — the text `menu.rs` builds it with.
///
/// The label is this module's rather than the menu's because it MOVES: the item is the whole of
/// the update interface, so it has to be able to say "checking", "downloading" and "restart to
/// install" as well. `menu.rs` owns where the item sits in the bar and nothing about what it says.
pub const MENU_LABEL_IDLE: &str = "Check for Updates…";

/// The window that renders download progress, and the event this module emits into it.
///
/// Both names are duplicated in `src/updater-window.ts` — a Rust binary and a static page share no
/// artifact to import one from, exactly as `menu.rs` and `native.ts` do for the menu events — and
/// `test/desktop-shell.test.ts` holds the two spellings together. The window is granted ONLY
/// `core:event:allow-listen`, scoped to this label, by `capabilities/updater.json`; the main
/// window's grant stays empty.
pub const PROGRESS_WINDOW_LABEL: &str = "updater";
pub const PROGRESS_EVENT: &str = "updater://progress";

/// The event that carries [`report`] to the settings pane, on every transition.
///
/// A THIRD name rather than a payload variant on `PROGRESS_EVENT`, for the reason the menu has
/// two events instead of one union: the two carry different kinds of value to different windows,
/// and the progress window's capability is scoped to the one event it renders. Spelled again in
/// `src/update.ts`; `test/desktop-shell.test.ts` holds the two spellings together.
pub const STATE_EVENT: &str = "updater://state";

/// Where the flow has got to. One value, and every surface reads it rather than deciding for
/// itself: the menu item's text, whether a press checks or restarts, and whether the one dialog is
/// still owed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Stage {
    /// Nothing in flight and nothing waiting.
    #[default]
    Idle,
    /// The feed is being asked.
    Checking,
    /// A newer release is being fetched. Nothing is installed by this.
    Downloading(String),
    /// A verified payload is in memory, one press away from being installed.
    Ready(String),
    /// The last attempt did not finish. The remedy is to try again.
    Failed,
}

/// Everything that can move the flow along. Named for what HAPPENED, not for what to do about it,
/// so the reaction stays in one place ([`Flow::apply`]) instead of at each call site.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Signal {
    CheckStarted,
    /// The feed answered, and there is nothing newer to offer. A refused downgrade is this too:
    /// from the user's side, an update that must not be installed and no update are the same fact.
    NothingOffered,
    Offered(String),
    Downloaded,
    Failed,
    /// The user answered "Later" to the one dialog. Asked once per run, never twice.
    Deferred,
    /// The installer did not start after the engine stopped for it. The release stays on offer,
    /// and the next press fetches and verifies it again.
    InstallerDidNotStart { at_unix_ms: u64 },
    /// That press's fetch began.
    Refetching,
    /// The check that just started answers a person's press, not a schedule.
    Pressed { at_unix_ms: u64 },
}

/// What picking the menu item does, in this stage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Press {
    Check,
    Restart,
    /// A check or a download is already running; the item is disabled and a press cannot land.
    Nothing,
}

/// HOW THIS COPY WAS INSTALLED — and therefore whether it can replace its own files.
///
/// Only three of these can: `tauri-plugin-updater` rewrites the file `$APPIMAGE` names, runs the
/// Windows setup, and swaps the macOS bundle. It has no path that can apply this project's
/// payload to a `.deb`, an `.rpm` or a Flatpak, and the feed carries no package of either kind on
/// purpose — so those installs used to fetch a release the press could not apply and say so
/// afterwards. Read from the machine and never from configuration: an install cannot be asked to
/// lie about itself. [`classify`] is the whole decision and [`Facts`] its input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallKind {
    /// The AppImage, running through its own runtime — the one Linux install that replaces itself.
    AppImage,
    /// Installed from the `.deb`.
    Deb,
    /// Installed from the `.rpm`.
    Rpm,
    /// A Linux binary under a system prefix that this project's bundler never packaged — a
    /// distribution's own build of this source.
    LinuxPackage,
    /// Running inside a Flatpak sandbox.
    Flatpak,
    /// Installed by the Windows setup.
    WindowsSetup,
    /// The macOS application bundle, downloaded from the release page.
    MacBundle,
    /// The Mac App Store build. Compiled by `--features mas`, never read from the machine: the
    /// store's copy is a `MacBundle` in every way the filesystem can see, and replacing its own
    /// files is exactly what the store forbids it to do.
    MacAppStore,
    /// A Linux binary that is none of the above: built from source, or an AppImage somebody
    /// unpacked and is running from the extracted tree.
    Unpackaged,
}

impl InstallKind {
    /// The wire name the window switches on. Written out rather than derived, `CheckResult`'s
    /// reason: a rename in Rust must not silently change what `src/update.ts` reads.
    pub fn as_str(self) -> &'static str {
        match self {
            InstallKind::AppImage => "appimage",
            InstallKind::Deb => "deb",
            InstallKind::Rpm => "rpm",
            InstallKind::LinuxPackage => "linuxPackage",
            InstallKind::Flatpak => "flatpak",
            InstallKind::WindowsSetup => "windowsSetup",
            InstallKind::MacBundle => "macBundle",
            InstallKind::MacAppStore => "macAppStore",
            InstallKind::Unpackaged => "unpackaged",
        }
    }

    /// Can this install replace its own files? The gate, and the three that can are exactly the
    /// three the plugin has an installer for.
    pub fn self_applies(self) -> bool {
        matches!(
            self,
            InstallKind::AppImage | InstallKind::WindowsSetup | InstallKind::MacBundle
        )
    }

    /// What the menu item says on an install that cannot update itself, or `None` where the flow's
    /// own label is the right one. The item stays in the bar and is disabled rather than removed:
    /// somebody looking for "Check for Updates…" is asking a question, and an answer beats an
    /// absence.
    pub fn menu_sentence(self) -> Option<&'static str> {
        match self {
            InstallKind::AppImage | InstallKind::WindowsSetup | InstallKind::MacBundle => None,
            InstallKind::Deb | InstallKind::Rpm | InstallKind::LinuxPackage => {
                Some("Updates Come from Your Package Manager")
            }
            InstallKind::Flatpak => Some("Updates Come from Your Software Centre"),
            InstallKind::MacAppStore => Some("Updates Come from the App Store"),
            InstallKind::Unpackaged => Some("This Build Does Not Update Itself"),
        }
    }
}

/// Which platform this binary was compiled for. A value rather than `cfg!` inside [`classify`], so
/// one table drives all three from one test run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Linux,
    Windows,
    Mac,
}

const HOST_OS: Os = if cfg!(target_os = "windows") {
    Os::Windows
} else if cfg!(target_os = "macos") {
    Os::Mac
} else {
    Os::Linux
};

/// Everything [`classify`] is allowed to know, read once by [`read_facts`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Facts {
    /// What the BUNDLER wrote into this binary, translated from tauri's own `BundleType`. It is
    /// present in everything this project ships — the shipped `.deb`'s binary carries the deb
    /// mark and the AppImage's carries the AppImage one, patched in at packaging time — and it is
    /// the same value `tauri-plugin-updater` switches ITS installer on, so the kind this file
    /// gates on and the installer that would have run cannot disagree. `None` on a build the
    /// bundler never packaged.
    pub bundled_as: Option<InstallKind>,
    /// Is this process the AppImage `$APPIMAGE` names? See [`AppImage`] — the variable alone is
    /// not the fact, because every child of an AppImage inherits it.
    pub appimage: AppImage,
    /// Does `/.flatpak-info` exist? The marker inside the sandbox, and the reliable one —
    /// `FLATPAK_ID` is not always inherited.
    pub flatpak_info: bool,
    /// Is the running executable under a system prefix (`/usr` or `/opt`)?
    pub system_path: bool,
    /// Was this binary compiled for the Mac App Store (`--features mas`)? A COMPILED fact and not
    /// a machine one, because nothing on disk distinguishes the store's copy from the download
    /// page's: same bundle layout, same identifier shape, same everything the filesystem sees.
    pub store_build: bool,
    pub os: Os,
}

/// Is the running executable the AppImage `$APPIMAGE` names? The variable is not the answer: the
/// runtime exports it to the process it launches and every child inherits it, so a copy extracted
/// from an image, or anything started from a terminal that is itself an AppImage, sees it set
/// while owning no image at all. Those copies have nothing the plugin could rewrite, and offering
/// them an update is a press that reports done and changes nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum AppImage {
    /// `$APPIMAGE` is unset or empty. Nothing here was launched by an AppImage runtime.
    #[default]
    None,
    /// `$APPIMAGE` is set and this process is NOT the image it names — an extracted copy, an
    /// `APPIMAGE_EXTRACT_AND_RUN` start, or a child of some other AppImage.
    Inherited,
    /// This process IS that image: the executable is served by a LIVE mount the AppImage runtime
    /// made, and `$APPIMAGE` names a regular file — a file that exists to be replaced. What makes
    /// it live is [`running_image`]: a `/proc/self/mountinfo` entry at that directory, its device
    /// the one the executable is read from, its FUSE subtype the image's own file name.
    Running,
}

/// The one decision, as a pure function of what the machine says. The ORDER is the design:
///
///  0. The store build wins outright — it is a fact about the artifact, not about the machine.
///  1. The sandbox marker wins next — a Flatpak is a Flatpak whatever a bundler wrote, and
///     the software centre is what updates it.
///  2. The bundler's record next, for every kind but the AppImage, and ahead of the AppImage fact
///     because a packaged install must not be talked into replacing a stranger's file.
///  3. The AppImage fact then decides the AppImage ALONE, not together with the bundler's mark. An
///     AppImage whose mark went missing would otherwise stop updating with nothing on screen to
///     say so, and an extracted copy carries the mark while having no image to rewrite.
///  4. Under a system prefix with no mark: a distribution built this and owns the files.
pub fn classify(facts: Facts) -> InstallKind {
    // 0. The store build wins before anything on disk is consulted: it is the one kind that is a
    //    property of the artifact rather than of the machine, and the store updates it.
    if facts.store_build {
        return InstallKind::MacAppStore;
    }
    if facts.flatpak_info {
        return InstallKind::Flatpak;
    }
    if let Some(kind) = facts.bundled_as {
        if kind != InstallKind::AppImage {
            return kind;
        }
    }
    match facts.os {
        Os::Linux if facts.appimage == AppImage::Running => InstallKind::AppImage,
        Os::Linux if facts.system_path => InstallKind::LinuxPackage,
        Os::Linux => InstallKind::Unpackaged,
        Os::Windows => InstallKind::WindowsSetup,
        Os::Mac => InstallKind::MacBundle,
    }
}

/// What the machine says about `$APPIMAGE`, as values rather than as an environment — so every
/// case below is a row in a table instead of a variable a test would have to set globally.
#[derive(Clone, Copy, Debug, Default)]
pub struct ImageEnv<'a> {
    /// `$APPIMAGE`, empty read as absent: the file the runtime mounted, and the only file the
    /// plugin's AppImage installer rewrites.
    pub appimage: Option<&'a std::path::Path>,
    /// Is `$APPIMAGE_EXTRACT_AND_RUN` PRESENT? The runtime then unpacked the image to a temporary
    /// directory and ran the copy: nothing is mounted and the running files are not the image.
    pub extract_and_run: bool,
    /// `$APPDIR` — the mount point the runtime made. Inherited exactly as `$APPIMAGE` is, and set
    /// by an extracted `AppRun` to the extraction directory, so it CONFIRMS the mount below and
    /// never establishes it alone.
    pub appdir: Option<&'a std::path::Path>,
    /// `/proc/self/exe`, resolved.
    pub exe: Option<&'a std::path::Path>,
    /// Does `$APPIMAGE` name a regular file? Measured by [`read_facts`]; there is nothing to
    /// replace if it does not.
    pub image_is_a_file: bool,
    /// `/proc/self/mountinfo`, whole and unparsed — the kernel's list of what is mounted where.
    /// `None` where it could not be read, which classifies NOT running: a fact that could not be
    /// read is not a fact that held.
    pub mountinfo: Option<&'a str>,
    /// `st_dev` of the running executable — the kernel's own answer to which mount serves this
    /// file, and the half of the test below that a person cannot write by choosing a path.
    pub exe_device: Option<u64>,
}

/// One `/proc/self/mountinfo` line, as much of it as this decision reads. The kernel's format is
/// fixed: id, parent, `major:minor`, root, mount point, options, any number of optional fields, a
/// lone `-`, the filesystem type, the source, the super options.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountEntry {
    pub major: u32,
    pub minor: u32,
    pub mount_point: String,
    pub fs_type: String,
    pub source: String,
}

/// The four characters the kernel escapes in a mount point, a filesystem type and a source: space,
/// tab, newline and the backslash itself, each as three octal digits. All four are ASCII, so a
/// decoded byte IS the character it stood for; nothing else in the line is escaped.
fn unescape_mountinfo(field: &str) -> String {
    let mut out = String::with_capacity(field.len());
    let mut rest = field.chars();
    while let Some(c) = rest.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        let digits: String = rest.clone().take(3).collect();
        match u8::from_str_radix(&digits, 8) {
            Ok(byte) if digits.len() == 3 => {
                out.push(byte as char);
                rest.nth(2);
            }
            _ => out.push('\\'),
        }
    }
    out
}

/// Read one line, or `None` where it is not one. Deliberately not lenient: a line this cannot
/// parse is a line this decision does not get to use.
pub fn parse_mount_line(line: &str) -> Option<MountEntry> {
    let mut fields = line.split_whitespace();
    let (_id, _parent) = (fields.next()?, fields.next()?);
    let device = fields.next()?;
    let _root = fields.next()?;
    let mount_point = fields.next()?;
    // The options, then the optional fields, are however many the kernel felt like writing; the
    // lone `-` is what ends them, and it is the only field that can be exactly that.
    let mut tail = fields.skip_while(|field| *field != "-");
    tail.next()?;
    let fs_type = unescape_mountinfo(tail.next()?);
    let source = unescape_mountinfo(tail.next()?);
    let (major, minor) = device.split_once(':')?;
    Some(MountEntry {
        major: major.parse().ok()?,
        minor: minor.parse().ok()?,
        mount_point: unescape_mountinfo(mount_point),
        fs_type,
        source,
    })
}

/// The mount the kernel serves `mount_point` from: the LAST entry naming it, because a mount made
/// over an earlier one is the one a path now resolves through.
pub fn mount_entry_at(mountinfo: &str, mount_point: &std::path::Path) -> Option<MountEntry> {
    mountinfo
        .lines()
        .filter_map(parse_mount_line)
        .filter(|entry| std::path::Path::new(&entry.mount_point) == mount_point)
        .next_back()
}

/// `st_dev` split the way `/proc/self/mountinfo` prints it. The encoding is the kernel's own, and
/// glibc's `major()`/`minor()`: twelve low bits of major, eight low bits of minor, the rest above.
/// Measured: this machine's root filesystem is `252:0` and stats as `64512`; a mounted AppImage is
/// `0:187` and stats as `187`.
pub fn device_pair(device: u64) -> (u32, u32) {
    let major = ((device >> 8) & 0x0fff) | ((device >> 32) & !0x0fff);
    let minor = (device & 0xff) | ((device >> 12) & !0xff);
    (major as u32, minor as u32)
}

/// Is this directory named the way the AppImage runtime names its mount? A `mkdtemp` directory
/// called `.mount_…`. The name is where the old rule STOPPED, and a directory anybody can create
/// is why that was not enough: it now only says which mount to go and look up.
fn is_runtime_mount_dir(dir: &std::path::Path) -> bool {
    dir.file_name().is_some_and(|name| name.to_string_lossy().starts_with(".mount_"))
}

/// Does this mount name the image `$APPIMAGE` names? The runtime mounts through libfuse, which
/// writes the image's own file NAME into the FUSE subtype and into the source — measured on three
/// live mounts as `- fuse.ohmail-linux-x86_64.AppImage ohmail-linux-x86_64.AppImage`. The source
/// is admitted in either spelling, because libfuse picks it and a false refusal here would stop a
/// real AppImage ever updating. Nothing ties the mount to the image's INODE: two mounts of one
/// hard-linked file took each link's own name, so the name is what the kernel has.
fn mount_names_the_image(entry: &MountEntry, name: &std::ffi::OsStr) -> bool {
    let subtype_is_the_image = entry
        .fs_type
        .strip_prefix("fuse.")
        .is_some_and(|subtype| std::ffi::OsStr::new(subtype) == name);
    subtype_is_the_image && std::path::Path::new(&entry.source).file_name() == Some(name)
}

/// The AppImage fact, from what was measured. `Running` rests on what the RUNTIME produced and a
/// person cannot stage: a live mount at the directory the executable is served from, on the device
/// the executable is read from, named after the image `$APPIMAGE` names. An extracted tree is not
/// a mount, and a directory somebody called `.mount_x` is not one either.
pub fn running_image(env: ImageEnv<'_>) -> AppImage {
    let Some(image) = env.appimage else { return AppImage::None };
    if env.extract_and_run || !env.image_is_a_file {
        return AppImage::Inherited;
    }
    // FAIL CLOSED on anything unread. The cost of refusing is the one this file already pays for a
    // distribution's build: no update offered, and a sentence saying so.
    let (Some(exe), Some(device), Some(mountinfo), Some(name)) =
        (env.exe, env.exe_device, env.mountinfo, image.file_name())
    else {
        return AppImage::Inherited;
    };
    // `$APPDIR` still only CONFIRMS: an extracted `AppRun` sets it to the extraction directory.
    if env.appdir.is_some_and(|dir| !exe.starts_with(dir)) {
        return AppImage::Inherited;
    }
    let served_from = device_pair(device);
    for dir in exe.ancestors().filter(|dir| is_runtime_mount_dir(dir)) {
        let Some(entry) = mount_entry_at(mountinfo, dir) else { continue };
        if (entry.major, entry.minor) == served_from && mount_names_the_image(&entry, name) {
            return AppImage::Running;
        }
    }
    AppImage::Inherited
}

/// Is this path under a system prefix? Compared by PATH COMPONENT rather than as a string prefix,
/// which is what keeps a mounted AppImage out: its executable sits at
/// `/tmp/.mount_xxxxxx/usr/bin/ohmail`, which contains `/usr/bin` and does not start with it.
pub fn path_is_system(path: &std::path::Path) -> bool {
    path.starts_with("/usr") || path.starts_with("/opt")
}

/// Translate the bundler's record. Exhaustive on purpose: a new `BundleType` upstream is a compile
/// error here rather than a kind that quietly reads as "not packaged".
fn bundled_as() -> Option<InstallKind> {
    use tauri::utils::config::BundleType;
    match tauri::utils::platform::bundle_type()? {
        BundleType::Deb => Some(InstallKind::Deb),
        BundleType::Rpm => Some(InstallKind::Rpm),
        BundleType::AppImage => Some(InstallKind::AppImage),
        // One kind for both Windows installers: they differ in what runs the payload, not in
        // whether this app can be replaced by one.
        BundleType::Msi | BundleType::Nsis => Some(InstallKind::WindowsSetup),
        // A `.dmg` installs a `.app`, and tauri's own reader answers `App` for it.
        BundleType::App | BundleType::Dmg => Some(InstallKind::MacBundle),
    }
}

/// A variable set to nothing is not a path, and an unset one is not an empty one.
fn env_path(name: &str) -> Option<std::path::PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
}

/// WHICH MOUNT THE RUNNING BINARY IS READ FROM. Stated through `/proc/self/exe` — the same link
/// `current_exe` resolved — rather than through the path it returned, because a path re-resolves
/// when it is stat'd and the magic link is the kernel's answer for THIS process. Windows has
/// neither, and the AppImage question cannot arise there: [`classify`] only asks it on Linux.
#[cfg(unix)]
fn running_executable_device() -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata("/proc/self/exe").ok().map(|meta| meta.dev())
}

#[cfg(not(unix))]
fn running_executable_device() -> Option<u64> {
    None
}

fn read_facts() -> Facts {
    let exe = std::env::current_exe().ok();
    let appimage = env_path("APPIMAGE");
    let appdir = env_path("APPDIR");
    // WHAT IS MOUNTED WHERE. `desktop-shell.test.ts` holds this module to four disk reads, each
    // named by its argument: an updater that touched the filesystem anywhere else would be
    // applying an update by hand, outside the plugin that verifies payloads.
    let mountinfo = std::fs::read_to_string("/proc/self/mountinfo").ok();
    Facts {
        bundled_as: bundled_as(),
        store_build: cfg!(feature = "mas"),
        appimage: running_image(ImageEnv {
            appimage: appimage.as_deref(),
            // PRESENCE, exactly as the runtime reads it: `APPIMAGE_EXTRACT_AND_RUN=0` extracts
            // too, so a value test here would disagree with the thing that actually decided.
            extract_and_run: std::env::var_os("APPIMAGE_EXTRACT_AND_RUN").is_some(),
            appdir: appdir.as_deref(),
            exe: exe.as_deref(),
            // Is there a file there at all to be replaced.
            image_is_a_file: appimage
                .as_deref()
                .and_then(|image| std::fs::metadata(image).ok())
                .is_some_and(|meta| meta.is_file()),
            mountinfo: mountinfo.as_deref(),
            exe_device: running_executable_device(),
        }),
        // The Flatpak marker inside the sandbox.
        flatpak_info: std::fs::metadata("/.flatpak-info").is_ok(),
        system_path: exe.as_deref().map(path_is_system).unwrap_or(false),
        os: HOST_OS,
    }
}

/// How this copy was installed — read once, for the life of the process. Cached because it is
/// asked on every transition, and because a copy is not re-installed underneath itself.
pub fn install_kind() -> InstallKind {
    static KIND: std::sync::OnceLock<InstallKind> = std::sync::OnceLock::new();
    *KIND.get_or_init(|| classify(read_facts()))
}

/// The flow, as a value: what stage it is in, and whether the one prompt has been answered.
///
/// Deliberately pure — it performs nothing, reaches nothing and has no `AppHandle` — so the whole
/// of "available → downloading → ready → the restart press", and "Later means never again this
/// run", is something `updater_tests.rs` drives directly instead of something a comment claims.
#[derive(Debug, Default)]
pub struct Flow {
    stage: Stage,
    deferred: bool,
    /// When the last installer did not start, while that release is still on offer: what the
    /// window's sentence and its strip are keyed on.
    not_started_at: Option<u64>,
    /// When the press that started this cycle was made; none for a cycle nobody pressed for. The
    /// window asks about that cycle's ready at once, keyed by this instant.
    pressed_at: Option<u64>,
}

impl Flow {
    /// The stage itself, for the tests that assert the whole ladder. The shipping code never reads
    /// it directly — it asks the four questions below instead, so there is no second switch over
    /// `Stage` anywhere for this one to drift from.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn stage(&self) -> &Stage {
        &self.stage
    }

    /// When the last installer did not start, while its release is still the one on offer.
    pub fn not_started_at(&self) -> Option<u64> {
        self.not_started_at
    }

    /// When the press that started this cycle was made.
    pub fn pressed_at(&self) -> Option<u64> {
        self.pressed_at
    }

    /// The release being fetched or waiting, in the two stages that have one.
    pub fn offered(&self) -> Option<&str> {
        match &self.stage {
            Stage::Downloading(version) | Stage::Ready(version) => Some(version),
            _ => None,
        }
    }

    /// Fold one signal in. Signals that do not belong to the current stage are ignored rather than
    /// asserted on: they arrive from spawned work, and a task finishing after the flow has moved on
    /// must not be able to drag it backwards.
    pub fn apply(&mut self, signal: Signal) {
        self.stage = match (&self.stage, &signal) {
            (Stage::Idle | Stage::Failed, Signal::CheckStarted) => {
                self.pressed_at = None;
                Stage::Checking
            }
            (Stage::Checking, Signal::Pressed { at_unix_ms }) => {
                self.pressed_at = Some(*at_unix_ms);
                Stage::Checking
            }
            (Stage::Checking, Signal::NothingOffered) => Stage::Idle,
            (Stage::Checking, Signal::Offered(version)) => Stage::Downloading(version.clone()),
            (Stage::Downloading(version), Signal::Downloaded) => Stage::Ready(version.clone()),
            (Stage::Checking | Stage::Downloading(_), Signal::Failed) => Stage::Failed,
            // The one signal that changes nothing but the question. A payload stays ready after
            // "Later"; what is spent is the app's one chance to ask about it.
            (Stage::Ready(version), Signal::Deferred) => {
                self.deferred = true;
                Stage::Ready(version.clone())
            }
            // An install that failed leaves nothing to restart into.
            (Stage::Ready(_), Signal::Failed) => Stage::Failed,
            // AN INSTALLER THAT DID NOT START LEAVES THE RELEASE ON OFFER: the same press installs
            // it, after fetching and verifying it again. The question was asked, and is spent.
            (Stage::Ready(version), Signal::InstallerDidNotStart { at_unix_ms }) => {
                self.not_started_at = Some(*at_unix_ms);
                self.deferred = true;
                Stage::Ready(version.clone())
            }
            (Stage::Ready(version), Signal::Refetching) => {
                self.not_started_at = None;
                Stage::Downloading(version.clone())
            }
            (stage, _) => stage.clone(),
        };
        if self.stage == Stage::Checking {
            self.not_started_at = None;
            // A NEW CYCLE GETS A NEW CHANCE TO ASK — and what can start a cycle has changed, so
            // the old note beside this line ("reached by a user pressing the item … the only way
            // back to `Checking`") is no longer true and is corrected rather than left standing.
            // `update_poll` reaches here on a timer, with nobody asking.
            //
            // The rule the line implements is unchanged and is still the one wanted: a deferral
            // answers the payload that was on the table, and a cycle that reaches `Checking` is
            // on its way to a fresh one. Reaching `Checking` at all requires `may_start_check`,
            // which refuses in `Ready` — so a payload somebody said "Later" to is never
            // re-offered by this; what can happen is that an install FAILED after the deferral,
            // and the next cycle offers the release again.
            //
            // That is bounded on the window's side rather than here: `src/update-cadence.ts`
            // allows exactly one scheduled check after a refused install and then stops, so a
            // failing install cannot turn this into a dialog a day for the life of the app.
            self.deferred = false;
        }
    }

    /// May a check start now? False while one is running and false once a payload is waiting —
    /// re-checking then would replace a verified download with an identical one.
    pub fn may_start_check(&self) -> bool {
        matches!(self.stage, Stage::Idle | Stage::Failed)
    }

    /// Is the one dialog still owed? Only in `Ready`, and only until "Later" is pressed.
    pub fn should_prompt(&self) -> bool {
        matches!(self.stage, Stage::Ready(_)) && !self.deferred
    }

    pub fn press(&self) -> Press {
        match self.stage {
            Stage::Idle | Stage::Failed => Press::Check,
            Stage::Checking | Stage::Downloading(_) => Press::Nothing,
            Stage::Ready(_) => Press::Restart,
        }
    }

    /// What the menu item says. This is the entire quiet affordance: the app never interrupts to
    /// announce an update, so the bar has to carry the sentence.
    pub fn menu_label(&self) -> String {
        match &self.stage {
            Stage::Idle | Stage::Failed => MENU_LABEL_IDLE.to_string(),
            Stage::Checking => "Checking for Updates…".to_string(),
            Stage::Downloading(version) => format!("Downloading ohmail {version}…"),
            Stage::Ready(version) => format!("Restart to Install {version}"),
        }
    }

    /// Whether the item can be picked. False exactly where [`Press::Nothing`] would be a no-op:
    /// an item that looks live and does nothing is worse than one that is visibly busy.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn menu_enabled(&self) -> bool {
        self.press() != Press::Nothing
    }
}

/// What a press does now: the flow's own answer, except that no install starts while a send
/// waits (`held`). The menu item, the pane and the window's line all ask this one rule.
pub fn press_now(flow: &Flow, held: bool) -> Press {
    match flow.press() {
        Press::Restart if held => Press::Nothing,
        press => press,
    }
}

/// The event that asks the main window to save an open draft and then press Restart itself.
/// Spelled again in `src/update.ts`.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub const RESTART_ASKED_EVENT: &str = "updater://restart-asked";

/// How long the menu's Restart waits for the window's own press before restarting anyway. Longer
/// than the window's save bound (`RESTART_FLUSH_MS`, 3 s), so a slow save still lands first.
pub const RESTART_ASK_BOUND: Duration = Duration::from_secs(5);

/// What picking the menu item does: a restart goes through a window that can save a draft first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuPick {
    AskWindow,
    Press(Press),
}

pub fn menu_pick(flow: &Flow, held: bool, window_saves: bool) -> MenuPick {
    match press_now(flow, held) {
        Press::Restart if window_saves => MenuPick::AskWindow,
        press => MenuPick::Press(press),
    }
}

/// The menu's ask to the window, while it stands: answered by the window's press, or lapsed by
/// the shell after [`RESTART_ASK_BOUND`].
#[derive(Debug, Default)]
pub struct RestartAsk(Mutex<AskSlot>);

#[derive(Debug, Default)]
struct AskSlot {
    next: u64,
    standing: Option<(u64, Instant)>,
}

impl RestartAsk {
    /// A new ask's id, or none while a younger one stands. An older one is replaced, so a timer
    /// that never ran cannot leave the menu item dead.
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    pub fn ask(&self, now: Instant) -> Option<u64> {
        let mut slot = lock(&self.0);
        if slot
            .standing
            .is_some_and(|(_, at)| now.saturating_duration_since(at) < RESTART_ASK_BOUND)
        {
            return None;
        }
        slot.next += 1;
        let id = slot.next;
        slot.standing = Some((id, now));
        Some(id)
    }

    /// The window pressed: whatever stands is answered.
    pub fn answer(&self) -> bool {
        lock(&self.0).standing.take().is_some()
    }

    /// The bound passed: true only when this ask still stands, which it then no longer does.
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    pub fn lapse(&self, id: u64) -> bool {
        let mut slot = lock(&self.0);
        if slot.standing.is_some_and(|(standing, _)| standing == id) {
            slot.standing = None;
            return true;
        }
        false
    }
}

/// The event that asks the main window to write its open editors before a quit or a close.
/// Spelled again in `src/update.ts`.
pub const LEAVE_ASKED_EVENT: &str = "shell://leave-asked";

/// How long a quit or a close waits for the window's answer: the restart's bound, longer than the
/// window's own save bound (`RESTART_FLUSH_MS`, 3 s).
pub const LEAVE_ASK_BOUND: Duration = RESTART_ASK_BOUND;

/// A quit's or a close's ask to the window while it stands: answered by [`leave_saved`], or out of
/// time at its bound. A second leave meanwhile joins it rather than asking again.
pub struct LeaveAsk {
    slot: Mutex<LeaveSlot>,
    answered: Condvar,
}

struct LeaveSlot {
    run: u64,
    /// When the standing ask gives up.
    standing: Option<Instant>,
    /// The last run the window answered.
    answered: u64,
}

impl LeaveAsk {
    pub const fn new() -> Self {
        Self {
            slot: Mutex::new(LeaveSlot { run: 0, standing: None, answered: 0 }),
            answered: Condvar::new(),
        }
    }

    /// This leave's ask, and whether it starts one (`false`: it joined the ask standing).
    pub fn ask(&self, now: Instant, bound: Duration) -> (u64, bool) {
        let mut slot = lock(&self.slot);
        if slot.standing.is_some_and(|ends| now < ends) {
            return (slot.run, false);
        }
        slot.run += 1;
        slot.standing = Some(now + bound);
        (slot.run, true)
    }

    /// The window saved: the standing ask is answered and every wait on it goes on at once.
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    pub fn answer(&self) -> bool {
        let mut slot = lock(&self.slot);
        if slot.standing.take().is_none() {
            return false;
        }
        slot.answered = slot.run;
        self.answered.notify_all();
        true
    }

    /// Wait for `run`'s answer, never past its bound. `false` when nobody answered.
    pub fn wait(&self, run: u64) -> bool {
        let mut slot = lock(&self.slot);
        loop {
            if slot.answered >= run {
                return true;
            }
            let Some(ends) = slot.standing.filter(|_| slot.run == run) else {
                return false;
            };
            let now = Instant::now();
            if now >= ends {
                slot.standing = None;
                return false;
            }
            slot = match self.answered.wait_timeout(slot, ends - now) {
                Ok((slot, _)) => slot,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }
}

/// The app's one leave ask.
pub static LEAVE: LeaveAsk = LeaveAsk::new();

/// EVERY QUIT AND CLOSE SAVES FIRST: the window is hidden at once (unless an install is writing,
/// which keeps it, as before), asked to write its open editors, and `then` runs once it answers or
/// [`LEAVE_ASK_BOUND`] passes, on a thread of its own: the save travels through the main loop. With
/// no main window, or in the preview (whose window can call nothing), `then` runs at once.
pub fn leave_saving<R: Runtime>(app: &AppHandle<R>, then: impl FnOnce() + Send + 'static) {
    let window = app.get_webview_window("main");
    let asks = cfg!(feature = "local-engine") && window.is_some();
    let teller = app.clone();
    leave_saving_with(
        &LEAVE,
        asks,
        FENCE.must_wait(),
        move || {
            if let Some(window) = window {
                let _ = window.hide();
            }
        },
        move || {
            let _ = teller.emit(LEAVE_ASKED_EVENT, ());
        },
        then,
    );
}

/// [`leave_saving`] with its acts handed in: `hide` takes the window off the screen, `tell` asks it.
pub(crate) fn leave_saving_with(
    ask: &'static LeaveAsk,
    asks: bool,
    installing: bool,
    hide: impl FnOnce(),
    tell: impl FnOnce(),
    then: impl FnOnce() + Send + 'static,
) {
    if !asks {
        return then();
    }
    if !installing {
        hide();
    }
    let began = Instant::now();
    let (run, first) = ask.ask(began, LEAVE_ASK_BOUND);
    if first {
        tell();
    }
    std::thread::Builder::new()
        .name("ohmail-leave-save".into())
        .spawn(move || {
            let answered = ask.wait(run);
            let waited = began.elapsed().as_millis().to_string();
            emit(line("leave_save", &[("answered", if answered { "true" } else { "false" }), ("waited_ms", &waited)]));
            then();
        })
        .expect("ohmail: failed to start the leave thread");
}

/// The window wrote its open editors: a quit or close under way goes now rather than at its bound.
/// No argument; it can only end a wait already standing, never start or delay a leave.
#[cfg(feature = "local-engine")]
#[tauri::command]
pub fn leave_saved() {
    LEAVE.answer();
}

/// WHAT THE MENU ITEM SAYS, and whether it can be pressed — the flow and the install, composed.
///
/// Pure, so `updater_tests.rs` drives every pair, and the only place the two are put together:
/// an install that cannot replace its own files says so in every stage, because on such a copy
/// no stage but `Idle` is ever reached.
pub fn menu_text(kind: InstallKind, flow: &Flow, held: bool) -> (String, bool) {
    match kind.menu_sentence() {
        Some(sentence) => (sentence.to_string(), false),
        None => (flow.menu_label(), press_now(flow, held) != Press::Nothing),
    }
}

/// What a verified release waits for: the next quit or launch (`Auto`, Settings' "Install
/// updates automatically", on by default) or a press (`Ask`, the switch off).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    Auto,
    Ask,
}

impl Policy {
    /// The policy file, read: none is the default; anything unreadable or unknown asks first,
    /// because a choice nobody can read is not consent.
    pub fn read(found: &crate::appimage_stage::PolicyRead) -> Policy {
        match found {
            crate::appimage_stage::PolicyRead::Missing => Policy::Auto,
            crate::appimage_stage::PolicyRead::Text(text) if text.trim() == "auto" => Policy::Auto,
            _ => Policy::Ask,
        }
    }

    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    pub fn word(self) -> &'static str {
        match self {
            Policy::Auto => "auto",
            Policy::Ask => "ask",
        }
    }
}

/// How long one "a send waits" (or "a draft holds files") from the window holds every install. The
/// window renews it each minute while it holds, so a window that went away holds nothing for long.
pub const HOLD_FOR: Duration = Duration::from_secs(120);

/// A send waits or a draft holds files, by the window's word: until when no install may start.
#[derive(Debug, Default)]
pub struct SendHold(Mutex<Option<Instant>>);

impl SendHold {
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    pub fn set(&self, waits: bool, now: Instant) {
        *lock(&self.0) = waits.then(|| now + HOLD_FOR);
    }

    pub fn held(&self, now: Instant) -> bool {
        lock(&self.0).is_some_and(|until| now < until)
    }
}

/// Everything the install at the app's own quit is allowed to know.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct QuitFacts {
    /// A verified release is ready.
    pub ready: bool,
    /// Its bytes are held, in memory or staged.
    pub payload: bool,
    /// Settings' switch is on.
    pub auto: bool,
    /// This release's install at quit or launch failed before; it waits for a press.
    pub failed_before: bool,
    /// A send waits, or a draft holds files, by the window's word.
    pub send_waits: bool,
    /// The AppImage, the Windows setup or the macOS app.
    pub self_applies: bool,
    /// The install can replace the app without a password prompt.
    pub replaceable: bool,
    /// Windows is ending the session.
    pub session_ending: bool,
    /// Another install holds the latch.
    pub busy: bool,
    /// The exit is a restart, which Tauri performs after it ([`InstallFence::restarts`]).
    pub restarting: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuitInstall {
    Install,
    Skip(Skip),
}

/// Why the quit installed nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Skip {
    Busy,
    CannotSelfApply,
    NotReady,
    NoPayload,
    AskFirst,
    FailedBefore,
    SendWaits,
    NeedsPermission,
    SessionEnding,
}

impl Skip {
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    pub fn as_str(self) -> &'static str {
        match self {
            Skip::Busy => "busy",
            Skip::CannotSelfApply => "cannotSelfApply",
            Skip::NotReady => "notReady",
            Skip::NoPayload => "noPayload",
            Skip::AskFirst => "askFirst",
            Skip::FailedBefore => "failedBefore",
            Skip::SendWaits => "sendWaits",
            Skip::NeedsPermission => "needsPermission",
            Skip::SessionEnding => "sessionEnding",
        }
    }
}

/// THE INSTALL AT QUIT, as a pure function of what the app knows as it goes.
pub fn quit_install(facts: QuitFacts) -> QuitInstall {
    let skip = if facts.busy {
        Skip::Busy
    } else if !facts.self_applies {
        Skip::CannotSelfApply
    } else if !facts.ready {
        Skip::NotReady
    } else if !facts.payload {
        Skip::NoPayload
    } else if !facts.auto {
        Skip::AskFirst
    } else if facts.failed_before {
        Skip::FailedBefore
    } else if facts.send_waits {
        Skip::SendWaits
    } else if !facts.replaceable {
        Skip::NeedsPermission
    } else if facts.session_ending {
        Skip::SessionEnding
    } else {
        return QuitInstall::Install;
    };
    QuitInstall::Skip(skip)
}

/// What the LAST COMPLETED CHECK found — a different question from [`Stage`], and it has to be.
///
/// The stage says where the flow is right now, and it collapses two facts a person would want
/// told apart: a client that is up to date and a client that REFUSED an update it could not
/// identify are both `Idle`, because from the flow's side both mean "nothing is being
/// installed". A menu item has room for one sentence and takes the collapse; a settings pane has
/// room for the truth, and "up to date" is a lie in the second case — the same lie the refusal
/// dialog exists to avoid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckResult {
    /// The feed answered and there is nothing newer.
    UpToDate,
    /// An update exists and this client will not install it — see [`refusal_is_unverifiable`].
    Refused,
    /// The feed could not be reached, or the payload did not arrive.
    Failed,
    /// A newer signed release was found. What happened next is the stage's business.
    Offered,
}

impl CheckResult {
    /// The wire name. Written out rather than derived so a rename in Rust cannot silently change
    /// what the window switches on.
    pub fn as_str(self) -> &'static str {
        match self {
            CheckResult::UpToDate => "upToDate",
            CheckResult::Refused => "refused",
            CheckResult::Failed => "failed",
            CheckResult::Offered => "offered",
        }
    }
}

/// The last completed check: when it finished, and what it found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Check {
    /// Unix milliseconds. A wall-clock instant and not a monotonic one, because the only thing
    /// it is for is a sentence a person reads — "checked 4 minutes ago" — and the window has to
    /// be able to format it against its own clock.
    pub at_unix_ms: u64,
    pub result: CheckResult,
}

/// A payload that has been fetched and verified and has NOT been installed.
type Pending = Waiting<Plugin>;

/// Where a verified release waits.
pub(crate) enum Held {
    /// Its bytes, in memory: dropped if the app quits without installing them.
    Memory(Vec<u8>),
    /// Beside the AppImage, recorded (`appimage_stage.rs`); verified again by the install.
    Staged,
    /// Nothing: an installer that did not start took the bytes, or the switch went off. The next
    /// press fetches and verifies again rather than handing kept bytes to an installer.
    Nothing,
}

/// A release waiting for its install: the payload, where it is held, and the hook the plugin runs
/// before the Windows installer starts.
pub(crate) struct Waiting<P> {
    payload: P,
    held: Held,
    hook: Arc<InstallHook>,
}

impl<P> Waiting<P> {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn new(payload: P, bytes: Vec<u8>, hook: Arc<InstallHook>) -> Self {
        Waiting::holding(payload, Held::Memory(bytes), hook)
    }

    pub(crate) fn holding(payload: P, held: Held, hook: Arc<InstallHook>) -> Self {
        Waiting { payload, held, hook }
    }

    /// Is a release held, in memory or staged? `false` after an installer that did not start.
    pub(crate) fn holds_bytes(&self) -> bool {
        !matches!(self.held, Held::Nothing)
    }
}

/// The plugin's calls an install makes, behind a seam the tests drive: `download` fetches and
/// verifies, `install` hands verified bytes to the platform's installer.
pub(crate) trait Payload {
    type Error: std::fmt::Debug;
    /// Fetch the payload again and verify its signature against the shipped key.
    fn fetch(&self) -> Result<Vec<u8>, Self::Error>;
    /// On Windows the plugin prepares the installer, runs the hook, starts the installer and exits,
    /// and returns only when preparing or starting it failed.
    fn install(&self, bytes: &[u8]) -> Result<(), Self::Error>;
    /// The same install as the app goes: the Windows installer starts the app again only when the
    /// exit is a restart, which its exit then stands in for.
    fn install_on_quit(&self, bytes: &[u8], restart: bool) -> Result<(), Self::Error>;
    /// The release staged beside the AppImage, read back; the install verifies it again.
    fn read_staged(&self) -> Result<Vec<u8>, Self::Error>;
}

/// What an AppImage's install needs beside the release: its image, the data folder its record is
/// in, and the shipped key a staged copy is verified against.
pub(crate) struct Staging {
    image: PathBuf,
    dir: Option<PathBuf>,
    pubkey: String,
}

/// The release the plugin found, as a [`Payload`]; on an AppImage, with its [`Staging`].
pub(crate) struct Plugin(tauri_plugin_updater::Update, Option<Staging>);

impl Payload for Plugin {
    type Error = tauri_plugin_updater::Error;

    /// The plugin's `download`, which verifies the signature before it returns any byte. Called on
    /// the install's own thread, never on a thread the async runtime drives.
    fn fetch(&self) -> Result<Vec<u8>, Self::Error> {
        tauri::async_runtime::block_on(self.0.download(|_, _| {}, || {}))
    }

    fn install(&self, bytes: &[u8]) -> Result<(), Self::Error> {
        self.put(bytes, true)
    }

    fn install_on_quit(&self, bytes: &[u8], restart: bool) -> Result<(), Self::Error> {
        self.put(bytes, restart)
    }

    fn read_staged(&self) -> Result<Vec<u8>, Self::Error> {
        let staging = self.1.as_ref().ok_or_else(no_image)?;
        Ok(crate::appimage_stage::read_staged(&staging.image)?)
    }
}

impl Plugin {
    /// THE ONE INSTALL. An AppImage's bytes, staged or held, are verified again and then written
    /// beside it and renamed over (`appimage_stage.rs`); the plugin's own AppImage install, which
    /// wrote in place, is never reached. Every other kind is the plugin's, the Windows installer
    /// told whether to start the app again.
    fn put(&self, bytes: &[u8], restart: bool) -> Result<(), tauri_plugin_updater::Error> {
        if install_kind() == InstallKind::AppImage {
            let staging = self.1.as_ref().ok_or_else(no_image)?;
            let running = env!("CARGO_PKG_VERSION");
            if verify_staged(bytes, &self.0.signature, &staging.pubkey, running, &self.0.version, EXPECTED_ASSET).is_none() {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "the release did not verify").into());
            }
            crate::appimage_stage::replace(&staging.image, bytes)?;
            if let Some(dir) = &staging.dir {
                crate::appimage_stage::forget_record(dir);
            }
            return Ok(());
        }
        self.0.clone().restart_after_install(restart).install(bytes)
    }
}

fn no_image() -> tauri_plugin_updater::Error {
    std::io::Error::new(std::io::ErrorKind::NotFound, "no image to replace").into()
}

/// The flow, the payload waiting on it, the menu item that reports both, and the last check.
struct Updater<R: Runtime> {
    flow: Mutex<Flow>,
    pending: Mutex<Option<Pending>>,
    item: Mutex<Option<MenuItem<R>>>,
    /// Not persisted, and deliberately: "last checked" means "since this app started", which is
    /// the honest thing for a launch check to be able to say. A value read back from disk would
    /// claim a check this run never made.
    last: Mutex<Option<Check>>,
    /// Settings' switch, read once from its file and kept.
    policy: Mutex<Option<Policy>>,
    hold: SendHold,
    ask: RestartAsk,
}

impl<R: Runtime> Updater<R> {
    fn new() -> Self {
        Self {
            flow: Mutex::new(Flow::default()),
            pending: Mutex::new(None),
            item: Mutex::new(None),
            last: Mutex::new(None),
            policy: Mutex::new(None),
            hold: SendHold::default(),
            ask: RestartAsk::default(),
        }
    }
}

/// Now, in Unix milliseconds — or 0 for a clock set before 1970, which is not a case worth a
/// second code path: the window renders a missing timestamp and a zero one the same way.
fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// THE WHOLE OF WHAT A SETTINGS PANE IS TOLD, as a value.
///
/// Pure, so `updater_tests.rs` drives every state directly rather than a comment claiming them,
/// and `serde_json::Value` rather than a derived struct for the reason `omarchy_theme` answers
/// one: the field names are the contract with a TypeScript module that shares no artifact with
/// this file, and a `Serialize` derive would need `serde` as a direct dependency for nothing.
///
/// `canCheck` and `canInstall` are the SAME two questions the menu item asks ([`Flow::press`]),
/// so the pane and the bar cannot offer different things — one flow, two surfaces, never two
/// policies.
pub fn report(
    flow: &Flow,
    last: Option<Check>,
    installed: &str,
    kind: InstallKind,
) -> serde_json::Value {
    let (state, offered) = match flow.stage() {
        Stage::Idle => ("idle", None),
        Stage::Checking => ("checking", None),
        Stage::Downloading(version) => ("downloading", Some(version.clone())),
        Stage::Ready(version) => ("ready", Some(version.clone())),
        Stage::Failed => ("failed", None),
    };
    serde_json::json!({
        "version": installed,
        "state": state,
        "offered": offered,
        "installKind": kind.as_str(),
        // THE KIND IS FOLDED IN HERE, so the pane and the strip cannot offer a press this module
        // would refuse. One flow, one install, one policy — never two.
        "canCheck": flow.press() == Press::Check && kind.self_applies(),
        "canInstall": flow.press() == Press::Restart && kind.self_applies(),
        // Unix milliseconds of an installer that did not start, while its release is on offer.
        "notStartedAt": flow.not_started_at(),
        // Unix milliseconds of the press that started this cycle; null for a scheduled one.
        "pressedAt": flow.pressed_at(),
        "lastCheckedAt": last.map(|c| c.at_unix_ms),
        "lastResult": last.map(|c| c.result.as_str()).unwrap_or("never"),
    })
}

/// What the window is told beside the flow: the switch, the hold, whether a ready release goes in
/// when the app quits — [`quit_install`]'s own answer, so the line cannot promise what the quit
/// would refuse — when an install at quit or launch failed, and when the switch installs here.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Standing {
    pub auto_install: bool,
    pub held: bool,
    pub installs_on_quit: bool,
    pub install_failed_at: Option<u64>,
    pub auto_at: Option<AutoAt>,
}

/// When Settings' switch, on, installs a ready release on this copy: what the sentence under it says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoAt {
    /// At quit, or at the next launch: an AppImage that stages the release beside itself.
    QuitOrLaunch,
    /// At quit: the Windows setup and the macOS app hold the release in memory until then.
    Quit,
    /// Only on Restart: replacing this copy needs a password, which no quit can ask for.
    Restart,
}

impl AutoAt {
    pub fn as_str(self) -> &'static str {
        match self {
            AutoAt::QuitOrLaunch => "quitOrLaunch",
            AutoAt::Quit => "quit",
            AutoAt::Restart => "restart",
        }
    }
}

/// When the switch installs on this kind, given whether it can be replaced without a prompt and
/// whether it can stage a release beside itself; `None` where the switch means nothing.
pub fn auto_at(kind: InstallKind, replaceable: bool, stages: bool) -> Option<AutoAt> {
    if !kind.self_applies() {
        return None;
    }
    Some(match (replaceable, kind == InstallKind::AppImage && stages) {
        (false, _) => AutoAt::Restart,
        (true, true) => AutoAt::QuitOrLaunch,
        (true, false) => AutoAt::Quit,
    })
}

/// [`Standing`] from what was read: a failed automatic install still standing for this release is
/// not tried at quit again (so not promised either), and the window is told when it failed.
pub fn standing_of(
    auto_install: bool,
    facts: QuitFacts,
    failed: Option<&crate::appimage_stage::Failure>,
    auto_at: Option<AutoAt>,
) -> Standing {
    let facts = QuitFacts { failed_before: failed.is_some(), ..facts };
    Standing {
        auto_install,
        held: facts.send_waits,
        installs_on_quit: quit_install(facts) == QuitInstall::Install,
        install_failed_at: failed.map(|failure| failure.at_unix_ms),
        auto_at,
    }
}

/// Does a kept failure still stand? Only for a release newer than the one running (one that went
/// in after all is over), and only while that release, or none, is on offer.
pub fn failure_stands(failure: &crate::appimage_stage::Failure, running: &str, offered: Option<&str>) -> bool {
    let newer = match (semver::Version::parse(&failure.version), semver::Version::parse(running)) {
        (Ok(failed), Ok(running)) => failed > running,
        _ => false,
    };
    newer && offered.map_or(true, |version| version == failure.version)
}

/// [`report`], with the [`Standing`] facts; `canInstall` is false while a send waits.
pub fn report_with(
    flow: &Flow,
    last: Option<Check>,
    installed: &str,
    kind: InstallKind,
    standing: Standing,
) -> serde_json::Value {
    let mut told = report(flow, last, installed, kind);
    told["canInstall"] =
        serde_json::Value::Bool(press_now(flow, standing.held) == Press::Restart && kind.self_applies());
    told["autoInstall"] = serde_json::Value::Bool(standing.auto_install);
    told["held"] = serde_json::Value::Bool(standing.held);
    told["installsOnQuit"] = serde_json::Value::Bool(standing.installs_on_quit);
    told["installFailedAt"] = standing.install_failed_at.map_or(serde_json::Value::Null, serde_json::Value::from);
    told["autoInstallsAt"] = standing.auto_at.map_or(serde_json::Value::Null, |at| at.as_str().into());
    told
}

/// What the window is told: [`report_with`], and `closing` — a quit is waiting for an install to
/// finish writing ([`FENCE`]), which the window says until it closes.
fn told(flow: &Flow, last: Option<Check>, kind: InstallKind, standing: Standing) -> serde_json::Value {
    let mut told = report_with(flow, last, env!("CARGO_PKG_VERSION"), kind, standing);
    told["closing"] = serde_json::Value::Bool(FENCE.quit_waits());
    told
}

/// Take a lock, and take it even if a previous holder panicked.
///
/// A poisoned lock here would disable the updater for the life of the process, which is a worse
/// outcome than continuing with the state that was left behind — every field is either a plain
/// enum or an owned payload, and neither can be half-written.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ── WHAT THE UPDATER WRITES DOWN ─────────────────────────────────────────────────────────────
//
// Three lines per cycle: `updater_check` names the feed and the running version, `updater_offer`
// what the check found, `updater_verdict` what became of a payload; on Windows `updater_hook`
// says whether the engine left before the installer was started. This module used to log
// nothing at all, so answering "which feed did this install reach, and what did it decide"
// meant reading the one compiled endpoint out of the binary and watching the process's sockets.
//
// Nothing identifying is in them. The endpoint is the pinned feed the config names and never a
// payload url, and a failure is reported as a CLASS rather than as a library's error text.

/// The `service` every line here carries. `engine.log` holds the engine's own JSON lines too, so
/// one grep for `"service":"updater"` is the whole read.
const LOG_SERVICE: &str = "updater";

/// What became of a payload — the log's vocabulary for the end of a cycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// The payload was applied. The app restarts immediately after.
    Installed,
    /// "Later". The payload stays ready and nothing was applied.
    Deferred,
    Failed,
    /// The engine stopped for the Windows installer and the installer did not start.
    NotStarted,
    /// A quit with a release ready installed nothing, and the line says why.
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    Skipped,
    /// A launch found a staged release it would not apply, and discarded it.
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    Refused,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Installed => "installed",
            Verdict::Deferred => "deferred",
            Verdict::Failed => "failed",
            Verdict::NotStarted => "notStarted",
            Verdict::Skipped => "skipped",
            Verdict::Refused => "refused",
        }
    }
}

/// One line of JSON, `service` and `event` first and the fields in the order given.
///
/// Composed rather than serialized from a map so the key order is this file's and not a hash's,
/// and every value goes through `serde_json`'s own escaping — a version or a class is not
/// something to interpolate into JSON by hand.
fn line(event: &str, fields: &[(&str, &str)]) -> String {
    let mut out = format!("{{\"service\":\"{LOG_SERVICE}\",\"event\":\"{event}\"");
    for (name, value) in fields {
        out.push(',');
        out.push_str(&serde_json::Value::from(*name).to_string());
        out.push(':');
        out.push_str(&serde_json::Value::from(*value).to_string());
    }
    out.push('}');
    out
}

/// Where a line goes. The engine build tees it into `engine.log` beside the engine's own lines;
/// the preview has no log file, so stderr is the whole of it — `frame::note`'s split, for
/// `frame::note`'s reason.
///
/// NEITHER ARM IS A WRITER THIS MODULE OWNS, and that is deliberate rather than tidy: a verified
/// payload lives in memory and must leave nothing on the machine, so the file that holds those
/// bytes calls no write API at all. `desktop-shell.test.ts` asserts that absence as a closed list.
#[cfg(feature = "local-engine")]
fn write_line(line: &str) {
    crate::engine::log_json_line(line);
}

#[cfg(not(feature = "local-engine"))]
fn write_line(line: &str) {
    crate::frame::note_line(line);
}

// Every line [`emit`] wrote ON THIS THREAD, so `updater_tests.rs` reads back what the shipping code
// composed rather than a copy of it, and a neighbouring case's line never lands in its window.
// Test-only, and the sink still runs beside it.
#[cfg(test)]
thread_local! {
    pub(crate) static WROTE: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Write one line. Every log site in this module goes through here.
fn emit(text: String) {
    #[cfg(test)]
    WROTE.with(|w| w.borrow_mut().push(text.clone()));
    write_line(&text);
}

/// A check is starting: the feed it is about to ask, and the version it is asking about.
fn log_check(endpoint: &str, installed: &str) {
    emit(line("updater_check", &[("endpoint", endpoint), ("version", installed)]));
}

/// What a check found: the signed version it will fetch, or `none` and the class of the answer.
///
/// `found` is [`CheckResult`]'s own wire name — the vocabulary the settings pane already switches
/// on, so the log and the pane cannot disagree about what happened — plus `installKind` for the
/// one class no check reaches: a copy that cannot replace its own files asks no feed. The kind is
/// on every line either way, because whether an offer could have been applied is the next thing
/// anybody reading one wants to know.
fn log_offer(found: &str, offered: Option<&str>, kind: InstallKind) {
    emit(line(
        "updater_offer",
        &[
            ("offered", offered.unwrap_or("none")),
            ("found", found),
            ("installKind", kind.as_str()),
        ],
    ));
}

/// What became of a payload, and — when it failed — the class of the failure.
fn log_verdict(verdict: Verdict, error_class: Option<&str>) {
    log_verdict_with(verdict, error_class, &[]);
}

/// [`log_verdict`], and where (`at`: press, quit, launch) and why, where a line says so.
fn log_verdict_with(verdict: Verdict, error_class: Option<&str>, more: &[(&str, &str)]) {
    let mut fields = vec![("verdict", verdict.as_str())];
    if let Some(class) = error_class {
        fields.push(("errorClass", class));
    }
    fields.extend_from_slice(more);
    emit(line("updater_verdict", &fields));
}

/// The CLASS of a failure, out of its `Debug` rendering, and nothing else from it.
///
/// `tauri_plugin_updater::Error`'s `Debug` is `Variant(…)`, and what is inside the brackets can
/// be a path, a url or an OS message — none of which belongs in a log somebody may hand over. So
/// the leading identifier is kept and the rest dropped, which is the same field the engine's own
/// lines carry as `errorClass`. `find` over a char predicate answers a char boundary, so the
/// slice is safe for any rendering.
pub fn error_class(debug: &str) -> &str {
    let end = debug
        .find(|c: char| !c.is_alphanumeric() && c != '_')
        .unwrap_or(debug.len());
    match &debug[..end] {
        "" => "Unknown",
        class => class,
    }
}

/// The feed this build asks, read from the config the plugin itself reads
/// (`plugins.updater.endpoints` in `tauri.conf.json`).
///
/// READ rather than restated. A second copy of the endpoint in Rust would be a second thing to
/// keep true, and the `strings` audit the README describes rests on the binary naming exactly one
/// first-party address. Joined by a space if a config ever lists more than the one this project
/// pins; empty when it names none, which is a build that cannot check at all.
fn feed_endpoints<R: Runtime>(app: &AppHandle<R>) -> String {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
        .map(|endpoints| {
            endpoints
                .iter()
                .filter_map(|endpoint| endpoint.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

/// Register the updater, the dialog it prompts through, its state and the handler
/// for its menu item. Called from `main.rs` in EVERY build — the updater ships in
/// the published binary, unlike the feature-gated engine.
///
/// THE MENU ITSELF IS NOT BUILT HERE, and the move was forced rather than tidied:
/// a menu is installed from `Builder::setup`, and a second `setup` on the same
/// builder REPLACES the first with nothing failing to say so. Once the app grew a
/// second menu (navigation, under the engine feature) two files installing menus
/// would have meant one of them silently winning. `menu.rs` owns the bar and
/// contributes this item by id; `on_menu_event` genuinely appends, so the handler
/// below is still this module's own.
pub fn attach<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(Updater::<R>::new())
        .on_menu_event(|app, event| {
            if event.id().as_ref() == CHECK_FOR_UPDATES_ID {
                menu_pressed(app.clone());
            }
        })
}

/// Let this module drive the text of the item `menu.rs` built for it.
///
/// The item is the update interface, so its text is not a constant: it reports the check, the
/// download and the one press that installs. `menu.rs` decides where in the bar it sits and
/// nothing else about it.
pub fn adopt_menu_item<R: Runtime>(app: &AppHandle<R>, item: MenuItem<R>) {
    {
        let state = app.state::<Updater<R>>();
        *lock(&state.item) = Some(item);
    }
    relabel(app);
}

/// SETTINGS → UPDATES, THE READ. What the pane draws, and what it re-reads on mount.
///
/// A command rather than only an event, for `mailto_claim`'s cold-start reason: the launch check
/// runs before this bundle's scripts do, so a pane that only listened would open blank after the
/// one transition it cared about had already happened.
///
/// It names nothing and reaches nothing — no argument, no feed, no path. The answer is [`told`]:
/// [`report`] over state this process already holds.
#[cfg(feature = "local-engine")]
#[tauri::command]
pub fn update_state<R: Runtime>(app: AppHandle<R>) -> serde_json::Value {
    let state = app.state::<Updater<R>>();
    let flow = lock(&state.flow);
    let last = *lock(&state.last);
    told(&flow, last, install_kind(), standing(&app, &flow))
}

/// SETTINGS → UPDATES, THE SWITCH. On (the default), a ready release goes in at the next quit or
/// launch; off, it waits for a press, and a release staged beside the image is discarded. One
/// bool, from the main window only; it can delay an install, never cause one.
#[cfg(feature = "local-engine")]
#[tauri::command]
pub fn update_set_auto<R: Runtime>(window: tauri::WebviewWindow<R>, on: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("the update switch is the main window's".into());
    }
    let app = window.app_handle();
    let next = if on { Policy::Auto } else { Policy::Ask };
    let dir = data_dir(app).ok_or("this platform names no data folder")?;
    crate::appimage_stage::write_policy(&dir, next.word()).map_err(|err| err.to_string())?;
    let state = app.state::<Updater<R>>();
    *lock(&state.policy) = Some(next);
    if next == Policy::Ask {
        if let Some(image) = crate::appimage_stage::running_image() {
            crate::appimage_stage::discard(&dir, &image);
        }
        // An install or a fetch holding the slot has already taken what was held.
        if let Ok(mut slot) = state.pending.try_lock() {
            if let Some(waiting) = slot.as_mut().filter(|w| matches!(w.held, Held::Staged)) {
                waiting.held = Held::Nothing;
            }
        }
    }
    relabel(app);
    Ok(())
}

/// THE WINDOW'S "A SEND WAITS" (or "A DRAFT HOLDS FILES"): while it holds, no press, menu item or
/// quit installs. The window renews it each minute; it lapses by itself [`HOLD_FOR`] after the last.
#[cfg(feature = "local-engine")]
#[tauri::command]
pub fn update_hold<R: Runtime>(window: tauri::WebviewWindow<R>, waits: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("the update hold is the main window's".into());
    }
    let app = window.app_handle();
    app.state::<Updater<R>>().hold.set(waits, Instant::now());
    relabel(app);
    Ok(())
}

/// SETTINGS → UPDATES, THE PRESS. Exactly what picking the menu item does, and nothing else.
///
/// It routes through [`pressed`], which is the same function the bar's `on_menu_event` calls, so
/// the pane is a second WAY to one implementation and never a second policy: what a press means
/// in each stage is [`Flow::press`]'s answer for both. In particular there is no "install" verb
/// here — a press in `Ready` restarts into a payload this module already fetched, verified and
/// version-checked, and a press anywhere else cannot install anything at all.
#[cfg(feature = "local-engine")]
#[tauri::command]
pub fn update_press<R: Runtime>(app: AppHandle<R>) {
    pressed(app);
}

/// SETTINGS → UPDATES, THE CHECK NOBODY ASKED FOR — the launch check, on a schedule.
///
/// ── WHY THIS IS NOT `update_press`, WHICH IS THE WHOLE REASON IT EXISTS ────────────────
///
/// A press is a person asking, and this module treats that as the licence to SPEAK: a press
/// that finds nothing says "ohmail is up to date", a press that cannot reach the feed says so
/// with a Try-again button, and a press that finds a release opens the progress window. All
/// three are right for somebody who just pressed a button and would otherwise face dead air.
/// All three are wrong for a check on a timer, and the file's own header says why — *"a window
/// appearing by itself over somebody's mail is the interruption this flow exists to remove"*.
///
/// Routing a daily cadence through `update_press` would therefore put a modal over a person's
/// mail every twenty-four hours for as long as the app stayed open and current, which is the
/// exact nag the cadence was written to replace. The shell cannot tell the two apart from the
/// call alone — `update_press` takes no argument, deliberately — so the difference is a second
/// command rather than a flag the window supplies.
///
/// It is the LAUNCH CHECK's path exactly: `check(app, false)`, the same call [`on_launch`]
/// makes. Silent unless it finds something; when it does, the one dialog is raised by
/// `prompt_ready` as it always was. It names nothing, takes no argument, and can no more start
/// an install than the press can: `may_start_check` refuses in every stage where a payload is
/// waiting.
#[cfg(feature = "local-engine")]
#[tauri::command]
pub fn update_poll<R: Runtime>(app: AppHandle<R>) {
    check(app, false);
}

/// The check nobody asked for — one request, shortly after the window opens.
///
/// An updater a person has to REMEMBER to run is an updater that does not run, which is what this
/// app had: the only trigger was the menu item, so a release could sit unfetched for months. This
/// is the same code path the menu takes with `user_initiated = false`, which is the whole of the
/// difference: it opens no window, and it says nothing at all unless it finds something.
pub fn on_launch<R: Runtime>(app: &AppHandle<R>) {
    check(app.clone(), false);
}

/// The menu item was picked. A restart with a main window asks the window, which saves an open
/// draft and then presses (`src/update-cadence.ts`); everything else is [`pressed`].
fn menu_pressed<R: Runtime>(app: AppHandle<R>) {
    let window_saves = cfg!(feature = "local-engine") && app.get_webview_window("main").is_some();
    let pick = {
        let state = app.state::<Updater<R>>();
        let flow = lock(&state.flow);
        menu_pick(&flow, state.hold.held(Instant::now()), window_saves)
    };
    match pick {
        MenuPick::Press(_) => pressed(app),
        #[cfg(feature = "local-engine")]
        MenuPick::AskWindow => ask_the_window(app),
        #[cfg(not(feature = "local-engine"))]
        MenuPick::AskWindow => pressed(app),
    }
}

/// Ask the window, and restart anyway if it has not pressed within [`RESTART_ASK_BOUND`]: a
/// frozen window never strands the item.
#[cfg(feature = "local-engine")]
fn ask_the_window<R: Runtime>(app: AppHandle<R>) {
    let Some(id) = app.state::<Updater<R>>().ask.ask(Instant::now()) else {
        return;
    };
    let _ = app.emit(RESTART_ASKED_EVENT, ());
    let waiter = app.clone();
    let spawned = std::thread::Builder::new()
        .name("ohmail-restart-ask".into())
        .spawn(move || {
            std::thread::sleep(RESTART_ASK_BOUND);
            if waiter.state::<Updater<R>>().ask.lapse(id) {
                emit(line("updater_restart_ask", &[("answered", "false")]));
                restart_if_ready(waiter);
            }
        });
    if spawned.is_err() {
        app.state::<Updater<R>>().ask.lapse(id);
    }
}

/// A lapsed ask installs only a release still ready and not held. Never a check: that would raise
/// a press's dialogs nobody asked for.
#[cfg(feature = "local-engine")]
fn restart_if_ready<R: Runtime>(app: AppHandle<R>) {
    let what = {
        let state = app.state::<Updater<R>>();
        let flow = lock(&state.flow);
        press_now(&flow, state.hold.held(Instant::now()))
    };
    if what == Press::Restart {
        start_install(app);
    }
}

/// A press: the menu's, the pane's or the window's line. What that means depends on where the flow is.
fn pressed<R: Runtime>(app: AppHandle<R>) {
    // The window's press answers a standing menu ask, so the ask's timer cannot press again.
    app.state::<Updater<R>>().ask.answer();
    let what = {
        let state = app.state::<Updater<R>>();
        let flow = lock(&state.flow);
        press_now(&flow, state.hold.held(Instant::now()))
    };
    match what {
        Press::Check => check(app, true),
        Press::Restart => start_install(app),
        // Disabled in the bar; belt and braces for a platform that lets a disabled item fire.
        Press::Nothing => {}
    }
}

/// OFF THE THREAD THAT DRAWS, for every press that installs: the menu's, the pane's and the
/// dialog's. The engine stops before the installer starts and a retry fetches the payload again,
/// and either wait on the main thread would hold a window that can neither paint nor close. The
/// window stays live during the install, and a quit there waits for it ([`FENCE`]).
fn start_install<R: Runtime>(app: AppHandle<R>) {
    std::thread::Builder::new()
        .name("ohmail-install".into())
        .spawn(move || install_and_restart(&app))
        .expect("ohmail: failed to start the install thread");
}

/// Check the pinned feed and, if there is a newer signed release, fetch it. Runs
/// off the main thread so the menu returns at once.
fn check<R: Runtime>(app: AppHandle<R>, user_initiated: bool) {
    /* AN INSTALL THIS APP CANNOT REPLACE IS NEVER ASKED ABOUT, and this is the only door: the
       launch check, the press, the daily poll and the failure dialog's Try-again all arrive here.
       A `.deb`, an `.rpm` or a Flatpak used to reach the feed, be offered the AppImage for its
       architecture, download it and fail at the install — so the fetch stops before it starts and
       the surfaces say what is true instead (`InstallKind::menu_sentence`, and the `installKind`
       the window reads). Nothing is suppressed on the three kinds that CAN install. */
    if !install_kind().self_applies() {
        // Logged, and logged HERE rather than as a check that found nothing: no feed was asked,
        // so an `updater_check` line naming an endpoint would be a line about a request this
        // build never made.
        log_offer("installKind", None, install_kind());
        return;
    }
    {
        let state = app.state::<Updater<R>>();
        let mut flow = lock(&state.flow);
        if !flow.may_start_check() {
            return;
        }
        flow.apply(Signal::CheckStarted);
        if user_initiated {
            flow.apply(Signal::Pressed { at_unix_ms: now_unix_ms() });
        }
    }
    relabel(&app);
    log_check(&feed_endpoints(&app), env!("CARGO_PKG_VERSION"));
    tauri::async_runtime::spawn(async move { run(app, user_initiated).await });
}

/// The whole flow, in the order a person experiences it.
async fn run<R: Runtime>(app: AppHandle<R>, user_initiated: bool) {
    /* OUR HOOK REPLACES THE PLUGIN'S DEFAULT, Tauri's `cleanup_before_exit`, which on Windows hides
       every window and clears the tray and the resource tables before the installer starts, and
       must be followed by the exit. The plugin returns when the start fails, and an app it had
       cleared would take that answer with nothing left on screen. Ours stops the engine and
       nothing else ([`InstallHook::run`]). The plugin calls it on Windows only. */
    let hook = Arc::new(InstallHook::new(engine_door(&app)));
    let updater = {
        let hook = Arc::clone(&hook);
        match app.updater_builder().on_before_exit(move || hook.run()).build() {
            Ok(updater) => updater,
            Err(_) => return failed(&app, user_initiated),
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return nothing_to_offer(&app, user_initiated),
        Err(_) => return failed(&app, user_initiated),
    };

    // THE DOWNGRADE GUARD. Every reason it is shaped the way it is lives on
    // `should_install`; this is the one call site, and it is the only thing standing
    // between a feed and an install.
    let Some(offered) = should_install(
        &update.current_version,
        &update.version,
        &update.signature,
        EXPECTED_ASSET,
    ) else {
        // A REFUSAL IS NOT ALWAYS "UP TO DATE", and saying so would be a false sentence.
        //
        // Two different facts arrive here. If the signed version agrees with the feed and
        // is simply not newer, "up to date" is exactly true and the flow says it. But if
        // the payload's identity could not be established at all — no signed version, or
        // one that disagrees with what the feed advertised — then an update DOES exist,
        // this client will not install it, and telling the person they are up to date is
        // untrue. It also hides the one shape of this that is our own fault: a release
        // signed without the version stops every client, and "up to date" is precisely the
        // report that makes nobody look.
        return if refusal_is_unverifiable(&update.version, &update.signature, EXPECTED_ASSET) {
            unverifiable_offer(&app, user_initiated)
        } else {
            nothing_to_offer(&app, user_initiated)
        };
    };

    // The SIGNED version is what the rest of the flow reports, not the advertised one.
    // They are equal here by construction — `should_install` refuses otherwise — so this
    // is a statement about which one is authoritative rather than a change of value.
    let version = offered.to_string();
    record(&app, CheckResult::Offered, Some(&version));
    signal(&app, Signal::Offered(version.clone()));

    /* THE PROGRESS WINDOW, and only for a check the user asked for. A tiny, bundled, offline page
       (`updater.html`, emitted from `src/updater-window.ts` by `vite.config.ts`) in its OWN window,
       granted only `core:event:allow-listen` by `capabilities/updater.json`. The download's
       byte-count is pushed to it over `PROGRESS_EVENT`; the main webview is never told an update is
       downloading and its permission list stays empty. A check nobody asked for opens nothing —
       a window appearing by itself over somebody's mail is the interruption this flow exists to
       remove. If the window cannot be built we still download; the bar is a courtesy, not the
       mechanism. */
    let progress = if user_initiated { show_progress_window(&app) } else { None };

    // `download` hands `on_chunk` the size of THIS chunk, not the running total, so we accumulate.
    // `content_len` is the server's Content-Length when it sent one (`None` otherwise, which the
    // page renders as an indeterminate bar). A failed emit is never a reason to abort a download —
    // the window may already be closed.
    let emitter = app.clone();
    let mut downloaded: u64 = 0;
    let fetched = update
        .download(
            move |chunk_len, content_len| {
                downloaded += chunk_len as u64;
                let _ = emitter.emit(
                    PROGRESS_EVENT,
                    serde_json::json!({ "downloaded": downloaded, "total": content_len }),
                );
            },
            || {},
        )
        .await;

    // The progress window has done its job either way; close it before anything else is said.
    if let Some(window) = progress {
        let _ = window.close();
    }

    // `download` returns only bytes that verified against the shipped public key. An error here is
    // a network failure, a refused signature, or a feed pointing at something that is not there —
    // all of them "this did not work", none of them anything installed.
    let bytes = match fetched {
        Ok(bytes) => bytes,
        Err(_) => return failed(&app, user_initiated),
    };

    // With the switch on, an AppImage's release is staged beside it and freed from memory: a
    // quit that never reaches the loop's last event (a reboot, SIGTERM) still finds it at launch.
    // Not a release whose install at quit or launch already failed: that one waits for a press.
    let staging = staging_for(&app);
    let to_stage = staging.as_ref().and_then(|staging| {
        let record = crate::appimage_stage::Record {
            image: staging.image.clone(),
            version: update.version.clone(),
            signature: update.signature.clone(),
        };
        Some((staging.dir.clone()?, record))
    });
    let failed_before = failure(&app).is_some_and(|failed| failure_stands(&failed, env!("CARGO_PKG_VERSION"), Some(&version)));
    let held = match to_stage {
        Some((dir, record)) if policy(&app) == Policy::Auto && !failed_before => {
            tauri::async_runtime::spawn_blocking(move || match crate::appimage_stage::stage(&dir, &record, &bytes) {
                Ok(()) => Held::Staged,
                Err(_) => Held::Memory(bytes),
            })
            .await
            .unwrap_or(Held::Nothing)
        }
        _ => Held::Memory(bytes),
    };

    {
        let state = app.state::<Updater<R>>();
        *lock(&state.pending) = Some(Waiting::holding(Plugin(update, staging), held, hook));
    }
    signal(&app, Signal::Downloaded);
    prompt_ready(&app, &version);
}

/// What an AppImage's install needs beside the release, or `None` on every other kind.
fn staging_for<R: Runtime>(app: &AppHandle<R>) -> Option<Staging> {
    if install_kind() != InstallKind::AppImage {
        return None;
    }
    Some(Staging {
        image: crate::appimage_stage::running_image()?,
        dir: data_dir(app),
        pubkey: shipped_pubkey(app),
    })
}

/// The app's data folder: the policy file and the staged release's record.
fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

/// The public key every payload is verified against, read from the config the plugin reads.
fn shipped_pubkey<R: Runtime>(app: &AppHandle<R>) -> String {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .unwrap_or_default()
        .to_string()
}

/// The switch now. The preview always asks first; the engine build reads Settings' file once.
fn policy<R: Runtime>(app: &AppHandle<R>) -> Policy {
    if !cfg!(feature = "local-engine") {
        return Policy::Ask;
    }
    let state = app.state::<Updater<R>>();
    let mut kept = lock(&state.policy);
    *kept.get_or_insert_with(|| {
        data_dir(app).map_or(Policy::Ask, |dir| Policy::read(&crate::appimage_stage::read_policy(&dir)))
    })
}

/// Can the install replace this copy without a password prompt? The AppImage's folder, and the
/// macOS app with its folder, must be writable: the plugin's macOS install asks for a password on
/// the thread that draws, which at quit never answers.
fn replaceable_without_a_prompt(kind: InstallKind) -> bool {
    use crate::appimage_stage::writable;
    match kind {
        InstallKind::AppImage => crate::appimage_stage::running_image()
            .is_some_and(|image| image.parent().is_some_and(writable)),
        InstallKind::MacBundle => std::env::current_exe()
            .ok()
            .and_then(|exe| tauri_plugin_updater::extract_path_from_executable(&exe).ok())
            .is_some_and(|app| writable(&app) && app.parent().is_some_and(writable)),
        InstallKind::WindowsSetup => true,
        _ => false,
    }
}

/// Is Windows ending the session? Then the loop's last event is a shutdown, and no installer starts.
#[cfg(windows)]
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
fn session_ending() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};
    unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
}

#[cfg(not(windows))]
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
fn session_ending() -> bool {
    false
}

/// What the window is told beside the flow, read now. The payload is asked with `try_lock`: an
/// install or a fetch holding it is under way, and a quit would then install nothing more.
fn standing<R: Runtime>(app: &AppHandle<R>, flow: &Flow) -> Standing {
    let state = app.state::<Updater<R>>();
    let kind = install_kind();
    let auto = policy(app) == Policy::Auto;
    let held = state.hold.held(Instant::now());
    let payload = match state.pending.try_lock() {
        Ok(slot) => slot.as_ref().is_some_and(Waiting::holds_bytes),
        Err(std::sync::TryLockError::Poisoned(slot)) => slot.into_inner().as_ref().is_some_and(Waiting::holds_bytes),
        Err(std::sync::TryLockError::WouldBlock) => false,
    };
    let replaceable = replaceable_without_a_prompt(kind);
    let facts = QuitFacts {
        ready: flow.press() == Press::Restart,
        payload,
        auto,
        send_waits: held,
        self_applies: kind.self_applies(),
        replaceable,
        ..QuitFacts::default()
    };
    let failed = failure(app).filter(|failed| failure_stands(failed, env!("CARGO_PKG_VERSION"), flow.offered()));
    standing_of(auto, facts, failed.as_ref(), auto_at(kind, replaceable, data_dir(app).is_some()))
}

/// The install at quit or launch that failed, as the data folder keeps it. Read each time, so a
/// launch's own failure is seen; one for a release no newer than this one went in after all.
fn failure<R: Runtime>(app: &AppHandle<R>) -> Option<crate::appimage_stage::Failure> {
    let dir = data_dir(app)?;
    let failed = crate::appimage_stage::read_failure(&dir)?;
    if failure_stands(&failed, env!("CARGO_PKG_VERSION"), None) {
        return Some(failed);
    }
    crate::appimage_stage::forget_failure(&dir);
    None
}

/// What the install at quit came to.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub(crate) enum AtQuit<E> {
    Skipped(Skip),
    Installed,
    Failed(E),
}

/// THE INSTALL AT THE APP'S OWN QUIT, everything but the facts the app reads. It never goes
/// through the fence (the loop's last event closed it before this runs), never fetches, never
/// resumes the engine and never moves the flow: the app is going. The latch stays taken once it
/// installs.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub(crate) fn at_quit<P: Payload>(
    latch: &AtomicBool,
    waiting: &Mutex<Option<Waiting<P>>>,
    facts: QuitFacts,
) -> AtQuit<P::Error> {
    if latch.swap(true, Ordering::SeqCst) {
        return AtQuit::Skipped(Skip::Busy);
    }
    let mut slot = lock(waiting);
    let payload = slot.as_ref().is_some_and(Waiting::holds_bytes);
    if let QuitInstall::Skip(skip) = quit_install(QuitFacts { payload, busy: false, ..facts }) {
        latch.store(false, Ordering::SeqCst);
        return AtQuit::Skipped(skip);
    }
    let Some(waiting) = slot.as_mut() else { return AtQuit::Skipped(Skip::NoPayload) };
    let bytes = match std::mem::replace(&mut waiting.held, Held::Nothing) {
        Held::Memory(bytes) => bytes,
        Held::Staged => match waiting.payload.read_staged() {
            Ok(bytes) => bytes,
            Err(err) => return AtQuit::Failed(err),
        },
        Held::Nothing => return AtQuit::Skipped(Skip::NoPayload),
    };
    waiting.hook.arm();
    match waiting.payload.install_on_quit(&bytes, facts.restarting) {
        Ok(()) => AtQuit::Installed,
        Err(err) => AtQuit::Failed(err),
    }
}

/// A READY RELEASE GOES IN AS THE APP QUITS, called from the loop's last event after the engine was
/// told to leave: on Windows the hook's stop then waits for that quit's stop instead of replacing it.
#[cfg(feature = "local-engine")]
pub fn install_on_quit<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<Updater<R>>() else { return };
    let kind = install_kind();
    let (facts, version) = {
        let flow = lock(&state.flow);
        let offered = flow.offered();
        let failed_before = failure(app).is_some_and(|failed| failure_stands(&failed, env!("CARGO_PKG_VERSION"), offered));
        let facts = QuitFacts {
            ready: flow.press() == Press::Restart,
            auto: policy(app) == Policy::Auto,
            failed_before,
            send_waits: state.hold.held(Instant::now()),
            self_applies: kind.self_applies(),
            replaceable: replaceable_without_a_prompt(kind),
            session_ending: session_ending(),
            restarting: FENCE.restarts(),
            ..QuitFacts::default()
        };
        (facts, offered.map(str::to_string))
    };
    let outcome = at_quit(&INSTALLING, &state.pending, facts);
    match &outcome {
        // Busy: a press's install holds the latch into its own restart, and said so.
        AtQuit::Skipped(Skip::NotReady | Skip::CannotSelfApply | Skip::Busy) => {}
        AtQuit::Skipped(skip) => log_verdict_with(Verdict::Skipped, None, &[("reason", skip.as_str()), ("at", "quit")]),
        AtQuit::Installed => log_verdict_with(Verdict::Installed, None, &[("at", "quit")]),
        AtQuit::Failed(err) => {
            log_verdict_with(Verdict::Failed, Some(error_class(&format!("{err:?}"))), &[("at", "quit")])
        }
    }
    if let (Some(dir), Some(version)) = (data_dir(app), version) {
        keep_quit_outcome(&dir, &version, &outcome, now_unix_ms());
    }
}

/// What the next launch is told of the install at quit: a failure is kept for its release (the line
/// says so, and no quit tries that release by itself again); an install forgets one.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub(crate) fn keep_quit_outcome<E: std::fmt::Debug>(dir: &Path, version: &str, outcome: &AtQuit<E>, at_unix_ms: u64) {
    match outcome {
        AtQuit::Failed(err) => {
            let failure = crate::appimage_stage::Failure {
                version: version.to_string(),
                error_class: error_class(&format!("{err:?}")).to_string(),
                at: "quit".into(),
                at_unix_ms,
            };
            let _ = crate::appimage_stage::write_failure(dir, &failure);
        }
        AtQuit::Installed => crate::appimage_stage::forget_failure(dir),
        AtQuit::Skipped(_) => {}
    }
}

/// A STAGED RELEASE A QUIT NEVER REACHED goes in at the next launch, before the engine and the
/// window start, and the app restarts into it with its launch arguments.
#[cfg(feature = "local-engine")]
pub fn apply_staged_at_launch(app: &tauri::App) {
    if install_kind() != InstallKind::AppImage {
        return;
    }
    let app = app.handle();
    let (Some(dir), Some(image)) = (data_dir(app), crate::appimage_stage::running_image()) else { return };
    let pubkey = shipped_pubkey(app);
    let launch = Launch {
        dir: &dir,
        image: &image,
        running: env!("CARGO_PKG_VERSION"),
        pubkey: &pubkey,
        policy: policy(app),
        expected_asset: EXPECTED_ASSET,
    };
    match launch_apply(&launch) {
        AtLaunch::Nothing => {}
        AtLaunch::Refused(reason) => log_verdict_with(Verdict::Refused, None, &[("reason", reason), ("at", "launch")]),
        AtLaunch::Applied(_) => {
            // No loop has run to let go of the single-instance name; the new copy needs it free.
            tauri_plugin_single_instance::destroy(app);
            restart_into_the_new_copy(app, "launch");
        }
    }
}

/// What a launch knows about a staged release.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub(crate) struct Launch<'a> {
    pub(crate) dir: &'a Path,
    pub(crate) image: &'a Path,
    pub(crate) running: &'a str,
    pub(crate) pubkey: &'a str,
    pub(crate) policy: Policy,
    pub(crate) expected_asset: &'a str,
}

#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AtLaunch {
    Nothing,
    Applied(semver::Version),
    Refused(&'static str),
}

/// THE LAUNCH'S DECISION AND ITS ONE RENAME. Applied only for this image, with the switch on, and
/// for a release that verifies again and is newer than the one running; anything else is refused,
/// the image untouched, and the staged release and its record discarded so no launch retries it.
/// A release that should have gone in and could not (gone, or not renamed) is kept as a failure,
/// for the line to say.
#[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
pub(crate) fn launch_apply(launch: &Launch<'_>) -> AtLaunch {
    let Some(record) = crate::appimage_stage::read_record(launch.dir) else { return AtLaunch::Nothing };
    let refuse = |reason| {
        crate::appimage_stage::discard(launch.dir, launch.image);
        AtLaunch::Refused(reason)
    };
    let failed = |reason, err: std::io::Error| {
        let failure = crate::appimage_stage::Failure {
            version: record.version.clone(),
            error_class: format!("{:?}", err.kind()),
            at: "launch".into(),
            at_unix_ms: now_unix_ms(),
        };
        let _ = crate::appimage_stage::write_failure(launch.dir, &failure);
        refuse(reason)
    };
    if launch.policy != Policy::Auto {
        return refuse("askFirst");
    }
    if record.image != launch.image {
        return refuse("otherImage");
    }
    let bytes = match crate::appimage_stage::read_staged(launch.image) {
        Ok(bytes) => bytes,
        Err(err) => return failed("missing", err),
    };
    let verified = verify_staged(
        &bytes,
        &record.signature,
        launch.pubkey,
        launch.running,
        &record.version,
        launch.expected_asset,
    );
    drop(bytes);
    let Some(version) = verified else { return refuse("unverified") };
    match crate::appimage_stage::apply(launch.image) {
        Ok(()) => {
            crate::appimage_stage::forget_record(launch.dir);
            crate::appimage_stage::forget_failure(launch.dir);
            AtLaunch::Applied(version)
        }
        Err(err) => failed("notApplied", err),
    }
}

/// A STAGED RELEASE, VERIFIED AGAIN before any use: the minisign signature over the bytes with the
/// shipped key, as the plugin's `download` checks it, then [`should_install`] — the signed version
/// and asset, newer than the version RUNNING.
pub fn verify_staged(
    bytes: &[u8],
    signature_b64: &str,
    pubkey_b64: &str,
    running: &str,
    advertised: &str,
    expected_asset: &str,
) -> Option<semver::Version> {
    use base64::Engine as _;
    let text = |b64: &str| {
        let raw = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
        String::from_utf8(raw).ok()
    };
    let key = minisign_verify::PublicKey::decode(&text(pubkey_b64)?).ok()?;
    let signature = minisign_verify::Signature::decode(&text(signature_b64)?).ok()?;
    key.verify(bytes, &signature, true).ok()?;
    should_install(running, advertised, signature_b64, expected_asset)
}

/// Is a ready payload asked about in a native dialog? Only in the preview, whose window holds no
/// update command. The engine build's window asks in place (`src/update-cadence.ts`, the strip):
/// a native dialog has no parent on Linux, so it opens on whatever workspace is in front.
pub fn asks_natively() -> bool {
    !cfg!(feature = "local-engine")
}

/// The ONE dialog in the whole flow, asked once, at the point it is worth asking.
///
/// Non-blocking (`show`, not `blocking_show`): the app stays usable behind it, and the answer
/// arrives on a callback rather than by parking a thread. "Later" spends the question and nothing
/// else — the payload stays ready and the menu item says so — so the app can never ask twice.
fn prompt_ready<R: Runtime>(app: &AppHandle<R>, version: &str) {
    if !asks_natively() {
        return;
    }
    {
        let state = app.state::<Updater<R>>();
        if !lock(&state.flow).should_prompt() {
            return;
        }
    }
    let deferrer = app.clone();
    app.dialog()
        .message(format!(
            "ohmail {version} is ready to install. ohmail will restart to finish."
        ))
        .title("Update ready")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Restart now".into(),
            "Later".into(),
        ))
        .show(move |now| {
            if now {
                start_install(deferrer.clone());
            } else {
                log_verdict(Verdict::Deferred, None);
                signal(&deferrer, Signal::Deferred);
            }
        });
}

/// Apply the waiting payload and relaunch into it. The only place anything is installed; what the
/// press did is [`attempt`]'s, and this is the app's answer to it.
///
/// WINDOWS' INSTALL IS ITS RESTART: the plugin starts the installer and exits this process, and
/// the installer replaces the runtime the engine runs on, so [`InstallHook`] stops the engine
/// before the start. When the start fails the plugin returns, the engine comes back, and the
/// release is offered again. Elsewhere the install returns, and the engine leaves before the new
/// copy starts — [`after_the_engine`].
fn install_and_restart<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<Updater<R>>();
    match attempt(&INSTALLING, &FENCE, &state.pending, |told| signal(app, told)) {
        // Another install in flight, nothing waiting, or an exit that closed the fence first.
        Attempt::Busy | Attempt::Nothing | Attempt::Closed => {}
        Attempt::Installed => restart_into_the_new_copy(app, "press"),
        // The failures that always speak, whoever started the check: the user pressed a button
        // that promised a restart, and nothing at all happening is the worst answer.
        Attempt::FetchFailed(err) => {
            log_verdict(Verdict::Failed, Some(error_class(&format!("{err:?}"))));
            signal(app, Signal::Failed);
            say_it_failed(app, "ohmail could not fetch the update. Check your connection and try again.");
        }
        Attempt::NotPrepared(err) => {
            log_verdict(Verdict::Failed, Some(error_class(&format!("{err:?}"))));
            signal(app, Signal::Failed);
            say_it_failed(app, "ohmail could not install the update. Try again in a moment.");
        }
        // The installer did not start. The person closed the app meanwhile: it goes, silently.
        // Otherwise the release stays on offer and the window says so in its own language.
        Attempt::NotStarted(err, resumed) => {
            log_verdict(Verdict::NotStarted, Some(error_class(&format!("{err:?}"))));
            if resumed == Resumed::AppGoing {
                return quit(app, 0);
            }
            crate::unclean_exit::rearm();
            signal(app, Signal::InstallerDidNotStart { at_unix_ms: now_unix_ms() });
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
        }
    }
}

/// EVERY RESTART INTO AN INSTALLED RELEASE, the press's and the launch's: once no install writes
/// and the engine has left (at launch none has started), with none of this launch's descriptors.
fn restart_into_the_new_copy<R: Runtime>(app: &AppHandle<R>, at: &str) {
    after_the_engine(app, || {
        // Before the restart, and it survives it: the log flushes per write, so the last
        // line of the old build's log is the one saying why there is a new one.
        log_verdict_with(Verdict::Installed, None, &[("at", at)]);
        // The new image starts without the old one's keep-alive, so the old mount goes when
        // this process does rather than when the new one quits.
        crate::inherited_fds::withhold_from_the_restart();
        // On the main thread the restart skips the loop's Exit.
        crate::unclean_exit::clear();
        app.restart();
    })
}

/// What one press of Restart came to.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Attempt<E> {
    /// Another install is in flight: this press changed nothing.
    Busy,
    /// Nothing was waiting to install.
    Nothing,
    /// An exit closed the fence first: nothing was run.
    Closed,
    /// The retry's fetch or its signature check failed; nothing was installed.
    FetchFailed(E),
    /// The installer replaced the app (macOS, Linux); the restart is the caller's.
    Installed,
    /// Preparing the installer failed before the hook ran; the engine was never stopped.
    NotPrepared(E),
    /// The hook stopped the engine and the installer did not start: the engine's resume ran once,
    /// and the bytes are gone, so the next press fetches and verifies them again.
    NotStarted(E, Resumed),
}

/// ONE PRESS OF RESTART, everything but the app's answer to it.
///
/// THE LATCH FIRST: a press while another is in flight (in the hook's stop, or in a retry's
/// fetch) changes nothing. The bytes are TAKEN, so no failure can leave them to be installed again
/// unverified: a retry fetches through the plugin's `download`, which verifies the signature before
/// it returns a byte. The install runs inside the fence, and `tell` folds the retry's own fetch
/// into the flow. Generic so the tests drive it with a stub payload and a real engine.
pub(crate) fn attempt<P: Payload>(
    latch: &AtomicBool,
    fence: &InstallFence,
    waiting: &Mutex<Option<Waiting<P>>>,
    tell: impl FnMut(Signal),
) -> Attempt<P::Error> {
    if latch.swap(true, Ordering::SeqCst) {
        return Attempt::Busy;
    }
    let outcome = attempt_held(fence, waiting, tell);
    // Held on past an install that returned: its restart is under way, and nothing may begin.
    if !matches!(outcome, Attempt::Installed) {
        latch.store(false, Ordering::SeqCst);
    }
    outcome
}

fn attempt_held<P: Payload>(
    fence: &InstallFence,
    waiting: &Mutex<Option<Waiting<P>>>,
    mut tell: impl FnMut(Signal),
) -> Attempt<P::Error> {
    let mut slot = lock(waiting);
    // Nothing waiting: a press that raced the payload being dropped. Silent by design.
    let Some(waiting) = slot.as_mut() else { return Attempt::Nothing };
    // A staged release is read back and verified again; one gone or no longer verifying is
    // fetched again like bytes an installer that did not start took.
    let kept = match std::mem::replace(&mut waiting.held, Held::Nothing) {
        Held::Memory(bytes) => Some(bytes),
        Held::Staged => waiting.payload.read_staged().ok(),
        Held::Nothing => None,
    };
    let bytes = match kept {
        Some(bytes) => bytes,
        None => {
            tell(Signal::Refetching);
            match waiting.payload.fetch() {
                Ok(bytes) => {
                    tell(Signal::Downloaded);
                    bytes
                }
                Err(err) => return Attempt::FetchFailed(err),
            }
        }
    };
    waiting.hook.arm();
    let Some(installed) = fenced(fence, || waiting.payload.install(&bytes)) else {
        // Nothing ran: these are still the verified bytes, kept for a press after the exit.
        waiting.held = Held::Memory(bytes);
        return Attempt::Closed;
    };
    match installed {
        Ok(()) => Attempt::Installed,
        // The hook ran, so the engine was stopped for an installer that did not start.
        Err(err) if waiting.hook.ran() => Attempt::NotStarted(err, waiting.hook.door.resume()),
        Err(err) => Attempt::NotPrepared(err),
    }
}

/// THE ENGINE'S TWO ACTS AN INSTALL NEEDS: stopping for the installer, and coming back when the
/// installer did not start. The shell's own in the engine build ([`ShellDoor`]); nothing to stop
/// in the preview.
pub(crate) trait EngineDoor: Send + Sync {
    /// Stop the engine and wait for it, bounded. `false` when the bound ran out first.
    fn stop(&self) -> bool;
    /// The installer did not start: start the engine again, once its stop has completed.
    fn resume(&self) -> Resumed;
}

/// What a resume came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Resumed {
    /// The engine runs again, or there was none to stop.
    Running,
    /// The person closed the app meanwhile: nothing was started, and the app goes.
    AppGoing,
    /// The stop never completed inside its bound: nothing was started beside the engine.
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    StillLeaving,
}

/// WHAT THE PLUGIN RUNS BETWEEN PREPARING THE WINDOWS INSTALLER AND STARTING IT: the engine
/// stopped and waited for, and nothing else. It hides no window and clears no tray, so a start that
/// fails returns to an app that is still there. It records that it ran, which is how the caller
/// tells an installer that did not start (the engine stopped) from one never prepared (untouched).
pub(crate) struct InstallHook {
    door: Arc<dyn EngineDoor>,
    ran: AtomicBool,
}

impl InstallHook {
    pub(crate) fn new(door: Arc<dyn EngineDoor>) -> Self {
        InstallHook { door, ran: AtomicBool::new(false) }
    }

    /// The hook itself. Recorded first: once the stop has begun, a failed start owes the resume.
    pub(crate) fn run(&self) {
        self.ran.store(true, Ordering::SeqCst);
        let left = self.door.stop();
        emit(line("updater_hook", &[("engineLeft", if left { "true" } else { "false" })]));
        // The installer ends the process with no Exit event.
        crate::unclean_exit::clear();
    }

    fn arm(&self) {
        self.ran.store(false, Ordering::SeqCst);
    }

    fn ran(&self) -> bool {
        self.ran.load(Ordering::SeqCst)
    }
}

/// The door the hook stops: the shell's engine where this build has one, nothing otherwise.
fn engine_door<R: Runtime>(app: &AppHandle<R>) -> Arc<dyn EngineDoor> {
    #[cfg(feature = "local-engine")]
    if let Some(shell) = app.try_state::<Arc<crate::engine::Shell>>() {
        return Arc::new(ShellDoor(Arc::clone(shell.inner())));
    }
    let _ = app;
    Arc::new(NoEngine)
}

/// The preview's door: no engine to stop, none to start again.
struct NoEngine;

impl EngineDoor for NoEngine {
    fn stop(&self) -> bool {
        true
    }
    fn resume(&self) -> Resumed {
        Resumed::Running
    }
}

/// The engine build's door: the restart's own stop, and a resume that waits for it to complete.
#[cfg(feature = "local-engine")]
pub(crate) struct ShellDoor(pub(crate) Arc<crate::engine::Shell>);

#[cfg(feature = "local-engine")]
impl EngineDoor for ShellDoor {
    fn stop(&self) -> bool {
        self.0.stop_for_restart()
    }

    fn resume(&self) -> Resumed {
        use crate::engine::Resume;
        match self.0.resume_after_failed_restart(crate::engine::SHUTDOWN_BOUND) {
            Resume::Resumed | Resume::NothingStopped => Resumed::Running,
            Resume::Quitting => Resumed::AppGoing,
            Resume::StillLeaving => Resumed::StillLeaving,
        }
    }
}

/// Run `install` inside the fence, so no exit passes while it writes; `None`, and nothing run,
/// once an exit has closed it.
fn fenced<T>(fence: &InstallFence, install: impl FnOnce() -> T) -> Option<T> {
    let _writing = fence.begin_install()?;
    Some(install())
}

/// An install is in flight. See [`install_and_restart`].
static INSTALLING: AtomicBool = AtomicBool::new(false);

// ── THE INSTALL FENCE ────────────────────────────────────────────────────────────────────────
//
// THE PROCESS NEVER EXITS WHILE AN INSTALL IS WRITING THE INSTALLED APP. The AppImage install
// renames the running image away, writes the new one in its place and sets the execute bit last,
// so an exit in between left a truncated file that would not start (measured: an exit 150 ms in
// left 32 of 126 MiB at mode 664). Every exit the app asks for passes this fence — the close,
// [`quit`], every restart ([`after_the_engine`]) — and one it did not ask for is held at
// `ExitRequested` ([`on_exit_requested`]). A quit that meets a writing install waits for it off the
// thread that draws, with the window saying so; the loop's last event closes the fence ([`at_exit`]).

/// How long a quit waits for an install. The measured write is 0.6-1.3 s; an install still writing
/// past this is stuck, and the quit goes anyway after saying so once (`install_outlived_quit_bound`).
pub const QUIT_WAITS_FOR_INSTALL: Duration = Duration::from_secs(60);

/// Whether an install is writing, and what the exits waiting on it share.
pub struct InstallFence {
    state: Mutex<Fence>,
    returned: Condvar,
    bound: Duration,
    outlived: fn(Duration),
}

struct Fence {
    /// Installs between their first write to the installed app and their last.
    writing: u32,
    /// A quit is waiting on the install, and the window says so.
    quit_waits: bool,
    /// When every wait stops, set by the first: a second quit adds no second bound.
    gives_up_at: Option<Instant>,
    /// `outlived` has been called for this install: once, however many quits waited.
    said: bool,
    /// The process is going, and no install may start.
    closed: bool,
    /// A restart asked for the exit.
    restarts: bool,
}

/// An install writing. Dropped when the install returns, and every waiting exit goes on.
pub struct InstallHold<'a>(&'a InstallFence);

impl InstallFence {
    pub const fn new(bound: Duration, outlived: fn(Duration)) -> Self {
        Self {
            state: Mutex::new(Fence {
                writing: 0,
                quit_waits: false,
                gives_up_at: None,
                said: false,
                closed: false,
                restarts: false,
            }),
            returned: Condvar::new(),
            bound,
            outlived,
        }
    }

    /// An install starts writing. `None` once the process is going.
    pub fn begin_install(&self) -> Option<InstallHold<'_>> {
        let mut fence = lock(&self.state);
        if fence.closed {
            return None;
        }
        fence.writing += 1;
        Some(InstallHold(self))
    }

    /// Must an exit asked for now wait? An install is writing and the bound has not run out.
    pub fn must_wait(&self) -> bool {
        let fence = lock(&self.state);
        fence.writing > 0 && fence.gives_up_at.map_or(true, |at| Instant::now() < at)
    }

    /// A quit is waiting on an install still writing: the `closing` the window is told.
    pub fn quit_waits(&self) -> bool {
        let fence = lock(&self.state);
        fence.quit_waits && fence.writing > 0
    }

    /// A quit is about to wait: what [`InstallFence::quit_waits`] reads, while the install writes.
    pub fn quit_asked(&self) {
        let mut fence = lock(&self.state);
        if fence.writing > 0 {
            fence.quit_waits = true;
        }
    }

    /// Does the app start again after this exit? Tauri's own flag is not readable, and never resets.
    #[cfg_attr(not(feature = "local-engine"), allow(dead_code))]
    pub fn restarts(&self) -> bool {
        lock(&self.state).restarts
    }

    /// Wait for the install to return, never past the bound. `false` when the bound ran out.
    pub fn wait(&self) -> bool {
        self.wait_in(lock(&self.state)).1
    }

    /// The last wait before the process goes: [`InstallFence::wait`], and then no install starts.
    pub fn close_for_exit(&self) -> bool {
        let (mut fence, returned) = self.wait_in(lock(&self.state));
        fence.closed = true;
        returned
    }

    fn wait_in<'a>(&'a self, mut fence: MutexGuard<'a, Fence>) -> (MutexGuard<'a, Fence>, bool) {
        if fence.writing == 0 {
            return (fence, true);
        }
        let gives_up_at = *fence.gives_up_at.get_or_insert_with(|| Instant::now() + self.bound);
        loop {
            if fence.writing == 0 {
                return (fence, true);
            }
            let now = Instant::now();
            if now >= gives_up_at {
                if !fence.said {
                    fence.said = true;
                    (self.outlived)(self.bound);
                }
                return (fence, false);
            }
            fence = match self.returned.wait_timeout(fence, gives_up_at - now) {
                Ok((fence, _)) => fence,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }
}

impl Drop for InstallHold<'_> {
    fn drop(&mut self) {
        let mut fence = lock(&self.0.state);
        fence.writing = fence.writing.saturating_sub(1);
        if fence.writing == 0 {
            fence.quit_waits = false;
            fence.gives_up_at = None;
            fence.said = false;
        }
        self.0.returned.notify_all();
    }
}

/// The app's fence, read by every exit it asks for.
pub static FENCE: InstallFence = InstallFence::new(QUIT_WAITS_FOR_INSTALL, outlived_the_bound);

/// A quit waited the whole bound for an install still writing, and goes now.
fn outlived_the_bound(bound: Duration) {
    let ms = bound.as_millis().to_string();
    emit(line("install_outlived_quit_bound", &[("boundMs", &ms)]));
}

/// EVERY QUIT THE APP ASKS FOR ITSELF — the tray's, the relaunch card's, a close's last step. While
/// an install writes, the window says so and the exit follows the install on a thread of its own,
/// so nothing waits on the thread that draws.
pub fn quit<R: Runtime>(app: &AppHandle<R>, code: i32) {
    let leaving = app.clone();
    quit_with(&FENCE, || say_a_quit_waits(app), move || leaving.exit(code));
}

/// [`quit`] with its two acts handed in: `waiting` tells the window, `exit` ends the app.
pub(crate) fn quit_with(
    fence: &'static InstallFence,
    waiting: impl FnOnce(),
    exit: impl FnOnce() + Send + 'static,
) {
    if !fence.must_wait() {
        return exit();
    }
    fence.quit_asked();
    waiting();
    std::thread::Builder::new()
        .name("ohmail-quitwait".into())
        .spawn(move || {
            fence.wait();
            exit();
        })
        .expect("ohmail: failed to start the quit thread");
}

/// AN EXIT THE APP DID NOT ASK FOR — its last window gone, the system's Quit — is held while an
/// install writes and asked again by [`quit`]. A restart cannot be held here (Tauri ignores the
/// prevent for its code), which is why every restart waits before it asks ([`after_the_engine`]).
pub fn on_exit_requested<R: Runtime>(app: &AppHandle<R>, code: Option<i32>, api: &tauri::ExitRequestApi) {
    hold_the_exit(&FENCE, code, api, |code| quit(app, code));
}

/// The one act `ExitRequested` lets its handler take on the exit, so a test can hand in its own.
pub(crate) trait PreventsExit {
    fn prevent_exit(&self);
}

impl PreventsExit for tauri::ExitRequestApi {
    fn prevent_exit(&self) {
        tauri::ExitRequestApi::prevent_exit(self);
    }
}

/// [`on_exit_requested`] with its fence and its quit handed in: an exit held for an install is
/// prevented and asked again by the quit, which waits for the install. A restart's is noted.
pub(crate) fn hold_the_exit(fence: &InstallFence, code: Option<i32>, api: &impl PreventsExit, quit: impl FnOnce(i32)) {
    if code == Some(tauri::RESTART_EXIT_CODE) {
        lock(&fence.state).restarts = true;
    }
    if holds_the_exit(fence, code) {
        api.prevent_exit();
        quit(code.unwrap_or(0));
    }
}

/// Is this exit request held for an install?
pub(crate) fn holds_the_exit(fence: &InstallFence, code: Option<i32>) -> bool {
    code != Some(tauri::RESTART_EXIT_CODE) && fence.must_wait()
}

/// The loop's last event: wait for an install still writing, then let none start.
pub fn at_exit() {
    exit_fence().close_for_exit();
}

/// The fence [`at_exit`] closes: the app's, or in a test a fence of the test's own, so the backstop
/// is driven as it runs rather than as a copy of its one line.
fn exit_fence() -> &'static InstallFence {
    #[cfg(test)]
    {
        if let Some(fence) = TEST_EXIT_FENCE.with(std::cell::Cell::get) {
            return fence;
        }
    }
    &FENCE
}

#[cfg(test)]
thread_local! {
    /// The fence [`at_exit`] closes on this thread, set by a test; `None` is the app's.
    pub(crate) static TEST_EXIT_FENCE: std::cell::Cell<Option<&'static InstallFence>> = const { std::cell::Cell::new(None) };
}

/// The window, told that a quit waits for the install: shown again if it was hidden, and sent the
/// report with `closing` set ([`told`]). NOT [`relabel`]: a quit moves no stage, so the menu item
/// has nothing new to say, and the window's report is the one surface that changes.
pub(crate) fn say_a_quit_waits<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
    }
    let report = {
        let state = app.state::<Updater<R>>();
        let flow = lock(&state.flow);
        let last = *lock(&state.last);
        told(&flow, last, install_kind(), standing(app, &flow))
    };
    let _ = app.emit(STATE_EVENT, report);
}

/// EVERY RESTART RUNS `then` THROUGH HERE, once no install is writing and the engine has left —
/// stopped, waited for, and killed past its grace. Tauri's restart starts the new copy and exits,
/// so without this the new engine met a lock a leaving one still held, or ran beside one that would
/// not leave, and a restart during an install cut the new image short. The update and the
/// renderer's relaunch both come here. The preview has no engine and waits for the install alone.
pub(crate) fn after_the_engine<R: Runtime, T>(app: &AppHandle<R>, then: impl FnOnce() -> T) -> T {
    #[cfg(feature = "local-engine")]
    {
        crate::engine::after_the_engine(app, &FENCE, then)
    }
    #[cfg(not(feature = "local-engine"))]
    {
        let _ = app;
        after_install(&FENCE, then)
    }
}

/// A restart's first wait: for an install still writing, bounded; then `then`.
pub(crate) fn after_install<T>(fence: &InstallFence, then: impl FnOnce() -> T) -> T {
    fence.wait();
    then()
}

/// Was the refusal about the payload's IDENTITY rather than about its age?
///
/// `should_install` refuses for four reasons and only one of them means "there is nothing
/// newer". This separates them, so the sentence the person reads is true: an unparseable
/// version, a payload with no signed version, or a signed version or asset that disagrees
/// with what the feed advertised all mean *an update exists and this client will not install
/// it*. Not newer means what it says.
///
/// Pure, and driven directly by `a_refusal_about_identity_is_not_reported_as_up_to_date` —
/// the distinction is the whole of the difference between two user-facing sentences, and one
/// of them would be a lie in the other's case.
pub fn refusal_is_unverifiable(advertised: &str, signature_b64: &str, expected_asset: &str) -> bool {
    match (semver::Version::parse(advertised), signed_release(signature_b64)) {
        (Ok(advertised), Some(signed)) => {
            advertised != signed.version || signed.asset != expected_asset
        }
        // An unparseable advertised version, or nothing signed to compare it against.
        _ => true,
    }
}

/// An update was offered and this client will not install it.
///
/// One sentence, and it does NOT offer to try again: retrying reaches the same feed and gets
/// the same answer, so a "Try again" button here would be a button that cannot work. Silent
/// unless the user asked, like every other outcome in this flow.
fn unverifiable_offer<R: Runtime>(app: &AppHandle<R>, user_initiated: bool) {
    record(app, CheckResult::Refused, None);
    signal(app, Signal::NothingOffered);
    if user_initiated {
        app.dialog()
            .message(
                "ohmail could not confirm which version the available update is, so nothing \
                 was installed. The version you have is unchanged.",
            )
            .title("Update not installed")
            .show(|_| {});
    }
}

/// The feed answered and there is nothing to install.
fn nothing_to_offer<R: Runtime>(app: &AppHandle<R>, user_initiated: bool) {
    record(app, CheckResult::UpToDate, None);
    signal(app, Signal::NothingOffered);
    if user_initiated {
        // One button, and it is not a dead end: it is the answer to a question the user asked.
        app.dialog()
            .message("ohmail is up to date.")
            .title("No updates")
            .show(|_| {});
    }
}

/// Something did not work. Silent unless the user asked for the check.
fn failed<R: Runtime>(app: &AppHandle<R>, user_initiated: bool) {
    record(app, CheckResult::Failed, None);
    signal(app, Signal::Failed);
    if user_initiated {
        say_it_failed(
            app,
            "ohmail could not fetch the update. Check your connection and try again.",
        );
    }
}

/// One plain sentence, and a way out of it that is not "OK".
///
/// Deliberately carries no library error text: "error sending request for url (…): dns error" is a
/// developer's sentence in a user's dialog, and it makes the box longer without making it more
/// actionable. What a person can do about any of these is try again, so that is the button.
fn say_it_failed<R: Runtime>(app: &AppHandle<R>, sentence: &str) {
    let retry = app.clone();
    app.dialog()
        .message(sentence)
        .title("ohmail update")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Try again".into(),
            "Close".into(),
        ))
        .show(move |again| {
            if again {
                check(retry, true);
            }
        });
}

/// Fold a signal into the flow and let the menu item say what changed.
///
/// Every transition goes through here, so there is exactly one place that can leave the bar
/// disagreeing with the state — and it cannot, because it does both.
fn signal<R: Runtime>(app: &AppHandle<R>, signal: Signal) {
    {
        let state = app.state::<Updater<R>>();
        lock(&state.flow).apply(signal);
    }
    relabel(app);
}

/// Put the flow's own sentence on the menu item — and tell the window the same thing.
///
/// TWO SURFACES, ONE CALL, because the failure mode of two calls is a settings pane that says
/// "up to date" while the bar says "restart to install". Every transition already went through
/// here for exactly that reason; the window is now the second reader of the same moment.
///
/// The event is one-way and needs no permission the window does not already hold: it listens
/// over the `core:event:allow-listen` grant the menu's own events use. A failed emit is a window
/// that is not there yet or is closing, and the pane re-reads the state when it next mounts.
fn relabel<R: Runtime>(app: &AppHandle<R>) {
    let at = app.clone();
    on_the_drawing_thread(app, move || {
        let app = &at;
        let state = app.state::<Updater<R>>();
        let (label, enabled, report) = {
            let flow = lock(&state.flow);
            let last = *lock(&state.last);
            let kind = install_kind();
            let standing = standing(app, &flow);
            let (label, enabled) = menu_text(kind, &flow, standing.held);
            (label, enabled, told(&flow, last, kind, standing))
        };
        // A bar that has not been built yet (this runs before `menu.rs` hands the item over on a
        // very early check) has nothing to relabel; `adopt_menu_item` relabels once on arrival. On
        // a session where the compositor owns the frame there is no bar at ALL — `frame.rs` — and
        // the settings pane below is then the only surface, which is why it is not optional.
        let item = lock(&state.item);
        if let Some(item) = item.as_ref() {
            let _ = item.set_text(label);
            let _ = item.set_enabled(enabled);
        }
        let _ = app.emit(STATE_EVENT, report);
    });
}

/// The thread a write to the menu runs on: the one that draws.
pub(crate) trait DrawingThread {
    /// Run `write` there: at once when the caller is that thread, posted otherwise, and never
    /// waited for.
    fn post(&self, write: Box<dyn FnOnce() + Send + 'static>);
}

impl<R: Runtime> DrawingThread for AppHandle<R> {
    fn post(&self, write: Box<dyn FnOnce() + Send + 'static>) {
        // An error is a loop that has already gone, with no menu left to write.
        let _ = self.run_on_main_thread(write);
    }
}

/// EVERY MENU WRITE RUNS ON THE THREAD THAT DRAWS, AND NO THREAD WAITS FOR IT. Tauri's setters post
/// to that thread and wait when called from any other, so a background relabel used to hold the
/// item's lock while it waited there, and a relabel on that thread meanwhile (a press, the Settings
/// button, the daily check) waited for the same lock: neither moved again. The write reads the flow
/// when it runs, so the last one to run carries the newest state.
pub(crate) fn on_the_drawing_thread(drawing: &impl DrawingThread, write: impl FnOnce() + Send + 'static) {
    drawing.post(Box::new(write));
}

/// Write down what a completed check found.
///
/// Called from the three places a check ENDS and from the one where an offer is taken up, so the
/// pane can say something true about a check that changed no stage — an up-to-date answer and a
/// refusal are both `Idle` and are not the same fact ([`CheckResult`]).
///
/// It announces NOTHING itself, and every call site is immediately followed by the [`signal`]
/// for the same moment: one transition, one emit, and no window that can catch the pair
/// half-applied.
///
/// It is also the one place the `updater_offer` line is written, for the same reason: these four
/// call sites ARE the ends of a check, so a fifth end could not be added without passing through
/// here. `offered` is the signed version at the one end that has one.
fn record<R: Runtime>(app: &AppHandle<R>, result: CheckResult, offered: Option<&str>) {
    let state = app.state::<Updater<R>>();
    *lock(&state.last) = Some(Check { at_unix_ms: now_unix_ms(), result });
    log_offer(result.as_str(), offered, install_kind());
    // A check that reached the feed and did not offer the release whose install failed ends that
    // failure: a newer one is on offer, or none is.
    if result != CheckResult::Failed && failure(app).is_some_and(|failed| offered != Some(failed.version.as_str())) {
        if let Some(dir) = data_dir(app) {
            crate::appimage_stage::forget_failure(&dir);
        }
    }
}

/// Build the transient progress window that renders `PROGRESS_EVENT`.
///
/// Returns `None` — and the download proceeds without a bar — if the window cannot be created. A
/// missing page or a platform refusal is not a reason to refuse an update the user asked for; the
/// download and the minisign verification happen regardless.
///
/// `focused(false)` on purpose: it is a report, not a place to type, and a window that takes the
/// keyboard away mid-sentence is the interruption this whole flow is built to avoid.
fn show_progress_window<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
    // Born locked to the app's own pages like every window (`navigation.rs`). The page has no link
    // and no new-window handler.
    crate::navigation::lock(
        WebviewWindowBuilder::new(app, PROGRESS_WINDOW_LABEL, WebviewUrl::App("updater.html".into())),
        app.config(),
    )
    .title("Updating ohmail")
    .inner_size(420.0, 210.0)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .focused(false)
    // The same question the main window answered at setup, asked again because this window is
    // built later and on demand. A decorated 420×210 progress window is the same double frame
    // as a decorated mail window, in a smaller rectangle; `frame.rs` carries the rule.
    .decorations(crate::frame::decide_from_env().decorations())
    .center()
    .build()
    .ok()
}

/// Offer `candidate` only if it is strictly newer than what is installed. Equal
/// (a reinstall of the same release) and older (a downgrade) are both refused.
/// This is the whole of the downgrade rule, and it is a plain semver comparison
/// because the version is now bare semver everywhere — there is no `-preview`
/// pre-release suffix left to make the ordering subtle.
pub fn should_offer(installed: &semver::Version, candidate: &semver::Version) -> bool {
    candidate > installed
}

/// The whole install decision, as a pure function of what the feed said and what the
/// signature says. Returns the version to install, or `None` for "offer nothing".
///
/// `run` holds an `AppHandle` and cannot be driven from a test, so the decision lives
/// here instead of inline — the same reason `Flow` is a value. `the_advertised_version_…`
/// and `the_attack_this_guard_exists_for` drive THIS, so the rule under test is the rule
/// that ships rather than a copy of it in a table.
///
/// FOUR refusals, and the invariant they share is the one worth stating: `None` is the only
/// way anything here can stop an install, nothing downstream resumes one, so every refusal
/// leaves the version already on the machine running.
///
///   1. Either version unparseable → `None`. A feed advertising an unparseable version is
///      exactly the kind of thing an updater must not act on.
///   2. The signed asset is not the one THIS build may install → `None` (see the block below).
///   3. The advertised version disagrees with the SIGNED one → `None`. The feed is not
///      serving what it says it is serving, and only the signature can reveal that.
///   4. The signed version is not strictly newer → `None`. A downgrade, or a reinstall.
///
/// What the person is TOLD is decided in `run`, not here, and the four do not share one
/// sentence: `refusal_is_unverifiable` splits 4 — genuinely "up to date" — from 1–3, which
/// mean an update exists that this client will not install. Reporting those three as up to
/// date is the report that hides a release signed without its version.
pub fn should_install(
    installed: &str,
    advertised: &str,
    signature_b64: &str,
    expected_asset: &str,
) -> Option<semver::Version> {
    let installed = semver::Version::parse(installed).ok()?;
    let advertised = semver::Version::parse(advertised).ok()?;
    let signed = signed_release(signature_b64)?;

    // ── AND THE PAYLOAD IS THE ONE FOR *THIS* BUILD ───────────────────────────────────
    //
    // The version being right does not make the ARTIFACT right. Which platform key a feed
    // maps to which url is unsigned exactly as the version was, so a feed writer holding no
    // key can point `linux-x86_64` at the genuine, genuinely-signed `linux-aarch64`
    // AppImage of the SAME release. Advertised and signed versions agree, the version is
    // newer, every signature verifies — and the plugin's AppImage installer then moves the
    // running x86-64 binary aside and writes an AArch64 ELF in its place. The restart fails
    // on an executable the machine cannot run, and the backup is gone with the temporary
    // directory. That is not a downgrade; it is every install on one architecture bricked,
    // permanently, by editing one file.
    //
    // The signed name carries the asset as well as the version, so the check is a
    // comparison. `expected_asset` is a parameter rather than read here so the tests can
    // drive every platform's case on one machine; `EXPECTED_ASSET` is the value the shipping
    // call site passes, and `the_expected_asset_names_match_the_release` holds it against
    // the names the release actually publishes.
    if signed.asset != expected_asset {
        return None;
    }
    // The ordering is applied to the SIGNED version, never the advertised one. That
    // substitution is the fix — see `signed_release`.
    //
    // THE TWO CONDITIONS ARE INDEPENDENTLY SUFFICIENT AGAINST THE DOWNGRADE, and that is
    // recorded here because a mutation run says so and because it makes the second one
    // look dead to anybody tidying up. Measured: removing the equality alone leaves the
    // attack refused (the ordering sees the signed 0.9.0 and says no); swapping the
    // ordering's operand back to `advertised` alone leaves it refused too (the equality
    // sees 99.0.0 against 0.9.0 and says no). Removing BOTH is the pre-slice code, and
    // `the_attack_this_guard_exists_for` goes red on exactly that.
    //
    // A consequence worth knowing: because the equality holds whenever the ordering runs,
    // `should_offer(&installed, &advertised)` here would be an EQUIVALENT mutant — no test
    // can distinguish it. `&signed.version` is written anyway, because it is the operand
    // the invariant is about, and it is the one that stays correct if the equality is ever
    // relaxed. Do not "simplify" either half on the grounds that mutating it changes
    // nothing.
    if advertised != signed.version || !should_offer(&installed, &signed.version) {
        return None;
    }
    Some(signed.version)
}

/// The published asset name THIS build may install, and no other.
///
/// Restated per target rather than derived, because there is nothing to derive it from: the
/// mapping from platform to filename is a release decision, and `build.yml`'s header calls
/// those names a contract. This is the other party to it, and
/// `the_expected_asset_names_match_the_release` fails if the two ever disagree — which is
/// the drift this constant would otherwise introduce, since a renamed asset would stop
/// every update with the client reporting "up to date".
///
/// A target with no arm here does not compile, deliberately. The four below are the four
/// the project publishes; a fifth platform must decide its own name before it can ship an
/// updater, rather than inheriting "accept anything".
#[cfg(target_os = "windows")]
pub const EXPECTED_ASSET: &str = "ohmail-windows-setup.exe";
/// One universal archive for both Mac architectures — the same file under both feed keys.
#[cfg(target_os = "macos")]
pub const EXPECTED_ASSET: &str = "ohmail.app.tar.gz";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub const EXPECTED_ASSET: &str = "ohmail-linux-x86_64.AppImage";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
pub const EXPECTED_ASSET: &str = "ohmail-linux-aarch64.AppImage";

/// What the SIGNING KEY says a payload is: the version, and the asset it was signed as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedRelease {
    pub version: semver::Version,
    pub asset: String,
}

/// The version the signing key vouches for, read out of the payload's own minisign
/// signature.
///
/// ── WHY THE FEED'S OWN `version` FIELD CANNOT BE THE CANDIDATE ────────────────────
///
/// `latest.json` is UNSIGNED METADATA. Every byte of every payload is minisign-verified
/// before `download` will hand it back, but nothing signs the manifest that says which
/// payload is which — `tauri-plugin-updater` 2.12.0 parses it with plain serde
/// (`parse_version`). Its own version check reads a `version:` field of the trusted comment,
/// which our signer does not write, so it admits our releases and this guard is the check.
/// So the version the feed ADVERTISES is a claim by whoever can write the feed, and the
/// artifacts of every past release are public, permanently downloadable, and genuinely
/// signed.
///
/// That is a downgrade for everyone, without the signing key: publish a manifest saying
/// `99.0.0` and point it at an old release's real artifact with that release's real
/// signature. The payload verifies, because it IS ours. Comparing `99.0.0` against the
/// installed version says "newer", and one "Restart now" installs a build whose known
/// vulnerabilities are in the changelog. Nothing stops it happening again next launch.
///
/// ── WHAT IS ACTUALLY SIGNED, AND HOW THE VERSION GETS IN THERE ────────────────────
///
/// minisign signs the payload AND its own TRUSTED COMMENT: the global signature covers
/// `signature || trusted_comment`, and `minisign-verify` checks it unconditionally
/// (0.2.5, `PublicKey::verify_ed25519`) on the same call that checks the payload. The
/// trusted comment is therefore the one place a release can put a fact about a payload
/// that a feed writer cannot forge.
///
/// The signer writes `timestamp:<unix>\tfile:<name>` there, where `<name>` is the file it
/// was handed. So the release pipeline signs each artifact under the name
/// `<version>@<published asset>` — see the `sign_tauri` call in `release-feeds.yml` — and
/// the version becomes signed metadata at no cost: no new key, no new file, no schema
/// change, and the published asset names are untouched.
///
/// ── WHERE THE AUTHENTICATION COMES FROM (this is the subtle part) ─────────────────
///
/// This function does NOT verify anything, and it is called BEFORE `download`. That is
/// deliberate and it is sound, but not for a reason worth guessing at:
///
///   * A payload whose trusted comment was EDITED never reaches an install, and this
///     guard is not what stops it — `download` is. Verification covers the trusted
///     comment, so a forged version claim in it fails the global signature check and
///     `download` returns an error. The app reports that it could not fetch the update.
///     `forged_version_claim_is_refused` watches exactly that happen.
///   * What this guard stops is the case where EVERYTHING VERIFIES because every byte is
///     genuine, and only the feed is lying about which release it is serving. No
///     signature check can catch that; a comparison against the signed name is the only
///     thing that can.
///
/// So running it first costs a downgrade attempt its download instead of granting it one,
/// and the string it reads is the same string `download` then proves authentic.
///
/// An artifact signed WITHOUT a version — every release up to and including 0.13.2 —
/// yields `None`, and `None` refuses. That is the intended reading: bytes this client
/// cannot establish a version for do not get installed. It costs nothing legitimate,
/// because updates only ever move forward onto releases signed after this shipped, and
/// `verify-feeds.mjs` fails the release rather than publish a feed that would stall every
/// client on `None`.
pub fn signed_release(signature_b64: &str) -> Option<SignedRelease> {
    use base64::Engine as _;

    // tauri wraps the whole .sig file text in base64; the manifest carries that envelope.
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(signature_b64.trim())
        .ok()?;
    let text = std::str::from_utf8(&decoded).ok()?;

    // ── THE TRUSTED COMMENT IS READ BY POSITION, NOT BY PREFIX ────────────────────────
    //
    // A minisign signature file is exactly four lines, and only two of them are signed:
    //
    //   0  untrusted comment: …      NOT covered by any signature — anyone may rewrite it
    //   1  <base64 signature>        covered
    //   2  trusted comment: …        covered, by the global signature over `sig || comment`
    //   3  <base64 global signature> covered
    //
    // This function first scanned for the FIRST line beginning `trusted comment: `, which
    // is a hole big enough to undo the whole guard, and it was found by crafting it rather
    // than by reading: `minisign_verify::Signature::decode` reads line 2 POSITIONALLY and
    // never validates line 0, so writing `trusted comment: …file:99.0.0@…` INTO LINE 0
    // leaves a genuine old release's signature verifying exactly as before — payload and
    // global signature both — while a prefix scan reads the forged line and reports 99.0.0.
    // Feed says 99.0.0, guard agrees, `download` verifies, and the downgrade installs.
    // `a_forged_untrusted_comment_cannot_move_the_version` is that signature.
    //
    // So the read is positional and mirrors `decode` line for line: whatever `download`
    // authenticates is the same text this reads, by construction rather than by agreement.
    let mut lines = text.lines();
    lines.next()?; // line 0 — the untrusted comment. Deliberately never read.
    lines.next()?; // line 1 — the payload signature.
    let comment = lines.next()?.strip_prefix("trusted comment: ")?;

    // `timestamp:<unix>\tfile:<name>` — tab-separated fields, and only the `file:` one is
    // read. The timestamp is signed too, but it is not a version and this guard does not
    // pretend otherwise.
    let name = comment
        .split('\t')
        .find_map(|field| field.strip_prefix("file:"))?;

    // `<version>@<asset>`. `split_once` rather than `split`, so an asset name containing
    // an `@` cannot move where the version is read from.
    let (version, asset) = name.split_once('@')?;
    if asset.is_empty() {
        return None;
    }
    Some(SignedRelease {
        version: semver::Version::parse(version).ok()?,
        asset: asset.to_string(),
    })
}

#[cfg(test)]
#[path = "updater_tests.rs"]
pub(crate) mod tests;
