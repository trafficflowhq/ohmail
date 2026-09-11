import { and, asc, eq, sql } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import { assertOrganizerRole, assertAccountOrganizes, tags, messages, messageTags, recordChange, type Tx } from "@trafficflow/db";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { materializeTag } from "./dto/materialize.js";
import type { TagDTO } from "./dto/types.js";

/** Same shim every write service here uses (`approval-service.ts:43`): a `ServiceContext.db`
 *  is a real transaction host, but the union type does not say so. */
const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/**
 * The hues the client can render — `TagHueName` in `packages/ui`, the ten the Blanc token
 * families paint. This list MUST equal that one: a hue accepted here with no rule in `chip.css`
 * is an invisible dot. Validated here, not at the DB — a new hue must not need a migration
 * (`tags.hue` is plain `text`, no CHECK, mail 0031). The API's tag suite round-trips every member
 * and refuses a non-member. ORDER IS `TAG_HUES`' ORDER; the column stores the NAME. The seven new
 * names avoid `clay|slate|plum|amber|teal` — rows once accepted, still in the database, clamped
 * to moss — because re-admitting one would repaint an existing tag. Exported so
 * `test/tag-hues.test.ts` compares this set to the client's, not a copy.
 */
export const RENDERABLE_HUES = [
  "rosewood", "ochre", "olive", "moss", "verdigris",
  "denim", "indigo", "iris", "mulberry", "heather",
] as const;
export type TagHue = (typeof RENDERABLE_HUES)[number];

/** Longest tag name we store. Tags are labels, not notes — a rail entry that does not fit is
 *  a worse product than a refusal, and an unbounded text column keyed by a user is an easy
 *  way to bloat a row nobody can see. Exported for the profile import, whose tag names arrive
 *  from a public document rather than this service's own validated body and must meet the same
 *  ceiling or be skipped. */
export const MAX_TAG_NAME_CHARS = 40;
const MAX_NAME = MAX_TAG_NAME_CHARS;

export interface TagBody {
  name: string;
  hue?: string;
}

export interface AssignResult {
  /** The message's full tag id list AFTER the write — what the client renders. */
  labels: string[];
  /**
   * The tag the assignment actually landed on. Differs from the requested id only in the
   * tag-or-create path, when the name already existed and the pre-existing row won.
   */
  tagId: string;
  /** The `change_log` seq of the emitted `message` change, for `X-Sync-Seq`. */
  seq: number | null;
}

/**
 * TagsService — the account's own labels, keyed by message. A tag is a row in OUR Postgres —
 * NEVER an IMAP folder or keyword (`tags.no-imap.test.ts` guards). A disconnect KEEPS tags;
 * erasure takes them. THE WIRE IS A DELTA: `assign` takes ONE tag and a boolean, never the full
 * label array — a read-modify-write array loses one of two concurrent toggles; assign is `INSERT
 * … ON CONFLICT DO NOTHING`, unassign a `DELETE`, both idempotent. Exactly one method locks:
 * `remove` — deleting a tag races an `assign` (the parent delete dies on its FK); locking the
 * `tags` row FIRST makes the inserter wait, then fail as a 404. `assign` takes NO lock. Asserted
 * on REAL Postgres (`tags.pg.test.ts`).
 */
export class TagsService {
  private validName(raw: unknown): string {
    if (typeof raw !== "string") throw new ServiceError("validation_failed", 400, "name is required");
    const name = raw.trim().replace(/\s+/g, " ");
    if (!name) throw new ServiceError("validation_failed", 400, "name is required");
    if (name.length > MAX_NAME) {
      throw new ServiceError("validation_failed", 400, `name must be ${MAX_NAME} characters or fewer`);
    }
    return name;
  }

  private validHue(raw: unknown): TagHue {
    if (raw === undefined || raw === null) return "moss";
    if (typeof raw !== "string" || !RENDERABLE_HUES.includes(raw as TagHue)) {
      throw new ServiceError("validation_failed", 400, `hue must be one of ${RENDERABLE_HUES.join(", ")}`);
    }
    return raw as TagHue;
  }

