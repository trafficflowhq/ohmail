import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  accountSettings, auditAction, auditLog, destinationIsDecisionSql, folderState, mailboxes,
  messages, recordRuleDelta, rules as rulesTbl, type LedgerTx, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { SCREENER_FOLDER } from "./screener-service.js";
import { ServiceError } from "./errors.js";
import { bridgeTx, withAccountTx, type ServiceContext } from "./context.js";

/* MAIL HELD AT THE GATE BEHIND A RULE ITS OWNER ALREADY WROTE — counted here, released by a press.
   An install that adopts mail at the screening gate records the placement as one no pass may
   revisit, and the rule's retroactive pass has long since finished, so nothing re-decides those
   rows. This module names that set ONCE — `heldReleaseGroups` shows it, `releaseHeld` acts on it —
   so the number a person is shown and the number a press releases cannot drift apart. The press
   moves no mail: it records consent on the rule and re-opens the rule's backlog, and `rule-retro`
   files the mail through the same rule engine a fresh arrival goes through. */

/**
 * The audit action one press writes, once per released group.
 *
 * The payload carries the group's identity and the count as measured at press time; what actually
 * moves is reported by the pass's own `rules.retro_moved`. Both are true and they answer different
 * questions — what was released, and what the rules then did with it.
 */
export const HELD_RELEASE_AUDIT_ACTION = auditAction("screener.held_release");

/**
 * How many groups one read returns and one press may act on.
 *
 * A bound rather than a page, because the screen is a summary: a mailbox with more than this many
 * DISTINCT rules holding mail at the gate is not a list somebody reads, and the tail is reached by
 * pressing the groups that are shown and asking again. It also bounds the press — the release is
 * one small UPDATE and one audit row per group, so this is the whole of its cost.
 */
export const HELD_RELEASE_GROUPS_MAX = 200;

/** One sender group: the rule that would file it, and how much of its mail is stuck at the gate. */
export interface HeldReleaseGroup {
  ruleId: string;
  kind: "sender" | "domain";
  /** The address or the domain the rule matches, lower-cased as stored. */
  match: string;
  /** Where the rule sends it — the destination the screen names beside the count. */
  destination: string;
  /** Held messages this rule would reach, by the predicate below. */
  count: number;
}

/** What a press did. `released` is the groups it acted on; a second press over the same set is empty. */
export interface HeldReleaseResult {
  released: HeldReleaseGroup[];
  /**
   * DISTINCT messages the press released — the headline number, and NOT the sum of the group
   * counts. One message can sit in two groups: a domain rule and a sender rule inside that domain
   * both claim it, and both are honest about what they would reach. Adding the groups up would
   * tell a person they have more held mail than they have, so the sum is never the total.
   */
  total: number;
}

/** The screen: the groups, how many distinct messages they hold, and the dismissal state. */
export interface HeldReleaseSummary {
  groups: HeldReleaseGroup[];
  total: number;
  /** The identity of THIS set — what a dismissal names. Empty groups fingerprint to "". */
  fingerprint: string;
  /** True when the account dismissed exactly this set. A changed set re-offers by construction. */
  dismissed: boolean;
}

/**
 * THE OFFER'S IDENTITY — a hash of the sorted (rule, destination, count) triples, so "the same
 * offer" is a fact about the SET and never about when it was read. Pure FNV-1a over the joined
 * triples rather than node:crypto, because this module is loaded by the phone bundle, which has
 * no node builtins. Not a security boundary: the value only ever meets an equality check against
 * what the same function produced.
 */
export function heldReleaseFingerprint(groups: readonly HeldReleaseGroup[]): string {
  if (groups.length === 0) return "";
  const text = groups
    .map((g) => `${g.ruleId}:${g.destination}:${g.count}`)
    .sort()
    .join("\n");
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `v1-${h.toString(16).padStart(16, "0")}`;
}

