/** @vitest-environment jsdom */
import type { EngineMessage, EngineMutation, Folder } from "@ohmail/wire";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryMirrorStore, OhmailEngine, waterlineIdOf, type SyncChange } from "@ohmail/client-engine";
import { mountCheckedStream, STREAM_DATE } from "./stream-check-frame.js";

type Locale = "en" | "de";

const NOW = new Date("2026-08-20T12:00:00.000Z");
/** Descending, one hour apart — index order is display order, newest first. */
const d = (i: number): string =>
  new Date(Date.UTC(2026, 7, 20, 9, 0, 0) - i * 3_600_000).toISOString();

let seq = 0;
function msg(id: string, i: number, unread: boolean, folder: Folder): EngineMessage {
  return {
    id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: id, address: `${id}@example.com` },
    to: [], cc: [], date: d(i), folder, snippet: `snippet ${id}`, unread,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: d(i),
  };
}

/**
 * TWELVE UNREAD ARRIVALS ABOVE THE LINE, THREE UNREAD ROWS BELOW IT.
 *
 * `a0` is the anchor and is READ, because the cut is exclusive and the anchor sits below the
 * line. So: `newCount` 12 (the waterline), and 15 unread over the pile.
 */
async function pileStore(withReceipt = false, stale = false): Promise<MemoryMirrorStore> {
  const rows: EngineMessage[] = [
    ...Array.from({ length: 12 }, (_, i) => msg(`n${i}`, i, true, "ohmail/News")),
    msg("a0", 12, false, "ohmail/News"),
    ...Array.from({ length: 3 }, (_, i) => msg(`o${i}`, 13 + i, true, "ohmail/News")),
  ];
  if (stale) rows.splice(0, rows.length,
    msg("r0", 0, false, "ohmail/News"),
    msg("r1", 1, false, "ohmail/News"),
    msg("r2", 2, false, "ohmail/News"),
  );
  if (withReceipt) rows.push(msg("purchase", 1, true, "ohmail/Receipts"));
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rows.map((m) => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })) as SyncChange[]);
  await store.putLocal("view_meta", waterlineIdOf("reads"), { newestSeenId: stale ? "r2" : "a0", at: stale ? d(2) : d(12) });
  return store;
}

async function mountNews(locale: Locale, withReceipt = false, sent?: EngineMutation[]): Promise<HTMLElement> {
  const store = await pileStore(withReceipt, sent !== undefined);
  const engine = new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: STREAM_DATE,
      }),
      mutate: async (mutation) => {
        sent?.push(mutation);
        return { changes: [], seq: null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
  await engine.start();
  return (await mountCheckedStream(engine, "#/reads", locale)).el;
}

it("the rail's two stream badges read the tooltip that says the same thing", async () => {
  const el = await mountNews("en", true);
  for (const [name, count] of [["News", 12], ["Receipts", 1]] as const) {
    const badge = within(el).getByRole("button", { name: new RegExp(`^${name} ${count}$`) });
    const sentence = `${count} new since you were here`;
    const titles = [...badge.querySelectorAll("[title]"), badge].map((node) => node.getAttribute("title"));
    expect.soft(titles, name).toContain(sentence);
  }
});

function menuIn(el: HTMLElement, locale: Locale) {
  const list = within(within(el).getByRole("region", { name: "News" }));
  const header = within(list.getByRole("banner"));
  fireEvent.click(header.getByRole("button", { name: locale === "en" ? "List" : "Liste" }));
  const label = locale === "en"
    ? /^(Mark all read|Mark all \d+ (unread|messages new))/
    : /^(Alles als gelesen markieren|Alle \d+ ungelesenen)/;
  return { header, markAll: screen.getByRole("menuitem", { name: label }) };
}

describe("the two numbers on one screen have distinct names", () => {
  const EXPECT: Record<Locale, { head: string; unread: string; never: readonly string[] }> = {
    en: {
      head: "12 new since you were here",
      unread: "Mark all 15 unread messages read",
      /* The row's own two mis-readings, and the swap of each number onto the other's word. */
      never: ["12 unread", "3 new", "15 new", "12 new messages", "Nothing new"],
    },
    de: {
      head: "12 neue seit deinem letzten Besuch",
      unread: "Alle 15 ungelesenen Nachrichten als gelesen markieren",
      never: ["12 ungelesen", "3 neue", "15 neue", "Nichts Neues"],
    },
  };

  for (const locale of ["en", "de"] as const) {
    it(`${locale}: the header says which count it is, and the control says the other`, async () => {
      const want = EXPECT[locale];
      const el = await mountNews(locale);
      const { header, markAll } = menuIn(el, locale);
      expect(header.getByText(want.head)).toBeTruthy();
      expect.soft(markAll.getAttribute("aria-label")).toBe(want.unread);

      const text = el.textContent ?? "";
      const aria = Array.from(el.querySelectorAll("[aria-label]"))
        .map((e) => e.getAttribute("aria-label") ?? "").join(" | ");
      for (const forbidden of want.never) {
        expect(`${text} | ${aria}`.includes(forbidden), `the surface says "${forbidden}"`)
          .toBe(false);
      }
    });
  }
});


it("the menu names the arrivals it clears when the pile has no unread mail", async () => {
  const sent: EngineMutation[] = [];
  const el = await mountNews("en", false, sent);
  const { header, markAll } = menuIn(el, "en");
  expect(header.getByText("Nothing new since you were here")).toBeTruthy();
  expect.soft(markAll.getAttribute("aria-label")).toBe(
    "Mark all 2 messages new since you were here as read",
  );
  fireEvent.click(markAll);
  await vi.waitFor(() =>
    expect(sent).toEqual([{ kind: "feed_mark_seen", view: "reads", upToId: "r0", messageIds: [] }]),
  );
});
