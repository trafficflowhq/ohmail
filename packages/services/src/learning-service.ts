import { and, eq } from "drizzle-orm";
import {
  graduations, rules as rulesTbl, fenceErased, type LedgerTx, type Tx,
  recordLearningSignal, patternKeyFor, parsePatternKey, demoteGraduatedRoute, recordRuleDelta,
  GRADUATION_THRESHOLD, DEMOTION_THRESHOLD,
  type LearningSignalInput, type LearningKind, type LearningLabel, type ParsedPattern,
} from "@trafficflow/db";
import { dialect, type Dialect } from "@trafficflow/db/dialect";
import { withAccountTx, type ServiceContext } from "./context.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

// Re-exported rather than re-declared: `packages/db/src/learning-signal.ts` is now the ONE
// definition (see its own header for why — the worker's request drain needs the write and may
// not import this package). Every existing importer of these five names from THIS module keeps
// working unchanged.
export { GRADUATION_THRESHOLD, DEMOTION_THRESHOLD, patternKeyFor, parsePatternKey };
export type { LearningKind, LearningLabel, LearningSignalInput, ParsedPattern };

/**
 * LearningService. Captures every learning-relevant action as a `learning_signals` row deduped by
 * `triggeringActionId`, and advances the `graduations` counters with SQL EXPRESSIONS — never an
 * app-side read-modify-write, which loses updates under the worker-read / API-write race; the
 * `graduated` flip is likewise computed and guarded in SQL. `graduations` is the seam the
 * pipeline reads via `RoutingPort.isGraduated`: once a (sender→destination, route) pattern
 * graduates, the pipeline auto-applies confident classifications for it. `record`/`recordOn` are
 * thin wrappers over `@trafficflow/db#recordLearningSignal` — see that function for why the write
 * moved.
 */
export class LearningService {
  /** Public entry: runs on the request's ambient db (which may already be a tx). */
  async record(ctx: ServiceContext, s: LearningSignalInput): Promise<void> {
    await recordLearningSignal(asTx(ctx), ctx.accountId, s);
  }

  /**
   * Executor-level record so callers already inside a transaction (ApprovalService,
   * ScreenerService) can enroll the signal + counter bump atomically with their
   * own writes. Idempotent on `(accountId, triggeringActionId)`: a replayed action
   * inserts nothing and — crucially — bumps no counter.
   */
  async recordOn(tx: Tx, accountId: string, s: LearningSignalInput): Promise<void> {
    await recordLearningSignal(tx, accountId, s);
  }

