import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import {
  accountStorage, accountSyncState, fencedAccountWrite, mailboxFolders, mailboxes, MailboxErasedError, type Tx,
} from "@trafficflow/db";
import { mailboxStorageStats } from "@trafficflow/db/cloud";
import { dialect, pgOnly } from "@trafficflow/db/dialect";

/**
 * THE STORAGE ESTIMATE'S SNAPSHOT (cloud 0057, marks 0058): what ohmail holds of each of an account's
 * mailboxes — letters, letters holding text, letters emptied for space, their text bytes, and their places
 * on the server — counted here, off the request path, so `GET /account/access` reads one row per mailbox
 * and never counts the mail tables. Over the letters the account owns (`ownedMessages`' predicate: its own
 * rows, the deleted ones out).
 *
 * A mailbox is due when it has no row, when its first import finished since its row, and else every
 * {@link STORAGE_STATS_EVERY_MS}. A due mailbox whose row carries marks is CHECKED first: it changed if the
 * change log names one of its letters past the row's `through_seq` (read {@link STORAGE_STATS_CHANGES_PAGE}
 * seqs per statement), if the log was pruned past that seq, or if it holds text and a trim ran since
 * (`husked_at`). Unchanged, the row is confirmed without reading a letter. Changed, without marks, or last
 * read whole {@link STORAGE_STATS_RECOUNT_MS} ago (`walked_at`), the mailbox is WALKED: pages of
 * {@link STORAGE_STATS_PAGE_LETTERS} letters in `dedup_key` order, each one read-only statement under
 * {@link STORAGE_STATS_TIMEOUT_MS}, summed in memory and written whole when the last page comes back
 * short. Every row is written through the erasure fence; rows of mailboxes no longer held are deleted.
 *
 * Progress lives in this process per account. `until` is asked after each statement; a failing statement
 * keeps its place, and the account waits {@link STORAGE_STATS_RETRY_MS} before it resumes there. A new
 * round waits that long after the last one began, except that a first import finished since an attempt
 * for another reason is counted at the next tail.
 */

export const STORAGE_STATS_EVERY_MS = 6 * 60 * 60 * 1000;
/** Per statement. */
export const STORAGE_STATS_TIMEOUT_MS = 5_000;
/** The least time between two rounds for one account, and after a fault, in this process. */
export const STORAGE_STATS_RETRY_MS = 30 * 60 * 1000;
/** Letters one page statement reads. */
export const STORAGE_STATS_PAGE_LETTERS = 500;
/** Change-log seqs one check statement reads. */
export const STORAGE_STATS_CHANGES_PAGE = 2_000;
/**
 * A mailbox read whole this long before its check is read whole again, whatever the change log says: a
 * write that moves text with neither a change row nor a trim stamp (a junk filing's husk, its refill)
 * stands this and a period at most.
 */
export const STORAGE_STATS_RECOUNT_MS = 7 * 24 * 60 * 60 * 1000;

export type StorageStatsReason = "no_row" | "imported" | "stale";

export interface StorageStatsResult {
  /** Why the round in hand was taken, or null when none was due or it waits after a fault. */
  taken: StorageStatsReason | null;
  /** Rows written by this call. */
  mailboxes: number;
  /** The round has work left for a later call. */
  more: boolean;
}

interface Counted { letters: number; textLetters: number; emptied: number; textBytes: number; instances: number }
interface Marks { nextSeq: bigint; pruned: bigint; huskedAt: Date | null }
interface Check { mailboxId: string; throughSeq: bigint; holdsText: boolean; huskedAt: Date | null; imported: boolean }
interface Walk {
  mailboxId: string; startedAt: Date; imported: boolean; marks: Marks;
  /** The last `dedup_key` read; it may embed a Message-ID, so it never leaves this process. */
  after: string | null;
  sums: Counted;
}
interface Round {
  reason: StorageStatsReason;
  checks: Check[];
  /** The check's marks and how far its window has been read, once it began. */
  scan: { marks: Marks; lo: bigint; changed: Set<string> } | null;
  walks: string[];
  walk: Walk | null;
  faultAt: number | null;
}

