import type { EngineDraft, EngineMessage, MutationOutcome, SyncSnapshotPage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  CursorExpiredError,
  encodeSeqCursor,
  LAST_DRAIN_AT_META,
  MemoryMirrorStore,
  OhmailEngine,
  STALE_RESUME_MS,
  type EngineAdapter,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";

/**
 * ═══ STALE-RESUME FRESHNESS — the newest page converges BEFORE the backlog replays ═══════════
 *
 * The delta feed is ascending-seq by contract, so a mirror that resumes hours or days stale
 * replays its backlog OLDEST-FIRST: the change a returning user actually cares about — the mail
 * that arrived while they were away, the triage they did on the other device — is in the LAST
 * page of the drain, behind every page of history before it. Measured on the hosted service
 * (a live account's full-log replay): several pages, a long wall time, and the newest message's
 * create applied at the very end — while `GET /sync/snapshot` page 1 (the newest page
 * of messages, every live thread and all small state) answered within a second.
 *
 * So a drain that starts on a STALE cursor fetches snapshot page 1 first and applies it
 * ROWS-ONLY — never the cursor — then lets the ordinary delta replay run behind it. The seq
 * guard makes the overlay sound: snapshot rows carry `seq === asOfSeq`, so the backlog's stale
 * intermediate states cannot overwrite them, and a row deleted while the client was away is
 * still removed by the delta's tombstone (the snapshot never carries it, so nothing shields the
 * stale copy). The cursor stays where the delta left it, so a crash after the freshness page
 * re-replays the same backlog — duplicates are what the apply contract absorbs.
 *
 * Staleness is the mirror's own record: the engine stamps `lastDrainAt` meta when a drain
 * completes, on the engine's own clock, and compares against the same clock — no server time,
 * no cross-device skew. A missing stamp on a WARM cursor is read as stale, deliberately: that is
 * every mirror written before this shipped, resuming for the first time.
 *
 * Every guard below was watched RED against a named mutation of the implementation, then the
 * implementation was restored.
 */

const t0 = new Date("2026-08-10T12:00:00.000Z");
const AS_OF = 900;

function msg(id: string, subject = `Subject ${id}`): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject,
    from: { name: null, address: "sender@example.test" },
    to: [],
    cc: [],
    date: t0.toISOString(),
    folder: "INBOX",
    snippet: "snippet",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: t0.toISOString(),
  };
}

function change(id: string, seq: number, subject?: string): SyncChange {
  return { type: "message", op: "create", id, seq, updatedAt: t0.toISOString(), entity: msg(id, subject) };
}

function respOf(changes: SyncChange[], cursorSeq: number, hasMore: boolean): SyncResponse {
  return {
    changes: { creates: changes, updates: [], moves: [], deletes: [] },
    cursor: encodeSeqCursor(cursorSeq),
    hasMore,
    serverTime: t0.toISOString(),
  };
}

interface Harness {
  adapter: EngineAdapter;
  /** Interleaved log of every transport call: "snapshot" | "sync:<since>". */
  calls: string[];
  /** What `probe()` returned at the moment each delta page was SERVED. */
  probed: unknown[];
}

/**
 * A stale-resume world: the mirror's cursor sits at `sinceSeq`, the server is at `AS_OF`, the
 * backlog between them pages oldest-first, and snapshot page 1 carries the newest state.
 */
