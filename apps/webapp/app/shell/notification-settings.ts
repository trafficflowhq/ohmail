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
  type NoticeChoices,
  type NoticePermission,
  type NotificationChannels,
} from "@ohmail/client-engine";
import { NONE, type None, type Signal } from "@ohmail/app/host";
import type { HostNoticeEmitter } from "@ohmail/app-logic/notices/use-notices";
import { apiConfigured, boundApiFamily, push as pushApi } from "../api-client";
import { readSessionFamily } from "../signed-out-signal";
import { sessionMayAsk } from "@ohmail/app-logic/session/session-truth";
import { browserNoticePage } from "./notice-emitter";
import { durableRemove, durableSet, localStorageDoor } from "@ohmail/app-logic/storage/durable";
import { readOwner, readOwnerMarker } from "@ohmail/app-logic/storage/owner-cookie";

import {
  noticeChoicesVersion, readChannels, storedNoticeChoices, subscriptionWanted,
} from "@ohmail/app-logic/notices/browser-channels";
export {
  CALENDAR_NOTICES_KEY, NOTIFICATION_CHANNELS_KEY, noticeChoicesVersion, readCalendarNotices,
  readChannels, storedNoticeChoices, subscriptionWanted, useNoticesVersion, writeChannels,
} from "@ohmail/app-logic/notices/browser-channels";

type PushRequestScope = { expectedOwner?: string; expectedFamily?: string };

type PushSyncOptions = PushRequestScope & {
  forceAnnounce?: boolean;
  signingOutOf?: string;
  mayPublish?: () => boolean;
  mayRegister?: () => boolean;
  mayWithdraw?: () => boolean;
};

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
  liveNoticeScope?: () => string | null;
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
   *
   * `opts.signingOutOf` — the sign-out press's revoke, for the row's DELETE:
   * see {@link revokeWakeRegistration}.
   */
  syncSubscription?: (
    wanted: boolean, opts?: PushSyncOptions,
  ) => Promise<PushSyncOutcome | null>;
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
  /**
   * What draws this surface's notices while the app runs, or `none`. The page's own emitter is made
   * where the page's words are (`web-supplies.tsx`); a host that hands this object in as it stands
   * draws none.
   */
  readonly emitter: HostNoticeEmitter | None;
  /**
   * The registration's two ends that are no press, for the part that boots once per sign-in (the mail ground's
   * `MailBoot`, through `host.device.notifications`): {@link reconcileWakeRegistration} and
   * {@link updateNotifyWords}. Both or neither: a host with no registration (the desktop) hands neither.
   */
  reconcile?: (body: string, scope: string | null) => Promise<PushSyncOutcome | null>;
  relabel?: (title: string, body: string, scope: string | null) => Promise<void>;
  /**
   * The person's choices on this device as the notices' gate reads them, for the one caller of this surface's
   * emitter (the mail ground's, through `host.device.notifications`): {@link storedNoticeChoices} wherever the
   * switches are this module's. Absent: the surface stores none, and nothing is handed to its emitter.
   */
  choices?: (scope: string | null) => NoticeChoices;
  choicesVersion?: Signal<number>;
}

/**
 * The browser host. Asking is ONLY ever done from a user gesture — the master switch's press —
 * because a permission prompt on page load is the behaviour browsers punish with a permanent
 * block, and one that is refused can never be asked for again.
 */
