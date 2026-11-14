import { accountOfMessage } from "@trafficflow/db";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { accounts, mailboxes, contacts as contactsTbl, messages, messageInstances, folderState, changeLog, threads, auditLog } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { carryDialect } from "@trafficflow/db/dialect";
import { makeDrizzleRepo } from "../../src/adapters/drizzle-repo.js";
import { planChange, commitChange , UNMETERED_STORAGE_CAP} from "../../src/pipeline.js";
import { normalizeMime } from "../../src/mime.js";
import {
  bodyHash, fingerprintDedupKey, legacyDedupKey, messageFingerprint, normalizeMessageId,
} from "../../src/identity.js";
import type { Change } from "../../src/ports.js";

/**
 * LOGICAL + PHYSICAL IDENTITY AGAINST REAL POSTGRES — and the ruling's risk 1.
 *
 * ── WHY NOT PGlite ─────────────────────────────────────────────────────────────────────────
 *
 * Two reasons, and the ruling names both.
 *
 * **Risk 1, ranked High × High: "the legacy fallback re-splits a message the client already
 * holds."** The dual-key lookup verifies a `mid:`/`body:` hit against four STORED columns, and one
 * of those comparisons is against a value that has been through Postgres. A mismatch does not
 * produce a wrong answer — it produces a SECOND `messages` row for one logical message, which no
 * delta ever removes (the "Delta-first client contract" invariant), plus a second `threads` row because `commitChange`'s re-entry guard
 * is `stored.threadId` and a new row has none. The client then holds two ids for one content, for
 * ever. `date` is the specific trap the ruling calls out, which is exactly why the tuple has four
 * columns and not five — and a `timestamptz` round trip is not a thing PGlite can be trusted to
 * reproduce.
 *
 * **`UNIQUE (message_id) WHERE is_primary` is a PARTIAL index**, the class of object CLAUDE.md
 * records PGlite misleading this repository about. Every write path here touches it.
 *
 * So the rows below are seeded in the SHAPE a pre-slice ingest wrote them: `dedup_key` as
 * `mid:<lowercased Message-ID>`, `message_id_header` lowercased with it, `body_hash` the real
 * canonical hash, `from_address` lowercased, and `date` a genuine offset-carrying timestamp with
 * sub-second precision.
 */

const AVAILABLE = await realPgAvailable();

/** A `Date:` header with an offset AND milliseconds — the round-trip the tuple must not depend on. */
const HEADER_DATE = "Tue, 14 Jul 2026 09:41:07 +0530";

function eml(o: {
  from?: string; subject?: string; body?: string; messageId?: string | null; date?: string;
} = {}): Buffer {
  const {
    from = "Anna@Example.COM", subject = "Roof detail", body = "the ridge beam is 240mm",
    messageId = "Legacy-1@Example.com", date = HEADER_DATE,
  } = o;
  return Buffer.from([
    ...(messageId === null ? [] : [`Message-ID: <${messageId}>`]),
    `From: ${from}`,
    "To: mila@lichtgrat.example",
    `Cc: partner@example.com`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    "Content-Type: text/plain; charset=utf-8",
    "", body,
  ].join("\r\n"));
}

const create = (folder: string, raw: Buffer, ref = "1:10"): Change =>
  ({ type: "create", locator: { folder, ref }, raw });

