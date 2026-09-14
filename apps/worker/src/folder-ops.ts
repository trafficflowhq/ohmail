import type { FolderOpRow, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { Logger } from "@trafficflow/core/mail";
import { assertMayWriteToMailbox, type MailboxWriteAuthority } from "./lease.js";

/**
 * THE FOLDER-OP PASS — user-commanded CREATE/RENAME/DELETE (FOLDERS-SPEC.md stage 2). The API records the
 * command (`folder_ops`, mail 0074) and rings the doorbell; this pass, once per cycle per mailbox at the
 * top (so the same cycle's `changesSince` observes the result), executes it and applies the DB
 * consequences through the caller's fenced `write`, inside the mailbox's serial cycle (one organizer per
 * mailbox, so no second copy runs beside it). Every command is TWO-PHASE, IMAP LEADING (the `fencedGroup`
 * header in `sync.ts`): a crash leaves it PENDING and each verb's IMAP half is idempotent (`mailboxCreate`,
 * `renameFolder`, `deleteFolder` all read the crash window as `"already"`), and the rename's DB swap is ONE
 * transaction (`applyFolderRename`). Failure honesty: a SEMANTIC refusal fails immediately
 * (`status='failed'` + a closed `FolderDTO.op.error`); a TRANSIENT miss defers and after {@link FOLDER_OP_MAX_ATTEMPTS} fails `"refused"`; a fence refusal leaves it unreclassified. A failed DELETE leaves a consistent, stated state. */

export const FOLDER_OP_MAX_ATTEMPTS = 5;

/** One chunk of the delete's mirror tombstones — the mark-seen batch bound, for its reason. */
export const FOLDER_DELETE_TOMBSTONE_CHUNK = 200;

/**
 * How many tombstone CHUNKS one cycle may spend on folder deletes, across all of the mailbox's
 * commands — the reconciler's `RECONCILE_MOVES_PER_CYCLE` argument at this seam: the worker's
 * rotation is serial, so a deep archive folder drained to exhaustion in one pass would hold
 * every other mailbox behind it. A cycle that runs out leaves the command PENDING with its
 * attempts untouched (progress is not an error), reports `owesMore`, and the caller re-kicks —
 * the mailbox goes to the back of the queue and the delete resumes where the chunks left off
 * (the picked set excludes what earlier chunks already tombstoned).
 */
export const FOLDER_DELETE_CHUNKS_PER_CYCLE = 10;

export interface FolderOpsDeps {
  repo: WorkerRepo;
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  /** The cycle's fenced group — consequences and the leadership verdict commit together. */
  write: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  /**
   * WHAT AUTHORISES EVERY IMAP MUTATION THIS PASS ISSUES, asked by `assertMayWriteToMailbox`.
   *
   * An IMAP command cannot ride a database transaction, so the fenced `write` alone would let a
   * stale worker CREATE, RENAME or sweep a mailbox another worker has taken over, and it says
   * nothing at all about the ORGANIZER lease — which is what stops a desktop install executing
   * queued folder verbs on a mailbox somebody else now organizes. REQUIRED: a caller that holds
   * neither half says so in the object, because absent and "none here" are different facts.
   */
  writeAuthority: MailboxWriteAuthority;
  log?: Logger;
}

export interface FolderOpsResult {
  executed: number;
  failed: number;
  deferred: number;
  /** A delete ran out its per-cycle chunk budget — still pending, re-kick to resume. */
  owesMore: boolean;
}

/** Does any SEGMENT of this canonical path contain the mailbox's real delimiter? */
export function leafFightsDelimiter(canonical: string, delimiter: string): boolean {
  if (delimiter === "/" || delimiter.length === 0) return false;
  return canonical.split("/").some((seg) => seg.includes(delimiter));
}

export async function folderOpsPass(deps: FolderOpsDeps): Promise<FolderOpsResult> {
  const { repo, adapter, accountId, mailboxId, log } = deps;
  const result: FolderOpsResult = { executed: 0, failed: 0, deferred: 0, owesMore: false };
  const ops = await repo.listFolderOps(mailboxId);
  if (ops.length === 0) return result;
  /** The cycle's shared tombstone budget — see {@link FOLDER_DELETE_CHUNKS_PER_CYCLE}. */
  const budget = { chunks: FOLDER_DELETE_CHUNKS_PER_CYCLE };

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
          : await runDelete(deps, op, budget);
      if (outcome === "done") result.executed += 1;
      else if (outcome === "paused") result.owesMore = true;
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
  await assertMayWriteToMailbox(deps.writeAuthority);
  // Where the create LANDED — a personal-namespace server files a root-named create under
  // INBOX, and the completion records the real path (or defers to the row discovery already
  // adopted there) so the commanded row can never stand as a phantom.
  const landed = await deps.adapter.createFolder!(op.folder);
  await deps.write((r) => r.completeFolderCreate(op, landed));
  deps.log?.info("folder_created", {
    mailboxId: deps.mailboxId, accountId: deps.accountId, folderId: op.folderId, landed,
  });
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
  await assertMayWriteToMailbox(deps.writeAuthority);
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

async function runDelete(
  deps: FolderOpsDeps, op: FolderOpRow, budget: { chunks: number },
): Promise<"done" | "failed" | "paused"> {
  const { repo, adapter, accountId, mailboxId } = deps;
  const special = await repo.getMailboxSpecialFolders?.(mailboxId);
  const trash = special?.trashFolder ?? null;
  if (trash === null) {
    // The API refused up front; discovery can still have moved under the command. Never an
    // expunge — a delete with nowhere to file fails, stated.
    await deps.write((r) => r.failFolderOp(op, "no_trash_folder"));
    return "failed";
  }

  // The RESOLVED Sent path, read once per delete: the stale-residue guard compares the exact
  // folder the adapter watermarks, not a spelling — a mailbox whose \\Sent resolved to a
  // custom path would otherwise lose the last evidence of old sent copies.
  // `watchedSentFolder ?? sentFolder` — the same precedence `sentFolderOf` uses: an adapter
  // that resolved \\Sent but names no separate watch path reports it in `sentFolder` alone.
  const caps = await adapter.capabilities();
  const sentFolder = caps.watchedSentFolder ?? caps.sentFolder ?? null;

  /** One folder's mirror consequences, within the cycle's budget. False ⇒ budget ran out. */
  const tombstoneWithin = async (folder: string): Promise<boolean> => {
    for (;;) {
      if (budget.chunks <= 0) return false;
      budget.chunks -= 1;
      const took = await deps.write((r) =>
        r.tombstoneFolderMessages(accountId, mailboxId, folder, FOLDER_DELETE_TOMBSTONE_CHUNK, sentFolder));
      if (took < FOLDER_DELETE_TOMBSTONE_CHUNK) return true;
    }
  };

  // Children before parents — no IMAP DELETE ever targets a folder with inferiors. The subject
  // (the subtree's root) is therefore LAST, and removing its inventory row CASCADE-retires the
  // command itself: the delete completes exactly when the last folder is gone. A cycle that
  // exhausts its chunk budget mid-subtree PAUSES — the command stays pending with its attempts
  // untouched (progress is not an error), the caller re-kicks, and the re-entry converges:
  // swept folders sweep to nothing, tombstoned rows are excluded from the next pick, removed
  // rows are gone from the subtree read.
  const subtree = await repo.listFolderSubtree(mailboxId, op.folder);
  for (const f of subtree) {
    // Phase 1 — the server sweep. Folder-level, not per known message: the mailbox may hold
    // mail the mirror never ingested, and every message must reach Trash before DELETE. The
    // sweep hands back the FENCE: the folder as it left it, which is the only state the DELETE
    // is authorized against.
    await assertMayWriteToMailbox(deps.writeAuthority);
    const sweep = await adapter.moveAll!(f.folder, trash);
    // Phase 2 — the mirror consequences, chunked (one tx per chunk, idempotent re-entry).
    if (!(await tombstoneWithin(f.folder))) return "paused";
    // Phase 3 — the folder itself, re-read against the fence. `unverified` — no reading at all —
    // is a transient, not a verdict: deleting on an unverified count is the expunge this
    // ceremony exists to forbid.
    await assertMayWriteToMailbox(deps.writeAuthority);
    const res = await adapter.deleteFolder!(f.folder, sweep.fence);
    if (res === "unverified") {
      throw new Error(`folder ${f.folder}: the server did not answer the re-reading — emptiness unverified, retrying`);
    }
    // MAIL ARRIVED WHILE THE FOLDER WAS BEING EMPTIED, and the command stops there. It used to
    // sweep again by itself, which files a stranger's brand-new message into Trash on the
    // strength of a press made before it existed — and leaves the same race open for the next
    // one. The person is told instead; pressing Delete again is a new command, which sweeps
    // once more and deletes if the folder is empty by then. Everything stays consistent: swept
    // mail is honestly in Trash, the folder stands with whatever landed in it.
    if (res === "not_empty" || res === "changed") {
      await deps.write((r) => r.failFolderOp(op, "received_mail"));
      deps.log?.info("folder_delete_refused", {
        mailboxId, accountId, folderId: op.folderId, folder: f.folder, why: res,
      });
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