export const browserNotificationHost: NotificationHost = {
  emitter: NONE,
  choices: storedNoticeChoices,
  choicesVersion: noticeChoicesVersion,
  /**
   * Registration is attempted only where there is a server to register WITH. `apiConfigured()`
   * is false in every desktop build — its Cloud adapter is aliased out of the bundle — so this
   * is a no-op there even though the module is compiled in.
   */
  syncSubscription: async (wanted: boolean, opts?: PushSyncOptions) => {
    /* `null` means "there was nothing to reconcile here", which is not the same as a failure and
       must not be rendered as one. `apiConfigured()` is false in every desktop build — its Cloud
       adapter is aliased out of the bundle — so this is a no-op there even though the module is
       compiled in. */
    if (!apiConfigured()) return null;
    try {
      // Live-window notices have their own emitter. Only closed-window delivery needs this lock.
      if (wanted && !notifyStateLocks()) return "unsupported";
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
  /* The boot's door and the relabel are this module's own two functions (below), named when they are called:
     both go through the one queue every write of the worker's state goes through. */
  reconcile: (body, scope) => reconcileWakeRegistration(body, scope),
  relabel: (title, body, scope) => updateNotifyWords(title, body, scope),
};

/* ══════════════════════════════════════════════════════════════════════════════════════════
 *  BEING WOKEN WHILE THE BROWSER IS CLOSED — the subscription, and when it should exist
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** Where the page leaves the service worker its words. Must match `public/sw.js`. */
export const NOTIFY_CACHE = "ohmail-notify-v1";
export const NOTIFY_STATE_URL = "/__ohmail_notify_state";
const NOTIFY_STATE_LOCK = "ohmail-notify-state";
const SUBSCRIPTION_LOCK = "ohmail-wake-subscription";
let cacheEdits = Promise.resolve();

function notifyStateLocks(): LockManager | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.locks;
}

async function withWakeSubscription<T>(operation: () => Promise<T>): Promise<T> {
  const locks = notifyStateLocks();
  return await (locks ? locks.request(SUBSCRIPTION_LOCK, operation) : operation());
}

function editNotifyCache(edit: (cache: Cache) => Promise<void>, strict = false): Promise<void> {
  const pending = cacheEdits.then(async () => {
    try {
      if (typeof caches === "undefined") return;
      const write = async () => edit(await caches.open(NOTIFY_CACHE));
      const locks = notifyStateLocks();
      if (locks) await locks.request(NOTIFY_STATE_LOCK, write);
      else await write();
    } catch (err) {
      if (strict) throw err;
    }
  });
  cacheEdits = pending.catch(() => undefined);
  return pending;
}

interface NotifyState {
  enabled: boolean;
  title: string;
  body: string;
  revision?: string;
  registration?: { owner: string; family: string; proof: string };
}

async function readNotifyState(cache: Cache): Promise<NotifyState | null> {
  const held = await cache.match(NOTIFY_STATE_URL);
  if (!held) return null;
  try { return await held.json(); } catch { return null; }
}

function putNotifyState(cache: Cache, state: NotifyState): Promise<void> {
  return cache.put(NOTIFY_STATE_URL, new Response(JSON.stringify(state), {
    headers: { "content-type": "application/json" },
  }));
}

function disarmedState(title: string, body: string, revision: string = crypto.randomUUID()): NotifyState & { revision: string } {
  return { enabled: false, title, body, revision };
}

async function putCurrentNotifyState(cache: Cache, state: NotifyState, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) return;
  await putNotifyState(cache, state);
  // A put may finish after its session ends. Disarm before letting the worker read the result.
  if (state.enabled && !isCurrent()) {
    try { await putNotifyState(cache, disarmedState("", "")); }
    catch { await cache.delete(NOTIFY_STATE_URL); }
  }
}

/** The fallback page may open only for the registration and live session confirmed by the server. */
export async function wakeProofHolds(proof: string, owner: string, family: string | undefined): Promise<boolean> {
  if (!family || readOwner() !== owner || readSessionFamily() !== family) return false;
  let matches = false;
  await editNotifyCache(async (cache) => {
    const state = await readNotifyState(cache);
    const registration = state?.registration;
    matches = wakeStorage.get(pendingOffKey) === null && state?.enabled === true &&
      registration?.proof === proof && registration.owner === owner && registration.family === family &&
      readOwner() === owner && readSessionFamily() === family;
  });
  return matches;
}

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
  return editNotifyCache((cache) => putNotifyState(cache, enabled ? { enabled, title, body } : disarmedState(title, body)));
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
  subscribe: (endpoint: string, p256dh: string, auth: string, opts?: PushRequestScope) => Promise<{ id: string }>;
  unsubscribe: (id: string, opts?: PushRequestScope & { signingOutOf?: string }) => Promise<void>;
}

