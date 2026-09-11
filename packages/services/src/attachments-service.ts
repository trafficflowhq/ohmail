import JSZip from "jszip";
import { and, asc, eq, gt, gte, inArray } from "drizzle-orm";
import { attachments, messages } from "@trafficflow/db";
import {
  CALENDAR_FALLBACK_FILENAME, isCalendarMime, isMessageGone,
  type NativeLocator, type EmailAddress,
} from "@trafficflow/core/mail";
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
   * `AttachmentTooLargeError`. Doing so POISONS THE CONNECTION — the parser is left mid-literal —
   * so a caller must treat the breach as TERMINAL for that socket. Both callers do: {@link
   * AttachmentsService.fetchBytes} owns its adapter for one fetch and closes it in a `finally`;
   * `downloadAll` shares one socket per mailbox group, so it abandons the REST OF THAT GROUP and
   * names each skipped part in `_errors.txt`. The poisoning is real for `fetchPart` (it `throw`s
   * out of its own `for await`), unlike `fetchRaw` — see both docstrings in `imap.ts`. Optional
   * third parameter so every existing fake/GreenMail adapter keeps compiling.
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
 * `minSizeBytes` as a value a `bigint` column can take, or a 400. It is declared `number` in
 * `FilesFilter` and arrives from `JSON.parse`, so the type says nothing at runtime: a string
 * reached the `gte` predicate and `1e30` reached an `integer` column — both 22P02/22003 from
 * Postgres, a 500 for a plainly bad request (the `clampLimit` shape). Bounded above by the
 * largest attachment this product will ever move rather than by the column:
 * `DOWNLOAD_ALL_MAX_BYTES` (64 MiB) is well inside `int4`, so a floor above it selects nothing
 * and asking for it is a mistake worth naming.
 */
function validMinSize(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > DOWNLOAD_ALL_MAX_BYTES) {
    throw new ServiceError(
      "validation_failed", 400,
      `minSizeBytes must be an integer between 0 and ${DOWNLOAD_ALL_MAX_BYTES}`,
    );
  }
  return v;
}

/**
 * Ceilings on `download-all` (the serverless memory/connection bound). The archive is assembled
 * in MEMORY — JSZip holds every fetched part AND the finished zip, so peak usage is roughly twice
 * the payload; uncapped, `POST /files/download-all` with no filter meant "zip my entire
 * attachment history", an OOM kill indistinguishable from the platform timeout. The part count is
 * capped too: each part is a separate IMAP FETCH and providers throttle. Exceeding either is a
 * 413, deliberately, rather than a silently truncated archive: an archive missing files the user
 * asked for and did not notice is worse than a refusal that names the limit.
 */
export const DOWNLOAD_ALL_MAX_PARTS = 200;
export const DOWNLOAD_ALL_MAX_BYTES = 64 * 1024 * 1024;   // 64 MiB of attachment payload

/**
 * Ceiling on ONE on-demand fetch (`GET /attachments/:id`). Without it `fetchPart` buffered
 * whatever the server sent under a held mailbox lock, so one oversized part could stall all later
 * mail for that mailbox — the fix must fire DURING the read. 32 MiB: ~4x the largest attachment
 * in the live corpus (7.8 MB measured); above what mainstream providers accept (~25 MB); half
 * {@link DOWNLOAD_ALL_MAX_BYTES} and equal to core's `DEFAULT_SYNC_BATCH_MAX_BYTES`. Peak memory
 * is ~3x the payload. Enforced TWICE, and the second is the one that counts: a pre-flight against
 * STORED metadata (costs no connection), then a real byte count inside the stream — the metadata
 * is the sender's claim and can be wrong.
 */
export const ATTACHMENT_MAX_FETCH_BYTES = 32 * 1024 * 1024;

/**
 * An attachment id's shape, checked before it reaches a `uuid` column.
 *
 * A malformed id would otherwise be handed to Postgres and raise 22P02 — a 500 for a plainly
 * bad request. Decidable without the database, so it leaks nothing: the same guard, and the same
 * argument, as `MessageService.getBodies` applies to its `ids`.
 */
