import type { EngineMessage, MutationOutcome, SyncSnapshotPage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * THE SNAPSHOT WALK HOLDS THE WINDOW ON THE WAY IN — the bound the delta drain already kept.
 *
 * `runSnapshot` applied every page rows-only and pruned nothing until the settle, so a windowed
 * mirror took in everything a door served before the first eviction: a door serving past the
 * window (the desktop's first walk over a large mailbox landed megabytes of pages) put its
 * whole reach in the mirror at the peak, while the settled size read as the policy. The peak is
 * sampled here at each page boundary, before the page is answered — the last moment the mirror
 * holds what the previous page left it — over the production page shape and window.
 */

const NOW = new Date("2026-09-27T09:00:00.000Z");
const HOUR = 3_600_000;
/** The desktop's and the browser's window, spelled out so this file needs no webapp import. */
const WINDOW = { mode: "windowed", days: 90, minRows: 5000, maxRows: 10000 } as const;
/** The server's page shape: a viewport's worth first, then the default page. */
const FIRST_PAGE = 50;
const PAGE = 500;

function message(i: number): EngineMessage {
  // Newest first, an hour apart: more rows inside ninety days than the ceiling, so the CEILING is what binds.
  const date = new Date(NOW.getTime() - (i + 1) * (HOUR / 12)).toISOString();
  return {
    id: `m${i}`, accountId: "acct", mailboxId: "mb", threadId: `t${i}`, messageIdHeader: null,
    subject: `Subject ${i}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: "", unread: false, hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}

/** A message with the rows that ride its page: its thread and a resting park. */
function rowsFor(i: number, seq: number): SyncChange[] {
  const m = message(i);
  return [
    { type: "message", op: "create", id: m.id, seq, updatedAt: m.updatedAt, entity: m },
    { type: "thread", op: "create", id: `t${i}`, seq, updatedAt: m.updatedAt,
      entity: { id: `t${i}`, accountId: "acct", subject: m.subject, messageCount: 1, lastMessageAt: m.date, updatedAt: m.updatedAt } },
    { type: "message_state", op: "create", id: `s${i}`, seq, updatedAt: m.updatedAt,
      entity: { id: `s${i}`, messageId: m.id, state: "none", updatedAt: m.updatedAt } },
  ];
}

interface Drafts { perPage: number; replyTo: (n: number) => string | null; count: number }

/** A door serving `rows` messages newest first, drafts riding every page until none are left. */
function door(rows: number, opts: { first?: number; page?: number; drafts?: Drafts; onPage?: () => void } = {}) {
  const first = opts.first ?? FIRST_PAGE;
  const size = opts.page ?? PAGE;
  const asOfSeq = rows + 1;
  let draftAt = 0;
  const self = {
    pages: 0,
    sync: async (p: { since: string }): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: p.since, hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    snapshot: async (params: { cursor?: string } = {}): Promise<SyncSnapshotPage> => {
      opts.onPage?.();
      self.pages += 1;
      const from = params.cursor === undefined ? 0 : Number(params.cursor);
      const upto = Math.min(from + (params.cursor === undefined ? first : size), rows);
      const changes: SyncChange[] = [];
      for (let i = from; i < upto; i++) changes.push(...rowsFor(i, asOfSeq));
      const d = opts.drafts;
      if (d) {
        for (let k = 0; k < d.perPage && draftAt < d.count; k++, draftAt++) {
          changes.push({ type: "draft", op: "create", id: `d${draftAt}`, seq: asOfSeq, updatedAt: NOW.toISOString(),
            entity: { id: `d${draftAt}`, status: "draft", inReplyToMessageId: d.replyTo(draftAt), body: "", subject: "" } });
        }
      }
      return {
        asOfSeq, changes,
        nextCursor: upto < rows ? String(upto) : null,
        window: { days: 90, minRows: 5000, maxRows: 10000 },
      };
    },
  };
  return self;
}

async function walk(rows: number, storePolicy: ConstructorParameters<typeof OhmailEngine>[0]["storePolicy"],
  opts: Parameters<typeof door>[1] = {}) {
  const store = new MemoryMirrorStore();
  let peak = 0;
  const sample = (): void => { peak = Math.max(peak, store.entries("message").length); };
  const adapter = door(rows, { ...opts, onPage: sample });
  const engine = new OhmailEngine({ adapter: adapter as unknown as EngineAdapter, store, storePolicy, now: () => NOW });
  await engine.syncOnce();
  sample();
  return { store, peak, settled: store.entries("message").length, pages: adapter.pages };
}

describe("the snapshot walk's peak", () => {
  it("never holds more than the window plus the page in flight, over tens of thousands of messages", async () => {
    // WATCHED RED by removing the per-page prune in `runSnapshot`: the peak holds the whole walk where the window is owed.
    const { peak, settled, pages } = await walk(25_000, WINDOW);
    expect(pages).toBe(1 + Math.ceil((25_000 - FIRST_PAGE) / PAGE));
    expect(peak).toBeLessThanOrEqual(WINDOW.maxRows + PAGE);
    expect(settled).toBe(WINDOW.maxRows);
  }, 120_000);

  it("… while a full policy holds everything the door served, as it must", async () => {
    const { peak, settled } = await walk(25_000, { mode: "full" });
    expect(peak).toBe(25_000);
    expect(settled).toBe(25_000);
  }, 120_000);

  it("a draft arriving pages after the message it answers still finds it", async () => {
    // Small numbers, so the draft pages outlast the page its parent landed on: ten drafts a page
    // for three pages, the last naming message 15, which is past the ceiling from page two on.
    // WATCHED RED by pruning from page one (`draftsIn` forced true): m15 evicted before its pin.
    const small = { mode: "windowed", days: 90, minRows: 5, maxRows: 8 } as const;
    const { store } = await walk(60, small, {
      first: 10, page: 10,
      drafts: { perPage: 10, count: 30, replyTo: (n) => (n === 29 ? "m15" : null) },
    });
    expect(store.get("message", "m15"), "the draft's message was evicted before the draft arrived").toBeDefined();
    // The control: m16 is as old and nothing pins it.
    expect(store.get("message", "m16")).toBeUndefined();
  }, 60_000);
});
