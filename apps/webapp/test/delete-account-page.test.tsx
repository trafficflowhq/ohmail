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
 * `/account/delete` — THE ACCOUNT ERASED FROM A PAGE OF ITS OWN, through the real route, the real client, the real
 * step-up dialog and the real wipe; only `fetch` and the IndexedDB factory are stand-ins. The page settles whose
 * browser this is, shows what is erased and kept before anything is typed, asks the second factor on EVERY press and
 * erases only once it verifies, exactly once; it says each outcome in the account pane's own sentences, and a test
 * holds the two erases equal while the pane keeps its own.
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
const W = en.deleteAccount;
const A = en.account;

const clearReadableCookies = (): void => {
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
};

const json = (body: unknown, status = 200, account: string | null = OWNER): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(account === null ? {} : { "X-Ohmail-Account": account }) },
  });

/** `erase` answers each DELETE in turn once the window is open; `windowClosed` until a factor verifies. */
interface Rig {
  erase: () => Response;
  asked: string[];
  windowClosed: boolean;
  tokens: (string | null)[];
  /** Holds the factor's answer until the case lets it land. */
  factor: Promise<void> | null;
  /** A live session on this browser; false: no session and nothing to renew it with. */
  signedIn: boolean;
}
const rig: Rig = { erase: () => json({}), asked: [], windowClosed: true, tokens: [], factor: null, signedIn: true };
const stepUpRequired = (): Response =>
  json({ error: { code: "step_up_required", message: "recent two-factor authentication required" } }, 403);
const RECEIPT = {
  erased: true, usersErased: 1, tables: {}, stagingTicketsExpired: 0, redactedTables: {},
  retained: "billing records only, under a pseudonymous account id", subscription: "none",
};
const refusedWith = (subscription?: string): Response =>
  json({ error: { code: "internal", message: "internal error", ...(subscription ? { details: { subscription } } : {}) } }, 500);

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
  rig.tokens = [];
  rig.windowClosed = true;
  rig.factor = null;
  rig.signedIn = true;
  rig.erase = () => { clearReadableCookies(); return json(RECEIPT); };
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    rig.asked.push(`${method} ${url}`);
    if (url === "/auth/refresh") {
      return rig.signedIn
        ? new Promise<Response>(() => {})
        : json({ error: { code: "refresh_missing", message: "missing refresh token" } }, 401, null);
    }
    if (url === "/api/auth/session" && !rig.signedIn) {
      return json({ error: { code: "unauthorized", message: "authentication required" } }, 401, null);
    }
    if (url === "/api/auth/session") {
      return json({ user: { accountId: OWNER, email: EMAIL, twofaEnrolled: { webauthn: false, totp: true } }, scope: "full" });
    }
    // The step-up re-stamps THIS session: no Set-Cookie, the same account named.
    if (url === "/api/auth/step-up/totp" && method === "POST") {
      if (rig.factor !== null) await rig.factor;
      rig.windowClosed = false;
      return json({ ok: true });
    }
    if (url === "/api/account" && method === "DELETE") {
      const token = new Headers(init?.headers).get("x-csrf-token");
      rig.tokens.push(token);
      if (token === null) return json({ error: { code: "csrf_failed", message: "csrf" } }, 403);
      return rig.windowClosed ? stepUpRequired() : rig.erase();
    }
    if (url === "/api/account/access") return json({ metered: false });
    return json({ error: { code: "not_found", message: "not found" } }, 404);
  }) as typeof globalThis.fetch;
  (await import("../app/api-client.js")).setAccountHeaderCapability(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

async function waitFor(predicate: () => boolean, what: string, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}; saw: ${document.body.textContent}`);
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function submit(form: Element): Promise<void> {
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}
async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
}

async function mountIn(node: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, { locale: "en", messages: en, timeZone: "UTC", children: node }));
  });
  return container;
}

async function mountPage(): Promise<HTMLElement> {
  const { DeleteAccountRoute } = await import("../app/(product)/account/delete/DeleteAccountRoute.js");
  return mountIn(h(DeleteAccountRoute));
}

/** The page's blank, its press and the dialog's code field, by what a person reads. */
const blank = (c: HTMLElement): HTMLInputElement | null =>
  [...c.querySelectorAll<HTMLInputElement>("input")].find((i) => i.closest('[role="dialog"]') === null) ?? null;
const pressOf = (c: HTMLElement, label: string): HTMLButtonElement | null =>
  [...c.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    [...b.childNodes].filter((n) => n.nodeName !== "KBD").map((n) => n.textContent ?? "").join("").trim() === label) ?? null;
const dialog = (c: HTMLElement): Element | null => c.querySelector('[role="dialog"]');
const codeField = (c: HTMLElement): HTMLInputElement | null => c.querySelector<HTMLInputElement>('[role="dialog"] input');
const pageAlert = (c: HTMLElement): string | null =>
  [...c.querySelectorAll('[role="alert"]')].find((a) => a.closest('[role="dialog"]') === null)?.textContent ?? null;
const deletes = (): number => rig.asked.filter((a) => a === "DELETE /api/account").length;
const stepUps = (): number => rig.asked.filter((a) => a === "POST /api/auth/step-up/totp").length;
const receiptShown = (c: HTMLElement): boolean => c.textContent!.includes(W.doneTitle.replace(/\.$/, ""));

/** Type the address back and press: the second factor is asked. */
async function pressDelete(c: HTMLElement): Promise<void> {
  await waitFor(() => blank(c) !== null, "the form");
  await type(blank(c)!, EMAIL);
  await click(pressOf(c, W.begin)!);
  await waitFor(() => codeField(c) !== null, "the dialog's code field");
}
/** One code at the dialog. */
async function verify(c: HTMLElement): Promise<void> {
  await type(codeField(c)!, "123456");
  await submit(codeField(c)!.closest("form")!);
}

describe("the page shows what it does before anything is typed, and asks nothing on its own", () => {
  it("mounting sends no DELETE and no factor; nothing in the address fills the blank", async () => {
    window.history.replaceState(null, "", `/account/delete?email=${EMAIL}&typed=${EMAIL}#${EMAIL}`);
    const c = await mountPage();
    await waitFor(() => blank(c) !== null, "the form");
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(blank(c)!.value).toBe("");
    expect(deletes()).toBe(0);
    expect(stepUps()).toBe(0);
    expect(rig.asked.filter((a) => !a.startsWith("GET ")), "a write left on mount").toEqual([]);
  });

  it("a browser with no session is told so, and nothing is asked before the page knows whose browser this is", async () => {
    // The jar still names the account it held: a read pended on it would leave before the settle said no.
    rig.signedIn = false;
    const c = await mountPage();
    await waitFor(() => c.textContent!.includes(W.signedOutBody), "the signed-out sentence");
    expect(pressOf(c, W.signIn)).not.toBeNull();
    expect(blank(c)).toBeNull();
    expect(rig.asked.filter((a) => a.includes("/account")), "the account was asked about before the settle").toEqual([]);
  });

  it("both lists stand before the blank, and the press is off until the session's own address is typed", async () => {
    const c = await mountPage();
    await waitFor(() => blank(c) !== null, "the form");
    for (const said of [W.gone1, W.gone4, W.goneWhen, W.kept1, W.lead]) expect(c.textContent).toContain(said);
    expect(pressOf(c, W.begin)!.disabled).toBe(true);
    await type(blank(c)!, "someone@example.test");
    expect(pressOf(c, W.begin)!.disabled).toBe(true);
    await type(blank(c)!, ` ${EMAIL.toUpperCase()} `);
    expect(pressOf(c, W.begin)!.disabled).toBe(false);
  });
});

