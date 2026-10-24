import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import {
  accountSettings, approvals, auditAction, auditLog, drafts, folderState, mailboxes,
  messageBodies, messageStates, messageTags, messages, readOwnAddresses, recordChanges,
  weAnsweredThisSenderWhere, type LedgerTx, type Tx,
} from "@trafficflow/db";
import { carryDialect, dialect } from "@trafficflow/db/dialect";
import {
  DEFAULT_OHBOX_POLICY, evaluateRules, resolveScreeningCutoff, screenerAdmits,
  type KnownSenders, type Rule, type ScreeningScope,
} from "./rules.js";
import { correspondentAtGate } from "./pipeline.js";
import type { RepoPort } from "./ports.js";
import type { Destination, NormalizedMessage } from "./types.js";

/* OHBOX MAIL FROM SENDERS NOBODY EVER DECIDED ABOUT — the set named ONCE, for two doors. The
   Screener's offer ("Screen N") reads and presses it account-wide; the organize decision reads it
   for one mailbox inside the window before the press and the organizer moves exactly that set after
   it. Membership is the arrival gate's own `evaluateRules` answer; the window is `screenerAdmits`
   on the server's receive clock (`messages.arrived_at`), and for the agree a letter with no recorded
   arrival is outside it. Writes are intents only: the organizer's reconciler performs every move. */

const OHBOX: Destination = "INBOX";
const SCREENER: Destination = "ohmail/Screener";

/** How many sender groups one read shows and one press may act on. */
export const OHBOX_UNSCREENED_GROUPS_MAX = 200;
/** Messages one read offers and one press moves. */
export const OHBOX_UNSCREENED_MESSAGES_MAX = 1000;
/** Rows one page of the walk reads. */
const BATCH = 200;
/** Letters one intent upsert carries: a few binds each, well under either store's bind ceiling. */
const INTENT_SLICE = 200;
/** Pages one walk may read: a bound on rows READ, so a large Ohbox answers with what it has. */
const MAX_PAGES = 25;
/** How much wider than the window the SQL prefilter reads; the window itself is `screenerAdmits`. */
const PREFILTER_SLACK_MS = 86_400_000;

/** The audit row a press writes per screened sender group, with its inverse. */
export const OHBOX_UNSCREENED_AUDIT_ACTION = auditAction("screener.unscreened_sweep");
/**
 * The record of a person's FIRST agree press made on a screen that stated the rule, written in
 * the consent's own transaction at the stamp's instant. The organizer that spends that stamp
 * sweeps; no other promotion finds one.
 */
export const AGREE_SCREENS_BACKLOG_ACTION = auditAction("organizer.agree_screens_backlog");

export interface UnscreenedSenderGroup {
  /** The sender's address, lower-cased as the gate reads it. */
  address: string;
  count: number;
  /** The newest of those messages, ISO. */
  newestAt: string;
}

/**
 * Which set: the account-wide offer, or one mailbox inside a window (the organize decision).
 * `storedBy` is the agree press's instant: the sweep moves only what the store held then.
 */
export type UnscreenedScope =
  | { kind: "offer" }
  | { kind: "agree"; mailboxId: string; cutoff: Date | undefined; storedBy?: Date };

/** The gate's knowledge, read by the caller inside the transaction the walk runs in. */
export interface UnscreenedKnowledge extends Pick<RepoPort, "isCorrespondent"> {
  listRules(accountId: string): Promise<Rule[]>;
  knownSenders(accountId: string): Promise<KnownSenders>;
}

export interface UnscreenedRow {
  messageId: string;
  fromAddress: string;
  subject: string;
  bodyText: string;
  headers: Record<string, string[]>;
  observedFolder: string;
  /** The letter's own Message-ID, for the gate's reply arm (`threadKeyOf` leaves it out). */
  messageIdHeader: string | null;
  /** For the group's "newest": the header date where present, else the ingest stamp. */
  at: Date;
  /** The server's receive clock, the window's only input. */
  arrivedAt: Date | null;
}

export interface UnscreenedWalk {
  /** The members a press would move — at most {@link OHBOX_UNSCREENED_MESSAGES_MAX}. */
  rows: UnscreenedRow[];
  /** Members seen in all, past the move bound too (the agree scope counts on). */
  matched: number;
  /** False when the page bound stopped the walk, so `matched` is a floor. */
  complete: boolean;
}

