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

/** The commands the shell registers for this file. Named once so a typo is one place. */
const NOTIFY_COMMAND = "notify";
const BADGE_COMMAND = "set_badge";
const OPEN_COMMAND = "open_link";

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
 */
export async function openWeb(place: WebPlace): Promise<void> {
  const shell = internals();
  if (!shell) return;
  await shell.invoke(OPEN_COMMAND, { key: place });
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
 */
export async function notify(title: string, body: string): Promise<void> {
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
