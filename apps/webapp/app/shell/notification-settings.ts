/**
 * The notification switches — stored per device, because delivery is a fact about a device. The DECISION
 * lives in `@ohmail/client-engine`'s gate; this is the state the gate is handed, plus what the operating
 * system says. Reach is `install`, a ruling: whether a notice may be drawn is the OS's answer, per device,
 * and it cannot be carried anywhere — wanting mail to interrupt on the phone and not the work laptop is the
 * ordinary case. The mailbox-as-master invariant is untouched: per-SENDER opt-ins (`notifyRules`) travel in
 * the organizer profile; "does this laptop make a sound" does not. `localStorage` is the right store
 * (`LocaleContext`'s argument: on the desktop it IS the persistence), and every read is defensive — a blocked
 * storage renders the DEFAULTS ({@link readChannels}).
 */
import {
  DEFAULT_CHANNELS,
  type NoticePermission,
  type NotificationChannels,
} from "@ohmail/client-engine";
import { apiConfigured, push as pushApi } from "../api-client";
import { durableRemove, durableSet } from "./durable";

/** One key, one JSON object — so a partial write cannot leave two switches disagreeing. */
export const NOTIFICATION_CHANNELS_KEY = "ohmail.notifications.channels";

/**
 * Read this install's switches, falling back to {@link DEFAULT_CHANNELS}.
 * A failed read reads as the DEFAULTS — not off, not on: the defaults are
 * what a fresh install believes, so a browser with storage blocked behaves
 * like a fresh install rather than like an account that turned everything
 * off (which silently disables a feature the user enabled, with nothing on
 * screen to explain it). Unknown keys are dropped and missing ones
 * defaulted field by field: a newer build's catalogue must not make an
 * older one throw, and a boolean that is not a boolean is not a preference.
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
  // The in-memory value still drives this session; the refusal is no longer silent.
  durableSet(NOTIFICATION_CHANNELS_KEY, JSON.stringify(next), "notifications.channels");
}

/**
 * What the platform says, normalized to the gate's four states. A host that
 * is not a browser — the desktop shell, whose webview cannot hold the
 * permission — supplies its own reader ({@link NotificationHost}); the
 * browser path is here because it needs no injection. `unsupported` and
 * `denied` are different and never collapsed: "this platform has no
 * notification centre" is a fact about the machine and hides the controls;
 * "you refused" is a decision somebody made and must be reported with the
 * place to change it.
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
   * Bring this surface's wake registration into line with the switches, if
   * it has one. Optional, and the desktop is why: that build has no push
   * subscription and no server to hold one — its shell is woken by its own
   * engine — so it supplies no implementation and the pane calls nothing; a
   * required method would force a do-nothing stub, a promise the type makes
   * and the surface does not keep. Never throws to the caller: a
   * registration that could not be made is a browser that will not be woken
   * while closed, not a reason to move a control the user set.
   */
  /**
   * `opts.forceAnnounce` — do NOT accept a stored id as proof this browser
   * owns the row. Both doors pass it, because both go through
   * {@link applyWakeIntent}, which sets it unconditionally. An earlier
   * version said the settings pane could keep the cheap `unchanged`
   * shortcut "because a press has already proved whose session it is" —
   * true when written, false one commit later, and wrong anyway: a press
   * proves the SESSION, never which account owns the registration already
   * live on this browser, which is the only question `unchanged` is asked.
   */
  syncSubscription?: (wanted: boolean, opts?: { forceAnnounce?: boolean }) => Promise<PushSyncOutcome | null>;
  /**
   * This surface cannot read the operating system's answer — its shell asks
   * on first use. Absent (the browser) means `permission()` IS the OS
   * answer and the pane's three sentences describe it exactly. Set (the
   * desktop) means `permission()` answers a narrower question — may this
   * window ask the shell — and the pane owes a sentence about who has the
   * last word. A fact about the host, not copy: the wording stays in the
   * catalogue. It exists because the released desktop had a master switch
   * that could not be turned on and said nothing (`apps/desktop/src/notify-host.ts`).
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
 * Should this browser have a push subscription at all? Pure, and separated from every call it
 * drives, because it is the whole policy. A subscription exists only to wake a browser that is
 * CLOSED: while a window is open the app syncs on its own and applies every per-event switch with
 * the mirror in front of it. So the question is "is there something worth starting this browser
 * up for", and the only such event is new mail — turning NEW MAIL off drops the subscription
 * while the other switches keep working for an open window (stated in the pane). Happy
 * consequence: "fully off" needs no cooperation from the push service — no subscription, nothing
 * to dial, nothing delivered-then-discarded.
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
 * Tell the worker to draw nothing — the only writer a surface outside this module should reach
 * for, and it cannot express the other direction. Arming has a precondition — a row the SERVER
 * named for THIS session — and it lives in {@link applyWakeIntent}, not the writer. When the
 * ungated writer was called `writeNotifyState`, both arming doors imported it and armed on an
 * INTENT — on a shared browser that re-arms the worker for the previous reader's still-live
 * registration. `writeNotifyStateUnchecked` is still exported (under test in
 * `web-push-subscription.test.ts`) but no longer reads like the thing to call; the census in
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
 * The prefix sign-out sweeps, and the ruling that separates these two keys from the switches.
 * `ohmail.notifications.channels` is a per-install preference and survives sign-out beside
 * `ohmail.theme` — the OS permission it mirrors is a fact about this machine. The two keys
 * below are NOT that: a server row's id and the address it was made for, minted inside a
 * signed-in session, meaningless to the next account — and a stale id makes {@link
 * syncWebPushNow} answer "unchanged" for the NEXT account, which would then never register and
 * never be woken. One prefix rather than two entries: a sweep that names a prefix cannot be
 * half-updated when a third key joins.
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
  if (id === null) {
    durableRemove(SUBSCRIPTION_ID_KEY, "notifications.subscription");
    durableRemove(SUBSCRIPTION_ENDPOINT_KEY, "notifications.subscription");
    return;
  }
  durableSet(SUBSCRIPTION_ID_KEY, id, "notifications.subscription");
  if (endpoint !== undefined) {
    durableSet(SUBSCRIPTION_ENDPOINT_KEY, endpoint, "notifications.subscription");
  }
};

/**
 * One at a time, in the order they were asked for. Two quick presses used
 * to interleave: an ON that had not finished asking for its key, and an OFF
 * that found no subscription, reported "unchanged" — after which the ON's
 * `subscribe()` landed and the browser was registered with every switch
 * off. The mobile client queues its wake mutations for the same reason;
 * this is that queue. Both arms of `then` are the operation, so a rejected
 * predecessor still lets the next run.
 */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const next = chain.then(op, op);
  chain = next.catch(() => undefined);
  return next;
}

