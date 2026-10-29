/** @vitest-environment jsdom */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { fillFrom } from "../app/shell/locale";
import { formalAddress } from "./_formal-address";

/**
 * DELETE YOUR ACCOUNT LEAVES NOTHING OF IT IN THIS BROWSER, AND ONLY IT.
 *
 * Measured on 0.25.1 and 0.25.2: `DELETE /account` answered 200 and the page showed no receipt, only
 * "This browser has lost the name of the account this window is for", with the mirror and the
 * account's keys still there after a reload. At 0.25.3's base the receipt was back and the wipe took
 * EVERY account's copy in the browser. Driven here through the real pane, the step-up prompt, the
 * real client and the real wipe; only `fetch` and the IndexedDB factory are stand-ins.
 */
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/* The engine's own devDependency, reached through its package: the webapp does not carry one. */
const ENGINE_PKG = existsSync(resolve("packages/client-engine/package.json"))
  ? resolve("packages/client-engine/package.json")
  : resolve("../../packages/client-engine/package.json");
const { IDBFactory } = createRequire(ENGINE_PKG)("fake-indexeddb") as { IDBFactory: new () => IDBFactory };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

const OWNER = "7a0c3f9e-5d61-4f7a-9d2e-2b1f8c4e6a10";
/** Another account signed in on this browser before: its copy is not this erasure's. */
const OTHER = "0b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const EMAIL = "person@example.test";

/** What the server does to the jar on a 200 `DELETE /account` that script can see. */
const clearReadableCookies = (): void => {
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
};

const json = (body: unknown, status = 200, account: string | null = OWNER): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(account === null ? {} : { "X-Ohmail-Account": account }),
    },
  });

/**
 * `erase` answers each DELETE in turn; the first is a closed step-up window, as it nearly always is.
 * `purges`: the cache clears asked for (`x-ohmail-clear: cache`), never answered here.
 */
interface Rig { erase: () => Response; asked: string[]; windowClosed: boolean; purges: number }
const rig: Rig = { erase: () => json({}), asked: [], windowClosed: true, purges: 0 };
const stepUpRequired = (): Response =>
  json({ error: { code: "step_up_required", message: "recent two-factor authentication required" } }, 403);

const RECEIPT = {
  erased: true, usersErased: 1, tables: {}, stagingTicketsExpired: 0, redactedTables: {},
  retained: "billing records only, under a pseudonymous account id", subscription: "none",
};

