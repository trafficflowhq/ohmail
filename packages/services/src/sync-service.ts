import { and, asc, desc, eq, exists, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  approvals, changeLog, drafts, messageStates, messages, messageTags, seqBounds,
  routingDecisions, rules, tags, type EntityType,
} from "@trafficflow/db";
import type { Db, ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import {
  approvalRowToDTO, draftRowToDTO, folderRowToDTO, materialize, materializeMessages,
  materializeMessagesInOrder, materializeSettings,
  materializeThreads, messageStateRowToDTO, routingDecisionRowToDTO, ruleRowToDTO, tagRowToDTO,
} from "./dto/materialize.js";
import { foldersEnabled, listUserFolders, userFoldersByIds, type UserFolderRow } from "./folders.js";
import type {
  ChangeOp, Folder, SnapshotResponse, SnapshotWindow, SyncChange, SyncResponse,
} from "./dto/types.js";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

/**
 * The bootstrap window, SERVED in every snapshot response so no client hardcodes it.
 * See {@link SnapshotWindow} for what the two numbers mean together.
 */
export const SNAPSHOT_WINDOW: SnapshotWindow = { days: 90, minRows: 5000 };

const DAY_MS = 86_400_000;

export interface GetChangesOptions {
  since?: string;
  limit?: number;
  types?: EntityType[];
}

export interface GetSnapshotOptions {
  /** The opaque `nextCursor` of the previous page. Absent ⇒ page 1. */
  cursor?: string;
  /** Messages per page. Clamped to [1, {@link MAX_LIMIT}]. */
  limit?: number;
}

/**
 * The decoded snapshot cursor: the point in time the whole snapshot reads at, plus where in the
 * newest-first message stream this page resumes.
 *
 * `date`/`id` are the keyset — the LAST row of the previous page, not an offset. An OFFSET would
 * make every page a different consistent point in the presence of concurrent ingest, which is
 * the one thing a bootstrap cannot afford: a row inserted at the front shifts every subsequent
 * offset by one and a message is skipped for ever. A keyset walks a fixed ordering, so an insert
 * at the front (which is where new mail lands, being the newest) is simply not in the window —
 * and the delta from `asOfSeq` delivers it, which is exactly right.
 */
interface SnapshotCursor {
  asOfSeq: bigint;
  /** The previous page's last `messages.date` as epoch ms; `null` ⇒ the undated tail. */
  date: number | null;
  id: string;
  /** Messages emitted by every page so far — the `minRows` floor is cumulative. */
  emitted: number;
  /**
   * `"tail"` ⇒ this cursor resumes the LABELED-MESSAGES TAIL, not the windowed walk. Absent on
   * every windowed cursor (and on any cursor a client held before this field existed, which is why
   * absence and not a version bump means "windowed" — an in-flight bootstrap across a deploy keeps
   * paging correctly and transitions to the tail when the window is satisfied). See the tail block
   * in {@link SyncService.getSnapshot} for what the tail is and why it exists.
   */
  phase?: "tail";
}

/**
 * The delta `/sync` reader. Reads `change_log` ascending by seq,
 * re-materializes the CURRENT DTO per row, emits ONE change per row (no
 * compaction), tombstones rows whose live entity is gone, and never advances the
 * cursor past a change it dropped.
 */
export class SyncService {
  /** Opaque base64 of the per-account high-water seq. */
  encodeCursor(seq: bigint): string {
    return Buffer.from(seq.toString(10), "utf8").toString("base64url");
  }

  /** Inverse of {@link encodeCursor}. A cursor we cannot parse is treated as
   *  expired (410) — the client re-bootstraps with `since="0"`, which heals it. */
  decodeCursor(cursor: string): bigint {
    try {
      const dec = Buffer.from(cursor, "base64url").toString("utf8");
      if (!/^\d+$/.test(dec)) throw new Error("non-numeric cursor");
      return BigInt(dec);
    } catch {
      throw new ServiceError("cursor_expired", 410, "sync cursor is malformed or expired; re-bootstrap with since=0");
    }
  }

  /** Opaque base64url of the snapshot's consistent point plus this page's keyset position. */
  encodeSnapshotCursor(c: SnapshotCursor): string {
    const payload = {
      v: 1, s: c.asOfSeq.toString(10), d: c.date, i: c.id, n: c.emitted,
      ...(c.phase ? { p: c.phase } : {}),
    };
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  }

  /**
   * Inverse of {@link encodeSnapshotCursor}. A cursor we cannot parse is a 410 for the same
   * reason the delta's is: the client's recovery is to start the snapshot again from page 1,
   * which costs a bootstrap and always heals, whereas guessing a position would silently serve
   * a window with a hole in it.
   */
  decodeSnapshotCursor(cursor: string): SnapshotCursor {
    try {
      const raw: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (typeof raw !== "object" || raw === null) throw new Error("not an object");
      const { v, s, d, i, n, p } = raw as Record<string, unknown>;
      if (v !== 1) throw new Error("unknown cursor version");
      if (typeof s !== "string" || !/^\d+$/.test(s)) throw new Error("bad asOfSeq");
      if (typeof i !== "string" || i === "") throw new Error("bad keyset id");
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new Error("bad emitted count");
      if (d !== null && (typeof d !== "number" || !Number.isFinite(d))) throw new Error("bad keyset date");
      if (p !== undefined && p !== "tail") throw new Error("bad phase");
      return {
        asOfSeq: BigInt(s), date: d as number | null, id: i, emitted: n,
        ...(p === "tail" ? { phase: "tail" as const } : {}),
      };
    } catch {
      throw new ServiceError(
        "cursor_expired", 410,
        "snapshot cursor is malformed or expired; restart the snapshot with no cursor",
      );
    }
  }

  /**
   * THE ACCOUNT'S HIGH-WATER **COMMITTED** SEQ — and the whole of the gap-free delta contract
   * lives here.
   *
   * ── WHAT MUST BE TRUE ────────────────────────────────────────────────────────────────────
   *
   * A snapshot that reports `asOfSeq = N` must have seen every change up to and including N,
   * because the client sets its delta cursor to N and will therefore never be told about
   * anything ≤ N again. Report a seq the projection did not actually cover and that row is
   * permanently missing from the mirror — silently, and only for the account that was being
   * written to at that instant.
   *
   * ── WHY `max(change_log.seq)` IS THAT VALUE, AND `account_sync_state.next_seq` IS NOT ─────
   *
   * `allocateSeqRange` takes the account's `account_sync_state` ROW LOCK and holds it to COMMIT
   * (`packages/db/src/change-log.ts`). So seq N's transaction commits strictly BEFORE N+1 is
   * even allocated, and `change_log` rows therefore become visible in seq order. Under READ
   * COMMITTED that gives the property this whole endpoint rests on: **if a reader can see seq N,
   * every seq below N is already committed and visible to it too.** No gap can be open beneath a
   * seq we can observe. That is the same discipline `getChanges` relies on when it takes the max
   * seq of the page it returned as the client's next cursor — this is not a second mechanism,
   * it is the same one read from the same table.
   *
   * The counter is deliberately NOT the source. `next_seq` names the last seq ALLOCATED, and
   * `greatest(next_seq, max(seq))` can leave it above the log after a restore. A snapshot that
   * took its `asOfSeq` from the counter would hand the client a cursor pointing past changes the
   * projection never saw and the delta will never resend, which is exactly the hole described
   * above. Reading the log instead can only ever be CONSERVATIVE — a seq is re-delivered, the
   * client's older-or-equal guard absorbs it — and conservative is the safe direction.
   *
   * ── AND WHY NO LOCK IS TAKEN HERE ────────────────────────────────────────────────────────
   *
   * Taking the counter row lock for a read would serialize every snapshot request against every
   * writer on the account, for no gain: the ordering guarantee above is already established by
   * the writers' lock. A read that adds its own lock buys nothing and blocks ingest.
   *
   * ── THE ORDERING CONSTRAINT ON THE CALLER ────────────────────────────────────────────────
   *
   * This must run BEFORE any entity is read. Read it first and every row projected afterwards is
   * at least as new as `asOfSeq`, so anything newer arrives again through the delta and the
   * client's seq guard lets it win. Read it AFTER, and the projection can be OLDER than the
   * cursor it ships with — the stale row is never re-sent and the mirror is wrong for ever.
   * `sync-snapshot-seq.pg.test.ts` drives exactly that race on real Postgres; PGlite is single
   * connection and cannot see it.
   */
  private async highWaterSeq(db: Db, accountId: string): Promise<bigint> {
    const rows = await db
      .select({ max: sql<string | null>`max(${changeLog.seq})` })
      .from(changeLog)
      .where(eq(changeLog.accountId, accountId));
    const m = rows[0]?.max;
    return m == null ? 0n : BigInt(m);
  }

  async getChanges(ctx: ServiceContext, opts: GetChangesOptions = {}): Promise<SyncResponse> {
    const { db, accountId } = ctx;
    const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

    // since omitted / "0" ⇒ bootstrap (full replay from seq 0).
    const sinceSeq = opts.since && opts.since !== "0" ? this.decodeCursor(opts.since) : 0n;

    // ── BOTH ENDS OF THE CURSOR WINDOW, FROM ONE READ ────────────────────────────────────────
    //
    // A resuming cursor is only serviceable when it names a point INSIDE this account's log.
    // There are two ways out of it, and only the first used to be checked:
    //
    //  · BELOW the floor — the changes between the cursor and the oldest retained row are gone
    //    and cannot be reconstructed;
    //  · ABOVE the ceiling — the cursor names a seq the account never issued, so `seq > since`
    //    matches nothing NOW AND FOREVER. That answered 200 with an empty delta on every poll,
    //    for the life of the mirror: the client kept its cursor (an empty page returns `since`
    //    unchanged), never learned another change, and every optimistic edit appeared to revert
    //    as its overlay drained onto a mirror that could no longer be updated. Nothing errored,
    //    nothing logged, and no surface in the product could show it — measured live on an
    //    account whose mirror held seq 2173 against a log whose max was 1684.
    //
    // Both are unrecoverable in the same way and get the same answer, which is the one the
    // client already knows how to act on: 410 `cursor_expired` → discard, re-snapshot, adopt a
    // fresh cursor. See `OhmailEngine.drain` (browser and desktop share it) and the sidecar
    // mirror's `drainSync`.
    //
    // THE RACE POSTURE IS "TOLERATE IT IN THE SAFE DIRECTION". These bounds are read in one
    // statement of their own, not in a transaction with the page read below. A change that
    // commits in between only RAISES `max`, so the worst it can do is let a cursor that was
    // momentarily above the ceiling through — a single extra empty 200, self-healing on the
    // next poll. The failure this replaces is empty-FOREVER; a transient empty-200 is not the
    // same class of thing, and serializing the reader against every writer on the account to
    // remove it would cost far more than it buys. A FALSE 410 would need `max(seq)` to move
    // BACKWARDS, which nothing but account erasure does — and that takes the account with it.
    //
    // `sinceSeq === 0n` is the bootstrap and skips all of it, which is what keeps a brand-new
    // account's first poll a plain empty 200 rather than a 410: an empty log has no ceiling to
    // be above, and the cursor an empty account is handed decodes back to 0.
    if (sinceSeq > 0n) {
      const { min: minSeq, max: maxSeq } = await seqBounds(db, accountId);
      if (minSeq != null && minSeq > sinceSeq + 1n) {
        throw new ServiceError(
          "cursor_expired", 410,
          "sync cursor is older than the retention horizon; re-bootstrap with since=0",
        );
      }
      if (maxSeq == null || sinceSeq > maxSeq) {
        throw new ServiceError(
          "cursor_expired", 410,
          "sync cursor is ahead of this account's change log; re-bootstrap with since=0",
        );
      }
    }

    const filters = [eq(changeLog.accountId, accountId), gt(changeLog.seq, sinceSeq)];
    if (opts.types && opts.types.length > 0) {
      filters.push(inArray(changeLog.entityType, opts.types));
    }

    const rows = await db
      .select()
      .from(changeLog)
      .where(and(...filters))
      .orderBy(asc(changeLog.seq))
      .limit(limit);

    const creates: SyncChange[] = [];
    const updates: SyncChange[] = [];
    const moves: SyncChange[] = [];
    const deletes: SyncChange[] = [];

    /**
     * PREFETCH THE PAGE'S MESSAGES IN THREE QUERIES, before the loop.
     *
     * The loop below used to call `materialize()` per row, and for a message that is three
     * sequential round-trips. At the 500-row default that is 1 500 of them, enough to run past
     * the function timeout on a large mailbox — so `/sync` returned nothing and every view in the
     * client rendered empty. Bootstrapping such a mailbox would have taken minutes of wall clock
     * spread over dozens of pages.
     *
     * `message` AND `thread` are prefetched because they are the two types that appear in
     * volume — ingest records a thread create or update beside nearly every message create, so a
     * catch-up page is dominated by the pair of them. `thread` learned this the way `message`
     * did, measured rather than assumed: `materializeThread` is three sequential round-trips,
     * so a 500-change page carrying a couple hundred thread changes pays hundreds of serial
     * round-trips — measured in the tens of seconds against a remote database, which is the
     * difference between a resume that converges and one that visibly hangs.
     * `materializeThreads` (three queries whatever the count) already served the
     * snapshot reader; a page of hundreds now costs what a page of one costs on both paths.
     *
     * The other six types stay on the per-row path, which is correct and rare. Both batch
     * readers apply the same `accountId` predicate the per-row calls did, so this changes cost
     * and nothing else.
     */
    const messageIds = rows.filter((r) => r.entityType === "message" && r.op !== "delete").map((r) => r.entityId);
    const prefetched = await materializeMessages(db, accountId, messageIds);
    const threadIds = rows.filter((r) => r.entityType === "thread" && r.op !== "delete").map((r) => r.entityId);
    const prefetchedThreads = await materializeThreads(db, accountId, threadIds);

    /**
     * `folder` JOINS THE PREFETCH — measured, like the two above, not assumed. Folder change
     * rows arrive in ACCOUNT-WIDE BURSTS by construction: the "Use folders" toggle writes one
     * create (or delete tombstone) per user folder in a single transaction, so the very first
     * page an enabling account drains is nothing but folder creates — 527 of them on the first
     * production mailbox this shipped to. The per-row path (`materializeFolder`: a fresh
     * `foldersEnabled` plus a `userFolderById`, two sequential round trips each) priced that
     * page at ~1 000 serial round trips — measured at 30.7 s on the deployed API for a 400-row
     * page, against a 60 s function budget — so the rail stayed empty while the account
     * watched its own switch appear to do nothing. Batched, the page costs TWO queries flat:
     * one flag read, one `userFoldersByIds`. Same account scoping, same exclusions, same
     * participation filter, same null-means-tombstone semantics as the per-row read, which
     * stays for the callers that genuinely have one row.
     */
    const folderIds = rows.filter((r) => r.entityType === "folder" && r.op !== "delete").map((r) => r.entityId);
    const prefetchedFolders = folderIds.length > 0 && await foldersEnabled(db, accountId)
      ? await userFoldersByIds(db, accountId, folderIds)
      : new Map<string, UserFolderRow>();

    for (const row of rows) {
      const type = row.entityType as EntityType;
      const id = row.entityId;
      const seq = Number(row.seq);
      const op = row.op as ChangeOp;

      if (op === "delete") {
        deletes.push({ type, op: "delete", id, seq, updatedAt: row.createdAt.toISOString() });
        continue;
      }

      // Re-materialize the live entity. If it is gone, emit a delete tombstone
      // instead — regardless of the original op. A message or thread absent from its
      // prefetch is absent for the same reason the per-row call returned null.
      const entity = type === "message"
        ? (prefetched.get(id) ?? null)
        : type === "thread"
          ? (prefetchedThreads.get(id) ?? null)
          : type === "folder"
            ? (() => { const f = prefetchedFolders.get(id); return f ? folderRowToDTO(f) : null; })()
            : await materialize(db, accountId, type, id);
      if (entity === null) {
        deletes.push({ type, op: "delete", id, seq, updatedAt: row.createdAt.toISOString() });
        continue;
      }

      const updatedAt = (entity as { updatedAt?: string }).updatedAt ?? row.createdAt.toISOString();
      const change: SyncChange = { type, op, id, seq, updatedAt, entity };

      if (op === "move") {
        const meta = (row.meta as { from: Folder | null; to: Folder } | null) ?? null;
        if (meta) change.move = meta;
        moves.push(change);
      } else if (op === "create") {
        creates.push(change);
      } else {
        updates.push(change);
      }
    }

    // cursor = max seq actually returned; unchanged when the page is empty.
    const cursorSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : sinceSeq;

    return {
      changes: { creates, updates, moves, deletes },
      cursor: this.encodeCursor(cursorSeq),
      hasMore: rows.length === limit,
      serverTime: ctx.now().toISOString(),
    };
  }

  /**
   * `GET /sync/snapshot` — THE BOOTSTRAP READER.
   *
   * A first-run client used to reach its mirror by replaying `change_log` from seq 0, which is
   * every change that ever happened to the account rather than the state it is in: a message
   * created, updated, moved and re-triaged is four pages' worth of wire to arrive at one row.
   * This reads the LIVE TABLES instead, so the cost is the size of the mailbox and not the size
   * of its history.
   *
   * ── WHAT EACH PAGE CARRIES ───────────────────────────────────────────────────────────────
   *
   * Page 1 carries ALL of the account's live small state — every rule, every message_state,
   * every PENDING routing decision, every approval, every draft, every tag — plus the newest
   * page of messages. The small state is not paged because paging it would mean a client that
   * stopped after page 1 holds a partial rule set, and a partial rule set is worse than none:
   * the UI would show routing that does not match what the server does. Tags are there for the
   * same reason read one step further on — messages carry tag ids, so a late tag list is a rail
   * that boots empty beside mail already pointing into it.
   *
   * EVERY page — page 1 included — additionally carries the THREADS its own messages name. That
   * is a different rule from the one above and deliberately so: threads are keyed to the message
   * window rather than to the account, so the two cannot disagree about what the client holds.
   * See the emit site for why cross-page duplicates are accepted rather than tracked.
   *
   * `folder` joined the reads with the folders foundation (FOLDERS-SPEC.md §4): while the
   * account's "Use folders" flag is on, page 1 carries the mailbox's own folders — small state
   * for the tags' reason one step further out, because an EMPTY folder (just discovered,
   * nothing in it) is visible in no message and a rail derived from messages alone could never
   * show one. With the flag off the read is skipped entirely, so a flag-off account's snapshot
   * is byte-identical to the pre-feature snapshot (the parity claim, spec §10).
   *
   * ── THE WINDOW, THEN THE LABELED TAIL ────────────────────────────────────────────────────
   *
   * Messages are bounded by {@link SNAPSHOT_WINDOW}: paging continues while the last row read is
   * inside the recency floor, and keeps going past it until the volume floor is met. Both
   * numbers are returned in every response so the client states the truth about what it has
   * without carrying a copy of them.
   *
   * The window is not the end of the message stream. A tag is cross-cutting and a person tags old
   * mail, so a windowed bootstrap that stopped at the volume/recency floor dropped every tagged
   * message below it — and the delta could never recover them, because their `message_tags`
   * changes sit below the cursor the client adopts after bootstrap. So once the window is met the
   * drain opens a TAIL: the same keyset walk, continued past the window, restricted to messages
   * that own a `message_tags` row. Its cost is bounded by how much mail carries a tag, not by the
   * mailbox — an untagged row below the window is never read. The client needs no new code: tail
   * pages are `op:"create"` at `seq = asOfSeq` like every other page, so a re-read is idempotent
   * on the older-or-equal seq guard, and the drain simply follows `nextCursor` until it is null.
   *
   * ── WHY EVERY ROW IS `op: "create"` AT `seq = asOfSeq` ───────────────────────────────────
   *
   * See {@link SnapshotResponse}: it makes the client's existing apply path — and specifically
   * its older-or-equal seq guard — correct for a snapshot with no new code on that side.
   *
   * Account scoping is `ctx.accountId` on every predicate, exactly as `getChanges` does it, and
   * the message projection is `materializeMessages` — the same batched three-table read the
   * delta uses — so redaction and sensitivity cannot fork between bootstrap and tail.
   */
  async getSnapshot(ctx: ServiceContext, opts: GetSnapshotOptions = {}): Promise<SnapshotResponse> {
    const { db, accountId } = ctx;
    const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const cursor = opts.cursor && opts.cursor !== "" ? this.decodeSnapshotCursor(opts.cursor) : null;

    // THE GAP-FREE SEQ IS FIXED BEFORE ANY ENTITY READ. See `highWaterSeq` for what depends on
    // this line
    // running first and nothing depending on it running at all if a cursor already fixed the point.
    const asOfSeq = cursor ? cursor.asOfSeq : await this.highWaterSeq(db, accountId);
    const seq = Number(asOfSeq);

    const changes: SyncChange[] = [];
    const emit = (type: EntityType, id: string, entity: unknown, updatedAt: string): void => {
      changes.push({ type, op: "create", id, seq, updatedAt, entity });
    };

    if (cursor === null) {
      // ── Page 1: the live state, one query per type, projected by the SAME functions the
      //    per-row `materialize` path uses. The entity id is the ROW id in every case — a
      //    `message_state` DTO carries `messageId` and not its own, and the client keys on the
      //    change's id, which is what the delta's `change_log.entity_id` holds.
      const ruleRows = await db.select().from(rules).where(eq(rules.accountId, accountId));
      for (const r of ruleRows) emit("rule", r.id, ruleRowToDTO(r), r.updatedAt.toISOString());

      const stateRows = await db.select().from(messageStates)
        .where(eq(messageStates.accountId, accountId));
      for (const s of stateRows) {
        emit("message_state", s.id, messageStateRowToDTO(s), s.updatedAt.toISOString());
      }

      // PENDING decisions only. A decided one is history — it is what `change_log` is for — and
      // an account that has been ingesting for months holds one row per message, which would
      // make "the live state" unbounded and page 1 unservable.
      const decisionRows = await db.select().from(routingDecisions).where(and(
        eq(routingDecisions.accountId, accountId),
        eq(routingDecisions.status, "pending_approval"),
      ));
      for (const d of decisionRows) {
        emit("routing_decision", d.id, routingDecisionRowToDTO(d), d.updatedAt.toISOString());
      }

      const approvalRows = await db.select().from(approvals).where(eq(approvals.accountId, accountId));
      for (const a of approvalRows) emit("approval", a.id, approvalRowToDTO(a), a.updatedAt.toISOString());

      const draftRows = await db.select().from(drafts).where(eq(drafts.accountId, accountId));
      for (const d of draftRows) emit("draft", d.id, draftRowToDTO(d), d.updatedAt.toISOString());

      // TAGS ARE LIVE STATE, IN FULL, AND ON PAGE 1. A tag is identity — a name and a hue — and
      // the client renders its rail by filtering the tag list against each message's `labels`.
      // Ship a tag late and the rail boots EMPTY while messages already carry ids pointing into
      // it, which reads as "my tags are gone" rather than as "still loading". The set is small
      // and bounded by what a person typed, so there is nothing to page.
      const tagRows = await db.select().from(tags).where(eq(tags.accountId, accountId));
      for (const t of tagRows) emit("tag", t.id, tagRowToDTO(t), t.updatedAt.toISOString());

      // THE MAILBOX'S OWN FOLDERS — live state, in full, on page 1, and ONLY while "Use
      // folders" is on (see the header). Post-exclusion by construction: `listUserFolders`
      // never answers the organized six, the Sent folder or the ohmail namespace.
      if (await foldersEnabled(db, accountId)) {
        for (const f of await listUserFolders(db, accountId)) {
          emit("folder", f.id, folderRowToDTO(f), f.updatedAt.toISOString());
        }
      }

      // THE SETTINGS DOORBELL — one row, always, on page 1 (never null for the caller's own
      // account: a missing row materializes as the default-shaped DTO). Live state like the
      // tags above, and the row that closes the bootstrap race review round 1 named: a settings
      // write landing between a fresh mirror's boot `GET /consent` and this snapshot's
      // `asOfSeq` is BELOW the cursor this page commits, so the delta would never deliver it —
      // the tab held stale consent until the next settings write, however far away that was.
      // With the entity on page 1 the mirror's stamp starts at the row's own instant and the
      // client's re-ask covers the gap.
      const settings = await materializeSettings(db, accountId, accountId);
      if (settings !== null) emit("settings", accountId, settings, settings.updatedAt);
    }

    // ── The message window: newest first, keyset-paged on (date desc nulls last, id desc).
    //
    // `nulls last` is written out rather than left to the default because Postgres puts NULLs
    // FIRST for a DESC sort, which would open the newest-first window with the undated rows —
    // the least useful mail in the mailbox leading the bootstrap. The keyset predicate below
    // mirrors that ordering exactly, including its treatment of the undated tail; a predicate
    // that disagreed with its ORDER BY would skip rows silently rather than fail.
    const keyset = cursor === null
      ? undefined
      : cursor.date === null
        // Already in the undated tail: only undated rows remain, ordered by id desc.
        ? and(isNull(messages.date), lt(messages.id, cursor.id))
        : or(
          lt(messages.date, new Date(cursor.date)),
          and(eq(messages.date, new Date(cursor.date)), lt(messages.id, cursor.id)),
          isNull(messages.date),
        );

    // ── THE LABELED-MESSAGES TAIL PREDICATE (only in the tail phase) ─────────────────────────
    //
    // Once the window is satisfied the walk switches to the tail (see the stop logic below): the
    // SAME keyset walk, resumed from where the window stopped, but restricted to messages that own
    // a `message_tags` row. Its cost — pages and rows — is bounded by how much mail carries a tag,
    // never by the size of the mailbox, because an unlabeled row below the window fails this EXISTS
    // and is never read. `message_tags.account_id` is denormalized, so it is filtered here too,
    // belt-and-braces with the outer `messages.account_id`: a bug that ever let the two disagree
    // must fail closed rather than leak one account's tagged mail into another's bootstrap.
    const inTail = cursor?.phase === "tail";
    const labeled = inTail
      ? exists(
        db.select({ x: sql`1` }).from(messageTags).where(and(
          eq(messageTags.messageId, messages.id),
          eq(messageTags.accountId, accountId),
        )),
      )
      : undefined;

    const where = and(
      eq(messages.accountId, accountId),
      // Mail 0065: a tombstoned message (user delete, or every watched copy expunged) is not in
      // the mirror's living views, so a FRESH mirror must not be handed it. The delta path needs
      // no twin predicate — the tombstone IS the delta (`op: "delete"`), and a getChanges row for
      // a deleted entity already tombstones.
      isNull(messages.deletedAt),
      ...(keyset ? [keyset] : []),
      ...(labeled ? [labeled] : []),
    );

    const rows = await db
      .select({ id: messages.id, date: messages.date })
      .from(messages)
      .where(where)
      .orderBy(sql`${messages.date} desc nulls last`, desc(messages.id))
      .limit(limit);

    const pageMessages = await materializeMessagesInOrder(db, accountId, rows.map((r) => r.id));
    for (const dto of pageMessages) emit("message", dto.id, dto, dto.updatedAt);

    // ── THREADS RIDE WITH THE PAGE THAT REFERENCES THEM ──────────────────────────────────────
    //
    // Not the thread table: a thread whose every message is outside the window would be a header
    // over messages the client does not have, and the full table is unbounded exactly where the
    // message window is bounded. So each page carries the threads ITS OWN messages name, which
    // keeps the two window-coherent by construction — a client that stops paging holds threads
    // for precisely the mail it holds.
    //
    // DUPLICATES ACROSS PAGES ARE ACCEPTED AND ARE NOT A DEFECT. A thread straddling a page
    // boundary is named by both pages, and the cursor cannot carry the emitted thread ids to
    // prevent it — that set grows without bound and the cursor is a URL. It costs nothing to
    // allow: both copies are `op:"create"` at the SAME `seq = asOfSeq`, so the client's
    // older-or-equal guard makes the second one a no-op on a store that already has the first.
    // This is the same property that makes re-reading a whole page free, used deliberately.
    //
    // Within ONE page they ARE deduped, because that is free — `materializeThreads` takes a
    // unique id set, so twenty messages of one thread cost one thread DTO and not twenty.
    const threadIds = [...new Set(
      pageMessages.map((m) => m.threadId).filter((id): id is string => id != null),
    )];
    for (const dto of (await materializeThreads(db, accountId, threadIds)).values()) {
      emit("thread", dto.id, dto, dto.updatedAt);
    }

    const emitted = (cursor?.emitted ?? 0) + rows.length;
    const last = rows[rows.length - 1];
    const fullPage = rows.length === limit && last !== undefined;
    const keysetOf = (phase?: "tail"): string => this.encodeSnapshotCursor({
      asOfSeq,
      date: last!.date ? last!.date.getTime() : null,
      id: last!.id,
      emitted,
      ...(phase ? { phase } : {}),
    });

    // ── WHERE THE NEXT PAGE COMES FROM: window → tail → done ─────────────────────────────────
    //
    // The window is the recency floor OR the volume floor, whichever is not yet met. When BOTH
    // are met the windowed walk stops — and that is exactly the point older tagged mail was lost at, because any
    // tagged mail below the window was then dropped from every windowed mirror and no delta could
    // ever re-deliver it (its `message_tags` change sits below the client's post-bootstrap
    // cursor). So the walk does not end there: it opens the labeled tail, resuming the same keyset
    // and carrying every message below the window that owns a tag. The tail ends when a page comes
    // back short. A windowed walk that ran off the end of the mailbox (a short page) has no tail —
    // every tagged message is already above it.
    let nextCursor: string | null;
    if (inTail) {
      nextCursor = fullPage ? keysetOf("tail") : null;
    } else {
      const cutoff = ctx.now().getTime() - SNAPSHOT_WINDOW.days * DAY_MS;
      // Inside the recency floor ⇒ keep going. Past it ⇒ keep going only until the volume floor is
      // met. An undated row is past the floor by construction (it sorts into the tail), so it can
      // only be carried by the volume arm.
      const withinWindow = last?.date != null && last.date.getTime() >= cutoff;
      if (fullPage && (withinWindow || emitted < SNAPSHOT_WINDOW.minRows)) {
        nextCursor = keysetOf();            // still inside the window
      } else if (fullPage) {
        nextCursor = keysetOf("tail");      // window satisfied, mail below it ⇒ open the tail
      } else {
        nextCursor = null;                  // ran off the end of the mailbox ⇒ no tail
      }
    }

    return { asOfSeq: seq, changes, nextCursor, window: SNAPSHOT_WINDOW };
  }
}

export const syncService = new SyncService();
