import { accountOfMessage } from "@trafficflow/db";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { accounts, mailboxes, contacts as contactsTbl, messages, messageInstances, folderState, changeLog, threads, attachments as attachmentsTbl } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "../../src/adapters/drizzle-repo.js";
import { planChange, commitChange , UNMETERED_STORAGE_CAP} from "../../src/pipeline.js";
import { normalizeMime } from "../../src/mime.js";
import { fingerprintDedupKey, messageFingerprint } from "../../src/identity.js";
import type { Change } from "../../src/ports.js";

/**
 * A MOVE IS COMPLETE WHEN THE SOURCE DISAPPEARS, NEVER WHEN A COPY APPEARS.
 *
 * ── THE SEQUENCE THIS FILE EXISTS FOR ────────────────────────────────────────────────────────
 *
 * On a server without RFC 6851 MOVE, `imap.ts#move` is COPY (phase 1) → verify (phase 2) →
 * EXPUNGE the source (phase 3). Those are three network operations and the split is across the
 * IMAP boundary, so NO isolation level can make them atomic. When phase 3 fails — a dropped
 * connection, a read-only source folder, a server that refuses the EXPUNGE — the message exists
 * TWICE: once at the source, once at the destination.
 *
 * The next sync cycle then observes the destination copy as an ordinary `create`, because its UID
 * is not in `listKnownLocators`. And before this slice the decision layer read that appearance as
 * the move having landed:
 *
 *   `dedup.ts`     `pendingMoveFolders.has(observed)` ⇒ `own_move`, purely from the FOLDER
 *   `reconciler.ts` `observedNow === desiredFolder`   ⇒ `none`, i.e. converged
 *   `pipeline.ts`  `updateLocator` repoints the primary instance to the copy, `folder_state`
 *                  lands `reconciled`, and the pending operation is GONE
 *
 * `ports.ts#MoveEvidence` already states the rule that forbids exactly this — "our own
 * pending-operation record ... says nothing about COMPLETION — completion is source absence"
 * — and nothing implemented it. The source copy was then owed to nobody: no pending row, no
 * conflict flag, and its locator vacated from `message_instances` by the repoint, so it came back
 * next cycle as a stranger. The user was left with a permanent duplicate in every mail client
 * they own.
 *
 * ── WHAT REPLACES IT ─────────────────────────────────────────────────────────────────────────
 *
 * The primary instance stays at the SOURCE, the destination copy is recorded as a second
 * instance, and `folder_state` stays PENDING. `reconcileFolders` therefore picks the row up again
 * and hands the source locator back to `imap.ts#move`, which reads the destination before it
 * writes: it finds the copy it already made, writes nothing, and performs the expunge it still
 * owed. That is the only sequence that ends with exactly one message on the server.
 *
 * The pre-check is what makes this safe. Withhold completion without it and the retry copies
 * again — one extra message at the destination every cycle, for ever.
 *
 * ── WHY REAL POSTGRES AND NOT PGlite ─────────────────────────────────────────────────────────
 *
 * The whole assertion is about `message_instances`, whose model is carried by
 * `UNIQUE (message_id) WHERE is_primary` — a PARTIAL index, the exact class of object CLAUDE.md
 * records PGlite misleading this repository about, and the class that hid the
 * `primaryInstanceVanished` correlated-subquery bug until a `*.pg.test.ts` ran. Every write below
 * touches that index: the repoint UPDATEs the primary row, the conflict path INSERTs a second
 * instance for the same message, and the healing path has to keep exactly one primary while a
 * second instance exists.
 */

const AVAILABLE = await realPgAvailable();

const SRC = "INBOX";
const DST = "ohmail/News";
/** The source UID, at epoch 1. Still on the server: phase 3 never expunged it. */
const SRC_REF = "1:10";
/** The destination UID the COPY produced, at the destination folder's own epoch. */
const DST_REF = "7:41";

function eml(body = "the ridge beam is 240mm"): Buffer {
  return Buffer.from([
    "Message-ID: <F3-copy-then-crash@example.com>",
    "From: anna@example.com",
    "To: mila@lichtgrat.example",
    "Subject: Roof detail",
    "Date: Tue, 14 Jul 2026 09:41:07 +0530",
    "Content-Type: text/plain; charset=utf-8",
    "", body,
  ].join("\r\n"));
}

