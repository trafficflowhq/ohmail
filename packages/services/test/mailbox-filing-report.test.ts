import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { carryDialect, dialect } from "@trafficflow/db/dialect";
import {
  accounts, applyScreenerDecision, auditLog, changeLog, mailboxes, messages, folderState, type Tx,
} from "@trafficflow/db";
import { StaticKeyProvider } from "@trafficflow/core";
import { MessageService, makeMailboxService, type ServiceContext } from "@trafficflow/services";

/**
 * ═══ `MailboxDTO.pendingMoves` IS ONE NUMBER FOR FOUR SITUATIONS ════════════════════════════
 *
 * `pendingMoves` counts every outstanding filing of ours, and the client has nothing else to
 * read — so "the reconciler will file this on its next turn" and "the server refused this five
 * times and the next attempt is six hours out" arrive as the same `1`.
 *
 * The two are not even the same set of work. The strip's count filters `pending` ∧
 * `last_set_by = 'us'` ∧ `desired <> observed`; the reconciler's own queue
 * (`listPendingFolderStates`) filters `pending` ∧ `dueNow(next_attempt_at)`. A DEFERRED row is
 * therefore IN the count and ABSENT from the queue — nothing is going to touch it until its
 * `next_attempt_at` — which is precisely the shape a person reads as "stuck".
 *
 * `filing` splits that number by the operand that decides: `due` is work the next turn will
 * pick up, `deferred` is work that is asleep, and the three timestamps say for how long and
 * why. `asOf` is the read's own instant, so a client can say when it last looked instead of
 * running a clock over a number that has not been re-fetched.
 *
 * ── WHY `updated_at` IS THE AGE AND `created_at` IS NOT ─────────────────────────────────────
 *
 * `folder_state` is keyed by message and UPSERTED: one row per message, reused every time that
 * message is filed again. A `created_at` would therefore date the message's FIRST filing —
 * months ago for a message re-filed today — and "not filed for 47 days" over a decision made a
 * second ago is a worse lie than the one this replaces.
 *
 * `updated_at` is the honest operand and the code already treats it as one: the intent writers
 * stamp it (`upsertDesired`, `upsertFolderState`), `deferFolderReconcile` deliberately does NOT
 * ("a refusal is not a re-filing" — it is this row's place in the oldest-first queue), and
 * `listPendingFolderStates` orders by it. So `min(updated_at)` over the outstanding rows is the
 * queue's own head, measured the way the queue measures it.
 *
 * PGlite deliberately: this is about which rows one aggregate counts and what it reports about
 * them, not about concurrency.
 */

