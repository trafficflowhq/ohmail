/** @vitest-environment jsdom */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type EngineMessage,
  type MutationOutcome,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import { MessageRow, StreamCard } from "@ohmail/ui";
import messages from "../messages/en.json";
import { senderHitOf } from "../app/shell/sender-hit";
import { SearchView } from "../app/views/SearchView";
import { KeymapProvider } from "../app/shell/keymap";
import { MessageRecipients } from "../app/shell/MessageRecipients";
import { MessageHeader } from "../app/shell/MessageCard";
import { SenderMenu } from "../app/shell/SenderMenu";
import { senderScreening } from "../app/shell/sender-screening";

/**
 * ═══ THE ADDRESS-CONTROL CENSUS — which surface reaches the address view, and how ═══════════
 *
 * `sender-hit.ts` runs in the capture phase on the whole stage and treats the address on a LIST
 * ROW and on a STREAM CARD as the sender handle that opens the screening popover. The address
 * view claims none of those pixels: on those surfaces the ONLY way in is the popover's own row.
 * Where the hit test answers null, the address itself is the control — a link on the search
 * result row; on the reader's chips, a verb in the popover the chip already opens.
 *
 * The classification is MEASURED, not assumed: each surface is rendered with an address and
 * `senderHitOf` is asked about the address element it rendered. A surface that changes its markup
 * so the hit test flips — a `.addr` class gained or lost, a carrier's data attribute renamed —
 * moves rows in this table and fails it. The door each classification promises is then rendered
 * and asserted too, so a surface cannot be classified "popover" while the popover lacks the row.
 *
 *   surface                   senderHitOf   the way to `#/address/<addr>`
 *   ─────────────────────────────────────────────────────────────────────────────────────────
 *   list row (MessageRow)     non-null      the screening popover's row (SenderMenu)
 *   stream card (StreamCard)  non-null      the screening popover's row (SenderMenu)
 *   search result row         null          the address is a link
 *   reader To/Cc chip         null          a verb in the chip's popover (ContactPopover)
 *   reader From block         null          its own press opens the screening popover
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const NOW = new Date("2026-08-04T09:00:00.000Z");
const ADDRESS = "anna@acme.test";
const SENTENCE = messages.screening.addressOpen;

interface Row { surface: string; senderHitOf: "non-null" | "null"; control: string }
const table: Row[] = [];

let seq = 0;
function msg(over: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Invoice ${over.id}`,
    from: { name: "Anna Berg", address: ADDRESS },
    to: [], cc: [], date: "2026-08-04T08:00:00.000Z", folder: "ohmail/News",
    snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
    ...over,
  };
}

async function mirror(list: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(list.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return store;
}

function baseAdapter(): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
  };
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  window.location.hash = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

afterAll(() => {
  // The table, printed once so the run's output carries the classification beside the verdict.
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(
    ["", "address-control census", ...table.map((r) => `  ${pad(r.surface, 28)}${pad(r.senderHitOf, 10)}${r.control}`), ""].join("\n"),
  );
});

async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(KeymapProvider, { children: node }),
      }),
    );
  });
}

const byText = (sel: string, text: string): HTMLElement | undefined =>
  [...host!.querySelectorAll<HTMLElement>(sel)].find((n) => (n.textContent ?? "").includes(text));

/** The screening popover, rendered over a mirror holding Anna's mail — the door the two popover
 *  surfaces promise. Asserted once here; the surfaces below refer to it. */
async function senderMenuOffersTheRow(): Promise<void> {
  const store = await mirror([msg({ id: "a" })]);
  const sender = senderScreening(store, "a")!;
  await mount(h(SenderMenu, {
    state: { messageId: "a", x: 0, y: 0 }, sender,
    onChoose: () => {}, onOpenDetail: () => {}, onClose: () => {},
  }));
  const link = byText("a.sm-detail", SENTENCE);
  expect(link, "the screening popover offers the address view as a row").toBeTruthy();
  expect(link!.getAttribute("href")).toBe(`#/address/${encodeURIComponent(ADDRESS)}`);
}

