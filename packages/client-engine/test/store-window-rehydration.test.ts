import type { EngineMessage, MutationOutcome, SyncSnapshotPage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  HttpAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  STORE_POLICY_GENERATION,
  STORE_POLICY_GENERATION_META,
  SNAPSHOT_PREFIX_SEQ_META,
  type EngineAdapter,
  type StorePolicy,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ═══ THE RE-HYDRATION A WIDENED RETENTION POLICY OWES A MIRROR IT ALREADY PRUNED ═══════════
 *
 * The pin that keeps tagged mail in a windowed mirror stops the next eviction. It cannot bring
 * back what the previous policy already deleted, and no delta will: the `message_tags` change
 * that made the row worth keeping sits below the mirror's cursor. A desktop mirror hides this —
 * it is in memory and rebuilt every launch — and a browser's, which persists across sessions,
 * carries the loss for ever.
 *
 * MEASURED FIRST on the shipped path, before any of this existed: a warm windowed mirror missing
 * one tagged message, a server still serving it on the snapshot's labeled tail, one drain. The
 * mirror asked snapshot page 1 and stopped there (`freshenStaleResume`), which is the newest mail
 * and not the tail, and the row stayed missing. That measurement is guard 1 below, inverted.
 *
 * Every guard was watched RED against a named mutation, then the implementation was restored.
 */

const NOW = new Date("2026-08-07T12:00:00.000Z");
const DAY = 86_400_000;
function daysAgo(n: number): string { return new Date(NOW.getTime() - n * DAY).toISOString(); }

let seq = 0;
function msg(id: string, date: string, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: "s", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date, ...over,
  };
}
function create(type: string, id: string, entity: unknown): SyncChange {
  return { type, op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity };
}

function adapterOf(): EngineAdapter {
  return {
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "d2FybQ", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  } as unknown as EngineAdapter;
}

/**
 * The server's snapshot as the service actually pages it: page 1 is the newest mail (plus the
 * live small state, which nothing here reads), and the LABELED TAIL comes after the window is
 * satisfied. `phase: "tail"` starts the walk in the tail instead, which is the whole point — the
 * asks are recorded so a guard can say which walk the client took.
 */
function snapshotServer(windowRows: EngineMessage[], tailRows: EngineMessage[]): {
  fn: (p: { cursor?: string; phase?: "tail" }) => Promise<SyncSnapshotPage>;
  asks: Array<{ cursor?: string; phase?: "tail" }>;
} {
  const asks: Array<{ cursor?: string; phase?: "tail" }> = [];
  const page = (rows: EngineMessage[], nextCursor: string | null): SyncSnapshotPage => ({
    asOfSeq: 900,
    changes: rows.map((m) => create("message", m.id, m)),
    nextCursor,
    window: { days: 90, minRows: 5000 },
  });
  return {
    asks,
    fn: async (p) => {
      asks.push(p);
      if (p.phase === "tail") return page(tailRows, null);
      if (p.cursor === undefined) return page(windowRows, "to-the-tail");
      return page(tailRows, null);
    },
  };
}

/** A warm mirror: rows in, a non-zero cursor, and a drain stamp so it is not a stale resume. */
async function warmMirror(rows: EngineMessage[], extra: SyncChange[] = []): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([...rows.map((m) => create("message", m.id, m)), ...extra]);
  await store.applyResponse({
    changes: { creates: [], updates: [], moves: [], deletes: [] },
    cursor: "d2FybQ", hasMore: false, serverTime: NOW.toISOString(),
  });
  await store.setMeta("lastDrainAt", NOW.toISOString());
  return store;
}

const WINDOWED: StorePolicy = { mode: "windowed", days: 90, minRows: 2, maxRows: 10 };

function engineWith(
  store: MemoryMirrorStore,
  snapshot: (p: { cursor?: string; phase?: "tail" }) => Promise<SyncSnapshotPage>,
  storePolicy: StorePolicy = WINDOWED,
): OhmailEngine {
  const adapter = adapterOf();
  (adapter as unknown as { snapshot: unknown }).snapshot = snapshot;
  return new OhmailEngine({ adapter, store, now: () => NOW, storePolicy });
}

