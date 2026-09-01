import { ServiceError } from "./errors.js";

/**
 * Opaque list cursors (contract §1.5) — independent from the `/sync` seq cursor.
 *
 * TWO WIRE SHAPES, and saying so is load-bearing rather than pedantic. Most encoders write the
 * last entity ID and page by `id`; four — `MessageService`, `ScreenerService`,
 * `PrivacyService.listTrackerEvents` and `WorkflowsService.listRuns` — write
 * `` `${millis}:${uuid}` `` because they order by (date, id). The triage keyset writes a bare
 * uuid despite its (date, id) intent, so it is in the first family.
 *
 * This header used to describe only the first shape, as a universal rule. A validator written
 * from it accepted uuids alone and would have turned the second page of those four routes into a
 * 400 — measured, not hypothesised, and caught by the suite rather than by reading.
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
 * THE TWO SHAPES A LIST CURSOR DECODES TO, and there really are two.
 *
 * ── THREE VERSIONS, AND THE TWO WRONG ONES ARE THE ARGUMENT FOR THIS ONE ─────────────────
 *
 * The first accepted a bare uuid only, on the reading that *"a list cursor encodes the last entity
 * id returned"* — which is what this module's header used to say, and is true of most encoders and
 * FALSE of four: `MessageService`, `ScreenerService`, `PrivacyService.listTrackerEvents` and
 * `WorkflowsService.listRuns` encode `` `${millis}:${uuid}` `` because they order by (date, id).
 * It would have made the second page of those four a 400.
 *
 * The second accepted BOTH shapes in ONE grammar, which is the opposite mistake: each shape became
 * valid on the other's routes, so a keyset cursor sent to `/contacts` bound `"1712…:<uuid>"`
 * against a uuid column — the 22P02 this validator exists to stop, reintroduced by the validator
 * being too generous.
 *
 * So there are TWO decoders and no shared grammar: {@link decodeListCursor} takes the bare id and
 * refuses the tuple, {@link decodeKeysetCursor} takes the tuple and refuses the bare id, and each
 * route family calls the one that issued its cursors.
 *
 * ── AND THE TIMESTAMP MAY BE NEGATIVE ────────────────────────────────────────────────────
 *
 * `messages.date` is the sender's own `Date:` header and it constrains nothing. A message dated
 * before 1970 — ordinary in imported archives — gives `getTime()` a negative value and the
 * encoder writes `-<millis>:<uuid>`; a header like `Date: Fri, 1 Jan 50000 …`, which the parser
 * accepts and `timestamptz` stores, gives a SIXTEEN-digit one. Both were refused by earlier
 * versions of this grammar, and both are cursors page one hands out and page two rejects — the
 * worst way to be wrong, because the product produced the value it refuses.
 *
 * The digit ceiling is therefore `Date`'s own range: signed milliseconds through ±8.64e15, which
 * is sixteen digits. Not "a plausible timestamp" — the range of the function that produced it.
 *
 * Both were caught by review rather than by reading, which is the argument for writing a
 * validator against the ENCODERS instead of against the header comment.
 */
const CURSOR_UUID = new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i");
const CURSOR_KEYSET = new RegExp(
  "^(-?\\d{1,16}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$", "i",
);
/**
 * THE THIRD SHAPE: a keyset whose SORT KEY IS NULL — `null:<uuid>`.
 *
 * `messages.date` is the sender's own header and is nullable, so the (date, id) walk over it has a
 * position the numeric tuple cannot express. Encoding that position as epoch `0` — which is what
 * {@link encodeListCursor}'s callers used to do — is not a near-miss, it is a DIFFERENT position:
 * the list orders `date desc nulls last`, so a null row sorts AFTER every dated one, while epoch 0
 * sorts among the 1970 mail. The page after an undated row therefore asked for rows older than
 * 1970-01-01 and the undated tail — which is strictly after that point — was unreachable for ever.
 * a null sort key the cursor grammar could not express.
 *
 * It is spelled `null` rather than given a punctuation sentinel because a cursor is decoded by
 * hand when a page misbehaves, and `null:<uuid>` says what it is. 4 + 1 + 36 = 41 characters, well
 * inside {@link LIST_CURSOR_MAX_CHARS}.
 *
 * **{@link decodeKeysetCursor} still REFUSES it**, and that is the point of two decoders rather
 * than one generous grammar: `PrivacyService.listTrackerEvents` and `WorkflowsService.listRuns`
 * page on `detected_at`/`created_at`, both `notNull`, so a null sort key is not a position their
 * lists have. Accepting it there would build `is null` predicates that silently match nothing.
 */
const CURSOR_NULL_KEYSET = new RegExp(
  "^null:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$", "i",
);