/**
 * Bring this browser's subscription into line with the switches.
 * Idempotent, safe on every change and on mount, serialized against itself.
 * Returns what actually happened, so the pane can say a true sentence —
 * `no_server_key` and `row_remains` are both states a person can act on.
 * It never throws and never moves a switch: a registration that could not
 * be made is a browser that will not be woken while closed, not a reason to
 * flip a control somebody set. What it must not do is leave a state that
 * cannot be recovered from — the three orderings below.
 */
export function syncWebPush(
  wanted: boolean, api: PushApi, opts?: { forceAnnounce?: boolean },
): Promise<PushSyncOutcome> {
  return serialize(() => syncWebPushNow(wanted, api, opts));
}

/**
 * Did the server actually name a row? Defence, not a known path: an earlier version asserted
 * the cross-account endpoint conflict makes `POST /push/subscriptions` answer `{}`, and it does
 * not — `push-service.ts` falls back to an account-scoped lookup that THROWS on a miss, which
 * the caller's catch maps to `not_registered`. The guard stays because it costs nothing and the
 * failure it prevents is silent: `writeId` treats only `null` as removal, so an absent id would
 * store the literal string "undefined" and report `subscribed` — a registration under an id
 * that names nothing, never retried.
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
     * `unchanged` is not proof of ownership, and the boot path may not take
     * it: the shortcut attests a STORED id matches the live endpoint, and says nothing about which ACCOUNT owns the row. On a shared browser:
     * `sign-out.ts` awaits the revoke and sweeps the prefix strictly after,
     * so an unload that beat the local `unsubscribe()` beat the sweep too —
     * A's id and endpoint survive into B's session, and without `forceAnnounce` the boot reads `unchanged` as ownership and re-arms
     * the worker for A's registration. The boot re-announces instead: cheap
     * for the legitimate case (the POST dedupes on the endpoint), and a
     * foreign row fails the account-scoped lookup, keeping the worker dark.
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
 * Take this browser's wake registration down — called by `sign-out.ts` on both doors. The server's sign-out prune is
 * device-scoped and a browser session's `device_id` is NULL, so the row survived sign-out, the sender kept POSTing, the
 * endpoint kept answering 2xx (no 404/410 prune), and the next person on a shared machine was woken for the previous account's
 * mail. The client is the right place: this browser is the only party that knows WHICH deviceless row is its own — deleting
 * every deviceless row server-side would end another browser's notifications. Three independent halves: unsubscribe locally,
 * delete the row, write `enabled: false` — whichever lands helps (a dropped subscription 404s the sender into pruning the row a
 * failed DELETE left). No sentence on screen: there is no action a signed-out browser could take, and the residue collects
 * itself. Never throws; a no-op on desktop builds (`apiConfigured()` false).
 */