function staleWorld(opts: {
  backlog: SyncResponse[];
  snapshotChanges?: SyncChange[];
  snapshotFails?: number;
  probe?: () => unknown;
  noSnapshot?: boolean;
}): Harness {
  const calls: string[] = [];
  const probed: unknown[] = [];
  let deltaPage = 0;
  let snapshotFailures = opts.snapshotFails ?? 0;

  const base = {
    sync: async (params: { since: string; types?: string[] }): Promise<SyncResponse> => {
      // The bootstrap's rules-first pass (`types=["rule"]`): every store in this file is a warm
      // PRE-STAMP mirror (no LAST_DRAIN_AT_META), which the drain now treats as a resumed
      // incomplete bootstrap and opens with one rules-only ask. These feeds carry no rule
      // changes, so the honest filtered answer is an empty page — routed and unrecorded, because
      // this file's claims are about the freshness/delta sequence, which the pass is not part
      // of (`bootstrap-rules-first.test.ts` owns the pass's own claims).
      if (params.types?.length === 1 && params.types[0] === "rule") {
        return { changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: params.since, hasMore: false, serverTime: t0.toISOString() };
      }
      calls.push(`sync:${params.since}`);
      probed.push(opts.probe?.());
      const page = opts.backlog[deltaPage];
      if (!page) {
        return { changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: params.since, hasMore: false, serverTime: t0.toISOString() };
      }
      deltaPage += 1;
      if (page instanceof Error) throw page;
      return page;
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
  };

  if (opts.noSnapshot) return { adapter: base as unknown as EngineAdapter, calls, probed };

  const snapshot = async (): Promise<SyncSnapshotPage> => {
    calls.push("snapshot");
    if (snapshotFailures > 0) {
      snapshotFailures -= 1;
      throw new Error("snapshot route down");
    }
    return {
      asOfSeq: AS_OF,
      changes: opts.snapshotChanges ?? [],
      nextCursor: null,
      window: { days: 90, minRows: 5000 },
    };
  };
  return { adapter: { ...base, snapshot } as unknown as EngineAdapter, calls, probed };
}

/** A warm store: rows applied, cursor committed — exactly what a returning tab hydrates. */
async function warmStore(cursorSeq: number, rows: SyncChange[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyResponse(respOf(rows, cursorSeq, false));
  return store;
}

/**
 * An engine whose clock the test owns. `{ mode: "full" }` is SAID because this file is not
 * about the window: the engine's absent branch is now a window, and a windowed warm mirror owes
 * `rehydrateForPolicy`'s labeled-tail walk, which would put a second `snapshot` call in the
 * middle of every ordering assertion below and measure a different question.
 */
function engineAt(adapter: EngineAdapter, store: MemoryMirrorStore, clock: { now: Date }): OhmailEngine {
  return new OhmailEngine({ adapter, store, now: () => clock.now, storePolicy: { mode: "full" } });
}

const subjectOf = (store: MemoryMirrorStore, id: string): string | undefined =>
  store.get<EngineMessage>("message", id)?.subject;

describe("a warm mirror resuming STALE", () => {
  /**
   * THE ORDERING GUARD — the one the slice exists for.
   *
   * WATCHED RED by removing the freshness fetch from `drain()` (the pre-fix build): `calls`
   * begins with `sync:…`, no `snapshot` entry exists, and the newest message is absent from the
   * mirror while every backlog page is served.
   */
  it("fetches the newest page BEFORE replaying the backlog, and holds it while the backlog streams", async () => {
    const store = await warmStore(100, [change("old-1", 90)]);
    await store.setMeta(LAST_DRAIN_AT_META, t0.toISOString());
    const clock = { now: new Date(t0.getTime() + STALE_RESUME_MS + 1) };

    const h = staleWorld({
      backlog: [
        respOf([change("backlog-1", 300)], 300, true),
        respOf([change("backlog-2", 600), change("newest", AS_OF, "fresh from the snapshot? no — the delta tail")], AS_OF, false),
      ],
      snapshotChanges: [change("newest", AS_OF, "the mail that arrived while you were away")],
      probe: () => subjectOf(store, "newest"),
    });

    await engineAt(h.adapter, store, clock).syncOnce();

    // The snapshot page came first, then the delta replay from the OLD cursor.
    expect(h.calls[0]).toBe("snapshot");
    expect(h.calls[1]).toBe(`sync:${encodeSeqCursor(100)}`);
    // The newest message was already in the mirror when the FIRST backlog page was served —
    // above-the-fold content does not wait for the tail.
    expect(h.probed[0]).toBe("the mail that arrived while you were away");
    // And the backlog's own replay of that row (same seq) did not clobber the snapshot copy.
    expect(subjectOf(store, "newest")).toBe("the mail that arrived while you were away");
    // Full convergence still happened: backlog rows present, cursor at the delta tail.
    expect(subjectOf(store, "backlog-1")).toBeDefined();
    expect(store.getCursor()).toBe(encodeSeqCursor(AS_OF));
  });

  /**
   * THE CURSOR IS NEVER THE FRESHNESS PAGE'S TO MOVE. A snapshot page carries only live rows;
   * committing `asOfSeq` off it would skip every tombstone in the backlog and the stale mirror
   * would keep ghosts of everything deleted while it was away.
   *
   * WATCHED RED by applying the freshness page through `applyResponse` with
   * `encodeSeqCursor(asOfSeq)` instead of `applyChanges`: the cursor observed by the first delta
   * page is `asOfSeq` and the drain never replays the backlog.
   */
  it("applies the freshness page rows-only — the delta replay still starts at the stale cursor", async () => {
    const store = await warmStore(100, []);
    await store.setMeta(LAST_DRAIN_AT_META, t0.toISOString());
    const clock = { now: new Date(t0.getTime() + STALE_RESUME_MS + 1) };

    const h = staleWorld({
      backlog: [respOf([change("backlog-1", 300)], AS_OF, false)],
      snapshotChanges: [change("newest", AS_OF)],
    });

    await engineAt(h.adapter, store, clock).syncOnce();

    expect(h.calls).toEqual(["snapshot", `sync:${encodeSeqCursor(100)}`]);
  });

  /**
   * A MISSING STAMP ON A WARM CURSOR IS STALE — that is every mirror written before this
   * shipped, resuming for the first time after the deploy. Treating it as fresh would make the
   * fix invisible on exactly the mailboxes that reported the symptom.
   *
   * WATCHED RED by returning early when the stamp is absent: `calls` starts with `sync:…`.
   */
  it("treats a warm mirror with NO stamp as stale (the pre-upgrade mirror)", async () => {
    const store = await warmStore(100, []);
    const clock = { now: t0 };

    const h = staleWorld({
      backlog: [respOf([], 100, false)],
      snapshotChanges: [change("newest", AS_OF)],
    });

    await engineAt(h.adapter, store, clock).syncOnce();

    expect(h.calls[0]).toBe("snapshot");
    expect(subjectOf(store, "newest")).toBeDefined();
  });
});

describe("a warm mirror resuming FRESH", () => {
  /**
   * THE COST GUARD. A healthy visible tab settles a drain every eight seconds; if each of those
   * paid a snapshot page the freshness path would be a full extra read of the live tables per
   * poll, forever, on every open tab.
   *
   * WATCHED RED by dropping the staleness comparison (always freshen): `calls` gains a
   * `snapshot` entry per drain.
   */
  it("pays nothing inside the staleness threshold", async () => {
    const store = await warmStore(100, []);
    await store.setMeta(LAST_DRAIN_AT_META, t0.toISOString());
    const clock = { now: new Date(t0.getTime() + 8_000) }; // one poll later

    const h = staleWorld({
      backlog: [respOf([], 100, false)],
      snapshotChanges: [change("newest", AS_OF)],
    });

    await engineAt(h.adapter, store, clock).syncOnce();

    expect(h.calls).toEqual([`sync:${encodeSeqCursor(100)}`]);
  });

  /**
   * THE STAMP IS THE DRAIN'S LAST WORD. Without it every drain would read as a stale resume and
   * the cost guard above would be meaningless; with it stamped anywhere but completion, a drain
   * that failed mid-backlog would mark the mirror fresh while it is still behind.
   *
   * WATCHED RED by deleting the stamp write in `drain()`: the meta stays undefined after a
   * completed drain, and the second drain here re-fetches the snapshot.
   */
  it("stamps the mirror at drain completion, so the NEXT drain is a fresh resume", async () => {
    const store = await warmStore(100, []);
    const clock = { now: t0 };

    const h = staleWorld({
      backlog: [respOf([], 100, false), respOf([], 100, false)],
      snapshotChanges: [change("newest", AS_OF)],
    });
    const engine = engineAt(h.adapter, store, clock);

    await engine.syncOnce(); // no stamp yet → freshens (the pre-upgrade case above)
    expect(store.getMeta<string>(LAST_DRAIN_AT_META)).toBe(t0.toISOString());

    clock.now = new Date(t0.getTime() + 8_000);
    await engine.syncOnce(); // one poll later → fresh, no second snapshot
    expect(h.calls.filter((c) => c === "snapshot")).toHaveLength(1);
  });

  /* A STAMP IN THE FUTURE IS DUE NOW: the clock stepped back since the last drain, so how long ago
     it was is unknown and the resume freshens. Once: the drain re-stamps on the clock it now reads,
     so the next poll is fresh again however far behind the clock stays. */
  it("treats a stamp the clock has stepped back behind as stale, once", async () => {
    const store = await warmStore(100, []);
    await store.setMeta(LAST_DRAIN_AT_META, new Date(t0.getTime() + 60 * 60_000).toISOString());
    const clock = { now: t0 };

    const h = staleWorld({
      backlog: [respOf([], 100, false), respOf([], 100, false)],
      snapshotChanges: [change("newest", AS_OF)],
    });
    const engine = engineAt(h.adapter, store, clock);

    await engine.syncOnce();
    expect(h.calls[0], "a resume after the clock stepped back read as current").toBe("snapshot");
    expect(store.getMeta<string>(LAST_DRAIN_AT_META)).toBe(t0.toISOString());

    clock.now = new Date(t0.getTime() + 8_000);
    await engine.syncOnce();
    expect(h.calls.filter((c) => c === "snapshot"), "the stepped-back clock freshened every drain").toHaveLength(1);
  });
});

describe("the freshness page failing", () => {
  /**
   * FRESHNESS IS AN OPTIMIZATION; THE DELTA IS THE CONTRACT. A snapshot route that is down must
   * cost the resume nothing but its head start — and it must NOT latch `snapshotUnavailable`,
   * because that latch belongs to the BOOTSTRAP path: a transient failure here would push a
   * later 410 re-bootstrap onto the full `since=0` log replay for the life of the tab.
   *
   * WATCHED RED two ways: rethrowing from the freshness fetch fails the whole drain; latching
   * `snapshotUnavailable = true` there makes the second half of this test see `since=0` with no
   * preceding `snapshot` call after the 410.
   */
  it("is swallowed, and does not disable the bootstrap snapshot a later 410 needs", async () => {
    const store = await warmStore(100, []);
    const clock = { now: t0 };

    const h = staleWorld({
      backlog: [
        new CursorExpiredError("sync cursor is older than the retention horizon") as unknown as SyncResponse,
      ],
      snapshotChanges: [change("newest", AS_OF)],
      snapshotFails: 1, // the freshness fetch fails…
    });
    const engine = engineAt(h.adapter, store, clock);

    await engine.syncOnce();

    // …the drain proceeded to the delta, hit the 410, reset, and the BOOTSTRAP snapshot ran.
    expect(h.calls).toEqual(["snapshot", `sync:${encodeSeqCursor(100)}`, "snapshot", `sync:${encodeSeqCursor(AS_OF)}`]);
    expect(subjectOf(store, "newest")).toBeDefined();
    expect(store.getCursor()).toBe(encodeSeqCursor(AS_OF));
  });
});

describe("adapters without the capability", () => {
  /**
   * WATCHED RED by calling `this.snapshotFn!` unconditionally in the freshness path: the demo's
   * FixturesAdapter-shaped world throws at the first stale resume.
   */
  it("resume without a snapshot route is exactly the old drain", async () => {
    const store = await warmStore(100, []);
    const clock = { now: t0 };

    const h = staleWorld({
      backlog: [respOf([change("backlog-1", 300)], 300, false)],
      noSnapshot: true,
    });

    await engineAt(h.adapter, store, clock).syncOnce();

    expect(h.calls).toEqual([`sync:${encodeSeqCursor(100)}`]);
    expect(subjectOf(store, "backlog-1")).toBeDefined();
  });
});

// ── THE PAGE-1 OVERLAY AND A MIRROR THAT HOLDS MORE DRAFTS THAN PAGE 1 CARRIES ──────────────

/** A draft change carrying its text — what a snapshot page or a delta both send. */
function draftChange(id: string, seq: number, body: string): SyncChange {
  return {
    type: "draft", op: "create", id, seq, updatedAt: t0.toISOString(),
    entity: {
      id, mailboxId: "mb", threadId: null, inReplyToMessageId: null,
      subject: `Draft ${id}`, body, to: [], cc: [], bcc: [], rationale: null,
      status: "draft", createdAt: t0.toISOString(), updatedAt: t0.toISOString(),
    },
  };
}

const draftBody = (store: MemoryMirrorStore, id: string): string | null | undefined =>
  store.get<EngineDraft>("draft", id)?.body;

describe("a warm mirror whose drafts outnumber snapshot page 1", () => {
  /**
   * DRAFTS NOW RIDE THE PAGES, so snapshot page 1 carries the newest of them and not the whole
   * set — and the freshen fetches page 1 ONLY. The overlay must therefore leave every draft it
   * did not carry exactly as it found it: an apply that treated page 1 as the account's complete
   * draft set would empty the rail on every stale resume, and the compose autosave would write
   * that emptiness back. It is an upsert of the rows the page carried, which is why it cannot.
   *
   * WATCHED RED by making the freshen a REPLACE (pruning the store's drafts before applying the
   * page): `d2` and `d3` come back undefined.
   */
  it("keeps the drafts page 1 did not carry, with their text", async () => {
    const store = await warmStore(100, [change("old-1", 90)]);
    await store.applyChanges([
      draftChange("d1", 91, "the first"),
      draftChange("d2", 92, "the second"),
      draftChange("d3", 93, "the third"),
    ]);
    await store.setMeta(LAST_DRAIN_AT_META, t0.toISOString());
    const clock = { now: new Date(t0.getTime() + STALE_RESUME_MS + 1) };

    const h = staleWorld({
      backlog: [],
      // Page 1 of a paged draft set: the newest one, re-sent at the snapshot's own seq.
      snapshotChanges: [change("newest", AS_OF), draftChange("d1", AS_OF, "the first, edited elsewhere")],
    });

    await engineAt(h.adapter, store, clock).syncOnce();

    expect(h.calls[0]).toBe("snapshot");
    // The carried row wins — it is the newer one, at `asOfSeq`.
    expect(draftBody(store, "d1")).toBe("the first, edited elsewhere");
    // …and the two the page did not carry are untouched, not blanked and not removed.
    expect(draftBody(store, "d2")).toBe("the second");
    expect(draftBody(store, "d3")).toBe("the third");
    expect(store.entries<EngineDraft>("draft")).toHaveLength(3);
  });
});
