import JSZip from "jszip";
import { and, asc, eq, gt, gte, inArray } from "drizzle-orm";
import { attachments, messages } from "@trafficflow/db";
import { CALENDAR_FALLBACK_FILENAME, isCalendarMime, type NativeLocator, type EmailAddress } from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { clampLimit, decodeListCursor, encodeListCursor } from "./pagination.js";
import type { Page } from "./dto/types.js";

/**
 * AttachmentsService. Attachment METADATA is stored
 * server-side; the BLOB bytes are NEVER stored — they are fetched ON-DEMAND from
 * IMAP by `partId` and streamed to the client (`GET /attachments/:id`) or zipped
 * (`download-all`). Every query is account-scoped: a cross-account id is
 * indistinguishable from a missing one → 404. The IMAP fetch is done through an
 * INJECTED `openAdapter` so this service never imports the worker or dials IMAP
 * itself; the API wires it to a real (decrypt-creds → ImapAdapter) factory and
 * tests inject a fake/GreenMail adapter.
 */

/** The wire shape for one attachment (metadata only — no bytes). */
export interface AttachmentDTO {
  id: string;
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  inline: boolean;
  /**
   * The part's `Content-ID` (angle brackets stripped at ingest), or `null` for a part that has
   * none. It is what lets a client resolve the html body's `cid:<contentId>` references to this
   * very row and draw the embedded image in place — without it the client can see THAT the body
   * references embedded parts but never WHICH row serves each one.
   */
  contentId: string | null;
  messageId: string;
}

/** An attachment row in the file library, joined to its message header. */
export interface FileDTO extends AttachmentDTO {
  message: { subject: string; from: EmailAddress; date: string | null };
}

/** One BLOB fetched on-demand from IMAP — bytes are NEVER persisted. */
export interface FetchedBytes { contentType: string; filename: string | null; body: Uint8Array; }

/**
 * A connected, per-mailbox adapter handle. `fetchPart` pulls one part's bytes;
 * `close` tears the connection down. The API builds this from decrypted mailbox
 * creds; tests inject a fake/GreenMail-backed one.
 */
export interface AttachmentAdapter {
  /**
   * `opts.maxBytes` abandons the transfer mid-stream once the ceiling is crossed and rejects with
   * an `AttachmentTooLargeError` (code `EATTACHTOOLARGE`). Doing so POISONS THE CONNECTION — the
   * parser is left mid-literal — so only a caller that owns this adapter for one fetch and closes
   * it afterwards may pass it. {@link AttachmentsService.fetchBytes} does; `downloadAll` must not,
   * because it fetches every part of a mailbox down one socket.
   *
   * Optional third parameter so every existing fake/GreenMail adapter keeps compiling.
   */
  fetchPart(locator: NativeLocator, partId: string | null, opts?: { maxBytes?: number }): Promise<FetchedBytes>;
  close(): Promise<void>;
}

/** Injected factory: open a connected adapter for a mailbox. */
export type OpenAdapter = (mailboxId: string) => Promise<AttachmentAdapter>;

export interface FetchDeps { openAdapter: OpenAdapter; }

export interface FilesFilter { type?: "all" | "big"; minSizeBytes?: number; q?: string }

export interface ListFilesOptions extends FilesFilter { cursor?: string; limit?: number }

export interface DownloadAllInput {
  messageId?: string;
  fileIds?: string[];
  filter?: FilesFilter;
}

export interface DownloadAllResult { zip: Uint8Array; filename: string }

/** The default "Big Files" threshold (1 MiB) when `type=big` carries no explicit minSizeBytes. */
export const BIG_FILE_DEFAULT_BYTES = 1024 * 1024;

/**
 * CEILINGS on `download-all` (the serverless memory/connection bound).
 *
 * The archive is assembled in MEMORY: JSZip holds every fetched part AND the finished zip at
 * once, so peak usage is roughly twice the total payload. With no cap, `POST /files/download-all`
 * with no filter meant "zip my entire attachment history", which on a 1 GB serverless function
 * is an OOM kill — and an OOM kill is indistinguishable to the client from the platform
 * timeout, i.e. the worst possible error message. `partId` count is capped too, because each
 * part is a separate IMAP FETCH round trip and providers throttle.
 *
 * Exceeding either is a **413**, deliberately, rather than a silently truncated archive: an
 * archive missing files the user asked for and did not notice is worse than a refusal that
 * names the limit.
 */
