import { and, asc, eq, gt } from "drizzle-orm";
import { notifyRules } from "@trafficflow/db";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { clampLimit, decodeListCursor, encodeListCursor } from "./pagination.js";
import type { NotifyRuleDTO, Page } from "./dto/types.js";

export interface CreateNotifyRuleBody {
  target: string;
  kind?: string;   // defaults to 'sender'
}

export interface ListNotifyRulesOptions {
  cursor?: string;
  limit?: number;
}

function toDTO(row: typeof notifyRules.$inferSelect): NotifyRuleDTO {
  return { id: row.id, kind: row.kind, target: row.target, createdAt: row.createdAt.toISOString() };
}

/**
 * NotifyRulesService (contract §5.11) — the opt-INTO-notifications list (push is
 * off by default, spec §5.1). Create + list + delete only, account-scoped,
 * REST-only (no change_log, RC4). `target` is a required non-empty spec; `kind`
 * defaults to 'sender'. A cross-account id is a 404.
 */
export class NotifyRulesService {
  async list(ctx: ServiceContext, opts: ListNotifyRulesOptions = {}): Promise<Page<NotifyRuleDTO>> {
    const limit = clampLimit(opts.limit);
    const filters = [eq(notifyRules.accountId, ctx.accountId)];
    if (opts.cursor) filters.push(gt(notifyRules.id, decodeListCursor(opts.cursor)));
    const rows = await ctx.db.select().from(notifyRules)
      .where(and(...filters)).orderBy(asc(notifyRules.id)).limit(limit + 1);
    const pageRows = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeListCursor(pageRows[pageRows.length - 1]!.id) : null;
    return { items: pageRows.map(toDTO), nextCursor };
  }

  async create(ctx: ServiceContext, body: CreateNotifyRuleBody): Promise<NotifyRuleDTO> {
    if (typeof body.target !== "string" || body.target.trim().length === 0) {
      throw new ServiceError("validation_failed", 400, "target is required");
    }
    const kind = body.kind === undefined ? "sender" : body.kind;
    if (typeof kind !== "string" || kind.trim().length === 0) {
      throw new ServiceError("validation_failed", 400, "kind must be a non-empty string");
    }
    const [row] = await ctx.db.insert(notifyRules).values({
      accountId: ctx.accountId, target: body.target, kind, createdAt: ctx.now(),
    }).returning();
    return toDTO(row!);
  }

  async remove(ctx: ServiceContext, id: string): Promise<void> {
    const deleted = await ctx.db.delete(notifyRules)
      .where(and(eq(notifyRules.id, id), eq(notifyRules.accountId, ctx.accountId)))
      .returning();
    if (deleted.length === 0) throw new ServiceError("not_found", 404, "notify rule not found");
  }
}

export const notifyRulesService = new NotifyRulesService();
