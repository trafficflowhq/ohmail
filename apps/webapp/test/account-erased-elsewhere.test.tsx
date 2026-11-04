/** @vitest-environment jsdom */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";

/**
 * AN ACCOUNT ERASED ELSEWHERE LEAVES NO COPY IN THIS BROWSER.
 *
 * Measured at the base: browser 2 of an account erased in browser 1 heard 401s, marked its session
 * dead and kept `ohmail-mirror:<account>` — nothing declared the erased answer, and no door wiped
 * on it. Driven here through the real API client, the real refresh, the real erased door and the
 * real wipe; `fetch` and the IndexedDB factory are the stand-ins, answering what the real routes
 * answer (`packages/api/test/erased-account-names-itself.test.ts`).
 */
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const ENGINE_PKG = existsSync(resolve("packages/client-engine/package.json"))
  ? resolve("packages/client-engine/package.json")
  : resolve("../../packages/client-engine/package.json");
const { IDBFactory } = createRequire(ENGINE_PKG)("fake-indexeddb") as { IDBFactory: new () => IDBFactory };

const X = "7a0c3f9e-5d61-4f7a-9d2e-2b1f8c4e6a10";
const Y = "2c9e1d44-8b3a-4f0e-a1c7-5d6e7f8a9b0c";

const envelope = (status: number, code: string, account: string | null): Response => new Response(
  JSON.stringify({ error: { code, message: code } }),
  { status, headers: { "content-type": "application/json", ...(account ? { "X-Ohmail-Account": account } : {}) } },
);
const expireJar = (): void => {
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
};

interface Rig {
  read: () => Response;
  refresh: () => Response;
  asked: Array<{ what: string; declared: string | null }>;
}
const rig: Rig = { read: () => envelope(401, "unauthorized", null), refresh: () => envelope(401, "refresh_revoked", null), asked: [] };