export const DOWNLOAD_ALL_MAX_PARTS = 200;
export const DOWNLOAD_ALL_MAX_BYTES = 64 * 1024 * 1024;   // 64 MiB of attachment payload

/**
 * CEILING on ONE on-demand fetch (`GET /attachments/:id`).
 *
 * Without it `fetchPart` buffered whatever the server sent, under a held mailbox lock, so a single
 * oversized part could hold that mailbox's lock for the length of its transfer and take the
 * function's memory with it. That is the shape of the failure where one bad message stopped all
 * later mail for a mailbox, and the fix has to be a limit that fires DURING the read, not a check
 * afterwards on bytes already paid for.
 *
 * 32 MiB, for reasons that each stand alone:
 *
 *   · It is ~4x the largest attachment in the live corpus (7.8 MB measured), so it refuses nothing
 *     a real user currently has.
 *   · It is above what mainstream providers accept as an attachment (Gmail ~25 MB, iCloud/Yahoo
 *     ≤ 25 MB), so it does not refuse mail the user's own mailbox would hold.
 *   · It is half {@link DOWNLOAD_ALL_MAX_BYTES}, and equal to core's `DEFAULT_SYNC_BATCH_MAX_BYTES`
 *     — the same number the sync path already argues for, rather than a new invention.
 *
 * Peak memory is ~3x the payload (the chunk list, the `Buffer.concat`, and the route's
 * `ArrayBuffer` copy), which at the ceiling is ~96 MB on a 1 GB function.
 *
 * Enforced TWICE, and the second time is the one that counts: once as a pre-flight against the
 * STORED metadata size, which costs no connection at all, and once as a real byte count inside the
 * stream, because the metadata is the sender's claim and can be wrong.
 */
export const ATTACHMENT_MAX_FETCH_BYTES = 32 * 1024 * 1024;

/** The mid-stream ceiling breach an `AttachmentAdapter` rejects with (core's `AttachmentTooLargeError`). */
const TOO_LARGE_CODE = "EATTACHTOOLARGE";

/**
 * Duck-typed rather than `instanceof`, on purpose: this package must not import
 * `@trafficflow/core/adapters/imap`, which would drag imapflow into every consumer of the service
 * layer and break the seam the injected `openAdapter` exists to keep (see the class docstring).
 * The adapter is an interface with fake implementations in tests, so a nominal check would be
 * wrong here anyway — a GreenMail fake raising the same condition must map to the same 413.
 */
function isTooLarge(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === TOO_LARGE_CODE;
}

/**
 * Why a mailbox's parts are missing from an archive, in words the reader can act on.
 *
 * Exported so the wording is asserted rather than described — see
 * `attachments-download-all-busy.at2.test.ts`. `mailbox_busy` is matched by CODE, never by
 * message text: the code is the contract the API's `makeOpenAdapter` and this function share.
 */
export function downloadAllOpenFailure(err: unknown): string {
  if (err instanceof ServiceError && err.code === "mailbox_busy") {
    return "skipped — this mailbox already has as many live connections as we open at once; " +
      "try again in a moment";
  }
  return "mail server unavailable";
}

/**
 * The name a nameless part is served and listed under.
 *
 * `invite.ics` for a calendar part — the COMMON nameless shape (Google and Outlook nest the
 * invitation as an unnamed `text/calendar` alternative) — and the generic id-stem for the rest.
 * The engine's `toAttachmentItem` mirrors BOTH fallbacks deliberately, so the tile, the single
 * download and a zip entry all name one file; its comment points here.
 */