/**
 * The prefix sign-out sweeps, and the ruling that separates these keys from the switches.
 * `ohmail.notifications.channels` is a per-install preference and survives sign-out beside
 * `ohmail.theme` — the OS permission it mirrors is a fact about this machine. The keys
 * below are NOT that: a server row's id, the address and the account it was made for, minted
 * inside a signed-in session, meaningless to the next account — and a stale id makes {@link
 * syncWebPushNow} answer "unchanged" for the NEXT account, which would then never register and
 * never be woken. One prefix rather than one entry per key: a sweep that names a prefix cannot be
 * half-updated when a key joins, as the account did.
 */
export const NOTIFICATION_SUBSCRIPTION_PREFIX = "ohmail.notifications.subscription";

// A refused Cache write must still invalidate acknowledgments waiting in another tab.
const pendingOffKey = `${NOTIFICATION_SUBSCRIPTION_PREFIX}OffRevision`;
const wakeStorage = localStorageDoor("notifications.subscription");

async function writeOff(cache: Cache, state: NotifyState & { revision: string }): Promise<boolean> {
  try {
    await putNotifyState(cache, state);
  } catch {
    wakeStorage.set(pendingOffKey, state.revision);
    try { await cache.delete(NOTIFY_STATE_URL); } catch { /* The pending revision still fences acknowledgments. */ }
    return false;
  }
  wakeStorage.remove(pendingOffKey);
  return true;
}

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
/**
 * And the account the jar named when the row was announced, so a revoke of that account while another holds
 * the jar forgets the id it left and keeps another account's (`sign-out.ts`).
 */
export const SUBSCRIPTION_OWNER_KEY = "ohmail.notifications.subscriptionOwner";

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
const readSubscriptionOwner = (): string | null => {
  try { return globalThis.localStorage?.getItem(SUBSCRIPTION_OWNER_KEY) ?? null; } catch { return null; }
};
const readEndpoint = (): string | null => {
  try { return globalThis.localStorage?.getItem(SUBSCRIPTION_ENDPOINT_KEY) ?? null; } catch { return null; }
};
/**
 * Id and endpoint move together — a row is only ever meaningful with the address it was made for. Its account
 * goes first and is written last, so a write that stops partway names nobody, never the wrong account.
 */
