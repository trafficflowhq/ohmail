/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, act, answerConsentWith, answerStoreWith, answerSyncWith, installShellEnv, mailbox, mountShell,
  teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import messages from "../messages/en.json";

/**
 * A report (2026-09-27): a sent invoice, found by Search and opened, showed its body and
 * no file. This mounts the shipped shell over the live engine and presses the real Search hit and
 * the real History row, so `openMessage` and the view's own open run, and every list is a real
 * `GET /messages/:id/attachments`. The message is the account's own, filed in Sent, plain text,
 * one PDF. The store's half is `packages/services/test/every-file-listed.test.ts`.
 */

vi.mock("pdfjs-dist", () => {
  const page = { getViewport: () => ({ width: 600, height: 800 }), render: () => ({ promise: Promise.resolve(), cancel: () => {} }) };
  return {
    GlobalWorkerOptions: { workerSrc: "" },
    getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => page }), destroy: async () => {} }),
  };
});

const INV = "inv-rechnung-0901";
const ACCOUNT = "walker@example.invalid";
const FAILED = messages.ohbox.toastDownloadAllFailed;

type Part = { id: string; filename: string; contentType: string; sizeBytes: number; inline: boolean; contentId: null; messageId: string };
const pdf = (id: string, filename: string, messageId: string): Part =>
  ({ id, filename, contentType: "application/pdf", sizeBytes: 48_213, inline: false, contentId: null, messageId });

/** The server's list per message, and the ids whose list read is slow (a long conversation's). */
let files: Record<string, Part[]> = {};
let slow = new Map<string, number>();
/** Every list asked, in order; every byte fetch; every file the browser was handed to save. */
let listed: Array<{ id: string }> = [];
let fetched: string[] = [];
let saved: string[] = [];
/** The date the store's search answers the invoice with. */
let searchDate = "2026-07-09T08:00:00.000Z";

const invoice = (date: string) => ({
  id: INV, accountId: "acct_live_1", mailboxId: "mb_1", threadId: `th-${INV}`, messageIdHeader: null,
  subject: "Rechnung September", from: { name: "Walker", address: ACCOUNT },
  to: [{ name: "Kunde", address: "kunde@example.invalid" }], cc: [], date, folder: "Sent",
  snippet: "Anbei die Rechnung.", unread: false, hasAttachments: true, attachmentCount: files[INV]?.length ?? 1,
  sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
});
const inbox = (id: string, n: number, over: Record<string, unknown> = {}) => ({
  type: "message", op: "create", id, seq: n, updatedAt: ISO,
  entity: {
    id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `subject of ${id}`, from: { name: "Colleague", address: "colleague@example.invalid" },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: ISO, ...over,
  },
});
const rule = (n: number) => ({
  type: "rule", op: "create", id: "rule_colleague", seq: n, updatedAt: ISO,
  entity: {
    id: "rule_colleague", kind: "sender", match: "colleague@example.invalid", destination: "INBOX", priority: 0,
    provenance: "seeded-from-sent", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
  },
});
/** A conversation from the decided sender, `n` messages, each with a file: an Ohbox thread to read. */
const conversation = (from: number, to: number, seq0: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => {
    const k = from + i;
    return inbox(`c${k}`, seq0 + i, {
      threadId: "th-long", date: new Date(Date.parse(ISO) - (100 - k) * 60_000).toISOString(),
      hasAttachments: true, attachmentCount: 1,
    });
  });

const page = (creates: unknown[], cursor: string): Response => new Response(JSON.stringify({
  changes: { creates, updates: [], moves: [], deletes: [] }, cursor, hasMore: false, serverTime: ISO,
}), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  answerConsentWith({ foldersEnabledAt: ISO });
  files = { [INV]: [pdf("a-inv-pdf", "Rechnung.pdf", INV)] };
  slow = new Map();
  listed = [];
  fetched = [];
  saved = [];
  searchDate = "2026-07-09T08:00:00.000Z";
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const inner = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const url = String(input);
    const list = /\/messages\/([^/?]+)\/attachments(?:$|\?)/.exec(url);
    if (list) {
      const id = decodeURIComponent(list[1]!);
      listed.push({ id });
      const wait = slow.get(id);
      if (wait !== undefined) await new Promise((r) => setTimeout(r, wait));
      return json({ items: files[id] ?? [] });
    }
    const body = /\/messages\/([^/?]+)\/body/.exec(url);
    if (body && decodeURIComponent(body[1]!) === INV) {
      return json({ text: "Anbei die Rechnung.", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null });
    }
    const bytes = /\/attachments\/([^/?]+)$/.exec(url);
    if (bytes) {
      fetched.push(decodeURIComponent(bytes[1]!));
      return new Response(new Blob(["%PDF-1.4"]), { status: 200, headers: { "content-type": "application/pdf" } });
    }
    if (/\/search\?/.test(url)) {
      const q = new URL(url, "https://harness.invalid").searchParams.get("q") ?? "";
      const items = /rechnung/i.test(q) ? [invoice(searchDate)] : [];
      return json({ items, total: items.length, totalExact: true, ms: 4 });
    }
    return (inner as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
  }) as unknown as typeof globalThis.fetch;
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:harness/1";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  const click = HTMLAnchorElement.prototype.click;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    if (this.download) saved.push(this.download);
    else click.call(this);
  });
});
afterEach(async () => { await teardownShellEnv(); });

