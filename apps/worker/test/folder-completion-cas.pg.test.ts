import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, auditLog, folderState, mailboxes, messageBodies, messageInstances, messages,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { PendingFolderState, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { NativeLocator } from "@trafficflow/core";
import { completeFiling, SPAM_PILE, type SpecialFolderMap } from "../src/junk-filing.js";

/**
 * ═══ A COMPLETION MAY NOT WRITE BACK THE DESIRE IT READ — AND IT MAY NOT GO SILENT EITHER ═══
 *
 * THE DEFECT THIS FILE PINS SHUT, as the sequence it actually takes (a worker completion that
 * clobbers the intent): the reconciler reads a pending `folder_state` row whose desired folder is the
 * Ohbox and starts its IMAP move — minutes, on a slow host. While the move is in flight the
 * one-time sensitive re-screen takes that row `FOR UPDATE`, writes `desired_folder =
 * 'ohmail/Screener'` and COMMITS. The move lands, and `completeFiling` writes `'INBOX'` back over
 * it, because its `upsertFolderState` carried the `desiredFolder` read before the move.
 *
 * Nothing errors. Both writers behaved exactly as designed. The user's message is simply where the
 * OLDER decision said, and no log line anywhere says a decision was reverted. That is a LOST
 * UPDATE, not a stale read, and the difference is why the fix is not "read again": a second read
 * would have the same window one statement later. The fix is that `desired_folder` is not in the
 * completion's `SET` list at all, ever — that half of `WorkerRepo.completeFolderState` has not
 * changed and could not: it is what makes writing `observed_folder` unconditionally (below) safe.
 *
 * ── THE FIRST FIX HAD A DEFECT OF ITS OWN, FOUND BY REVIEW AND PINNED HERE TOO ───────────────
 *
 * The very first version answered a miss by writing NOTHING — a `WHERE` on the witness instead of
 * an absent `SET`. That reopened a narrower hole: the mail had ALREADY physically moved
 * (`updateLocator` runs before any completion is attempted), so a declined completion left
 * `observed_folder` describing wherever the row was BEFORE this move — now false. When the
 * competing writer's own new desire happened to equal that stale value (the ordinary shape of "the
 * user restores a message while the old move is still in flight" — the API reads the row before
 * any physical move has landed in the database, so its own write is desired=observed=the CURRENT,
 * pre-move value), the result was a `reconciled` row that would never be looked at again, and on
 * the spam path specifically a message with no watched instance and no reconciled-while-divergent
 * exemption — the instanceless reaper's exact victim shape, silently deleting mail that was still
 * sitting on the server.
 *
 * So `completeFolderState` writes `observed_folder` on EVERY call now, matched or not, and derives
 * `reconcile_status` from the row's LIVE `desired_folder` rather than the witness. A miss records
 * the truth and, if that truth still disagrees with the current desire, leaves the row PENDING —
 * which is what makes it self-heal on the next cycle instead of lying for ever.
 *
 * The class is wider than the one caller. `desired_folder` has six writers that take NO mailbox
 * row and are therefore serialized against the worker by nothing: the API's move, the Screener's
 * apply, `rule-retro`, `ohbox-tidy`, `screener-auto`, and this re-screen. The reconciler's fenced
 * write group excludes none of them. So the conditional write is at the WRITER seam — every arm of
 * `completeFiling`, the reconciler's already-converged status repair, and the gone-message void —
 * and not a defence inside any one reader.
 *
 * REAL POSTGRES (:5433), and it has to be: the claim is that one UPDATE's `WHERE`/`CASE` sees
 * another connection's COMMITTED row under READ COMMITTED. PGlite is single-connection, so the
 * interleave below cannot exist there and every assertion would pass vacuously — the exact
 * blindness CLAUDE.md records for transactional code.
 *
 * ── MUTATIONS WATCHED (each restored; see the run log at the bottom of this file) ────────────
 */

const AVAILABLE = await realPgAvailable();
const LOC = (folder: string, ref: string): NativeLocator => ({ folder, ref });

const OHBOX = "INBOX";
const SCREENER = "ohmail/Screener";
/** Where the message physically SITS before the reconciler moves it. A third folder, so that
 *  "the desire", "the source" and "the newer desire" are three distinguishable values and no
 *  assertion below can pass by two of them happening to coincide. */
const SOURCE = "ohmail/News";
const JUNK = "[Gmail]/Spam";
const TRASH = "Trash";
const SPECIAL: SpecialFolderMap = { junkFolder: JUNK, trashFolder: TRASH, sentFolder: "Sent" };

describe.skipIf(!AVAILABLE)("folder completion — the desire it read is a witness, never a payload", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;
  /** A SECOND connection: the competing writer must be a different session, not the same one. */
  let otherSql: ReturnType<typeof postgres>;
  let otherDb: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
    otherSql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    otherDb = brandDialect(drizzle(otherSql, { schema }), "pg");
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await otherSql?.end({ timeout: 5 });
  });

  /** One mailbox, one message, one pending `folder_state` row — the reconciler's starting state. */
  async function seedPending(opts: {
    desired: string; observed: string; attempts?: number; nextAttemptAt?: Date | null;
  }) {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await db.insert(accounts).values({ id: accountId, name: `cas-${tag}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `cas-${tag}@example.test`, status: "connected",
      junkFolder: JUNK, trashFolder: TRASH,
    }).returning();
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id,
      dedupKey: `mid:<cas-${tag}@example.test>`,
      messageIdHeader: `cas-${tag}@example.test`,
      fromAddress: "someone@example.test", subject: "s",
      bodyHash: `cas-hash-${tag}`,
      nativeLocator: LOC(opts.observed, "1:10"),
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: opts.desired, observedFolder: opts.observed,
      lastSetBy: "us", reconcileStatus: "pending", conflict: false,
      attempts: opts.attempts ?? 0, nextAttemptAt: opts.nextAttemptAt ?? null,
    });
    // The message's one watched instance, and a body — both only matter to the spam-park case
    // below, where the whole question is whether the park removes the instance and husks the body
    // for a completion that has been superseded.
    await db.insert(messageInstances).values({
      accountId, messageId: m!.id, mailboxId: mb!.id, folder: opts.observed, uid: 10,
      uidvalidity: 1n, isPrimary: true,
    });
    await db.insert(messageBodies).values({
      messageId: m!.id, text: "the original body", html: "<p>the original body</p>", headers: {},
    });
    const repo = makeDrizzleRepo(db as never) as WorkerRepo;
    return { accountId, mailboxId: mb!.id, messageId: m!.id, repo };
  }

  const stateOf = async (messageId: string) => {
    const [row] = await db.select().from(folderState).where(eq(folderState.messageId, messageId));
    return row!;
  };

  const auditsOf = async (accountId: string, action: string) =>
    db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, action)));

  /**
   * THE RECONCILER'S OWN READ, verbatim: the pending row as `listPendingFolderStates` hands it to
   * the filing path. Taken BEFORE the competing writer commits, which is the whole point — a
   * completion built from a fresher read would not be testing anything.
   */
  const readPending = async (repo: WorkerRepo, mailboxId: string): Promise<PendingFolderState> => {
    const [p] = await repo.listPendingFolderStates(mailboxId);
    return p!;
  };

  it("a desire committed during the move STANDS: the completion never writes it back", async () => {
    const { accountId, mailboxId, messageId, repo } = await seedPending({
      desired: OHBOX, observed: SOURCE,
    });

    // the reconciler reads the pending row and hands it to the adapter.
    const p = await readPending(repo, mailboxId);
    expect(p.desiredFolder).toBe(OHBOX);

    // ANOTHER SESSION decides differently and commits. This is the re-screen's write; it
    // takes no mailbox row, so nothing in the worker's fence excludes it. Its own pair is
    // deliberately NOT converged (desired=SCREENER, observed=SOURCE unchanged) — a genuinely
    // pending intent, so this test is about the DESIRE surviving and not about the physical-fact
    // write the sibling test below exists to prove.
    await otherDb.update(folderState)
      .set({ desiredFolder: SCREENER, reconcileStatus: "pending", updatedAt: new Date() })
      .where(eq(folderState.messageId, messageId));
    // The newer intent's own schedule, written as a deferral writes it (no desired folder), so
    // mail 0163's fresh-intent trigger keeps it.
    await otherDb.update(folderState).set({ attempts: 3 }).where(eq(folderState.messageId, messageId));

    // the IMAP move landed at INBOX; this is its completion.
    await completeFiling(repo, accountId, mailboxId, p, LOC(OHBOX, "9:900"), SPECIAL);

    const row = await stateOf(messageId);
    // THE CLAIM. Before the fix this read `INBOX` — the completion's write-back of a decision that
    // had already been superseded, with nothing anywhere saying so.
    expect(row.desiredFolder).toBe(SCREENER);
    // The newer intent's OWN authorship survived, and so did its attempt count — attempts/
    // next_attempt_at are touched only when this completion's witness matches the live desire,
    // never on a miss, so a schedule this row earned before the miss is not clobbered.
    expect(row.attempts).toBe(3);
    // `observed_folder` DOES move — see the header's second section. It is a fact about the
    // SERVER, not about anyone's intent, and it is written unconditionally: the mail landed at
    // INBOX, so that is now the truthful record of where it is, regardless of whose desire wins.
    expect(row.observedFolder).toBe(OHBOX);
    // desired(SCREENER) != observed(INBOX) ⇒ still pending — self-healing, not silence: the row
    // re-enters the queue and the next cycle files it from INBOX toward the Screener.
    expect(row.reconcileStatus).toBe("pending");

    // The locator IS repointed, because that half is unconditionally true: the server moved the
    // mail, and the next cycle files from where it actually is toward the newer desire.
    const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect((msg!.nativeLocator as NativeLocator).folder).toBe(OHBOX);

    // And the refusal is ON RECORD. A silent decline is how this defect stayed invisible for its
    // whole life; `reconcile.move.superseded` names the desire the move was computed against and
    // the folder the mail physically reached.
    const audits = await auditsOf(accountId, "reconcile.move.superseded");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toMatchObject({ messageId, filedAgainst: OHBOX, to: OHBOX });
  });

  it("a coincidentally-converged competing write SELF-HEALS instead of lying forever", async () => {
    // ═══ THE SECOND-ROUND FINDING, reproduced exactly, AGAINST THE REPO METHOD DIRECTLY ══════
    //
    // The API's restore-from-spam endpoint reads the CURRENT folder_state row before any
    // physical move has landed in the database and writes desired=observed=that current value
    // — an ordinary, ALREADY-CONVERGED pair, because as far as the API knows nothing has moved
    // yet. If the completion then answers a miss by writing NOTHING, that converged pair stands
    // for ever: `reconciled` rows never re-enter `listPendingFolderStates`, so nobody ever
    // notices the mail is actually sitting somewhere else.
    //
    // Driven through `completeFolderState` directly rather than `completeFiling`, because the
    // ordinary (non-spam, non-delete) branch of `completeFiling` assumes the physical landing
    // folder IS the desire it read (true of every real move — the reconciler always computes the
    // physical destination FROM `p.desiredFolder`) and would need an artificial, unreachable
    // shape to exercise a mismatch here. The repo method is the primitive under test; the spam
    // branch's own version of this exact race is covered end-to-end by the test above.
    //
    // `physicalObservation: true` is REQUIRED here — round 3's finding, found by review of round
    // 2: this call is standing in for `settle`'s call (a genuine landed move), which is the only
    // shape allowed to make this unconditional write. Without it (the default, `false`) a miss
    // writes nothing at all — correct for `sync.ts`'s other two callers, which have no fresh
    // physical fact and must not overwrite a fresher writer's own observation with a stale echo.
    // That default-`false` shape is what the NEXT test down proves.
    const { mailboxId, messageId, repo } = await seedPending({ desired: OHBOX, observed: SOURCE });

    // The competing writer converges the row to SOURCE — the value that WAS already on disk as
    // `observed` before any physical move landed, i.e. exactly the "restore it to where the
    // database currently believes it is" write the API's own restore endpoint makes.
    await otherDb.update(folderState)
      .set({ desiredFolder: SOURCE, reconcileStatus: "reconciled", updatedAt: new Date() })
      .where(eq(folderState.messageId, messageId));

    // The move this pass had in flight was computed against OHBOX and landed there physically.
    const matched = await repo.completeFolderState(messageId, {
      expectDesiredFolder: OHBOX, observedFolder: OHBOX, lastSetBy: "us",
      physicalObservation: true,
    });
    expect(matched, "the live desire had moved to SOURCE; this call's witness no longer matches")
      .toBe(false);

    const row = await stateOf(messageId);
    // The newer intent's DESIRE is untouched — still SOURCE, never OHBOX.
    expect(row.desiredFolder).toBe(SOURCE);
    // THE CLAIM: the physical fact is recorded anyway. Before the second-round fix this write
    // never happened at all, and the row above would have stood as `reconciled` — a converged
    // pair the RESTORE endpoint believed true the instant it wrote it, made false the instant
    // this move landed, with nothing left to notice the difference.
    expect(row.observedFolder).toBe(OHBOX);
    expect(row.reconcileStatus, "a converged-but-now-false pair must not stand as reconciled")
      .toBe("pending");

    // And it is REACHABLE: the next reconcile pass picks it up and can converge it for real —
    // toward SOURCE, using the physical fact this call just recorded.
    const [again] = await repo.listPendingFolderStates(mailboxId);
    expect(again!.desiredFolder).toBe(SOURCE);
    expect(again!.observedFolder).toBe(OHBOX);
  });

  it("WITHOUT physicalObservation, a miss writes NOTHING — protecting a fresher writer's own fact", async () => {
    // ═══ THE THIRD-ROUND FINDING ══════════════════════════════════════════════════════════════
    //
    // The exact scenario the review named: `sync.ts`'s already-converged status repair
    // (`p.desiredFolder === p.observedFolder`) and its gone-message void call this method with an
    // `observedFolder` that is a STALE ECHO of a row read before any I/O for this row — not a
    // physical fact. If the unconditional-on-a-miss write from round two applied to them too, a
    // miss would OVERWRITE whatever a genuinely fresher writer — here, ingest adopting an
    // EXTERNAL move the user made in their own mail client — had just committed, with a value
    // that was already stale before this call started.
    const { messageId, repo } = await seedPending({ desired: OHBOX, observed: SOURCE });

    // Ingest observes the user moved the message externally, in real time, AFTER this call's
    // witness was formed — the fresher writer.
    await otherDb.update(folderState)
      .set({
        desiredFolder: SCREENER, observedFolder: SCREENER, lastSetBy: "external",
        reconcileStatus: "reconciled", attempts: 0, updatedAt: new Date(),
      })
      .where(eq(folderState.messageId, messageId));

    // The status-repair shape: no `physicalObservation`, carrying the STALE `p.desiredFolder` as
    // `observedFolder` — exactly `sync.ts`'s call, reproduced.
    const matched = await repo.completeFolderState(messageId, {
      expectDesiredFolder: OHBOX, observedFolder: OHBOX, lastSetBy: "us",
    });
    expect(matched).toBe(false);

    const row = await stateOf(messageId);
    // THE CLAIM: ingest's fresher, externally-authored fact survives completely untouched.
    expect(row.desiredFolder).toBe(SCREENER);
    expect(row.observedFolder, "a stale echo must not overwrite a fresher writer's own fact")
      .toBe(SCREENER);
    expect(row.lastSetBy).toBe("external");
    expect(row.reconcileStatus).toBe("reconciled");
  });

  it("the row is left DUE under the newer intent — the next cycle converges it", async () => {
    const { accountId, mailboxId, messageId, repo } = await seedPending({
      desired: OHBOX, observed: SOURCE,
    });
    const p = await readPending(repo, mailboxId);
    await otherDb.update(folderState).set({ desiredFolder: SCREENER, updatedAt: new Date() })
      .where(eq(folderState.messageId, messageId));
    await completeFiling(repo, accountId, mailboxId, p, LOC(OHBOX, "9:900"), SPECIAL);

    // The row is still in the queue, now desiring the Screener from the folder the move reached.
    // Declining a completion may never mean abandoning the message: the newer decision has to be
    // reachable by the very pass that just declined to overwrite it.
    const [again] = await repo.listPendingFolderStates(mailboxId);
    expect(again!.desiredFolder).toBe(SCREENER);
    expect(again!.nativeLocator!.folder).toBe(OHBOX);

    // CYCLE 2 — the move the newer intent asked for lands and completes against ITS OWN witness.
    await completeFiling(repo, accountId, mailboxId, again!, LOC(SCREENER, "9:901"), SPECIAL);
    const row = await stateOf(messageId);
    expect(row.desiredFolder).toBe(SCREENER);
    expect(row.observedFolder).toBe(SCREENER);
    expect(row.reconcileStatus).toBe("reconciled");
    // Terminates: nothing is owed any more.
    expect(await repo.listPendingFolderStates(mailboxId)).toHaveLength(0);
  });

  it("an UNDISTURBED completion is byte-for-byte what it always was, backoff reset included", async () => {
    // A row that has been REFUSED four times and whose deferral has since come due — the shape
    // that makes the backoff reset observable. The instant is in the PAST on purpose:
    // `listPendingFolderStates` only hands over due rows, so a future one would make `readPending`
    // return nothing and the test would assert against a row it never filed.
    const { accountId, mailboxId, messageId, repo } = await seedPending({
      desired: SOURCE, observed: OHBOX,
      attempts: 4, nextAttemptAt: new Date(Date.now() - 3_600_000),
    });
    const p = await readPending(repo, mailboxId);
    expect(await completeFiling(repo, accountId, mailboxId, p, LOC(SOURCE, "9:900"), SPECIAL))
      .toBe(false);

    const row = await stateOf(messageId);
    expect(row.desiredFolder).toBe(SOURCE);
    expect(row.observedFolder).toBe(SOURCE);
    expect(row.reconcileStatus).toBe("reconciled");
    expect(row.lastSetBy).toBe("us");
    // The reset `upsertFolderState` documents, kept: a row that goes pending again is a fresh
    // mutation and starts its schedule clean.
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt).toBeNull();
    // No refusal was recorded, because none happened.
    expect(await auditsOf(accountId, "reconcile.move.superseded")).toHaveLength(0);
  });

  it("the spam verdict's FULFILMENT survives the conditional write (pile kept, junk satisfied)", async () => {
    const { accountId, mailboxId, messageId, repo } = await seedPending({
      desired: SPAM_PILE, observed: OHBOX,
    });
    const p = await readPending(repo, mailboxId);
    await completeFiling(repo, accountId, mailboxId, p, LOC(JUNK, "9:900"), SPECIAL);

    const row = await stateOf(messageId);
    // The pile is what every view projects and it is NOT rewritten to the physical path…
    expect(row.desiredFolder).toBe(SPAM_PILE);
    // …the server's truth is recorded as observed…
    expect(row.observedFolder).toBe(JUNK);
    // …and `satisfiedBy` (which has no column — it derives the status at write time) is what makes
    // the difference fulfilment rather than a move still owed. This is the assertion that proves
    // the witness is not being confused with the payload: the status is derived from the WITNESS
    // against the OBSERVED, and a completion that derived it from the stored row would read
    // `desired = observed` false with no satisfaction and answer `pending`.
    expect(row.reconcileStatus).toBe("reconciled");
    expect(await repo.listPendingFolderStates(mailboxId)).toHaveLength(0);
  });

  it("a SUPERSEDED spam completion does not park — parking it is how the message is TOMBSTONED", async () => {
    // ══ THE ONE PLACE "DECLINE AND LEAVE THE NEWER INTENT STANDING" IS NOT ENOUGH ══════════
    //
    // Found by review of the conditional write itself. The spam park removes the message's last
    // watched instance, which is right for a filed verdict because the reaper
    // (`tombstoneInstanceless`) exempts exactly that shape: `reconciled` WHILE `desired <>
    // observed` — the signature only the `satisfiedBy` completion writes. A superseded completion
    // cannot write that signature, because it must not touch `desired_folder`. So parking it
    // leaves a message with no instance, no tombstone, and no exemption: the reaper's victim
    // predicate, exactly.
    //
    // The competing writer here is the ordinary one, not an exotic race: `ruleRetroPass` and its
    // siblings store `desired === observed` with `reconcile_status = 'reconciled'` — a snapshot
    // that is about to become FALSE the instant this move lands. Round 2's fix is what keeps that
    // from being permanent: see the next assertions.
    const { accountId, mailboxId, messageId, repo } = await seedPending({
      desired: SPAM_PILE, observed: OHBOX,
    });
    const p = await readPending(repo, mailboxId);

    // The retro pass decides this sender belongs in the Ohbox after all, and converges the row —
    // an honest belief at the instant it was written, since the physical move had not landed yet.
    await otherDb.update(folderState)
      .set({ desiredFolder: OHBOX, observedFolder: OHBOX, reconcileStatus: "reconciled",
             updatedAt: new Date() })
      .where(eq(folderState.messageId, messageId));

    // The spam move lands in native Junk — against the desire that is no longer there.
    await completeFiling(repo, accountId, mailboxId, p, LOC(JUNK, "9:900"), SPECIAL);

    // THE CLAIM, part one: no park ran, because this pass's own intent did not win. The instance
    // survived, so the reaper has nothing to take.
    expect(
      await db.select().from(messageInstances).where(eq(messageInstances.messageId, messageId)),
      "the park ran on a completion that had been superseded",
    ).toHaveLength(1);
    expect(await repo.tombstoneInstanceless(accountId, mailboxId, 10)).toBe(0);
    const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(msg!.deletedAt, "the message was tombstoned by the reaper").toBeNull();

    // …and the husk did not run either: the claim "your bytes are in Junk" belongs to a filing
    // this row no longer wants.
    const [body] = await db.select().from(messageBodies)
      .where(eq(messageBodies.messageId, messageId));
    expect(body!.text).toBe("the original body");
    expect(body!.withheldReason).toBeNull();

    // THE CLAIM, part two — the physical fact is recorded rather than swallowed, so the
    // now-stale "reconciled" snapshot cannot stand: desired(OHBOX) no longer matches the fresh
    // observed(Junk), and the row is PENDING again instead of lying. This is what makes the
    // message REACHABLE — see the next test for the full loop closing.
    const row = await stateOf(messageId);
    expect(row.desiredFolder).toBe(OHBOX);
    expect(row.observedFolder).toBe(JUNK);
    expect(row.reconcileStatus, "a stale 'reconciled' snapshot must not survive a physical move")
      .toBe("pending");
    expect(await auditsOf(accountId, "reconcile.move.superseded")).toHaveLength(1);

    // AND THE ROW IS REACHABLE: `listPendingFolderStates` picks it up, with the locator this
    // completion already repointed at Junk — the next cycle files it from there toward Ohbox.
    const [again] = await repo.listPendingFolderStates(mailboxId);
    expect(again!.desiredFolder).toBe(OHBOX);
    expect(again!.nativeLocator!.folder).toBe(JUNK);
    await completeFiling(repo, accountId, mailboxId, again!, LOC(OHBOX, "9:901"), SPECIAL);
    const finalRow = await stateOf(messageId);
    expect(finalRow.reconcileStatus).toBe("reconciled");
    expect(finalRow.observedFolder).toBe(OHBOX);
  });

  it("an UNDISTURBED spam completion still parks, husks and records fulfilment", async () => {
    // The other half — without it the fix above is indistinguishable from "never park".
    const { accountId, mailboxId, messageId, repo } = await seedPending({
      desired: SPAM_PILE, observed: OHBOX,
    });
    const p = await readPending(repo, mailboxId);

    await completeFiling(repo, accountId, mailboxId, p, LOC(JUNK, "9:900"), SPECIAL);

    expect(await db.select().from(messageInstances).where(eq(messageInstances.messageId, messageId)))
      .toHaveLength(0);
    const [body] = await db.select().from(messageBodies)
      .where(eq(messageBodies.messageId, messageId));
    expect(body!.withheldReason).toBe("junk_filed");
    const row = await stateOf(messageId);
    expect(row.desiredFolder).toBe(SPAM_PILE);
    expect(row.observedFolder).toBe(JUNK);
    expect(row.reconcileStatus).toBe("reconciled");
    // And the reaper leaves THIS one alone, because reconciled-while-divergent is its exemption.
    expect(await repo.tombstoneInstanceless(accountId, mailboxId, 10)).toBe(0);
    const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(msg!.deletedAt).toBeNull();
  });

  it("completeFolderState answers false and touches nothing when the row is GONE", async () => {
    // The account-erasure shape: `folder_state` swept while a pass that started earlier is still
    // completing. Writing here would insert into a table the erasure has just emptied.
    const { messageId, repo } = await seedPending({ desired: OHBOX, observed: SOURCE });
    await db.delete(folderState).where(eq(folderState.messageId, messageId));
    expect(await repo.completeFolderState(messageId, {
      expectDesiredFolder: OHBOX, observedFolder: OHBOX, lastSetBy: "us",
    })).toBe(false);
    expect(await db.select().from(folderState).where(eq(folderState.messageId, messageId)))
      .toHaveLength(0);
  });
});

