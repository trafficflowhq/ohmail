import type { Logger } from "@trafficflow/core/mail";
import { epochOf, parseRef, sameEpoch, type FolderKeys, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { specialFoldersOf } from "./junk-filing.js";

/**
 * THE JUNK CHECK. A spam verdict files the letter into the provider's Junk and drops its watched
 * record, so the folder scan (which never reads Junk) cannot see it deleted there, and the reaper
 * exempts it by design. This pass asks the server only whether the UIDs ohmail filed are still
 * there, and tombstones the ones proved gone under the same UIDVALIDITY. Nothing from Junk is
 * ingested, counted or listed. Any unanswered, renumbered or missing reading deletes nothing.
 */

/** Rows asked about per cycle: the reaper's own bound. */
export const JUNK_GONE_PAGE = 200;

type Keyed = FolderKeys & { folder: string };
/** Per connection: the keys of the last walk that read the whole set while Junk stood still. */
const proofByAdapter = new WeakMap<MailboxAdapter, Keyed>();
/** Per connection: the keys the walk in progress started under. */
const walkByAdapter = new WeakMap<MailboxAdapter, Keyed>();
/** Per connection: the last unproved reading logged, so a standing one is logged once. */
const loggedByAdapter = new WeakMap<MailboxAdapter, string>();
/** Per connection: where a paged walk resumes. */
const cursorByAdapter = new WeakMap<MailboxAdapter, string>();

export interface JunkGoneDeps {
  repo: WorkerRepo;
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  /** The cycle's fenced group; the tombstone commits or vanishes with the fence. */
  write: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  log?: Logger;
  page?: number;
}

export interface JunkGoneResult {
  asked: number;
  tombstoned: number;
  /** Why nothing was asked, when nothing was. */
  skipped?: "no_junk" | "unsupported" | "unchanged" | "unanswered" | "renumbered" | "absent";
}

export async function junkGonePass(deps: JunkGoneDeps): Promise<JunkGoneResult> {
  const { repo, adapter, accountId, mailboxId, log } = deps;
  if (typeof repo.listJunkParked !== "function" || typeof repo.tombstoneJunkParkedGone !== "function"
    || !adapter.folderKeys || !adapter.uidsHeld) return { asked: 0, tombstoned: 0, skipped: "unsupported" };
  const folder = (await specialFoldersOf(repo, mailboxId)).junkFolder;
  if (folder === null) return { asked: 0, tombstoned: 0, skipped: "no_junk" };

  const keys = await adapter.folderKeys(folder);
  if (keys.k !== "keys") return refuse(deps, keys.k === "absent" ? "absent" : "unanswered");
  if (sameKeys(proofByAdapter.get(adapter), folder, keys.keys)) return { asked: 0, tombstoned: 0, skipped: "unchanged" };

  const limit = deps.page ?? JUNK_GONE_PAGE;
  // A cursor into another folder's walk is stale: start again from the top.
  const after = walkByAdapter.get(adapter)?.folder === folder ? cursorByAdapter.get(adapter) : undefined;
  if (after === undefined) {
    cursorByAdapter.delete(adapter);
    walkByAdapter.set(adapter, { ...keys.keys, folder });
  }
  const rows = await repo.listJunkParked(accountId, mailboxId, { folder, limit, ...(after !== undefined ? { afterId: after } : {}) });
  const full = rows.length >= limit;
  // Only rows filed under the live epoch get a verdict; the others wait for the resync.
  const epoch = epochOf(keys.keys.uidValidity);
  const asked = rows.filter((r) => {
    const at = parseRef(r.locator.ref);
    return Number.isSafeInteger(at.uid) && at.uid > 0 && sameEpoch(epochOf(at.uidValidity), epoch);
  });
  let tombstoned = 0;
  if (asked.length > 0) {
    const held = await adapter.uidsHeld(folder, keys.keys.uidValidity, asked.map((r) => parseRef(r.locator.ref).uid));
    if (held.k !== "held") return refuse(deps, held.k === "renumbered" ? "renumbered" : held.k === "absent" ? "absent" : "unanswered");
    const gone = asked.filter((r) => !held.present.has(parseRef(r.locator.ref).uid));
    if (gone.length > 0) {
      tombstoned = await deps.write((r) => r.tombstoneJunkParkedGone!(accountId, mailboxId, gone));
    }
  }
  if (full) cursorByAdapter.set(adapter, rows[rows.length - 1]!.messageId);
  else {
    // The walk read every filed letter; UIDNEXT only grows, so equal keys mean Junk stood still.
    if (sameKeys(walkByAdapter.get(adapter), folder, keys.keys)) proofByAdapter.set(adapter, { ...keys.keys, folder });
    cursorByAdapter.delete(adapter);
    walkByAdapter.delete(adapter);
  }
  loggedByAdapter.delete(adapter);
  if (tombstoned > 0) {
    log?.info("sync_junk_gone_tombstoned", {
      mailboxId, accountId, asked: asked.length, tombstoned,
      reason: "letters ohmail filed into Junk were deleted there by another client; their copies leave",
    });
  }
  return { asked: asked.length, tombstoned };
}

function sameKeys(k: Keyed | undefined, folder: string, now: FolderKeys): boolean {
  return k !== undefined && k.folder === folder && sameEpoch(epochOf(k.uidValidity), epochOf(now.uidValidity))
    && k.uidNext === now.uidNext && k.messages === now.messages;
}

function refuse(deps: JunkGoneDeps, why: "unanswered" | "renumbered" | "absent"): JunkGoneResult {
  if (loggedByAdapter.get(deps.adapter) === why) return { asked: 0, tombstoned: 0, skipped: why };
  loggedByAdapter.set(deps.adapter, why);
  deps.log?.info("sync_junk_gone_unproved", {
    mailboxId: deps.mailboxId, accountId: deps.accountId, outcome: why,
    reason: "the Junk folder could not be read whole under the epoch ohmail filed into, so nothing was deleted",
  });
  return { asked: 0, tombstoned: 0, skipped: why };
}
