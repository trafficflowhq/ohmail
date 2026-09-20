import { and, eq, inArray, sql } from "drizzle-orm";
import { folderState, mailboxes, messages } from "@trafficflow/db";
import {
  FOLDER_PAGE_MAX, epochOf, sameEpoch,
  type FolderPage, type FolderPageItem, type FolderSearchPage,
} from "@trafficflow/core/adapters/imap";
/* `core/mail`, never the default barrel: the barrel re-exports `ai/workflows/*`, whose workflow
 * runner imports the db cloud barrel — so one barrel import here pulls the hosted schema into the
 * LOCAL ENGINE bundle this module is part of. The mail subpath is the same surface minus `ai/*`. */
import { normalizeMime } from "@trafficflow/core/mail";
import { ServiceError, requireImapUint32 } from "@trafficflow/services/mail";
import {
  WINDOW_CURSOR_MAX_CHARS, mergeWindowLanes, midKey, mintWindowCursor, parseWindowCursor,
  requireRealEpoch, requireWindowFolders, windowMailboxesOf, type CursorEntry,
} from "./folder-window.js";
import { IMAP_DOOR_DEADLINE_MS, withinDoorBudget } from "./imap-door.js";
import type { ApiDeps } from "./deps.js";

/**
 * The Trash window — a live, un-mirrored view of the provider's own \Trash: the other population
 * (mail deleted in another client), read the way Junk is. The defining property is the same:
 * Trash never enters `messages` or any client mirror — deleted mail into somebody's history would
 * invent a decision rather than read one. Every read writes nothing; `trash-window.test.ts`
 * counts the tables. Read-only with no verb: the restore verb that exists aims at a
 * `trashed_from` origin — a message the mirror never held has none, so "put it back" has no
 * destination. Reads go through {@link withinDoorBudget}, non-`disabled` mailboxes only.
 * Epoch-scoped: 410 on a body-read mismatch; a stale-epoch cursor reports `reset`.
 */

/** The trash body read's transfer ceiling — a bounded window never pulls a 90 MB attachment. */
export const TRASH_BODY_MAX_BYTES = 2_000_000;

/**
 * How long one mailbox's window read may take before it is reported `unreachable`. Reads run in
 * PARALLEL across the account's mailboxes and each is raced against this, so a slow provider
 * costs the response one stated degrade — never the whole invocation's budget.
 */
/**
 * How long one mailbox's Trash read may take before it is reported `unreachable`. Reads run in
 * PARALLEL across the account's mailboxes and each is raced against this, so a slow provider
 * costs the response one stated degrade rather than the whole invocation's budget.
 *
 * The BUDGET is {@link IMAP_DOOR_DEADLINE_MS} and this is the name the Trash window's callers
 * know it by, which is `JUNK_READ_TIMEOUT_MS`'s arrangement exactly: one literal for every
 * API-side dial, so a change there cannot leave one door on an older number. This stood at a
 * second literal `20_000` — the same value by hand, which is the way two numbers drift apart.
 */
export const TRASH_READ_TIMEOUT_MS = IMAP_DOOR_DEADLINE_MS;

/** Longest search term the window accepts — a bound on what is handed to the provider's SEARCH. */
export const TRASH_SEARCH_MAX_CHARS = 120;

/** How large a trash-window cursor may be on the wire — {@link WINDOW_CURSOR_MAX_CHARS}' argument. */
export const TRASH_CURSOR_MAX_CHARS = WINDOW_CURSOR_MAX_CHARS;

/** One row of the merged window list, origin attributed. */
export interface TrashItem extends Omit<FolderPageItem, "seq"> {
  mailboxId: string;
  uidValidity: string;
  /**
   * WHO PUT IT THERE: `"ohmail"` — the message-id matches a mirror row whose desired folder is
   * this mailbox's Trash path, i.e. a delete taken in ohmail; `"provider"` — everything else,
   * which is the person's own delete in another mail client, or the provider's own filing.
   *
   * An `"ohmail"` row is ALREADY in the Trash view from the mirror, with its date of deletion and
   * its restore button. The client drops it from the live population rather than showing the
   * message twice — which is why this field exists at all, and why it is computed here where the
   * mirror is readable rather than guessed in the client.
   */
  origin: "ohmail" | "provider";
}

