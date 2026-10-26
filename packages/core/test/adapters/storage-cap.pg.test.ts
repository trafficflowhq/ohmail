import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import {
  accounts, accountStorage, mailboxes, messages, messageBodies, messageSearch, attachments, folderState,
  changeLog, bodyBytesOf, storageUsageOf, applyBodyBytesDelta, reserveBodyBytes, evictOldestBodies,
  recomputeAccountStorage, stampMailboxErasure, sweepMailboxStep, eraseOwedMailbox, recordChanges,
  type LedgerTx,
} from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { carryDialect, dialect } from "@trafficflow/db/dialect";
import { makeDrizzleRepo } from "../../src/adapters/drizzle-repo.js";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "../../src/pipeline.js";
import type { Change } from "../../src/ports.js";

/**
 * THE MANAGED STORAGE CAP AGAINST REAL POSTGRES — the reserve's race, the decline's completeness,
 * and the counter's refusal to drift.
 *
 * ── WHY NOT PGlite ──────────────────────────────────────────────────────────────────────────
 *
 * The reserve is a read-modify-write on ONE row (`account_storage.bytes`) whose whole correctness
 * argument is "the conditional UPDATE takes the row lock, so racers serialize". Under PGlite there
 * is one connection, so two 'concurrent' ingests interleave cooperatively and the lost-update /
 * double-admit shapes this file exists to see are UNREPRESENTABLE — the standing PGlite-blindness
 * rule, on the exact primitive (`credit_balances`-style row serialization) it was written about.
 *
 * ── THE MUTATIONS WATCHED (each performed once against this file and reverted) ──────────────
 *
 *  · drop the `bytes < cap` arm from `reserveBodyBytes`'s WHERE → "the racers admit exactly what
 *    fits" goes red: over-cap ingest stores forever and no row is ever withheld;
 *  · make `commitChange` skip `insertAttachments`/`upsertFolderState` on a withheld body → "at
 *    cap, ORGANIZING is untouched" goes red on the missing rows;
 *  · drop the loser compensation in `insertMessageBody` → "a duplicate body moves the counter
 *    once" goes red with the counter double-charged.
 */
const AVAILABLE = await realPgAvailable();

function eml(o: { from?: string; subject?: string; body?: string; messageId?: string; date?: Date } = {}): Buffer {
  const {
    from = "cap@example.com", subject = "storage cap probe",
    body = "x".repeat(1000), messageId = `cap-${randomUUID()}@example.com`,
  } = o;
  const date = o.date === undefined ? "Tue, 14 Jul 2026 09:41:07 +0000" : o.date.toUTCString();
  return Buffer.from([
    `Message-ID: <${messageId}>`,
    `From: ${from}`,
    "To: reader@example.test",
    `Subject: ${subject}`,
    `Date: ${date}`,
    "Content-Type: text/plain; charset=utf-8",
    "", body,
  ].join("\r\n"));
}

let uid = 100;
const create = (raw: Buffer): Change =>
  ({ type: "create", locator: { folder: "INBOX", ref: `7:${++uid}` }, raw });

