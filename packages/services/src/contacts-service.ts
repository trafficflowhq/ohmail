import { and, asc, eq, gt, ilike } from "drizzle-orm";
import { contacts, contactNotes, threadNotes, threads } from "@trafficflow/db";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { clampLimit, decodeListCursor, encodeListCursor } from "./pagination.js";
import type { ContactDTO, NoteDTO, Page } from "./dto/types.js";

/**
 * THE LONGEST `?q=` THE CONTACT LIST ACCEPTS.
 *
 * `q` becomes the ILIKE pattern `'%' || q || '%'`, which is an unanchored substring match run
 * against every contact row the account owns — the pattern length is a per-row cost and the
 * caller chose it, with no bound at all.
 *
 * **320, and the number is a deliberate over-cap rather than a derivation.** Pasting a complete
 * address into the contact search is the obvious thing to do with this field, so the ceiling has
 * to clear the longest address a row can hold. RFC 5321 §4.5.3.1 makes a usable mailbox 254
 * octets (the forward path is capped at 256 including the brackets, so the 64 + 1 + 255 component
 * maxima cannot all be met at once) — but `contacts.address` is a `text` column written from
 * whatever arrived, with no such validator, so the deliverable maximum is not the storable one.
 * 320 clears both with room, and being generous here costs one bounded ILIKE pattern.
 *
 * Deliberately NOT `SEARCH_QUERY_MAX_CHARS` (200), which bounds free-text prose against a trigram
 * index and has no reason to accommodate an address.
 *
 * A 400, never a truncation: a shortened pattern silently matches MORE rows than the caller
 * asked about, which on a contact list is the wrong direction to be silently wrong in.
 */
export const CONTACTS_QUERY_MAX_CHARS = 320;

export interface ListContactsOptions {
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface ListNotesOptions {
  cursor?: string;
  limit?: number;
}

/** A `contact_notes` / `thread_notes` row shape (both share these columns). */
interface NoteRow {
  id: string;
  body: string;
  updatedAt: Date;
}

function contactToDTO(row: typeof contacts.$inferSelect): ContactDTO {
  return {
    id: row.id,
    name: row.name ?? null,
    addresses: [row.address],
    // Screener-outcome derivation is out of scope for this slice; default "unknown".
    screened: "unknown",
    lastSeenAt: null,
    updatedAt: row.createdAt.toISOString(),   // contacts has no updatedAt column (0010 added only `name`)
  };
}

/**
 * ContactsService (contract §5.12) — the reference/contacts surface plus the
 * free-text notes pinned to a contact card OR a thread. REST-only (no change_log,
 * RC4): clients refetch. Every query is scoped to `ctx.accountId` — a
 * cross-account id is indistinguishable from a missing one → 404. Adding a note
 * verifies the parent contact/thread belongs to the account FIRST (IDOR guard).
 *
 * `/notes/:id` (PATCH/DELETE) resolves an id that may live in EITHER note table:
 * the account-scoped UPDATE/DELETE is attempted against `contact_notes` first,
 * then `thread_notes`; only when neither matches is it a 404.
 */
export class ContactsService {
  async list(ctx: ServiceContext, opts: ListContactsOptions = {}): Promise<Page<ContactDTO>> {
    const limit = clampLimit(opts.limit);
    const filters = [eq(contacts.accountId, ctx.accountId)];
    // `q` matches the ADDRESS, case-insensitively — not the display name, which this used to
    // claim. Adding `or ilike(contacts.name, …)` is a behaviour change with its own product
    // question (a name match on a list keyed by address changes what "no results" means), so the
    // comment is corrected to what the predicate does rather than the predicate widened inside a
    // slice about bounds. Bounded BEFORE it becomes the pattern — see
    // {@link CONTACTS_QUERY_MAX_CHARS}.
    if (opts.q) {
      if (opts.q.length > CONTACTS_QUERY_MAX_CHARS) {
        throw new ServiceError(
          "validation_failed", 400,
          `q is ${opts.q.length} characters; the limit is ${CONTACTS_QUERY_MAX_CHARS}`,
        );
      }
      filters.push(ilike(contacts.address, `%${opts.q}%`));
    }
    if (opts.cursor) filters.push(gt(contacts.id, decodeListCursor(opts.cursor)));

    const rows = await ctx.db.select().from(contacts)
      .where(and(...filters)).orderBy(asc(contacts.id)).limit(limit + 1);

    const pageRows = rows.slice(0, limit);
    const items = pageRows.map(contactToDTO);
    const nextCursor = rows.length > limit ? encodeListCursor(pageRows[pageRows.length - 1]!.id) : null;
    return { items, nextCursor };
  }