/**
 * A ZIP ENTRY NAME IS A PATH, AND THE SENDER WROTE IT.
 *
 * `filename` on a MIME part is attacker-controlled text that reaches this service verbatim (the
 * parser preserves what the sender sent, deliberately — see `packages/core/src/mime.ts`). JSZip's
 * `file()` treats `/` as a FOLDER SEPARATOR, and its documented traversal sanitisation is on
 * `loadAsync` — reading an archive — not on writing one. So a part named `../../.ssh/authorized_keys`
 * became an entry at exactly that path, and any extractor that honours relative components writes
 * outside the directory the user picked. The single-attachment download never had the same hole:
 * it leaves as a `Content-Disposition` header, where the browser keeps the basename.
 *
 * The name is therefore reduced to a BASENAME: the last component of either separator, with
 * control bytes removed, trimmed, and length-capped. `.` and `..` reduce to nothing and fall back
 * to the generated part name, because an entry called `..` is a directory reference and not a
 * file. Returning `""` for anything unusable is deliberate — the caller's `||` then reaches
 * {@link partFallbackName}, so the user still gets the bytes under a name they can open.
 *
 * DE-DUPLICATION RUNS ON THE SANITISED NAME (see {@link AttachmentsService.uniqueName}), or two
 * hostile parts that differ only in their stripped bytes would collide into one entry and one of
 * the two files would silently vanish from the archive.
 */
function zipEntryName(filename: string | null | undefined): string {
  if (!filename) return "";
  const lastComponent = filename.split(/[/\\]/).pop() ?? "";
  /* eslint-disable-next-line no-control-regex -- the point is to remove exactly these */
  const cleaned = lastComponent.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "";
  return cleaned.slice(0, 200);
}

function partFallbackName(part: { id: string; contentType: string }): string {
  return isCalendarMime(part.contentType) ? CALENDAR_FALLBACK_FILENAME : `attachment-${part.id}.bin`;
}

/** A resolved attachment carrying everything the on-demand IMAP fetch needs. */
interface ResolvedPart {
  id: string;
  filename: string | null;
  contentType: string;
  partId: string | null;
  mailboxId: string;
  locator: NativeLocator;
  /** Metadata size — used for the pre-flight ceiling check (the fetch enforces the real one). */
  sizeBytes: number;
}

function toDTO(row: typeof attachments.$inferSelect): AttachmentDTO {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    inline: row.inline,
    contentId: row.contentId,
    messageId: row.messageId,
  };
}

export class AttachmentsService {
  /** GET /messages/:id/attachments — metadata for one message (IDOR: message.accountId). */
  async listForMessage(ctx: ServiceContext, messageId: string): Promise<AttachmentDTO[]> {
    await this.assertMessage(ctx, messageId);
    const rows = await ctx.db.select().from(attachments)
      .where(and(eq(attachments.accountId, ctx.accountId), eq(attachments.messageId, messageId)))
      .orderBy(asc(attachments.id));
    return rows.map(toDTO);
  }

  /** GET /attachments/:id/meta — one attachment (404 cross-account via the messages join). */
  async getMeta(ctx: ServiceContext, attachmentId: string): Promise<AttachmentDTO> {
    const row = await this.ownedRow(ctx, attachmentId);
    return toDTO(row);
  }

