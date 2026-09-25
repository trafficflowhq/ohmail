import { and, asc, eq, gt, sql } from "drizzle-orm";
import {
  approvals, auditAction, auditLog, autoReplyByUsWhere, drafts, folderState, mailboxes,
  messageBodies, messageStates, messages, recordChange,
  type LedgerTx, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import {
  DEFAULT_OHBOX_POLICY, evaluateRules,
  type Destination, type NormalizedMessage, type Rule,
} from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ServiceError } from "./errors.js";
import { bridgeTx, withAccountTx, type ServiceContext } from "./context.js";

/* OHBOX MAIL FROM SENDERS NOBODY EVER DECIDED ABOUT — counted here, moved by a press.
   Mail that arrived before the screening gate existed was filed into the Ohbox by a blanket
   default; the gate now sends a stranger to the Screener, but only on ARRIVAL, so the backlog
   stays. This module names that set ONCE — {@link unscreenedSenderGroups} shows it,
   {@link screenUnscreened} acts on it — so the number a person is shown and the number a press
   moves cannot drift apart. The membership question is the ARRIVAL GATE's own
   (`rules.ts#evaluateRules`, imported); nothing here re-spells it. The press writes the same
   intent a fresh arrival writes and the organizer's reconciler carries it to IMAP. */

/** The Ohbox: where the blanket default put this mail. */
const OHBOX: Destination = "INBOX";
/** The gate: where consent says an undecided sender belongs. */
const SCREENER: Destination = "ohmail/Screener";

/**
 * The audit action one press writes, once per screened sender group, carrying the count as
 * measured inside the press's own transaction.
 */
export const OHBOX_UNSCREENED_AUDIT_ACTION = auditAction("screener.unscreened_sweep");

/** How many sender groups one read shows and one press may act on. */
export const OHBOX_UNSCREENED_GROUPS_MAX = 200;

/** Rows one page of the walk reads — the sibling passes' page, for their `recordChange` reason. */
const OHBOX_UNSCREENED_BATCH = 200;

/**
 * Pages the walk may read before it answers with what it has.
 *
 * A bound and not a drain: this runs behind a route, and the Ohbox it looks at is the one that
 * grew for years. The walk STEPS PAST mail the gate would not screen rather than stopping at it —
 * the first page of a legacy Ohbox is usually a correspondent's — so the bound is on rows READ,
 * not on rows found, and the tail is reached by pressing what is shown and asking again.
 */
const OHBOX_UNSCREENED_MAX_PAGES = 25;

/** Messages one read offers and one press moves. The walk stops early once it has this many. */
const OHBOX_UNSCREENED_MESSAGES_MAX = 1000;

/** One sender group: who wrote, how much of their mail is in the Ohbox undecided, and how recent. */
export interface UnscreenedSenderGroup {
  /** The sender's address, lower-cased as the gate reads it — this group's key, and what a press names. */
  address: string;
  /** Messages in this group. Every message has one sender, so the totals here do add up. */
  count: number;
  /** The newest of those messages, ISO — so a press is never a surprise about how old the mail is. */
  newestAt: string;
}

/** The screen: the groups and how many messages they hold. */
export interface UnscreenedSummary {
  groups: UnscreenedSenderGroup[];
  total: number;
}

/** What a press did. A second press over the same set is empty — the moved rows leave the set. */
export interface UnscreenedResult {
  screened: UnscreenedSenderGroup[];
  total: number;
}

/** One candidate, carrying everything the gate reads off a stored row — all of it from disk. */
interface UnscreenedRow {
  messageId: string;
  fromAddress: string;
  subject: string;
  bodyText: string;
  headers: Record<string, string[]>;
  observedFolder: string;
  /** The arrival instant, `date` where the header carried one and the ingest stamp otherwise. */
  at: Date;
}