const NOW = new Date("2026-09-08T12:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);
const svc = makeMailboxService({ keyProvider: KP });

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const ctxFor = (db: Db, accountId: string): ServiceContext =>
  ({ db, accountId, userId: null, now: () => NOW, requestId: "r" });

async function seed(
  db: Db, over: { organizer?: boolean; reader?: boolean; address?: string } = {},
): Promise<{ accountId: string; mailboxId: string }> {
  const [a] = await db.insert(accounts).values({ name: "filing-report" }).returning();
  const [mb] = await db.insert(mailboxes).values({
    accountId: a!.id, provider: "imap", address: over.address ?? "person@example.test",
    ...(over.organizer || over.reader ? { organizeConsentedAt: minutesAgo(600) } : {}),
    ...(over.reader ? { organizerRole: "reader" } : {}),
  }).returning();
  return { accountId: a!.id, mailboxId: mb!.id };
}

/** One outstanding filing, with the schedule columns the reconciler writes on a refusal. */
async function seedFiling(
  db: Db,
  ids: { accountId: string; mailboxId: string },
  n: number,
  row: {
    updatedAt: Date;
    attempts?: number;
    nextAttemptAt?: Date | null;
    lastErrorClass?: string | null;
    by?: "us" | "external";
    desired?: string;
    observed?: string;
    status?: "pending" | "reconciled";
  },
): Promise<string> {
  const [m] = await db.insert(messages).values({
    accountId: ids.accountId,
    mailboxId: ids.mailboxId,
    dedupKey: `mid:<fr-${n}@example.test>`,
    messageIdHeader: `<fr-${n}@example.test>`,
    fromAddress: "stranger@example.test",
    subject: `s${n}`,
    date: NOW,
    bodyHash: `fr-hash-${n}`,
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id,
    desiredFolder: row.desired ?? "ohmail/News",
    observedFolder: row.observed ?? "INBOX",
    reconcileStatus: row.status ?? "pending",
    lastSetBy: row.by ?? "us",
    updatedAt: row.updatedAt,
    attempts: row.attempts ?? 0,
    nextAttemptAt: row.nextAttemptAt ?? null,
    ...(row.lastErrorClass !== undefined ? { lastErrorClass: row.lastErrorClass } : {}),
  });
  return m!.id;
}

const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const minutesAhead = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe("MailboxDTO.filing — why an outstanding filing is outstanding", () => {
  it("is present with zeros on a healthy mailbox — absent would mean 'cannot tell'", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.filing).toBeTruthy();
    expect(dto.filing?.due).toBe(0);
    expect(dto.filing?.deferred).toBe(0);
    expect(dto.filing?.oldestPendingAt).toBeNull();
    expect(dto.filing?.nextAttemptAt).toBeNull();
    expect(dto.filing?.attempts).toBe(0);
    expect(dto.filing?.lastRefusalClass).toBeNull();
    // The read's own instant, so the client can state when it last looked.
    expect(dto.filing?.asOf).toBe(NOW.toISOString());
  });

  it("counts a DUE row as due — NULL `next_attempt_at` means due now", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, { updatedAt: minutesAgo(1) });
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.filing?.due).toBe(1);
    expect(dto.filing?.deferred).toBe(0);
    expect(dto.filing?.oldestPendingAt).toBe(minutesAgo(1).toISOString());
    // The legacy total keeps counting BOTH, byte for byte — a client that reads only it behaves
    // exactly as it did before this field existed.
    expect(dto.pendingMoves).toBe(1);
  });

  it("counts a DEFERRED row as deferred — it is not in the reconciler's queue", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, {
      updatedAt: minutesAgo(9), attempts: 2,
      nextAttemptAt: minutesAhead(6), lastErrorClass: "no_such_folder",
    });
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.filing?.due, "a deferred row was reported as work in progress").toBe(0);
    expect(dto.filing?.deferred).toBe(1);
    expect(dto.filing?.nextAttemptAt).toBe(minutesAhead(6).toISOString());
    expect(dto.filing?.attempts).toBe(2);
    expect(dto.filing?.lastRefusalClass).toBe("no_such_folder");
    expect(dto.pendingMoves).toBe(1);
  });

  it("a PAST `next_attempt_at` is due again — the deferral expired", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, {
      updatedAt: minutesAgo(30), attempts: 3, nextAttemptAt: minutesAgo(2),
      lastErrorClass: "refused",
    });
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.filing?.due).toBe(1);
    expect(dto.filing?.deferred).toBe(0);
    // The class and the count STAY — they are what the row has been through, not a schedule.
    expect(dto.filing?.attempts).toBe(3);
    expect(dto.filing?.lastRefusalClass).toBe("refused");
  });

  it("the two classes of a failure on our side (mail 0164) read as themselves, never 'unknown'", async () => {
    for (const cls of ["stale_locator", "unconfirmed"]) {
      const db = await makeTestDb();
      const ids = await seed(db);
      await seedFiling(db, ids, 1, { updatedAt: minutesAgo(9), attempts: 2, nextAttemptAt: minutesAhead(6), lastErrorClass: cls });
      expect((await svc.get(ctxFor(db, ids.accountId), ids.mailboxId)).filing?.lastRefusalClass).toBe(cls);
    }
  });

  it("reports the OLDEST outstanding filing and the SOONEST next attempt", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, { updatedAt: minutesAgo(3), attempts: 1, nextAttemptAt: minutesAhead(20) });
    await seedFiling(db, ids, 2, { updatedAt: minutesAgo(14), attempts: 4, nextAttemptAt: minutesAhead(5) });
    await seedFiling(db, ids, 3, { updatedAt: minutesAgo(8) });
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.filing?.due).toBe(1);
    expect(dto.filing?.deferred).toBe(2);
    expect(dto.filing?.oldestPendingAt).toBe(minutesAgo(14).toISOString());
    // MIN, not max: the soonest is when something will next happen, which is what a sentence
    // promising a retry has to name.
    expect(dto.filing?.nextAttemptAt).toBe(minutesAhead(5).toISOString());
    // MAX: "this one has been refused four times" is the row that decides whether it is stuck.
    expect(dto.filing?.attempts).toBe(4);
    expect(dto.pendingMoves).toBe(3);
  });

  it("EXCLUDES the same three shapes the count excludes — one set, both fields", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    // The user tidying in their own client: adopted, never pushed.
    await seedFiling(db, ids, 1, { updatedAt: minutesAgo(20), by: "external" });
    // Folders already agree: a no-op the reconciler retires without touching IMAP.
    await seedFiling(db, ids, 2, { updatedAt: minutesAgo(20), desired: "INBOX", observed: "INBOX" });
    // Converged.
    await seedFiling(db, ids, 3, { updatedAt: minutesAgo(20), status: "reconciled" });
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.pendingMoves).toBe(0);
    expect(dto.filing?.due).toBe(0);
    expect(dto.filing?.deferred).toBe(0);
    // And no age from a row that is not outstanding — an `oldestPendingAt` over an excluded row
    // would report a wait nobody is waiting.
    expect(dto.filing?.oldestPendingAt).toBeNull();
  });

  it("is scoped to THIS mailbox — another mailbox's backlog is not this one's", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    const [other] = await db.insert(mailboxes).values({
      accountId: ids.accountId, provider: "imap", address: "second@example.test",
    }).returning();
    await seedFiling(db, { ...ids, mailboxId: other!.id }, 1, { updatedAt: minutesAgo(40) });
    const dto = await svc.get(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(dto.filing?.due).toBe(0);
    expect(dto.filing?.oldestPendingAt).toBeNull();
  });
});

