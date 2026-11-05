/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHANNELS, type NoticePermission } from "@ohmail/client-engine";
import {
  NOTIFY_CACHE,
  NOTIFY_STATE_URL,
  subscriptionWanted,
  syncWebPush,
  writeNotifyStateUnchecked,
  type PushApi,
} from "../app/shell/notification-settings";

/**
 * BEING WOKEN WHILE THE BROWSER IS CLOSED.
 *
 * The subscription is the only part of notifications that reaches the network, and it is the
 * layer where "off" is actually enforced for a closed browser: with no subscription the server
 * has no endpoint to dial, so nothing is delivered and then discarded. These assertions are
 * about that lifecycle — not about whether a notice looks right, which is the pane's file.
 */

const chans = (over: Partial<typeof DEFAULT_CHANNELS> = {}) => ({ ...DEFAULT_CHANNELS, ...over });

describe("subscriptionWanted — the whole policy, in one function", () => {
  it("wants one only when the OS agrees AND the master is on AND new mail is on", () => {
    expect(subscriptionWanted(chans(), "granted")).toBe(true);
  });

  it("wants none when the OS refuses, whatever the switches say", () => {
    for (const p of ["denied", "default", "unsupported"] as NoticePermission[]) {
      expect(subscriptionWanted(chans(), p), `subscribed under a ${p} platform`).toBe(false);
    }
  });

  it("wants none with the master off", () => {
    expect(subscriptionWanted(chans({ master: false }), "granted")).toBe(false);
  });

  it("wants none with NEW MAIL off — the only event worth starting a closed browser for", () => {
    expect(subscriptionWanted(chans({ ohbox: false }), "granted")).toBe(false);
  });

  it("still wants one when only the other three are off — new mail alone decides it", () => {
    const only = chans({ screener: false, scheduled: false, pairing: false });
    expect(subscriptionWanted(only, "granted")).toBe(true);
  });
});

// ── the fake browser ────────────────────────────────────────────────────────────────────────

interface FakeSub {
  endpoint: string;
  unsubscribed: boolean;
  getKey: (n: string) => ArrayBuffer | null;
  unsubscribe: () => Promise<boolean>;
}

function makeSub(withKeys = true): FakeSub {
  const key = (n: number): ArrayBuffer => new Uint8Array(n).fill(7).buffer;
  const s: FakeSub = {
    endpoint: "https://push.example/ep/abc",
    unsubscribed: false,
    getKey: (n: string) => (withKeys ? key(n === "auth" ? 16 : 65) : null),
    unsubscribe: () => { s.unsubscribed = true; return Promise.resolve(true); },
  };
  return s;
}

let created: FakeSub | null = null;
let existing: FakeSub | null = null;
let registered: string[] = [];

function installFakeBrowser(): void {
  registered = [];
  const pushManager = {
    getSubscription: () => Promise.resolve(existing),
    /* A REAL `pushManager` answers `getSubscription()` with what `subscribe()` just created, and
       the fake must too — without this, an ON followed by an OFF looked like an OFF with nothing
       to remove, and the ordering assertion below could not fail even when the ordering was
       wrong. The fake being unfaithful HERE is the shape that makes a race test decorative. */
    subscribe: () => { created = makeSub(); existing = created; return Promise.resolve(created); },
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: (u: string) => { registered.push(u); return Promise.resolve({ pushManager }); },
    },
  });
}

function api(overrides: Partial<PushApi> = {}): PushApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    vapidKey: () => { calls.push("vapidKey"); return Promise.resolve({ publicKey: "B".repeat(87) }); },
    subscribe: (e) => { calls.push(`subscribe:${e}`); return Promise.resolve({ id: "row-1" }); },
    unsubscribe: (id) => { calls.push(`unsubscribe:${id}`); return Promise.resolve(); },
    ...overrides,
  };
}

/**
 * A MINIMAL CACHE API. jsdom ships none, and `writeNotifyStateUnchecked` is the one piece of this module
 * that speaks to it — the worker's only source of words. Stubbed rather than skipped, because
 * "the page wrote what the worker reads" is the assertion that keeps a paired server from
 * choosing the text that appears under ohmail's name.
 */
function installFakeCaches(): void {
  const stores = new Map<string, Map<string, Response>>();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map());
        const store = stores.get(name)!;
        return Promise.resolve({
          put: (k: string, v: Response) => { store.set(k, v); return Promise.resolve(); },
          match: (k: string) => Promise.resolve(store.get(k)),
        });
      },
    },
  });
}

beforeEach(() => {
  created = null; existing = null;
  window.localStorage.clear();
  installFakeBrowser();
  installFakeCaches();
});
afterEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });

describe("syncWebPush — creating one", () => {
  it("asks the SERVER for its key before touching the push service", async () => {
    const a = api();
    const out = await syncWebPush(true, a);
    expect(out).toBe("subscribed");
    // The key comes first: a registration made against the wrong key renders nothing, and there
    // is no earlier moment the browser could have learned it.
    expect(a.calls[0]).toBe("vapidKey");
    expect(a.calls[1]).toBe("subscribe:https://push.example/ep/abc");
  });

  it("registers the worker at the origin root, so its scope covers the app", async () => {
    await syncWebPush(true, api());
    expect(registered).toEqual(["/sw.js"]);
  });

  it("remembers the row id, so it can be named for deletion after a reload", async () => {
    await syncWebPush(true, api());
    expect(window.localStorage.getItem("ohmail.notifications.subscriptionId")).toBe("row-1");
  });

  it("a server with NO keypair is a supported state, not an error, and subscribes nothing", async () => {
    const a = api({
      // Records too: a bare override would replace the instrumented version and the call log
      // would read empty, which looks exactly like "never asked".
      vapidKey: () => { a.calls.push("vapidKey"); return Promise.resolve({ publicKey: null }); },
    });
    expect(await syncWebPush(true, a)).toBe("no_server_key");
    expect(created, "subscribed against a server that cannot sign a wake").toBeNull();
    expect(a.calls).toEqual(["vapidKey"]);
  });

  it("does nothing when one already exists AND the server has it — safe on every change", async () => {
    existing = makeSub();
    window.localStorage.setItem("ohmail.notifications.subscriptionId", "row-1");
    window.localStorage.setItem("ohmail.notifications.subscriptionEndpoint", existing.endpoint);
    const a = api();
    expect(await syncWebPush(true, a)).toBe("unchanged");
    expect(a.calls).toEqual([]);
  });

  it("RE-ANNOUNCES when the push service ROTATED the endpoint, and drops the superseded row", async () => {
    /**
     * A push service may replace a subscription on its own. Both facts are then true at once —
     * there is a subscription and there is a row — while they name different addresses, which a
     * bare id check reads as "nothing to do". Nothing throws: the server dials an endpoint that
     * no longer exists and this browser is simply never woken again.
     */
    existing = makeSub();
    existing.endpoint = "https://push.example/ep/NEW";
    window.localStorage.setItem("ohmail.notifications.subscriptionId", "row-old");
    window.localStorage.setItem(
      "ohmail.notifications.subscriptionEndpoint", "https://push.example/ep/OLD",
    );
    const a = api({ subscribe: (e) => { a.calls.push(`subscribe:${e}`); return Promise.resolve({ id: "row-new" }); } });
    expect(await syncWebPush(true, a)).toBe("subscribed");
    expect(a.calls).toEqual([
      "subscribe:https://push.example/ep/NEW",
      "unsubscribe:row-old",                       // and only AFTER the new one exists
    ]);
    expect(window.localStorage.getItem("ohmail.notifications.subscriptionId")).toBe("row-new");
    expect(window.localStorage.getItem("ohmail.notifications.subscriptionEndpoint"))
      .toBe("https://push.example/ep/NEW");
  });

  it("RE-ANNOUNCES a local subscription the server never recorded, instead of calling it fine", async () => {
    /**
     * `subscribe()` can succeed and the POST after it fail. This used to be permanent: every
     * later call saw a subscription, answered "unchanged", and no row ever existed — so nothing
     * could wake the browser and nothing said so. Re-announcing is free (the server dedupes on
     * the endpoint), so the safe move is to announce rather than assume.
     */
    existing = makeSub();                       // a subscription…
    // …and NO stored row id: the POST never landed.
    const a = api();
    expect(await syncWebPush(true, a)).toBe("subscribed");
    expect(a.calls).toEqual(["subscribe:https://push.example/ep/abc"]);
    expect(window.localStorage.getItem("ohmail.notifications.subscriptionId")).toBe("row-1");
    expect(window.localStorage.getItem("ohmail.notifications.subscriptionEndpoint"))
      .toBe(existing.endpoint);
  });

  it("ROLLS BACK the local half when the server refuses the registration", async () => {
    const a = api({ subscribe: () => Promise.reject(new Error("500")) });
    expect(await syncWebPush(true, a)).toBe("not_registered");
    expect(
      created!.unsubscribed,
      "a subscription with no server row was left in place — every later call would skip it",
    ).toBe(true);
    expect(window.localStorage.getItem("ohmail.notifications.subscriptionId")).toBeNull();
  });
});

