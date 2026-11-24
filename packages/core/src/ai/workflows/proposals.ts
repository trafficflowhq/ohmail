import type { WorkflowPattern, WorkflowStep, WorkflowTrigger } from "@ohmail/wire";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  rules, learningSignals, workflowProposals, fencedAccountWrite, type Tx,
} from "@trafficflow/db";
import { canonicalDestination, DESTINATIONS } from "../../types.js";
import type { Logger } from "../../log.js";
import { deriveProposals, type WorkflowPort } from "./propose.js";

// The proposal pass sends account-scoped sender and routing pattern metadata.

/** How many times a sender→destination pattern must recur before it is a candidate. */
export const RECURRENCE_THRESHOLD = 3;

export interface AssemblePatternsOpts {
  /** Override the recurrence threshold (tests seed few rows). */
  threshold?: number;
}

/**
 * Assemble recurring pattern metadata for one account.
 */
export async function assembleWorkflowPatterns(
  db: Tx, accountId: string, opts: AssemblePatternsOpts = {},
): Promise<WorkflowPattern[]> {
  const threshold = opts.threshold ?? RECURRENCE_THRESHOLD;

  const patterns: WorkflowPattern[] = [];

  // Recurring POSITIVE learning signals, grouped by sender/domain → destination.
  const signalRows = await db.select({
    senderAddress: learningSignals.senderAddress,
    senderDomain: learningSignals.senderDomain,
    destination: learningSignals.destination,
    count: sql<number>`count(*)::int`,
  }).from(learningSignals)
    .where(and(
      eq(learningSignals.accountId, accountId),
      eq(learningSignals.label, "positive"),
      isNotNull(learningSignals.destination),
    ))
    .groupBy(learningSignals.senderAddress, learningSignals.senderDomain, learningSignals.destination);
  for (const r of signalRows) {
    if (r.count < threshold) continue;             // only RECURRING patterns
    if (r.senderAddress) {
      patterns.push({
        kind: "sender", senderAddress: r.senderAddress,
        ...(r.senderDomain ? { senderDomain: r.senderDomain } : {}),
        ...(r.destination ? { destination: r.destination } : {}),
        count: r.count, provenance: "learning",
      });
    } else if (r.senderDomain) {
      patterns.push({
        kind: "domain", senderDomain: r.senderDomain,
        ...(r.destination ? { destination: r.destination } : {}),
        count: r.count, provenance: "learning",
      });
    }
  }

  // Established, enabled rules — deliberate recurring routing the user already set.
  const ruleRows = await db.select({
    kind: rules.kind, match: rules.match, destination: rules.destination, hits: rules.hits,
  }).from(rules).where(and(eq(rules.accountId, accountId), eq(rules.enabled, true)));
  for (const r of ruleRows) {
    if (r.kind === "sender") {
      const dom = r.match.split("@")[1];
      patterns.push({
        kind: "sender", senderAddress: r.match, ...(dom ? { senderDomain: dom } : {}),
        destination: r.destination, count: Math.max(r.hits, 1), provenance: "rule",
      });
    } else if (r.kind === "domain") {
      patterns.push({
        kind: "domain", senderDomain: r.match, destination: r.destination,
        count: Math.max(r.hits, 1), provenance: "rule",
      });
    }
  }

  // Canonical destinations only: a pattern routed anywhere else (Junk, Trash, a folder of the
  //    person's own) is never offered to the model, so no proposal can name one.
  return patterns.flatMap((p) => {
    const destination = p.destination === undefined ? undefined : canonicalDestination(p.destination);
    if (destination === undefined || !(DESTINATIONS as readonly string[]).includes(destination)) return [];
    return [{ ...p, destination }];
  });
}

/** A stored proposal, driver-agnostic (the service maps it to a DTO with ISO dates). */
export interface StoredProposal {
  id: string;
  name: string;
  rationale: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  sourcePattern: WorkflowPattern | null;
  status: string;
  createdAt: Date;
}