export interface TrashMailboxState {
  id: string;
  address: string;
  /**
   * The per-mailbox degrade, stated instead of thrown: `"ok"` — the folder was read;
   * `"no_trash_folder"` — the mailbox has no native \Trash (a delete there is refused up front,
   * so there is nothing to show); `"unreachable"` — the dial or the read failed just now. An
   * empty list is never substituted for the last of those.
   */
  window: "ok" | "no_trash_folder" | "unreachable";
  /**
   * THIS mailbox's pagination cursor was DISCARDED — its UIDVALIDITY changed (the folder was
   * emptied and recreated), so the rows in this answer are its new TOP page, not a continuation.
   * Stated rather than inferred: an epoch change with an EMPTY new folder has no row to detect
   * it by.
   */
  reset?: boolean;
}

export interface TrashPage {
  mailboxes: TrashMailboxState[];
  items: TrashItem[];
  /** Opaque older-page cursor (per-mailbox epoch + seq watermarks); null when drained. */
  nextCursor: string | null;
}

export interface TrashSearchPage {
  mailboxes: TrashMailboxState[];
  items: TrashItem[];
  /** Some mailbox matched more than its page carried — the rows are the newest hits only. */
  truncated: boolean;
}

/** The opaque cursor: base64url JSON of {mailboxId → {v, s}}. Malformed input is a 400. */
const parseCursor = (raw: string | undefined): Record<string, CursorEntry> =>
  parseWindowCursor(raw, "trash-window", TRASH_CURSOR_MAX_CHARS);

/** The foundation gate every trash-window route shares — the view is part of folders. */
const requireFolders = (deps: ApiDeps, accountId: string): Promise<void> =>
  requireWindowFolders(deps, accountId, "the Trash window");

/** The account's mailboxes with their resolved Trash paths — {@link windowMailboxesOf}'s rule. */
async function trashMailboxesOf(
  deps: ApiDeps, accountId: string, mailboxId?: string,
): Promise<Array<{ id: string; address: string; trashFolder: string | null }>> {
  const rows = await windowMailboxesOf(deps, accountId, mailboxes.trashFolder, mailboxId);
  return rows.map((r) => ({ id: r.id, address: r.address, trashFolder: r.folder }));
}

async function attributeOrigin(
  deps: ApiDeps, accountId: string, items: TrashItem[],
): Promise<void> {
  const keys = [...new Set(
    items.map((i) => i.messageIdHeader).filter((m): m is string => m !== null).map(midKey),
  )];
  if (keys.length === 0) return;
  // Both spellings are asked for, so a mirror row stored either way is found; the comparison
  // below is on the normalised key regardless.
  const wanted = [...new Set(keys.flatMap((k) => [k, `<${k}>`]))];
  const rows = await deps.db
    .select({ messageIdHeader: messages.messageIdHeader, mailboxId: messages.mailboxId })
    .from(messages)
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(and(
      eq(messages.accountId, accountId),
      inArray(messages.messageIdHeader, wanted),
      sql`${folderState.desiredFolder} = ${mailboxes.trashFolder}`,
    ));
  const ours = new Set(
    rows
      .filter((r) => r.messageIdHeader !== null)
      .map((r) => `${r.mailboxId} ${midKey(r.messageIdHeader!)}`),
  );
  for (const it of items) {
    if (it.messageIdHeader !== null && ours.has(`${it.mailboxId} ${midKey(it.messageIdHeader)}`)) {
      it.origin = "ohmail";
    }
  }
}

/**
 * A UIDVALIDITY that arrived over the wire is only usable if it is a real epoch — a positive
 * integer, no leading zero, sign, exponent or whitespace, inside the protocol's unsigned 32-bit
 * range (RFC 3501 §2.3.1.1). `"0"` is refused for the Junk window's reason: the adapter's epoch
 * guard treats zero as "this locator never claimed an epoch" — correct for the worker's
 * internally minted sentinels, wrong for a number a request chose, which would switch the guard
 * off for that caller. Not `Number(v) > 0`: that accepts `"1e9"`, `" 7 "`, `"0x7"` and
 * `"Infinity"`, and the downstream comparison is a string one against the server's decimal
 * digits.
 */
