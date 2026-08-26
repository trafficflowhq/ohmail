import type { FolderOpRow, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { Logger } from "@trafficflow/core/mail";

/**
 * ═══ THE FOLDER-OP PASS — user-commanded CREATE / RENAME / DELETE (FOLDERS-SPEC.md stage 2) ═══
 *
 * The API records the user's command (`folder_ops`, mail 0074) and rings the doorbell; THIS pass
 * — once per sync cycle per mailbox, at the top of the cycle so the same cycle's `changesSince`
 * already observes the result — executes the command against the user's own mailbox and applies
 * the database consequences through the caller's fenced `write`. It runs inside the mailbox's
 * serial cycle, which is the concurrency design: exactly one organizer per mailbox (the lease),
 * so no reconcile, no discovery and no second copy of this pass ever runs beside it on this mailbox.
 *
 * ── EVERY COMMAND IS TWO-PHASE, AND THE ORDER IS THE MASTER RULE ────────────────────────────
 *
 * IMAP leads; the database records what was done (the `fencedGroup` header in sync.ts carries
 * the whole argument). A crash between the phases leaves the command PENDING and the database
 * un-swapped, and each verb's IMAP half is idempotent so the re-run converges:
 *
 *  · CREATE — `mailboxCreate` reads "already exists" as success;
 *  · RENAME — `renameFolder` answers `"already"` when the source is gone and the target exists
 *    (the crash window's exact signature), and the caller proceeds straight to the swap;
 *  · DELETE — the sweep finds nothing left to move, `deleteFolder` answers `"already"`, and the
 *    per-folder row removal is keyed by rows that still exist.
 *
 * The database half of the rename — the multi-table swap — is ONE transaction
 * (`applyFolderRename`), all-or-nothing, proven by the pg test that aborts it mid-flight: a
 * kill mid-rename leaves the OLD spelling everywhere, never half a swap.
 *
 * ── FAILURE HONESTY ─────────────────────────────────────────────────────────────────────────
 *
 * A SEMANTIC refusal — a name the server's own delimiter forbids, a collision, a subject that
 * vanished, a folder that will not empty — fails the command immediately: `status='failed'` plus
 * a closed code, carried to every client on the entity (`FolderDTO.op.error`) until the user
 * dismisses it. A TRANSIENT miss (the network, the server hiccuping) defers: the command stays
 * pending, `attempts` counts, and after {@link FOLDER_OP_MAX_ATTEMPTS} it fails as `"refused"`
 * rather than retrying for ever. Fence refusals leave this pass unreclassified — lost
 * leadership is never evidence about a command.
 *
 * A failed DELETE leaves a consistent, stated state: whatever the sweep already moved is
 * honestly in the provider's Trash (a move, reversible in any client), the folder still exists,
 * and nothing is half-removed — the pass deletes a folder's inventory row only AFTER the
 * server confirmed the folder is gone.
 */

export const FOLDER_OP_MAX_ATTEMPTS = 5;

/** One chunk of the delete's mirror tombstones — the mark-seen batch bound, for its reason. */
export const FOLDER_DELETE_TOMBSTONE_CHUNK = 200;

export interface FolderOpsDeps {
  repo: WorkerRepo;
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  /** The cycle's fenced group — consequences and the leadership verdict commit together. */
  write: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  log?: Logger;
}

export interface FolderOpsResult {
  executed: number;
  failed: number;
  deferred: number;
}

/** Does any SEGMENT of this canonical path contain the mailbox's real delimiter? */
export function leafFightsDelimiter(canonical: string, delimiter: string): boolean {
  if (delimiter === "/" || delimiter.length === 0) return false;
  return canonical.split("/").some((seg) => seg.includes(delimiter));
}

export async function folderOpsPass(deps: FolderOpsDeps): Promise<FolderOpsResult> {
  const { repo, adapter, accountId, mailboxId, log } = deps;
  const result: FolderOpsResult = { executed: 0, failed: 0, deferred: 0 };
  const ops = await repo.listFolderOps(mailboxId);
  if (ops.length === 0) return result;

  // An adapter without the verbs (a fake, an alternative backend) cannot execute the command;
  // failing it honestly beats holding it pending for ever on a surface that will never act.
  const capable = adapter.createFolder && adapter.renameFolder && adapter.deleteFolder && adapter.moveAll;

  for (const op of ops) {
    try {
      if (!capable) {
        await deps.write((r) => r.failFolderOp(op, "refused"));
        result.failed += 1;
        continue;
      }
      const outcome = op.op === "create"
        ? await runCreate(deps, op)
        : op.op === "rename"
          ? await runRename(deps, op)
          : await runDelete(deps, op);
      if (outcome === "done") result.executed += 1;
      else result.failed += 1;
    } catch (err) {
      // Only the caller's fence vocabulary may leave this pass — lost leadership stops the
      // cycle unreclassified. Everything else is a transient: count it, keep the command.
      if (isFenceRefusal(err)) throw err;
      const attempts = op.attempts + 1;
      if (attempts >= FOLDER_OP_MAX_ATTEMPTS) {
        await deps.write((r) => r.failFolderOp(op, "refused"));
        result.failed += 1;
        log?.warn("folder_op_failed", { mailboxId, accountId, op: op.op, folderId: op.folderId, attempts, err });
      } else {
        await deps.write((r) => r.deferFolderOp(op.id, attempts));
        result.deferred += 1;
        log?.warn("folder_op_deferred", { mailboxId, accountId, op: op.op, folderId: op.folderId, attempts, err });
      }
    }
  }
  return result;
}

/**
 * `LeaderFencedError` by NAME rather than by class: the class lives in sync.ts, which imports
 * this module — an import the other way would be a cycle, and the name is the contract the
 * fence's own tests pin.
 */
function isFenceRefusal(err: unknown): boolean {
  return err instanceof Error && err.name === "LeaderFencedError";
}

async function runCreate(deps: FolderOpsDeps, op: FolderOpRow): Promise<"done" | "failed"> {
  const delimiter = deps.adapter.hierarchyDelimiter?.() ?? "/";
  if (leafFightsDelimiter(op.folder, delimiter)) {
    await deps.write((r) => r.failFolderOp(op, "bad_name"));
    return "failed";
  }
  await deps.adapter.createFolder!(op.folder);
  await deps.write((r) => r.completeFolderCreate(op));
  deps.log?.info("folder_created", { mailboxId: deps.mailboxId, accountId: deps.accountId, folderId: op.folderId });
  return "done";
}

async function runRename(deps: FolderOpsDeps, op: FolderOpRow): Promise<"done" | "failed"> {
  const to = op.toFolder;
  if (to === null) {
    // The CHECK forbids this row; a repo that produced it anyway gets the honest terminal.
    await deps.write((r) => r.failFolderOp(op, "refused"));
    return "failed";
  }
  const delimiter = deps.adapter.hierarchyDelimiter?.() ?? "/";
  if (leafFightsDelimiter(to, delimiter)) {
    await deps.write((r) => r.failFolderOp(op, "bad_name"));
    return "failed";
  }
  const res = await deps.adapter.renameFolder!(op.folder, to);
  if (res === "conflict") {
    await deps.write((r) => r.failFolderOp(op, "exists"));
    return "failed";
  }
  if (res === "gone") {
    // The subject vanished server-side (another client deleted it). The rename has no subject;
    // the inventory row stays under the phantom rules and the refusal names what happened.
    await deps.write((r) => r.failFolderOp(op, "gone"));
    return "failed";
  }
  // "renamed" — or "already": the crash window's signature, the swap is still owed.
  const swapped = await deps.write((r) => r.applyFolderRename({ ...op, toFolder: to }));
  deps.log?.info("folder_renamed", {
    mailboxId: deps.mailboxId, accountId: deps.accountId, folderId: op.folderId,
    folders: swapped.folders, messages: swapped.messages, imap: res,
  });
  return "done";
}

async function runDelete(deps: FolderOpsDeps, op: FolderOpRow): Promise<"done" | "failed"> {
  const { repo, adapter, accountId, mailboxId } = deps;
  const special = await repo.getMailboxSpecialFolders?.(mailboxId);
  const trash = special?.trashFolder ?? null;
  if (trash === null) {
    // The API refused up front; discovery can still have moved under the command. Never an
    // expunge — a delete with nowhere to file fails, stated.
    await deps.write((r) => r.failFolderOp(op, "no_trash_folder"));
    return "failed";
  }

  // Children before parents — no IMAP DELETE ever targets a folder with inferiors. The subject
  // (the subtree's root) is therefore LAST, and removing its inventory row CASCADE-retires the
  // command itself: the delete completes exactly when the last folder is gone.
  const subtree = await repo.listFolderSubtree(mailboxId, op.folder);
  for (const f of subtree) {
    // Phase 1 — the server sweep. Folder-level, not per known message: the mailbox may hold
    // mail the mirror never ingested, and every message must reach Trash before DELETE.
    await adapter.moveAll!(f.folder, trash);
    // Phase 2 — the mirror consequences, chunked (one tx per chunk, idempotent re-entry).
    for (;;) {
      const took = await deps.write((r) =>
        r.tombstoneFolderMessages(accountId, mailboxId, f.folder, FOLDER_DELETE_TOMBSTONE_CHUNK));
      if (took < FOLDER_DELETE_TOMBSTONE_CHUNK) break;
    }
    // Phase 3 — the folder itself. `not_empty` means mail landed between sweep and DELETE;
    // one more sweep covers the race, and a folder that STILL will not empty fails the command
    // with everything consistent: swept mail is honestly in Trash, the folder stands.
    let res = await adapter.deleteFolder!(f.folder);
    if (res === "not_empty") {
      await adapter.moveAll!(f.folder, trash);
      for (;;) {
        const took = await deps.write((r) =>
          r.tombstoneFolderMessages(accountId, mailboxId, f.folder, FOLDER_DELETE_TOMBSTONE_CHUNK));
        if (took < FOLDER_DELETE_TOMBSTONE_CHUNK) break;
      }
      res = await adapter.deleteFolder!(f.folder);
    }
    if (res === "not_empty") {
      await deps.write((r) => r.failFolderOp(op, "refused"));
      return "failed";
    }
    // "deleted" — or "already" (a crash re-entry, or another client got there first).
    await deps.write((r) => r.removeFolderRow(accountId, f.id));
  }
  deps.log?.info("folder_deleted", {
    mailboxId, accountId, folderId: op.folderId, folders: subtree.length,
  });
  return "done";
}