export interface GenerateProposalsDeps {
  port: WorkflowPort;                                    // INJECTED (mocked in tests)
  now?: () => Date;
  threshold?: number;
  /**
   * The spend authorization — asked AFTER assembly, immediately before the model, and only when
   * there is something to ask about; `false` abandons the pass, touching nothing. A callback
   * rather than a gate because this module is core: it owns the ORDER, the worker owns the money.
   * Both halves are corrections: the worker used to charge before this ran, so an account with no
   * recurring patterns paid for a pass the proposer short-circuits to `[]` — the one bill the
   * ledger could never explain; and a refusal must not fall through into the transaction below,
   * whose first act DELETES the account's open proposals — wiping the suggestions you had is
   * worse than showing yesterday's.
   */
  authorize?: (patterns: WorkflowPattern[]) => Promise<boolean>;
  beforeDispatch?: () => Promise<void>;
  /** Where the dropped answers are counted, by class and never by content. Absent ⇒ silent. */
  log?: Logger;
}

/**
 * Generate proposals for one account. Assemble redacted patterns → ask for
 * authorization to spend, but only if there is anything to spend ON → ask the injected port →
 * DERIVE each answer's trigger and step args from the pattern it names, dropping and counting
 * every answer that is not exactly the schema's shape (`deriveProposals`) → REPLACE the account's OPEN proposals in one tx so a re-run never piles up
 * duplicates. `materialized`/`dismissed` rows are untouched (a dismissed suggestion is never
 * resurrected). Proposals are INERT storage — this never creates or enables a workflow.
 */
export async function generateProposals(
  db: Tx, accountId: string, deps: GenerateProposalsDeps,
): Promise<StoredProposal[]> {
  const patterns = await assembleWorkflowPatterns(db, accountId, { threshold: deps.threshold });
  // No patterns ⇒ no model call is possible (`makeOpusProposer` returns `[]` on an empty list
  // before it builds a request), so there is nothing to authorize and nothing to charge. The
  // pass still runs to completion — the empty result clears the open set exactly as it always
  // did — it is only the MONEY question that is skipped.
  if (patterns.length > 0 && deps.authorize && !(await deps.authorize(patterns))) return [];
  if (patterns.length > 0 && deps.beforeDispatch) await deps.beforeDispatch();
  const proposals = patterns.length === 0 ? [] : deps.beforeDispatch
    ? await deps.port.propose(patterns, { beforeDispatch: deps.beforeDispatch })
    : await deps.port.propose(patterns);

  // BEFORE the write below: an answer that cannot be stored must never cost the open set.
  const { proposals: valid, dropped } = deriveProposals(proposals, patterns);
  for (const [reason, count] of Object.entries(dropped)) {
    deps.log?.info("proposal_dropped", { accountId, reason, count });
  }

  const now = deps.now?.() ?? new Date();
  /* THROUGH THE SEAM. The proposal pass reads correspondent patterns and then AWAITS A MODEL —
     seconds, sometimes longer — so an erasure committing inside that window met an unfenced
     insert that put the patterns back as generated workflow text. "A background pass, no session"
     was the reason it carried, and having no session is not having no subject. */
  return fencedAccountWrite(db, { accountId }, async (tx) => {
    // Dedup semantics: replace the OPEN set (re-running never accumulates dups).
    await tx.delete(workflowProposals)
      .where(and(eq(workflowProposals.accountId, accountId), eq(workflowProposals.status, "open")));
    if (valid.length === 0) return [];
    const rows = await tx.insert(workflowProposals).values(valid.map((p) => ({
      accountId,
      name: p.name,
      rationale: p.rationale,
      trigger: p.trigger,
      steps: p.steps,
      sourcePattern: p.sourcePattern,      // the pattern the answer named, by index
      status: "open",
      createdAt: now,
    }))).returning();
    return rows.map(toStored);
  });
}

function toStored(row: typeof workflowProposals.$inferSelect): StoredProposal {
  return {
    id: row.id,
    name: row.name,
    rationale: row.rationale,
    trigger: row.trigger as WorkflowTrigger,
    steps: row.steps as WorkflowStep[],
    sourcePattern: (row.sourcePattern as WorkflowPattern | null) ?? null,
    status: row.status,
    createdAt: row.createdAt,
  };
}
