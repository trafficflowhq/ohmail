import { and, eq, inArray } from "drizzle-orm";
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
      // Ownership gate: EVERY id must belong to the caller's account, else 404.
      const owned = await tx.select({ id: threads.id }).from(threads)
        .where(and(eq(threads.accountId, ctx.accountId), inArray(threads.id, threadIds)));
      if (owned.length !== new Set(threadIds).size) {
        throw new ServiceError("not_found", 404, "thread not found");
      }

      const target = threadIds[0]!;
      const others = threadIds.slice(1).filter((t) => t !== target);

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
          await recordChange(tx, { accountId: ctx.accountId, entityType: "message", entityId: m.id, op: "update", meta: null });
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
          await recordChange(tx, { accountId: ctx.accountId, entityType: "draft", entityId: d.id, op: "update", meta: null });
        }
      }

      // Optionally retitle the target, then emit its update + delete-tombstone the rest.
      const targetSet: Record<string, unknown> = { updatedAt: ctx.now() };
      if (body.subject !== undefined) targetSet.subject = body.subject;
      await tx.update(threads).set(targetSet)
        .where(and(eq(threads.id, target), eq(threads.accountId, ctx.accountId)));
      await recordChange(tx, { accountId: ctx.accountId, entityType: "thread", entityId: target, op: "update", meta: null });

      for (const other of others) {
        await tx.delete(threads).where(and(eq(threads.id, other), eq(threads.accountId, ctx.accountId)));
        await recordChange(tx, { accountId: ctx.accountId, entityType: "thread", entityId: other, op: "delete", meta: null });
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