/**
 * THE LIST PAGE: each mailbox's next window read IN PARALLEL (deadline-raced), merged into ONE
 * account-level page of at most {@link FOLDER_PAGE_MAX} rows, origin-attributed against the
 * mirror. Reads only; writes nothing.
 *
 * The merge keeps a PER-MAILBOX SEQ-PREFIX invariant: rows are taken newest-date-first across
 * mailboxes, but a row is only ever taken after every newer-seq row of its own mailbox — so the
 * per-mailbox cursor (the lowest TAKEN seq) can never skip a row the cap cut. Rows cut by the cap
 * are simply not taken; the next page re-reads them from the watermark.
 */
export async function listServerTrash(
  deps: ApiDeps, accountId: string, opts: { cursor?: string } = {},
): Promise<TrashPage> {
  await requireFolders(deps, accountId);
  const before = parseCursor(opts.cursor);
  const boxes = await trashMailboxesOf(deps, accountId);

  const states: TrashMailboxState[] = [];

  const reads = boxes.map(async (box): Promise<{ boxId: string; page: FolderPage } | null> => {
    if (box.trashFolder === null) {
      states.push({ id: box.id, address: box.address, window: "no_trash_folder" });
      return null;
    }
    try {
      const held = before[box.id];
      const page = await withinDoorBudget(deps, box.id, (adapter) =>
        adapter.listFolderPage(box.trashFolder!, {
          limit: FOLDER_PAGE_MAX,
          ...(held !== undefined ? { beforeSeq: held.s, expectUidValidity: held.v } : {}),
        }), { budgetMs: TRASH_READ_TIMEOUT_MS });
      if (page === null) {
        // The recorded Trash path no longer opens on a LIVE connection — the same honest degrade
        // as no folder (transport failures throw and land in the catch below).
        states.push({ id: box.id, address: box.address, window: "no_trash_folder" });
        return null;
      }
      states.push({
        id: box.id, address: box.address, window: "ok",
        ...(held !== undefined && !sameEpoch(epochOf(held.v), epochOf(page.uidValidity)) ? { reset: true } : {}),
      });
      return { boxId: box.id, page };
    } catch (err) {
      deps.logger?.warn?.("trash_window_read_failed", { mailboxId: box.id, err });
      states.push({ id: box.id, address: box.address, window: "unreachable" });
      return null;
    }
  });
  const pages = (await Promise.all(reads))
    .filter((p): p is { boxId: string; page: FolderPage } => p !== null);

  const { taken, nextBefore } = mergeWindowLanes(pages, before);

  const items: TrashItem[] = taken.map(({ boxId, uidValidity, row }) => {
    const { seq: _seq, ...header } = row;
    return { ...header, mailboxId: boxId, uidValidity, origin: "provider" as const };
  });
  await attributeOrigin(deps, accountId, items);

  return { mailboxes: states, items, nextCursor: mintWindowCursor(nextBefore) };
}

/**
 * THE SEARCH: every mailbox's Trash folder searched IN PARALLEL behind the read budget, the
 * newest hits merged into ONE bounded, origin-attributed answer. Reads only; writes nothing. A
 * mailbox that fails or times out is stated `unreachable`, so an empty answer beside it is never
 * read as "nothing matched".
 */