describe("each surface's address, classified by the hit test it is actually under", () => {
  it("list row — the address is the sender handle; the way in is the popover's row", async () => {
    await mount(h("div", { className: "view" },
      h(MessageRow, { id: "a", from: "Anna Berg", address: ADDRESS, subject: "Invoice" })));
    const addr = host!.querySelector(".row .addr");
    expect(addr, "the row rendered its address").not.toBeNull();
    const hit = senderHitOf(addr);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe("a");
    // No address link of the view's own is laid over the handle.
    expect(host!.querySelector('a[href^="#/address/"]')).toBeNull();
    table.push({ surface: "list row (MessageRow)", senderHitOf: "non-null", control: "SenderMenu row" });
    await act(async () => { root!.unmount(); });
    root = createRoot(host!);
    await senderMenuOffersTheRow();
  });

  it("stream card — the address is the sender handle; the way in is the popover's row", async () => {
    await mount(h(StreamCard, {
      id: "a", from: "Anna Berg", address: ADDRESS, time: "09:00", subject: "Invoice", body: "…",
      expandLabel: "expand", collapseLabel: "collapse",
    }));
    const addr = host!.querySelector(".scast .addr");
    expect(addr, "the card rendered its address").not.toBeNull();
    const hit = senderHitOf(addr);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe("a");
    expect(host!.querySelector('a[href^="#/address/"]')).toBeNull();
    table.push({ surface: "stream card (StreamCard)", senderHitOf: "non-null", control: "SenderMenu row" });
  });

  it("search result row — the hit test answers null; the address itself is the link", async () => {
    const store = await mirror([msg({ id: "a" })]);
    const engine = new OhmailEngine({ adapter: baseAdapter(), store, now: () => NOW });
    await mount(h(SearchView, {
      engine, version: 1, now: NOW, query: "invoice", onQuery: () => {}, onOpen: () => {},
    }));
    const addr = host!.querySelector<HTMLAnchorElement>(".hit .hit-addr");
    expect(addr, "the result row rendered its address").not.toBeNull();
    expect(senderHitOf(addr)).toBeNull();
    expect(addr!.tagName).toBe("A");
    expect(addr!.getAttribute("href")).toBe(`#/address/${encodeURIComponent(ADDRESS)}`);
    table.push({ surface: "search result row", senderHitOf: "null", control: "address is a link" });
  });

  it("reader To/Cc chip — the hit test answers null; the chip's own popover carries the verb", async () => {
    const m = msg({ id: "a", from: { name: "Someone", address: "someone@else.test" },
      to: [{ name: "Anna Berg", address: ADDRESS }] });
    await mount(h(MessageRecipients, { message: m }));
    const chip = host!.querySelector<HTMLButtonElement>(".rcpt-chip");
    expect(chip, "the chip rendered").not.toBeNull();
    expect(chip!.title).toBe(ADDRESS);
    expect(senderHitOf(chip)).toBeNull();
    // The chip is a control already — it opens the contact popover — so the view is a verb in it.
    expect(host!.querySelector('a[href^="#/address/"]')).toBeNull();
    await act(async () => { chip!.click(); });
    const verb = byText('.cpop [role="menuitem"]', SENTENCE);
    expect(verb, "the chip's popover offers the address view").toBeTruthy();
    table.push({ surface: "reader To/Cc chip", senderHitOf: "null", control: "ContactPopover verb" });
  });

  it("reader From block — the hit test answers null; its own press opens the screening popover", async () => {
    await mount(h(MessageHeader, { message: msg({ id: "a" }), now: NOW }));
    const sender = host!.querySelector<HTMLButtonElement>(".msg-sender");
    expect(sender, "the header rendered its sender block").not.toBeNull();
    expect(sender!.textContent).toContain(ADDRESS);
    expect(senderHitOf(sender)).toBeNull();
    // A button with its own handler (`chrome.openSenderMenu`), so the popover's row is its door
    // and no link is laid over it.
    expect(sender!.tagName).toBe("BUTTON");
    expect(host!.querySelector('a[href^="#/address/"]')).toBeNull();
    table.push({ surface: "reader From block", senderHitOf: "null", control: "SenderMenu row (own press)" });
  });

  it("the table is exactly the five surfaces, classified as the header states", () => {
    expect(table).toEqual([
      { surface: "list row (MessageRow)", senderHitOf: "non-null", control: "SenderMenu row" },
      { surface: "stream card (StreamCard)", senderHitOf: "non-null", control: "SenderMenu row" },
      { surface: "search result row", senderHitOf: "null", control: "address is a link" },
      { surface: "reader To/Cc chip", senderHitOf: "null", control: "ContactPopover verb" },
      { surface: "reader From block", senderHitOf: "null", control: "SenderMenu row (own press)" },
    ]);
  });
});