let roots: Root[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  localStorage.clear();
  sessionStorage.clear();
  for (const c of document.cookie.split(";")) {
    const n = c.split("=")[0]!.trim();
    if (n) document.cookie = `${n}=; Path=/; Max-Age=0`;
  }
  rig.asked = [];
  rig.read = () => envelope(401, "unauthorized", null);
  rig.refresh = () => envelope(401, "refresh_revoked", null);
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    rig.asked.push({ what: `${init?.method ?? "GET"} ${url}`, declared: new Headers(init?.headers).get("x-ohmail-accepts") });
    if (url.endsWith("/auth/refresh")) return rig.refresh();
    return rig.read();
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** A browser signed in to `owner`: the marker, the client bound, the door registered. */
async function signedIn(owner: string | null) {
  if (owner) document.cookie = `tf_owner=${owner}; Path=/`;
  document.cookie = "tf_csrf=c; Path=/";
  const client = await import("../app/api-client.js");
  await import("../app/erased-door.js");
  client.setAccountHeaderCapability(true);
  client.bindApiOwner(owner);
  return {
    client,
    erased: await import("../app/shell/account-erased.js"),
    truth: await import("../app/shell/session-truth.js"),
    door: await import("../app/erased-door.js"),
  };
}

/** An account's copy in this browser: its mirror (closed, as a reload leaves it) and its keys. */
async function holdCopyOf(owner: string): Promise<string[]> {
  const engine = await import("@ohmail/client-engine");
  const store = new engine.IndexedDbMirrorStore({ owner });
  await store.load();
  await store.putLocal("message", "m1", { id: "m1", subject: `the letter of ${owner.slice(0, 4)}` });
  store.close();
  const { SEND_LOCKS_PREFIX } = await import("../app/shell/send-lock.js");
  const { COMPOSE_DRAFT_PREFIX } = await import("../app/shell/compose.js");
  const keys = [`${SEND_LOCKS_PREFIX}${owner}`, `${COMPOSE_DRAFT_PREFIX}${owner}.w1`, `ohmail.boot.ownAddresses.${owner}`];
  for (const k of keys) localStorage.setItem(k, "account data");
  return keys;
}

async function mirrors(): Promise<string[]> {
  const all = await (indexedDB as IDBFactory & { databases: () => Promise<IDBDatabaseInfo[]> }).databases();
  return all.map((d) => d.name ?? "").filter((n) => n.startsWith("ohmail-mirror")).sort();
}

async function settle(test: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const end = Date.now() + 5_000;
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function codeOfThrow(p: Promise<unknown>): Promise<string> {
  try { await p; return "resolved"; } catch (e) { return `${(e as { status?: number }).status} ${(e as { code?: string }).code}`; }
}

describe("the erased answer wipes this browser's copy of that account", () => {
  it("a declared read answering 410 naming the account: latched, mirror and keys gone, other tabs told", async () => {
    const { client, erased, truth } = await signedIn(X);
    const keys = await holdCopyOf(X);
    rig.read = () => envelope(410, "account_erased", X);

    expect(await codeOfThrow(client.api("/sync?limit=50"))).toBe("410 account_erased");
    expect(rig.asked[0]!.declared, "the read did not declare it understands the answer").toBe("account_erased");
    expect(erased.accountErasedOwner()).toBe(X);
    expect(truth.sessionMayAsk(), "an erased tab went on asking").toBe(false);
    await settle(() => localStorage.getItem(erased.ERASED_KEY) === X, "the cross-tab word");
    expect(await mirrors(), "the erased account's mirror is still in this browser").toEqual([]);
    expect(keys.filter((k) => localStorage.getItem(k) !== null)).toEqual([]);
    expect(rig.asked.map((a) => a.what), "a 410 is not recoverable: no refresh").toEqual(["GET /api/sync?limit=50"]);
  });

  it("past the access window: the read's 401, then the REFRESH's 410 — which clears the jar in flight", async () => {
    const { client, erased, truth } = await signedIn(X);
    await holdCopyOf(X);
    rig.refresh = () => { expireJar(); return envelope(410, "account_erased", X); };

    expect(await codeOfThrow(client.api("/sync?limit=50"))).toBe("401 unauthorized");
    const refresh = rig.asked.find((a) => a.what === "POST /auth/refresh");
    expect(refresh?.declared, "the refresh did not declare it").toBe("account_erased");
    expect(erased.accountErasedOwner(), "the account owner read after the answer, not before it").toBe(X);
    expect(truth.sessionHealAttempts()).toBe(0);
    await settle(async () => (await mirrors()).length === 0, "the mirror gone");
    // No heal schedule: nothing asks again.
    const asked = rig.asked.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(rig.asked.length).toBe(asked);
  });

  it("account Y's copy in the same browser is untouched by X's erasure", async () => {
    const { client } = await signedIn(X);
    const yKeys = await holdCopyOf(Y);
    await holdCopyOf(X);
    rig.read = () => envelope(410, "account_erased", X);
    await codeOfThrow(client.api("/sync?limit=50"));
    await settle(async () => (await mirrors()).length === 1, "X's mirror gone");
    expect(await mirrors()).toEqual([`ohmail-mirror:${Y}`]);
    expect(yKeys.filter((k) => localStorage.getItem(k) === null), "Y's keys were swept").toEqual([]);
  });

  it("the engine's transport: the adapter is handed a dead session, not a cursor expiry to re-bootstrap on", async () => {
    await signedIn(X);
    await holdCopyOf(X);
    rig.read = () => envelope(410, "account_erased", X);
    const { createEngine } = await import("../app/shell/engine-config.js");
    const erased = await import("../app/shell/account-erased.js");
    const engine = createEngine(false, { NEXT_PUBLIC_API_BASE: "/api" }, null);
    await engine.syncOnce().catch(() => undefined);
    expect(erased.accountErasedOwner()).toBe(X);
    expect(rig.asked.every((a) => a.declared === "account_erased"), "an engine ask went out undeclared").toBe(true);
    // One ask, the bootstrap's, answered 410: nothing after it — no re-bootstrap, no retry.
    expect(rig.asked.map((a) => a.what), "the engine asked again after the verdict").toHaveLength(1);
    await engine.syncOnce().catch(() => undefined);
    expect(rig.asked, "a drain after the verdict went out").toHaveLength(1);
    await settle(async () => (await mirrors()).length === 0, "the mirror gone");
  });

  it("the jar names nobody (the refusal cleared it): the named copy goes where the registry holds it", async () => {
    const { door, erased } = await signedIn(null);
    await holdCopyOf(X);
    const shell = await import("../app/shell/account-erased.js");
    expect(shell.hearAccountErased(X, { marker: { kind: "absent" } })).toBe("erased");
    await settle(async () => (await mirrors()).length === 0, "the mirror gone");
    expect(door.erasedDecision(Y, { kind: "absent" }), "an account this browser never held").toBe("nothing-here");
    expect(erased.accountErasedOwner()).toBe(X);
  });
});

describe("what wipes nothing", () => {
  it("CONTROL — an ordinary 401 and a refused refresh: the session ends, the copy stays", async () => {
    const { client, erased, truth } = await signedIn(X);
    await holdCopyOf(X);
    expect(await codeOfThrow(client.api("/sync?limit=50"))).toBe("401 unauthorized");
    expect(truth.sessionIsDead()).toBe(true);
    expect(erased.accountErasedOwner()).toBeNull();
    expect(await mirrors()).toEqual([`ohmail-mirror:${X}`]);
  });

  it("a 410 naming ANOTHER account than the jar's is somebody else's answer: refused, nothing wiped", async () => {
    const { client, erased } = await signedIn(X);
    await holdCopyOf(X);
    await holdCopyOf(Y);
    rig.read = () => envelope(410, "account_erased", Y);
    expect(await codeOfThrow(client.api("/sync?limit=50"))).toBe("0 response_not_owner_bound");
    expect(erased.accountErasedOwner()).toBeNull();
    expect(await mirrors()).toEqual([`ohmail-mirror:${X}`, `ohmail-mirror:${Y}`].sort());
  });

  it("a 410 account_erased with NO account named (an older server) wipes nothing", async () => {
    const { client, erased } = await signedIn(X);
    await holdCopyOf(X);
    rig.read = () => envelope(410, "account_erased", null);
    expect(await codeOfThrow(client.api("/sync?limit=50"))).toBe("410 account_erased");
    expect(erased.accountErasedOwner()).toBeNull();
    expect(await mirrors()).toEqual([`ohmail-mirror:${X}`]);
  });

  it("a 410 that is not account_erased (an expired cursor) is not an erasure", async () => {
    const { client, erased } = await signedIn(X);
    await holdCopyOf(X);
    rig.read = () => envelope(410, "cursor_expired", X);
    expect(await codeOfThrow(client.api("/sync?limit=50"))).toBe("410 cursor_expired");
    expect(erased.accountErasedOwner()).toBeNull();
    expect(await mirrors()).toEqual([`ohmail-mirror:${X}`]);
  });
});

describe("the latch never arms a refresh", () => {
  it("a death before the erasure has its heal schedule disarmed; one after it arms none", async () => {
    vi.useFakeTimers();
    try {
      const truth = await import("../app/shell/session-truth.js");
      const erased = await import("../app/shell/account-erased.js");
      const probe = vi.fn();
      truth.registerSessionProbe(probe);
      truth.markSessionDead();
      erased.markAccountErased(X);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(probe, "the heal schedule asked for a session after the erasure").not.toHaveBeenCalled();

      vi.resetModules();
      const truth2 = await import("../app/shell/session-truth.js");
      const erased2 = await import("../app/shell/account-erased.js");
      const probe2 = vi.fn();
      truth2.registerSessionProbe(probe2);
      erased2.markAccountErased(X);
      truth2.markSessionDead();
      truth2.probeSessionNow();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(probe2, "a death after the erasure armed a refresh").not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("every tab, and the wall", () => {
  it("another tab's word: a tab for X walls and wipes; a tab for Y wipes X's copy and stays", async () => {
    const forX = await signedIn(X);
    await holdCopyOf(X);
    const off = forX.door.watchErasedElsewhere();
    window.dispatchEvent(new StorageEvent("storage", { key: forX.erased.ERASED_KEY, newValue: X }));
    expect(forX.erased.accountErasedOwner()).toBe(X);
    await settle(async () => (await mirrors()).length === 0, "the mirror gone");
    off();

    vi.resetModules();
    const forY = await signedIn(Y);
    await holdCopyOf(X);
    const offY = forY.door.watchErasedElsewhere();
    window.dispatchEvent(new StorageEvent("storage", { key: forY.erased.ERASED_KEY, newValue: X }));
    await settle(async () => (await mirrors()).length === 0, "X's mirror gone");
    expect(forY.erased.accountErasedOwner(), "a tab for Y walled on X's erasure").toBeNull();
    offY();
  });

  it("the wall renders the sentence, and a new session lifts it", async () => {
    const { erased, door } = await signedIn(X);
    await holdCopyOf(X);
    const { ErasedWall } = await import("../app/(product)/mailbox/ErasedWall.js");
    function Harness() {
      const wall = door.useErasedWall();
      return wall ? h(ErasedWall, { blocked: false }) : h("p", null, "the mailbox");
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(h(NextIntlClientProvider, { locale: "en", messages: en, timeZone: "UTC", children: h(Harness) }));
    });
    expect(container.textContent).toBe("the mailbox");
    await act(async () => { void door.eraseHere(X, true); });
    expect(container.textContent).toContain(en.accessLock.erasedTitle);
    expect(container.textContent).toContain(en.accessLock.erasedBody);
    await act(async () => { erased.clearAccountErased(); });
    expect(container.textContent).toBe("the mailbox");
    expect(localStorage.getItem(erased.ERASED_KEY)).toBeNull();
  });
});

/**
 * A SESSION REVOKED ELSEWHERE LEAVES NO COPY EITHER. Devices → Sign out on another device (or Sign
 * out all, sign out everywhere, a password change) answers this browser's next renewal
 * `refresh_revoked`: the tab drops its mailbox, its account's copy goes and another account's stays,
 * and the sign-in page is told why. A lapse keeps the copy, behind the scrim.
 */
describe("a session revoked elsewhere", () => {
  const refusal = (code: string, cause?: string): Response => new Response(
    JSON.stringify({ error: { code, message: code, ...(cause ? { details: { cause } } : {}) } }),
    { status: 401, headers: { "content-type": "application/json" } },
  );

  /** The revoke door, and a tab that draws its mailbox unless the door dropped it; leaves are counted. */
  async function tab() {
    const door = await import("../app/revoked-door.js");
    let leaves = 0;
    (await import("../app/signed-out-signal.js")).setSignedOutLeaveForTest(() => { leaves += 1; });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    const Harness = () => (door.useRevokedHere(false) ? h("p", null, "dropped") : h("p", null, "the mailbox"));
    await act(async () => { root.render(h(Harness)); });
    const note = await import("../app/(product)/resume/signed-out-note.js");
    return { door, container, leaves: () => leaves, note: note.takeSharedSignedOutNote };
  }

  /** A read meets its 401 and the refresh hears `answer`; then whatever the door started has ended. */
  async function renewalRefused(client: { api: (p: string) => Promise<unknown> }, door: { revokedWipeSettled: () => Promise<void> }) {
    await act(async () => { await codeOfThrow(client.api("/sync?limit=50")); });
    await act(async () => { await door.revokedWipeSettled(); });
  }

  it("refresh_revoked: the tab drops its mail, this account's copy goes, another's stays, and the reason waits", async () => {
    const { client, truth } = await signedIn(X);
    const xKeys = await holdCopyOf(X);
    const yKeys = await holdCopyOf(Y);
    const t = await tab();
    rig.refresh = () => { expireJar(); return refusal("refresh_revoked"); };
    await renewalRefused(client, t.door);
    expect(truth.sessionIsDead()).toBe(true);
    expect(t.container.textContent, "the revoked tab kept its mailbox").toBe("dropped");
    const left = await mirrors();
    expect(left, "the revoked account's mirror is still in this browser").not.toContain(`ohmail-mirror:${X}`);
    expect(left, "another account's mirror went with it").toEqual([`ohmail-mirror:${Y}`]);
    expect(xKeys.filter((k) => localStorage.getItem(k) !== null)).toEqual([]);
    expect(yKeys.filter((k) => localStorage.getItem(k) === null), "another account's keys were swept").toEqual([]);
    expect(t.note(), "the sign-in page is not told why").toBe("revoked");
    await settle(() => t.leaves() === 1, "the tab's leave");
  });

  it("a reuse sweep's refusal: the copy goes, and the reason is the sweep's", async () => {
    const { client } = await signedIn(X);
    await holdCopyOf(X);
    const t = await tab();
    rig.refresh = () => { expireJar(); return refusal("refresh_revoked", "reuse"); };
    await renewalRefused(client, t.door);
    expect(await mirrors()).toEqual([]);
    expect(t.note()).toBe("reused");
  });

  it.each(["refresh_expired", "refresh_missing"])("CONTROL — %s is a lapse: the session ends, the mailbox and the copy stay", async (code) => {
    const { client, truth } = await signedIn(X);
    const keys = await holdCopyOf(X);
    const t = await tab();
    rig.refresh = () => { expireJar(); return refusal(code); };
    await renewalRefused(client, t.door);
    expect(truth.sessionIsDead()).toBe(true);
    expect(t.container.textContent).toBe("the mailbox");
    expect(await mirrors()).toEqual([`ohmail-mirror:${X}`]);
    expect(keys.filter((k) => localStorage.getItem(k) === null)).toEqual([]);
    expect(t.leaves()).toBe(0);
  });

  it("a session minted afterwards (a 204) lifts the revoke", async () => {
    const { client } = await signedIn(X);
    const t = await tab();
    rig.refresh = () => { expireJar(); return refusal("refresh_revoked"); };
    await renewalRefused(client, t.door);
    expect(t.container.textContent).toBe("dropped");
    rig.refresh = () => new Response(null, { status: 204 });
    const { resumeSession } = await import("../app/session-refresh.js");
    await act(async () => { expect(await resumeSession()).toBe("resumed"); });
    expect(t.container.textContent, "a live session stayed dropped").toBe("the mailbox");
  });

  it("CONTROL — a refusal that lands under another account's jar wipes nothing and tells nobody", async () => {
    const { client } = await signedIn(X);
    await holdCopyOf(X);
    await holdCopyOf(Y);
    const t = await tab();
    rig.refresh = () => { document.cookie = `tf_owner=${Y}; Path=/`; return refusal("refresh_revoked"); };
    await renewalRefused(client, t.door);
    expect(await mirrors()).toEqual([`ohmail-mirror:${X}`, `ohmail-mirror:${Y}`].sort());
    expect(t.note()).toBeNull();
  });
});
