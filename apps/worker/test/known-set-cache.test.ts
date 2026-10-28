import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DrizzleRepo, type KnownLocator } from "@trafficflow/core/adapters/drizzle-repo";
import {
  KnownSetBudget, KnownSetCache, KNOWN_SET_NEUTRAL, dirtyMethodsOf, estimateWireBytes, watchKnownSet,
} from "../src/known-set.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE CLASSIFICATION IS THE GUARD — every repo method is either neutral or drops the memo
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `known-set.ts` serves `listKnownLocators` from memory for as long as nothing this process wrote
 * could have moved it. What "could have moved it" means is a LIST, and a list is exactly the thing
 * that stops covering the method somebody adds next — which here would mean serving an entry that
 * says a live UID is already known, whose body is then never fetched and whose folder cursor
 * advances past it. Silent and permanent.
 *
 * So the list is inverted (neutral is named, everything else is dirty) and then pinned from both
 * ends here: a neutral entry that no longer exists is caught, and a NEW method is dirty by
 * construction and shows up in the assertion below until somebody classifies it. That is the
 * "name the new consumer" rule applied to a cache.
 */
describe("known-set memo: the classification", () => {
  it("classifies every DrizzleRepo method, and the dirty ones are exactly the writers of the projection", () => {
    /* The projection is `message_instances (folder, uid, uidvalidity)` ⋈ `messages.message_id_header`
       ⋈ the read-state baseline `flag_state.observed_seen ?? !messages.unread`. These seven are the
       methods that write any part of it — the four instance writers (`setPrimaryInstance` is the
       private one `insertMessage` and `updateLocator` funnel through) and the two read-state
       writers. A method appearing here that is not on this list is either a new writer of the
       known-set — in which case dirty is the RIGHT answer and this list needs it — or a method that
       cannot move it, in which case it belongs in KNOWN_SET_NEUTRAL with a reason. Never soften
       this to a superset check: the whole value is that it forces the decision. */
    expect(dirtyMethodsOf(DrizzleRepo.prototype)).toEqual([
      "applyExternalFlag",
      // The folder-op pass's two projection movers (mail 0074): the rename swap re-spells
      // `message_instances.folder` for a whole subtree, and the delete's tombstone chunk
      // removes the swept folder's instance rows outright. Both must drop the memo — a cached
      // known-set naming the OLD path would present renamed UIDs as living where they no
      // longer do. Their narrow siblings (`completeFolderCreate`, `removeFolderRow`, the op
      // reads and stamps) are in KNOWN_SET_NEUTRAL with their reasons.
      "applyFolderRename",
      // The read-state completion (`WorkerRepo.completeFlagState`): `upsertFlagState`'s conditional
      // twin, and DIRTY for its reason — it writes `flag_state.observed_seen`, which the projection
      // coalesces into `KnownLocator.seen`. Its witness decides whether the write lands, never
      // whether the memo may survive it: a completion that missed left the row's observation moved
      // all the same, so a memo kept across it would serve a stale `seen`.
      "completeFlagState",
      "forgetInstanceAt",
      "insertMessage",
      "recordInstance",
      // The legacy News repair (mail 0164): it forgets legacy-named and dead-epoch instances and
      // moves the primary onto the live News copy.
      "repairLegacyNews",
      // A folder the server stated gone: it forgets every instance still spelled there, at any epoch.
      "retireGoneFolder",
      "setPrimaryInstance",
      "tombstoneFolderMessages",
      "updateLocator",
      "upsertFlagState",
    ]);
  });

  it("names no method that does not exist — a rename cannot leave a stale neutral entry", () => {
    const missing = [...KNOWN_SET_NEUTRAL]
      .filter((n) => typeof (DrizzleRepo.prototype as unknown as Record<string, unknown>)[n] !== "function");
    expect(missing).toEqual([]);
  });

  /**
   * THE BACKSTOP'S COLD READ, AS A RULING RATHER THAN AN OMISSION.
   *
   * `reconcile-cron.ts` takes a mailbox for two cycles and gives it back, and it runs precisely
   * when no worker leads. A memo there could save at most one of the two reads, and would buy that
   * by holding a mailbox's known UIDs across the boundary the pass exists to respect. The decision
   * is recorded in a comment at the call site; this is what stops the comment and the code drifting
   * apart, which is the only way a reasoned omission turns into an accident.
   */
  it("the reconcile backstop reads cold — it does not build a memo", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/reconcile-cron.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/NO `knownSet`, AND THAT IS A RULING/);
    expect(src).not.toMatch(/^\s*knownSet:/m);
  });
});