export async function revokeWakeRegistration(): Promise<PushSyncOutcome | null> {
  /*
   * Bounded, and the bound is load-bearing (found by review — it inverted the neighbour's "the wipe runs REGARDLESS"). Every call joins the
   * module-global {@link serialize} queue, whose ops are `fetch`es with no
   * timeout; the settings pane fires two on mount and the sign-out control
   * lives inside that pane — so on a captive portal whose vapid-key GET
   * stalls, `signOut` blocked here for ever: the server logout never issued,
   * the local wipe never ran, the whole mailbox left in IndexedDB on a machine somebody said they were done with. So the revoke gets a budget
   * and the sign-out proceeds; the loser is not cancelled (a late delete is
   * a free win — every store is swept unconditionally either way). `row_remains` is the honest answer on a timeout.
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
 * How long either end of the session waits on the push queue before going
 * on without it — long enough for a round trip on a poor connection, short
 * enough not to read as a hang. A bound on a BEST-EFFORT step, not a
 * request deadline: what it protects is the acts around it — the sign-out's
 * logout and wipe ({@link revokeWakeRegistration}), the shell's boot
 * ({@link reconcileWakeRegistration}). One constant because it is one
 * hazard: every call on both paths goes through the same module-global
 * {@link serialize} chain, so a single stalled `fetch` is the shared risk.
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
 * Set the `enabled` byte and keep the words that are there. The reconcile may not write the words
 * itself: everything goes through one queue, and the boot commit enqueues out of effect order — the
 * push round trip first, the locale relabel second, and the reconcile's final write only when the
 * round trip RESOLVES, third, carrying a `body` captured at boot in the DEVICE's language. Whenever
 * `GET /consent` adopted the account locale mid-flight (the ordinary case), the relabel wrote German
 * at position 2 and the reconcile overwrote it with English at position 3 — the defect the relabel
 * fixed, undone by its neighbour. So the last writer carries no words; `body` survives only where
 * there is no entry to preserve.
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
 * Re-label the worker's words, and touch nothing else. The account locale is adopted after
 * boot, off `GET /consent`; by then the boot reconcile has written the notify-state body in the
 * DEVICE's language and nothing rewrote it until somebody opened Settings — a German account on
 * an English device got "New mail." on the lock screen. It re-writes the WORDS and preserves
 * `enabled` exactly as stored: recomputing it here from `subscriptionWanted()` — an intent — is
 * how the previous user's surviving registration gets re-armed; a relabel is not a reconcile.
 * Absent entry ⇒ nothing relabelled, nothing created: a worker with no entry draws nothing.
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
 * The other end of the session — what {@link revokeWakeRegistration} undoes, put back. Sign-out deletes the
 * push row and disables the worker; the channels and the OS permission deliberately survive (per-install
 * preferences), so the same reader signing back in saw every switch ON over no registration, with
 * closed-browser notices silently off — and the only reconcile was the settings pane's mount effect. This runs
 * at shell boot instead: once per sign-in, before anybody goes looking. Bounded for the revoke's reason (same
 * hazard, same {@link WAKE_BUDGET_MS}); the loser is not cancelled — a late registration is a free win, since
 * nothing reads this answer as permission. `not_registered` is the honest reply on a timeout. Never throws: a
 * missing mocked export must not take a boot effect down.
 */
/**
 * Apply a wake intent to this browser — the one place either door goes
 * through. `host` so the settings pane can pass its injected one (and the
 * desktop its own); `wanted` given rather than derived, because the PRESS
 * knows the intent before storage settles while the BOOT has to read it.
 * Everything after that point is identical on purpose: the boot path and
 * the Settings door had the same privacy defect, and a second copy of this
 * ordering is how one gets fixed and the other does not — which happened
 * once. Bounded by {@link WAKE_BUDGET_MS}. Never throws.
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
   * ON is written last, and only for a row this boot established. An earlier version wrote `enabled: true` first, arguing an enabled flag
   * with no subscription is inert — false on the one machine that matters, a shared browser: A signs out, the delete fails (`row_remains` retains
   * the row by design), and a boot that enables up front re-arms the worker
   * for a registration that is still A's — the next push for A's mail drawn
   * on B's screen. So: announce first, enable only on an OUTCOME that says this browser holds the row. The gate is the outcome, deliberately NOT
   * `readId() !== null` — after A's `row_remains` the stored id is A's, so
   * a non-null check is the defect wearing a guard. `subscribed` and `unchanged` are the two answers that mean a row exists and names THIS
   * endpoint; every other answer leaves the state that draws nothing.
   */
  /*
   * What `forceAnnounce` costs, and why it is accepted: every signed-in
   * boot now issues the POST rather than trusting a stored id, so a boot on
   * a bad connection reaches {@link WAKE_BUDGET_MS} more often. The timeout
   * answer is `not_registered`, which leaves the worker dark for a reader
   * who legitimately owns the row — no closed-browser notices until the
   * next boot lands. That is the chosen direction: enabling on a timeout
   * would render "I could not confirm" as "this browser owns the row", on
   * the one machine where the row may be somebody else's. A missed notice is recoverable; a stranger's mail on your lock screen is not.
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
