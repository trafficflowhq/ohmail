import { and, asc, eq, inArray } from "drizzle-orm";
import { drafts, messages, threadNotes, threads, recordChange, type Tx } from "@trafficflow/db";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { materializeThread } from "./dto/materialize.js";
import type { ThreadDTO } from "./dto/types.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

export interface ThreadPatchBody {
  muted?: boolean;
}
export interface ThreadRenameBody {
  subject: string;
}
export interface ThreadMergeBody {
  threadIds: string[];
  subject?: string;
}

/**
 * ThreadService — thread-level mutations. Each client-visible
 * mutation runs ONE `db.transaction` that writes the `threads`/`messages` rows AND
 * appends the corresponding `change_log` row(s). Every write is scoped to
 * `ctx.accountId`: a cross-account id is a 404. `merge` reassigns the merged
 * threads' messages onto a target and tombstones the emptied threads — all atomic.
 */
export class ThreadService {
  async get(ctx: ServiceContext, id: string): Promise<ThreadDTO> {
    const dto = await materializeThread(ctx.db, ctx.accountId, id);
    if (!dto) throw new ServiceError("not_found", 404, "thread not found");
    return dto;
  }

  async patch(ctx: ServiceContext, id: string, body: ThreadPatchBody): Promise<ThreadDTO> {
    if (body.muted !== undefined && typeof body.muted !== "boolean") {
      throw new ServiceError("validation_failed", 400, "muted must be a boolean");
    }
    await asTx(ctx).transaction(async (tx) => {
      const set: Record<string, unknown> = { updatedAt: ctx.now() };
      if (body.muted !== undefined) set.muted = body.muted;
      const updated = await tx.update(threads).set(set)
        .where(and(eq(threads.id, id), eq(threads.accountId, ctx.accountId)))
        .returning({ id: threads.id });
      if (updated.length === 0) throw new ServiceError("not_found", 404, "thread not found");
      await recordChange(tx, { accountId: ctx.accountId, entityType: "thread", entityId: id, op: "update", meta: null });
    });
    return this.reload(ctx, id);
  }

  async rename(ctx: ServiceContext, id: string, body: ThreadRenameBody): Promise<ThreadDTO> {
    if (typeof body.subject !== "string") {
      throw new ServiceError("validation_failed", 400, "subject is required");
    }
    await asTx(ctx).transaction(async (tx) => {
      const updated = await tx.update(threads).set({ subject: body.subject, updatedAt: ctx.now() })
        .where(and(eq(threads.id, id), eq(threads.accountId, ctx.accountId)))
        .returning({ id: threads.id });
      if (updated.length === 0) throw new ServiceError("not_found", 404, "thread not found");
      await recordChange(tx, { accountId: ctx.accountId, entityType: "thread", entityId: id, op: "update", meta: null });
    });
    return this.reload(ctx, id);
  }

