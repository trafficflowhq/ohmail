/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { managedWordsIn } from "./_managed-words";

/**
 * DELETE YOUR ACCOUNT ON A SELF-HOSTED SERVER SAYS WHAT THAT SERVER KEEPS. "Kept" read the managed sentence — a
 * billing row, the credit ledger, the subscription record, the link to the payment processor — on a server whose
 * database has none of them, and the receipt's button named the managed address. Rendered, not read from source:
 * the pane's own text on a self-host build carries no managed word, in either language, before and after the erase;
 * the managed build keeps its sentence (the control), and a managed sentence planted in the self-host path is found.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** The server's own sentence for an erasure on a host with no billing program, read from the route (jsdom's
 *  `import.meta.url` is http, so the path is the run's cwd, the repo root). */
const ROUTE = `${process.cwd()}/packages/api/src/routes/account.ts`;
const RETAINED_UNMETERED = /const RETAINED_UNMETERED =\s*"([^"]+)"/.exec(readFileSync(ROUTE, "utf8"))![1]!;

const rig = vi.hoisted(() => ({ selfHost: false }));

vi.mock("../app/hello", async () => {
  const actual = await vi.importActual<typeof import("../app/hello")>("../app/hello");
  return { ...actual, get SELF_HOST_BUILD() { return rig.selfHost; }, serverHello: async () => null };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
vi.mock("../app/sign-out", async (original) => ({
  ...await original<typeof import("../app/sign-out")>(),
  forgetThisBrowser: async () => ({ remaining: [], inventoryComplete: true }),
  signOut: async () => ({ cleared: true, inventoryComplete: true, serverRefused: null, remaining: [] }),
}));
vi.mock("../app/api-client", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
  }
  // The access feed as the real client keeps it: every answer published, whoever asked for it.
  let feed: { owner: null; answer: unknown; caughtUp: null; at: number } | null = null;
  const listeners = new Set<() => void>();
  const publish = (answer: unknown) => {
    feed = { owner: null, answer, caughtUp: null, at: Date.now() };
    for (const l of [...listeners]) l();
    return answer;
  };
  return {
    ApiError,
    apiConfigured: () => true,
    accessFeedFor: () => feed,
    onAccessFeed: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    webauthnAvailable: () => false,
    assertPasskey: async () => ({ id: "credential" }),
    codeOf: () => null,
    messageOf: (e: unknown) => String(e),
    auth: {
      session: async () => ({ user: { accountId: "acct-1", email: "person@example.test" }, scope: "full" }),
      login: async () => ({ status: "twofa_required", loginToken: "tok", methods: ["totp"] }),
      totpVerify: async () => ({ user: { accountId: "acct-1", email: "person@example.test" } }),
    },
    account: {
      // The managed control's account has a manage page; a self-host build never asks.
      access: async () => publish({ metered: true }),
      erase: async () => ({
        erased: true, subscription: "none",
        retained: rig.selfHost ? RETAINED_UNMETERED : "billing records only, under a pseudonymous account id",
      }),
    },
  };
});

let root: Root | null = null;
beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function waitFor(ok: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  }
}

async function field(c: HTMLElement, sel: string, value: string): Promise<void> {
  const input = c.querySelector<HTMLInputElement>(sel)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function submit(form: Element): Promise<void> {
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

/** The pane at its facts: the Erased and Kept columns, the sentences this finding is about. */
async function mount(selfHost: boolean, messages: AbstractIntlMessages, locale = "en"): Promise<HTMLElement> {
  rig.selfHost = selfHost;
  const { AccountSection } = await import("../app/(product)/mailbox/AccountSection.js");
  const c = document.createElement("div");
  document.body.appendChild(c);
  root = createRoot(c);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale, messages, timeZone: "UTC", children: h(AccountSection) }));
  });
  await waitFor(() => c.querySelector("#acct-typed") != null, "the facts");
  // `useManageOffer` settles after the session read; one more turn so a managed keptSub is on screen.
  await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  return c;
}

/** The press to the receipt (a fresh step-up window, so the erase runs on the press). */
async function erase(c: HTMLElement): Promise<void> {
  await field(c, "#acct-typed", "person@example.test");
  await submit(c.querySelector("form:has(#acct-typed)")!);
  await waitFor(() => c.textContent!.includes(en.account.doneTitle), "the receipt");
}

const text = (c: HTMLElement): string => c.textContent ?? "";

describe("Delete your account on a self-hosted server", () => {
  it("Kept names what this server keeps, and no managed word, in English and German", async () => {
    const c = await mount(true, en);
    expect(text(c)).toContain(en.account.keptSelfHost);
    expect(managedWordsIn(text(c))).toEqual([]);
    await act(() => root!.unmount());
    const d = await mount(true, de, "de");
    expect(text(d)).toContain(de.account.keptSelfHost);
    expect(managedWordsIn(text(d))).toEqual([]);
  });

  it("the receipt carries the server's own sentence and a button naming no managed address", async () => {
    const c = await mount(true, en);
    await erase(c);
    expect(text(c)).toContain(RETAINED_UNMETERED);
    expect(text(c)).toContain(en.account.doneHomeSelfHost);
    expect(managedWordsIn(text(c))).toEqual([]);
  });

  it("CONTROL: the managed build keeps the managed sentence, its subscription line and its address", async () => {
    const c = await mount(false, en);
    expect(text(c)).toContain(en.account.kept1);
    expect(text(c)).toContain(en.account.keptSub);
    await erase(c);
    expect(text(c)).toContain(en.account.doneHome);
  });

  it("PLANTED: a managed sentence in the self-host Kept line is found by the same reading", async () => {
    const planted = structuredClone(en);
    planted.account.keptSelfHost = "The credit ledger and the subscription record are kept.";
    const c = await mount(true, planted);
    expect(managedWordsIn(text(c))).toEqual(["credit", "subscription"]);
  });
});