/**
 * THE PREDICATE, IN ONE PLACE. Held-by-a-decided-sender = placed by a KNOWN writer (allow-list
 * over the three `last_set_by` values; 'us' included — `confirmSeed` rules owe no backlog, so
 * 'us'-placed pre-seed mail sat unoffered for months), settled AT the gate (desired AND observed
 * both `ohmail/Screener`; two equalities so the mover census reads a folder constraint), in a
 * live organized mailbox, matched by an ENABLED sender/domain rule pointing off the gate, that
 * rule's backlog not already open (an owed rule is in flight — why a second press finds zero).
 * The user-intent exclusions here are the SAME three a RELEASE run applies — the own-reply arm
 * once kept ALL 57 offered rows, so it no longer binds one — one set, counted and moved.
 */
function heldAtGate(accountId: string) {
  return and(
    eq(messages.accountId, accountId),
    isNull(messages.deletedAt),
    sql`${folderState.lastSetBy} in ('external', 'peer', 'us')`,
    eq(folderState.desiredFolder, SCREENER_FOLDER),
    eq(folderState.observedFolder, SCREENER_FOLDER),
    sql`exists (
      select 1 from ${mailboxes} mb
       where mb.id = ${messages.mailboxId}
         and mb.status <> 'disabled'
         and mb.organizer_role = 'organizer'
    )`,
    sql`not exists (
      select 1 from message_states ms where ms.message_id = ${messages.id} and ms.state <> 'none'
    )`,
    sql`not exists (
      select 1 from drafts d where d.in_reply_to_message_id = ${messages.id}
    )`,
    sql`not exists (
      select 1 from approvals a where a.message_id = ${messages.id} and a.status <> 'pending'
    )`,
  );
}

/**
 * The rule's own half: enabled, pointing off the gate, and not already walking its backlog.
 *
 * The account clause here and the account tie in the join below are a PAIR, and either alone closes
 * cross-account reads — measured: removing one leaves every case green, removing both reddens five.
 * Both are kept because they say different things (this rule is mine; this rule and this message
 * belong to the same account) and a future join that drops one should not open the other.
 */
function decidedRule(accountId: string) {
  return and(
    eq(rulesTbl.accountId, accountId),
    eq(rulesTbl.enabled, true),
    sql`${rulesTbl.kind} in ('sender', 'domain')`,
    /* ONE DEFINITION OF DECIDED, and this call site does not own it: `destinationIsDecisionSql`
       is the same expression the Screener queue subtracts by, so a sender cannot be "already
       decided" here and "first-time waiting" there — which three senders on one live account
       were, with the two screens printing different counts of the same mailbox. It
       reads WIDER than the old `<> Screener` in nothing and narrower in one state: a destination
       outside the six is nobody's answer and no longer counts as a decision on either side. */
    destinationIsDecisionSql(sql`${rulesTbl.destination}`),
    // Not in flight — see the predicate note above. Either nobody ever asked, or the walk finished.
    or(isNull(rulesTbl.retroRequestedAt), isNotNull(rulesTbl.retroDoneAt)),
  );
}

/**
 * DOES THIS RULE CLAIM THIS SENDER — THE PASS'S OWN QUESTION, ASKED THROUGH THE DIALECT.
 *
 * This is `rule-retro.ts#matchPredicate` and `screener-service#heldRowsForDomain` written as a
 * join, and it must stay their twin: the set this COUNTS and the set the pass MOVES are offered to
 * a person as one number, so an expression that merely agrees on ordinary input is not good enough.
 * The domain arm goes through {@link Dialect.domainOf} rather than being spelled here, because this
 * module is LOADED BY THE PHONE BUNDLE — `substring … position` is a construct only the server
 * accepts, and a store that threw on it would answer the release screen with a crash rather than a
 * count (`dialect-census.test.ts` refuses the pg-only spelling by name).
 *
 * `trim(lower(…))` on the stored match is the SQL spelling of the pass's
 * `rule.match.trim().toLowerCase()`, and both stores have both functions.
 */