let roots: Root[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  vi.resetModules();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = `tf_owner=${OWNER}; Path=/`;
  document.cookie = "tf_csrf=csrf-under-test; Path=/";
  rig.asked = [];
  rig.windowClosed = true;
  rig.purges = 0;
  rig.erase = () => {
    clearReadableCookies();
    return json(RECEIPT);
  };
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    rig.asked.push(`${method} ${url}`);
    if (url === "/auth/refresh" && method === "POST" && new Headers(init?.headers).get("x-ohmail-clear") === "cache") {
      rig.purges += 1;
      return new Promise<Response>(() => {});
    }
    if (url === "/api/auth/session") {
      return json({
        user: { accountId: OWNER, email: EMAIL, twofaEnrolled: { webauthn: false, totp: true } }, scope: "full",
      });
    }
    // The step-up re-stamps THIS session: no Set-Cookie, the same account named.
    if (url === "/api/auth/step-up/totp" && method === "POST") { rig.windowClosed = false; return json({ ok: true }); }
    if (url === "/api/account" && method === "DELETE") return rig.windowClosed ? stepUpRequired() : rig.erase();
    if (url === "/api/account/access") return json({ metered: false });
    return json({ error: { code: "not_found", message: "not found" } }, 404);
  }) as typeof globalThis.fetch;
  const client = await import("../app/api-client.js");
  client.setAccountHeaderCapability(true);
  client.bindApiOwner(OWNER);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function waitFor(predicate: () => boolean, what: string, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: Element): Promise<void> {
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

/** A mirror the page itself holds open, as the running engine does, plus account-keyed keys. */
async function seedThisBrowser(): Promise<{ close: () => void; keys: string[] }> {
  const engine = await import("@ohmail/client-engine");
  const store = new engine.IndexedDbMirrorStore({ owner: OWNER });
  await store.load();
  await store.putLocal("message", "m1", { id: "m1", subject: "the whole letter" });
  await waitFor(() => localStorage.getItem("ohmail.mirror.__since") !== null, "the registry anchor");
  const { SEND_LOCKS_PREFIX } = await import("../app/shell/send-lock.js");
  const { COMPOSE_SESSION_PREFIX } = await import("../app/shell/compose.js");
  const keys = [`${SEND_LOCKS_PREFIX}${OWNER}`, `${COMPOSE_SESSION_PREFIX}${OWNER}`, `ohmail.boot.ownAddresses.${OWNER}`];
  for (const k of keys) localStorage.setItem(k, "account data");
  return { close: () => store.close(), keys };
}

async function mirrorsLeft(): Promise<string[]> {
  const all = await (indexedDB as IDBFactory & { databases: () => Promise<IDBDatabaseInfo[]> }).databases();
  return all.map((d) => d.name ?? "").filter((n) => n.startsWith("ohmail-mirror")).sort();
}

/** Mount the pane, press Delete, and verify one code at the prompt a closed window opens. */
async function eraseThroughThePane(locale: "en" | "de" = "en"): Promise<HTMLElement> {
  const { AccountSection } = await import("../app/(product)/mailbox/AccountSection.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale, messages: (locale === "de" ? fillFrom(en as never, de as never) : en) as never,
      timeZone: "UTC", now: new Date("2026-09-26T16:00:00.000Z"),
      children: h(AccountSection),
    }));
  });
  await waitFor(() => container.querySelector("#acct-typed") != null, "the facts step");
  await type(container.querySelector<HTMLInputElement>("#acct-typed")!, EMAIL);
  await submit(container.querySelector("form.acct-confirm")!);
  await waitFor(() => container.querySelector("#stepup-code") != null, "the step-up prompt");
  expect(rig.purges, "a cache clear after the step-up refusal").toBe(0);
  await type(container.querySelector<HTMLInputElement>("#stepup-code")!, "123456");
  await submit(container.querySelector("#stepup-code")!.closest("form")!);
  await waitFor(() => rig.asked.filter((a) => a === "DELETE /api/account").length === 2, "the parked erase");
  return container;
}

/** Another account's copy on this browser: its mirror with a message, and its keys. */
async function seedAnotherAccount(): Promise<string[]> {
  const engine = await import("@ohmail/client-engine");
  const store = new engine.IndexedDbMirrorStore({ owner: OTHER });
  await store.load();
  await store.putLocal("message", "o1", { id: "o1", subject: "another account's letter" });
  store.close();
  const { SEND_LOCKS_PREFIX } = await import("../app/shell/send-lock.js");
  const keys = [`${SEND_LOCKS_PREFIX}${OTHER}`, `ohmail.boot.ownAddresses.${OTHER}`];
  for (const k of keys) localStorage.setItem(k, "the other account's data");
  return keys;
}

/** How many entities a mirror holds, read through the engine's own store. */
async function entitiesOf(owner: string): Promise<number> {
  const engine = await import("@ohmail/client-engine");
  const store = new engine.IndexedDbMirrorStore({ owner });
  await store.load();
  const n = store.list("message").length;
  store.close();
  return n;
}

const keysNaming = (owner: string): string[] => Object.keys(localStorage).filter((k) => k.includes(owner)).sort();

const receiptShown = (c: HTMLElement): boolean => c.textContent!.includes(en.account.doneTitle);

