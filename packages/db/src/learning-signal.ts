import { sql } from "drizzle-orm";
import { graduations, learningSignals } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE LEARNING SIGNAL WRITE, ON ITS OWN LEAF — MOVED DOWN THE SPINE FOR `flag-intent.ts`'s REASON
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `LearningService.recordOn` (`packages/services/src/learning-service.ts`) is the only writer
 * this had, and it still is the CALLER — this module is not a second implementation, it is the
 * first one moved to where a second caller can reach it without importing `@trafficflow/services`.
 * The organizer's request drain (`apps/worker/src/request-drain.ts`, 0.14.1) applies a reader's
 * screener decision — one of `ScreenerService.decide`'s effects, alongside the promoted rule and
 * the re-route — and the worker may not import the services package at runtime
 * (`apps/worker/package.json` "//services-is-test-only": a CJS `sanitize-html` re-entering an ESM
 * `htmlparser2` mid-evaluation is a hard `ERR_REQUIRE_CYCLE_MODULE` on Node 23). `screener-suggestion.ts`
 * beside this file states the identical argument for the identical reason.
 *
 * So the SQL lives here, where both the service layer and the worker can reach it (`@trafficflow/core`
 * and `@trafficflow/db` are the worker's whole runtime closure), and `LearningService.recordOn`
 * becomes a thin wrapper that calls it — one implementation, not two spellings of the same insert
 * and counter bump. Everything else `LearningService` does (`promoteOrDemote`, `isGraduated`, the
 * graduation/demotion sweep) reads `graduations` rather than writing `learning_signals` on this
 * path and stays exactly where it is; only the write this second caller needs moved.
 */

/** Net (positives − negatives) a (pattern, action) must reach before it graduates. */
export const GRADUATION_THRESHOLD = 3;
/** Net-negative margin at which an accumulated set of overrides demotes/unpromotes a pattern. */
export const DEMOTION_THRESHOLD = 2;

export type LearningKind = "screener" | "approval" | "override" | "external_move";
export type LearningLabel = "positive" | "negative";

/**
 * `destination` is `string`, not `@trafficflow/core/mail`'s `Destination` — this package must not
 * import `@trafficflow/core` (see `organizer-role.ts#CAPABILITY_REQUESTS` for the dependency
 * direction this follows: core depends on db, never the reverse). The exhaustiveness a typed
 * union buys belongs to the caller; this layer stores what it is given, exactly as the column
 * underneath it is untyped `text`.
 */
export interface LearningSignalInput {
  triggeringActionId: string;
  kind: LearningKind;
  senderAddress?: string | null;
  senderDomain?: string | null;
  destination?: string | null;
  label: LearningLabel;
}

/** Deterministic pattern key the pipeline's `RoutingPort.isGraduated` also reads. */
export function patternKeyFor(
  s: { senderAddress?: string | null; senderDomain?: string | null; destination?: string | null },
): string | null {
  if (!s.destination) return null;
  if (s.senderAddress) return `sender:${s.senderAddress.toLowerCase()}→${s.destination}`;
  if (s.senderDomain) return `domain:${s.senderDomain.toLowerCase()}→${s.destination}`;
  return null;
}

/**
 * Advance the (pattern, action='route') counters entirely in SQL — see
 * `LearningService.bumpCounter`'s original docblock, reproduced here verbatim because the
 * reasoning is unchanged by the move:
 *
 *   positives = positives + 1   (or negatives = negatives + 1)
 *
 * and flip `graduated` in the same statement, guarded so it is sticky once set and only trips
 * when net (positives − negatives) reaches the threshold. Because the increment and the flip are
 * one `ON CONFLICT DO UPDATE`, two concurrent writers serialize on the row lock and neither loses
 * an increment.
 */
async function bumpCounter(tx: Tx, accountId: string, patternKey: string, label: LearningLabel): Promise<void> {
  const pos = label === "positive" ? 1 : 0;
  const neg = label === "negative" ? 1 : 0;
  const net = sql`(${graduations.positives} + ${pos}) - (${graduations.negatives} + ${neg})`;
  await tx
    .insert(graduations)
    .values({ accountId, patternKey, action: "route", positives: pos, negatives: neg, graduated: false })
    .onConflictDoUpdate({
      target: [graduations.accountId, graduations.patternKey, graduations.action],
      set: {
        positives: sql`${graduations.positives} + ${pos}`,
        negatives: sql`${graduations.negatives} + ${neg}`,
        graduated: sql`(${graduations.graduated} OR ${net} >= ${GRADUATION_THRESHOLD})`,
        graduatedAt: sql`CASE WHEN ${graduations.graduatedAt} IS NULL AND ${net} >= ${GRADUATION_THRESHOLD} THEN now() ELSE ${graduations.graduatedAt} END`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Record one learning-relevant action as a `learning_signals` row **deduped by
 * `triggeringActionId`**, and advance the `graduations` counters. Idempotent on `(accountId,
 * triggeringActionId)`: a replayed action inserts nothing and — crucially — bumps no counter,
 * which is what makes this safe to call from the drain's own idempotency-guarded retry.
 */
export async function recordLearningSignal(tx: Tx, accountId: string, s: LearningSignalInput): Promise<void> {
  const inserted = await tx
    .insert(learningSignals)
    .values({
      accountId,
      triggeringActionId: s.triggeringActionId,
      kind: s.kind,
      senderAddress: s.senderAddress ?? null,
      senderDomain: s.senderDomain ?? null,
      destination: s.destination ?? null,
      label: s.label,
    })
    .onConflictDoNothing({ target: [learningSignals.accountId, learningSignals.triggeringActionId] })
    .returning({ id: learningSignals.id });

  // Duplicate triggering action → signal already recorded → do NOT double-count.
  if (inserted.length === 0) return;

  const patternKey = patternKeyFor(s);
  if (!patternKey) return;
  await bumpCounter(tx, accountId, patternKey, s.label);
}