  /** True when the (pattern, action) has graduated — the same read the 1c pipeline performs. */
  async isGraduated(ctx: ServiceContext, patternKey: string, action: "route" = "route"): Promise<boolean> {
    const rows = await asTx(ctx)
      .select({ graduated: graduations.graduated })
      .from(graduations)
      .where(and(
        eq(graduations.accountId, ctx.accountId),
        eq(graduations.patternKey, patternKey),
        eq(graduations.action, action),
        eq(graduations.graduated, true),
      ))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Promotion / demotion pass for a pattern. When a `sender:<addr>→<dest>`
   * pattern has graduated and no equivalent enabled promoted rule exists yet, create
   * one. When accumulated overrides push net negative past the demotion threshold,
   * disable the promoted rule (`demotions++`) and clear `graduated` — all in SQL.
   */
  async promoteOrDemote(ctx: ServiceContext, patternKey: string): Promise<void> {
    const outer = asTx(ctx);
    const [g] = await outer
      .select()
      .from(graduations)
      .where(and(
        eq(graduations.accountId, ctx.accountId),
        eq(graduations.patternKey, patternKey),
        eq(graduations.action, "route"),
      ))
      .limit(1);
    if (!g) return;

    const parsed = parsePatternKey(patternKey);
    if (!parsed) return;

    const net = g.positives - g.negatives;
    const promote = g.graduated && net >= GRADUATION_THRESHOLD;
    // The SHARED effect, not a second spelling of it. This arm is the LIFETIME-net trigger;
    // `recordRouteOverride` is the recent-override one, and both have to disable the same rule
    // and clear the same flag or a route can be demoted by one reading and not the other.
    const demote = !promote && net <= -DEMOTION_THRESHOLD;
    if (!promote && !demote) return;

    /**
     * THE ROW AND ITS DELTA COMMIT TOGETHER, which is why the transaction is opened here and was
     * not before. `rule` is a synced entity: a promotion that moved the row and no change row
     * leaves every client showing the rule the way it was, with nothing wrong at the write and
     * nothing later to correct it. `recordRuleDelta` refuses an autocommit handle for that
     * reason, and this method is called from OUTSIDE `ApprovalService`'s own transaction.
     *
     * Dialect is resolved from `tx`, not from the outer handle: the brand is inherited by
     * transactions, and the two writes below belong to one decision.
     */
    /* THROUGH THE SEAM. `rules` is a table the Art. 17 sweep empties and the approval that leads
       here is read before this transaction opens: an erasure committing in between met a
       promotion that inserted the rule and its change-log row into an account that was gone. */
    await withAccountTx(ctx, async (tx) => {
      const d = dialect(tx);
      if (promote) {
        await this.ensurePromotedRule(tx, d, ctx.accountId, parsed);
        return;
      }
      const { ruleIds } = await demoteGraduatedRoute(tx, ctx.accountId, patternKey);
      await recordRuleDelta(tx, ctx.accountId, ruleIds, "update");
    });
  }

  /**
   * The promotion write, and its delta beside it: whichever arm moves the row files for that row,
   * in this transaction. Nothing is announced when the rule was already standing exactly like
   * this — a delta a client cannot tell from a real move is noise.
   */
  private async ensurePromotedRule(
    tx: LedgerTx, d: Dialect, accountId: string, p: ParsedPattern,
  ): Promise<void> {
    // Locally, rather than as a claim about the one caller: this method inserts into `rules` and
    // a second caller opening its own transaction would leave the promotion unfenced while the
    // door above still read as covering it.
    await fenceErased(tx, d, { accountId });
    const existing = await tx
      .select({ id: rulesTbl.id })
      .from(rulesTbl)
      .where(and(
        eq(rulesTbl.accountId, accountId),
        eq(rulesTbl.kind, p.kind),
        eq(rulesTbl.match, p.match),
        eq(rulesTbl.destination, p.destination),
      ))
      .limit(1);
    if (existing.length > 0) {
      // `enabled = false` in the WHERE, so the returned row is the one whose state CHANGED —
      // the same construction the demotion uses, for the same reason: a delta announcing a rule
      // that already read this way is noise a client cannot tell from a real move.
      const flipped = await tx.update(rulesTbl)
        .set({ enabled: true, updatedAt: d.now() })
        .where(and(eq(rulesTbl.id, existing[0]!.id), eq(rulesTbl.enabled, false)))
        .returning({ id: rulesTbl.id });
      await recordRuleDelta(tx, accountId, flipped.map((r) => r.id), "update");
      return;
    }
    /* THE RETRO REQUEST IS PART OF THIS WRITE, not a later press (the 2026-09-16 ruling).
       A promotion is a decision the person made — it graduates off their own approvals — and a
       rule that claims a sender's mail without asking for the backlog leaves that mail where it
       was. Measured on a live account: eight rules created over two days with retro_requested_at
       NULL, and fifteen of their messages still at the gate days later, which is what the release
       screen was counting. Stamped HERE so the rule and the request commit together; `null` would
       mean "nobody asked", which is the state that produced the defect. */
    const [row] = await tx.insert(rulesTbl).values({
      accountId, kind: p.kind, match: p.match, destination: p.destination,
      provenance: "promoted", enabled: true, retroRequestedAt: d.now(),
    }).returning({ id: rulesTbl.id });
    await recordRuleDelta(tx, accountId, [row!.id], "create");
  }

}

export const learningService = new LearningService();
