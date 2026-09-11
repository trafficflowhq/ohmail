import { and, eq, inArray, isNull } from "drizzle-orm";
// `@trafficflow/core/mail`, NOT the default barrel: this module rides into the desktop
// ENGINE bundle through `sync-service.ts`, and the default barrel puts the classifier and the
// drafter (and, through them, the private cloud schema) into esbuild's input graph — which the
// engine's private-input gate refuses outright (`scripts/engine-bundle.mjs`). The mail barrel
// is the vocabulary half, exactly what imap-types.ts does internally for the same reason.
import { DESTINATIONS } from "@trafficflow/core/mail";
// The Sent shape's single source — see its export for the two readers and their stakes.
import { SENT_SHAPED_CANONICAL } from "@trafficflow/core/adapters/imap-types";
import { accountSettings, folderOps, mailboxFolders, mailboxes } from "@trafficflow/db";
import type { Db } from "./context.js";

/**
 * The user's own folders, as the server knows them (FOLDERS-SPEC.md §2/§4). `mailbox_folders` is
 * the worker's cursor table, already post-exclusion. Left to exclude HERE: the organized six, the
 * `ohmail` namespace, and THE SENT FOLDER — an open edge: the worker resolves Sent at connect and
 * does not persist the answer, so this module can only recognise Sent-SHAPED paths; the residual
 * appears as a user folder until the resolved path is persisted beside `mailboxes.junk_folder`.
 * STALENESS is the second edge: rows are never deleted, so a folder renamed elsewhere reads as a
 * PHANTOM until discovery learns to prune — bounded and honest: a phantom renders EMPTY, never
 * with another folder's mail. Nothing here writes to the mailbox.
 */

/**
 * Sent-shaped canonical paths, at top level or under the INBOX prefix — `SENT_BY_NAME`
 * (imap.ts) plus the German localized family the SPECIAL-USE resolver can surface. Deliberately
 * NOT matching nested forms (`Alternativen/Sent Messages` is a folder the user keeps, and the
 * resolver would never pick it): the anchor covers exactly the places a resolved Sent can live.
 */
const SENT_SHAPED = SENT_SHAPED_CANONICAL;

/** The `ohmail` namespace, in canonical form, at any depth — imap-types' spelling. */
const OHMAIL_SEGMENT = /(?:^|\/)ohmail(?:\/|$)/i;

/**
 * Why this `mailbox_folders` row is NOT one of the user's own folders, or `null` when it IS —
 * `passiveFolderExclusion`'s answer shape, for its reason: a folder that did not become an
 * entity should be explainable in a sentence, not a boolean.
 */
export function userFolderExclusion(path: string): string | null {
  if (path.toUpperCase() === "INBOX") return "it is the Imbox";
  if ((DESTINATIONS as readonly string[]).includes(path)) {
    return "it is one of the folders ohmail organizes";
  }
  if (OHMAIL_SEGMENT.test(path)) return "it is inside the ohmail namespace";
  if (SENT_SHAPED.test(path)) return "it is the mailbox's Sent folder";
  return null;
}

/**
 * A pending or failed user COMMAND on this folder (`folder_ops`, mail 0074) — what lets every
 * client render "creating…" / "renaming to X…" / "deleting…" honestly instead of pretending
 * the mailbox already changed, and carry a refusal's closed code until it is dismissed.
 */
export interface UserFolderOp {
  kind: "create" | "rename" | "delete";
  /** The rename's target canonical path; null for the other two. */
  to: string | null;
  /** Closed refusal code when the worker failed the command; null while pending. */
  error: string | null;
}

export interface UserFolderRow {
  /** The `mailbox_folders` row id — the `folder` entity's id on the wire. */
  id: string;
  /** Canonical `/`-joined path — the natural key, the spelling messages carry. */
  folder: string;
  mailboxId: string;
  /** The owning mailbox's address — the rail's section label when 2+ mailboxes exist. */
  address: string;
  updatedAt: Date;
  /** The in-flight user command, or null when the folder is settled (see {@link UserFolderOp}). */
  op: UserFolderOp | null;
}

/** The op columns every read below selects — one spelling, so no read can drift. */
const OP_SELECTION = {
  opKind: folderOps.op,
  opTo: folderOps.toFolder,
  opStatus: folderOps.status,
  opError: folderOps.error,
} as const;

type OpColumns = { opKind: string | null; opTo: string | null; opStatus: string | null; opError: string | null };

/** One row's op columns → {@link UserFolderOp} (or null when no op row joined). */
function opOf(r: OpColumns): UserFolderOp | null {
  if (r.opKind !== "create" && r.opKind !== "rename" && r.opKind !== "delete") return null;
  return {
    kind: r.opKind,
    to: r.opTo,
    error: r.opStatus === "failed" ? (r.opError ?? "refused") : null,
  };
}

/**
 * Every user folder of the account, post-exclusion — the rows `/sync` materializes as `folder`
 * entities and `setFoldersEnabled` writes change rows for. One query, account-scoped through the
 * mailbox join; deterministic order (by path) so two reads of one state emit the same sequence.
 * Per-mailbox participation (mail 0073, spec §17): a mailbox whose `folders_disabled_at` is set
 * contributes NOTHING here — not to the snapshot, not to the master toggle's transition rows, not
 * to the rail. NULL means participate, the default. The filter lives on THIS read (and its two
 * per-row siblings) rather than at each call site, so no emitter can forget it.
 */
