/** @vitest-environment jsdom */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { within } from "@testing-library/react";
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
 * EVERY account's copy in the browser. Driven here through the live delete page, the step-up dialog, the
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
 * `erase` answers DELETE after verification; a write that leaves before verification is refused.
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

/**
 * A mirror the page itself holds open, as the running engine does, plus account-keyed keys and the
 * account's preferences and tab notes, which a sign-out keeps and an erasure does not.
 */
async function seedThisBrowser(): Promise<{ close: () => void; keys: string[]; prefs: string[] }> {
  const engine = await import("@ohmail/client-engine");
  const store = new engine.IndexedDbMirrorStore({ owner: OWNER });
  await store.load();
  await store.putLocal("message", "m1", { id: "m1", subject: "the whole letter" });
  await waitFor(() => localStorage.getItem("ohmail.mirror.__since") !== null, "the registry anchor");
  const { SEND_LOCKS_PREFIX } = await import("@ohmail/app-logic/writing/send-lock");
  const { COMPOSE_SESSION_PREFIX } = await import("@ohmail/app-logic/writing/compose");
  const { SENT_COPY_NOTES_PREFIX } = await import("@ohmail/app-logic/writing/mail-send");
  const keys = [
    `${SEND_LOCKS_PREFIX}${OWNER}`, `${SENT_COPY_NOTES_PREFIX}${OWNER}`, `${COMPOSE_SESSION_PREFIX}${OWNER}`, `ohmail.boot.ownAddresses.${OWNER}`,
  ];
  for (const k of keys) localStorage.setItem(k, "account data");
  return { close: () => store.close(), keys, prefs: await plantPreferences(OWNER) };
}

/** One account's preferences and this tab's notes about it, through the product's own builders. */
async function plantPreferences(owner: string): Promise<string[]> {
  const before = new Set([...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
  const { foldersOpenedKey, mailOriginalKey, searchSortKey } = await import("@ohmail/app-logic/storage/persisted-ui");
  const { seedNotNowKey } = await import("@ohmail/app-logic/mailboxes/first-run/seed-offer");
  const { writeAfterVerb } = await import("@ohmail/app-logic/press/after-verb");
  const { imageQualityKeyFor } = await import("@ohmail/app-logic/write/image-quality");
  const { dismissKey } = await import("../app/(product)/mailbox/LifecycleBanner.js");
  const { resumeOnceKey } = await import("../app/(product)/resume/use-resume-door.js");
  localStorage.setItem(searchSortKey(owner), "oldest");
  localStorage.setItem(seedNotNowKey(owner), "1");
  writeAfterVerb("stay", owner);
  localStorage.setItem(imageQualityKeyFor(owner), "low");
  // The rail's opened branches and the messages kept in their original colours: folder paths and message ids.
  localStorage.setItem(foldersOpenedKey(owner), JSON.stringify([`mbx-${owner.slice(0, 4)}|Clients/Acme Corp`]));
  localStorage.setItem(mailOriginalKey(owner), JSON.stringify(["m1"]));
  // The Screener's impersonation mark (#777), by name until its builder is on main.
  localStorage.setItem(`ohmail.screener.impersonationSeen.${owner}`, "2026-09-26T15:00:00.000Z");
  const { unsubscribeSeenKey } = await import("@ohmail/app-logic/screener");
  localStorage.setItem(unsubscribeSeenKey(owner), "1");
  sessionStorage.setItem(dismissKey({ kind: "trialEnding", deadline: "2026-09-28T00:00:00.000Z" }, owner), "1");
  sessionStorage.setItem(resumeOnceKey(owner), JSON.stringify({ at: 0, answer: "resumed", reloads: 0 }));
  // The catch-up note's builder is private to the API client.
  sessionStorage.setItem(`ohmail.lifecycle.${owner}.caughtUp`, "2026-09-20T00:00:00.000Z");
  const planted = [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => !before.has(k));
  expect(planted, "a builder wrote nothing").toHaveLength(11);
  return planted.sort();
}

async function mirrorsLeft(): Promise<string[]> {
  const all = await (indexedDB as IDBFactory & { databases: () => Promise<IDBDatabaseInfo[]> }).databases();
  return all.map((d) => d.name ?? "").filter((n) => n.startsWith("ohmail-mirror")).sort();
}

const addressField = (c: HTMLElement): HTMLInputElement | null =>
  [...c.querySelectorAll<HTMLInputElement>("input")].find((input) => input.closest('[role="dialog"]') === null) ?? null;

const factorField = (c: HTMLElement): HTMLInputElement | null =>
  c.querySelector('[role="dialog"] input[autocomplete="one-time-code"]');

const erases = () => rig.asked.filter((ask) => ask === "DELETE /api/account").length;
const factors = () => rig.asked.filter((ask) => ask === "POST /api/auth/step-up/totp").length;

async function openEraseDialog(c: HTMLElement, locale: "en" | "de" = "en") {
  const deletesBefore = erases();
  const factorsBefore = factors();
  const catalog = locale === "de" ? de : en;
  await act(async () => within(c).getByRole("button", { name: catalog.deleteAccount.begin }).click());
  await waitFor(() => factorField(c) !== null, "the verification dialog");
  expect(erases(), "the erase left before verification").toBe(deletesBefore);
  expect(factors(), "the factor was sent before it was entered").toBe(factorsBefore);
}

async function verifyErase(c: HTMLElement): Promise<void> {
  const field = factorField(c)!;
  const deletesBefore = erases();
  const factorsBefore = factors();
  await type(field, "123456");
  await submit(field.closest("form")!);
  await waitFor(() => erases() === deletesBefore + 1, "the verified erase");
  expect(factors()).toBe(factorsBefore + 1);
}

/** The live delete page asks for a factor before each erase. */
async function eraseThroughThePage(locale: "en" | "de" = "en"): Promise<HTMLElement> {
  const { DeleteAccountRoute } = await import("../app/(product)/account/delete/DeleteAccountRoute.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale, messages: (locale === "de" ? fillFrom(en as never, de as never) : en) as never,
      timeZone: "UTC", now: new Date("2026-09-26T16:00:00.000Z"),
      children: h(DeleteAccountRoute),
    }));
  });
  await waitFor(() => addressField(container) !== null, "the facts step");
  await type(addressField(container)!, EMAIL);
  await openEraseDialog(container, locale);
  expect(rig.purges, "the browser cache was cleared before verification").toBe(0);
  await verifyErase(container);
  return container;
}

