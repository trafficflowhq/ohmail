/**
 * THE NATIVE CHROME, from the window's side of it.
 *
 * Three things a web page cannot do and an app is expected to: answer the menu bar, put a
 * notice in the operating system's own notification centre, and carry a count on its icon in
 * the dock or taskbar. All three are the SHELL's to perform — the page has no menu, no
 * notification permission and no dock — so each one is either an event the shell emits or a
 * command the shell registers, and this file is the whole of what the window may say about them.
 *
 * ── THE DIRECTION OF EACH ONE, WHICH IS NOT THE SAME ────────────────────────────────────────
 *
 * The MENU pushes: the shell owns the bar and its accelerators, and a chosen item arrives here
 * as one event carrying a view id. Navigation itself stays in the frontend — the menu says where
 * to go and the client goes there through exactly the function the rail, the palette and the
 * number keys already use, so a menu item and a keystroke cannot land in different places.
 *
 * The NOTIFICATION and the BADGE pull: the window decides there is something to say and asks the
 * shell to say it. That is the right way round — what counts as unread is a question about mail,
 * which the client answers and the shell has no opinion on.
 *
 * ── WHY THE COMMAND CHANNEL IS REACHED THROUGH THE RUNTIME'S OWN GLOBAL ─────────────────────
 *
 * The same reason `bridge-fetch.ts` gives: `@tauri-apps/api` is a wrapper around this exact
 * property, and adding the dependency would put a package in the bundle and in the published
 * manifest for lines that read identically either way. `withGlobalTauri` is false, so the
 * friendlier global does not exist; this one always does, because the runtime's bootstrap
 * defines it before any bundle script runs.
 *
 * Listening is `plugin:event|listen`, which is the runtime's own event plugin and is granted to
 * this window by exactly one permission (`core:event:allow-listen`). Emitting is NOT granted:
 * the window can hear what the shell says and cannot make the shell hear anything, which is the
 * asymmetry a menu wants.
 */

/** The event the shell emits when a navigation item is chosen from the menu. */
export const MENU_NAVIGATE_EVENT = "menu:navigate";

/** The event the shell emits when a COMMAND item is chosen — compose, settings, search, … */
export const MENU_COMMAND_EVENT = "menu:command";

/**
 * The event the shell emits when an `ohmail://link?code=…` activation arrives.
 *
 * A THIRD channel rather than a third name on one of the menu's, for the reason those two are
 * separate from each other: the payloads are different kinds of value, and each union is closed on
 * its own terms. A menu payload is one of a fixed list this bundle knows; this one is an opaque
 * server-minted string this bundle deliberately does not pattern-check. Sharing an event would mean
 * a shell one version ahead could turn one into the other.
 *
 * What arrives is the handoff CODE and never a token — the shell claims nothing, and the window
 * sends the code down the same bridge the retyped one has always gone down.
 */
export const LINK_CODE_EVENT = "link:code";

/**
 * The views the menu can reach, in the order it lists them — and therefore the order their
 * ⌘1…⌘5 accelerators run in.
 *
 * FIVE, and the same five the rail lists first. It is deliberately not every view: Search has
 * its own key, Settings is not somewhere anybody flicks to, and Tags are the user's own and
 * change. The Rust side names the same list; `menu.rs` carries the reasoning for why the two
 * are written down twice and what keeps them in step.
 */
export const MENU_VIEWS = ["ohbox", "reads", "receipts", "screener", "triage"] as const;

export type MenuView = (typeof MENU_VIEWS)[number];

/**
 * The commands the menu can ask for, and therefore what its ⌘N / ⌘, / ⌘F / ⌘K / ⌘/ items do.
 *
 * Every one is something the client already does. The menu is a second WAY to one implementation
 * and never a second implementation: `DesktopGate` maps each id onto the same call the key or the
 * palette entry makes. The Rust side names the same list; `menu.rs` carries the reasoning for why
 * the two are written down twice and what keeps them in step.
 */
export const MENU_COMMANDS = ["compose", "settings", "search", "palette", "shortcuts"] as const;