function asRuleInput(row: UnscreenedRow, scope: UnscreenedScope): NormalizedMessage {
  return {
    canonical: { messageIdHeader: scope.kind === "agree" ? row.messageIdHeader : null, bodyHash: "" },
    subject: row.subject,
    from: { name: null, address: row.fromAddress.toLowerCase() },
    to: [], cc: [], date: null,
    headers: row.headers,
    textBody: row.bodyText,
    htmlBody: null,
    hasAttachments: false,
    attachments: [],
  };
}

/**
 * THE PREDICATE: the arrival gate would hold this sender's mail (`auth` unavailable and no
 * identity fact — a question about a SENDER, not one delivery). For the agree scope also
 * {@link gateHoldsSender}'s window and reply arm.
 */
async function member(
  row: UnscreenedRow, rules: readonly Rule[], known: KnownSenders, own: ReadonlySet<string>,
  scope: UnscreenedScope, ask: Pick<RepoPort, "isCorrespondent">, accountId: string,
): Promise<boolean> {
  if (scope.kind === "agree") {
    return gateHoldsSender(row, { rules, known, own, cutoff: scope.cutoff, ask, accountId });
  }
  const decision = evaluateRules({
    msg: asRuleInput(row, scope), rules: rules as Rule[], knownSenders: known, ownAddresses: own,
    auth: "unavailable", ohboxPolicy: DEFAULT_OHBOX_POLICY, identity: null,
  });
  return decision.source === "screener";
}

/**
 * WHETHER THE GATE HOLDS THIS STORED LETTER'S SENDER — the one definition of a stranger, read by
 * the organize decision and the gap pass. The gate's own answer with `auth` unavailable and no
 * identity fact must be the Screener; the letter needs a recorded arrival inside the window
 * (`screenerAdmits` admits a missing one for a new delivery, never for stored history); and the
 * gate's reply arm ({@link correspondentAtGate}) must not admit it as an answer to the person.
 */
export async function gateHoldsSender(
  row: UnscreenedRow,
  { rules, known, own, cutoff, ask, accountId }: {
    rules: readonly Rule[]; known: KnownSenders; own: ReadonlySet<string>; cutoff: Date | undefined;
    ask: Pick<RepoPort, "isCorrespondent">; accountId: string;
  },
): Promise<boolean> {
  const msg = asRuleInput(row, { kind: "agree", mailboxId: "", cutoff });
  const decision = evaluateRules({
    msg, rules: rules as Rule[], knownSenders: known, ownAddresses: own,
    auth: "unavailable", ohboxPolicy: DEFAULT_OHBOX_POLICY, identity: null,
  });
  if (decision.source !== "screener") return false;
  if (row.arrivedAt === null) return false;
  if (!screenerAdmits({ arrivedAt: row.arrivedAt, cutoff, source: decision.source, authFailed: false })) {
    return false;
  }
  return (await correspondentAtGate(ask, accountId, msg, decision, "unavailable", known)) === null;
}

/**
 * THE WALK — the one place the set is produced; a read and a press both call it. `lock` takes
 * `FOR UPDATE OF folder_state` inside a press (two presses move a message once). The offer stops
 * at the move bound; the agree scope reads newest arrival first and counts on to its page bound, so
 * a screen can say "the newest 1,000 of N".
 */
export async function unscreenedWalk(
  t: Tx, knowledge: UnscreenedKnowledge, accountId: string,
  opts: { lock: boolean; scope: UnscreenedScope },
): Promise<UnscreenedWalk> {
  const rules = await knowledge.listRules(accountId);
  const known = await knowledge.knownSenders(accountId);
  const ownRows = await t.select({ address: mailboxes.address }).from(mailboxes)
    .where(eq(mailboxes.accountId, accountId));
  const ownAddresses = ownRows.map((r) => r.address.toLowerCase());
  const ownSet = await readOwnAddresses(t, accountId);
  const enabled = rules.filter((r) => r.enabled);
  const needsHeaders = enabled.some((r) => r.kind === "header");
  const needsBody = enabled.some((r) => (r.bodyContains ?? "") !== "");

  const out: UnscreenedRow[] = [];
  let matched = 0;
  let complete = false;
  let afterId: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (opts.scope.kind === "offer" && out.length >= OHBOX_UNSCREENED_MESSAGES_MAX) break;
    const rows = await selectCandidates(t, {
      accountId, ownAddresses, needsHeaders, needsBody, afterId, lock: opts.lock, scope: opts.scope,
    });
    for (const row of rows) {
      if (!(await member(row, rules, known, ownSet, opts.scope, knowledge, accountId))) continue;
      matched++;
      if (out.length < OHBOX_UNSCREENED_MESSAGES_MAX) out.push(row);
    }
    if (rows.length < BATCH) { complete = true; break; }
    afterId = rows[rows.length - 1]!.messageId;
  }
  return { rows: out, matched, complete };
}

