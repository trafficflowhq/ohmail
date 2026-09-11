import { ServiceError } from "./errors.js";

/**
 * Opaque list cursors (contract §1.5) — independent from the `/sync` seq cursor. TWO WIRE SHAPES:
 * most encoders write the last entity ID and page by `id`; four — `MessageService`,
 * `ScreenerService`, `PrivacyService.listTrackerEvents`, `WorkflowsService.listRuns` — write
 * `${millis}:${uuid}` because they order by (date, id). The triage keyset writes a bare uuid
 * despite its (date, id) intent, so it is in the first family. A validator written from a
 * one-shape reading would turn the second page of those four routes into a 400.
 */
export function encodeListCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

/**
 * The longest a list cursor may be on the wire.
 *
 * The largest shape any encoder produces is the KEYSET form — a signed millisecond timestamp, a
 * colon and a uuid. `Date#getTime()` spans ±8.64e15, so the timestamp is at most 17 characters
 * with its sign: 17 + 1 + 36 = 54, which is 72 of base64url. 96 leaves room without leaving room
 * for anything else, and it is consulted BEFORE the decode so an arbitrarily long value is
 * refused for the cost of a `.length` rather than of a base64 decode.
 */
export const LIST_CURSOR_MAX_CHARS = 96;

/**
 * THE TWO SHAPES A LIST CURSOR DECODES TO. A bare-uuid-only grammar 400s the second page of the
 * four (date, id) routes; ONE grammar accepting both is the opposite mistake — a keyset cursor
 * sent to `/contacts` binds `"1712…:<uuid>"` against a uuid column, the 22P02 this validator
 * exists to stop. So: TWO decoders, no shared grammar — `decodeListCursor` takes the bare id and
 * refuses the tuple, `decodeKeysetCursor` the reverse; each route family calls the one that
 * issued its cursors. The timestamp may be NEGATIVE (`messages.date` is the sender's own header;
 * pre-1970 mail encodes `-<millis>:<uuid>`) and up to SIXTEEN digits (`Date: Fri, 1 Jan 50000 …`
 * parses and stores). The digit ceiling is `Date`'s own range: signed millis through ±8.64e15.
 */
const CURSOR_UUID = new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i");
const CURSOR_KEYSET = new RegExp(
  "^(-?\\d{1,16}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$", "i",
);
/**
 * THE THIRD SHAPE: a keyset whose SORT KEY IS NULL — `null:<uuid>`. `messages.date` is nullable,
 * so the (date, id) walk has a position the numeric tuple cannot express. Encoding it as epoch
 * `0` is a DIFFERENT position: the list orders `date desc nulls last`, so a null row sorts AFTER
 * every dated one while epoch 0 sorts among the 1970 mail — the page after an undated row asked
 * for pre-1970 rows and the undated tail was unreachable. Spelled `null` because cursors are
 * decoded by hand when a page misbehaves; 4 + 1 + 36 = 41 chars, inside `LIST_CURSOR_MAX_CHARS`.
 * `decodeKeysetCursor` still REFUSES it: `listTrackerEvents` and `listRuns` page on `notNull`
 * columns, and accepting it there would build `is null` predicates that match nothing.
 */
const CURSOR_NULL_KEYSET = new RegExp(
  "^null:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$", "i",
);

/**
 * THE RANGE THE SINK ACCEPTS, not the range the producer can emit. A digit count admits
 * `9999999999999999`, which is not a time and reaches `timestamptz` as an out-of-range cast — so
 * the grammar checks the NUMBER, against the COLUMN's range. `Date#getTime()` spans ±8.64e15 ms;
 * `timestamptz` spans 4713 BC to 294276 AD. The upper end of `Date`'s range is inside the
 * column's, so `MAX_EPOCH_MS` is safe as written — the lower end is not:
 * `-8640000000000000:<uuid>` passed a `Date`-derived check and reached PostgreSQL as a pre-4713
 * BC timestamp, a 500 for a bad query string. "What can this value be" is not the question —
 * "what will accept it" is.
 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;
/** PostgreSQL's `timestamptz` floor, 4713-01-01 BC, in milliseconds from the epoch. */
const MIN_EPOCH_MS = -210_866_803_200_000;

/**
 * Decode an opaque list cursor, or refuse it. Node's base64 decoder never throws — it discards
 * what it cannot read — so a bare decode turned `?cursor=eA` into `"x"`, bound against a `uuid`
 * column: 22P02, a 500 for a plainly bad query string, on every keyset-paginated route. Same
 * defect `MessageService.getBodies` refuses for its `ids` and `SearchService` for its date
 * filters, in the one place they share. The LENGTH is checked before the decode — an unbounded
 * cursor is an unbounded decode. The shape here is the bare id; `decodeKeysetCursor` has the
 * other. A 400, not a 410: a malformed cursor is a bad request, and "your page moved on" would
 * send a client looping.
 */
