import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  mailboxes, messages, folderState, messageStates, changeLog, accountSyncState, threads,
  recordChange, type EntityType,
} from "@trafficflow/db";
import { SyncService, type ServiceContext, type SyncResponse } from "../src/index.js";
import { ServiceError } from "../src/index.js";
import { ClientMirror, flatten } from "./_apply-harness.js";

const svc = new SyncService();

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "a@x.example" }).returning();
  const ctx: ServiceContext = {
    db, accountId, userId: null,
    now: () => new Date("2026-07-27T00:00:00.000Z"), requestId: "r",
  };
  return { db, accountId, mailboxId: mb.id, ctx };
}

async function addMessage(
  db: Db, accountId: string, mailboxId: string,
  opts: { folder?: string; subject?: string; from?: string } = {},
): Promise<string> {
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, bodyHash: "h", dedupKey: randomUUID(),
    subject: opts.subject ?? "s", fromAddress: opts.from ?? "f@x.example",
  }).returning();
  await db.insert(folderState).values({
    messageId: m.id, accountId: m.accountId, desiredFolder: opts.folder ?? "INBOX", observedFolder: opts.folder ?? "INBOX", lastSetBy: "us",
  });
  return m.id;
}

/**
 * IN A TRANSACTION, because `recordChange` now requires one and production always had one.
 *
 * This fixture passed the top-level handle, which is the exact mistake the seq allocator was
 * retyped to `LedgerTx` to make uncompilable: on an autocommit handle the allocating UPDATE
 * commits and releases the counter row lock BEFORE the log row is inserted, so seq N+1 can be
 * visible while N is still unwritten and a polling client advances past it for ever. Test files
 * in this package are not typechecked (`tsconfig` includes `src` only), so the TYPE did not catch
 * this one — `assertLedgerTx` inside `allocateSeqRange` did, which is why that runtime layer
 * exists at all.
 */
const rec = (db: Db, accountId: string, entityType: EntityType, entityId: string,
  op: "create" | "update" | "move" | "delete", meta?: { from: string | null; to: string }) =>
  db.transaction((tx) => recordChange(tx as never, { accountId, entityType, entityId, op, meta }));

function snapshotObj(mirror: ClientMirror): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of [...mirror.snapshot().entries()].sort(([a], [b]) => a.localeCompare(b))) out[k] = v;
  return out;
}

describe("SyncService.getChanges — bootstrap vs tail", () => {
  it("bootstrap returns all changes as creates; tail returns only what is newer", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const ids = [] as string[];
    for (let i = 0; i < 3; i++) {
      const id = await addMessage(db, accountId, mailboxId);
      await rec(db, accountId, "message", id, "create");
      ids.push(id);
    }

    const boot = await svc.getChanges(ctx, {});
    expect(boot.changes.creates.map((c) => c.id)).toEqual(ids);
    expect(boot.hasMore).toBe(false);
    expect(svc.decodeCursor(boot.cursor).seq).toBe(3n);

    // Tail with the bootstrap cursor → nothing new, cursor unchanged.
    const tail0 = await svc.getChanges(ctx, { since: boot.cursor });
    expect(flatten(tail0)).toHaveLength(0);
    expect(svc.decodeCursor(tail0.cursor).seq).toBe(3n);

    // A new change is picked up by the tail.
    const id4 = await addMessage(db, accountId, mailboxId);
    await rec(db, accountId, "message", id4, "create");
    const tail1 = await svc.getChanges(ctx, { since: boot.cursor });
    expect(tail1.changes.creates.map((c) => c.id)).toEqual([id4]);
    expect(svc.decodeCursor(tail1.cursor).seq).toBe(4n);
  });
});