  async get(ctx: ServiceContext, id: string): Promise<ContactDTO> {
    const [row] = await ctx.db.select().from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId))).limit(1);
    if (!row) throw new ServiceError("not_found", 404, "contact not found");
    return contactToDTO(row);
  }

  /** PATCH /contacts/:id { name } — the only editable field (0010). */
  async updateName(ctx: ServiceContext, id: string, name: string | null): Promise<ContactDTO> {
    if (name !== null && typeof name !== "string") {
      throw new ServiceError("validation_failed", 400, "name must be a string or null");
    }
    const updated = await ctx.db.update(contacts).set({ name })
      .where(and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)))
      .returning();
    if (updated.length === 0) throw new ServiceError("not_found", 404, "contact not found");
    return contactToDTO(updated[0]!);
  }

  // ── Notes ────────────────────────────────────────────────────────────────

  async listContactNotes(ctx: ServiceContext, contactId: string, opts: ListNotesOptions = {}): Promise<Page<NoteDTO>> {
    await this.assertContact(ctx, contactId);
    const limit = clampLimit(opts.limit);
    const filters = [eq(contactNotes.accountId, ctx.accountId), eq(contactNotes.contactId, contactId)];
    if (opts.cursor) filters.push(gt(contactNotes.id, decodeListCursor(opts.cursor)));
    const rows = await ctx.db.select({ id: contactNotes.id, body: contactNotes.body, updatedAt: contactNotes.updatedAt })
      .from(contactNotes).where(and(...filters)).orderBy(asc(contactNotes.id)).limit(limit + 1);
    return this.notePage(rows, limit, () => ({ kind: "contact", contactId }));
  }

  async addContactNote(ctx: ServiceContext, contactId: string, body: string): Promise<NoteDTO> {
    await this.assertContact(ctx, contactId);   // IDOR: the parent must belong to the account
    const validBody = this.validBody(body);
    const now = ctx.now();
    const [row] = await ctx.db.insert(contactNotes).values({
      accountId: ctx.accountId, contactId, body: validBody, createdAt: now, updatedAt: now,
    }).returning();
    return { id: row!.id, target: { kind: "contact", contactId }, body: row!.body, updatedAt: row!.updatedAt.toISOString() };
  }

  async listThreadNotes(ctx: ServiceContext, threadId: string, opts: ListNotesOptions = {}): Promise<Page<NoteDTO>> {
    await this.assertThread(ctx, threadId);
    const limit = clampLimit(opts.limit);
    const filters = [eq(threadNotes.accountId, ctx.accountId), eq(threadNotes.threadId, threadId)];
    if (opts.cursor) filters.push(gt(threadNotes.id, decodeListCursor(opts.cursor)));
    const rows = await ctx.db.select({ id: threadNotes.id, body: threadNotes.body, updatedAt: threadNotes.updatedAt })
      .from(threadNotes).where(and(...filters)).orderBy(asc(threadNotes.id)).limit(limit + 1);
    return this.notePage(rows, limit, () => ({ kind: "thread", threadId }));
  }

  async addThreadNote(ctx: ServiceContext, threadId: string, body: string): Promise<NoteDTO> {
    await this.assertThread(ctx, threadId);
    const validBody = this.validBody(body);
    const now = ctx.now();
    const [row] = await ctx.db.insert(threadNotes).values({
      accountId: ctx.accountId, threadId, body: validBody, createdAt: now, updatedAt: now,
    }).returning();
    return { id: row!.id, target: { kind: "thread", threadId }, body: row!.body, updatedAt: row!.updatedAt.toISOString() };
  }

  /**
   * PATCH /notes/:id — the note may be a contact_note OR a thread_note. Try the
   * account-scoped UPDATE against each table; the one that matches a row wins.
   */
  async updateNote(ctx: ServiceContext, noteId: string, body: string): Promise<NoteDTO> {
    const validBody = this.validBody(body);
    const now = ctx.now();

    const c = await ctx.db.update(contactNotes).set({ body: validBody, updatedAt: now })
      .where(and(eq(contactNotes.id, noteId), eq(contactNotes.accountId, ctx.accountId)))
      .returning();
    if (c.length > 0) {
      return { id: c[0]!.id, target: { kind: "contact", contactId: c[0]!.contactId }, body: c[0]!.body, updatedAt: c[0]!.updatedAt.toISOString() };
    }

    const t = await ctx.db.update(threadNotes).set({ body: validBody, updatedAt: now })
      .where(and(eq(threadNotes.id, noteId), eq(threadNotes.accountId, ctx.accountId)))
      .returning();
    if (t.length > 0) {
      return { id: t[0]!.id, target: { kind: "thread", threadId: t[0]!.threadId }, body: t[0]!.body, updatedAt: t[0]!.updatedAt.toISOString() };
    }

    throw new ServiceError("not_found", 404, "note not found");
  }

  /** DELETE /notes/:id — same dual-table, account-scoped resolution. */
  async deleteNote(ctx: ServiceContext, noteId: string): Promise<void> {
    const c = await ctx.db.delete(contactNotes)
      .where(and(eq(contactNotes.id, noteId), eq(contactNotes.accountId, ctx.accountId)))
      .returning();
    if (c.length > 0) return;

    const t = await ctx.db.delete(threadNotes)
      .where(and(eq(threadNotes.id, noteId), eq(threadNotes.accountId, ctx.accountId)))
      .returning();
    if (t.length > 0) return;

    throw new ServiceError("not_found", 404, "note not found");
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async assertContact(ctx: ServiceContext, contactId: string): Promise<void> {
    const [row] = await ctx.db.select({ id: contacts.id }).from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId))).limit(1);
    if (!row) throw new ServiceError("not_found", 404, "contact not found");
  }

  private async assertThread(ctx: ServiceContext, threadId: string): Promise<void> {
    const [row] = await ctx.db.select({ id: threads.id }).from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.accountId, ctx.accountId))).limit(1);
    if (!row) throw new ServiceError("not_found", 404, "thread not found");
  }

  private notePage(rows: NoteRow[], limit: number | undefined, target: (r: NoteRow) => NoteDTO["target"]): Page<NoteDTO> {
    const cap = clampLimit(limit);
    const pageRows = rows.slice(0, cap);
    const items: NoteDTO[] = pageRows.map((r) => ({ id: r.id, target: target(r), body: r.body, updatedAt: r.updatedAt.toISOString() }));
    const nextCursor = rows.length > cap ? encodeListCursor(pageRows[pageRows.length - 1]!.id) : null;
    return { items, nextCursor };
  }

  private validBody(v: unknown): string {
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new ServiceError("validation_failed", 400, "body is required");
    }
    return v;
  }
}

export const contactsService = new ContactsService();