/** Wire length and base64url decode, shared by both decoders. The SHAPE is each decoder's own. */
function decodedOr400(cursor: string): string {
  if (cursor.length > LIST_CURSOR_MAX_CHARS) {
    throw new ServiceError("validation_failed", 400, "invalid cursor");
  }
  return Buffer.from(cursor, "base64url").toString("utf8");
}

const invalidCursor = (): never => {
  throw new ServiceError("validation_failed", 400, "invalid cursor");
};

/**
 * A BARE-ID cursor: the last entity id, for a route ordered by `id`.
 *
 * It refuses the keyset form deliberately. One grammar that accepted both made each shape valid
 * on the wrong route family — `GET /contacts?cursor=<tuple>` decoded to `"1712…:<uuid>"` and bound
 * THAT against a uuid column, which is the 22P02 this validator exists to stop, reintroduced by
 * the validator being too generous. A cursor is only ever handed out by one route family and only
 * ever meaningful there.
 */
export function decodeListCursor(cursor: string): string {
  const decoded = decodedOr400(cursor);
  if (!CURSOR_UUID.test(decoded)) invalidCursor();
  return decoded;
}

/**
 * A KEYSET cursor: `(millis, id)` for a route ordered by (date, id).
 *
 * The timestamp is checked against `Date`'s own range rather than a digit count — see
 * {@link MAX_EPOCH_MS} — because the value is cast to `timestamptz` and a sixteen-digit number
 * that is not a time raises 22007 rather than paging.
 */
export function decodeKeysetCursor(cursor: string): { millis: number; id: string } {
  const decoded = decodedOr400(cursor);
  const m = CURSOR_KEYSET.exec(decoded);
  if (!m) invalidCursor();
  const millis = Number(m![1]);
  if (!Number.isFinite(millis) || millis > MAX_EPOCH_MS || millis < MIN_EPOCH_MS) invalidCursor();
  return { millis, id: m![2]! };
}

/**
 * A NULLABLE keyset cursor: `(millis | null, id)` for a route ordered by `<nullable date> desc
 * nulls last, id desc`. The numeric half is `decodeKeysetCursor`'s exactly; the addition is the
 * `null:` position at `CURSOR_NULL_KEYSET`. Only `MessageService` issues these — only its sort
 * column is nullable. An old-shape cursor encodes an undated row as `0:<uuid>` and still decodes,
 * as the epoch: during a rolling deploy that request answers the undated tail again and skips
 * dated rows back to 1970 — one page, self-healing. Versioning would 400 every in-flight cursor
 * for the deploy's length, and `0` is a legitimate `Date:` value, so no sentinel. Cursors are
 * ephemeral; no migration to write.
 */
export function decodeNullableKeysetCursor(cursor: string): { millis: number | null; id: string } {
  const decoded = decodedOr400(cursor);
  const n = CURSOR_NULL_KEYSET.exec(decoded);
  if (n) return { millis: null, id: n[1]! };
  const m = CURSOR_KEYSET.exec(decoded);
  if (!m) invalidCursor();
  const millis = Number(m![1]);
  if (!Number.isFinite(millis) || millis > MAX_EPOCH_MS || millis < MIN_EPOCH_MS) invalidCursor();
  return { millis, id: m![2]! };
}

/** Mint a {@link decodeNullableKeysetCursor} cursor. `null` is a POSITION, not a missing value. */
export function encodeNullableKeysetCursor(millis: number | null, id: string): string {
  return encodeListCursor(`${millis === null ? "null" : millis}:${id}`);
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/**
 * The page ceiling, TOTAL over every double the wire can carry. Callers reach this from
 * `Number(url.searchParams.get("limit"))`. `?limit=abc` ⇒ NaN: `??` does not fire, min/max stay
 * NaN, and drizzle-orm omits the `limit` clause for a falsy value — verified on drizzle 0.36.4:
 * `.limit(NaN).toSQL()` has no limit, `.limit(200)` has `limit $1`; `-1e999` is the same shape.
 * `?limit=1.5` or `1e999` reach Postgres as bad bigint params, a 500. The unbounded arm matters
 * most: `rows.slice(0, NaN)` is EMPTY, so the whole table is fetched for a page of nothing —
 * `getBodies`' `BODIES_BYTE_BUDGET` is consulted inside that empty loop. Anything not a finite
 * number gets the DEFAULT; a finite one is floored into `[1, max]`.
 */
export function clampPageLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(1, Math.floor(limit)), max);
}

export function clampLimit(limit: number | undefined): number {
  return clampPageLimit(limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
}
