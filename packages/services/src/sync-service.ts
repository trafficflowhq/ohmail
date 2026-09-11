import { and, asc, desc, eq, exists, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  approvals, changeLog, drafts, messages, messageTags, seqBounds,
  rules, tags, type EntityType,
} from "@trafficflow/db";
import type { Db, ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { clampPageLimit } from "./pagination.js";
import { isUuid } from "./ids.js";

/**
 * The longest `?since=` cursor `/sync` will decode.
 *
 * A `change_log` seq is a `bigserial`, so its whole range is nineteen digits — 32 base64url
 * characters covers that with room and leaves room for nothing else.
 */
export const SYNC_CURSOR_MAX_CHARS = 32;

/**
 * The longest `?cursor=` `/sync/snapshot` will decode.
 *
 * A base64url JSON object of six small fields: a version, a nineteen-digit seq, a millisecond
 * date, a uuid, a count and a phase word. 512 characters is several times what that weighs.
 */
export const SNAPSHOT_CURSOR_MAX_CHARS = 512;

/**
 * THE RANGE THE COLUMN ACCEPTS, not the range `Date` can hold — the same note as `pagination.ts`,
 * found there first and again here. `Date#getTime()` spans ±8.64e15 ms; `timestamptz` spans 4713
 * BC to 294276 AD. The upper end of `Date`'s range is inside the column's, so the maximum is
 * safe; the LOWER end is not — a snapshot cursor carrying `"d": -8640000000000000` reached
 * PostgreSQL as a pre-4713 BC timestamp, a 500 for a caller-supplied cursor on a route that
 * otherwise answers 410. Two decoders substituted the producer's range for the sink's
 * independently, which is why both now name the sink.
 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;
/** PostgreSQL's `timestamptz` floor, 4713-01-01 BC, in milliseconds from the epoch. */
const MIN_EPOCH_MS = -210_866_803_200_000;

/**
 * A signed `bigint`'s maximum — what a `bigserial` seq can actually reach.
 *
 * Nineteen DIGITS is not this: `9999999999999999999` is nineteen digits and larger than the
 * column can hold, so it survives a digit count and raises 22003 at the comparison. The range is
 * the bound; the digit count in front of it is what stops an unbounded `BigInt` parse.
 */
const MAX_BIGSERIAL = 9_223_372_036_854_775_807n;

/**
 * The largest `emitted` a snapshot cursor may claim.
 *
 * It counts rows this snapshot has already sent, so it cannot exceed what an account holds —
 * and `1e308` is an integer to `Number.isInteger`'s eye only in the sense that it has no
 * fractional part. Ten million is far beyond any real account and small enough to be a number.
 */
const MAX_EMITTED = 10_000_000;
import {
  approvalRowToDTO, draftRowToDTO, folderRowToDTO, materialize, materializeApprovals,
  materializeDrafts, materializeMessageChildren, materializeMessages,
  materializeMessagesInOrder, materializeMessageStates, materializeRoutingDecisions,
  materializeRules, materializeSettings,
  materializeTags, materializeThreads,
  ruleRowToDTO, tagRowToDTO,
} from "./dto/materialize.js";
import { foldersEnabled, listUserFolders, userFoldersByIds, type UserFolderRow } from "./folders.js";
import type {
  ChangeOp, Folder, SnapshotResponse, SnapshotWindow, SyncChange, SyncResponse,
} from "./dto/types.js";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

/**
 * THE BACKLOG DIET'S ENGAGEMENT THRESHOLD. A resuming cursor whose span behind the horizon
 * (`max(seq) − since`, exact — the seq is gap-free) exceeds this is served COALESCED pages: the
 * latest change per entity in a bounded scan window, materialized at CURRENT state. At or below
 * it, the plain page path — byte-identical to the deployed shape. WHY 500 — one DEFAULT page:
 * below that, coalescing saves no round trip; above it every dropped PAGE is a whole invocation
 * saved (measured p50 1,084 ms per page). EQUIVALENCE-PRESERVING because `getChanges`
 * re-materializes the CURRENT entity per row — N changes are N copies of the SAME final upsert; a
 * dead entity's latest change materializes null and tombstones.
 */
export const STALE_COALESCE_SPAN = 500;

/**
 * How many change rows one coalesced page may SCAN (the dedup window), as distinct from how
 * many it may RETURN (`limit`). Bounds the per-page sort so a since-forever cursor cannot make
 * a single request sort an unbounded log; sized to cover the heaviest measured 7-day account
 * (9,831 rows, production probe 2026-08-29) in ONE window, where the same probe measured the
 * 10k scan+dedup at 74 ms of database time. Each request advances the cursor by up to this
 * many rows while emitting only the distinct tail, so even a 100k-row backlog converges in
 * ≤ 10 coalesced requests.
 */
export const COALESCE_SCAN_WINDOW = 10_000;

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
 * newest-first message stream this page resumes. `date`/`id` are the keyset — the LAST row of the
 * previous page, not an offset: an OFFSET makes every page a different consistent point under
 * concurrent ingest, the one thing a bootstrap cannot afford — a row inserted at the front shifts
 * every later offset and a message is skipped for ever. A keyset walks a fixed ordering, so an
 * insert at the front (where new mail lands) is simply not in the window — and the delta from
 * `asOfSeq` delivers it, which is exactly right.
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
 * The delta `/sync` reader. Reads `change_log` ascending by seq, re-materializes the CURRENT DTO
 * per row, tombstones rows whose live entity is gone, and never advances the cursor past a change
 * it dropped. A steady-state cursor (span ≤ `STALE_COALESCE_SPAN`) is served one change per log
 * row — the deployed shape, byte for byte. A STALE cursor is served COALESCED pages (the latest
 * change per entity within a bounded window), sound precisely BECAUSE this reader projects
 * current state rather than history: the skipped rows are superseded copies of the same upsert.
 */
export class SyncService {
  /** Opaque base64 of the per-account high-water seq. */
  encodeCursor(seq: bigint): string {
    return Buffer.from(seq.toString(10), "utf8").toString("base64url");
  }

  /**
   * Inverse of `encodeCursor`. A cursor we cannot parse is treated as expired (410) — the client
   * re-bootstraps with `since="0"`. BOUNDED BEFORE THE DECODE: `?since=` was bounded by nothing —
   * an arbitrarily long base64 string was fully decoded, regex-scanned and handed to `BigInt`,
   * superlinear in digit count; the census's `identifier` disposition assumed the shape test was
   * the bound, and the shape test ran after the work. `SYNC_CURSOR_MAX_CHARS` is generous: a
   * `bigserial` seq is nineteen digits, 32 base64url characters covers that. Nineteen DIGITS is
   * not the range — `9999999999999999999` exceeds the column — so the value is checked against
   * `MAX_BIGSERIAL` too.
   */
  decodeCursor(cursor: string): bigint {
    try {
      if (cursor.length > SYNC_CURSOR_MAX_CHARS) throw new Error("cursor too long");
      const dec = Buffer.from(cursor, "base64url").toString("utf8");
      if (!/^\d{1,19}$/.test(dec)) throw new Error("non-numeric cursor");
      // The digit count bounds the PARSE and the RANGE bounds the value — nineteen digits reaches
      // `9999999999999999999`, which is past what a `bigserial` holds. The same pair the snapshot
      // cursor's `s` carries, and for the same reason.
      const seq = BigInt(dec);
      if (seq > MAX_BIGSERIAL) throw new Error("seq out of range");
      return seq;
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
      // The same ceiling, for the same reason and BEFORE the decode: this one is a base64 JSON
      // object, so an unbounded cursor is an unbounded `JSON.parse` as well as an unbounded
      // decode. Its six fields are a version, a seq, a date, a uuid, a count and a phase —
      // comfortably inside {@link SNAPSHOT_CURSOR_MAX_CHARS}.
      if (cursor.length > SNAPSHOT_CURSOR_MAX_CHARS) throw new Error("cursor too long");
      const raw: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (typeof raw !== "object" || raw === null) throw new Error("not an object");
      const { v, s, d, i, n, p } = raw as Record<string, unknown>;
      if (v !== 1) throw new Error("unknown cursor version");
      // The digit count bounds the PARSE (`BigInt` accepts a three-hundred-digit string happily,
      // which then reaches `Number(asOfSeq)` as `Infinity`) and the RANGE bounds the value — a
      // `change_log` seq is a `bigserial`, and nineteen digits reaches past what one can hold.
      // The other two numeric fields get the same treatment below: a cursor small enough to pass
      // the wire ceiling can still carry values no clock or counter could produce.
      if (typeof s !== "string" || !/^\d{1,19}$/.test(s) || BigInt(s) > MAX_BIGSERIAL) {
        throw new Error("bad asOfSeq");
      }
      // A UUID, not merely a non-empty string: `i` is bound against `messages.id` (and its
      // siblings) further down, so `{"i":"x"}` in a hand-built cursor reached Postgres as 22P02 —
      // a 500 for a value this function had already claimed to validate. Every other field here
      // is shape-checked; this one said "not empty" and meant it.
      if (!isUuid(i)) throw new Error("bad keyset id");
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_EMITTED) {
        throw new Error("bad emitted count");
      }
      // `Date`'s own range, not merely "finite": `1e308` is a finite number and not a date, and
      // it reaches a `timestamptz` comparison as one.
      if (d !== null && (typeof d !== "number" || !Number.isFinite(d) || d > MAX_EPOCH_MS || d < MIN_EPOCH_MS)) {
        throw new Error("bad keyset date");
      }
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
   * THE ACCOUNT'S HIGH-WATER **COMMITTED** SEQ — the whole gap-free delta contract. A snapshot
   * reporting `asOfSeq = N` must have seen everything ≤ N: the client never asks again, so a
   * missed row is missing for ever. `max(change_log.seq)` IS that value: `allocateSeqRange` holds
   * the counter row lock to COMMIT, so rows become visible in seq order. The counter (`next_seq`)
   * is NOT the source: it names the last seq ALLOCATED and can sit above the log after a restore;
   * the log read is only ever CONSERVATIVE. NO LOCK HERE: the writers' lock establishes the
   * ordering. MUST RUN BEFORE ANY ENTITY IS READ — after, the projection can be older than its
   * cursor (`sync-snapshot-seq.pg.test.ts` drives the race on real Postgres).
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
    const limit = clampPageLimit(opts.limit, DEFAULT_LIMIT, MAX_LIMIT);

    // since omitted / "0" ⇒ bootstrap (full replay from seq 0).
    const sinceSeq = opts.since && opts.since !== "0" ? this.decodeCursor(opts.since) : 0n;

    // BOTH ENDS OF THE CURSOR WINDOW, FROM ONE READ. A resuming cursor must name a point INSIDE
    // this account's log; two ways out, and only the first used to be checked. BELOW the floor —
    // the changes are pruned. ABOVE the ceiling — a seq the account never issued: `seq > since`
    // matches nothing FOREVER, a 200 with an empty delta on every poll, every optimistic edit
    // appearing to revert (measured live: a mirror at seq 2173 against a log max of 1684). Both
    // answer 410 `cursor_expired` → re-snapshot. RACE POSTURE: tolerate in the safe direction — a
    // change committing in between only RAISES `max`, so the worst case is one extra empty 200; a
    // FALSE 410 needs `max(seq)` to move backwards, which only account erasure does. `sinceSeq
    // === 0n` skips all of it — an empty log has no ceiling.
    let horizonSeq: bigint | null = null;
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
      horizonSeq = maxSeq;
    }

    const filters = [eq(changeLog.accountId, accountId), gt(changeLog.seq, sinceSeq)];
    if (opts.types && opts.types.length > 0) {
      filters.push(inArray(changeLog.entityType, opts.types));
    }

    // THE BACKLOG DIET: a stale cursor is served COALESCED pages. The span is exact, read from
    // the bounds the 410 checks fetched — zero added queries decide the mode. The page: scan
    // `COALESCE_SCAN_WINDOW` rows in seq order, keep the LATEST change per entity, emit in
    // FIRST-APPEARANCE order, cut at `limit`; every emitted row flows through the SAME
    // materialize pipeline. FIRST-APPEARANCE, NOT LATEST-SEQ: the desktop mirror FK-guards its
    // applies assuming a parent's create carries a lower seq; latest-seq order could emit
    // STATE-then-MESSAGE and a page cut between them skips the state for ever. THE CURSOR STAYS
    // HONEST: the page is fetched with ONE LOOKAHEAD entity, and a CUT page's cursor is that
    // entity's first-seq MINUS ONE — the lookahead keeps a cut page's cursor MOVING. No lookahead
    // ⇒ the window was consumed and the cursor advances to its max seq.
    const span = horizonSeq !== null ? horizonSeq - sinceSeq : 0n;
    const coalesced = span > BigInt(STALE_COALESCE_SPAN);

    let rows: (typeof changeLog.$inferSelect)[];
    /** Coalesced mode only: the lookahead entity's first-seq − 1, `null` ⇒ window consumed. */
    let coalescedCutCursor: bigint | null = null;
    if (coalesced) {
      const spanRows = db.$with("span").as(
        db.select()
          .from(changeLog)
          .where(and(...filters))
          .orderBy(asc(changeLog.seq))
          .limit(COALESCE_SCAN_WINDOW),
      );
      const pageEntities = db.$with("page_entities").as(
        db.select({
          entityType: spanRows.entityType,
          entityId: spanRows.entityId,
          firstSeq: sql<string>`min(${spanRows.seq})`.as("first_seq"),
          lastSeq: sql<string>`max(${spanRows.seq})`.as("last_seq"),
        })
          .from(spanRows)
          .groupBy(spanRows.entityType, spanRows.entityId)
          .orderBy(sql`min(${spanRows.seq})`)
          .limit(limit + 1), // the lookahead — see the cursor argument above
      );
      const joined = await db.with(spanRows, pageEntities)
        .select({
          accountId: spanRows.accountId,
          seq: spanRows.seq,
          entityType: spanRows.entityType,
          entityId: spanRows.entityId,
          op: spanRows.op,
          meta: spanRows.meta,
          createdAt: spanRows.createdAt,
          firstSeq: pageEntities.firstSeq,
        })
        .from(spanRows)
        .innerJoin(pageEntities, and(
          eq(spanRows.entityType, pageEntities.entityType),
          eq(spanRows.entityId, pageEntities.entityId),
          eq(spanRows.seq, sql`${pageEntities.lastSeq}`),
        ))
        .orderBy(sql`${pageEntities.firstSeq}`);
      const lookahead = joined.length > limit ? joined[limit] : undefined;
      coalescedCutCursor = lookahead === undefined ? null : BigInt(lookahead.firstSeq) - 1n;
      rows = joined.slice(0, limit).map(({ firstSeq: _first, ...row }) => row);
    } else {
      rows = await db
        .select()
        .from(changeLog)
        .where(and(...filters))
        .orderBy(asc(changeLog.seq))
        .limit(limit);
    }

    const creates: SyncChange[] = [];
    const updates: SyncChange[] = [];
    const moves: SyncChange[] = [];
    const deletes: SyncChange[] = [];

    /**
     * PREFETCH THE PAGE'S MESSAGES IN THREE QUERIES, before the loop. The loop used to call
     * `materialize()` per row — three sequential round trips per message, 1,500 at the 500-row
     * default, enough to run past the function timeout: `/sync` returned nothing and every view
     * rendered empty. `message` AND `thread` are prefetched because they appear in volume (ingest
     * records a thread change beside nearly every message create); `materializeThread` measured
     * in the tens of seconds for a page of hundreds against a remote database. The other six
     * types stay per-row, which is correct and rare. Both batch readers apply the same
     * `accountId` predicate the per-row calls did — this changes cost and nothing else.
     */
    const messageIds = rows.filter((r) => r.entityType === "message" && r.op !== "delete").map((r) => r.entityId);
    const prefetched = await materializeMessages(db, accountId, messageIds);
    const threadIds = rows.filter((r) => r.entityType === "thread" && r.op !== "delete").map((r) => r.entityId);
    const prefetchedThreads = await materializeThreads(db, accountId, threadIds);

    /**
     * `folder` JOINS THE PREFETCH — measured, like the two above. Folder changes arrive in
     * ACCOUNT-WIDE BURSTS: the "Use folders" toggle writes one create per user folder in one
     * transaction, so the first page an enabling account drains is nothing but folder creates —
     * 527 on the first production mailbox this shipped to. The per-row path priced that at ~1,000
     * serial round trips — measured 30.7 s for a 400-row page against a 60 s budget — so the rail
     * stayed empty while the account watched its own switch do nothing. Batched, the page costs
     * TWO queries flat: one flag read, one `userFoldersByIds`. Same scoping, same
     * null-means-tombstone semantics.
     */
    const folderIds = rows.filter((r) => r.entityType === "folder" && r.op !== "delete").map((r) => r.entityId);
    const prefetchedFolders = folderIds.length > 0 && await foldersEnabled(db, accountId)
      ? await userFoldersByIds(db, accountId, folderIds)
      : new Map<string, UserFolderRow>();

    /**
     * THE REMAINING SMALL-STATE TYPES JOIN THE PREFETCH — measured, like the three above. A
     * backlog page is not only mail: triage from another device is `message_state` rows,
     * composing is `draft` rows, screening is `rule` rows — each cost a sequential round trip
     * (~18 ms on the live serverless path; a 500-row page carrying 38 such rows spent ~680 ms of
     * its 1,084 ms p50 in the loop, and a page carrying hundreds was the measured p90 at 1,939
     * ms). One `inArray` per type PRESENT on the page; absent types cost nothing; the projection
     * functions are shared with the per-id readers so the paths cannot drift. `settings` is
     * memoized rather than batched: one row per account, every change row names the same id.
     */
    const idsOf = (t: EntityType): string[] =>
      rows.filter((r) => r.entityType === t && r.op !== "delete").map((r) => r.entityId);
    const prefetchedStates = await materializeMessageStates(db, accountId, idsOf("message_state"));
    const prefetchedDecisions = await materializeRoutingDecisions(db, accountId, idsOf("routing_decision"));
    const prefetchedApprovals = await materializeApprovals(db, accountId, idsOf("approval"));
    const prefetchedRules = await materializeRules(db, accountId, idsOf("rule"));
    const prefetchedDrafts = await materializeDrafts(db, accountId, idsOf("draft"));
    const prefetchedTags = await materializeTags(db, accountId, idsOf("tag"));
    const settingsMemo = new Map<string, unknown | null>();

    const prefetched2 = new Map<EntityType, Map<string, unknown>>([
      ["message_state", prefetchedStates],
      ["routing_decision", prefetchedDecisions],
      ["approval", prefetchedApprovals],
      ["rule", prefetchedRules],
      ["draft", prefetchedDrafts],
      ["tag", prefetchedTags],
    ]);

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
      const batched = prefetched2.get(type);
      const entity = type === "message"
        ? (prefetched.get(id) ?? null)
        : type === "thread"
          ? (prefetchedThreads.get(id) ?? null)
          : type === "folder"
            ? (() => { const f = prefetchedFolders.get(id); return f ? folderRowToDTO(f) : null; })()
            : batched
              ? (batched.get(id) ?? null)
              : type === "settings"
                ? await (async () => {
                  if (!settingsMemo.has(id)) settingsMemo.set(id, await materializeSettings(db, accountId, id));
                  return settingsMemo.get(id) ?? null;
                })()
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

    // cursor and hasMore, per mode. Plain page: cursor = max seq actually returned (unchanged
    // when empty); a full page means "maybe more". Coalesced, CUT (a lookahead entity exists):
    // cursor = that unemitted entity's first-seq − 1, and there is trivially more. Coalesced,
    // WINDOW CONSUMED: every scanned entity was emitted, so the cursor advances to the window's
    // own max seq, and "more?" is that cursor against the horizon this request read for its 410
    // checks — fullness says nothing here, since a window can dedup to fewer than `limit` rows
    // while thousands remain beyond it. The `rows.length > 0` guard keeps a types-filtered window
    // that matched nothing from answering an unchanged cursor with `hasMore: true`, which a drain
    // loop would spin on for ever.
    let cursorSeq: bigint;
    let hasMore: boolean;
    if (!coalesced) {
      cursorSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : sinceSeq;
      hasMore = rows.length === limit;
    } else if (rows.length === 0) {
      cursorSeq = sinceSeq;
      hasMore = false;
    } else if (coalescedCutCursor !== null) {
      cursorSeq = coalescedCutCursor;
      hasMore = true;
    } else {
      cursorSeq = rows.reduce((m, r) => (r.seq > m ? r.seq : m), 0n);
      hasMore = horizonSeq !== null && cursorSeq < horizonSeq;
    }

    return {
      changes: { creates, updates, moves, deletes },
      cursor: this.encodeCursor(cursorSeq),
      hasMore,
      serverTime: ctx.now().toISOString(),
    };
  }

  /**
   * `GET /sync/snapshot` — THE BOOTSTRAP READER. A first-run client used to replay `change_log`
   * from seq 0 — history rather than state; this reads the LIVE TABLES, so the cost is the size
   * of the mailbox. Page 1 carries the live small state — every rule, draft and tag, unpaged —
   * plus the newest page of messages. EVERY page carries the THREADS its own messages name and
   * their child rows, keyed to the message window. `folder` rides page 1 only while the flag is
   * on (byte parity off). Messages are bounded by `SNAPSHOT_WINDOW`; then a TAIL restricted to
   * messages owning a `message_tags` row — tagged mail below the window is otherwise unreachable.
   * Every row is `op:"create"` at `seq = asOfSeq`.
   */
  async getSnapshot(ctx: ServiceContext, opts: GetSnapshotOptions = {}): Promise<SnapshotResponse> {
    const { db, accountId } = ctx;
    const limit = clampPageLimit(opts.limit, DEFAULT_LIMIT, MAX_LIMIT);
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

      // AN APPROVAL WITH NO MESSAGE has no page to ride with, so it stays here — under the page
      // limit, which is the whole point. `kind` admits later message-less kinds (`draft_send`,
      // `workflow_action`); `routing` is the only one that exists and it always names a message,
      // so this read is dormant rather than dead.
      const orphanApprovals = await db.select().from(approvals).where(and(
        eq(approvals.accountId, accountId),
        isNull(approvals.messageId),
      )).limit(limit);
      for (const a of orphanApprovals) {
        emit("approval", a.id, approvalRowToDTO(a), a.updatedAt.toISOString());
      }

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
      // tags above, and the row that closes the bootstrap race named below: a settings
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

    // THREADS RIDE WITH THE PAGE THAT REFERENCES THEM — not the thread table: a thread whose
    // every message is outside the window would be a header over mail the client does not have,
    // and the full table is unbounded exactly where the message window is bounded. Each page
    // carries the threads ITS OWN messages name, so a client that stops paging holds threads for
    // precisely the mail it holds. DUPLICATES ACROSS PAGES ARE ACCEPTED: a straddling thread is
    // named by both pages, and the cursor cannot carry the emitted set (it grows without bound
    // and the cursor is a URL). It costs nothing: both copies are `op:"create"` at the SAME `seq
    // = asOfSeq`, so the older-or-equal guard makes the second a no-op. Within ONE page they ARE
    // deduped, because that is free.
    const threadIds = [...new Set(
      pageMessages.map((m) => m.threadId).filter((id): id is string => id != null),
    )];
    for (const dto of (await materializeThreads(db, accountId, threadIds)).values()) {
      emit("thread", dto.id, dto, dto.updatedAt);
    }

    // A MESSAGE'S CHILD STATE RIDES WITH THE MESSAGE, NEVER WITH THE ACCOUNT. `message_state`, a
    // pending `routing_decision` and an `approval` are keyed to a message, and reading them per
    // ACCOUNT made page 1 unbounded AND window-incoherent: the client was handed actionable state
    // for a message it never received, the cursor moved past that change for ever, and the row
    // sat unreachable — a pile entry titled with a bare id. Keyed to the page, both close: at
    // most `limit` parents is at most `limit` children, and a child cannot arrive without its
    // row. On `pageMessages` and NOT the keyset `rows`: `materializeMessagesInOrder` re-applies
    // the living-view filter, so a message tombstoned between the reads is in `rows` and absent
    // from the page — keying on `rows` would emit its children with no parent.
    for (const c of await materializeMessageChildren(db, accountId, pageMessages.map((m) => m.id))) {
      emit(c.type, c.id, c.entity, c.updatedAt);
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
