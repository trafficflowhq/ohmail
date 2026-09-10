import { eq } from "drizzle-orm";
import { accounts, auditLog } from "./schema.js";
import type { Tx } from "./change-log.js";

/**
 * THE ACCOUNT'S OWN AI SWITCH — read it, write it, and record that it was answered.
 *
 * It is a MAIL-half concern that the spend gate happens to consult, which is why it is its own
 * module rather than part of `ai-gate.ts`: the switch is the product ("switch the AI off entirely
 * without losing a single feature that files your mail") and it belongs to every deployment,
 * metered or not. `ai-gate.ts` — the metering half — imports {@link aiEnabledFor} from here, and
 * not the other way round, so whoever holds the entitlement state can change without the on/off
 * switch moving with it.
 *
 * It reads `accounts` and writes one audit row. No subscription, no ledger, nothing hosted.
 */

/**
 * Has this account switched managed AI off?
 *
 * A missing row answers `true` (enabled): the account id came from a mailbox row or a session,
 * so its absence is a referential-integrity problem, and failing OPEN here means such a bug
 * surfaces as the real error it is rather than as "AI mysteriously stopped for one customer".
 * Nothing is spent on the strength of this answer alone — the subscription state and
 * `debitCredits` still have to agree.
 */
export async function aiEnabledFor(tx: Tx, accountId: string): Promise<boolean> {
  const [row] = await tx
    .select({ aiEnabled: accounts.aiEnabled })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row ? row.aiEnabled : true;
}

/**
 * Read the account's AI switch (migration 0022). The value a settings screen displays.
 *
 * A missing row answers `true`, matching the gate's own fail-open read — the two must agree, or
 * the UI would show a state the spend path does not honour.
 */
export async function getAiEnabled(tx: Tx, accountId: string): Promise<boolean> {
  return aiEnabledFor(tx, accountId);
}

/**
 * THE SWITCH AND WHETHER ANYBODY WAS ASKED — the pair, because one without the other cannot
 * answer the onboarding question (migration 0084).
 *
 * `answered` is `IS NOT NULL` and never an instant, so a skewed clock cannot turn it into a
 * different answer — the rule `auto_suggest_at` states and this column inherits.
 *
 * A MISSING ROW ANSWERS `{ enabled: true, answered: false }`, which is `aiEnabledFor`'s fail-open
 * read plus the only honest reading of an absent row: nobody has been asked. The two halves must
 * agree with the gate or the UI would show a state the spend path does not honour — and the
 * `answered` half must fail towards ASKING, because the alternative is walking silently past a
 * consent question about spending somebody's credits.
 */
export async function getAiAnswer(
  tx: Tx, accountId: string,
): Promise<{ enabled: boolean; answered: boolean }> {
  const [row] = await tx
    .select({ aiEnabled: accounts.aiEnabled, aiAnsweredAt: accounts.aiAnsweredAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!row) return { enabled: true, answered: false };
  return { enabled: row.aiEnabled, answered: row.aiAnsweredAt !== null };
}

/**
 * Set the account's AI switch, and record WHY it changed.
 *
 * ## This is the whole off switch, and it is deliberately this small
 *
 * There is no second place to update, no cache to invalidate and no per-service flag to thread,
 * because {@link spendState} reads this column on every spend decision and every AI call site
 * in the product goes through that one gate. So the write is one `UPDATE` and the effect is
 * immediate and total: the next message that would have been classified is filed by rules
 * instead, no model is called, and no credit moves.
 *
 * ## What it does NOT do, stated so nobody adds it later
 *
 * It does not touch billing. Switching AI off is not a downgrade: the account keeps its plan,
 * its price and its credit balance, and those credits simply go unspent. Refunding or
 * pro-rating here would turn a preference into a subscription change, which is a different
 * promise from the one the site makes ("switch the AI off entirely without losing a single
 * feature that files your mail").
 *
 * The audit row exists because "who turned this off, and when" is asked exactly once — months
 * later, by someone who was not there, looking at a customer complaining that AI stopped.
 */
export async function setAiEnabled(
  tx: Tx,
  accountId: string,
  enabled: boolean,
  actor: { userId: string | null; requestId?: string } = { userId: null },
  /**
   * The instant the answer was given. Injected so the suite can pin it; the route does not pass
   * one, and `new Date()` here is the same clock every other writer on this row uses.
   */
  now: Date = new Date(),
): Promise<{ aiEnabled: boolean; changed: boolean }> {
  const previous = await aiEnabledFor(tx, accountId);
  /* ── THE ANSWER IS RECORDED EVEN WHEN THE SWITCH DOES NOT MOVE ─────────────────────────────
   *
   * This returned here and wrote NOTHING when `previous === enabled`, which is right for the
   * switch and wrong for the question — and the case it is wrong in is the common one.
   * `ai_enabled` rests `true`, so the first-run flow's "Yes" is a write of the value the account
   * already has: the early return meant the most likely answer anybody gives was never recorded,
   * the posture stayed "nobody has been asked", and the flow asked again on every resume for ever.
   *
   * So the STAMP is unconditional and the rest of the write stays conditional. `changed` still
   * means what it said — the switch moved — so no caller's reading of it changes, and the audit
   * row is still only written for a real change (an audit entry whose inverse is the value it
   * already had is noise). One UPDATE either way: the stamp joins the switch's own row and its
   * own statement, so an answer can never exist without its switch or a switch without its
   * answer. See migration 0084 for why the column is here and not on `account_settings`.
   */
  if (previous === enabled) {
    await tx.update(accounts).set({ aiAnsweredAt: now }).where(eq(accounts.id, accountId));
    return { aiEnabled: enabled, changed: false };
  }
  await tx.update(accounts).set({ aiEnabled: enabled, aiAnsweredAt: now }).where(eq(accounts.id, accountId));
  await tx.insert(auditLog).values({
    accountId,
    action: "account.ai_enabled",
    payload: { aiEnabled: enabled, userId: actor.userId, requestId: actor.requestId ?? null },
    // The inverse is the whole undo: this row is enough to put the setting back.
    inverse: { aiEnabled: previous },
  });
  return { aiEnabled: enabled, changed: true };
}
