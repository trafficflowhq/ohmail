import { and, eq, sql, type SQL } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import {
  assertAccountOrganizes,
  accountSettings, contacts, folderState, learningSignals, messages, recordChange,
  routingDecisions, rules, type Tx,
} from "@trafficflow/db";
import type { ServiceContext } from "./context.js";
import { fenceErasedAccount } from "./erasure-fence.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/**
 * Reset screening state — back to "never screened anybody", keeping the mail. It NEVER MOVES
 * MAIL: past decisions caused real IMAP moves, indistinguishable from moves the user made by hand
 * — the reset REPORTS what it leaves behind, per pile, and stops. Mail filed in the Screener
 * still belongs to an undecided sender; the web client partitions by consent, not folder. Still
 * NOT covered: `GET /screener` (the server's queue selects on the folder with no cutline) and the
 * desktop window's client pinned to "no API" — a wiring item (mail 0083). `rule` is a synced
 * entity: each deletion gets its own change-log row in the same transaction; `contacts` and
 * `learning_signals` are not synced and are deleted plainly.
 */

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
  const d = dialect(ctx.db);
  const rows = await ctx.db
    .select({
      folder: folderState.desiredFolder,
      total: d.castInt(sql`count(*)`).mapWith(Number) as unknown as SQL<number>,
      observed: d.castInt(
        sql`count(*) filter (where ${folderState.observedFolder} = ${folderState.desiredFolder})`,
      ).mapWith(Number) as unknown as SQL<number>,
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
    await fenceErasedAccount(tx, dialect(ctx.db), ctx.accountId);
    /**
     * A reader's account does not reset screening (mail 0083). "Reset" reads like a local clear
     * and is not: it DELETES EVERY RULE, clears learning signals, and drops the screening
     * baseline — the largest single organizing act in the product, reachable from an install that
     * organizes nothing. The damage travels: rules are the substance of the profile document in
     * `ohmail/_meta`, so a reader that wiped them would hand the organizer an empty rule set at
     * its next profile read — every decided sender back to the Screener, from a button pressed on
     * a machine that is not organizing. ACCOUNT-scoped, matching `decide`. Placed after the
     * erasure fence and before the settings lock: this read takes no lock of its own.
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
     * And the screening baseline goes back to NULL (mail 0056) — without this the reset is a
     * NO-OP for the cutline. The baseline is the instant the dormancy window measures back from;
     * with every rule deleted, a standing baseline would send all mail predating it straight to
     * History — "start over" and the Screener comes back empty. NULL rather than `ctx.now()`: a
     * baseline asserts the account worked through its backlog, and one that just discarded every
     * decision has not; the next decide establishes the new one. The other writer
     * (`ScreenerService.decide`, guarded on NULL) cannot fight this: the reset already deleted
     * the rules a concurrent decide would write beside, and the race's loser does not re-stamp.
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
