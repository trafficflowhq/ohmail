import { and, eq, inArray, sql } from "drizzle-orm";
import { learningSignals, rules } from "./schema-mail.js";
import { recordRuleDelta, type LedgerTx, type Tx } from "./change-log.js";
import { canonicalNewsSpelling, ruleMatchKey } from "./screener-apply.js";
import { carryDialect } from "./dialect/index.js";

/**
 * THE ONE-TIME REPAIR FOR A PERSON'S PRESS THAT LEFT A SCREENER RULE INFERRED (0.25.9).
 *
 * Before 0.25.9 a press naming where a rule files left its `provenance` alone, so a Screener rule a
 * person moved to the Ohbox stayed `promoted` and `people_only` went on filing that sender's
 * newsletters to News. No store records who edited a rule, so the class is read by elimination,
 * and only the shape that needs no stamp comparison: a promoted rule at the Ohbox whose sender has
 * Screener decisions, none into the Ohbox, no approval into the Ohbox, and no rule of its key left
 * at a place a Screener decision named. Only a person's press moves that rule there.
 */

/** Keys per signal read, well under either store's parameter ceiling. */
const KEYS_PER_READ = 500;

export interface InferredPressPlan {
  /** Rule ids the repair makes the person's. Opaque: never an address. */
  ruleIds: string[];
}

interface RuleFacts {
  id: string; kind: string; match: string; destination: string; provenance: string;
  subjectContains: string | null; bodyContains: string | null;
}

const OHBOX = "INBOX";
const keyOf = (r: { kind: string; match: string }) => `${r.kind}\u0000${ruleMatchKey(r.match)}`;

/** Read-only: which of this account's rules the repair would write. */
export async function planInferredPressRepair(tx: Tx, accountId: string): Promise<InferredPressPlan> {
  const all: RuleFacts[] = await tx.select({
    id: rules.id, kind: rules.kind, match: rules.match, destination: rules.destination,
    provenance: rules.provenance, subjectContains: rules.subjectContains, bodyContains: rules.bodyContains,
  }).from(rules).where(eq(rules.accountId, accountId));

  const candidates = all.filter((r) => r.provenance === "promoted" && r.destination === OHBOX
    && (r.kind === "sender" || r.kind === "domain")
    && r.subjectContains === null && r.bodyContains === null);
  if (candidates.length === 0) return { ruleIds: [] };

  // Every place each key files to today, term-free rules only: the Screener's rule is term-free.
  const placesOfKey = new Map<string, Set<string>>();
  for (const r of all) {
    if (r.subjectContains !== null || r.bodyContains !== null) continue;
    const k = keyOf(r);
    const set = placesOfKey.get(k) ?? new Set<string>();
    set.add(canonicalNewsSpelling(r.destination));
    placesOfKey.set(k, set);
  }

  const senders = [...new Set(candidates.filter((r) => r.kind === "sender").map((r) => ruleMatchKey(r.match)))];
  const domains = [...new Set(candidates.filter((r) => r.kind === "domain").map((r) => ruleMatchKey(r.match)))];
  /** key -> the places Screener decisions named; and the keys an approval sent to the Ohbox. */
  const screened = new Map<string, Set<string>>();
  const approvedIntoOhbox = new Set<string>();
  const note = (k: string, dest: string | null) => {
    if (dest === null) return;
    const set = screened.get(k) ?? new Set<string>();
    set.add(canonicalNewsSpelling(dest));
    screened.set(k, set);
  };

  const sender = sql<string>`lower(${learningSignals.senderAddress})`;
  const domain = sql<string>`lower(${learningSignals.senderDomain})`;
  for (let i = 0; i < senders.length; i += KEYS_PER_READ) {
    const rows = await tx.select({ s: sender, kind: learningSignals.kind, d: learningSignals.destination })
      .from(learningSignals)
      .where(and(eq(learningSignals.accountId, accountId),
        inArray(learningSignals.kind, ["screener", "approval"]),
        inArray(sender, senders.slice(i, i + KEYS_PER_READ))));
    for (const r of rows) {
      const k = `sender\u0000${r.s}`;
      if (r.kind === "screener") note(k, r.d);
      else if (r.d !== null && canonicalNewsSpelling(r.d) === OHBOX) approvedIntoOhbox.add(k);
    }
  }
  for (let i = 0; i < domains.length; i += KEYS_PER_READ) {
    const part = domains.slice(i, i + KEYS_PER_READ);
    const rows = await tx.select({ dom: domain, d: learningSignals.destination })
      .from(learningSignals)
      .where(and(eq(learningSignals.accountId, accountId), eq(learningSignals.kind, "screener"),
        inArray(domain, part)));
    for (const r of rows) note(`domain\u0000${r.dom}`, r.d);
  }
  if (domains.length > 0) {
    // An approval names an address; its domain is the domain rule's key.
    const rows = await tx.select({ s: sender, d: learningSignals.destination }).from(learningSignals)
      .where(and(eq(learningSignals.accountId, accountId), eq(learningSignals.kind, "approval")));
    const wanted = new Set(domains);
    for (const r of rows) {
      const at = r.s?.lastIndexOf("@") ?? -1;
      const dom = at >= 0 ? r.s!.slice(at + 1) : "";
      if (wanted.has(dom) && r.d !== null && canonicalNewsSpelling(r.d) === OHBOX) approvedIntoOhbox.add(`domain\u0000${dom}`);
    }
  }

  const ruleIds = candidates.filter((r) => {
    const k = keyOf(r);
    const named = screened.get(k);
    if (named === undefined || named.size === 0) return false;
    if (approvedIntoOhbox.has(k)) return false;
    // A rule of the key at a place a Screener decision named — this rule included, so a Screener
    // decision into the Ohbox is one too — means the Screener can account for where it stands.
    const places = placesOfKey.get(k) ?? new Set<string>();
    for (const p of named) if (places.has(p)) return false;
    return true;
  }).map((r) => r.id);
  return { ruleIds };
}

export interface InferredPressRepairResult {
  planned: number;
  written: number;
}

/**
 * Plan and write in ONE transaction: `provenance` becomes `manual` for the planned rows still
 * `promoted`, nothing else changes (`updated_at` included), and each written row gets its rule
 * delta so every mirror learns it. A written row is no longer a candidate, so a re-run plans 0.
 */
export async function applyInferredPressRepair(db: Tx, accountId: string): Promise<InferredPressRepairResult> {
  return db.transaction(async (t) => {
    // The store's brand rides the transaction, or a device store's change-log write refuses.
    const tx = carryDialect(db, t as object) as unknown as Tx;
    const plan = await planInferredPressRepair(tx, accountId);
    if (plan.ruleIds.length === 0) return { planned: 0, written: 0 };
    const written = await tx.update(rules).set({ provenance: "manual" })
      .where(and(eq(rules.accountId, accountId), eq(rules.provenance, "promoted"), inArray(rules.id, plan.ruleIds)))
      .returning({ id: rules.id });
    await recordRuleDelta(tx as unknown as LedgerTx, accountId, written.map((r) => r.id), "update");
    return { planned: plan.ruleIds.length, written: written.length };
  });
}