describe("syncWebPush — removing one, which is where OFF is enforced", () => {
  it("unsubscribes the browser AND deletes the server row", async () => {
    existing = makeSub();
    window.localStorage.setItem("ohmail.notifications.subscriptionId", "row-9");
    const a = api();
    expect(await syncWebPush(false, a)).toBe("unsubscribed");
    expect(existing.unsubscribed, "the browser is still subscribed").toBe(true);
    expect(a.calls).toEqual(["unsubscribe:row-9"]);
    expect(window.localStorage.getItem("ohmail.notifications.subscriptionId")).toBeNull();
  });

  it("unsubscribes LOCALLY even when the server call fails, and SAYS the row remains", async () => {
    existing = makeSub();
    window.localStorage.setItem("ohmail.notifications.subscriptionId", "row-9");
    const a = api({ unsubscribe: () => Promise.reject(new Error("offline")) });
    expect(await syncWebPush(false, a)).toBe("row_remains");
    expect(
      existing.unsubscribed,
      "a failed server call left this browser subscribed — it would still be woken",
    ).toBe(true);
  });

  it("KEEPS the row id when the delete fails, so the removal can be retried", async () => {
    /**
     * Erasing it made the row unreachable for ever: nothing else knows its name, so no retry
     * could be made and the server went on dialling an endpoint this browser had dropped.
     */
    existing = makeSub();
    window.localStorage.setItem("ohmail.notifications.subscriptionId", "row-9");
    await syncWebPush(false, api({ unsubscribe: () => Promise.reject(new Error("offline")) }));
    expect(
      window.localStorage.getItem("ohmail.notifications.subscriptionId"),
      "the only name for the surviving row was thrown away",
    ).toBe("row-9");

    // …and the NEXT attempt uses it, with no local subscription left to remove.
    existing = null;
    const a = api();
    expect(await syncWebPush(false, a)).toBe("unsubscribed");
    expect(a.calls).toEqual(["unsubscribe:row-9"]);
    expect(window.localStorage.getItem("ohmail.notifications.subscriptionId")).toBeNull();
  });

  it("attempts the server delete EVEN IF the local unsubscribe throws — not both halves live", async () => {
    existing = makeSub();
    existing.unsubscribe = () => Promise.reject(new Error("browser refused"));
    window.localStorage.setItem("ohmail.notifications.subscriptionId", "row-9");
    const a = api();
    expect(await syncWebPush(false, a)).toBe("row_remains");
    expect(
      a.calls,
      "a local failure skipped the server delete, leaving the row dialling a live endpoint",
    ).toEqual(["unsubscribe:row-9"]);
  });

  it("with nothing to remove, says so and calls nobody", async () => {
    const a = api();
    expect(await syncWebPush(false, a)).toBe("unchanged");
    expect(a.calls).toEqual([]);
  });
});

/**
 * THE ROW NAMES THE ACCOUNT IT WAS ANNOUNCED FOR, beside its id: a revoke of one account while another holds this
 * browser's jar forgets only its own (`sign-out.ts`, the one-account sweep). The name is the jar's at the POST.
 */
describe("syncWebPush — the stored row names its account", () => {
  const stored = (): Array<string | null> => ["subscriptionId", "subscriptionEndpoint", "subscriptionOwner"]
    .map((k) => window.localStorage.getItem(`ohmail.notifications.${k}`));
  afterEach(() => { document.cookie = "tf_owner=; Path=/; Max-Age=0"; });

  it("names A; a rotation announced under B names B; turning it off removes all three", async () => {
    document.cookie = "tf_owner=acct_A; Path=/";
    expect(await syncWebPush(true, api())).toBe("subscribed");
    expect(stored()).toEqual(["row-1", "https://push.example/ep/abc", "acct_A"]);
    document.cookie = "tf_owner=acct_B; Path=/";
    existing!.endpoint = "https://push.example/ep/NEW";
    expect(await syncWebPush(true, api({ subscribe: () => Promise.resolve({ id: "row-new" }) }))).toBe("subscribed");
    expect(stored()).toEqual(["row-new", "https://push.example/ep/NEW", "acct_B"]);
    expect(await syncWebPush(false, api())).toBe("unsubscribed");
    expect(stored()).toEqual([null, null, null]);
  });

  it("a row announced with nobody in the jar names nobody, not the account named before", async () => {
    window.localStorage.setItem("ohmail.notifications.subscriptionOwner", "acct_A");
    expect(await syncWebPush(true, api())).toBe("subscribed");
    expect(stored()).toEqual(["row-1", "https://push.example/ep/abc", null]);
  });
});

