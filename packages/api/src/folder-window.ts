import { and, eq, ne } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import {
  FOLDER_PAGE_MAX, epochOf, sameEpoch, type FolderPage, type FolderPageItem,
} from "@trafficflow/core/adapters/imap";
import {
  ServiceError, foldersEnabled, isUuid, requireUuid, IMAP_UINT32_MAX,
} from "@trafficflow/services/mail";
import type { ApiDeps } from "./deps.js";

/**
 * ONE RULE FOR THE LIVE WINDOWS — Junk (§16.2) and Trash read the provider's own folder the same
 * way, so the cursor codec, the epoch shape, the folders gate and the account-scoped mailbox read
 * live here rather than once per window. Each window keeps its own noun and its own folder column
 * and nothing else; a second copy is how two windows come to disagree about what a cursor is.
 * A shared test reads every rule below through both doors.
 */

/** One mailbox's cursor entry: the UIDVALIDITY the watermark belongs to, and the seq below. */
export interface CursorEntry { v: string; s: number }

/**
 * How large a window cursor may be on the wire. The cursor is a caller-supplied base64 JSON
 * object, one entry per mailbox, bounded by nothing until this. One ceiling, consulted before the
 * decode, so an arbitrarily long cursor costs a `.length`; it bounds the entry count too, since an
 * entry cannot weigh less than its uuid key. Deliberately no entry-count ceiling: the cursor's
 * size is the account's mailbox count and the self-host imposes no mailbox limit, so any entry
 * ceiling rejects a cursor this function itself minted at some account size.
 */
export const WINDOW_CURSOR_MAX_CHARS = 128 * 1024;

/**
 * The opaque cursor: base64url JSON of {mailboxId → {v, s}}. Malformed input is a 400 naming the
 * window, because that sentence is what a caller sees. The KEY is a mailbox id and the epoch is an
 * IMAP UIDVALIDITY — both were untyped here, and both are compared downstream against values from
 * the user's own mail server.
 */
export function parseWindowCursor(
  raw: string | undefined, noun: string, maxChars: number = WINDOW_CURSOR_MAX_CHARS,
): Record<string, CursorEntry> {
  if (!raw) return {};
  if (raw.length > maxChars) {
    throw new ServiceError("validation_failed", 400, `cursor is not a ${noun} cursor`);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    const out: Record<string, CursorEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!isUuid(k)) throw new Error("shape");
      const e = v as { v?: unknown; s?: unknown };
      if (typeof e?.v !== "string" || !/^[1-9][0-9]{0,9}$/.test(e.v) || Number(e.v) > IMAP_UINT32_MAX) {
        throw new Error("shape");
      }
      if (typeof e?.s !== "number" || !Number.isInteger(e.s) || e.s <= 0) throw new Error("shape");
      out[k] = { v: e.v, s: e.s };
    }
    return out;
  } catch {
    throw new ServiceError("validation_failed", 400, `cursor is not a ${noun} cursor`);
  }
}

/** The cursor back on the wire; `null` when no mailbox has anything older to offer. */
export function mintWindowCursor(map: Record<string, CursorEntry>): string | null {
  return Object.keys(map).length === 0
    ? null
    : Buffer.from(JSON.stringify(map), "utf8").toString("base64url");
}

/** The foundation gate every window route shares: the view exists only behind "Use folders". */
export async function requireWindowFolders(
  deps: ApiDeps, accountId: string, label: string,
): Promise<void> {
  if (!accountId || !(await foldersEnabled(deps.db, accountId))) {
    throw new ServiceError(
      "folders_disabled", 409,
      `${label} is part of the folders feature — turn on “Use folders” first`,
    );
  }
}

/**
 * A Message-ID as a comparable key: trimmed, angle brackets off. The live envelope carries
 * `<id@host>`; the mirror stores the id the parser kept, which is bare — so without this
 * normalisation the two sides of the attribution join never meet.
 */
export const midKey = (raw: string): string => raw.trim().replace(/^<|>$/g, "");

/**
 * AND THE EPOCH IS BOUNDED, because the protocol bounds it. `^[1-9][0-9]*$` accepted a decimal
 * string of ANY length; RFC 3501 §2.3.1.1 makes UIDVALIDITY an unsigned 32-bit integer, so a
 * five-hundred-digit "epoch" is not one — and it survived to be compared against the answer of
 * somebody else's mail server. The digit ceiling is checked before the range so an absurd string
 * costs a `.length` rather than a `Number()`.
 */
export function requireRealEpoch(uidValidity: string): void {
  if (!/^[1-9][0-9]*$/.test(uidValidity) || uidValidity.length > 10
    || Number(uidValidity) > IMAP_UINT32_MAX) {
    throw new ServiceError(
      "validation_failed", 400,
      `uidValidity must be the row's epoch — an integer between 1 and ${IMAP_UINT32_MAX}`,
    );
  }
}

/** One mailbox as a window reads it: who it is, and where this window's folder sits on it. */
export interface WindowMailbox { id: string; address: string; folder: string | null }

/**
 * The two columns a live window may read. Named as a union rather than widened to any column:
 * these are the only folders the provider owns and ohmail never mirrors, and a third one would
 * be a decision somebody makes here rather than a type that already admitted it.
 */
export type WindowFolderColumn = typeof mailboxes.junkFolder | typeof mailboxes.trashFolder;

