import { ServiceError } from "./errors.js";

/**
 * IDENTIFIER SHAPES, CHECKED BEFORE THEY REACH A COLUMN.
 *
 * ── WHY THIS IS A MODULE AND NOT THREE PRIVATE COPIES ────────────────────────────────────────
 *
 * `MessageService`, `ScreenerService` and `routes/consent.ts` each carried their own `UUID_RE`
 * and each applied it to some of their inputs. That is the shape of a rule that holds where
 * somebody remembered it: `GET /messages?view=folder&folderId=…`,
 * `GET /workflow-runs?workflowId=…`, `GET /img?mid=…`, `GET /screener/junk/body?mailboxId=…` and
 * the sync snapshot cursor's `i` all reached a `uuid` predicate with no shape test at all.
 * Postgres answers 22P02 to a malformed one, `withErrorEnvelope` has nothing to map it to, and
 * the caller gets a **500 for a plainly bad query string** — on five routes.
 *
 * It is a bounds question as much as a correctness one, which is why it belongs to this slice:
 * whether a string is a uuid is decidable without the database, so checking costs nothing and
 * leaks nothing, and the check is what makes an identifier's SIZE stop mattering. The input
 * census records these parameters as `identifier`, a disposition whose whole content is "the
 * shape test is the bound" — and that claim was false for five of them until this existed.
 *
 * ── "FIVE ROUTES" WAS THE QUERY-STRING HALF ONLY, AND THE OTHER HALF WAS BIGGER ──────────────
 *
 * Every route named above reaches its uuid through a QUERY parameter, and for a long time this
 * header read as though naming them closed the subject. It did not. The same defect lived on every
 * PATH parameter in the table — `matchRoute` extracts `:id` as a caller-chosen string and it went
 * into a `uuid` column with no shape test at all — which is roughly 78 patterns, not five. Nearly
 * every by-id route answered `500 internal error` to an id that was merely misspelt, and a client
 * that kept asking kept being told the server was broken.
 *
 * The path half is NOT solved by callers remembering `requireUuid` — that is the arrangement this
 * module's opening paragraph already argues against, and `routes/drafts.ts` demonstrated the cost
 * by importing the symbol for a body field while its own `:id` went unchecked for the route's whole
 * life. It is solved in ONE place instead: `createApp.handle` refuses any path parameter failing
 * {@link isUuid} before a pipeline runs, unless the route names it in `opaqueParams`. So
 * {@link requireUuid} is now for values arriving by query or body, and the door owns the path.
 */

/** The canonical form every `uuid` column in this schema holds. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True iff `v` is a string a `uuid` column can accept. */
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/**
 * `v` as a uuid, or a 400 naming the field.
 *
 * A 400 and not a 404: the two say different things, and a caller that sent nonsense has a
 * different thing to fix from one that named a row belonging to somebody else. Ownership is still
 * decided afterwards, by the account-scoped predicate, exactly as before — this only stops a
 * value that could never name any row from reaching the database at all.
 */
export function requireUuid(v: unknown, field: string): string {
  if (!isUuid(v)) throw new ServiceError("validation_failed", 400, `${field} must be an id`);
  return v;
}

/**
 * The largest value IMAP's `UID` and `UIDVALIDITY` may hold.
 *
 * RFC 3501 §2.3.1.1 makes both unsigned 32-bit integers. Nothing enforced that:
 * `GET /screener/junk/body?uid=1e100&uidValidity=…` passed a JavaScript integer check, survived
 * the mailbox lookup and was then written into a FETCH command on a socket to somebody's mail
 * server — a caller-chosen value reaching a socket with no ceiling, which is this class exactly,
 * and an out-of-protocol one at that.
 */
export const IMAP_UINT32_MAX = 4_294_967_295;

/**
 * `v` as an IMAP UID or UIDVALIDITY, or a 400 naming the field.
 *
 * The RANGE is the point, not the integer-ness: a value outside it is not a number the protocol
 * can carry, so sending it is asking somebody else's server to parse nonsense on our behalf.
 */
export function requireImapUint32(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > IMAP_UINT32_MAX) {
    throw new ServiceError(
      "validation_failed", 400,
      `${field} must be an integer between 1 and ${IMAP_UINT32_MAX}`,
    );
  }
  return v;
}