/**
 * THE PERSISTED ROW AS THE GATE READS IT. Shaped like the sibling passes' `asRuleInput`
 * (`rule-retro.ts`, `ohbox-tidy.ts`, `sensitive-rescreen.ts`), so no two can disagree about what a
 * stored message looks like to the router. The two wide columns are read only where a rule reads
 * them ({@link unscreenedWalk}); where none does, `{}` and `""` are what the gate would have seen
 * anyway, and a rule that cannot fire leaves its sender undecided — offered, never taken.
 */
function asRuleInput(row: UnscreenedRow): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "" },
    subject: row.subject,
    from: { name: null, address: row.fromAddress.toLowerCase() },
    to: [],
    cc: [],
    date: null,
    headers: row.headers,
    textBody: row.bodyText,
    htmlBody: null,
    hasAttachments: false,
    attachments: [],
  };
}

/**
 * THE PREDICATE, IN ONE PLACE, AND IT IS THE ARRIVAL GATE'S OWN: a message joins the set when
 * {@link evaluateRules} answers `screener` — no rule claims it, no standing rule decides its
 * sender, the sender is no contact. `auth` is `"unavailable"` because a verdict is a fact about
 * ONE delivery while this screen asks about a SENDER; that arm can only push toward the Screener,
 * so the set is a SUBSET of what the gate screens today and the press can never move mail the gate
 * would admit (the delivery axis is `sensitive-rescreen.ts`'s). `ohboxPolicy` is the lenient
 * default: the `people_only` refinement sits inside the winning-allow branch, so no posture can
 * make an answer `screener` or unmake one.
 */
function gateWouldScreen(
  row: UnscreenedRow, rules: readonly Rule[], known: ReadonlySet<string>, own: ReadonlySet<string>,
): boolean {
  return evaluateRules({
    msg: asRuleInput(row),
    rules: rules as Rule[],
    knownSenders: known,
    ownAddresses: own,
    auth: "unavailable",
    ohboxPolicy: DEFAULT_OHBOX_POLICY,
  }).source === "screener";
}

/**
 * THE WALK — one page at a time until the message ceiling or the page bound, and the ONE place the
 * set is produced. Both the read and the press call it, which is what keeps the number shown and
 * the number moved the same number.
 *
 * `lock` is `false` for the read (a summary takes no rows hostage) and true inside the press, where
 * `FOR UPDATE OF folder_state` is what makes two presses move a message once.
 */
