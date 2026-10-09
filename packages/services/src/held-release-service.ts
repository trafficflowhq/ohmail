import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  AccountErasedError, accountSettings, applyScreenerDecision, auditAction, auditLog, changeLog,
  contactOnlyHeldWhere, destinationIsDecisionSql, folderState, lockAccountRuleKeys, mailboxes, messages, recordRuleDelta,
  ruleNamesSenderSql, rules as rulesTbl, senderHasPersonConsentSql, seqBounds, type LedgerTx, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { checkUncheckedById } from "@trafficflow/core/adapters/drizzle-repo";
import { SCREENER_FOLDER } from "./screener-service.js";
import { recordSettingsChange } from "./consent-seed.js";
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

/**
 * A SENDER WHO IS ONLY A CONTACT, with mail held at the gate — no rule to key a group on, so the
 * group is the address (`contactOnlyHeldWhere`). Beside the rule groups, never among them: an older
 * client reads `groups` and `total` alone and never learns these exist.
 */
export interface HeldReleaseSenderGroup {
  /** The address, lower-cased — what the press names back. */
  sender: string;
  count: number;
}

/** What a press did. `released` is the groups it acted on; a second press over the same set is empty. */
export interface HeldReleaseResult {
  released: HeldReleaseGroup[];
  /** The contact-only senders it released, decided into the Ohbox through the Screener's own door. */
  releasedSenders: HeldReleaseSenderGroup[];
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
  /** Distinct messages across the RULE groups — unchanged for an older client. */
  total: number;
  /** The contact-only senders beside them; their mail is claimed by no rule, so it adds to `total`. */
  senders: HeldReleaseSenderGroup[];
  /** The identity of THIS set — what a dismissal names. Empty groups fingerprint to "". */
  fingerprint: string;
  /**
   * True when the account dismissed this set and no held mail joined it since: a set that only
   * shrank stays dismissed, new held mail re-offers ({@link heldReleaseNewest}).
   */
  dismissed: boolean;
}

/**
 * THE OFFER'S IDENTITY — a hash of the sorted (rule, destination, count) triples, so "the same
 * offer" is a fact about the SET and never about when it was read. Pure FNV-1a over the joined
 * triples rather than node:crypto, because this module is loaded by the phone bundle, which has
 * no node builtins. Not a security boundary: the value only ever meets an equality check against
 * what the same function produced.
 */
