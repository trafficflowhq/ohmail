import { and, eq, sql } from "drizzle-orm";
import {
  assertAccountOrganizes,
  accountSettings, contacts, folderState, learningSignals, messages, recordChange,
  routingDecisions, rules, type Tx,
} from "@trafficflow/db";
import type { ServiceContext } from "./context.js";
import { fenceErasedAccount } from "./erasure-fence.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/* ══════════════════════════════════════════════════════════════════════════════════════════
   RESET SCREENING STATE — put an account back to "never screened anybody", keeping the mail.

   This is a supported operation and not only a development convenience: re-running the seed
   after a change of life is the same button. So it is careful about two things.

   ── IT NEVER MOVES MAIL ───────────────────────────────────────────────────────────────────

   Screening decisions taken in the past caused real IMAP moves, and those moves are visible in
   every other mail client the person uses. Un-making them would be thousands more moves, made
   on the strength of an assumption about what the mailbox "should" look like — and the moves
   this would be undoing are indistinguishable, at the database level, from moves the user made
   by hand. So the reset REPORTS what it is leaving behind, per pile, and stops. What to do
   about it is a decision for a person.

   The consequence to hold onto: after a reset, mail physically filed in the Screener folder
   still belongs to a sender with no decision. The presentation layer handles exactly that — it
   partitions by consent rather than by folder — so the account presents correctly without a
   single message moving.

   ── WHICH SURFACES THAT IS TRUE OF, BECAUSE IT WAS ONCE WRITTEN AS THOUGH IT WERE ALL OF THEM ──

   This paragraph used to end at "presents correctly", and it was false where it mattered most.
   The web client partitions Ohbox, Reads, Receipts, the triage piles, Tags and History through
   `presentationReader`, and for a year the SCREENER QUEUE — the one surface the cutline exists
   for — grouped the raw mirror by folder instead. On an account with a large backfill behind it
   that queue offered an order of magnitude more sender rows than the real queue, with
   the dormant remainder presented in History at the same time. Fixed in the webapp; the claim is
   narrowed here rather than restated, because it is the reset's own justification for leaving
   mail where it is and a reader has to be able to check it.

   Still NOT covered, and both are real rather than theoretical:

     · `GET /screener` — the SERVER's queue (`screener-service.ts`, `heldRows`) selects on
       `desired_folder = 'ohmail/Screener'` with no cutline, so any client that trusts it rather
       than partitioning locally sees the unfiltered backlog, and `suggestable.credits` prices it.
     · DESKTOP / Local tier — `apps/desktop/src/no-api-client.ts` pins `apiConfigured()` false, so
       the consent state never arrives and the partition is never switched on at all.

       AMENDED 2026-09-01 (mail 0083): the second half of this bullet — *"The sidecar serves no
       consent endpoint to switch it on with"* — is no longer true. `consentRoutes` are mounted on
       `localRoutes`, so the standalone door answers `GET /consent` and `PATCH /consent/settings`
       and the window is storable and readable there. What is STILL not covered is the first half:
       the desktop window's own client is pinned to "no API", so it does not ask. That is a client
       wiring item, not a missing endpoint, and it is the smaller of the two by a long way — the
       endpoint's absence also meant the sidecar's CYCLE had no cutoff to apply, which is fixed
       with it.

   ── IT TELLS THE CLIENTS ──────────────────────────────────────────────────────────────────

   `rule` is a synced entity. A bulk DELETE that skipped the change log would leave every
   mirror — browser, desktop — showing the deleted rules for ever, with no event that could
   ever remove them. Each deletion gets its own change-log row inside the same transaction.

   `contacts` and `learning_signals` are NOT synced, so they are deleted plainly.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** Mail that a past decision physically moved, and that this reset is deliberately leaving. */
export interface UnmovedPile {
  /** The folder as it exists on the mail server. */
  folder: string;
  messages: number;
  /** Messages the server has already been told about — i.e. really sitting there. */
  observed: number;
}

