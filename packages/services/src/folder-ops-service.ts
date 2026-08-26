import { and, eq, inArray, isNull, sql } from "drizzle-orm";
// `@trafficflow/core/mail`, NOT the default barrel — `folders.ts`'s rule, same reason: this
// module is imported beside it and must never pull the classifier/drafter graph anywhere.
import { folderNameError } from "@trafficflow/core/mail";
import { folderOps, folderState, mailboxFolders, mailboxes, messages, recordChange, type Tx } from "@trafficflow/db";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { foldersEnabled, userFolderById, userFolderExclusion, type UserFolderRow } from "./folders.js";
import { folderRowToDTO } from "./dto/materialize.js";
import type { FolderDTO } from "./dto/types.js";

/**
 * ═══ THE FOLDER VERBS — create / rename / delete, as USER COMMANDS (FOLDERS-SPEC.md stage 2) ═══
 *
 * Every verb here is a REAL IMAP write in the user's own mailbox, and the API never opens an
 * IMAP connection to organize — so this service records the COMMAND (`folder_ops`, mail 0074),
 * appends the `folder` change row that lets every client render the pending state honestly, and
 * rings the `sync_requested_at` doorbell. The worker's `folderOpsPass` (apps/worker/src/
 * folder-ops.ts) executes the command inside the mailbox's serial cycle — exactly one organizer
 * — applies the database consequences in one transaction, and deletes the row. The wake channel
 * then carries the settled entity back within seconds.
 *
 * ── THE OPTIMISM MODEL: PENDING MARKERS, NEVER PRETENDED COMPLETION ─────────────────────────
 *
 * `FolderDTO.name` stays the MAILBOX's truth throughout. A create inserts the inventory row (so
 * the folder renders instantly, marked `op.kind = 'create'`); a rename records the target in
 * `op.to` and keeps the old name until the worker's RENAME lands; a delete marks the row
 * `op.kind = 'delete'` and the tombstones arrive as the worker files and removes. The mirror
 * never claims a mailbox state that does not exist yet — the marker is the honest middle.
 *
 * ── ONE COMMAND IN FLIGHT PER SUBTREE ───────────────────────────────────────────────────────
 *
 * UNIQUE(folder_id) refuses a second command on one folder at the database; {@link assertNoOpOverlap}
 * widens that to the SUBTREE and the rename target, because two in-flight commands whose paths
 * overlap have no defined order ("rename A" + "delete A/B" — which subtree?). Ops resolve in
 * seconds, so the refusal is a sentence the user reads once, not a workflow.
 *
 * A FAILED command keeps its row (the honest refusal, carried on the entity until seen) and
 * blocks new commands on its folder until dismissed — {@link dismiss} — so a refusal cannot be
 * silently steamrolled by a retry loop.
 */

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/** `POST /folders` body. */
export interface FolderCreateBody { mailboxId?: unknown; name?: unknown }
/** `PATCH /folders/:id` body — the new full canonical path. */
export interface FolderRenameBody { name?: unknown }

/** The delete confirm's server-truth numbers ("N messages across M folders move to Trash"). */
export interface FolderScopeSummary { folders: number; messages: number }

interface MailboxRow { id: string; status: string; trashFolder: string | null }

