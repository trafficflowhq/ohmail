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
  /**
   * `opts.forceAnnounce` — do NOT accept a stored id as proof this browser owns the row.
   *
   * BOTH doors pass it, because both go through {@link applyWakeIntent}, which sets it
   * unconditionally.
   *
   * An earlier version of this sentence said the settings pane kept the cheap `unchanged`
   * shortcut, "because a person pressing a switch has already proved whose session it is". That
   * was true when it was written and false one commit later, and the reasoning was wrong as well
   * as the fact: a press proves the SESSION, never which account owns the registration already
   * live on this browser — which is the only question `unchanged` is being asked. A mount proves
   * even less.
   */
  syncSubscription?: (wanted: boolean, opts?: { forceAnnounce?: boolean }) => Promise<PushSyncOutcome | null>;
  /**
   * THIS SURFACE CANNOT READ THE OPERATING SYSTEM'S ANSWER — its shell asks on first use.
   *
   * Absent (the browser) means `permission()` IS the OS answer and the pane's three sentences
   * (`denied`, `unsupported`, `default`) describe it exactly. Set (the desktop) means
   * `permission()` answers a narrower question — may this window ask the shell — and the pane
   * therefore owes a sentence about who has the last word, because none of those three is true
   * and the switch would otherwise be the only thing on screen with an opinion.
   *
   * A FACT ABOUT THE HOST, not copy: the wording stays in the catalogue where every other
   * sentence on the pane lives. It exists because the released desktop had a master switch that
   * could not be turned on and said nothing at all — see `apps/desktop/src/notify-host.ts`.
   */
  osHoldsPermission?: boolean;
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
  syncSubscription: async (wanted: boolean, opts?: { forceAnnounce?: boolean }) => {
    /* `null` means "there was nothing to reconcile here", which is not the same as a failure and
       must not be rendered as one. `apiConfigured()` is false in every desktop build — its Cloud
       adapter is aliased out of the bundle — so this is a no-op there even though the module is
       compiled in, the same guard `consent-state.ts` uses for the same reason. */
    if (!apiConfigured()) return null;
    try {
      return await syncWebPush(wanted, pushApi, opts);
    } catch {
      /* `syncWebPush` maps every failure to an outcome, so this is the contract being wrong
         rather than a path that is expected. Reported as the state that is true either way: the
         server does not have a registration this browser can rely on. */
      return "not_registered";
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
export function writeNotifyStateUnchecked(
  enabled: boolean, title: string, body: string,
): Promise<void> {
  /* THROUGH THE SAME QUEUE AS THE SUBSCRIPTION, and that is the point rather than tidiness.
     These were two independent fire-and-forget writes, so a fast OFF/ON pair could land in
     either order: a stale `enabled: false` arriving after a later `enabled: true` leaves the
     worker refusing to draw for a browser that is subscribed and expecting notices, with nothing
     on screen to explain it. One queue makes call order the order they are applied in — and puts
     them in order relative to the subscription changes they accompany. */
  return serialize(() => writeNotifyStateNow(enabled, title, body));
}

/**
 * TELL THE WORKER TO DRAW NOTHING. The only writer a surface outside this module should reach for
 * to change the flag, and it cannot express the other direction.
 *
 * ── WHY THE ARMING WRITER IS NOT SIMPLY EXPORTED UNDER THE OBVIOUS NAME ───────────────────
 *
 * Arming has a precondition — a row the SERVER named for THIS session — and the precondition
 * lives in {@link applyWakeIntent}, not in the writer. When the ungated writer was called
 * `writeNotifyState`, it was the natural import, and BOTH doors that arm this browser reached for
 * it and armed on an INTENT instead: the shell's boot path, and the settings pane, each writing
 * `enabled: wanted` before anything had answered. On a shared browser that re-arms the worker for
 * the previous reader's still-live registration.
 *
 * Renaming is the cheap half of stopping that recurring: `writeNotifyStateUnchecked` is still
 * exported (its own behaviour is under test in `web-push-subscription.test.ts`, and this module
 * uses it), but it no longer reads like the thing to call. The census in
 * `settings-pane-rearms-wake.test.tsx` is the half that actually holds.
 */
export function disarmNotifyState(title: string, body: string): Promise<void> {
  return writeNotifyStateUnchecked(false, title, body);
}

async function writeNotifyStateNow(
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
    /* No Cache API, or storage refused. With no entry at all the worker draws nothing, which is
       the safe direction. The case this CANNOT make safe is a failed write over an OLDER entry
       that says `enabled: true` — the stale value survives and the worker would still draw. What
       stops that mattering is the subscription: an intent that turned to false drops it, so the
       server has no endpoint to dial and the worker is never entered. The two have to fail
       together for a notice to arrive after an OFF. */
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

/**
 * THE PREFIX SIGN-OUT SWEEPS, and the ruling that separates these two keys from the switches.
 *
 * `ohmail.notifications.channels` is a per-INSTALL preference and survives sign-out beside
 * `ohmail.theme` and `ohmail.face` — the header above is the whole argument for why, and it does
 * not change because somebody signed out: the OS permission it mirrors is a fact about this
 * machine, not about an account.
 *
 * The two keys below are NOT that. They are a server row's id and the address that row was made
 * for — both minted inside a signed-in session, both meaningless to the next account on this
 * browser, and the endpoint is a URL a push service will deliver to. Leaving them behind on a
 * shared machine is the case the sign-out census was written for, and it has a second, quieter
 * cost: a stale id makes {@link syncWebPushNow} answer "unchanged" for the NEXT account, which
 * would then never register and never be woken, with nothing on screen to explain it.
 *
 * One prefix rather than two entries because both keys share it by construction, and a sweep
 * that names a prefix cannot be half-updated when a third key joins them.
 */
export const NOTIFICATION_SUBSCRIPTION_PREFIX = "ohmail.notifications.subscription";

/** Where the row id is remembered, so `unsubscribe` can name it after a reload. */
const SUBSCRIPTION_ID_KEY = "ohmail.notifications.subscriptionId";
/**
 * And WHICH ENDPOINT that row was made for.
 *
 * A push service may replace a subscription on its own — the endpoint and the key pair both
 * change — and the browser is then holding a live subscription the server has never heard of,
 * while the stored row points at an address that no longer exists. Nothing throws: the server
 * keeps dialling a dead endpoint until it is pruned, and this browser is simply never woken
 * again. Comparing the stored endpoint against the live one is what turns that silent state into
 * an ordinary re-announcement on the next visit.
 */
const SUBSCRIPTION_ENDPOINT_KEY = "ohmail.notifications.subscriptionEndpoint";

/** What `syncWebPush` did, or why it could not. */
export type PushSyncOutcome =
  | "subscribed" | "unsubscribed" | "unchanged"
  | "no_server_key"        // this deployment has no VAPID keypair — supported, not an error
  | "unsupported"          // no service worker, or a subscription with no keys
  | "row_remains"          // the browser is unsubscribed; the server row could not be deleted
  | "not_registered";      // this browser holds a subscription the server never recorded

const readId = (): string | null => {
  try { return globalThis.localStorage?.getItem(SUBSCRIPTION_ID_KEY) ?? null; } catch { return null; }
};
const readEndpoint = (): string | null => {
  try { return globalThis.localStorage?.getItem(SUBSCRIPTION_ENDPOINT_KEY) ?? null; } catch { return null; }
};
/** Id and endpoint move together — a row is only ever meaningful with the address it was made for. */
const writeId = (id: string | null, endpoint?: string): void => {
  try {
    if (id === null) {
      globalThis.localStorage?.removeItem(SUBSCRIPTION_ID_KEY);
      globalThis.localStorage?.removeItem(SUBSCRIPTION_ENDPOINT_KEY);
    } else {
      globalThis.localStorage?.setItem(SUBSCRIPTION_ID_KEY, id);
      if (endpoint !== undefined) globalThis.localStorage?.setItem(SUBSCRIPTION_ENDPOINT_KEY, endpoint);
    }
  } catch { /* blocked store */ }
};

/**
 * ONE AT A TIME, IN THE ORDER THEY WERE ASKED FOR.
 *
 * Two presses in quick succession used to interleave: an ON that had not finished asking the
 * server for its key, and an OFF that then found no subscription to remove and reported
 * "unchanged" — after which the ON's `subscribe()` landed and the browser was registered with
 * every switch off. The mobile client already learned this and queues its wake mutations for the
 * same reason; this is that queue.
 *
 * Both arms of `then` are the operation, so a rejected predecessor still lets the next run.
 */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const next = chain.then(op, op);
  chain = next.catch(() => undefined);
  return next;
}

/**
 * Bring this browser's subscription into line with the switches. Idempotent, safe to call on
 * every change AND on mount, and serialized against itself.
 *
 * Returns what actually happened, so the pane can say a true sentence instead of a silent
 * nothing — `no_server_key` and `row_remains` are both states a person can act on.
 *
 * **It never throws and never moves a switch.** A registration that could not be made is a
 * browser that will not be woken while closed; that is not a reason to flip a control somebody
 * set. What it must not do is leave a state that cannot be recovered from, which is what the
 * three orderings below are about.
 */
export function syncWebPush(
  wanted: boolean, api: PushApi, opts?: { forceAnnounce?: boolean },
): Promise<PushSyncOutcome> {
  return serialize(() => syncWebPushNow(wanted, api, opts));
}

/**
 * DID THE SERVER ACTUALLY NAME A ROW?
 *
 * DEFENCE, NOT A KNOWN PATH — and the difference is worth stating, because an earlier version of
 * this comment asserted the path and was wrong about a neighbouring module.
 *
 * It claimed the cross-account endpoint conflict makes `POST /push/subscriptions` answer `{}`. It
 * does not: `push-service.ts` falls back to an account-scoped lookup and that lookup THROWS
 * `ServiceError("internal", 500, …)` when it misses, which the caller's own `catch` already maps
 * to `not_registered`. So the server does not hand back an id-less 201 today.
 *
 * The guard stays because it costs nothing and the failure it prevents is silent: `writeId`
 * treats only `null` as a removal, so an absent id would be stored as the literal string
 * `"undefined"` and the sync would report `subscribed` — a browser believing it holds a
 * registration under an id that names nothing, which never retries because every later call sees
 * a subscription. Reported instead as what is true either way.
 */
const namedRow = (id: unknown): id is string => typeof id === "string" && id.length > 0;

async function syncWebPushNow(
  wanted: boolean, api: PushApi, opts?: { forceAnnounce?: boolean },
): Promise<PushSyncOutcome> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return "unsupported";
  let reg: ServiceWorkerRegistration;
  let existing: PushSubscription | null;
  try {
    reg = await navigator.serviceWorker.register("/sw.js");
    existing = await reg.pushManager.getSubscription();
  } catch {
    return "unsupported";
  }

  if (!wanted) {
    const id = readId();
    if (existing === null) {
      /* NO LOCAL SUBSCRIPTION, BUT PERHAPS A ROW. A browser that cleared its site data, or a
         previous attempt that unsubscribed and then failed to delete, leaves an id with nothing
         under it. The row is what causes wakes, so it is still worth removing. */
      if (id === null) return "unchanged";
      try { await api.unsubscribe(id); writeId(null); return "unsubscribed"; }
      catch { return "row_remains"; }
    }
    /* LOCAL FIRST — unsubscribing here is what actually stops this browser being woken — but the
       server delete is attempted EVEN IF that throws. Returning early on a local failure used to
       leave both halves live: the browser still had its endpoint and the row still pointed at it. */
    let localGone = true;
    try { await existing.unsubscribe(); } catch { localGone = false; }
    if (id === null) return localGone ? "unsubscribed" : "row_remains";
    try {
      await api.unsubscribe(id);
      writeId(null);
      return localGone ? "unsubscribed" : "row_remains";
    } catch {
      /* THE ID SURVIVES A FAILED DELETE, and that is the whole point. Erasing it here made the
         row unreachable for ever: nothing else knows its name, so a retry could never be made and
         the server went on dialling an endpoint this browser had already dropped. Keeping it means
         the next OFF — or the mount reconciliation — tries again. */
      return "row_remains";
    }
  }

  if (existing !== null) {
    /* A LOCAL SUBSCRIPTION THE SERVER NEVER RECORDED. `subscribe()` can succeed and the POST
       after it fail; before this the result was permanent, because every later call saw a
       subscription and answered "unchanged" while no row existed and no wake could ever arrive.
       Re-announcing an endpoint the server already has is free — it dedupes on the endpoint — so
       the safe move is to announce it again rather than to assume. */
    const knownId = readId();
    /* THE STORED ROW MUST NAME THIS ENDPOINT. A rotation leaves both true at once — there IS a
       subscription and there IS a row — while they describe different addresses, which is the one
       case a bare id check reads as "nothing to do". */
    /*
     * ── `unchanged` IS NOT PROOF OF OWNERSHIP, AND THE BOOT PATH MAY NOT TAKE IT ──────────
     *
     * This shortcut attests that a STORED id matches the live endpoint. It says nothing about
     * WHICH ACCOUNT owns the row — and the browser cannot know that; only the server can.
     *
     * On a shared browser that matters. `sign-out.ts` awaits the revoke at :130 and sweeps
     * `NOTIFICATION_SUBSCRIPTION_PREFIX` at :182, strictly after — so an unload that beat the
     * local `unsubscribe()` (which runs inside that awaited call) necessarily beat the sweep too.
     * A's id AND A's endpoint both survive into B's session. Without `forceAnnounce` the boot
     * gets `unchanged`, reads it as "this browser owns a row", and re-arms the service worker for
     * a registration that is still A's.
     *
     * So the boot re-announces instead. It is cheap for the legitimate case — the POST dedupes on
     * the endpoint — and for a FOREIGN row the account-scoped lookup behind it cannot find one,
     * which is the refusal that keeps the worker dark.
     */
    if (!opts?.forceAnnounce && knownId !== null && readEndpoint() === existing.endpoint) {
      return "unchanged";
    }
    const keys = subscriptionKeys(existing);
    if (keys === null) return "unsupported";
    try {
      const { id } = await api.subscribe(existing.endpoint, keys.p256dh, keys.auth);
      if (!namedRow(id)) return "not_registered";
      /* The superseded row is dropped AFTER the new one exists, so a failure here never leaves
         this browser with no registration at all. A row for a dead endpoint is pruned by the
         sender anyway; a browser with none is simply never woken. */
      /* THE SAME ENDPOINT DEDUPES TO THE SAME ROW, so the ordinary boot re-announce leaves
         `knownId === id` and this arm does not fire. It is reached when the SERVER names a
         different row — an endpoint rotation — which is the case it was written for and not
         something `forceAnnounce` manufactures. */
      if (knownId !== null && knownId !== id) {
        try { await api.unsubscribe(knownId); } catch { /* pruned when its endpoint stops answering */ }
      }
      writeId(id, existing.endpoint);
      return "subscribed";
    } catch {
      return "not_registered";
    }
  }

  let publicKey: string | null;
  try { ({ publicKey } = await api.vapidKey()); } catch { return "not_registered"; }
  if (publicKey === null || publicKey.trim() === "") return "no_server_key";

  let sub: PushSubscription;
  try {
    sub = await reg.pushManager.subscribe({
      // REQUIRED by every browser that implements this, and honest here: the worker draws a notice
      // for exactly the case this subscription exists for. A silent-push subscription would be a
      // promise this code does not keep.
      userVisibleOnly: true,
      applicationServerKey: decodeVapidKey(publicKey.trim()),
    });
  } catch {
    return "not_registered";
  }
  const keys = subscriptionKeys(sub);
  if (keys === null) {
    // A subscription with no keys cannot be sealed to, and the sender refuses to send in the
    // clear. Undo it rather than leaving a registration nothing will ever use.
    try { await sub.unsubscribe(); } catch { /* nothing better to do */ }
    return "unsupported";
  }
  try {
    const { id } = await api.subscribe(sub.endpoint, keys.p256dh, keys.auth);
    if (!namedRow(id)) {
      /* Same rollback as the throw below, for the same reason: a local subscription with no row
         is the stuck state where every later call sees one and never retries the POST. */
      try { await sub.unsubscribe(); } catch { /* nothing better to do */ }
      return "not_registered";
    }
    writeId(id, sub.endpoint);
    return "subscribed";
  } catch {
    /* ROLL THE LOCAL HALF BACK. Leaving it subscribed with no row is the stuck state above —
       every later call would see a subscription and never retry the POST. Undoing it means the
       next attempt starts clean. */
    try { await sub.unsubscribe(); } catch { /* nothing better to do */ }
    return "not_registered";
  }
}


/* ══════════════════════════════════════════════════════════════════════════════════════════
 *  SIGNING OUT — the registration must not outlive the session that minted it
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * TAKE THIS BROWSER'S WAKE REGISTRATION DOWN. Called by `sign-out.ts`, on both its doors.
 *
 * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────────────────────
 *
 * The server's own sign-out prune is DEVICE-scoped: `logout` reads the session's `device_id` and
 * deletes the push rows carrying it. A browser ceremony mints no device row — `establish` only
 * auto-mints one for the desktop kinds — so a browser session's `device_id` is NULL, the prune
 * returns early, and the row survives the sign-out. The sender does not care: it selects on the
 * account and the transport, so it goes on POSTing a wake to this endpoint. Nothing unregisters
 * the push service either, so the endpoint keeps answering 2xx and the sender's prune-on-404/410
 * never fires. The row and the traffic are permanent, and the next person on a shared machine is
 * the one being woken for the previous account's mail.
 *
 * ── WHY THE CLIENT IS THE RIGHT PLACE, AND NOT A WIDER SERVER PREDICATE ───────────────────
 *
 * This browser is the only party that knows WHICH deviceless row is its own — it kept the id.
 * The server cannot: deleting every deviceless registration on the account at sign-out would
 * silently end another browser's notifications, which is why the prune deliberately does not
 * guess. `DELETE /push/subscriptions/:id` is account-scoped and already exists; naming the row
 * we minted is both the sharpest handle available and no new mechanism.
 *
 * ── THREE HALVES, BECAUSE ANY ONE OF THEM CAN FAIL ────────────────────────────────────────
 *
 * `syncWebPush(false, …)` unsubscribes LOCALLY and then deletes the row, in that order and each
 * independently of the other's failure. Whichever lands helps: a dropped local subscription makes
 * the endpoint answer 404/410, which is exactly the status the sender prunes on, so the row that
 * a failed DELETE left behind is collected on the next wake. The third half is the notify-state
 * entry — the only place the words a notice may draw are kept — set to `enabled: false` so that a
 * browser which somehow keeps both a live subscription and a live row still draws nothing.
 *
 * ── AND IT PUTS NO SENTENCE ON SCREEN, DELIBERATELY ───────────────────────────────────────
 *
 * Every other failure `signOut` reports is one the reader can act on (close the other tab, try
 * again). This one is not: there is no retry a signed-out browser could make — the credential
 * that authorized the DELETE is precisely what has just been revoked — and the residue collects
 * itself through the two halves above. A row that reported it could only worry somebody with no
 * action attached, which this product treats as its own small defect.
 *
 * Never throws. `apiConfigured()` is false in every desktop build (its Cloud adapter is aliased
 * out), so this is a no-op there; and callers' tests mock `../api-client`, where a missing export
 * would otherwise throw out of the guard itself and skip the rest of the sign-out.
 */
export async function revokeWakeRegistration(): Promise<PushSyncOutcome | null> {
  /*
   * ── BOUNDED, AND THE BOUND IS LOAD-BEARING ──────────────────────────────────────────────
   *
   * FOUND BY REVIEW, and it inverted this file's neighbour's central invariant — "the wipe runs
   * REGARDLESS". Two facts compose into a sign-out that never completes. Every call below goes
   * through the module-global {@link serialize} queue, so it cannot START until every op already
   * queued has settled; and the queued ops are `fetch`es with no timeout (`api-client.ts` passes
   * an undefined `signal`, and `fetch` has no default). The settings pane fires
   * `writeNotifyState` + `syncSubscription` on mount, and the sign-out control lives INSIDE that
   * pane — so on a captive portal whose `GET /push/vapid-key` merely stalls, the chain never
   * advances, `signOut` blocks here for ever, the server logout is never issued and the local
   * wipe never runs. The session stays live and the whole mailbox stays in IndexedDB on a machine
   * somebody has just said they are done with: strictly worse than the residue this closes.
   *
   * So the revoke gets a budget and the sign-out proceeds without it. The loser of the race is
   * NOT cancelled — the queued delete may still land later, which is a free win and never a
   * correctness question, because every store this decides about is swept unconditionally either
   * way. `row_remains` is the honest answer on a timeout: nothing here proved the row gone.
   */
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<PushSyncOutcome>((resolve) => {
    timer = setTimeout(() => resolve("row_remains"), WAKE_BUDGET_MS);
  });
  try {
    return await Promise.race([revokeWakeRegistrationNow(), budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * How long either end of the session will wait on the push queue before going on without it.
 *
 * Long enough for an ordinary round trip on a poor connection, short enough that nobody reads it
 * as a hang. The number is a bound on a BEST-EFFORT step, not a request deadline: what it
 * protects is the acts around it, which are the ones a user is entitled to — the sign-out's
 * logout and wipe on one end ({@link revokeWakeRegistration}), the shell's own boot on the other
 * ({@link reconcileWakeRegistration}). ONE constant because it is one hazard: every call on both
 * paths goes through the same module-global {@link serialize} chain, so a single stalled `fetch`
 * is what both budgets exist to survive.
 */
const WAKE_BUDGET_MS = 4_000;

/** The revoke itself. Never throws; see {@link revokeWakeRegistration} for the bound around it. */
async function revokeWakeRegistrationNow(): Promise<PushSyncOutcome | null> {
  // The words go first and unconditionally: it is the one half that needs neither the network nor
  // a live subscription, so a browser that fails everything below still refuses to draw.
  try { await disarmNotifyState("", ""); } catch { /* no Cache API, or storage refused */ }
  try {
    return (await browserNotificationHost.syncSubscription?.(false)) ?? null;
  } catch {
    /* The host's own guard threw before its try block could catch — a mocked `../api-client` with
       no `apiConfigured`, or a platform without one. Reported as the state that is true either
       way: nothing here proved the server row gone. */
    return "row_remains";
  }
}

/**
 * SET THE `enabled` BYTE AND KEEP THE WORDS THAT ARE THERE.
 *
 * ── WHY THE RECONCILE MAY NOT WRITE THE WORDS ITSELF ──────────────────────────────────────
 *
 * Every call in this module goes through ONE queue, and the boot commit enqueues in an order the
 * effect order does not suggest. `reconcileWakeRegistration` runs synchronously into
 * `syncSubscription`, so the push round trip is enqueued FIRST; the locale relabel is enqueued
 * SECOND; and the reconcile's own final write is enqueued only once the round trip RESOLVES —
 * THIRD, carrying a `body` captured at boot in the DEVICE's language.
 *
 * So whenever `GET /consent` adopts the account locale while the push request is still in flight
 * — the ordinary case, one request against register-SW + getSubscription + vapidKey + subscribe —
 * the relabel wrote German at position 2 and the reconcile overwrote it with English at position
 * 3. Which is the defect the relabel was added to fix, undone by its own neighbour.
 *
 * The last writer therefore does not carry words. `body` survives only as the value to use if
 * there is no entry at all to preserve — a state the relabel normally rules out before this runs.
 */
export function setNotifyEnabled(enabled: boolean, fallbackBody: string): Promise<void> {
  return serialize(async () => {
    try {
      if (typeof caches === "undefined") return;
      const cache = await caches.open(NOTIFY_CACHE);
      const held = await cache.match(NOTIFY_STATE_URL);
      const prior = held ? ((await held.json()) as { title?: unknown; body?: unknown }) : null;
      const title = typeof prior?.title === "string" ? prior.title : "ohmail";
      const body = typeof prior?.body === "string" ? prior.body : fallbackBody;
      await cache.put(
        NOTIFY_STATE_URL,
        new Response(JSON.stringify({ enabled, title, body }), {
          headers: { "content-type": "application/json" },
        }),
      );
    } catch {
      /* No Cache API, or storage refused. With no entry the worker draws nothing, which is the
         safe direction — the same argument `writeNotifyStateNow` makes. */
    }
  });
}

/**
 * RE-LABEL THE WORKER'S WORDS, and touch nothing else.
 *
 * The account's locale is adopted AFTER boot, off `GET /consent`. By then the boot reconcile has
 * already written the notify-state body in the DEVICE's language, and nothing rewrote it until
 * somebody opened Settings — so a German account on an English device got "New mail." drawn on
 * the lock screen. Drawing those words is the entry's only purpose, so "the worker only reads it
 * when it draws" is a reason to fix it, not to shrug.
 *
 * It re-writes the WORDS and preserves `enabled` EXACTLY as stored. Recomputing that here would
 * undo the whole point of the reconcile's gate: `subscriptionWanted()` is an intent, and enabling
 * on an intent rather than on a row this browser owns is how the previous user's surviving
 * registration gets re-armed. A relabel is not a reconcile.
 *
 * Absent entry ⇒ nothing to relabel, and nothing is created: a worker with no entry draws
 * nothing, which is the safe direction and the state a boot that established no row leaves.
 */
export function updateNotifyWords(title: string, body: string): Promise<void> {
  return serialize(async () => {
    try {
      if (typeof caches === "undefined") return;
      const cache = await caches.open(NOTIFY_CACHE);
      /* AN ABSENT ENTRY IS CREATED, DISARMED. It has to be: on the boot commit this runs BEFORE
         the reconcile's own write lands (see the ordering note there), so returning early would
         leave the words for the reconcile to supply — which is the clobber this exists to end.
         `enabled: false` is the only safe value to invent: a worker with no permission draws
         nothing, and the reconcile sets the byte immediately after. */
      const held = await cache.match(NOTIFY_STATE_URL);
      const prior = held ? ((await held.json()) as { enabled?: unknown }) : null;
      const enabled = typeof prior?.enabled === "boolean" ? prior.enabled : false;
      await cache.put(
        NOTIFY_STATE_URL,
        new Response(JSON.stringify({ enabled, title, body }), {
          headers: { "content-type": "application/json" },
        }),
      );
    } catch {
      /* No Cache API, storage refused, or an entry that is not ours to parse. The words stay as
         they were, which is a stale language and never a wrong `enabled`. */
    }
  });
}

/**
 * THE OTHER END OF THE SESSION — what {@link revokeWakeRegistration} undoes, put back.
 *
 * ── THE DEFECT THIS EXISTS FOR ────────────────────────────────────────────────────────────
 *
 * Sign-out deletes this browser's push row and writes the worker's notify-state `enabled: false`.
 * Nothing used to re-establish either. The channels in `localStorage` deliberately SURVIVE a
 * sign-out — they are a per-install preference, like the theme, and sweeping them at sign-out
 * would be honest about the wire and wrong about the person — and the OS permission survives
 * with them. So the same reader signing back in on their own laptop got `subscriptionWanted()`
 * true, every switch rendered ON, and no push row and a worker refusing to draw behind them.
 * Closed-browser new-mail notices were silently off, with nothing on screen to say so.
 *
 * The only reconcile in the app was the settings pane's mount effect, so the switches told the
 * truth again only if the reader happened to open Settings. This runs at shell boot instead —
 * once per sign-in, before anybody has been asked to go looking.
 *
 * ── BOUNDED, FOR THE REASON THE REVOKE IS ─────────────────────────────────────────────────
 *
 * Same hazard, same shape, same {@link WAKE_BUDGET_MS}. Every call below joins the module-global
 * {@link serialize} chain, whose ops are `fetch`es with no timeout, so an unguarded `await` here
 * would hand a captive portal the power to stall the shell's boot path. The loser of the race is
 * NOT cancelled: a late registration is a free win, because nothing downstream reads this
 * function's answer as permission to do anything. `not_registered` is the honest reply on a
 * timeout — nothing here proved a row exists.
 *
 * Never throws, for the reason the revoke does not: callers' tests mock `../api-client`, and a
 * missing export must not throw out of a boot effect and take the rest of the shell with it.
 */
/**
 * APPLY A WAKE INTENT TO THIS BROWSER — the one place either door goes through.
 *
 * `host` so the settings pane can pass its injected one (and the desktop its own); `wanted` given
 * rather than derived, because the PRESS knows the intent before storage settles while the BOOT
 * has to read it. Everything after that point is identical, and it is identical ON PURPOSE: the
 * boot path and the Settings door had the same privacy defect, and a second copy of this ordering
 * is how one of them gets fixed and the other does not — which is exactly what happened once.
 *
 * Bounded by {@link WAKE_BUDGET_MS}. Never throws.
 */
export async function applyWakeIntent(
  host: NotificationHost, wanted: boolean, body: string,
): Promise<PushSyncOutcome | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<PushSyncOutcome>((resolve) => {
    timer = setTimeout(() => resolve("not_registered"), WAKE_BUDGET_MS);
  });
  try {
    return await Promise.race([applyWakeIntentNow(host, wanted, body), budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The BOOT door: the same act, over the stored intent and the browser's own host. */
export async function reconcileWakeRegistration(body: string): Promise<PushSyncOutcome | null> {
  return applyWakeIntent(
    browserNotificationHost, subscriptionWanted(readChannels(), browserPermission()), body,
  );
}

/**
 * The act itself. Never throws; see {@link applyWakeIntent} for the bound.
 *
 * THE TWO DIRECTIONS ARE ORDERED DIFFERENTLY, and that asymmetry is the whole of the privacy
 * argument. OFF is written first and unconditionally — it needs neither the network nor a
 * subscription, and a worker told not to draw cannot leak. ON is written LAST, and only once this
 * browser holds a row the server acknowledged, because the residue a failed sign-out delete
 * leaves behind belongs to the PREVIOUS user and is still being dialled. See the body.
 */
async function applyWakeIntentNow(
  host: NotificationHost, wanted: boolean, body: string,
): Promise<PushSyncOutcome | null> {

  /* OFF IS WRITTEN FIRST AND UNCONDITIONALLY. It needs neither the network nor a subscription,
     and it is the safe direction: a worker told not to draw cannot leak whatever the sender still
     has. This half is unchanged. */
  if (!wanted) {
    try { await disarmNotifyState("ohmail", body); } catch { /* no Cache API, or refused */ }
    try {
      return (await host.syncSubscription?.(false)) ?? null;
    } catch {
      return "row_remains";
    }
  }

  /*
   * ── ON IS WRITTEN LAST, AND ONLY FOR A ROW THIS BOOT ESTABLISHED ────────────────────────
   *
   * An earlier version wrote `enabled: true` FIRST, arguing that an `enabled: true` with no
   * subscription is inert because no push can arrive to read it. THAT ARGUMENT IS FALSE ON THE
   * ONE MACHINE THAT MATTERS — a shared browser.
   *
   * Sign-out deletes the row, but a failed delete answers `row_remains` and leaves it LIVE by
   * design, retained so a later attempt can name it. The sender goes on dialling that endpoint.
   * So the sequence is: user A signs out, the delete fails, A's row survives behind an
   * `enabled: false` worker — which is exactly what keeps A's mail from being drawn. User B signs
   * in on the same browser, and a boot that writes `enabled: true` up front re-arms the worker
   * for a registration that is still A's. The next push for A's mail is drawn, on B's screen.
   * That is the privacy defect the sign-out revoke was written to close, reintroduced from the
   * other end.
   *
   * So: announce first, and enable only on an OUTCOME that says this browser holds the row.
   *
   * The gate is the outcome and deliberately NOT `readId() !== null`, which was the first thing
   * tried and is wrong for exactly the sequence above: a failed delete RETAINS the id by design,
   * so after A's `row_remains` the id in storage is A's, and a non-null check would re-arm the
   * worker for B on the strength of A's registration — the defect, wearing a guard.
   *
   * `subscribed` and `unchanged` are the two answers that mean a row exists AND names THIS
   * browser's endpoint (`syncWebPush` compares the stored endpoint before it says `unchanged`).
   * Every other answer — `row_remains`, `not_registered`, `no_server_key`, `unsupported` — leaves
   * the honest state as the one that draws nothing.
   */
  /*
   * ── WHAT `forceAnnounce` COSTS, AND WHY IT IS ACCEPTED ──────────────────────────────────
   *
   * Every signed-in boot now issues the POST rather than trusting a stored id, so a boot on a bad
   * connection reaches {@link WAKE_BUDGET_MS} more often than one that could shortcut. The
   * timeout answer is `not_registered`, which leaves the worker DARK for a reader who legitimately
   * owns the row — they get no closed-browser notices until the next boot lands the round trip.
   *
   * That is the direction to fail in, and it is chosen rather than inherited. The alternative is
   * enabling on a timeout, which is exactly the defect: "I could not confirm" would render as
   * "this browser owns the row", on the one machine — a shared browser — where the row may be
   * somebody else's. A missed notice is recoverable on the next boot; a stranger's mail announced
   * on your lock screen is not.
   */
  let outcome: PushSyncOutcome | null;
  try {
    outcome = (await host.syncSubscription?.(true, { forceAnnounce: true })) ?? null;
  } catch {
    /* The host's own guard threw before its try block could catch — a mocked `../api-client`
       with no `apiConfigured`, or a platform without one. Reported as the state that is true
       either way: nothing here established a registration this browser can rely on. */
    outcome = "not_registered";
  }
  /* `subscribed` ALONE. `unchanged` is reachable only without `forceAnnounce`, and it attests to a
     stored id rather than to ownership — see the shortcut in `syncWebPushNow`. The announce above
     is forced precisely so that the only way to reach `true` here is a row the server named for
     THIS session. */
  const ours = outcome === "subscribed";
  try {
    await setNotifyEnabled(ours, body);
  } catch { /* no Cache API, or refused */ }
  return outcome;
}
