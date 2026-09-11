import { sql, type SQL } from "drizzle-orm";
import { awayReplies, mailboxes, messageBodies } from "./schema-mail.js";
import { SQL_TRIM_BLANK, type Dialect } from "./dialect/index.js";

/**
 * Is this row a reply the away responder sent on our behalf — the predicate, stated once in SQL:
 * the tidy, rule retro and the DTO batch (`MessageDTO.autoReplyByUs`) must agree. A
 * WHERE-fragment, since the callers' JOINs differ. Two arms, both carrying population: the LEDGER
 * (`away_replies.minted_message_id`) and the HEADER BELT (replies the ledger cannot know) —
 * dropping either leaves plain auto-replies looking like the person's own. The trim is on the
 * LEDGER side: `minted_message_id` keeps RFC 5322 angle brackets, ingest strips them, so a bare
 * `=` matches nothing; the parity test pins that. `trim(col, '<>')`, not `btrim` — the device
 * store has no `btrim`. The own-address test is INSIDE the predicate.
 */
export function autoReplyByUsWhere(d: Dialect, row: {
  /** The row's `account_id` — scopes both the ledger and the own-address lookup. */
  accountId: SQL;
  /** The row's `id`, for the body join the header belt needs. */
  id: SQL;
  /** The row's `from_address`. Compared lowercased, as every own-address test here is. */
  fromAddress: SQL;
  /** The row's `message_id_header`. NULL never correlates, which is correct: no id, no identity. */
  messageIdHeader: SQL;
}): SQL {
  return sql`(
    lower(${row.fromAddress}) in (
      select lower(mx.address) from ${mailboxes} mx where mx.account_id = ${row.accountId}
    )
    and (
      exists (
        select 1 from ${awayReplies} ar
         where ar.account_id = ${row.accountId}
           and ar.minted_message_id is not null
           and trim(ar.minted_message_id, '<>') = ${row.messageIdHeader}
      )
      or exists (
        select 1 from ${messageBodies} mb
         where mb.message_id = ${row.id}
           and (${machineSentHeadersWhere(d, sql`mb.headers`)})
      )
    )
  )`;
}

/**
 * The header arms of `isMachineSent` in SQL; `hasMachineSentHeaders` (services `consent-seed.ts`)
 * is the TS half, and `auto-reply-by-us-parity.test.ts` asserts they agree row by row. Three
 * arms: `auto-submitted` with any value other than `no`; `precedence` in
 * bulk/autoreply/auto_reply/junk/list; `x-auto-response-suppress` present at all. Two traps:
 * non-string members (the TS filters to strings — hence the seam's `isString`) and the trim
 * ({@link SQL_TRIM_BLANK} is the set `String.prototype.trim` strips). Residual: `trim()` also
 * strips Unicode whitespace, this set does not — pinned in the parity test. No regex (`~*` has no
 * device-store equivalent); `auto_?reply` is its two literals, `_` being a LIKE wildcard.
 */
function machineSentHeadersWhere(d: Dialect, headers: SQL): SQL {
  /* The array at one header name, or the empty array — the seam's element relation over it, so
     the element's type test and its text come from the store that produced it. */
  const members = (name: string) => d.jsonArrayElements(
    sql`case when ${d.jsonIsArray(d.jsonGet(headers, name))}
              then ${d.jsonGet(headers, name)} else ${d.castJsonb(sql`'[]'`)} end`,
    // ONE alias for all three, because each sits in its own `exists` subquery and resolves there.
    // It is also the shape `test/auto-reply-engagement-census.test.ts` reads the header names out
    // of — a second argument here makes that census see none of them and report zero asked.
    "e",
  );
  const submitted = members("auto-submitted");
  const precedence = members("precedence");
  const suppress = members("x-auto-response-suppress");
  /** Lowercased and trimmed of the blanks `String.prototype.trim` strips. See residual above. */
  const folded = (text: SQL): SQL => sql`lower(trim(${text}, ${SQL_TRIM_BLANK}))`;
  const holds = (text: SQL, needle: string): SQL => sql`${d.strpos(text, sql`${needle}`)} > 0`;
  return sql`
    exists (select 1 from ${submitted.from}
             where ${submitted.isString} and ${folded(submitted.text)} <> 'no')
    or exists (select 1 from ${precedence.from}
                where ${precedence.isString}
                  and (${sql.join(
    ["bulk", "autoreply", "auto_reply", "junk", "list"].map((n) => holds(folded(precedence.text), n)),
    sql` or `,
  )}))
    or exists (select 1 from ${suppress.from} where ${suppress.isString})
  `;
}