  /**
   * GET /attachments/:id — fetch the BLOB bytes on-demand from IMAP. Resolves the
   * attachment + its message's mailbox/locator (account-scoped), opens the injected
   * adapter, fetches the part by `partId`, and ALWAYS closes the adapter. The bytes
   * are returned to the caller and NEVER persisted server-side.
   */
  async fetchBytes(ctx: ServiceContext, attachmentId: string, deps: FetchDeps): Promise<FetchedBytes> {
    const part = await this.resolvePart(ctx, attachmentId);

    // PRE-FLIGHT, before any socket is opened. The stored size is the sender's claim, so this is
    // not the real guard — but when it is right it refuses an oversized part for the cost of a row
    // we had already read, with no IMAP login, no lock taken on the user's mailbox and no bytes
    // pulled. A user who clicks a 90 MB file gets a sentence naming the limit, immediately.
    if (part.sizeBytes > ATTACHMENT_MAX_FETCH_BYTES) {
      throw new ServiceError(
        "payload_too_large", 413,
        `this attachment is ${Math.round(part.sizeBytes / 1048576)} MiB, over the ` +
          `${Math.round(ATTACHMENT_MAX_FETCH_BYTES / 1048576)} MiB limit for a single download`,
      );
    }

    const adapter = await deps.openAdapter(part.mailboxId);
    try {
      // THE REAL GUARD. Safe to pass here and nowhere else: this adapter serves exactly one part
      // and the `finally` below closes it, so the poisoned-connection cost of a mid-stream abort is
      // a connection we were about to discard anyway.
      const fetched = await adapter.fetchPart(part.locator, part.partId, { maxBytes: ATTACHMENT_MAX_FETCH_BYTES });
      // Prefer the DB filename (stable), then what IMAP reported; a part nameless in BOTH
      // places downloads under the type-aware fallback (invite.ics for a calendar part) rather
      // than the route's bare "attachment" — see {@link partFallbackName}.
      return { ...fetched, filename: part.filename ?? fetched.filename ?? partFallbackName(part) };
    } catch (err) {
      // TRANSLATE, or the route loses it. `routes/attachments.ts` maps `ServiceError` and turns
      // everything else into a blanket 502 `upstream_unavailable` — so an un-translated ceiling
      // breach would reach the user as "the mail server is having trouble", which is both false
      // and unactionable. It is not an upstream failure; it is us refusing, and it says so.
      if (isTooLarge(err)) {
        throw new ServiceError(
          "payload_too_large", 413,
          `this attachment is larger than the ${Math.round(ATTACHMENT_MAX_FETCH_BYTES / 1048576)} MiB ` +
            `limit for a single download`,
        );
      }
      throw err;
    } finally {
      await adapter.close();
    }
  }

  /**
   * POST /messages/:id/attachments/download-all + POST /files/download-all — resolve the
   * target set (a message's attachments, an explicit `fileIds` selection, or a filtered slice
   * of the file library), fetch each part on-demand, and assemble a zip in memory (personal
   * scale). A part that fails to fetch is SKIPPED and noted in a `_errors.txt` entry rather
   * than aborting the whole archive. Bytes are never persisted.
   *
   * ## Bounded connections
   *
   * Parts are processed GROUPED BY MAILBOX, one connection at a time: open → fetch every part
   * of that mailbox → close, then the next. The previous shape opened an adapter per distinct
   * mailbox and held them all open until the end, so a library-wide download from an account
   * with N mailboxes meant N simultaneous IMAP logins from one serverless invocation — the
   * pattern providers like iCloud and Gmail throttle first, and N sockets held for the whole
   * request. One at a time is also what capping the `download-all` fan-out requires.
   *
   * ## Bounded memory
   *
   * {@link DOWNLOAD_ALL_MAX_PARTS} / {@link DOWNLOAD_ALL_MAX_BYTES} are checked BEFORE any
   * connection is opened, from the stored metadata (413 when exceeded). The metadata can be
   * wrong, so the running total of ACTUAL bytes is enforced too: once the cap is reached the
   * remaining parts are skipped and named in `_errors.txt`, which is the one place truncation
   * is the lesser evil — the alternative is an OOM kill mid-archive with no message at all.
   */
  async downloadAll(ctx: ServiceContext, input: DownloadAllInput, deps: FetchDeps): Promise<DownloadAllResult> {
    const parts = await this.resolveTargets(ctx, input);
    if (parts.length === 0) throw new ServiceError("not_found", 404, "no attachments to download");

    if (parts.length > DOWNLOAD_ALL_MAX_PARTS) {
      throw new ServiceError(
        "payload_too_large", 413,
        `too many attachments to archive at once: ${parts.length} > ${DOWNLOAD_ALL_MAX_PARTS} — narrow the selection`,
      );
    }
    const declaredBytes = parts.reduce((n, p) => n + (p.sizeBytes || 0), 0);
    if (declaredBytes > DOWNLOAD_ALL_MAX_BYTES) {
      throw new ServiceError(
        "payload_too_large", 413,
        `archive would be ${Math.round(declaredBytes / 1048576)} MiB, over the ` +
          `${Math.round(DOWNLOAD_ALL_MAX_BYTES / 1048576)} MiB limit — narrow the selection`,
      );
    }

    const zip = new JSZip();
    const used = new Set<string>();
    const errors: string[] = [];
    let fetchedBytes = 0;

    // Stable grouping: preserve the resolved (id-ordered) sequence within each mailbox, and
    // visit mailboxes in first-appearance order, so the archive's contents are deterministic.
    const byMailbox = new Map<string, ResolvedPart[]>();
    for (const p of parts) {
      const list = byMailbox.get(p.mailboxId);
      if (list) list.push(p);
      else byMailbox.set(p.mailboxId, [p]);
    }

    for (const [mailboxId, group] of byMailbox) {
      let adapter: AttachmentAdapter;
      try {
        adapter = await deps.openAdapter(mailboxId);
      } catch (err) {
        // A mailbox we cannot connect to costs its parts, not the archive — but the SENTENCE has
        // to be true, because it is the only thing the user is left holding. The connection cap
        // refuses with `mailbox_busy`, and that is not the mail server being unavailable: it is us
        // declining to open another connection, it says nothing about their provider, and it is
        // fixed by waiting rather than by anything they could do about a server. A reason a user
        // cannot act on is the same defect as no reason at all.
        for (const part of group) {
          errors.push(`${this.uniqueName(part, used)}: ${downloadAllOpenFailure(err)}`);
        }
        continue;
      }
      try {
        for (const part of group) {
          const name = this.uniqueName(part, used);
          if (fetchedBytes >= DOWNLOAD_ALL_MAX_BYTES) {
            errors.push(`${name}: skipped — the archive reached its ${Math.round(DOWNLOAD_ALL_MAX_BYTES / 1048576)} MiB limit`);
            continue;
          }
          try {
            const fetched = await adapter.fetchPart(part.locator, part.partId);
            fetchedBytes += fetched.body.byteLength;
            zip.file(name, fetched.body);
          } catch {
            errors.push(`${name}: could not be fetched from the mail server`);
          }
        }
      } finally {
        try { await adapter.close(); } catch { /* best-effort */ }
      }
    }

    if (errors.length > 0) zip.file("_errors.txt", errors.join("\n"));
    const body = await zip.generateAsync({ type: "uint8array" });
    const filename = input.messageId ? `attachments-${input.messageId}.zip` : "attachments.zip";
    return { zip: body, filename };
  }