const triedAt = new Map<string, { at: number; reason: StorageStatsReason }>();
const rounds = new Map<string, Round>();

/** Forget this process's attempts and progress — a test seam. */
export function resetStorageStatsAttempts(): void {
  triedAt.clear();
  rounds.clear();
}

interface LiveMailbox { id: string; imported: boolean }
type StatsRow = {
  mailboxId: string; imported: boolean; at: Date; textLetters: number;
  throughSeq: bigint | null; huskedAt: Date | null; walkedAt: Date | null;
};

/** The account's mailboxes not erased; a mailbox ohmail no longer reads holds what it holds. */
async function liveMailboxesOf(db: Tx, accountId: string, only?: string): Promise<LiveMailbox[]> {
  const rows = await db.select({ id: mailboxes.id, status: mailboxes.status, importedAt: mailboxes.initialImportCompletedAt })
    .from(mailboxes).where(and(eq(mailboxes.accountId, accountId), isNull(mailboxes.erasedAt),
      ...(only === undefined ? [] : [eq(mailboxes.id, only)])));
  return rows.map((r) => ({ id: r.id, imported: r.importedAt !== null || r.status === "disabled" }));
}

async function statsRowsOf(db: Tx, accountId: string): Promise<StatsRow[]> {
  return db.select({
    mailboxId: mailboxStorageStats.mailboxId, imported: mailboxStorageStats.imported, at: mailboxStorageStats.at,
    textLetters: mailboxStorageStats.textLetters, throughSeq: mailboxStorageStats.throughSeq, huskedAt: mailboxStorageStats.huskedAt,
    walkedAt: mailboxStorageStats.walkedAt,
  }).from(mailboxStorageStats).where(eq(mailboxStorageStats.accountId, accountId));
}

const isDue = (m: LiveMailbox, row: StatsRow | undefined, now: Date): boolean =>
  row === undefined || (m.imported && !row.imported) || now.getTime() - row.at.getTime() >= STORAGE_STATS_EVERY_MS;

function dueReason(live: LiveMailbox[], rows: StatsRow[], now: Date): StorageStatsReason | null {
  const byId = new Map(rows.map((r) => [r.mailboxId, r]));
  if (live.some((m) => !byId.has(m.id))) return "no_row";
  if (live.some((m) => m.imported && !byId.get(m.id)!.imported)) return "imported";
  // Rows of mailboxes no longer held go at the next round, so they make one due too.
  if (rows.some((r) => !live.some((m) => m.id === r.mailboxId))) return "stale";
  return live.some((m) => isDue(m, byId.get(m.id), now)) ? "stale" : null;
}

/** Why a round is due for this account now, or null. Two indexed reads. */
export async function storageStatsDue(db: Tx, accountId: string, now: Date): Promise<StorageStatsReason | null> {
  return dueReason(await liveMailboxesOf(db, accountId), await statsRowsOf(db, accountId), now);
}

/** The account's committed seq, prune floor and last trim: two primary-key reads. */
async function marksOf(db: Tx, accountId: string): Promise<Marks> {
  const [s] = await db.select({ nextSeq: accountSyncState.nextSeq, pruned: accountSyncState.prunedThroughSeq })
    .from(accountSyncState).where(eq(accountSyncState.accountId, accountId));
  const [c] = await db.select({ at: accountStorage.lastHuskedAt }).from(accountStorage).where(eq(accountStorage.accountId, accountId));
  return { nextSeq: BigInt(s?.nextSeq ?? 0), pruned: BigInt(s?.pruned ?? 0), huskedAt: c?.at ?? null };
}

/** One statement in its own read-only transaction under the statement timeout. */
async function readBounded(db: Tx, timeoutMs: number, statement: ReturnType<typeof sql>): Promise<unknown[][]> {
  const ms = Math.floor(timeoutMs);
  const d = dialect(db);
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Tx;
    await d.exec(tx, pgOnly(sql`select set_config('statement_timeout', ${sql.raw(`'${String(ms)}'`)}, true)`));
    return d.exec(tx, statement);
  }, { accessMode: "read only" });
}