describe("SyncService.getChanges — four-bucket partition + ascending seq", () => {
  it("partitions one ordered stream into creates/updates/moves/deletes, seq-ascending", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const a = await addMessage(db, accountId, mailboxId, { folder: "INBOX" });
    await rec(db, accountId, "message", a, "create");                    // seq 1
    await rec(db, accountId, "message", a, "update");                    // seq 2
    // A real move flips the desired folder, then records the move delta.
    await db.update(folderState).set({ desiredFolder: "ohmail/News" }).where(eq(folderState.messageId, a));
    await rec(db, accountId, "message", a, "move", { from: "INBOX", to: "ohmail/News" }); // seq 3
    const b = await addMessage(db, accountId, mailboxId);
    await rec(db, accountId, "message", b, "create");                    // seq 4
    await rec(db, accountId, "message", b, "delete");                    // seq 5 (explicit delete)

    const resp = await svc.getChanges(ctx, {});
    expect(resp.changes.creates.map((c) => c.id)).toEqual([a, b]);
    expect(resp.changes.updates.map((c) => c.seq)).toEqual([2]);
    expect(resp.changes.moves.map((c) => c.seq)).toEqual([3]);
    expect(resp.changes.deletes.map((c) => c.seq)).toEqual([5]);

    // The move carries {from,to} and re-materializes the CURRENT folder.
    const mv = resp.changes.moves[0]!;
    expect(mv.move).toEqual({ from: "INBOX", to: "ohmail/News" });
    expect((mv.entity as { folder: string }).folder).toBe("ohmail/News");

    // Delete tombstone carries no entity.
    expect(resp.changes.deletes[0]!.entity).toBeUndefined();

    // The true apply order is ascending seq across all buckets combined.
    const seqs = flatten(resp).map((c) => c.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs.sort((x, y) => x - y));
    expect(flatten(resp).map((c) => c.seq).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("SyncService.getChanges — hasMore paging drains", () => {
  it("returns capped pages with hasMore, and draining yields every change exactly once", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const ids = [] as string[];
    for (let i = 0; i < 5; i++) {
      const id = await addMessage(db, accountId, mailboxId);
      await rec(db, accountId, "message", id, "create");
      ids.push(id);
    }

    const drained: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page: SyncResponse = await svc.getChanges(ctx, { since: cursor, limit: 2 });
      drained.push(...page.changes.creates.map((c) => c.id));
      cursor = page.cursor;
      if (!page.hasMore) break;
      expect(page.changes.creates.length).toBe(2); // full page while hasMore
      if (++guard > 10) throw new Error("drain did not terminate");
    }
    expect(drained).toEqual(ids);
  });
});

describe("SyncService.getChanges — create then hard-deleted → tombstone", () => {
  it("emits a delete tombstone when the live entity is gone", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    const id = await addMessage(db, accountId, mailboxId);
    await rec(db, accountId, "message", id, "create");

    // Hard-delete the entity (folder_state FK first), leaving only the change_log create row.
    await db.delete(folderState).where(eq(folderState.messageId, id));
    await db.delete(messages).where(eq(messages.id, id));

    const resp = await svc.getChanges(ctx, {});
    expect(resp.changes.creates).toHaveLength(0);
    expect(resp.changes.deletes).toHaveLength(1);
    expect(resp.changes.deletes[0]).toMatchObject({ type: "message", op: "delete", id });
    expect(resp.changes.deletes[0]!.entity).toBeUndefined();
  });
});

describe("SyncService.getChanges — expired cursor → 410", () => {
  it("throws cursor_expired when the cursor is below the retained horizon; bootstrap never expires", async () => {
    const { db, accountId, ctx } = await setup();
    // Simulate retention pruning: the oldest retained change is seq 10.
    await db.insert(accountSyncState).values({ accountId, nextSeq: 11n }).onConflictDoUpdate({
      target: accountSyncState.accountId, set: { nextSeq: 11n },
    });
    await db.insert(changeLog).values([
      { accountId, seq: 10n, entityType: "message", entityId: randomUUID(), op: "create" },
      { accountId, seq: 11n, entityType: "message", entityId: randomUUID(), op: "create" },
    ]);

    // Cursor 3: next wanted is seq>3, but 4..9 were pruned → unrecoverable → 410.
    await expect(svc.getChanges(ctx, { since: svc.encodeCursor(3n) })).rejects.toMatchObject({
      code: "cursor_expired", httpStatus: 410,
    });
    await expect(svc.getChanges(ctx, { since: svc.encodeCursor(3n) })).rejects.toBeInstanceOf(ServiceError);

    // Cursor 9 abuts the horizon (next wanted seq 10 == min retained) → OK.
    const ok = await svc.getChanges(ctx, { since: svc.encodeCursor(9n) });
    expect(ok.changes.deletes.map((c) => c.seq)).toEqual([10, 11]); // random ids → tombstones

    // Bootstrap is never expired.
    const boot = await svc.getChanges(ctx, { since: "0" });
    expect(boot.changes.deletes.map((c) => c.seq)).toEqual([10, 11]);

    // A malformed cursor is treated as expired (client re-bootstraps).
    await expect(svc.getChanges(ctx, { since: "!!!not-base64!!!" })).rejects.toMatchObject({ httpStatus: 410 });
  });
});

/**
 * THE CEILING — a cursor ABOVE the account's highest committed seq.
 *
 * The retention floor above has always been guarded. The ceiling was not, and the failure it
 * produced is worse than the floor's, because it does not fail: `seq > since` matches nothing,
 * so the endpoint answers 200 with an empty delta, keeps the client's cursor exactly where it
 * was (an empty page returns `since` unchanged), and does it again on every poll for ever. The
 * mirror never learns another change, every optimistic edit appears to revert as its overlay
 * drains, and nothing anywhere reports an error.
 *
 * Measured live: a mirror holding a cursor seq far past its account's `change_log` max
 * itself. The cause is not the point — a restore, a copy between databases, a client that adopted
 * a cursor from a DIFFERENT seq space (see `apps/sidecar/src/cloud-read.ts`, where the hosted
 * and the local logs are two unrelated sequences) all produce it. 410 is the correct answer to
 * ALL of them, because it is the answer the client can act on: discard, re-snapshot, resume.
 *
 * MUTATION-WATCHED: delete the `maxSeq == null || sinceSeq > maxSeq` arm in
 * `sync-service.ts#getChanges` and the first two cases below go red with an OK answer carrying an empty
 * delta — which is precisely the production symptom.
 */
describe("SyncService.getChanges — cursor above the log's max → 410", () => {
  it("410s a cursor above max, serves the cursor AT max, and never expires a bootstrap", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();
    for (let i = 0; i < 3; i++) {
      const id = await addMessage(db, accountId, mailboxId);
      await rec(db, accountId, "message", id, "create");
    }

    // ── ABOVE the ceiling: the incident. One past it is enough — this is not a tolerance.
    await expect(svc.getChanges(ctx, { since: svc.encodeCursor(4n) })).rejects.toMatchObject({
      code: "cursor_expired", httpStatus: 410,
    });
    await expect(svc.getChanges(ctx, { since: svc.encodeCursor(4n) })).rejects.toBeInstanceOf(ServiceError);
    // Far above it — the live shape — answers the same way, not a 200.
    await expect(svc.getChanges(ctx, { since: svc.encodeCursor(2173n) })).rejects.toMatchObject({
      httpStatus: 410,
    });

    // ── AT the ceiling: the STEADY STATE of every caught-up client, and it must stay a 200.
    //    A guard that took this out would 410 every idle poll in the product.
    const atMax = await svc.getChanges(ctx, { since: svc.encodeCursor(3n) });
    expect(flatten(atMax)).toHaveLength(0);
    expect(svc.decodeCursor(atMax.cursor).seq).toBe(3n);
    expect(atMax.hasMore).toBe(false);

    // ── BELOW the ceiling: unchanged.
    expect(flatten(await svc.getChanges(ctx, { since: svc.encodeCursor(2n) }))).toHaveLength(1);

    // ── The bootstrap is never a cursor and is never expired.
    expect(flatten(await svc.getChanges(ctx, { since: "0" }))).toHaveLength(3);
    expect(flatten(await svc.getChanges(ctx, {}))).toHaveLength(3);
  });

  it("an EMPTY change log 410s any positive cursor — there is no seq it could name", async () => {
    const { ctx } = await setup();
    await expect(svc.getChanges(ctx, { since: svc.encodeCursor(1n) })).rejects.toMatchObject({
      code: "cursor_expired", httpStatus: 410,
    });
  });

  /**
   * THE FRESH-ACCOUNT BOOTSTRAP, WHICH MUST NOT 410 — the one way this guard could break the
   * product rather than fix it.
   *
   * A brand-new account has an empty log, so its ceiling is "nothing". The reason that is not a
   * 410 on its first poll is that a fresh client's cursor is ZERO, and zero is the bootstrap
   * sentinel rather than a position: `getChanges` skips both horizons for it. The subtlety worth
   * pinning is that an empty account is HANDED a cursor back (`encodeCursor(0n)`, not the literal
   * "0"), presents it on the next poll, and it must decode to the same bootstrap — otherwise a
   * new account would 410 in a loop until its first message arrived.
   */
  it("a fresh account polls, is handed a cursor, and re-polls with it — never a 410", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();

    const first = await svc.getChanges(ctx, {});
    expect(flatten(first)).toHaveLength(0);
    const minted = first.cursor;
    expect(minted).not.toBe("0");            // it really is an encoded cursor, not the sentinel
    expect(svc.decodeCursor(minted).seq).toBe(0n);

    // The second poll presents what it was given. Still a bootstrap, still a 200.
    const second = await svc.getChanges(ctx, { since: minted });
    expect(flatten(second)).toHaveLength(0);
    expect(svc.decodeCursor(second.cursor).seq).toBe(0n);

    // And the moment the account's first change lands, that same cursor delivers it.
    const id = await addMessage(db, accountId, mailboxId);
    await rec(db, accountId, "message", id, "create");
    const third = await svc.getChanges(ctx, { since: minted });
    expect(third.changes.creates.map((c) => c.id)).toEqual([id]);
    expect(svc.decodeCursor(third.cursor).seq).toBe(1n);
  });

  /**
   * ONE ACCOUNT'S CEILING IS ITS OWN. `change_log` is keyed `(account_id, seq)` and the seq
   * spaces are per-account, so a busy neighbour must not lift this account's ceiling — that
   * would re-open the hole for exactly the accounts most likely to have a stale mirror.
   */
  it("the ceiling is per-account: a neighbour's high seq does not license this account's cursor", async () => {
    const quiet = await setup();
    const { db } = quiet;

    // A BUSY neighbour in the SAME database, with its own mailbox and its own seq space.
    const busyAccountId = randomUUID();
    const [busyMb] = await db.insert(mailboxes)
      .values({ accountId: busyAccountId, provider: "imap", address: "busy@x.example" }).returning();
    for (let i = 0; i < 5; i++) {
      const id = await addMessage(db, busyAccountId, busyMb.id);
      await rec(db, busyAccountId, "message", id, "create");
    }

    // The quiet account has exactly one change, so seq 3 is above ITS ceiling and below the
    // neighbour's. The neighbour is served; the quiet account is not.
    const id = await addMessage(db, quiet.accountId, quiet.mailboxId);
    await rec(db, quiet.accountId, "message", id, "create");

    const neighbour: ServiceContext = { ...quiet.ctx, accountId: busyAccountId };
    expect(flatten(await svc.getChanges(neighbour, { since: svc.encodeCursor(3n) }))).toHaveLength(2);
    await expect(svc.getChanges(quiet.ctx, { since: svc.encodeCursor(3n) })).rejects.toMatchObject({
      httpStatus: 410,
    });
  });
});

