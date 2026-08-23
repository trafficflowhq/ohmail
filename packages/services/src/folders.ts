import { and, eq } from "drizzle-orm";
// `@trafficflow/core/mail`, NOT the default barrel: this module rides into the desktop
// ENGINE bundle through `sync-service.ts`, and the default barrel puts the classifier and the
// drafter (and, through them, the private cloud schema) into esbuild's input graph — which the
// engine's private-input gate refuses outright (`scripts/engine-bundle.mjs`). The mail barrel
// is the vocabulary half, exactly what imap-types.ts does internally for the same reason.
import { DESTINATIONS } from "@trafficflow/core/mail";
import { accountSettings, mailboxFolders, mailboxes } from "@trafficflow/db";
import type { Db } from "./context.js";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE USER'S OWN FOLDERS, AS THE SERVER KNOWS THEM — the folders foundation's inventory read
   (FOLDERS-SPEC.md §2/§4).

   `mailbox_folders` is the worker's cursor table: one row per folder the sync actually reads —
   the organized six, the mailbox's resolved Sent folder, and every passive folder that survived
   `passiveFolderExclusion` (packages/core/src/adapters/imap-types.ts). So the rows are ALREADY
   post-exclusion for everything the discovery could see: the provider's Junk/Trash/Drafts,
   Gmail's virtual folders and the `ohmail` namespace never got a cursor in the first place.

   What is left to exclude HERE, reading only what the database holds:

     · the organized six (`DESTINATIONS`) — they are the product's spine, never "a folder";
     · the `ohmail` namespace, belt-and-braces (discovery already refuses it, including the
       namespace-prefixed forms);
     · THE SENT FOLDER — one of two genuinely open edges (the other is staleness, below). The worker resolves it at connect
       (SPECIAL-USE, then imap.ts's `SENT_BY_NAME`) and does NOT persist the answer, so this
       module cannot ask "which row is Sent" — it can only recognise Sent-shaped paths. The
       belt below covers every form the resolver itself can produce for the English names plus
       the localized German family, which covers both production mailboxes (measured 2026-08-23:
       `INBOX/Sent` and `INBOX/Sent Messages`). The residual — a Sent folder advertising
       SPECIAL-USE under a name neither belt knows — would appear as a user folder until the
       proper fix lands: persist the resolved Sent path beside `mailboxes.junk_folder` /
       `trash_folder` (mail 0065's discovery already stands at the right seam). That column is
       the sync lane's to grow; this comment is the hand-off.

   STALENESS — the second open edge, and the second half of the same hand-off. `mailbox_folders`
   rows are never deleted: a folder renamed or removed in another IMAP client stops appearing in
   the worker's cursor writes but keeps its row, so this read emits it as a PHANTOM (a rename
   emits old and new both) until the worker's discovery learns to prune disappeared rows and
   emit the matching `folder` delete tombstones. That prune belongs beside the discovery that
   writes the rows (`apps/worker/src/sync.ts`, the sync lane's hot path — not this module's),
   and until it lands the phantom is bounded and honest in one direction: a phantom folder
   renders EMPTY (its messages moved with the rename, the passive read adopts them under the
   new path), never with another folder's mail, and a re-toggle or re-bootstrap after the prune
   lands clears it. The IMAP-master rule is unbroken — nothing here writes to the mailbox —
   but the inventory's answer can lag the mailbox by exactly this class of row.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Sent-shaped canonical paths, at top level or under the INBOX prefix — `SENT_BY_NAME`
 * (imap.ts) plus the German localized family the SPECIAL-USE resolver can surface. Deliberately
 * NOT matching nested forms (`Alternativen/Sent Messages` is a folder the user keeps, and the
 * resolver would never pick it): the anchor covers exactly the places a resolved Sent can live.
 */
const SENT_SHAPED =
  /^(inbox\/)?(sent([ -](items|messages|mail))?|gesendet(e[ -](objekte|elemente|nachrichten))?)$/i;

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

export interface UserFolderRow {
  /** The `mailbox_folders` row id — the `folder` entity's id on the wire. */
  id: string;
  /** Canonical `/`-joined path — the natural key, the spelling messages carry. */
  folder: string;
  mailboxId: string;
  /** The owning mailbox's address — the rail's section label when 2+ mailboxes exist. */
  address: string;
  updatedAt: Date;
}

/**
 * Every user folder of the account, post-exclusion — the rows `/sync` materializes as `folder`
 * entities and `setFoldersEnabled` writes change rows for. One query, account-scoped through
 * the mailbox join; deterministic order (by path) so two reads of the same state emit the same
 * sequence.
 */
export async function listUserFolders(db: Db, accountId: string): Promise<UserFolderRow[]> {
  const rows = await db
    .select({
      id: mailboxFolders.id,
      folder: mailboxFolders.folder,
      mailboxId: mailboxFolders.mailboxId,
      address: mailboxes.address,
      updatedAt: mailboxFolders.updatedAt,
    })
    .from(mailboxFolders)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxFolders.mailboxId))
    .where(eq(mailboxes.accountId, accountId));
  return rows
    .filter((r) => userFolderExclusion(r.folder) === null)
    .sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
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
    })
    .from(mailboxFolders)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxFolders.mailboxId))
    .where(and(eq(mailboxFolders.id, id), eq(mailboxes.accountId, accountId)))
    .limit(1);
  if (!r) return null;
  return userFolderExclusion(r.folder) === null ? r : null;
}
