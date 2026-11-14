import { describe, expect, it } from "vitest";
import {
  LAST_DRAIN_AT_META,
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type EngineMessage,
  type MutationOutcome,
  type RuleDTO,
  type SyncChange,
  type SyncResponse,
  type SyncSnapshotPage,
} from "../src/index.js";

/**
 * ═══ RULES BEFORE MAIL ON THE `since=0` FALLBACK ═══════════════════════════════════════════
 *
 * The reported shape: during a bootstrap, already-screened senders present as UNSCREENED,
 * because the `since=0` replay interleaves by seq — a sender decided AFTER their mail arrived
 * replays as mail-first, and for the whole stretch between those seqs the consent cutline reads
 * the absent rule as "no decision". Unknown is not undecided.
 *
 * The snapshot path already has the ordering (page 1 carries the account's whole rule set —
 * `sync-service.ts`), so the fallback is the one drain that could render a message whose
 * sender's decision had not arrived. The engine now opens that fallback with a `types=rule`
 * drain to the horizon, rows only, before the first mixed page.
 *
 * Every guard below was watched RED against a named mutation, then the implementation restored.
 */

const NOW = new Date("2026-08-24T12:00:00.000Z");

function msg(id: string, seq: number): SyncChange {
  const entity: EngineMessage = {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: "decided@example.test" },
    to: [],
    cc: [],
    date: NOW.toISOString(),
    folder: "INBOX",
    snippet: "snippet",
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: NOW.toISOString(),
  };
  return { type: "message", op: "create", id, seq, updatedAt: NOW.toISOString(), entity };
}