describe("SyncService — client-apply convergence harness (contract §3.3)", () => {
  it("converges to the same state under replay, out-of-order, duplication, and page-by-page draining", async () => {
    const { db, accountId, mailboxId, ctx } = await setup();

    // A: create → update → move to Feed (survives, folder Feed)
    const a = await addMessage(db, accountId, mailboxId, { folder: "INBOX" });
    await rec(db, accountId, "message", a, "create");
    await rec(db, accountId, "message", a, "update");
    await db.update(folderState).set({ desiredFolder: "ohmail/News" }).where(eq(folderState.messageId, a));
    await rec(db, accountId, "message", a, "move", { from: "INBOX", to: "ohmail/News" });

    // B: create → hard-deleted (bootstrap create re-materializes null → tombstone; net absent)
    const b = await addMessage(db, accountId, mailboxId);
    await rec(db, accountId, "message", b, "create");
    await db.delete(folderState).where(eq(folderState.messageId, b));
    await db.delete(messages).where(eq(messages.id, b));

    // C: create (survives, INBOX)
    const c = await addMessage(db, accountId, mailboxId, { folder: "INBOX" });
    await rec(db, accountId, "message", c, "create");

    // A message_state entity on A (survives)
    const [st] = await db.insert(messageStates).values({ accountId, messageId: a, state: "reply_later" }).returning();
    await rec(db, accountId, "message_state", st.id, "create");

    const full = await svc.getChanges(ctx, { limit: 2000 });

    // Oracle: in-order apply.
    const inOrder = new ClientMirror();
    inOrder.applyResponse(full);
    const expected = snapshotObj(inOrder);

    // The converged state contains A, C and the message_state — but not the deleted B.
    expect(Object.keys(expected).sort()).toEqual([`message:${a}`, `message:${c}`, `message_state:${st.id}`].sort());
    expect((expected[`message:${a}`] as { folder: string }).folder).toBe("ohmail/News");

    // (a) Replay the same page twice → idempotent.
    const replay = new ClientMirror();
    replay.applyResponse(full);
    replay.applyResponse(full);
    expect(snapshotObj(replay)).toEqual(expected);

    // (b) Out-of-order: reverse the merged stream.
    const reversed = new ClientMirror();
    reversed.applyChanges([...flatten(full)].reverse());
    expect(snapshotObj(reversed)).toEqual(expected);

    // (c) Shuffled + duplicated changes.
    const shuffled = new ClientMirror();
    const dup = [...flatten(full), ...flatten(full)];
    for (let i = dup.length - 1; i > 0; i--) {
      const j = (i * 7 + 3) % (i + 1); // deterministic pseudo-shuffle
      [dup[i], dup[j]] = [dup[j]!, dup[i]!];
    }
    shuffled.applyChanges(dup);
    expect(snapshotObj(shuffled)).toEqual(expected);

    // (d) Page-by-page draining (limit 1) converges identically.
    const drained = new ClientMirror();
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page = await svc.getChanges(ctx, { since: cursor, limit: 1 });
      drained.applyResponse(page);
      cursor = page.cursor;
      if (!page.hasMore) break;
      if (++guard > 50) throw new Error("drain did not terminate");
    }
    expect(snapshotObj(drained)).toEqual(expected);
  });
});