export function heldReleaseFingerprint(
  groups: readonly HeldReleaseGroup[], senders: readonly HeldReleaseSenderGroup[] = [],
): string {
  if (groups.length === 0 && senders.length === 0) return "";
  const text = [
    ...groups.map((g) => `${g.ruleId}:${g.destination}:${g.count}`),
    ...senders.map((g) => `sender:${g.sender}:${g.count}`),
  ].sort().join("\n");
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
function heldAtGate(d: ReturnType<typeof dialect>, accountId: string) {
  return and(
    eq(messages.accountId, accountId),
    isNull(messages.deletedAt),
    sql`${folderState.lastSetBy} in ('external', 'peer', 'us')`,
    eq(folderState.desiredFolder, SCREENER_FOLDER),
    eq(folderState.observedFolder, SCREENER_FOLDER),
    // A claim the identity fact holds is the Screener's question, with its sentence, never a release —
    // unless a person consented to the address, whose mail the gate never holds for its name.
    sql`(${messages.senderCheck} is null or ${messages.senderCheck} <> 'impersonation'
      or ${senderHasPersonConsentSql(d, accountId, sql`lower(${messages.fromAddress})`)})`,
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

/** Of `senders` (lower-cased, the offer's own, bounded), those a person consented to at the address. */
async function personConsentedAmong(db: Tx, accountId: string, senders: readonly string[]): Promise<Set<string>> {
  const d = dialect(db);
  const out = new Set<string>();
  for (const s of senders) {
    const rows = await d.exec(db, sql`select case when ${senderHasPersonConsentSql(d, accountId, sql`${s}`)} then 1 else 0 end`);
    if (Number(rows[0]?.[0] ?? 0) === 1) out.add(s);
  }
  return out;
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
 * `rule-retro.ts#matchPredicate` and `screener-service#heldRowsForDomain` as a join, and their
 * twin: the set this COUNTS and the set the pass MOVES are offered as one number. The domain arm
 * goes through {@link Dialect.domainOf} because the phone bundle loads this module, and a pg-only
 * `substring … position` would crash the release screen (`dialect-census.test.ts` refuses it).
 * `ruleNamesSenderSql` is the SQL spelling of the pass's `ruleMatchKey(rule.match)`, spaces only,
 * on both stores.
 */
const ruleClaimsSender = (d: ReturnType<typeof dialect>) =>
  ruleNamesSenderSql(d, { kind: rulesTbl.kind, match: rulesTbl.match, destination: rulesTbl.destination }, sql`lower(${messages.fromAddress})`);

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
    .where(and(decidedRule(accountId), heldAtGate(d, accountId)))
    .groupBy(rulesTbl.id, rulesTbl.kind, rulesTbl.match, rulesTbl.destination)
    .orderBy(sql`count(${messages.id}) desc`, rulesTbl.id)
    .limit(HELD_RELEASE_GROUPS_MAX);

  return rows.map((r) => ({
    ruleId: r.ruleId, kind: r.kind as "sender" | "domain",
    match: r.match, destination: r.destination, count: Number(r.count),
  }));
}

/** The account's own addresses, lower-cased — the contact arm's own-reply exclusion reads them. */
async function ownAddressesOf(db: Tx, accountId: string): Promise<string[]> {
  const rows = await db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.accountId, accountId));
  return rows.map((r) => r.address.toLowerCase());
}

/** The contact-only senders with mail held at the gate, largest first — {@link HeldReleaseSenderGroup}. */
export async function heldReleaseSenders(db: Tx, accountId: string): Promise<HeldReleaseSenderGroup[]> {
  const d = dialect(db);
  const own = await ownAddressesOf(db, accountId);
  const sender = sql<string>`lower(${messages.fromAddress})`;
  const rows = await db
    .select({ sender, count: sql<number>`${d.castInt(sql`count(${messages.id})`)}` })
    .from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(and(heldAtGate(d, accountId), ...contactOnlyHeldWhere(d, { ownAddresses: own })))
    .groupBy(sender)
    .orderBy(sql`count(${messages.id}) desc`, sender)
    .limit(HELD_RELEASE_GROUPS_MAX);
  return rows.map((r) => ({ sender: String(r.sender), count: Number(r.count) }));
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
    .where(and(decidedRule(accountId), heldAtGate(d, accountId), inArray(rulesTbl.id, ids)));
  return Number(row?.n ?? 0);
}

/**
 * DID THE HELD SET GAIN A MEMBER AFTER THE DISMISSAL — one clock, the account's change log: a
 * change row past `anchor` placing one of the set's messages at the gate (`create`, `move`), or
 * writing one of its rules (`create`, or `update` — back from its walk). The log's sequence is
 * allocated under the account's row lock, so no writer's clock and no skew decides what is newer.
 * The walk reads the change rows since the anchor, which is what happened since the "Not now".
 */
async function heldReleaseJoinedSince(
  db: Tx, accountId: string, groups: readonly HeldReleaseGroup[], senders: readonly HeldReleaseSenderGroup[],
  anchor: bigint,
): Promise<boolean> {
  const d = dialect(db);
  const since = and(eq(changeLog.accountId, accountId), sql`${changeLog.seq} > ${anchor.toString()}`);
  const placedAtGate = and(since, eq(changeLog.entityType, "message"), inArray(changeLog.op, ["create", "move"]));
  if (senders.length > 0) {
    // A contact-only sender's held mail placed since: the address list is the read's own, bounded.
    const addresses = senders.map((g) => g.sender);
    const [joined] = await db.select({ one: sql`1` }).from(changeLog)
      .innerJoin(messages, and(eq(messages.id, changeLog.entityId), eq(messages.accountId, changeLog.accountId)))
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(placedAtGate, heldAtGate(d, accountId), inArray(sql`lower(${messages.fromAddress})`, addresses)))
      .limit(1);
    if (joined !== undefined) return true;
  }
  if (groups.length === 0) return false;
  // This account's own group keys, bounded by `HELD_RELEASE_GROUPS_MAX`, as in `heldReleaseTotal`.
  const ids = groups.map((g) => g.ruleId);
  const [placed] = await db.select({ one: sql`1` }).from(changeLog)
    .innerJoin(messages, and(eq(messages.id, changeLog.entityId), eq(messages.accountId, changeLog.accountId)))
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .innerJoin(rulesTbl, and(eq(rulesTbl.accountId, messages.accountId), ruleClaimsSender(d)))
    .where(and(placedAtGate, decidedRule(accountId), heldAtGate(d, accountId), inArray(rulesTbl.id, ids)))
    .limit(1);
  if (placed !== undefined) return true;
  // scoped-by: `since` pins eq(changeLog.accountId, accountId)
  const [decided] = await db.select({ one: sql`1` }).from(changeLog)
    .where(and(since, eq(changeLog.entityType, "rule"), inArray(changeLog.op, ["create", "update"]), inArray(changeLog.entityId, ids)))
    .limit(1);
  return decided !== undefined;
}

