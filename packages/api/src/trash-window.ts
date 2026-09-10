import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { folderState, mailboxes, messages } from "@trafficflow/db";
import {
  FOLDER_PAGE_MAX,
  type FolderPage, type FolderPageItem, type FolderSearchPage,
} from "@trafficflow/core/adapters/imap";
/* `core/mail`, never the default barrel: the barrel re-exports `ai/workflows/*`, whose workflow
 * runner imports the db cloud barrel — so one barrel import here pulls the hosted schema into the
 * LOCAL ENGINE bundle this module is part of. The mail subpath is the same surface minus `ai/*`. */
import { normalizeMime } from "@trafficflow/core/mail";
import {
  ServiceError, foldersEnabled, isUuid, requireImapUint32, requireUuid, IMAP_UINT32_MAX,
} from "@trafficflow/services/mail";
import { IMAP_DOOR_DEADLINE_MS, withinDoorBudget } from "./imap-door.js";
import type { ApiDeps } from "./deps.js";

/**
 * ═══ THE TRASH WINDOW — a live, UN-MIRRORED view of the provider's own \Trash ════════════════
 *
 * The Trash view lists what ohmail deleted: `folder_state.desired_folder` = the mailbox's Trash
 * path, ordered by the instant of the press. Mail the person deleted in Apple Mail, in Gmail's
 * web client or on their phone is not in it and could not be — `imap-types.ts`'s reading rule
 * gives the provider's Trash no cursor, so the mirror does not know it is there — and the view's
 * foot line said so rather than pretending otherwise.
 *
 * This is the other population, read the way Junk already is. The DEFINING property is the same
 * and it is the reason the shape was copied rather than improved on: **Trash never enters
 * `messages` or any client mirror.** Deleted mail is not filing, and putting it into somebody's
 * history and their search results would be inventing a decision rather than reading one — the
 * argument `imap-types.ts` makes for excluding the folder from the SYNC, unchanged. Every read
 * here writes nothing anywhere, and `trash-window.test.ts` counts the tables to keep it that way.
 *
 * ── READ-ONLY, WITH NO VERB AT ALL ───────────────────────────────────────────────────────────
 *
 * The Junk window has a rescue, because a spam verdict is the user's own and reversing it belongs
 * to them. This window has NOTHING: the restore verb that exists (`POST /messages/:id/restore`)
 * puts back a message ohmail itself deleted, which is a mirror row with a `trashed_from` origin
 * to aim at. A message the provider's Trash holds and the mirror has never seen has no origin
 * recorded anywhere, so "put it back" has no destination — it would be ohmail choosing a folder
 * for somebody else's mail. That is a product decision and it is not this module's to make; the
 * window shows the mail and names where it is.
 *
 * ── WHY THE API DIALS DIRECTLY INSTEAD OF QUEUEING ON THE WORKER ─────────────────────────────
 *
 * The architecture rule draws its line at applying ORGANIZATION: moves defer to the worker via
 * desired state so a serverless function can never leave a mailbox half-moved, while on-demand
 * reads that store nothing already open a short-lived connection. A Trash LIST/BODY read is
 * exactly that shape, so the reads go through {@link withinDoorBudget} — the same
 * admission-capped, budget-counted door every other API dial uses, and the reason this module
 * owns no dialling code of its own — and the connection is closed before the response leaves.
 * The window serves only mailboxes whose `status` is not `disabled`:
 * a stood-down mailbox is another organizer's, and this module never dials one Cloud does not
 * serve.
 *
 * ── EVERYTHING IS EPOCH-SCOPED, because \Trash is a folder providers PURGE ───────────────────
 *
 * A UID names a message only within one UIDVALIDITY epoch, and a provider empties and recreates
 * Trash on its own schedule — more aggressively than Junk, since that is what Trash is for. So
 * the list carries each row's epoch, the body read REQUIRES the row's epoch and answers 410 on a
 * mismatch rather than serving whatever message now wears the number, and a page cursor whose
 * epoch no longer matches is reported `reset` rather than silently continued.
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

/** How large a trash-window cursor may be on the wire — {@link JUNK_CURSOR_MAX_CHARS}' argument. */
export const TRASH_CURSOR_MAX_CHARS = 128 * 1024;

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

