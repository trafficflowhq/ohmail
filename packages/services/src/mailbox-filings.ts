/**
 * SETTINGS → MAILBOXES: THE FILINGS THAT WAIT, AND THE TWO PRESSES ON THEM.
 *
 * The strip said "6 messages have not been filed … · Settings → Mailboxes" and the pane had
 * nothing to say about them. This module is the account-scoped read behind the pane's block and
 * its two presses. It never dials and never moves mail: "Try again now" re-arms the schedule so
 * the worker's next pass picks the rows up, and "Leave them where they are" settles the intent on
 * the folder the mail is already in. Every statement carries the account and the mailbox, and goes
 * through the dialect helpers — the local door mounts these routes on the device store too.
 */
import { and, asc, eq, inArray, lt, not, sql, type SQL } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import {
  assertOrganizerRole, auditAction, auditLog, decisionInstant, filingDeferred, filingStuck, filingWaiting,
  folderState, isFilingRefusalClass, mailboxes, messages, outstandingFilingsOf, readOrganizerRole,
  recordChanges, ringFilingDoorbell, type FilingRefusalClass, type Tx,
} from "@trafficflow/db";
import { LEGACY_NEWS_FOLDER, NEWS_FOLDER, createLogger } from "@trafficflow/core/mail";
import { bridgeTx, withAccountTx, type ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";

/** The most rows one press settles or re-arms; the block shows what remains. */
export const FILINGS_PRESS_MAX = 500;
/** A folder name on the wire, compared verbatim and never canonicalized. */
export const FILINGS_FOLDER_MAX_CHARS = 1024;
/** How many (folder, class) pairs one read folds; past it `more` is set. */
const FILINGS_PAIRS_MAX = 100;

/** Why the rows of one group wait: a known class, `unknown` for one this build cannot name, or none. */
export interface MailboxFilingsReason {
  reason: FilingRefusalClass | "unknown" | null;
  count: number;
}

/** The waiting filings into one folder. Counts, names and instants only. */
export interface MailboxFilingsGroup {
  folder: string;
  count: number;
  deferred: number;
  stuck: number;
  /** Rows deleted here and not in the mailbox's Trash, a delete that has not landed: Leave never settles them. */
  deletes: number;
  /** The oldest row's `updated_at`. */
  since: string | null;
  /** The newest row's `updated_at` — the bound a Leave press repeats. */
  through: string | null;
  /** The soonest scheduled retry among the deferred rows. */
  nextAttemptAt: string | null;
  /** The folder the mail sits in on the server, when every row sits in the same one. */
  at: string | null;
  reasons: MailboxFilingsReason[];
}

export interface MailboxFilingsDTO {
  mailboxId: string;
  asOf: string;
  more: boolean;
  groups: MailboxFilingsGroup[];
}

const log = createLogger({ service: "mailbox-filings" });

/** The live mailbox of this account and its Trash path, or 404. A removed mailbox (a tombstone) is not one. */
async function liveMailbox(tx: Tx, ctx: ServiceContext, id: string): Promise<{ trash: string | null }> {
  const [m] = await tx.select({ status: mailboxes.status, trash: mailboxes.trashFolder }).from(mailboxes)
    .where(and(eq(mailboxes.id, id), eq(mailboxes.accountId, ctx.accountId))).limit(1);
  if (!m || m.status === "disabled") throw new ServiceError("not_found", 404, "mailbox not found");
  return { trash: m.trash };
}

/** This mailbox's waiting filings of this account — the one predicate the read and both presses use. */
function waitingOf(ctx: ServiceContext, id: string, now: Date): SQL {
  return and(
    eq(messages.accountId, ctx.accountId), eq(messages.mailboxId, id),
    outstandingFilingsOf(ctx.accountId), filingWaiting(now),
  )!;
}

/**
 * Deleted here and not in Trash as the last attach named it: settled, the row would stay deleted
 * outside Trash, shown nowhere. Not the desired folder: every attach re-writes `trash_folder`.
 */
function deletedOutsideTrash(trash: string | null): SQL {
  return trash === null
    ? sql`(${messages.deletedAt} is not null)`
    : sql`(${messages.deletedAt} is not null and ${folderState.observedFolder} <> ${trash})`;
}

/** Desired and observed both a News spelling: a move between them would take the letter for its own copy. */
const NEWS_PAIR: SQL = and(
  inArray(folderState.desiredFolder, [NEWS_FOLDER, LEGACY_NEWS_FOLDER]),
  inArray(folderState.observedFolder, [NEWS_FOLDER, LEGACY_NEWS_FOLDER]),
)!;

function folderOf(body: unknown): string {
  const folder = (body as { folder?: unknown } | null)?.folder;
  if (typeof folder !== "string" || folder === "" || folder.length > FILINGS_FOLDER_MAX_CHARS) {
    throw new ServiceError("validation_failed", 400, `folder must be a folder name of at most ${FILINGS_FOLDER_MAX_CHARS} characters`);
  }
  return folder;
}

function throughOf(body: unknown): Date {
  const through = (body as { through?: unknown } | null)?.through;
  const at = typeof through === "string" && through.length <= 40 ? Date.parse(through) : Number.NaN;
  if (Number.isNaN(at)) throw new ServiceError("validation_failed", 400, "through must be a timestamp");
  return new Date(at);
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function narrowed(cls: string | null): MailboxFilingsReason["reason"] {
  if (cls === null) return null;
  return isFilingRefusalClass(cls) ? cls : "unknown";
}

export async function readMailboxFilings(ctx: ServiceContext, id: string): Promise<MailboxFilingsDTO> {
  const now = ctx.now();
  const tx = bridgeTx(ctx.db);
  const d = dialect(ctx.db);
  const { trash } = await liveMailbox(tx, ctx, id);
  const empty: MailboxFilingsDTO = { mailboxId: id, asOf: now.toISOString(), more: false, groups: [] };
  // A reader's leftover rows are not this install's to retry or settle.
  const role = await readOrganizerRole(tx, d, ctx.accountId, id);
  if (role?.role !== "organizer") return empty;

  // scoped-by: waitingOf binds messages.account_id and messages.mailbox_id
  const pairs = await tx.select({
    folder: folderState.desiredFolder,
    cls: folderState.lastErrorClass,
    n: d.castInt(sql`count(*)`).mapWith(Number) as unknown as SQL<number>,
    deferred: d.castInt(sql`count(*) filter (where ${filingDeferred(now)})`).mapWith(Number) as unknown as SQL<number>,
    stuck: d.castInt(sql`count(*) filter (where ${filingStuck(now)})`).mapWith(Number) as unknown as SQL<number>,
    deletes: d.castInt(sql`count(*) filter (where ${deletedOutsideTrash(trash)})`).mapWith(Number) as unknown as SQL<number>,
    since: sql<Date | null>`min(${folderState.updatedAt})`.mapWith(folderState.updatedAt) as unknown as SQL<Date | null>,
    through: sql<Date | null>`max(${folderState.updatedAt})`.mapWith(folderState.updatedAt) as unknown as SQL<Date | null>,
    next: sql<Date | null>`min(${folderState.nextAttemptAt}) filter (where ${filingDeferred(now)})`
      .mapWith(folderState.nextAttemptAt) as unknown as SQL<Date | null>,
    atLow: sql<string | null>`min(${folderState.observedFolder})`,
    atHigh: sql<string | null>`max(${folderState.observedFolder})`,
  }).from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(waitingOf(ctx, id, now))
    .groupBy(folderState.desiredFolder, folderState.lastErrorClass)
    .orderBy(asc(folderState.desiredFolder), asc(folderState.lastErrorClass))
    .limit(FILINGS_PAIRS_MAX + 1);

  const byFolder = new Map<string, MailboxFilingsGroup & { mixed: boolean; reasonCounts: Map<MailboxFilingsReason["reason"], number> }>();
  for (const p of pairs.slice(0, FILINGS_PAIRS_MAX)) {
    let g = byFolder.get(p.folder);
    if (!g) {
      g = {
        folder: p.folder, count: 0, deferred: 0, stuck: 0, deletes: 0, since: null, through: null, nextAttemptAt: null,
        at: p.atLow, reasons: [], mixed: false, reasonCounts: new Map(),
      };
      byFolder.set(p.folder, g);
    }
    g.count += p.n;
    g.deferred += p.deferred;
    g.stuck += p.stuck;
    g.deletes += p.deletes;
    const since = iso(p.since), through = iso(p.through), next = iso(p.next);
    if (since !== null && (g.since === null || since < g.since)) g.since = since;
    if (through !== null && (g.through === null || through > g.through)) g.through = through;
    if (next !== null && (g.nextAttemptAt === null || next < g.nextAttemptAt)) g.nextAttemptAt = next;
    if (p.atLow !== p.atHigh || p.atLow !== g.at) g.mixed = true;
    const reason = narrowed(p.cls ?? null);
    g.reasonCounts.set(reason, (g.reasonCounts.get(reason) ?? 0) + p.n);
  }
  const groups = [...byFolder.values()].map(({ mixed, reasonCounts, ...g }) => ({
    ...g,
    at: mixed ? null : g.at,
    reasons: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || (a.reason === null ? 1 : b.reason === null ? -1 : a.reason.localeCompare(b.reason))),
  })).sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
  return { ...empty, more: pairs.length > FILINGS_PAIRS_MAX, groups };
}

/**
 * TRY AGAIN NOW — the oldest waiting rows into `folder` lose their schedule and their class, so the
 * worker's next pass picks them up; the doorbell asks for that pass sooner. `updated_at` is not
 * touched (it is the row's place in the queue) and no change row is written: nothing moved. A row
 * whose desired and observed folders are both a News spelling is never re-armed.
 */
export async function retryMailboxFilings(
  ctx: ServiceContext, id: string, body: unknown,
): Promise<{ reset: number; skipped: number }> {
  const folder = folderOf(body);
  const now = ctx.now();
  const answer = await withAccountTx(ctx, async (tx) => {
    await liveMailbox(bridgeTx(tx), ctx, id);
    await assertOrganizerRole(bridgeTx(tx), dialect(ctx.db), ctx.accountId, id);
    const into = and(waitingOf(ctx, id, now), eq(folderState.desiredFolder, folder))!;
    // scoped-by: waitingOf binds messages.account_id and messages.mailbox_id
    const target = tx.select({ id: folderState.id }).from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(into, not(NEWS_PAIR)))
      .orderBy(asc(folderState.updatedAt), asc(folderState.id))
      .limit(FILINGS_PRESS_MAX);
    // scoped-by: the ids come from `target`, the caller's own waiting rows
    const reset = await tx.update(folderState)
      .set({ attempts: 0, nextAttemptAt: null, lastErrorClass: null })
      .where(and(inArray(folderState.id, target), eq(folderState.desiredFolder, folder)))
      .returning({ id: folderState.id });
    // scoped-by: waitingOf binds messages.account_id and messages.mailbox_id
    const [skipped] = await tx.select({ n: dialect(ctx.db).castInt(sql`count(*)`).mapWith(Number) as unknown as SQL<number> })
      .from(folderState).innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(into, NEWS_PAIR));
    await tx.insert(auditLog).values({
      accountId: ctx.accountId, action: auditAction("filing.retry"),
      payload: { mailboxId: id, folder, count: reset.length }, createdAt: now,
    });
    return { reset: reset.length, skipped: skipped?.n ?? 0 };
  });
  // After the commit, as the move door rings it: a failed stamp costs one rotation, never the press.
  try {
    await ringFilingDoorbell(bridgeTx(ctx.db), id, now);
  } catch (err) {
    log.warn("filing_doorbell_failed", {
      accountId: ctx.accountId, mailboxId: id, err,
      reason: "the retry COMMITTED; only the ask-the-organizer-sooner stamp failed",
    });
  }
  return answer;
}