/**
 * THE LEGACY CLOCK ANCHOR, READ ONLY: a `<fp>@<ms>` dismissal a build before the sequence anchor
 * wrote, compared as it was until the next "Not now" overwrites it — the latest instant one of the
 * set's (message, rule) pairs joined. Nothing writes this form any more; gap row
 * HELD-RELEASE-LEGACY-CLOCK-ANCHOR-READ-ARM removes the arm next release.
 */
async function heldReleaseNewest(
  db: Tx, accountId: string, groups: readonly HeldReleaseGroup[],
): Promise<number> {
  if (groups.length === 0) return 0;
  const d = dialect(db);
  // This account's own group keys, bounded by `HELD_RELEASE_GROUPS_MAX`, as in `heldReleaseTotal`.
  const ids = groups.map((g) => g.ruleId);
  const [placed] = await db
    .select({ at: folderState.updatedAt })
    .from(rulesTbl)
    .innerJoin(messages, and(eq(messages.accountId, rulesTbl.accountId), ruleClaimsSender(d)))
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(decidedRule(accountId), heldAtGate(d, accountId), inArray(rulesTbl.id, ids)))
    .orderBy(desc(folderState.updatedAt))
    .limit(1);
  const decided = await db
    .select({ created: rulesTbl.createdAt, walked: rulesTbl.retroDoneAt })
    .from(rulesTbl)
    .where(and(eq(rulesTbl.accountId, accountId), inArray(rulesTbl.id, ids)));
  let newest = placed?.at?.getTime() ?? 0;
  for (const r of decided) newest = Math.max(newest, r.created.getTime(), r.walked?.getTime() ?? 0);
  return newest;
}

/**
 * A dismissal as stored: `<fingerprint>#<the account's change-log head when it was pressed>`; the
 * legacy `<fingerprint>@<epoch ms>` (read only, {@link heldReleaseNewest}); or a bare fingerprint —
 * what a press over a set that moved since its read records, read by equality.
 */
const SEQ_ANCHOR = "#";
const LEGACY_CLOCK_ANCHOR = "@";
function readDismissal(stored: string | null): { fingerprint: string; seq: bigint | null; ms: number | null } | null {
  if (stored === null || stored === "") return null;
  const at = (sep: string): { head: string; tail: string } | null => {
    const i = stored.lastIndexOf(sep);
    const tail = i > 0 ? stored.slice(i + 1) : "";
    return /^\d{1,19}$/.test(tail) ? { head: stored.slice(0, i), tail } : null;
  };
  const seq = at(SEQ_ANCHOR);
  if (seq !== null) return { fingerprint: seq.head, seq: BigInt(seq.tail), ms: null };
  const clock = at(LEGACY_CLOCK_ANCHOR);
  if (clock !== null && clock.tail.length <= 16) return { fingerprint: clock.head, seq: null, ms: Number(clock.tail) };
  return { fingerprint: stored, seq: null, ms: null };
}

