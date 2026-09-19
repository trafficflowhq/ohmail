import { and, asc, eq, gt } from "drizzle-orm";
import { snippets } from "@trafficflow/db";
import { withAccountTx, type ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { clampLimit, decodeListCursor, encodeListCursor } from "./pagination.js";
import type { Page, SnippetDTO } from "./dto/types.js";

export interface SnippetBody {
  title: string;
  body: string;
  shortcut?: string | null;
}

export interface ListSnippetsOptions {
  cursor?: string;
  limit?: number;
}

function toDTO(row: typeof snippets.$inferSelect): SnippetDTO {
  return { id: row.id, title: row.title, body: row.body, shortcut: row.shortcut ?? null, updatedAt: row.updatedAt.toISOString() };
}

/**
 * SnippetsService (contract §5.13) — the compose-time canned-text library. Plain
 * account-scoped CRUD, REST-only (no change_log, RC4). PUT is a FULL replace of
 * `title`/`body`/`shortcut`. `title` and `body` are validated non-empty; a
 * cross-account id is a 404.
 */
export class SnippetsService {
  async list(ctx: ServiceContext, opts: ListSnippetsOptions = {}): Promise<Page<SnippetDTO>> {
    const limit = clampLimit(opts.limit);
    const filters = [eq(snippets.accountId, ctx.accountId)];
    if (opts.cursor) filters.push(gt(snippets.id, decodeListCursor(opts.cursor)));
    // scoped-by: `filters` above leads with eq(snippets.accountId, ctx.accountId)
    const rows = await ctx.db.select().from(snippets)
      .where(and(...filters)).orderBy(asc(snippets.id)).limit(limit + 1);
    const pageRows = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeListCursor(pageRows[pageRows.length - 1]!.id) : null;
    return { items: pageRows.map(toDTO), nextCursor };
  }

  async get(ctx: ServiceContext, id: string): Promise<SnippetDTO> {
    const [row] = await ctx.db.select().from(snippets)
      .where(and(eq(snippets.id, id), eq(snippets.accountId, ctx.accountId))).limit(1);
    if (!row) throw new ServiceError("not_found", 404, "snippet not found");
    return toDTO(row);
  }

  async create(ctx: ServiceContext, body: SnippetBody): Promise<SnippetDTO> {
    const title = this.validText(body.title, "title");
    const text = this.validText(body.body, "body");
    const shortcut = this.validShortcut(body.shortcut);
    const now = ctx.now();
    // Through the fenced door: `snippets` hangs off the account alone, and `accounts` survives
    // Art. 17 erasure — see `withAccountTx` for why an unfenced insert here recreates erased state.
    const row = await withAccountTx(ctx, async (tx) => {
      const [created] = await tx.insert(snippets).values({
        accountId: ctx.accountId, title, body: text, shortcut, createdAt: now, updatedAt: now,
      }).returning();
      return created;
    });
    return toDTO(row!);
  }

  /** PUT /snippets/:id — full replace of all three fields. */
  async update(ctx: ServiceContext, id: string, body: SnippetBody): Promise<SnippetDTO> {
    const title = this.validText(body.title, "title");
    const text = this.validText(body.body, "body");
    const shortcut = this.validShortcut(body.shortcut);
    // Through the one door, like the insert above. A statement issued straight on the handle is
    // outside the device store's transaction queue: it lands inside whatever transaction is open
    // and is rolled back with it, after this method has already answered with the new row.
    const updated = await withAccountTx(ctx, async (tx) => tx.update(snippets)
      .set({ title, body: text, shortcut, updatedAt: ctx.now() })
      .where(and(eq(snippets.id, id), eq(snippets.accountId, ctx.accountId)))
      .returning());
    if (updated.length === 0) throw new ServiceError("not_found", 404, "snippet not found");
    return toDTO(updated[0]!);
  }

  async remove(ctx: ServiceContext, id: string): Promise<void> {
    const deleted = await withAccountTx(ctx, async (tx) => tx.delete(snippets)
      .where(and(eq(snippets.id, id), eq(snippets.accountId, ctx.accountId)))
      .returning());
    if (deleted.length === 0) throw new ServiceError("not_found", 404, "snippet not found");
  }

  private validText(v: unknown, field: string): string {
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new ServiceError("validation_failed", 400, `${field} is required`);
    }
    return v;
  }

  private validShortcut(v: unknown): string | null {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw new ServiceError("validation_failed", 400, "shortcut must be a string");
    const trimmed = v.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
}

export const snippetsService = new SnippetsService();
