/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  SIGNING BACK IN MUST PUT BACK WHAT SIGNING OUT TOOK AWAY
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The mirror image of `sign-out-revokes-wake.test.ts`, and it exists because closing the defect
 * that file guards opened this one.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
 *
 * Sign-out deletes this browser's `push_subscriptions` row, drops the local subscription, and
 * writes the service worker's notify-state `enabled: false`. Two things deliberately SURVIVE it:
 * `ohmail.notifications.channels` — a per-install preference, like the theme, and sweeping it
 * would be honest about the wire and wrong about the person — and the OS permission, which is
 * the browser's to hold and not ours.
 *
 * So the same reader signing back in on their own laptop had `subscriptionWanted()` true, every
 * switch in the pane rendering ON, and behind them no server row and a worker under orders not
 * to draw. Closed-browser new-mail notices were silently off, with nothing on screen to say so.
 * Nothing re-established either half: the app's ONLY reconcile was `SettingsView`'s mount
 * effect, so the switches told the truth again if and only if the reader went looking in
 * Settings.
 *
 * ── WHAT IS COVERED WHERE ─────────────────────────────────────────────────────────────────
 *
 * The `syncWebPush` ON path itself is covered in `web-push-subscription.test.ts`. What is
 * covered HERE is the boot wrapper around it: that it restores BOTH halves from the stale state
 * a sign-out leaves, that it reconciles to what the switches actually say rather than to ON,
 * that a stalled queue cannot hold the shell's boot open, and that it cannot throw out of a boot
 * effect. That the SHELL calls it — once per sign-in, with Settings never mounted — is
 * `shell-boot-reconciles-wake.test.ts`.
 */

const cachePuts: { url: string; body: string }[] = [];

function installFakeCaches(): void {
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: () => Promise.resolve({
        put: async (url: string, res: Response) => {
          cachePuts.push({ url, body: await res.text() });
        },
        /* The relabel READS what is stored, so the fake has to hold it. Last write wins, which is
           what a real Cache does for one key. */
        match: async (url: string) => {
          const held = [...cachePuts].reverse().find((p) => p.url === url);
          return held ? new Response(held.body, { headers: { "content-type": "application/json" } }) : undefined;
        },
      }),
    },
  });
}

/** What `Notification.permission` says. A returning browser still holds its grant. */
function installPermission(value: string): void {
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: { permission: value },
  });
}

const subscribed: { endpoint: string }[] = [];
/** Row ids the client asked the server to DELETE — a spurious supersede shows up here. */
const unsubscribed: string[] = [];
let subscribeFails = false;
/** The conflict answer: 201 with no `id`, because the row belongs to another account. */
let subscribeReturnsNoId = false;

/**
 * A browser with NO push subscription — the state a sign-out leaves behind, and the one this
 * reconcile has to climb out of. `subscribe` mints one the way the platform would.
 */
function installUnsubscribedBrowser(): void {
  const made = {
    endpoint: "https://push.example/ep/new",
    getKey: (n: string) => new Uint8Array(n === "auth" ? 16 : 65).fill(3).buffer,
    unsubscribe: () => Promise.resolve(true),
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: () => Promise.resolve({
        pushManager: {
          getSubscription: () => Promise.resolve(null),
          subscribe: () => Promise.resolve(made),
        },
      }),
    },
  });
}

/* The Cloud client, configured — the shape a browser build has. A real VAPID key, because the
   ON path decodes it before it may subscribe. */
vi.mock("../app/api-client", () => ({
  apiConfigured: () => true,
  push: {
    vapidKey: () => Promise.resolve({ publicKey: "BFAKEa-b_c0123456789" }),
    subscribe: (endpoint: string) => {
      // Recorded BEFORE the refusal: what these cases assert is that the announce was ATTEMPTED,
      // which is the half `forceAnnounce` exists to guarantee.
      subscribed.push({ endpoint });
      if (subscribeFails) return Promise.reject(new Error("no"));
      return Promise.resolve(subscribeReturnsNoId ? {} : { id: "row-new" });
    },
    unsubscribe: (id: string) => { unsubscribed.push(id); return Promise.resolve(); },
  },
}));