describe("every press asks the second factor, and the erase runs once, from the verified factor alone", () => {
  it("over a window that is already open, the press still asks the factor and erases nothing before it", async () => {
    rig.windowClosed = false;
    const c = await mountPage();
    await pressDelete(c);
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(deletes(), "the erase ran before the factor").toBe(0);
    expect(dialog(c)!.textContent).toContain(W.factorBody.replace("{email}", EMAIL));
    await verify(c);
    await waitFor(() => receiptShown(c), "the receipt");
    expect(deletes()).toBe(1);
    expect(stepUps()).toBe(1);
    expect(rig.asked).not.toContain("POST /api/auth/login");
  });

  it("the DELETE carries the jar's token", async () => {
    const c = await mountPage();
    await pressDelete(c);
    await verify(c);
    await waitFor(() => receiptShown(c), "the receipt");
    expect(rig.tokens).toEqual(["csrf-under-test"]);
  });

  it("with no token in the jar the refusal is said and nothing is wiped", async () => {
    const d = await mountPage();
    await waitFor(() => blank(d) !== null, "the form");
    document.cookie = "tf_csrf=; Path=/; Max-Age=0";
    await pressDelete(d);
    await verify(d);
    await waitFor(() => pageAlert(d) !== null, "the refusal");
    expect(rig.tokens).toEqual([null]);
    expect(pageAlert(d)).toBe(A.eraseRefused);
    expect(receiptShown(d)).toBe(false);
  });

  it("a second closed window after the verified factor is a sentence, never a second dialog", async () => {
    rig.erase = stepUpRequired;
    const c = await mountPage();
    await pressDelete(c);
    await verify(c);
    await waitFor(() => pageAlert(c) !== null, "the sentence");
    expect(pageAlert(c)).toBe(en.devices.stepUpExpired);
    expect(dialog(c), "a second dialog").toBeNull();
    expect(deletes()).toBe(1);
    expect(blank(c)!.value, "the address kept").toBe(EMAIL);
  });

  it("Cancel at the factor erases nothing, and the page is back with the address kept", async () => {
    const c = await mountPage();
    await pressDelete(c);
    await click(pressOf(dialog(c) as HTMLElement, en.stepUp.cancel)!);
    expect(dialog(c)).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(deletes()).toBe(0);
    expect(blank(c)!.value).toBe(EMAIL);
    expect(c.textContent, "a factor was said discarded that never went out").not.toContain(W.cancelledNothingErased);
  });

  it("Cancel while the factor is on its way: the factor lands, nothing is erased, and the page says so", async () => {
    let land!: () => void;
    rig.factor = new Promise<void>((r) => { land = r; });
    const c = await mountPage();
    await pressDelete(c);
    await verify(c);
    await waitFor(() => stepUps() === 1, "the factor on the wire");
    await click(pressOf(dialog(c) as HTMLElement, en.stepUp.cancel)!);
    land();
    await waitFor(() => c.textContent!.includes(W.cancelledNothingErased), "the discarded sentence");
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(deletes(), "the factor that landed after Cancel erased").toBe(0);
    expect(receiptShown(c)).toBe(false);
  });
});

