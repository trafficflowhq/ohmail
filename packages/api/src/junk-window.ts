import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  applyBodyBytesDelta, bodyBytesOf, mailboxes, messageBodies, messages, recordChange,
} from "@trafficflow/db";
import {
  FOLDER_PAGE_MAX, MessageGoneError, makeRef,
  type FolderPage, type FolderPageItem,
} from "@trafficflow/core/adapters/imap";
import { normalizeMime, normalizeMessageId, prepareHtmlForStorage } from "@trafficflow/core";
import { ServiceError, foldersEnabled } from "@trafficflow/services/mail";
import { openMailboxImap } from "./attachments-adapter.js";
import type { ApiDeps } from "./deps.js";

/**
 * ═══ THE JUNK WINDOW — a live, UN-MIRRORED view of the provider's own \Junk ═══════════════════
 *
 * FOLDERS-SPEC.md §16.2: the Screener's third segment becomes a window into the mailbox's native
 * Junk folder. The DEFINING property is that Junk never enters `messages` or any client mirror —
 * the window reads the folder itself, on request, bounded. The LIST and BODY reads write nothing
 * anywhere; the RESCUE writes exactly three things, each argued at its site: the user-commanded
 * MOVE on the user's own server (the `imap-types.ts` carve-out's second write), the
 * `sync_requested_at` doorbell that follows it, and — for a message OUR OWN verdict husked — the
 * restoration of the husked body, which is the verdict's reversal made whole. No NEW mirror row
 * is ever created here, and `junk-window.test.ts` counts the tables to keep it that way.
 *
 * ── WHY THE API DIALS DIRECTLY INSTEAD OF QUEUEING ON THE WORKER ────────────────────────────
 *
 * The architecture rule draws its line at applying ORGANIZATION: moves defer to the worker via
 * desired state so a serverless function can never leave a mailbox half-moved, while on-demand
 * reads that store nothing — attachment fetch, the gated send — already open a short-lived
 * connection. A junk LIST/BODY read is exactly that second shape: on-demand, short-lived,
 * nothing stored. The API↔worker seam is a database stamp polled every ~3 s (`sync-kick.ts`) —
 * routing an interactive read through it would add seconds of latency per page AND a result
 * channel that marshals junk headers/bodies through the database, which is precisely the
 * storage the window exists to avoid. So the reads go through {@link openMailboxImap}, the SAME
 * admission-capped, budget-counted door every other API dial uses (`MAX_IMAP_PER_MAILBOX` — the
 * worker's own connection is priced into that budget), and the connection is closed before the
 * response leaves. The window also serves only mailboxes whose `status` is `connected`: a
 * stood-down mailbox is another organizer's (a local install holds the lease), and this module
 * never dials — much less writes into — a mailbox Cloud does not organize. The rescue itself is
 * a single-UID move in a folder no ohmail pass ever enumerates, so it contends with no
 * organizer write by construction; the residual — the spec's letter has the worker execute it
 * under the lease — is a recorded deviation, not an accident.
 *
 * ── EVERYTHING IS EPOCH-SCOPED, because \Junk is a folder other software rewrites ───────────
 *
 * A UID names a message only within one UIDVALIDITY epoch, and junk folders get purged and
 * recreated by providers on their own schedule. So: the list carries each row's epoch; the body
 * read REQUIRES the row's epoch and answers 410 on a mismatch rather than serving whatever
 * message now wears the number; the rescue moves with `requireEpoch`, so a stale press can
 * never move a stranger; and the pagination cursor stores each mailbox's epoch beside its
 * watermark — a renumbered folder restarts that mailbox's window at the top instead of silently
 * skipping everything above a stale mark.
 *
 * ── THE RESCUE RE-ENTERS THROUGH THE PIPELINE, NOT AROUND IT (§16.2/G3) ─────────────────────
 *
 * "Not junk" performs one server-side move OUT of Junk into INBOX — which is what un-trains the
 * provider's filter — and then files NOTHING itself: the message's next appearance is a new UID
 * in a watched folder, which the worker ingests like any arrival. Provider-origin junk is
 * genuinely new mail — an unknown sender therefore waits in the Screener, an allowed sender
 * lands in the Ohbox. A message OUR verdict filed is already a (husked) mirror row, and its
 * re-appearance is the adoption path `junk-filing.ts` designed for exactly this restore; what
 * adoption cannot do is un-husk the body the verdict dropped, so the rescue restores it — the
 * same fetch-verify-rewrite `redacted-restore.ts` performs, byte accounting included. A message
 * the provider expunged mid-flight fails HONESTLY: `MessageGoneError` → 410, never a phantom.
 */

