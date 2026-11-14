/** @vitest-environment jsdom */
import type { EngineMessage, Folder, RuleEntity as RuleDTO, StayedWhy } from "@ohmail/wire";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import en from "../messages/en.json";
import de from "../messages/de.json";
import {
  ACCOUNT, ISO, installScreeningWeb, mountScreeningWeb, syncScreeningWeb,
  teardownScreeningWeb, tick, warmScreeningWeb,
} from "./fixtures/screening-web.js";
import { clickMounted } from "./fixtures/mounted-sender-sheet.js";

/**
 * THE SPLIT SAYS WHY A ROW STAYED (the paying user's bare "News 1"). Once the rule's pass has
 * finished, each row the lists show elsewhere is named by the server's reason, one line per place
 * and reason, with "Move it too" where the person may overrule it. The counts are the rows the
 * split counts; a row with no reason is not listed; a pass still running asks nothing.
 */
const ADDR = "letters@vendor.example";
const NOW = "2026-10-01T21:00:00.000Z";

function msg(id: string, folder: Folder, date: string): EngineMessage {
  return {
    id, accountId: ACCOUNT, mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `Issue ${id}`,
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

beforeAll(warmScreeningWeb, 30_000);
afterEach(teardownScreeningWeb);

async function render(o: {
  doneAt: string | null; why: Record<string, StayedWhy>; locale?: "en" | "de"; extra?: EngineMessage[];
}) {
  const rows = [
    ...(o.extra ?? []),
    msg("in-1", "INBOX", "2026-09-30T09:00:00.000Z"), msg("in-2", "INBOX", "2026-09-29T09:00:00.000Z"),
    msg("news-a", "ohmail/News", "2026-09-28T09:00:00.000Z"), msg("news-b", "ohmail/News", "2026-09-27T09:00:00.000Z"),
    msg("news-c", "ohmail/News", "2026-09-26T09:00:00.000Z"), msg("rec-a", "ohmail/Receipts", "2026-09-25T09:00:00.000Z"),
  ];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const standing = rule(o.doneAt);
  const stayedFor = vi.fn();
  let seq = rows.length + 1;
  const moves: Array<{ id: string; folder: Folder }> = [];
  installScreeningWeb("#/ohbox/m/in-1", (path, query, method, init) => {
    if (path === "/api/mailboxes") return Response.json({ items: [{
      id: "mb", address: ["fixture", "mailbox.example"].join("@"), status: "connected", organizerRole: "organizer", organizerChecked: true,
      createdAt: ISO, lastSyncAt: ISO, organizeConsentedAt: ISO,
    }] });
    if (path === "/api/sync") return query.get("types") === "rule"
      ? syncScreeningWeb([{ type: "rule", op: "create", id: standing.id, seq: 1, updatedAt: NOW, entity: standing }], 1)
      : syncScreeningWeb(rows.map((row, index) => ({
        type: "message", op: "create", id: row.id, seq: index + 2, updatedAt: NOW, entity: row,
      })), rows.length + 1);
    if (path === "/api/screener/stayed") {
      const ids = query.get("ids")?.split(",") ?? [];
      stayedFor(ids);
      return Response.json({ stayed: ids.flatMap((id) => o.why[id] ? [{ id, why: o.why[id] }] : []) }, {
        headers: { "X-Ohmail-Account": ACCOUNT },
      });
    }
    const move = /^\/api\/messages\/([^/]+)\/move$/.exec(path);
    if (move && method === "POST") {
      const id = move[1]!;
      const row = byId.get(id);
      if (!row) return new Response(null, { status: 404 });
      const { folder } = JSON.parse(String(init?.body)) as { folder: Folder };
      moves.push({ id, folder });
      row.folder = folder;
      return Response.json(row, {
        headers: { "X-Ohmail-Account": ACCOUNT, "X-Sync-Seq": String(++seq) },
      });
    }
    return undefined;
  });
  vi.setSystemTime(new Date(NOW));

  const words = o.locale === "de" ? de : en;
  const frame = within(await mountScreeningWeb(o.locale));
  await tick(4000);
  const reader = within(frame.getByRole("region", { name: words.frame.landmark.reading }));
  await clickMounted(reader.getByRole("button", { name: (name) => name.startsWith(ADDR) }));
  const page = within(document.body);
  const contact = page.getByRole("dialog", { name: words.message.contactAria.replace("{who}", ADDR) });
  await clickMounted(within(contact).getByRole("menuitem", { name: words.screening.action }));
  const el = page.getByRole("dialog", { name: words.screening.aria.replace("{sender}", ADDR) });
  await tick(200);

  const lines = [...el.querySelectorAll(".sm-stayed-line")].map((line) => ({
    text: line.querySelector("span")!.textContent!,
    move: within(line as HTMLElement).queryByRole("button", { name: /^(Move (them|it) too|Auch verschieben)$/ })?.textContent ?? null,
  }));
  return { el, lines, stayedFor, moves };
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
    const line = within(r.el).getByText("2 stay in News: you replied to them.").parentElement!;
    await clickMounted(within(line).getByRole("button", { name: "Move them too" }));
    await tick(1500);
    expect(r.moves).toEqual([{ id: "news-a", folder: "INBOX" }, { id: "news-b", folder: "INBOX" }]);
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
    await clickMounted(within(r.el).getByRole("button", { name: "Move them too" }));
    await tick(1500);
    expect(r.moves).toHaveLength(151);
  });

  it("in German", async () => {
    const r = await render({ doneAt: NOW, why: { "news-a": "replied", "rec-a": "filed-elsewhere" }, locale: "de" });
    expect(r.lines.map((l) => l.text)).toEqual([
      "1 bleibt in News: Du hast darauf geantwortet.", "1 bleibt in Belege: in einem anderen Mailprogramm einsortiert.",
    ]);
    expect(r.lines[0]!.move).toBe("Auch verschieben");
  });
});