describe("another tab under the page", () => {
  it("the marker names another account before the press: nothing leaves", async () => {
    const c = await mountPage();
    await waitFor(() => blank(c) !== null, "the form");
    document.cookie = `tf_owner=${OTHER}; Path=/`;
    await type(blank(c)!, EMAIL);
    await click(pressOf(c, W.begin)!);
    await waitFor(() => dialog(c) !== null, "the dialog");
    if (codeField(c) !== null) await verify(c);
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(stepUps(), "a factor left for another account's jar").toBe(0);
    expect(deletes(), "an erase left for another account's jar").toBe(0);
  });

  it("the marker names another account while the dialog is up: the factor and the erase stay home", async () => {
    const c = await mountPage();
    await pressDelete(c);
    document.cookie = `tf_owner=${OTHER}; Path=/`;
    await verify(c);
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(stepUps()).toBe(0);
    expect(deletes()).toBe(0);
    expect(receiptShown(c)).toBe(false);
  });

  it("the marker goes while the dialog is up: the page settles again, and nothing parked runs", async () => {
    const c = await mountPage();
    await pressDelete(c);
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    await verify(c);
    await waitFor(() => dialog(c) === null, "the dialog gone");
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(deletes(), "the parked erase ran by itself").toBe(0);
    expect(receiptShown(c)).toBe(false);
  });

  it("the marker goes between the verified factor and the erase: the page settles again, never the lost-name sentence", async () => {
    let land!: () => void;
    rig.factor = new Promise<void>((r) => { land = r; });
    const c = await mountPage();
    await pressDelete(c);
    await verify(c);
    await waitFor(() => stepUps() === 1, "the factor on the wire");
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    land();
    await waitFor(() => dialog(c) === null, "the dialog gone");
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(c.textContent).not.toMatch(/lost the name of the account|lost track of which account/);
    expect(deletes(), "an erase left with no account named").toBe(0);
    expect(receiptShown(c)).toBe(false);
  });

  it("a sign-out this browser asked for and the server never confirmed is said, and no form is offered", async () => {
    document.cookie = "tf_owner=signed_out_pending; Path=/";
    const c = await mountPage();
    await waitFor(() => c.textContent!.includes(en.session.refusedOwnerSignedOut), "the sign-in-again sentence");
    expect(blank(c)).toBeNull();
    expect(deletes()).toBe(0);
  });
});

