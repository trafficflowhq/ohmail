import { and, asc, desc, eq, exists, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  approvals, changeLog, drafts, messages, messageStates, messageTags, prunedThroughSeq, routingDecisions, seqBounds,
  rules, tags, type EntityType,
} from "@trafficflow/db";
import type { Db, ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { clampPageLimit } from "./pagination.js";
import { isUuid } from "./ids.js";

/**
 * The longest `?since=` cursor `/sync` will decode.
 *
 * A `change_log` seq is a `bigserial`, so each numeric segment is at most nineteen digits. The
 * widest legal body is `generation.seq~floor` — three nineteen-digit numbers and two separators,
 * 59 utf8 bytes — which base64url spells in 80 characters, and this bound leaves room for
 * nothing else.
 */
export const SYNC_CURSOR_MAX_CHARS = 80;

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
  approvalRowToDTO, draftRowToSnapshotDTO, draftRowWithheldDTO, folderRowToDTO, materialize,
  materializeApprovals,
  materializeDrafts, materializeMessageChildren, materializeMessages,
  materializeMessagesInOrder, materializeMessageStates, materializeRoutingDecisions,
  materializeRules, materializeSettings,
  materializeTags, materializeThreads,
  ruleRowToDTO, tagRowToDTO, type MessageChildChange,
} from "./dto/materialize.js";
import { foldersEnabled, listUserFolders, userFoldersByIds, type UserFolderRow } from "./folders.js";
import { DRAFT_ROW_MAX_BYTES, PageByteBudget, weighChange } from "./sync-page-byte-budget.js";
import type {
  ChangeOp, DraftDTO, Folder, SnapshotResponse, SnapshotWindow, SyncChange, SyncResponse,
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
 * See {@link SnapshotWindow} for what the three numbers mean together.
 *
 * WHY 10 000. It is the ceiling every windowed client keeps (the browser, the desktop and the
 * phone all evict past it), and a server that served FEWER than the largest client window would
 * starve a mirror of rows it is willing to hold and never get them back — the delta only carries
 * what changes. So the rule is one-directional: at least the largest client ceiling, never less.
 */
export const SNAPSHOT_WINDOW: SnapshotWindow & { maxRows: number } =
  { days: 90, minRows: 5000, maxRows: 10_000 };

/**
 * A ceiling under the floor is a misconfiguration, not a narrower window: the walk keeps paging
 * until the floor is met, so it would read as "the floor won" and the window it names would never
 * be the window it serves. Refused at module load rather than clamped — a silent reorder is the
 * shape that makes a wrong constant survive a release.
 */
export function assertSnapshotWindow(w: SnapshotWindow): void {
  if (w.maxRows !== undefined && w.maxRows < w.minRows) {
    throw new Error(`SNAPSHOT_WINDOW.maxRows (${w.maxRows}) is below minRows (${w.minRows})`);
  }
}
assertSnapshotWindow(SNAPSHOT_WINDOW);

/**
 * How many drafts one snapshot page carries, newest first. Page 1 used to emit EVERY draft row
 * the account holds with no limit applied — the one live-state read left unpaged after the child
 * rows moved onto their message's page. A draft is a whole composed message, so the count is also
 * a byte budget; this is the order of a default message page, which puts an ordinary account's
 * entire draft set on page 1 and pages anything larger. See the draft keyset in `getSnapshot`.
 */
export const SNAPSHOT_DRAFT_PAGE = 100;

/**
 * HOW MANY MESSAGES PAGE 1 CARRIES — a viewport's worth, so the reader has mail while the rest of
 * the window is still being read. Page 1 used to take {@link DEFAULT_LIMIT} like every other page,
 * and the walk's cost is linear in the rows it emits, so most of that page was work in front of a
 * first row nobody could see. It bounds the MESSAGE walk only: page 1's live state — rules, tags,
 * folders, settings, message-less approvals — is unpaged and stays that way, and the keyset makes
 * page 1 a strict PREFIX of what it replaced: the same rows, in the same order.
 */
export const SNAPSHOT_FIRST_PAGE_MESSAGES = 50;

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
  /**
   * `"tail"` on PAGE 1 asks for the LABELED TAIL ALONE — every message that owns a tag, newest
   * first, with no window ahead of it and no page-1 live state. A windowed client whose mirror
   * evicted tagged mail under an older retention policy needs exactly those rows and nothing
   * else: the ordinary walk reaches them only after paging the whole window, and its page 1 is
   * the mail such a client already holds. Cost is bounded by how much mail carries a tag, which
   * is what somebody tagged by hand. Absent — and any phase this build has never heard of, which
   * the route drops at the read — is the ordinary walk, byte for byte.
   */
  phase?: "tail";
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
interface DraftKeyset {
  /** The previous page's last `drafts.updated_at` as epoch ms. */
  updatedAt: number;
  id: string;
}

interface MessageSnapshotCursor {
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
  /**
   * Where the DRAFT walk resumes. ABSENT MEANS THE DRAFTS ARE FINISHED, and that reading is true
   * of a cursor issued before this field existed too: page 1 emitted every draft back then, so an
   * in-flight bootstrap across a deploy is already complete on drafts and must not restart them.
   */
  draft?: DraftKeyset;
}

/**
 * Drafts outlived the message walk: every message phase is done and drafts remain, so this page
 * carries drafts and nothing else. It holds NO message keyset — there is not always one to hold
 * (an account with more drafts than messages runs off the end of `messages` first) and a sentinel
 * would be a position the next page could act on.
 */
interface DraftsSnapshotCursor {
  asOfSeq: bigint;
  emitted: number;
  phase: "drafts";
  draft: DraftKeyset;
}

type SnapshotCursor = MessageSnapshotCursor | DraftsSnapshotCursor;

/**
 * The delta `/sync` reader. Reads `change_log` ascending by seq, re-materializes the CURRENT DTO
 * per row, tombstones rows whose live entity is gone, and never advances the cursor past a change
 * it dropped. A steady-state cursor (span ≤ `STALE_COALESCE_SPAN`) is served one change per log
 * row — the deployed shape, byte for byte. A STALE cursor is served COALESCED pages (the latest
 * change per entity within a bounded window), sound precisely BECAUSE this reader projects
 * current state rather than history: the skipped rows are superseded copies of the same upsert.
 */
/** A decoded `/sync` cursor: where in the log, and which run of the store issued it. */
export interface SyncCursor {
  seq: bigint;
  /** `null` ⇒ the cursor names no run, which only a first-generation store admits. */
  generation: number | null;
  /**
   * The retention floor this cursor was issued UNDER, present only while the cursor sits below
   * it — i.e. mid-replay over the compacted region (a `since=0` bootstrap paging retained
   * first rows). The floor arm admits such a cursor as long as the floor has not risen past the
   * tag: under an unchanged floor the compaction can only delete rows this replay does not need
   * (each consumed row was materialized at serve time, and every post-serve change writes a NEW
   * seq the 30-day grace protects), while a RISEN floor means churn this replay had not reached
   * was deleted — unrecoverable, 410, restart. `null` on every at-or-above-floor cursor, which
   * is every cursor that existed before this field did — those genuinely predate the prune.
   */
  floor: bigint | null;
}

export class SyncService {
  /**
   * Opaque base64 of the per-account high-water seq, and — where the store has one — the run of
   * that store the seq belongs to, in front of it.
   *
   * IN the cursor rather than beside it, because a cursor is the one value every client already
   * round-trips unread: a second wire field would have to be carried by the desktop mirror, the
   * phone and a browser, and any one of them dropping it would be a cursor that still LOOKS
   * valid. A store with no generation encodes exactly what it always did, so the hosted wire does
   * not move. See {@link decodeCursor} for what the two shapes mean to a reader.
   */
  encodeCursor(seq: bigint, generation?: number | null, floor?: bigint | null): string {
    const base = generation == null ? seq.toString(10) : `${generation}.${seq.toString(10)}`;
    // The floor tag rides IN the cursor for the field's own reason (see the docblock above):
    // every client already round-trips the cursor unread, so a mid-bootstrap resume over a
    // compacted log survives sidecars and engines that have never heard of retention.
    const body = floor == null ? base : `${base}~${floor.toString(10)}`;
    return Buffer.from(body, "utf8").toString("base64url");
  }

  /**
   * THE CURSOR IS REFUSED WHEN IT NAMES A RUN OF THE STORE THAT IS OVER.
   *
   * A store whose ingest does not wait for the flush gives back its last commits' seqs after a
   * kill, so rows re-derived from the mailbox land BELOW a parked cursor and are never served.
   * The horizon check below catches a client that polls inside that window; this catches the one
   * that does not. A cursor naming no run is admitted by a FIRST generation — the run no crash
   * has ended — which is how a cursor issued before this field existed survives the upgrade.
   */
  private assertSameStoreRun(cursor: number | null, store: number | null): void {
    if (cursor === store) return;
    if (cursor === null && store === 1) return;
    throw new ServiceError(
      "cursor_expired", 410,
      "sync cursor belongs to an earlier run of this store; re-bootstrap with since=0",
    );
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
  decodeCursor(cursor: string): SyncCursor {
    try {
      if (cursor.length > SYNC_CURSOR_MAX_CHARS) throw new Error("cursor too long");
      const dec = Buffer.from(cursor, "base64url").toString("utf8");
      // ONE parser for all three shapes, so neither the generation nor the floor tag can be
      // admitted by one reader and dropped by another. Both are bounded like the seq.
      const m = /^(?:(\d{1,19})\.)?(\d{1,19})(?:~(\d{1,19}))?$/.exec(dec);
      if (m === null) throw new Error("non-numeric cursor");
      const generation = m[1] === undefined ? null : Number(m[1]);
      if (generation !== null && !Number.isSafeInteger(generation)) throw new Error("generation out of range");
      // The digit count bounds the PARSE and the RANGE bounds the value — nineteen digits reaches
      // `9999999999999999999`, which is past what a `bigserial` holds. The same pair the snapshot
      // cursor's `s` carries, and for the same reason.
      const seq = BigInt(m[2]!);
      if (seq > MAX_BIGSERIAL) throw new Error("seq out of range");
      const floor = m[3] === undefined ? null : BigInt(m[3]);
      if (floor !== null && floor > MAX_BIGSERIAL) throw new Error("floor out of range");
      return { seq, generation, floor };
    } catch {
      throw new ServiceError("cursor_expired", 410, "sync cursor is malformed or expired; re-bootstrap with since=0");
    }
  }

  /** Opaque base64url of the snapshot's consistent point plus this page's keyset position. */
  encodeSnapshotCursor(c: SnapshotCursor): string {
    const payload = {
      v: 1, s: c.asOfSeq.toString(10), n: c.emitted,
      // A drafts-phase cursor carries no message keyset; every other phase carries one.
      ...(c.phase === "drafts" ? {} : { d: c.date, i: c.id }),
      ...(c.phase ? { p: c.phase } : {}),
      ...(c.draft ? { da: c.draft.updatedAt, di: c.draft.id } : {}),
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
      // decode. Its eight fields are a version, a seq, a date, a uuid, a count, a phase and the
      // draft keyset's own date and uuid — comfortably inside {@link SNAPSHOT_CURSOR_MAX_CHARS}.
      if (cursor.length > SNAPSHOT_CURSOR_MAX_CHARS) throw new Error("cursor too long");
      const raw: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (typeof raw !== "object" || raw === null) throw new Error("not an object");
      const { v, s, d, i, n, p, da, di } = raw as Record<string, unknown>;
      if (v !== 1) throw new Error("unknown cursor version");
      // The digit count bounds the PARSE (`BigInt` accepts a three-hundred-digit string happily,
      // which then reaches `Number(asOfSeq)` as `Infinity`) and the RANGE bounds the value — a
      // `change_log` seq is a `bigserial`, and nineteen digits reaches past what one can hold.
      // The other two numeric fields get the same treatment below: a cursor small enough to pass
      // the wire ceiling can still carry values no clock or counter could produce.
      if (typeof s !== "string" || !/^\d{1,19}$/.test(s) || BigInt(s) > MAX_BIGSERIAL) {
        throw new Error("bad asOfSeq");
      }
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_EMITTED) {
        throw new Error("bad emitted count");
      }
      if (p !== undefined && p !== "tail" && p !== "drafts") throw new Error("bad phase");
      // THE DRAFT KEYSET, both halves or neither: one half alone is a position nothing can
      // resume from, and reading it as absent would silently declare the drafts finished.
      // Same range rules as the message keyset below, for the same reason.
      if ((da === undefined) !== (di === undefined)) throw new Error("half a draft keyset");
      if (di !== undefined && !isUuid(di)) throw new Error("bad draft keyset id");
      if (da !== undefined
          && (typeof da !== "number" || !Number.isFinite(da) || da > MAX_EPOCH_MS || da < MIN_EPOCH_MS)) {
        throw new Error("bad draft keyset date");
      }
      const draft = da === undefined
        ? undefined
        : { draft: { updatedAt: da as number, id: di as string } };
      if (p === "drafts") {
        // A drafts-phase cursor has no message keyset to carry and cannot be resumed without a
        // draft position — either shape is a cursor this service never issued.
        if (d !== undefined || i !== undefined) throw new Error("a drafts cursor with a message keyset");
        if (draft === undefined) throw new Error("a drafts cursor with no draft keyset");
        return { asOfSeq: BigInt(s), emitted: n, phase: "drafts", ...draft };
      }
      // A UUID, not merely a non-empty string: `i` is bound against `messages.id` (and its
      // siblings) further down, so `{"i":"x"}` in a hand-built cursor reached Postgres as 22P02 —
      // a 500 for a value this function had already claimed to validate. Every other field here
      // is shape-checked; this one said "not empty" and meant it.
      if (!isUuid(i)) throw new Error("bad keyset id");
      // `Date`'s own range, not merely "finite": `1e308` is a finite number and not a date, and
      // it reaches a `timestamptz` comparison as one.
      if (d !== null && (typeof d !== "number" || !Number.isFinite(d) || d > MAX_EPOCH_MS || d < MIN_EPOCH_MS)) {
        throw new Error("bad keyset date");
      }
      return {
        asOfSeq: BigInt(s), date: d as number | null, id: i, emitted: n,
        ...(p === "tail" ? { phase: "tail" as const } : {}),
        ...draft,
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
    const storeGeneration = ctx.storeGeneration ?? null;
    const parsed = opts.since && opts.since !== "0" ? this.decodeCursor(opts.since) : null;
    /* BEFORE EVERY OTHER QUESTION, because every other question is about a log this cursor may
       not belong to: a seq compared against the bounds of the wrong run is a comparison of two
       unrelated numbers. See {@link assertSameStoreRun}. */
    if (parsed !== null) this.assertSameStoreRun(parsed.generation, storeGeneration);
    const sinceSeq = parsed?.seq ?? 0n;

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
    /** The retention floor, read on EVERY path: the resuming arm needs it for the 410, and the
     *  bootstrap arm needs it to TAG the sub-floor page cursors it hands out (see below). */
    let prunedThrough = 0n;
    if (sinceSeq > 0n) {
      const { min: minSeq, max: maxSeq, prunedThrough: floor } = await seqBounds(db, accountId);
      prunedThrough = floor;
      // THE RETENTION FLOOR (mail 0122), the authoritative one: the pass compacts below
      // `pruned_through_seq` — tombstones included — while RETAINING each live entity's first
      // row, so `min` stays low and only this explicit floor can see the gap. A cursor AT the
      // floor is fine; below it, rows it never saw are gone — EXCEPT a cursor whose floor TAG is
      // at or above the current floor, which is a post-prune bootstrap mid-replay over the
      // retained sub-floor rows: each consumed row was materialized at serve time, and under an
      // unmoved floor the compactor deletes nothing such a replay needs ({@link SyncCursor.floor}).
      // The `min` check stays as the belt for the shapes that empty the log outright;
      // raised-before-delete keeps the race one-sided (an empty 200 becomes the NEXT poll's 410,
      // never a gap).
      const bootstrapUnderCurrentFloor = parsed?.floor != null && parsed.floor >= prunedThrough;
      if (prunedThrough > 0n && sinceSeq < prunedThrough && !bootstrapUnderCurrentFloor) {
        throw new ServiceError(
          "cursor_expired", 410,
          "sync cursor is older than the retention horizon; re-bootstrap with since=0",
        );
      }
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
      /* A CURSOR THAT IS ALREADY THE HORIZON IS ANSWERED HERE, out of the read the 410 checks
         just took — the rest of this function computes the same empty answer from it, since
         `seq > since` matches nothing. An IDENTITY, not a 304: the answer is a function of the
         rows above the cursor and there are none. It is exact because no row at or below
         `maxSeq` can become visible afterwards — `allocateSeqRange` refuses a handle outside a
         transaction and its counter UPDATE holds that row's lock to commit, so allocation order
         is commit order, which a Postgres test drives with two overlapping writers. */
      if (sinceSeq === maxSeq) {
        return {
          changes: { creates: [], updates: [], moves: [], deletes: [] },
          cursor: this.encodeCursor(sinceSeq, storeGeneration),
          hasMore: false,
          serverTime: ctx.now().toISOString(),
        };
      }
      horizonSeq = maxSeq;
    } else {
      // The bootstrap replay pages through the compacted region, so its outgoing cursors need
      // the floor tag from page one — one PK-row read, never the aggregate.
      prunedThrough = await prunedThroughSeq(db, accountId);
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
      // scoped-by: `filters` above leads with eq(changeLog.accountId, accountId)
      const spanRows = db.$with("span").as(
        db.select()
          .from(changeLog)
          .where(and(...filters))
          .orderBy(asc(changeLog.seq))
          .limit(COALESCE_SCAN_WINDOW),
      );
      // scoped-by: spanRows is the account-filtered CTE defined just above
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
      // scoped-by: `filters` above leads with eq(changeLog.accountId, accountId)
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
      // A cursor still below the retention floor is a replay over the compacted region — tag it
      // with the floor it is valid under, so the NEXT page is admitted rather than 410'd (see
      // {@link SyncCursor.floor}); at or above the floor the cursor is the plain shape it always was.
      cursor: this.encodeCursor(cursorSeq, storeGeneration, cursorSeq < prunedThrough ? prunedThrough : null),
      hasMore,
      serverTime: ctx.now().toISOString(),
    };
  }

  /**
   * `GET /sync/snapshot` — THE BOOTSTRAP READER. A first-run client used to replay `change_log`
   * from seq 0 — history rather than state; this reads the LIVE TABLES, so the cost is the size of
   * the mailbox. Page 1 carries the live small state — every rule and tag, unpaged, and `folder`
   * while the flag is on — plus the newest page of messages. EVERY page carries the THREADS its own
   * messages name, their child rows, and the next {@link SNAPSHOT_DRAFT_PAGE} drafts. Three phases:
   * the message window (`SNAPSHOT_WINDOW` — two floors and a ceiling), then a TAIL carrying the
   * messages below it that own a tag, a PARK, a pending approval or a pending routing decision —
   * otherwise unreachable — then drafts outliving both. Every row is `op:"create"` at
   * `seq = asOfSeq`.
   */
  async getSnapshot(ctx: ServiceContext, opts: GetSnapshotOptions = {}): Promise<SnapshotResponse> {
    const { db, accountId } = ctx;
    const limit = clampPageLimit(opts.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const cursor = opts.cursor && opts.cursor !== "" ? this.decodeSnapshotCursor(opts.cursor) : null;
    // TAIL-ONLY: page 1 of a walk that starts IN the tail. PRESENCE and not a second spelling
    // test — the option's type admits the one phase there is, and the route decides the
    // vocabulary at the read (where `input-bounds-census` asks for it). A later phase would widen
    // the type and this line with it, which is the point: one comparison, in one place.
    // Only ever true on page 1; later pages carry `phase: "tail"` in the cursor itself.
    const tailOnly = cursor === null && opts.phase !== undefined;

    // THE GAP-FREE SEQ IS FIXED BEFORE ANY ENTITY READ. See `highWaterSeq` for what depends on
    // this line
    // running first and nothing depending on it running at all if a cursor already fixed the point.
    const asOfSeq = cursor ? cursor.asOfSeq : await this.highWaterSeq(db, accountId);
    const seq = Number(asOfSeq);

    const changes: SyncChange[] = [];
    /**
     * ONE BUDGET FOR THE WHOLE PAGE, IN THE UNIT THE TRANSPORT REFUSES ON. Rows were the only
     * bound and the encoder counts bytes, so a page correct by every row rule could not be
     * delivered at all — the frame is refused, the stdio host answers `sidecar_failed`, and the
     * bootstrap never completes. Every emission below is charged, and the two PAGED phases stop
     * on it. See `sync-page-byte-budget.ts` for where the number comes from.
     */
    const budget = new PageByteBudget();
    const changeOf = (type: EntityType, id: string, entity: unknown, updatedAt: string): SyncChange =>
      ({ type, op: "create", id, seq, updatedAt, entity });
    /** Emit and charge. Page-1 live state and a message's own children go through here: they are
     *  mandatory, so they are counted rather than refused. */
    const emit = (type: EntityType, id: string, entity: unknown, updatedAt: string): void => {
      const change = changeOf(type, id, entity, updatedAt);
      budget.charge(weighChange(change));
      changes.push(change);
    };

    if (cursor === null && !tailOnly) {
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

    // ── DRAFTS RIDE THE PAGES, newest first, keyset-paged on (updated_at desc, id desc) ───────
    //
    // Page 1 used to emit every draft row unpaged — the last such read, and the one carrying whole
    // composed messages. A keyset for the message window's reason: an OFFSET makes every page a
    // different consistent point, and a draft saved mid-bootstrap would shift the rest and skip one
    // for ever. `drafts_account_updated_idx` is that ordering.
    // ABSENT `cursor.draft` MEANS FINISHED — true of a cursor issued after exhausting them and of
    // one issued before the field existed, when page 1 emitted them all, so a bootstrap in flight
    // across a deploy neither restarts the set nor loses it. No cursor at all starts at the newest.
    const draftResume = cursor === null ? undefined : cursor.draft;
    const draftsDone = cursor !== null && cursor.draft === undefined;
    let draftNext: DraftKeyset | undefined;
    /**
     * Read the next drafts and emit what this page has room for, newest first.
     *
     * Runs LAST on a message page — after the walk, which stops a draft's width early so the
     * first row here always has somewhere to go. Two bounds, not one: the COUNT
     * (`SNAPSHOT_DRAFT_PAGE`) and the BYTES, and the walk stops at whichever it reaches first,
     * reporting the keyset it actually reached rather than the one it read.
     */
    const emitDrafts = async (): Promise<void> => {
      if (draftsDone) return;
      const draftKeyset = draftResume === undefined
        ? undefined
        : or(
          lt(drafts.updatedAt, new Date(draftResume.updatedAt)),
          and(eq(drafts.updatedAt, new Date(draftResume.updatedAt)), lt(drafts.id, draftResume.id)),
        );
      const draftRows = await db.select().from(drafts)
        .where(and(eq(drafts.accountId, accountId), ...(draftKeyset ? [draftKeyset] : [])))
        .orderBy(desc(drafts.updatedAt), desc(drafts.id))
        .limit(SNAPSHOT_DRAFT_PAGE);
      // AND NOT EVERY DRAFT'S BYTES: a stored body past `DRAFT_BODY_MAX_BYTES` arrives as `null`
      // with its reason and the client asks for it by id. The page bounds the COUNT; this bounds
      // what one row weighs, and the two ceilings are independent.
      let lastDraft: (typeof draftRows)[number] | undefined;
      for (const d of draftRows) {
        let change = changeOf("draft", d.id, draftRowToSnapshotDTO(d), d.updatedAt.toISOString());
        let bytes = weighChange(change);
        // A ROW NO PAGE COULD EVER CARRY IS WITHHELD, NOT DROPPED AND NOT LEFT TO WEDGE THE WALK.
        // `body` has a ceiling and `html` a database CHECK; `rationale` and the recipient lists
        // have neither, so this is reachable while every documented limit holds. The withheld row
        // still lists, and `GET /drafts/:id` opens it.
        if (bytes > DRAFT_ROW_MAX_BYTES) {
          change = changeOf("draft", d.id, draftRowWithheldDTO(change.entity as DraftDTO), change.updatedAt);
          bytes = weighChange(change);
        }
        // THE FIRST DRAFT OF A PAGE ALWAYS RIDES — that is what makes the walk advance, and what
        // lets the keyset below always name a row. It cannot overshoot: the message phase held
        // `DRAFT_ROW_MAX_BYTES` back, and anything heavier than that was withheld one line up.
        if (lastDraft !== undefined && !budget.admits(bytes)) break;
        budget.charge(bytes);
        changes.push(change);
        lastDraft = d;
      }
      // A SHORT PAGE IS THE END. A full one may or may not be, and asking again for an empty page
      // is the price of not paying for a count on every page of every bootstrap. A page the BYTES
      // ended is never the end, however few rows it carried.
      const readThemAll = lastDraft !== undefined && lastDraft === draftRows[draftRows.length - 1];
      if (lastDraft !== undefined && (!readThemAll || draftRows.length === SNAPSHOT_DRAFT_PAGE)) {
        draftNext = { updatedAt: lastDraft.updatedAt.getTime(), id: lastDraft.id };
      }
    };

    if (cursor !== null && cursor.phase === "drafts") {
      // THE THIRD PHASE: the message walk and its tail are both finished and drafts are not. This
      // page carries drafts and nothing else — there is no message keyset left to walk, so the
      // whole budget is theirs.
      await emitDrafts();
      return {
        asOfSeq: seq,
        changes,
        nextCursor: draftNext === undefined ? null : this.encodeSnapshotCursor({
          asOfSeq, emitted: cursor.emitted, phase: "drafts", draft: draftNext,
        }),
        window: SNAPSHOT_WINDOW,
      };
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

    // ── WHAT A MESSAGE BELOW THE WINDOW MUST OWN TO BE CARRIED ───────────────────────────────
    //
    // The tail is the SAME keyset walk resumed past the window, restricted to messages owning
    // something the client cannot do without, so its cost is bounded by how much mail owns one of
    // these rather than by the mailbox. A TAG, because a rail over mail the client lacks reads as
    // empty. A PARK, because the window is days over the ARRIVAL stamp and a message parked until
    // next month is one whose arrival says nothing about whether it is wanted. A PENDING approval
    // or routing decision, because those are actions somebody is waiting to take. Settled rows and
    // `none` parks are history, which is what the window is for. Every arm filters `account_id`
    // too, so a bug that let the two disagree fails closed rather than leaking into another
    // account's bootstrap.
    const inTail = cursor?.phase === "tail" || tailOnly;
    const reachableTail = inTail
      ? or(
        exists(
          db.select({ x: sql`1` }).from(messageTags).where(and(
            eq(messageTags.messageId, messages.id),
            eq(messageTags.accountId, accountId),
          )),
        ),
        exists(
          db.select({ x: sql`1` }).from(approvals).where(and(
            eq(approvals.messageId, messages.id),
            eq(approvals.accountId, accountId),
            eq(approvals.status, "pending"),
          )),
        ),
        /**
         * A PARK. `SNAPSHOT_WINDOW` is untouched and a horizon beyond it is admitted for as long
         * as the message is parked. `none` is the resting state every released message keeps, so
         * it must not admit, or the tail would re-deliver everything ever parked.
         */
        exists(
          db.select({ x: sql`1` }).from(messageStates).where(and(
            eq(messageStates.messageId, messages.id),
            eq(messageStates.accountId, accountId),
            ne(messageStates.state, "none"),
          )),
        ),
        exists(
          db.select({ x: sql`1` }).from(routingDecisions).where(and(
            eq(routingDecisions.messageId, messages.id),
            eq(routingDecisions.accountId, accountId),
            eq(routingDecisions.status, "pending_approval"),
          )),
        ),
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
      ...(reachableTail ? [reachableTail] : []),
    );

    /* THE BOUND THIS PAGE'S MESSAGE WALK TAKES. Page 1 of an ordinary cold start takes a
       viewport's worth ({@link SNAPSHOT_FIRST_PAGE_MESSAGES}); every later page, and a walk that
       starts in the tail, takes the caller's own limit. `Math.min` so a caller asking for FEWER
       still gets what it asked for, and `fullPage` below compares against this and not `limit` —
       against `limit` a short first page would read as the end of the mailbox. */
    const walkLimit = cursor === null && !tailOnly
      ? Math.min(SNAPSHOT_FIRST_PAGE_MESSAGES, limit)
      : limit;

    // scoped-by: `where` above leads with eq(messages.accountId, accountId)
    const rows = await db
      .select({ id: messages.id, date: messages.date })
      .from(messages)
      .where(where)
      .orderBy(sql`${messages.date} desc nulls last`, desc(messages.id))
      .limit(walkLimit);

    const pageMessages = await materializeMessagesInOrder(db, accountId, rows.map((r) => r.id));

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
    const threadsById = await materializeThreads(db, accountId, threadIds);

    // A MESSAGE'S CHILD STATE RIDES WITH THE MESSAGE, NEVER WITH THE ACCOUNT. `message_state`, a
    // pending `routing_decision` and an `approval` are keyed to a message, and reading them per
    // ACCOUNT made page 1 unbounded AND window-incoherent: the client was handed actionable state
    // for a message it never received, the cursor moved past that change for ever, and the row
    // sat unreachable — a pile entry titled with a bare id. Keyed to the page, both close: at
    // most `limit` parents is at most `limit` children, and a child cannot arrive without its
    // row. On `pageMessages` and NOT the keyset `rows`: `materializeMessagesInOrder` re-applies
    // the living-view filter, so a message tombstoned between the reads is in `rows` and absent
    // from the page — keying on `rows` would emit its children with no parent.
    const childrenOf = new Map<string, MessageChildChange[]>();
    for (const c of await materializeMessageChildren(db, accountId, pageMessages.map((m) => m.id))) {
      const parent = c.entity.messageId;
      if (parent === null) continue;   // unreachable: every child read above named a message
      const bucket = childrenOf.get(parent);
      if (bucket) bucket.push(c); else childrenOf.set(parent, [c]);
    }

    // ── THE PAGE STOPS AT WHICHEVER BOUND IT REACHES FIRST: the row limit above, or these bytes.
    //
    // A message is weighed WITH its thread and its children, because a page may not be cut
    // between them — a child with no parent is the unreachable-row defect the block above exists
    // to prevent, and a thread is the header its messages are drawn under. The first group of a
    // page always rides, so the keyset below always names a row and the walk always advances;
    // only the live state of page 1 sits ahead of it, and that is bounded by what a person typed.
    // `DRAFT_ROW_MAX_BYTES` is held back for the draft phase, which runs after this one.
    const seenThread = new Set<string>();
    // Keyed, not scanned: `limit` reaches 2000 and a scan per row is four million comparisons on
    // the page this walk exists to make cheap.
    const liveById = new Map(pageMessages.map((m) => [m.id, m]));
    let stoppedAt = rows.length;
    let emittedMessages = 0;
    for (const [at, row] of rows.entries()) {
      const dto = liveById.get(row.id);
      // Tombstoned between the keyset read and the materialize: it costs nothing and the walk
      // must still step past it, exactly as it did before there was a byte bound.
      if (dto === undefined) continue;
      const group: SyncChange[] = [changeOf("message", dto.id, dto, dto.updatedAt)];
      const thread = dto.threadId !== null && !seenThread.has(dto.threadId)
        ? threadsById.get(dto.threadId) : undefined;
      if (thread) group.push(changeOf("thread", thread.id, thread, thread.updatedAt));
      for (const c of childrenOf.get(dto.id) ?? []) {
        group.push(changeOf(c.type, c.id, c.entity, c.updatedAt));
      }
      const bytes = group.reduce((n, c) => n + weighChange(c), 0);
      if (emittedMessages > 0 && !budget.admits(bytes, DRAFT_ROW_MAX_BYTES)) {
        stoppedAt = at;
        break;
      }
      budget.charge(bytes);
      changes.push(...group);
      if (thread) seenThread.add(thread.id);
      emittedMessages += 1;
    }
    // The keyset this page COMMITS to is the part of the read it actually delivered.
    const walked = stoppedAt === rows.length ? rows : rows.slice(0, stoppedAt);

    // The drafts come last so the walk above could hold room for them; `draftNext` has to be
    // known before `keysetOf` reads it, and it is.
    await emitDrafts();

    const emitted = (cursor?.emitted ?? 0) + walked.length;
    const last = walked[walked.length - 1];
    // A page the BYTES ended has more at this very keyset, so it continues like a full one.
    const fullPage = (walked.length === walkLimit || stoppedAt < rows.length) && last !== undefined;
    const keysetOf = (phase?: "tail"): string => this.encodeSnapshotCursor({
      asOfSeq,
      date: last!.date ? last!.date.getTime() : null,
      id: last!.id,
      emitted,
      ...(phase ? { phase } : {}),
      ...(draftNext ? { draft: draftNext } : {}),
    });

    // ── WHERE THE NEXT PAGE COMES FROM: window → tail → drafts → done ────────────────────────
    //
    // The window is the recency floor or the volume floor, whichever is not yet met, under the row
    // CEILING. When it stops the walk opens the TAIL rather than ending: below the window a message
    // owning a tag, a park, a pending approval or a pending routing decision is otherwise lost —
    // the change that made it interesting (`message_tags`, `message_states`) sits below the
    // client's post-bootstrap cursor and no delta re-delivers it. The tail resumes the same keyset
    // under `reachableTail` and ends on a short page; a walk that ran off the end has no tail.
    // THE CEILING STOPS THE WINDOW, NEVER THE TAIL — counted newest-first like the floor, so it
    // ends the walk above it and the tail still reaches below. Read at a PAGE boundary, so a
    // snapshot serves at most `maxRows` plus the page in flight.
    let nextCursor: string | null;
    if (inTail) {
      nextCursor = fullPage ? keysetOf("tail") : null;
    } else {
      const cutoff = ctx.now().getTime() - SNAPSHOT_WINDOW.days * DAY_MS;
      // Inside the recency floor ⇒ keep going. Past it ⇒ keep going only until the volume floor is
      // met. An undated row is past the floor by construction (it sorts into the tail), so it can
      // only be carried by the volume arm.
      const withinWindow = last?.date != null && last.date.getTime() >= cutoff;
      const underCeiling = emitted < SNAPSHOT_WINDOW.maxRows;
      if (fullPage && underCeiling && (withinWindow || emitted < SNAPSHOT_WINDOW.minRows)) {
        nextCursor = keysetOf();            // still inside the window
      } else if (fullPage) {
        nextCursor = keysetOf("tail");      // window satisfied, mail below it ⇒ open the tail
      } else {
        nextCursor = null;                  // ran off the end of the mailbox ⇒ no tail
      }
    }

    // Drafts outliving both message phases get their own pages rather than being dropped: a draft
    // the bootstrap never delivers is unreachable, because its `change_log` row sits below the
    // cursor the client adopts when the snapshot ends.
    if (nextCursor === null && draftNext !== undefined) {
      nextCursor = this.encodeSnapshotCursor({
        asOfSeq, emitted, phase: "drafts", draft: draftNext,
      });
    }

    /* Spread, not `?? undefined`: a store with no generation must leave the field ABSENT, which
       is the answer a client reads as "mint the shape you always did". */
    const gen = ctx.storeGeneration ?? null;
    return {
      asOfSeq: seq, changes, nextCursor, window: SNAPSHOT_WINDOW,
      ...(gen === null ? {} : { storeGeneration: gen }),
    };
  }
}

export const syncService = new SyncService();