/**
 * LEAVE THEM WHERE THEY ARE — the oldest waiting rows into `folder` that nobody has touched since
 * the block was read (`through`) take their observed folder as the desired one, verbatim, and are
 * reconciled. One `move` change row each, so every client re-renders; the put-back stamp, so no
 * automatic pass files them again. It teaches no rule and rings no doorbell: nothing moves.
 * A row deleted here and not in Trash ({@link deletedOutsideTrash}) is never settled: it would
 * stay tombstoned outside Trash, shown nowhere. A waiting restore still in Trash is settled like
 * any filing, back into Trash.
 */
export async function leaveMailboxFilings(
  ctx: ServiceContext, id: string, body: unknown,
): Promise<{ settled: number; remaining: number; seq: bigint | null }> {
  const folder = folderOf(body);
  const through = throughOf(body);
  const now = ctx.now();
  const d = dialect(ctx.db);
  return withAccountTx(ctx, async (tx) => {
    const { trash } = await liveMailbox(bridgeTx(tx), ctx, id);
    await assertOrganizerRole(bridgeTx(tx), d, ctx.accountId, id);
    const into = and(waitingOf(ctx, id, now), eq(folderState.desiredFolder, folder), not(deletedOutsideTrash(trash)))!;
    // `through` is milliseconds and the store may keep microseconds: the whole millisecond counts.
    // scoped-by: waitingOf binds messages.account_id and messages.mailbox_id
    const target = tx.select({ id: folderState.id }).from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(into, lt(folderState.updatedAt, new Date(through.getTime() + 1))))
      .orderBy(asc(folderState.updatedAt), asc(folderState.id))
      .limit(FILINGS_PRESS_MAX);
    // scoped-by: the ids come from `target`, the caller's own waiting rows
    const settled = await tx.update(folderState)
      .set({
        desiredFolder: sql`${folderState.observedFolder}`,
        reconcileStatus: "reconciled", lastSetBy: "us", conflict: false,
        attempts: 0, nextAttemptAt: null, lastErrorClass: null,
        updatedAt: now, decidedAt: decisionInstant(ctx.pressFloor, now), trashedFrom: null,
        autoFilingUndoneAt: sql`coalesce(${folderState.autoFilingUndoneAt}, ${d.ts(now)})`,
      })
      .where(and(
        inArray(folderState.id, target), eq(folderState.desiredFolder, folder),
        eq(folderState.reconcileStatus, "pending"), eq(folderState.lastSetBy, "us"),
      ))
      .returning({ messageId: folderState.messageId, observed: folderState.observedFolder });
    const seqs = await recordChanges(tx, settled.map((r) => ({
      accountId: ctx.accountId, entityType: "message" as const, entityId: r.messageId, op: "move" as const,
      meta: { from: folder, to: r.observed },
    })));
    await tx.insert(auditLog).values({
      accountId: ctx.accountId, action: auditAction("filing.leave"),
      payload: { mailboxId: id, folder, count: settled.length },
      inverse: { desiredFolder: folder, messageIds: settled.map((r) => r.messageId) },
      createdAt: now,
    });
    // scoped-by: waitingOf binds messages.account_id and messages.mailbox_id
    const [left] = await tx.select({ n: d.castInt(sql`count(*)`).mapWith(Number) as unknown as SQL<number> })
      .from(folderState).innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(into);
    return {
      settled: settled.length, remaining: left?.n ?? 0,
      seq: seqs.length === 0 ? null : seqs.reduce((a, b) => (b > a ? b : a)),
    };
  });
}
