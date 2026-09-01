/**
 * THE APP'S OWN UPDATE, from the window's side of it.
 *
 * The updater is Rust (`src-tauri/src/updater.rs`) and stays there: this process makes one pinned
 * HTTPS request, minisign-verifies every payload against the key compiled into the binary, refuses
 * anything that is not strictly newer than the running build, and installs only on a press. None
 * of that moves here. What moves here is the AFFORDANCE — a settings pane that can say what the
 * app knows and ask for a check — and it exists because the menu bar is not always there.
 *
 * ── WHY A SETTINGS PANE AT ALL, WHEN THE MENU ITEM ALREADY DID THIS ─────────────────────────
 *
 * On a tiling Wayland compositor the app draws no menu bar (`src-tauri/src/frame.rs`), so on those
 * desktops "Check for Updates…" in the bar is an affordance nobody can reach. A person who cannot
 * find out whether their mail client is current, on a build whose whole update story is one signed
 * feed, is a person who will not update. Settings is where an app's own facts belong anyway, and
 * the version was already there.
 *
 * ── WHAT CROSSES THE BOUNDARY, WHICH IS AS LITTLE AS BEFORE ────────────────────────────────
 *
 * Two commands, neither taking an argument. {@link updateState} READS the flow's own value — the
 * installed version, the stage, what the last check found and when. {@link updatePress} does
 * exactly what picking the menu item does, and the shell decides what that means in the stage it
 * is in: start a check, or restart into a payload it already fetched and verified. There is no
 * "install" verb and no way to name a feed, a version or a file; a window that could would be a
 * window that had been handed the updater, which is the one thing this design has always refused.
 *
 * The push half is the `updater://state` event over the one receive-only
 * `core:event:allow-listen` grant the menu already uses — the shell can make this window hear
 * things and this window cannot make the shell hear anything. Both halves exist for
 * `mailto_claim`'s cold-start reason: the launch check runs before this bundle's scripts do, so a
 * pane that only listened would open blank after the transition it cared about had already
 * happened. It ASKS at mount and listens afterwards.
 *
 * ── AND EVERY PARSE IS HERE, NOT AT THE CALL SITE ──────────────────────────────────────────
 *
 * The payload crosses a process boundary from a shell that may be one version ahead of this
 * bundle. A state name this file does not know degrades to "unknown", which the pane renders as
 * the version it is running and a button that still works — never to a thrown render.
 */

/** The event the shell emits whenever the update flow moves. Spelled again in `updater.rs`. */
export const UPDATE_STATE_EVENT = "updater://state";

/** The two commands the shell registers for this file. */
const STATE_COMMAND = "update_state";
const PRESS_COMMAND = "update_press";

/**
 * Where the flow is. The same five the Rust `Stage` has, plus the honest sixth for a payload this
 * bundle does not recognise — a shell one version ahead naming a stage that did not exist when
 * this window was built.
 */
export const UPDATE_STATES = [
  "idle",
  "checking",
  "downloading",
  "ready",
  "failed",
  "unknown",
] as const;

export type UpdateState = (typeof UPDATE_STATES)[number];

/**
 * What the LAST COMPLETED CHECK found — a different question from the state, and the reason it is
 * asked separately is that two of its answers share one state. A client that is up to date and a
 * client that REFUSED an update it could not identify are both `idle`, and telling somebody they
 * are up to date in the second case is untrue: an update exists and this app will not install it.
 * `never` is a window that has not seen a check finish yet, which is not the same as "up to date"
 * either.
 */
export const UPDATE_RESULTS = ["never", "upToDate", "refused", "failed", "offered"] as const;

export type UpdateResult = (typeof UPDATE_RESULTS)[number];