async function unscreenedWalk(
  t: Tx, accountId: string, opts: { lock: boolean },
): Promise<UnscreenedRow[]> {
  const repo = makeDrizzleRepo(t as unknown as Parameters<typeof makeDrizzleRepo>[0]);
  /* THE KNOWLEDGE THE GATE DECIDES ON, READ ONCE PER CALL. A read is one answer about one moment;
     a press reads it inside its own transaction, so what it acts on is as fresh as its writes. */
  const rules: Rule[] = await repo.listRules(accountId);
  const known: ReadonlySet<string> = await repo.knownSenders(accountId);
  // The account's own addresses — what "not from myself" excludes, and the reply predicate's list.
  const ownRows = await t.select({ address: mailboxes.address }).from(mailboxes)
    .where(eq(mailboxes.accountId, accountId));
  const ownAddresses = ownRows.map((r) => r.address.toLowerCase());
  const ownSet: ReadonlySet<string> = new Set(ownAddresses);
  /* THE TWO WIDE COLUMNS ARE READ ONLY WHERE A RULE READS THEM, and which rule reads which is the
     whole of the condition. `headers` is read by ONE arm of the gate that can precede a `screener`
     answer — a `header` rule, which names a header and nobody's address; `message_bodies.text` by
     the `body_contains` term (mail 0052), whose haystack is the stored text. `headerHeuristic` and
     the auth demotion also read headers and are reachable only for a sender already admitted, so
     they cannot turn a `screener` answer into another one. Both arms of both conditions are
     reachable and both are driven. */
  const enabled = rules.filter((r) => r.enabled);
  const needsHeaders = enabled.some((r) => r.kind === "header");
  const needsBody = enabled.some((r) => (r.bodyContains ?? "") !== "");

  const out: UnscreenedRow[] = [];
  let afterId: string | null = null;
  for (let page = 0; page < OHBOX_UNSCREENED_MAX_PAGES; page++) {
    if (out.length >= OHBOX_UNSCREENED_MESSAGES_MAX) break;
    const rows = await selectCandidates(t, {
      accountId, ownAddresses, needsHeaders, needsBody,
      limit: OHBOX_UNSCREENED_BATCH, afterId, lock: opts.lock,
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      if (out.length >= OHBOX_UNSCREENED_MESSAGES_MAX) break;
      if (gateWouldScreen(row, rules, known, ownSet)) out.push(row);
    }
    afterId = rows[rows.length - 1]!.messageId;
    if (rows.length < OHBOX_UNSCREENED_BATCH) break;
  }
  return out;
}

/**
 * ONE page of the Ohbox this screen may offer — oldest id first, so the walk is monotone in
 * `messages.id`. CANDIDATES: `desired_folder = 'INBOX'` (also the idempotency) in a live mailbox
 * this install ORGANIZES, so a reader's walk is empty by construction. EXCLUSIONS, the four
 * `ohbox-tidy.ts` applies: no non-`none` triage row, no reply draft, no DECIDED approval, no reply
 * of the person's own in the thread. READ is NOT one — reading is not deciding, which is the whole
 * of the row this closes. `last_set_by` is NOT constrained either: a blanket default, an older
 * install and the person's own client years ago are all this backlog, and what protects them is
 * the PRESS rather than a placement stamp.
 */
async function selectCandidates(
  t: Tx,
  opts: {
    accountId: string; ownAddresses: readonly string[];
    needsHeaders: boolean; needsBody: boolean;
    limit: number; afterId: string | null; lock: boolean;
  },
): Promise<UnscreenedRow[]> {
  const d = dialect(t);
  const filters = [
    eq(messages.accountId, opts.accountId),
    eq(folderState.desiredFolder, OHBOX),
    sql`exists (
      select 1 from ${mailboxes} mb
       where mb.id = ${messages.mailboxId}
         and mb.status <> 'disabled'
         and mb.organizer_role = 'organizer'
    )`,
    // 1 — the user has triaged this message.
    sql`not exists (
      select 1 from ${messageStates} ms
       where ms.message_id = ${messages.id} and ms.state <> 'none'
    )`,
    // 2 — the user is replying, or has replied, through ohmail.
    sql`not exists (
      select 1 from ${drafts} dr where dr.in_reply_to_message_id = ${messages.id}
    )`,
    // 3 — the user decided on an AI proposal about this message.
    sql`not exists (
      select 1 from ${approvals} a
       where a.message_id = ${messages.id} and a.status <> 'pending'
    )`,
  ];
  /* 4 — the user replied from their own mail client, and a MACHINE'S reply is not that: the away
     responder answering on their behalf is not them dealing with the message (`ohbox-tidy.ts`
     carries the same narrowing and the same reason). Guarded on a non-empty list — `in ()` is a
     syntax error — and on a non-NULL thread. `not from myself` rides the same clause: a message
     the account sent is excluded by its own address being in this list on the message row below. */
  if (opts.ownAddresses.length > 0) {
    const own = sql`(${sql.join(opts.ownAddresses.map((a) => sql`${a}`), sql`, `)})`;
    filters.push(sql`lower(${messages.fromAddress}) not in ${own}`);
    filters.push(sql`not exists (
      select 1 from ${messages} sent
       where sent.account_id = ${messages.accountId}
         and sent.thread_id = ${messages.threadId}
         and ${messages.threadId} is not null
         and lower(sent.from_address) in ${own}
         and not ${autoReplyByUsWhere(d, {
           accountId: sql`sent.account_id`,
           id: sql`sent.id`,
           fromAddress: sql`sent.from_address`,
           messageIdHeader: sql`sent.message_id_header`,
         })}
    )`);
  }
  if (opts.afterId) filters.push(gt(messages.id, d.castUuid(sql`${opts.afterId}`)));

  const q = t.select({
    messageId: messages.id,
    fromAddress: messages.fromAddress,
    subject: messages.subject,
    observedFolder: folderState.observedFolder,
    /* THE TWO WIDE COLUMNS, OR WHAT THE GATE WOULD HAVE SEEN WITHOUT THEM — and each placeholder
       is its own EXPRESSION, never the same cast twice. This module is loaded by the PHONE
       bundle: `::jsonb` is a construct only the server accepts (`dialect-census.test.ts` refuses
       it by name), and on the device store two columns spelled identically collapse into one,
       because rows come back positionally — measured, both ways, in
       `ohbox-unscreened-dialect.test.ts`. */
    headers: opts.needsHeaders ? messageBodies.headers : sql<null>`null`,
    bodyText: opts.needsBody ? messageBodies.text : sql<string>`''`,
    at: sql<string>`coalesce(${messages.date}, ${messages.createdAt})`,
  }).from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(...filters))
    .orderBy(asc(messages.id))
    .limit(opts.limit)
    .$dynamic();
  /* THE LOCK, THROUGH THE DIALECT. On the server this is `FOR UPDATE OF folder_state`, which is
     what makes two presses move a message once; on the phone's single serialized connection there
     is nothing for a row lock to add and {@link Dialect.forUpdate} is the identity. A press asks
     for it and a read does not: a summary takes no rows hostage. */
  const rows = await (opts.lock ? d.forUpdate(q, { of: folderState }) : q);

  return rows.map((r) => ({
    messageId: r.messageId,
    fromAddress: r.fromAddress,
    subject: r.subject,
    bodyText: (r.bodyText as string | null) ?? "",
    headers: (r.headers as Record<string, string[]> | null) ?? {},
    observedFolder: r.observedFolder,
    at: new Date(r.at),
  }));
}