describe("Delete your account wipes this browser's copy of that account", () => {
  it("the receipt, no lost-name sentence, and no sign-in: the step-up re-runs the erase on the session it had", async () => {
    const seeded = await seedThisBrowser();
    expect(await mirrorsLeft()).toEqual([`ohmail-mirror:${OWNER}`]);

    const c = await eraseThroughThePane();
    await waitFor(() => receiptShown(c) || c.querySelector("[role=alert]") != null, "a receipt or a refusal");

    expect(c.querySelector("[role=alert]")?.textContent ?? null, "the page refused a completed erasure").toBeNull();
    expect(receiptShown(c), "no receipt after DELETE /account answered 200").toBe(true);
    expect(c.textContent, "the erased account is still named as signed in").not.toContain("Signed in as");
    expect(rig.asked.filter((a) => a === "POST /api/auth/login"), "the confirmation signed in again").toEqual([]);
    expect(rig.asked.filter((a) => a === "POST /api/auth/step-up/totp")).toHaveLength(1);
    expect(await mirrorsLeft(), "the erased account's mirror is still in this browser").toEqual([]);
    expect(seeded.keys.filter((k) => localStorage.getItem(k) !== null), "account-keyed storage survived").toEqual([]);
    expect(document.cookie.includes("tf_owner="), "the name went with the mail").toBe(false);
    // The receipt no longer carries the cache clear: the browser asks for it once, and the receipt
    // shows while that request is still unanswered.
    expect(rig.purges, "the cache clear after the erase").toBe(1);
    expect(rig.asked.filter((a) => a === "POST /auth/refresh"), "a request on the refresh door other than the purge").toHaveLength(1);
  }, 30_000);

  it("THE CENSUS: zero entities and zero keys for the erased account; another account's copy survives", async () => {
    await seedThisBrowser();
    const others = await seedAnotherAccount();
    expect(await entitiesOf(OTHER), "the control seeded nothing").toBe(1);
    expect(keysNaming(OWNER).length, "the census has nothing to find").toBeGreaterThan(0);
    // A renewal the server did not answer keeps its name owed, in its own IndexedDB database.
    const refresh = await import("../app/session-refresh.js");
    const renewalNames = async (): Promise<string[]> =>
      (await indexedDB.databases()).map((d) => d.name ?? "").filter((n) => n === refresh.SESSION_ATTEMPT_DB);
    expect(await refresh.resumeSession()).toBe("unavailable");
    expect(await renewalNames(), "the control: the renewal's name is in IndexedDB").toHaveLength(1);

    const c = await eraseThroughThePane();
    await waitFor(() => receiptShown(c), "the receipt");

    expect(await renewalNames(), "the erased session's renewal name survived").toEqual([]);
    expect(await mirrorsLeft(), "the erase took another account's mirror, or left its own")
      .toEqual([`ohmail-mirror:${OTHER}`]);
    expect(keysNaming(OWNER), "keys naming the erased account survived").toEqual([]);
    expect(others.filter((k) => localStorage.getItem(k) === null), "another account's keys went with it").toEqual([]);
    expect(await entitiesOf(OTHER), "another account's mail went with it").toBe(1);
  }, 30_000);

  it("after the erase this tab asks nothing more, and never says it lost the account's name", async () => {
    await seedThisBrowser();
    const c = await eraseThroughThePane();
    await waitFor(() => receiptShown(c), "the receipt");

    const client = await import("../app/api-client.js");
    const before = rig.asked.length;
    const refused = await client.api("/mailboxes").then(() => null, (e: unknown) => e as { code?: string });
    expect(refused?.code, "the next ask was refused by the lost-name sentence").not.toBe("owner_absent");
    expect(refused?.code, "the tab of an erased account went on asking").toBe(client.SESSION_ENDED_REFUSAL_CODE);
    expect(rig.asked.slice(before), "a request left the tab after the erase").toEqual([]);
  }, 30_000);

  it("CONTROL — another tab holding the mirror: the receipt is shown WITH the blocked sentence", async () => {
    await seedThisBrowser();
    // Another tab's connection: it never yields, so the browser can only report the delete blocked.
    const other = await new Promise<IDBDatabase>((ok, no) => {
      const req = indexedDB.open(`ohmail-mirror:${OWNER}`);
      req.onsuccess = () => ok(req.result);
      req.onerror = () => no(req.error);
    });

    const c = await eraseThroughThePane();
    await waitFor(() => receiptShown(c) || c.querySelector("[role=alert]") != null, "a receipt or a refusal");

    expect(receiptShown(c), "a blocked wipe must not hide a completed erasure").toBe(true);
    expect(c.textContent).toContain(en.account.erasedMirrorBlocked);
    other.close();
  }, 30_000);

  it("in German the same receipt speaks to the reader as du", async () => {
    await seedThisBrowser();
    const other = await new Promise<IDBDatabase>((ok, no) => {
      const req = indexedDB.open(`ohmail-mirror:${OWNER}`);
      req.onsuccess = () => ok(req.result);
      req.onerror = () => no(req.error);
    });
    const c = await eraseThroughThePane("de");
    await waitFor(() => c.textContent!.includes(de.account.erasedMirrorBlocked), "the German blocked receipt");
    expect(formalAddress(c), "the receipt says Sie").toEqual([]);
    other.close();
  }, 30_000);
});

