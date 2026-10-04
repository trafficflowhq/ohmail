import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ACCOUNT_RULE_KEY_LOCK_CLASS, rules as rulesTbl } from "./schema-mail.js";
import { recordRuleDelta, type LedgerTx, type Tx } from "./change-log.js";
import { dialect } from "./dialect/index.js";
import { ruleMatchKeySql } from "./rule-match-sql.js";
import type { RuleKey } from "./request-apply.js";

/**
 * ONE RULE PER FOUR-FIELD KEY — the key lookup and the converge every rules writer goes through.
 * A leaf below `request-apply.ts` and `screener-apply.ts` (which imports nothing back from here
 * but types), so the Screener's decision and the organizer's apply share one door without an
 * import cycle between the two modules.
 */

const ledger = (tx: Tx): LedgerTx => tx as unknown as LedgerTx;

/**
 * What a key lookup reads back: the row's identity, and EVERY column a request could write.
 *
 * The state columns are here so the drain can compare rather than assume. A column named by
 * `RULE_CREATE_STATE` (request-apply.ts) and missing from the select would compare against `undefined`, decide
 * "differs" on every replay and rewrite the row for ever — the census refuses that pairing.
 */
export interface FoundRule {
  id: string;
  destination: string;
  priority: number;
  enabled: boolean;
  subjectContains: string | null;
  bodyContains: string | null;
  /** Never a request's to write; read so a person's press can make an inferred rule theirs. */
  provenance: string;
  /** Read for the reader's belt only (`settleReaderRuleRows`): when this row was last written. */
  updatedAt: Date | null;
  /** A person's Screener decision stamped it: the unsubscribe pass's licence, kept once given. */
  personDecidedAt: Date | null;
}

/**
 * EVERY ROW UNDER THE FOUR-FIELD KEY, the acting twin first. The match is compared key to key
 * (`ruleMatchKeySql` against the key the validator made), so a row `POST /rules` stored padded or
 * re-cased is found. Within one key the order is core's `compareTwins`: on before paused (the
 * router never runs a paused rule), then priority, effect, provenance and id — the first row is
 * the one the router runs. A parity test holds this SQL to that function.
 */
export async function findRulesByKey(
  tx: Tx, accountId: string, key: RuleKey, opts: { lock?: boolean } = {},
): Promise<FoundRule[]> {
  const q = tx.select({
    id: rulesTbl.id, destination: rulesTbl.destination,
    priority: rulesTbl.priority, enabled: rulesTbl.enabled,
    subjectContains: rulesTbl.subjectContains, bodyContains: rulesTbl.bodyContains,
    provenance: rulesTbl.provenance, updatedAt: rulesTbl.updatedAt, personDecidedAt: rulesTbl.personDecidedAt,
  })
    .from(rulesTbl)
    .where(and(
      eq(rulesTbl.accountId, accountId),
      eq(rulesTbl.kind, key.kind),
      sql`${ruleMatchKeySql(rulesTbl.match)} = ${key.match}`,
      key.subjectContains === null ? isNull(rulesTbl.subjectContains) : eq(rulesTbl.subjectContains, key.subjectContains),
      key.bodyContains === null ? isNull(rulesTbl.bodyContains) : eq(rulesTbl.bodyContains, key.bodyContains),
    ))
    .orderBy(
      desc(rulesTbl.enabled),
      desc(rulesTbl.priority),
      sql`case when ${rulesTbl.destination} in ('ohmail/Screener', 'ohmail/Screened', 'ohmail/Quarantine') then 0 else 1 end`,
      sql`case ${rulesTbl.provenance} when 'manual' then 0 when 'migrated' then 1 when 'promoted' then 2 when 'seeded-from-sent' then 3 else 4 end`,
      asc(rulesTbl.id),
    );
  // The belt reads to decide a write: the rows are held, so a local write in flight is read once committed.
  return opts.lock ? dialect(tx).forUpdate(q) : q;
}

/** The twins the acting row collapses: deleted in the caller's transaction, one delta each. */
async function deleteTwins(tx: Tx, accountId: string, twins: readonly FoundRule[]): Promise<bigint[]> {
  if (twins.length === 0) return [];
  const ids = twins.map((t) => t.id);
  await tx.delete(rulesTbl).where(and(eq(rulesTbl.accountId, accountId), inArray(rulesTbl.id, ids)));
  return recordRuleDelta(ledger(tx), accountId, ids, "delete");
}

/**
 * THE ACCOUNT'S RULE-KEY LOCK, the one statement every rules writer opens with: after the account
 * fence and any `account_settings` row, before the first `rules` statement and before any mailbox
 * row lock. A transaction-scoped advisory lock, so a second take in one transaction is free.
 */
export async function lockAccountRuleKeys(tx: Tx, accountId: string): Promise<void> {
  await dialect(tx).advisoryLock(tx, ACCOUNT_RULE_KEY_LOCK_CLASS, accountId);
}

/** What {@link convergeRuleKey} left under a key: the one row, the rows it deleted, their deltas. */
export interface ConvergedKey {
  /** The row that stays: the one asked for, else the acting row; `null` when the key has none or the asked-for id is not under it. */
  survivor: FoundRule | null;
  /** The row the router ran BEFORE the converge (the first under `findRulesByKey`'s order). */
  acting: FoundRule | null;
  /** Every other row under the key, deleted here, in the key's order. */
  collapsed: FoundRule[];
  /** One `delete` seq per collapsed row, in order; empty when none went. */
  twinSeqs: bigint[];
  lastSeq: bigint | null;
}

