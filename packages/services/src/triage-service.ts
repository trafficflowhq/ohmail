import { and, asc, eq, gt } from "drizzle-orm";
import { messages, messageStates, folderState, claimIdempotencyKey, recordChange, type Tx } from "@trafficflow/db";
import type { Db, ServiceContext } from "./context.js";
import { ServiceError, IdempotencyRaceLost } from "./errors.js";
import { upsertDesiredSeen } from "./flag-intent.js";
import { materializeMessage, materializeMessageState } from "./dto/materialize.js";
import { clampLimit, decodeListCursor, encodeListCursor } from "./pagination.js";
import type { MessageDTO, MessageStateDTO, Page, TriageState } from "./dto/types.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;
/** Materialize inside the ambient tx (reads its uncommitted writes) — same query surface as Db. */
const asDb = (tx: Tx): Db => tx as unknown as Db;

export interface TriageSetBody {
  state: TriageState;
  /**
   * REQUIRED for `bubbled_up`, and FORCED NULL for every other state — including `resurfaced`,
   * which is the one where a client might plausibly send one.
   *
   * Dropped rather than refused: a client that sends a timestamp with `resurfaced` is not making
   * a different request, it is over-specifying this one. Storing it would be the harm — the
   * worker's due-scan selects on `bubble_up_at`, so a resurfaced row carrying a future date is a
   * second flip waiting to happen, and every surface that renders the column (`triagePiles`'
   * `resurfaceAt`) would read it as "still scheduled".
   */
  bubbleUpAt?: string;
}

/** Idempotency handle threaded in by the route; the row is written IN the setState tx. */
export interface TriageIdempotency {
  key: string;
  requestHash: string;
}

export interface ListOptions {
  cursor?: string;
  limit?: number;
}

export interface FocusReplyView {
  items: Array<{ message: MessageDTO; draft: null }>;   // draft populated once drafting is wired
  remaining: number;
}

export interface PowerThroughView {
  current: MessageDTO | null;
  remaining: number;
  nextCursor: string | null;
}

/**
 * TriageService. The bottom-pile states (`reply_later`, `set_aside`,
 * `bubbled_up`, `muted`) live in `message_states`; every transition is user-wins
 * (no If-Match) and emits a `message_state` `update` change — plus the `message` update its
 * DTO's embedded `triage` needs — through the same `change_log` seam SyncService reads. The
 * Reply Run and Power Through are pure read views over these states + the Imbox — no separate
 * write logic.
 *
 * `resurfaced` is settable here too, and it is NOT a bottom pile: it pins the row at the top of
 * the Ohbox. See {@link TriageService.resurfaceNow} and `dto/types.ts#TriageState`.
 */
export class TriageService {
  /**
   * Upsert the triage state for a message and emit the `message_state` update change
   * atomically. `bubbleUpAt` is REQUIRED when transitioning to `bubbled_up`.
   */
  async setState(
    ctx: ServiceContext, messageId: string, b: TriageSetBody,
    opts: { idempotency?: TriageIdempotency | null } = {},
  ): Promise<MessageStateDTO> {
    if (b.state === "bubbled_up" && !b.bubbleUpAt) {
      throw new ServiceError("validation_failed", 400, "bubbleUpAt is required when state is 'bubbled_up'");
    }
    const bubbleUpAt = b.state === "bubbled_up" ? new Date(b.bubbleUpAt!) : null;
    if (bubbleUpAt && Number.isNaN(bubbleUpAt.getTime())) {
      throw new ServiceError("validation_failed", 400, "bubbleUpAt is not a valid ISO datetime");
    }

    return asTx(ctx).transaction(async (tx) => {
      // Cross-account guard: the message must belong to the caller's account.
      const [msg] = await tx.select({ id: messages.id }).from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.accountId, ctx.accountId))).limit(1);
      if (!msg) throw new ServiceError("not_found", 404, "message not found");

      const now = ctx.now();
      const [row] = await tx.insert(messageStates).values({
        accountId: ctx.accountId, messageId, state: b.state, bubbleUpAt, setAt: now, updatedAt: now,
      }).onConflictDoUpdate({
        target: messageStates.messageId,
        set: { state: b.state, bubbleUpAt, updatedAt: now },
      }).returning({ id: messageStates.id });