  async merge(ctx: ServiceContext, body: ThreadMergeBody): Promise<ThreadDTO> {
    const threadIds = body.threadIds;
    if (!Array.isArray(threadIds) || threadIds.length < 2) {
      throw new ServiceError("validation_failed", 400, "threadIds must contain at least two thread ids");
    }
    if (body.subject !== undefined && typeof body.subject !== "string") {
      throw new ServiceError("validation_failed", 400, "subject must be a string");
    }

    const targetId = await asTx(ctx).transaction(async (tx) => {
      // Ownership gate: EVERY id must belong to the caller's account, else 404 — and the
      // gate LOCKS what it reads. Taking the thread rows first puts this transaction on the
      // one lock order every writer of a thread shares (thread rows, then message rows, then
      // the change-log seq): ingest's mergeThreadMessage locks the thread row before its
      // message, and the worker's thread-join heal locks its group's thread rows before its
      // moves for the same reason. A merge that locked messages first could hold them while
      // waiting on a thread row the heal holds while waiting on those messages — a cycle
      // Postgres resolves by aborting one side into a user-facing 500.
      // ORDER BY id under FOR UPDATE: two merges overlapping in two threads would otherwise
      // lock them in whatever order their plans scan, and deadlock each other thread-to-thread.
      const owned = await tx.select({ id: threads.id }).from(threads)
        .where(and(eq(threads.accountId, ctx.accountId), inArray(threads.id, threadIds)))
        .orderBy(asc(threads.id))
        .for("update");
      if (owned.length !== new Set(threadIds).size) {
        throw new ServiceError("not_found", 404, "thread not found");
      }

      const target = threadIds[0]!;
      const others = threadIds.slice(1).filter((t) => t !== target);

      // ── ALL DATA LOCKS FIRST, THE SEQ LOCK LAST — the order `ThreadResolution.changes`
      // documents (packages/core). `recordChange` → `allocateSeq` takes the account's
      // `account_sync_state` row lock and holds it to COMMIT, while `DraftsService` locks a
      // draft row FIRST and then allocates. A merge that allocated between its data writes and
      // then reached for a draft row would face a concurrent autosave the other way round —
      // a genuine cycle Postgres resolves with 40P01. So the changes are collected and
      // appended at the very end, in the same order they were owed.
      const changes: Array<{ entityType: "message" | "thread" | "draft"; entityId: string; op: "update" | "delete" }> = [];

      for (const other of others) {
        // Reassign the merged thread's messages onto the target BEFORE deleting it
        // (messages.thread_id FKs threads.id → the source must be empty to drop). A
        // soft-deleted row moves too — the FK does not care — but is NOT announced: its
        // tombstone already reached every mirror, and `getChanges` materializes an update
        // without consulting `deleted_at`, so announcing it would resurrect deleted mail.
        const moved = await tx.update(messages).set({ threadId: target, updatedAt: ctx.now() })
          .where(and(eq(messages.threadId, other), eq(messages.accountId, ctx.accountId)))
          .returning({ id: messages.id, deletedAt: messages.deletedAt });
        for (const m of moved) {
          if (m.deletedAt !== null) continue;
          changes.push({ entityType: "message", entityId: m.id, op: "update" });
        }
        // The OTHER two tables that FK a thread, or the DELETE below is refused with 23503 and
        // the whole merge 500s (measured in production by the worker's thread-join heal, which
        // shares this transaction shape). Notes are fetch-on-demand — no change_log entity, so
        // the repoint is silent; drafts are mirrored, so each repointed draft is announced.
        await tx.update(threadNotes).set({ threadId: target, updatedAt: ctx.now() })
          .where(and(eq(threadNotes.threadId, other), eq(threadNotes.accountId, ctx.accountId)));
        const repointed = await tx.update(drafts).set({ threadId: target, updatedAt: ctx.now() })
          .where(and(eq(drafts.threadId, other), eq(drafts.accountId, ctx.accountId)))
          .returning({ id: drafts.id });
        for (const d of repointed) {
          changes.push({ entityType: "draft", entityId: d.id, op: "update" });
        }
      }

      // Optionally retitle the target, then delete-tombstone the rest — still data writes.
      const targetSet: Record<string, unknown> = { updatedAt: ctx.now() };
      if (body.subject !== undefined) targetSet.subject = body.subject;
      await tx.update(threads).set(targetSet)
        .where(and(eq(threads.id, target), eq(threads.accountId, ctx.accountId)));
      changes.push({ entityType: "thread", entityId: target, op: "update" });

      for (const other of others) {
        await tx.delete(threads).where(and(eq(threads.id, other), eq(threads.accountId, ctx.accountId)));
        changes.push({ entityType: "thread", entityId: other, op: "delete" });
      }

      // Every data lock is held; only now the account's seq lock, once, to commit.
      for (const c of changes) {
        await recordChange(tx, { accountId: ctx.accountId, ...c, meta: null });
      }

      return target;
    });

    return this.reload(ctx, targetId);
  }

  private async reload(ctx: ServiceContext, id: string): Promise<ThreadDTO> {
    const dto = await materializeThread(ctx.db, ctx.accountId, id);
    if (!dto) throw new ServiceError("internal", 500, "thread vanished after write");
    return dto;
  }
}

export const threadService = new ThreadService();
