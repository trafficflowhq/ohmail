import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import {
  messages, rules, learningSignals, workflowProposals, type Tx,
} from "@trafficflow/db";
import { validateSteps, validateTrigger, type WorkflowStep, type WorkflowTrigger } from "../../workflow-shapes.js";
import type { WorkflowPattern, WorkflowProposal, WorkflowPort } from "./propose.js";

// Pattern ASSEMBLY + proposal GENERATION. In CORE (db-coupled, worker-importable — the executor's
// seam) so the worker's `proposal-cron` and the services `ProposalsService` both delegate here
// without the worker importing services; the AI port is injected. REDACTION:
// `assembleWorkflowPatterns` emits non-sensitive pattern METADATA only — sender/domain,
// destination, recurrence count, provenance — drawn from `learning_signals` and enabled `rules`.
// It never reads a body, snippet or subject, and it STRUCTURALLY excludes any pattern whose
// sender or domain has any sensitivity-flagged message, so a suggestion derived from sensitive
// mail can never be surfaced or sent to the model. `buildProposeParams` re-asserts the redaction
// allowlist as defence in depth.

/** How many times a sender→destination pattern must recur before it is a candidate. */
export const RECURRENCE_THRESHOLD = 3;

export interface AssemblePatternsOpts {
  /** Override the recurrence threshold (tests seed few rows). */
  threshold?: number;
}

/**
 * Assemble the redaction-safe recurring patterns for one account. Metadata only,
 * sensitive senders/domains excluded structurally.
 */
export async function assembleWorkflowPatterns(
  db: Tx, accountId: string, opts: AssemblePatternsOpts = {},
): Promise<WorkflowPattern[]> {
  const threshold = opts.threshold ?? RECURRENCE_THRESHOLD;

  // 1. The sensitive frontier: every sender/domain with ANY sensitivity-flagged
  //    message. A pattern touching one of these is dropped below — never surfaced.
  const sensRows = await db.select({ from: messages.fromAddress }).from(messages)
    .where(and(
      eq(messages.accountId, accountId),
      or(
        eq(messages.noAi, true), eq(messages.noForward, true), eq(messages.noKb, true),
        isNotNull(messages.sensitivityCategory), eq(messages.priority, true),
      ),
    ));
  const sensitiveSenders = new Set<string>();
  const sensitiveDomains = new Set<string>();
  for (const r of sensRows) {
    const addr = (r.from ?? "").toLowerCase();
    if (!addr) continue;
    sensitiveSenders.add(addr);
    const dom = addr.split("@")[1];
    if (dom) sensitiveDomains.add(dom);
  }

  const patterns: WorkflowPattern[] = [];

  // 2. Recurring POSITIVE learning signals, grouped by sender/domain → destination.
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

  // 3. Established, enabled rules — deliberate recurring routing the user already set.
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

  // 4. Sensitive exclusion — drop any pattern whose sender/domain touches sensitive mail.
  return patterns.filter((p) => {
    const addr = (p.senderAddress ?? "").toLowerCase();
    const dom = (p.senderDomain ?? "").toLowerCase();
    if (addr && sensitiveSenders.has(addr)) return false;
    if (dom && sensitiveDomains.has(dom)) return false;
    return true;
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
}

/**
 * Generate proposals for one account. Assemble redacted patterns → ask for
 * authorization to spend, but only if there is anything to spend ON → ask the injected port →
 * DROP any proposal whose steps declare a non-allowlisted tool or whose trigger is
 * malformed → REPLACE the account's OPEN proposals in one tx so a re-run never piles up
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
  const proposals = patterns.length === 0 ? [] : await deps.port.propose(patterns);

  // The allowlist gate: keep only proposals whose every step is an allowlisted tool + valid trigger.
  const valid = proposals.filter((p: WorkflowProposal) =>
    p.name.trim().length > 0 && validateSteps(p.steps).ok && validateTrigger(p.trigger).ok);

  const now = deps.now?.() ?? new Date();
  return db.transaction(async (tx) => {
    // Dedup semantics: replace the OPEN set (re-running never accumulates dups).
    await tx.delete(workflowProposals)
      .where(and(eq(workflowProposals.accountId, accountId), eq(workflowProposals.status, "open")));
    if (valid.length === 0) return [];
    const rows = await tx.insert(workflowProposals).values(valid.map((p, i) => ({
      accountId,
      name: p.name,
      rationale: p.rationale,
      trigger: p.trigger,
      steps: p.steps,
      sourcePattern: patterns[i] ?? null,   // best-effort provenance hint (audit/UI only)
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
