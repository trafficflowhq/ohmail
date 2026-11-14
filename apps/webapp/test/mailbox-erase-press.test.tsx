/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import type { MailboxDTO, MailboxErasure } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * REMOVE AND ERASE OHMAIL'S COPY — the pane's half of the per-mailbox erase.
 *
 * The removal's confirmation offers a second arm beside the one that keeps the copy (still the
 * default): the address is TYPED, never filled in; the same step-up gates it; the door is
 * `mailboxes.erase(id, typed)`; its 202 is held while the row counts down, and the receipt is said
 * when the row leaves the list. A mistyped address is the SERVER's refusal, said at the
 * confirmation. The wire itself is `mailbox-erase-wire.test.ts`; the sweep is the worker's.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const copy = messages.mailboxes as unknown as Record<string, string>;
const copyDe = (de as unknown as { mailboxes: Record<string, string> }).mailboxes;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET = { mailboxes: null, mirrored: 0, freshness: { state: "unknown", asOf: null } } as unknown as MailState;
const A = "keeps-its-name@example.test";
const B = "the-other-one@example.test";

let mockListed: MailboxDTO[] = [];
let mockEraseCalls: Array<[string, string]> = [];
let mockRemoveCalls: string[] = [];
let mockEraseAnswer: () => Promise<MailboxErasure> = async () => { throw new Error("unset"); };
/** The removal's first press meets a closed step-up window when this is set. */
let mockRemoveWindowClosed = false;

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    assertPasskey: async () => ({}),
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({
        user: { email: "person@example.test", emailVerified: true, twofaEnrolled: { webauthn: false, totp: true } },
        scope: "full",
      }),
      stepUpTotp: async () => { mockRemoveWindowClosed = false; return { ok: true }; },
    },
    account: { access: async () => ({ metered: false }) },
    mailboxes: {
      list: async () => ({ items: mockListed }),
      resync: async () => undefined,
      remove: async (id: string) => {
        if (mockRemoveWindowClosed) throw new actual.ApiError(403, "step_up_required", "recent two-factor authentication required");
        mockRemoveCalls.push(id);
      },
      erase: async (id: string, confirm: string) => {
        mockEraseCalls.push([id, confirm]);
        return mockEraseAnswer();
      },
    },
  };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

const row = (over: Partial<MailboxDTO>): MailboxDTO => ({
  provider: "icloud", displayName: null, status: "connected",
  lastSyncAt: "2026-09-20T11:00:00.000Z", createdAt: "2026-09-01T10:00:00.000Z", ...over,
} as MailboxDTO);
const mbA = (over: Partial<MailboxDTO> = {}) => row({ id: "mbA", address: A, messageCount: 3000, ...over });
const mbB = (over: Partial<MailboxDTO> = {}) => row({ id: "mbB", address: B, messageCount: 500, ...over });

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); });
}

async function mount(): Promise<HTMLDivElement> {
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, children: h(MailboxSection) }));
  });
  await settle();
  return host;
}

