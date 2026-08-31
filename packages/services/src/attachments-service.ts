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
   * parser is left mid-literal — so a caller that passes it must treat the breach as TERMINAL for
   * that socket.
   *
   * Both callers do, in the two ways that are available to them. {@link
   * AttachmentsService.fetchBytes} owns its adapter for one fetch and closes it in a `finally`.
   * `downloadAll` shares one socket across a mailbox's whole group, so it abandons the REST OF
   * THAT GROUP on a breach and names each skipped part in the archive's `_errors.txt` — this
   * used to say `downloadAll` must not pass it at all, which left the one caller that reads a
   * hostile server's bytes as the one caller with no ceiling on how many of them it buffers.
   *
   * ── THE POISONING IS REAL, AND THE ADAPTER SAYS SO IN ITS OWN WORDS ──────────────────────
   *
   * A review round argued the opposite — that imapflow fetches complete partial ranges, so an
   * abort lands on a chunk boundary and the connection stays usable, making the group-abandon
   * unnecessarily lossy. That is true of `fetchRaw` and NOT of `fetchPart`, and the difference is
   * written down at both: `fetchPart` (`imap.ts`) counts bytes and `throw`s out of its own
   * `for await (const chunk of dl.content)`, abandoning the stream wherever it happens to be;
   * `fetchRaw`'s docstring next to it states the consequence — *"`fetchPart` throws out of its
   * own `for await`, which destroys the stream while the driver may be halfway through reading a
   * FETCH literal — the connection is dead afterwards"* — and hands `maxBytes` to `download`
   * instead precisely to avoid it, because ITS caller holds a long-lived per-mailbox connection.
   *
   * Giving `fetchPart` the same driver-level ceiling would make the breach non-terminal and let
   * `downloadAll` continue with the group's remaining parts. That is a real improvement and it is
   * a change to `fetchBytes`' proven behaviour, so it is parked rather than folded in here.
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
 * `minSizeBytes` as a value a `bigint` column can take, or a 400.
 *
 * It is declared `number` in `FilesFilter` and arrives from `JSON.parse`, so the type says
 * nothing at runtime: `{"filter":{"minSizeBytes":"x"}}` reached the `gte` predicate as a string
 * and `1e30` reached it as a value `attachments.size_bytes` — an `integer` column — cannot take.
 * Both are 22P02/22003 from Postgres, surfacing as a 500 for a plainly bad request. That is the
 * `clampLimit` shape exactly: a caller-chosen number reaching a query with the guard assuming it
 * had been checked.
 *
 * Bounded above by the largest attachment this product will ever move rather than by the column:
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

/** `MessageGoneError`'s code — duck-typed for the reason {@link isTooLarge} states. */
const MESSAGE_GONE_CODE = "EMSGGONE";