/** The junk body read's transfer ceiling — a bounded window never pulls a 90 MB spam payload. */
export const JUNK_BODY_MAX_BYTES = 2_000_000;

/**
 * How long one mailbox's window read may take before it is reported `unreachable`. Reads run in
 * PARALLEL across the account's mailboxes and each is raced against this, so a slow provider
 * costs the response one stated degrade — never the whole invocation's budget (the serverless
 * host's ceiling is 60 s; serial unbounded dials could exhaust it before answering anything).
 */
export const JUNK_READ_TIMEOUT_MS = 20_000;

/** One row of the merged window list, origin attributed. */
export interface JunkItem extends Omit<FolderPageItem, "seq"> {
  mailboxId: string;
  uidValidity: string;
  /**
   * WHO FILED IT (§16.2's origin marker): `"verdict"` — the message-id matches a mirror row our
   * spam verdict (or the one-time sweep) parked at this mailbox's junk path
   * (`messages.native_locator`, written by the worker's filing completion); `"provider"` —
   * everything else, i.e. the mail server's own filter.
   */
  origin: "verdict" | "provider";
}

export interface JunkMailboxState {
  id: string;
  address: string;
  /**
   * The per-mailbox degrade, stated instead of thrown: `"ok"` — the folder was read;
   * `"no_junk_folder"` — the mailbox has no native \Junk (the §16.2 degrade: the segment says
   * so); `"unreachable"` — the dial or the read failed just now (the honest failed state — an
   * empty list is never substituted for it).
   */
  window: "ok" | "no_junk_folder" | "unreachable";
}

export interface JunkPage {
  mailboxes: JunkMailboxState[];
  items: JunkItem[];
  /** Opaque older-page cursor (per-mailbox epoch + seq watermarks); null when drained. */
  nextCursor: string | null;
}

/** One mailbox's cursor entry: the UIDVALIDITY the watermark belongs to, and the seq below. */
interface CursorEntry { v: string; s: number }

/** The opaque cursor: base64url JSON of {mailboxId → {v, s}}. Malformed input is a 400. */
function parseCursor(raw: string | undefined): Record<string, CursorEntry> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    const out: Record<string, CursorEntry> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const e = v as { v?: unknown; s?: unknown };
      if (typeof e?.v !== "string" || typeof e?.s !== "number" || !Number.isInteger(e.s) || e.s <= 0) {
        throw new Error("shape");
      }
      out[k] = { v: e.v, s: e.s };
    }
    return out;
  } catch {
    throw new ServiceError("validation_failed", 400, "cursor is not a junk-window cursor");
  }
}

function mintCursor(map: Record<string, CursorEntry>): string | null {
  return Object.keys(map).length === 0
    ? null
    : Buffer.from(JSON.stringify(map), "utf8").toString("base64url");
}

/** The foundation gate every junk route shares: the window exists only behind "Use folders". */
async function requireFolders(deps: ApiDeps, accountId: string): Promise<void> {
  if (!accountId || !(await foldersEnabled(deps.db, accountId))) {
    throw new ServiceError("folders_disabled", 409, "the Junk window is part of the folders feature — turn on “Use folders” first");
  }
}

/**
 * The account's CONNECTED mailboxes with their resolved junk paths — ownership by scoping,
 * never by trust, and `status = 'connected'` because a stood-down or disabled mailbox is not
 * Cloud's to dial: its organizer is elsewhere (the lease principle), even while its credential
 * rows remain stored for a later takeover.
 */
async function junkMailboxesOf(
  deps: ApiDeps, accountId: string, mailboxId?: string,
): Promise<Array<{ id: string; address: string; junkFolder: string | null }>> {
  // `disabled` is the stood-down/lease state — another organizer's mailbox. `error` stays in:
  // a transiently erroring mailbox is still Cloud's to read, and the read itself will state
  // `unreachable` honestly when the dial fails.
  const scoped = and(eq(mailboxes.accountId, accountId), ne(mailboxes.status, "disabled"));
  const rows = await deps.db
    .select({ id: mailboxes.id, address: mailboxes.address, junkFolder: mailboxes.junkFolder })
    .from(mailboxes)
    .where(mailboxId === undefined ? scoped : and(scoped, eq(mailboxes.id, mailboxId)));
  if (mailboxId !== undefined && rows.length === 0) {
    throw new ServiceError("not_found", 404, "mailbox not found");
  }
  return rows;
}

