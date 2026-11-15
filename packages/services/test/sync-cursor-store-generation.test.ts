import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  mailboxes, messages, folderState, recordChange, type EntityType,
} from "@trafficflow/db";
import { SyncService, ServiceError, type ServiceContext } from "../src/index.js";

/**
 * ══ A CURSOR FROM A RUN OF THE STORE THAT IS OVER IS REFUSED ══════════════════════════════════
 *
 * The desktop's store does not wait for the flush when it takes mail in, so a kill costs it what
 * it committed since the last fold. Those mirror rows come back — the mailbox is the master, and
 * the folder cursor was lost with them — but they come back AT THE SAME SEQS, because the
 * change-log counter rolled back with the rows and `allocateSeqRange` reconciles it against the
 * log's own maximum. A client parked above that point is then served everything above its cursor
 * and never the re-derived rows below it: mail in the mailbox, absent from that device, silently,
 * for ever.
 *
 * THE HORIZON CHECK IS NOT THIS CHECK, and the difference is the whole reason this one exists.
 * Immediately after the crash `max(seq)` is BELOW the parked cursor, and `/sync` already answers
 * 410 for a cursor above the log — which catches the client that polls in that window. Once the
 * re-derivation has passed the parked seq the ceiling is back above it and that check goes quiet;
 * the client this catches is the one that was asleep, which on a desktop is every paired phone.
 *
 * WHAT ADMITS A CURSOR THAT NAMES NO RUN. A store's FIRST generation is the run no crash has
 * ended, so a cursor issued before this field existed is still about the only run there has been.
 * That is the upgrade path and nothing else: the moment a generation is minted, every such cursor
 * is refused.
 *
 * WATCHED FAILING: drop the `assertSameStoreRun` call in `getChanges` and the first two cases go
 * green with a 200 that skips the re-derived rows; admit a generation-less cursor unconditionally
 * (`if (cursor === null) return`) and the third goes green on the crash it is about; drop the
 * `storeGeneration` argument from either `encodeCursor` call and the round-trip case goes red
 * because the door hands back a cursor it would itself refuse.
 */

const svc = new SyncService();
type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function setup(storeGeneration: number | null) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "a@x.example",
  }).returning();
  const ctx: ServiceContext = {
    db, accountId, userId: null,
    now: () => new Date("2026-09-17T00:00:00.000Z"), requestId: "r",
    ...(storeGeneration === null ? {} : { storeGeneration }),
  };
  return { db, accountId, mailboxId: mb!.id, ctx };
}

const rec = (db: Db, accountId: string, entityType: EntityType, entityId: string) =>
  db.transaction((tx) => recordChange(tx as never, { accountId, entityType, entityId, op: "create" }));

async function addMessage(db: Db, accountId: string, mailboxId: string): Promise<string> {
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, bodyHash: "h", dedupKey: randomUUID(),
    subject: "s", fromAddress: "f@x.example",
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
  });
  return m!.id;
}

/** Three changes, so a cursor can sit inside the log rather than at either end of it. */
async function threeChanges(db: Db, accountId: string, mailboxId: string): Promise<void> {
  for (let i = 0; i < 3; i++) await rec(db, accountId, "message", await addMessage(db, accountId, mailboxId));
}

