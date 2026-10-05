import { canonicalDestination } from "@trafficflow/core/mail";
import { ruleMatchKey } from "@trafficflow/core/rule-order";
import {
  fenceErased, lockAccountRuleKeys, writeRuleUnderKey, type LedgerTx, type Tx,
  recordLearningSignal, patternKeyFor, parsePatternKey, demoteRoute, graduationVerdict, routeIsLearned,
  GRADUATION_THRESHOLD, DEMOTION_THRESHOLD,
  type FoundRule, type RuleRowWrite,
  type LearningSignalInput, type LearningKind, type LearningLabel, type ParsedPattern,
} from "@trafficflow/db";
import { dialect, type Dialect } from "@trafficflow/db/dialect";
import { bridgeTx, withAccountTx, type ServiceContext } from "./context.js";

const asTx = (ctx: ServiceContext): Tx => bridgeTx(ctx.db);

/** A promotion nobody pressed: the only row a graduation may write over (never a person's). */
const promotedByNobody = (row: FoundRule): boolean => row.provenance === "promoted" && row.personDecidedAt === null;

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

  /**
   * True when the route is LEARNED — graduated, and no decision of the person's under the sender's
   * key ({@link routeIsLearned}): the one read the pipeline performs too.
   */
  async isGraduated(ctx: ServiceContext, patternKey: string, _action: "route" = "route"): Promise<boolean> {
    return routeIsLearned(asTx(ctx), ctx.accountId, patternKey);
  }

  /**
   * Promotion / demotion pass for a pattern, run AFTER the approval that fed it commits. A
   * learned `sender:<addr>→<dest>` pattern at the threshold writes its promoted rule under the
   * sender's key ({@link ensurePromotedRule}); a net past the demotion margin switches the
   * promoted rule off through the demotions' one door (`demoteRoute`), which records its own delta.
   */
  async promoteOrDemote(ctx: ServiceContext, patternKey: string): Promise<void> {
    const parsed = parsePatternKey(patternKey);
    if (!parsed) return;
    const verdict = await graduationVerdict(asTx(ctx), ctx.accountId, patternKey);
    if (verdict === "demote") {
      await demoteRoute(asTx(ctx), ctx.accountId, patternKey);
      return;
    }
    if (verdict !== "promote") return;
    /* THROUGH THE SEAM. `rules` is a table the Art. 17 sweep empties and the verdict is read before
       this transaction opens: an erasure committing in between met a promotion that inserted the
       rule and its change-log row into an account that was gone. */
    await withAccountTx(ctx, async (tx) => {
      // The account's rule-key lock after the fence, before the first `rules` statement.
      await lockAccountRuleKeys(bridgeTx(tx), ctx.accountId);
      // Asked again under the lock: a person's pause or removal committed since the verdict wins.
      if (!(await routeIsLearned(bridgeTx(tx), ctx.accountId, patternKey))) return;
      await this.ensurePromotedRule(tx, dialect(tx), ctx.accountId, parsed, ctx.now());
    });
  }

  /**
   * The promotion write, through the sender's KEY (LEARNING-PROMOTION-ADDS-A-TWIN): a key with no
   * row gets the promoted rule; a key whose every row is a promotion nobody pressed is converged
   * onto its acting row, switched on and retargeted there. A manual, migrated or person-decided
   * row under the key, paused included, is a decision, and nothing is written over it. Nothing is
   * announced when the row already reads this way.
   */
  private async ensurePromotedRule(
    tx: LedgerTx, d: Dialect, accountId: string, p: ParsedPattern, now: Date,
  ): Promise<void> {
    // Locally, rather than as a claim about the one caller: this method writes `rules`, and a
    // second caller opening its own transaction would leave the promotion unfenced.
    await fenceErased(tx, d, { accountId });
    /* THE RETRO REQUEST IS PART OF THIS WRITE (the 2026-09-16 ruling): a promotion graduates off
       the person's own approvals, and a rule that claims a sender's mail without asking for the
       backlog leaves that mail where it was (measured: fifteen messages still at the gate days
       later). `null` would mean "nobody asked", the state that produced the defect. */
    const retro = { retroRequestedAt: now, retroDoneAt: null, retroCursor: null, retroMoved: 0 };
    await writeRuleUnderKey(bridgeTx(tx), {
      accountId, now, overExisting: { onlyOver: promotedByNobody },
      key: { kind: p.kind, match: ruleMatchKey(p.match), subjectContains: null, bodyContains: null },
      diff: (row) => {
        const w: RuleRowWrite = {};
        if (canonicalDestination(row.destination) !== canonicalDestination(p.destination)) w.destination = p.destination;
        if (!row.enabled) w.enabled = true;
        // The backlog walk is asked for only where this promotion switched the rule on.
        return w.enabled === true ? { ...w, ...retro } : w;
      },
      insert: { destination: p.destination, provenance: "promoted", enabled: true, retroRequestedAt: now },
    });
  }

}

export const learningService = new LearningService();
