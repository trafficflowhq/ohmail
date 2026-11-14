/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markSignedOutPending } from "@ohmail/app-logic/storage/owner-cookie";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A WAKE REGISTRATION MUST NOT OUTLIVE THE SESSION THAT MINTED IT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
 *
 * The server's sign-out prune is DEVICE-scoped: `logout` reads the session's `device_id` and
 * deletes the push rows carrying it. A browser ceremony mints NO device row — the auto-mint map
 * in `session-lifecycle.ts` covers only the desktop kinds, and `auth-service.test.ts` asserts
 * through the real ceremony that an exchanged web session's `deviceId` is null — so a browser's
 * `push_subscriptions` row is deviceless, the prune returns early, and the row survives.
 *
 * The sender does not care about any of that: `push-wake.ts` selects on the account and the
 * transport, and `push-wake.e2e.pg.test.ts`'s browser arm proves end-to-end that a deviceless
 * `webpush` row IS dialled. Nothing unregisters the push service either, so the endpoint keeps
 * answering 2xx and the sender's prune-on-404/410 never fires. The row and the traffic are
 * permanent: a shared browser, signed out, still woken for the previous account's mail.
 *
 * ── WHY THE CLIENT CLOSES IT ──────────────────────────────────────────────────────────────
 *
 * This browser is the only party that knows WHICH deviceless row is its own — it kept the id.
 * The server cannot: deleting every deviceless registration on the account would silently end
 * another browser's notifications, which is why its prune deliberately does not guess.
 *
 * The `syncWebPush` OFF path is covered in `web-push-subscription.test.ts`. What is covered HERE
 * is the sign-out wrapper around it: the notify-state half, and that it cannot throw out of a
 * sign-out. The ORDER — before `auth.logout()`, and before the sweep takes the id — is asserted
 * in `sign-out-clears-durable-stores.test.ts`, on the source and by position.
 */

const cachePuts: { url: string; body: string }[] = [];
const cacheDeletes: string[] = [];

function installFakeCaches({ beforeRead, beforeWrite }: {
  beforeRead?: () => Promise<void>;
  beforeWrite?: (enabled: boolean) => Promise<void>;
} = {}): void {
  let body: string | undefined;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: () => Promise.resolve({
        match: async () => {
          const held = body;
          await beforeRead?.();
          return held === undefined ? undefined : new Response(held);
        },
        put: async (url: string, res: Response) => {
          const next = await res.text();
          await beforeWrite?.(JSON.parse(next).enabled);
          body = next;
          cachePuts.push({ url, body });
        },
        delete: async (url: string) => {
          const found = body !== undefined;
          body = undefined;
          cacheDeletes.push(url);
          return found;
        },
      }),
    },
  });
}

/** A browser holding a live subscription the server has a row for. */
function installSubscribedBrowser(unsubscribed: { value: boolean }, beforeRead?: () => Promise<void>): void {
  const sub = {
    endpoint: "https://push.example/ep/abc",
    getKey: (n: string) => new Uint8Array(n === "auth" ? 16 : 65).fill(7).buffer,
    unsubscribe: () => { unsubscribed.value = true; return Promise.resolve(true); },
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: () => Promise.resolve({
        pushManager: { getSubscription: async () => { await beforeRead?.(); return sub; } },
      }),
    },
  });
}

const deleted: string[] = [];
/** What each DELETE was handed beside the id: the sign-out press's pass, or nothing. */
const passes: unknown[] = [];
const subscribe = vi.fn(async () => ({ id: "unused" }));

/* The Cloud client, configured as a browser build. Synthetic responses let the suite order
   a registration acknowledgment against the corresponding session change. */
vi.mock("../app/api-client", () => ({
  apiConfigured: () => true,
  push: {
    vapidKey: () => Promise.resolve({ publicKey: null }),
    subscribe: () => subscribe(),
    unsubscribe: (id: string, opts?: unknown) => { deleted.push(id); passes.push(opts); return Promise.resolve(); },
  },
}));