const goHash = async (hash: string, settle = 500): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
  await tick(0);
  await tick(settle);
};
const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await tick(300);
};
const listsOf = (id: string): number => listed.filter((l) => l.id === id).length;
const tilesIn = (scope: Element): string[] =>
  [...scope.querySelectorAll(".att-strip .att-name")].map((n) =>
    `${n.querySelector(".att-stem")?.textContent ?? ""}${n.querySelector(".att-ext")?.textContent ?? ""}`);
const reader = (): Element => {
  const el = document.querySelector("[role=dialog].reader");
  expect(el, "the reader is not open").not.toBeNull();
  return el!;
};

async function mount(creates: unknown[]): Promise<void> {
  answerSyncWith(() => page(creates, `c${creates.length}`));
  await mountShell([mailbox({ address: ACCOUNT, lastSyncAt: ISO, id: "mb_1" })]);
  await tick(30_000);
}

/** Search for the invoice and press its hit, the way a person does. */
async function searchAndOpen(settle = 1_000): Promise<void> {
  await goHash("#/search", 50);
  const box = document.querySelector<HTMLInputElement>(".view-search .search-box input");
  expect(box, "no search box").not.toBeNull();
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(box, "Rechnung");
    box!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await tick(1_000);
  const hit = document.querySelector<HTMLButtonElement>(`.view-search .hit-w[data-hit="${INV}"] button.hit-open`);
  expect(hit, "Search does not list the invoice").not.toBeNull();
  await act(async () => { hit!.click(); });
  await tick(settle);
}

/** The tile is drawn, a press fetches the bytes and opens the look, and the look closes. */
async function expectTheInvoiceOpens(scope: Element): Promise<void> {
  expect(tilesIn(scope), "the invoice shows no file").toEqual(["Rechnung.pdf"]);
  const tile = scope.querySelector<HTMLButtonElement>(".att-strip button.att-tile");
  await act(async () => { tile!.click(); });
  await tick(500);
  expect(fetched, "pressing Rechnung.pdf fetched no bytes").toContain("a-inv-pdf");
  expect(document.querySelector(".ap-panel"), "pressing Rechnung.pdf opened no preview").not.toBeNull();
  await key("Escape");
  expect(document.querySelector(".ap-panel"), "the preview did not close").toBeNull();
}

describe("a sent invoice found by Search or History lists its PDF", () => {
  for (const [name, date] of [
    ["inside the mail window", "2026-07-09T08:00:00.000Z"],
    ["older than the account's cutline (History)", "2026-03-02T08:00:00.000Z"],
  ] as const) {
    it(`(a) the mirror holds it, ${name}: Search opens it with its file`, async () => {
      searchDate = date;
      await mount([inbox("o1", 1), rule(2), { type: "message", op: "create", id: INV, seq: 3, updatedAt: ISO, entity: invoice(date) }]);
      expect(listsOf(INV), "the invoice's list was asked before anybody opened it").toBe(0);
      await searchAndOpen();
      expect(listsOf(INV), "the list was not asked exactly once").toBe(1);
      await expectTheInvoiceOpens(reader());
      await key("Escape");
      expect(document.querySelector("[role=dialog].reader"), "the reader did not close").toBeNull();
      const again = document.querySelector<HTMLButtonElement>(`.view-search .hit-w[data-hit="${INV}"] button.hit-open`);
      await act(async () => { again!.click(); });
      await tick(1_000);
      expect(tilesIn(reader()), "a re-open shows no file").toEqual(["Rechnung.pdf"]);
      expect(listsOf(INV), "the close kept the list, or the re-open did not ask").toBe(2);
    }, 60_000);
  }

  it("(b) the mirror does not hold it: the store's hit opens with its file", async () => {
    searchDate = "2026-07-09T08:00:00.000Z";
    await mount([inbox("o1", 1), rule(2)]);
    await searchAndOpen();
    expect(listsOf(INV), "the list was not asked exactly once").toBe(1);
    await expectTheInvoiceOpens(reader());
    await key("Escape");
    expect(document.querySelector("[role=dialog].reader"), "the reader did not close").toBeNull();
    const again = document.querySelector<HTMLButtonElement>(`.view-search .hit-w[data-hit="${INV}"] button.hit-open`);
    await act(async () => { again!.click(); });
    await tick(1_000);
    expect(tilesIn(reader()), "a re-open shows no file").toEqual(["Rechnung.pdf"]);
    expect(listsOf(INV), "the close kept the list, or the re-open did not ask").toBe(2);
  }, 60_000);

  it("(c) the evicted row opened from History lists its file", async () => {
    answerStoreWith([invoice("2026-07-09T08:00:00.000Z")]);
    await mount([inbox("o1", 1), rule(2)]);
    const openRow = async (): Promise<Element> => {
      await goHash("#/history", 1_000);
      const row = document.querySelector<HTMLElement>(`.view-history .row[data-id="${INV}"]`);
      expect(row, "History does not list the invoice").not.toBeNull();
      await act(async () => { row!.click(); });
      await tick(1_000);
      const col = document.querySelector(".view-history .read-col");
      expect(col, "History shows no reading column").not.toBeNull();
      return col!;
    };
    const col = await openRow();
    expect(listsOf(INV), "the list was not asked exactly once").toBe(1);
    await expectTheInvoiceOpens(col);
    await goHash("#/ohbox");
    const again = await openRow();
    expect(tilesIn(again), "a re-open shows no file").toEqual(["Rechnung.pdf"]);
    expect(listsOf(INV), "leaving History kept the list, or the re-open did not ask").toBe(2);
  }, 60_000);
});