/**
 * The rows of the walk as sender groups, largest first, bounded by
 * {@link OHBOX_UNSCREENED_GROUPS_MAX}. A tie breaks on the address so two reads of one set answer
 * in one order.
 */
function groupsOf(rows: readonly UnscreenedRow[]): UnscreenedSenderGroup[] {
  const by = new Map<string, { count: number; newest: number }>();
  for (const row of rows) {
    const key = row.fromAddress.toLowerCase();
    const at = row.at.getTime();
    const hit = by.get(key);
    if (hit) { hit.count++; if (at > hit.newest) hit.newest = at; }
    else by.set(key, { count: 1, newest: at });
  }
  return [...by.entries()]
    .map(([address, g]) => ({ address, count: g.count, newestAt: new Date(g.newest).toISOString() }))
    .sort((a, b) => b.count - a.count || a.address.localeCompare(b.address))
    .slice(0, OHBOX_UNSCREENED_GROUPS_MAX);
}

/**
 * The whole screen in one read: the groups and the messages they hold.
 *
 * `total` is the SHOWN groups' messages and nothing else — every message has one sender, so a
 * group list that was cut at the bound must not report the mail behind the cut as offered.
 */
export async function unscreenedSummary(
  db: Tx, accountId: string,
): Promise<UnscreenedSummary> {
  const groups = groupsOf(await unscreenedWalk(db, accountId, { lock: false }));
  return { groups, total: groups.reduce((n, g) => n + g.count, 0) };
}

