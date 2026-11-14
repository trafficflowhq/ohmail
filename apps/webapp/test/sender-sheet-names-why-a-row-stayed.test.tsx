/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { MemoryMirrorStore, type EngineMessage, type Folder, type RuleDTO, type StayedWhy, type SyncChange } from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { SenderMenu } from "../app/shell/SenderMenu";
import { senderScreening } from "@ohmail/app-logic/press/sender-screening";

/**
 * THE SPLIT SAYS WHY A ROW STAYED (the paying user's bare "News 1"). Once the rule's pass has
 * finished, each row the lists show elsewhere is named by the server's reason, one line per place
 * and reason, with "Move it too" where the person may overrule it. The counts are the rows the
 * split counts; a row with no reason is not listed; a pass still running asks nothing.
 */
const ADDR = "letters@vendor.example";
const NOW = "2026-10-01T21:00:00.000Z";
let seq = 0;

function msg(id: string, folder: Folder, date: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `Issue ${id}`,
    from: { name: null, address: ADDR }, to: [], cc: [], date, folder, snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW,
  };
}
const rule = (doneAt: string | null): RuleDTO => ({
  id: "r-1", kind: "sender", match: ADDR, destination: "INBOX", priority: 0, provenance: "manual", enabled: true,
  stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: NOW, updatedAt: NOW, subjectContains: null, bodyContains: null,
  retro: { requestedAt: NOW, doneAt },
} as RuleDTO);

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

async function render(o: {
  doneAt: string | null; why: Record<string, StayedWhy>; locale?: "en" | "de"; extra?: EngineMessage[];
}) {
  const rows = [
    ...(o.extra ?? []),
    msg("in-1", "INBOX", "2026-09-30T09:00:00.000Z"), msg("in-2", "INBOX", "2026-09-29T09:00:00.000Z"),
    msg("news-a", "ohmail/News", "2026-09-28T09:00:00.000Z"), msg("news-b", "ohmail/News", "2026-09-27T09:00:00.000Z"),
    msg("news-c", "ohmail/News", "2026-09-26T09:00:00.000Z"), msg("rec-a", "ohmail/Receipts", "2026-09-25T09:00:00.000Z"),
  ];
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...rows.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW, entity: m })),
    { type: "rule", op: "create", id: "r-1", seq: ++seq, updatedAt: NOW, entity: rule(o.doneAt) },
  ] as SyncChange[]);
  const sender = senderScreening(store, "in-1")!;
  const stayedFor = vi.fn(async (ids: readonly string[]) =>
    new Map(ids.filter((id) => o.why[id]).map((id) => [id, o.why[id]!] as const)));
  const onMoveToo = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(NextIntlClientProvider, {
      locale: o.locale ?? "en", messages: o.locale === "de" ? de : en,
      children: React.createElement(SenderMenu, {
        state: { messageId: "in-1", x: 0, y: 0 } as never, sender,
        onChoose: () => undefined, onOpenDetail: () => undefined, onClose: () => undefined, stayedFor, onMoveToo,
      }),
    }));
  });
  await act(async () => { await Promise.resolve(); });
  const lines = [...host.querySelectorAll(".sm-stayed-line")].map((l) => ({
    text: l.querySelector("span")!.textContent!, move: l.querySelector("button")?.textContent ?? null,
  }));
  return { el: host, lines, stayedFor, onMoveToo };
}

describe("the sender sheet names why a row stayed", () => {
  it("one line per place and reason, counted as the split counts them", async () => {
    const r = await render({ doneAt: NOW, why: { "news-a": "replied", "news-b": "replied", "news-c": "failed-checks", "rec-a": "filed-elsewhere" } });
    expect(r.stayedFor).toHaveBeenCalledWith(["news-a", "news-b", "news-c", "rec-a"]);
    expect(r.el.querySelector(".sm-now")!.textContent).toBe("6 messages — News 3 · Ohbox 2 · Receipts 1");
    expect(r.lines).toEqual([
      { text: "2 stay in News: you replied to them.", move: "Move them too" },
      { text: "1 stays in News: it failed the sender's sign-in checks.", move: null },
      { text: "1 stays in Receipts: filed in another mail app.", move: "Move it too" },
    ]);
    await act(async () => { (r.el.querySelector(".sm-stayed-move") as HTMLButtonElement).click(); });
    expect(r.onMoveToo).toHaveBeenCalledWith(["news-a", "news-b"], "ohbox");
  });

  it("a row the server names no reason for is not listed", async () => {
    const r = await render({ doneAt: NOW, why: { "news-a": "set-aside" } });
    expect(r.lines).toEqual([{ text: "1 stays in News: you set it aside.", move: "Move it too" }]);
  });

  it("asks nothing while the rule's pass is still running", async () => {
    const r = await render({ doneAt: null, why: { "news-a": "replied" } });
    expect(r.stayedFor).not.toHaveBeenCalled();
    expect(r.lines).toEqual([]);
  });

  it("past the route's 100-id page every row is asked: 151 left in Receipts read 151, and move 151", async () => {
    const extra = Array.from({ length: 150 }, (_, i) =>
      msg(`bulk-${String(i).padStart(3, "0")}`, "ohmail/Receipts", new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString()));
    const why = Object.fromEntries([...extra.map((m) => m.id), "rec-a"].map((id) => [id, "filed-elsewhere" as const]));
    const r = await render({ doneAt: NOW, why, extra });
    expect(r.el.querySelector(".sm-now")!.textContent).toBe("156" + " messages — Receipts 151 · News 3 · Ohbox 2");
    expect(r.lines).toEqual([{ text: "151 stay in Receipts: filed in another mail app.", move: "Move them too" }]);
    await act(async () => { (r.el.querySelector(".sm-stayed-move") as HTMLButtonElement).click(); });
    expect((r.onMoveToo.mock.calls[0]![0] as string[]).length).toBe(151);
  });

  it("in German", async () => {
    const r = await render({ doneAt: NOW, why: { "news-a": "replied", "rec-a": "filed-elsewhere" }, locale: "de" });
    expect(r.lines.map((l) => l.text)).toEqual([
      "1 bleibt in News: Du hast darauf geantwortet.", "1 bleibt in Belege: in einem anderen Mailprogramm einsortiert.",
    ]);
    expect(r.lines[0]!.move).toBe("Auch verschieben");
  });
});