describe.skipIf(!AVAILABLE)("message identity against real Postgres", () => {
  let owned: OwnedDb;
  let accountId: string;
  let mailboxId: string;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    // An INDEPENDENT pool: `makeDb`/`closeDb` share one module global and this file must not be able
    // to close a handle another test owns (see `client.ts#makeOwnedDb`).
    owned = makeOwnedDb(PG_TEST_URL);
  }, 180_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  /** A fresh account + mailbox per case, so the shared Postwith cannot make a count assertion flaky. */
  async function world(): Promise<{ accountId: string; mailboxId: string }> {
    accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `b13-${accountId.slice(0, 8)}` });
    const [mb] = await owned.db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: `${accountId}@b13.test` }).returning();
    mailboxId = mb!.id;
    // A known sender, so the routing layer leaves the message where it arrives and the assertions
    // below are about identity rather than about placement.
    await owned.db.insert(contactsTbl).values({ accountId, address: "anna@example.com" });
    return { accountId, mailboxId };
  }

  /** Seed one row EXACTLY as a pre-slice ingest wrote it, from the same raw bytes. */
  async function seedLegacy(raw: Buffer, locator = { folder: "INBOX", ref: "1:10" }): Promise<string> {
    const m = await normalizeMime(raw);
    const [row] = await owned.db.insert(messages).values({
      accountId, mailboxId,
      // The PRE-SLICE `normalizeMessageId` folded case. Stored that way, on purpose.
      messageIdHeader: m.canonical.messageIdHeader?.toLowerCase() ?? null,
      bodyHash: m.canonical.bodyHash,
      dedupKey: legacyDedupKey(m.canonical),
      subject: m.subject,
      fromAddress: m.from.address,
      date: m.date,
      nativeLocator: locator,
    }).returning({ id: messages.id });
    // …and its primary instance, which migration 0028's backfill would have written.
    await owned.db.insert(messageInstances).values({
      accountId, mailboxId, messageId: row!.id, folder: locator.folder,
      uidvalidity: BigInt(locator.ref.split(":")[0]!), uid: Number(locator.ref.split(":")[1]),
      isPrimary: true,
    });
    await owned.db.insert(folderState).values({
      messageId: row!.id, accountId: accountOfMessage(row!.id), desiredFolder: locator.folder, observedFolder: locator.folder,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return row!.id;
  }

  async function ingest(change: Change): Promise<{ outcome: string; messageId: string }> {
    const repo = makeDrizzleRepo(owned.db);
    const plan = await planChange(change, { repo, accountId, mailboxId, routing: repo });
    return owned.db.transaction(async (tx) => {
      // Carried, not bare: the driver's transaction object has no dialect brand of its own, and
      // the thread merge below composes a locking statement through the seam.
      const txRepo = makeDrizzleRepo(carryDialect(owned.db, tx) as never);
      return commitChange(plan, { repo: txRepo, routing: txRepo, accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP });
    });
  }

  const countMessages = async (): Promise<number> =>
    (await owned.db.select({ id: messages.id }).from(messages)
      .where(eq(messages.accountId, accountId))).length;

  const rowsOf = async (): Promise<Array<typeof messages.$inferSelect>> =>
    owned.db.select().from(messages).where(eq(messages.accountId, accountId));

  const instancesOf = async (): Promise<Array<typeof messageInstances.$inferSelect>> =>
    owned.db.select().from(messageInstances)
      .where(eq(messageInstances.accountId, accountId))
      .orderBy(messageInstances.folder, messageInstances.uid);

  const changesOf = async (): Promise<Array<typeof changeLog.$inferSelect>> =>
    owned.db.select().from(changeLog).where(eq(changeLog.accountId, accountId)).orderBy(changeLog.seq);

  // ── RISK 1: the legacy fallback must not re-split ─────────────────────────────────────────

  it("RECOGNISES a pre-slice row from the same bytes: one row, key upgraded, no second thread", async () => {
    // THE HIGHEST-DAMAGE FAILURE ON THIS PATH. A verification that refuses a genuine legacy row
    // inserts a SECOND `messages` row; no delta removes the first, so the client holds two ids for
    // one content for ever, and a second `threads` row is minted with it.
    await world();
    const raw = eml();
    const legacyId = await seedLegacy(raw);
    expect(await countMessages()).toBe(1);

    const res = await ingest(create("INBOX", raw));

    expect(res.outcome).toBe("duplicate");
    expect(res.messageId).toBe(legacyId);
    expect(await countMessages(), "a second row here IS the convergence break").toBe(1);
    // The key is now `fp1:` — the migration, performed at read time, one message at a time.
    const [row] = await rowsOf();
    expect(row!.dedupKey).toBe(fingerprintDedupKey(messageFingerprint(await normalizeMime(raw))));
    expect(row!.dedupKey.startsWith("fp1:")).toBe(true);
    // No `create` delta for a message the client already has, and no second thread.
    expect((await changesOf()).filter((c) => c.entityType === "message" && c.op === "create"))
      .toHaveLength(0);
    expect(await owned.db.select({ id: threads.id }).from(threads)
      .where(eq(threads.accountId, accountId))).toHaveLength(0);
  });

  it("the four-column tuple survives the `date` ROUND TRIP — which is why date is not in it", async () => {
    // `messages.date` is `timestamptz` and has been through Postgres; `parsed.date` has not. The
    // header above carries a +0530 offset and a whole-second value, and a five-column tuple would
    // have to prove those compare equal after storage. This case exists to state that the
    // recognition above did NOT depend on that: the stored date is read back and asserted to be a
    // real Date, and the row is still recognised.
    await world();
    const raw = eml({ date: HEADER_DATE });
    await seedLegacy(raw);
    const [before] = await rowsOf();
    expect(before!.date).toBeInstanceOf(Date);
    expect(before!.date!.toISOString()).toBe(new Date(HEADER_DATE).toISOString());

    // …and a message whose DATE HEADER DIFFERS but whose four columns agree is still the same
    // logical message to the legacy fallback. (Its fingerprint differs — `date` IS in the
    // fingerprint — so this is the fallback's answer, not the fingerprint's.)
    const res = await ingest(create("INBOX", eml({ date: "Wed, 15 Jul 2026 09:41:07 +0000" })));
    expect(res.outcome).toBe("duplicate");
    expect(await countMessages()).toBe(1);
  });

  it("matches the Message-ID CASE-INSENSITIVELY — the fold the legacy population was written with", async () => {
    // The stored header is `legacy-1@example.com`; the observed one is `Legacy-1@Example.com`,
    // because `normalizeMessageId` no longer folds case. Compare them raw and every mixed-case
    // legacy row is refused and re-inserted. Remove the `.toLowerCase()` pair from
    // `verifiesLegacyIdentity` and this case reports 2 rows.
    await world();
    const raw = eml({ messageId: "Legacy-1@Example.com" });
    await seedLegacy(raw);
    const [stored] = await rowsOf();
    expect(stored!.messageIdHeader).toBe("legacy-1@example.com");
    expect(normalizeMessageId("<Legacy-1@Example.com>")).toBe("Legacy-1@Example.com");

    expect((await ingest(create("INBOX", raw))).outcome).toBe("duplicate");
    expect(await countMessages()).toBe(1);
  });

  it("REFUSES a forged `mid:` hit — the stranger gets their own row, the user's is untouched", async () => {
    // at the database. The Message-ID is chosen by whoever sent the mail, so a stranger can name
    // the id of a message the user already holds. Under `mid:` alone their bytes WERE that message.
    // Here the body, the subject and the sender all disagree, so the tuple refuses and the forgery
    // becomes its own row — under the NEW key, so it cannot join anybody else's later either.
    await world();
    const genuine = eml({ messageId: "shared@id", subject: "Invoice 4471", body: "IBAN CH00 real" });
    const genuineId = await seedLegacy(genuine);
    const forged = eml({
      messageId: "shared@id", subject: "Invoice 4471", from: "attacker@evil.example",
      body: "IBAN CH99 attacker",
    });

    const res = await ingest(create("INBOX", forged, "1:11"));

    expect(res.outcome).toBe("new");
    expect(res.messageId).not.toBe(genuineId);
    expect(await countMessages()).toBe(2);
    const rows = await rowsOf();
    // The user's row keeps its legacy key — nothing was upgraded on the strength of a refusal.
    expect(rows.find((r) => r.id === genuineId)!.dedupKey).toBe("mid:shared@id");
    expect(rows.find((r) => r.id !== genuineId)!.dedupKey.startsWith("fp1:")).toBe(true);
  });

  it("two anchorless messages sharing a body: are NOT one row", async () => {
    // The legacy `body:` key made these one row and dropped the second — an empty auto-reply, a bare
    // "thanks", two different senders. Seeded as a pre-slice `body:` row, then the second arrives.
    await world();
    const first = eml({ messageId: null, subject: "Re: invoice", body: "thanks" });
    const firstId = await seedLegacy(first);
    const [seeded] = await rowsOf();
    expect(seeded!.dedupKey).toBe(`body:${bodyHash("thanks")}`);

    const second = eml({ messageId: null, subject: "Re: contract", body: "thanks" });
    const res = await ingest(create("INBOX", second, "1:12"));

    expect(res.outcome).toBe("new");
    expect(res.messageId).not.toBe(firstId);
    expect(await countMessages()).toBe(2);
  });

  it("the upgrade is MONOTONE: a third observation hits `fp1:` and nothing is rewritten", async () => {
    await world();
    const raw = eml();
    await seedLegacy(raw);
    await ingest(create("INBOX", raw));
    const key = (await rowsOf())[0]!.dedupKey;

    // A row already on `fp1:` is found by step 1 of the lookup, so the legacy read never happens and
    // `upgradeDedupKey` is never called. `dedup_key NOT LIKE 'fp1:%'` therefore only ever decreases.
    expect((await ingest(create("INBOX", raw))).outcome).toBe("duplicate");
    expect((await rowsOf())[0]!.dedupKey).toBe(key);
    expect(await countMessages()).toBe(1);
  });

  // ── the consent boundary end to end, on real Postgres ────────────────────────────────────

  it("a second delivery records an instance, flags conflict, and moves NOTHING", async () => {
    await world();
    const raw = eml({ from: "stranger@nowhere.example" });
    const first = await ingest(create("INBOX", raw));
    const changesBefore = (await changesOf()).length;
    const [state0] = await owned.db.select().from(folderState)
      .where(eq(folderState.messageId, first.messageId));

    const second = await ingest(create("ohmail/News", raw, "1:2002"));

    expect(second.outcome).toBe("external_copy");
    expect(second.messageId).toBe(first.messageId);
    expect(await countMessages()).toBe(1);

    const [state1] = await owned.db.select().from(folderState)
      .where(eq(folderState.messageId, first.messageId));
    // Placement UNCHANGED and still ours; the conflict RECORDED.
    expect(state1!.desiredFolder).toBe(state0!.desiredFolder);
    expect(state1!.observedFolder).toBe(state0!.observedFolder);
    expect(state1!.lastSetBy).toBe("us");
    expect(state1!.conflict).toBe(true);
    // No delta, no `adopt_external` audit row.
    expect((await changesOf()).length).toBe(changesBefore);
    expect(await owned.db.select({ id: auditLog.id }).from(auditLog)
      .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, "adopt_external"))))
      .toHaveLength(0);
    // The primary never moved — still the ARRIVAL locator. (`desired_folder` is
    // `ohmail/Screener`; the physical move is the reconcile runner's job and this test does not
    // run it, which is exactly why `native_locator` is still INBOX.)
    const [row] = await rowsOf();
    expect(row!.nativeLocator).toEqual({ folder: "INBOX", ref: "1:10" });
    // …TWO instances exist, exactly one of them primary…
    const inst = await instancesOf();
    expect(inst).toHaveLength(2);
    expect(inst.filter((i) => i.isPrimary)).toHaveLength(1);
    expect(inst.find((i) => i.isPrimary)).toMatchObject({ folder: "INBOX", uid: 10 });
    expect(inst.find((i) => !i.isPrimary)).toMatchObject({ folder: "ohmail/News", uid: 2002 });
    // …and BOTH locators are in the known-set, which is what stops the copy being re-fetched every
    // cycle for ever. `listKnownLocators` reading `message_instances` IS that property: built from
    // `messages.native_locator` it can only ever name one locator per logical message, so the
    // declined copy would be an unknown UID on every single poll — and INBOX has no watermark to
    // save it the way Sent saved `own_copy`.
    const known = await makeDrizzleRepo(owned.db).listKnownLocators(mailboxId);
    expect(known.map((k) => `${k.folder}#${k.uidValidity}:${k.uid}`).sort())
      .toEqual(["INBOX#1:10", "ohmail/News#1:2002"]);
  });

  /**
   * THE REPOINT THAT CANNOT HAPPEN IS REPORTED, not swallowed. `setPrimaryInstance` ended in an
   * `onConflictDoNothing`, so a destination tuple already claimed by ANOTHER message made the
   * insert a silent no-op while `messages.native_locator` had just been written to it — a message
   * advertising a place with no instance row of its own, invisible to `listKnownLocators` and
   * therefore re-fetched every cycle for ever. The UPDATE arm above it has always failed loudly;
   * this one now does too, and the mirror is written only after the fact lands.
   */
  it("a locator ANOTHER message already holds refuses the repoint, and the advertised place stands", async () => {
    await world();
    const a = await seedLegacy(eml({ messageId: "claimed-a@example.com" }), { folder: "INBOX", ref: "1:10" });
    await seedLegacy(eml({ messageId: "claimed-b@example.com" }), { folder: "INBOX", ref: "1:20" });
    // A has no primary instance of its own, so the repoint reaches the INSERT arm rather than the
    // UPDATE arm — the one that swallowed its conflict.
    await owned.db.delete(messageInstances).where(eq(messageInstances.messageId, a));

    const repo = makeDrizzleRepo(owned.db);
    // A ONE-WORD VERDICT rather than `.rejects` on this pool handle.
    const verdict = await repo.updateLocator(a, { folder: "INBOX", ref: "1:20" }).then(
      () => "accepted",
      (err: unknown) => (String((err as Error).message).includes("another message") ? "refused" : "other"),
    );
    expect(verdict).toBe("refused");

    // The refusal left the tuple with its rightful owner…
    const inst = await instancesOf();
    expect(inst.filter((i) => i.uid === 20)).toHaveLength(1);
    expect(inst.filter((i) => i.messageId === a)).toHaveLength(0);
    // …and A still advertises the place it actually occupies, not the one it could not take.
    const [rowA] = await owned.db.select().from(messages).where(eq(messages.id, a));
    expect(rowA!.nativeLocator).toEqual({ folder: "INBOX", ref: "1:10" });
  });

  it("POSITIVE CONTROL — an unclaimed locator is taken, and the mirror follows it", async () => {
    await world();
    const a = await seedLegacy(eml({ messageId: "unclaimed-a@example.com" }), { folder: "INBOX", ref: "1:10" });

    await makeDrizzleRepo(owned.db).updateLocator(a, { folder: "ohmail/News", ref: "1:77" });

    const inst = await instancesOf();
    expect(inst.filter((i) => i.isPrimary)).toHaveLength(1);
    expect(inst.find((i) => i.isPrimary)).toMatchObject({ folder: "ohmail/News", uid: 77 });
    const [rowA] = await owned.db.select().from(messages).where(eq(messages.id, a));
    expect(rowA!.nativeLocator).toEqual({ folder: "ohmail/News", ref: "1:77" });
  });

  it("re-observing the copy three times leaves ONE instance row and no new deltas", async () => {
    await world();
    const raw = eml({ from: "stranger@nowhere.example" });
    await ingest(create("INBOX", raw));
    const changesBefore = (await changesOf()).length;
    for (let i = 0; i < 3; i++) {
      expect((await ingest(create("ohmail/Receipts", raw, "1:3003"))).outcome).toBe("external_copy");
    }
    expect(await instancesOf()).toHaveLength(2);
    expect((await changesOf()).length).toBe(changesBefore);
  });

  // ── The evidence, and the writes that produce it ──────────────────────────────────────────

  it("a DISAPPEARANCE turns the same observation into an adoption", async () => {
    // The pair that is the whole slice, on real Postgres: identical bytes, identical folder,
    // identical stored state. The only difference is `forgetInstanceAt` — which only the SERVER's
    // report of an expunge can cause, and which is therefore the one thing a sender cannot forge.
    await world();
    const raw = eml({ from: "anna@example.com" });
    const first = await ingest(create("INBOX", raw));
    const repo = makeDrizzleRepo(owned.db);
    expect(await repo.primaryInstanceVanished(first.messageId)).toBe(false);

    await repo.forgetInstanceAt(mailboxId, { folder: "INBOX", ref: "1:10" });
    expect(await repo.primaryInstanceVanished(first.messageId)).toBe(true);

    const second = await ingest(create("Archive", raw, "1:4004"));
    expect(second.outcome).toBe("external_move");
    const [state] = await owned.db.select().from(folderState)
      .where(eq(folderState.messageId, first.messageId));
    expect(state!.desiredFolder).toBe("Archive");
    expect(state!.lastSetBy).toBe("external");
  });

  it("a row with NO native_locator never reads as a disappearance", async () => {
    // The other half of `primaryInstanceVanished`. Rows like this exist (seeded backlogs, fixtures)
    // and they have no instance to be missing — answering true for them would manufacture adoption
    // evidence out of an incomplete record. Drop the `native_locator IS NOT NULL` half of that
    // statement and this reports true.
    await world();
    const [row] = await owned.db.insert(messages).values({
      accountId, mailboxId, bodyHash: "h", dedupKey: `fp1:${randomUUID()}`,
      subject: "s", fromAddress: "a@b.test",
    }).returning({ id: messages.id });
    expect(await makeDrizzleRepo(owned.db).primaryInstanceVanished(row!.id)).toBe(false);
  });

  // ── The write paths that the partial unique makes sharp ───────────────────────────────────

  it("updateLocator MOVES the primary into a slot a copy already occupies, without 23505", async () => {
    // The ordering inside `setPrimaryInstance`. A non-primary instance of the SAME message can
    // already be sitting at the destination — that is exactly what an `external_copy` recorded, and
    // it is what a user's own move into a folder we saw a copy in produces. Without the DELETE
    // first, the UPDATE raises 23505 on `message_instances_locator_uq` and takes the ingest
    // transaction with it.
    await world();
    const raw = eml({ from: "anna@example.com" });
    const first = await ingest(create("INBOX", raw));
    await ingest(create("ohmail/News", raw, "1:5005"));       // the copy, non-primary
    expect(await instancesOf()).toHaveLength(2);

    const repo = makeDrizzleRepo(owned.db);
    await repo.updateLocator(first.messageId, { folder: "ohmail/News", ref: "1:5005" });

    const inst = await instancesOf();
    expect(inst).toHaveLength(1);
    expect(inst[0]).toMatchObject({ folder: "ohmail/News", uid: 5005, isPrimary: true });
    // …and `native_locator` still mirrors it, which every other read path depends on.
    expect((await rowsOf())[0]!.nativeLocator).toEqual({ folder: "ohmail/News", ref: "1:5005" });
  });

  it("recordInstance never RE-ATTRIBUTES a locator another message claims", async () => {
    // A UID is not reused inside an epoch, so a conflict with a different `message_id` is an
    // anomaly. Repointing it would be a write an attacker could aim by choosing when to deliver, so
    // the `setWhere` guard makes it a no-op instead.
    await world();
    const a = await ingest(create("INBOX", eml({ from: "anna@example.com" })));
    const b = await ingest(create("INBOX", eml({ from: "anna@example.com", subject: "other" }), "1:20"));
    expect(a.messageId).not.toBe(b.messageId);

    const before = (await instancesOf()).find((i) => i.folder === "INBOX" && i.uid === 10)!;
    await makeDrizzleRepo(owned.db).recordInstance(b.messageId, { folder: "INBOX", ref: "1:10" });

    const inst = await instancesOf();
    const atTen = inst.filter((i) => i.folder === "INBOX" && i.uid === 10);
    expect(atTen).toHaveLength(1);
    expect(atTen[0]!.messageId).toBe(a.messageId);
    expect(atTen[0]!.isPrimary).toBe(true);
    // NOT ONE FIELD of the other message's row moved — `last_seen_at` included. That is what the
    // `setWhere` guard buys: the conflict is a complete no-op rather than a write another account's
    // sender could aim by choosing when to deliver. Remove `setWhere` and `lastSeenAt` advances here.
    expect(atTen[0]!.lastSeenAt.toISOString()).toBe(before.lastSeenAt.toISOString());
  });

  it("upgradeDedupKey declines rather than raising 23505 when the fp1 row already exists", async () => {
    // `UNIQUE (mailbox_id, dedup_key)` is still the constraint (the ruling forbids moving it), so a
    // bare UPDATE would raise 23505 if a concurrent ingest had already written the `fp1:` row — and
    // 23505 inside the ingest transaction aborts the whole commit, losing the message for that cycle
    // rather than merely skipping an upgrade.
    await world();
    const raw = eml();
    const legacyId = await seedLegacy(raw);
    const fp = fingerprintDedupKey(messageFingerprint(await normalizeMime(raw)));
    // A second row already holding the destination key.
    await owned.db.insert(messages).values({
      accountId, mailboxId, bodyHash: "h", dedupKey: fp, subject: "s", fromAddress: "a@b.test",
    });

    const moved = await makeDrizzleRepo(owned.db)
      .upgradeDedupKey(legacyId, legacyDedupKey((await normalizeMime(raw)).canonical), fp);

    expect(moved).toBe(false);
    expect((await rowsOf()).find((r) => r.id === legacyId)!.dedupKey).toBe("mid:legacy-1@example.com");
  });

  it("setFolderConflict raises the flag WITHOUT touching desired/observed/last_set_by", async () => {
    // `upsertFolderState` writes `conflict: false` on every call, so routing the conflict through it
    // would mean the next reconcile silently cleared the record. And the `set` here must not be able
    // to move placement: a second delivery changing `desired_folder` is the whole finding.
    await world();
    const raw = eml({ from: "anna@example.com" });
    const first = await ingest(create("INBOX", raw));
    const repo = makeDrizzleRepo(owned.db);
    await repo.upsertFolderState(first.messageId, {
      desiredFolder: "ohmail/Screener", observedFolder: "INBOX", lastSetBy: "us",
    });

    await repo.setFolderConflict(first.messageId, {
      desiredFolder: "Junk", observedFolder: "Junk", lastSetBy: "external",
    });

    const [state] = await owned.db.select().from(folderState)
      .where(eq(folderState.messageId, first.messageId));
    expect(state!.desiredFolder).toBe("ohmail/Screener");
    expect(state!.observedFolder).toBe("INBOX");
    expect(state!.lastSetBy).toBe("us");
    expect(state!.conflict).toBe(true);
  });

  it("insertMessage gives every new row its primary instance, in the same transaction", async () => {
    // The invariant that makes `primaryInstanceVanished` meaningful and `listKnownLocators` complete.
    // Remove the `setPrimaryInstance` call from `insertMessage` and the row is invisible to the
    // known-set: its body is re-fetched on every cycle, for ever.
    await world();
    const res = await ingest(create("INBOX", eml({ from: "anna@example.com" })));
    const inst = await instancesOf();
    expect(inst).toHaveLength(1);
    expect(inst[0]).toMatchObject({ messageId: res.messageId, folder: "INBOX", uid: 10, isPrimary: true });
    expect(String(inst[0]!.uidvalidity)).toBe("1");
    // The account and mailbox came from the MESSAGE, not from the caller — one place the isolation
    // boundary (the "Account isolation is absolute, and it binds staff too" invariant) is decided.
    expect(inst[0]!.accountId).toBe(accountId);
    expect(inst[0]!.mailboxId).toBe(mailboxId);
  });

  it("the attachment content digest reaches the column, and it is a real sha256", async () => {
    await world();
    const raw = Buffer.from([
      "Message-ID: <att-1@example.com>",
      "From: Anna@Example.COM", "To: mila@lichtgrat.example", "Subject: with a file",
      `Date: ${HEADER_DATE}`,
      'Content-Type: multipart/mixed; boundary="b"', "", "--b",
      "Content-Type: text/plain; charset=utf-8", "", "see attached", "", "--b",
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      "Content-Transfer-Encoding: base64", "", Buffer.from("PDF-BYTES").toString("base64"),
      "", "--b--", "",
    ].join("\r\n"));
    const res = await ingest(create("INBOX", raw));
    const rows = await owned.db.execute<{ content_sha256: string | null }>(sql`
      select content_sha256 from attachments where message_id = ${res.messageId}`);
    const digests = [...rows].map((r) => r.content_sha256);
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatch(/^[0-9a-f]{64}$/);
    // The digest of the DECODED bytes, not of the base64 — which is what makes it an identity for
    // the file rather than for one particular encoding of it.
    const { createHash } = await import("node:crypto");
    expect(digests[0]).toBe(createHash("sha256").update(Buffer.from("PDF-BYTES")).digest("hex"));
  });
});
