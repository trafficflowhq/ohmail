import { and, eq, inArray } from "drizzle-orm";
import { mailboxes, messages } from "@trafficflow/db";
import {
  FOLDER_PAGE_MAX, MessageGoneError, makeRef, type FolderPageItem,
} from "@trafficflow/core/adapters/imap";
import { normalizeMime } from "@trafficflow/core";
import { ServiceError, foldersEnabled } from "@trafficflow/services/mail";
import { openMailboxImap } from "./attachments-adapter.js";
import type { ApiDeps } from "./deps.js";

/**
 * ═══ THE JUNK WINDOW — a live, UN-MIRRORED view of the provider's own \Junk ═══════════════════
 *
 * FOLDERS-SPEC.md §16.2: the Screener's third segment becomes a window into the mailbox's native
 * Junk folder. The DEFINING property is that Junk never enters `messages` or any client mirror —
 * the window reads the folder itself, on request, bounded. Everything in this module is a SELECT
 * over rows the account already owns plus a short-lived, admission-capped IMAP read; the ONLY
 * writes are (a) the user-commanded "Not junk" MOVE on the user's own server — one of the three
 * writes `imap-types.ts`'s carve-out licenses — and (b) the `sync_requested_at` doorbell stamp
 * that follows it, so the rescued message re-enters the normal pipeline within seconds instead
 * of a poll interval. No `messages` row, no `message_bodies` row, no mirror entity is ever
 * written here, and `junk-window.test.ts` counts the tables to keep it that way.
 *
 * ── WHY THE API DIALS DIRECTLY INSTEAD OF QUEUEING ON THE WORKER ────────────────────────────
 *
 * The architecture rule draws its line at applying ORGANIZATION: moves defer to the worker via
 * desired state so a serverless function can never leave a mailbox half-moved, while on-demand
 * reads that store nothing — attachment fetch, the gated send — already open a short-lived
 * connection. A junk LIST/BODY read
 * is exactly that second shape: on-demand, short-lived, nothing stored. The API↔worker seam is a
 * database stamp polled every ~3 s (`sync-kick.ts`) — routing an interactive read through it
 * would add seconds of latency per page AND a result channel that marshals junk headers/bodies
 * through the database, which is precisely the storage the window exists to avoid. So the reads
 * go through {@link openMailboxImap}, the SAME admission-capped, budget-counted door every other
 * API dial uses (`MAX_IMAP_PER_MAILBOX` — the worker's own connection is priced into that
 * budget), and the connection is closed before the response leaves.
 *
 * ── THE RESCUE RE-ENTERS THROUGH THE PIPELINE, NOT AROUND IT (§16.2/G3) ─────────────────────
 *
 * "Not junk" performs one server-side move OUT of Junk into INBOX — which is what un-trains the
 * provider's filter — and then does NOTHING else: the message's next appearance is a new UID in
 * a watched folder, which the worker ingests like any arrival. An unknown sender therefore waits
 * in the Screener; an allowed sender lands in the Ohbox. No special-case filing exists to test,
 * because none exists at all. A message the provider expunged mid-flight fails HONESTLY:
 * `MessageGoneError` → 410, never a phantom.
 */

/** The junk body read's transfer ceiling — a bounded window never pulls a 90 MB spam payload. */
export const JUNK_BODY_MAX_BYTES = 2_000_000;

/** One row of the merged window list, origin attributed. */
export interface JunkItem extends FolderPageItem {
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
  /** Opaque older-page cursor (per-mailbox UID watermarks); null when every window is drained. */
  nextCursor: string | null;
}

/** The opaque cursor: base64url JSON of {mailboxId → beforeUid}. Malformed input is a 400. */
function parseCursor(raw: string | undefined): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new Error("shape");
      out[k] = v;
    }
    return out;
  } catch {
    throw new ServiceError("validation_failed", 400, "cursor is not a junk-window cursor");
  }
}