export async function listUserFolders(db: Db, accountId: string): Promise<UserFolderRow[]> {
  const rows = await db
    .select({
      id: mailboxFolders.id,
      folder: mailboxFolders.folder,
      mailboxId: mailboxFolders.mailboxId,
      address: mailboxes.address,
      updatedAt: mailboxFolders.updatedAt,
      ...OP_SELECTION,
    })
    .from(mailboxFolders)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxFolders.mailboxId))
    .leftJoin(folderOps, eq(folderOps.folderId, mailboxFolders.id))
    .where(and(eq(mailboxes.accountId, accountId), isNull(mailboxes.foldersDisabledAt)));
  return rows
    .filter((r) => userFolderExclusion(r.folder) === null)
    .map((r) => ({ ...r, op: opOf(r) }))
    .sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
}

/**
 * ONE mailbox's user folders, post-exclusion, WITHOUT the participation filter — the
 * per-mailbox toggle's transition read (`setMailboxFoldersEnabled`), and only its. The writer
 * needs the list on BOTH edges: switching a mailbox OFF must tombstone folders the filtered
 * read no longer answers, and switching it ON must emit creates the instant after the column
 * flips. Account-scoped through the join like every read here; never exported to an emitter —
 * the wire reads stay on the filtered three.
 */
export async function listMailboxUserFolders(
  db: Db, accountId: string, mailboxId: string,
): Promise<UserFolderRow[]> {
  const rows = await db
    .select({
      id: mailboxFolders.id,
      folder: mailboxFolders.folder,
      mailboxId: mailboxFolders.mailboxId,
      address: mailboxes.address,
      updatedAt: mailboxFolders.updatedAt,
      ...OP_SELECTION,
    })
    .from(mailboxFolders)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxFolders.mailboxId))
    .leftJoin(folderOps, eq(folderOps.folderId, mailboxFolders.id))
    .where(and(eq(mailboxes.accountId, accountId), eq(mailboxFolders.mailboxId, mailboxId)));
  return rows
    .filter((r) => userFolderExclusion(r.folder) === null)
    .map((r) => ({ ...r, op: opOf(r) }))
    .sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
}

/**
 * The account's switched-OFF mailboxes, as `{ mailboxId: instant }` — `GET /consent`'s
 * per-mailbox answer (FOLDERS-SPEC.md §17). Only the EXCEPTIONS travel: a mailbox absent from
 * the map participates, which is what NULL means in the column and what an older client that
 * never reads the field assumes anyway. The instant rather than a boolean for the same reason
 * every consent stamp keeps its instant — "when was this switched off" is the support
 * question.
 */
export async function mailboxFoldersOff(
  db: Db, accountId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ id: mailboxes.id, at: mailboxes.foldersDisabledAt })
    .from(mailboxes)
    .where(eq(mailboxes.accountId, accountId));
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.at !== null) out[r.id] = r.at.toISOString();
  }
  return out;
}

/**
 * Is "Use folders" on for this account? NULL, no row, and a failed read all mean OFF — the
 * column's own rule, applied at the one place `/sync` asks.
 */
export async function foldersEnabled(db: Db, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ at: accountSettings.foldersEnabledAt })
    .from(accountSettings)
    .where(eq(accountSettings.accountId, accountId))
    .limit(1);
  return (row?.at ?? null) !== null;
}

/**
 * One user-folder row by entity id, account-scoped — the delta materializer's read. `null` for
 * a row that is gone, excluded, or another account's: all three drain as delete tombstones,
 * which is the safe answer for each.
 */
export async function userFolderById(
  db: Db, accountId: string, id: string,
): Promise<UserFolderRow | null> {
  const [r] = await db
    .select({
      id: mailboxFolders.id,
      folder: mailboxFolders.folder,
      mailboxId: mailboxFolders.mailboxId,
      address: mailboxes.address,
      updatedAt: mailboxFolders.updatedAt,
      ...OP_SELECTION,
    })
    .from(mailboxFolders)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxFolders.mailboxId))
    .leftJoin(folderOps, eq(folderOps.folderId, mailboxFolders.id))
    .where(and(
      eq(mailboxFolders.id, id),
      eq(mailboxes.accountId, accountId),
      // A switched-off mailbox's folder is a fourth null — drained as a tombstone like the
      // other three, which is exactly what the per-mailbox OFF means on the wire (§17).
      isNull(mailboxes.foldersDisabledAt),
    ))
    .limit(1);
  if (!r) return null;
  return userFolderExclusion(r.folder) === null ? { ...r, op: opOf(r) } : null;
}

/**
 * MANY user-folder rows by entity id in ONE query — the delta page's read, born of a production
 * measurement: `GET /sync` used to call {@link userFolderById} PER ROW, so the page a "Use
 * folders" enable writes (527 creates on the first mailbox this shipped to) cost ~1 000 serial
 * round trips and 30+ seconds of a 60-second budget — the rail sat empty, which read as "the
 * switch does nothing". Same joins, scope, participation filter as the per-row read — batched. An
 * id that is gone, excluded, or another account's is absent from the map, drained as the delete
 * tombstone the per-row null meant.
 */
export async function userFoldersByIds(
  db: Db, accountId: string, ids: readonly string[],
): Promise<Map<string, UserFolderRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: mailboxFolders.id,
      folder: mailboxFolders.folder,
      mailboxId: mailboxFolders.mailboxId,
      address: mailboxes.address,
      updatedAt: mailboxFolders.updatedAt,
      ...OP_SELECTION,
    })
    .from(mailboxFolders)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxFolders.mailboxId))
    .leftJoin(folderOps, eq(folderOps.folderId, mailboxFolders.id))
    .where(and(
      inArray(mailboxFolders.id, ids as string[]),
      eq(mailboxes.accountId, accountId),
      isNull(mailboxes.foldersDisabledAt),
    ));
  const out = new Map<string, UserFolderRow>();
  for (const r of rows) {
    if (userFolderExclusion(r.folder) === null) out.set(r.id, { ...r, op: opOf(r) });
  }
  return out;
}