const loc = (folder: string, uid: number, messageId: string | null = null): KnownLocator =>
  ({ folder, uid, uidValidity: "77", messageId, seen: false });

/** A repo stub that counts its reads and answers a fixed set — the whole surface the memo needs. */
function stubRepo(rows: KnownLocator[]) {
  const calls = {
    listKnownLocators: 0, recordInstance: 0, getMailboxFolders: 0, transaction: 0,
    recordExternalOverride: 0,
  };
  const repo = {
    async listKnownLocators(_mailboxId: string): Promise<KnownLocator[]> {
      calls.listKnownLocators++;
      return [...rows];
    },
    async getMailboxFolders(_mailboxId: string): Promise<unknown[]> { calls.getMailboxFolders++; return []; },
    async recordInstance(_id: string, _l: unknown): Promise<void> { calls.recordInstance++; },
    async insertMessage(): Promise<void> { /* dirty */ },
    async updateLocator(): Promise<void> { /* dirty */ },
    async forgetInstanceAt(): Promise<void> { /* dirty */ },
    async upsertFlagState(): Promise<void> { /* dirty */ },
    async applyExternalFlag(): Promise<void> { /* dirty */ },
    async upsertMailboxFolder(): Promise<void> { /* neutral */ },
    async upsertMailboxFolders(): Promise<void> { /* neutral */ },
    async recordAudit(): Promise<void> { /* neutral */ },
    // `null` is what the real one answers for every ordinary adoption — no graduated route
    // filed the message there, so there is nothing to contradict.
    async recordExternalOverride(): Promise<null> { calls.recordExternalOverride++; return null; },
    async transaction<T>(fn: (r: unknown) => Promise<T>): Promise<T> { calls.transaction++; return fn(repo); },
  };
  return { repo, calls };
}

