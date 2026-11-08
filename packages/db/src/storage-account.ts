import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { mailboxFolders, mailboxes } from "./schema-mail.js";
import { accountStoragePrefs, mailboxStorageStats } from "./schema-cloud.js";
import { fencedAccountWrite } from "./erasure-fence.js";
import type { Tx } from "./change-log.js";
import type { StorageNeed } from "./entitlements-port.js";
import { storageFactsOf, type StorageFacts } from "./storage.js";
import { storageEstimateOf, type EstimateMailbox, type StorageEstimate } from "./storage-estimate.js";
import { isStorageCardLevel, type StorageCardDismissal } from "./storage-card.js";

/**
 * THE ACCOUNT'S STORAGE FACTS BEYOND THE COUNTER, as a request reads them: the estimate's inputs
 * (the account's mailboxes, one grouped sum of their folder counts, and the worker's snapshot rows)
 * and the person's choices (the card they dismissed, whether storage mails are off). No statement
 * here reads `messages`, `message_bodies` or `message_instances`: the snapshot is where those are
 * counted, by the worker, off the request path.
 */

/** A mailbox ohmail still holds letters of, as the estimate and the storage block read it. */
export interface StorageEstimateMailbox extends EstimateMailbox {
  /** Still on its first import: neither finished nor stopped (`storageRefillHold`'s reading). */
  importing: boolean;
}

export interface StorageEstimateFacts {
  mailboxes: StorageEstimateMailbox[];
  /** When the oldest snapshot row was taken; null before the first. */
  at: Date | null;
}

/** Three reads: the mailboxes not erased, their folder counts grouped, the snapshot rows. */
export async function storageEstimateFactsOf(db: Tx, accountId: string): Promise<StorageEstimateFacts> {
  const boxes = await db.select({
    id: mailboxes.id, status: mailboxes.status, importedAt: mailboxes.initialImportCompletedAt,
  }).from(mailboxes).where(and(eq(mailboxes.accountId, accountId), isNull(mailboxes.erasedAt)))
    .orderBy(asc(mailboxes.id));
  const folders = await db.select({
    mailboxId: mailboxFolders.mailboxId,
    server: sql<number | null>`sum(${mailboxFolders.serverExists})`.mapWith((v) => (v === null ? null : Number(v))),
    uncounted: sql<number>`count(*) filter (where ${mailboxFolders.serverExists} is null)`.mapWith(Number),
  }).from(mailboxFolders)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxFolders.mailboxId))
    .where(eq(mailboxes.accountId, accountId))
    .groupBy(mailboxFolders.mailboxId);
  const stats = await db.select({
    mailboxId: mailboxStorageStats.mailboxId, letters: mailboxStorageStats.letters,
    textLetters: mailboxStorageStats.textLetters, textBytes: mailboxStorageStats.textBytes,
    instances: mailboxStorageStats.instances, imported: mailboxStorageStats.imported, at: mailboxStorageStats.at,
  }).from(mailboxStorageStats).where(eq(mailboxStorageStats.accountId, accountId));
  const folderOf = new Map(folders.map((f) => [f.mailboxId, f]));
  const statsOf = new Map(stats.map((s) => [s.mailboxId, s]));
  let at: Date | null = null;
  const out = boxes.map((b): StorageEstimateMailbox => {
    const f = folderOf.get(b.id);
    const s = statsOf.get(b.id);
    if (s && (at === null || s.at.getTime() < at.getTime())) at = s.at;
    // A mailbox ohmail stopped reading holds what it holds; a mailbox with no folder row is uncounted.
    const imported = b.importedAt !== null || b.status === "disabled";
    return {
      id: b.id,
      serverLetters: f?.server ?? null,
      counted: f !== undefined && f.uncounted === 0,
      imported,
      importing: !imported,
      stats: s ? {
        letters: Number(s.letters), textLetters: Number(s.textLetters),
        textBytes: Number(s.textBytes), instances: Number(s.instances), imported: s.imported,
      } : null,
    };
  });
  return { mailboxes: out, at };
}

/** The person's storage choices: the dismissal on record, and whether the storage mails are off. */
export interface StoragePrefs {
  dismissal: StorageCardDismissal | null;
  mailOffAt: Date | null;
}

/** One primary-key read; no row reads as nothing dismissed and mails on. */
export async function storagePrefsOf(db: Tx, accountId: string): Promise<StoragePrefs> {
  const [row] = await db.select({
    level: accountStoragePrefs.cardDismissedLevel, cap: accountStoragePrefs.cardDismissedCap,
    emptied: accountStoragePrefs.cardDismissedEmptied, dropsAt: accountStoragePrefs.cardDismissedDropsAt,
    at: accountStoragePrefs.cardDismissedAt, mailOffAt: accountStoragePrefs.mailOffAt,
  }).from(accountStoragePrefs).where(eq(accountStoragePrefs.accountId, accountId)).limit(1);
  if (!row) return { dismissal: null, mailOffAt: null };
  const dismissal = isStorageCardLevel(row.level) && row.cap !== null && row.emptied !== null && row.at !== null
    ? { level: row.level, capBytes: Number(row.cap), emptied: Number(row.emptied), dropsAt: row.dropsAt ?? null, at: row.at }
    : null;
  return { dismissal, mailOffAt: row.mailOffAt ?? null };
}

/** Record a dismissal, replacing the one on record. Through the erasure fence. */
export async function recordStorageDismissal(db: Tx, accountId: string, d: StorageCardDismissal): Promise<void> {
  const set = {
    cardDismissedLevel: d.level, cardDismissedCap: d.capBytes, cardDismissedEmptied: d.emptied,
    cardDismissedDropsAt: d.dropsAt, cardDismissedAt: d.at, updatedAt: d.at,
  };
  await fencedAccountWrite(db, { accountId }, async (tx) => {
    await tx.insert(accountStoragePrefs).values({ accountId, ...set })
      .onConflictDoUpdate({ target: accountStoragePrefs.accountId, set });
  });
}

/** Everything a storage reading starts from, before the program is asked. */
export interface StorageReading {
  counter: StorageFacts;
  facts: StorageEstimateFacts;
  prefs: StoragePrefs;
  estimate: StorageEstimate;
  /** What the program is told the mail needs, so it can size its offer. */
  need: StorageNeed;
}

/** The counter row, the estimate's three reads and the choices row: five reads, no aggregate over mail. */
export async function storageReadingOf(db: Tx, accountId: string): Promise<StorageReading> {
  const counter = await storageFactsOf(db, accountId);
  const facts = await storageEstimateFactsOf(db, accountId);
  const prefs = await storagePrefsOf(db, accountId);
  const estimate = storageEstimateOf(facts.mailboxes, counter.usedBytes);
  return {
    counter, facts, prefs, estimate,
    need: {
      expectedBytes: estimate.expectedBytes, expectedLetters: estimate.expectedLetters,
      importing: facts.mailboxes.some((m) => m.importing),
    },
  };
}

/** Turn the storage mails off (stamped) or on again. Through the erasure fence. */
export async function setStorageMail(db: Tx, accountId: string, on: boolean, now: Date): Promise<void> {
  const set = { mailOffAt: on ? null : now, updatedAt: now };
  await fencedAccountWrite(db, { accountId }, async (tx) => {
    await tx.insert(accountStoragePrefs).values({ accountId, ...set })
      .onConflictDoUpdate({ target: accountStoragePrefs.accountId, set });
  });
}
