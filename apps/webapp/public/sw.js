/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE SERVICE WORKER — draws ONE fixed notice, and only when no window is there to do better
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * This file exists for exactly one case: a wake arrives and the app is not open. When a window
 * IS open it syncs and decides for itself, with the mirror in front of it and the per-event
 * switches to consult; this worker has neither and must not pretend otherwise.
 *
 * A push carries an opaque account and family binding. The worker compares it with the
 * acknowledged registration before acting. It gets the words from the page's cache and the
 * tap target from its own origin.
 *
 * ── AND THE LIMIT OF THAT, WHICH IS NOT THIS FILE'S TO FIX ────────────────────────────────
 *
 * "Within this handler" is doing real work in that sentence. Safari implements DECLARATIVE WEB
 * PUSH: a payload that parses as a declarative notification is rendered by the BROWSER, and this
 * handler is never entered. Everything above is then bypassed — the title, the body and the
 * navigation target come from the payload, which is exactly the primitive this file was written
 * to deny. Nothing a service worker can do prevents it; the choice is made before any of our code
 * runs.
 *
 * What that does and does not mean, stated precisely rather than reassuringly:
 *
 *  · this project's own sender emits a bound wake that is not a declarative notification, so
 *    on every browser its wakes reach this handler and behave as described;
 *  · a paired server the user does not control — a self-hosted install, a friend's machine —
 *    CAN send a declarative payload, and on Safari it will be drawn with text and a tap target
 *    that server chose. On that path the no-mail-content property is a property of the SERVER,
 *    not of this client.
 *
 * It is recorded rather than papered over because the comment above would otherwise be a promise
 * the code cannot keep on a shipping browser.
 *
 * ── AND ONLY WHEN NO WINDOW IS LOOKING ────────────────────────────────────────────────────
 *
 * A notification about mail you are currently reading is the behaviour every mail client is
 * disliked for. If any client is visible, this draws nothing and posts a message instead: the
 * page syncs, sees exactly what changed, and applies the per-event switches this worker cannot.
 *
 * ── WHY PER-EVENT SWITCHES DO NOT APPLY HERE, STATED RATHER THAN HIDDEN ───────────────────
 *
 * They cannot. The wake says only "something changed" — by design, because the kind of thing
 * that changed is a fact about somebody's mail and does not belong on the wire. With no window
 * to sync, this worker cannot know whether it was new mail, a screened sender, or a scheduled
 * send finishing. So the closed-app notice is tied to the NEW MAIL switch alone: the app does
 * not subscribe at all unless that one is on, and this worker draws nothing when the stored
 * state says otherwise. The same limit the phone has, for the same reason.
 */

/** Where the page leaves the words and the switch state. Never the network, never the payload. */
const NOTIFY_CACHE = "ohmail-notify-v1";
const NOTIFY_STATE_URL = "/__ohmail_notify_state";
const NOTIFY_STATE_LOCK = "ohmail-notify-state"; // Also held by the page while changing this cache.
const NOTIFY_LOCK_WAIT_MS = 4_000;
/** The longest title or body this worker draws, in characters; a longer one draws nothing. */
const WORDS_MAX = 120;

/**
 * Read the words and registration last acknowledged for this browser session.
 *
 * A miss means the page has never written one — a worker that outlived its app, or a browser
 * that cleared storage. The answer then is to draw NOTHING. Defaulting the other way would put a
 * notice on screen for someone who may have turned notifications off, using words this worker
 * would have to invent, in a language it does not know.
 */
async function notifyState() {
  try {
    const cache = await caches.open(NOTIFY_CACHE);
    const hit = await cache.match(NOTIFY_STATE_URL);
    if (!hit) return null;
    const state = await hit.json();
    if (!state || state.enabled !== true) return null;
    if (typeof state.title !== "string" || typeof state.body !== "string") return null;
    if ([...state.title].length > WORDS_MAX || [...state.body].length > WORDS_MAX) return null;
    const registration = state.registration;
    if (!registration || typeof registration.proof !== "string" || registration.proof === "" ||
        typeof registration.owner !== "string" || registration.owner === "" ||
        registration.owner === "signed_out_pending" ||
        typeof registration.family !== "string" || registration.family === "") return null;
    return { title: state.title, body: state.body, registration };
  } catch {
    return null;
  }
}

/** Is a window of this app on screen right now? */
async function aWindowIsVisible() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.some((c) => c.visibilityState === "visible");
}

async function liveRegistration(registration) {
  if (!self.cookieStore) return false;
  const [owner, family] = await Promise.all([
    self.cookieStore.get("tf_owner"), self.cookieStore.get("tf_family"),
  ]);
  return owner?.value === registration.owner && family?.value === registration.family;
}

