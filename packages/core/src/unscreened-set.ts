import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import {
  accountSettings, approvals, auditAction, auditLog, cutlineInstant, drafts, folderState, mailboxes,
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
   it, in slices. Membership is one rule for both ({@link gateHoldsSender}): the arrival gate's own
   `evaluateRules` answer, `screenerAdmits` on the server's receive clock (`messages.arrived_at`),
   with a letter that has no recorded arrival outside the window, and the gate's reply arm. A bulk
   move also needs the date the person sees (the queue's `cutlineInstant`) inside the window, so
   migrated mail with a fresh arrival stays. Writes are intents only: the organizer's reconciler
   performs every move. */

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
 * Which set: the account-wide offer, or one mailbox (the organize decision); both inside the
 * account's window. `storedBy` is the sweep's start: it moves only what the store held then.
 * `after` is the last letter a previous slice read; a letter gone since restarts from the top.
 */
export type UnscreenedScope =
  | { kind: "offer"; cutoff: Date | undefined }
  | { kind: "agree"; mailboxId: string; cutoff: Date | undefined; storedBy?: Date; after?: string | null };

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
  /** Members seen in all, past the move bound too when the walk has no `stopAt`. */
  matched: number;
  /** Distinct senders among every member seen. */
  senders: number;
  /** False when `stopAt` or the page bound stopped the walk, so `matched` is a floor. */
  complete: boolean;
  /** The last letter the walk read, where a next slice goes on from. */
  last: string | null;
}

function asRuleInput(row: UnscreenedRow): NormalizedMessage {
  return {
    canonical: { messageIdHeader: row.messageIdHeader, bodyHash: "" },
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
  const msg = asRuleInput(row);
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
 * THE WALK — the one place the set is produced; a read, a press and a sweep slice all call it.
 * `lock` takes `FOR UPDATE OF folder_state` inside a press (two presses move a message once). A
 * press and a slice stop at `stopAt` members; a count reads on to its page bound.
 */
export async function unscreenedWalk(
  t: Tx, knowledge: UnscreenedKnowledge, accountId: string,
  opts: { lock: boolean; scope: UnscreenedScope; stopAt?: number },
): Promise<UnscreenedWalk> {
  const rules = await knowledge.listRules(accountId);
  const known = await knowledge.knownSenders(accountId);
  const ownRows = await t.select({ address: mailboxes.address }).from(mailboxes)
    .where(eq(mailboxes.accountId, accountId));
  const ownAddresses = ownRows.map((r) => r.address.toLowerCase());
  const ownSet = await readOwnAddresses(t, accountId);
  const enabled = rules.filter((r) => r.enabled);
  const needsBody = enabled.some((r) => (r.bodyContains ?? "") !== "");

  const out: UnscreenedRow[] = [];
  const senders = new Set<string>();
  let matched = 0;
  let complete = false;
  let afterId = opts.scope.kind === "agree" ? opts.scope.after ?? null : null;
  if (afterId !== null) {
    // A cursor letter gone from the store restarts the walk from the top.
    const [still] = await t.select({ id: messages.id }).from(messages)
      .where(eq(messages.id, dialect(t).castUuid(sql`${afterId}`))).limit(1);
    if (!still) afterId = null;
  }
  let last: string | null = afterId;
  pages: for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await selectCandidates(t, {
      accountId, ownAddresses, needsBody, afterId, lock: opts.lock, scope: opts.scope,
    });
    for (const row of rows) {
      last = row.messageId;
      if (!(await gateHoldsSender(row, { rules, known, own: ownSet, cutoff: opts.scope.cutoff, ask: knowledge, accountId }))) continue;
      matched++;
      senders.add(row.fromAddress.toLowerCase());
      if (out.length < OHBOX_UNSCREENED_MESSAGES_MAX) out.push(row);
      if (opts.stopAt !== undefined && out.length >= opts.stopAt) break pages;
    }
    if (rows.length < BATCH) { complete = true; break; }
    afterId = rows[rows.length - 1]!.messageId;
  }
  return { rows: out, matched, senders: senders.size, complete, last };
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
 * triage pile, a reply draft, a decided approval, an answered sender, the account's own mail, a
 * tag, a letter with no recorded arrival, one whose shown date is older than the window and, for
 * the sweep, one stored after its start — with the arrival window as a prefilter
 * {@link gateHoldsSender} re-asks.
 */
async function selectCandidates(
  t: Tx,
  opts: {
    accountId: string; ownAddresses: readonly string[]; needsBody: boolean;
    afterId: string | null; lock: boolean; scope: UnscreenedScope;
  },
): Promise<UnscreenedRow[]> {
  const d = dialect(t);
  const filters: SQL[] = [
    eq(messages.accountId, opts.accountId),
    eq(folderState.desiredFolder, OHBOX),
    placementUndecided(),
    // A letter gone from the server is no candidate: offering it screens a ghost.
    isNull(messages.deletedAt),
    isNull(messages.serverMissingAt),
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
    sql`not exists (
      select 1 from ${messageTags} mt where mt.message_id = ${messages.id}
    )`,
    isNotNull(messages.arrivedAt),
  ];
  const cutoff = opts.scope.cutoff;
  if (cutoff !== undefined) {
    // The arrival prefilter only bounds what the walk reads, a day wider: the gate decides.
    filters.push(gte(messages.arrivedAt, new Date(cutoff.getTime() - PREFILTER_SLACK_MS)));
    // The date the queue and History show must be inside too: an import's fresh arrival is not new mail.
    filters.push(sql`${cutlineInstant({ date: sql`${messages.date}`, arrivedAt: sql`${messages.createdAt}` })} >= ${d.ts(cutoff)}`);
  }
  if (opts.scope.kind === "offer") {
    filters.push(sql`exists (
      select 1 from ${mailboxes} mb
       where mb.id = ${messages.mailboxId}
         and mb.status <> 'disabled'
         and mb.organizer_role = 'organizer'
    )`);
  } else {
    filters.push(eq(messages.mailboxId, opts.scope.mailboxId));
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
    headers: messageBodies.headers,
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
export function unscreenedGroups(
  rows: readonly UnscreenedRow[], max: number = OHBOX_UNSCREENED_GROUPS_MAX,
): UnscreenedSenderGroup[] {
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
    .slice(0, max);
}

/**
 * THE PRESS'S WRITES: desired `ohmail/Screener`, observed untouched (so `reconcile_status`
 * derives `pending` and the reconciler moves it), a change row per letter and one audit row per
 * sender group carrying its inverse. A press moves only the shown groups (`"shown"`), so what it
 * reports and what it wrote are one measurement; the agree's sweep moves every group (`"all"`).
 */
export async function writeScreenerIntents(
  t: Tx, ledger: LedgerTx,
  input: {
    accountId: string; rows: readonly UnscreenedRow[]; now: Date; via: "offer" | "agree" | "gap";
    groups: "shown" | "all";
  },
): Promise<{ screened: UnscreenedSenderGroup[]; total: number }> {
  const screened = unscreenedGroups(input.rows, input.groups === "all" ? Infinity : OHBOX_UNSCREENED_GROUPS_MAX);
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

/** The agree record's payload: the mailbox, and the window agreed to (ISO, null for all time). */
export async function agreeRecordPayload(
  t: Tx, accountId: string, mailboxId: string, now: Date,
): Promise<{ mailboxId: string; cutoff: string | null }> {
  const cutoff = await agreeWindowCutoff(t, accountId, now);
  return { mailboxId, cutoff: cutoff === undefined ? null : cutoff.toISOString() };
}

/**
 * THE AGREE RECORD A PROMOTION SPENT, or null: the agree press recorded
 * {@link AGREE_SCREENS_BACKLOG_ACTION} for this mailbox at the stamp's own instant, which it writes
 * only beside a first consent. A claim-back, a takeover and a later promotion carry no such row.
 * `agreed` is the window it names (null all time), undefined for a record written before it did.
 */
export async function agreeRecordAt(
  t: Tx, input: { accountId: string; mailboxId: string; stamp: Date },
): Promise<{ agreed: Date | null | undefined } | null> {
  const rows = await t.select({ payload: auditLog.payload, at: auditLog.createdAt }).from(auditLog)
    .where(and(eq(auditLog.accountId, input.accountId), eq(auditLog.action, AGREE_SCREENS_BACKLOG_ACTION)));
  for (const r of rows) {
    const p = r.payload as { mailboxId?: unknown; cutoff?: unknown } | null;
    if (new Date(r.at).getTime() !== input.stamp.getTime() || p?.mailboxId !== input.mailboxId) continue;
    if (p.cutoff === null) return { agreed: null };
    const at = typeof p.cutoff === "string" ? new Date(p.cutoff) : null;
    return { agreed: at !== null && Number.isFinite(at.getTime()) ? at : undefined };
  }
  return null;
}

/** WHETHER A PROMOTION SPENT THE STAMP OF A PERSON'S AGREE ({@link agreeRecordAt}). */
export async function agreeRecordedAt(
  t: Tx, input: { accountId: string; mailboxId: string; stamp: Date },
): Promise<boolean> {
  return (await agreeRecordAt(t, input)) !== null;
}

/** The narrower of two windows: the later cutoff; all time (undefined) only when both are. */
function narrowerWindow(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Where the agree's sweep goes on: the store it was fixed on, the last letter a slice read, and the
 * window agreed to (null all time) — a later widening of the dials never extends the sweep.
 */
export interface AgreeSweepCursor {
  storedBy: Date;
  after: string | null;
  agreed: Date | null;
}

/** What one slice of the organizer's sweep after a promotion did. */
export type AgreeSweepOutcome =
  /** `next` is where the following slice goes on, or null when the window is done. */
  | { kind: "swept"; total: number; senders: number; next: AgreeSweepCursor | null }
  /** No agree record at this stamp: a claim-back, a takeover or any other press. Nothing moved. */
  | { kind: "not_an_agree" }
  /** A travelling profile document holds this mailbox's history: somebody sorted it. Nothing moved. */
  | { kind: "held" }
  /** The shared settings folder could not be read, or held a garbled document: fails CLOSED. Nothing moved. */
  | { kind: "unread" }
  /** The row is no longer this install's to organize. Nothing moved. */
  | { kind: "not_organizer" };

export interface AgreeSweepInput {
  accountId: string; mailboxId: string; stamp: Date; held: boolean | "unread"; now: Date;
  /** The gate's knowledge bound to the sweep's transaction (`makeDrizzleRepo` over it). */
  knowledgeFor: (tx: Tx) => UnscreenedKnowledge;
  /** The sweep's ledger handle for `recordChange` — the transaction itself. */
  ledgerOf: (tx: Tx) => LedgerTx;
  /** Where the previous slice stopped; absent or null for the first. */
  cursor?: AgreeSweepCursor | null;
  /** Letters one slice moves, {@link OHBOX_UNSCREENED_MESSAGES_MAX} unless a host says less. */
  slice?: number;
}

/**
 * ONE SLICE OF THE AGREE'S SWEEP, run by the organizer after the promotion that spent `stamp`: if
 * that stamp was written with a person's first agree on a screen that stated the rule, up to one
 * slice of the in-window mail of never-decided senders gets its Screener intents. The set is what
 * the store held when the sweep started (the first slice's `now`), newest arrival first. One
 * transaction per slice: the mailbox row first (the writers' lock order), then every check again,
 * then the walk. `held` is the caller's FRESH read of the settings folder: `"unread"` (a fault or a
 * garbled document) moves nothing, like a hold.
 */
export async function agreeSweepSlice(db: Tx, input: AgreeSweepInput): Promise<AgreeSweepOutcome> {
  return db.transaction(async (raw) => {
    const t = carryDialect(db, raw as object) as unknown as Tx;
    const q = t.select({ role: mailboxes.organizerRole, status: mailboxes.status }).from(mailboxes)
      .where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.accountId, input.accountId))).$dynamic();
    const [mb] = await dialect(t).forUpdate(q, { of: mailboxes });
    if (!mb || mb.status === "disabled" || mb.role !== "organizer") return { kind: "not_organizer" } as const;
    const record = await agreeRecordAt(t, input);
    if (record === null) return { kind: "not_an_agree" } as const;
    if (input.held === "unread") return { kind: "unread" } as const;
    if (input.held) return { kind: "held" } as const;
    const storedBy = input.cursor?.storedBy ?? input.now;
    const current = await agreeWindowCutoff(t, input.accountId, input.now);
    // The record's window; an older record without one takes the first slice's, carried in the cursor.
    const agreed = input.cursor ? input.cursor.agreed : record.agreed === undefined ? current ?? null : record.agreed;
    const cutoff = narrowerWindow(agreed ?? undefined, current);
    const walk = await unscreenedWalk(t, input.knowledgeFor(t), input.accountId, {
      lock: true, stopAt: input.slice ?? OHBOX_UNSCREENED_MESSAGES_MAX,
      scope: { kind: "agree", mailboxId: input.mailboxId, cutoff, storedBy, after: input.cursor?.after ?? null },
    });
    const next = walk.complete ? null : { storedBy, after: walk.last, agreed };
    if (walk.rows.length === 0) return { kind: "swept", total: 0, senders: 0, next } as const;
    const res = await writeScreenerIntents(t, input.ledgerOf(t), {
      accountId: input.accountId, rows: walk.rows, now: input.now, via: "agree", groups: "all",
    });
    return { kind: "swept", total: res.total, senders: res.screened.length, next } as const;
  });
}

/** Slices one drain may run before it hands the cursor to the next. */
export const AGREE_SWEEP_SLICES_PER_DRAIN = 10;

/** What one drain's run of the sweep did: the last slice's verdict, summed counts, the cursor left. */
export interface AgreeSweepRun {
  verdict: AgreeSweepOutcome["kind"];
  total: number;
  /** Undo rows written: a sender spanning two slices counts in each. */
  senders: number;
  slices: number;
  next: AgreeSweepCursor | null;
}

/**
 * THE SWEEP BOTH HOSTS CALL, once per organizing drain: slices back to back, each its own
 * transaction, yielding between them so the store serves other writers, at most
 * {@link AGREE_SWEEP_SLICES_PER_DRAIN}. A non-null `next` is the host's to carry to its next drain.
 */
export async function agreeSweepRun(db: Tx, input: AgreeSweepInput & { maxSlices?: number }): Promise<AgreeSweepRun> {
  const max = input.maxSlices ?? AGREE_SWEEP_SLICES_PER_DRAIN;
  let cursor = input.cursor ?? null;
  let total = 0;
  let senders = 0;
  let slices = 0;
  for (;;) {
    if (slices > 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const out = await agreeSweepSlice(db, { ...input, cursor });
    slices++;
    if (out.kind !== "swept") return { verdict: out.kind, total, senders, slices, next: null };
    total += out.total;
    senders += out.senders;
    cursor = out.next;
    if (cursor === null || slices >= max) return { verdict: "swept", total, senders, slices, next: cursor };
  }
}