function isMessageGone(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === MESSAGE_GONE_CODE;
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
   *
   * The part-count check below is now a BACKSTOP rather than the enforcement: `resolveTargets`
   * bounds the caller's `fileIds` before they reach a SQL `IN`, and `partsWhere` bounds the READ
   * itself at the ceiling plus one, so no current branch can hand this function an oversized
   * array. It is kept because a fourth resolution branch that did not go through `partsWhere`
   * would otherwise arrive here unbounded.
   *
   * And the METADATA IS THE SENDER'S CLAIM, so the per-part read carries the archive's remaining
   * byte budget as its own mid-stream ceiling — see the block comment at the fetch. Without it,
   * one part that declares 1 KiB and streams 4 GiB was buffered whole, because the running total
   * is only consulted between parts.
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
             * ── THE BUDGET IS ENFORCED DURING THE READ, NOT AFTER IT ──────────────────────
             *
             * This was `fetchPart(locator, partId)` with no ceiling at all, and the two guards
             * around it are both checks on the sender's CLAIM: `DOWNLOAD_ALL_MAX_BYTES` above
             * is compared against bytes already fetched, and the pre-flight in `downloadAll`
             * sums `sizeBytes` from the stored metadata. The metadata is what the sending
             * server said the part weighs. A hostile or broken mailbox that declares 1 KiB and
             * streams 4 GiB was buffered in full — the running total is only consulted between
             * parts, so ONE part is unbounded however small it claims to be.
             *
             * The ceiling is the archive's REMAINING budget, so the transfer is abandoned at
             * the first byte that could not have fitted anyway.
             *
             * ── WHY THIS IS SAFE HERE, WHEN THE ADAPTER'S OWN DOCSTRING SAYS IT IS NOT ────
             *
             * Passing `maxBytes` POISONS THE CONNECTION — `imap.ts#fetchPart` throws out of its
             * own `for await` over the download stream, abandoning the driver mid-literal, and
             * `fetchRaw`'s docstring beside it states the consequence in the adapter's own words:
             * *"the connection is dead afterwards"*. The interface used to forbid `downloadAll`
             * from passing it at all for that reason; it now describes the obligation instead,
             * because the breach being TERMINAL is a thing a caller can honour and an unbounded
             * read is not. That is what `poisoned` is for, rather than a reason to leave the read
             * unbounded: the
             * breach is TERMINAL for this mailbox's group. Every remaining part of that group
             * is named in `_errors.txt` and the socket is closed by the `finally` below, so no
             * further read is attempted through a parser that is mid-literal. Other mailboxes'
             * groups are untouched — they get their own connection.
             *
             * Aborting the group rather than reconnecting is deliberate: a reconnect per breach
             * is a loop whose length the hostile server chooses, which is the same defect one
             * layer up. And an honest mailbox never reaches this line, because the declared-size
             * pre-flight has already refused it with a 413 that names the limit.
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
   * Resolve the download-all target set into fetch-ready parts (account-scoped).
   *
   * ── THE CEILING IS APPLIED TO THE READ, NOT TO ITS RESULT ────────────────────────────────
   *
   * {@link DOWNLOAD_ALL_MAX_PARTS} used to be checked in `downloadAll`, on the array this
   * function had already built — which is one statement too late in both of its branches:
   *
   *  · the `fileIds` branch put the caller's array STRAIGHT into a SQL `IN`, so a request
   *    naming 100 000 file ids sent 100 000 bind parameters at a driver whose protocol limit is
   *    65 535, and the 200-part ceiling that was supposed to refuse it was evaluated on rows
   *    that could never come back. `fileIds` is now bounded and SHAPE-CHECKED here, before the
   *    predicate is built: a non-uuid would otherwise reach Postgres as 22P02, a 500 for a
   *    plainly bad request — the guard `MessageService.getBodies` already applies to its ids.
   *  · the FILTER branch names no ids at all, so `POST /files/download-all` with
   *    `{"filter":{}}` selected the account's ENTIRE attachment history, materialized every row
   *    in the process, and only then counted them and answered 413. The refusal was correct and
   *    the work behind it was unbounded. The read now stops at the ceiling PLUS ONE, which is
   *    exactly enough to know the ceiling was crossed and nothing more.
   *
   * The `messageId` branch needs no bound of its own beyond the same limit: one message's
   * attachment count is bounded by what a sender could put in one MIME tree, and it now shares
   * the same ceiling rather than resting on that argument.
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
       * A PRESENT `fileIds` IS THE SELECTION MODE, EVEN WHEN IT IS EMPTY.
       *
       * `[]` used to fall through to the library branch below, so `{"fileIds": []}` — a client
       * asking to archive nothing — downloaded the account's ENTIRE non-inline attachment
       * history, or answered 413 about a limit the request had not gone near. A caller-chosen
       * selection of zero became "everything", which is the same shape as the `NaN` limit that
       * named this class: a value the guard could not read, read as "no ceiling".
       *
       * `GET /messages/bodies` already made this exact ruling one route over, and its words
       * apply verbatim: *"A present-but-empty `ids=` is still the ids MODE (an empty answer),
       * never a silent fall-through to the keyset page, which would send a client asking for
       * nothing the account's first fifty bodies."*
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
