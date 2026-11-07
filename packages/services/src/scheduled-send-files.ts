import { createHash } from "node:crypto";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { dialect, dialectOf } from "@trafficflow/db/dialect";
import { drafts, scheduledSendFiles, type Tx } from "@trafficflow/db";
import { bridgeTx, type Db } from "./context.js";

/**
 * A SCHEDULED LETTER'S FILES (mail 0179, 0180) — kept from the schedule press until the appointment
 * ends, then read back by the scheduled-send pass and sent as the letter's attachments. Where they
 * are kept is the host's declaration, {@link ScheduledFilesKeeping}: the desktop's own store keeps
 * plain rows; a server (Cloud, self-host) keeps every piece sealed under its own key, at most
 * {@link SCHEDULE_FILES_MAX_AHEAD_MS} ahead, inside a per-account quota. A host that declares nothing
 * does not mount the route that takes files.
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

/** Where a piece sits: what its seal is bound to, so a row moved to another letter does not open. */
export interface PiecePlace {
  accountId: string;
  draftId: string;
  fileNo: number;
  seq: number;
}

/** A sealed piece as stored (mail 0180): the sealed bytes, and the piece's key wrapped by the key ring. */
export interface SealedPiece {
  rawB64: string;
  dekEnc: string;
  dekKeyVersion: number;
}

/** Seals a server's pieces at the press and opens them for the pass (`scheduled-files-seal.ts`). */
export interface ScheduledFileSealer {
  seal(piece: Buffer, at: PiecePlace): Promise<SealedPiece>;
  /** The piece's bytes; throws on any failure, a wrong place included. */
  open(row: SealedPiece, at: PiecePlace): Promise<Buffer>;
}

/**
 * HOW THIS HOST KEEPS A SCHEDULED LETTER'S FILES (`ApiServices.scheduledFiles`). `plain`: the
 * desktop's own store, one year ahead like any appointment. `sealed`: a server — sealed pieces, a
 * horizon, a per-letter ceiling and a per-account quota.
 */
export type ScheduledFilesKeeping =
  | { readonly atRest: "plain" }
  | {
    readonly atRest: "sealed";
    readonly sealer: ScheduledFileSealer;
    /** How far ahead a letter with files may be scheduled. */
    readonly maxAheadMs: number;
    /** The most file bytes one scheduled letter may carry, whatever the mailbox accepts. */
    readonly maxTotalBytes: number;
    /** What one account may keep across its other scheduled letters, in bytes and in files. */
    readonly quota: { readonly maxBytes: number; readonly maxFiles: number };
  };

/** The desktop's declaration. */
export const SCHEDULED_FILES_PLAIN: ScheduledFilesKeeping = { atRest: "plain" };

/** How far ahead a server takes a letter with files: seven days. */
export const SCHEDULE_FILES_MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

/** What one account may keep on a server across its scheduled letters: 1 GiB and 500 files. */
export const SCHEDULED_FILES_QUOTA = { maxBytes: 1024 * 1024 * 1024, maxFiles: 500 } as const;

/**
 * The `classid` half of the quota's `pg_advisory_xact_lock(int4, int4)`, keyed per account by
 * `hashtext(account_id)`; the `4207270…` family beside `STAGING_QUOTA_LOCK_CLASS`.
 */
export const SCHEDULED_FILES_QUOTA_LOCK_CLASS = 420_727_021;

/** Base64 characters per plain row: PGlite fails a single value of about 17 MB (as `SEND_COPY_OWED_PIECE_CHARS`). */
export const SCHEDULED_FILE_PIECE_CHARS = 4 * 1024 * 1024;

/** Raw bytes per sealed piece: its base64 stays near {@link SCHEDULED_FILE_PIECE_CHARS}. */
export const SEALED_FILE_PIECE_BYTES = 3 * 1024 * 1024;

/** The Drafts sentence for an appointment whose files did not read back whole, on the desktop. */
export const SCHEDULED_FILES_UNREADABLE =
  "This message's files could not be read back on this computer, so it was not sent. Attach them again and send it.";

/** The same, on a server. */
export const SCHEDULED_FILES_UNREADABLE_KEPT =
  "This message's files could not be read back, so it was not sent. Attach them again and send it.";

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

/** A sealed row before the transaction names its key and its mailbox. */
export type SealedFileRow = Omit<typeof scheduledSendFiles.$inferInsert, "sendKey" | "mailboxId">;