/**
 * THE STUCK ROWS ALONE. The stuck sentence read the aggregate: a seconds-old move
 * beside a 62-minute one read "2 messages … 62 minutes", and a row nothing refused took the class
 * of another row. `stuck`, `stuckSince` and `stuckRefusalClass` are computed over the rows past
 * the rule (`filingStuck`: five minutes waited, or two refusals) and nothing else.
 */
describe("MailboxDTO.filing — the stuck rows are counted apart", () => {
  it("counts the old row and not the seconds-old one, under the old row's own clock", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, { updatedAt: minutesAgo(62) });
    await seedFiling(db, ids, 2, { updatedAt: new Date(NOW.getTime() - 30_000) });
    const f = (await svc.get(ctxFor(db, ids.accountId), ids.mailboxId)).filing!;
    expect(f.due).toBe(2);
    expect(f.stuck, "the seconds-old move was counted as stuck").toBe(1);
    expect(f.stuckSince).toBe(minutesAgo(62).toISOString());
    expect(f.stuckRefusalClass, "a row nothing refused was given a class").toBeNull();
  });

  it("a row refused twice is stuck at any age, and carries its own class", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, {
      updatedAt: minutesAgo(3), attempts: 2, nextAttemptAt: minutesAhead(10), lastErrorClass: "over_quota",
    });
    await seedFiling(db, ids, 2, { updatedAt: minutesAgo(4) });
    const f = (await svc.get(ctxFor(db, ids.accountId), ids.mailboxId)).filing!;
    expect(f.stuck).toBe(1);
    expect(f.stuckSince).toBe(minutesAgo(3).toISOString());
    expect(f.stuckRefusalClass).toBe("over_quota");
  });

  it("a young refused row does not lend its class to a stuck row nothing refused", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, { updatedAt: minutesAgo(70) });
    await seedFiling(db, ids, 2, {
      updatedAt: minutesAgo(1), attempts: 1, nextAttemptAt: minutesAhead(4), lastErrorClass: "read_only",
    });
    const f = (await svc.get(ctxFor(db, ids.accountId), ids.mailboxId)).filing!;
    expect(f.lastRefusalClass, "the precondition: the aggregate carries the young row's class").toBe("read_only");
    expect(f.stuck).toBe(1);
    expect(f.stuckRefusalClass, "the stuck row borrowed another row's reason").toBeNull();
  });

  it("CONTROL — five minutes is the boundary, and a reconciled or external row is never stuck", async () => {
    const db = await makeTestDb();
    const ids = await seed(db);
    await seedFiling(db, ids, 1, { updatedAt: minutesAgo(5) });
    await seedFiling(db, ids, 2, { updatedAt: new Date(NOW.getTime() - 299_000) });
    await seedFiling(db, ids, 3, { updatedAt: minutesAgo(90), status: "reconciled" });
    await seedFiling(db, ids, 4, { updatedAt: minutesAgo(90), by: "external" });
    const f = (await svc.get(ctxFor(db, ids.accountId), ids.mailboxId)).filing!;
    expect(f.stuck).toBe(1);
    expect(f.stuckSince).toBe(minutesAgo(5).toISOString());
  });
});

