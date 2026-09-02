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
import { apiConfigured, push as pushApi } from "../api-client";

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
  /**
   * Bring this surface's wake registration into line with the switches, if it has one.
   *
   * OPTIONAL, and the desktop is why. That build has no push subscription and no server to hold
   * one — its shell is woken by its own engine — so it supplies no implementation and the pane
   * calls nothing. A required method would force a do-nothing stub there, which is a promise the
   * type makes and the surface does not keep.
   *
   * Never throws to the caller: a registration that could not be made is a browser that will not
   * be woken while closed, and that is not a reason to move a control the user set.
   */
  syncSubscription?: (wanted: boolean) => Promise<void>;
}

/**
 * The browser host. Asking is ONLY ever done from a user gesture — the master switch's press —
 * because a permission prompt on page load is the behaviour browsers punish with a permanent
 * block, and one that is refused can never be asked for again.
 */
export const browserNotificationHost: NotificationHost = {
  /**
   * Registration is attempted only where there is a server to register WITH. `apiConfigured()`
   * is false in every desktop build — its Cloud adapter is aliased out of the bundle — so this
   * is a no-op there even though the module is compiled in, the same guard `consent-state.ts`
   * uses for the same reason.
   */
  syncSubscription: async (wanted: boolean) => {
    if (!apiConfigured()) return;
    try {
      await syncWebPush(wanted, pushApi);
    } catch {
      /* Swallowed deliberately. Every outcome that MATTERS to the user is already on screen —
         the OS permission state and the stored switches — and a failed registration changes
         neither. Surfacing it as an error would report "notifications are broken" for a browser
         whose only loss is being woken while shut. */
    }
  },
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

/* ══════════════════════════════════════════════════════════════════════════════════════════
 *  BEING WOKEN WHILE THE BROWSER IS CLOSED — the subscription, and when it should exist
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * SHOULD THIS BROWSER HAVE A PUSH SUBSCRIPTION AT ALL?
 *
 * Pure, and separated from every call it drives, because it is the whole policy and the rest is
 * plumbing.
 *
 * Three conditions, and the third is the one worth explaining. A subscription exists ONLY to wake
 * a browser that is CLOSED. While a window is open the app syncs on its own and applies every
 * per-event switch with the mirror in front of it — no push is involved in any of that. So the
 * question this answers is narrower than "does the user want notifications": it is "is there
 * something worth starting this browser up for", and the only event that can happen with nothing
 * open, and that somebody would want their machine woken for, is new mail.
 *
 * Turning NEW MAIL off therefore drops the subscription, while the other three switches keep
 * working exactly as before for as long as a window is open. That is stated in the pane rather
 * than left to be discovered.
 *
 * The happy consequence is that "fully off" needs no cooperation from the push service: with the
 * master off there is no subscription, so the server has nothing to dial and no code path can
 * fire. Nothing is delivered-then-discarded.
 */
export function subscriptionWanted(
  channels: NotificationChannels,
  permission: NoticePermission,
): boolean {
  return permission === "granted" && channels.master && channels.ohbox;
}

/** Where the page leaves the service worker its words. Must match `public/sw.js`. */
export const NOTIFY_CACHE = "ohmail-notify-v1";
export const NOTIFY_STATE_URL = "/__ohmail_notify_state";

/**
 * Hand the service worker the sentence it may draw, in the user's own language.
 *
 * The worker never reads the push payload — a paired server must not be able to choose the words
 * that appear under ohmail's name — so the words have to come from here. `enabled: false` is
 * written rather than the entry being deleted, so a worker that reads a stale cache sees an
 * explicit "do not draw" instead of a miss it has to interpret.
 */
export async function writeNotifyState(
  enabled: boolean, title: string, body: string,
): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    const cache = await caches.open(NOTIFY_CACHE);
    await cache.put(
      NOTIFY_STATE_URL,
      new Response(JSON.stringify({ enabled, title, body }), {
        headers: { "content-type": "application/json" },
      }),
    );
  } catch {
    /* No Cache API, or storage refused. The worker then draws nothing, which is the safe way
       for this to fail: a missing state is read as "do not draw". */
  }
}