describe("syncWebPush — two presses do not interleave", () => {
  it("an ON and an OFF in flight together resolve IN ORDER, not into a live subscription", async () => {
    /**
     * Without a queue: ON observes no subscription and goes to fetch the key; OFF runs while that
     * is in the air, finds nothing to remove, reports "unchanged"; then ON's `subscribe()` lands
     * and the browser is registered with every switch off. The mobile client queues its wake
     * mutations for exactly this reason.
     */
    let releaseKey = (): void => {};
    let reachedKey = (): void => {};
    const atKey = new Promise<void>((res) => { reachedKey = res; });
    const slow = api({
      vapidKey: () => {
        reachedKey();                            // the ON is now genuinely in flight
        return new Promise((res) => { releaseKey = () => res({ publicKey: "B".repeat(87) }); });
      },
    });

    const on = syncWebPush(true, slow);
    const off = syncWebPush(false, slow);       // asked second, must run second
    // WAIT FOR THE ON TO REACH THE KEY FETCH before releasing it. Releasing earlier proves
    // nothing: the queue defers the first operation by a microtask, so `vapidKey` has not been
    // called yet and there is no in-flight ON for the OFF to race.
    await atKey;
    releaseKey();

    expect(await on).toBe("subscribed");
    expect(await off).toBe("unsubscribed");
    expect(
      created!.unsubscribed,
      "the OFF resolved before the ON's subscription existed, and left it live",
    ).toBe(true);
  });
});

describe("syncWebPush — refusals", () => {
  it("a browser with no service worker support is `unsupported`, not a crash", async () => {
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
    // `in` still finds the property, so blank it entirely the way an old browser has it.
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    expect(await syncWebPush(true, api())).toBe("unsupported");
  });

  it("a subscription with no keys is UNDONE rather than left for a sender that cannot seal", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: () => Promise.resolve({
          pushManager: {
            getSubscription: () => Promise.resolve(null),
            subscribe: () => { created = makeSub(false); return Promise.resolve(created); },
          },
        }),
      },
    });
    const a = api();
    expect(await syncWebPush(true, a)).toBe("unsupported");
    expect(created!.unsubscribed, "a keyless registration was left in place").toBe(true);
    // And never announced to the server, which would have stored a row nothing can seal to.
    expect(a.calls).toEqual(["vapidKey"]);
  });
});

describe("writeNotifyStateUnchecked — the only words the worker may draw", () => {
  it("stores them where the worker looks, with the enabled flag", async () => {
    await writeNotifyStateUnchecked(true, "ohmail", "New mail.");
    const cache = await caches.open(NOTIFY_CACHE);
    const hit = await cache.match(NOTIFY_STATE_URL);
    expect(hit, "the worker's state was never written").toBeDefined();
    expect(await hit!.json()).toEqual({ enabled: true, title: "ohmail", body: "New mail." });
  });

  it("two writes land IN CALL ORDER, even when the first one is slow", async () => {
    /**
     * These were two independent fire-and-forget writes, so a fast OFF/ON pair could land either
     * way round. A stale `enabled: false` arriving after a later `enabled: true` leaves the worker
     * refusing to draw for a browser that IS subscribed and expecting notices — silent, and with
     * nothing on screen to explain it.
     *
     * The slow first write is what makes the race observable at all: with both puts resolving
     * immediately the wrong order cannot be reached, and the test would pass on the broken code.
     */
    const store = new Map<string, Response>();
    let puts = 0;
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: {
        open: () => Promise.resolve({
          put: (k: string, v: Response) => {
            puts += 1;
            const delay = puts === 1 ? 20 : 0;   // the FIRST write is the slow one
            return new Promise<void>((res) => {
              setTimeout(() => { store.set(k, v); res(); }, delay);
            });
          },
          match: (k: string) => Promise.resolve(store.get(k)),
        }),
      },
    });

    const first = writeNotifyStateUnchecked(false, "ohmail", "New mail.");
    const second = writeNotifyStateUnchecked(true, "ohmail", "New mail.");
    await Promise.all([first, second]);

    const state = await (await (await caches.open(NOTIFY_CACHE)).match(NOTIFY_STATE_URL))!.json();
    expect(
      state.enabled,
      "a stale write overtook a later one — the worker would refuse to draw for a live subscription",
    ).toBe(true);
  });

  it("writes an explicit OFF rather than removing the entry — a miss must not need interpreting", async () => {
    await writeNotifyStateUnchecked(true, "ohmail", "New mail.");
    await writeNotifyStateUnchecked(false, "ohmail", "New mail.");
    const cache = await caches.open(NOTIFY_CACHE);
    const state = await (await cache.match(NOTIFY_STATE_URL))!.json();
    expect(state.enabled).toBe(false);
  });
});
