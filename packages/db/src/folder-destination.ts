import { and, eq } from "drizzle-orm";
import { folderOps, mailboxFolders, mailboxes } from "./schema-mail.js";
import type { Tx } from "./change-log.js";
import { folderMoveNameError, type InventoryFolder } from "./request-apply.js";

/**
 * WHERE A MOVE INTO A PERSON'S OWN FOLDER MAY GO — one check, asked by the move's door on the install
 * the person pressed on and again, independently, by the organizer for every `message.file` record
 * before it writes anything. The name is untrusted at both: a client sends it, and a record is a
 * message anyone with the mailbox password can append. A folder qualifies only when THIS store lists
 * it for the letter's own mailbox, it is one of the person's own folders, and no folder command
 * stands on it. Nothing here creates a folder, and the answer is the store's own spelling of it.
 */

/**
 * Which canonical paths are NOT one of the person's own folders: core's `userFolderExclusion`
 * (the Imbox, ohmail's six and its tree, the mailbox's Sent), handed in because this package may not
 * import core. Required, so a caller cannot forget it; never restated here.
 */
export type FolderExclusionRule = (path: string, recordedSent: string | null) => string | null;

/** Why a name is not a destination. Each is a closed word; the name itself is never repeated. */
export type FolderDestinationRefusal =
  /** Its shape: not text, empty, too long, a control character or a broken surrogate pair. */
  | "unusable"
  /** Not a person's folder: the Imbox, ohmail's own tree, Sent, or Trash or Junk or a folder under either. */
  | "reserved"
  /** This mailbox of this account lists no folder of exactly that name. */
  | "absent"
  /** A create, rename or delete stands on it, on a folder above or below it, or renames into it. */
  | "busy";

export type FolderDestination =
  | { ok: true; folder: InventoryFolder }
  | { ok: false; refusal: FolderDestinationRefusal };

/** `path` is `base` or a folder under it. A missing base contains nothing. */
function atOrUnder(path: string, base: string | null): boolean {
  return base !== null && base !== "" && (path === base || path.startsWith(`${base}/`));
}

/** The folder commands' own overlap: one path is the other, or one lies under the other. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Find `name` in the person's own folders of one mailbox, in the caller's transaction. The order is
 * the check's: the name's shape, the mailbox (its Sent, Trash and Junk), the reserved places before
 * any inventory read, the exact row, then the folder commands. Exact means exact: no trim, case fold,
 * normalization or delimiter mapping, and the match is an SQL parameter. No lock is taken: a folder
 * command enqueued after this answer retargets or retires the pending move itself.
 */
export async function resolveFolderDestination(
  tx: Tx, scope: { accountId: string; mailboxId: string }, name: unknown, exclusion: FolderExclusionRule,
): Promise<FolderDestination> {
  if (folderMoveNameError(name) !== null) return { ok: false, refusal: "unusable" };
  const path = name as string;

  const [mb] = await tx.select({
    sentFolder: mailboxes.sentFolder, trashFolder: mailboxes.trashFolder, junkFolder: mailboxes.junkFolder,
  }).from(mailboxes)
    .where(and(eq(mailboxes.id, scope.mailboxId), eq(mailboxes.accountId, scope.accountId)))
    .limit(1);
  if (!mb) return { ok: false, refusal: "absent" };

  if (exclusion(path, mb.sentFolder) !== null
    || atOrUnder(path, mb.trashFolder) || atOrUnder(path, mb.junkFolder)) {
    return { ok: false, refusal: "reserved" };
  }

  const [row] = await tx.select({ folder: mailboxFolders.folder }).from(mailboxFolders)
    .where(and(
      eq(mailboxFolders.mailboxId, scope.mailboxId),
      eq(mailboxFolders.accountId, scope.accountId),
      eq(mailboxFolders.folder, path),
    ))
    .limit(1);
  if (!row) return { ok: false, refusal: "absent" };

  // Any status: a failed command stands until it is dismissed, and its folder is not settled either.
  const ops = await tx.select({ subject: mailboxFolders.folder, to: folderOps.toFolder }).from(folderOps)
    .innerJoin(mailboxFolders, eq(mailboxFolders.id, folderOps.folderId))
    .where(and(eq(folderOps.mailboxId, scope.mailboxId), eq(folderOps.accountId, scope.accountId)));
  if (ops.some((op) => overlaps(op.subject, row.folder) || (op.to !== null && overlaps(op.to, row.folder)))) {
    return { ok: false, refusal: "busy" };
  }

  // THE ONE PLACE A PATH BECOMES A DESTINATION: the row's own value, found above.
  return { ok: true, folder: row.folder as InventoryFolder };
}