/**
 * SETTINGS → MAILBOXES SHOWS THE WAITING FILINGS, AND TWO PRESSES. The strip said "6 messages have
 * not been filed … · Settings → Mailboxes" and the pane said nothing. The read names how many,
 * since when, into which folder and why; "Try again now" re-arms the schedule; "Leave them where
 * they are" settles the intent where the mail already is. The API writes desired state only.
 */
const waiting = (o: { updatedAt?: Date; attempts?: number; nextAttemptAt?: Date | null; lastErrorClass?: string | null; desired?: string; observed?: string } = {}) =>
  ({ updatedAt: minutesAgo(345), attempts: 1, nextAttemptAt: null, lastErrorClass: "refused", desired: "ohmail/Receipts", observed: "ohmail/Reads", ...o });

async function row(db: Db, messageId: string) {
  const [r] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
  return r!;
}

/** A letter deleted from INBOX into "Trash" `ago` minutes before NOW; the move has not landed. */
async function deletedLetter(db: Db, ids: { accountId: string; mailboxId: string }, ago: number): Promise<string> {
  await db.update(mailboxes).set({ trashFolder: "Trash" }).where(eq(mailboxes.id, ids.mailboxId));
  const id = await seedFiling(db, ids, 1, { updatedAt: minutesAgo(900), desired: "INBOX", status: "reconciled", by: "external" });
  await db.update(messages).set({ nativeLocator: { folder: "INBOX", ref: "7:42" } }).where(eq(messages.id, id));
  await new MessageService().delete({ ...ctxFor(db, ids.accountId), now: () => minutesAgo(ago) }, id);
  return id;
}

/** The delete landed in Trash; the restore pressed an hour ago has not. */
async function restoringLetter(db: Db, ids: { accountId: string; mailboxId: string }): Promise<string> {
  const id = await deletedLetter(db, ids, 120);
  await db.update(folderState).set({ observedFolder: "Trash", reconcileStatus: "reconciled" }).where(eq(folderState.messageId, id));
  await db.update(messages).set({ nativeLocator: { folder: "Trash", ref: "9:5" } }).where(eq(messages.id, id));
  await new MessageService().restore({ ...ctxFor(db, ids.accountId), now: () => minutesAgo(60) }, id);
  return id;
}