/**
 * ── MUTATION LOG — ROUND 2 (2026-09-01, each mutation restored and the file re-run green) ────
 *
 * Recorded here rather than in a commit message because this is the evidence that these
 * assertions come from reality: a guard nobody has watched fail is not evidence. This is the
 * SECOND log in this file's life; the first covered the CAS-only design and is superseded by
 * this one, which covers the physical-observation-on-every-call design that replaced it.
 *
 *  · `junk-filing.ts#settle` reverted to the historical unconditional
 *    `r.upsertFolderState(p.messageId, { desiredFolder: p.desiredFolder, … })`
 *      ⇒ 3 RED: "a desire committed during the move STANDS" on
 *        `expected 'INBOX' to be 'ohmail/Screener'` — the original defect, reproduced, the older
 *        decision written back over the newer one; "the row is left DUE under the newer intent"
 *        (same cause); and "a SUPERSEDED spam completion does not park" on the reaper assertion,
 *        because the unconditional write also clobbers `desired_folder` on the spam path, which
 *        makes the row `reconciled`-with-a-lie and re-opens the exact tombstone hazard.
 *  · the live-desired self-heal clause dropped from `reconcile_status`'s `CASE` (a declined
 *    write's status frozen at whatever it already was, instead of derived from the fresh
 *    observation against the row's CURRENT desire)
 *      ⇒ 2 RED, both on the exact claim this round exists to prove: "a coincidentally-converged
 *        competing write SELF-HEALS" on `expected 'reconciled' to be 'pending'`, and "a
 *        SUPERSEDED spam completion does not park" on the same shape — a stale `reconciled`
 *        snapshot survives a physical move that makes it false. This is the mutation that
 *        reproduces the SECOND-ROUND finding most directly: without it, the fix from round one
 *        (claim before park) is not enough, because the row never re-enters the pending queue.
 *  · `settle`'s `recordAudit` arm deleted (decline silently)
 *      ⇒ 2 RED on `expected [] to have a length of 1` — no `reconcile.move.superseded`, on both
 *        tests that assert it.
 *  · the spam park run regardless of whether the completion matched (round one's own fix,
 *    reverted, to prove round two's tests still catch it)
 *      ⇒ 1 RED, "a SUPERSEDED spam completion does not park" on the reaper assertion — the
 *        instance is gone, `tombstoneInstanceless` has nothing to check, and the mirror deletes
 *        mail that is sitting on the server.
 *  · `attempts`/`next_attempt_at` reset UNCONDITIONALLY instead of only on a match (the backoff
 *    reset applied to a row this call did not win)
 *      ⇒ 1 RED, "a desire committed during the move STANDS" on `expected 0 to be 3` — the newer
 *        intent's own earned schedule clobbered by an observation write that has no business
 *        touching it.
 *
 * NOT separately mutated: `satisfiedBy`'s status contribution and the plain-equality self-heal
 * clause are two arms of ONE `CASE`, and the self-heal-clause mutation above already proves the
 * `CASE`'s live-desired comparison is load-bearing; a `satisfiedBy`-only mutation was run against
 * the structurally identical matched-arm derivation in this file's first (now-superseded) log and
 * is not repeated here.
 *
 * ── MUTATION LOG — ROUND 3 (2026-09-01, each mutation restored and the file re-run green) ────
 *
 * Round two's "always record the physical fact" answer was itself too wide: two callers in
 * `sync.ts` (the already-converged status repair, the gone-message void) carry no fresh physical
 * fact at all, only a stale echo of a row read before any I/O — and applying round two's fix to
 * them meant a miss could overwrite a genuinely fresher writer's own observation. The gate is
 * `FolderCompletion.physicalObservation`, `true` only from `settle` (the one caller with a real
 * landed move).
 *
 *  · `completeFolderState`'s `physical` local flipped from `c.physicalObservation === true` to
 *    `c.physicalObservation !== false` — i.e. TRUE by default, opt-out instead of opt-in, which
 *    is exactly the shape the review found wrong
 *      ⇒ 1 RED, "WITHOUT physicalObservation, a miss writes NOTHING" on
 *        `expected 'INBOX' to be 'ohmail/Screener'` — a status-repair-shaped call overwrote
 *        ingest's fresher, externally-authored observation with its own stale echo. This is the
 *        round-3 finding, reproduced directly.
 *  · `settle`'s `physicalObservation: true` argument deleted (the caller stops asserting it has a
 *    real fact, reverting to the new SAFE default)
 *      ⇒ 2 RED: "a desire committed during the move STANDS" and "a SUPERSEDED spam completion
 *        does not park" — `settle` is the ONE caller that legitimately needs the unconditional
 *        write, so removing its opt-in silently reintroduces round two's own defect at the one
 *        site meant to be exempt from round three's tightening.
 */