/** Another account's copy on this browser: its mirror with a message, and its keys. */
async function seedAnotherAccount(): Promise<string[]> {
  const engine = await import("@ohmail/client-engine");
  const store = new engine.IndexedDbMirrorStore({ owner: OTHER });
  await store.load();
  await store.putLocal("message", "o1", { id: "o1", subject: "another account's letter" });
  store.close();
  const { SEND_LOCKS_PREFIX } = await import("@ohmail/app-logic/writing/send-lock");
  const { SENT_COPY_NOTES_PREFIX } = await import("@ohmail/app-logic/writing/mail-send");
  const keys = [`${SEND_LOCKS_PREFIX}${OTHER}`, `${SENT_COPY_NOTES_PREFIX}${OTHER}`, `ohmail.boot.ownAddresses.${OTHER}`];
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

/** Every key in this tab's two jars that carries `owner`'s id anywhere. */
const keysNaming = (owner: string): string[] =>
  [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => k.includes(owner)).sort();

const held = (key: string): boolean => localStorage.getItem(key) !== null || sessionStorage.getItem(key) !== null;

const receiptShown = (c: HTMLElement): boolean => c.textContent!.includes(en.deleteAccount.doneTitle.replace(/\.$/, ""));

describe("Delete your account wipes this browser's copy of that account", () => {
  it("the verified erase shows its receipt and clears this account without signing in again", async () => {
    const seeded = await seedThisBrowser();
    expect(await mirrorsLeft()).toEqual([`ohmail-mirror:${OWNER}`]);

    const c = await eraseThroughThePage();
    await waitFor(() => receiptShown(c) || c.querySelector("[role=alert]") != null, "a receipt or a refusal");

    expect(c.querySelector("[role=alert]")?.textContent ?? null, "the page refused a completed erasure").toBeNull();
    expect(receiptShown(c), "no receipt after DELETE /account answered 200").toBe(true);
    expect(c.textContent, "the erased account is still named as signed in").not.toContain("Signed in as");
    expect(rig.asked.filter((a) => a === "POST /api/auth/login"), "the confirmation signed in again").toEqual([]);
    expect(rig.asked.filter((a) => a === "POST /api/auth/step-up/totp")).toHaveLength(1);
    expect(await mirrorsLeft(), "the erased account's mirror is still in this browser").toEqual([]);
    expect(seeded.keys.filter((k) => localStorage.getItem(k) !== null), "account-keyed storage survived").toEqual([]);
    expect(seeded.prefs.filter(held), "the account's preferences or this tab's notes about it survived").toEqual([]);
    expect(document.cookie.includes("tf_owner="), "the name went with the mail").toBe(false);
    // The receipt no longer carries the cache clear: the browser asks for it once, and the receipt
    // shows while that request is still unanswered.
    expect(rig.purges, "the cache clear after the erase").toBe(1);
    expect(rig.asked.filter((a) => a === "POST /auth/refresh"), "a request on the refresh door other than the purge").toHaveLength(1);
  }, 30_000);

  it("THE CENSUS: zero entities and zero keys for the erased account; another account's copy survives", async () => {
    await seedThisBrowser();
    const others = [...await seedAnotherAccount(), ...await plantPreferences(OTHER)];
    // Ids that extend the erased one's, and keys that name no account: none of them is the erasure's.
    const { searchSortKey } = await import("@ohmail/app-logic/storage/persisted-ui");
    const kin = [searchSortKey(`${OWNER}0`), searchSortKey(`${OWNER}.x`)].sort();
    const device = ["ohmail.theme", "ohmail.ui.columns", searchSortKey(null)];
    for (const k of [...kin, ...device]) localStorage.setItem(k, "kept");
    // The id sets an earlier build kept device-wide, the erased account's folder paths and message ids among them.
    const retired = ["ohmail.ui.rail.foldersOpened", "ohmail.ui.mail.original"];
    localStorage.setItem(retired[0]!, JSON.stringify([`mbx-${OWNER.slice(0, 4)}|Clients/Acme Corp`]));
    localStorage.setItem(retired[1]!, JSON.stringify(["m1"]));
    expect(await entitiesOf(OTHER), "the control seeded nothing").toBe(1);
    expect(keysNaming(OWNER).length, "the census has nothing to find").toBeGreaterThan(0);
    // A renewal the server did not answer keeps its name owed, in its own IndexedDB database.
    const refresh = await import("../app/session-refresh.js");
    const renewalNames = async (): Promise<string[]> =>
      (await indexedDB.databases()).map((d) => d.name ?? "").filter((n) => n === refresh.SESSION_ATTEMPT_DB);
    expect(await refresh.resumeSession()).toBe("unavailable");
    expect(await renewalNames(), "the control: the renewal's name is in IndexedDB").toHaveLength(1);

    const c = await eraseThroughThePage();
    await waitFor(() => receiptShown(c), "the receipt");

    expect(await renewalNames(), "the erased session's renewal name survived").toEqual([]);
    expect(await mirrorsLeft(), "the erase took another account's mirror, or left its own")
      .toEqual([`ohmail-mirror:${OTHER}`]);
    expect(keysNaming(OWNER), "keys naming the erased account survived").toEqual(kin);
    expect(retired.filter(held), "a device-wide set holding the erased account's folder paths survived").toEqual([]);
    expect([...others, ...kin, ...device].filter((k) => !held(k)), "another account's keys went with it").toEqual([]);
    expect(await entitiesOf(OTHER), "another account's mail went with it").toBe(1);
  }, 30_000);

  it("after the erase this tab asks nothing more, and never says it lost the account's name", async () => {
    await seedThisBrowser();
    const c = await eraseThroughThePage();
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

    const c = await eraseThroughThePage();
    await waitFor(() => receiptShown(c) || c.querySelector("[role=alert]") != null, "a receipt or a refusal");

    expect(receiptShown(c), "a blocked wipe must not hide a completed erasure").toBe(true);
    expect(c.textContent).toContain(en.deleteAccount.erasedMirrorBlocked);
    // The registry record of the mirror still on disk stays, so a later wipe can name it; nothing else.
    expect(keysNaming(OWNER)).toEqual([`ohmail.mirror.ohmail-mirror:${OWNER}`]);
    other.close();
  }, 30_000);

  it("in German the same receipt speaks to the reader as du", async () => {
    await seedThisBrowser();
    const other = await new Promise<IDBDatabase>((ok, no) => {
      const req = indexedDB.open(`ohmail-mirror:${OWNER}`);
      req.onsuccess = () => ok(req.result);
      req.onerror = () => no(req.error);
    });
    const c = await eraseThroughThePage("de");
    await waitFor(() => c.textContent!.includes(de.deleteAccount.erasedMirrorBlocked), "the German blocked receipt");
    expect(formalAddress(c), "the receipt says Sie").toEqual([]);
    other.close();
  }, 30_000);
});

describe("a refused erase says so, and the next press can erase", () => {
  it("a server refusal keeps the address and the browser copy until a verified retry", async () => {
    const seeded = await seedThisBrowser();
    rig.erase = () => json({ error: { code: "internal", message: "internal error" } }, 500);

    const c = await eraseThroughThePage();
    await waitFor(() => c.querySelector("[role=alert]") != null, "the refusal");

    expect(c.querySelector("[role=alert]")!.textContent).toBe(en.account.eraseRefused);
    expect(c.textContent, "the server's own words reached the person").not.toContain("internal error");
    expect(c.querySelector('[role="dialog"] input[autocomplete="one-time-code"]'), "left on a prompt for a window that is open").toBeNull();
    expect(addressField(c)?.value, "not back at the top, address kept").toBe(EMAIL);
    // The account still exists, so this browser keeps it, and its cache.
    expect(await mirrorsLeft()).toEqual([`ohmail-mirror:${OWNER}`]);
    expect([...seeded.keys, ...seeded.prefs].filter((k) => !held(k))).toEqual([]);
    expect(rig.purges, "a cache clear after a refused erase").toBe(0);

    // The page asks again even while the previous factor window is open.
    rig.erase = () => { clearReadableCookies(); return json(RECEIPT); };
    await openEraseDialog(c);
    await verifyErase(c);
    await waitFor(() => receiptShown(c), "the receipt after the retry");
    expect(rig.asked.filter((a) => a === "POST /api/auth/login")).toEqual([]);
    expect(factors()).toBe(2);
    expect(erases()).toBe(2);
    expect(await mirrorsLeft()).toEqual([]);
    expect(rig.purges, "the erase that went through asks for the cache clear once").toBe(1);
    seeded.close();
  }, 30_000);

  it("an erase that got no answer keeps the client's own sentence, which claims nothing", async () => {
    await seedThisBrowser();
    rig.erase = () => { throw new TypeError("network down"); };

    const c = await eraseThroughThePage();
    await waitFor(() => c.querySelector("[role=alert]") != null, "the refusal");

    const said = c.querySelector("[role=alert]")!.textContent!;
    expect(said, "an unanswered request must not claim nothing was deleted").not.toBe(en.account.eraseRefused);
    expect(said).toContain("We could not reach ohmail");
    expect(addressField(c), "back at the top").not.toBeNull();
    expect(rig.purges, "a cache clear after an erase nobody answered").toBe(0);
  }, 30_000);

  it("a platform 5xx with no envelope of ours (the function cut mid-erasure) is unconfirmed, never nothing removed", async () => {
    const seeded = await seedThisBrowser();
    rig.erase = () => new Response("<html><body>504 Gateway Timeout</body></html>", {
      status: 504, headers: { "content-type": "text/html" },
    });

    const c = await eraseThroughThePage();
    await waitFor(() => c.querySelector("[role=alert]") != null, "the refusal");

    const said = c.querySelector("[role=alert]")!.textContent!;
    expect(said, "an outcome nobody confirmed").toBe(en.account.eraseUnconfirmed);
    expect(addressField(c), "back at the top").not.toBeNull();
    // Nothing proves the account is gone, so this browser keeps its copy, and its cache.
    expect(await mirrorsLeft()).toEqual([`ohmail-mirror:${OWNER}`]);
    expect(rig.purges, "a cache clear after an unconfirmed erase").toBe(0);
    seeded.close();
  }, 30_000);
});
