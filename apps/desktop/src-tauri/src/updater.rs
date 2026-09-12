//! The auto-updater — Rust-side, and deliberately nowhere near the webview.
//!
//! ── WHY THIS LIVES IN RUST AND NOT IN THE UI ──────────────────────────────────
//!
//! The shell's promise is that the webview reaches nothing: `capabilities/main.json`
//! grants it no permission, its CSP is `connect-src 'none'`, and `offline-guard.ts`
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
//!   3. When the payload is verified and waiting, ONE dialog asks whether to
//!      restart and install it. "Later" is remembered for the rest of the run —
//!      it is never asked twice — and the menu item becomes "Restart to Install",
//!      which is the only thing that ever installs anything.
//!
//! The restart happens on that press and on nothing else. There is no second
//! prompt, no dialog stacked on a dialog, and no path where the app relaunches
//! itself while somebody is reading their mail.
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
//! The re-ask the window raises is a quiet strip, never a dialog, and it treats the
//! FIRST sight of a ready payload as this file's dialog already asking. So the count
//! above still holds: one dialog per release, from here, and the strip is what
//! carries it a day later. A failing install is bounded on the window's side too —
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
//!   * NOTIFY-AND-INSTALL, never silent. Downloading and installing are two
//!     separate calls here, and the consent gates the second one: not a byte of a
//!     new release is applied to the installed app until the user presses for it.
//!     A payload that is fetched and never consented to is dropped when the app
//!     quits.
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
//!     of a payload. It used to log nothing at all, so answering "which feed did this install
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

use std::sync::{Mutex, MutexGuard};

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
    /// The macOS application bundle.
    MacBundle,
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
    /// This process IS that image: the executable resolves inside the mount the runtime made, and
    /// the path names a regular file — a file that exists to be replaced.
    Running,
}

/// The one decision, as a pure function of what the machine says. The ORDER is the design:
///
///  1. The sandbox marker wins outright — a Flatpak is a Flatpak whatever a bundler wrote, and
///     the software centre is what updates it.
///  2. The bundler's record next, for every kind but the AppImage, and ahead of the AppImage fact
///     because a packaged install must not be talked into replacing a stranger's file.
///  3. The AppImage fact then decides the AppImage ALONE, not together with the bundler's mark. An
///     AppImage whose mark went missing would otherwise stop updating with nothing on screen to
///     say so, and an extracted copy carries the mark while having no image to rewrite.
///  4. Under a system prefix with no mark: a distribution built this and owns the files.
pub fn classify(facts: Facts) -> InstallKind {
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
}

/// Is this path inside a mount the AppImage runtime made? The runtime mounts each image under a
/// `mkdtemp` directory it names `.mount_…` (`/tmp/.mount_ohmailXXXXXX/usr/bin/ohmail`), and an
/// EXTRACTED tree is a directory somebody chose — which is the whole difference the finding turns
/// on. `$APPDIR` cannot answer it alone: an extracted `AppRun` sets that variable to the
/// extraction directory, so the exe would sit inside it in both cases.
fn inside_runtime_mount(path: &std::path::Path) -> bool {
    path.ancestors().any(|dir| {
        dir.file_name().is_some_and(|name| name.to_string_lossy().starts_with(".mount_"))
    })
}