export type MenuCommand = (typeof MENU_COMMANDS)[number];

/**
 * The event the shell emits when a `mailto:` activation arrives — and it carries NOTHING.
 *
 * A fourth channel, and a different shape from the third: the link itself waits in the shell
 * until this window CLAIMS it over {@link claimMailto}, take-once. The claim shape exists for
 * the activation that STARTS the app — an event emitted before this bundle's scripts run is an
 * event nobody hears, and a mailto click is precisely the click that launches a closed mail
 * client. The window claims on this poke and once at mount, and the same link can never seed
 * two compose forms.
 */
export const MAILTO_EVENT = "link:mailto";

/** The commands the shell registers for this file. Named once so a typo is one place. */
const NOTIFY_COMMAND = "notify";
const BADGE_COMMAND = "set_badge";
const OPEN_COMMAND = "open_link";
const MAILTO_CLAIM_COMMAND = "mailto_claim";
const DEFAULT_MAIL_STATUS_COMMAND = "default_mail_status";
const DEFAULT_MAIL_REQUEST_COMMAND = "default_mail_request";

/**
 * The places on the web this app can open, named as PLACES and never as addresses.
 *
 * A hosted account is administered on the web — the plan, the password, the authenticator — and
 * every one of those is a ceremony against a server this window cannot reach. So Settings needs a
 * way OUT to the browser, and the way out is deliberately not a URL.
 *
 * The window passes one of these keys and the shell's own table decides what it means. That is the
 * whole of the safety argument: were a URL the argument, anything that ever got a string into this
 * page — a mail body, a sender's display name, a hole in the sanitizer — could open an arbitrary
 * address in the user's real browser, signed in to everything they are signed in to. It is also
 * what keeps this bundle free of any host name at all, which is the claim the preview artifact is
 * built on.
 */
export const WEB_PLACES = [
  "account", "security", "billing",
  // `mailboxes` is the hosted door's mailbox administration — connecting one, rotating its
  // password, disconnecting it. It is here for a reason the shell can state precisely rather
  // than as a shrug: those three routes on the hosted account are step-up gated (a second factor
  // asserted within the last few minutes), and a desktop install's session is stamped with one
  // exactly once, when the code was claimed. Nothing this app can do re-asserts a factor — it
  // holds no password, no authenticator secret, and a passkey ceremony needs a real browser
  // origin this window does not have. So the honest surface is a read-only list and a way out to
  // the browser, and this key is the way out.
  "mailboxes",
  // `link-desktop` is the odd one and worth naming: every other place here administers an
  // account this app is already serving, and this one is opened BEFORE there is a session — it
  // is the browser half of signing in, where the page mints a one-use code the person retypes
  // into the app. Same mechanism, same table, no exception to the no-URL rule.
  "link-desktop",
  "privacy", "subprocessors",
] as const;

export type WebPlace = (typeof WEB_PLACES)[number];

/**
 * Open one of {@link WEB_PLACES} in the user's own browser.
 *
 * Nothing is fetched here and nothing is fetched by the shell: the browser makes the request, as
 * itself, with its own session. A refusal — no browser, a platform that would not spawn one —
 * comes back as a rejection for the caller to show.
 *
 * ── `challenge` IS A VALUE, AND STILL NOT A URL ─────────────────────────────────────────────
 *
 * The sign-in page needs one parameter: the public half of a PKCE pair whose secret half is in the
 * engine's memory, which is what makes the code that page mints safe to hand back over the
 * `ohmail://` scheme. This window does not compose that address. It passes the place and the 43
 * characters, and the SHELL decides the scheme, the host, the path, the `?`, the parameter's name
 * and whether this key may carry one at all — refusing a value that is not challenge-shaped rather
 * than opening the page without it, because a page opened without the commitment mints an UNBOUND
 * code while this app goes on holding a verifier.
 *
 * Omitted for every other place, and the field is then absent from the payload rather than sent
 * empty: the shell's `Option<String>` and "no such parameter" are the same fact, and a caller that
 * always sent the key would make the exception look like the rule.
 */
