import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { graduations, learningSignals, rules } from "./schema-mail.js";
import type { Tx } from "./change-log.js";
import { dialect } from "./dialect/index.js";

/**
 * The learning-signal write, on its own leaf — moved down the spine for `flag-intent.ts`'s
 * reason. `LearningService.recordOn` is still the CALLER; this is the first implementation moved
 * to where a second caller reaches it without importing `@trafficflow/services`: the organizer's
 * request drain applies a reader's screener decision, and the worker may not import the services
 * package at runtime (a hard `ERR_REQUIRE_CYCLE_MODULE` on Node 23); `screener-suggestion.ts`
 * states the identical argument. The SQL lives here, where the service layer and the worker both
 * reach it, and `LearningService.recordOn` is a thin wrapper — one implementation, not two
 * spellings of one insert. Only the write this second caller needs moved.
 */

/** Net (positives − negatives) a (pattern, action) must reach before it graduates. */
export const GRADUATION_THRESHOLD = 3;
/** Net-negative margin at which an accumulated set of overrides demotes/unpromotes a pattern. */
export const DEMOTION_THRESHOLD = 2;

/**
 * Overrides of ONE graduated route, inside {@link OVERRIDE_WINDOW_MS}, that demote it.
 *
 * Separate from {@link DEMOTION_THRESHOLD}, which is a LIFETIME net over every kind of evidence.
 * A route that earned its graduation years ago and is being contradicted this fortnight has a
 * healthy lifetime net and is still wrong now, so a lifetime margin cannot see it.
 */
export const OVERRIDE_DEMOTION_THRESHOLD = 2;
/** How far back an override still counts. */
export const OVERRIDE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** A pattern key taken apart into the three columns `rules` stores it as. */
export interface ParsedPattern { kind: "sender" | "domain"; match: string; destination: string; }

/** The inverse of {@link patternKeyFor}. One owner, so the two spellings cannot drift. */
export function parsePatternKey(patternKey: string): ParsedPattern | null {
  const arrow = patternKey.indexOf("\u2192");
  if (arrow < 0) return null;
  const lhs = patternKey.slice(0, arrow);
  const destination = patternKey.slice(arrow + 1);
  const colon = lhs.indexOf(":");
  if (colon < 0) return null;
  const kind = lhs.slice(0, colon);
  const match = lhs.slice(colon + 1);
  if (kind !== "sender" && kind !== "domain") return null;
  return { kind, match, destination };
}

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
 * Advance the (pattern, action='route') counters entirely in SQL: positives = positives + 1 (or
 * negatives), and flip `graduated` in the same statement, guarded so it is sticky once set and
 * only trips when net (positives − negatives) reaches the threshold. Because the increment and
 * the flip are one `ON CONFLICT DO UPDATE`, two concurrent writers serialize on the row lock and
 * neither loses an increment.
 */
async function bumpCounter(tx: Tx, accountId: string, patternKey: string, label: LearningLabel): Promise<void> {
  // The current instant is spelled by the store, not by this module: the server has `now()` and
  // the device store has no such function at all — a statement carrying it there fails to parse,
  // in the middle of a write that is otherwise correct.
  const d = dialect(tx);
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
        graduatedAt: sql`CASE WHEN ${graduations.graduatedAt} IS NULL AND ${net} >= ${GRADUATION_THRESHOLD} THEN ${d.now()} ELSE ${graduations.graduatedAt} END`,
        updatedAt: d.now(),
      },
    });
}

/**
 * Record one learning-relevant action as a `learning_signals` row **deduped by
 * `triggeringActionId`**, and advance the `graduations` counters. Idempotent on `(accountId,
 * triggeringActionId)`: a replayed action inserts nothing and — crucially — bumps no counter,
 * which is what makes this safe to call from the drain's own idempotency-guarded retry.
 *
 * Answers whether THIS call inserted. Every caller before {@link recordRouteOverride} ignored
 * it, and that one cannot: an effect keyed on "a new signal arrived" must be able to tell a
 * first observation from a replay, and the insert is the only place that knows.
 */