/// The AppImage fact, from what was measured. Every refusal below is a copy that cannot replace
/// itself, and each is its own row in `updater_tests.rs`.
pub fn running_image(env: ImageEnv<'_>) -> AppImage {
    if env.appimage.is_none() {
        return AppImage::None;
    }
    if env.extract_and_run || !env.image_is_a_file {
        return AppImage::Inherited;
    }
    let Some(exe) = env.exe else { return AppImage::Inherited };
    // Both halves: the runtime's own mount, and `$APPDIR` agreeing with it where it is set.
    if !inside_runtime_mount(exe) || env.appdir.is_some_and(|dir| !exe.starts_with(dir)) {
        return AppImage::Inherited;
    }
    AppImage::Running
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

fn read_facts() -> Facts {
    let exe = std::env::current_exe().ok();
    let appimage = env_path("APPIMAGE");
    let appdir = env_path("APPDIR");
    Facts {
        bundled_as: bundled_as(),
        appimage: running_image(ImageEnv {
            appimage: appimage.as_deref(),
            // PRESENCE, exactly as the runtime reads it: `APPIMAGE_EXTRACT_AND_RUN=0` extracts
            // too, so a value test here would disagree with the thing that actually decided.
            extract_and_run: std::env::var_os("APPIMAGE_EXTRACT_AND_RUN").is_some(),
            appdir: appdir.as_deref(),
            exe: exe.as_deref(),
            // The SECOND of this module's two disk reads, and `desktop-shell.test.ts` holds it to
            // exactly these two: an updater that touched the filesystem anywhere else would be
            // applying an update by hand, outside the plugin that verifies payloads.
            image_is_a_file: appimage
                .as_deref()
                .and_then(|path| std::fs::metadata(path).ok())
                .is_some_and(|meta| meta.is_file()),
        }),
        // The FIRST: the Flatpak marker inside the sandbox.
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
}

impl Flow {
    /// The stage itself, for the tests that assert the whole ladder. The shipping code never reads
    /// it directly — it asks the four questions below instead, so there is no second switch over
    /// `Stage` anywhere for this one to drift from.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn stage(&self) -> &Stage {
        &self.stage
    }

    /// Fold one signal in. Signals that do not belong to the current stage are ignored rather than
    /// asserted on: they arrive from spawned work, and a task finishing after the flow has moved on
    /// must not be able to drag it backwards.
    pub fn apply(&mut self, signal: Signal) {
        self.stage = match (&self.stage, &signal) {
            (Stage::Idle | Stage::Failed, Signal::CheckStarted) => Stage::Checking,
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
            (stage, _) => stage.clone(),
        };
        if self.stage == Stage::Checking {
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
    pub fn menu_enabled(&self) -> bool {
        self.press() != Press::Nothing
    }
}

/// WHAT THE MENU ITEM SAYS, and whether it can be pressed — the flow and the install, composed.
///
/// Pure, so `updater_tests.rs` drives every pair, and the only place the two are put together:
/// an install that cannot replace its own files says so in every stage, because on such a copy
/// no stage but `Idle` is ever reached.
pub fn menu_text(kind: InstallKind, flow: &Flow) -> (String, bool) {
    match kind.menu_sentence() {
        Some(sentence) => (sentence.to_string(), false),
        None => (flow.menu_label(), flow.menu_enabled()),
    }
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
///
/// Held in memory rather than written anywhere: an update nobody consented to must leave no trace
/// on the machine, so quitting the app is enough to discard it.
struct Pending {
    update: tauri_plugin_updater::Update,
    bytes: Vec<u8>,
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
}

impl<R: Runtime> Updater<R> {
    fn new() -> Self {
        Self {
            flow: Mutex::new(Flow::default()),
            pending: Mutex::new(None),
            item: Mutex::new(None),
            last: Mutex::new(None),
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
        "lastCheckedAt": last.map(|c| c.at_unix_ms),
        "lastResult": last.map(|c| c.result.as_str()).unwrap_or("never"),
    })
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
// what the check found, `updater_verdict` what became of a payload. This module used to log
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
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Installed => "installed",
            Verdict::Deferred => "deferred",
            Verdict::Failed => "failed",
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

/// Every line [`emit`] wrote, so `updater_tests.rs` reads back what the shipping code composed
/// rather than a copy of it. Test-only, and the sink still runs beside it.
#[cfg(test)]
pub(crate) static WROTE: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Write one line. Every log site in this module goes through here.
fn emit(text: String) {
    #[cfg(test)]
    lock(&WROTE).push(text.clone());
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
    let mut fields = vec![("verdict", verdict.as_str())];
    if let Some(class) = error_class {
        fields.push(("errorClass", class));
    }
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
                pressed(app.clone());
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
/// It names nothing and reaches nothing — no argument, no feed, no path. The answer is [`report`]
/// over state this process already holds.
#[cfg(feature = "local-engine")]
#[tauri::command]
pub fn update_state<R: Runtime>(app: AppHandle<R>) -> serde_json::Value {
    let state = app.state::<Updater<R>>();
    let flow = lock(&state.flow);
    let last = *lock(&state.last);
    report(&flow, last, env!("CARGO_PKG_VERSION"), install_kind())
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

/// The menu item was picked. What that means depends on where the flow is.
fn pressed<R: Runtime>(app: AppHandle<R>) {
    let what = {
        let state = app.state::<Updater<R>>();
        let flow = lock(&state.flow);
        flow.press()
    };
    match what {
        Press::Check => check(app, true),
        Press::Restart => install_and_restart(&app),
        // Disabled in the bar; belt and braces for a platform that lets a disabled item fire.
        Press::Nothing => {}
    }
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
    }
    relabel(&app);
    log_check(&feed_endpoints(&app), env!("CARGO_PKG_VERSION"));
    tauri::async_runtime::spawn(async move { run(app, user_initiated).await });
}

/// The whole flow, in the order a person experiences it.
async fn run<R: Runtime>(app: AppHandle<R>, user_initiated: bool) {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(_) => return failed(&app, user_initiated),
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

    {
        let state = app.state::<Updater<R>>();
        *lock(&state.pending) = Some(Pending { update, bytes });
    }
    signal(&app, Signal::Downloaded);
    prompt_ready(&app, &version);
}

/// The ONE dialog in the whole flow, asked once, at the point it is worth asking.
///
/// Non-blocking (`show`, not `blocking_show`): the app stays usable behind it, and the answer
/// arrives on a callback rather than by parking a thread. "Later" spends the question and nothing
/// else — the payload stays ready and the menu item says so — so the app can never ask twice.
fn prompt_ready<R: Runtime>(app: &AppHandle<R>, version: &str) {
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
                install_and_restart(&deferrer);
            } else {
                log_verdict(Verdict::Deferred, None);
                signal(&deferrer, Signal::Deferred);
            }
        });
}

/// Apply the waiting payload and relaunch into it. The only place anything is installed.
fn install_and_restart<R: Runtime>(app: &AppHandle<R>) {
    let outcome = {
        let state = app.state::<Updater<R>>();
        let pending = lock(&state.pending);
        match pending.as_ref() {
            // Nothing waiting: a press that raced the payload being dropped. Silent by design.
            None => return,
            Some(payload) => payload.update.install(&payload.bytes),
        }
    };
    match outcome {
        Ok(()) => {
            // Before the restart, and it survives it: the log flushes per write, so the last
            // line of the old build's log is the one saying why there is a new one.
            log_verdict(Verdict::Installed, None);
            app.restart();
        }
        Err(err) => {
            // The one failure that always speaks, whoever started the check: the user pressed a
            // button that promised a restart, and nothing at all happening is the worst answer.
            log_verdict(Verdict::Failed, Some(error_class(&format!("{err:?}"))));
            signal(app, Signal::Failed);
            say_it_failed(app, "ohmail could not install the update. Try again in a moment.");
        }
    }
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
    let state = app.state::<Updater<R>>();
    let (label, enabled, report) = {
        let flow = lock(&state.flow);
        let last = *lock(&state.last);
        let kind = install_kind();
        let (label, enabled) = menu_text(kind, &flow);
        (label, enabled, report(&flow, last, env!("CARGO_PKG_VERSION"), kind))
    };
    // A bar that has not been built yet (this runs before `menu.rs` hands the item over on a very
    // early check) simply has nothing to relabel; `adopt_menu_item` relabels once on arrival. On a
    // session where the compositor owns the frame there is no bar at ALL — `frame.rs` — and the
    // settings pane below is then the only surface, which is why it is not optional.
    let item = lock(&state.item);
    if let Some(item) = item.as_ref() {
        let _ = item.set_text(label);
        let _ = item.set_enabled(enabled);
    }
    let _ = app.emit(STATE_EVENT, report);
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
    WebviewWindowBuilder::new(
        app,
        PROGRESS_WINDOW_LABEL,
        WebviewUrl::App("updater.html".into()),
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
/// Three refusals, and the middle one is the new one:
///
///   1. Either version unparseable → `None`. A feed advertising an unparseable version is
///      exactly the kind of thing an updater must not act on.
///   2. The advertised version disagrees with the SIGNED one → `None`. The feed is not
///      serving what it says it is serving, and only the signature can reveal that.
///   3. The signed version is not strictly newer → `None`. A downgrade, or a reinstall.
///
/// All three are reported as "up to date" rather than as an error: a feed that offers the
/// wrong version is not something the person at the keyboard can do anything about, and
/// the honest user-facing fact is that nothing is going to be installed.
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
/// payload is which — `tauri-plugin-updater` 2.10.1 parses it with plain serde
/// (`parse_version`) and there is no signature over it anywhere in the crate. So the
/// version the feed ADVERTISES is a claim by whoever can write the feed, and the
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
mod tests;