/** The three values a `PushSubscription` yields, base64url, as the server wants them. */
function subscriptionKeys(sub: PushSubscription): { p256dh: string; auth: string } | null {
  const p = sub.getKey("p256dh");
  const a = sub.getKey("auth");
  if (p === null || a === null) return null;
  const b64url = (buf: ArrayBuffer): string => {
    let s = "";
    for (const byte of new Uint8Array(buf)) s += String.fromCharCode(byte);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  return { p256dh: b64url(p), auth: b64url(a) };
}

/**
 * A VAPID public key arrives base64url; `PushManager.subscribe` wants the raw bytes.
 *
 * Returns an `ArrayBuffer` rather than a `Uint8Array`, and that is a type-level requirement
 * rather than a preference: a `Uint8Array` may be backed by a `SharedArrayBuffer`, which
 * `applicationServerKey` does not accept, so handing over the buffer itself is what typechecks
 * and what the API actually wants.
 */
function decodeVapidKey(base64url: string): ArrayBuffer {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return buf;
}

/** What a host needs to reach the server. Injected so this module names no route itself. */
export interface PushApi {
  vapidKey: () => Promise<{ publicKey: string | null }>;
  subscribe: (endpoint: string, p256dh: string, auth: string) => Promise<{ id: string }>;
  unsubscribe: (id: string) => Promise<void>;
}

/** Where the row id is remembered, so `unsubscribe` can name it after a reload. */
const SUBSCRIPTION_ID_KEY = "ohmail.notifications.subscriptionId";

/**
 * Bring this browser's subscription into line with the switches. Idempotent, and safe to call on
 * every change.
 *
 * Returns what actually happened, so a caller can render a refusal rather than a silent nothing:
 * `"subscribed"`, `"unsubscribed"`, `"unchanged"`, or `"no_server_key"` — that last one is a
 * deployment with no VAPID keypair, which is a supported configuration and not an error.
 *
 * **Every failure leaves the switches alone.** A subscription that could not be created is a
 * browser that will not be woken while closed; it is not a reason to flip a control the user set,
 * and the pane says which state it is in from the OS and the store, never from this.
 */
export async function syncWebPush(
  wanted: boolean, api: PushApi,
): Promise<"subscribed" | "unsubscribed" | "unchanged" | "no_server_key" | "unsupported"> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return "unsupported";
  const reg = await navigator.serviceWorker.register("/sw.js");
  const existing = await reg.pushManager.getSubscription();

  if (!wanted) {
    if (existing === null) return "unchanged";
    let id: string | null = null;
    try { id = globalThis.localStorage?.getItem(SUBSCRIPTION_ID_KEY) ?? null; } catch { id = null; }
    // LOCAL FIRST, then the server. Unsubscribing locally is what actually stops the browser
    // being woken; the server row is tidied after. Doing it the other way round leaves a browser
    // still subscribed if the network call fails.
    await existing.unsubscribe();
    try { globalThis.localStorage?.removeItem(SUBSCRIPTION_ID_KEY); } catch { /* blocked store */ }
    if (id !== null) {
      // A failure here leaves a row the server will prune when its endpoint stops accepting.
      try { await api.unsubscribe(id); } catch { /* pruned later */ }
    }
    return "unsubscribed";
  }

  if (existing !== null) return "unchanged";
  const { publicKey } = await api.vapidKey();
  if (publicKey === null || publicKey.trim() === "") return "no_server_key";

  const sub = await reg.pushManager.subscribe({
    // REQUIRED by every browser that implements this, and honest here: the worker draws a notice
    // for exactly the case this subscription exists for. A silent-push subscription would be a
    // promise this code does not keep.
    userVisibleOnly: true,
    applicationServerKey: decodeVapidKey(publicKey.trim()),
  });
  const keys = subscriptionKeys(sub);
  if (keys === null) {
    // A subscription with no keys cannot be sealed to, and the sender refuses to send in the
    // clear. Undo it rather than leaving a registration nothing will ever use.
    await sub.unsubscribe();
    return "unsupported";
  }
  const { id } = await api.subscribe(sub.endpoint, keys.p256dh, keys.auth);
  try { globalThis.localStorage?.setItem(SUBSCRIPTION_ID_KEY, id); } catch { /* blocked store */ }
  return "subscribed";
}