export async function recordLearningSignal(tx: Tx, accountId: string, s: LearningSignalInput): Promise<boolean> {
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
  if (inserted.length === 0) return false;

  const patternKey = patternKeyFor(s);
  if (patternKey) await bumpCounter(tx, accountId, patternKey, s.label);
  return true;
}

/**
 * The override — a person's own hand outranks a graduated route from then on. Graduation is
 * earned and has to be undoable, by the only evidence that settles it: the person moving the mail
 * somewhere else. {@link recordRouteOverride} is the ONE definition of "this move contradicts a
 * route", and {@link demoteGraduatedRoute} the ONE effect — a second write site cannot mean
 * something slightly different by either. `learning_signals.triggering_action_id` already
 * specified this signal's identity (`move:<msgId>:<seq>`, beside `kind = 'external_move'`) and
 * nothing wrote it; the shape is kept because it makes a replayed adoption count once — the
 * unique is `(account_id, triggering_action_id)`.
 */

/** `move:<messageId>:<discriminator>` — the schema's own spelling, composed in one place. */
export function routeOverrideActionId(messageId: string, discriminator: string | bigint): string {
  return `move:${messageId}:${discriminator}`;
}

export interface RouteOverrideInput {
  /** The sender of the message that moved, however the route may have keyed it. */
  senderAddress?: string | null;
  senderDomain?: string | null;
  /** The folder the route filed it INTO — the placement the person has just contradicted. */
  filedTo: string;
  /** From {@link routeOverrideActionId}. What makes a replay of THIS move count once. */
  triggeringActionId: string;
  /** Injected so the window is deterministic under test; defaults to the wall clock. */
  now?: Date;
}

export interface RouteOverrideOutcome {
  patternKey: string;
  /** Overrides standing inside the window, this one included. */
  overrides: number;
  demoted: boolean;
  /**
   * Promoted rules this demotion switched OFF, if any.
   *
   * Returned rather than reported, because the delta a client needs can only be written by a
   * caller holding a ledger transaction and this module does not know whether it has one. A
   * caller that has one files an `update` for each id; see the `adopt_external` arm in
   * `packages/core/src/pipeline.ts`.
   */
  ruleIds: readonly string[];
}

/**
 * Demote a graduated route: switch off the promoted rule it produced, and clear `graduated` so
 * the pipeline stops auto-applying and goes back to PROPOSING.
 *
 * `enabled = true` is in the update's where clause, so `demotions` counts actual disablings and
 * the returned ids are exactly the rows whose state changed — which is what a delta must be.
 */
export async function demoteGraduatedRoute(
  tx: Tx, accountId: string, patternKey: string,
): Promise<{ demoted: boolean; ruleIds: string[] }> {
  const p = parsePatternKey(patternKey);
  if (!p) return { demoted: false, ruleIds: [] };
  const d = dialect(tx);
  const disabled = await tx
    .update(rules)
    .set({ enabled: false, demotions: sql`${rules.demotions} + 1`, updatedAt: d.now() })
    .where(and(
      eq(rules.accountId, accountId),
      eq(rules.kind, p.kind),
      eq(rules.match, p.match),
      eq(rules.destination, p.destination),
      eq(rules.provenance, "promoted"),
      eq(rules.enabled, true),
    ))
    .returning({ id: rules.id });
  await tx
    .update(graduations)
    .set({ graduated: false, updatedAt: d.now() })
    .where(and(
      eq(graduations.accountId, accountId),
      eq(graduations.patternKey, patternKey),
      eq(graduations.action, "route"),
    ));
  return { demoted: true, ruleIds: disabled.map((r) => r.id) };
}