function mintCursor(map: Record<string, number>): string | null {
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

/** The account's mailboxes with their resolved junk paths — ownership by scoping, never by trust. */
async function junkMailboxesOf(
  deps: ApiDeps, accountId: string, mailboxId?: string,
): Promise<Array<{ id: string; address: string; junkFolder: string | null }>> {
  const rows = await deps.db
    .select({ id: mailboxes.id, address: mailboxes.address, junkFolder: mailboxes.junkFolder })
    .from(mailboxes)
    .where(mailboxId === undefined
      ? eq(mailboxes.accountId, accountId)
      : and(eq(mailboxes.accountId, accountId), eq(mailboxes.id, mailboxId)));
  if (mailboxId !== undefined && rows.length === 0) {
    throw new ServiceError("not_found", 404, "mailbox not found");
  }
  return rows;
}

/**
 * The LIST page: newest-{@link FOLDER_PAGE_MAX} headers per mailbox window, merged newest-first,
 * origin-attributed against the mirror's verdict locators. Reads only; writes nothing.
 */
export async function listJunk(
  deps: ApiDeps, accountId: string, opts: { cursor?: string } = {},
): Promise<JunkPage> {
  await requireFolders(deps, accountId);
  const before = parseCursor(opts.cursor);
  const boxes = await junkMailboxesOf(deps, accountId);

  const states: JunkMailboxState[] = [];
  const items: JunkItem[] = [];
  const nextBefore: Record<string, number> = {};

  for (const box of boxes) {
    if (box.junkFolder === null) {
      states.push({ id: box.id, address: box.address, window: "no_junk_folder" });
      continue;
    }
    try {
      const opened = await openMailboxImap(deps, box.id);
      try {
        const page = await opened.adapter.listFolderPage(box.junkFolder, {
          limit: FOLDER_PAGE_MAX,
          ...(before[box.id] !== undefined ? { beforeUid: before[box.id] } : {}),
        });
        if (page === null) {
          // The recorded junk path no longer opens — the same honest degrade as no folder.
          states.push({ id: box.id, address: box.address, window: "no_junk_folder" });
          continue;
        }
        states.push({ id: box.id, address: box.address, window: "ok" });
        for (const it of page.items) {
          items.push({ ...it, mailboxId: box.id, uidValidity: page.uidValidity, origin: "provider" });
        }
        if (page.nextBeforeUid !== null) nextBefore[box.id] = page.nextBeforeUid;
      } finally {
        await opened.close().catch(() => { /* socket gone; slot released by close's own guard */ });
      }
    } catch (err) {
      deps.logger?.warn?.("junk_window_read_failed", { mailboxId: box.id, err: String(err) });
      states.push({ id: box.id, address: box.address, window: "unreachable" });
    }
  }

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

  // Merged newest-first across mailboxes; undated rows sink, matching the mirror's comparators.
  items.sort((a, b) => (Date.parse(b.date ?? "") || 0) - (Date.parse(a.date ?? "") || 0));
  return { mailboxes: states, items, nextCursor: mintCursor(nextBefore) };
}

/**
 * The BODY on open — fetched live, parsed, returned as TEXT, never persisted and never HTML:
 * junk is the one pile whose bodies are hostile by definition, and a plain-text rendering loads
 * no remote content, runs no markup, and fires no tracker. The session cache is the client's.
 */
export async function junkBody(
  deps: ApiDeps, accountId: string, args: { mailboxId: string; uid: number },
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
    await opened.close().catch(() => { /* socket gone; slot released by close's own guard */ });
  }
}

/**
 * "NOT JUNK" — the rescue (§16.2/G3): ONE user-commanded move OUT of Junk, back to INBOX, then
 * the doorbell. Re-entry is the worker's ordinary ingest of a new INBOX UID — the normal
 * pipeline, so an unknown sender waits in the Screener and an allowed one lands in the Ohbox.
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
  const opened = await openMailboxImap(deps, args.mailboxId);
  try {
    await opened.adapter.move(
      { folder: box.junkFolder, ref: makeRef(args.uidValidity, args.uid) },
      "INBOX",
    );
  } catch (err) {
    if (err instanceof MessageGoneError) {
      // The provider (or another client) took it first. The rescue fails honestly — never a
      // phantom arrival, never a claim of a move that did not happen.
      throw new ServiceError("junk_message_gone", 410, "this message is no longer in the Junk folder — it may have been deleted there");
    }
    throw err;
  } finally {
    await opened.close().catch(() => { /* socket gone; slot released by close's own guard */ });
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