function buttonIn(el: Element, text: string): HTMLButtonElement {
  const hits = [...el.querySelectorAll("button")].filter((n) => (n.textContent ?? "").trim() === text);
  expect(hits.length, `"${text}" matched ${hits.length} buttons, not one`).toBe(1);
  return hits[0] as HTMLButtonElement;
}
const rowOf = (el: Element, address: string): Element | undefined =>
  [...el.querySelectorAll(".mbx-row")].find((r) => r.querySelector(".mbx-addr")?.textContent === address);

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}
async function typeInto(el: Element | null, value: string): Promise<void> {
  expect(el, "a field the walk needs is not on screen").toBeTruthy();
  const input = el as HTMLInputElement;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
}
async function submit(form: Element | null): Promise<void> {
  expect(form, "a form the walk needs is not on screen").toBeTruthy();
  await act(async () => { form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}

/** Open A's removal, choose the erase arm, type `typed`, and press it (a fresh step-up window). */
async function eraseWalk(el: HTMLDivElement, typed: string): Promise<void> {
  await click(buttonIn(rowOf(el, A)!, copy.remove!));
  await click(el.querySelector("#mb-remove-erase")!);
  await typeInto(el.querySelector("#mb-erase-confirm"), typed);
  await click(buttonIn(el, copy.removeEraseConfirm!));
}

beforeEach(() => {
  mockListed = [mbA(), mbB()];
  mockRemoveWindowClosed = false;
  mockEraseCalls = [];
  mockRemoveCalls = [];
  mockEraseAnswer = async () => { throw new Error("unset"); };
});
afterEach(async () => {
  vi.useRealTimers();
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
});

describe("the confirmation offers the erase, and the removal that keeps the copy stays the default", () => {
  it("keep is chosen on arrival, and the address field appears EMPTY only when erase is chosen", async () => {
    const el = await mount();
    await click(buttonIn(rowOf(el, A)!, copy.remove!));
    expect((el.querySelector("#mb-remove-keep") as HTMLInputElement).checked).toBe(true);
    expect(el.querySelector("#mb-erase-confirm"), "the address is asked before erase is chosen").toBeNull();
    const said = () => el.querySelector('[role="alertdialog"]')!.textContent ?? "";
    expect(said()).toContain(copy.removeCopyStays);
    expect(said()).toContain(copy.removeEraseWhat);

    await click(el.querySelector("#mb-remove-erase")!);
    const field = el.querySelector("#mb-erase-confirm") as HTMLInputElement;
    expect(field.value, "the pane filled in the address it asks the person to type").toBe("");
    expect(said()).toContain(copy.removeCopyErased);
    expect(said()).not.toContain(copy.removeCopyStays);
    expect(buttonIn(el, copy.removeEraseConfirm!).disabled, "an empty address may not proceed").toBe(true);
  });

  it("POSITIVE CONTROL: the default removal calls the keep door and never the erase", async () => {
    mockRemoveWindowClosed = true;
    const el = await mount();
    await click(buttonIn(rowOf(el, A)!, copy.remove!));
    await click(buttonIn(el, copy.removeConfirm!));
    // A closed window: the prompt names the act its factor authorises, then runs it.
    expect(el.textContent).toContain(copy.factorBodyRemove);
    await typeInto(el.querySelector("#stepup-code"), "123456");
    await submit(el.querySelector("#stepup-code")!.closest("form"));
    expect(mockRemoveCalls).toEqual(["mbA"]);
    expect(mockEraseCalls).toEqual([]);
  });
});

describe("the erase press", () => {
  it("sends the address as typed, counts down, and says the receipt when the row leaves", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    mockEraseAnswer = async () => {
      mockListed = [mbA({ status: "disabled", erasure: { remaining: 1000 } }), mbB()];
      return { erasing: true, mailboxId: "mbA", messages: 3000, drafts: 1, draftsUnanchored: 0, retained: "" };
    };
    const el = await mount();
    await eraseWalk(el, ` ${A.toUpperCase()} `);

    expect(mockEraseCalls, "the door was not given the typed address").toEqual([["mbA", ` ${A.toUpperCase()} `]]);
    expect(mockRemoveCalls).toEqual([]);
    const erasingRow = rowOf(el, A)!;
    expect(erasingRow.textContent).toContain("Erasing ohmail's copy — 1,000" + " messages left");
    expect(erasingRow.textContent, "a carried count sat beside the countdown").not.toContain("3,000" + " messages");
    expect(rowOf(el, B)!.textContent, "the other mailbox's row changed").toContain("500" + " messages");

    // The pass finishes: the next poll no longer lists the row.
    mockListed = [mbB()];
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await settle();
    expect(rowOf(el, A), "the erased mailbox is still listed").toBeUndefined();
    expect(el.textContent).toContain(`${A} is removed, and ohmail's copy of its mail is erased: ${"3,000"} messages and 1 draft.`);
    expect(rowOf(el, B)!.textContent).toContain("500" + " messages");
  });

  it("a mistyped address is the server's refusal, said at the confirmation and not the list", async () => {
    const { ApiError } = await import("../app/api-client");
    mockEraseAnswer = async () => {
      throw new ApiError(400, "erase_not_confirmed", "confirm the erasure by repeating this mailbox's address");
    };
    const el = await mount();
    await eraseWalk(el, "not-this-one@example.test");

    expect(mockEraseCalls).toEqual([["mbA", "not-this-one@example.test"]]);
    expect(el.querySelector('[role="alertdialog"]'), "the refusal left the confirmation").toBeTruthy();
    expect(el.textContent).toContain(copy.removeEraseMismatch);
    expect((el.querySelector("#mb-erase-confirm") as HTMLInputElement).value).toBe("not-this-one@example.test");
    expect([...el.querySelectorAll("button")].some((b) => b.textContent?.trim() === copy.connect),
      "the refusal painted the list").toBe(false);
  });
});

describe("the copy is a claim, in both catalogues", () => {
  const keys = [
    "removeKeepChoice", "removeEraseChoice", "removeEraseWhat", "removeCopyErased", "removeEraseTypeLabel",
    "removeEraseConfirm", "removeEraseWorking", "removeEraseMismatch", "removeErased",
    "removeErasedUnanchored", "factorBodyErase", "listBehind", "erasingLeft",
  ];
  it("every key is translated, and every erase sentence says it is ohmail's copy", () => {
    for (const k of keys) {
      expect(copy[k], `en is missing mailboxes.${k}`).toBeTruthy();
      expect(copyDe[k], `de is missing mailboxes.${k}`).toBeTruthy();
      expect(copyDe[k], `de.${k} was left in English`).not.toBe(copy[k]);
    }
    for (const k of ["removeEraseChoice", "removeEraseWhat", "removeCopyErased", "removeErased", "erasingLeft"]) {
      expect(copy[k], `${k} does not say whose copy goes`).toMatch(/ohmail's copy/);
    }
    expect(copy.removeEraseWhat).toMatch(/your own mail server/);
    expect(copyDe.removeEraseWhat).toMatch(/Mailserver/);
  });

  it("the sentences that say ohmail never erases mail stay true: they are about the mail server", () => {
    const en = messages as unknown as Record<string, Record<string, string>>;
    const never = [en.rail?.folderErrNoTrash, en.ohbox?.deleteNote, en.trash?.noErase]
      .filter((v): v is string => typeof v === "string");
    expect(never.length, "a cited sentence moved — this reads it by key").toBe(3);
    for (const line of never) expect(line).toMatch(/ohmail never erases mail/);
    // The new sentences never claim to erase MAIL: every erase names the copy.
    for (const k of keys) expect(copy[k]).not.toMatch(/erases? (your|the) mail\b/i);
  });
});
