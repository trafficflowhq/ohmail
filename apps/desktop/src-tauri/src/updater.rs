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
//! That constraint is also why there is no update banner inside the mail window.
//! A banner needs a button, a button needs a command, and a command is the exact
//! permission this design exists to withhold — so the menu item below IS the
//! affordance, and it changes its own text to say what the app is doing.
//!
//! ── WHAT THE USER ACTUALLY SEES ───────────────────────────────────────────────
//!
//! One decision, asked once, at the end:
//!
//!   1. The app checks the feed shortly after launch, and whenever the menu item
//!      is picked. While a check runs the item says so and is disabled, so a slow
//!      feed is visible where the user just pressed rather than as dead air.
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
            // A new run gets a new chance to ask. Reached by a user pressing the item after a
            // "Later" was withdrawn by a failure, which is the only way back to `Checking`.
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

/// A payload that has been fetched and verified and has NOT been installed.
///
/// Held in memory rather than written anywhere: an update nobody consented to must leave no trace
/// on the machine, so quitting the app is enough to discard it.
struct Pending {
    update: tauri_plugin_updater::Update,
    bytes: Vec<u8>,
}

/// The flow, the payload waiting on it, and the menu item that reports both.
struct Updater<R: Runtime> {
    flow: Mutex<Flow>,
    pending: Mutex<Option<Pending>>,
    item: Mutex<Option<MenuItem<R>>>,
}

impl<R: Runtime> Updater<R> {
    fn new() -> Self {
        Self {
            flow: Mutex::new(Flow::default()),
            pending: Mutex::new(None),
            item: Mutex::new(None),
        }
    }
}

/// Take a lock, and take it even if a previous holder panicked.
///
/// A poisoned lock here would disable the updater for the life of the process, which is a worse
/// outcome than continuing with the state that was left behind — every field is either a plain
/// enum or an owned payload, and neither can be half-written.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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
    {
        let state = app.state::<Updater<R>>();
        let mut flow = lock(&state.flow);
        if !flow.may_start_check() {
            return;
        }
        flow.apply(Signal::CheckStarted);
    }
    relabel(&app);
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
    let Some(offered) = should_install(&update.current_version, &update.version, &update.signature)
    else {
        return nothing_to_offer(&app, user_initiated);
    };

    // The SIGNED version is what the rest of the flow reports, not the advertised one.
    // They are equal here by construction — `should_install` refuses otherwise — so this
    // is a statement about which one is authoritative rather than a change of value.
    let version = offered.to_string();
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
            app.restart();
        }
        Err(_) => {
            // The one failure that always speaks, whoever started the check: the user pressed a
            // button that promised a restart, and nothing at all happening is the worst answer.
            signal(app, Signal::Failed);
            say_it_failed(app, "ohmail could not install the update. Try again in a moment.");
        }
    }
}

/// The feed answered and there is nothing to install.
fn nothing_to_offer<R: Runtime>(app: &AppHandle<R>, user_initiated: bool) {
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

/// Put the flow's own sentence on the menu item.
fn relabel<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<Updater<R>>();
    let (label, enabled) = {
        let flow = lock(&state.flow);
        (flow.menu_label(), flow.menu_enabled())
    };
    // A bar that has not been built yet (this runs before `menu.rs` hands the item over on a very
    // early check) simply has nothing to relabel; `adopt_menu_item` relabels once on arrival.
    let item = lock(&state.item);
    if let Some(item) = item.as_ref() {
        let _ = item.set_text(label);
        let _ = item.set_enabled(enabled);
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
) -> Option<semver::Version> {
    let installed = semver::Version::parse(installed).ok()?;
    let advertised = semver::Version::parse(advertised).ok()?;
    let signed = signed_release(signature_b64)?;
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
