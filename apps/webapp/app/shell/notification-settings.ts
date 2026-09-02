/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE NOTIFICATION SWITCHES — stored per device, because delivery is a fact about a device
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The DECISION lives in `@ohmail/client-engine`'s gate; this is the state the gate is handed,
 * plus the one thing the gate deliberately does not model — what the operating system says.
 *
 * ── WHY `install` REACH AND NOT `account` ─────────────────────────────────────────────────
 *
 * `LocaleContext` already had to answer "how far does this choice reach", and its answer is the
 * one this file copies: the row SAYS which, because the two hosts differ and a claim that is
 * right on one surface is false on the other.
 *
 * For notifications the answer is `install` on every surface, and that is a ruling rather than a
 * shortcut. Whether a notice may be drawn at all is the OS's answer, per device, and it cannot be
 * carried anywhere — a phone that granted permission says nothing about a laptop that refused.
 * Wanting mail to interrupt you on your phone and not on your work laptop is the ordinary case,
 * not an edge one. So these switches are about THIS device's delivery, the pane says so, and
 * nothing here travels.
 *
 * That leaves the mailbox-as-master invariant intact, because it was never about delivery: the
 * per-SENDER notification opt-ins (`notifyRules`) do travel, in the organizer profile, and are a
 * different thing from "does this laptop make a sound".
 *
 * ── WHY `localStorage` IS THE RIGHT STORE HERE AND NOT A COMPROMISE ───────────────────────
 *
 * `LocaleContext` again: "the desktop — `localStorage` IS the persistence. That is the desktop on
 * BOTH its doors." A per-install preference has no other home on a standalone build, which has no
 * account to write to. Using the same store on every surface keeps one code path.
 *
 * Every read is defensive: a blocked or absent `localStorage` throws, and a settings pane that
 * cannot read a preference must render the DEFAULTS rather than fail. Note the failure direction
 * is deliberate — see {@link readChannels}.
 */
import {
  DEFAULT_CHANNELS,
  type NoticePermission,
  type NotificationChannels,
} from "@ohmail/client-engine";

/** One key, one JSON object — so a partial write cannot leave two switches disagreeing. */
export const NOTIFICATION_CHANNELS_KEY = "ohmail.notifications.channels";

/**
 * Read this install's switches, falling back to {@link DEFAULT_CHANNELS}.
 *
 * **A FAILED READ READS AS THE DEFAULTS, NOT AS OFF, AND NOT AS ON.** The defaults are what a
 * fresh install believes, so a browser with storage blocked behaves like a fresh install rather
 * than like an account that turned everything off — the alternative silently disables a feature
 * the user enabled, with nothing on screen to explain it.
 *
 * Unknown keys are dropped and missing ones defaulted, field by field: a catalogue written by a
 * newer build must not make an older one throw, and a boolean that is not a boolean is not a
 * preference.
 */
export function readChannels(): NotificationChannels {
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(NOTIFICATION_CHANNELS_KEY) ?? null;
  } catch {
    return { ...DEFAULT_CHANNELS };
  }
  if (raw === null) return { ...DEFAULT_CHANNELS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_CHANNELS };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_CHANNELS };
  const src = parsed as Record<string, unknown>;
  const out = { ...DEFAULT_CHANNELS };
  for (const k of Object.keys(DEFAULT_CHANNELS) as (keyof NotificationChannels)[]) {
    if (typeof src[k] === "boolean") out[k] = src[k] as boolean;
  }
  return out;
}

/**
 * Write them. Best-effort by construction: a blocked store is not a reason to refuse the press,
 * because the switch still governs this session and the pane still reads back what it holds.
 */
export function writeChannels(next: NotificationChannels): void {
  try {
    globalThis.localStorage?.setItem(NOTIFICATION_CHANNELS_KEY, JSON.stringify(next));
  } catch {
    /* Storage blocked or full. The in-memory value still drives this session. */
  }
}

/**
 * WHAT THE PLATFORM SAYS, normalized to the gate's four states.
 *
 * A host that is not a browser — the desktop shell, whose webview cannot hold the permission and
 * asks the shell instead — supplies its own reader; see {@link NotificationHost}. The browser
 * path is here because it is the only one that needs no injection.
 *
 * `unsupported` and `denied` are DIFFERENT and are never collapsed: "this platform has no
 * notification centre" is a fact about the machine and hides the controls, while "you refused" is
 * a fact about a decision somebody made and must be reported with the place to change it.
 */
export function browserPermission(): NoticePermission {
  const N = (globalThis as { Notification?: { permission?: string } }).Notification;
  if (N === undefined || typeof N.permission !== "string") return "unsupported";
  switch (N.permission) {
    case "granted": return "granted";
    case "denied": return "denied";
    default: return "default";
  }
}

/**
 * The seam every host fills. Two functions and no state: the pane owns the state, the host owns
 * the platform.
 *
 * `request` returns the state AFTER asking, so the pane re-renders from one answer rather than
 * reading a value the ask may not have committed yet. A host whose platform cannot ask returns
 * its current state unchanged.
 */
export interface NotificationHost {
  permission: () => NoticePermission;
  request: () => Promise<NoticePermission>;
}

/**
 * The browser host. Asking is ONLY ever done from a user gesture — the master switch's press —
 * because a permission prompt on page load is the behaviour browsers punish with a permanent
 * block, and one that is refused can never be asked for again.
 */
export const browserNotificationHost: NotificationHost = {
  permission: browserPermission,
  request: async () => {
    const N = (globalThis as {
      Notification?: { permission?: string; requestPermission?: () => Promise<string> };
    }).Notification;
    if (N === undefined || typeof N.requestPermission !== "function") return "unsupported";
    try {
      const answer = await N.requestPermission();
      return answer === "granted" ? "granted" : answer === "denied" ? "denied" : "default";
    } catch {
      // A platform that refuses to answer is reported as `default` and never as `denied`: we do
      // not know that the user said no, and claiming they did puts a wrong sentence on screen.
      return "default";
    }
  },
};