const ruleClaimsSender = (d: ReturnType<typeof dialect>) => sql`(
     (${rulesTbl.kind} = 'sender'
      and trim(lower(${rulesTbl.match})) = lower(${messages.fromAddress}))
  or (${rulesTbl.kind} = 'domain'
      and trim(lower(${rulesTbl.match})) = ${d.domainOf(messages.fromAddress)})
)`;

/** The screen's rows: every group with mail stuck behind it, largest first. */
export async function heldReleaseGroups(
  db: Tx, accountId: string,
): Promise<HeldReleaseGroup[]> {
  const d = dialect(db);
  const rows = await db
    .select({
      ruleId: rulesTbl.id, kind: rulesTbl.kind, match: rulesTbl.match,
      destination: rulesTbl.destination,
      count: sql<number>`${d.castInt(sql`count(${messages.id})`)}`,
    })
    .from(rulesTbl)
    .innerJoin(messages, and(eq(messages.accountId, rulesTbl.accountId), ruleClaimsSender(d)))
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(decidedRule(accountId), heldAtGate(accountId)))
    .groupBy(rulesTbl.id, rulesTbl.kind, rulesTbl.match, rulesTbl.destination)
    .orderBy(sql`count(${messages.id}) desc`, rulesTbl.id)
    .limit(HELD_RELEASE_GROUPS_MAX);

  return rows.map((r) => ({
    ruleId: r.ruleId, kind: r.kind as "sender" | "domain",
    match: r.match, destination: r.destination, count: Number(r.count),
  }));
}

/**
 * How many DISTINCT messages the given groups hold. Asked as its own query rather than summed,
 * for {@link HeldReleaseResult.total}'s reason: a message two rules both claim is one message.
 * An empty group list is zero without a query.
 */
export async function heldReleaseTotal(
  db: Tx, accountId: string, groups: readonly HeldReleaseGroup[],
): Promise<number> {
  if (groups.length === 0) return 0;
  const d = dialect(db);
  // The ids are this account's OWN group keys, read out of `heldReleaseGroups` a few statements
  // ago and bounded by `HELD_RELEASE_GROUPS_MAX` — never a caller's list.
  const ids = groups.map((g) => g.ruleId);
  const [row] = await db
    .select({ n: sql<number>`${d.castInt(sql`count(distinct ${messages.id})`)}` })
    .from(rulesTbl)
    .innerJoin(messages, and(eq(messages.accountId, rulesTbl.accountId), ruleClaimsSender(d)))
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(decidedRule(accountId), heldAtGate(accountId), inArray(rulesTbl.id, ids)));
  return Number(row?.n ?? 0);
}

/** The whole screen in one read: the groups, their distinct total, and the dismissal state. */
export async function heldReleaseSummary(
  db: Tx, accountId: string,
): Promise<HeldReleaseSummary> {
  const groups = await heldReleaseGroups(db, accountId);
  const fingerprint = heldReleaseFingerprint(groups);
  const [row] = await db
    .select({ dismissed: accountSettings.heldReleaseDismissed })
    .from(accountSettings)
    .where(eq(accountSettings.accountId, accountId));
  return {
    groups,
    total: await heldReleaseTotal(db, accountId, groups),
    fingerprint,
    // "" (no groups) never reads dismissed: there is no offer to have said "not now" to.
    dismissed: fingerprint !== "" && (row?.dismissed ?? null) === fingerprint,
  };
}

/**
 * "NOT NOW" — record which exact offer the account dismissed. The fingerprint is the CLIENT'S,
 * from the read it showed: storing what was on screen (never a re-derivation) means a set that
 * changed between the read and the press stays offered, because the stored value then matches
 * nothing. One row per account (`account_settings` upsert), bounded before the write — the
 * migration's CHECK is the belt. Clearing is not offered: a dismissal is superseded by the set
 * changing, which is the only honest way back.
 */
export async function dismissHeldRelease(
  ctx: ServiceContext, opts: { fingerprint?: unknown },
): Promise<{ dismissed: true }> {
  const fp = opts.fingerprint;
  if (typeof fp !== "string" || fp.length === 0 || fp.length > 128) {
    throw new ServiceError("validation_failed", 400, "fingerprint must be a short string");
  }
  await withAccountTx(ctx, async (t) => {
    await t.insert(accountSettings)
      .values({ accountId: ctx.accountId, heldReleaseDismissed: fp })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { heldReleaseDismissed: fp },
      });
  });
  return { dismissed: true };
}