/** The mailboxes a letter change in (lo, hi] names, each with its latest seq there. */
async function changedIn(db: Tx, accountId: string, lo: bigint, hi: bigint, timeoutMs: number): Promise<Map<string, bigint>> {
  const rows = await readBounded(db, timeoutMs, pgOnly(sql`
    select m."mailbox_id" as mailbox_id, max(c."seq")::text as seq
      from change_log c
      join messages m on m."id" = c."entity_id" and m."account_id" = c."account_id"
     where c."account_id" = ${accountId} and c."entity_type" = 'message'
       and c."seq" > ${String(lo)}::bigint and c."seq" <= ${String(hi)}::bigint
     group by m."mailbox_id"`));
  return new Map(rows.map((r) => [String(r[0]), BigInt(String(r[1]))]));
}

/** One page of a mailbox's letters in `dedup_key` order, with the snapshot's five figures over it. */
async function countPage(
  db: Tx, accountId: string, mailboxId: string, after: string | null, limit: number, timeoutMs: number,
): Promise<{ scanned: number; lastKey: string | null; counted: Counted }> {
  const [r] = await readBounded(db, timeoutMs, pgOnly(sql`
    with page as (
      select m."id", m."dedup_key", m."deleted_at" from messages m
       where m."mailbox_id" = ${mailboxId} and m."account_id" = ${accountId}
         ${after === null ? sql`` : sql`and m."dedup_key" > ${after}`}
       order by m."dedup_key" limit ${limit}
    )
    select (select count(*) from page)::int as scanned,
           (select max(p."dedup_key") from page p) as last_key,
           count(*)::int as letters,
           (count(*) filter (where b."withheld_reason" is null
              and (octet_length(b."text") > 0 or b."html" is not null)))::int as text_letters,
           (count(*) filter (where b."withheld_reason" = 'storage_cap'))::int as emptied,
           (coalesce(sum(octet_length(b."text") + coalesce(octet_length(b."html"), 0))
              filter (where b."withheld_reason" is null), 0))::text as text_bytes,
           (coalesce(sum(i.n), 0))::int as instances
      from page p
      left join message_bodies b on b."message_id" = p."id"
      left join lateral (select count(*) as n from message_instances x where x."message_id" = p."id") i on true
     where p."deleted_at" is null`));
  return {
    scanned: Number(r?.[0] ?? 0), lastKey: r?.[1] == null ? null : String(r[1]),
    counted: { letters: Number(r?.[2] ?? 0), textLetters: Number(r?.[3] ?? 0), emptied: Number(r?.[4] ?? 0),
      textBytes: Number(r?.[5] ?? 0), instances: Number(r?.[6] ?? 0) },
  };
}

/** The folder counts per mailbox: the stated letters summed, and whether every folder row has one. */
async function folderCountsOf(db: Tx, accountId: string): Promise<Map<string, { server: number | null; counted: boolean }>> {
  const rows = await db.select({
    mailboxId: mailboxFolders.mailboxId,
    server: sql<number | null>`sum(${mailboxFolders.serverExists})`.mapWith((v) => (v === null ? null : Number(v))),
    uncounted: sql<number>`count(*) filter (where ${mailboxFolders.serverExists} is null)`.mapWith(Number),
  }).from(mailboxFolders).innerJoin(mailboxes, eq(mailboxes.id, mailboxFolders.mailboxId))
    .where(eq(mailboxes.accountId, accountId)).groupBy(mailboxFolders.mailboxId);
  return new Map(rows.map((r) => [r.mailboxId, { server: r.server, counted: r.uncounted === 0 }]));
}

/** A row through the erasure fence; false when the mailbox was erased (or, confirming, its row went). */
async function writeRow(
  db: Tx, accountId: string, mailboxId: string,
  row: Partial<Counted> & {
    serverLetters: number | null; counted: boolean; imported: boolean; at: Date; throughSeq: bigint; huskedAt: Date | null; walkedAt?: Date;
  },
  whole: boolean,
): Promise<boolean> {
  try {
    return await fencedAccountWrite(db, { accountId, mailboxId }, async (tx) => {
      const key = and(eq(mailboxStorageStats.accountId, accountId), eq(mailboxStorageStats.mailboxId, mailboxId));
      if (!whole) return (await tx.update(mailboxStorageStats).set(row).where(key).returning({ at: mailboxStorageStats.at })).length > 0;
      await tx.insert(mailboxStorageStats).values({ accountId, mailboxId, ...(row as Counted & typeof row) })
        .onConflictDoUpdate({ target: [mailboxStorageStats.accountId, mailboxStorageStats.mailboxId], set: row });
      return true;
    });
  } catch (err) {
    // A mailbox erased since the read holds nothing to count; its row, if any, goes at the next round.
    if (err instanceof MailboxErasedError) return false;
    throw err;
  }
}

const sameInstant = (a: Date | null, b: Date | null): boolean => (a?.getTime() ?? null) === (b?.getTime() ?? null);

async function startRound(db: Tx, accountId: string, now: Date, reason: StorageStatsReason, live: LiveMailbox[], rows: StatsRow[]): Promise<Round> {
  const held = live.map((m) => m.id);
  await db.delete(mailboxStorageStats).where(and(
    eq(mailboxStorageStats.accountId, accountId),
    ...(held.length > 0 ? [notInArray(mailboxStorageStats.mailboxId, held)] : []),
  ));
  const byId = new Map(rows.map((r) => [r.mailboxId, r]));
  const round: Round = { reason, checks: [], scan: null, walks: [], walk: null, faultAt: null };
  for (const m of live) {
    const row = byId.get(m.id);
    if (!isDue(m, row, now)) continue;
    // Without marks, or last read whole a week ago, it is read whole; else checked against the change log.
    const walkedAt = row?.walkedAt?.getTime() ?? null;
    if (row === undefined || row.throughSeq === null || walkedAt === null || now.getTime() - walkedAt >= STORAGE_STATS_RECOUNT_MS) round.walks.push(m.id);
    else round.checks.push({ mailboxId: m.id, throughSeq: BigInt(row.throughSeq), holdsText: row.textLetters > 0, huskedAt: row.huskedAt, imported: m.imported });
  }
  return round;
}

