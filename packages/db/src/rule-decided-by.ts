import { and, eq, inArray, sql } from "drizzle-orm";
import { learningSignals } from "./schema-mail.js";
import type { Tx } from "./change-log.js";
import { canonicalNewsSpelling } from "./screener-apply.js";

/** The prefix the act on suggestions stamps on every decision it makes. One spelling, three readers. */
export const SCREENER_ACT_TRIGGER_PREFIX = "screener:auto:";

/** The rule fields the reading needs; a whole `rules` row satisfies it. */
export interface ActRuleFacts {
  id: string;
  kind: string;
  match: string;
  destination: string;
  provenance: string;
  personDecidedAt: Date | null;
}

/** Sender lists are bounded per statement, well under either store's parameter ceiling. */
const SENDERS_PER_READ = 500;

/**
 * WHICH OF THESE RULES THE ACT ON SUGGESTIONS WROTE — the Rules pane's "Decided for you by ohmail".
 * A promoted sender rule no person stamped (`person_decided_at` NULL), whose sender has a decision
 * from the act INTO THIS RULE'S DESTINATION and none from anybody else. The column alone is not
 * enough: it has no backfill, so every press before mail 0128 reads NULL too, and a "Not junk"
 * rescue writes a promoted rule without it. One statement per {@link SENDERS_PER_READ} senders.
 */
export async function rulesTheActWrote(
  tx: Tx, accountId: string, rules: readonly ActRuleFacts[],
): Promise<Set<string>> {
  const candidates = rules.filter((r) =>
    r.provenance === "promoted" && r.kind === "sender" && r.personDecidedAt === null);
  const out = new Set<string>();
  if (candidates.length === 0) return out;

  const senderOf = (match: string): string => match.trim().toLowerCase();
  const senders = [...new Set(candidates.map((r) => senderOf(r.match)))];
  const sender = sql<string>`lower(${learningSignals.senderAddress})`;
  const act = `${SCREENER_ACT_TRIGGER_PREFIX}%`;
  const pressed = new Set<string>();
  const actInto = new Map<string, Set<string>>();
  for (let i = 0; i < senders.length; i += SENDERS_PER_READ) {
    const rows = await tx.select({
      sender,
      destination: learningSignals.destination,
      act: sql<number>`max(case when ${learningSignals.triggeringActionId} like ${act} then 1 else 0 end)`,
      other: sql<number>`max(case when ${learningSignals.triggeringActionId} like ${act} then 0 else 1 end)`,
    }).from(learningSignals)
      .where(and(
        eq(learningSignals.accountId, accountId),
        eq(learningSignals.kind, "screener"),
        inArray(sender, senders.slice(i, i + SENDERS_PER_READ)),
      ))
      .groupBy(sender, learningSignals.destination);
    for (const r of rows) {
      if (Number(r.other) === 1) pressed.add(r.sender);
      if (Number(r.act) === 1 && r.destination !== null) {
        const into = actInto.get(r.sender) ?? new Set<string>();
        into.add(canonicalNewsSpelling(r.destination));
        actInto.set(r.sender, into);
      }
    }
  }
  for (const r of candidates) {
    const s = senderOf(r.match);
    if (!pressed.has(s) && actInto.get(s)?.has(canonicalNewsSpelling(r.destination))) out.add(r.id);
  }
  return out;
}