      /**
       * ── RESURFACING RE-UNREADS, WHATEVER STARTED IT ─────────────────────────────────────
       *
       * "Resurface this now" and the worker's due flip are the same event at two triggers, so
       * they carry the same consequence: the row comes back UNREAD, because unread is the one
       * honest way this product draws an eye to a row, and most resurfaced mail was read before
       * it was put away. The mark is tied to the EVENT — never to import, never re-applied on a
       * sync — which is what lets it coexist with `\Seen` adoption: the `flag_state` intent
       * written here (`desired_seen = false`, ours, pending) makes the worker REMOVE `\Seen` on
       * the real server, and until it does, `applyExternalFlag`'s our-write-pending guard keeps
       * the server's stale flag from re-reading the row. `bubbleUpPass` writes the identical
       * trio for the scheduled trigger; `lastReadAt` is cleared because the reading it recorded
       * has been deliberately disowned — the row must sort as new attention, not as recently
       * finished with.
       */
      if (b.state === "resurfaced") {
        const [msgRow] = await tx.select({ unread: messages.unread }).from(messages)
          .where(eq(messages.id, messageId)).limit(1);
        await tx.update(messages)
          .set({ unread: true, lastReadAt: null, updatedAt: now })
          .where(and(eq(messages.id, messageId), eq(messages.accountId, ctx.accountId)));
        await upsertDesiredSeen(tx, messageId, !(msgRow?.unread ?? true), false, now);
      }

      await recordChange(tx, {
        accountId: ctx.accountId, entityType: "message_state", entityId: row!.id, op: "update", meta: null,
      });

      /**
       * ── AND THE MESSAGE, BECAUSE ITS DTO EMBEDS THIS STATE ────────────────────────────────
       *
       * `MessageDTO.triage` is a projection of the row just written, so a delta that moves the
       * row without re-emitting its projection leaves every mirror internally inconsistent: the
       * `message_state` entity says one thing and the `message` entity's `triage` field, applied
       * at an earlier seq and never touched again, goes on saying another.
       *
       * That is not a theoretical inconsistency. `selectors.ts#isResurfaced` — the whole of how
       * the Ohbox pins a resurfaced row — reads `message.triage.state`, and the client joins
       * nothing: `apply.ts` is a keyed upsert per (type,id) and has no business deriving one
       * entity from another. So with only the `message_state` change on the wire, a resurfaced
       * row pinned on the device that set it (its optimistic effect writes BOTH entities —
       * `mutations.ts`) and pinned nowhere else, including on this device after the overlay was
       * dropped. The two halves of the mutation meant different things.
       *
       * Emitted for EVERY state, not just `resurfaced`: the projection is stale after any of
       * them, and a conditional here would be a second rule about when `message.triage` can be
       * trusted. `MessageService.markSeen` already emits the pair for the same reason.
       *
       * SECOND, so the returned seq is the highest of the two — a caller that echoes it as
       * `X-Sync-Seq` is naming the point at which BOTH changes are visible.
       */
      const seqBig = await recordChange(tx, {
        accountId: ctx.accountId, entityType: "message", entityId: messageId, op: "update", meta: null,
      });

      // Materialize the DTO INSIDE the tx (reads the uncommitted upsert) so the
      // idempotency row stores the exact response.
      const dto = await materializeMessageState(asDb(tx), ctx.accountId, row!.id);
      if (!dto) throw new ServiceError("internal", 500, "message_state vanished after write");

      // Store the verbatim response IN this tx so a commit-then-crash retry
      // replays the SAME 200. Inserted directly (services can't import packages/api).
      if (opts.idempotency) {
        const claimed = await claimIdempotencyKey(tx, {
          accountId: ctx.accountId,
          key: opts.idempotency.key,
          requestHash: opts.idempotency.requestHash,
          responseStatus: 200,
          responseJson: dto,
          seq: Number(seqBig),
          now: ctx.now(),
        });
        // A LOST claim = a concurrent same-key request committed first. Throwing rolls THIS
        // transaction back (effect included) and the caller replays the winner's response.
        if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
      }

