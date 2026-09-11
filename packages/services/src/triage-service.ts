import { and, asc, eq, gt, sql, type SQL } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import { assertOrganizerRole, messages, messageStates, folderState, claimIdempotencyKey, recordChange, type Tx } from "@trafficflow/db";
import type { Db, ServiceContext } from "./context.js";
import { ServiceError, IdempotencyRaceLost } from "./errors.js";
import {
  materializeMessage, materializeMessageState, materializeMessagesInOrder,
} from "./dto/materialize.js";
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
 * TriageService. The bottom-pile states (`reply_later`, `set_aside`, `bubbled_up`, `muted`) live
 * in `message_states`; every transition is user-wins (no If-Match) and emits a `message_state`
 * `update` change — plus the `message` update its DTO's embedded `triage` needs — through the
 * same `change_log` seam SyncService reads. The Reply Run and Power Through are pure read views
 * over these states + the Imbox — no separate write logic. `resurfaced` is settable here too, and
 * it is NOT a bottom pile: it pins the row at the top of the Ohbox (`resurfaceNow`,
 * `dto/types.ts#TriageState`).
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
      // Cross-account guard: the message must belong to the caller's account — and the select
      // takes the MESSAGE ROW LOCK, which is what serializes concurrent
      // `setState` calls on one message: the prior-state read below classifies the transition,
      // and a classification read beside an uncommitted sibling transition would mis-file the
      // re-homing (a park committing under a stale clear left the clear reading `none` — a
      // review caught it; the state row cannot carry the lock because a first park has no row
      // to lock yet). `date` rides the same select for the re-homing below.
      const [msg] = await dialect(ctx.db).forUpdate(tx.select({
        id: messages.id, date: messages.date,
        // Mail 0083 — the mailbox this message belongs to, so the role can be asked about the
        // right row. It rides the select that was already being made and already holds the lock;
        // a second query would be a second snapshot.
        mailboxId: messages.mailboxId,
      })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.accountId, ctx.accountId)))
        .limit(1));
      if (!msg) throw new ServiceError("not_found", 404, "message not found");
      /**
       * A READER DOES NOT TRIAGE (mail 0083). Triage is not a label: `bubbled_up` and the pile
       * transitions re-home mail, and the passes that act on them run on the organizer's
       * authority against the organizer's store. A reader recording a state would be writing an
       * intent nothing on this install will carry out, on a mailbox another install is actively
       * arranging. PER MAILBOX, not per account: an account may hold mailboxes with different
       * roles — one organized here, one on somebody's laptop — and this door's question is about
       * the message in front of it.
       */
      await assertOrganizerRole(tx as unknown as Tx, dialect(ctx.db), ctx.accountId, msg.mailboxId);

      // The state being LEFT — read before the upsert overwrites it (serialized by the message
      // row lock above). Only the `none` transition consumes it (the re-homing below).
      const [prior] = await tx.select({ state: messageStates.state, setAt: messageStates.setAt })
        .from(messageStates)
        .where(eq(messageStates.messageId, messageId)).limit(1);

      const now = ctx.now();
      const [row] = await tx.insert(messageStates).values({
        accountId: ctx.accountId, messageId, state: b.state, bubbleUpAt, setAt: now, updatedAt: now,
      }).onConflictDoUpdate({
        target: messageStates.messageId,
        // `setAt` REFRESHES with every transition: it is "when THIS state was set", and the
        // re-homing predicate below compares reading stamps against it — a second park that
        // kept the first cycle's instant would call a stamp from between the cycles "newer
        // than the pile entry" and skip the re-homing. The overlay has always
        // written a fresh `setAt` per transition; this makes the server agree. The one writer
        // that deliberately PRESERVES `setAt` is `spendResurface` — a release, not a
        // transition into a state — on both sides of the wire.
        set: { state: b.state, bubbleUpAt, setAt: now, updatedAt: now },
      }).returning({ id: messageStates.id });

      /**
       * UN-PARKING RE-HOMES THE ROW AT ITS OWN DATE, NOT AT THE TOP OF "EARLIER". A message that
       * LEAVES a bottom pile returns to "Earlier" at its CHRONOLOGICAL position. "Earlier" orders
       * by `lastReadAt`, and both stamps a parked row can carry are wrong: the glance before the
       * parking press stamps it NOW-ish; a row read in another client carries no stamp —
       * effectively lost. So leaving a pile disowns the parked interlude: `lastReadAt = date`
       * (`readTimeOf`'s idiom). Scoped three ways: only the `none` transition; only FROM a bottom
       * pile (a stray `none` must not move mail never parked); only a READ row — a reading stamp
       * on unread mail claims a reading that never happened.
       */
      const LEFT_PILE = prior !== undefined
        && ["reply_later", "set_aside", "bubbled_up", "muted"].includes(prior.state);
      if (b.state === "none" && LEFT_PILE) {
        /**
         * The scopes live IN the row predicate, atomically: `unread = false` — an unread row
         * returns to "New for you", and a raced mark-unread must not leave `unread = true` beside
         * a fresh stamp; `date is not null` — a dateless row KEEPS whatever stamp it has rather
         * than being nulled into the unstamped basement (the very "lost" this fix removes);
         * `last_read_at <= prior.setAt` — only the PARKED INTERLUDE's stamp is disowned. A stamp
         * newer than the pile entry is a fresh deliberate act — `resurface_done`'s un-awaited
         * sibling `mark_seen` landing first — and the later word wins whichever order the two
         * commit in.
         */
        await tx.update(messages)
          .set({ lastReadAt: msg.date, updatedAt: now })
          .where(and(
            eq(messages.id, messageId),
            eq(messages.accountId, ctx.accountId),
            eq(messages.unread, false),
            sql`${messages.date} is not null`,
            // The bound value is an ISO STRING with an explicit cast, not a Date: postgres-js
            // refuses a raw Date parameter inside a sql fragment (PGlite binds it happily —
            // the standing PGlite-green-means-nothing trap, measured on this exact line).
            sql`(${messages.lastReadAt} is null or ${messages.lastReadAt} <= ${dialect(ctx.db).ts(prior.setAt)})`,
          ));
      }

      /**
       * RESURFACING DOES NOT TOUCH READ STATE. This arm used to force `unread = true`, disown
       * `lastReadAt` and queue a `\Seen` removal for `state === "resurfaced"`. Removed from its
       * measured consequence: pins arrived bold whatever their real state, and reading one did
       * not stick (the glance filter dropped the read to protect the pin, so the row turned back
       * to unread). PLACEMENT in Resurface is the attention signal; a resurfaced message keeps
       * its GENUINE read state, and reading it sticks like anywhere else. `bubbleUpPass` and
       * `mutations.ts#triage_set` dropped their halves of the same stamp in the same change — no
       * writer of the artificial mark remains.
       */
      await recordChange(tx, {
        accountId: ctx.accountId, entityType: "message_state", entityId: row!.id, op: "update", meta: null,
      });

      /**
       * AND THE MESSAGE, BECAUSE ITS DTO EMBEDS THIS STATE. `MessageDTO.triage` projects the row
       * just written; moving the row without re-emitting its projection leaves every mirror
       * inconsistent. Not theoretical: `selectors.ts#isResurfaced` reads `message.triage.state`,
       * and `apply.ts` derives nothing from other entities — with only the `message_state` change
       * on the wire, a resurfaced row pinned on the device that set it and nowhere else. Emitted
       * for EVERY state: the projection is stale after any of them. SECOND, so the returned seq
       * is the highest of the two — `X-Sync-Seq` names the point at which BOTH are visible.
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
    // The batch, for the reason at `MessageService.list`: round-trips constant in the page size,
    // and `deleted: "include"` so only the round-trips change.
    const items = await materializeMessagesInOrder(
      ctx.db, ctx.accountId, pageRows.map((r) => r.messageId), { deleted: "include" },
    );
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

  /**
   * Power Through — one-by-one over the "New" group (unread Ohbox / INBOX). TWO BOUNDED QUERIES,
   * AND THE REASON IS THE PILE THIS FEATURE IS FOR. This was one query with NO `limit`: every
   * unread INBOX id sent to the process, for two uses — `rows[0]` and `rows.length`. The pile is
   * the point: Power Through exists to clear a large inbox, so the user with the most unread mail
   * paid the most for every screen, and advancing repeated it — a big enough mailbox could not
   * open the feature at all. `remaining` is now a scalar `count(*)` over the same predicates, and
   * the page query takes `limit(2)` — "is there another after this one" is exactly what the
   * cursor needs. Same three answers, same values, off the same index.
   */
  async powerThrough(ctx: ServiceContext, opts: ListOptions = {}): Promise<PowerThroughView> {
    const filters = [
      eq(messages.accountId, ctx.accountId),
      eq(messages.unread, true),
      eq(folderState.desiredFolder, "INBOX"),
    ];
    if (opts.cursor) filters.push(gt(messages.id, decodeListCursor(opts.cursor)));

    // `limit(2)`: the row on screen, plus the sentinel that decides whether a cursor is owed.
    const rows = await ctx.db.select({ id: messages.id }).from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(...filters)).orderBy(asc(messages.id)).limit(2);

    if (rows.length === 0) return { current: null, remaining: 0, nextCursor: null };

    // The count the caller is owed, as a scalar — never as the length of a materialized pile.
    const [tally] = await ctx.db
      .select({ n: dialect(ctx.db).castInt(sql`count(*)`).mapWith(Number) as unknown as SQL<number> })
      .from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(...filters));

    const current = await materializeMessage(ctx.db, ctx.accountId, rows[0]!.id);
    const nextCursor = rows.length > 1 ? encodeListCursor(rows[0]!.id) : null;
    return { current, remaining: Number(tally?.n ?? rows.length), nextCursor };
  }
}

export const triageService = new TriageService();