  /** GET /tags — every tag on the account, oldest first (stable order for the rail). */
  async list(ctx: ServiceContext): Promise<TagDTO[]> {
    const rows = await ctx.db.select().from(tags)
      .where(eq(tags.accountId, ctx.accountId)).orderBy(asc(tags.createdAt), asc(tags.id));
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      hue: t.hue,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    }));
  }

  /**
   * POST /tags — mint a tag. The `change_log` row is emitted IN the transaction, which is the
   * difference between a tag that exists and one the client can see: the mirror is fed only by
   * the sync drain, so a tag created without a change row would sit in Postgres and never reach
   * the rail — the "built, tested, unreachable" shape. A duplicate name is a 409 rather than a
   * silent no-op or a second row: the unique index is on `lower(name)`, so "Invoices" and
   * "invoices" collide, and the user needs to know which survived rather than discovering later
   * that their new tag went nowhere.
   */
  async create(ctx: ServiceContext, body: TagBody): Promise<{ dto: TagDTO; seq: number | null }> {
    const name = this.validName(body?.name);
    const hue = this.validHue(body?.hue);
    const now = ctx.now();

    const { id, seq } = await asTx(ctx).transaction(async (tx) => {
      // A READER'S ACCOUNT DEFINES NO TAGS (mail 0083). Account-scoped, not per-mailbox: a tag
      // name belongs to the account and is carried in the travelling profile, so the question is
      // whether this install organizes ANYTHING. On a one-mailbox standalone that collapses to
      // "all refused", which is correct — a definition this install will never apply is a
      // settings screen that accepts an edit and silently does nothing.
      await assertAccountOrganizes(tx as unknown as Tx, ctx.accountId);
      const inserted = await tx.insert(tags)
        .values({ accountId: ctx.accountId, name, hue, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .returning({ id: tags.id });
      const row = inserted[0];
      if (!row) throw new ServiceError("conflict", 409, "a tag with that name already exists");
      const s = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "tag", entityId: row.id, op: "create", meta: null,
      });
      return { id: row.id, seq: s };
    });

    const dto = await materializeTag(ctx.db, ctx.accountId, id);
    if (!dto) throw new ServiceError("internal", 500, "tag vanished after write");
    return { dto, seq: seq === null ? null : Number(seq) };
  }

  /** PATCH /tags/:id — rename and/or recolour. A name collision is a 409, as on create. */
  async update(ctx: ServiceContext, id: string, body: TagBody): Promise<{ dto: TagDTO; seq: number | null }> {
    const patch: { name?: string; hue?: string; updatedAt: Date } = { updatedAt: ctx.now() };
    if (body?.name !== undefined) patch.name = this.validName(body.name);
    if (body?.hue !== undefined) patch.hue = this.validHue(body.hue);

    const seq = await asTx(ctx).transaction(async (tx) => {
      // A READER'S ACCOUNT DEFINES NO TAGS (mail 0083). Account-scoped, not per-mailbox: a tag
      // name belongs to the account and is carried in the travelling profile, so the question is
      // whether this install organizes ANYTHING. On a one-mailbox standalone that collapses to
      // "all refused", which is correct — a definition this install will never apply is a
      // settings screen that accepts an edit and silently does nothing.
      await assertAccountOrganizes(tx as unknown as Tx, ctx.accountId);
      const updated = await tx.update(tags).set(patch)
        .where(and(eq(tags.id, id), eq(tags.accountId, ctx.accountId)))
        .returning({ id: tags.id })
        .catch((e: unknown) => {
          if (isUniqueViolation(e)) throw new ServiceError("conflict", 409, "a tag with that name already exists");
          throw e;
        });
      if (updated.length === 0) throw new ServiceError("not_found", 404, "tag not found");
      return recordChange(tx, {
        accountId: ctx.accountId, entityType: "tag", entityId: id, op: "update", meta: null,
      });
    });

    const dto = await materializeTag(ctx.db, ctx.accountId, id);
    if (!dto) throw new ServiceError("internal", 500, "tag vanished after write");
    return { dto, seq: seq === null ? null : Number(seq) };
  }

  /**
   * DELETE /tags/:id — the tag and every assignment of it. THE `FOR UPDATE` IS THE POINT: without
   * it, a concurrent `assign` of this tag inserts a `message_tags` row between the child delete
   * and the parent delete, and the parent delete dies on its FK. Taking the parent row's lock
   * first makes the inserter wait and then fail cleanly as a 404. Every affected message gets a
   * `message` change, because each of their `labels` arrays just changed — a client that heard
   * only the tag's `delete` would drop it from the rail and keep rendering it on the rows until
   * the next unrelated update.
   */
  async remove(ctx: ServiceContext, id: string): Promise<{ seq: number | null }> {
    const seq = await asTx(ctx).transaction(async (tx) => {
      // A READER'S ACCOUNT DEFINES NO TAGS (mail 0083). Account-scoped, not per-mailbox: a tag
      // name belongs to the account and is carried in the travelling profile, so the question is
      // whether this install organizes ANYTHING. On a one-mailbox standalone that collapses to
      // "all refused", which is correct — a definition this install will never apply is a
      // settings screen that accepts an edit and silently does nothing.
      await assertAccountOrganizes(tx as unknown as Tx, ctx.accountId);
      // Lock the parent FIRST, through the seam: the lock, not the read, is what a concurrent
      // assign blocks on.
      const locked = await dialect(ctx.db).forUpdate(tx.select({ id: tags.id }).from(tags)
        .where(and(eq(tags.id, id), eq(tags.accountId, ctx.accountId)))
        .limit(1));
      if (locked.length === 0) throw new ServiceError("not_found", 404, "tag not found");

      const cleared = await tx.delete(messageTags)
        .where(and(eq(messageTags.tagId, id), eq(messageTags.accountId, ctx.accountId)))
        .returning({ messageId: messageTags.messageId });

      await tx.delete(tags).where(and(eq(tags.id, id), eq(tags.accountId, ctx.accountId)));

      let last: bigint | null = null;
      for (const row of cleared) {
        last = await recordChange(tx, {
          accountId: ctx.accountId, entityType: "message", entityId: row.messageId, op: "update", meta: null,
        });
      }
      last = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "tag", entityId: id, op: "delete", meta: null,
      });
      return last;
    });
    return { seq: seq === null ? null : Number(seq) };
  }

  /**
   * POST /messages/:id/tags — assign or unassign ONE tag; the delta verb. Both directions are
   * idempotent, which makes this safe to retry and safe to race: assigning twice leaves one row
   * (`ON CONFLICT DO NOTHING` on the PK) and unassigning twice deletes nothing the second time.
   * Neither direction reads the label array first, so there is no window in which a concurrent
   * toggle of a DIFFERENT tag can be lost. The emitted change is a `message` update, not a new
   * entity kind — the client re-reads the message and gets its whole `labels` array from
   * `materializeMessages`, so it can never hold an assignment naming a tag it has not seen.
   */
  async assign(
    ctx: ServiceContext, messageId: string, tagId: string, assigned: boolean, createName?: string,
  ): Promise<AssignResult> {
    if (typeof assigned !== "boolean") {
      throw new ServiceError("validation_failed", 400, "assigned must be a boolean");
    }
    if (typeof tagId !== "string" || !tagId) {
      throw new ServiceError("validation_failed", 400, "tagId is required");
    }
    const name = createName === undefined ? undefined : this.validName(createName);

    const { seq, effectiveTagId } = await asTx(ctx).transaction(async (tx) => {
      // Both rows must belong to the caller. Checked here rather than trusted from the URL:
      // `message_tags` is the one table that references two account-scoped parents, and a
      // cross-account id must be a 404 rather than a row nobody can see but that exists.
      const [msg] = await tx.select({ id: messages.id, mailboxId: messages.mailboxId }).from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.accountId, ctx.accountId))).limit(1);
      if (!msg) throw new ServiceError("not_found", 404, "message not found");
      /**
       * A READER DOES NOT ASSIGN TAGS (mail 0083). A tag looks like a label and is not only a
       * label: `message_tags` is read by the rules path and the retro passes, so an assignment on
       * a mailbox this install does not organize is an input to filing this install will never
       * perform and the organizer will never see (the travelling profile carries tag NAMES, no
       * per-message state). The tag DEFINITIONS — create, rename, delete — are account
       * configuration, gated on whether the account organizes anything at all. Naming a colour is
       * not a statement about one mailbox; putting that colour on one message is.
       */
      await assertOrganizerRole(tx as unknown as Tx, dialect(ctx.db), ctx.accountId, msg.mailboxId);

      let resolved = tagId;
      let tagSeq: bigint | null = null;

      if (name !== undefined) {
        // TAG-OR-CREATE. The insert carries the CLIENT's id so a genuinely new tag lands under
        // the id the optimistic paint already used. `ON CONFLICT DO NOTHING` covers both unique
        // objects on this table — the PK and `tags_account_name_uq` — so a concurrent creator
        // of the same name does not raise, it just loses; the read-back below then resolves the
        // winner's id and both users end up assigning the SAME tag rather than one of them
        // getting a 409 for typing a word at the wrong moment.
        const created = await tx.insert(tags)
          .values({ id: tagId, accountId: ctx.accountId, name, hue: "moss", createdAt: ctx.now(), updatedAt: ctx.now() })
          .onConflictDoNothing()
          .returning({ id: tags.id });
        if (created[0]) {
          resolved = created[0].id;
          // The `tag` entity must reach the mirror or the chip never renders: the client
          // filters assignments by the tags it knows. Emitted in-tx, like every other change
          // here, so a tag can never exist without the change row that announces it.
          tagSeq = await recordChange(tx, {
            accountId: ctx.accountId, entityType: "tag", entityId: resolved, op: "create", meta: null,
          });
        } else {
          // Share-locked for the same reason as the plain-id branch below: the winner of the
          // name race must not be deleted out from under this assign between here and the
          // insert.
          const [existing] = await dialect(ctx.db).forUpdate(
            tx.select({ id: tags.id }).from(tags)
              .where(and(eq(tags.accountId, ctx.accountId), sql`lower(${tags.name}) = lower(${name})`))
              .limit(1),
            { mode: "share" });
          if (!existing) throw new ServiceError("conflict", 409, "tag id already in use");
          resolved = existing.id;
        }
      } else {
        // A SHARED LOCK, AND THE LOCK IS THE WHOLE POINT — a plain SELECT here is a bug
        // `tags.pg.test.ts` caught on real Postgres and PGlite could never show. Under READ
        // COMMITTED an unlocked read sees a tag whose DELETE has not committed, waves the assign
        // through, and the INSERT blocks on the FK's parent-row lock and raises `23503` — a 500
        // for "that tag is gone". The share lock moves the wait one statement earlier: this
        // select blocks on the deleter's exclusive lock, and when the delete commits the row is
        // simply not there — a truthful 404. SHARE, not UPDATE: share locks are compatible with
        // each other, so concurrent assigns of one tag still run in parallel; only `remove`'s
        // exclusive lock conflicts, exactly the pair that must be ordered. The STRENGTH travels
        // with the call: promoting it while porting would serialize what must stay parallel.
        const [tag] = await dialect(ctx.db).forUpdate(
          tx.select({ id: tags.id }).from(tags)
            .where(and(eq(tags.id, tagId), eq(tags.accountId, ctx.accountId)))
            .limit(1),
          { mode: "share" });
        if (!tag) throw new ServiceError("not_found", 404, "tag not found");
      }

      if (assigned) {
        await tx.insert(messageTags)
          .values({ accountId: ctx.accountId, messageId, tagId: resolved, createdAt: ctx.now() })
          .onConflictDoNothing();
      } else {
        await tx.delete(messageTags).where(and(
          eq(messageTags.messageId, messageId),
          eq(messageTags.tagId, resolved),
          eq(messageTags.accountId, ctx.accountId),
        ));
      }

      const s = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "message", entityId: messageId, op: "update", meta: null,
      });
      return { seq: s ?? tagSeq, effectiveTagId: resolved };
    });

    const rows = await ctx.db.select({ tagId: messageTags.tagId }).from(messageTags)
      .where(and(eq(messageTags.messageId, messageId), eq(messageTags.accountId, ctx.accountId)));
    return { labels: rows.map((r) => r.tagId), tagId: effectiveTagId, seq: seq === null ? null : Number(seq) };
  }

  /**
   * Erase every tag row for an account. Called by `AccountDeletionService` BEFORE it deletes
   * `messages`, or the `message_tags → messages` FK refuses. Exported as a service method
   * rather than inlined there so the ordering constraint lives next to the tables it is about.
   */
  async eraseAccount(tx: Tx, accountId: string): Promise<{ messageTags: number; tags: number }> {
    const mt = await tx.delete(messageTags).where(eq(messageTags.accountId, accountId)).returning({ id: messageTags.tagId });
    const tg = await tx.delete(tags).where(eq(tags.accountId, accountId)).returning({ id: tags.id });
    return { messageTags: mt.length, tags: tg.length };
  }
}

/**
 * A unique-constraint violation, across both drivers. postgres-js surfaces `code` on the error;
 * PGlite nests it. Matched on SQLSTATE 23505 and not on the message text, which is localized.
 */
function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

export const tagsService = new TagsService();