/** The whole screen in one read: the groups, their distinct total, and the dismissal state. */
export async function heldReleaseSummary(
  db: Tx, accountId: string,
): Promise<HeldReleaseSummary> {
  const groups = await heldReleaseGroups(db, accountId);
  const senders = await heldReleaseSenders(db, accountId);
  const fingerprint = heldReleaseFingerprint(groups, senders);
  const [row] = await db
    .select({ dismissed: accountSettings.heldReleaseDismissed })
    .from(accountSettings)
    .where(eq(accountSettings.accountId, accountId));
  const stored = readDismissal(row?.dismissed ?? null);
  // "" (no groups) never reads dismissed: there is no offer to have said "not now" to.
  let dismissed = false;
  if (fingerprint !== "" && stored !== null) {
    if (stored.seq !== null) dismissed = !(await heldReleaseJoinedSince(db, accountId, groups, senders, stored.seq));
    else if (stored.ms !== null) dismissed = await heldReleaseNewest(db, accountId, groups) <= stored.ms;
    else dismissed = stored.fingerprint === fingerprint;
  }
  return { groups, total: await heldReleaseTotal(db, accountId, groups), senders, fingerprint, dismissed };
}

/**
 * "NOT NOW" — record the offer the account dismissed. The fingerprint is the CLIENT'S, from the
 * read it showed: when it still names the set, the dismissal is anchored at the account's
 * change-log head, read in this transaction, and only mail or a rule joining after it re-offers
 * ({@link heldReleaseJoinedSince}); when the set moved since the read, the bare fingerprint
 * matches nothing and the offer stays. One row per account, bounded before the write — the
 * migration's CHECK is the belt. Clearing is not offered: new held mail is the only honest way back.
 */