describe("the waiting filings of one mailbox", () => {
  it("reads groups by folder with a count per reason; fresh, external and other accounts' rows left out", async () => {
    const db = await makeTestDb();
    const ids = await seed(db, { organizer: true });
    await seedFiling(db, ids, 1, waiting());
    await seedFiling(db, ids, 2, waiting({ updatedAt: minutesAgo(300), attempts: 0, lastErrorClass: null }));
    await seedFiling(db, ids, 3, waiting({ updatedAt: minutesAgo(2), nextAttemptAt: minutesAhead(10), lastErrorClass: "read_only" }));
    await seedFiling(db, ids, 4, { updatedAt: minutesAgo(1), desired: "ohmail/News" });
    await seedFiling(db, ids, 5, { updatedAt: minutesAgo(20), by: "external", desired: "Archive" });
    const other = await seed(db, { organizer: true, address: "other@example.test" });
    await seedFiling(db, other, 6, waiting());
    const r = await svc.readFilings(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(r).toEqual({
      mailboxId: ids.mailboxId, asOf: NOW.toISOString(), more: false,
      groups: [{
        folder: "ohmail/Receipts", count: 3, deferred: 1, stuck: 2, deletes: 0,
        since: minutesAgo(345).toISOString(), through: minutesAgo(2).toISOString(),
        nextAttemptAt: minutesAhead(10).toISOString(), at: "ohmail/Reads",
        reasons: [{ reason: "read_only", count: 1 }, { reason: "refused", count: 1 }, { reason: null, count: 1 }],
      }],
    });
  });

  it("is 404 for another account's mailbox and for a removed one; a reader's rows are not listed", async () => {
    const db = await makeTestDb();
    const ids = await seed(db, { organizer: true });
    const other = await seed(db, { organizer: true, address: "other@example.test" });
    await expect(svc.readFilings(ctxFor(db, other.accountId), ids.mailboxId)).rejects.toMatchObject({ httpStatus: 404 });
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, other.mailboxId));
    await expect(svc.readFilings(ctxFor(db, other.accountId), other.mailboxId)).rejects.toMatchObject({ httpStatus: 404 });
    const reader = await seed(db, { reader: true, address: "reader@example.test" });
    await seedFiling(db, reader, 7, waiting());
    expect((await svc.readFilings(ctxFor(db, reader.accountId), reader.mailboxId)).groups).toEqual([]);
  });

  it("an unrecognised class reads 'unknown', never null", async () => {
    const db = await makeTestDb();
    if (dialect(db).name !== "sqlite") {
      await db.execute(sql`alter table folder_state drop constraint folder_state_last_error_class_check`);
    }
    const ids = await seed(db, { organizer: true });
    await seedFiling(db, ids, 1, waiting({ lastErrorClass: "transport" }));
    const r = await svc.readFilings(ctxFor(db, ids.accountId), ids.mailboxId);
    expect(r.groups[0]!.reasons).toEqual([{ reason: "unknown", count: 1 }]);
    const f = (await svc.get(ctxFor(db, ids.accountId), ids.mailboxId)).filing!;
    expect(f.lastRefusalClass).toBe("unknown");
    expect(f.stuckRefusalClass).toBe("unknown");
  });
});

describe("Try again now", () => {
  it("re-arms that folder's waiting rows, skips a News pair, rings the doorbell, writes no change row", async () => {
    const db = await makeTestDb();
    const ids = await seed(db, { organizer: true });
    const a = await seedFiling(db, ids, 1, waiting({ attempts: 3, nextAttemptAt: minutesAhead(300) }));
    const b = await seedFiling(db, ids, 2, waiting({ desired: "Archive" }));
    const news = await seedFiling(db, ids, 3, waiting({ desired: "ohmail/Receipts", observed: "ohmail/Reads" }));
    await db.update(folderState).set({ desiredFolder: "ohmail/News" }).where(eq(folderState.messageId, news));
    await db.update(folderState).set({ attempts: 2, lastErrorClass: "refused" }).where(eq(folderState.messageId, news));
    const ctx = ctxFor(db, ids.accountId);
    expect(await svc.retryFilings(ctx, ids.mailboxId, { folder: "ohmail/Receipts" })).toEqual({ reset: 1, skipped: 0 });
    expect(await row(db, a)).toMatchObject({ attempts: 0, nextAttemptAt: null, lastErrorClass: null, updatedAt: minutesAgo(345) });
    expect((await row(db, b)).attempts).toBe(1);
    expect(await svc.retryFilings(ctx, ids.mailboxId, { folder: "ohmail/News" })).toEqual({ reset: 0, skipped: 1 });
    expect((await row(db, news)).attempts).toBe(2);
    const [mb] = await db.select({ at: mailboxes.syncRequestedAt }).from(mailboxes).where(eq(mailboxes.id, ids.mailboxId));
    expect(mb!.at).toEqual(NOW);
    expect(await db.select().from(changeLog).where(eq(changeLog.accountId, ids.accountId))).toEqual([]);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.accountId, ids.accountId), eq(auditLog.action, "filing.retry")));
    expect(audit.map((x) => x.payload)).toEqual([
      { mailboxId: ids.mailboxId, folder: "ohmail/Receipts", count: 1 },
      { mailboxId: ids.mailboxId, folder: "ohmail/News", count: 0 },
    ]);
  });

  it("is refused on a reader and on another account's mailbox, and validates the folder", async () => {
    const db = await makeTestDb();
    const reader = await seed(db, { reader: true });
    await seedFiling(db, reader, 1, waiting());
    await expect(svc.retryFilings(ctxFor(db, reader.accountId), reader.mailboxId, { folder: "ohmail/Receipts" }))
      .rejects.toMatchObject({ code: "organized_elsewhere" });
    const other = await seed(db, { organizer: true, address: "other@example.test" });
    await expect(svc.retryFilings(ctxFor(db, other.accountId), reader.mailboxId, { folder: "ohmail/Receipts" }))
      .rejects.toMatchObject({ httpStatus: 404 });
    for (const folder of [undefined, "", 7, "x".repeat(1025)]) {
      await expect(svc.retryFilings(ctxFor(db, other.accountId), other.mailboxId, { folder }))
        .rejects.toMatchObject({ httpStatus: 400 });
    }
    expect((await row(db, (await db.select().from(messages).where(eq(messages.mailboxId, reader.mailboxId)))[0]!.id)).attempts).toBe(1);
  });
});

