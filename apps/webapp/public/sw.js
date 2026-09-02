/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE SERVICE WORKER — draws ONE fixed notice, and only when no window is there to do better
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * This file exists for exactly one case: a wake arrives and the app is not open. When a window
 * IS open it syncs and decides for itself, with the mirror in front of it and the per-event
 * switches to consult; this worker has neither and must not pretend otherwise.
 *
 * ── IT NEVER READS THE PUSH PAYLOAD. NOT ONE FIELD. ───────────────────────────────────────
 *
 * The wake is a closed constant with nothing in it, and the sender is held to that by a census
 * over its own source. But "the payload is empty" is a property of OUR server, and this worker
 * runs against whatever server the user paired with — the hosted one, an operator's own install,
 * or a friend's machine. A worker that rendered `payload.title` would let that server draw a
 * notice in ohmail's name with text and a tap target of its own choosing. That is a phishing
 * primitive, and the fact that our own server would never use it is not a defence.
 *
 * So: `event.data` is never parsed, never read, never logged. The words below come from the
 * PAGE — written into a cache entry by the app itself, in the user's own language — and the tap
 * target is this app's own origin. The worst a hostile paired server can do is cause a spurious
 * notice with our fixed text, which is inside the power it already has (it decides whether to
 * wake at all) rather than a new one.
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

/**
 * Read what the page last stored: `{ enabled, title, body }`.
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
    return state;
  } catch {
    return null;
  }
}

/** Is a window of this app on screen right now? */
async function aWindowIsVisible() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.some((c) => c.visibilityState === "visible");
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const clientsOpen = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    // A VISIBLE window handles this itself — it can sync and read the switches. Tell it a wake
    // arrived and draw nothing. `postMessage` carries no payload content because none was read.
    if (await aWindowIsVisible()) {
      for (const c of clientsOpen) c.postMessage({ type: "ohmail:wake" });
      return;
    }

    // No window looking. Draw the app's own fixed words, if the app said to.
    const state = await notifyState();
    if (state === null) return;
    await self.registration.showNotification(state.title, {
      body: state.body,
      // A single tag, so ten wakes while the laptop is shut collapse into one notice rather
      // than stacking ten identical ones.
      tag: "ohmail-new-mail",
      renotify: false,
      // No `data` from anywhere but here: the click handler below derives its target from the
      // worker's own scope, never from anything that arrived over the network.
      data: { scope: self.registration.scope },
    });
    // Background windows that exist but are not visible still get the nudge, so the moment one
    // is brought forward it is already current.
    for (const c of clientsOpen) c.postMessage({ type: "ohmail:wake" });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Prefer an existing window — opening a second copy of a mail client is not what the tap meant.
    for (const c of all) {
      if (c.url.startsWith(scope) && "focus" in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(scope);
    return undefined;
  })());
});

// Take over as soon as installed, so turning notifications on does not need a reload to work.
self.addEventListener("install", () => { void self.skipWaiting(); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });
