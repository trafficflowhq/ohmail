import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { fencedAccountWrite, mailboxFolders, mailboxes, MailboxErasedError, type Tx } from "@trafficflow/db";
import { mailboxStorageStats } from "@trafficflow/db/cloud";
import { dialect, pgOnly } from "@trafficflow/db/dialect";

/**
 * THE STORAGE ESTIMATE'S SNAPSHOT (cloud 0057): what ohmail holds of each of an account's mailboxes —
 * letters, letters holding text, letters emptied for space, their text bytes, and their places on the
 * server — counted here, off the request path, so `GET /account/access` reads one row per mailbox and
 * never counts the mail tables. ONE grouped aggregate per account, over the letters the account owns
 * (`ownedMessages`' predicate: its own rows, the deleted ones out), under a {@link STORAGE_STATS_TIMEOUT_MS}
 * statement timeout; a timeout or a fault writes nothing and the old rows stand. Taken when a mailbox
 * has no row, when a first import finished since its row, and else every {@link STORAGE_STATS_EVERY_MS};
 * an attempt waits {@link STORAGE_STATS_RETRY_MS} before the next, except that a first import finished
 * since an attempt for another reason is counted at the next tail. Each row is written through the
 * erasure fence on its account and its mailbox; rows of mailboxes no longer held are deleted.
 */

export const STORAGE_STATS_EVERY_MS = 6 * 60 * 60 * 1000;
export const STORAGE_STATS_TIMEOUT_MS = 20_000;
/** The least time between two attempts for one account, in this process. */
export const STORAGE_STATS_RETRY_MS = 30 * 60 * 1000;

export type StorageStatsReason = "no_row" | "imported" | "stale";

export interface StorageStatsResult {
  /** Why a snapshot was taken, or null when none was due. */
  taken: StorageStatsReason | null;
  /** Rows written. */
  mailboxes: number;
}

const triedAt = new Map<string, { at: number; reason: StorageStatsReason }>();

/** Forget this process's attempts — a test seam. */
export function resetStorageStatsAttempts(): void {
  triedAt.clear();
}

interface LiveMailbox { id: string; imported: boolean }

/** The account's mailboxes not erased; a mailbox ohmail no longer reads holds what it holds. */
async function liveMailboxesOf(db: Tx, accountId: string): Promise<LiveMailbox[]> {
  const rows = await db.select({ id: mailboxes.id, status: mailboxes.status, importedAt: mailboxes.initialImportCompletedAt })
    .from(mailboxes).where(and(eq(mailboxes.accountId, accountId), isNull(mailboxes.erasedAt)));
  return rows.map((r) => ({ id: r.id, imported: r.importedAt !== null || r.status === "disabled" }));
}

/** Why a snapshot is due for this account now, or null. Two indexed reads. */
export async function storageStatsDue(db: Tx, accountId: string, now: Date): Promise<StorageStatsReason | null> {
  const live = await liveMailboxesOf(db, accountId);
  const rows = await db.select({ mailboxId: mailboxStorageStats.mailboxId, imported: mailboxStorageStats.imported, at: mailboxStorageStats.at })
    .from(mailboxStorageStats).where(eq(mailboxStorageStats.accountId, accountId));
  const byId = new Map(rows.map((r) => [r.mailboxId, r]));
  if (live.some((m) => !byId.has(m.id))) return "no_row";
  if (live.some((m) => m.imported && !byId.get(m.id)!.imported)) return "imported";
  // Rows of mailboxes no longer held go at the next snapshot, so they make one due too.
  if (rows.some((r) => !live.some((m) => m.id === r.mailboxId))) return "stale";
  const oldest = rows.reduce((t, r) => Math.min(t, r.at.getTime()), Number.POSITIVE_INFINITY);
  return now.getTime() - oldest >= STORAGE_STATS_EVERY_MS ? "stale" : null;
}

interface Counted { letters: number; textLetters: number; emptied: number; textBytes: number; instances: number }

/** The one grouped aggregate, in a read-only transaction under the statement timeout. */
async function countLetters(db: Tx, accountId: string, timeoutMs: number): Promise<Map<string, Counted>> {
  const ms = Math.floor(timeoutMs);
  const d = dialect(db);
  const rows = await db.transaction(async (raw) => {
    const tx = raw as unknown as Tx;
    await d.exec(tx, pgOnly(sql`select set_config('statement_timeout', ${sql.raw(`'${String(ms)}'`)}, true)`));
    return d.exec(tx, pgOnly(sql`
      select m."mailbox_id" as mailbox_id,
             count(*)::int as letters,
             (count(*) filter (where b."withheld_reason" is null
                and (octet_length(b."text") > 0 or b."html" is not null)))::int as text_letters,
             (count(*) filter (where b."withheld_reason" = 'storage_cap'))::int as emptied,
             (coalesce(sum(octet_length(b."text") + coalesce(octet_length(b."html"), 0))
                filter (where b."withheld_reason" is null), 0))::text as text_bytes,
             (coalesce(sum(i.n), 0))::int as instances
        from messages m
        left join message_bodies b on b."message_id" = m."id"
        left join lateral (select count(*) as n from message_instances x where x."message_id" = m."id") i on true
       where m."account_id" = ${accountId} and m."deleted_at" is null
       group by m."mailbox_id"`));
  }, { accessMode: "read only" });
  return new Map(rows.map((r) => [String(r[0]), {
    letters: Number(r[1]), textLetters: Number(r[2]), emptied: Number(r[3]), textBytes: Number(r[4]), instances: Number(r[5]),
  }]));
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

/**
 * One account's snapshot, when it is due. Runs in the serial per-account section of the cycle tail;
 * never throws past a fault it can name: the caller's catch logs, and the next cycle tries again
 * after {@link STORAGE_STATS_RETRY_MS}.
 */
export async function storageStatsPass(
  db: Tx, opts: { accountId: string; now: Date; timeoutMs?: number },
): Promise<StorageStatsResult> {
  const { accountId, now } = opts;
  const last = triedAt.get(accountId);
  const waiting = last !== undefined && now.getTime() - last.at < STORAGE_STATS_RETRY_MS;
  if (waiting && last.reason === "imported") return { taken: null, mailboxes: 0 };
  const due = await storageStatsDue(db, accountId, now);
  // Until a snapshot after the import, the estimate leans on the server's count: take it now, once.
  if (due === null || (waiting && due !== "imported")) return { taken: null, mailboxes: 0 };
  triedAt.set(accountId, { at: now.getTime(), reason: due });
  const live = await liveMailboxesOf(db, accountId);
  const counted = await countLetters(db, accountId, opts.timeoutMs ?? STORAGE_STATS_TIMEOUT_MS);
  const folders = await folderCountsOf(db, accountId);
  let written = 0;
  for (const m of live) {
    const c = counted.get(m.id) ?? { letters: 0, textLetters: 0, emptied: 0, textBytes: 0, instances: 0 };
    const f = folders.get(m.id);
    const row = {
      ...c, serverLetters: f?.server ?? null, counted: f?.counted ?? false, imported: m.imported, at: now,
    };
    try {
      await fencedAccountWrite(db, { accountId, mailboxId: m.id }, async (tx) => {
        await tx.insert(mailboxStorageStats).values({ accountId, mailboxId: m.id, ...row })
          .onConflictDoUpdate({ target: [mailboxStorageStats.accountId, mailboxStorageStats.mailboxId], set: row });
      });
      written += 1;
    } catch (err) {
      // A mailbox erased since the read holds nothing to count; its row, if any, goes below next time.
      if (!(err instanceof MailboxErasedError)) throw err;
    }
  }
  const held = live.map((m) => m.id);
  await db.delete(mailboxStorageStats).where(and(
    eq(mailboxStorageStats.accountId, accountId),
    ...(held.length > 0 ? [notInArray(mailboxStorageStats.mailboxId, held)] : []),
  ));
  return { taken: due, mailboxes: written };
}