function ids(store: MemoryMirrorStore): string[] {
  return store.entries<EngineMessage>("message").map((e) => e.id).sort();
}

const KEPT = [msg("m0", daysAgo(1)), msg("m1", daysAgo(2)), msg("m2", daysAgo(3))];
const TAGGED = msg("old-tagged", daysAgo(400), { labels: ["t1"] });

describe("a windowed mirror that already lost its tagged mail", () => {
  /**
   * THE MEASURED DEFECT, now closed. Before the walk existed this mirror asked snapshot page 1
   * once and stopped; `old-tagged` is on the tail and stayed missing for ever.
   *
   * WATCHED RED by deleting the `await this.rehydrateForPolicy();` call from `drain()`
   * (the row stays missing), and by `if (this.storePolicy.mode !== "windowed") return;` →
   * `if (this.storePolicy.mode === "windowed") return;` (same).
   */
  it("gets it back, once, on the first drain under the new policy", async () => {
    const store = await warmMirror(KEPT);
    const server = snapshotServer(KEPT, [TAGGED]);
    await engineWith(store, server.fn).syncOnce();

    expect(ids(store)).toContain("old-tagged");
    // AND IT STAYS: the row is tagged, so the pin keeps it through the same drain's prune. The
    // walk without the pin would be a fetch and a delete in one pass.
    expect(store.get("message", "old-tagged")).toBeDefined();
  });

  /**
   * IT ASKS FOR THE TAIL AND NOT FOR THE MAILBOX. The ordinary walk reaches the same rows, but
   * only after paging the whole window — which is the mail this mirror already holds. One ask,
   * `phase: "tail"`, bounded by what somebody tagged by hand.
   *
   * WATCHED RED by dropping `phase: "tail"` from the `snapshot({...})` call in
   * `rehydrateForPolicy` (two asks, the first of them the window).
   */
  it("asks for the labeled tail alone", async () => {
    const store = await warmMirror(KEPT);
    const server = snapshotServer(KEPT, [TAGGED]);
    await engineWith(store, server.fn).syncOnce();

    expect(server.asks).toEqual([{ phase: "tail" }]);
  });

  /**
   * ONCE, NOT EVERY DRAIN. The stamp is what ends it; a walk per drain is a request per poll for
   * the life of every mirror in the field.
   *
   * WATCHED RED by deleting the `getMeta(STORE_POLICY_GENERATION_META) === STORE_POLICY_GENERATION`
   * early return from `rehydrateForPolicy` (the second drain asks again).
   */
  it("does not walk again once the mirror is stamped", async () => {
    const store = await warmMirror(KEPT);
    const server = snapshotServer(KEPT, [TAGGED]);
    const engine = engineWith(store, server.fn);
    await engine.syncOnce();
    expect(store.getMeta<number>(STORE_POLICY_GENERATION_META)).toBe(STORE_POLICY_GENERATION);
    await engine.syncOnce();

    expect(server.asks).toHaveLength(1);
  });

  /**
   * A WALK THAT DID NOT FINISH IS NOT STAMPED. The stamp is the only thing that stops the walk,
   * so stamping a failed one loses the mail permanently — the exact failure this whole mechanism
   * exists to end, in a new place.
   *
   * WATCHED RED by deleting `this.policyWalkFailed = true;` from the catch in
   * `rehydrateForPolicy` (the mirror is stamped and never asks again).
   */
  it("is owed the walk again when the tail request fails", async () => {
    const store = await warmMirror(KEPT);
    let attempts = 0;
    const failing = async (): Promise<SyncSnapshotPage> => {
      attempts += 1;
      throw new Error("network");
    };
    const engine = engineWith(store, failing);
    await engine.syncOnce();

    expect(attempts).toBe(1);
    expect(store.getMeta<number>(STORE_POLICY_GENERATION_META)).toBeUndefined();
    // The drain itself still settled — the delta is the source of truth and of error reporting.
    expect(store.getMeta<string>("lastDrainAt")).toBeDefined();
  });

  /**
   * THE WALK IS ROWS ONLY. Two things it must not touch, and both would be silent:
   *
   *  · THE CURSOR. Committing `asOfSeq` would skip every tombstone between the old cursor and the
   *    snapshot's point — deleted mail back in the mirror, permanently.
   *  · {@link SNAPSHOT_PREFIX_SEQ_META}, which names a BOOTSTRAP's abandoned prefix. Claiming it
   *    here would make the next cold start sweep the rows this walk legitimately wrote.
   *
   * WATCHED RED by adding `await this.store.setMeta(SNAPSHOT_PREFIX_SEQ_META, page.asOfSeq);`
   * inside the walk's loop (the marker appears), and by replacing the walk's `applyChanges` with
   * an `applyResponse` carrying `cursor: encodeSeqCursor(page.asOfSeq)` (the cursor moves to the
   * snapshot's point).
   */
  it("moves neither the cursor nor the bootstrap's prefix marker", async () => {
    const store = await warmMirror(KEPT);
    const server = snapshotServer(KEPT, [TAGGED]);
    await engineWith(store, server.fn).syncOnce();

    expect(store.getCursor()).toBe("d2FybQ");
    expect(store.getMeta<number>(SNAPSHOT_PREFIX_SEQ_META)).toBeUndefined();
  });

  /**
   * A COLD MIRROR OWES NOTHING — its bootstrap walks the snapshot to the end, tail included — and
   * a `full` mirror evicted nothing to get back. Both are stamped at the settle without a walk,
   * which is what stops the next drain asking.
   *
   * WATCHED RED by deleting the `getCursor() === "0"` early return (the cold mirror asks for the
   * tail on top of its bootstrap) and, for the `full` arm, by deleting the
   * `storePolicy.mode !== "windowed"` early return (a desktop mirror asks for a tail it cannot
   * be missing).
   */
  /**
   * THE WIRE. `phase` has to reach the query string or the walk asks for the whole snapshot and
   * every guard above still passes — the adapter's own layer, where three capabilities have
   * shipped unforwarded before (`http-adapter-binding.test.ts`).
   *
   * WATCHED RED by deleting `if (params.phase) q.set("phase", params.phase);` from
   * `HttpAdapter.snapshot`.
   */
  it("puts the phase on the wire", async () => {
    const urls: string[] = [];
    const adapter = new HttpAdapter({
      baseUrl: "/api",
      fetch: (url: string) => {
        urls.push(url);
        return Promise.resolve(new Response(
          JSON.stringify({ asOfSeq: 900, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ));
      },
    });

    await adapter.snapshot({ phase: "tail" });
    await adapter.snapshot({ phase: "tail", cursor: "page2" });
    // The ordinary walk is unchanged — no parameter, byte for byte the URL every client sends.
    await adapter.snapshot({});

    expect(urls).toEqual([
      "/api/sync/snapshot?phase=tail",
      "/api/sync/snapshot?cursor=page2&phase=tail",
      "/api/sync/snapshot",
    ]);
  });

  it("asks for nothing on a cold mirror or a full one, and stamps both", async () => {
    const cold = new MemoryMirrorStore();
    await cold.load();
    const coldServer = snapshotServer(KEPT, [TAGGED]);
    await engineWith(cold, coldServer.fn).syncOnce();
    expect(coldServer.asks.some((a) => a.phase === "tail")).toBe(false);
    expect(cold.getMeta<number>(STORE_POLICY_GENERATION_META)).toBe(STORE_POLICY_GENERATION);

    const full = await warmMirror(KEPT);
    const fullServer = snapshotServer(KEPT, [TAGGED]);
    await engineWith(full, fullServer.fn, { mode: "full" }).syncOnce();
    expect(fullServer.asks).toEqual([]);
    expect(full.getMeta<number>(STORE_POLICY_GENERATION_META)).toBe(STORE_POLICY_GENERATION);
  });
});
