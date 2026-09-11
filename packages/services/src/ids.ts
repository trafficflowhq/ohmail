import { ServiceError } from "./errors.js";

/**
 * Identifier shapes, checked before they reach a column. Three services carried their own
 * `UUID_RE` and applied it to SOME inputs: five query parameters reached a `uuid` predicate
 * unchecked — Postgres answered 22P02, a 500 for a plainly bad query string. The check is what
 * makes an identifier's SIZE stop mattering (the input census records these as `identifier`). The
 * query half was the small half: every PATH parameter (~78 patterns) had the same defect, not
 * solved by callers remembering `requireUuid` — one route imported the symbol for a body field
 * while its own `:id` went unchecked. Solved in ONE place: `createApp.handle` refuses any path
 * parameter failing {@link isUuid}, unless named in `opaqueParams`. The door owns the path.
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