/** One mailbox's cursor entry: the UIDVALIDITY the watermark belongs to, and the seq below. */
interface CursorEntry { v: string; s: number }

/** The opaque cursor: base64url JSON of {mailboxId → {v, s}}. Malformed input is a 400. */
function parseCursor(raw: string | undefined): Record<string, CursorEntry> {
  if (!raw) return {};
  // The WIRE ceiling is consulted BEFORE the decode, so an arbitrarily long cursor costs a
  // `.length` rather than a base64 decode, a `JSON.parse` and a loop. It bounds the entry count
  // too, because an entry cannot weigh less than its uuid key.
  if (raw.length > TRASH_CURSOR_MAX_CHARS) {
    throw new ServiceError("validation_failed", 400, "cursor is not a trash-window cursor");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    const out: Record<string, CursorEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      // The KEY is a mailbox id and the epoch is an IMAP UIDVALIDITY: both are compared
      // downstream against values from the user's own server, so both are typed here.
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
    throw new ServiceError("validation_failed", 400, "cursor is not a trash-window cursor");
  }
}

function mintCursor(map: Record<string, CursorEntry>): string | null {
  return Object.keys(map).length === 0
    ? null
    : Buffer.from(JSON.stringify(map), "utf8").toString("base64url");
}

/** The foundation gate every trash-window route shares — the view is part of folders. */
async function requireFolders(deps: ApiDeps, accountId: string): Promise<void> {
  if (!accountId || !(await foldersEnabled(deps.db, accountId))) {
    throw new ServiceError(
      "folders_disabled", 409,
      "the Trash window is part of the folders feature — turn on “Use folders” first",
    );
  }
}

/**
 * The account's mailboxes with their resolved Trash paths — ownership by scoping, never by
 * trust. `disabled` is excluded because it is the stood-down state: that mailbox's organizer is
 * elsewhere. `error` stays in — a transiently erroring mailbox is still Cloud's to read, and the
 * read itself states `unreachable` honestly when the dial fails.
 */
async function trashMailboxesOf(
  deps: ApiDeps, accountId: string, mailboxId?: string,
): Promise<Array<{ id: string; address: string; trashFolder: string | null }>> {
  // SHAPE before the predicate: `mailboxes.id` is a uuid column and `?mailboxId=` is
  // caller-chosen, so a malformed one would reach Postgres as 22P02 — a 500 for a bad query
  // string. Here rather than in the routes, so every present and future caller gets it.
  if (mailboxId !== undefined) requireUuid(mailboxId, "mailboxId");
  const scoped = and(eq(mailboxes.accountId, accountId), ne(mailboxes.status, "disabled"));
  const rows = await deps.db
    .select({ id: mailboxes.id, address: mailboxes.address, trashFolder: mailboxes.trashFolder })
    .from(mailboxes)
    .where(mailboxId === undefined ? scoped : and(scoped, eq(mailboxes.id, mailboxId)));
  if (mailboxId !== undefined && rows.length === 0) {
    throw new ServiceError("not_found", 404, "mailbox not found");
  }
  return rows;
}


/**
 * A Message-ID as a comparable key: trimmed, angle brackets off. The live envelope carries
 * `<id@host>`; the mirror stores the id the parser kept, which is bare — so without this
 * normalisation the two sides of the attribution join never meet.
 */
const midKey = (raw: string): string => raw.trim().replace(/^<|>$/g, "");

/**
 * Origin attribution shared by the list and the search. A live Trash row whose message-id matches
 * a mirror row DESIRED at this mailbox's Trash path is one ohmail deleted; everything else is the
 * person's own delete elsewhere, or the provider's.
 *
 * The predicate is `folder_state.desired_folder = mailboxes.trash_folder` — the SAME spelling
 * `MessageService.listTrash` selects the mirrored population with, so the two lists cannot come to
 * disagree about which messages they each own. Bounded: at most one IN() over this page's mids.
 * Mutates `origin` in place; writes nothing.
 */
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
 * A UIDVALIDITY that arrived over the wire is only usable if it is a REAL epoch — a positive
 * integer with no leading zero, no sign, no exponent, no whitespace, inside the protocol's
 * unsigned 32-bit range (RFC 3501 §2.3.1.1).
 *
 * `"0"` is refused for the reason the Junk window refuses it: the adapter's epoch guard treats
 * zero as "this locator never claimed an epoch" — correct for the worker's internally-minted
 * cold-drain sentinels, wrong for a number a request chose, because it would switch the guard off
 * for that caller. Not `Number(v) > 0`: that accepts `"1e9"`, `" 7 "`, `"0x7"` and `"Infinity"`,
 * none of which is an epoch, and the comparison downstream is a STRING one against the server's
 * decimal digits — so such a value would fail somewhere less honest than here.
 */