async function withNotifyState(use) {
  let timer;
  try {
    const locks = self.navigator && self.navigator.locks;
    if (!locks) return false;
    const budget = new AbortController();
    timer = setTimeout(() => budget.abort(), NOTIFY_LOCK_WAIT_MS);
    return await locks.request(NOTIFY_STATE_LOCK, { signal: budget.signal }, async () => {
      clearTimeout(timer);
      const state = await notifyState();
      return state === null ? false : use(state);
    });
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function readBinding(data) {
  try {
    const text = data?.text();
    if (typeof text !== "string" || text.length > 128) return null;
    const wake = JSON.parse(text);
    return wake?.type === "wake" && Object.keys(wake).length === 2 &&
      typeof wake.binding === "string" && /^[a-f0-9]{64}$/.test(wake.binding) ? wake.binding : null;
  } catch {
    return null;
  }
}

async function matchingWake(state, binding) {
  if (state === null) return false;
  const { owner, family } = state.registration;
  const input = new TextEncoder().encode(JSON.stringify([owner, family]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const expected = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return binding === expected && await liveRegistration(state.registration);
}

function drawStoredNotice(binding) {
  return withNotifyState(async (state) => {
    if (await aWindowIsVisible() || !await matchingWake(state, binding)) return false;
    await self.registration.showNotification(state.title, {
      body: state.body,
      // Ten wakes while the laptop is shut collapse into one notice instead of stacking.
      tag: "ohmail-new-mail",
      renotify: false,
      data: { wake: state.registration.proof },
    });
    return true;
  });
}

self.addEventListener("push", (event) => {
  const binding = readBinding(event.data);
  if (binding === null) return;
  event.waitUntil((async () => {
    const clientsOpen = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    // A VISIBLE window handles this itself — it can sync and read the switches. Tell it a wake
    // arrived and draw nothing. The page receives a fixed sync nudge.
    if (await aWindowIsVisible()) {
      if (!await matchingWake(await notifyState(), binding)) return;
      for (const c of clientsOpen) c.postMessage({ type: "ohmail:wake" });
      return;
    }

    // No window looking. Draw the app's own fixed words, if the app said to.
    if (!(await drawStoredNotice(binding))) {
      // A window can come back during the wait. Let it handle the wake as it normally would.
      const nowOpen = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (nowOpen.some((c) => c.visibilityState === "visible") && await matchingWake(await notifyState(), binding)) {
        for (const c of nowOpen) c.postMessage({ type: "ohmail:wake" });
      }
      return;
    }
    // Background windows that exist but are not visible still get the nudge, so the moment one
    // is brought forward it is already current.
    for (const c of clientsOpen) c.postMessage({ type: "ohmail:wake" });
  })());
});

function askNoticeWindow(client, opening) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (accepted) => {
      clearTimeout(timer);
      channel.port1.close();
      if (accepted) resolve(client);
      else reject();
    };
    const timer = setTimeout(() => finish(false), 600);
    channel.port1.onmessage = ({ data }) => finish(data === true);
    try {
      client.postMessage({ type: "ohmail:notice-open", ...opening }, [channel.port2]);
    } catch {
      channel.port2.close();
      finish(false);
    }
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const windows = all.filter((client) => client.url.startsWith(scope) && "focus" in client);
    const { tag, data } = event.notification;
    const open = typeof data?.open === "string" ? data.open : "";
    const calendar = typeof tag === "string" && tag.startsWith("ohmail-cal-");
    if ((tag === "ohmail-new-mail" || calendar) && /^[a-f0-9-]{36}$/.test(open)) {
      // Only the window that drew the notice can resolve its opaque handle.
      const owner = await Promise.any(windows.map((client) => askNoticeWindow(client, { open }))).catch(() => null);
      return owner?.focus();
    }
    if (tag === "ohmail-new-mail") {
      return withNotifyState(async ({ registration }) => {
        if (data?.wake !== registration.proof || !await liveRegistration(registration)) return false;
        const ohbox = new URL("mailbox#/ohbox", scope).href;
        const mailbox = windows.find((client) => client.url.split("#")[0] === ohbox.split("#")[0]);
        const { owner, family } = registration;
        const accepted = mailbox
          ? await askNoticeWindow(mailbox, { wake: { owner, family } }).catch(() => null)
          : null;
        if (!await liveRegistration(registration)) return false;
        if (accepted) return accepted.focus();
        const destination = new URL(scope);
        destination.searchParams.set("wake", "1");
        destination.hash = `wake=${registration.proof}`;
        if (self.clients.openWindow) return self.clients.openWindow(destination.href);
        return false;
      });
    }
    if (calendar) return undefined;
    if (windows.length > 0) return windows[0].focus();
    if (self.clients.openWindow) return self.clients.openWindow(scope);
    return undefined;
  })());
});

// Take over as soon as installed, so turning notifications on does not need a reload to work.
self.addEventListener("install", () => { void self.skipWaiting(); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });
