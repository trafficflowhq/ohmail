import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { ruleRemovals } from "./schema-mail.js";
import { ruleMatchKey } from "./rule-match-sql.js";
import type { Tx } from "./change-log.js";

/**
 * THE RULES A PERSON REMOVED (mail 0178), one row per rule key, so the settings copy can say which
 * rules were removed here and an Import elsewhere retires only those (`applyOrganizerProfile`).
 * Only a person's removal of one named rule is recorded; bulk and policy deletes are not, and a
 * missed site can only bring a rule back, never lose one. So a rule made again under a key ends
 * the key's removal ({@link clearRuleRemovals}), and a Screener start-over drops them all
 * (`resetScreeningState`). Every write runs in the caller's transaction, after the account's
 * rule-key lock; a removal is recorded at the caller's clock.
 */

/**
 * A removal's year. A copy carries only the removals of the year before it was written; this store
 * keeps a row until it records another removal more than a year later, the account is erased, a
 * rule is made again under the row's key, or the Screener is started over.
 */
export const RULE_REMOVAL_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * The longest key a removal is recorded under, in UTF-8 bytes: the primary key is a btree, which
 * refuses a key past a few kilobytes. A longer one goes unrecorded, so its rule can only come back.
 */
export const RULE_REMOVAL_KEY_MAX_BYTES = 2048;

const utf8Length = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { n += 4; i++; } else n += 3;
  }
  return n;
};

/** A rule's natural key, as a removal names it. */
export interface RuleRemovalKeyParts {
  kind: string;
  match: string;
  subjectContains?: string | null;
  bodyContains?: string | null;
}

/** One recorded removal; `removedBy` null is this store. */
export interface RuleRemoval {
  ruleKey: string;
  kind: string;
  match: string;
  subjectContains: string | null;
  bodyContains: string | null;
  removedAt: Date;
  removedBy: string | null;
}

/** THE ONE SPELLING of a rule's key, the settings import's: `ruleMatchKey`, terms lowercased. */
export function ruleRemovalKey(k: RuleRemovalKeyParts): string {
  return JSON.stringify([k.kind, ruleMatchKey(k.match), (k.subjectContains ?? "").toLowerCase(), (k.bodyContains ?? "").toLowerCase()]);
}

/**
 * Record each key removed at `at` by `by` (null: this store), keeping the newest instant per key, and
 * prune this account's rows older than a year before `now`.
 */
export async function recordRuleRemovals(
  tx: Tx, accountId: string, keys: readonly RuleRemovalKeyParts[], at: Date, by: string | null = null, now: Date = at,
): Promise<void> {
  for (const k of keys) {
    const ruleKey = ruleRemovalKey(k);
    if (utf8Length(ruleKey) > RULE_REMOVAL_KEY_MAX_BYTES) continue;
    const row = {
      kind: k.kind, match: k.match, subjectContains: k.subjectContains ?? null, bodyContains: k.bodyContains ?? null,
      removedAt: at, removedBy: by,
    };
    await tx.insert(ruleRemovals).values({ accountId, ruleKey, ...row })
      .onConflictDoUpdate({ target: [ruleRemovals.accountId, ruleRemovals.ruleKey], set: row, setWhere: lt(ruleRemovals.removedAt, at) });
  }
  await tx.delete(ruleRemovals).where(and(
    eq(ruleRemovals.accountId, accountId), lt(ruleRemovals.removedAt, new Date(now.getTime() - RULE_REMOVAL_MAX_AGE_MS)),
  ));
}

/**
 * A rule made again under each key (created there, or moved there) ends the key's removal: kept, it
 * would travel again once the rule left by a door that records nothing, and an Import elsewhere would
 * retire the rule the person made again. Whatever the instants say: the writer holds the rule-key
 * lock, so making the rule again is the later act here.
 */
export async function clearRuleRemovals(tx: Tx, accountId: string, keys: readonly RuleRemovalKeyParts[]): Promise<void> {
  const ruleKeys = [...new Set(keys.map(ruleRemovalKey))].filter((k) => utf8Length(k) <= RULE_REMOVAL_KEY_MAX_BYTES);
  if (ruleKeys.length === 0) return;
  await tx.delete(ruleRemovals).where(and(eq(ruleRemovals.accountId, accountId), inArray(ruleRemovals.ruleKey, ruleKeys)));
}

/** This account's removals, newest first. */
export async function readRuleRemovals(tx: Tx, accountId: string): Promise<RuleRemoval[]> {
  const rows = await tx.select().from(ruleRemovals).where(eq(ruleRemovals.accountId, accountId))
    .orderBy(desc(ruleRemovals.removedAt), ruleRemovals.ruleKey);
  return rows.map((r) => ({
    ruleKey: r.ruleKey, kind: r.kind, match: r.match, subjectContains: r.subjectContains, bodyContains: r.bodyContains,
    removedAt: new Date(r.removedAt as unknown as string | number | Date), removedBy: r.removedBy,
  }));
}