describe("a refused erase says so, and the next press can erase", () => {
  it("a server refusal: our sentence, back to the top with the address kept, nothing wiped; the next press erases", async () => {
    const seeded = await seedThisBrowser();
    rig.erase = () => json({ error: { code: "internal", message: "internal error" } }, 500);

    const c = await eraseThroughThePane();
    await waitFor(() => c.querySelector("[role=alert]") != null, "the refusal");

    expect(c.querySelector("[role=alert]")!.textContent).toBe(en.account.eraseRefused);
    expect(c.textContent, "the server's own words reached the person").not.toContain("internal error");
    expect(c.querySelector("#stepup-code"), "left on a prompt for a window that is open").toBeNull();
    expect(c.querySelector<HTMLInputElement>("#acct-typed")?.value, "not back at the top, address kept").toBe(EMAIL);
    // The account still exists, so this browser keeps it, and its cache.
    expect(await mirrorsLeft()).toEqual([`ohmail-mirror:${OWNER}`]);
    expect(seeded.keys.filter((k) => localStorage.getItem(k) === null)).toEqual([]);
    expect(rig.purges, "a cache clear after a refused erase").toBe(0);

    // The window the factor opened is still open: the next press erases with no prompt and no sign-in.
    rig.erase = () => { clearReadableCookies(); return json(RECEIPT); };
    await submit(c.querySelector("form.acct-confirm")!);
    await waitFor(() => receiptShown(c), "the receipt after the retry");
    expect(rig.asked.filter((a) => a === "POST /api/auth/login")).toEqual([]);
    expect(rig.asked.filter((a) => a === "POST /api/auth/step-up/totp")).toHaveLength(1);
    expect(await mirrorsLeft()).toEqual([]);
    expect(rig.purges, "the erase that went through asks for the cache clear once").toBe(1);
    seeded.close();
  }, 30_000);

  it("an erase that got no answer keeps the client's own sentence, which claims nothing", async () => {
    await seedThisBrowser();
    rig.erase = () => { throw new TypeError("network down"); };

    const c = await eraseThroughThePane();
    await waitFor(() => c.querySelector("[role=alert]") != null, "the refusal");

    const said = c.querySelector("[role=alert]")!.textContent!;
    expect(said, "an unanswered request must not claim nothing was deleted").not.toBe(en.account.eraseRefused);
    expect(said).toContain("We could not reach ohmail");
    expect(c.querySelector("#acct-typed"), "back at the top").not.toBeNull();
    expect(rig.purges, "a cache clear after an erase nobody answered").toBe(0);
  }, 30_000);

  it("a platform 5xx with no envelope of ours (the function cut mid-erasure) is unconfirmed, never nothing removed", async () => {
    const seeded = await seedThisBrowser();
    rig.erase = () => new Response("<html><body>504 Gateway Timeout</body></html>", {
      status: 504, headers: { "content-type": "text/html" },
    });

    const c = await eraseThroughThePane();
    await waitFor(() => c.querySelector("[role=alert]") != null, "the refusal");

    const said = c.querySelector("[role=alert]")!.textContent!;
    expect(said, "an outcome nobody confirmed").toBe(en.account.eraseUnconfirmed);
    expect(c.querySelector("#acct-typed"), "back at the top").not.toBeNull();
    // Nothing proves the account is gone, so this browser keeps its copy, and its cache.
    expect(await mirrorsLeft()).toEqual([`ohmail-mirror:${OWNER}`]);
    expect(rig.purges, "a cache clear after an unconfirmed erase").toBe(0);
    seeded.close();
  }, 30_000);
});