/**
 * A PLACEMENT NOBODY DECIDED, the per-row question both scopes ask: `folder_state.decided_at` is
 * unset — neither a person's filing (here, or adopted from another client) nor an answer the gate
 * admitted for itself alone. A decided letter is never offered, counted or swept.
 */
export function placementUndecided(): SQL {
  return isNull(folderState.decidedAt);
}

/**
 * ONE PAGE. Candidates are desired `INBOX`; the offer reads every mailbox this install organizes,
 * oldest id first; the agree scope one mailbox whatever its role (the count is read before the
 * press), newest arrival first. Exclusions: a decided placement ({@link placementUndecided}), a
 * triage pile, a reply draft, a decided approval, an answered sender, the account's own mail; and
 * for the agree scope also a tag, a letter with no recorded arrival and, for the sweep, one stored
 * after the press — with the window as a prefilter `member` re-asks.
 */
async function selectCandidates(
  t: Tx,
  opts: {
    accountId: string; ownAddresses: readonly string[]; needsHeaders: boolean; needsBody: boolean;
    afterId: string | null; lock: boolean; scope: UnscreenedScope;
  },
): Promise<UnscreenedRow[]> {
  const d = dialect(t);
  const filters: SQL[] = [
    eq(messages.accountId, opts.accountId),
    eq(folderState.desiredFolder, OHBOX),
    placementUndecided(),
    sql`not exists (
      select 1 from ${messageStates} ms
       where ms.message_id = ${messages.id} and ms.state <> 'none'
    )`,
    sql`not exists (
      select 1 from ${drafts} dr where dr.in_reply_to_message_id = ${messages.id}
    )`,
    sql`not exists (
      select 1 from ${approvals} a
       where a.message_id = ${messages.id} and a.status <> 'pending'
    )`,
  ];
  if (opts.scope.kind === "offer") {
    filters.push(sql`exists (
      select 1 from ${mailboxes} mb
       where mb.id = ${messages.mailboxId}
         and mb.status <> 'disabled'
         and mb.organizer_role = 'organizer'
    )`);
  } else {
    filters.push(eq(messages.mailboxId, opts.scope.mailboxId));
    filters.push(sql`not exists (
      select 1 from ${messageTags} mt where mt.message_id = ${messages.id}
    )`);
    filters.push(isNotNull(messages.arrivedAt));
    // The prefilter only bounds what the walk reads, a day wider than the window: `member` decides.
    const cutoff = opts.scope.cutoff;
    if (cutoff !== undefined) {
      filters.push(gte(messages.arrivedAt, new Date(cutoff.getTime() - PREFILTER_SLACK_MS)));
    }
    if (opts.scope.storedBy !== undefined) filters.push(lte(messages.createdAt, opts.scope.storedBy));
  }
  if (opts.ownAddresses.length > 0) {
    const own = sql`(${sql.join(opts.ownAddresses.map((a) => sql`${a}`), sql`, `)})`;
    filters.push(sql`lower(${messages.fromAddress}) not in ${own}`);
    filters.push(sql`not ${weAnsweredThisSenderWhere(d, {
      accountId: sql`${messages.accountId}`,
      threadId: sql`${messages.threadId}`,
      fromAddress: sql`${messages.fromAddress}`,
      ownAddresses: opts.ownAddresses,
    })}`);
  }
  const newestFirst = opts.scope.kind === "agree";
  if (opts.afterId && newestFirst) {
    // Past the last row read, by the stored values themselves: no timestamp crosses into JS and back.
    filters.push(sql`(${messages.arrivedAt}, ${messages.id}) < (
      select m2.arrived_at, m2.id from ${messages} m2 where m2.id = ${d.castUuid(sql`${opts.afterId}`)}
    )`);
  } else if (opts.afterId) {
    filters.push(gt(messages.id, d.castUuid(sql`${opts.afterId}`)));
  }

  // Each placeholder its own expression: on the device store two identical ones collapse.
  const q = t.select({
    messageId: messages.id,
    fromAddress: messages.fromAddress,
    subject: messages.subject,
    observedFolder: folderState.observedFolder,
    headers: opts.needsHeaders || newestFirst ? messageBodies.headers : sql<null>`null`,
    bodyText: opts.needsBody ? messageBodies.text : sql<string>`''`,
    messageIdHeader: messages.messageIdHeader,
    at: sql<string>`coalesce(${messages.date}, ${messages.createdAt})`,
    arrivedAt: messages.arrivedAt,
  }).from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(...filters))
    .orderBy(...(newestFirst ? [desc(messages.arrivedAt), desc(messages.id)] : [asc(messages.id)]))
    .limit(BATCH)
    .$dynamic();
  const rows = await (opts.lock ? d.forUpdate(q, { of: folderState }) : q);

  return rows.map((r) => ({
    messageId: r.messageId,
    fromAddress: r.fromAddress,
    subject: r.subject,
    bodyText: (r.bodyText as string | null) ?? "",
    headers: (r.headers as Record<string, string[]> | null) ?? {},
    observedFolder: r.observedFolder,
    messageIdHeader: r.messageIdHeader ?? null,
    at: new Date(r.at),
    arrivedAt: r.arrivedAt === null || r.arrivedAt === undefined ? null : new Date(r.arrivedAt),
  }));
}

