import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { mailboxFolders, messages } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { mailboxService } from "@trafficflow/services";
import { runSyncCycle } from "../src/sync.js";
import { makeHarness, rawClient, emlOf, imapCfg, dbUrlFor } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

const DB_URL = dbUrlFor(import.meta.url);

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A UIDVALIDITY RESET *DURING* A BOUNDED DRAIN — a high review finding
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The review finding is explicit about why this survived thousands of tests: "The existing single-message UIDVALIDITY
 * test and ordinary bounded-backfill test do not COMPOSE the two states, so neither detects this
 * loop." Both files below stand inside the composition.
 *
 * A reset is produced the honest way — by the DATABASE holding an epoch the server does not have,
 * which is precisely the state a server-side reset leaves behind and the only state the worker can
 * actually observe. GreenMail's epoch is fixed; the worker's belief about it is what is under test.
 *
 * Real Postgres, and the claims are about what is PERSISTED across passes.
 */
describe("UIDVALIDITY reset composed with a bounded drain (GreenMail + Postgres)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  /** The server's real epoch for INBOX, read without going through the worker's own cursor. */
  async function serverEpoch(cfg: ReturnType<typeof imapCfg>): Promise<bigint> {
    const c = await rawClient(cfg);
    const lock = await c.getMailboxLock("INBOX");
    try { return BigInt((c.mailbox as { uidValidity: bigint }).uidValidity); }
    finally { lock.release(); await c.logout(); }
  }

  async function appendAll(cfg: ReturnType<typeof imapCfg>, mids: string[]): Promise<void> {
    const c = await rawClient(cfg);
    // A KNOWN contact, so routing leaves every message in INBOX and the epoch question is not
    // confounded by moves.
    for (const mid of mids) await c.append("INBOX", emlOf({ from: "anna@x.example", subject: mid, messageId: mid }));
    await c.logout();
  }

  const midsIn = async (db: ReturnType<typeof import("@trafficflow/db/cloud").makeDb>, mailboxId: string): Promise<string[]> => {
    const rows = await db.select({ mid: messages.messageIdHeader })
      .from(messages).where(eq(messages.mailboxId, mailboxId));
    return rows.map((r) => r.mid ?? "").sort();
  };

  const inbox = async (db: ReturnType<typeof import("@trafficflow/db/cloud").makeDb>, mailboxId: string) => {
    const [row] = await db.select().from(mailboxFolders)
      .where(and(eq(mailboxFolders.mailboxId, mailboxId), eq(mailboxFolders.folder, "INBOX")));
    return row;
  };

  /**
   * THE LOOP. A stale epoch plus a batch cap smaller than the folder, which before that change re-fetched
   * the same newest slice on every pass — for ever — because a truncated batch held the whole
   * cursor at its previous value, epoch included, and the next pass therefore asked the identical
   * question. New mail arrives newest-first, so it can keep displacing the tail the drain never
   * reaches.
   */
  it("drains a reset larger than one batch instead of re-reading the same slice for ever", async () => {
    const cfg = imapCfg();
    const h = await makeHarness(cfg);
    closers.push(() => h.adapter.close());
    await appendAll(cfg, ["r1@x.example", "r2@x.example", "r3@x.example"]);

    // ONE message per batch, so three messages need three passes and every pass is truncated.
    const bounded = new ImapAdapter(cfg, { maxBatchMessages: 1 });
    await bounded.connect();
    closers.push(() => bounded.close());

    // The database believes the folder is one epoch behind the server: a reset, as the worker sees
    // one. Non-zero watermarks, because that is what a mailbox that had been syncing looks like.
    const epoch = await serverEpoch(cfg);
    await h.db.insert(mailboxFolders).values({
      mailboxId: h.mailboxId, folder: "INBOX",
      uidvalidity: epoch - 1n, uidnext: 1n, highestmodseq: 1n,
    });

    const deps = { repo: h.repo, adapter: bounded, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };
    for (let i = 0; i < 4; i++) await runSyncCycle(deps);

    // EVERY message, not just the newest one. Before that change this was the newest message alone after any number
    // of passes.
    expect(await midsIn(h.db, h.mailboxId)).toEqual(["r1@x.example", "r2@x.example", "r3@x.example"]);

    // …and the reset is LEARNED: the row now names the server's epoch and its watermark is past
    // every UID, so the drain has finished rather than merely made progress.
    const row = await inbox(h.db, h.mailboxId);
    expect(String(row!.uidvalidity)).toBe(String(epoch));
    expect(Number(row!.uidnext)).toBeGreaterThan(3);

    // A further pass ingests nothing and does not owe a backlog — the loop is closed, not slowed.
    await expect(runSyncCycle(deps)).resolves.toEqual({ hasBacklog: false, owesFiling: false });
    expect(await midsIn(h.db, h.mailboxId)).toHaveLength(3);
  }, 40000);

  /**
   * THE SILENT SKIP, which is the dangerous half.
   *
   * A cold or truncated drain deliberately persists the sentinel folder cursor `uidValidity: "0"`
   * while the message locators it has already committed carry a real epoch. If the server resets
   * before that drain finishes, the sentinel cannot express an epoch mismatch — so a message
   * whose server REUSED one of those UID numbers was treated as already known, its body was never
   * fetched, and when the enumeration drained the cursor was persisted past it. Permanently.
   *
   * UID reuse is not exotic: a new epoch commonly allocates again from low numbers, which is
   * exactly what the collision below models.
   */
  it("fetches a second-generation message whose UID number was reused, across the sentinel cursor", async () => {
    const cfg = imapCfg();
    const h = await makeHarness(cfg);
    closers.push(() => h.adapter.close());
    await appendAll(cfg, ["s1@x.example", "s2@x.example", "s3@x.example"]);
    const epoch = await serverEpoch(cfg);

    // The state a truncated cold drain leaves: the SENTINEL epoch on the folder row…
    await h.db.insert(mailboxFolders).values({
      mailboxId: h.mailboxId, folder: "INBOX",
      uidvalidity: 0n, uidnext: 0n, highestmodseq: 0n,
    });
    // …beside a committed locator from the PREVIOUS epoch whose UID number the new epoch reused.
    // GreenMail numbers a fresh INBOX from 1, so UID 2 is the second appended message.
    const collidingUid = 2;
    await h.db.insert(messages).values({
      accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP,
      messageIdHeader: "stale@old-epoch", bodyHash: "h", dedupKey: "mid:stale@old-epoch",
      nativeLocator: { folder: "INBOX", ref: `${epoch - 1n}:${collidingUid}` },
    });

    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };
    await runSyncCycle(deps);

    // THE ASSERTION THE SKIP FAILED: the message sitting at the reused UID has a body in the
    // database. Before that change the second message was simply absent, for the life of the mailbox.
    const mids = await midsIn(h.db, h.mailboxId);
    expect(mids).toContain("s2@x.example");
    expect(mids).toEqual(["s1@x.example", "s2@x.example", "s3@x.example", "stale@old-epoch"].sort());

    // The reset is learned in the same pass, and the stale-epoch locator is NOT counted as known
    // afterwards, so a second pass neither re-fetches nor duplicates.
    expect(String((await inbox(h.db, h.mailboxId))!.uidvalidity)).toBe(String(epoch));
    await runSyncCycle(deps);
    expect(await midsIn(h.db, h.mailboxId)).toHaveLength(4);
  }, 40000);

  /**
   * THE SAME SKIP WITH NO SENTINEL IN SIGHT — and this is the likelier shape of the two.
   *
   * Deletes are cursor-only, so a message that vanished in a reset keeps its
   * old-epoch locator in `messages` for the life of the mailbox. Once the reset is LEARNED the
   * folder row names the new epoch, the adapter's own `uidValidityChanged` test is therefore
   * false — and a bare `uid` from that stale row silences whatever the new epoch has since put at
   * the same number. No drain, no sentinel, no race: just an old row and a reused number.
   */
  it("does not let a stale-epoch locator silence a live message at the same UID", async () => {
    const cfg = imapCfg();
    const h = await makeHarness(cfg);
    closers.push(() => h.adapter.close());
    await appendAll(cfg, ["t1@x.example", "t2@x.example", "t3@x.example"]);
    const epoch = await serverEpoch(cfg);

    // The reset is already learned: the row names the CURRENT epoch…
    await h.db.insert(mailboxFolders).values({
      mailboxId: h.mailboxId, folder: "INBOX",
      uidvalidity: epoch, uidnext: 1n, highestmodseq: 0n,
    });
    // …while one locator from the previous epoch survives at UID 2, which holds the second message today.
    await h.db.insert(messages).values({
      accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP,
      messageIdHeader: "ghost@old-epoch", bodyHash: "h", dedupKey: "mid:ghost@old-epoch",
      nativeLocator: { folder: "INBOX", ref: `${epoch - 1n}:2` },
    });

    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };
    await runSyncCycle(deps);

    expect(await midsIn(h.db, h.mailboxId))
      .toEqual(["ghost@old-epoch", "t1@x.example", "t2@x.example", "t3@x.example"]);
  }, 40000);

  /**
   * RESTARTABLE, which is the property the review asks for by name.
   *
   * The per-message commits and the cursor write are separate durable events, so a crash between
   * them leaves the sentinel epoch on the row beside locators that carry a real one. The known-set
   * must still be usable across that window, or the drain re-fetches what it already committed and
   * spends its whole batch budget doing so — a bounded drain that cannot advance is the same
   * outage as the loop above, arrived at from the other side.
   *
   * This is the case the folder row cannot answer and only the LOCATORS can.
   */
  it("makes progress when the sentinel row outlived the commits it belongs to", async () => {
    const cfg = imapCfg();
    const h = await makeHarness(cfg);
    closers.push(() => h.adapter.close());
    await appendAll(cfg, ["c1@x.example", "c2@x.example", "c3@x.example"]);

    const bounded = new ImapAdapter(cfg, { maxBatchMessages: 1 });
    await bounded.connect();
    closers.push(() => bounded.close());
    const deps = { repo: h.repo, adapter: bounded, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };

    await runSyncCycle(deps);
    expect(await midsIn(h.db, h.mailboxId)).toHaveLength(1);

    // The crash: the message committed, the cursor write did not. Put the row back to the sentinel.
    await h.db.update(mailboxFolders).set({ uidvalidity: 0n })
      .where(and(eq(mailboxFolders.mailboxId, h.mailboxId), eq(mailboxFolders.folder, "INBOX")));

    // One pass. It must spend its single-message budget on the NEXT message, not re-fetch the one
    // it already holds.
    await runSyncCycle(deps);
    expect(await midsIn(h.db, h.mailboxId)).toHaveLength(2);
  }, 40000);

  /**
   * The ordinary bounded backfill, unchanged. `epochAware` rewrites a held cursor ONLY when the
   * server's epoch differs from the one the cursor names; a same-epoch drain must keep holding its
   * `uidNext`, because `fetchCapped` sorts newest-first and slices, so the highest UID a truncated
   * pass ingested sits ABOVE unknown lower UIDs it did not fetch. On Sent — the one folder that
   * READS this field — a watermark above unfetched mail means that mail is never enumerated again,
   * and `own_copy` guarantees no row will ever exist to notice. So this assertion is the standing
   * refusal of "carry forward max(ingested UID)", not bookkeeping.
   *
   * `highestmodseq` used to be asserted here too, for the same stated reason, and that reason was
   * wrong for it: creates come from the known-set diff, which is a strict superset of what
   * `changedSince` could report, so no modseq can hide an unfetched create. The two reasons that
   * ARE real — a truncated FLAG pass, and a server with no CONDSTORE — are guarded by name in
   * `packages/core/test/adapters/imap.changes.flagbudget.test.ts` and in the test immediately
   * below.
   */
  it("still holds uidNext through a same-epoch truncated drain", async () => {
    const cfg = imapCfg();
    const h = await makeHarness(cfg);
    closers.push(() => h.adapter.close());
    await appendAll(cfg, ["k1@x.example", "k2@x.example", "k3@x.example"]);

    const bounded = new ImapAdapter(cfg, { maxBatchMessages: 1 });
    await bounded.connect();
    closers.push(() => bounded.close());
    const deps = { repo: h.repo, adapter: bounded, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };

    // Pass 1 from cold: one message, and the epoch is now recorded (that is the fix) while
    // the enumeration watermark stays the untouched sentinel zero.
    await expect(runSyncCycle(deps)).resolves.toEqual({ hasBacklog: true, owesFiling: false });
    const held = await inbox(h.db, h.mailboxId);
    expect(String(held!.uidvalidity)).toBe(String(await serverEpoch(cfg)));
    expect(Number(held!.uidnext)).toBe(0);

    // …and the drain still finishes, in bounded passes, with the watermark published only at the end.
    for (let i = 0; i < 3; i++) await runSyncCycle(deps);
    expect(await midsIn(h.db, h.mailboxId)).toEqual(["k1@x.example", "k2@x.example", "k3@x.example"]);
    expect(Number((await inbox(h.db, h.mailboxId))!.uidnext)).toBeGreaterThan(3);
  }, 40000);

  /**
   * THE FIRST OF `highestmodseq`'s TWO REAL REASONS: NEVER PUBLISH A BASELINE THE FALLBACK PATH
   * CANNOT USE.
   *
   * This is a NEW consumer of the `"0"` that used to be asserted above with a refuted reason, and
   * it is server-shaped rather than policy-shaped: GreenMail does not advertise CONDSTORE
   * (`* CAPABILITY IMAP4rev1 LITERAL+ UIDPLUS SORT IDLE MOVE QUOTA`), so there is no fast path to
   * hand a baseline to. The capability is asserted here rather than assumed, because the whole
   * claim is conditional on it.
   *
   * **AND THIS TEST DOES NOT GUARD THE `!caps.condstore` TERM — measured, not assumed.** Deleting
   * that term leaves this green, because GreenMail reports no HIGHESTMODSEQ either, so
   * `String(mb.highestModseq ?? 0n)` is `"0"` as well and the outcome is over-determined. What
   * fails without the term is the CONDSTORE-fake companion in
   * `packages/core/test/adapters/imap.changes.flagbudget.test.ts` (`'60'` published where `"0"`
   * belongs) — and, here, the promotion test below, whose planted baseline gets overwritten by
   * that `"0"`. This test pins the OUTCOME against a real fallback-path server; the term itself is
   * guarded there.
   */
  it("publishes no CONDSTORE baseline on a server that has no CONDSTORE", async () => {
    const cfg = imapCfg();
    const h = await makeHarness(cfg);
    closers.push(() => h.adapter.close());
    await appendAll(cfg, ["n1@x.example", "n2@x.example", "n3@x.example"]);

    const bounded = new ImapAdapter(cfg, { maxBatchMessages: 1 });
    await bounded.connect();
    closers.push(() => bounded.close());
    expect((await bounded.capabilities()).condstore, "GreenMail advertises no CONDSTORE").toBe(false);

    const deps = { repo: h.repo, adapter: bounded, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };
    // Truncated pass, then a drained one: neither may invent a baseline.
    await expect(runSyncCycle(deps)).resolves.toEqual({ hasBacklog: true, owesFiling: false });
    expect(String((await inbox(h.db, h.mailboxId))!.highestmodseq)).toBe("0");
    for (let i = 0; i < 3; i++) await runSyncCycle(deps);
    expect(await midsIn(h.db, h.mailboxId)).toEqual(["n1@x.example", "n2@x.example", "n3@x.example"]);
    expect(String((await inbox(h.db, h.mailboxId))!.highestmodseq)).toBe("0");
  }, 40000);

  /**
   * A `"0" → V` PROMOTION IS NOT A RESET — and the persistence half of the fix.
   *
   * `epochAware` fires on `observed !== fc.uidValidity`, which is true for an epoch-to-epoch reset and
   * equally true for a folder whose cursor could not yet NAME an epoch. Both arms zeroed the
   * watermarks, and `(real epoch, 0, 0)` is the cold-start state of every mailbox big enough to
   * truncate — with `highestmodseq = 0` the one value at which `canFastPath` is false. So a mailbox
   * that truncates on every pass had its baseline deleted by the worker as fast as the adapter
   * published it, and never mirrored inbound read-state at all.
   *
   * The baseline below is PLANTED rather than earned, and that is a real limitation of this file:
   * GreenMail has no CONDSTORE, so nothing here can produce a non-zero `mb.highestModseq`. What it
   * does prove is the half that only Postgres can answer — that the worker PERSISTS what the
   * adapter handed it across a `"0" → V` promotion instead of zeroing it. The earned shape is
   * `imap.changes.flagbudget.test.ts`'s CONDSTORE fake.
   *
   * Mutation: drop the `fc.uidValidity === "0"` clause from `epochAware` — the row comes back with
   * `highestmodseq = 0`.
   */
  it("keeps the watermarks it was handed across a 0 → V epoch promotion; only a real reset zeroes them", async () => {
    const cfg = imapCfg();
    const h = await makeHarness(cfg);
    closers.push(() => h.adapter.close());
    await appendAll(cfg, ["p1@x.example", "p2@x.example", "p3@x.example"]);
    const epoch = await serverEpoch(cfg);

    // The sentinel shape, with a modseq baseline standing where a CONDSTORE server's would be.
    // No locators exist yet, so `soleEpochOf` cannot name an epoch either and the cursor handed to
    // the adapter really is `uidValidity: "0"`.
    await h.db.insert(mailboxFolders).values({
      mailboxId: h.mailboxId, folder: "INBOX",
      uidvalidity: 0n, uidnext: 0n, highestmodseq: 5n,
    });

    const bounded = new ImapAdapter(cfg, { maxBatchMessages: 1 });
    await bounded.connect();
    closers.push(() => bounded.close());
    const deps = { repo: h.repo, adapter: bounded, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };

    await expect(runSyncCycle(deps)).resolves.toEqual({ hasBacklog: true, owesFiling: false });

    const row = await inbox(h.db, h.mailboxId);
    // The epoch is LEARNED — that half is the earlier fix and must not regress…
    expect(String(row!.uidvalidity)).toBe(String(epoch));
    // …and the baseline SURVIVES the promotion, which is.
    expect(String(row!.highestmodseq)).toBe("5");
    // …while `uidNext` is still held at the value a truncated pass may publish, i.e. the old one.
    expect(Number(row!.uidnext)).toBe(0);

    // A GENUINE reset still zeroes: same folder, now naming an epoch the server does not have.
    await h.db.update(mailboxFolders).set({ uidvalidity: epoch - 1n, uidnext: 9n, highestmodseq: 7n })
      .where(and(eq(mailboxFolders.mailboxId, h.mailboxId), eq(mailboxFolders.folder, "INBOX")));
    await runSyncCycle(deps);
    const afterReset = await inbox(h.db, h.mailboxId);
    expect(String(afterReset!.uidvalidity)).toBe(String(epoch));
    expect(Number(afterReset!.uidnext)).toBe(0);
    expect(String(afterReset!.highestmodseq)).toBe("0");
  }, 40000);

  /**
   * THE REACHABLE RE-ENTRY, and the reason this slice ships while the defect is latent.
   *
   * `MailboxService.requestResync` nulls `highestmodseq` on user demand
   * (`packages/services/src/mailbox-service.ts`), `getMailboxFolders` maps that null to the string
   * `"0"`, and `"0"` is exactly where `canFastPath` is false. So one click on a mailbox that
   * truncates every pass used to disable its inbound read-state mirror permanently. The service is
   * CALLED here rather than its UPDATE re-typed, because the shape is the claim.
   */
  it("survives requestResync: it nulls only highestmodseq, and the cursor reads that as \"0\"", async () => {
    const cfg = imapCfg();
    const h = await makeHarness(cfg);
    closers.push(() => h.adapter.close());
    await appendAll(cfg, ["q1@x.example", "q2@x.example"]);

    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };
    await runSyncCycle(deps);
    const before = await inbox(h.db, h.mailboxId);
    expect(Number(before!.uidnext), "a drained pass publishes the server's UIDNEXT").toBeGreaterThan(2);

    await mailboxService.requestResync(
      { db: h.db, accountId: h.accountId, userId: null, now: () => new Date(), requestId: "w-cursor" },
      h.mailboxId,
    );

    const after = await inbox(h.db, h.mailboxId);
    expect(after!.highestmodseq).toBeNull();
    expect(Number(after!.uidnext), "the enumeration watermark is untouched").toBe(Number(before!.uidnext));
    // …and this is the value the adapter then sees, i.e. the one that disables the fast path.
    const folders = await h.repo.getMailboxFolders(h.mailboxId);
    const inboxCursor = folders.find((f) => f.folder === "INBOX");
    expect(inboxCursor!.highestModseq).toBe("0");
    expect(inboxCursor!.uidNext).toBe(Number(before!.uidnext));
  }, 40000);
});

/** Silences the unused-import lint if the file is ever trimmed. */
void randomUUID;