/** Race a read against {@link JUNK_READ_TIMEOUT_MS}; a timeout is an ordinary failure. */
async function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("junk window read timed out")), JUNK_READ_TIMEOUT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The LIST page: each mailbox's next window read IN PARALLEL (deadline-raced), merged into ONE
 * account-level page of at most {@link FOLDER_PAGE_MAX} rows, origin-attributed against the
 * mirror's verdict locators. Reads only; writes nothing.
 *
 * The merge keeps a PER-MAILBOX SEQ-PREFIX invariant: rows are taken newest-date-first across
 * mailboxes, but a row is only ever taken after every newer-seq row of its own mailbox — so the
 * per-mailbox cursor (the lowest TAKEN seq) can never skip a row the cap cut. Rows cut by the
 * cap are simply not taken; the next page re-reads them from the watermark.
 */
export async function listJunk(
  deps: ApiDeps, accountId: string, opts: { cursor?: string } = {},
): Promise<JunkPage> {
  await requireFolders(deps, accountId);
  const before = parseCursor(opts.cursor);
  const boxes = await junkMailboxesOf(deps, accountId);

  const states: JunkMailboxState[] = [];
  const nextBefore: Record<string, CursorEntry> = {};

  const reads = boxes.map(async (box): Promise<{ boxId: string; page: FolderPage | null } | null> => {
    if (box.junkFolder === null) {
      states.push({ id: box.id, address: box.address, window: "no_junk_folder" });
      return null;
    }
    try {
      const page = await withDeadline((async () => {
        const opened = await openMailboxImap(deps, box.id);
        try {
          const held = before[box.id];
          return await opened.adapter.listFolderPage(box.junkFolder!, {
            limit: FOLDER_PAGE_MAX,
            ...(held !== undefined ? { beforeSeq: held.s, expectUidValidity: held.v } : {}),
          });
        } finally {
          await opened.close().catch(() => { /* socket gone; the slot release has its own guard */ });
        }
      })());
      if (page === null) {
        // The recorded junk path no longer opens on a LIVE connection — the same honest
        // degrade as no folder (transport failures threw and land in the catch below).
        states.push({ id: box.id, address: box.address, window: "no_junk_folder" });
        return null;
      }
      states.push({ id: box.id, address: box.address, window: "ok" });
      return { boxId: box.id, page };
    } catch (err) {
      deps.logger?.warn?.("junk_window_read_failed", { mailboxId: box.id, err: String(err) });
      states.push({ id: box.id, address: box.address, window: "unreachable" });
      return null;
    }
  });
  const pages = (await Promise.all(reads)).filter((p): p is { boxId: string; page: FolderPage } => p !== null);

  // ── The k-way merge: newest date first, per-mailbox seq order enforced by taking each
  // mailbox's rows through its own pointer. At most FOLDER_PAGE_MAX rows leave, whatever the
  // mailbox count — the account-level page bound.
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

  // ── Per-mailbox cursors: from the lowest TAKEN seq; a lane with rows left (cut by the cap)
  // resumes below what was taken; an untouched lane keeps its incoming watermark verbatim; a
  // fully-drained lane leaves no entry. Every entry carries the epoch it belongs to.
  for (const lane of lanes) {
    const leftover = lane.at < lane.rows.length;
    if (lane.tookAny) {
      if (leftover || lane.adapterNext !== null) {
        nextBefore[lane.boxId] = { v: lane.uidValidity, s: lane.lowestTakenSeq };
      }
    } else if (lane.rows.length > 0) {
      // Nothing of this mailbox fit the page: resume exactly where this request began.
      const held = before[lane.boxId];
      nextBefore[lane.boxId] = held !== undefined && held.v === lane.uidValidity
        ? held
        : { v: lane.uidValidity, s: lane.rows[0]!.seq + 1 };
    } else if (lane.adapterNext !== null) {
      nextBefore[lane.boxId] = { v: lane.uidValidity, s: lane.adapterNext };
    }
  }

  const items: JunkItem[] = taken.map(({ lane, row }) => {
    const { seq: _seq, ...header } = row;
    return { ...header, mailboxId: lane.boxId, uidValidity: lane.uidValidity, origin: "provider" as const };
  });

  // ── Origin attribution: the verdict's husk keeps the message-id, and the filing completion
  // parks `native_locator` at the junk path — so a live junk row whose mid matches such a row
  // was filed by US on the user's order. Bounded: at most one IN() over this page's mids.
  const mids = [...new Set(items.map((i) => i.messageIdHeader).filter((m): m is string => m !== null))];
  if (mids.length > 0) {
    const junkPathOf = new Map(boxes.map((b) => [b.id, b.junkFolder]));
    const rows = await deps.db
      .select({ messageIdHeader: messages.messageIdHeader, mailboxId: messages.mailboxId, nativeLocator: messages.nativeLocator })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), inArray(messages.messageIdHeader, mids)));
    const filedByUs = new Set(
      rows
        .filter((r) => {
          const loc = r.nativeLocator as { folder?: string } | null;
          return loc?.folder !== undefined && loc.folder === junkPathOf.get(r.mailboxId);
        })
        .map((r) => `${r.mailboxId} ${r.messageIdHeader}`),
    );
    for (const it of items) {
      if (it.messageIdHeader !== null && filedByUs.has(`${it.mailboxId} ${it.messageIdHeader}`)) {
        it.origin = "verdict";
      }
    }
  }

  return { mailboxes: states, items, nextCursor: mintCursor(nextBefore) };
}