/**
 * THE PRESS. Records your consent on each named group and re-opens its rule's backlog.
 *
 * It writes no `folder_state` and opens no mailbox: `rule-retro` is the one bulk filer, it decides
 * with `evaluateRules`, and the reconciler is the only thing that moves mail. What this does is
 * exactly two facts per group — `release_held_at`, the narrow licence that lets the pass reconsider
 * a row recorded as a hand file WHILE IT IS STILL AT THE GATE, and the ordinary retro re-arm that
 * puts the rule back in the owed set — plus one audit row naming what was released.
 *
 * IDEMPOTENT BY THE PREDICATE, not by a marker: a re-armed rule is in flight, so it is not a group
 * any more and a second press finds nothing to release. `ruleIds` absent releases every group.
 */
export async function releaseHeld(
  ctx: ServiceContext, opts: { ruleIds?: readonly string[] } = {},
): Promise<HeldReleaseResult> {
  const wanted = opts.ruleIds;
  if (wanted !== undefined) {
    if (!Array.isArray(wanted)) {
      throw new ServiceError("validation_failed", 400, "ruleIds must be an array");
    }
    if (wanted.length > HELD_RELEASE_GROUPS_MAX) {
      throw new ServiceError("validation_failed", 400, "too many groups in one press");
    }
    if (wanted.some((id) => typeof id !== "string" || id === "")) {
      throw new ServiceError("validation_failed", 400, "ruleIds must be rule ids");
    }
  }

  /* THROUGH THE FENCE, like every other account-owned write in this package. The press writes a
     rule and an audit row, and a transaction opened straight on the handle can commit them AFTER
     an erasure sweep has finished — a row belonging to an account that no longer exists. */
  return withAccountTx(ctx, async (t) => {
    // Read the groups INSIDE the transaction that acts on them: the count written to the audit row
    // is then the count the press released, not one measured before somebody else's decision landed.
    const groups = await heldReleaseGroups(bridgeTx(t), ctx.accountId);
    const named = wanted === undefined
      ? groups
      : groups.filter((g) => wanted.includes(g.ruleId));
    if (named.length === 0) return { released: [], total: 0 };
    /* READ BEFORE THE WRITE, and that order is load-bearing: the re-arm below puts each rule in
       flight, which is exactly what {@link decidedRule} excludes, so the same count asked
       afterwards would be zero. */
    const total = await heldReleaseTotal(bridgeTx(t), ctx.accountId, named);

    const now = ctx.now();
    for (const g of named) {
      await t.update(rulesTbl)
        .set({
          releaseHeldAt: now,
          retroRequestedAt: now, retroDoneAt: null, retroCursor: null, retroMoved: 0,
          updatedAt: now,
        })
        // Account-scoped, so a rule id belonging to somebody else names no row. The ownership
        // question is the same question as "is this one of my groups" and is asked once.
        .where(and(eq(rulesTbl.id, g.ruleId), eq(rulesTbl.accountId, ctx.accountId)));
      /* THE DELTA, in the same block as the write. The press moves `release_held_at` and re-arms
         the retro cursor, both of which a client renders, so a mirror that never heard of it
         would show the rule as it stood before the press until something else touched it. */
      await recordRuleDelta(t as unknown as LedgerTx, ctx.accountId, [g.ruleId], "update");

      await t.insert(auditLog).values({
        accountId: ctx.accountId,
        action: auditAction("screener.held_release"),
        payload: {
          ruleId: g.ruleId, kind: g.kind, match: g.match,
          destination: g.destination, count: g.count,
        },
        // No inverse. The press undoes nothing on its own — it asks the rules to decide, and every
        // move they then make is recorded, and reversible, where that move is made.
        inverse: null,
      });
    }

    return { released: named, total };
  });
}