function rule(id: string, seq: number): SyncChange {
  const entity: RuleDTO = {
    id,
    kind: "sender",
    match: "decided@example.test",
    destination: "ohmail/News",
    priority: 0,
    provenance: "promoted",
    enabled: true,
    stats: { hits: 1, lastHitAt: NOW.toISOString(), demotions: 0 },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
  return { type: "rule", op: "create", id, seq, updatedAt: NOW.toISOString(), entity };
}

function page(changes: SyncChange[], cursor: string, hasMore: boolean): SyncResponse {
  return {
    changes: {
      creates: changes.filter((c) => c.op === "create"),
      updates: [],
      moves: [],
      deletes: [],
    },
    cursor,
    hasMore,
    serverTime: NOW.toISOString(),
  };
}

interface Recorder {
  /** Every `{since, types}` pair the delta endpoint was asked for, in order. */
  syncAsks: Array<{ since: string; types: string[] | null }>;
  snapshotCalls: number;
}

/** The rules pass names the rule kind alone; every other ask names the engine's whole list. */
const rulesOnly = (types: string[] | null): boolean => types?.length === 1 && types[0] === "rule";

/**
 * A feed whose seq order is the DEFECT's: the decided sender's mail (seqs 1–2) strictly before
 * the rule that decided them (seq 3). The snapshot route fails page 1, which is the live way
 * onto the `since=0` fallback (`snapshotUnavailable` latches). `?types=rule` is honored the way
 * the real `/sync` honors it — a filtered view of the same log.
 */
function fallbackAdapter(rec: Recorder): EngineAdapter {
  const log: SyncChange[] = [msg("m1", 1), msg("m2", 2), rule("r1", 3)];
  return {
    sync: async (p: { since: string; limit?: number; types?: string[] }): Promise<SyncResponse> => {
      rec.syncAsks.push({ since: p.since, types: p.types ?? null });
      const since = p.since === "0" ? 0 : Number(Buffer.from(p.since, "base64url").toString("utf8"));
      const wanted = p.types ? new Set(p.types) : null;
      const pending = log.filter((c) => c.seq > since && (!wanted || wanted.has(c.type)));
      // One change per page, so the mixed replay has a render boundary between the mail and the
      // rule — the exact window the defect lived in.
      const slice = pending.slice(0, 1);
      const last = slice[slice.length - 1];
      const cursor = last
        ? Buffer.from(String(last.seq), "utf8").toString("base64url")
        : p.since;
      return page(slice, cursor, pending.length > slice.length);
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    snapshot: async (): Promise<SyncSnapshotPage> => {
      rec.snapshotCalls++;
      throw new Error("503 — the snapshot route is having a day");
    },
  } as unknown as EngineAdapter;
}

async function freshStore(): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  return store;
}

describe("the since=0 fallback drains rules before mail", () => {
  /**
   * THE INVARIANT ITSELF, checked at every render the bootstrap produces: no notification may
   * show a message from the decided sender without the rule that decided them.
   *
   * WATCHED RED by deleting the `drainRulesFirst()` call from `drain()`: the first mixed page
   * notifies with m1 present and r1 absent — the Screener's "already screened shown as
   * unscreened" window, reproduced in one assertion.
   */
  it("never notifies a render in which the sender's mail is present and their rule is not", async () => {
    const rec: Recorder = { syncAsks: [], snapshotCalls: 0 };
    const store = await freshStore();
    const engine = new OhmailEngine({ adapter: fallbackAdapter(rec), store, now: () => NOW });

    const violations: string[] = [];
    engine.subscribe(() => {
      const reader = engine.read();
      const mailThere = reader.get("message", "m1") !== undefined || reader.get("message", "m2") !== undefined;
      const ruleThere = reader.get("rule", "r1") !== undefined;
      if (mailThere && !ruleThere) violations.push("mail rendered before its sender's rule");
    });

    await engine.start();

    expect(violations).toEqual([]);
    // The drain converged: everything arrived, and the cursor is the log's horizon.
    expect(store.get("message", "m1")).toBeDefined();
    expect(store.get("message", "m2")).toBeDefined();
    expect(store.get("rule", "r1")).toBeDefined();
  });

  /**
   * THE MECHANISM: the fallback's first ask is `types=["rule"]` from zero, drained to its
   * horizon BEFORE the first mixed page — and the mixed replay still starts at `since=0`, so
   * the rules pass never advanced the cursor of record.
   *
   * WATCHED RED by the same mutation as above: the first ask becomes the mixed `since=0`.
   */
  it("asks for the rule type first, rows only — the cursor of record stays with the mixed replay", async () => {
    const rec: Recorder = { syncAsks: [], snapshotCalls: 0 };
    const store = await freshStore();
    await new OhmailEngine({ adapter: fallbackAdapter(rec), store, now: () => NOW }).start();

    expect(rec.snapshotCalls).toBe(1); // page 1 failed and latched — the way onto this path
    expect(rec.syncAsks[0]).toEqual({ since: "0", types: ["rule"] });
    // The first MIXED ask (every kind named) is still since=0: the rules pass wrote no cursor.
    const firstMixed = rec.syncAsks.find((a) => !rulesOnly(a.types));
    expect(firstMixed?.since).toBe("0");
  });

  /**
   * A healthy snapshot route keeps the bootstrap EXACTLY as it was — the ordering there is the
   * snapshot's own (page 1 carries the whole rule set), and a second rules drain would be a
   * wasted request per cold start.
   *
   * WATCHED RED by making the `drainRulesFirst()` call unconditional: a rules ask appears on the
   * snapshot-served bootstrap (and would on every warm poll). Note that merely dropping the
   * `snapshotUnavailable` conjunct is NOT observable here and is not claimed to be: a snapshot
   * that succeeded has already committed the cursor off "0", so at the call site
   * `cursor === "0" && snapshotFn` already implies the latch — the third conjunct is the
   * STATEMENT of when this path is meant to run, kept because the implication lives two methods
   * away and a future edit to `runSnapshot`'s commit discipline must not silently widen this.
   */
  it("does not run when the snapshot path served the bootstrap", async () => {
    const rec: Recorder = { syncAsks: [], snapshotCalls: 0 };
    const adapter = fallbackAdapter(rec);
    (adapter as unknown as { snapshot: () => Promise<SyncSnapshotPage> }).snapshot = async () => {
      rec.snapshotCalls++;
      return {
        asOfSeq: 3,
        changes: [msg("m1", 3), msg("m2", 3), rule("r1", 3)].map((c) => ({ ...c, op: "create" as const, seq: 3 })),
        nextCursor: null,
        window: { days: 30, minRows: 500 },
      };
    };
    const store = await freshStore();
    await new OhmailEngine({ adapter, store, now: () => NOW }).start();

    expect(rec.syncAsks.every((a) => !rulesOnly(a.types))).toBe(true);
  });

  /**
   * THE RESUMED INTERRUPTED BOOTSTRAP — review round 1's first finding. An earlier session's
   * fallback committed the mail stretch (cursor past the message, no completion stamp) and died
   * before the rule's seq; the resume must open with the rules pass, or the persisted mail
   * renders unscreened for the rest of the replay. The snapshot stays broken — the healthy-route
   * resume is already healed by `freshenStaleResume` applying page 1 (the whole rule set).
   *
   * WATCHED RED by narrowing the gate back to `cursor === "0" && snapshotUnavailable`: the
   * resume's first ask becomes the mixed replay from the committed cursor.
   */
  it("a resumed bootstrap that never completed opens with the rules pass too", async () => {
    const rec: Recorder = { syncAsks: [], snapshotCalls: 0 };
    const store = await freshStore();
    // Last session: the fallback applied the mail stretch and committed its cursor, then died —
    // no LAST_DRAIN_AT_META, cursor past m1/m2, rule r1 (seq 3) never arrived.
    await store.applyResponse({
      changes: { creates: [msg("m1", 1), msg("m2", 2)], updates: [], moves: [], deletes: [] },
      cursor: Buffer.from("2", "utf8").toString("base64url"),
      hasMore: false,
      serverTime: NOW.toISOString(),
    });
    expect(store.getMeta(LAST_DRAIN_AT_META)).toBeUndefined();

    await new OhmailEngine({ adapter: fallbackAdapter(rec), store, now: () => NOW }).syncOnce();

    // The stale-resume freshen tries the snapshot (still broken), then the drain opens with the
    // rules pass BEFORE resuming the mixed replay from the committed cursor.
    const firstDelta = rec.syncAsks[0];
    expect(firstDelta).toEqual({ since: "0", types: ["rule"] });
    expect(store.get("rule", "r1")).toBeDefined();
  });

  /**
   * …AND A MIRROR THAT HAS COMPLETED A DRAIN NEVER PAYS IT. The completion stamp is the whole
   * gate: a warm mirror's steady state is already ordered (a decision writes its rule before its
   * effects), so a rules ask per poll would be a wasted request on every warm mailbox.
   *
   * WATCHED RED by dropping the `LAST_DRAIN_AT_META === undefined` half of `resumedIncomplete`:
   * every warm poll opens with a rules ask.
   */
  it("a warm mirror that completed a drain owes no rules pass", async () => {
    const rec: Recorder = { syncAsks: [], snapshotCalls: 0 };
    const store = await freshStore();
    await store.applyResponse({
      changes: { creates: [msg("m1", 1), msg("m2", 2), rule("r1", 3)], updates: [], moves: [], deletes: [] },
      cursor: Buffer.from("3", "utf8").toString("base64url"),
      hasMore: false,
      serverTime: NOW.toISOString(),
    });
    // A completed drain stamped the mirror, freshly enough that no stale-resume freshen fires.
    await store.setMeta(LAST_DRAIN_AT_META, NOW.toISOString());

    await new OhmailEngine({ adapter: fallbackAdapter(rec), store, now: () => NOW }).syncOnce();

    expect(rec.syncAsks.every((a) => !rulesOnly(a.types)), "a warm poll paid a rules ask").toBe(true);
  });
});