export class FolderOpsService {
  /**
   * CREATE — insert the inventory row (the instant, honest render) + the command + the change
   * row, one transaction. The worker's `mailboxCreate` is idempotent against "already exists",
   * so a crash after commit costs one redundant CREATE and nothing else.
   */
  async create(ctx: ServiceContext, body: FolderCreateBody): Promise<{ dto: FolderDTO; seq: number | null }> {
    const mailboxId = typeof body?.mailboxId === "string" ? body.mailboxId : "";
    const name = typeof body?.name === "string" ? body.name : "";
    await this.requireFolders(ctx);
    this.validName(name);

    const { id, seq } = await asTx(ctx).transaction(async (tx) => {
      await this.requireCommandableMailbox(tx, ctx, mailboxId);
      await this.assertNoOpOverlap(tx, mailboxId, [name]);
      const inserted = await tx.insert(mailboxFolders)
        .values({ mailboxId, folder: name })
        .onConflictDoNothing()
        .returning({ id: mailboxFolders.id });
      const row = inserted[0];
      if (!row) throw new ServiceError("conflict", 409, "a folder with that name already exists");
      await tx.insert(folderOps).values({
        accountId: ctx.accountId, mailboxId, folderId: row.id, op: "create",
        requestedAt: ctx.now(), updatedAt: ctx.now(),
      });
      const s = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "folder", entityId: row.id, op: "create", meta: null,
      });
      await this.ringDoorbell(tx, mailboxId, ctx.now());
      return { id: row.id, seq: s };
    });

    return this.answer(ctx, id, seq);
  }

  /**
   * RENAME — one wire act for rename AND move (a move is a rename under a new parent; the
   * stage-2 UI ships rename-in-place, the vocabulary already carries both). The subtree, the
   * messages' folder addresses and the cursors all follow when the WORKER lands the swap — in
   * one transaction, beside the IMAP RENAME it mirrors. Here: the command, the pending marker,
   * the doorbell.
   */
  async rename(ctx: ServiceContext, id: string, body: FolderRenameBody): Promise<{ dto: FolderDTO; seq: number | null }> {
    const name = typeof body?.name === "string" ? body.name : "";
    await this.requireFolders(ctx);
    this.validName(name);
    const subject = await this.requireSubject(ctx, id);
    if (subject.folder === name) {
      throw new ServiceError("validation_failed", 400, "that is already the folder's name");
    }
    if (name.startsWith(subject.folder + "/")) {
      throw new ServiceError("validation_failed", 400, "a folder cannot move into its own subtree");
    }

    const seq = await asTx(ctx).transaction(async (tx) => {
      await this.requireCommandableMailbox(tx, ctx, subject.mailboxId);
      await this.assertNoOpOverlap(tx, subject.mailboxId, [subject.folder, name]);
      const [collision] = await tx.select({ id: mailboxFolders.id }).from(mailboxFolders)
        .where(and(eq(mailboxFolders.mailboxId, subject.mailboxId), eq(mailboxFolders.folder, name)))
        .limit(1);
      if (collision) throw new ServiceError("conflict", 409, "a folder with that name already exists");
      await tx.insert(folderOps).values({
        accountId: ctx.accountId, mailboxId: subject.mailboxId, folderId: id,
        op: "rename", toFolder: name, requestedAt: ctx.now(), updatedAt: ctx.now(),
      });
      const s = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "folder", entityId: id, op: "update", meta: null,
      });
      await this.ringDoorbell(tx, subject.mailboxId, ctx.now());
      return s;
    });

    return this.answer(ctx, id, seq);
  }

  /**
   * DELETE — the ratified ceremony: the worker files the subtree's messages to native `\Trash`
   * (the delete verb's exact semantics — NEVER an expunge), children first, then removes each
   * empty folder (IMAP DELETE), then tombstones the inventory. Refused UP FRONT when the
   * mailbox has no discovered Trash — the only alternatives are an expunge (forbidden) or a
   * delete that strands mail, and both are worse than the sentence.
   */
  async remove(ctx: ServiceContext, id: string): Promise<{ dto: FolderDTO; seq: number | null }> {
    await this.requireFolders(ctx);
    const subject = await this.requireSubject(ctx, id);

    const seq = await asTx(ctx).transaction(async (tx) => {
      const mb = await this.requireCommandableMailbox(tx, ctx, subject.mailboxId);
      if (mb.trashFolder === null) {
        throw new ServiceError(
          "no_trash_folder", 422,
          "this mailbox has no Trash folder, and ohmail never expunges — delete the folder in your own mail client instead",
        );
      }
      await this.assertNoOpOverlap(tx, subject.mailboxId, [subject.folder]);
      await tx.insert(folderOps).values({
        accountId: ctx.accountId, mailboxId: subject.mailboxId, folderId: id,
        op: "delete", requestedAt: ctx.now(), updatedAt: ctx.now(),
      });
      const s = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "folder", entityId: id, op: "update", meta: null,
      });
      await this.ringDoorbell(tx, subject.mailboxId, ctx.now());
      return s;
    });

    return this.answer(ctx, id, seq);
  }

  /**
   * DISMISS a FAILED command — the only way past a refusal, deliberately manual: the sentence
   * was for the user, and a retry loop that clears it unread would hide the one honest signal.
   * A failed CREATE takes its never-created inventory row with it (there is nothing on the
   * server to keep showing); a failed rename/delete leaves the folder exactly as the mailbox
   * has it. A PENDING command cannot be dismissed — the worker may be mid-execution, and a
   * cancel that races an IMAP write would make the marker lie in whichever direction lost.
   */
  async dismiss(ctx: ServiceContext, id: string): Promise<{ dto: FolderDTO | null; seq: number | null }> {
    await this.requireFolders(ctx);
    const subject = await this.requireSubject(ctx, id);
    if (!subject.op) throw new ServiceError("not_found", 404, "no failed change to dismiss");
    if (subject.op.error === null) {
      throw new ServiceError("conflict", 409, "that change is still being made on your mail server");
    }
    const wasCreate = subject.op.kind === "create";

    const seq = await asTx(ctx).transaction(async (tx) => {
      if (wasCreate) {
        // CASCADE takes the op row with the inventory row.
        await tx.delete(mailboxFolders).where(eq(mailboxFolders.id, id));
        return recordChange(tx, {
          accountId: ctx.accountId, entityType: "folder", entityId: id, op: "delete", meta: null,
        });
      }
      await tx.delete(folderOps).where(eq(folderOps.folderId, id));
      return recordChange(tx, {
        accountId: ctx.accountId, entityType: "folder", entityId: id, op: "update", meta: null,
      });
    });

    if (wasCreate) return { dto: null, seq: seq === null ? null : Number(seq) };
    return this.answer(ctx, id, seq);
  }

  /**
   * The delete confirm's numbers, from the SERVER's truth — the client mirror is windowed
   * (the folder tail exists precisely because it does not hold everything), so a count derived
   * there would understate what the delete moves. `folders` counts the subtree including the
   * subject; `messages` counts undeleted mirror rows whose effective folder (`folder_state`
   * desired, else the locator) sits in the subtree — the same derivation `MessageDTO.folder`
   * uses, so the number is the one the views agree with.
   */
  async summary(ctx: ServiceContext, id: string): Promise<FolderScopeSummary> {
    await this.requireFolders(ctx);
    const subject = await this.requireSubject(ctx, id);
    const db = ctx.db;
    const all = await db.select({ folder: mailboxFolders.folder }).from(mailboxFolders)
      .where(eq(mailboxFolders.mailboxId, subject.mailboxId));
    const subtree = all
      .map((r) => r.folder)
      .filter((f) => (f === subject.folder || f.startsWith(subject.folder + "/")) && userFolderExclusion(f) === null);
    if (subtree.length === 0) return { folders: 0, messages: 0 };

    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .leftJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(
        eq(messages.mailboxId, subject.mailboxId),
        eq(messages.accountId, ctx.accountId),
        isNull(messages.deletedAt),
        inArray(
          sql`coalesce(${folderState.desiredFolder}, ${messages.nativeLocator}->>'folder')`,
          subtree,
        ),
      ));
    return { folders: subtree.length, messages: row?.n ?? 0 };
  }

  // ── shared gates ──────────────────────────────────────────────────────────────────────────

  private async requireFolders(ctx: ServiceContext): Promise<void> {
    if (!(await foldersEnabled(ctx.db, ctx.accountId))) {
      throw new ServiceError("folders_disabled", 409, "turn on “Use folders” first");
    }
  }

  /** The subject folder, account-scoped through the participation-filtered read (404 otherwise). */
  private async requireSubject(ctx: ServiceContext, id: string): Promise<UserFolderRow> {
    const row = await userFolderById(ctx.db, ctx.accountId, id);
    if (!row) throw new ServiceError("not_found", 404, "folder not found");
    return row;
  }

  /**
   * The mailbox a command may be recorded against: the account's own, participating in folders,
   * and not stood down — a `disabled` mailbox is another organizer's (a local install holds the
   * lease), and a command Cloud's worker will never execute is a lie in a table.
   */
  private async requireCommandableMailbox(tx: Tx, ctx: ServiceContext, mailboxId: string): Promise<MailboxRow> {
    const [mb] = await tx
      .select({ id: mailboxes.id, status: mailboxes.status, trashFolder: mailboxes.trashFolder })
      .from(mailboxes)
      .where(and(
        eq(mailboxes.id, mailboxId),
        eq(mailboxes.accountId, ctx.accountId),
        isNull(mailboxes.foldersDisabledAt),
      ))
      .limit(1);
    if (!mb) throw new ServiceError("not_found", 404, "mailbox not found");
    if (mb.status === "disabled") {
      throw new ServiceError(
        "mailbox_stood_down", 409,
        "this mailbox is organized by your local install — make folder changes there",
      );
    }
    return mb;
  }

  /** The structural validation both sides share — see `folderNameError` (core) for the codes. */
  private validName(name: string): void {
    const err = folderNameError(name);
    if (err !== null) {
      throw new ServiceError("validation_failed", 400, `folder_name_${err}`);
    }
    const excluded = userFolderExclusion(name);
    if (excluded !== null) {
      throw new ServiceError("validation_failed", 400, "folder_name_reserved");
    }
  }

  /**
   * NO in-flight command may prefix-overlap this verb's paths. Two overlapping commands have no
   * defined order, and the worker's pass derives paths at execution time — a stale sibling would
   * execute against a tree the earlier command already reshaped. Ops resolve in seconds; the
   * refusal is one honest sentence.
   */
  private async assertNoOpOverlap(tx: Tx, mailboxId: string, paths: readonly string[]): Promise<void> {
    const ops = await tx
      .select({ subject: mailboxFolders.folder, to: folderOps.toFolder })
      .from(folderOps)
      .innerJoin(mailboxFolders, eq(mailboxFolders.id, folderOps.folderId))
      .where(eq(folderOps.mailboxId, mailboxId));
    const overlaps = (a: string, b: string): boolean =>
      a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
    for (const op of ops) {
      for (const p of paths) {
        if (overlaps(op.subject, p) || (op.to !== null && overlaps(op.to, p))) {
          throw new ServiceError(
            "conflict", 409,
            "another change to that folder is still being made on your mail server — it settles in seconds",
          );
        }
      }
    }
  }

  /**
   * The doorbell (`sync_requested_at`, mail 0049): the worker's ~3 s kick pass triggers an
   * out-of-band cycle, whose `folderOpsPass` executes the command — so the verb settles in
   * seconds instead of a poll interval. Written with millisecond precision (a JS date), which
   * the kick pass's text-exact compare-and-clear handles either way.
   */
  private async ringDoorbell(tx: Tx, mailboxId: string, now: Date): Promise<void> {
    await tx.update(mailboxes).set({ syncRequestedAt: now }).where(eq(mailboxes.id, mailboxId));
  }

  /** The verb's echo: the subject's fresh DTO (marker included) + the write's `X-Sync-Seq`. */
  private async answer(
    ctx: ServiceContext, id: string, seq: bigint | null,
  ): Promise<{ dto: FolderDTO; seq: number | null }> {
    const row = await userFolderById(ctx.db, ctx.accountId, id);
    if (!row) throw new ServiceError("internal", 500, "folder vanished after write");
    return { dto: folderRowToDTO(row), seq: seq === null ? null : Number(seq) };
  }
}

export const folderOpsService = new FolderOpsService();
