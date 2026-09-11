import { eq } from "drizzle-orm";
import { accounts, auditLog } from "./schema.js";
import type { Tx } from "./change-log.js";

/**
 * The account's own AI switch — read it, write it, and record that it was answered. A mail-half
 * concern the spend gate happens to consult, which is why it is its own module rather than part
 * of `ai-gate.ts`: the switch is the product ("switch the AI off entirely without losing a single
 * feature that files your mail") and belongs to every deployment, metered or not. `ai-gate.ts` —
 * the metering half — imports {@link aiEnabledFor} from here, not the other way round, so whoever
 * holds the entitlement state can change without the switch moving with it. It reads `accounts`
 * and writes one audit row. No subscription, no ledger, nothing hosted.
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
 * The switch and whether anybody was asked — the pair, because one without the other cannot
 * answer the onboarding question (migration 0084). `answered` is `IS NOT NULL` and never an
 * instant, so a skewed clock cannot change the answer — `auto_suggest_at`'s rule, inherited. A
 * missing row answers `{ enabled: true, answered: false }`: `aiEnabledFor`'s fail-open read plus
 * the only honest reading of an absent row. The two halves must agree with the gate or the UI
 * would show a state the spend path does not honour — and the `answered` half must fail towards
 * asking, because the alternative is walking silently past a consent question about spending
 * somebody's credits.
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
 * Set the account's AI switch, and record why it changed. This is the whole off switch,
 * deliberately small: no second place to update, no cache, no per-service flag — {@link
 * spendState} reads this column on every spend decision and every AI call site goes through that
 * one gate, so the write is one UPDATE and the effect is immediate and total: the next message is
 * filed by rules, no model is called, no credit moves. What it does not do, stated so nobody adds
 * it: it does not touch billing — switching AI off is not a downgrade; the account keeps its
 * plan, price and balance, and the credits go unspent. The audit row exists because "who turned
 * this off, and when" is asked exactly once — months later, by someone who was not there.
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
  // The answer is recorded even when the switch does not move. This returned early and wrote
  // nothing when `previous === enabled` — right for the switch, wrong for the question, and the
  // wrong case is the common one: `ai_enabled` rests `true`, so the first-run flow's "Yes" writes
  // the value the account already has; the early return meant the likeliest answer was never
  // recorded and the flow asked again on every resume, forever. So the stamp is unconditional and
  // the rest stays conditional: `changed` still means the switch moved, and the audit row is
  // still written only for a real change. One UPDATE either way — an answer can never exist
  // without its switch. See migration 0084 for why the column is on `accounts`.
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