/**
 * THE COST OF A PAGE MUST NOT SCALE WITH THE PAGE.
 *
 * `getChanges` re-materializes every row it returns, and `materializeMessage` was three
 * sequential round-trips. At the default page that is thousands of them. Measured on the
 * hosted service it came to tens of seconds for ONE page, and minutes to bootstrap the
 * changes of a single real account. The first page never finished inside the function
 * timeout, so `/sync` returned nothing at all and every view in the client rendered empty
 * against a mailbox full of messages. It read as "the app has no mail in it".
 *
 * A duration assertion would be a flake, and a "faster than before" assertion has nothing to
 * compare to. The property that actually prevents the outage is CONSTANCY: a page of forty
 * costs the same number of queries as a page of one. That is what is asserted.
 */
describe("sync — a page costs a constant number of queries", () => {
  /** Counts `db.select()` calls; in this code path each one is exactly one round-trip. */
  function counting(db: Db): { db: Db; selects: () => number } {
    let n = 0;
    const proxy = new Proxy(db as object, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "select" || typeof value !== "function") return value;
        return (...args: unknown[]) => {
          n += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as Db;
    return { db: proxy, selects: () => n };
  }

  async function costOf(messageCount: number): Promise<number> {
    const { db, accountId, mailboxId, ctx } = await setup();
    for (let i = 0; i < messageCount; i += 1) {
      const id = await addMessage(db, accountId, mailboxId, { subject: `s${i}` });
      // In a transaction, for the reason spelled out on `rec` above.
      await db.transaction((tx) => recordChange(tx as never, {
        accountId, entityType: "message", entityId: id, op: "create",
      }));
    }
    const counted = counting(db);
    const res = await svc.getChanges({ ...ctx, db: counted.db }, { since: "0", limit: 500 });
    // The page must actually contain the messages — a query-count assertion over an empty
    // result would pass for the very outage it exists to prevent.
    expect(res.changes.creates).toHaveLength(messageCount);
    return counted.selects();
  }

  it("forty messages cost the same as one", async () => {
    const one = await costOf(1);
    const forty = await costOf(40);
    expect(forty).toBe(one);
    // And the constant is small: the change_log page, then the batched reads.
    //
    // Six rather than five since the delta page carries `MessageDTO.autoReplyByUs`: one query per
    // page for the auto-reply flag, keyed on the page's ids. The flag needs the `away_replies`
    // ledger and the stored headers, so it cannot be read off the message row, and the client is
    // never given a header to parse — `materializeMessages` therefore asks once per page. The
    // ceiling moved by one; what this test asserts is unchanged and still passes above it, that
    // forty messages cost exactly what one costs.
    //
    // Seven since the page also carries `MessageDTO.awayRepliedAt`: one more per-page read, on the
    // same ledger, for the instant the responder answered. The number is measured, not predicted.

    // Eight since the page carries the two calendar facts, which ride ONE query as two columns:
    // both are answered off `message_bodies.headers` for the same ids, so a second query would
    // scan the same rows twice. Forty messages still cost exactly what one costs.

    // Nine since the retention floor (mail 0122): a `since=0` bootstrap reads the counter row's
    // `pruned_through_seq` once per page — a PK lookup — to tag sub-floor page cursors, so a
    // replay over a compacted log resumes instead of 410-looping. The number is measured, not
    // predicted, and forty messages still cost exactly what one costs.
    expect(one).toBeLessThanOrEqual(9);
  }, 60_000);

  /**
   * THREADS TOO — the half the message batch left behind, found the same way it was.
   *
   * `materializeThread` is three sequential round-trips, and the per-row loop in `getChanges`
   * paid them for every `thread` change on a page. Threads appear in the SAME volume messages do
   * (ingest records a thread create/update beside nearly every message create), so a stale
   * client's catch-up pages were dominated by them. Measured on the hosted service (2026-08-10,
   * a live account): a page heavy with thread changes took seconds, and the pages
   * thinned out exactly as the thread counts did — one round trip after another, per thread.
   * `materializeThreads` (three queries whatever the count) already existed for the snapshot
   * reader; this pins `getChanges` to it.
   */
  async function threadCostOf(threadCount: number): Promise<number> {
    const { db, accountId, mailboxId, ctx } = await setup();
    for (let i = 0; i < threadCount; i += 1) {
      const [t] = await db.insert(threads).values({ accountId, subject: `t${i}` }).returning();
      const mid = await addMessage(db, accountId, mailboxId, { subject: `s${i}` });
      await db.update(messages).set({ threadId: t.id }).where(eq(messages.id, mid));
      await db.transaction((tx) => recordChange(tx as never, {
        accountId, entityType: "thread", entityId: t.id, op: "create",
      }));
    }
    const counted = counting(db);
    const res = await svc.getChanges({ ...ctx, db: counted.db }, { since: "0", limit: 500 });
    // Same trap as above: the count only means something over a page that holds the threads.
    expect(res.changes.creates.filter((c) => c.type === "thread")).toHaveLength(threadCount);
    return counted.selects();
  }

  it("forty threads cost the same as one", async () => {
    const one = await threadCostOf(1);
    const forty = await threadCostOf(40);
    expect(forty).toBe(one);
    // The change_log page, the (empty) message prefetch, and three batched thread reads.
    expect(one).toBeLessThanOrEqual(6);
  }, 60_000);

  /**
   * THE SMALL-STATE TYPES TOO — the per-row loop's last inhabitants (INSTANT-ARCH §8 stage 3).
   *
   * `message_state` is the fourth volume type: triage done on another device is one row per
   * verb, and a stale resume's pages carry them by the dozen. Measured on the live serverless
   * path (2026-08-29, a test account): a page carrying dozens of `message_state`/`draft` rows
   * spent much of its p50 in the per-row loop — a sequential round trip per
   * row, the identical shape the message and thread batches were written to end. The batched
   * readers (`materializeMessageStates` and siblings) make the page constant-cost; this pins
   * it exactly as the two censuses above pin theirs.
   */
  async function stateCostOf(stateCount: number): Promise<number> {
    const { db, accountId, mailboxId, ctx } = await setup();
    for (let i = 0; i < stateCount; i += 1) {
      const mid = await addMessage(db, accountId, mailboxId, { subject: `s${i}` });
      const [st] = await db.insert(messageStates).values({ accountId, messageId: mid, state: "reply_later" }).returning();
      await db.transaction((tx) => recordChange(tx as never, {
        accountId, entityType: "message_state", entityId: st.id, op: "create",
      }));
    }
    const counted = counting(db);
    const res = await svc.getChanges({ ...ctx, db: counted.db }, { since: "0", limit: 500 });
    // The count only means something over a page that holds the states.
    expect(res.changes.creates.filter((c) => c.type === "message_state")).toHaveLength(stateCount);
    return counted.selects();
  }

  it("forty message_states cost the same as one", async () => {
    const one = await stateCostOf(1);
    const forty = await stateCostOf(40);
    expect(forty).toBe(one);
    // The change_log page, the (empty) message/thread prefetches, and ONE batched state read.
    expect(one).toBeLessThanOrEqual(7);
  }, 60_000);
});