/**
 * THE PRESS. Moves the named sender groups — or every group shown, when `addresses` is absent — to
 * the Screener, through the door a fresh arrival takes: the INTENT and the delta, `observed`
 * untouched so `reconcile_status` DERIVES `pending` and the organizer's reconciler performs the
 * move. It opens no mailbox — one organizer per mailbox is the lease's invariant. One audit row
 * per group carries the inverse, because this moves mail nobody named message by message.
 * IDEMPOTENT BY THE PREDICATE: a moved row is no longer a candidate.
 */
export async function screenUnscreened(
  ctx: ServiceContext, opts: { addresses?: readonly string[] } = {},
): Promise<UnscreenedResult> {
  const wanted = opts.addresses;
  if (wanted !== undefined) {
    if (!Array.isArray(wanted)) {
      throw new ServiceError("validation_failed", 400, "addresses must be an array");
    }
    if (wanted.length > OHBOX_UNSCREENED_GROUPS_MAX) {
      throw new ServiceError("validation_failed", 400, "too many sender groups in one press");
    }
    if (wanted.some((a) => typeof a !== "string" || a === "" || a.length > 320)) {
      throw new ServiceError("validation_failed", 400, "addresses must be sender addresses");
    }
  }
  const named = wanted === undefined ? null : new Set(wanted.map((a) => a.toLowerCase()));

  /* THROUGH THE FENCE, like every other account-owned write in this package: a request valid when
     it started must not commit `folder_state` rows after an erasure sweep has emptied the account. */
  return withAccountTx(ctx, async (t) => {
    const tx = bridgeTx(t);
    /* THE SET, READ INSIDE THE TRANSACTION THAT ACTS ON IT — the same walk the screen was drawn
       from, so the count in the audit row is the count this press moved rather than one measured
       before somebody else's decision landed. */
    const rows = (await unscreenedWalk(tx, ctx.accountId, { lock: true }))
      .filter((r) => named === null || named.has(r.fromAddress.toLowerCase()));
    if (rows.length === 0) return { screened: [], total: 0 };
    // The groups are derived from the rows that will move, so what the result reports and what the
    // press wrote are one measurement — never the screen's own list handed back.
    const screened = groupsOf(rows);
    const moving = new Set(screened.map((g) => g.address));

    const now = ctx.now();
    for (const row of rows) {
      if (!moving.has(row.fromAddress.toLowerCase())) continue;
      await upsertScreenerIntent(tx, row, now);
      await recordChange(t as unknown as LedgerTx, {
        accountId: ctx.accountId, entityType: "message", entityId: row.messageId, op: "move",
        meta: { from: OHBOX, to: SCREENER },
      });
    }
    for (const g of screened) {
      await t.insert(auditLog).values({
        accountId: ctx.accountId,
        action: auditAction("screener.unscreened_sweep"),
        payload: { address: g.address, count: g.count, from: OHBOX, to: SCREENER },
        // The undo this press owes: it moved mail the person named by SENDER, not by message.
        inverse: { address: g.address, from: SCREENER, to: OHBOX },
      });
    }
    return { screened, total: rows.filter((r) => moving.has(r.fromAddress.toLowerCase())).length };
  });
}

/**
 * Write the INTENT and nothing else — desired `ohmail/Screener`, observed untouched.
 * `reconcile_status` is DERIVED (desired ≠ observed ⇒ `pending`), so a row can never claim a
 * convergence it does not have, and `pending` is what makes the reconciler perform the move.
 */
async function upsertScreenerIntent(t: Tx, row: UnscreenedRow, now: Date): Promise<void> {
  const reconcileStatus = SCREENER === row.observedFolder ? "reconciled" : "pending";
  await t.insert(folderState).values({
    messageId: row.messageId, desiredFolder: SCREENER, observedFolder: row.observedFolder,
    lastSetBy: "us", reconcileStatus, conflict: false,
  }).onConflictDoUpdate({
    target: folderState.messageId,
    set: {
      desiredFolder: SCREENER, observedFolder: row.observedFolder, lastSetBy: "us",
      reconcileStatus, conflict: false, updatedAt: now,
    },
  });
}