/**
 * The account's mailboxes with their resolved window folder — ownership by scoping, never by
 * trust. `disabled` is excluded because it is the stood-down state: that mailbox's organizer is
 * elsewhere (the lease principle), even while its credential rows remain stored for a later
 * takeover. `error` stays in — a transiently erroring mailbox is still Cloud's to read, and the
 * read itself states `unreachable` honestly when the dial fails. SHAPE before the predicate:
 * `mailboxes.id` is a uuid column and `?mailboxId=` is caller-chosen, so a malformed one reached
 * Postgres as 22P02 — a 500 for a bad query string. Here rather than in the routes, so every
 * present and future caller gets it.
 */
export async function windowMailboxesOf(
  deps: ApiDeps,
  accountId: string,
  folderColumn: WindowFolderColumn,
  mailboxId?: string,
): Promise<WindowMailbox[]> {
  if (mailboxId !== undefined) requireUuid(mailboxId, "mailboxId");
  const scoped = and(eq(mailboxes.accountId, accountId), ne(mailboxes.status, "disabled"));
  const rows = await deps.db
    .select({ id: mailboxes.id, address: mailboxes.address, folder: folderColumn })
    .from(mailboxes)
    .where(mailboxId === undefined ? scoped : and(scoped, eq(mailboxes.id, mailboxId)));
  if (mailboxId !== undefined && rows.length === 0) {
    throw new ServiceError("not_found", 404, "mailbox not found");
  }
  return rows;
}

/** One mailbox's answer to this page's read, with the mailbox it came from. */
export interface WindowLanePage { boxId: string; page: FolderPage }

/** One row the merge took, carrying the lane it belongs to. */
export interface TakenWindowRow { boxId: string; uidValidity: string; row: FolderPageItem }

/**
 * THE K-WAY MERGE AND THE PER-MAILBOX CURSORS — newest date first, at most
 * {@link FOLDER_PAGE_MAX} rows whatever the mailbox count, with a PER-MAILBOX SEQ-PREFIX
 * invariant: a row is only ever taken after every newer-seq row of its own mailbox, so the cursor
 * (the lowest TAKEN seq) can never skip a row the cap cut. A lane with rows left resumes below
 * what was taken; an untouched lane keeps its incoming watermark verbatim.
 *
 * WHILE ANY LANE PAGINATES, EVERY READ LANE KEEPS AN EPOCH ENTRY — a DRAINED mailbox included.
 * Without one the next "Show older" re-reads that mailbox cursorless: a folder recreated in the
 * meantime would serve its new-epoch top page with NO reset stated, and the client, which trusts
 * the stated flag, would append fresh mail under stale rows. What matters is the `v`.
 */
export function mergeWindowLanes(
  pages: WindowLanePage[], before: Record<string, CursorEntry>,
): { taken: TakenWindowRow[]; nextBefore: Record<string, CursorEntry> } {
  const nextBefore: Record<string, CursorEntry> = {};
  const lanes = pages.map(({ boxId, page }) => ({
    boxId,
    uidValidity: page.uidValidity,
    rows: page.items, // already newest-first by seq
    at: 0,
    tookAny: false,
    lowestTakenSeq: 0,
    adapterNext: page.nextBeforeSeq,
  }));
  const taken: Array<{ lane: (typeof lanes)[number]; row: FolderPageItem }> = [];
  const dateOf = (r: FolderPageItem): number => (r.date !== null ? Date.parse(r.date) || 0 : 0);
  while (taken.length < FOLDER_PAGE_MAX) {
    let best: (typeof lanes)[number] | null = null;
    for (const lane of lanes) {
      if (lane.at >= lane.rows.length) continue;
      if (best === null || dateOf(lane.rows[lane.at]!) > dateOf(best.rows[best.at]!)) best = lane;
    }
    if (best === null) break;
    const row = best.rows[best.at]!;
    best.at += 1;
    best.tookAny = true;
    best.lowestTakenSeq = row.seq;
    taken.push({ lane: best, row });
  }

  for (const lane of lanes) {
    const leftover = lane.at < lane.rows.length;
    if (lane.tookAny) {
      if (leftover || lane.adapterNext !== null) {
        nextBefore[lane.boxId] = { v: lane.uidValidity, s: lane.lowestTakenSeq };
      }
    } else if (lane.rows.length > 0) {
      // Nothing of this mailbox fit the page: resume exactly where this request began.
      const held = before[lane.boxId];
      nextBefore[lane.boxId] = held !== undefined && sameEpoch(epochOf(held.v), epochOf(lane.uidValidity))
        ? held
        : { v: lane.uidValidity, s: lane.rows[0]!.seq + 1 };
    } else if (lane.adapterNext !== null) {
      nextBefore[lane.boxId] = { v: lane.uidValidity, s: lane.adapterNext };
    }
  }
  if (Object.keys(nextBefore).length > 0) {
    for (const lane of lanes) {
      if (nextBefore[lane.boxId] !== undefined) continue;
      const held = before[lane.boxId];
      const s = lane.tookAny
        ? lane.lowestTakenSeq
        : held !== undefined && sameEpoch(epochOf(held.v), epochOf(lane.uidValidity))
          ? held.s
          : (lane.rows[0]?.seq ?? 0) + 1;
      nextBefore[lane.boxId] = { v: lane.uidValidity, s: Math.max(1, s) };
    }
  }

  return {
    taken: taken.map(({ lane, row }) => ({ boxId: lane.boxId, uidValidity: lane.uidValidity, row })),
    nextBefore,
  };
}