function requireRealEpoch(uidValidity: string): void {
  if (!/^[1-9][0-9]*$/.test(uidValidity) || uidValidity.length > 10
    || Number(uidValidity) > IMAP_UINT32_MAX) {
    throw new ServiceError(
      "validation_failed", 400,
      `uidValidity must be the row's epoch — an integer between 1 and ${IMAP_UINT32_MAX}`,
    );
  }
}

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
  const nextBefore: Record<string, CursorEntry> = {};

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
        ...(held !== undefined && held.v !== page.uidValidity ? { reset: true } : {}),
      });
      return { boxId: box.id, page };
    } catch (err) {
      deps.logger?.warn?.("trash_window_read_failed", { mailboxId: box.id, err: String(err) });
      states.push({ id: box.id, address: box.address, window: "unreachable" });
      return null;
    }
  });
  const pages = (await Promise.all(reads))
    .filter((p): p is { boxId: string; page: FolderPage } => p !== null);

  const lanes = pages.map(({ boxId, page }) => ({
    boxId,
    uidValidity: page.uidValidity,
    rows: page.items,                 // already newest-first by seq
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

  // Per-mailbox cursors: from the lowest TAKEN seq; a lane with rows left (cut by the cap) resumes
  // below what was taken; an untouched lane keeps its incoming watermark verbatim.
  for (const lane of lanes) {
    const leftover = lane.at < lane.rows.length;
    if (lane.tookAny) {
      if (leftover || lane.adapterNext !== null) {
        nextBefore[lane.boxId] = { v: lane.uidValidity, s: lane.lowestTakenSeq };
      }
    } else if (lane.rows.length > 0) {
      const held = before[lane.boxId];
      nextBefore[lane.boxId] = held !== undefined && held.v === lane.uidValidity
        ? held
        : { v: lane.uidValidity, s: lane.rows[0]!.seq + 1 };
    } else if (lane.adapterNext !== null) {
      nextBefore[lane.boxId] = { v: lane.uidValidity, s: lane.adapterNext };
    }
  }
  /* WHILE ANY LANE PAGINATES, EVERY READ LANE KEEPS AN EPOCH ENTRY — a DRAINED mailbox included.
   * Without one the next "Show older" re-reads the drained mailbox cursorless: a folder emptied
   * and recreated in the meantime would serve its new-epoch top page with NO reset stated (there
   * is no held epoch to compare), and the client — which trusts the stated flag — would append
   * fresh rows under stale ones. What matters is the `v`. */
  if (Object.keys(nextBefore).length > 0) {
    for (const lane of lanes) {
      if (nextBefore[lane.boxId] !== undefined) continue;
      const held = before[lane.boxId];
      const s = lane.tookAny
        ? lane.lowestTakenSeq
        : held !== undefined && held.v === lane.uidValidity
          ? held.s
          : (lane.rows[0]?.seq ?? 0) + 1;
      nextBefore[lane.boxId] = { v: lane.uidValidity, s: Math.max(1, s) };
    }
  }

  const items: TrashItem[] = taken.map(({ lane, row }) => {
    const { seq: _seq, ...header } = row;
    return {
      ...header, mailboxId: lane.boxId, uidValidity: lane.uidValidity,
      origin: "provider" as const,
    };
  });
  await attributeOrigin(deps, accountId, items);

  return { mailboxes: states, items, nextCursor: mintCursor(nextBefore) };
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
      deps.logger?.warn?.("trash_window_search_failed", { mailboxId: box.id, err: String(err) });
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
    if (fetched.uidValidity !== args.uidValidity) {
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
