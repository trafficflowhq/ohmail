import { and, eq } from "drizzle-orm";
import {
  graduations, rules as rulesTbl, type Tx,
  recordLearningSignal, patternKeyFor, parsePatternKey, demoteGraduatedRoute,
  GRADUATION_THRESHOLD, DEMOTION_THRESHOLD,
  type LearningSignalInput, type LearningKind, type LearningLabel, type ParsedPattern,
} from "@trafficflow/db";
import { dialect, type Dialect } from "@trafficflow/db/dialect";
import type { ServiceContext } from "./context.js";

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
    const tx = asTx(ctx);
    // Read from the handle and threaded down rather than resolved again in each helper: the two
    // writes below belong to one decision, and a store that answered them differently would be a
    // program running against two databases.
    const d = dialect(ctx.db);
    const [g] = await tx
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
    if (g.graduated && net >= GRADUATION_THRESHOLD) {
      await this.ensurePromotedRule(tx, d, ctx.accountId, parsed);
    } else if (net <= -DEMOTION_THRESHOLD) {
      // The SHARED effect, not a second spelling of it. This arm is the LIFETIME-net trigger;
      // `recordRouteOverride` is the recent-override one, and both have to disable the same rule
      // and clear the same flag or a route can be demoted by one reading and not the other.
      await demoteGraduatedRoute(tx, ctx.accountId, patternKey);
    }
  }

  private async ensurePromotedRule(tx: Tx, d: Dialect, accountId: string, p: ParsedPattern): Promise<void> {
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
      await tx.update(rulesTbl).set({ enabled: true, updatedAt: d.now() }).where(eq(rulesTbl.id, existing[0]!.id));
      return;
    }
    await tx.insert(rulesTbl).values({
      accountId, kind: p.kind, match: p.match, destination: p.destination,
      provenance: "promoted", enabled: true,
    });
  }

}

export const learningService = new LearningService();