/** Checks, then walks, until done or `until` says stop; returns rows written. */
async function advance(
  db: Tx, accountId: string, now: Date, round: Round, until: () => boolean, timeoutMs: number, pageLetters: number,
): Promise<{ written: number; more: boolean }> {
  let written = 0;
  if (round.checks.length > 0) {
    if (round.scan === null) {
      const marks = await marksOf(db, accountId);
      const lo = round.checks.reduce((x, c) => (c.throughSeq < x ? c.throughSeq : x), marks.nextSeq);
      round.scan = { marks, lo, changed: new Set() };
    }
    const scan = round.scan;
    const changedNow = (floor: bigint): void => {
      for (const c of round.checks) {
        // A mark ahead of the counter (a restored database) proves nothing either.
        if (floor > c.throughSeq || c.throughSeq > scan.marks.nextSeq
          || (c.holdsText && !sameInstant(c.huskedAt, scan.marks.huskedAt))) scan.changed.add(c.mailboxId);
      }
    };
    changedNow(scan.marks.pruned);
    while (scan.lo < scan.marks.nextSeq && round.checks.some((c) => !scan.changed.has(c.mailboxId))) {
      const hi = scan.lo + BigInt(STORAGE_STATS_CHANGES_PAGE) < scan.marks.nextSeq ? scan.lo + BigInt(STORAGE_STATS_CHANGES_PAGE) : scan.marks.nextSeq;
      const named = await changedIn(db, accountId, scan.lo, hi, timeoutMs);
      for (const c of round.checks) if ((named.get(c.mailboxId) ?? -1n) > c.throughSeq) scan.changed.add(c.mailboxId);
      scan.lo = hi;
      if (until()) return { written, more: true };
    }
    // Rows the retention pass deleted while the window was read raised the floor first.
    changedNow((await marksOf(db, accountId)).pruned);
    const folders = await folderCountsOf(db, accountId);
    for (const c of round.checks.filter((x) => !scan.changed.has(x.mailboxId))) {
      const f = folders.get(c.mailboxId);
      if (await writeRow(db, accountId, c.mailboxId, {
        serverLetters: f?.server ?? null, counted: f?.counted ?? false, imported: c.imported, at: now,
        throughSeq: scan.marks.nextSeq, huskedAt: scan.marks.huskedAt,
      }, false)) written += 1;
    }
    round.walks.push(...round.checks.filter((x) => scan.changed.has(x.mailboxId)).map((x) => x.mailboxId));
    round.checks = [];
    round.scan = null;
  }
  for (;;) {
    if (round.walk === null) {
      const mailboxId = round.walks.shift();
      if (mailboxId === undefined) return { written, more: false };
      const marks = await marksOf(db, accountId);
      const [m] = await liveMailboxesOf(db, accountId, mailboxId);
      round.walk = {
        mailboxId, startedAt: now, imported: m?.imported ?? false, marks, after: null,
        sums: { letters: 0, textLetters: 0, emptied: 0, textBytes: 0, instances: 0 },
      };
    }
    const walk = round.walk;
    const page = await countPage(db, accountId, walk.mailboxId, walk.after, pageLetters, timeoutMs);
    const sums = { ...walk.sums };
    for (const k of Object.keys(sums) as Array<keyof Counted>) sums[k] += page.counted[k];
    if (page.scanned < pageLetters) {
      const f = (await folderCountsOf(db, accountId)).get(walk.mailboxId);
      if (await writeRow(db, accountId, walk.mailboxId, {
        ...sums, serverLetters: f?.server ?? null, counted: f?.counted ?? false, imported: walk.imported,
        at: walk.startedAt, throughSeq: walk.marks.nextSeq, huskedAt: walk.marks.huskedAt, walkedAt: walk.startedAt,
      }, true)) written += 1;
      round.walk = null;
    } else {
      walk.sums = sums;
      walk.after = page.lastKey;
    }
    if (until()) return { written, more: round.walk !== null || round.walks.length > 0 };
  }
}

/**
 * One account's snapshot work for this tail. Runs in the serial per-account section of the cycle tail;
 * a fault throws to the caller's catch, which logs, and the account resumes where it stopped after
 * {@link STORAGE_STATS_RETRY_MS}.
 */
export async function storageStatsPass(
  db: Tx, opts: { accountId: string; now: Date; timeoutMs?: number; until?: () => boolean; pageLetters?: number },
): Promise<StorageStatsResult> {
  const { accountId, now } = opts;
  let round = rounds.get(accountId);
  if (round === undefined) {
    const last = triedAt.get(accountId);
    const waiting = last !== undefined && now.getTime() - last.at < STORAGE_STATS_RETRY_MS;
    if (waiting && last.reason === "imported") return { taken: null, mailboxes: 0, more: false };
    const live = await liveMailboxesOf(db, accountId);
    const rows = await statsRowsOf(db, accountId);
    const due = dueReason(live, rows, now);
    // Until a snapshot after the import, the estimate leans on the server's count: take it now, once.
    if (due === null || (waiting && due !== "imported")) return { taken: null, mailboxes: 0, more: false };
    triedAt.set(accountId, { at: now.getTime(), reason: due });
    round = await startRound(db, accountId, now, due, live, rows);
    rounds.set(accountId, round);
  } else if (round.faultAt !== null && now.getTime() - round.faultAt < STORAGE_STATS_RETRY_MS) {
    return { taken: null, mailboxes: 0, more: true };
  }
  round.faultAt = null;
  try {
    const { written, more } = await advance(
      db, accountId, now, round, opts.until ?? (() => false),
      opts.timeoutMs ?? STORAGE_STATS_TIMEOUT_MS, opts.pageLetters ?? STORAGE_STATS_PAGE_LETTERS,
    );
    if (!more) rounds.delete(accountId);
    return { taken: round.reason, mailboxes: written, more };
  } catch (err) {
    round.faultAt = now.getTime();
    throw err;
  }
}
