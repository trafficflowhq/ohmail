/**
 * The desktop window's first drain over a large mailbox (FIX-022). The snapshot walk lands the
 * whole reachable mailbox in the windowed store before the first prune, so the settle evicts tens
 * of thousands of messages at once, and every evicted message drags its thread, state and routing
 * rows behind it. Shipped 0.21.0 spread that cascade into one `push(...)` call, which the engine
 * refuses past its argument ceiling — `syncOnce()` rejected with a `RangeError`
 * after every complete walk, the policy stamp was never written, and the next drain re-walked the
 * tail and died on the same line while the strip read "Sync failed. Retrying." for the whole
 * session. Measured on the Windows guest against the large rig mailbox (2026-09-21).
 */
import type { EngineMessage, MutationOutcome, SyncSnapshotPage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine,
  type EngineAdapter, type SyncChange, type SyncResponse,
} from "../src/index.js";

const NOW = new Date("2026-09-21T08:00:00.000Z");
/** The desktop window's policy, spelled out so this file needs no webapp import. */
const WINDOW = { mode: "windowed", days: 90, minRows: 5000, maxRows: 10000 } as const;
/** The rig mailbox the guest was connected to. */
const MAILBOX_ROWS = 74_003;
const PAGE = 5_000;

function message(i: number): EngineMessage {
  // Every row older than the window's 90 days, newest first: the walk's own order.
  const date = new Date(NOW.getTime() - (120 + i) * 60_000 * 60).toISOString();
  return {
    id: `m${i}`, accountId: "acct", mailboxId: "mb", threadId: `t${i}`, messageIdHeader: null,
    subject: `Subject ${i}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}

/** One message and the three rows an organizer leaves beside it — the cascade's real shape. */
function rowsFor(i: number, seq: number): SyncChange[] {
  const m = message(i);
  return [
    { type: "message", op: "create", id: m.id, seq, updatedAt: m.updatedAt, entity: m },
    { type: "thread", op: "create", id: `t${i}`, seq, updatedAt: m.updatedAt,
      entity: { id: `t${i}`, accountId: "acct", subject: m.subject, messageCount: 1, lastMessageAt: m.date, updatedAt: m.updatedAt } },
    { type: "message_state", op: "create", id: `s${i}`, seq, updatedAt: m.updatedAt,
      entity: { id: `s${i}`, messageId: m.id, state: "none", updatedAt: m.updatedAt } },
    { type: "routing_decision", op: "create", id: `r${i}`, seq, updatedAt: m.updatedAt,
      entity: { id: `r${i}`, messageId: m.id, status: "applied", updatedAt: m.updatedAt } },
  ];
}

function bigMailboxAdapter(rows: number): EngineAdapter & { snapshotPages: number; deltas: number } {
  const asOfSeq = rows;
  const self = {
    snapshotPages: 0,
    deltas: 0,
    sync: async (p: { since: string }): Promise<SyncResponse> => {
      self.deltas += 1;
      return {
        changes: { creates: [], updates: [], deletes: [], moves: [] },
        cursor: p.since, hasMore: false, serverTime: NOW.toISOString(),
      };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    snapshot: async (params: { cursor?: string } = {}): Promise<SyncSnapshotPage> => {
      self.snapshotPages += 1;
      const from = params.cursor === undefined ? 0 : Number(params.cursor);
      const upto = Math.min(from + PAGE, rows);
      const changes: SyncChange[] = [];
      for (let i = from; i < upto; i++) changes.push(...rowsFor(i, asOfSeq));
      return {
        asOfSeq, changes,
        nextCursor: upto < rows ? String(upto) : null,
        window: { days: WINDOW.days, minRows: WINDOW.minRows },
      };
    },
  };
  return self as unknown as EngineAdapter & { snapshotPages: number; deltas: number };
}

describe("a first drain over a mailbox far larger than the window settles", () => {
  it("evicts the mailbox down to the window with its cascade, and the drain resolves", async () => {
    const adapter = bigMailboxAdapter(MAILBOX_ROWS);
    const engine = new OhmailEngine({
      adapter, store: new MemoryMirrorStore(), storePolicy: WINDOW, eagerBodies: true, now: () => NOW,
    });
    await engine.hydrate();

    await engine.syncOnce();

    expect(adapter.snapshotPages, "the walk ran to the end of the mailbox").toBe(Math.ceil(MAILBOX_ROWS / PAGE));
    expect(adapter.deltas, "the delta followed the walk").toBe(1);
    const kept = engine.read().list<EngineMessage>("message").length;
    expect(kept, "the window's ceiling holds after the settle").toBeLessThanOrEqual(WINDOW.maxRows);
    expect(kept, "the prune actually ran — the walk landed far more than this").toBeLessThan(MAILBOX_ROWS);
    // The cascade followed the evicted messages: no thread, state or routing row survives its message.
    const live = new Set(engine.read().list<EngineMessage>("message").map((m) => m.id));
    const orphans = (type: string, of: (e: { messageId?: string; id: string }) => string): number =>
      engine.read().list<{ messageId?: string; id: string }>(type).filter((e) => !live.has(of(e))).length;
    expect(orphans("message_state", (e) => e.messageId ?? "")).toBe(0);
    expect(orphans("routing_decision", (e) => e.messageId ?? "")).toBe(0);
    expect(orphans("thread", (e) => `m${e.id.slice(1)}`)).toBe(0);
  }, 120_000);
});