/**
 * The BODY on open — fetched live, parsed, returned as TEXT, never persisted and never HTML:
 * junk is the one pile whose bodies are hostile by definition, and a plain-text rendering loads
 * no remote content, runs no markup, and fires no tracker. The session cache is the client's.
 * EPOCH-BOUND: the caller names the UIDVALIDITY its row came from, and a folder renumbered
 * since answers 410 — never the body of whatever message now wears the UID.
 */
export async function junkBody(
  deps: ApiDeps, accountId: string,
  args: { mailboxId: string; uid: number; uidValidity: string },
): Promise<{ subject: string; text: string }> {
  await requireFolders(deps, accountId);
  const [box] = await junkMailboxesOf(deps, accountId, args.mailboxId);
  if (!box || box.junkFolder === null) {
    throw new ServiceError("no_junk_folder", 404, "this mailbox has no Junk folder");
  }
  const opened = await openMailboxImap(deps, args.mailboxId);
  try {
    const fetched = await opened.adapter.fetchByUid(box.junkFolder, [args.uid], {
      maxBytes: JUNK_BODY_MAX_BYTES,
    });
    if (fetched.uidValidity !== args.uidValidity) {
      throw new ServiceError("junk_message_gone", 410, "the Junk folder changed under this row — reload the list");
    }
    if (fetched.oversize.includes(args.uid)) {
      throw new ServiceError("junk_body_too_large", 413, "this message is too large to preview here — read it in your own mail client");
    }
    const create = fetched.creates.find((c) => c.raw !== undefined);
    if (!create || !create.raw) {
      throw new ServiceError("junk_message_gone", 410, "this message is no longer in the Junk folder");
    }
    const parsed = await normalizeMime(create.raw);
    return { subject: parsed.subject, text: parsed.textBody };
  } finally {
    await opened.close().catch(() => { /* socket gone; the slot release has its own guard */ });
  }
}

/**
 * "NOT JUNK" — the rescue (§16.2/G3): ONE user-commanded, EPOCH-GUARDED move OUT of Junk back
 * to INBOX, the doorbell, and — for a message OUR verdict husked — the body's restoration. See
 * the module header for how each half re-enters the normal flow.
 */