/** Sender groups, largest first, bounded by {@link OHBOX_UNSCREENED_GROUPS_MAX}; ties by address. */
export function unscreenedGroups(rows: readonly UnscreenedRow[]): UnscreenedSenderGroup[] {
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
 * THE PRESS'S WRITES: desired `ohmail/Screener`, observed untouched (so `reconcile_status`
 * derives `pending` and the reconciler moves it), a change row per letter and one audit row per
 * sender group carrying its inverse. Only the shown groups move, so what a press reports and
 * what it wrote are one measurement.
 */
export async function writeScreenerIntents(
  t: Tx, ledger: LedgerTx,
  input: { accountId: string; rows: readonly UnscreenedRow[]; now: Date; via: "offer" | "agree" | "gap" },
): Promise<{ screened: UnscreenedSenderGroup[]; total: number }> {
  const screened = unscreenedGroups(input.rows);
  const moving = new Set(screened.map((g) => g.address));
  const seen = new Set<string>();
  const rows: UnscreenedRow[] = [];
  for (const row of input.rows) {
    if (!moving.has(row.fromAddress.toLowerCase()) || seen.has(row.messageId)) continue;
    seen.add(row.messageId);
    rows.push(row);
  }
  /* SET-BASED, in the caller's one transaction: a row-at-a-time press spent ~4 statements per letter
     and held the phone store's only transaction slot for minutes on a slow device. */
  for (let i = 0; i < rows.length; i += INTENT_SLICE) {
    await t.insert(folderState).values(rows.slice(i, i + INTENT_SLICE).map((row) => ({
      messageId: row.messageId, desiredFolder: SCREENER, observedFolder: row.observedFolder,
      lastSetBy: "us" as const, reconcileStatus: SCREENER === row.observedFolder ? "reconciled" as const : "pending" as const,
      conflict: false,
    }))).onConflictDoUpdate({
      target: folderState.messageId,
      set: {
        desiredFolder: SCREENER, observedFolder: sql`excluded.observed_folder`, lastSetBy: "us",
        reconcileStatus: sql`excluded.reconcile_status`, conflict: false, updatedAt: input.now,
      },
    });
  }
  await recordChanges(ledger, rows.map((row) => ({
    accountId: input.accountId, entityType: "message" as const, entityId: row.messageId, op: "move" as const,
    meta: { from: OHBOX, to: SCREENER },
  })));
  if (screened.length > 0) {
    await t.insert(auditLog).values(screened.map((g) => ({
      accountId: input.accountId,
      action: auditAction("screener.unscreened_sweep"),
      payload: { address: g.address, count: g.count, from: OHBOX, to: SCREENER, via: input.via },
      inverse: { address: g.address, from: SCREENER, to: OHBOX },
    })));
  }
  return { screened, total: rows.length };
}

/** A screening answer as the consent writes it: absent dials keep what the account stored. */
export interface ScreeningAnswer {
  dormancyDays?: number;
  scope?: ScreeningScope;
}

/**
 * THE WINDOW the organize decision is about, resolved as the consent will store it: the baseline
 * an account already has (consent `coalesce`s it) or `now`, the answer's dials over the stored
 * ones. No answer is the window already in force — what the organizer reads after the press.
 */