describe("the outcomes, in the pane's own sentences", () => {
  it("erased: this account's copy goes and another account's stays; a copy another tab holds is said with the receipt", async () => {
    const engine = await import("@ohmail/client-engine");
    for (const owner of [OWNER, OTHER]) {
      const store = new engine.IndexedDbMirrorStore({ owner });
      await store.load();
      await store.putLocal("message", `m-${owner}`, { id: `m-${owner}`, subject: "a letter" });
      store.close();
    }
    const holder = await new Promise<IDBDatabase>((ok, no) => {
      const req = indexedDB.open(`ohmail-mirror:${OWNER}`);
      req.onsuccess = () => ok(req.result);
      req.onerror = () => no(req.error);
    });
    const c = await mountPage();
    await pressDelete(c);
    await verify(c);
    await waitFor(() => receiptShown(c), "the receipt");
    expect(pageAlert(c)).toBe(W.erasedMirrorBlocked);
    holder.close();
    const other = new engine.IndexedDbMirrorStore({ owner: OTHER });
    await other.load();
    expect(other.list("message"), "another account's copy went with it").toHaveLength(1);
    other.close();
  });

  it("a subscription cancelled by a press that failed is still said after the retry erases", async () => {
    rig.erase = () => refusedWith("cancelled");
    const c = await mountPage();
    await pressDelete(c);
    await verify(c);
    await waitFor(() => pageAlert(c) !== null, "the refusal");
    expect(pageAlert(c)).toBe(A.eraseRefusedSubCancelled);
    rig.erase = () => { clearReadableCookies(); return json(RECEIPT); };
    await click(pressOf(c, W.begin)!);
    await waitFor(() => codeField(c) !== null, "the dialog again");
    await verify(c);
    await waitFor(() => receiptShown(c), "the receipt");
    expect(c.textContent).toContain(W.doneSubCancelled);
    expect(stepUps(), "every press asks the factor").toBe(2);
  });

  it("the subscription that could not be cancelled is said as a warning beside the receipt", async () => {
    rig.erase = () => { clearReadableCookies(); return json({ ...RECEIPT, subscription: "cancel_failed" }); };
    const c = await mountPage();
    await pressDelete(c);
    await verify(c);
    await waitFor(() => receiptShown(c), "the receipt");
    expect(pageAlert(c)).toBe(W.doneSubFailed);
  });
});

/**
 * PARITY WITH THE PANE. Settings › Account keeps its own erase until it moves here; for every answer the server can
 * give the erase, the page and the pane say the same sentence. The pane tries the erase first and asks the factor on
 * a closed window; the page asks the factor first: the answer after the factor is the one compared.
 */
describe("the page and Settings › Account say the same outcome", () => {
  async function throughThePane(): Promise<HTMLElement> {
    const client = await import("../app/api-client.js");
    client.bindApiOwner(OWNER);
    const { AccountSection } = await import("../app/(product)/mailbox/AccountSection.js");
    const c = await mountIn(h(AccountSection));
    await waitFor(() => c.querySelector("#acct-typed") != null, "the pane's facts");
    await type(c.querySelector<HTMLInputElement>("#acct-typed")!, EMAIL);
    await submit(c.querySelector("form.acct-confirm")!);
    await waitFor(() => c.querySelector("#stepup-code") != null, "the pane's prompt");
    await type(c.querySelector<HTMLInputElement>("#stepup-code")!, "123456");
    await submit(c.querySelector("#stepup-code")!.closest("form")!);
    return c;
  }
  async function throughThePage(): Promise<HTMLElement> {
    const c = await mountPage();
    await pressDelete(c);
    await verify(c);
    return c;
  }
  const said = (c: HTMLElement): string | null => c.querySelector('[role="alert"]')?.textContent ?? null;

  const ANSWERS: [string, () => Response][] = [
    ["a refusal", () => refusedWith()],
    ["a refusal after the subscription was cancelled", () => refusedWith("cancelled")],
    ["a refusal whose cancel failed", () => refusedWith("cancel_failed")],
    ["an erasure nobody confirmed", () => json({ error: { code: "erasure_unconfirmed", message: "unconfirmed" } }, 500)],
    ["a platform 5xx with no envelope", () => new Response("<html>504</html>", { status: 504, headers: { "content-type": "text/html" } })],
    ["no answer at all", () => { throw new TypeError("network down"); }],
  ];
  for (const [what, answer] of ANSWERS) {
    it(what, async () => {
      rig.erase = answer;
      const pane = await throughThePane();
      await waitFor(() => said(pane) !== null, "the pane's sentence");
      const paneSaid = said(pane);
      cleanup();
      rig.asked = [];
      rig.windowClosed = true;
      document.cookie = `tf_owner=${OWNER}; Path=/`;
      document.cookie = "tf_csrf=csrf-under-test; Path=/";
      vi.resetModules();
      (await import("../app/api-client.js")).setAccountHeaderCapability(true);
      const page = await throughThePage();
      await waitFor(() => pageAlert(page) !== null, "the page's sentence");
      expect(pageAlert(page)).toBe(paneSaid);
    });
  }
});

/** Unmount what a case mounted, so the next mount in the same case starts clean. */
function cleanup(): void {
  for (const root of roots) root.unmount();
  roots = [];
  document.body.innerHTML = "";
}