/** One message carrying one attachment — so a duplicated child row is visible as a count. */
function emlWithAttachment(): Buffer {
  const b = "b14boundary";
  return Buffer.from([
    "Message-ID: <concurrent-move@example.com>",
    "From: anna@example.com",
    "To: mila@lichtgrat.example",
    "Subject: Roof detail with drawing",
    "Date: Tue, 14 Jul 2026 09:41:07 +0530",
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain; charset=utf-8",
    "", "the ridge beam is 240mm", "",
    `--${b}`,
    "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="ridge.pdf"',
    "Content-Transfer-Encoding: base64",
    "", "JVBERi0xLjQK", "",
    `--${b}--`, "",
  ].join("\r\n"));
}

const create = (folder: string, raw: Buffer, ref: string): Change =>
  ({ type: "create", locator: { folder, ref }, raw });

describe.skipIf(!AVAILABLE)("move completion requires source absence", () => {
  let owned: OwnedDb;
  let accountId: string;
  let mailboxId: string;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 180_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  async function world(): Promise<void> {
    accountId = randomUUID();
    await owned.db.insert(accounts).values({ id: accountId, name: `b14-${accountId.slice(0, 8)}` });
    const [mb] = await owned.db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: `${accountId}@b14.test` }).returning();
    mailboxId = mb!.id;
    // A known sender, so `evaluateRules` leaves placement alone and every assertion below is
    // about move completion rather than about the consent gate.
    await owned.db.insert(contactsTbl).values({ accountId, address: "anna@example.com" });
  }

  /**
   * The state `reconcileFolders` leaves behind when `adapter.move` throws in PHASE 3.
   *
   * COPY landed, so the destination holds a copy; EXPUNGE did not, so the source is still there.
   * `applyReconcileAction`/`reconcileFolders` never reached `updateLocator` or `upsertFolderState`,
   * so the row still points at the SOURCE and the move is still pending. That is the real
   * post-failure database state, seeded verbatim rather than described.
   */
  async function seedInterruptedMove(raw: Buffer): Promise<string> {
    const m = await normalizeMime(raw);
    const [row] = await owned.db.insert(messages).values({
      accountId, mailboxId,
      messageIdHeader: m.canonical.messageIdHeader,
      bodyHash: m.canonical.bodyHash,
      dedupKey: fingerprintDedupKey(messageFingerprint(m)),
      subject: m.subject,
      fromAddress: m.from.address,
      date: m.date,
      nativeLocator: { folder: SRC, ref: SRC_REF },
    }).returning({ id: messages.id });
    await owned.db.insert(messageInstances).values({
      accountId, mailboxId, messageId: row!.id, folder: SRC,
      uidvalidity: BigInt(SRC_REF.split(":")[0]!), uid: Number(SRC_REF.split(":")[1]),
      isPrimary: true,
    });
    await owned.db.insert(folderState).values({
      messageId: row!.id, accountId: accountOfMessage(row!.id), desiredFolder: DST, observedFolder: SRC,
      lastSetBy: "us", reconcileStatus: "pending", conflict: false,
    });
    return row!.id;
  }

  async function ingest(change: Change): Promise<{ outcome: string; messageId: string }> {
    const repo = makeDrizzleRepo(owned.db);
    const plan = await planChange(change, { repo, accountId, mailboxId, routing: repo });
    return owned.db.transaction(async (tx) => {
      const txRepo = makeDrizzleRepo(tx as never);
      return commitChange(plan, { repo: txRepo, routing: txRepo, accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP });
    });
  }

  const stateOf = async (messageId: string) =>
    (await owned.db.select().from(folderState).where(eq(folderState.messageId, messageId)))[0]!;

  const instancesOf = async () =>
    owned.db.select().from(messageInstances)
      .where(eq(messageInstances.accountId, accountId))
      .orderBy(messageInstances.folder, messageInstances.uid);

  const changesOf = async () =>
    owned.db.select().from(changeLog).where(eq(changeLog.accountId, accountId)).orderBy(changeLog.seq);

  const countMessages = async (): Promise<number> =>
    (await owned.db.select({ id: messages.id }).from(messages)
      .where(eq(messages.accountId, accountId))).length;

  // ── THE DEFECT, AS ONE CYCLE ────────────────────────────────────────────────────────────────

  it("keeps the primary at the source and records the copy, leaving the move owed", async () => {
    await world();
    const raw = eml();
    const id = await seedInterruptedMove(raw);

    // Cycle 1: the copy at the destination is an unknown locator, so the adapter emits it as a
    // create. The source did NOT vanish, so `batch.deletes` is empty and `correlateMoves` has
    // nothing to pair — `change.type` is "create" and the evidence is `appearance_only`.
    const res = await ingest(create(DST, raw, DST_REF));

    // Never re-ingested: this is one logical message, and it stays one row.
    expect(await countMessages()).toBe(1);
    expect(res.messageId).toBe(id);
    expect(res.outcome).toBe("own_move");

    // THE PRIMARY STAYS AT THE SOURCE. It is the locator `reconcileFolders` hands back to the
    // adapter, and the only one the surviving copy can be expunged from. Repointing at the
    // destination is what left the source addressable by nothing.
    const inst = await instancesOf();
    const primary = inst.filter((i) => i.isPrimary);
    expect(primary).toHaveLength(1);
    expect(primary[0]!.folder).toBe(SRC);
    expect(Number(primary[0]!.uid)).toBe(Number(SRC_REF.split(":")[1]));

    // And the destination copy is a locator we KNOW, so it is never re-fetched and never
    // rediscovered next cycle as a stranger.
    const atDst = inst.filter((i) => i.folder === DST);
    expect(atDst, "the destination copy must be recorded").toHaveLength(1);
    expect(atDst[0]!.isPrimary).toBe(false);
    expect(Number(atDst[0]!.uid)).toBe(Number(DST_REF.split(":")[1]));

    // Two physical instances of one logical message IS the conflict this column records — and it
    // has to be raised AFTER `upsertFolderState`, which writes `conflict` false on every call.
    const st = await stateOf(id);
    expect(st.conflict, "raised before the folder-state write, this is silently cleared").toBe(true);
    // STILL OWED. This is what puts the row back in `reconcileFolders`'s queue.
    expect(st.observedFolder).toBe(SRC);
    expect(st.desiredFolder).toBe(DST);

    // Our own move in flight is not an adoption and not a client-visible move.
    expect((await changesOf()).filter((c) => c.op === "move")).toHaveLength(0);
  });

  // ── AND IT MUST NOT DRIFT OVER REPEATED CYCLES ──────────────────────────────────────────────

  it("stays stable over three cycles: one row, one primary, one recorded copy", async () => {
    await world();
    const raw = eml();
    await seedInterruptedMove(raw);

    for (let cycle = 0; cycle < 3; cycle++) {
      await ingest(create(DST, raw, DST_REF));
    }

    expect(await countMessages()).toBe(1);
    const inst = await instancesOf();
    expect(inst, "no instance may accumulate per cycle").toHaveLength(2);
    expect(inst.filter((i) => i.isPrimary)).toHaveLength(1);
    expect(inst.find((i) => i.isPrimary)!.folder).toBe(SRC);

    // ── WHICH HALF OF THE RECORD IS DURABLE, MEASURED RATHER THAN ASSUMED ────────────────────
    //
    // The `message_instances` row is. Nothing deletes it but `forgetInstanceAt`, which fires only
    // on a real disappearance — so if the source copy genuinely goes away later, the record
    // self-heals, and until then this row IS the queryable "a source expunge is still owed":
    //
    //     a non-primary instance whose folder is not the message's `desired_folder`
    //
    // `folder_state.conflict` is NOT durable, and this test is where that was established rather
    // than assumed. It is raised at detection (asserted in the first case) but `upsertFolderState`
    // writes `conflict: false` unconditionally on every call — `setFolderConflict`'s own doc says
    // so — and cycle 2 re-observes the destination as an ordinary `duplicate`, which calls it. The
    // flag is therefore point-in-time for `own_move` exactly as it already was for that change slice 2's
    // `external_copy`; it is a UI signal, not the ledger.
    //
    // **Anything that needs to find these must query the instance table, never this flag.**
    // Asserting `conflict` here would have been asserting something the system does not provide.
    expect(inst.filter((i) => !i.isPrimary && i.folder === DST), "the DURABLE record")
      .toHaveLength(1);
    expect((await changesOf()).filter((c) => c.op === "move")).toHaveLength(0);
  });

  // ── THE PIN, AGAINST REAL POSTGRES ──────────────────────────────────────────────────────────

  it("PIN: stays pending — this may only converge again if imap.ts#move stops pre-checking", async () => {
    // The pair to the assertion in `pipeline.f3.test.ts`. Withholding completion is safe ONLY
    // while `imap.ts#move` reads the destination before it writes. Remove that pre-check and the
    // retry copies again: the destination gains an identical message every cycle, the fallback
    // verify (exactly one fingerprint match) then finds several and refuses for ever, and one
    // duplicate becomes an unbounded one. If the pre-check ever goes, this test must go back to
    // expecting `reconciled` / observed === DST.
    await world();
    const raw = eml();
    const id = await seedInterruptedMove(raw);

    await ingest(create(DST, raw, DST_REF));

    const st = await stateOf(id);
    expect(st.reconcileStatus, "a copy appearing is not the source disappearing")
      .toBe("pending");
    expect(st.desiredFolder).toBe(DST);
    expect(st.observedFolder).toBe(SRC);
  });

  // ── THE RACE: A DUPLICATE ARRIVES WHILE THE MOVE IS STILL OWED ──────────────────────────────

  it("a duplicate arriving during the withheld window neither completes nor re-ingests", async () => {
    // The window between a failed expunge and its retry is not empty — mail keeps being
    // delivered. A second copy of the SAME logical message landing in a third folder must not
    // look like anything: it is not a completion (nothing disappeared), it is not a new message
    // (same fingerprint, so the same `dedup_key` and the same row), and it must not steal the
    // primary away from the source that still owes an expunge.
    await world();
    const raw = eml();
    const id = await seedInterruptedMove(raw);

    await ingest(create(DST, raw, DST_REF));
    // A third physical copy shows up somewhere we never asked for.
    const res = await ingest(create("ohmail/Screened", raw, "9:77"));

    expect(res.messageId, "one fingerprint, one row").toBe(id);
    expect(await countMessages()).toBe(1);

    const st = await stateOf(id);
    expect(st.desiredFolder).toBe(DST);
    expect(st.observedFolder, "an arrival is not a disappearance").toBe(SRC);

    const inst = await instancesOf();
    const primary = inst.filter((i) => i.isPrimary);
    expect(primary).toHaveLength(1);
    expect(primary[0]!.folder, "the retry target must survive a stranger's delivery").toBe(SRC);
    // Every copy known, so none of them is ever re-downloaded.
    expect(inst).toHaveLength(3);
    expect((await changesOf()).filter((c) => c.op === "move")).toHaveLength(0);
  });

  // ── TWO ORGANIZERS ENTERING THE WITHHELD MOVE AT ONCE ───────────────────────────────────────

  it("two cycles racing the same withheld move leave one row, one primary, and no extra instance", async () => {
    // The organizer lease is a LEASE, NOT A MUTEX — `organizer-lease.ts` says so in as many
    // words: IMAP has no compare-and-swap, two installs can APPEND in the same instant, and what
    // the mechanism buys is detection plus every-cycle re-verification. A transient one-cycle
    // overlap is therefore reachable, and that file's claim that the overlap is "idempotent-safe"
    // was written about the behaviour this slice replaced — the second engine observing a locator
    // the first recorded used to be a placement-free `external_copy`. The withheld move is a NEW
    // intermediate state (primary on the source, a non-primary at the destination, the row still
    // pending), so the claim has to be re-earned rather than inherited.
    //
    // Both cycles PLAN against the same pre-state and only then COMMIT, concurrently on separate
    // connections. Planning both first is what makes this a race rather than a sequence: each one
    // decides `own_move` + `appearance_only` without seeing the other's writes.
    await world();
    const raw = eml();
    const id = await seedInterruptedMove(raw);
    const change = create(DST, raw, DST_REF);

    const repo = makeDrizzleRepo(owned.db);
    const planA = await planChange(change, { repo, accountId, mailboxId, routing: repo });
    const planB = await planChange(change, { repo, accountId, mailboxId, routing: repo });

    const commit = (plan: Awaited<ReturnType<typeof planChange>>) =>
      owned.db.transaction(async (tx) => {
        const txRepo = makeDrizzleRepo(tx as never);
        return commitChange(plan, { repo: txRepo, routing: txRepo, accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP });
      });

    // `allSettled`, deliberately. A serialization or unique-violation rejection is an ACCEPTABLE
    // outcome — the caller's next cycle retries — whereas corrupt state is not. So the assertions
    // below are about the state that results, not about both commits succeeding.
    const settled = await Promise.allSettled([commit(planA), commit(planB)]);
    expect(settled.some((s) => s.status === "fulfilled"), "at least one cycle must land").toBe(true);
    // Measured, not assumed: BOTH commits run to completion here — the second is not short-circuited
    // by a constraint, it genuinely re-does every write against the first one's committed state.
    // That is what makes the assertions below coverage rather than coincidence. If a future change
    // makes one of these reject, the outcome is still acceptable (the next cycle retries) but this
    // test has stopped proving what it claims, so it fails loudly instead of quietly weakening.
    expect(settled.map((s) => s.status), "both cycles must complete for this to be a real race")
      .toEqual(["fulfilled", "fulfilled"]);

    expect(await countMessages(), "a race must not mint a second row").toBe(1);

    const inst = await instancesOf();
    expect(inst, "one source primary, one destination record, no duplicates").toHaveLength(2);
    const primary = inst.filter((i) => i.isPrimary);
    expect(primary).toHaveLength(1);
    expect(primary[0]!.folder, "neither cycle may steal the retry target").toBe(SRC);
    expect(inst.filter((i) => !i.isPrimary && i.folder === DST)).toHaveLength(1);

    // And the move is still owed exactly once — not completed by whichever cycle finished last.
    const st = await stateOf(id);
    expect(st.desiredFolder).toBe(DST);
    expect(st.observedFolder).toBe(SRC);
    expect((await changesOf()).filter((c) => c.op === "move")).toHaveLength(0);
  });

  // ── AND THE REPAIR ITSELF, END TO END ───────────────────────────────────────────────────────

  it("the retry completes the move: source forgotten, primary at the destination, one row", async () => {
    // What `reconcileFolders` does on the next pass once the adapter has expunged the source:
    // `updateLocator` to the destination, then `upsertFolderState` converged. The interesting
    // part is `setPrimaryInstance` having to absorb the non-primary row the withheld cycle
    // recorded at that exact tuple — `UNIQUE (mailbox_id, folder, uidvalidity, uid)` would
    // otherwise abort the whole transaction.
    await world();
    const raw = eml();
    const id = await seedInterruptedMove(raw);
    await ingest(create(DST, raw, DST_REF));

    const repo = makeDrizzleRepo(owned.db);
    await repo.updateLocator(id, { folder: DST, ref: DST_REF });
    await repo.upsertFolderState(id, {
      desiredFolder: DST, observedFolder: DST, lastSetBy: "us",
    });
    // The source is gone now, so the next cycle's `batch.deletes` retires its instance.
    await repo.forgetInstanceAt(mailboxId, { folder: SRC, ref: SRC_REF });

    expect(await countMessages()).toBe(1);
    const inst = await instancesOf();
    expect(inst, "exactly one surviving instance").toHaveLength(1);
    expect(inst[0]!.isPrimary).toBe(true);
    expect(inst[0]!.folder).toBe(DST);
    expect(Number(inst[0]!.uid)).toBe(Number(DST_REF.split(":")[1]));

    const st = await stateOf(id);
    expect(st.reconcileStatus).toBe("reconciled");
    expect(st.observedFolder).toBe(DST);
  });

  // ── THE HEALED CASE: THE SOURCE REALLY DID GO ───────────────────────────────────────────────

  it("converges once the source has actually disappeared", async () => {
    await world();
    const raw = eml();
    const id = await seedInterruptedMove(raw);

    // The worker records the disappearance from `batch.deletes` — the ONLY writer of an absence,
    // and only at the live epoch. This is `forgetInstanceAt`, exactly as `sync.ts` calls it.
    const repo = makeDrizzleRepo(owned.db);
    await repo.forgetInstanceAt(mailboxId, { folder: SRC, ref: SRC_REF });

    const res = await ingest(create(DST, raw, DST_REF));

    expect(await countMessages()).toBe(1);
    expect(res.messageId).toBe(id);
    // NOW the move is complete: the source is gone, which is the only evidence that counts.
    const st = await stateOf(id);
    expect(st.reconcileStatus).toBe("reconciled");
    expect(st.observedFolder).toBe(DST);
    expect(st.desiredFolder).toBe(DST);

    // A GENUINE completion records nothing: there is no second copy to record, and raising
    // `conflict` here would report a duplicate the user does not have.
    const inst = await instancesOf();
    expect(inst).toHaveLength(1);
    expect(inst[0]!.isPrimary).toBe(true);
    expect(inst[0]!.folder).toBe(DST);
    expect(st.conflict, "a real move leaves no conflict").toBe(false);
  });

  // ── CONCURRENT INGEST OF ONE MESSAGE FROM TWO CYCLES ────────────────────────────────────────
  //
  // Two sync cycles can observe the same mail at once — a restarted worker overlapping the
  // outgoing one, or a LOCAL install and Cloud both holding the organizer lease during the
  // hand-over `organizer-lease.ts` describes. Both call `planChange` before either commits, so
  // BOTH plan `new`, and `insertMessage`'s `ON CONFLICT DO NOTHING` on
  // `UNIQUE (mailbox_id, dedup_key)` decides which one actually inserts.
  //
  // PGlite is structurally incapable of testing this: it is a single connection, so two `await`ed
  // calls in one process are sequential and the loser branch is never taken.

  it("two cycles ingesting one message: one row, one create delta, no duplicated child rows", async () => {
    await world();
    const raw = emlWithAttachment();

    const repo = makeDrizzleRepo(owned.db);
    const ch = create(SRC, raw, "1:55");
    // BOTH plans are computed before EITHER commits — that is the race, and computing them
    // sequentially would be a test that cannot fail.
    const [planA, planB] = await Promise.all([
      planChange(ch, { repo, accountId, mailboxId, routing: repo }),
      planChange(ch, { repo, accountId, mailboxId, routing: repo }),
    ]);
    expect(planA.outcome, "both cycles must see an unseen message").toBe("new");
    expect(planB.outcome).toBe("new");

    const commit = (plan: typeof planA) => owned.db.transaction(async (tx) => {
      const txRepo = makeDrizzleRepo(tx as never);
      return commitChange(plan, { repo: txRepo, routing: txRepo, accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP });
    });
    const [resA, resB] = await Promise.all([commit(planA), commit(planB)]);

    // The constrained key is correct, so the two observations CONVERGE on one row.
    expect(await countMessages()).toBe(1);
    expect(resA.messageId, "the loser must return the winner's row, not its own").toBe(resB.messageId);

    // THE LOSER MUST NOT DESTROY THE WINNER'S ROW — and it must not write a second copy of the
    // winner's CHILD rows either. `insertMessage` returns the existing row on conflict, so
    // everything after it in `commitChange` runs a second time against the SAME message id.
    const att = await owned.db.select().from(attachmentsTbl)
      .where(eq(attachmentsTbl.messageId, resA.messageId));
    expect(att, "the attachment row must not be written once per concurrent cycle").toHaveLength(1);

    const created = (await changesOf())
      .filter((c) => c.entityType === "message" && c.op === "create");
    expect(created, "one message is one create delta, or the client materializes it twice")
      .toHaveLength(1);

    // One logical message is one conversation, whichever cycle got there first.
    expect(await owned.db.select().from(threads).where(eq(threads.accountId, accountId)))
      .toHaveLength(1);

    // And exactly one physical instance is claimed, by the row that won.
    const inst = await instancesOf();
    expect(inst).toHaveLength(1);
    expect(inst[0]!.isPrimary).toBe(true);
  });
});