  /**
   * GET /files — the attachment library (All Files / Big Files). Account-scoped,
   * joined to the message header (subject/from/date). Only real files (non-inline)
   * are listed; `type=big` (or an explicit `minSizeBytes`) applies a size floor.
   */
  async listFiles(ctx: ServiceContext, opts: ListFilesOptions = {}): Promise<Page<FileDTO>> {
    const limit = clampLimit(opts.limit);
    const minSize = opts.minSizeBytes ?? (opts.type === "big" ? BIG_FILE_DEFAULT_BYTES : undefined);

    const filters = [eq(attachments.accountId, ctx.accountId), eq(attachments.inline, false)];
    if (minSize != null) filters.push(gte(attachments.sizeBytes, minSize));
    if (opts.cursor) filters.push(gt(attachments.id, decodeListCursor(opts.cursor)));

    const rows = await ctx.db.select({
      a: attachments,
      subject: messages.subject,
      fromAddress: messages.fromAddress,
      date: messages.date,
    }).from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(and(...filters))
      .orderBy(asc(attachments.id))
      .limit(limit + 1);

    const pageRows = rows.slice(0, limit);
    const items: FileDTO[] = pageRows.map((r) => ({
      ...toDTO(r.a),
      message: {
        subject: r.subject,
        from: { name: null, address: r.fromAddress },
        date: r.date ? r.date.toISOString() : null,
      },
    }));
    const nextCursor = rows.length > limit ? encodeListCursor(pageRows[pageRows.length - 1]!.a.id) : null;
    return { items, nextCursor };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Resolve the download-all target set into fetch-ready parts (account-scoped). */
  private async resolveTargets(ctx: ServiceContext, input: DownloadAllInput): Promise<ResolvedPart[]> {
    if (input.messageId) {
      await this.assertMessage(ctx, input.messageId);
      return this.partsWhere(ctx, and(
        eq(attachments.accountId, ctx.accountId),
        eq(attachments.messageId, input.messageId),
        eq(attachments.inline, false),
      ));
    }
    if (input.fileIds && input.fileIds.length > 0) {
      return this.partsWhere(ctx, and(
        eq(attachments.accountId, ctx.accountId),
        inArray(attachments.id, input.fileIds),
      ));
    }
    // A filtered slice of the library (All Files / Big Files).
    const minSize = input.filter?.minSizeBytes ?? (input.filter?.type === "big" ? BIG_FILE_DEFAULT_BYTES : undefined);
    const filters = [eq(attachments.accountId, ctx.accountId), eq(attachments.inline, false)];
    if (minSize != null) filters.push(gte(attachments.sizeBytes, minSize));
    return this.partsWhere(ctx, and(...filters));
  }

  private async partsWhere(ctx: ServiceContext, where: ReturnType<typeof and>): Promise<ResolvedPart[]> {
    const rows = await ctx.db.select({
      id: attachments.id,
      filename: attachments.filename,
      contentType: attachments.contentType,
      partId: attachments.partId,
      sizeBytes: attachments.sizeBytes,
      mailboxId: messages.mailboxId,
      nativeLocator: messages.nativeLocator,
    }).from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(where)
      .orderBy(asc(attachments.id));
    const out: ResolvedPart[] = [];
    for (const r of rows) {
      const locator = r.nativeLocator as NativeLocator | null;
      if (!locator) continue;   // a message with no native locator cannot be fetched
      out.push({ id: r.id, filename: r.filename, contentType: r.contentType, partId: r.partId, mailboxId: r.mailboxId, locator, sizeBytes: r.sizeBytes });
    }
    return out;
  }

  /** Resolve one attachment + its message's mailbox/locator, account-scoped or 404. */
  private async resolvePart(ctx: ServiceContext, attachmentId: string): Promise<ResolvedPart> {
    const [r] = await ctx.db.select({
      id: attachments.id,
      filename: attachments.filename,
      contentType: attachments.contentType,
      partId: attachments.partId,
      sizeBytes: attachments.sizeBytes,
      mailboxId: messages.mailboxId,
      nativeLocator: messages.nativeLocator,
    }).from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(and(eq(attachments.id, attachmentId), eq(attachments.accountId, ctx.accountId)))
      .limit(1);
    if (!r) throw new ServiceError("not_found", 404, "attachment not found");
    const locator = r.nativeLocator as NativeLocator | null;
    if (!locator) throw new ServiceError("upstream_unavailable", 502, "message location unknown");
    return { id: r.id, filename: r.filename, contentType: r.contentType, partId: r.partId, mailboxId: r.mailboxId, locator, sizeBytes: r.sizeBytes };
  }

  private async ownedRow(ctx: ServiceContext, attachmentId: string): Promise<typeof attachments.$inferSelect> {
    const [r] = await ctx.db.select({ a: attachments }).from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(and(eq(attachments.id, attachmentId), eq(messages.accountId, ctx.accountId)))
      .limit(1);
    if (!r) throw new ServiceError("not_found", 404, "attachment not found");
    return r.a;
  }

  private async assertMessage(ctx: ServiceContext, messageId: string): Promise<void> {
    const [row] = await ctx.db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.accountId, ctx.accountId))).limit(1);
    if (!row) throw new ServiceError("not_found", 404, "message not found");
  }

  /** De-duplicate zip entry names (Apple-Mail behavior on same-named parts). */
  private uniqueName(part: ResolvedPart, used: Set<string>): string {
    const base = zipEntryName(part.filename) || partFallbackName(part);
    if (!used.has(base)) { used.add(base); return base; }
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    let i = 2;
    let candidate = `${stem} (${i})${ext}`;
    while (used.has(candidate)) { i += 1; candidate = `${stem} (${i})${ext}`; }
    used.add(candidate);
    return candidate;
  }
}

export const attachmentsService = new AttachmentsService();
