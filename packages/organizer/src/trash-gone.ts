import type { Logger } from "@trafficflow/core/mail";
import { epochOf, parseRef, sameEpoch, type FolderKeys, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { TrashGoneRow, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { specialFoldersOf } from "./junk-filing.js";

/**
 * THE TRASH CHECK. A landed delete parks the letter in the provider's Trash with no watched copy,
 * and the folder walk never reads Trash, so a letter another client then removed from Trash stayed
 * in ohmail's Trash with its text. This pass asks the server only whether the UIDs ohmail parked are
 * still there, and drops the ones proved gone under the same UIDVALIDITY: the Trash row goes and the
 * body is emptied. A letter parked at a copy outside Trash (Gmail drops a deleted letter's labels, so
 * the copy the park promoted is already gone) is asked by its Message-ID instead, and only a Trash
 * holding no letter that carries it lets it go: a forged id can keep a letter, never take one. Any
 * unanswered, renumbered or missing reading drops nothing.
 */

/** Rows asked about per visit: the reaper's own bound. */
export const TRASH_GONE_PAGE = 200;

type Keyed = FolderKeys & { folder: string };
/* Per connection, and apart from the Junk check's: one shared map would reset the other's walk. */
const proofByAdapter = new WeakMap<MailboxAdapter, Keyed>();
const walkByAdapter = new WeakMap<MailboxAdapter, Keyed>();
const loggedByAdapter = new WeakMap<MailboxAdapter, string>();
const cursorByAdapter = new WeakMap<MailboxAdapter, string>();

/**
 * A filing parked a letter in Trash after this visit's check (a Restore put back, a delete settled
 * on a dropped copy): the next visit reads Trash again instead of skipping it as unchanged.
 */
export function forgetTrashProof(adapter: MailboxAdapter): void {
  proofByAdapter.delete(adapter);
}

export interface TrashGoneDeps {
  repo: WorkerRepo;
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  /** The cycle's fenced group; the drop commits or vanishes with the fence. */
  write: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  log?: Logger;
  page?: number;
}

export interface TrashGoneResult {
  asked: number;
  dropped: number;
  /** Why nothing was asked, when nothing was. */
  skipped?: "no_trash" | "unsupported" | "unchanged" | "unanswered" | "renumbered" | "absent";
}

export async function trashGonePass(deps: TrashGoneDeps): Promise<TrashGoneResult> {
  const { repo, adapter, accountId, mailboxId, log } = deps;
  if (typeof repo.listTrashParked !== "function" || typeof repo.dropGoneFromTrash !== "function"
    || !adapter.folderKeys || !adapter.uidsHeld) return { asked: 0, dropped: 0, skipped: "unsupported" };
  const folder = (await specialFoldersOf(repo, mailboxId)).trashFolder;
  if (folder === null) return { asked: 0, dropped: 0, skipped: "no_trash" };

  const keys = await adapter.folderKeys(folder);
  if (keys.k !== "keys") return refuse(deps, keys.k === "absent" ? "absent" : "unanswered");
  if (sameKeys(proofByAdapter.get(adapter), folder, keys.keys)) return { asked: 0, dropped: 0, skipped: "unchanged" };

  const limit = deps.page ?? TRASH_GONE_PAGE;
  const after = walkByAdapter.get(adapter)?.folder === folder ? cursorByAdapter.get(adapter) : undefined;
  if (after === undefined) {
    cursorByAdapter.delete(adapter);
    walkByAdapter.set(adapter, { ...keys.keys, folder });
  }
  const rows = await repo.listTrashParked(accountId, mailboxId, { folder, limit, ...(after !== undefined ? { afterId: after } : {}) });
  const full = rows.length >= limit;
  const uidValidity = keys.keys.uidValidity;
  // At a Trash UID: only rows parked under the live epoch get a verdict.
  const epoch = epochOf(uidValidity);
  const byUid = rows.filter((r) => {
    if (r.locator.folder !== folder) return false;
    const at = parseRef(r.locator.ref);
    return Number.isSafeInteger(at.uid) && at.uid > 0 && sameEpoch(epochOf(at.uidValidity), epoch);
  });
  // At a copy outside Trash: asked by Message-ID, when the letter has one.
  const byId = adapter.messageIdsGone ? rows.filter((r) => r.locator.folder !== folder && r.messageIdHeader !== null) : [];
  const gone: TrashGoneRow[] = [];
  if (byUid.length > 0) {
    const held = await adapter.uidsHeld(folder, uidValidity, byUid.map((r) => parseRef(r.locator.ref).uid));
    if (held.k !== "held") return refuse(deps, held.k);
    for (const r of byUid) if (!held.present.has(parseRef(r.locator.ref).uid)) gone.push({ ...r, expectDesired: folder });
  }
  if (byId.length > 0) {
    const read = await adapter.messageIdsGone!(folder, uidValidity, byId.map((r) => r.messageIdHeader!));
    if (read.k !== "read") return refuse(deps, read.k);
    for (const r of byId) if (read.gone.has(r.messageIdHeader!)) gone.push({ ...r, expectDesired: folder });
  }
  let dropped = 0;
  if (gone.length > 0) dropped = (await deps.write((r) => r.dropGoneFromTrash!(accountId, mailboxId, folder, gone))).length;
  if (full) cursorByAdapter.set(adapter, rows[rows.length - 1]!.messageId);
  else {
    // The walk read every parked letter; UIDNEXT only grows, so equal keys mean Trash stood still.
    if (sameKeys(walkByAdapter.get(adapter), folder, keys.keys)) proofByAdapter.set(adapter, { ...keys.keys, folder });
    cursorByAdapter.delete(adapter);
    walkByAdapter.delete(adapter);
  }
  loggedByAdapter.delete(adapter);
  const asked = byUid.length + byId.length;
  if (dropped > 0) {
    log?.info("sync_trash_gone_dropped", {
      mailboxId, accountId, examined: asked, dropped,
      reason: "letters deleted in ohmail were removed from Trash by another client; they leave Trash",
    });
  }
  return { asked, dropped };
}

function sameKeys(k: Keyed | undefined, folder: string, now: FolderKeys): boolean {
  return k !== undefined && k.folder === folder && sameEpoch(epochOf(k.uidValidity), epochOf(now.uidValidity))
    && k.uidNext === now.uidNext && k.messages === now.messages;
}

function refuse(deps: TrashGoneDeps, why: "unanswered" | "renumbered" | "absent"): TrashGoneResult {
  if (loggedByAdapter.get(deps.adapter) === why) return { asked: 0, dropped: 0, skipped: why };
  loggedByAdapter.set(deps.adapter, why);
  deps.log?.info("sync_trash_gone_unproved", {
    mailboxId: deps.mailboxId, accountId: deps.accountId, outcome: why,
    reason: "the Trash folder could not be read whole under the epoch ohmail parked into, so nothing was dropped",
  });
  return { asked: 0, dropped: 0, skipped: why };
}