export interface ResetResult {
  rulesDeleted: number;
  contactsDeleted: number;
  screenerSuggestionsDeleted: number;
  learningSignalsDeleted: number;
  /**
   * What could not be cleanly un-moved, per pile. Never acted on — reported so that a person
   * can decide, because the alternative is a silent mass move through somebody's mailbox.
   */
  unmoved: UnmovedPile[];
  lastSeq: number | null;
}

/** The folders a screening decision can have moved mail INTO. INBOX is where mail already was. */
const DECISION_PILES = ["ohmail/Screener", "ohmail/Reads", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"];

/**
 * Count what past decisions physically moved. Read-only, and safe to call before deciding to reset.
 */
export async function unmovedReport(ctx: ServiceContext): Promise<UnmovedPile[]> {
  const rows = await ctx.db
    .select({
      folder: folderState.desiredFolder,
      total: sql<number>`count(*)::int`,
      observed: sql<number>`count(*) filter (where ${folderState.observedFolder} = ${folderState.desiredFolder})::int`,
    })
    .from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(and(
      eq(messages.accountId, ctx.accountId),
      sql`${folderState.desiredFolder} in ${sql`(${sql.join(DECISION_PILES.map((f) => sql`${f}`), sql`, `)})`}`,
    ))
    .groupBy(folderState.desiredFolder);

  return rows
    .map((r) => ({ folder: r.folder, messages: Number(r.total), observed: Number(r.observed) }))
    .sort((a, b) => b.messages - a.messages);
}

/**
 * Wipe rules, contacts, screener suggestions and screener learning. Keep every message.
 *
 * Idempotent: running it twice deletes nothing the second time and reports zeroes.
 */
export async function resetScreeningState(ctx: ServiceContext): Promise<ResetResult> {
  // Read the pile report BEFORE the transaction. It describes physical state the reset does
  // not change, so it is the same answer either way — and taking it outside keeps the
  // transaction, which holds the account's sequence row, as short as it can be.
  const unmoved = await unmovedReport(ctx);

  return asTx(ctx).transaction(async (tx) => {
    // ── ERASURE FENCE, FIRST — before the settings lock below. The chain is accounts →
    // settings → sequence row; `erasure-fence.ts` states why it must be the first lock.
    await fenceErasedAccount(tx, ctx.accountId);
    /* -- A READER'S ACCOUNT DOES NOT RESET SCREENING (mail 0083) --------------------------
     *
     * This one nearly escaped the reader ruling, because "reset" reads like a local clear. It is
     * not: it DELETES EVERY RULE, clears the learning signals and graduations, and drops the
     * screening baseline. Rules are the router; the baseline is the cutline the router measures
     * from. So this is the largest single organizing act in the product — larger than any decide
     * — and it was reachable from an install that organizes nothing.
     *
     * The damage is not confined to the install that pressed it. Rules TRAVEL: they are the
     * substance of the profile document in `ohmail/_meta`, so a reader that wiped them would hand
     * the actual organizer an empty rule set at its next profile read, and every sender the person
     * had ever decided about would go back to the Screener — on the machine that IS organizing
     * their mail, from a button pressed on one that is not.
     *
     * ACCOUNT-SCOPED, matching `decide` and the rules doors: the state being reset belongs to the
     * account, so the question is whether this install organizes ANYTHING. Placed after the
     * erasure fence and before the settings lock, so the lock chain (accounts → settings →
     * sequence row) is unchanged — this read takes no lock of its own.
     */
    await assertAccountOrganizes(tx as unknown as Tx, ctx.accountId);
    /**
     * THE GLOBAL LOCK ORDER — `account_settings` FIRST, the sequence row second (the rule and
     * its reproduction live at `recordSettingsChange`, consent-seed.ts). This transaction was
     * the one long-standing writer that took them the other way round — sequence row first
     * (the per-rule change rows below), settings row last (the baseline reset at the bottom) —
     * which is an opposite-order pair against `confirmSeed`, `ScreenerService.decide` and every
     * settings knob: each holds its first row, each waits on the other, Postgres kills one
     * with 40P01. So the row is TAKEN here, up front, with a no-op-shaped upsert; the real
     * column writes at the bottom then update a row this transaction already holds.
     */
    await tx.insert(accountSettings)
      .values({ accountId: ctx.accountId, updatedAt: ctx.now() })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { updatedAt: ctx.now() },
      });
    const doomed = await tx.select({ id: rules.id }).from(rules).where(eq(rules.accountId, ctx.accountId));

    let lastSeq: bigint | null = null;
    for (const r of doomed) {
      // The change-log row is written BEFORE the delete so a crash between them leaves a
      // client believing a rule is gone that still exists — recoverable by the next sync —
      // rather than a rule gone from the database that no client will ever stop showing.
      lastSeq = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "rule", entityId: r.id, op: "delete", meta: null,
      });
    }
    if (doomed.length > 0) await tx.delete(rules).where(eq(rules.accountId, ctx.accountId));

    const contactRows = await tx.delete(contacts)
      .where(eq(contacts.accountId, ctx.accountId)).returning({ id: contacts.id });

    // Screener SUGGESTIONS only. The rest of `routing_decisions` is the record of why each
    // message is where it is — and since the reset moves nothing, that record is still true.
    const suggestionRows = await tx.delete(routingDecisions)
      .where(and(eq(routingDecisions.accountId, ctx.accountId), eq(routingDecisions.status, "suggestion")))
      .returning({ id: routingDecisions.id });

    const learningRows = await tx.delete(learningSignals)
      .where(and(eq(learningSignals.accountId, ctx.accountId), eq(learningSignals.kind, "screener")))
      .returning({ id: learningSignals.id });

    /**
     * ── AND THE SCREENING BASELINE GOES BACK TO NULL (mail 0056) ──────────────────────────
     *
     * Not housekeeping — without this line the reset is a NO-OP for the cutline, which is most of
     * what the user asked for.
     *
     * The baseline is the instant the dormancy window is measured back from, and once it is set
     * the cutoff stops sliding: mail older than `baseline - dormancy_days` can no longer make an
     * undecided sender active, so it presents in History rather than in the queue. Every rule
     * above has just been deleted, so every sender in the mailbox is undecided again — and with a
     * baseline still standing from the previous era, all of the mail that predates it would go
     * straight back to History. The user presses "start over" and the Screener comes back empty.
     *
     * NULL is right rather than `ctx.now()` for the same reason the column is not stamped at
     * signup: a baseline asserts that this account has worked through its backlog, and an account
     * that just discarded every decision it had made has not. The next decide establishes the new
     * one, which is exactly the event that established the old one.
     *
     * Unlike its neighbours here this field is written by a DIFFERENT writer in normal operation
     * (`ScreenerService.decide`, guarded on it still being NULL), so the two must not fight: this
     * runs inside the reset transaction, which has already deleted the rules a concurrent decide
     * would have been writing beside, and the decide's own guard means the loser of that race
     * simply does not re-stamp.
     */
    await tx.insert(accountSettings).values({
      accountId: ctx.accountId,
      seedConfirmedAt: null,
      seedConfirmedCount: 0,
      seedDeclinedCount: 0,
      screeningBaselineAt: null,
      screeningResetAt: ctx.now(),
    }).onConflictDoUpdate({
      target: accountSettings.accountId,
      set: {
        seedConfirmedAt: null,
        seedConfirmedCount: 0,
        seedDeclinedCount: 0,
        screeningBaselineAt: null,
        screeningResetAt: ctx.now(),
        updatedAt: ctx.now(),
      },
    });

    return {
      rulesDeleted: doomed.length,
      contactsDeleted: contactRows.length,
      screenerSuggestionsDeleted: suggestionRows.length,
      learningSignalsDeleted: learningRows.length,
      unmoved,
      lastSeq: lastSeq === null ? null : Number(lastSeq),
    };
  });
}