      return dto;
    });
  }

  // ── Convenience transitions (thin wrappers over setState) ──
  replyLater(ctx: ServiceContext, messageId: string): Promise<MessageStateDTO> {
    return this.setState(ctx, messageId, { state: "reply_later" });
  }
  setAside(ctx: ServiceContext, messageId: string): Promise<MessageStateDTO> {
    return this.setState(ctx, messageId, { state: "set_aside" });
  }
  bubbleUp(ctx: ServiceContext, messageId: string, untilTs: string): Promise<MessageStateDTO> {
    return this.setState(ctx, messageId, { state: "bubbled_up", bubbleUpAt: untilTs });
  }
  /**
   * RESURFACE NOW — the horizon chooser's fourth answer, and the only one that is not a date.
   *
   * Deliberately NOT `bubbleUp(ctx, id, <a moment ago>)`. That spelling depends on a bubble-up
   * pass to mean anything, and the pass is not a promise the product can make at this latency:
   * it runs inside the worker's cycle behind a 60s gate, and a standalone desktop install runs no
   * worker at all. So "now" writes the state the schedule exists to reach, in one transaction,
   * and the row is pinned by the time the response is written.
   */
  resurfaceNow(ctx: ServiceContext, messageId: string): Promise<MessageStateDTO> {
    return this.setState(ctx, messageId, { state: "resurfaced" });
  }
  mute(ctx: ServiceContext, messageId: string): Promise<MessageStateDTO> {
    return this.setState(ctx, messageId, { state: "muted" });
  }
  clear(ctx: ServiceContext, messageId: string): Promise<MessageStateDTO> {
    return this.setState(ctx, messageId, { state: "none" });
  }

  /** The bottom piles: messages currently in a given triage state. */
  async listByState(ctx: ServiceContext, state: TriageState, opts: ListOptions = {}): Promise<Page<MessageDTO>> {
    const limit = clampLimit(opts.limit);
    const filters = [
      eq(messageStates.accountId, ctx.accountId),
      eq(messageStates.state, state),
    ];
    if (opts.cursor) filters.push(gt(messageStates.messageId, decodeListCursor(opts.cursor)));

    const rows = await ctx.db.select({ messageId: messageStates.messageId }).from(messageStates)
      .where(and(...filters)).orderBy(asc(messageStates.messageId)).limit(limit + 1);

    const pageRows = rows.slice(0, limit);
    const items: MessageDTO[] = [];
    for (const r of pageRows) {
      const dto = await materializeMessage(ctx.db, ctx.accountId, r.messageId);
      if (dto) items.push(dto);
    }
    const nextCursor = rows.length > limit ? encodeListCursor(pageRows[pageRows.length - 1]!.messageId) : null;
    return { items, nextCursor };
  }

  /** Reply Run — the distraction-free batch over the Answer-Later pile. */
  async focusReply(ctx: ServiceContext): Promise<FocusReplyView> {
    const page = await this.listByState(ctx, "reply_later", { limit: 200 });
    return {
      items: page.items.map((message) => ({ message, draft: null as null })),
      remaining: page.items.length,
    };
  }

  /** Power Through — one-by-one over the "New" group (unread Ohbox / INBOX). */
  async powerThrough(ctx: ServiceContext, opts: ListOptions = {}): Promise<PowerThroughView> {
    const filters = [
      eq(messages.accountId, ctx.accountId),
      eq(messages.unread, true),
      eq(folderState.desiredFolder, "INBOX"),
    ];
    if (opts.cursor) filters.push(gt(messages.id, decodeListCursor(opts.cursor)));

    const rows = await ctx.db.select({ id: messages.id }).from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(...filters)).orderBy(asc(messages.id));

    if (rows.length === 0) return { current: null, remaining: 0, nextCursor: null };
    const current = await materializeMessage(ctx.db, ctx.accountId, rows[0]!.id);
    const nextCursor = rows.length > 1 ? encodeListCursor(rows[0]!.id) : null;
    return { current, remaining: rows.length, nextCursor };
  }
}

export const triageService = new TriageService();
