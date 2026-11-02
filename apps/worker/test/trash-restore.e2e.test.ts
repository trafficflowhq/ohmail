import { NO_TRUSTED_AUTHSERV_IDS, UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { changeLog, contacts, folderState, mailboxes, mailboxFolders, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { MessageService, type ServiceContext } from "@trafficflow/services";
import { runSyncCycle, type SyncDeps } from "../src/sync.js";
import { byMessageId, imapCfg, rawClient, emlOf, uidInFolder, ORGANIZER_CONSENT } from "./_workerenv.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FIXTURE_DOOR, FIXTURE_LEASE } from "./_door.js";

/**
 * DELETE → TRASH → RESTORE, END TO END AGAINST A REAL MAIL SERVER (mail 0099).
 *
 * ══ WHAT THIS PROVES THAT NOTHING ELSE CAN ══════════════════════════════════════════════════
 *
 * The restore's whole design is that it writes ONE row and lets the ordinary machinery finish
 * the job: the reconciler performs the IMAP move, the passive read observes the message in the
 * target, `clearDeletedOnAdopt` clears the tombstone, and the arrival emits the change that puts
 * the row back in the client's mirror. Every step of that is somebody else's code. A unit test
 * can prove the row is written; only this can prove the four steps behind it still compose —
 * which is exactly the class of failure this repository keeps paying for (a reliability feature
 * that renders as its own healthy state).
 *
 * So the sequence is driven and READ AT THE SERVER at each stage:
 *
 *   1. ingest a message into INBOX;
 *   2. `MessageService.delete` — desired = Trash, `trashed_from` = INBOX, the row tombstoned,
 *      and NOTHING moved on the server yet (the API opens no IMAP connection);
 *   3. one sync cycle — the copy is physically in the server's Trash, gone from INBOX;
 *   4. `MessageService.restore` — desired = INBOX, `trashed_from` cleared, and the tombstone
 *      STILL STANDING (the mailbox is the master);
 *   5. one sync cycle — the copy is back in INBOX, `deleted_at` is null because the completion
 *      writer clears it on a landed move that did not go to Trash, the message is back in the
 *      list it came from through `GET /messages`, and a change row is there for a client's
 *      drain to re-materialize the entity from.
 *
 * ══ A PRIVATE DATABASE, AND WHY ═════════════════════════════════════════════════════════════
 *
 * This lane carries a mail migration. A run against the shared `trafficflow_test` records its
 * `when` there, and drizzle then applies only a `when` strictly above it — so every LOWER
 * migration in the release chain is recorded as applied WITHOUT running, the row says applied
 * and the column does not exist, and nothing raises. Measured on another lane: fourteen box
 * reds, not one of them a defect in the lane they were reported against.
 */
let DB: string;

const ctxOf = (db: ReturnType<typeof makeDb>, accountId: string): ServiceContext => ({
  db, accountId, userId: null, now: () => new Date(), requestId: "trash-e2e",
});

describe("delete → Trash → restore, against real GreenMail", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_trash"); }, 60000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("the copy rides to the server's Trash and comes back, and the row is live again", async () => {
    const cfg = imapCfg();
    const db = makeDb(DB);
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: cfg.auth.user, ...ORGANIZER_CONSENT,
    }).returning();
    const mailboxId = mb!.id;
    /* THE SENDER IS A KNOWN CONTACT, so the message stays in INBOX after ingest instead of
       going to the Screener. Learned from this test failing: without the contact row the ingest
       screened the message and the delete correctly recorded `trashed_from = ohmail/Screener`
       — the product was right and the FIXTURE was wrong, which is why the round trip under test
       is INBOX → Trash → INBOX and the contact is seeded rather than the expectation loosened. */
    await db.insert(contacts).values({ accountId, address: "anna@x.example" });
    const repo = makeDrizzleRepo(db);
    const adapter = new ImapAdapter(cfg);
    await adapter.connect();
    closers.push(() => adapter.close());
    await adapter.ensureFolders(FIXTURE_DOOR);

    /* THE PROVIDER'S OWN TRASH, created on the server and then DISCOVERED the way production
       discovers it — `findSpecialFolders` at attach, written to the mailbox row. Setting the
       column by hand would be a fixture that agrees with itself: the whole reason the API can
       refuse a delete up front is that this discovery ran. */
    const raw = await rawClient(cfg);
    closers.push(async () => { await raw.logout(); });
    await raw.mailboxCreate("Trash").catch(() => {});
    const special = await adapter.findSpecialFolders();
    expect(special.trash, "the discovery found the folder that was just created").toBeTruthy();
    await repo.setMailboxSpecialFolders!(mailboxId, {
      junkFolder: special.junk, trashFolder: special.trash, sentFolder: null,
    });
    const trashPath = special.trash!;

    /* The cycle's own required deps, spelled rather than left to `undefined`: `role` is what
       decides whether this cycle may write to the mailbox at all, and this case is the organizer's.
       An empty trusted-authserv set is the default every sibling here uses. */
    /* ANNOTATED, and that is not decoration: in an unannotated object literal the cap's
       `unique symbol` widens to `symbol` and stops matching `StorageCap`. A literal passed
       straight to the call keeps it; one held in a `const` does not. */
    const deps: SyncDeps = {
      repo, adapter, accountId, mailboxId, role: "organizer",
      trustedAuthservIds: NO_TRUSTED_AUTHSERV_IDS, storageCap: UNMETERED_STORAGE_CAP,
      // No lease is taken in this fixture, and `writeAuthority` is required, so it says so rather
      // than leaving the field out — an omission is the shape the required field exists to refuse.
      writeAuthority: FIXTURE_LEASE,
    };

    // ── 1. INGEST ────────────────────────────────────────────────────────────────────────────
    await raw.append("INBOX", emlOf({ from: "anna@x.example", subject: "keep me", messageId: "trash1@x" }));
    await runSyncCycle(deps);
    const [msg] = await db.select().from(messages).where(byMessageId(mailboxId, "trash1@x"));
    expect(msg, "ingested").toBeTruthy();
    const id = msg!.id;

    /* THE PROVIDER'S TRASH GOT NO CURSOR — `passiveFolderExclusion`'s own rule, asserted rather
       than assumed, because this whole feature rests on the server NOT reading that folder. If
       it ever did, mail trashed in another client would appear in this list and the view's scope
       sentence would become false. */
    const cursors = await db.select({ f: mailboxFolders.folder })
      .from(mailboxFolders).where(eq(mailboxFolders.mailboxId, mailboxId));
    expect(cursors.map((r) => r.f), "no cursor for the provider's Trash").not.toContain(trashPath);

    // ── 2. DELETE (the API side — no IMAP) ───────────────────────────────────────────────────
    const svc = new MessageService();
    await svc.delete(ctxOf(db, accountId), id);

    const [afterDelete] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(afterDelete).toMatchObject({
      desiredFolder: trashPath, observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "pending",
      trashedFrom: "INBOX",
    });
    const [tombstoned] = await db.select({ d: messages.deletedAt }).from(messages).where(eq(messages.id, id));
    expect(tombstoned!.d, "tombstoned at the press").not.toBeNull();
    // The API opened no connection: the copy is still physically in INBOX.
    expect((await uidInFolder(raw, "INBOX", "trash1@x")).length).toBe(1);

    // The row IS in the Trash list, tombstone and all, with its origin resolved.
    const listed = await svc.listTrash(ctxOf(db, accountId), { view: "trash" });
    expect(listed.items.map((m) => m.id)).toEqual([id]);
    expect(listed.items[0]!.restoreTo).toBe("INBOX");

    // ── 3. THE WORKER MOVES IT ───────────────────────────────────────────────────────────────
    await runSyncCycle(deps);
    expect((await uidInFolder(raw, trashPath, "trash1@x")).length, "physically in the server's Trash").toBe(1);
    expect((await uidInFolder(raw, "INBOX", "trash1@x")).length, "and gone from INBOX").toBe(0);
    const [moved] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(moved!.observedFolder).toBe(trashPath);
    /* AND THE ORIGIN SURVIVED THE MOVE. This is the whole reason the column exists: `observed`
       is now Trash, so the folder the message came from is written NOWHERE ELSE. */
    expect(moved!.trashedFrom, "the only surviving record of where it was").toBe("INBOX");
    const [stillDeleted] = await db.select({ d: messages.deletedAt }).from(messages).where(eq(messages.id, id));
    expect(stillDeleted!.d).not.toBeNull();

    // ── 4. RESTORE (the API side — no IMAP) ──────────────────────────────────────────────────
    const out = await svc.restore(ctxOf(db, accountId), id);
    expect(out).toMatchObject({ restoreTo: "INBOX", pending: true });

    const [afterRestore] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(afterRestore).toMatchObject({
      desiredFolder: "INBOX", lastSetBy: "us", reconcileStatus: "pending", trashedFrom: null,
    });
    /* THE TOMBSTONE STILL STANDS. The mail server has the message in Trash at this instant, and
       a mirror saying otherwise would be showing mail in a place it is not. */
    const [pending] = await db.select({ d: messages.deletedAt }).from(messages).where(eq(messages.id, id));
    expect(pending!.d, "the mailbox is the master").not.toBeNull();
    // And it has left the Trash list — the decision is taken, the server has not caught up.
    expect((await svc.listTrash(ctxOf(db, accountId), { view: "trash" })).items).toHaveLength(0);

    // ── 5. THE WORKER MOVES IT BACK, AND THE ADOPT UN-DELETES ────────────────────────────────
    const seqBefore = (await db.select({ s: changeLog.seq }).from(changeLog)
      .where(eq(changeLog.accountId, accountId))).reduce((m, r) => (r.s > m ? r.s : m), 0n);

    await runSyncCycle(deps);
    expect((await uidInFolder(raw, "INBOX", "trash1@x")).length, "back in INBOX on the server").toBe(1);
    expect((await uidInFolder(raw, trashPath, "trash1@x")).length, "and gone from Trash").toBe(0);

    const [converged] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(converged!.observedFolder, "the filing converged").toBe("INBOX");
    expect(converged!.reconcileStatus).not.toBe("pending");
    expect(converged!.trashedFrom, "still clear — the origin was spent by the restore").toBeNull();

    /* ── AND THE ROW IS LIVE AGAIN, BECAUSE THE SERVER HAS IT BACK ─────────────────────────
     *
     * The half the restore was missing. `MessageService.restore` writes desired = the origin and
     * clears nothing on purpose — the mirror says "back" when the SERVER has it back — and for
     * one revision that clear was reachable from nowhere on this path: `pipeline.ts` clears the
     * tombstone in its reconcile runner's `adopt_external` arm only, and after the landed move
     * repoints the locator the message is known at exactly the folder the next enumeration finds
     * it in, so there is no arrival for the arrival path's clear to run on. Measured:
     * `deleted_at` was byte-identical after the moving cycle and after two further cycles, so a
     * restore was invisible to whoever pressed it, for ever.
     *
     * `completeFiling`'s `unDeleteOnLandedMove` is the fix — a landed move that did NOT park,
     * which is exactly a landed move whose destination is not the mailbox's Trash path, clears
     * the tombstone and records the delta. Watched failing: at the commit before it this
     * assertion read `expected 2026-09-09T13:23:44.443Z to be null`.
     */
    const [live] = await db.select({ d: messages.deletedAt }).from(messages).where(eq(messages.id, id));
    expect(live!.d, "the mirror says it is back because the SERVER has it back").toBeNull();

    /* AND THROUGH THE CLIENT'S OWN READ PATH, which is the assertion that matters to a person:
       the cleared stamp is the mechanism and this is the outcome. `GET /messages` for the origin
       view excludes tombstoned rows structurally, so a row that were live and still somehow
       filtered would fail here and pass above. */
    const inbox = await svc.list(ctxOf(db, accountId), { view: "imbox" });
    expect(inbox.items.map((m) => m.id), "back in the list it came from").toContain(id);
    /* And it has left Trash for good — the desired folder moved, so that read cannot hold it. */
    expect((await svc.listTrash(ctxOf(db, accountId), { view: "trash" })).items).toHaveLength(0);

    /* AND A CLIENT'S DRAIN SEES IT. A change row above the pre-cycle seq, for this message,
       whose op is one the apply contract UPSERTS — `create`, `update` or `move`, all three of
       which re-add a tombstoned row (rule 4/5), so a mirror's `entity: null` is replaced by the
       live DTO. The op NAME is deliberately not pinned beyond that set: which arm emits it is
       the pipeline's business, and a test pinning one word would go red on a correct refactor
       while proving nothing more. */
    const after = await db.select().from(changeLog).where(eq(changeLog.accountId, accountId));
    const mine = after.filter((r) => r.entityId === id && r.seq > seqBefore);
    expect(mine.length, "the landed move emitted a delta").toBeGreaterThan(0);
    expect(mine.some((r) => r.op === "create" || r.op === "update" || r.op === "move"),
      "and it is an op the apply contract upserts, so the row lives again").toBe(true);
  }, 90000);

  it("a restore pressed before the organizer moved the copy cancels the delete: it never leaves INBOX", async () => {
    const cfg = imapCfg();
    const db = makeDb(DB);
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: cfg.auth.user, ...ORGANIZER_CONSENT,
    }).returning();
    await db.insert(contacts).values({ accountId, address: "anna@x.example" });
    const repo = makeDrizzleRepo(db);
    const adapter = new ImapAdapter(cfg);
    await adapter.connect();
    closers.push(() => adapter.close());
    await adapter.ensureFolders(FIXTURE_DOOR);
    const raw = await rawClient(cfg);
    closers.push(async () => { await raw.logout(); });
    await raw.mailboxCreate("Trash").catch(() => {});
    const special = await adapter.findSpecialFolders();
    await repo.setMailboxSpecialFolders!(mb!.id, { junkFolder: special.junk, trashFolder: special.trash, sentFolder: null });
    const trashPath = special.trash!;
    const deps: SyncDeps = {
      repo, adapter, accountId, mailboxId: mb!.id, role: "organizer",
      trustedAuthservIds: NO_TRUSTED_AUTHSERV_IDS, storageCap: UNMETERED_STORAGE_CAP,
      writeAuthority: FIXTURE_LEASE, signatures: null,
    };

    await raw.append("INBOX", emlOf({ from: "anna@x.example", subject: "changed my mind", messageId: "trashundo@x" }));
    await runSyncCycle(deps);
    const [msg] = await db.select().from(messages).where(byMessageId(mb!.id, "trashundo@x"));
    const id = msg!.id;
    const svc = new MessageService();
    await svc.delete(ctxOf(db, accountId), id);
    const out = await svc.restore(ctxOf(db, accountId), id);
    expect(out).toMatchObject({ restoreTo: "INBOX", pending: false });

    await runSyncCycle(deps);
    await runSyncCycle(deps);
    expect((await uidInFolder(raw, "INBOX", "trashundo@x")).length, "still in INBOX on the server").toBe(1);
    expect((await uidInFolder(raw, trashPath, "trashundo@x")).length, "and never in its Trash").toBe(0);
    const [live] = await db.select({ d: messages.deletedAt }).from(messages).where(eq(messages.id, id));
    expect(live!.d, "the letter is live").toBeNull();
    const inbox = await svc.list(ctxOf(db, accountId), { view: "imbox" });
    expect(inbox.items.map((m) => m.id), "and in the list it came from").toContain(id);
  }, 90000);

  it("NEGATIVE CONTROL — a move that lands INTO Trash leaves the row deleted", async () => {
    /* ══ THE CLEAR MAY NOT WIDEN INTO UN-DELETING DELETES ══════════════════════════════════
     *
     * `unDeleteOnLandedMove` runs on a landed move that did not park, and a delete's move parks
     * — so a delete never reaches it. That is a structural argument and this is the measurement
     * of it, because "the clear is on the other branch" is exactly the kind of reasoning that
     * stops being true when somebody moves a line.
     *
     * The whole delete is driven, not just the write: press it, let the organizer carry the copy
     * to the server's own Trash, and then read the stamp. If the clear ever widened to every
     * landed move, this is the assertion that says so — and it says it about the one gesture
     * where being wrong is least recoverable, since the row coming back would put deleted mail
     * back in somebody's Ohbox.
     *
     * Watched failing: calling `unDeleteOnLandedMove` unconditionally (before the park test
     * rather than inside the non-park arm) reddens THIS case — "a delete's landed move must NOT
     * un-delete it: expected null not to be null" — and also the round trip's own mid-sequence
     * assertion, which reads the stamp at the Trash stage. Two independent readings of one
     * widening, which is stronger than one; the round trip's is incidental and this is the case
     * that exists for it.
     */
    const cfg = imapCfg();
    const db = makeDb(DB);
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: cfg.auth.user, ...ORGANIZER_CONSENT,
    }).returning();
    await db.insert(contacts).values({ accountId, address: "anna@x.example" });
    const repo = makeDrizzleRepo(db);
    const adapter = new ImapAdapter(cfg);
    await adapter.connect();
    closers.push(() => adapter.close());
    await adapter.ensureFolders(FIXTURE_DOOR);
    const raw = await rawClient(cfg);
    closers.push(async () => { await raw.logout(); });
    await raw.mailboxCreate("Trash").catch(() => {});
    const special = await adapter.findSpecialFolders();
    await repo.setMailboxSpecialFolders!(mb!.id, { junkFolder: special.junk, trashFolder: special.trash, sentFolder: null });
    const trashPath = special.trash!;
    const deps: SyncDeps = {
      repo, adapter, accountId, mailboxId: mb!.id, role: "organizer",
      trustedAuthservIds: NO_TRUSTED_AUTHSERV_IDS, storageCap: UNMETERED_STORAGE_CAP,
      writeAuthority: FIXTURE_LEASE,
    };

    await raw.append("INBOX", emlOf({ from: "anna@x.example", subject: "stays deleted", messageId: "trashneg@x" }));
    await runSyncCycle(deps);
    const [msg] = await db.select().from(messages).where(byMessageId(mb!.id, "trashneg@x"));
    const id = msg!.id;
    const svc = new MessageService();
    await svc.delete(ctxOf(db, accountId), id);
    await runSyncCycle(deps);

    // The copy is where a delete puts it, and the organizer's move has LANDED.
    expect((await uidInFolder(raw, trashPath, "trashneg@x")).length, "in the server's Trash").toBe(1);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs!.observedFolder, "the move landed, so the completion writer ran").toBe(trashPath);

    /* AND THE STAMP STANDS. A second cycle too, so a clear that happened one turn late would
       still be caught. */
    const [afterOne] = await db.select({ d: messages.deletedAt }).from(messages).where(eq(messages.id, id));
    expect(afterOne!.d, "a delete's landed move must NOT un-delete it").not.toBeNull();
    await runSyncCycle(deps);
    const [afterTwo] = await db.select({ d: messages.deletedAt }).from(messages).where(eq(messages.id, id));
    expect(afterTwo!.d, "and it still stands a cycle later").not.toBeNull();

    // The outcome, through the client's own reads: absent from the pile, present in Trash.
    const inbox = await svc.list(ctxOf(db, accountId), { view: "imbox" });
    expect(inbox.items.map((m) => m.id), "a deleted message is in no living view").not.toContain(id);
    const trash = await svc.listTrash(ctxOf(db, accountId), { view: "trash" });
    expect(trash.items.map((m) => m.id), "and it IS in Trash").toContain(id);
  }, 90000);

  it("a restore whose Trash copy the provider PURGED leaves Trash: nothing arrives, the tombstone stands", async () => {
    /* THE OTHER HARD STOP THE BRIEF NAMES, driven rather than reasoned about:
       `RESTORE-OF-A-PURGED-TRASH-COPY-STAYS-PENDING`. A mail server may empty its own Trash on
       its own schedule, so between the delete's move and the restore's move the copy can be
       gone. What the reconciler does with a move whose source is not there is what this case
       records; the lane does not invent a finaliser for it. */
    const cfg = imapCfg();
    const db = makeDb(DB);
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: cfg.auth.user, ...ORGANIZER_CONSENT,
    }).returning();
    await db.insert(contacts).values({ accountId, address: "anna@x.example" });
    const repo = makeDrizzleRepo(db);
    const adapter = new ImapAdapter(cfg);
    await adapter.connect();
    closers.push(() => adapter.close());
    await adapter.ensureFolders(FIXTURE_DOOR);
    const raw = await rawClient(cfg);
    closers.push(async () => { await raw.logout(); });
    await raw.mailboxCreate("Trash").catch(() => {});
    const special = await adapter.findSpecialFolders();
    await repo.setMailboxSpecialFolders!(mb!.id, { junkFolder: special.junk, trashFolder: special.trash, sentFolder: null });
    const trashPath = special.trash!;
    const deps: SyncDeps = {
      repo, adapter, accountId, mailboxId: mb!.id, role: "organizer",
      trustedAuthservIds: NO_TRUSTED_AUTHSERV_IDS, storageCap: UNMETERED_STORAGE_CAP,
      writeAuthority: FIXTURE_LEASE,
    };

    await raw.append("INBOX", emlOf({ from: "anna@x.example", subject: "purged", messageId: "trashpurge@x" }));
    await runSyncCycle(deps);
    const [msg] = await db.select().from(messages).where(byMessageId(mb!.id, "trashpurge@x"));
    const id = msg!.id;
    const svc = new MessageService();
    await svc.delete(ctxOf(db, accountId), id);
    await runSyncCycle(deps);
    expect((await uidInFolder(raw, trashPath, "trashpurge@x")).length).toBe(1);

    /* THE PROVIDER EMPTIES ITS TRASH — a real expunge, by the user's own other client, which is
       the one destructive act this product never performs and cannot prevent. */
    const uids = await uidInFolder(raw, trashPath, "trashpurge@x");
    const lock = await raw.getMailboxLock(trashPath);
    try {
      await raw.messageDelete({ uid: uids.join(",") }, { uid: true });
    } finally {
      lock.release();
    }
    expect((await uidInFolder(raw, trashPath, "trashpurge@x")).length, "gone from the server").toBe(0);

    await svc.restore(ctxOf(db, accountId), id);
    await runSyncCycle(deps);
    await runSyncCycle(deps);

    /* THE SETTLEMENT: a restore whose copy the server purged never completes (`observed := desired`
       would say the message is back in INBOX with the server holding nothing anywhere), and it does
       not go back to Trash either: no server holds it there. Its row leaves, so no move is owed. */
    const [after] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect((await uidInFolder(raw, "INBOX", "trashpurge@x")).length, "nothing arrived in INBOX").toBe(0);
    expect(after, "the purged letter kept a row asking for a move that cannot run").toBeUndefined();
    const listed = await svc.listTrash(ctxOf(db, accountId), { view: "trash" });
    expect(listed.items.map((m) => m.id), "Trash lists a letter no server holds").not.toContain(id);
    // THE TOMBSTONE STANDS — only a LANDED move clears it, and nothing landed.
    const [stillGone] = await db.select({ d: messages.deletedAt }).from(messages).where(eq(messages.id, id));
    expect(stillGone!.d, "the message must stay deleted: no copy of it exists").not.toBeNull();
  }, 90000);

});
