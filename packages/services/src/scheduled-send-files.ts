import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { dialect, dialectOf } from "@trafficflow/db/dialect";
import { drafts, scheduledSendFiles, type Tx } from "@trafficflow/db";
import { bridgeTx, type Db } from "./context.js";

/**
 * A SCHEDULED LETTER'S FILES (mail 0179) — kept in the local engine's own store from the schedule
 * press until the appointment ends, then read back by the scheduled-send pass and sent as the
 * letter's attachments. Servers never write rows: the route that takes files is mounted on the
 * local table alone, and `/hello` says `scheduleFiles: false` everywhere else.
 */

/** One file as the schedule route decoded it. */
export interface ScheduledFile {
  filename: string;
  contentType: string;
  content: Buffer;
}

/** A file's identity as stored, without its bytes: what a claim's digest folds. */
export interface ScheduledFileMeta {
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentSha256: string;
}

/** Base64 characters per row: PGlite fails a single value of about 17 MB (as `SEND_COPY_OWED_PIECE_CHARS`). */
export const SCHEDULED_FILE_PIECE_CHARS = 4 * 1024 * 1024;

/** The Drafts sentence for an appointment whose files did not read back whole. */
export const SCHEDULED_FILES_UNREADABLE =
  "This message's files could not be read back on this computer, so it was not sent. Attach them again and send it.";

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** An appointment's files as rows under its key, one per piece. The caller inserts them on its fenced transaction. */
export function scheduledFileRows(
  at: { accountId: string; mailboxId: string; draftId: string; sendKey: string },
  files: readonly ScheduledFile[],
): Array<typeof scheduledSendFiles.$inferInsert> {
  const rows: Array<typeof scheduledSendFiles.$inferInsert> = [];
  for (const [fileNo, f] of files.entries()) {
    const b64 = f.content.toString("base64");
    const meta = {
      ...at, fileNo, filename: f.filename, contentType: f.contentType,
      sizeBytes: f.content.byteLength, contentSha256: sha256(f.content),
    };
    for (let seq = 0; seq === 0 || seq * SCHEDULED_FILE_PIECE_CHARS < b64.length; seq += 1) {
      rows.push({ ...meta, seq, rawB64: b64.slice(seq * SCHEDULED_FILE_PIECE_CHARS, (seq + 1) * SCHEDULED_FILE_PIECE_CHARS) });
    }
  }
  return rows;
}

/** Every file row of one draft, whatever its key. Inside the caller's transaction. */
export async function dropScheduledFiles(tx: Tx, accountId: string, draftId: string): Promise<void> {
  await tx.delete(scheduledSendFiles)
    .where(and(eq(scheduledSendFiles.accountId, accountId), eq(scheduledSendFiles.draftId, draftId)));
}

/** The appointment's files without their bytes, in order: piece 0 of each. */
export async function scheduledFilesMeta(
  tx: Tx, accountId: string, draftId: string, sendKey: string,
): Promise<ScheduledFileMeta[]> {
  return tx.select({
    filename: scheduledSendFiles.filename, contentType: scheduledSendFiles.contentType,
    sizeBytes: scheduledSendFiles.sizeBytes, contentSha256: scheduledSendFiles.contentSha256,
  }).from(scheduledSendFiles)
    .where(and(
      eq(scheduledSendFiles.accountId, accountId), eq(scheduledSendFiles.draftId, draftId),
      eq(scheduledSendFiles.sendKey, sendKey), eq(scheduledSendFiles.seq, 0),
    ))
    .orderBy(asc(scheduledSendFiles.fileNo));
}

/**
 * The appointment's files read back, or `null` when they are not whole: not exactly `expected`
 * files numbered from 0, a piece missing, or a file whose size or sha-256 differs from what was
 * written. One piece per statement, so no single value is ever large.
 */
export async function readScheduledFiles(
  db: Db, accountId: string, draftId: string, sendKey: string, expected: number,
): Promise<ScheduledFile[] | null> {
  const tx = bridgeTx(db);
  const heads = await tx.select({
    fileNo: scheduledSendFiles.fileNo, filename: scheduledSendFiles.filename,
    contentType: scheduledSendFiles.contentType, sizeBytes: scheduledSendFiles.sizeBytes,
    contentSha256: scheduledSendFiles.contentSha256,
  }).from(scheduledSendFiles)
    .where(and(
      eq(scheduledSendFiles.accountId, accountId), eq(scheduledSendFiles.draftId, draftId),
      eq(scheduledSendFiles.sendKey, sendKey), eq(scheduledSendFiles.seq, 0),
    ))
    .orderBy(asc(scheduledSendFiles.fileNo));
  if (heads.length !== expected || heads.some((h, i) => h.fileNo !== i)) return null;
  const out: ScheduledFile[] = [];
  for (const h of heads) {
    const pieces: string[] = [];
    for (let seq = 0; ; seq += 1) {
      const [p] = await tx.select({ s: scheduledSendFiles.rawB64 }).from(scheduledSendFiles)
        .where(and(
          eq(scheduledSendFiles.accountId, accountId), eq(scheduledSendFiles.draftId, draftId),
          eq(scheduledSendFiles.sendKey, sendKey), eq(scheduledSendFiles.fileNo, h.fileNo),
          eq(scheduledSendFiles.seq, seq),
        )).limit(1);
      if (!p) break;
      pieces.push(p.s);
    }
    const content = Buffer.from(pieces.join(""), "base64");
    if (content.byteLength !== h.sizeBytes || sha256(content) !== h.contentSha256) return null;
    out.push({ filename: h.filename, contentType: h.contentType, content });
  }
  return out;
}

/**
 * Remove the files no appointment carries any more: rows whose draft is gone or no longer holds
 * their key. Every ending of an appointment clears or replaces the key, so this catches each one.
 * Answers how many rows went; on the desktop's PGlite the space is handed back when any did.
 */
export async function sweepScheduledSendFiles(db: Db, opts: { mailboxIds?: readonly string[] } = {}): Promise<number> {
  if (opts.mailboxIds !== undefined && opts.mailboxIds.length === 0) return 0;
  const tx = bridgeTx(db);
  const gone = await tx.delete(scheduledSendFiles)
    .where(and(
      ...(opts.mailboxIds ? [inArray(scheduledSendFiles.mailboxId, [...opts.mailboxIds])] : []),
      // scoped-by: each row is matched to its own draft by (account_id, id, send_key) inside the subquery
      sql`not exists (select 1 from ${drafts} where ${drafts.id} = ${scheduledSendFiles.draftId}
            and ${drafts.accountId} = ${scheduledSendFiles.accountId}
            and ${drafts.sendKey} = ${scheduledSendFiles.sendKey})`,
    ))
    .returning({ draftId: scheduledSendFiles.draftId });
  if (gone.length > 0 && dialectOf(db) === "pg") {
    await dialect(db).exec(db, sql`VACUUM scheduled_send_files`).catch(() => { /* the store's open reclaims it */ });
  }
  return gone.length;
}
