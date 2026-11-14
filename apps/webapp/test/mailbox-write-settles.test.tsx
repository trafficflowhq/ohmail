/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { MailboxDTO } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * A WRITE NEVER PAINTS THE LIST FROM BEFORE IT — the pane's half of the first-run rule.
 *
 * `MailboxSection` moved to `list` before its own re-read had answered, so the rows from before
 * the write were painted as its result. Now the list is painted only over a read issued after the
 * write, bounded; a read that fails or runs out the bound leaves the pane where it is with a
 * sentence instead of the rows, and the next read that answers finishes the move.
 * MUTATION WATCHED RED, RESTORED BY `cmp`: `setStage("list")` moved above `await afterWrite()`
 * in `connect()` reds the first case.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const copy = messages.mailboxes as unknown as Record<string, string>;
const picker = messages.providerPicker as unknown as Record<string, string>;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const QUIET = { mailboxes: null, mirrored: 0, freshness: { state: "unknown", asOf: null } } as unknown as MailState;

const OLD = "already-here@example.test";
const NEW = "just-connected@example.test";
const dto = (id: string, address: string): MailboxDTO => ({
  id, address, provider: "imap", displayName: null, status: "connected",
  lastSyncAt: "2026-09-20T11:00:00.000Z", createdAt: "2026-09-01T10:00:00.000Z",
} as MailboxDTO);

/** The list's answers, in order. After the create each read is a promise this file settles. */
let mockCreated = false;
let mockAfter: () => Promise<{ items: MailboxDTO[] }> = async () => ({ items: [] });

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    assertPasskey: async () => ({}),
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({ user: { email: "person@example.test", emailVerified: true }, scope: "full" }),
      login: async () => ({ status: "twofa_required", loginToken: "tok", methods: ["totp"] }),
      totpVerify: async () => undefined,
    },
    account: { access: async () => ({ metered: false }) },
    mailboxes: {
      list: () => (mockCreated ? mockAfter() : Promise.resolve({ items: [dto("mb-old", OLD)] })),
      create: async () => { mockCreated = true; return dto("mb-new", NEW); },
      oauthAvailability: async () => ({ available: false }),
    },
  };
});
vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); });
}
function press(el: Element, prefix: string): HTMLElement {
  const hits = [...el.querySelectorAll("button")].filter((n) => (n.textContent ?? "").trim().startsWith(prefix));
  expect(hits.length, `"${prefix}" matched ${hits.length} controls, not one`).toBe(1);
  return hits[0] as HTMLElement;
}
async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}
async function typeInto(el: Element | null, value: string): Promise<void> {
  expect(el, "a field the walk needs is not on screen").toBeTruthy();
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
  await act(async () => { el!.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
}
async function submit(form: Element | null): Promise<void> {
  expect(form, "a form the walk needs is not on screen").toBeTruthy();
  await act(async () => { form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}

const rows = (el: Element): string[] =>
  [...el.querySelectorAll(".mbx-addr")].map((n) => n.textContent ?? "");
const listStage = (el: Element): boolean =>
  [...el.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim() === copy.connect);

/** Connect NEW through the form and the second factor; resolves once the create has answered. */
async function connectNew(): Promise<HTMLDivElement> {
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, children: h(MailboxSection) }));
  });
  await settle();
  const el = host;
  expect(rows(el)).toEqual([OLD]);
  await click(press(el, copy.connect!));
  await click(press(el, picker.otherLabel!));
  await typeInto(el.querySelector("#mb-address"), NEW);
  await typeInto(el.querySelector("#mb-imap"), "imap.example.test");
  await typeInto(el.querySelector("#mb-smtp"), "smtp.example.test");
  await typeInto(el.querySelector("#mb-pass"), "app-password");
  // The connect is tried on submit (a fresh step-up window, so no prompt).
  await submit(el.querySelector("form.acct-confirm"));
  expect(mockCreated, "the create never happened — this case measures nothing").toBe(true);
  return el;
}

/** Every paint from now on: was the list stage on screen, and which rows did it show. */
function watch(el: Element): Array<{ list: boolean; rows: string[] }> {
  const seen: Array<{ list: boolean; rows: string[] }> = [{ list: listStage(el), rows: rows(el) }];
  const obs = new MutationObserver(() => { seen.push({ list: listStage(el), rows: rows(el) }); });
  obs.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
  observers.push(obs);
  return seen;
}
const observers: MutationObserver[] = [];

beforeEach(() => { mockCreated = false; });
afterEach(async () => {
  for (const o of observers.splice(0)) o.disconnect();
  vi.useRealTimers();
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
});

describe("a create's list is painted only over the read that holds it", () => {
  it("the re-read answers 500 ms later, and no paint in between is the list from before", async () => {
    let answered = false;
    mockAfter = () => new Promise((resolve) => {
      setTimeout(() => { answered = true; resolve({ items: [dto("mb-old", OLD), dto("mb-new", NEW)] }); }, 500);
    });
    const el = await connectNew();
    const paints = watch(el);
    expect(listStage(el), "the list came back before its re-read").toBe(false);
    expect(el.textContent).toContain(copy.connecting);

    await act(async () => { await new Promise((r) => setTimeout(r, 650)); });
    await settle();
    expect(answered, "the re-read never ran — this case measures nothing").toBe(true);
    const stale = paints.filter((p) => p.list && !p.rows.includes(NEW));
    expect(stale, "the list was painted with the rows from before the write").toEqual([]);
    expect(listStage(el)).toBe(true);
    expect(rows(el)).toEqual([OLD, NEW]);
  });

  it("a re-read that fails keeps the pane here with its sentence, and the next read finishes it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { ApiError } = await import("../app/api-client");
    mockAfter = async () => { throw new ApiError(503, "unavailable", "the list is down"); };
    const el = await connectNew();
    expect(listStage(el)).toBe(false);
    expect(el.textContent).toContain(copy.listBehind);
    expect(rows(el), "the rows from before the write were shown").toEqual([]);

    mockAfter = async () => ({ items: [dto("mb-old", OLD), dto("mb-new", NEW)] });
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await settle();
    expect(listStage(el)).toBe(true);
    expect(rows(el)).toEqual([OLD, NEW]);
    expect(el.textContent).not.toContain(copy.listBehind);
  });

  it("a re-read that outlasts the bound says so instead of painting the old rows", async () => {
    let release: (() => void) | undefined;
    mockAfter = () => new Promise((resolve) => {
      release = () => resolve({ items: [dto("mb-old", OLD), dto("mb-new", NEW)] });
    });
    const el = await connectNew();
    const paints = watch(el);
    await act(async () => { await new Promise((r) => setTimeout(r, 4_300)); });
    await settle();
    expect(el.textContent).toContain(copy.listBehind);
    expect(listStage(el)).toBe(false);

    await act(async () => { release!(); });
    await settle();
    expect(listStage(el)).toBe(true);
    expect(rows(el)).toEqual([OLD, NEW]);
    expect(paints.filter((p) => p.list && !p.rows.includes(NEW))).toEqual([]);
  }, 15_000);
});