export async function agreeWindowCutoff(
  t: Tx, accountId: string, now: Date, answer?: ScreeningAnswer,
): Promise<Date | undefined> {
  const [row] = await t.select({
    baseline: accountSettings.screeningBaselineAt,
    days: accountSettings.dormancyDays,
    scope: accountSettings.screeningScope,
  }).from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
  const baseline = row?.baseline ?? now;
  const days = answer?.dormancyDays ?? (answer?.scope !== undefined ? undefined : row?.days ?? undefined);
  const scope = answer?.scope ?? row?.scope ?? "window";
  return resolveScreeningCutoff(baseline, days, scope);
}

/**
 * WHETHER A PROMOTION SPENT THE STAMP OF A PERSON'S AGREE: the agree press recorded
 * {@link AGREE_SCREENS_BACKLOG_ACTION} for this mailbox at the stamp's own instant, which it writes
 * only beside a first consent. A claim-back, a takeover and a later promotion carry no such row.
 */
export async function agreeRecordedAt(
  t: Tx, input: { accountId: string; mailboxId: string; stamp: Date },
): Promise<boolean> {
  const rows = await t.select({ payload: auditLog.payload, at: auditLog.createdAt }).from(auditLog)
    .where(and(eq(auditLog.accountId, input.accountId), eq(auditLog.action, AGREE_SCREENS_BACKLOG_ACTION)));
  return rows.some((r) => new Date(r.at).getTime() === input.stamp.getTime()
    && (r.payload as { mailboxId?: unknown } | null)?.mailboxId === input.mailboxId);
}

/** What the organizer's sweep after a promotion did. */
export type AgreeSweepOutcome =
  | { kind: "swept"; total: number; senders: number }
  /** No agree record at this stamp: a claim-back, a takeover or any other press. Nothing moved. */
  | { kind: "not_an_agree" }
  /** A travelling profile document holds this mailbox's history: somebody sorted it. Nothing moved. */
  | { kind: "held" }
  /** The shared settings folder could not be read, or held a garbled document: fails CLOSED. Nothing moved. */
  | { kind: "unread" }
  /** The row is no longer this install's to organize. Nothing moved. */
  | { kind: "not_organizer" };

/**
 * THE AGREE'S SWEEP, run ONCE by the organizer at the promotion that spent `stamp`: if that stamp
 * was written with a person's first agree on a screen that stated the rule, the in-window mail of
 * never-decided senders the store held at the press gets its Screener intents — the set the agree
 * screen counted, read by the same walk. One transaction: the mailbox row first (the writers' lock
 * order), then the walk. `held` is the caller's FRESH read of the settings folder: `"unread"` (a
 * fault or a garbled document) moves nothing, like a hold.
 */
export async function agreeSweepPass(
  db: Tx,
  input: {
    accountId: string; mailboxId: string; stamp: Date; held: boolean | "unread"; now: Date;
    /** The gate's knowledge bound to the sweep's transaction (`makeDrizzleRepo` over it). */
    knowledgeFor: (tx: Tx) => UnscreenedKnowledge;
    /** The sweep's ledger handle for `recordChange` — the transaction itself. */
    ledgerOf: (tx: Tx) => LedgerTx;
  },
): Promise<AgreeSweepOutcome> {
  return db.transaction(async (raw) => {
    const t = carryDialect(db, raw as object) as unknown as Tx;
    const q = t.select({ role: mailboxes.organizerRole, status: mailboxes.status }).from(mailboxes)
      .where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.accountId, input.accountId))).$dynamic();
    const [mb] = await dialect(t).forUpdate(q, { of: mailboxes });
    if (!mb || mb.status === "disabled" || mb.role !== "organizer") return { kind: "not_organizer" } as const;
    if (!(await agreeRecordedAt(t, input))) return { kind: "not_an_agree" } as const;
    if (input.held === "unread") return { kind: "unread" } as const;
    if (input.held) return { kind: "held" } as const;
    const cutoff = await agreeWindowCutoff(t, input.accountId, input.now);
    const walk = await unscreenedWalk(t, input.knowledgeFor(t), input.accountId, {
      lock: true, scope: { kind: "agree", mailboxId: input.mailboxId, cutoff, storedBy: input.stamp },
    });
    if (walk.rows.length === 0) return { kind: "swept", total: 0, senders: 0 } as const;
    const res = await writeScreenerIntents(t, input.ledgerOf(t), {
      accountId: input.accountId, rows: walk.rows, now: input.now, via: "agree",
    });
    return { kind: "swept", total: res.total, senders: res.screened.length } as const;
  });
}