/** A browser that still holds a live `PushSubscription` — what an unloaded sign-out leaves. */
function installStillSubscribedBrowser(): void {
  const sub = {
    endpoint: "https://push.example/ep/A",
    getKey: (n: string) => new Uint8Array(n === "auth" ? 16 : 65).fill(9).buffer,
    unsubscribe: () => Promise.resolve(true),
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: () => Promise.resolve({
        pushManager: { getSubscription: () => Promise.resolve(sub), subscribe: () => Promise.resolve(sub) },
      }),
    },
  });
}

const CHANNELS_KEY = "ohmail.notifications.channels";
const ID_KEY = "ohmail.notifications.subscriptionId";

/** Every switch a returning reader left ON, exactly as sign-out preserved them. */
const ALL_ON = JSON.stringify({
  master: true, ohbox: true, screener: true,
  scheduled: true, pairing: true, showSenderAndSubject: false,
});

describe("reconcileWakeRegistration", () => {
  beforeEach(() => {
    cachePuts.length = 0;
    subscribed.length = 0;
    unsubscribed.length = 0;
    subscribeFails = false;
    subscribeReturnsNoId = false;
    window.localStorage.clear();
    installFakeCaches();
    installPermission("granted");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: async (_name: string, write: () => Promise<void>) => write() },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "locks");
    vi.resetModules();
  });

  it("a returning reader gets the row back AND the worker's permission to draw", async () => {
    /*
     * The whole defect in one case. The stale state is exactly what a sign-out leaves: switches
     * still ON, permission still granted, no local subscription, no stored id — and a worker
     * that was last told `enabled: false`.
     */
    const { reconcileWakeRegistration, NOTIFY_STATE_URL } =
      await import("../app/shell/notification-settings");
    installUnsubscribedBrowser();
    window.localStorage.setItem(CHANNELS_KEY, ALL_ON);

    const outcome = await reconcileWakeRegistration("New mail.");

    // The row: without it the sender has no endpoint to dial and the browser is never woken.
    expect(subscribed.map((s) => s.endpoint), "no registration was re-established")
      .toEqual(["https://push.example/ep/new"]);
    expect(window.localStorage.getItem(ID_KEY)).toBe("row-new");
    expect(outcome).toBe("subscribed");

    // The words: the worker draws from this entry alone, and `false` here is the half that made
    // the failure SILENT — a push could arrive and be deliberately dropped.
    const state = cachePuts.find((p) => p.url === NOTIFY_STATE_URL);
    expect(state, "the worker was left under its sign-out orders").toBeTruthy();
    expect(JSON.parse(state!.body).enabled).toBe(true);
  });

  it("reconciles to what the switches SAY — a reader who turned it off stays off", async () => {
    /*
     * The direction guard, and the reason this is a reconcile rather than a re-arm. Restoring
     * notifications for somebody who switched them off would be the same class of lie as the
     * defect above, pointing the other way: a subscription nobody asked for, minted by a boot.
     */
    const { reconcileWakeRegistration, NOTIFY_STATE_URL } =
      await import("../app/shell/notification-settings");
    installUnsubscribedBrowser();
    window.localStorage.setItem(CHANNELS_KEY, JSON.stringify({ master: false, ohbox: true }));

    await reconcileWakeRegistration("New mail.");

    expect(subscribed, "a boot minted a subscription the reader had switched off").toEqual([]);
    const state = cachePuts.find((p) => p.url === NOTIFY_STATE_URL);
    expect(JSON.parse(state!.body).enabled).toBe(false);
  });

  it("the registration stands only while the master and new mail are both on: either off takes it down at the server and in the browser, both on makes it again", async () => {
    const { reconcileWakeRegistration, NOTIFY_STATE_URL } =
      await import("../app/shell/notification-settings");
    // A browser that holds its subscription as a browser does: made by a subscribe, gone after an unsubscribe.
    let held: { endpoint: string } | null = null;
    const pushManager = {
      getSubscription: () => Promise.resolve(held),
      subscribe: () => Promise.resolve(held = {
        endpoint: "https://push.example/ep/new",
        getKey: (n: string) => new Uint8Array(n === "auth" ? 16 : 65).fill(3).buffer,
        unsubscribe: () => { held = null; return Promise.resolve(true); },
      } as { endpoint: string }),
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true, value: { register: () => Promise.resolve({ pushManager }) },
    });
    const switches = (over: object): void =>
      window.localStorage.setItem(CHANNELS_KEY, JSON.stringify({ ...JSON.parse(ALL_ON), ...over }));
    const armed = (): boolean => JSON.parse([...cachePuts].reverse().find((p) => p.url === NOTIFY_STATE_URL)!.body).enabled;

    switches({});
    expect(await reconcileWakeRegistration("New mail.")).toBe("subscribed");
    expect(held, "no subscription in the browser").not.toBeNull();
    expect(subscribed).toHaveLength(1);

    let made = 1;
    for (const off of [{ ohbox: false }, { master: false }]) {
      switches(off);
      expect(await reconcileWakeRegistration("New mail."), JSON.stringify(off)).toBe("unsubscribed");
      expect(held, `${JSON.stringify(off)}: the browser still holds its subscription`).toBeNull();
      expect(unsubscribed.at(-1), `${JSON.stringify(off)}: the server's row was left standing`).toBe("row-new");
      expect(window.localStorage.getItem(ID_KEY)).toBeNull();
      expect(armed(), "the worker may still draw").toBe(false);

      switches({});
      expect(await reconcileWakeRegistration("New mail.")).toBe("subscribed");
      expect(held).not.toBeNull();
      expect(subscribed).toHaveLength(made += 1);
      expect(armed()).toBe(true);
    }

    // The three other switches are no part of it: a closed browser is started for new mail alone.
    const removed = unsubscribed.length;
    switches({ screener: false, scheduled: false, pairing: false });
    await reconcileWakeRegistration("New mail.");
    expect(held, "a switch that is not new mail took the registration down").not.toBeNull();
    expect(unsubscribed).toHaveLength(removed);
    expect(armed()).toBe(true);
  });

  it("a DENIED permission is not talked round by a boot", async () => {
    // `subscriptionWanted` needs all three, and the OS answer is the one we may never overrule.
    const { reconcileWakeRegistration } = await import("../app/shell/notification-settings");
    installUnsubscribedBrowser();
    installPermission("denied");
    window.localStorage.setItem(CHANNELS_KEY, ALL_ON);

    await reconcileWakeRegistration("New mail.");

    expect(subscribed, "a boot subscribed a browser whose owner had refused").toEqual([]);
  });

  it("A SHARED BROWSER: B's boot does not re-arm the worker for A's surviving row", async () => {
    /*
     * ── THE SEQUENCE, AND IT IS THE DEFECT THE SIGN-OUT REVOKE EXISTS TO CLOSE ────────────
     *
     * 1. User A signs out. The account-scoped DELETE fails — a captive portal, a 500, anything —
     *    so `syncWebPush` answers `row_remains` and RETAINS the id ON PURPOSE, because it is the
     *    only handle by which that row can ever be deleted. A's registration is still live and
     *    the sender goes on dialling A's endpoint.
     * 2. The worker is left `enabled: false`, which is the ONLY thing keeping A's mail from being
     *    drawn on this machine.
     * 3. User B signs in on the same browser. The boot reconcile runs.
     *
     * A boot that writes `enabled: true` up front re-arms the worker while the live row is still
     * A's, and the next push for A's mail is drawn on B's screen. Not a content breach — the
     * payload is a constant — but the arrival of a stranger's mail, announced on a machine they
     * have signed out of.
     *
     * Here B's own announce FAILS (the same flaky network that broke A's delete), so nothing
     * establishes a row for B. The worker must stay dark.
     */
    const { reconcileWakeRegistration, NOTIFY_STATE_URL } =
      await import("../app/shell/notification-settings");

    // B's switches are ON, because they are a per-install preference that survives sign-out;
    // A's id, endpoint and server row all survive with them (see the ordering note below).
    window.localStorage.setItem(CHANNELS_KEY, ALL_ON);

    /*
     * ── THE STATE THE PRODUCT ACTUALLY PRODUCES, AND MY FIRST FIXTURE DID NOT ────────────
     *
     * A first version of this case cleared the id and kept the endpoint, on the belief that
     * sign-out sweeps `NOTIFICATION_SUBSCRIPTION_PREFIX` before the unload. It does not, and the
     * order is the whole point: `sign-out.ts` AWAITS `revokeWakeRegistration()` at :130 and
     * sweeps the prefix at :182, strictly after — and the local `unsubscribe()` runs INSIDE that
     * awaited call. So an unload that beat `unsubscribe()` necessarily beat the sweep as well.
     * A's id AND A's endpoint both survive. There is no reachable state in which the endpoint
     * survives and the id does not, and a guard built on one is green against nothing.
     *
     * With both present, B's boot reaches `existing !== null && knownId !== null &&
     * readEndpoint() === existing.endpoint` — the `unchanged` shortcut — which attests that a
     * STORED id matches the live endpoint and says NOTHING about which account owns the row.
     * That is why the boot passes `forceAnnounce` and gates on `subscribed` alone: the announce
     * is re-issued, the server's account-scoped lookup cannot find another account's row, and
     * the refusal is what keeps the worker dark.
     */
    window.localStorage.setItem(ID_KEY, "row-belonging-to-A");
    window.localStorage.setItem(
      "ohmail.notifications.subscriptionEndpoint", "https://push.example/ep/A",
    );
    installStillSubscribedBrowser();
    // The server's answer for a foreign row: the endpoint conflicts and the account-scoped
    // lookup misses, which `push-service.ts` raises as a 500 and the client maps to a refusal.
    subscribeFails = true;

    const outcome = await reconcileWakeRegistration("New mail.");

    // The announce MUST have been attempted — an `unchanged` shortcut here is the defect.
    expect(
      subscribed.map((x) => x.endpoint),
      "the boot took the `unchanged` shortcut and never re-announced",
    ).toEqual(["https://push.example/ep/A"]);
    const state = cachePuts.find((p) => p.url === NOTIFY_STATE_URL);
    expect(
      JSON.parse(state!.body).enabled,
      "the boot re-armed the worker while the only live row still belonged to the previous user",
    ).toBe(false);
    expect(outcome).toBe("not_registered");
  });

  it("…and DOES enable once B's own announce lands", async () => {
    // The other half, so the case above cannot pass by simply never enabling anything. Same
    // residue, same switches — only the announce succeeds this time.
    const { reconcileWakeRegistration, NOTIFY_STATE_URL } =
      await import("../app/shell/notification-settings");
    window.localStorage.setItem(CHANNELS_KEY, ALL_ON);
    installUnsubscribedBrowser();

    await reconcileWakeRegistration("New mail.");

    const state = cachePuts.find((p) => p.url === NOTIFY_STATE_URL);
    expect(JSON.parse(state!.body).enabled).toBe(true);
    // B's row replaced A's id — the worker is armed for a registration this browser owns.
    expect(window.localStorage.getItem(ID_KEY)).toBe("row-new");
  });

  it("the same-user re-announce dedupes to the SAME row — no supersede, no churn", async () => {
    /*
     * `forceAnnounce` makes every signed-in boot issue the POST rather than trusting a stored id.
     * The question that raises: does the ordinary boot now churn the row?
     *
     * It does not, and the reason is the server's coalesced unique index. The same endpoint
     * resolves to the same registration, so the announce comes back with the id already stored,
     * `knownId === id`, and the supersede arm — which exists for an endpoint ROTATION — never
     * fires. A boot that deleted the row it had just re-announced would be a self-inflicted
     * outage, and it is the failure this case exists to make visible.
     */
    const { reconcileWakeRegistration } = await import("../app/shell/notification-settings");
    window.localStorage.setItem(CHANNELS_KEY, ALL_ON);
    // This browser's OWN row and endpoint, as a previous boot left them.
    window.localStorage.setItem(ID_KEY, "row-new");
    window.localStorage.setItem(
      "ohmail.notifications.subscriptionEndpoint", "https://push.example/ep/A",
    );
    installStillSubscribedBrowser();

    const outcome = await reconcileWakeRegistration("New mail.");

    expect(outcome).toBe("subscribed");
    // The announce happened — that is `forceAnnounce`'s whole point.
    expect(subscribed.map((x) => x.endpoint)).toEqual(["https://push.example/ep/A"]);
    // …and nothing was deleted. The stored id and the answered id are the same row.
    expect(unsubscribed, "the boot deleted the registration it had just re-announced").toEqual([]);
    expect(window.localStorage.getItem(ID_KEY)).toBe("row-new");
  });

  it("a STALLED push queue cannot hold the boot open — the reconcile has a budget", async () => {
    /*
     * The same hazard `revokeWakeRegistration` was given a budget for, at the other end of the
     * session. Every call in this module goes through one module-global queue, so it cannot
     * START until every op already queued has settled, and those ops are `fetch`es with no
     * timeout. An unguarded `await` here would let a captive portal stall the shell's own boot
     * path — so it is reproduced the way the hazard is reachable: by blocking the QUEUE.
     */
    vi.useFakeTimers();
    try {
      const mod = await import("../app/shell/notification-settings");
      installUnsubscribedBrowser();
      window.localStorage.setItem(CHANNELS_KEY, ALL_ON);
      // An op that never settles, queued ahead of the reconcile.
      Object.defineProperty(globalThis, "caches", {
        configurable: true,
        value: { open: () => new Promise(() => { /* never resolves */ }) },
      });
      void mod.writeNotifyStateUnchecked(true, "ohmail", "New mail.");

      const boot = mod.reconcileWakeRegistration("New mail.");
      let settled = false;
      void boot.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(3_000);
      expect(settled, "it must actually wait — a reconcile that gives up at once is not best-effort")
        .toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      // `not_registered` is the honest answer: nothing here established a row.
      await expect(boot).resolves.toBe("not_registered");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the LOCALE relabel changes the words and NEVER the `enabled` byte", async () => {
    /*
     * The account's language is adopted after boot, so the words the worker holds are the
     * DEVICE's until something rewrites them. That rewrite must not become a second reconcile:
     * recomputing `enabled` from `subscriptionWanted()` — an INTENT — is precisely how a previous
     * user's surviving registration gets re-armed, which is the case above.
     *
     * So: a boot that established NO row leaves `enabled: false`, and a relabel over it must
     * change only the sentence.
     */
    const { reconcileWakeRegistration, updateNotifyWords, NOTIFY_STATE_URL } =
      await import("../app/shell/notification-settings");

    // The switches say ON, and the announce fails — so `enabled` is stored false.
    window.localStorage.setItem(CHANNELS_KEY, ALL_ON);
    installUnsubscribedBrowser();
    subscribeFails = true;
    await reconcileWakeRegistration("New mail.");
    expect(JSON.parse(cachePuts.at(-1)!.body).enabled).toBe(false);

    await updateNotifyWords("ohmail", "Neue Mail.");

    const last = cachePuts.at(-1)!;
    expect(last.url).toBe(NOTIFY_STATE_URL);
    expect(JSON.parse(last.body).body, "the account's language never reached the worker")
      .toBe("Neue Mail.");
    expect(
      JSON.parse(last.body).enabled,
      "a relabel re-armed the worker — it recomputed `enabled` instead of preserving it",
    ).toBe(false);
  });

  it("…and relabels an ENABLED entry without disarming it", async () => {
    // The other direction, so the case above cannot pass by always writing false.
    const { reconcileWakeRegistration, updateNotifyWords } =
      await import("../app/shell/notification-settings");
    window.localStorage.setItem(CHANNELS_KEY, ALL_ON);
    installUnsubscribedBrowser();
    await reconcileWakeRegistration("New mail.");
    expect(JSON.parse(cachePuts.at(-1)!.body).enabled).toBe(true);

    await updateNotifyWords("ohmail", "Neue Mail.");

    const last = JSON.parse(cachePuts.at(-1)!.body);
    expect(last.body).toBe("Neue Mail.");
    expect(last.enabled).toBe(true);
  });

  it("a relabel with NOTHING stored creates a DISARMED entry, never an armed one", async () => {
    /*
     * This case used to assert that a relabel over nothing wrote nothing, which was right until
     * the relabel became the sole owner of the words. It has to create now — on the boot commit
     * it is queued BEFORE the reconcile's write lands, so returning early would hand the words
     * back to the reconcile and reinstate the clobber.
     *
     * What must NOT change is the direction: a language change may never mint permission to
     * draw. `enabled: false` is the only value it is allowed to invent.
     */
    const { updateNotifyWords, NOTIFY_STATE_URL } =
      await import("../app/shell/notification-settings");

    await updateNotifyWords("ohmail", "Neue Mail.");

    const state = cachePuts.find((p) => p.url === NOTIFY_STATE_URL);
    expect(state, "the relabel wrote nothing, so the reconcile still owns the words").toBeTruthy();
    expect(JSON.parse(state!.body).body).toBe("Neue Mail.");
    expect(
      JSON.parse(state!.body).enabled,
      "a language change armed the worker",
    ).toBe(false);
  });

  it("THE CLOBBER: a locale adopted mid-flight survives the reconcile's own later write", async () => {
    /*
     * ── THE ORDERING THAT DEFEATED THE FIRST RELABEL ─────────────────────────────────────
     *
     * Everything here goes through one queue, and the boot commit enqueues in an order the
     * effect order does not suggest: the push round trip FIRST (the reconcile runs synchronously
     * into `syncSubscription`), the relabel SECOND, and the reconcile's own final write THIRD —
     * carrying a `body` captured at boot, in the DEVICE's language.
     *
     * So a locale adopted while the push request is in flight — the ordinary case — was written
     * at position 2 and overwritten at position 3. The relabel tests all called
     * `updateNotifyWords` with nothing in flight, so none of them could see it.
     *
     * Here the reconcile is deliberately left in flight while the relabel runs.
     */
    const { reconcileWakeRegistration, updateNotifyWords, NOTIFY_STATE_URL } =
      await import("../app/shell/notification-settings");
    window.localStorage.setItem(CHANNELS_KEY, ALL_ON);
    installUnsubscribedBrowser();

    // Not awaited: the reconcile's final write is still queued behind the announce.
    const booting = reconcileWakeRegistration("New mail.");
    // The locale lands while it is in flight, exactly as `GET /consent` does.
    const relabelled = updateNotifyWords("ohmail", "Neue Mail.");
    await Promise.all([booting, relabelled]);

    const state = cachePuts.filter((p) => p.url === NOTIFY_STATE_URL).at(-1)!;
    expect(
      JSON.parse(state.body).body,
      "the reconcile's boot-time language overwrote the account's own",
    ).toBe("Neue Mail.");
    // …and the byte the reconcile owns is still its own answer, not the relabel's placeholder.
    expect(JSON.parse(state.body).enabled).toBe(true);
  });

  it("does not throw when there is no push machinery at all — a boot must not depend on it", async () => {
    // A private window, a browser with no service worker, or a desktop build whose Cloud client
    // is aliased out. This runs inside a shell boot effect, so a throw here would be an
    // exception escaping a `useEffect` on every sign-in.
    const { reconcileWakeRegistration } = await import("../app/shell/notification-settings");
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
    Reflect.deleteProperty(globalThis as Record<string, unknown>, "caches");

    await expect(reconcileWakeRegistration("New mail.")).resolves.toBe("unsupported");
  });
});