export async function dismissHeldRelease(
  ctx: ServiceContext, opts: { fingerprint?: unknown },
): Promise<{ dismissed: true }> {
  const fp = opts.fingerprint;
  // `#` and `@` are the stored forms' separators, and no fingerprint the server issues carries one;
  // 100 leaves the anchor's room inside the column's 128.
  if (typeof fp !== "string" || fp.length === 0 || fp.length > 100
      || fp.includes(SEQ_ANCHOR) || fp.includes(LEGACY_CLOCK_ANCHOR)) {
    throw new ServiceError("validation_failed", 400, "fingerprint must be a short string");
  }
  /* THE DOORBELL, in the same transaction and after the row (`recordSettingsChange`'s lock
     order). The dismissal is the ACCOUNT's: without a moved stamp and a change row, every other
     device kept the offer it had read until its shell remounted. Each engine re-asks its one
     held-release door when the settings stamp moves (`OhmailEngine.ringHeldReleaseBell`). */
  await withAccountTx(ctx, async (t) => {
    const now = ctx.now();
    const groups = await heldReleaseGroups(bridgeTx(t), ctx.accountId);
    const senders = await heldReleaseSenders(bridgeTx(t), ctx.accountId);
    let value = fp;
    if ((groups.length > 0 || senders.length > 0) && heldReleaseFingerprint(groups, senders) === fp) {
      const head = (await seqBounds(bridgeTx(t), ctx.accountId)).max ?? 0n;
      value = `${fp}${SEQ_ANCHOR}${head.toString()}`;
    }
    await t.insert(accountSettings)
      .values({ accountId: ctx.accountId, heldReleaseDismissed: value, updatedAt: now })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { heldReleaseDismissed: value, updatedAt: now },
      });
    await recordSettingsChange(t, ctx.accountId);
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
  ctx: ServiceContext, opts: { ruleIds?: readonly string[]; senders?: readonly string[] } = {},
): Promise<HeldReleaseResult> {
  const wanted = opts.ruleIds;
  const wantedSenders = opts.senders;
  if (wantedSenders !== undefined) {
    if (!Array.isArray(wantedSenders)) throw new ServiceError("validation_failed", 400, "senders must be an array");
    if (wantedSenders.length > HELD_RELEASE_GROUPS_MAX) {
      throw new ServiceError("validation_failed", 400, "too many senders in one press");
    }
    if (wantedSenders.some((a) => typeof a !== "string" || a === "" || a.length > 320)) {
      throw new ServiceError("validation_failed", 400, "senders must be addresses");
    }
  }
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
    // The rule-key lock first after the fence: this press writes rules by id and then decides
    // senders, whose held bags lock mailboxes it cannot name up front (every writer's order).
    await lockAccountRuleKeys(bridgeTx(t), ctx.accountId);
    // Read the groups INSIDE the transaction that acts on them: the count written to the audit row
    // is then the count the press released, not one measured before somebody else's decision landed.
    const groups = await heldReleaseGroups(bridgeTx(t), ctx.accountId);
    // An absent `ruleIds` is every rule group, as before; an absent `senders` is NONE — an older
    // client never saw a sender line, so its "release all" releases what it showed and no more.
    const named = wanted === undefined
      ? groups
      : groups.filter((g) => wanted.includes(g.ruleId));
    const asked = new Set((wantedSenders ?? []).map((a) => a.trim().toLowerCase()));
    const namedSenders = asked.size === 0 ? []
      : (await heldReleaseSenders(bridgeTx(t), ctx.accountId)).filter((g) => asked.has(g.sender));
    // The senders whose claims the offer counted (`heldAtGate`'s person skip): their press moves them.
    const consented = await personConsentedAmong(bridgeTx(t), ctx.accountId, namedSenders.map((g) => g.sender));
    if (named.length === 0 && namedSenders.length === 0) return { released: [], releasedSenders: [], total: 0 };
    /* READ BEFORE THE WRITE, and that order is load-bearing: the re-arm below puts each rule in
       flight, which is exactly what {@link decidedRule} excludes, so the same count asked
       afterwards would be zero. */
    // Contact-only mail is claimed by no rule, so its count adds to the rule groups' distinct total.
    const total = await heldReleaseTotal(bridgeTx(t), ctx.accountId, named)
      + namedSenders.reduce((n, g) => n + g.count, 0);

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

    /* A CONTACT-ONLY SENDER IS DECIDED THROUGH THE SCREENER'S OWN DOOR (`applyScreenerDecision`): a
       rule the person made by pressing, their held mail desired into the Ohbox and the retro
       re-armed for the rest — the same act as an Ohbox press over a waiting sender. It writes
       desired state only; the reconciler moves the mail. */
    for (const g of namedSenders) {
      try {
        // `t` is the fenced transaction, branded by the handle it came from: no hand carry.
        await applyScreenerDecision(bridgeTx(t), {
          accountId: ctx.accountId, scope: "sender", address: g.sender, appliedFolder: "INBOX", decision: "yes",
          triggeringActionId: `held-release:${g.sender}`, now, stampBaseline: false, applyRetro: true,
          // The offer counts a claim only from an address a person consented to (`heldAtGate`), whose
          // claims move with the rest; any other claim waits for its own press, and an unchecked row is
          // checked first, so a claim it carries is one of them.
          decidedBy: "person", overExisting: "converge", marked: consented.has(g.sender) ? "pressed" : "none",
          checkUnchecked: checkUncheckedById,
        });
      } catch (err) {
        if (err instanceof AccountErasedError) {
          throw new ServiceError("account_erased", 410, "this account has been deleted; its settings cannot be changed");
        }
        throw err;
      }
      await t.insert(auditLog).values({
        accountId: ctx.accountId,
        action: auditAction("screener.held_release"),
        payload: { sender: g.sender, count: g.count },
        inverse: null,
      });
    }

    return { released: named, releasedSenders: namedSenders, total };
  });
}
