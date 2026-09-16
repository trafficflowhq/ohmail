import { sql, type SQL } from "drizzle-orm";
import { attachments, messageBodies } from "./schema-mail.js";
import { SQL_TRIM_BLANK, type Dialect } from "./dialect/index.js";

/**
 * The two calendar facts a message row cannot answer for itself, stated once in SQL so the DTO
 * batch and any later reader cannot drift. `packages/core/src/mime.ts` holds the TS half
 * (`invitationWithoutEvent`, `itipReplyByHeaders`) and `calendar-facts-parity.test.ts` asserts the
 * two agree row by row — the same two-engines-one-definition shape `autoReplyByUsWhere` uses.
 *
 * Both read only what ingest already stored: `message_bodies.headers` (kept even when a body is
 * husked) and `attachments.content_type`. Neither needs the .ics bytes, which are never persisted.
 */

/** A header value folded for comparison: lowercased and stripped of the blanks `trim()` strips. */
function folded(d: Dialect, text: SQL): SQL {
  return sql`lower(trim(${text}, ${SQL_TRIM_BLANK}))`;
}

/**
 * The elements of the string array at one header name, or none. Mirrors the TS half's
 * `headerValues`: a name that is absent, or whose value is not an array, contributes nothing.
 */
function headerElements(d: Dialect, messageId: SQL, name: string, alias: string) {
  const doc = sql`(select mb.headers from ${messageBodies} mb where mb.message_id = ${messageId})`;
  return d.jsonArrayElements(
    sql`case when ${d.jsonIsArray(d.jsonGet(doc, name))}
              then ${d.jsonGet(doc, name)} else ${d.castJsonb(sql`'[]'`)} end`,
    alias,
  );
}

/**
 * Does this Content-Type value carry a `method=` PARAMETER — RFC 6047's iTIP marker.
 *
 * Spaces and tabs are squeezed out and the match is anchored on the `;` that introduces a
 * parameter, so a parameter merely ENDING in "method" (`;x-method=`) does not match — which is
 * what keeps the over-match direction, a wrong sentence on a reader's screen, shut. No regex:
 * `~*` has no device-store equivalent.
 */
function hasMethodParam(d: Dialect, value: SQL, needle: string): SQL {
  // The two blanks bound as PARAMETERS: `chr(9)` is Postgres-only (the device store spells it
  // `char(9)`), and a literal tab inside the SQL text would not survive every formatter.
  const squeezed = sql`replace(replace(lower(${value}), ${" "}, ${""}), ${"\t"}, ${""})`;
  return sql`${d.strpos(squeezed, sql`${needle}`)} > 0`;
}

/** The base media type of a stored `content_type`, folded — everything before the first `;`. */
function baseType(d: Dialect, value: SQL): SQL {
  const cut = sql`case when ${d.strpos(value, sql`';'`)} > 0
                       then ${d.substr(value, sql`1`, sql`${d.strpos(value, sql`';'`)} - 1`)}
                       else ${value} end`;
  return folded(d, cut);
}

/**
 * IS THIS A MEETING INVITATION WHOSE EVENT WE CANNOT SHOW — the SQL half of
 * `invitationWithoutEvent`. The message SAYS it is a calendar message (Microsoft's
 * `Content-Class`, or a top-level `Content-Type` carrying `method=`) and carries NO calendar part.
 */
export function invitationWithoutEventWhere(d: Dialect, row: { id: SQL }): SQL {
  const cls = headerElements(d, row.id, "content-class", "cc");
  const ct = headerElements(d, row.id, "content-type", "ct");
  const calendarPart = sql`
    exists (select 1 from ${attachments} a
             where a.message_id = ${row.id}
               and ${baseType(d, sql`a.content_type`)} in ('text/calendar', 'application/ics'))`;
  return sql`(
    (
      exists (select 1 from ${cls.from}
               where ${cls.isString}
                 and ${folded(d, cls.text)} = 'urn:content-classes:calendarmessage')
      or exists (select 1 from ${ct.from}
                  where ${ct.isString} and (${hasMethodParam(d, ct.text, ";method=")}))
    )
    and not ${calendarPart}
  )`;
}

/**
 * DOES THIS MESSAGE'S TOP-LEVEL Content-Type DECLARE `method=REPLY` — the SQL half of
 * `itipReplyByHeaders`, and one of the two arms of the list's acknowledgement test. The other arm
 * is the subject, which the client already holds and composes itself.
 */
export function itipReplyHeaderWhere(d: Dialect, row: { id: SQL }): SQL {
  const ct = headerElements(d, row.id, "content-type", "ct");
  return sql`exists (select 1 from ${ct.from}
                      where ${ct.isString} and (${hasMethodParam(d, ct.text, ";method=reply")}))`;
}