export interface UpdateReport {
  /** The build running in this window. */
  version: string;
  state: UpdateState;
  /** The version being fetched or waiting, in the two states that have one. */
  offered: string | null;
  /** Whether a press would start a check. False while one is running and while a payload waits. */
  canCheck: boolean;
  /** Whether a press would restart into a verified payload. */
  canInstall: boolean;
  /** Unix milliseconds, or null when no check has finished in this run. */
  lastCheckedAt: number | null;
  lastResult: UpdateResult;
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

/** One member of `allowed`, or null. The closed-union rule `native.ts` states. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * The report a payload carried, or null when it carried nothing usable.
 *
 * Accepts the value itself or the event envelope (`{ payload }`), `native.ts`'s rule — the pull
 * answers one shape and the push the other, and one parser owns both so they cannot drift.
 *
 * A MISSING VERSION IS THE ONE FATAL FIELD, and deliberately: every other slot has an honest
 * fallback ("unknown", null, "never", a disabled button), but a pane that cannot name the build
 * it is running in is a pane with nothing true left to say, and rendering a blank version reads
 * as a bug in the app rather than as a shell that answered oddly.
 */
export function reportOfPayload(payload: unknown): UpdateReport | null {
  let raw = payload as Record<string, unknown> | null;
  if (raw !== null && typeof raw === "object" && typeof raw.version !== "string") {
    raw = (raw as { payload?: unknown }).payload as Record<string, unknown> | null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  if (version === "") return null;
  return {
    version,
    state: oneOf(raw.state, UPDATE_STATES) ?? "unknown",
    offered: typeof raw.offered === "string" && raw.offered !== "" ? raw.offered : null,
    canCheck: raw.canCheck === true,
    canInstall: raw.canInstall === true,
    lastCheckedAt:
      typeof raw.lastCheckedAt === "number" && Number.isFinite(raw.lastCheckedAt)
        ? raw.lastCheckedAt
        : null,
    lastResult: oneOf(raw.lastResult, UPDATE_RESULTS) ?? "never",
  };
}

/**
 * Ask the shell where the update flow is.
 *
 * Null outside the app — a development server, the render check, and the interface-preview build
 * whose window is granted no command at all. The pane renders nothing in that case rather than an
 * update control with nothing behind it, which is the one thing a settings surface must never be.
 */
export async function updateState(): Promise<UpdateReport | null> {
  const shell = internals();
  if (!shell) return null;
  try {
    return reportOfPayload(await shell.invoke(STATE_COMMAND));
  } catch {
    /* An older shell without the command, or a grant that dropped it. Same answer as no shell:
       there is no update surface to draw, which is honest and is not an error to report. */
    return null;
  }
}

/**
 * Press it. What that means is the shell's to decide — a check, or a restart into a payload it has
 * already fetched and verified — and this window deliberately does not model the difference twice.
 *
 * Resolves when the shell has taken the press, which is not when the check has finished: the
 * outcome arrives on {@link onUpdateState}. A rejection is the caller's to swallow; a press that
 * did not land must never take a mail client down.
 */
export async function updatePress(): Promise<void> {
  const shell = internals();
  if (!shell) return;
  await shell.invoke(PRESS_COMMAND);
}

/* ── ONE REGISTRATION FOR THE PROCESS, MANY SUBSCRIBERS ────────────────────────────────────────
 *
 * `plugin:event|listen` HAS NO UNLISTEN on this seam. `native.ts` records that as a deliberate
 * limitation and answers it with a rule — register once, from a component that mounts once — which
 * is the right answer for the sign-in screen and the WRONG one here: Settings → About is opened and
 * closed as often as somebody likes, and a registration per mount would hand the shell a new
 * callback every visit, keep every previous mount's closure alive, and call all of them on every
 * transition. So the registration is the MODULE's, made at most once and never taken back, and the
 * component's subscription is an ordinary set membership it can leave.
 *
 * `listening` is the latch. It is a promise rather than a boolean so a second mount arriving while
 * the first registration is still in flight waits for the same one instead of starting another, and
 * `register` swallows its own failures so the latch can never become a rejected promise every later
 * caller re-throws. */
const subscribers = new Set<(report: UpdateReport) => void>();
let listening: Promise<void> | null = null;

async function register(): Promise<void> {
  const shell = internals();
  if (!shell) return;
  const handler = shell.transformCallback((payload: unknown) => {
    const report = reportOfPayload(payload);
    if (report === null) return;
    // A copy, so a subscriber that unsubscribes while being told does not disturb the walk.
    for (const show of [...subscribers]) show(report);
  });
  try {
    await shell.invoke("plugin:event|listen", {
      event: UPDATE_STATE_EVENT,
      // Every target: the shell emits to the app, and this window is the only one that listens.
      target: { kind: "Any" },
      handler,
    });
  } catch {
    /* An older shell, or a grant that dropped the listen permission: no live updates. The pane
       still pulls at mount and after every press, so it is stale rather than blank. */
  }
}

/**
 * Run `show` whenever the flow moves, and hand back the way to stop.
 *
 * Never rejects on a missing shell, `native.ts`'s rule: this bundle is also loaded outside the app,
 * and a shell that is not there is not a failure — there is simply nothing to listen to. The
 * returned function is safe to call in either case and safe to call twice.
 */
export async function onUpdateState(
  show: (report: UpdateReport) => void,
): Promise<() => void> {
  subscribers.add(show);
  listening ??= register();
  await listening;
  return () => {
    subscribers.delete(show);
  };
}

/** Tests only: forget the registration so each test drives a fresh one. `omarchy.ts`'s seam. */
export function resetUpdateFeedForTests(): void {
  subscribers.clear();
  listening = null;
}

/**
 * Tests only: how many subscribers are held.
 *
 * A SEAM RATHER THAN AN ASSERTION ABOUT WHAT IS ON SCREEN, and the difference is the whole reason
 * it exists. A leaked subscriber from a closed pane still RUNS on every transition; it simply does
 * nothing visible, because the component guards its setter with a mounted flag. So a test written
 * against the rendered markup passes whether or not the subscription was released — it was, and it
 * was watched passing against a version that never released one. The count is the fact.
 */
export function subscriberCountForTests(): number {
  return subscribers.size;
}

/**
 * The one sentence the pane leads with, as a message KEY rather than a string.
 *
 * Pure, and the whole of the mapping from what the shell knows to what a person reads — so the
 * five states and the two that share one are driven by a test rather than described by a comment.
 * Keys and not sentences because the copy is translated and the decision is not.
 *
 * The order is deliberate: what is HAPPENING beats what last happened. A check running now is
 * more useful than "checked two minutes ago", and a payload waiting is more useful than either.
 */
export function updateSentenceKey(report: UpdateReport): string {
  switch (report.state) {
    case "checking":
      return "checking";
    case "downloading":
      return "downloading";
    case "ready":
      return "ready";
    case "failed":
      return "failed";
    // `idle` and `unknown` are both "nothing in flight", and what is worth saying then is what the
    // last check found. A shell one version ahead in a state this bundle cannot name still has a
    // true last result to report, which is why `unknown` lands here rather than on its own line.
    default:
      switch (report.lastResult) {
        case "upToDate":
          return "upToDate";
        case "refused":
          return "refused";
        case "failed":
          return "failed";
        // `offered` with nothing in flight means a check found something and the flow has since
        // gone quiet — a deferred payload, or a download that ended. There is nothing true to
        // claim about currency, so the pane says what it can: it has not been established.
        default:
          return "unchecked";
      }
  }
}

/**
 * What the button says, as a message key — or null when there is nothing to press.
 *
 * `canCheck` and `canInstall` come from the shell's own `Flow::press`, so this cannot offer a
 * press the menu item has disabled. Both false is a check or a download already running, and the
 * honest control then is a disabled one rather than a live button that does nothing.
 */
export function updateButtonKey(report: UpdateReport): string | null {
  if (report.canInstall) return "restart";
  if (report.canCheck) return "check";
  return null;
}