const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// `isMessageGone` used to be a second copy of this predicate, spelled out here with its own
// literal `"EMSGGONE"`. It now comes from `core/gone.ts`, which is the one leaf both this file and
// the error class are built from — see {@link isTooLarge} for why it is duck-typed at all, and
// that module's header for the three readings of a gone locator and which seam may take which.

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
 * A zip entry name is a PATH, and the sender wrote it. `filename` on a MIME part is
 * attacker-controlled text reaching this service verbatim; JSZip's `file()` treats `/` as a
 * folder separator and sanitises only on `loadAsync`, so a part named
 * `../../.ssh/authorized_keys` became an entry at exactly that path. (The single-attachment
 * download leaves as `Content-Disposition`; the browser keeps the basename.) The name is reduced
 * to a BASENAME: control bytes removed, trimmed, length-capped; `.` and `..` reduce to nothing
 * and fall back to {@link partFallbackName}. De-duplication runs on the SANITISED name, or two
 * hostile parts differing only in stripped bytes would collide and one file would vanish.
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
      // The same argument one condition over. The message is not at that locator any more —
      // expunged, moved from another client, or its folder recreated under a new UIDVALIDITY, in
      // which case the adapter refuses rather than downloading part n of whatever now wears the
      // UID. Untranslated, the route's blanket 502 says "the mail server is having trouble",
      // which is false and leaves the reader nothing to do; this says what happened and what
      // fixes it, and the fix is real — the next sync re-resolves the locator by Message-ID.
      if (isMessageGone(err)) {
        throw new ServiceError(
          "not_found", 404,
          "this attachment is no longer where the mailbox said it was — the message has moved or " +
            "been deleted. Refresh and try again.",
        );
      }
      throw err;
    } finally {
      await adapter.close();
    }
  }

  /**
   * download-all — resolve the target set (a message's attachments, a `fileIds` selection, or a
   * filtered library slice), fetch each part on demand, assemble a zip in memory; a failing part
   * is SKIPPED and named in `_errors.txt`; bytes are never persisted. Parts are grouped BY
   * MAILBOX, one connection at a time — N simultaneous IMAP logins is what providers throttle
   * first. {@link DOWNLOAD_ALL_MAX_PARTS}/{@link DOWNLOAD_ALL_MAX_BYTES} are checked BEFORE any
   * connection, from stored metadata (413), and the running total of ACTUAL bytes is enforced
   * too. The part-count check below is a BACKSTOP. The metadata is the sender's claim, so each
   * per-part read carries the archive's remaining budget as its ceiling.
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
        // `poisoned` is what makes the per-part ceiling usable down a SHARED socket — see the
        // block comment on the fetch below.
        let poisoned = false;
        for (const part of group) {
          const name = this.uniqueName(part, used);
          if (fetchedBytes >= DOWNLOAD_ALL_MAX_BYTES) {
            errors.push(`${name}: skipped — the archive reached its ${Math.round(DOWNLOAD_ALL_MAX_BYTES / 1048576)} MiB limit`);
            continue;
          }
          if (poisoned) {
            errors.push(`${name}: skipped — an earlier part on this mailbox overran its size and the connection was dropped`);
            continue;
          }
          try {
            /**
             * The budget is enforced DURING the read, not after it. The two guards around this
             * are checks on the sender's CLAIM, so one part declaring 1 KiB and streaming 4 GiB
             * was buffered whole. The ceiling is the archive's REMAINING budget. Passing
             * `maxBytes` poisons the connection (`imap.ts#fetchPart` throws out of its own `for
             * await`), so the breach is TERMINAL for this mailbox's group: every remaining part
             * is named in `_errors.txt` and the socket is closed by the `finally` below. Aborting
             * the group rather than reconnecting is deliberate — a reconnect per breach is a loop
             * whose length the hostile server chooses.
             */
            const fetched = await adapter.fetchPart(part.locator, part.partId, {
              maxBytes: DOWNLOAD_ALL_MAX_BYTES - fetchedBytes,
            });
            fetchedBytes += fetched.body.byteLength;
            zip.file(name, fetched.body);
          } catch (err) {
            if (isTooLarge(err)) {
              poisoned = true;
              errors.push(
                `${name}: skipped — the mail server sent more than this archive had room for ` +
                  `(the whole archive may hold ${Math.round(DOWNLOAD_ALL_MAX_BYTES / 1048576)} MiB)`,
              );
            } else if (isMessageGone(err)) {
              // Not a mail-server fault, and the generic line below once said it was: the message
              // is not at the locator the mirror holds, and blaming the server sent people to
              // check a server that is fine. It says "no longer there", not "moved": the refusal
              // establishes only that the locator no longer resolves — a permanently deleted
              // message produces the same refusal, and for that one no refresh will ever work, so
              // promising recovery was an over-claim. The refresh is offered as the thing to try,
              // not as the fix.
              errors.push(
                `${name}: skipped — this message is no longer where the mailbox recorded it. ` +
                  `It may have moved, in which case refreshing and downloading again will work, ` +
                  `or it may have been deleted`,
              );
            } else {
              errors.push(`${name}: could not be fetched from the mail server`);
            }
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
    const minSize = validMinSize(opts.minSizeBytes)
      ?? (opts.type === "big" ? BIG_FILE_DEFAULT_BYTES : undefined);

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

  /**
   * Resolve the download-all target set into fetch-ready parts (account-scoped). The ceiling is
   * applied to the READ, not its result — checking {@link DOWNLOAD_ALL_MAX_PARTS} on the built
   * array was one statement too late in both branches: the `fileIds` branch put the caller's
   * array straight into a SQL `IN` (100 000 ids = 100 000 bind parameters against a 65 535
   * protocol limit), so `fileIds` is now bounded and SHAPE-CHECKED before the predicate is built;
   * the FILTER branch (`{"filter":{}}`) materialized the account's ENTIRE attachment history and
   * only then answered 413 — the read now stops at the ceiling PLUS ONE, exactly enough to know
   * it was crossed. The `messageId` branch shares the same ceiling.
   */
  private async resolveTargets(ctx: ServiceContext, input: DownloadAllInput): Promise<ResolvedPart[]> {
    if (input.messageId) {
      await this.assertMessage(ctx, input.messageId);
      return this.partsWhere(ctx, and(
        eq(attachments.accountId, ctx.accountId),
        eq(attachments.messageId, input.messageId),
        eq(attachments.inline, false),
      ));
    }
    if (input.fileIds !== undefined && input.fileIds !== null) {
      if (!Array.isArray(input.fileIds)) {
        throw new ServiceError("validation_failed", 400, "fileIds must be an array of file ids");
      }
      if (input.fileIds.length > DOWNLOAD_ALL_MAX_PARTS) {
        // 413 with the number, before the query — the same refusal `downloadAll` gives for a
        // resolved set that is too large, moved to where it costs nothing.
        throw new ServiceError(
          "payload_too_large", 413,
          `too many attachments to archive at once: ${input.fileIds.length} > ` +
            `${DOWNLOAD_ALL_MAX_PARTS} — narrow the selection`,
        );
      }
      for (const id of input.fileIds) {
        if (typeof id !== "string" || !ATTACHMENT_ID_RE.test(id)) {
          throw new ServiceError("validation_failed", 400, "invalid attachment id");
        }
      }
      /**
       * A present `fileIds` is the SELECTION MODE, even when empty. `[]` used to fall through to
       * the library branch, so `{"fileIds": []}` — a client asking to archive nothing —
       * downloaded the account's ENTIRE non-inline attachment history, or answered 413 about a
       * limit the request had not gone near. A selection of zero became "everything", the same
       * shape as the `NaN` limit that named this class: a value the guard could not read, read as
       * "no ceiling". `GET /messages/bodies` made this exact ruling one route over: a
       * present-but-empty ids parameter is still the ids mode — an empty answer, never a silent
       * fall-through.
       */
      return input.fileIds.length === 0
        ? []
        : this.partsWhere(ctx, and(
          eq(attachments.accountId, ctx.accountId),
          inArray(attachments.id, input.fileIds),
        ));
    }
    // A filtered slice of the library (All Files / Big Files).
    const minSize = validMinSize(input.filter?.minSizeBytes)
      ?? (input.filter?.type === "big" ? BIG_FILE_DEFAULT_BYTES : undefined);
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
      .orderBy(asc(attachments.id))
      // PLUS ONE, so the ceiling can be DETECTED without being exceeded. Without it the
      // unfiltered library branch read every attachment row the account owns purely in order to
      // refuse the request.
      .limit(DOWNLOAD_ALL_MAX_PARTS + 1);

    // Refused HERE, on the ROW count, and that is the load-bearing detail. The loop below drops
    // rows with no native locator, so a selection of `MAX + 1` rows could resolve to `MAX` parts
    // and slip past a check made afterwards — a SILENTLY TRUNCATED archive, which is exactly
    // what `DOWNLOAD_ALL_MAX_PARTS`' own docstring refuses ("an archive missing files the user
    // asked for and did not notice is worse than a refusal that names the limit"). The count is
    // not named because the read deliberately stopped one past the limit rather than counting
    // the whole selection; the limit is named, which is the actionable half.
    if (rows.length > DOWNLOAD_ALL_MAX_PARTS) {
      throw new ServiceError(
        "payload_too_large", 413,
        `too many attachments to archive at once: more than ${DOWNLOAD_ALL_MAX_PARTS} — narrow the selection`,
      );
    }

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