describe("Leave them where they are", () => {
  it("settles desired := observed verbatim, clears the schedule, marks the put-back, one move row each", async () => {
    const db = await makeTestDb();
    const ids = await seed(db, { organizer: true });
    // A named Trash makes no living row a delete.
    await db.update(mailboxes).set({ trashFolder: "Trash" }).where(eq(mailboxes.id, ids.mailboxId));
    const a = await seedFiling(db, ids, 1, waiting());
    const b = await seedFiling(db, ids, 2, waiting({ observed: "INBOX", updatedAt: minutesAgo(10) }));
    const ctx = ctxFor(db, ids.accountId);
    const through = (await svc.readFilings(ctx, ids.mailboxId)).groups[0]!.through!;
    const r = await svc.leaveFilings(ctx, ids.mailboxId, { folder: "ohmail/Receipts", through });
    expect(r.settled).toBe(2);
    expect(r.remaining).toBe(0);
    expect(r.seq).not.toBeNull();
    for (const [id, observed] of [[a, "ohmail/Reads"], [b, "INBOX"]] as const) {
      expect(await row(db, id)).toMatchObject({
        desiredFolder: observed, observedFolder: observed, reconcileStatus: "reconciled", lastSetBy: "us",
        attempts: 0, nextAttemptAt: null, lastErrorClass: null, trashedFrom: null,
        updatedAt: NOW, decidedAt: NOW, autoFilingUndoneAt: NOW,
      });
    }
    const moves = await db.select().from(changeLog).where(eq(changeLog.accountId, ids.accountId));
    expect(moves.map((c) => [c.entityId, c.op, c.meta]).sort()).toEqual([
      [a, "move", { from: "ohmail/Receipts", to: "ohmail/Reads" }],
      [b, "move", { from: "ohmail/Receipts", to: "INBOX" }],
    ].sort());
    expect(r.seq).toBe(moves.map((c) => c.seq).reduce((x, y) => (y > x ? y : x)));
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "filing.leave"));
    expect(audit!.accountId).toBe(ids.accountId);
    expect(audit!.payload).toEqual({ mailboxId: ids.mailboxId, folder: "ohmail/Receipts", count: 2 });
    expect((audit!.inverse as { desiredFolder: string; messageIds: string[] }).desiredFolder).toBe("ohmail/Receipts");
    expect([...(audit!.inverse as { messageIds: string[] }).messageIds].sort()).toEqual([a, b].sort());
    // The strip clears: nothing of ours is outstanding on the mailbox any more.
    const dto = await svc.get(ctx, ids.mailboxId);
    expect(dto.pendingMoves).toBe(0);
    expect(dto.filing?.stuck).toBe(0);
  });

  it("CAS: a row filed elsewhere since, or touched after `through`, stays; the same millisecond settles", async () => {
    const db = await makeTestDb();
    const ids = await seed(db, { organizer: true });
    const through = minutesAgo(10);
    const same = await seedFiling(db, ids, 1, waiting({ updatedAt: through }));
    // A server keeps microseconds; the press's `through` is milliseconds.
    if (dialect(db).name !== "sqlite") {
      await db.execute(sql`update folder_state set updated_at = updated_at + interval '400 microseconds' where message_id = ${same}`);
    }
    const later = await seedFiling(db, ids, 2, waiting({ updatedAt: new Date(through.getTime() + 2) }));
    const elsewhere = await seedFiling(db, ids, 3, waiting({ desired: "Archive" }));
    const r = await svc.leaveFilings(ctxFor(db, ids.accountId), ids.mailboxId, { folder: "ohmail/Receipts", through: through.toISOString() });
    expect(r.settled).toBe(1);
    expect((await row(db, same)).reconcileStatus).toBe("reconciled");
    expect((await row(db, later)).desiredFolder).toBe("ohmail/Receipts");
    expect((await row(db, elsewhere)).desiredFolder).toBe("Archive");
  });

  it("settles at most 500 rows a press and says what remains", async () => {
    const db = await makeTestDb();
    const ids = await seed(db, { organizer: true });
    const made = await db.insert(messages).values(Array.from({ length: 501 }, (_, i) => ({
      accountId: ids.accountId, mailboxId: ids.mailboxId, dedupKey: `mid:<bulk-${i}@example.test>`, bodyHash: `bulk-${i}`,
    }))).returning({ id: messages.id });
    await db.insert(folderState).values(made.map((m) => ({
      messageId: m.id, desiredFolder: "ohmail/Receipts", observedFolder: "INBOX", lastSetBy: "us", updatedAt: minutesAgo(60),
    })));
    const r = await svc.leaveFilings(ctxFor(db, ids.accountId), ids.mailboxId, { folder: "ohmail/Receipts", through: NOW.toISOString() });
    expect(r).toMatchObject({ settled: 500, remaining: 1 });
  });

  it("never settles a waiting delete: it stays deleted and in Trash", async () => {
    const db = await makeTestDb();
    const ids = await seed(db, { organizer: true });
    const id = await deletedLetter(db, ids, 10);
    const ms = new MessageService();
    const ctx = ctxFor(db, ids.accountId);
    const [g] = (await svc.readFilings(ctx, ids.mailboxId)).groups;
    expect(g).toMatchObject({ folder: "Trash", count: 1, deletes: 1 });
    expect(await svc.leaveFilings(ctx, ids.mailboxId, { folder: "Trash", through: g!.through })).toMatchObject({ settled: 0, remaining: 0 });
    expect(await row(db, id)).toMatchObject({ desiredFolder: "Trash", reconcileStatus: "pending", trashedFrom: "INBOX" });
    expect((await ms.listTrash(ctx, { view: "trash" })).items.map((m) => m.id)).toEqual([id]);
  });

  it("a waiting restore is no delete: Leave keeps it in Trash, where Restore brings it back", async () => {
    const db = await makeTestDb();
    const ids = await seed(db, { organizer: true });
    const id = await restoringLetter(db, ids);
    const ms = new MessageService();
    const ctx = ctxFor(db, ids.accountId);
    const [g] = (await svc.readFilings(ctx, ids.mailboxId)).groups;
    expect(g).toMatchObject({ folder: "INBOX", count: 1, deletes: 0, at: "Trash" });
    expect(await svc.leaveFilings(ctx, ids.mailboxId, { folder: "INBOX", through: g!.through })).toMatchObject({ settled: 1, remaining: 0 });
    expect(await row(db, id)).toMatchObject({ desiredFolder: "Trash", observedFolder: "Trash", reconcileStatus: "reconciled" });
    expect((await ms.listTrash(ctx, { view: "trash" })).items.map((m) => m.id)).toEqual([id]);
    expect((await ms.restore(ctx, id)).restoreTo).toBe("INBOX");
  });

  // Every attach re-writes trash_folder: a rename or a lost Trash must not make a delete leavable.
  for (const trash of ["Deleted Items", null]) {
    it(`never settles a waiting delete once the attach names its Trash ${trash ?? "nowhere"}`, async () => {
      const db = await makeTestDb();
      const ids = await seed(db, { organizer: true });
      const id = await deletedLetter(db, ids, 10);
      await db.update(mailboxes).set({ trashFolder: trash }).where(eq(mailboxes.id, ids.mailboxId));
      const ctx = ctxFor(db, ids.accountId);
      const [g] = (await svc.readFilings(ctx, ids.mailboxId)).groups;
      expect(g).toMatchObject({ folder: "Trash", count: 1, deletes: 1 });
      expect(await svc.leaveFilings(ctx, ids.mailboxId, { folder: "Trash", through: g!.through })).toMatchObject({ settled: 0, remaining: 0 });
      expect(await row(db, id)).toMatchObject({ desiredFolder: "Trash", reconcileStatus: "pending", trashedFrom: "INBOX" });
    });
  }

  it("never settles a waiting restore out of a Trash the attach has since renamed", async () => {
    const db = await makeTestDb();
    const ids = await seed(db, { organizer: true });
    const id = await restoringLetter(db, ids);
    await db.update(mailboxes).set({ trashFolder: "Deleted Items" }).where(eq(mailboxes.id, ids.mailboxId));
    const ctx = ctxFor(db, ids.accountId);
    const [g] = (await svc.readFilings(ctx, ids.mailboxId)).groups;
    expect(g).toMatchObject({ folder: "INBOX", count: 1, deletes: 1, at: "Trash" });
    expect(await svc.leaveFilings(ctx, ids.mailboxId, { folder: "INBOX", through: g!.through })).toMatchObject({ settled: 0, remaining: 0 });
    expect(await row(db, id)).toMatchObject({ desiredFolder: "INBOX", observedFolder: "Trash", reconcileStatus: "pending" });
  });

  it("is refused on a reader, across accounts, and without a timestamp", async () => {
    const db = await makeTestDb();
    const reader = await seed(db, { reader: true });
    const id = await seedFiling(db, reader, 1, waiting());
    await expect(svc.leaveFilings(ctxFor(db, reader.accountId), reader.mailboxId, { folder: "ohmail/Receipts", through: NOW.toISOString() }))
      .rejects.toMatchObject({ code: "organized_elsewhere" });
    const other = await seed(db, { organizer: true, address: "other@example.test" });
    await expect(svc.leaveFilings(ctxFor(db, other.accountId), reader.mailboxId, { folder: "ohmail/Receipts", through: NOW.toISOString() }))
      .rejects.toMatchObject({ httpStatus: 404 });
    await expect(svc.leaveFilings(ctxFor(db, other.accountId), other.mailboxId, { folder: "ohmail/Receipts", through: "soon" }))
      .rejects.toMatchObject({ httpStatus: 400 });
    expect((await row(db, id)).desiredFolder).toBe("ohmail/Receipts");
  });
});