describe("revokeWakeRegistration", () => {
  beforeEach(() => {
    cachePuts.length = 0;
    cacheDeletes.length = 0;
    deleted.length = 0;
    passes.length = 0;
    subscribe.mockReset();
    subscribe.mockResolvedValue({ id: "unused" });
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    window.localStorage.clear();
    installFakeCaches();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: async (_name: string, write: () => Promise<void>) => write() },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "locks");
    vi.resetModules();
  });

  it("deletes THIS browser's row by the id it kept, and drops the local subscription", async () => {
    const { revokeWakeRegistration } = await import("../app/shell/notification-settings");
    const unsubscribed = { value: false };
    installSubscribedBrowser(unsubscribed);
    window.localStorage.setItem("ohmail.notifications.subscriptionId", "row-7");
    window.localStorage.setItem("ohmail.notifications.subscriptionEndpoint", "https://push.example/ep/abc");

    const outcome = await revokeWakeRegistration();

    // The id is the ONLY handle that names this deviceless row; the server cannot derive it.
    expect(deleted, "the server row was left for the sender to keep dialling").toEqual(["row-7"]);
    // …and the local half, which is what makes the endpoint answer 404/410 so that a row a
    // failed delete left behind is collected by the sender's own prune.
    expect(unsubscribed.value, "the browser kept its push subscription").toBe(true);
    expect(outcome).toBe("unsubscribed");
  });

  it("hands the sign-out press's account to the DELETE on both turn-off paths, and nothing when it names none", async () => {
    /* The press marks the jar pending before it revokes, so the row's DELETE carries the account the
       jar named at the press (`api-client.ts` lets that one call through). Both OFF paths delete a row:
       a live subscription, and an id left with no subscription under it. */
    const { revokeWakeRegistration } = await import("../app/shell/notification-settings");
    installSubscribedBrowser({ value: false });
    window.localStorage.setItem("ohmail.notifications.subscriptionId", "row-live");
    await revokeWakeRegistration({ signingOutOf: "acct_A" });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register: () => Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(null) } }) },
    });
    window.localStorage.setItem("ohmail.notifications.subscriptionId", "row-left");
    await revokeWakeRegistration({ signingOutOf: "acct_A" });
    window.localStorage.setItem("ohmail.notifications.subscriptionId", "row-bare");
    await revokeWakeRegistration();
    expect(deleted).toEqual(["row-live", "row-left", "row-bare"]);
    expect(passes, "the press's account did not reach the DELETE, or a bare revoke carried one")
      .toEqual([{ signingOutOf: "acct_A" }, { signingOutOf: "acct_A" }, undefined]);
  });

  it("closes every notice of the origin still listed before it answers", async () => {
    // A sign-out that unloads the page runs no cleanup of the shell: this close is the one take-back.
    const { revokeWakeRegistration } = await import("../app/shell/notification-settings");
    const n1 = { close: vi.fn() };
    const n2 = { close: vi.fn() };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: () => Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(null) } }),
        getRegistration: () => Promise.resolve({ getNotifications: () => Promise.resolve([n1, n2]) }),
      },
    });

    await revokeWakeRegistration();

    expect(n1.close, "a notice of the account left stays listed").toHaveBeenCalledTimes(1);
    expect(n2.close).toHaveBeenCalledTimes(1);
  });

  it("writes the notify state OFF — the last half, for a row that somehow survives", async () => {
    /*
     * The service worker never reads the push payload; the words it may draw live in this cache
     * entry alone. Set to `enabled: false` it draws nothing, so a browser that failed BOTH the
     * local unsubscribe and the server delete still shows the next person nothing. Written
     * unconditionally and first, because it is the one half that needs neither the network nor a
     * live subscription.
     */
    const { revokeWakeRegistration, NOTIFY_STATE_URL } =
      await import("../app/shell/notification-settings");
    installSubscribedBrowser({ value: false });

    await revokeWakeRegistration();

    const state = cachePuts.find((p) => p.url === NOTIFY_STATE_URL);
    expect(state, "the worker was left holding its old permission to draw").toBeTruthy();
    expect(JSON.parse(state!.body).enabled).toBe(false);
  });

  it("keeps the worker disarmed when a registration started before sign-out answers late", async () => {
    const { applyWakeIntent, browserNotificationHost, revokeWakeRegistration } =
      await import("../app/shell/notification-settings");
    installSubscribedBrowser({ value: false });
    document.cookie = "tf_owner=account_A; Path=/";
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: (value: { id: string }) => void;
    subscribe.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => { finish = resolve; });
    });

    const waking = applyWakeIntent(browserNotificationHost, true, "Mail from the old session");
    await started;
    markSignedOutPending();
    const signingOut = revokeWakeRegistration({ signingOutOf: "account_A" });
    finish({ id: "row-old" });
    await Promise.all([waking, signingOut]);

    expect(deleted).toEqual(["row-old"]);
    expect(cachePuts.map(({ body }) => JSON.parse(body).enabled)).toEqual([false]);
  });

  it("keeps a late registration from another account from enabling the worker", async () => {
    const { applyWakeIntent, browserNotificationHost } = await import("../app/shell/notification-settings");
    installSubscribedBrowser({ value: false });
    document.cookie = "tf_owner=account_A; Path=/";
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: (value: { id: string }) => void;
    subscribe.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => { finish = resolve; });
    });

    const waking = applyWakeIntent(browserNotificationHost, true, "Mail from the old session");
    await started;
    document.cookie = "tf_owner=account_B; Path=/";
    finish({ id: "row-old" });
    await waking;
    expect(cachePuts).toEqual([]);

    subscribe.mockResolvedValueOnce({ id: "row-current" });
    await expect(applyWakeIntent(browserNotificationHost, true, "Mail from this session")).resolves.toBe("subscribed");
    expect(cachePuts.map(({ body }) => JSON.parse(body))).toEqual([
      { enabled: true, title: "ohmail", body: "Mail from this session" },
    ]);
  });

  it("keeps the worker disarmed when the signed-in account changes during the cache read", async () => {
    const { applyWakeIntent, browserNotificationHost } = await import("../app/shell/notification-settings");
    installSubscribedBrowser({ value: false });
    document.cookie = "tf_owner=account_A; Path=/";
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const release = new Promise<void>((resolve) => { finish = resolve; });
    installFakeCaches({ beforeRead: () => { entered(); return release; } });

    const waking = applyWakeIntent(browserNotificationHost, true, "Mail from the old session");
    await reading;
    document.cookie = "tf_owner=account_B; Path=/";
    finish();
    await expect(waking).resolves.toBeNull();
    expect(cachePuts).toEqual([]);
  });

  it("keeps the worker disarmed when another tab signs out during a language change", async () => {
    const openTab = await import("../app/shell/notification-settings");
    installSubscribedBrowser({ value: false });
    document.cookie = "tf_owner=account_A; Path=/";
    let holdRead = false;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const release = new Promise<void>((resolve) => { finish = resolve; });
    installFakeCaches({ beforeRead: async () => {
      if (!holdRead) return;
      entered();
      await release;
    } });
    await expect(openTab.applyWakeIntent(openTab.browserNotificationHost, true, "Mail")).resolves.toBe("subscribed");
    holdRead = true;
    const relabelling = openTab.updateNotifyWords("Mail", "Neue Mail.");
    await reading;

    // Each tab has its own module queue, with one owner cookie and worker cache between them.
    vi.resetModules();
    const otherTab = await import("../app/shell/notification-settings");
    markSignedOutPending();
    await otherTab.revokeWakeRegistration({ signingOutOf: "account_A" });
    finish();
    await relabelling;

    expect(cachePuts.map(({ body }) => JSON.parse(body).enabled)).toEqual([true, false]);
  });

  it("does not start a wake registration after the account changes during browser setup", async () => {
    const { applyWakeIntent, browserNotificationHost } = await import("../app/shell/notification-settings");
    document.cookie = "tf_owner=account_A; Path=/";
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const release = new Promise<void>((resolve) => { finish = resolve; });
    installSubscribedBrowser({ value: false }, () => { entered(); return release; });

    const waking = applyWakeIntent(browserNotificationHost, true, "Mail from the old session");
    await reading;
    document.cookie = "tf_owner=account_B; Path=/";
    finish();

    await expect(waking).resolves.toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
    expect(cachePuts).toEqual([]);
  });

  it("reports a browser without a shared lock as unavailable for closed-window wakes", async () => {
    const { applyWakeIntent, browserNotificationHost } = await import("../app/shell/notification-settings");
    installSubscribedBrowser({ value: false });
    Reflect.deleteProperty(navigator, "locks");
    document.cookie = "tf_owner=account_A; Path=/";

    await expect(applyWakeIntent(browserNotificationHost, true, "Mail")).resolves.toBe("unsupported");
    expect(subscribe).not.toHaveBeenCalled();
    expect(cachePuts.map(({ body }) => JSON.parse(body).enabled)).toEqual([false]);
  });

  it("clears an enable already writing to the cache when the signed-in account changes", async () => {
    const { applyWakeIntent, browserNotificationHost } = await import("../app/shell/notification-settings");
    installSubscribedBrowser({ value: false });
    document.cookie = "tf_owner=account_A; Path=/";
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const release = new Promise<void>((resolve) => { finish = resolve; });
    installFakeCaches({ beforeWrite: async (enabled) => { if (enabled) { entered(); await release; } } });

    const waking = applyWakeIntent(browserNotificationHost, true, "Mail from the old session");
    await writing;
    document.cookie = "tf_owner=account_B; Path=/";
    finish();

    await expect(waking).resolves.toBeNull();
    const last = JSON.parse(cachePuts.at(-1)!.body);
    expect(last.enabled).toBe(false);
  });

  it("removes a stale enable if the cache refuses to replace it with a disarmed state", async () => {
    const { applyWakeIntent, browserNotificationHost, NOTIFY_CACHE, NOTIFY_STATE_URL } =
      await import("../app/shell/notification-settings");
    installSubscribedBrowser({ value: false });
    document.cookie = "tf_owner=account_A; Path=/";
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const release = new Promise<void>((resolve) => { finish = resolve; });
    installFakeCaches({ beforeWrite: async (enabled) => {
      if (!enabled) throw new DOMException("storage full", "QuotaExceededError");
      entered();
      await release;
    } });

    const waking = applyWakeIntent(browserNotificationHost, true, "Mail from the old session");
    await writing;
    document.cookie = "tf_owner=account_B; Path=/";
    finish();

    await expect(waking).resolves.toBeNull();
    expect(cacheDeletes).toEqual([NOTIFY_STATE_URL]);
    const cache = await caches.open(NOTIFY_CACHE);
    await expect(cache.match(NOTIFY_STATE_URL)).resolves.toBeUndefined();
  });

  it("orders a different tab's sign-out behind the pending cache write", async () => {
    const openTab = await import("../app/shell/notification-settings");
    installSubscribedBrowser({ value: false });
    document.cookie = "tf_owner=account_A; Path=/";
    let cacheQueue: Promise<unknown> = Promise.resolve();
    const request = vi.fn((name: string, write: () => Promise<void>) => {
      expect(name).toBe("ohmail-notify-state");
      const pending = cacheQueue.then(write);
      cacheQueue = pending;
      return pending;
    });
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const release = new Promise<void>((resolve) => { finish = resolve; });
    installFakeCaches({ beforeWrite: async (enabled) => { if (enabled) { entered(); await release; } } });
    const waking = openTab.applyWakeIntent(openTab.browserNotificationHost, true, "Mail");
    await writing;

    vi.resetModules();
    const otherTab = await import("../app/shell/notification-settings");
    markSignedOutPending();
    const signingOut = otherTab.revokeWakeRegistration({ signingOutOf: "account_A" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(cachePuts).toEqual([]);
    finish();
    await Promise.all([waking, signingOut]);

    expect(cachePuts.map(({ body }) => JSON.parse(body).enabled)).toEqual([true, false, false]);
    expect(deleted).toEqual(["unused"]);
  });

  it("a STALLED push queue cannot hold the sign-out open — the revoke has a budget", async () => {
    /*
     * FOUND BY REVIEW, and it inverted `sign-out.ts`'s central invariant: "the wipe runs
     * REGARDLESS". Two facts compose. Every call in this module goes through one module-global
     * queue, so it cannot START until every op already queued has settled; and the queued ops are
     * `fetch`es with no timeout. The settings pane fires a pair of them on mount and the sign-out
     * control lives inside that pane — so on a connection where one request merely STALLS, the
     * chain never advances and `signOut` would await here for ever: no `auth.logout()`, no local
     * wipe, the session still live and the whole mailbox still in IndexedDB on a machine somebody
     * has just said they are done with. Strictly worse than the residue this slice closes.
     *
     * Reproduced as the finding describes it — by blocking the QUEUE rather than the request —
     * because that is the path that made an unbounded wait reachable from a control that looks
     * local.
     */
    vi.useFakeTimers();
    try {
      const mod = await import("../app/shell/notification-settings");
      installSubscribedBrowser({ value: false });
      // An op that never settles, queued ahead of the revoke: the settings pane's mount write.
      Object.defineProperty(globalThis, "caches", {
        configurable: true,
        value: { open: () => new Promise(() => { /* never resolves */ }) },
      });
      void mod.writeNotifyStateUnchecked(true, "ohmail", "new mail");

      const revoke = mod.revokeWakeRegistration();
      let settled = false;
      void revoke.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(3_000);
      expect(settled, "it must actually wait — a revoke that gives up at once is not best-effort")
        .toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      // `row_remains` is the honest answer: nothing here proved the row gone.
      await expect(revoke).resolves.toBe("row_remains");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not throw when there is no push machinery at all — a sign-out must not depend on it", async () => {
    // A private window, a browser with no service worker, or a build whose Cloud client is
    // aliased out. `signOut` calls this before `auth.logout()`, so a throw here would skip the
    // revoke, the logout AND the local wipe — leaving the mail and the name on the machine,
    // which is the exact failure `sign-out.ts` exists to prevent.
    const { revokeWakeRegistration } = await import("../app/shell/notification-settings");
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
    Reflect.deleteProperty(globalThis as Record<string, unknown>, "caches");

    await expect(revokeWakeRegistration()).resolves.toBe("unsupported");
  });
});