describe.skipIf(!AVAILABLE)("the storage cap against real Postgres", () => {
  let owned: OwnedDb;
  const createdAccounts: string[] = [];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 180_000);

  afterAll(async () => {
    // The :5433 Postgres is SHARED and long-lived; leaked rows change what other suites'
    // database-global assertions see. Children first (FKs point at messages/mailboxes).
    if (owned && createdAccounts.length > 0) {
      const ids = await owned.db.select({ id: messages.id }).from(messages)
        .where(inArray(messages.accountId, createdAccounts));
      const messageIds = ids.map((r) => r.id);
      if (messageIds.length) {
        await owned.db.delete(messageSearch).where(inArray(messageSearch.messageId, messageIds));
        await owned.db.delete(messageBodies).where(inArray(messageBodies.messageId, messageIds));
        await owned.db.delete(folderState).where(inArray(folderState.messageId, messageIds));
        await owned.db.delete(attachments).where(inArray(attachments.messageId, messageIds));
        await owned.db.execute(sql`delete from message_instances where message_id = any(${sql`array[${sql.join(messageIds.map((i) => sql`${i}::uuid`), sql`, `)}]`})`);
      }
      await owned.db.execute(sql`delete from routing_decisions where account_id = any(${sql`array[${sql.join(createdAccounts.map((i) => sql`${i}::uuid`), sql`, `)}]`})`);
      await owned.db.delete(changeLog).where(inArray(changeLog.accountId, createdAccounts));
      await owned.db.delete(messages).where(inArray(messages.accountId, createdAccounts));
      await owned.db.execute(sql`delete from threads where account_id = any(${sql`array[${sql.join(createdAccounts.map((i) => sql`${i}::uuid`), sql`, `)}]`})`);
      await owned.db.execute(sql`delete from account_sync_state where account_id = any(${sql`array[${sql.join(createdAccounts.map((i) => sql`${i}::uuid`), sql`, `)}]`})`);
      await owned.db.delete(accountStorage).where(inArray(accountStorage.accountId, createdAccounts));
      await owned.db.delete(mailboxes).where(inArray(mailboxes.accountId, createdAccounts));
      await owned.db.delete(accounts).where(inArray(accounts.id, createdAccounts));
    }
    await owned?.close().catch(() => {});
  });

  async function world(): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    createdAccounts.push(accountId);
    await owned.db.insert(accounts).values({ id: accountId, name: `cap-${accountId.slice(0, 8)}` });
    const [mb] = await owned.db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: `${accountId}@cap.test` }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  /** One full plan+commit through the REAL adapter — the exact shipped path, cap included. */
  async function ingest(
    w: { accountId: string; mailboxId: string }, change: Change, storageCap: number | typeof UNMETERED_STORAGE_CAP,
  ): Promise<{ outcome: string; messageId: string }> {
    const repo = makeDrizzleRepo(owned.db);
    const plan = await planChange(change, { repo, accountId: w.accountId, mailboxId: w.mailboxId, routing: repo });
    return owned.db.transaction(async (tx) => {
      // A transaction object is built by the query builder and carries no dialect brand, so a
      // repository built straight from it refuses on its first locking statement. Carried from
      // the handle the transaction was opened on — the same thing the production tx-scoped repo
      // sites do.
      const txRepo = makeDrizzleRepo(carryDialect(owned.db, tx as object) as never);
      return commitChange(plan, {
        repo: txRepo, routing: txRepo, accountId: w.accountId, mailboxId: w.mailboxId, storageCap,
      });
    });
  }

  it("below cap stores and counts EXACTLY the body's octets; the crossing message stores whole", async () => {
    const w = await world();
    // First message: ~1000 text bytes against a 10 KB cap — stored, counted.
    const r1 = await ingest(w, create(eml({ body: "a".repeat(1000) })), 10_000);
    expect(r1.outcome).toBe("new");
    const [b1] = await owned.db.select().from(messageBodies).where(eq(messageBodies.messageId, r1.messageId));
    expect(b1!.withheldReason).toBeNull();
    const counted1 = await storageUsageOf(owned.db, w.accountId);
    expect(counted1).toBe(bodyBytesOf({ text: b1!.text, html: b1!.html }));

    // Second message CROSSES the cap (counted < cap when it arrives) — stored WHOLE, deliberately:
    // the cap is a decline threshold, not a hard byte ceiling, and the overshoot is bounded by
    // one message.
    const r2 = await ingest(w, create(eml({ body: "b".repeat(20_000) })), 10_000);
    const [b2] = await owned.db.select().from(messageBodies).where(eq(messageBodies.messageId, r2.messageId));
    expect(b2!.withheldReason).toBeNull();
    expect(b2!.text.length).toBe(20_000);
    expect(await storageUsageOf(owned.db, w.accountId)).toBe(counted1 + bodyBytesOf({ text: b2!.text, html: b2!.html }));
  });

  it("AT CAP the OLDEST stored body husks and the NEW one stores — the rolling window", async () => {
    // Pre-ruling this case pinned decline-new: the arriving body was withheld and everything
    // existing kept. The ratified rolling window inverts it: new mail always lands, the oldest
    // stored copy gives way (headers kept, `storage_cap` marker), and IMAP — outside this
    // table — is untouched either way.
    const w = await world();
    const before = await ingest(w, create(eml({ body: "oldest".padEnd(2_000, ".") })), UNMETERED_STORAGE_CAP);
    const usedBefore = await storageUsageOf(owned.db, w.accountId);
    expect(usedBefore).toBeGreaterThan(0);

    // The cap is now AT what is stored ⇒ the account is at cap ⇒ the next body must evict.
    const atCap = usedBefore;
    const r = await ingest(w, create(eml({ subject: "arrives at cap", body: "c".repeat(5_000) })), atCap);
    expect(r.outcome).toBe("new");

    // THE MESSAGE ROW IS WHOLE either way: real snippet, sender, attachment counts.
    const [m] = await owned.db.select().from(messages).where(eq(messages.id, r.messageId));
    expect(m!.subject).toBe("arrives at cap");
    expect(m!.snippet.length).toBeGreaterThan(0);

    // THE NEW BODY IS STORED IN FULL — the ruling's whole content.
    const [fresh] = await owned.db.select().from(messageBodies).where(eq(messageBodies.messageId, r.messageId));
    expect(fresh!.withheldReason).toBeNull();
    expect(fresh!.text.length).toBe(5_000);

    // THE OLDEST is now the husk: empty content, REAL headers (the organizing passes read
    // stored headers), and the marker that lets every reader say why.
    const [husk] = await owned.db.select().from(messageBodies).where(eq(messageBodies.messageId, before.messageId));
    expect(husk!.withheldReason).toBe("storage_cap");
    expect(husk!.text).toBe("");
    expect(husk!.html).toBeNull();
    expect(Object.keys(husk!.headers as Record<string, unknown>)).toContain("subject");

    // ORGANIZING LANDED: folder_state (the desired-state move machinery) and the create delta.
    const [fs] = await owned.db.select().from(folderState).where(eq(folderState.messageId, r.messageId));
    expect(fs).toBeDefined();
    const deltas = await owned.db.select().from(changeLog).where(eq(changeLog.accountId, w.accountId));
    expect(deltas.some((d) => d.entityId === r.messageId && d.op === "create")).toBe(true);

    // THE COUNTER IS THE SWAP, exactly: the husked bytes left, the new body's bytes arrived.
    expect(await storageUsageOf(owned.db, w.accountId))
      .toBe(bodyBytesOf({ text: fresh!.text, html: fresh!.html }));
  });

  it("AT CAP with NOTHING left to evict, the new body is withheld — the pathological ceiling", async () => {
    // The old decline-new shape survives as the bound: when the inline evictor can free
    // nothing (every stored body is already a husk), the arriving body is withheld rather
    // than stored past the cap — the "No API cost without revenue behind it" invariant's hard edge.
    const w = await world();
    const first = await ingest(w, create(eml({ body: "seed".padEnd(2_000, ".") })), UNMETERED_STORAGE_CAP);
    const used = await storageUsageOf(owned.db, w.accountId);
    // Husk everything by hand, then hold the counter at the cap with nothing evictable behind it.
    await owned.db.transaction(async (tx) =>
      evictOldestBodies(tx as never, dialect(owned.db), w.accountId, { targetBytes: 0, maxBodies: 100 }));
    await owned.db.transaction(async (tx) =>
      reserveBodyBytes(tx as never, dialect(owned.db), w.accountId, used, null));
    const r = await ingest(w, create(eml({ subject: "no room", body: "d".repeat(3_000) })), used);
    expect(r.outcome).toBe("new");
    const [husk] = await owned.db.select().from(messageBodies).where(eq(messageBodies.messageId, r.messageId));
    expect(husk!.withheldReason).toBe("storage_cap");
    expect(husk!.text).toBe("");
    void first;
  });

  /** The account's counter row, facts included. */
  const factsOf = async (accountId: string) => {
    const [r] = await owned.db.select().from(accountStorage).where(eq(accountStorage.accountId, accountId));
    return r!;
  };
  /** Letters whose text is not held for space, counted from the bodies themselves. */
  const emptiedOf = async (accountId: string): Promise<number> => {
    const [r] = await owned.db.execute<{ n: string }>(sql`
      select count(*)::bigint as n from message_bodies b join messages m on m.id = b.message_id
       where m.account_id = ${accountId} and b.withheld_reason = 'storage_cap'`) as unknown as Array<{ n: string }>;
    return Number(r!.n);
  };

  it("a letter withheld for space on arrival is counted once; its duplicate is not", async () => {
    const w = await world();
    await ingest(w, create(eml({ body: "seed".padEnd(2_000, ".") })), UNMETERED_STORAGE_CAP);
    const used = await storageUsageOf(owned.db, w.accountId);
    await owned.db.transaction(async (tx) =>
      evictOldestBodies(tx as never, dialect(owned.db), w.accountId, { targetBytes: 0, maxBodies: 100 }));
    await owned.db.transaction(async (tx) =>
      reserveBodyBytes(tx as never, dialect(owned.db), w.accountId, used, null));
    // The trim emptied the seed (dated July 2026): text is kept from August on.
    expect(await factsOf(w.accountId)).toMatchObject({ huskedForSpace: 1, keptFrom: "2026-08-01", withheldOnArrival: 0 });

    const r = await ingest(w, create(eml({ subject: "no room", body: "d".repeat(3_000), date: new Date(Date.UTC(2026, 8, 3)) })), used);
    expect((await factsOf(w.accountId)).huskedForSpace, "the arrival withheld for space was not counted").toBe(2);
    expect((await factsOf(w.accountId)).withheldOnArrival, "the arrival was not counted apart").toBe(1);
    expect((await factsOf(w.accountId)).keptFrom, "a letter withheld on arrival moved the month text is kept from").toBe("2026-08-01");
    // The same body again: the 1:1 conflict inserts nothing, so nothing more is withheld.
    const again = await makeDrizzleRepo(owned.db).insertMessageBody(
      r.messageId, { text: "d".repeat(3_000), html: null, headers: {} }, { accountId: w.accountId, capBytes: used });
    expect(again).toBe("withheld");
    expect(await factsOf(w.accountId)).toMatchObject({ huskedForSpace: 2, withheldOnArrival: 1 });
    expect(await emptiedOf(w.accountId)).toBe(2);
  });

  it("after the cap drops, a letter withheld on arrival never moves kept_from past the letters that keep their text", async () => {
    // A downgrade, or a storage add-on removed: the cap falls to a quarter of what is stored. One new
    // letter arrives, the inline trim cannot make room for it, then the background trim and the daily recount.
    const w = await world();
    const d = dialect(owned.db);
    for (let i = 0; i < 200; i++) {
      await ingest(w, create(eml({ body: "o".repeat(1_000), date: new Date(Date.UTC(2022, 11, 1 + 7 * i)) })), UNMETERED_STORAGE_CAP);
    }
    const cap = 50_000;
    const arrival = await ingest(w, create(eml({ body: "n".repeat(1_000), date: new Date(Date.UTC(2026, 9, 20)) })), cap);
    const [body] = await owned.db.select().from(messageBodies).where(eq(messageBodies.messageId, arrival.messageId));
    expect(body!.withheldReason, "the new letter found room after all").toBe("storage_cap");
    for (let r = 0; r < 4; r++) {
      await owned.db.transaction(async (tx) =>
        evictOldestBodies(tx as never, d, w.accountId, { targetBytes: cap * 0.9, maxBodies: 500 }));
    }
    await owned.db.transaction(async (tx) =>
      recomputeAccountStorage(tx as never, d, w.accountId, new Date("2026-10-24T08:00:00Z")));

    // The trim emptied the 155 oldest letters, the newest of them dated 13 November 2025.
    const facts = await factsOf(w.accountId);
    expect(facts).toMatchObject({ huskedForSpace: 156, withheldOnArrival: 1, keptFrom: "2025-12-01" });
    expect(await emptiedFrom(w.accountId, facts.keptFrom), "an emptied letter dated from kept_from, besides the arrival").toBe(1);
    const [early] = await owned.db.execute<{ n: string }>(sql`
      select count(*)::bigint as n from message_bodies b join messages m on m.id = b.message_id
       where m.account_id = ${w.accountId} and b.withheld_reason is null and octet_length(b.text) > 0
         and coalesce(m.date, m.created_at) < ${facts.keptFrom}::date - interval '1 month'`) as unknown as Array<{ n: string }>;
    expect(Number(early!.n), "kept_from is past letters that keep their text by more than its own month").toBe(0);
    // 20 s: 2.4-3.4 s alone; over the default 5 s only in loaded 300-file whole-run shards (three reds on
    // unrelated pull requests, 2026-10-26/27). The bound is on the machine, not on what this case proves.
  }, 20_000);

  it("the recount writes the real bytes and count, the month text is kept from, and what had drifted", async () => {
    const w = await world();
    const d = dialect(owned.db);
    for (const [month, size] of [[0, 1_000], [2, 2_000], [4, 3_000]] as const) {
      await owned.db.transaction(async (tx) => {
        const t = tx as unknown as typeof owned.db;
        await reserveBodyBytes(t as never, d, w.accountId, size, null);
        const [m] = await t.insert(messages).values({
          accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: randomUUID(), dedupKey: randomUUID(),
          subject: "recount", date: new Date(Date.UTC(2026, month, 20)),
        }).returning();
        await t.insert(messageBodies).values({ messageId: m!.id, text: "r".repeat(size), html: null, headers: {} });
      });
    }
    await owned.db.transaction(async (tx) =>
      evictOldestBodies(tx as never, d, w.accountId, { targetBytes: 5_000, maxBodies: 100 }));
    expect((await factsOf(w.accountId)).keptFrom, "the trim's month").toBe("2026-02-01");
    // A letter that arrived while the storage was full, dated after that month: emptied, never trimmed.
    const [late] = await owned.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: randomUUID(), dedupKey: randomUUID(),
      subject: "recount", date: new Date(Date.UTC(2026, 6, 20)),
    }).returning();
    await owned.db.insert(messageBodies).values({ messageId: late!.id, text: "", html: null, headers: {}, withheldReason: "storage_cap" });
    // The counter wrong in every fact it keeps; the month later than the newest letter the trim emptied.
    await owned.db.update(accountStorage).set({ bytes: 5_777, huskedForSpace: 9, keptFrom: "2026-06-01", withheldOnArrival: 5 })
      .where(eq(accountStorage.accountId, w.accountId));

    const AT = new Date("2026-10-24T08:00:00.000Z");
    const found = await owned.db.transaction(async (tx) => recomputeAccountStorage(tx as never, d, w.accountId, AT));
    // Text is kept from the month after the newest letter emptied before that month (January's);
    // the July letter is past it, so it is the one withheld on arrival and moves nothing.
    expect(found).toEqual({ bytes: 5_000, drift: 777, huskedForSpace: 2, keptFrom: "2026-02-01", withheldOnArrival: 1 });
    expect(await factsOf(w.accountId)).toMatchObject({
      bytes: 5_000, huskedForSpace: 2, keptFrom: "2026-02-01", withheldOnArrival: 1, recountedAt: AT, recountDrift: 777,
    });
    expect(await emptiedOf(w.accountId)).toBe(2);

    // A second check finds nothing to correct; a counter LOW reads as a negative drift.
    expect((await owned.db.transaction(async (tx) => recomputeAccountStorage(tx as never, d, w.accountId, AT))).drift).toBe(0);
    await owned.db.update(accountStorage).set({ bytes: 4_000 }).where(eq(accountStorage.accountId, w.accountId));
    expect((await owned.db.transaction(async (tx) => recomputeAccountStorage(tx as never, d, w.accountId, AT))).drift).toBe(-1_000);
    expect(await storageUsageOf(owned.db, w.accountId)).toBe(5_000);
  });

  /** Letters emptied for space dated on or after `keptFrom` (all of them when it is null): always 0. */
  const emptiedFrom = async (accountId: string, keptFrom: string | null): Promise<number> => {
    const [r] = await owned.db.execute<{ n: string }>(sql`
      select count(*)::bigint as n from message_bodies b join messages m on m.id = b.message_id
       where m.account_id = ${accountId} and b.withheld_reason = 'storage_cap'
         and (${keptFrom}::date is null or coalesce(m.date, m.created_at) >= ${keptFrom}::date)`) as unknown as Array<{ n: string }>;
    return Number(r!.n);
  };
  const trimAndRecount = async (accountId: string, cap: number, at: Date) => {
    const d = dialect(owned.db);
    await owned.db.transaction(async (tx) =>
      evictOldestBodies(tx as never, d, accountId, { targetBytes: Math.floor(cap * 0.9), maxBodies: 500 }));
    const before = (await factsOf(accountId)).keptFrom;
    await owned.db.transaction(async (tx) => recomputeAccountStorage(tx as never, d, accountId, at));
    return { afterTrim: before, afterRecount: (await factsOf(accountId)).keptFrom };
  };

  it("kept_from bounds every emptied letter through a newest-first import across the cap", async () => {
    // The backfill fetches newest first: past the cap every arrival is older than every kept letter.
    // The background trim runs every ten arrivals; the last two arrive under its mark, then the daily recount.
    const w = await world();
    const cap = 50_000;
    const d = dialect(owned.db);
    for (let i = 0; i < 62; i++) {
      await ingest(w, create(eml({ body: "n".repeat(1_000), date: new Date(Date.UTC(2026, 6 - i, 10)) })), cap);
      if (i % 10 === 9) {
        await owned.db.transaction(async (tx) =>
          evictOldestBodies(tx as never, d, w.accountId, { targetBytes: cap * 0.9, maxBodies: 500 }));
      }
      const { keptFrom } = await factsOf(w.accountId);
      expect(await emptiedFrom(w.accountId, keptFrom), `arrival ${i}: an emptied letter dated from ${keptFrom}`).toBe(0);
    }
    expect(await emptiedOf(w.accountId)).toBeGreaterThan(0);
    await owned.db.transaction(async (tx) =>
      recomputeAccountStorage(tx as never, d, w.accountId, new Date("2026-10-24T08:00:00Z")));
    const { keptFrom } = await factsOf(w.accountId);
    expect(keptFrom).not.toBeNull();
    expect(await emptiedFrom(w.accountId, keptFrom), "the recount named a month whose letters were emptied").toBe(0);
  });

  it("a letter with an old Date header arriving after a trim does not move kept_from back", async () => {
    const w = await world();
    const cap = 20_000;
    for (let i = 0; i < 24; i++) {
      await ingest(w, create(eml({ body: "w".repeat(1_000), date: new Date(Date.UTC(2025, 0, 1 + 7 * i)) })), UNMETERED_STORAGE_CAP);
    }
    const trimmed = await trimAndRecount(w.accountId, cap, new Date("2026-10-23T08:00:00Z"));
    expect(trimmed.afterTrim).not.toBeNull();
    expect(trimmed.afterRecount).toBe(trimmed.afterTrim);
    // Small, so the account stays under the trim's mark and only the daily recount runs.
    await ingest(w, create(eml({ body: "o".repeat(200), date: new Date(Date.UTC(2001, 0, 1)) })), cap);
    await owned.db.transaction(async (tx) =>
      recomputeAccountStorage(tx as never, dialect(owned.db), w.accountId, new Date("2026-10-24T08:00:00Z")));
    const later = (await factsOf(w.accountId)).keptFrom;
    expect(later, "a letter dated 2001 moved the month back").toBe(trimmed.afterTrim);
    expect(await emptiedFrom(w.accountId, later)).toBe(0);
  });

  it("TWO RACING INGESTS at one slot of headroom admit exactly one — the reserve's whole claim", async () => {
    const w = await world();
    // Seed 1000 counted bytes, cap at 1001: one more body fits (bytes < cap), then at-cap.
    await ingest(w, create(eml({ body: "s".repeat(1000) })), UNMETERED_STORAGE_CAP);
    const cap = (await storageUsageOf(owned.db, w.accountId)) + 1;

    // Two SEPARATE physical connections — the decisive property. Both plan first (no tx), then
    // commit concurrently.
    const a = makeOwnedDb(PG_TEST_URL);
    const b = makeOwnedDb(PG_TEST_URL);
    try {
      const mk = async (handle: OwnedDb, tag: string) => {
        const repo = makeDrizzleRepo(handle.db);
        const change = create(eml({ subject: `racer ${tag}`, body: tag.repeat(3_000) }));
        const plan = await planChange(change, { repo, accountId: w.accountId, mailboxId: w.mailboxId, routing: repo });
        return handle.db.transaction(async (tx) => {
          const txRepo = makeDrizzleRepo(carryDialect(handle.db, tx as object) as never);
          return commitChange(plan, {
            repo: txRepo, routing: txRepo, accountId: w.accountId, mailboxId: w.mailboxId, storageCap: cap,
          });
        });
      };
      const [ra, rb] = await Promise.all([mk(a, "A"), mk(b, "B")]);
      const rows = await owned.db.select().from(messageBodies)
        .where(inArray(messageBodies.messageId, [ra.messageId, rb.messageId]));
      const withheld = rows.filter((r) => r.withheldReason === "storage_cap");
      const stored = rows.filter((r) => r.withheldReason === null);
      // EXACTLY one of each: a lost update would store both; a phantom decline would store none.
      expect(stored).toHaveLength(1);
      expect(withheld).toHaveLength(1);
      // And the counter equals precisely what was stored — recomputed from the table itself, so
      // this cannot pass by the counter and the rows drifting together.
      const [recount] = await owned.db.execute<{ sum: string }>(sql`
        select coalesce(sum(octet_length(b.text) + coalesce(octet_length(b.html), 0)), 0)::bigint as sum
          from message_bodies b join messages m on m.id = b.message_id
         where m.account_id = ${w.accountId}`) as unknown as Array<{ sum: string }>;
      expect(await storageUsageOf(owned.db, w.accountId)).toBe(Number(recount!.sum));
    } finally {
      await a.close().catch(() => {});
      await b.close().catch(() => {});
    }
  });

  it("a DUPLICATE body insert moves the counter once — the loser compensates", async () => {
    const w = await world();
    const repo = makeDrizzleRepo(owned.db);
    const [m] = await owned.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `dup:${randomUUID()}`,
      subject: "dup", fromAddress: "dup@example.com",
      nativeLocator: { folder: "INBOX", ref: "7:9999" },
    }).returning();
    const body = { text: "d".repeat(500), html: null, headers: { subject: ["dup"] } };
    const first = await repo.insertMessageBody(m!.id, body, { accountId: w.accountId, capBytes: null });
    const second = await repo.insertMessageBody(m!.id, body, { accountId: w.accountId, capBytes: null });
    expect(first).toBe("stored");
    expect(second).toBe("stored"); // the row exists and holds content — "stored" is the true answer
    expect(await storageUsageOf(owned.db, w.accountId)).toBe(bodyBytesOf(body));
  });

  it("the repair-pass delta clamps at zero and never aborts — and ingest+delta do not deadlock", async () => {
    const w = await world();
    // A negative delta against a missing/zero row must clamp, not violate the CHECK: the repair
    // this delta rides must never be aborted by bookkeeping.
    await applyBodyBytesDelta(owned.db, dialect(owned.db), w.accountId, -5_000);
    expect(await storageUsageOf(owned.db, w.accountId)).toBe(0);

    // Concurrent ingest (reserve → seq) and a repair-shaped tx (delta → seq) on ONE account:
    // both take the account_storage row lock BEFORE the change-log seq lock — the pinned lock
    // order — so this completes rather than 40P01ing.
    const a = makeOwnedDb(PG_TEST_URL);
    try {
      const ingestP = ingest(w, create(eml({ body: "i".repeat(2_000) })), 1_000_000);
      const deltaP = a.db.transaction(async (tx) => {
        await applyBodyBytesDelta(tx as never, dialect(owned.db), w.accountId, 123);
        // The repair pass records a change AFTER its delta — same order as ingest.
        await tx.execute(sql`select pg_sleep(0.05)`);
      });
      await Promise.all([ingestP, deltaP]);
    } finally {
      await a.close().catch(() => {});
    }
    const used = await storageUsageOf(owned.db, w.accountId);
    expect(used).toBeGreaterThanOrEqual(2_000); // the ingest's bytes plus the 123 delta
  });

  it("the 0062 backfill statement is a RECOMPUTE — a re-run converges on the true sum", async () => {
    const w = await world();
    await ingest(w, create(eml({ body: "r".repeat(4_000) })), UNMETERED_STORAGE_CAP);
    const truth = await storageUsageOf(owned.db, w.accountId);
    // Drift the counter deliberately (the old-worker window the runbook re-run exists for)…
    await owned.db.update(accountStorage).set({ bytes: 1 }).where(eq(accountStorage.accountId, w.accountId));
    // …and run the migration's own backfill statement twice. Same statement, verbatim shape.
    for (let i = 0; i < 2; i++) {
      await owned.db.execute(sql`
        INSERT INTO account_storage (account_id, bytes)
        SELECT m.account_id,
               COALESCE(SUM(octet_length(b.text) + COALESCE(octet_length(b.html), 0)), 0)
          FROM message_bodies b
          JOIN messages m ON m.id = b.message_id
         WHERE m.account_id = ${w.accountId}
         GROUP BY m.account_id
        ON CONFLICT (account_id) DO UPDATE SET bytes = excluded.bytes, updated_at = now()`);
    }
    expect(await storageUsageOf(owned.db, w.accountId)).toBe(truth);
  });

  /**
   * THE RE-RUN'S LOST UPDATE — the hole the serial test above structurally cannot see.
   *
   * The test above proves the migration's statement CONVERGES when nothing else is writing. The
   * runbook, though, prescribes the re-run while the old worker is still ingesting, and that is
   * exactly when `INSERT … SELECT SUM(…) … ON CONFLICT DO UPDATE SET bytes = excluded.bytes`
   * loses a reservation: `excluded.bytes` is fixed from the statement's OWN snapshot, taken
   * before the row lock is even requested, so a reservation that commits in between is
   * overwritten by a stale sum. The body stays stored and uncounted for ever.
   *
   * The interleaving is FORCED, not hoped for: the writer holds the counter row lock with an
   * uncommitted body, the recompute is started and observed WAITING on that exact lock in
   * `pg_locks`, and only then does the writer commit. That ordering is the whole defect, and
   * asserting the wait is what stops this passing by accident on a fast machine.
   *
   * MUTATION WATCHED: replace `recomputeAccountStorage`'s lock-then-compute pair with the
   * migration's single `INSERT … ON CONFLICT` statement → this goes red with the counter short by
   * exactly the concurrent body's octets, while the serial test above stays green.
   */
  // 30 s: the lock-wait observation polls for up to 5 s by design, and the default 5 s budget
  // would time the test out before the interleaving it asserts could be seen.
  it("a RECOMPUTE racing a live reservation loses nothing — lock first, then compute", async () => {
    const w = await world();
    await ingest(w, create(eml({ body: "base".repeat(250) })), UNMETERED_STORAGE_CAP);
    const before = await storageUsageOf(owned.db, w.accountId);

    const writer = makeOwnedDb(PG_TEST_URL);
    const recomputer = makeOwnedDb(PG_TEST_URL);
    try {
      // ── the writer: reserve (takes the row lock) + insert the body, then HOLD the tx open ──
      const BODY = "z".repeat(3_000);
      const bytes = bodyBytesOf({ text: BODY, html: null });
      let releaseWriter: (() => void) | undefined;
      const held = new Promise<void>((resolve) => { releaseWriter = resolve; });
      let locked: (() => void) | undefined;
      const lockTaken = new Promise<void>((resolve) => { locked = resolve; });

      const writerTx = writer.db.transaction(async (tx) => {
        await reserveBodyBytes(tx as never, dialect(owned.db), w.accountId, bytes, null);
        const [m] = await (tx as never as typeof owned.db).insert(messages).values({
          accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: randomUUID(),
          dedupKey: randomUUID(), subject: "racing the recompute",
        }).returning();
        await (tx as never as typeof owned.db).insert(messageBodies)
          .values({ messageId: m!.id, text: BODY, html: null, headers: {} });
        locked!();
        await held;             // keep the lock until the recompute is provably waiting on it
      });

      await lockTaken;
      // Start the recompute; with the fix it blocks acquiring the row lock the writer holds.
      const recomputeDone = recomputer.db.transaction(async (tx) =>
        recomputeAccountStorage(tx as never, dialect(owned.db), w.accountId, new Date()));

      // Observe the WAIT — the premise of the whole test; without it the two could serialize and
      // the assertions below would pass for the wrong reason.
      //
      // NOT a non-granted RELATION lock: a row-lock wait does not appear that way. The waiter
      // blocks on the HOLDER'S TRANSACTION ID (`locktype = 'transactionid'`), which is what the
      // first version of this check got wrong — it polled for a relation lock, never saw one, and
      // then left the writer's transaction open on the way out, which surfaced as
      // `CONNECTION_CLOSED` at teardown rather than as the assertion it really was.
      const waiting = async (): Promise<boolean> => {
        const rows = await owned.db.execute<{ n: string }>(sql`
          select count(*)::bigint as n from pg_locks
           where not granted and locktype in ('transactionid', 'tuple')`) as unknown as Array<{ n: string }>;
        return Number(rows[0]!.n) > 0;
      };
      let sawWait = false;
      for (let i = 0; i < 100 && !sawWait; i++) {
        sawWait = await waiting();
        if (!sawWait) await new Promise((r) => setTimeout(r, 50));
      }
      // Release the writer UNCONDITIONALLY before asserting: a failed assertion must not leave a
      // transaction holding a row lock on the shared :5433 Postgres, which is how one red test
      // becomes a suite-wide cascade.
      releaseWriter!();
      await writerTx;
      const written = await recomputeDone;
      expect(sawWait, "the recompute must be waiting on the counter row the writer holds").toBe(true);

      // The recomputed counter must INCLUDE the body that committed while it waited.
      const [recount] = await owned.db.execute<{ sum: string }>(sql`
        select coalesce(sum(octet_length(b.text) + coalesce(octet_length(b.html), 0)), 0)::bigint as sum
          from message_bodies b join messages m on m.id = b.message_id
         where m.account_id = ${w.accountId}`) as unknown as Array<{ sum: string }>;
      expect(written.bytes).toBe(Number(recount!.sum));
      expect(await storageUsageOf(owned.db, w.accountId)).toBe(Number(recount!.sum));
      // And it is strictly more than before — a stale-snapshot overwrite would land on `before`.
      expect(Number(recount!.sum)).toBe(before + bytes);
    } finally {
      await writer.close().catch(() => {});
      await recomputer.close().catch(() => {});
    }
  }, 30_000);

  /**
   * THE ERASE AGAINST INGEST AND THE TRIM. An erase step locks the counter before the change-log
   * sequence, the order ingest takes them in (reserve, then the deltas), and gives back exactly the
   * bytes of the rows its delete removed. Each case forces its interleaving and asserts the wait.
   *
   * MUTATION WATCHED: take the counter lock after the step's `recordChanges` → the first case
   * deadlocks (40P01).
   */
  describe("an erase step beside ingest and the trim", () => {
    const BODY = "e".repeat(1_000);
    const NOW = new Date("2026-10-24T10:00:00.000Z");

    async function sibling(accountId: string): Promise<string> {
      const [mb] = await owned.db.insert(mailboxes)
        .values({ accountId, provider: "imap", address: `${randomUUID()}@cap.test` }).returning();
      return mb!.id;
    }
    /** One counted letter: its message, its body and its reservation, in the caller's transaction. */
    async function letter(tx: unknown, accountId: string, mailboxId: string, daysAgo: number): Promise<string> {
      const t = tx as typeof owned.db;
      await reserveBodyBytes(t as never, dialect(owned.db), accountId, BODY.length, null);
      const [m] = await t.insert(messages).values({
        accountId, mailboxId, bodyHash: randomUUID(), dedupKey: randomUUID(), subject: "erase race",
        date: new Date(NOW.getTime() - daysAgo * 86_400_000),
      }).returning();
      await t.insert(messageBodies).values({ messageId: m!.id, text: BODY, html: null, headers: {} });
      return m!.id;
    }
    async function letters(accountId: string, mailboxId: string, n: number, daysAgo: number): Promise<void> {
      for (let i = 0; i < n; i++) await owned.db.transaction((tx) => letter(tx, accountId, mailboxId, daysAgo + i));
    }
    const stamp = (accountId: string, mailboxId: string) => owned.db.transaction(async (tx) => {
      await stampMailboxErasure(tx as never, { accountId, mailboxId, now: NOW });
    });
    const real = async (accountId: string): Promise<number> => {
      const [r] = await owned.db.execute<{ sum: string }>(sql`
        select coalesce(sum(octet_length(b.text) + coalesce(octet_length(b.html), 0)), 0)::bigint as sum
          from message_bodies b join messages m on m.id = b.message_id
         where m.account_id = ${accountId}`) as unknown as Array<{ sum: string }>;
      return Number(r!.sum);
    };
    const sawLockWait = async (): Promise<boolean> => {
      for (let i = 0; i < 100; i++) {
        const rows = await owned.db.execute<{ n: string }>(sql`
          select count(*)::bigint as n from pg_locks
           where not granted and locktype in ('transactionid', 'tuple')`) as unknown as Array<{ n: string }>;
        if (Number(rows[0]!.n) > 0) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => { open = resolve; });
      return { open, opened };
    };

    it("ingest holding the counter first: the erase waits on it, no deadlock, the counter exact", async () => {
      const w = await world();
      const sib = await sibling(w.accountId);
      await letters(w.accountId, w.mailboxId, 3, 10);
      await stamp(w.accountId, w.mailboxId);
      const writer = makeOwnedDb(PG_TEST_URL);
      const eraser = makeOwnedDb(PG_TEST_URL);
      try {
        const held = gate(); const locked = gate();
        const writing = writer.db.transaction(async (tx) => {
          const id = await letter(tx, w.accountId, sib, 0);
          locked.open();
          await held.opened;
          await recordChanges(tx as unknown as LedgerTx, [{
            accountId: w.accountId, entityType: "message", entityId: id, op: "create", meta: null,
          }]);
        });
        await locked.opened;
        const erasing = eraseOwedMailbox(eraser.db as never, dialect(eraser.db), {
          accountId: w.accountId, mailboxId: w.mailboxId, now: () => NOW, maxSteps: 10,
        });
        const waited = await sawLockWait();
        held.open();
        const [a, b] = await Promise.allSettled([writing, erasing]);
        expect(waited, "the erase step must wait on the counter the ingest holds").toBe(true);
        expect([a.status, b.status], String((a as PromiseRejectedResult).reason ?? (b as PromiseRejectedResult).reason))
          .toEqual(["fulfilled", "fulfilled"]);
        expect((b as PromiseFulfilledResult<{ done: boolean }>).value.done).toBe(true);
        expect(await storageUsageOf(owned.db, w.accountId)).toBe(1_000);
        expect(await storageUsageOf(owned.db, w.accountId)).toBe(await real(w.accountId));
      } finally {
        await writer.close().catch(() => {});
        await eraser.close().catch(() => {});
      }
    }, 30_000);

    it("the erase step holding the counter first: ingest waits on it, no deadlock, the counter exact", async () => {
      const w = await world();
      const sib = await sibling(w.accountId);
      await letters(w.accountId, w.mailboxId, 3, 10);
      await stamp(w.accountId, w.mailboxId);
      const writer = makeOwnedDb(PG_TEST_URL);
      const eraser = makeOwnedDb(PG_TEST_URL);
      try {
        const held = gate(); const locked = gate();
        const erasing = eraser.db.transaction(async (tx) => {
          const step = await sweepMailboxStep(tx as unknown as LedgerTx, dialect(eraser.db),
            { accountId: w.accountId, mailboxId: w.mailboxId, now: NOW });
          locked.open();
          await held.opened;
          return step;
        });
        erasing.catch(() => locked.open());
        await locked.opened;
        const writing = writer.db.transaction(async (tx) => {
          const id = await letter(tx, w.accountId, sib, 0);
          await recordChanges(tx as unknown as LedgerTx, [{
            accountId: w.accountId, entityType: "message", entityId: id, op: "create", meta: null,
          }]);
        });
        const waited = await sawLockWait();
        held.open();
        const [a, b] = await Promise.allSettled([erasing, writing]);
        expect(waited, "the ingest must wait on the counter the erase step holds").toBe(true);
        expect([a.status, b.status]).toEqual(["fulfilled", "fulfilled"]);
        expect(await storageUsageOf(owned.db, w.accountId), "the step kept its bodies' bytes")
          .toBe(await real(w.accountId));
        const rest = await eraseOwedMailbox(owned.db as never, dialect(owned.db), {
          accountId: w.accountId, mailboxId: w.mailboxId, now: () => NOW, maxSteps: 10,
        });
        expect(rest.done).toBe(true);
        expect(await storageUsageOf(owned.db, w.accountId)).toBe(1_000);
        expect(await storageUsageOf(owned.db, w.accountId)).toBe(await real(w.accountId));
      } finally {
        await writer.close().catch(() => {});
        await eraser.close().catch(() => {});
      }
    }, 30_000);

    it("an erase step against a trim of the same bodies releases them once", async () => {
      const w = await world();
      const sib = await sibling(w.accountId);
      await letters(w.accountId, w.mailboxId, 4, 100);   // the oldest: the trim takes these
      await letters(w.accountId, sib, 2, 1);
      await stamp(w.accountId, w.mailboxId);
      const evictor = makeOwnedDb(PG_TEST_URL);
      const eraser = makeOwnedDb(PG_TEST_URL);
      try {
        const held = gate(); const locked = gate();
        const trimming = evictor.db.transaction(async (tx) => {
          const r = await evictOldestBodies(tx as never, dialect(evictor.db), w.accountId,
            { targetBytes: 4_000, maxBodies: 100 });
          locked.open();
          await held.opened;
          return r;
        });
        await locked.opened;
        const erasing = eraseOwedMailbox(eraser.db as never, dialect(eraser.db), {
          accountId: w.accountId, mailboxId: w.mailboxId, now: () => NOW, maxSteps: 10,
        });
        const waited = await sawLockWait();
        held.open();
        const [a, b] = await Promise.allSettled([trimming, erasing]);
        expect(waited).toBe(true);
        expect([a.status, b.status]).toEqual(["fulfilled", "fulfilled"]);
        expect((a as PromiseFulfilledResult<{ evicted: number }>).value.evicted).toBe(2);
        expect(await storageUsageOf(owned.db, w.accountId)).toBe(2_000);
        expect(await storageUsageOf(owned.db, w.accountId)).toBe(await real(w.accountId));
      } finally {
        await evictor.close().catch(() => {});
        await eraser.close().catch(() => {});
      }
    }, 30_000);
  });
});