const writeId = (id: string | null, endpoint?: string, owner: string | null = null): void => {
  durableRemove(SUBSCRIPTION_OWNER_KEY, "notifications.subscription");
  if (id === null) {
    durableRemove(SUBSCRIPTION_ID_KEY, "notifications.subscription");
    durableRemove(SUBSCRIPTION_ENDPOINT_KEY, "notifications.subscription");
    return;
  }
  const kept = [durableSet(SUBSCRIPTION_ID_KEY, id, "notifications.subscription")];
  if (endpoint !== undefined) {
    kept.push(durableSet(SUBSCRIPTION_ENDPOINT_KEY, endpoint, "notifications.subscription"));
  }
  if (owner !== null && kept.every((k) => k === "stored")) {
    durableSet(SUBSCRIPTION_OWNER_KEY, owner, "notifications.subscription");
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
  wanted: boolean, api: PushApi, opts?: PushSyncOptions,
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
  wanted: boolean, api: PushApi, opts?: PushSyncOptions,
): Promise<PushSyncOutcome> {
  if (wanted && opts?.mayRegister?.() === false) return "not_registered";
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return "unsupported";
  const idAtStart = readId();
  const endpointAtStart = readEndpoint();
  const ownerAtStart = readSubscriptionOwner();
  const familyAtStart = readSessionFamily();
  const requestScope = opts?.expectedFamily === undefined ? undefined : {
    expectedFamily: opts.expectedFamily,
    ...(opts.expectedOwner === undefined ? {} : { expectedOwner: opts.expectedOwner }),
  };
  let reg: ServiceWorkerRegistration;
  let existing: PushSubscription | null;
  try {
    reg = await navigator.serviceWorker.register("/sw.js");
    existing = await reg.pushManager.getSubscription();
  } catch {
    return "unsupported";
  }

  if (!wanted) {
    const mayWithdraw = () => opts?.mayWithdraw?.() !== false && readSessionFamily() === familyAtStart &&
      readId() === idAtStart && readEndpoint() === endpointAtStart && readSubscriptionOwner() === ownerAtStart;
    const sameOwner = ownerAtStart === null || ownerAtStart === (opts?.expectedOwner ?? opts?.signingOutOf ?? readOwner());
    if (!sameOwner || !mayWithdraw()) return "row_remains";
    const pass = opts?.signingOutOf === undefined ? requestScope : { signingOutOf: opts.signingOutOf, ...requestScope };
    if (existing === null && idAtStart === null) return "unchanged";
    // A recorded endpoint belongs to the operation that captured it. A browser rotation can leave
    // a different local endpoint behind, which must survive this withdrawal.
    let localGone = existing === null;
    if (existing !== null && (endpointAtStart === null || existing.endpoint === endpointAtStart)) {
      try { localGone = await existing.unsubscribe(); } catch { /* still try the captured server row */ }
    }
    if (idAtStart === null) return localGone ? "unsubscribed" : "row_remains";
    if (!mayWithdraw()) return "row_remains";
    try {
      await api.unsubscribe(idAtStart, pass);
      if (mayWithdraw()) writeId(null);
      return localGone ? "unsubscribed" : "row_remains";
    } catch {
      /* THE ID SURVIVES A FAILED DELETE, and that is the whole point. Erasing it here made the
         row unreachable for ever: nothing else knows its name, so a retry could never be made and
         the server went on dialling an endpoint this browser had already dropped. Keeping it means
         the next OFF — or the mount reconciliation — tries again. */
      return "row_remains";
    }
  }

  if (opts?.mayRegister?.() === false) return "not_registered";
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
     * `unchanged` is not proof of ownership, and the boot path may not take it: the shortcut
     * attests a STORED id matches the live endpoint, nothing about which ACCOUNT owns the row. On a
     * shared browser, `sign-out.ts` sweeps the prefix strictly after the awaited revoke, so an
     * unload that beat the local `unsubscribe()` beat the sweep too — A's id and endpoint survive
     * into B's session, and the boot would re-arm the worker for A's registration. So the boot
     * re-announces: cheap (the POST dedupes on the endpoint), and a foreign row fails the
     * account-scoped lookup, keeping the worker dark.
     */
    if (!opts?.forceAnnounce && knownId !== null && readEndpoint() === existing.endpoint) {
      return "unchanged";
    }
    const keys = subscriptionKeys(existing);
    if (keys === null) return "unsupported";
    try {
      // The row is the account's whose session the POST carries: the jar's name now, not at its answer.
      const owner = readOwner();
      const { id } = await api.subscribe(existing.endpoint, keys.p256dh, keys.auth, requestScope);
      if (!namedRow(id) || opts?.mayPublish?.() === false) return "not_registered";
      /* The superseded row is dropped AFTER the new one exists, so a failure here never leaves
         this browser with no registration at all. A row for a dead endpoint is pruned by the
         sender anyway; a browser with none is simply never woken. */
      /* THE SAME ENDPOINT DEDUPES TO THE SAME ROW, so the ordinary boot re-announce leaves
         `knownId === id` and this arm does not fire. It is reached when the SERVER names a
         different row — an endpoint rotation — which is the case it was written for and not
         something `forceAnnounce` manufactures. */
      if (knownId !== null && knownId !== id && opts?.mayRegister?.() !== false &&
          (ownerAtStart === null || ownerAtStart === owner)) {
        try { await api.unsubscribe(knownId, requestScope); } catch { /* pruned when its endpoint stops answering */ }
      }
      if (opts?.mayPublish?.() === false) return "not_registered";
      writeId(id, existing.endpoint, owner);
      return "subscribed";
    } catch {
      return "not_registered";
    }
  }

  let publicKey: string | null;
  try { ({ publicKey } = await api.vapidKey()); } catch { return "not_registered"; }
  if (opts?.mayRegister?.() === false) return "not_registered";
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
  if (opts?.mayRegister?.() === false) return "not_registered";
  const keys = subscriptionKeys(sub);
  if (keys === null) {
    // A subscription with no keys cannot be sealed to, and the sender refuses to send in the
    // clear. Undo it rather than leaving a registration nothing will ever use.
    try { await sub.unsubscribe(); } catch { /* nothing better to do */ }
    return "unsupported";
  }
  try {
    const owner = readOwner();
    const { id } = await api.subscribe(sub.endpoint, keys.p256dh, keys.auth, requestScope);
    if (opts?.mayPublish?.() === false) return "not_registered";
    if (!namedRow(id)) {
      /* Same rollback as the throw below, for the same reason: a local subscription with no row
         is the stuck state where every later call sees one and never retries the POST. */
      try { await sub.unsubscribe(); } catch { /* nothing better to do */ }
      return "not_registered";
    }
    writeId(id, sub.endpoint, owner);
    return "subscribed";
  } catch {
    /* ROLL THE LOCAL HALF BACK. Leaving it subscribed with no row is the stuck state above —
       every later call would see a subscription and never retry the POST. Undoing it means the
       next attempt starts clean. */
    if (opts?.mayPublish?.() !== false) {
      try { await sub.unsubscribe(); } catch { /* nothing better to do */ }
    }
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
 *
 * `signingOutOf` is the sign-out press's: the account its jar named. The press marks the jar pending before it revokes, so
 * the account boundary lets the row's DELETE through on that account alone (`api-client.ts`, `RequestOptions`).
 */
export async function revokeWakeRegistration(opts?: { signingOutOf?: string; expectedFamily?: string }): Promise<PushSyncOutcome | null> {
  latestWakeIntent += 1;
  /*
   * Bounded, and the bound is load-bearing (review — it inverted "the wipe runs REGARDLESS"). Every
   * physical withdrawal joins the local subscription queue, whose operations can wait on the network;
   * the settings pane fires two on mount and the sign-out control lives inside it — on a captive
   * portal whose vapid-key GET stalls, `signOut` blocked for ever: no server logout, no local wipe,
   * the mailbox left in IndexedDB on a machine somebody was done with. The revoke gets a budget;
   * the loser is not cancelled (a late delete is a free win — every store is swept regardless).
   * `row_remains` is the honest answer on a timeout.
   */
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<PushSyncOutcome>((resolve) => {
    timer = setTimeout(() => resolve("row_remains"), WAKE_BUDGET_MS);
  });
  try {
    return await Promise.race([revokeWakeRegistrationNow(opts), budget]);
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
 * ({@link reconcileWakeRegistration}). A stalled platform or network request can delay physical
 * subscription changes. Writing the cache does not wait for the subscription queue.
 */
const WAKE_BUDGET_MS = 4_000;
// The cache revision invalidates an ON in any tab once OFF commits.
let latestWakeIntent = 0;

function confirmedWakeFamily(scope: string | null): string | null {
  if (scope === null || readOwner() !== scope || !sessionMayAsk()) return null;
  const family = boundApiFamily(scope);
  return family !== null && readSessionFamily() === family ? family : null;
}

/** Clear the browser's cached wake display and close its existing notices. */
export async function clearBrowserWakeNotices(): Promise<boolean> {
  try {
    const marker = readOwnerMarker();
    const family = readSessionFamily();
    const holds = () => readOwnerMarker().kind === marker.kind && readSessionFamily() === family &&
      (marker.kind !== "account" || readOwner() === marker.id);
    await editNotifyCache((cache) => putCurrentNotifyState(cache, disarmedState("", ""), holds), true);
    if (!holds()) return false;
    await browserNoticePage.closeAll(true);
    return true;
  } catch {
    return false;
  }
}

/** The revoke itself. Never throws; see {@link revokeWakeRegistration} for the bound around it. */
async function revokeWakeRegistrationNow(opts?: { signingOutOf?: string; expectedFamily?: string }): Promise<PushSyncOutcome | null> {
  const family = opts?.expectedFamily ?? readSessionFamily();
  const owner = readOwner();
  const holds = () => readSessionFamily() === family && readOwner() === owner;
  if (!holds()) return null;
  await clearBrowserWakeNotices();
  if (!holds()) return null;
  try {
    return await withWakeSubscription(async () =>
      (await browserNotificationHost.syncSubscription?.(false, { ...opts, mayWithdraw: holds })) ?? null);
  } catch {
    /* The host's own guard threw before its try block could catch — a mocked `../api-client` with
       no `apiConfigured`, or a platform without one. Reported as the state that is true either
       way: nothing here proved the server row gone. */
    return "row_remains";
  }
}

/** Validate the acknowledgment under the same lock the worker uses to read its state. */
function finishWakeIntent(
  session: { owner: string; family: string } | undefined, fallbackBody: string, revision: string | undefined,
  isCurrent: () => boolean,
): Promise<void> {
  return editNotifyCache(async (cache) => {
    const prior = await readNotifyState(cache);
    if (wakeStorage.get(pendingOffKey) !== null || prior?.revision !== revision) return;
    const previous = prior?.registration;
    const registration = session && {
      ...session,
      proof: previous?.owner === session.owner && previous.family === session.family
        ? previous.proof
        : crypto.randomUUID(),
    };
    await putCurrentNotifyState(cache, {
      enabled: registration !== undefined,
      ...(registration === undefined ? {} : { registration }),
      title: typeof prior?.title === "string" ? prior.title : "ohmail",
      body: typeof prior?.body === "string" ? prior.body : fallbackBody,
      ...(revision === undefined ? {} : { revision }),
    }, isCurrent);
  });
}

/**
 * Re-label the worker's words, and touch nothing else. The account locale is adopted after
 * boot, off `GET /consent`; by then the boot reconcile has written the notify-state body in the
 * DEVICE's language and nothing rewrote it until somebody opened Settings — a German account on
 * an English device got "New mail." on the lock screen. It re-writes the WORDS and preserves
 * `enabled` exactly as stored: recomputing it here from `subscriptionWanted()` — an intent — is
 * how the previous user's surviving registration gets re-armed; a relabel is not a reconcile.
 * When no state is stored, record the words with the worker disarmed until registration.
 */
export function updateNotifyWords(title: string, body: string, owner = readOwner()): Promise<void> {
  const family = confirmedWakeFamily(owner);
  const isCurrent = () => family !== null && confirmedWakeFamily(owner) === family;
  return editNotifyCache(async (cache) => {
    if (!isCurrent()) return;
    const prior = await readNotifyState(cache);
    const registration = prior?.registration;
    const enabled = prior?.enabled === true && registration?.owner === owner && registration.family === family;
    await putCurrentNotifyState(cache, {
      title, body, enabled, revision: prior?.revision, registration: enabled ? registration : undefined,
    }, isCurrent);
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
  host: NotificationHost, wanted: boolean, body: string, scope = readOwner(),
): Promise<PushSyncOutcome | null> {
  const family = confirmedWakeFamily(scope);
  if (scope === null || family === null) return null;
  const intent = ++latestWakeIntent;
  const holdsOwner = () => confirmedWakeFamily(scope) === family;
  const isCurrent = () => intent === latestWakeIntent && holdsOwner();
  // A late receipt can still identify the row that the pending sign-out needs to delete.
  const mayPublish = () => holdsOwner() ||
    (readOwnerMarker().kind === "signed-out" && readSessionFamily() === family);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<PushSyncOutcome>((resolve) => {
    timer = setTimeout(() => resolve("not_registered"), WAKE_BUDGET_MS);
  });
  try {
    const off = wanted ? null : disarmedState("ohmail", body);
    let revision: string | undefined;
    let preparedForWake = false;
    let disarmed = false;
    const prepared = editNotifyCache(async (cache) => {
      if (!holdsOwner()) return;
      if (off) {
        disarmed = await writeOff(cache, off);
        return;
      }
      const pending = wakeStorage.get(pendingOffKey);
      if (pending !== null && !await writeOff(cache, disarmedState("ohmail", body, pending))) return;
      revision = (await readNotifyState(cache))?.revision;
      preparedForWake = true;
    });
    const requestScope = { expectedOwner: scope, expectedFamily: family };
    const operation = async () => {
      await prepared;
      if (!holdsOwner()) return null;
      if (off === null) {
        if (typeof caches === "undefined") return "unsupported";
        if (!preparedForWake) return "not_registered";
        return registerWake(host, body, revision, isCurrent, mayPublish, requestScope);
      }
      const outcome = await host.syncSubscription?.(false, { ...requestScope, mayWithdraw: holdsOwner });
      if (!disarmed && holdsOwner()) {
        await editNotifyCache(async (cache) => {
          if (holdsOwner() && wakeStorage.get(pendingOffKey) === off.revision) {
            disarmed = await writeOff(cache, off);
          }
        });
      }
      return holdsOwner() ? disarmed ? outcome ?? null : "row_remains" : null;
    };
    return await Promise.race([withWakeSubscription(operation), budget]);
  } catch {
    return wanted ? "not_registered" : "row_remains";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The BOOT door: the same act, over the stored intent and the browser's own host. */
export async function reconcileWakeRegistration(body: string, scope = readOwner()): Promise<PushSyncOutcome | null> {
  if (confirmedWakeFamily(scope) === null) return null;
  return applyWakeIntent(
    browserNotificationHost, subscriptionWanted(readChannels(scope), browserPermission()), body, scope,
  );
}

/** Arm the worker only after the server acknowledges this browser's current session. */
async function registerWake(
  host: NotificationHost, body: string, revision: string | undefined,
  isCurrent: () => boolean, mayPublish: () => boolean,
  requestScope: { expectedOwner: string; expectedFamily: string },
): Promise<PushSyncOutcome | null> {
  /*
   * ON is written last, and only for a row this boot established. Writing `enabled: true` first
   * ("inert without a subscription") is false on a shared browser: A signs out, the delete fails
   * (`row_remains` retains the row by design), and an up-front enable re-arms the worker for A's
   * registration — the next push for A's mail drawn on B's screen. So: announce first, enable only
   * on an OUTCOME saying this browser holds the row — deliberately NOT `readId() !== null`, which
   * after A's `row_remains` is A's id: the defect wearing a guard. `subscribed` and `unchanged`
   * mean a row names THIS endpoint; all else draws nothing.
   */
  /*
   * What `forceAnnounce` costs, and why: every signed-in boot issues the
   * POST rather than trusting a stored id, so a boot on a bad connection
   * reaches {@link WAKE_BUDGET_MS} more often. The timeout answer is
   * `not_registered`, leaving the worker dark for a reader who legitimately
   * owns the row — no closed-browser notices until the next boot lands.
   * Chosen: enabling on a timeout would render "I could not confirm" as
   * "this browser owns the row", on the one machine where the row may be
   * somebody else's. A missed notice is recoverable; a stranger's mail on your lock screen is not.
   */
  if (!isCurrent()) return null;
  let outcome: PushSyncOutcome | null;
  try {
    outcome = (await host.syncSubscription?.(true, { ...requestScope, forceAnnounce: true, mayRegister: isCurrent, mayPublish })) ?? null;
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
  /* A sign-out or a changed account may have withdrawn this intent while the request was pending. */
  const session = outcome === "subscribed" ? {
    owner: requestScope.expectedOwner, family: requestScope.expectedFamily,
  } : undefined;
  try {
    await finishWakeIntent(session, body, revision, isCurrent);
  } catch { /* no Cache API, or refused */ }
  return isCurrent() ? outcome : null;
}
