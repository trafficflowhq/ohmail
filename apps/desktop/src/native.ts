/**
 * THE NATIVE CHROME, from the window's side: the menu bar, the OS notification centre, the
 * badge on the dock icon. All three are the SHELL's to perform — each is an event the shell
 * emits or a command it registers, and this file is the whole of what the window may say about
 * them. The MENU pushes: a chosen item arrives as one event with a view id, and navigation goes
 * through the same function the rail, palette and number keys use. NOTIFICATION and BADGE pull:
 * what counts as unread is a question about mail. The command channel is the runtime's own
 * global (`withGlobalTauri` is false); listening is `plugin:event|listen` under the one grant
 * `core:event:allow-listen`, and emitting is NOT granted — the window cannot make the shell hear.
 */

/** The event the shell emits when a navigation item is chosen from the menu. */
export const MENU_NAVIGATE_EVENT = "menu:navigate";

/** The event the shell emits when a COMMAND item is chosen — compose, settings, search, … */
export const MENU_COMMAND_EVENT = "menu:command";

/**
 * The event the shell emits when an `ohmail://link?code=…` activation arrives. A THIRD channel
 * rather than a third name on the menu's: the payloads are different kinds of value, each union
 * closed on its own terms — a menu payload is one of a fixed list this bundle knows; this one
 * is an opaque server-minted string this bundle deliberately does not pattern-check. Sharing an
 * event would let a shell one version ahead turn one into the other. What arrives is the
 * handoff CODE and never a token — the shell claims nothing; the window sends the code down
 * the same bridge the retyped one has always gone down.
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
 * The places on the web this app can open, named as PLACES and never as addresses. A hosted
 * account is administered on the web — plan, password, authenticator — so Settings needs a way
 * OUT to the browser, and the way out is deliberately not a URL: the window passes one of these
 * keys and the shell's own table decides what it means. Were a URL the argument, anything that
 * ever got a string into this page — a mail body, a display name, a sanitizer hole — could open
 * an arbitrary address in the user's real browser, signed in to everything. It also keeps this
 * bundle free of any host name at all, which is the claim the preview artifact is built on.
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
  // `devices` is Settings → Devices on the hosted door: the sessions signed into the account, the
  // pairing mint that puts its mail on a phone, and the take-back. Here for `mailboxes`' reason
  // said about a different pair of routes — `POST /pair` and `DELETE /devices/:id` are step-up
  // gated, and a desktop session is stamped with a factor exactly once, when its code was claimed.
  // A form here would collect a password and be refused, so the window offers the way out instead.
  "devices",
  // `link-desktop` is the odd one and worth naming: every other place here administers an
  // account this app is already serving, and this one is opened BEFORE there is a session — it
  // is the browser half of signing in, where the page mints a one-use code the person retypes
  // into the app. Same mechanism, same table, no exception to the no-URL rule.
  "link-desktop",
  "privacy", "subprocessors",
] as const;

export type WebPlace = (typeof WEB_PLACES)[number];

/**
 * Open one of {@link WEB_PLACES} in the user's own browser. Nothing is fetched here or by the
 * shell: the browser makes the request as itself. A refusal comes back as a rejection for the
 * caller to show. `challenge` IS A VALUE, AND STILL NOT A URL: the sign-in page needs the
 * public half of a PKCE pair whose secret half is in the engine's memory. This window passes
 * the place and the 43 characters; the SHELL decides scheme, host, path and parameter name —
 * refusing a value that is not challenge-shaped, because a page opened without the commitment
 * mints an UNBOUND code while this app goes on holding a verifier. Omitted for every other
 * place, absent rather than empty: the shell's `Option<String>` and "no parameter" are one fact.
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
 * The handoff code a `link:code` payload carried, or null when it carried none. NOT a closed
 * union like the two above: a menu payload names one of a known list, but a handoff code is a
 * server-minted opaque string — a shape assertion here would be a second, quieter definition of
 * what the account issues, working until the issuer changes and then refusing every valid code
 * with a sentence nobody can see. `doors.ts` declines the same assertion; the shell's parser
 * has already refused every link that is not exactly `ohmail://link?code=…`. What is checked is
 * what a TYPE cannot be trusted for across a process boundary: a non-empty string. The rest is
 * the engine's answer to make.
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
 * ONE SHELL-SIDE LISTENER FOR THE LIFE OF THE WINDOW, and the latest handler wins. The menu's
 * two are registered once by `DesktopGate`, which mounts once. The sign-in screen mounts
 * whenever somebody picks the hosted door and unmounts on the way back — registering per mount
 * would stack listeners in the SHELL, every stale one firing on the next activation with an
 * old mount's props, submitting one code several times against different closures.
 * Unregistering is deliberately unavailable: it would cost `core:event:allow-unlisten`, a
 * SECOND core permission, and the grant is one receive-only permission on purpose. So:
 * register once, swap the handler — the mount a person is looking at is the one that answers.
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
 * Put one notice in the operating system's notification centre. The window composes the words
 * and the shell shows them — the page has no notification permission under this CSP, and the
 * shell has no idea what a message is. A refusal (notifications off, a platform without them)
 * comes back as a rejection and is the caller's to swallow: a notice that could not be shown
 * must never take a mail client down. NAMED `postOsNotice`, NOT `notify`: `notify` is also the
 * client-engine's subscriber callback with dozens of unrelated call sites, and the census that
 * enforces "nothing draws a notice outside an emitter" keys on a name — one name meaning two
 * things makes its output mostly false positives. The Rust command is still `notify`.
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
