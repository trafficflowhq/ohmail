import {
  FOLDER_PAGE_MAX, epochOf, sameEpoch,
  type FolderPage, type FolderPageItem,
} from "@trafficflow/core/adapters/imap";
import { ServiceError, isUuid, IMAP_UINT32_MAX } from "@trafficflow/services/mail";

/**
 * THE PROVIDER WINDOWS' ONE PAGINATION MECHANISM — shared by the Junk window and the Trash
 * window, which are the same read of two different folders: every connected mailbox's page,
 * merged newest-first into one account-level page, with a per-mailbox `(uidValidity, seq)`
 * watermark minted into an opaque cursor. Both files carried their own byte-identical copy until
 * 0.21; a copy that drifts is a live window keeping a bug the other one had fixed, which is why
 * `folder-window-one-definition.test.ts` refuses a second declaration of any part of this.
 */

/** One mailbox's cursor entry: the UIDVALIDITY the watermark belongs to, and the seq below. */
export interface CursorEntry { v: string; s: number }

/**
 * How large a window cursor may be on the wire. The cursor is a caller-supplied base64 JSON
 * object, one entry per mailbox. One ceiling, consulted before the decode, so an arbitrarily long
 * cursor costs a `.length`; it bounds the entry count too, since an entry cannot weigh less than
 * its uuid key. Deliberately no entry-count ceiling: the cursor's size is the account's mailbox
 * count and the self-host imposes no mailbox limit, so any entry ceiling rejects a cursor this
 * module itself minted at some account size — roughly two thousand mailboxes still mint a cursor
 * this refuses.
 */
export const FOLDER_WINDOW_CURSOR_MAX_CHARS = 128 * 1024;

/**
 * The opaque cursor, decoded: base64url JSON of {mailboxId → {v, s}}. Malformed input is a 400
 * carrying `refusal`, which is the only thing the two windows ever differed by. The KEY is a
 * mailbox id and the epoch is an IMAP UIDVALIDITY — both are compared downstream against values
 * from the user's own server, so both are typed here rather than trusted.
 */
export function parseWindowCursor(
  raw: string | undefined, refusal: string,
): Record<string, CursorEntry> {
  if (!raw) return {};
  if (raw.length > FOLDER_WINDOW_CURSOR_MAX_CHARS) {
    throw new ServiceError("validation_failed", 400, refusal);
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
    throw new ServiceError("validation_failed", 400, refusal);
  }
}

/** The opaque cursor, minted. `null` when nothing paginates — the window is drained. */
export function mintWindowCursor(map: Record<string, CursorEntry>): string | null {
  return Object.keys(map).length === 0
    ? null
    : Buffer.from(JSON.stringify(map), "utf8").toString("base64url");
}

/**
 * A UIDVALIDITY that arrived over the wire is only usable if it is a real epoch — a positive
 * integer, no leading zero, sign, exponent or whitespace, inside the protocol's unsigned 32-bit
 * range (RFC 3501 §2.3.1.1). `"0"` is refused: the adapter's epoch guard treats zero as "this
 * locator never claimed an epoch" — correct for the worker's internally minted sentinels, wrong
 * for a number a request chose, which would switch the guard off for that caller. Not
 * `Number(v) > 0`: that accepts `"1e9"`, `" 7 "`, `"0x7"` and `"Infinity"`, and the downstream
 * comparison is a string one against the server's decimal digits. The digit ceiling is checked
 * before the range so an absurd string costs a `.length` rather than a `Number()`.
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

/** One taken row, with the mailbox and epoch it came from. */
export interface TakenRow { boxId: string; uidValidity: string; row: FolderPageItem }

/**
 * THE K-WAY MERGE: newest date first, per-mailbox seq order enforced by taking each mailbox's
 * rows through its own pointer. At most {@link FOLDER_PAGE_MAX} rows leave, whatever the mailbox
 * count — the account-level page bound. The merge keeps a PER-MAILBOX SEQ-PREFIX invariant: a row
 * is only ever taken after every newer-seq row of its own mailbox, so the per-mailbox cursor (the
 * lowest TAKEN seq) can never skip a row the cap cut.
 */
export function mergeFolderWindow(
  pages: ReadonlyArray<{ boxId: string; page: FolderPage }>,
  before: Record<string, CursorEntry>,
): { taken: TakenRow[]; nextBefore: Record<string, CursorEntry> } {
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
  const taken: TakenRow[] = [];
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
    taken.push({ boxId: best.boxId, uidValidity: best.uidValidity, row });
  }

  // Per-mailbox cursors: from the lowest TAKEN seq; a lane with rows left (cut by the cap)
  // resumes below what was taken; an untouched lane keeps its incoming watermark verbatim.
  // Every entry carries the epoch it belongs to.
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

  /**
   * WHILE ANY LANE PAGINATES, EVERY READ LANE KEEPS AN EPOCH ENTRY — a DRAINED mailbox included.
   * Without one, the next "Show older" re-reads the drained mailbox cursorless: a folder emptied
   * and recreated in the meantime would serve its new-epoch top page with NO reset stated (there
   * is no held epoch to compare), and the client — which trusts the stated flag — would append
   * fresh mail under stale rows. The drained entry's watermark is its own lowest taken seq (the
   * next page below it is empty, so nothing repeats), or the incoming watermark / the-top for a
   * lane that contributed nothing; what matters is the `v`, which is what lets the NEXT read
   * detect the recreation and say `reset`.
   */
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

  return { taken, nextBefore };
}