export async function searchServerTrash(
  deps: ApiDeps, accountId: string, query: string,
): Promise<TrashSearchPage> {
  await requireFolders(deps, accountId);
  const term = query.trim();
  if (term.length === 0 || term.length > TRASH_SEARCH_MAX_CHARS) {
    throw new ServiceError("validation_failed", 400, `q must be 1–${TRASH_SEARCH_MAX_CHARS} characters`);
  }
  const boxes = await trashMailboxesOf(deps, accountId);
  const states: TrashMailboxState[] = [];
  let truncated = false;

  const reads = boxes.map(async (box): Promise<{ boxId: string; page: FolderSearchPage } | null> => {
    if (box.trashFolder === null) {
      states.push({ id: box.id, address: box.address, window: "no_trash_folder" });
      return null;
    }
    try {
      const page = await withinDoorBudget(deps, box.id, (adapter) =>
        adapter.searchFolderPage(box.trashFolder!, term, { limit: FOLDER_PAGE_MAX }),
        { budgetMs: TRASH_READ_TIMEOUT_MS });
      if (page === null) {
        states.push({ id: box.id, address: box.address, window: "no_trash_folder" });
        return null;
      }
      states.push({ id: box.id, address: box.address, window: "ok" });
      if (page.truncated) truncated = true;
      return { boxId: box.id, page };
    } catch (err) {
      deps.logger?.warn?.("trash_window_search_failed", { mailboxId: box.id, err });
      states.push({ id: box.id, address: box.address, window: "unreachable" });
      return null;
    }
  });
  const pages = (await Promise.all(reads))
    .filter((p): p is { boxId: string; page: FolderSearchPage } => p !== null);

  const dateOf = (r: FolderPageItem): number => (r.date !== null ? Date.parse(r.date) || 0 : 0);
  const all = pages.flatMap(({ boxId, page }) =>
    page.items.map((row) => ({ boxId, uidValidity: page.uidValidity, row })));
  all.sort((a, b) => dateOf(b.row) - dateOf(a.row));
  if (all.length > FOLDER_PAGE_MAX) truncated = true;
  const items: TrashItem[] = all.slice(0, FOLDER_PAGE_MAX).map(({ boxId, uidValidity, row }) => {
    const { seq: _seq, ...header } = row;
    return { ...header, mailboxId: boxId, uidValidity, origin: "provider" as const };
  });
  await attributeOrigin(deps, accountId, items);
  return { mailboxes: states, items, truncated };
}

/**
 * THE BODY on open — fetched live, parsed, returned as TEXT, never persisted and never HTML.
 * Trash holds whatever was deleted, spam included, so it renders on the Junk window's terms: a
 * plain-text rendering loads no remote content, runs no markup and fires no tracker. The session
 * cache is the client's; this route re-reads the folder every time it is asked.
 *
 * EPOCH-BOUND: the caller names the UIDVALIDITY its row came from, and a folder emptied since
 * answers 410 — never the body of whatever message now wears the UID.
 */
export async function serverTrashBody(
  deps: ApiDeps, accountId: string,
  args: { mailboxId: string; uid: number; uidValidity: string },
): Promise<{ subject: string; text: string }> {
  requireRealEpoch(args.uidValidity);
  // The UID has the same protocol ceiling as its epoch: `?uid=1e100` is an integer to JavaScript
  // and would be written into a FETCH command.
  requireImapUint32(args.uid, "uid");
  await requireFolders(deps, accountId);
  const [box] = await trashMailboxesOf(deps, accountId, args.mailboxId);
  if (!box || box.trashFolder === null) {
    throw new ServiceError("no_trash_folder", 404, "this mailbox has no Trash folder");
  }
  return withinDoorBudget(deps, args.mailboxId, async (adapter) => {
    const fetched = await adapter.fetchByUid(box.trashFolder!, [args.uid], {
      maxBytes: TRASH_BODY_MAX_BYTES,
    });
    if (!sameEpoch(epochOf(fetched.uidValidity), epochOf(args.uidValidity))) {
      throw new ServiceError(
        "trash_message_gone", 410, "the Trash folder changed under this row — reload the list",
      );
    }
    if (fetched.oversize.includes(args.uid)) {
      throw new ServiceError(
        "trash_body_too_large", 413,
        "this message is too large to preview here — read it in your own mail client",
      );
    }
    const create = fetched.creates.find((c) => c.raw !== undefined);
    if (!create || !create.raw) {
      throw new ServiceError(
        "trash_message_gone", 410, "this message is no longer in the Trash folder",
      );
    }
    const parsed = await normalizeMime(create.raw);
    return { subject: parsed.subject, text: parsed.textBody };
  }, { budgetMs: TRASH_READ_TIMEOUT_MS });
}