export async function openWeb(place: WebPlace, challenge?: string): Promise<void> {
  const shell = internals();
  if (!shell) return;
  await shell.invoke(OPEN_COMMAND, challenge ? { key: place, challenge } : { key: place });
}

interface TauriInternals {
  invoke(command: string, payload?: Record<string, unknown>, options?: unknown): Promise<unknown>;
  transformCallback(callback: (payload: unknown) => void, once?: boolean): number;
}

function internals(): TauriInternals | null {
  const host = globalThis as { __TAURI_INTERNALS__?: Partial<TauriInternals> };
  const found = host.__TAURI_INTERNALS__;
  if (typeof found?.invoke !== "function" || typeof found?.transformCallback !== "function") {
    return null;
  }
  return found as TauriInternals;
}

/**
 * Which view a `menu:navigate` payload names, or null when it names none.
 *
 * A closed union and not a cast. The payload crosses a process boundary, and a shell one version
 * ahead of this bundle could name a view that does not exist here — navigating to it would put
 * the client on its fallback route, which looks like the menu item going to the wrong place.
 * Null is "this window does not know that one", and the caller does nothing.
 */
export function viewOfMenuPayload(payload: unknown): MenuView | null {
  return oneOf(payload, MENU_VIEWS);
}

/**
 * Which command a `menu:command` payload names, or null when it names none.
 *
 * The same closed-union rule as {@link viewOfMenuPayload} and separate from it for the reason
 * `menu.rs` gives: an unknown VIEW and an unknown COMMAND are different facts, and folding both
 * into one union would let a shell one version ahead turn a command this bundle has never heard
 * of into a navigation to a route it does not have.
 */
export function commandOfMenuPayload(payload: unknown): MenuCommand | null {
  return oneOf(payload, MENU_COMMANDS);
}

