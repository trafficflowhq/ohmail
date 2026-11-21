/** @vitest-environment jsdom */
import type { EngineMessage, SyncResponse } from "@ohmail/wire";
import { mailboxLabelResolver, type MailboxLabelFact } from "@ohmail/app-logic/reader";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const name = "Fixture Stranger";
const address = "stranger@fixture.example";
const subject = "A letter waiting to be screened";
const letter: EngineMessage = {
  id: "letter", accountId: ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject, from: { name, address }, to: [], cc: [], date: ISO, folder: "ohmail/Screener",
  snippet: "A preview of the letter", unread: true, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
};

const other: EngineMessage = {
  ...letter, id: "other-letter", subject: "A different held letter",
  from: { name: "Other Sender", address: "other@fixture.example" },
};

let mounted = false;
beforeAll(warmCloudShell);
afterEach(async () => {
  if (mounted) await teardownConfirmEnv();
  mounted = false;
  vi.unstubAllGlobals();
});

async function mount({ width = 414, coarse = true, letters = [letter] } = {}) {
  installConfirmEnv();
  mounted = true;
  window.localStorage.clear();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  scriptSync(() => Response.json({
    changes: {
      creates: letters.map((entity, index) => ({
        type: "message", op: "create", id: entity.id, seq: index + 1, updatedAt: ISO, entity,
      })),
      updates: [], moves: [], deletes: [],
    },
    cursor: String(letters.length), hasMore: false, serverTime: ISO,
  } satisfies SyncResponse));
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input), window.location.origin).pathname === "/api/mailboxes") {
      return Response.json({ items: [{
        id: letter.mailboxId, address: "mailbox@fixture.example", status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
        lastSyncAt: ISO, createdAt: ISO, providerConfirms: true,
      }] });
    }
    return fixture(input, init);
  };
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: media === "(pointer: coarse)" && coarse,
    media, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  }));
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
  window.location.hash = "#/screener";
  const host = await mountCloudShell();
  await tick(3000);
  expect(host.querySelector("[data-columns]")?.getAttribute("data-columns")).toBe(width < 700 ? "1" : "2");
  expect(document.documentElement.getAttribute("data-touch")).toBe(coarse ? "1" : "0");
  const shell = within(host);
  const row = within(shell.getByRole("listbox", { name: "Screener" }))
    .getByRole("option", { name: `${name}: ${subject}` });
  return { shell, row };
}

const cardName = "Change this sender's screening";

async function tap(target: Element) {
  await act(() => { fireEvent.click(target); });
}

function expectFullLetter(shell: ReturnType<typeof within>) {
  expect(shell.queryByRole("listbox", { name: "Screener" })).toBeNull();
  expect(shell.getByRole("heading", { name: subject })).toBeTruthy();
  expect(shell.queryByRole("dialog", { name: cardName })).toBeNull();
}

it("a touch on the sender address opens the full held letter", async () => {
  const { shell, row } = await mount();
  // The address is split into spans so the domain stays legible.
  const printed = row.querySelector(".oh-row-address");
  expect(printed?.textContent).toBe(address);
  await tap(printed!);
  expect(shell.getByRole("listbox", { name: "Screener" })).toBeTruthy();
  expect(within(document.body).getByRole("dialog", { name: `Options for ${name}` }).textContent).toContain(address);
});

it("a touch on the sender avatar selects the held letter", async () => {
  const { shell, row } = await mount();
  const avatar = within(row.closest(".oh-row-slot") as HTMLElement).getByRole("button", { name: "Select the message" });
  await tap(avatar);
  expect(shell.getByRole("listbox", { name: "Screener" })).toBeTruthy();
  expect(row.getAttribute("aria-selected")).toBe("true");
  expect(shell.getByRole("button", { name: /^1 selected/ })).toBeTruthy();
  expect(within(document.body).queryByRole("dialog", { name: `Options for ${name}` })).toBeNull();
});

it("pressing the sender in the full held letter opens that sender's screening card", async () => {
  const { shell, row } = await mount();
  await tap(row);
  expectFullLetter(shell);
  const sender = shell.getByRole("button", { name: `${name} ${address}` });
  await tap(sender);
  const card = within(document.body).getByRole("dialog", { name: cardName });
  expect(card.textContent).toContain(address);
});

it("wide, clicking an address selects its row and s opens that sender's screening card", async () => {
  const { shell, row } = await mount({ width: 1440, coarse: false, letters: [other, letter] });
  const printed = row.querySelector(".oh-row-address");
  expect(printed?.textContent).toBe(address);
  await tap(printed!);
  const contact = within(document.body).getByRole("dialog", { name: `Options for ${name}` });
  expect(contact.textContent).toContain(address);
  expect(row.getAttribute("aria-selected")).toBe("false");
  await act(() => { fireEvent.keyDown(contact, { key: "Escape" }); });
  await tap(within(row).getByText(subject));
  expect(row.getAttribute("aria-selected")).toBe("true");
  expect(shell.getByRole("listbox", { name: "Screener" })).toBeTruthy();
  await act(() => { fireEvent.keyDown(row, { key: "s" }); });
  const card = within(document.body).getByRole("dialog", { name: cardName });
  expect(card.textContent).toContain(address);
});

it("narrow with a fine pointer, s opens the selected sender's card over the full letter", async () => {
  const { shell, row } = await mount({ width: 640, coarse: false, letters: [other, letter] });
  await tap(row);
  expectFullLetter(shell);
  await act(() => { fireEvent.keyDown(document.body, { key: "s" }); });
  const card = within(document.body).getByRole("dialog", { name: cardName });
  expect(card.textContent).toContain(address);
  expect(shell.queryByRole("listbox", { name: "Screener" })).toBeNull();
});

it("one mailbox stays unnamed in the phone queue and its full letter", async () => {
  const { shell, row } = await mount();
  expect(row.textContent).not.toMatch(/Delivered to|mailbox@fixture\.example/);
  await tap(row);
  expectFullLetter(shell);
  expect(shell.queryByText(/^Delivered to /)).toBeNull();
  expect(shell.queryByText("mailbox@fixture.example")).toBeNull();
});

it("the short label tells the account's mailboxes apart", () => {
  const short = (facts: MailboxLabelFact[], id: string) => mailboxLabelResolver(facts)(id, "short");
  const a = (id: string, address: string, displayName: string | null = null) => ({ id, address, displayName });
  const MB_A = a("mb-a", "casey@acme.example");
  const MB_B = a("mb-b", "ops@acme.example");
  expect(short([MB_A, MB_B], "mb-b")).toBe("ops");
  expect(short([a("x", "me@home.example"), a("y", "me@work.example")], "y"), "a shared local part names the domain").toBe("work.example");
  expect(short([a("x", "me@home.example", "Home"), a("y", "me@work.example")], "x"), "a label is its own short form").toBe("Home");
  expect(short([a("x", "me@a.example"), a("y", "me@b.example"), a("z", "you@a.example")], "x"), "both halves shared: the address").toBe("me@a.example");
  expect(short([MB_A], "mb-a"), "one mailbox is still silence").toBeNull();
  expect(mailboxLabelResolver([MB_A, MB_B])("mb-a"), "the long form is unchanged").toBe("casey@acme.example");
});