/** Is this exact (account, pattern) route auto-applying today? */
async function isRouteGraduated(tx: Tx, accountId: string, patternKey: string): Promise<boolean> {
  const rows = await tx
    .select({ graduated: graduations.graduated })
    .from(graduations)
    .where(and(
      eq(graduations.accountId, accountId),
      eq(graduations.patternKey, patternKey),
      eq(graduations.action, "route"),
      eq(graduations.graduated, true),
    ))
    .limit(1);
  return rows.length > 0;
}

/**
 * Count this route's overrides inside the window.
 *
 * Matched on the SAME three columns the pattern is keyed on, the unused one asserted NULL: a
 * sender route's overrides are that sender's, and another sender to the same folder is not
 * evidence about it. The bound is bound as a Date against the COLUMN rather than spelled as an
 * interval in a fragment — a raw `now() - interval` does not parse on the device store, and a
 * parameter in a fragment has no column to take its type from.
 */
async function countOverridesInWindow(
  tx: Tx, accountId: string, pattern: { senderAddress: string | null; senderDomain: string | null },
  filedTo: string, since: Date,
): Promise<number> {
  const rows = await tx
    .select({ id: learningSignals.id })
    .from(learningSignals)
    .where(and(
      eq(learningSignals.accountId, accountId),
      eq(learningSignals.kind, "external_move"),
      eq(learningSignals.label, "negative"),
      eq(learningSignals.destination, filedTo),
      pattern.senderAddress === null
        ? isNull(learningSignals.senderAddress)
        : eq(learningSignals.senderAddress, pattern.senderAddress),
      pattern.senderDomain === null
        ? isNull(learningSignals.senderDomain)
        : eq(learningSignals.senderDomain, pattern.senderDomain),
      gt(learningSignals.createdAt, since),
    ));
  return rows.length;
}

/**
 * THE PREDICATE. An externally observed move away from where a GRADUATED route filed this message
 * is an override of that route; enough of them inside the window demote it. `null` means there
 * was nothing to contradict — no graduated route filed the message to `filedTo` (every ordinary
 * adoption) — or the move was a replay; both are silence rather than a verdict, because adoption
 * is commonplace and this seam sits on the ingest path. The SENDER key is asked before the DOMAIN
 * key: it is the specific pattern and the one the pipeline auto-applies on, and asking the domain
 * only when no sender route graduated stops an account holding both from counting one move twice.
 */
export async function recordRouteOverride(
  tx: Tx, accountId: string, input: RouteOverrideInput,
): Promise<RouteOverrideOutcome | null> {
  const candidates: { senderAddress: string | null; senderDomain: string | null }[] = [
    { senderAddress: input.senderAddress?.toLowerCase() ?? null, senderDomain: null },
    { senderAddress: null, senderDomain: input.senderDomain?.toLowerCase() ?? null },
  ];
  for (const pattern of candidates) {
    const patternKey = patternKeyFor({ ...pattern, destination: input.filedTo });
    if (!patternKey) continue;
    if (!(await isRouteGraduated(tx, accountId, patternKey))) continue;

    // Only a NEWLY inserted signal demotes. A replayed adoption inserts nothing, bumps no
    // counter, and must not spend a second override on one act of the person's.
    const inserted = await recordLearningSignal(tx, accountId, {
      triggeringActionId: input.triggeringActionId,
      kind: "external_move",
      ...pattern,
      destination: input.filedTo,
      label: "negative",
    });
    if (!inserted) return null;

    const since = new Date((input.now?.getTime() ?? Date.now()) - OVERRIDE_WINDOW_MS);
    const overrides = await countOverridesInWindow(tx, accountId, pattern, input.filedTo, since);
    if (overrides < OVERRIDE_DEMOTION_THRESHOLD) {
      return { patternKey, overrides, demoted: false, ruleIds: [] };
    }
    const { ruleIds } = await demoteGraduatedRoute(tx, accountId, patternKey);
    return { patternKey, overrides, demoted: true, ruleIds };
  }
  return null;
}