/** One file sealed into pieces of {@link SEALED_FILE_PIECE_BYTES}, numbered `fileNo`. */
export async function sealedFileRows(
  at: { accountId: string; draftId: string; fileNo: number },
  file: ScheduledFile,
  sealer: ScheduledFileSealer,
): Promise<SealedFileRow[]> {
  const meta = {
    accountId: at.accountId, draftId: at.draftId, fileNo: at.fileNo, filename: file.filename,
    contentType: file.contentType, sizeBytes: file.content.byteLength, contentSha256: sha256(file.content),
  };
  const rows: SealedFileRow[] = [];
  for (let seq = 0; seq === 0 || seq * SEALED_FILE_PIECE_BYTES < file.content.byteLength; seq += 1) {
    const piece = file.content.subarray(seq * SEALED_FILE_PIECE_BYTES, (seq + 1) * SEALED_FILE_PIECE_BYTES);
    rows.push({ ...meta, seq, ...await sealer.seal(piece, { accountId: at.accountId, draftId: at.draftId, fileNo: at.fileNo, seq }) });
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
 * files numbered from 0, a piece missing, a piece that does not open, or a file whose size or
 * sha-256 differs from what was written. One piece per statement, each decoded into one buffer of
 * the file's stored size. A sealed piece opens only through `open`; without it the files are not
 * whole, so a host that cannot open them never sends the letter without them. A statement that
 * fails throws: it says nothing about the files.
 */
export async function readScheduledFiles(
  db: Db, accountId: string, draftId: string, sendKey: string, expected: number,
  open?: ScheduledFileSealer["open"],
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
    const content = Buffer.alloc(h.sizeBytes);
    let at = 0;
    for (let seq = 0; ; seq += 1) {
      const [p] = await tx.select({
        s: scheduledSendFiles.rawB64, dekEnc: scheduledSendFiles.dekEnc, dekKeyVersion: scheduledSendFiles.dekKeyVersion,
      }).from(scheduledSendFiles)
        .where(and(
          eq(scheduledSendFiles.accountId, accountId), eq(scheduledSendFiles.draftId, draftId),
          eq(scheduledSendFiles.sendKey, sendKey), eq(scheduledSendFiles.fileNo, h.fileNo),
          eq(scheduledSendFiles.seq, seq),
        )).limit(1);
      if (!p) break;
      let bytes: Buffer;
      if (p.dekEnc === null && p.dekKeyVersion === null) {
        // A plain piece is a whole run of base64 quads, so it decodes on its own.
        bytes = Buffer.from(p.s, "base64");
      } else if (p.dekEnc !== null && p.dekKeyVersion !== null && open) {
        try {
          bytes = await open({ rawB64: p.s, dekEnc: p.dekEnc, dekKeyVersion: p.dekKeyVersion }, { accountId, draftId, fileNo: h.fileNo, seq });
        } catch {
          return null;
        }
      } else {
        return null;
      }
      if (at + bytes.byteLength > h.sizeBytes) return null;
      bytes.copy(content, at);
      at += bytes.byteLength;
    }
    if (at !== h.sizeBytes || sha256(content) !== h.contentSha256) return null;
    out.push({ filename: h.filename, contentType: h.contentType, content });
  }
  return out;
}

/**
 * Remove the files no appointment carries any more: rows whose draft is gone or no longer holds
 * their key. Every ending of an appointment clears or replaces the key, so this catches each one.
 * Answers how many rows went; on the desktop's PGlite the space is handed back when any did
 * (`vacuum: false` on a server, whose own autovacuum does that).
 */
export async function sweepScheduledSendFiles(
  db: Db, opts: { mailboxIds?: readonly string[]; vacuum?: boolean } = {},
): Promise<number> {
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
  if (gone.length > 0 && opts.vacuum !== false && dialectOf(db) === "pg") {
    await dialect(db).exec(db, sql`VACUUM scheduled_send_files`).catch(() => { /* the store's open reclaims it */ });
  }
  return gone.length;
}

/**
 * A server's backstop: rows written before `before` go, unless their letter is mid-send (its draft
 * still holds their key at `sending`). Every appointment with files on a server ends long before
 * this — at most {@link SCHEDULE_FILES_MAX_AHEAD_MS} ahead, closed a day after its time — so this
 * reaches only a letter something else left behind, which then closes as unreadable when it comes due.
 */
export async function sweepAgedScheduledFiles(db: Db, before: Date): Promise<number> {
  const gone = await bridgeTx(db).delete(scheduledSendFiles)
    .where(and(
      lt(scheduledSendFiles.createdAt, before),
      // scoped-by: each row is matched to its own draft by (account_id, id, send_key) inside the subquery
      sql`not exists (select 1 from ${drafts} where ${drafts.id} = ${scheduledSendFiles.draftId}
            and ${drafts.accountId} = ${scheduledSendFiles.accountId}
            and ${drafts.sendKey} = ${scheduledSendFiles.sendKey}
            and ${drafts.status} = 'sending')`,
    ))
    .returning({ draftId: scheduledSendFiles.draftId });
  return gone.length;
}