describe("a new filing starts its schedule fresh", () => {
  it("through the move door", async () => {
    const db = await makeTestDb();
    const ids = await seed(db, { organizer: true });
    const id = await seedFiling(db, ids, 1, waiting({ attempts: 4, nextAttemptAt: minutesAhead(360) }));
    await new MessageService().move(ctxFor(db, ids.accountId), id, { folder: "ohmail/Screened" });
    expect(await row(db, id)).toMatchObject({ desiredFolder: "ohmail/Screened", attempts: 0, nextAttemptAt: null, lastErrorClass: null });
  });

  it("through the Screener's apply", async () => {
    const db = await makeTestDb();
    const ids = await seed(db, { organizer: true });
    const id = await seedFiling(db, ids, 1, waiting({ desired: "ohmail/Screener", observed: "INBOX" }));
    await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx) as unknown as Tx, {
      accountId: ids.accountId, scope: "sender", address: "stranger@example.test", appliedFolder: "ohmail/Screened",
      decision: "yes", triggeringActionId: "screener:fresh", now: NOW, decidedBy: "person", overExisting: "converge",
    }));
    expect(await row(db, id)).toMatchObject({ desiredFolder: "ohmail/Screened", attempts: 0, nextAttemptAt: null, lastErrorClass: null });
  });
});