/** The string a menu event carried, if it is one of `allowed`. */
function oneOf<T extends string>(payload: unknown, allowed: readonly T[]): T | null {
  const raw =
    typeof payload === "string"
      ? payload
      : typeof (payload as { payload?: unknown } | null)?.payload === "string"
        ? ((payload as { payload: string }).payload)
        : null;
  if (raw === null) return null;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

/**
 * Run `go` whenever the menu asks for a view. Resolves once the shell has the listener.
 *
 * Never rejects on a missing shell: this bundle is also loaded outside the app (a development
 * server, the render check), and a menu that is not there is not a failure — there is simply
 * nothing to listen to. A shell that IS there and refuses the listen does reject, because that
 * is a capability that was not granted and the app is quietly missing half its menu.
 */
export async function onMenuNavigate(go: (view: MenuView) => void): Promise<void> {
  await listen(MENU_NAVIGATE_EVENT, viewOfMenuPayload, go);
}

/**
 * Run `run` whenever the menu asks for a command. Same contract as {@link onMenuNavigate}.
 */
export async function onMenuCommand(run: (command: MenuCommand) => void): Promise<void> {
  await listen(MENU_COMMAND_EVENT, commandOfMenuPayload, run);
}

/**
 * The handoff code a `link:code` payload carried, or null when it carried none.
 *
 * ── WHY THIS ONE IS NOT A CLOSED UNION, UNLIKE THE TWO ABOVE ────────────────────────────────
 *
 * A menu payload names one of a list this bundle knows, so an unknown name is refused. A handoff
 * code is a server-minted opaque string, and a shape assertion here would be a second, quieter
 * definition of what the account issues — one that keeps working until the issuer changes and then
 * refuses every valid code with a sentence nobody can see. `doors.ts` declines the same assertion
 * for the same reason, and the shell's own parser has already refused every link that is not
 * exactly `ohmail://link?code=…`.
 *
 * So what is checked here is what a TYPE cannot be trusted for across a process boundary: that it
 * is a non-empty string. Everything else is the engine's answer to make.
 */
export function codeOfLinkPayload(payload: unknown): string | null {
  const raw =
    typeof payload === "string"
      ? payload
      : typeof (payload as { payload?: unknown } | null)?.payload === "string"
        ? (payload as { payload: string }).payload
        : null;
  const code = raw === null ? "" : raw.trim();
  return code.length > 0 ? code : null;
}

/**
 * ONE SHELL-SIDE LISTENER FOR THE LIFE OF THE WINDOW, and the latest handler wins.
 *
 * ── WHY THIS IS NOT THE SAME SHAPE AS THE MENU'S TWO ────────────────────────────────────────
 *
 * `onMenuNavigate` and `onMenuCommand` are registered once by `DesktopGate`, which mounts once, so
 * a plain registration is correct there. The sign-in screen is different: it is mounted whenever
 * somebody picks the hosted door and unmounted when they go back, which can happen several times
 * in a session. Registering per mount would stack listeners in the SHELL, and every stale one
 * would fire on the next activation — each holding an old mount's props, so one code would be
 * submitted several times against different closures.
 *
 * Unregistering is not available and that is deliberate rather than an oversight: taking a listener
 * off costs `core:event:allow-unlisten`, a SECOND core permission for this window, and the window's
 * grant is one receive-only permission on purpose. So the registration happens once and the handler
 * is swapped behind it — which is the behaviour the screen wants anyway, since the mount a person
 * is looking at is the one that should answer.
 */
let linkCodeHandler: ((code: string) => void) | null = null;
let linkCodeListening = false;

/**
 * Run `run` when a scheme activation hands this window a handoff code.
 *
 * Same contract as {@link onMenuNavigate}: never rejects on a missing shell, because this bundle is
 * also loaded outside the app, and there is simply nothing to listen to there.
 */
export async function onLinkCode(run: (code: string) => void): Promise<void> {
  linkCodeHandler = run;
  if (linkCodeListening) return;
  linkCodeListening = true;
  await listen(LINK_CODE_EVENT, codeOfLinkPayload, (code) => linkCodeHandler?.(code));
}

/** Stop answering activations — the mount that registered is going away and none replaced it. */
export function offLinkCode(run: (code: string) => void): void {
  if (linkCodeHandler === run) linkCodeHandler = null;
}

/** One `plugin:event|listen`, shared by the two menu channels. */
async function listen<T>(
  event: string,
  parse: (payload: unknown) => T | null,
  run: (value: T) => void,
): Promise<void> {
  const shell = internals();
  if (!shell) return;
  const handler = shell.transformCallback((payload: unknown) => {
    const value = parse(payload);
    if (value !== null) run(value);
  });
  await shell.invoke("plugin:event|listen", {
    event,
    // Every target: the shell emits to the app, and this window is the only one there is.
    target: { kind: "Any" },
    handler,
  });
}

/**
 * Put one notice in the operating system's notification centre.
 *
 * The window composes the words and the shell shows them, which is the only arrangement that
 * works: the page has no notification permission and cannot ask for one under this CSP, and the
 * shell has no idea what a message is. A refusal — the user has notifications turned off for
 * ohmail, or the platform has none — comes back as a rejection and is the caller's to swallow;
 * a notification that could not be shown must never take a mail client down.
 *
 * NAMED `postOsNotice` AND NOT `notify`, WHICH IS WHAT IT USED TO BE. `notify` is also the
 * client-engine's subscriber callback, with dozens of call sites of that unrelated sense
 * across the shared sources. The census that enforces "nothing draws a notice outside an
 * emitter" has to key on a name, and a name meaning two things makes its output mostly false
 * positives — a guard whose result has to be hand-filtered is one nobody keeps. The Rust
 * command this invokes is still `notify`; only the binding was renamed.
 */
export async function postOsNotice(title: string, body: string): Promise<void> {
  const shell = internals();
  if (!shell) return;
  await shell.invoke(NOTIFY_COMMAND, { title, body });
}

/**
 * How many pieces of mail the icon should say are waiting.
 *
 * Clamped and floored here rather than at the command, so the number the window believes and
 * the number the icon shows are the same one. Zero means "take the badge off" — not "show a
 * zero", which is a badge that says there is nothing and is still a badge.
 */
export function badgeCount(unread: number): number {
  return Number.isFinite(unread) && unread > 0 ? Math.floor(unread) : 0;
}

/** Set (or, at zero, remove) the dock/taskbar badge. Silent without a shell. */
export async function setBadge(unread: number): Promise<void> {
  const shell = internals();
  if (!shell) return;
  await shell.invoke(BADGE_COMMAND, { count: badgeCount(unread) });
}

/**
 * Run `poke` whenever the shell announces a held mailto link. The payload is deliberately
 * ignored — whatever a stale or future shell put in it, the LINK travels only over the claim,
 * where it is parsed by `mailto.ts` under that parser's own contract.
 *
 * A plain registration, `onMenuNavigate`'s shape rather than `onLinkCode`'s: `DesktopGate`
 * registers this once and mounts once.
 */
export async function onMailto(poke: () => void): Promise<void> {
  await listen(MAILTO_EVENT, () => true, () => poke());
}

/**
 * Take the mailto link the shell is holding, if any — once. A second claim answers null, which
 * is what makes the warm path (poke → claim) and the cold path (mount → claim) safe to run
 * together: whichever asks first gets the link, the other gets nothing.
 */
export async function claimMailto(): Promise<string | null> {
  const shell = internals();
  if (!shell) return null;
  const raw = await shell.invoke(MAILTO_CLAIM_COMMAND);
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * What the OS says about its default mail app, in the shell's three-word vocabulary — and a
 * CLOSED union here, `viewOfMenuPayload`'s rule: a shell one version ahead answering a fourth
 * word must read as "unknown", never as a state this bundle invents a rendering for.
 */
export const DEFAULT_MAIL_STATES = ["default", "not-default", "unknown"] as const;
export type DefaultMailState = (typeof DEFAULT_MAIL_STATES)[number];

/** The shape a request took — which sentence the screen owes the person next. Closed, as above. */
export const DEFAULT_MAIL_HOWS = ["system-dialog", "settings-opened", "set"] as const;
export type DefaultMailHow = (typeof DEFAULT_MAIL_HOWS)[number];

function defaultMailStateOf(payload: unknown): DefaultMailState {
  const raw = (payload as { state?: unknown } | null)?.state;
  return typeof raw === "string" && (DEFAULT_MAIL_STATES as readonly string[]).includes(raw)
    ? (raw as DefaultMailState)
    : "unknown";
}

/**
 * Is ohmail this computer's mail app for mailto links? "unknown" covers every way of not
 * knowing — no shell, a command this shell does not have, a platform tool that would not
 * answer — because a surface that guessed either way would be lying to exactly the person
 * about to act on it.
 */
export async function defaultMailStatus(): Promise<DefaultMailState> {
  const shell = internals();
  if (!shell) return "unknown";
  try {
    return defaultMailStateOf(await shell.invoke(DEFAULT_MAIL_STATUS_COMMAND));
  } catch {
    return "unknown";
  }
}

/**
 * Ask the platform to make ohmail the default mail app, the way the platform allows — the
 * shell decides which that is (macOS's own consent dialog, the Windows Settings page,
 * `xdg-settings` on Linux) and answers with which it did (`how`) plus a fresh read.
 *
 * REJECTS with the shell's sentence when the platform refused; the caller shows it beside the
 * control, `DoorResult.problem`'s rule.
 */
export async function requestDefaultMail(): Promise<{
  how: DefaultMailHow | null;
  state: DefaultMailState;
}> {
  const shell = internals();
  if (!shell) throw new Error("There is no app shell to ask.");
  const answer = await shell.invoke(DEFAULT_MAIL_REQUEST_COMMAND);
  const rawHow = (answer as { how?: unknown } | null)?.how;
  const how =
    typeof rawHow === "string" && (DEFAULT_MAIL_HOWS as readonly string[]).includes(rawHow)
      ? (rawHow as DefaultMailHow)
      : null;
  return { how, state: defaultMailStateOf(answer) };
}