/**
 * ONE ROW PER FOUR-FIELD KEY, the primitive every rules writer converges through. Takes the
 * account's rule-key lock first (re-entrant per transaction), reads every row under the key,
 * acting first, and deletes all but the survivor with one `delete` delta each. `survivor` absent
 * keeps the ACTING row; given, that id, and nothing is deleted when it is not under the key.
 */
export async function convergeRuleKey(
  tx: Tx, input: { accountId: string; key: RuleKey; survivor?: string },
): Promise<ConvergedKey> {
  const { accountId, key } = input;
  await dialect(tx).advisoryLock(tx, ACCOUNT_RULE_KEY_LOCK_CLASS, accountId);
  const rows = await findRulesByKey(tx, accountId, key);
  const acting = rows[0] ?? null;
  const survivor = input.survivor === undefined ? acting : rows.find((r) => r.id === input.survivor) ?? null;
  if (survivor === null) return { survivor: null, acting, collapsed: [], twinSeqs: [], lastSeq: null };
  const collapsed = rows.filter((r) => r.id !== survivor.id);
  const twinSeqs = await deleteTwins(tx, accountId, collapsed);
  return { survivor, acting, collapsed, twinSeqs, lastSeq: twinSeqs[twinSeqs.length - 1] ?? null };
}

/** A `rules` write under a key, minus the key columns {@link writeRuleUnderKey} owns. */
export type RuleRowWrite = Omit<Partial<typeof rulesTbl.$inferInsert>, "id" | "accountId" | "kind" | "match" | "subjectContains" | "bodyContains">;

/** What {@link writeRuleUnderKey} did under the key. `lastSeq` is the last delta it recorded, if any. */
export interface KeyWriteResult {
  op: "create" | "update" | "unchanged" | "skipped";
  /** The one row under the key afterwards; `null` only when skipped over an empty key (never) or nothing was inserted. */
  ruleId: string | null;
  lastSeq: bigint | null;
  /** The row the router ran before the write, and the rows collapsed into the survivor. */
  acting: FoundRule | null;
  collapsed: FoundRule[];
}

/**
 * THE ONE WRITER FOR A DOOR THAT NAMES A SENDER, NOT A ROW (the Screener's decision, "Not junk,
 * always allow", the HEY import): converge the key onto its ACTING row, then write that row's
 * difference (`diff`, empty = unchanged, no delta) or insert `insert` where the key has none.
 * `skip` writes nothing at all over a key that has any row. Deltas: the twin deletes, then the
 * row's own, so the last seq names the row.
 */
export async function writeRuleUnderKey(tx: Tx, input: {
  accountId: string; key: RuleKey; now: Date;
  /** The stored spelling of `match` for an insert; the lookup always compares `key.match`. */
  match?: string;
  overExisting: "converge" | "skip";
  diff: (survivor: FoundRule) => RuleRowWrite;
  insert: RuleRowWrite & { destination: string };
}): Promise<KeyWriteResult> {
  const { accountId, key, now } = input;
  await dialect(tx).advisoryLock(tx, ACCOUNT_RULE_KEY_LOCK_CLASS, accountId);
  if (input.overExisting === "skip") {
    const [any] = await findRulesByKey(tx, accountId, key);
    if (any) return { op: "skipped", ruleId: null, lastSeq: null, acting: any, collapsed: [] };
  }
  const c = await convergeRuleKey(tx, { accountId, key });
  if (c.survivor) {
    const diff = input.diff(c.survivor);
    if (Object.keys(diff).length === 0) {
      return { op: "unchanged", ruleId: c.survivor.id, lastSeq: c.lastSeq, acting: c.acting, collapsed: c.collapsed };
    }
    await tx.update(rulesTbl).set({ ...diff, updatedAt: now })
      .where(and(eq(rulesTbl.id, c.survivor.id), eq(rulesTbl.accountId, accountId)));
    const lastSeq = (await recordRuleDelta(ledger(tx), accountId, [c.survivor.id], "update"))[0]!;
    return { op: "update", ruleId: c.survivor.id, lastSeq, acting: c.acting, collapsed: c.collapsed };
  }
  const [row] = await tx.insert(rulesTbl).values({
    updatedAt: now, ...input.insert,
    accountId, kind: key.kind, match: input.match ?? key.match,
    subjectContains: key.subjectContains, bodyContains: key.bodyContains,
  }).returning({ id: rulesTbl.id });
  const lastSeq = (await recordRuleDelta(ledger(tx), accountId, [row!.id], "create"))[0]!;
  return { op: "create", ruleId: row!.id, lastSeq, acting: null, collapsed: [] };
}

/** The Rules order's provenance rank (`rule-order.ts` PROVENANCE_RANK): lower ranks first. */
const PROVENANCE_ORDER: readonly string[] = ["manual", "migrated", "promoted", "seeded-from-sent"];

/**
 * A door's inferred write over an existing row keeps the better-ranked provenance: `manual` and
 * `migrated` stay, `seeded-from-sent` becomes `inferred`. Never makes a row `manual`.
 */
export function keptProvenance(own: string, inferred: "promoted"): string {
  const a = PROVENANCE_ORDER.indexOf(own);
  const b = PROVENANCE_ORDER.indexOf(inferred);
  return a !== -1 && a < b ? own : inferred;
}
