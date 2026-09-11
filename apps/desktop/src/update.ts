/**
 * THE APP'S OWN UPDATE, from the window's side. The updater is Rust
 * (`src-tauri/src/updater.rs`) and stays there: one pinned HTTPS request, minisign
 * verification against the compiled-in key, strictly-newer guard, install only on a press.
 * What moves here is the AFFORDANCE: on a tiling Wayland compositor the app draws no menu bar
 * (`src-tauri/src/frame.rs`), so "Check for Updates…" there is unreachable, and Settings is
 * where the app's own facts belong. Three argument-less commands cross: `updateState` reads
 * the flow's value, `updatePress` does what the menu item does, `updatePoll` starts the launch
 * check's request without a press's dialogs. No "install" verb; no feed, version or file names.
 */

/*
 * The push half is the `updater://state` event over the one receive-only
 * `core:event:allow-listen` grant — the shell can make this window hear things, never the
 * reverse. Both halves exist for `mailto_claim`'s cold-start reason: the launch check runs
 * before this bundle's scripts do, so a pane that only listened would open blank. It ASKS at
 * mount and listens afterwards. Every parse is HERE, not at the call site: the shell may be a
 * version ahead, and a state name this file does not know degrades to "unknown" — the pane
 * renders the running version and a working button, never a thrown render.
 */

/** The event the shell emits whenever the update flow moves. Spelled again in `updater.rs`. */
export const UPDATE_STATE_EVENT = "updater://state";

/** The three commands the shell registers for this file. */
const STATE_COMMAND = "update_state";
const PRESS_COMMAND = "update_press";
const POLL_COMMAND = "update_poll";

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

/**
 * HOW THIS COPY WAS INSTALLED — the shell's `InstallKind`, the reason this pane can say
 * something true on a copy that will never be offered an update. Only three kinds replace
 * their own files: the AppImage, the Windows setup and the macOS bundle. A `.deb`, an `.rpm`
 * and a Flatpak cannot, so the shell does not ask the feed on them at all — `idle` + `never`
 * is the permanent state there, and the sentence has to come from the kind rather than the
 * flow. `unknown` is a shell that did not name one (older, or a version ahead) and reads as
 * "nothing special", keeping this bundle's behaviour on such a shell what it was.
 */
export const INSTALL_KINDS = [
  "appimage",
  "deb",
  "rpm",
  "linuxPackage",
  "flatpak",
  "windowsSetup",
  "macBundle",
  "unpackaged",
  "unknown",
] as const;

export type InstallKind = (typeof INSTALL_KINDS)[number];

/**
 * The sentence each install that cannot update itself leads with, by message key.
 *
 * A table rather than a boolean, because the three doors are different places: a package manager,
 * a software centre, and — for a build from source or an unpacked AppImage — nowhere but a fresh
 * download. A copy told to look in the wrong one has been sent somewhere the release is not.
 */
export const MANAGED_SENTENCE_KEYS: Partial<Record<InstallKind, string>> = {
  deb: "managedPackage",
  rpm: "managedPackage",
  linuxPackage: "managedPackage",
  flatpak: "managedFlatpak",
  unpackaged: "managedUnpackaged",
};

/** Is this install updated by something other than ohmail? */
export function updateManagedElsewhere(report: UpdateReport): boolean {
  return MANAGED_SENTENCE_KEYS[report.installKind] !== undefined;
}

export interface UpdateReport {
  /** The build running in this window. */
  version: string;
  state: UpdateState;
  /** How this copy was installed, and so whether an update could ever be installed from here. */
  installKind: InstallKind;
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
 * The report a payload carried, or null when it carried nothing usable. Accepts the value
 * itself or the event envelope (`{ payload }`), `native.ts`'s rule — the pull answers one
 * shape and the push the other, and one parser owns both so they cannot drift. A MISSING
 * VERSION IS THE ONE FATAL FIELD, deliberately: every other slot has an honest fallback
 * ("unknown", null, "never", a disabled button), but a pane that cannot name the build it
 * runs in has nothing true left to say, and a blank version reads as a bug in the app.
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
    /* A kind this bundle does not know degrades to "unknown", which is the SAFE side: it drops
       this window back to the sentences the flow alone decides, rather than claiming a door
       nobody named. */
    installKind: oneOf(raw.installKind, INSTALL_KINDS) ?? "unknown",
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

/**
 * Ask the shell to CHECK, on nobody's behalf — the launch check's own path, on a schedule.
 * NOT {@link updatePress}: a press is a person asking, and the shell answers a person OUT
 * LOUD — an up-to-date dialog, an error with Try-again, or the progress window — each right
 * for somebody facing dead air and each wrong once a day, forever; a cadence through the
 * press would put a modal over somebody's mail every twenty-four hours. The shell cannot tell
 * the two apart from the call (`update_press` takes no argument, by design), so the
 * difference is a second command rather than a flag — it also names nothing and installs
 * nothing. Rejects on a shell too old to have it — a press that did not land.
 */
export async function updatePoll(): Promise<void> {
  const shell = internals();
  if (!shell) return;
  await shell.invoke(POLL_COMMAND);
}

/* ── ONE REGISTRATION FOR THE PROCESS, MANY SUBSCRIBERS ────────────────────────────────────────
 * `plugin:event|listen` has no unlisten on this seam. `native.ts`'s rule — register once, from
 * a component that mounts once — is right for the sign-in screen and WRONG here: Settings →
 * About opens and closes freely, and a registration per mount would hand the shell a new
 * callback every visit, keep every previous mount's closure alive, and call all of them on
 * every transition. So the registration is the MODULE's, made at most once and never taken
 * back; a component's subscription is ordinary set membership it can leave. `listening` is a
 * promise, not a boolean, so a second mount mid-flight waits for the same registration; and
 * `register` swallows its own failures so the latch can never become a rejected promise. */
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
  /* THE INSTALL BEATS THE FLOW, and it has to: on a copy the shell will not check for, the flow
     stays `idle` with no check ever recorded, and "no update check has finished yet" would read
     as a fault where the truth is that this copy is updated somewhere else. */
  const managed = MANAGED_SENTENCE_KEYS[report.installKind];
  if (managed !== undefined) return managed;
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