export async function rescueJunk(
  deps: ApiDeps, accountId: string,
  args: { mailboxId: string; uid: number; uidValidity: string },
): Promise<{ status: "rescued" }> {
  await requireFolders(deps, accountId);
  const [box] = await junkMailboxesOf(deps, accountId, args.mailboxId);
  if (!box || box.junkFolder === null) {
    throw new ServiceError("no_junk_folder", 404, "this mailbox has no Junk folder");
  }
  const ref = makeRef(args.uidValidity, args.uid);

  /**
   * THE HUSK, if this is our own verdict coming back: the filing completion parked the row's
   * locator at exactly this junk ref, and the verdict dropped the body. Identified BEFORE the
   * move (the raw must be fetched while the message is still in Junk, on the same connection);
   * restored AFTER it (the move is the user's command — a failed restore must not undo it).
   */
  const [husk] = await deps.db
    .select({
      id: messages.id, dedupKey: messages.dedupKey, messageIdHeader: messages.messageIdHeader,
    })
    .from(messages)
    .where(and(
      eq(messages.accountId, accountId),
      eq(messages.mailboxId, args.mailboxId),
      sql`${messages.nativeLocator}->>'folder' = ${box.junkFolder}`,
      sql`${messages.nativeLocator}->>'ref' = ${ref}`,
    ))
    .limit(1);

  const opened = await openMailboxImap(deps, args.mailboxId);
  let raw: Buffer | null = null;
  try {
    if (husk !== undefined) {
      const [body] = await deps.db
        .select({ withheld: messageBodies.withheldReason, text: messageBodies.text, html: messageBodies.html })
        .from(messageBodies)
        .where(eq(messageBodies.messageId, husk.id))
        .limit(1);
      if (body?.withheld === "junk_filed") {
        try {
          const fetched = await opened.adapter.fetchByUid(box.junkFolder, [args.uid], {
            maxBytes: JUNK_BODY_MAX_BYTES,
          });
          const c = fetched.uidValidity === args.uidValidity
            ? fetched.creates.find((x) => x.raw !== undefined)
            : undefined;
          raw = (c?.raw as Buffer | undefined) ?? null;
        } catch (err) {
          // Best-effort: an oversize or failed pre-fetch narrows the rescue to the move; the
          // body stays husked and the marker stays TRUE until the move lands (it still names
          // where the bytes live). Logged, never fatal — the user pressed "move", not "fetch".
          deps.logger?.warn?.("junk_rescue_prefetch_failed", { mailboxId: args.mailboxId, err: String(err) });
        }
      }
    }

    // The move itself — epoch-guarded, so a recreated folder's reused UID can never send a
    // STRANGER to the inbox under a stale press.
    await opened.adapter.move({ folder: box.junkFolder, ref }, "INBOX", { requireEpoch: true });
  } catch (err) {
    if (err instanceof MessageGoneError) {
      // The provider (or another client) took it first — or the folder was renumbered. The
      // rescue fails honestly: never a phantom arrival, never a claim of a move that did not
      // happen, and never a different message moved in this one's name.
      throw new ServiceError("junk_message_gone", 410, "this message is no longer in the Junk folder — it may have been deleted there");
    }
    throw err;
  } finally {
    await opened.close().catch(() => { /* socket gone; the slot release has its own guard */ });
  }

  // ── The verdict's reversal made whole: put the husked body back, exactly the
  // fetch-verify-rewrite `redacted-restore.ts` performs (same identity witness, same byte
  // accounting, same one `message` delta). Best-effort AFTER the move — a failure here leaves
  // the rescue done and the husk standing, which the next verdict surface states honestly.
  if (husk !== undefined && raw !== null) {
    try {
      const fresh = await normalizeMime(raw);
      const sameMid = normalizeMessageId(husk.messageIdHeader) !== null
        && normalizeMessageId(husk.messageIdHeader) === normalizeMessageId(fresh.canonical.messageIdHeader);
      if (sameMid) {
        await deps.db.transaction(async (tx) => {
          const [live] = await tx
            .select({ text: messageBodies.text, html: messageBodies.html, withheld: messageBodies.withheldReason })
            .from(messageBodies)
            .where(eq(messageBodies.messageId, husk.id))
            .for("update");
          if (live?.withheld !== "junk_filed") return; // somebody else restored it first
          const storedHtml = prepareHtmlForStorage(fresh.htmlBody);
          const oldBytes = bodyBytesOf({ text: live.text ?? "", html: live.html ?? null });
          await tx.update(messageBodies).set({
            text: fresh.textBody,
            html: storedHtml,
            withheldReason: null,
          }).where(eq(messageBodies.messageId, husk.id));
          await applyBodyBytesDelta(
            tx, accountId,
            bodyBytesOf({ text: fresh.textBody, html: storedHtml }) - oldBytes,
          );
          await tx.update(messages).set({
            snippet: fresh.textBody.replace(/\s+/g, " ").trim().slice(0, 200),
            updatedAt: deps.now?.() ?? new Date(),
          }).where(and(eq(messages.id, husk.id), eq(messages.accountId, accountId)));
          await recordChange(tx, {
            accountId, entityType: "message", entityId: husk.id, op: "update", meta: null,
          });
        });
      }
    } catch (err) {
      deps.logger?.warn?.("junk_rescue_unhusk_failed", { mailboxId: args.mailboxId, err: String(err) });
    }
  }

  // Ring the doorbell (`sync_requested_at`, mail 0049): the worker's ~3 s kick pass ingests the
  // rescued message's new INBOX UID without waiting for the poll. Best-effort — the poll is the
  // floor beneath it either way.
  try {
    await deps.db.update(mailboxes)
      .set({ syncRequestedAt: deps.now?.() ?? new Date() })
      .where(and(eq(mailboxes.id, args.mailboxId), eq(mailboxes.accountId, accountId)));
  } catch (err) {
    deps.logger?.warn?.("junk_rescue_kick_failed", { mailboxId: args.mailboxId, err: String(err) });
  }
  return { status: "rescued" };
}