/**
 * THE RANGE THE SINK ACCEPTS, WHICH IS NOT THE RANGE THE PRODUCER CAN EMIT.
 *
 * A DIGIT COUNT is neither: it admits `9999999999999999`, which is sixteen digits and is not a
 * time, and which reaches `timestamptz` as an out-of-range cast. So the grammar checks the
 * number — and the number it has to check against is the COLUMN's range, not `Date`'s.
 *
 * `Date#getTime()` spans ±8.64e15 ms (years 271821 BC to 275760 AD). PostgreSQL's `timestamptz`
 * spans 4713 BC to 294276 AD. The two overlap but they are not the same interval, and the
 * asymmetry is the whole finding: the upper end of `Date`'s range is INSIDE the column's, so
 * `MAX_EPOCH_MS` is safe as written — but the lower end is not. `-8640000000000000:<uuid>`, a
 * cursor an authenticated caller can simply write, passed a `Date`-derived check and reached
 * PostgreSQL as a timestamp before 4713 BC: a 500 for a bad query string, which is the exact
 * failure `decodeListCursor` exists to stop, reintroduced by validating against the wrong end.
 *
 * A bound checked against the producer's type instead of the sink's is this slice's own mistake
 * one level of abstraction up, and it is worth naming: "what can this value be" is not the
 * question — "what will accept it" is.
 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;
/** PostgreSQL's `timestamptz` floor, 4713-01-01 BC, in milliseconds from the epoch. */
const MIN_EPOCH_MS = -210_866_803_200_000;

/**
 * Decode an opaque list cursor, or refuse it.
 *
 * ── WHY THIS VALIDATES AT ALL ────────────────────────────────────────────────────────────
 *
 * It used to be `Buffer.from(cursor, "base64url").toString("utf8")` and nothing else, and node's
 * base64 decoder never throws — it discards what it cannot read. So `?cursor=eA` decoded to the
 * string `"x"`, which every caller binds straight against a `uuid` column: Postgres answers
 * 22P02 and the request is a **500 for a plainly bad query string**, reachable on every
 * keyset-paginated route this product has. That is the same defect `MessageService.getBodies`
 * already refuses for its `ids` and `SearchService` for its date filters, in the one place all of
 * them share.
 *
 * And the LENGTH is checked before the decode, because an unbounded cursor is an unbounded decode
 * — the `identifier` disposition in the input-bounds census claimed a shape check that did not
 * exist, which is how this was found.
 *
 * The shape is this decoder's own — the bare id — and {@link decodeKeysetCursor} has the other.
 *
 * A 400, not a 410: a malformed cursor is a bad request, and telling a client its page has moved
 * on would send it looping.
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
 * A NULLABLE keyset cursor: `(millis | null, id)` for a route ordered by
 * `<nullable date> desc nulls last, id desc`.
 *
 * The numeric half is {@link decodeKeysetCursor}'s exactly — same grammar, same epoch range, same
 * reasons — and the addition is the `null:` position described at {@link CURSOR_NULL_KEYSET}.
 * Only `MessageService` issues these, because only its sort column is nullable.
 *
 * A cursor minted before this shape existed encodes an undated row as `0:<uuid>` and still
 * decodes; it resumes at the 1970 boundary as it always did and the client is back on a correct
 * cursor after one page. Cursors are ephemeral, so there is no migration to write.
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
 * The page ceiling, TOTAL over every double the wire can carry.
 *
 * ── WHY THE ARITHMETIC IS NOT ENOUGH, MEASURED ────────────────────────────────────────────
 *
 * This used to be `Math.min(Math.max(1, limit ?? DEFAULT), MAX)`, which is correct for every
 * number and wrong for the two values that are not numbers in the arithmetic sense. Every
 * caller reaches it from `Number(url.searchParams.get("limit"))`, so the caller chooses the
 * double:
 *
 *  · `?limit=abc` ⇒ `NaN`. `??` does not fire (NaN is not nullish), `Math.max(1, NaN)` is NaN,
 *    `Math.min(NaN, 200)` is NaN — and **drizzle-orm omits the `limit` clause entirely for a
 *    falsy value**, so the query it builds is `select … from …` with NO CEILING. Verified
 *    against drizzle 0.36.4: `.limit(NaN).toSQL()` returns `{sql: 'select "id" from "t"',
 *    params: []}` while `.limit(200)` returns `… limit $1`. It is a query-BUILDER fact, so it
 *    holds identically for an in-process PGlite and for a Postgres server. `?limit=-1e999`
 *    (`-Infinity`) is the same shape.
 *  · `?limit=1.5` ⇒ a fractional param reaches Postgres and raises
 *    `invalid input syntax for type bigint`, a 500 for a plainly bad request. `?limit=1e999`
 *    (`Infinity`) raises the same.
 *
 * The unbounded arm is the one that matters. Every caller then does `rows.slice(0, limit)`,
 * and `slice(0, NaN)` is EMPTY — so the database is asked for the account's entire table, the
 * rows are materialized in the process, and the response is a page of nothing. `getBodies`
 * is the sharp case: its `BODIES_BYTE_BUDGET` is consulted inside that empty loop, so the one
 * guard written to bound that response never runs while the bytes it exists to bound have
 * already been fetched.
 *
 * So the clamp is total: anything that is not a finite number is the DEFAULT (the same answer
 * an absent `limit` gets — the caller named no usable page size), and a finite one is floored
 * into `[1, max]` before it can reach a `bigint` parameter.
 */
export function clampPageLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(1, Math.floor(limit)), max);
}

export function clampLimit(limit: number | undefined): number {
  return clampPageLimit(limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
}