describe("known-set memo: what it serves and what drops it", () => {
  it("reads Postgres once and answers every later cycle from memory", async () => {
    const { repo, calls } = stubRepo([loc("INBOX", 1), loc("INBOX", 2)]);
    const cache = new KnownSetCache("mb-1");
    const watched = watchKnownSet(repo, cache);

    for (let i = 0; i < 5; i++) await watched.listKnownLocators("mb-1");

    expect(calls.listKnownLocators).toBe(1);
    expect(cache.census().rows).toBe(2);
    expect(cache.census().bytesSaved).toBeGreaterThan(0);
  });

  it("answers with the same rows the database would have — byte-identical, not merely the same length", async () => {
    const rows = [loc("INBOX", 1, "<a@x>"), loc("ohmail/Screener", 9, null)];
    const { repo } = stubRepo(rows);
    const cache = new KnownSetCache("mb-1");
    const watched = watchKnownSet(repo, cache);

    const cold = await watched.listKnownLocators("mb-1");
    const warm = await watched.listKnownLocators("mb-1");
    expect(warm).toEqual(cold);
    expect(warm).toEqual(rows);
  });

  it("hands out a COPY — a caller that mutates what it was given cannot poison the next cycle", async () => {
    const { repo } = stubRepo([loc("INBOX", 1)]);
    const cache = new KnownSetCache("mb-1");
    const watched = watchKnownSet(repo, cache);

    (await watched.listKnownLocators("mb-1")).push(loc("INBOX", 999));
    expect(await watched.listKnownLocators("mb-1")).toHaveLength(1);
  });

  /* THE STALENESS GUARD, at the seam. Each of these is a write that moves what the projection
     reports, and the memo must not survive it. Watched red by deleting the `cache.drop(prop)` line
     in `watchKnownSet`: every row here fails with a second read that never happened. */
  it.each(["insertMessage", "recordInstance", "updateLocator", "forgetInstanceAt", "upsertFlagState", "applyExternalFlag"])(
    "%s drops the memo, so the next read goes to Postgres",
    async (method) => {
      const { repo, calls } = stubRepo([loc("INBOX", 1)]);
      const cache = new KnownSetCache("mb-1");
      const watched = watchKnownSet(repo, cache) as unknown as Record<string, () => Promise<void>>;

      await (watched as unknown as { listKnownLocators(id: string): Promise<KnownLocator[]> }).listKnownLocators("mb-1");
      expect(calls.listKnownLocators).toBe(1);
      expect(cache.warm).toBe(true);

      await watched[method]!();
      expect(cache.warm).toBe(false);
      expect(cache.census().droppedBy).toBe(method);

      await (watched as unknown as { listKnownLocators(id: string): Promise<KnownLocator[]> }).listKnownLocators("mb-1");
      expect(calls.listKnownLocators).toBe(2);
    },
  );

  /* THE VALUE-DEPENDENT HALF of `recordInstance`'s classification (WORKER-BACKFILL-LOOP).
     `recordInstance` of a tuple the projection ALREADY HOLDS can only take its upsert's conflict
     arm — a `last_seen_at` touch, guarded by `setWhere` to the same message — so no projected
     column can move and the memo may survive. Measured cost of not knowing this: a production
     mailbox whose Sent folder held byte-twin copies re-asserted an instance every cycle and
     re-read hundreds of KB of locators per visit, for ever. Watched red by deleting the
     `prop === "recordInstance"` branch in `watchKnownSet`. */
  it("recordInstance of a tuple the memo already projects does NOT drop it", async () => {
    const { repo, calls } = stubRepo([loc("INBOX/Sent", 413), loc("INBOX/Sent", 414)]);
    const cache = new KnownSetCache("mb-1");
    const watched = watchKnownSet(repo, cache);

    await watched.listKnownLocators("mb-1");
    await watched.recordInstance("msg-1", { folder: "INBOX/Sent", ref: "77:414" });
    expect(cache.warm).toBe(true);
    await watched.listKnownLocators("mb-1");

    expect(calls.listKnownLocators).toBe(1);
    expect(calls.recordInstance).toBe(1);
  });

  it("recordInstance of a tuple the memo does NOT project still drops it — the insert arm adds a projected row", async () => {
    const { repo, calls } = stubRepo([loc("INBOX/Sent", 413)]);
    const cache = new KnownSetCache("mb-1");
    const watched = watchKnownSet(repo, cache);

    await watched.listKnownLocators("mb-1");
    // Same folder, same epoch, a uid the projection has never seen: the genuine learn.
    await watched.recordInstance("msg-1", { folder: "INBOX/Sent", ref: "77:999" });
    expect(cache.warm).toBe(false);
    expect(cache.census().droppedBy).toBe("recordInstance");

    await watched.listKnownLocators("mb-1");
    expect(calls.listKnownLocators).toBe(2);
  });

  it("recordInstance keep-vs-drop keys on the WHOLE tuple — a matching uid under another epoch or folder drops", async () => {
    const { repo } = stubRepo([loc("INBOX/Sent", 413)]);
    const cache = new KnownSetCache("mb-1");
    const watched = watchKnownSet(repo, cache);

    await watched.listKnownLocators("mb-1");
    await watched.recordInstance("msg-1", { folder: "INBOX/Sent", ref: "88:413" });
    expect(cache.warm, "a different EPOCH is a different physical tuple").toBe(false);

    await watched.listKnownLocators("mb-1");
    await watched.recordInstance("msg-1", { folder: "INBOX", ref: "77:413" });
    expect(cache.warm, "a different FOLDER is a different physical tuple").toBe(false);
  });

  it("a neutral write does NOT drop it — otherwise the memo would be useless, since every cycle writes a cursor", async () => {
    const { repo, calls } = stubRepo([loc("INBOX", 1)]);
    const cache = new KnownSetCache("mb-1");
    const watched = watchKnownSet(repo, cache);

    await watched.listKnownLocators("mb-1");
    await watched.upsertMailboxFolder();
    await watched.recordAudit();
    // `recordExternalOverride` is the ingest path's override predicate, and it is here for the
    // same reason `completeFolderState` is in the registry: it runs on EVERY externally observed
    // move, so a dirty classification would cost a full locator re-read per adoption. It writes
    // learning_signals / graduations / rules and reads messages.from_address — no instance row,
    // neither projected `messages` column. Watched red by removing its KNOWN_SET_NEUTRAL entry.
    await watched.recordExternalOverride();
    await watched.listKnownLocators("mb-1");

    expect(calls.listKnownLocators).toBe(1);
    expect(calls.recordExternalOverride, "the neutral path still CALLS through").toBe(1);
  });

  /* THE ONE THAT MATTERS MOST STRUCTURALLY. Nearly every write in `sync.ts` happens inside
     `fencedIngest`/`fencedGroup`, which hand their callback a repo built over the transaction's own
     connection. A memo that only watched the outer object would be written straight past. */
  it("a write INSIDE a transaction drops it too", async () => {
    const { repo, calls } = stubRepo([loc("INBOX", 1)]);
    const cache = new KnownSetCache("mb-1");
    const watched = watchKnownSet(repo, cache);

    await watched.listKnownLocators("mb-1");
    await watched.transaction(async (tx: { recordInstance(): Promise<void> }) => { await tx.recordInstance(); });

    expect(cache.warm).toBe(false);
    await watched.listKnownLocators("mb-1");
    expect(calls.listKnownLocators).toBe(2);
  });

  /* A ROLLED-BACK WRITE MUST ALSO LEAVE THE MEMO DROPPED, and it does — because the drop happens
     BEFORE the call, not after it. This is the direction that costs a query instead of losing mail:
     a memo kept warm across an aborted transaction would be correct, and a memo kept warm across a
     transaction that COMMITTED would not, and nothing at this seam can tell the two apart. */
  it("a write that then throws still drops it", async () => {
    const { repo, calls } = stubRepo([loc("INBOX", 1)]);
    const cache = new KnownSetCache("mb-1");
    const watched = watchKnownSet(repo, cache);

    await watched.listKnownLocators("mb-1");
    await expect(watched.transaction(async (tx: { recordInstance(): Promise<void> }) => {
      await tx.recordInstance();
      throw new Error("the transaction aborted after the write");
    })).rejects.toThrow("aborted");

    expect(cache.warm).toBe(false);
    await watched.listKnownLocators("mb-1");
    expect(calls.listKnownLocators).toBe(2);
  });

  /* `SyncDeps.repo` is ONE object shared by every mailbox this worker serves. A memo handed to the
     wrong runtime must answer with the database, never with another account's UIDs. */
  it("never answers for a mailbox it does not belong to", async () => {
    const { repo, calls } = stubRepo([loc("INBOX", 1)]);
    const cache = new KnownSetCache("mb-1");
    const watched = watchKnownSet(repo, cache);

    await watched.listKnownLocators("mb-1");
    await watched.listKnownLocators("mb-OTHER");
    await watched.listKnownLocators("mb-OTHER");

    expect(calls.listKnownLocators).toBe(3);
    expect(cache.warm).toBe(true);          // the other mailbox's read did not disturb this memo
  });

  /* A read in pages yields the loop, so a drop or a committed insert can land while it is out.
     The set it returns predates that write: handed back, never kept, never charged. */
  it.each([
    ["a drop", (c: KnownSetCache) => c.drop("leader lock lost")],
    ["an insert", (c: KnownSetCache) => c.noteInserted(loc("INBOX", 3))],
    ["a move", (c: KnownSetCache) => c.noteMoved(loc("INBOX", 1), loc("Archive", 1))],
  ] as const)("%s during a cold read leaves the memo cold and charges nothing", async (_name, write) => {
    const budget = new KnownSetBudget(1 << 20);
    const cache = new KnownSetCache("mb-1", budget);
    let release!: () => void;
    let reads = 0;
    const read = async (): Promise<KnownLocator[]> => {
      reads += 1;
      if (reads === 1) await new Promise<void>((r) => { release = r; });
      return [loc("INBOX", 1), loc("INBOX", 2)];
    };
    const pending = cache.list(read, "mb-1");
    await Promise.resolve();
    write(cache);
    release();
    expect(await pending).toEqual([loc("INBOX", 1), loc("INBOX", 2)]);
    expect(cache.warm).toBe(false);
    expect(budget.chargedBytes).toBe(0);
    expect(cache.census().droppedBy).not.toBeNull();
    await cache.list(read, "mb-1");
    expect(reads).toBe(2);
    expect(cache.warm).toBe(true);
  });

  it("an explicit drop names its reason, which is what reaches the log", () => {
    const cache = new KnownSetCache("mb-1");
    cache.drop("leader lock lost");
    // Nothing was warm, so nothing was lost and nothing is reported.
    expect(cache.census().droppedBy).toBeNull();
  });
});

describe("known-set memo: the wire-bytes estimate", () => {
  it("counts the six projected columns, and a NULL Message-ID costs only its length prefix", () => {
    /* 6 row overhead + 4×6 field prefixes = 30, plus the data. `INBOX` is 5, uid `1` is 1,
       uidvalidity `77` is 2, the two booleans are 1 each. With no Message-ID: 30 + 5 + 1 + 2 + 2 = 40.
       Adding a 5-byte Message-ID adds exactly 5. Spelled out rather than snapshotted, because the
       number's job is to make a before/after comparable and a snapshot would let the formula drift
       while the test stayed green. */
    expect(estimateWireBytes([loc("INBOX", 1)])).toBe(40);
    expect(estimateWireBytes([loc("INBOX", 1, "<a@x>")])).toBe(45);
    expect(estimateWireBytes([])).toBe(0);
  });
});