describe("Download all saves the list it was pressed over", () => {
  /** A queued conversation sweep: the Ohbox thread grows by eight members with slow lists. */
  async function queueASweep(): Promise<void> {
    const grown = conversation(3, 10, 20);
    for (const m of grown) slow.set(m.id, 2_000);
    answerSyncWith(() => page([...conversation(1, 2, 10), ...grown, inbox("o1", 1), rule(2)], "c-grown"));
    for (let i = 0; i < 40 && !listed.some((l) => l.id === "c10" || l.id === "c3"); i += 1) await tick(250);
    expect(listed.some((l) => slow.has(l.id)), "the grown conversation was never swept").toBe(true);
  }

  it("a Search-opened reader with two files saves both, asks the list once, says nothing failed", async () => {
    files[INV] = [pdf("a-inv-pdf", "Rechnung.pdf", INV), pdf("a-inv-agb", "AGB.pdf", INV)];
    await mount([...conversation(1, 2, 10), inbox("o1", 1), rule(2)]);
    await goHash("#/ohbox/m/c2");
    await searchAndOpen();
    expect(tilesIn(reader()), "the reader shows no files").toEqual(["Rechnung.pdf", "AGB.pdf"]);
    await queueASweep();
    const all = reader().querySelector<HTMLButtonElement>(".att-strip button.att-all");
    expect(all, "no Download all").not.toBeNull();
    await act(async () => { all!.click(); });
    await tick(30_000);
    expect.soft(saved.sort(), "Download all did not save both files").toEqual(["AGB.pdf", "Rechnung.pdf"]);
    expect.soft(document.body.textContent ?? "", "a failure was said").not.toContain(FAILED);
    expect.soft(listsOf(INV), "the press let the list go and asked it again").toBe(1);
  }, 60_000);

  it("the Ohbox reader's own Download all saves both (green at 0.25.2's shape)", async () => {
    files.c2 = [pdf("a-c2-1", "Offerte.pdf", "c2"), pdf("a-c2-2", "Plan.pdf", "c2")];
    await mount([...conversation(1, 2, 10), inbox("o1", 1), rule(2)]);
    await goHash("#/ohbox/m/c2", 2_000);
    await queueASweep();
    /* The letter's files' own Download all, by its name (the reader's catalogue: `attachments.downloadAll`). */
    const all = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .filter((b) => (b.getAttribute("aria-label") ?? (b.textContent ?? "").trim()) === "Download all");
    expect(all, "the Ohbox shows no Download all").toHaveLength(1);
    await act(async () => { all[0]!.click(); });
    await tick(30_000);
    expect.soft(saved.sort()).toEqual(["Offerte.pdf", "Plan.pdf"]);
    expect.soft(document.body.textContent ?? "").not.toContain(FAILED);
    expect.soft(listsOf("c2")).toBe(1);
  }, 60_000);
});

describe("a Search reader's files do not wait for a long Ohbox thread", () => {
  it("the reader's list is asked ahead of a 50-message thread's queued lists", async () => {
    const thread = conversation(1, 50, 10);
    for (const m of thread) slow.set(m.id, 100);
    await mount([...thread, inbox("o1", 1), rule(2)]);
    await goHash("#/ohbox/m/c50", 0);
    await goHash("#/search", 0);
    const box = document.querySelector<HTMLInputElement>(".view-search .search-box input")!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(box, "Rechnung");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick(300);
    const hit = document.querySelector<HTMLButtonElement>(`.view-search .hit-w[data-hit="${INV}"] button.hit-open`);
    expect(hit, "Search does not list the invoice").not.toBeNull();
    const swept = listed.filter((l) => slow.has(l.id)).length;
    expect(swept, "the thread's sweep had finished before the press: nothing measured").toBeLessThan(45);
    const before = listed.length;
    await act(async () => { hit!.click(); });
    for (let i = 0; i < 200 && listsOf(INV) === 0; i += 1) await tick(25);
    // Lists asked after the press and before the reader's: the thread's queue it waited behind.
    const ahead = listed.slice(before).findIndex((l) => l.id === INV);
    expect(ahead, "the invoice's list was never asked").toBeGreaterThanOrEqual(0);
    expect(ahead, "the reader's list waited behind the thread's sweep").toBeLessThanOrEqual(4);
  }, 60_000);
});