describe("a /sync cursor names the run of the store that issued it", () => {
  it("refuses a cursor from an earlier run, on the seq the re-derivation has already reached", async () => {
    const { db, accountId, mailboxId, ctx } = await setup(2);
    await threeChanges(db, accountId, mailboxId);

    // The parked cursor: inside the log, so the horizon check has nothing to say about it — this
    // is the state AFTER the re-derivation caught up, which is the state that used to answer 200.
    const parked = svc.encodeCursor(1n, 1);
    const inside = await svc.getChanges(ctx, { since: svc.encodeCursor(1n, 2) });
    expect(inside.changes.creates.length + inside.changes.updates.length,
      "the same seq under the CURRENT run is served, so the refusal below is about the run and "
      + "not about where the cursor sits").toBeGreaterThan(0);

    await expect(svc.getChanges(ctx, { since: parked }))
      .rejects.toMatchObject({ code: "cursor_expired", httpStatus: 410 });
    await expect(svc.getChanges(ctx, { since: parked })).rejects.toBeInstanceOf(ServiceError);
  });

  it("admits a cursor that names no run only while the store is on its first", async () => {
    const first = await setup(1);
    await threeChanges(first.db, first.accountId, first.mailboxId);
    // The shape a client held before the field existed: a bare seq, no run named.
    const legacy = svc.encodeCursor(1n);
    const served = await svc.getChanges(first.ctx, { since: legacy });
    expect(served.changes.creates.length + served.changes.updates.length,
      "a cursor with no run is refused by the run that has never ended — every install upgrading "
      + "into this field would re-bootstrap for nothing").toBeGreaterThan(0);

    const second = await setup(2);
    await threeChanges(second.db, second.accountId, second.mailboxId);
    await expect(svc.getChanges(second.ctx, { since: legacy }))
      .rejects.toMatchObject({ code: "cursor_expired", httpStatus: 410 });
  });

  it("hands back a cursor carrying its own run, and reads it back", async () => {
    const { db, accountId, mailboxId, ctx } = await setup(7);
    await threeChanges(db, accountId, mailboxId);

    const boot = await svc.getChanges(ctx, {});
    expect(svc.decodeCursor(boot.cursor)).toEqual({ seq: 3n, generation: 7, floor: null });
    // The identity arm — a cursor AT the horizon — hands one back too, and it is the same shape.
    const atMax = await svc.getChanges(ctx, { since: boot.cursor });
    expect(svc.decodeCursor(atMax.cursor)).toEqual({ seq: 3n, generation: 7, floor: null });
  });

  it("states its run in the snapshot, because the client mints its first cursor from that", async () => {
    const { db, accountId, mailboxId, ctx } = await setup(4);
    await threeChanges(db, accountId, mailboxId);
    const page = await svc.getSnapshot(ctx, {});
    expect(page.storeGeneration, "a snapshot that states no run leaves the cursor the client "
      + "mints from asOfSeq naming none, which the next crash then admits").toBe(4);

    const hosted = await setup(null);
    await threeChanges(hosted.db, hosted.accountId, hosted.mailboxId);
    const hostedPage = await svc.getSnapshot(hosted.ctx, {});
    expect("storeGeneration" in hostedPage,
      "a store that cannot lose a committed row states nothing, so the hosted wire does not move")
      .toBe(false);
    const hostedBoot = await svc.getChanges(hosted.ctx, {});
    expect(svc.decodeCursor(hostedBoot.cursor)).toEqual({ seq: 3n, generation: null, floor: null });
  });
});

/**
 * THE SNAPSHOT'S PAGE CURSOR NAMES ITS RUN TOO. A walk whose pages span an unclean restart used to
 * commit the old run's `asOfSeq` under the new run's generation, and the new run admitted it: rows
 * re-derived at or below that seq after the walk passed them were never delivered. A page cursor
 * from another run — or one naming no run at a store that has them — is a 410, never a guess.
 */
describe("a /sync/snapshot page cursor names the run of the store that issued it", () => {
  const PAGE = { limit: 1 } as const;

  it("a walk on one run pages to the end", async () => {
    const { db, accountId, mailboxId, ctx } = await setup(3);
    await threeChanges(db, accountId, mailboxId);
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await svc.getSnapshot(ctx, { ...PAGE, ...(cursor ? { cursor } : {}) });
      pages += 1;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(pages, "the fixture must span pages or the refusals below prove nothing").toBeGreaterThan(1);
  });

  it("refuses a page cursor issued by an earlier run of the store", async () => {
    const { db, accountId, mailboxId, ctx } = await setup(1);
    await threeChanges(db, accountId, mailboxId);
    const first = await svc.getSnapshot(ctx, PAGE);
    expect(first.nextCursor).not.toBeNull();
    await expect(svc.getSnapshot({ ...ctx, storeGeneration: 2 }, { ...PAGE, cursor: first.nextCursor! }))
      .rejects.toMatchObject({ code: "cursor_expired", httpStatus: 410 });
  });

  it("refuses a page cursor that names no run where the store has one, and the reverse", async () => {
    const { db, accountId, mailboxId, ctx } = await setup(1);
    await threeChanges(db, accountId, mailboxId);
    const { storeGeneration: _run, ...unrun } = ctx;
    const older = await svc.getSnapshot(unrun, PAGE);
    await expect(svc.getSnapshot(ctx, { ...PAGE, cursor: older.nextCursor! }))
      .rejects.toMatchObject({ code: "cursor_expired", httpStatus: 410 });
    const newer = await svc.getSnapshot(ctx, PAGE);
    await expect(svc.getSnapshot(unrun, { ...PAGE, cursor: newer.nextCursor! }))
      .rejects.toMatchObject({ code: "cursor_expired", httpStatus: 410 });
    // A store with no runs keeps paging on its own cursors, as the hosted wire always has.
    await expect(svc.getSnapshot(unrun, { ...PAGE, cursor: older.nextCursor! })).resolves.toBeDefined();
  });
});
