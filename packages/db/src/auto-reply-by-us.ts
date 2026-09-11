import { sql, type SQL } from "drizzle-orm";
import { awayReplies, mailboxes, messageBodies } from "./schema-mail.js";
import { SQL_TRIM_BLANK, type Dialect } from "./dialect/index.js";

/**
 * IS THIS ROW A REPLY THE AWAY RESPONDER SENT ON OUR BEHALF — the predicate, stated ONCE, in SQL.
 *
 * Three programs ask it and they must agree, because they are three halves of one rule: an
 * automatic reply is not the person's engagement. `ohbox-tidy.ts` and `rule-retro.ts` ask it to
 * decide whether an own-address message in a thread means "they replied, hands off"; the DTO
 * batch (`materialize.ts`) asks it to set `MessageDTO.autoReplyByUs`, which is how the client
 * knows without ever seeing a header. Three hand-written copies would drift, and the drift is
 * invisible: each one is a coherent query that returns rows.
 *
 * ── WHY IT IS A WHERE-FRAGMENT AND NOT A FUNCTION OVER A ROW ────────────────────────────────
 *
 * `junk-sweep.ts`'s pattern, for its reason: the callers' JOINs differ (the tidy asks it of an
 * ALIASED `messages sent` inside a `NOT EXISTS`, the DTO batch asks it of a set of ids), so the
 * join belongs to the caller and only the predicate is shared. Every column the predicate reads
 * arrives as a fragment, which is what lets one definition serve an alias and a table alike.
 *
 * ── THE TWO ARMS, AND WHY BOTH CARRY POPULATION ─────────────────────────────────────────────
 *
 *   1. THE LEDGER. `away_replies.minted_message_id` is the `<uuid@domain>` the responder minted
 *      for the reply (`away-responder-pass.ts`, `mintMessageId`), so a Sent copy bearing it IS
 *      that reply — an identity, not a heuristic.
 *   2. THE HEADER BELT. An auto-reply this deployment did not send has no ledger row: replies
 *      from before `away_replies` existed (migration 0051's `away_responder_sent`), and replies
 *      another client of the same account sent. Neither arm is decorative — a live mailbox holds
 *      rows only the ledger recognises AND rows only the headers do, so dropping either one
 *      leaves messages that are plainly auto-replies looking like the person's own.
 *
 * ── THE TRIM IS ON THE LEDGER SIDE, AND THAT IS DELIBERATE ──────────────────────────────────
 *
 * Spelled `trim(col, '<>')` rather than `btrim(col, '<>')`: the two are the same function on the
 * server — it resolves the two-argument `trim` to `btrim` — and `btrim` does not exist on the
 * device store at all, so the server's name would have taken every DTO read down there.
 *
 * The two columns store the same id in two shapes: `minted_message_id` keeps the RFC 5322 angle
 * brackets (the send path searches the Sent folder for that exact header, so the stored form has
 * to be the header's form), while ingest strips them before writing `messages.message_id_header`.
 * An `=` between them therefore matches NOTHING — not "rarely", but never, for every row the
 * responder has ever sent. That is the whole reason this function exists rather than an inline
 * `=`, and it is why the parity test asserts the bare `=` answers false on a row the trim
 * correlates: without that control the predicate would be dead code with every gate green.
 *
 * The trim is on the LEDGER side only, so `messages.message_id_header` stays untransformed and
 * usable by an index — sound because the bracketed form is written by the SEND path and the bare
 * form by INGEST, and this join only ever looks at our own sent mail. Should ingest ever start
 * keeping the brackets, such a row falls through the ledger arm and the header belt still catches
 * it, because the responder always sets `Auto-Submitted`.
 *
 * ── AND WHY THE OWN-ADDRESS TEST IS INSIDE THE PREDICATE ────────────────────────────────────
 *
 * "By us" is half the claim. An inbound out-of-office from a stranger carries exactly the same
 * `Auto-Submitted: auto-replied` marker, and a flag that answered true for it would be a lie on
 * the wire that the 0.16 mark would then draw. The tidy and retro subqueries already bound their
 * candidates to the account's own addresses, so the test is redundant THERE — kept anyway,
 * because a predicate that depends on its caller having asked half the question is the drift
 * this file exists to prevent.
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
 * THE HEADER ARMS OF `isMachineSent`, AS SQL — and the TS is the other half of one contract.
 *
 * `hasMachineSentHeaders` (`packages/services/src/consent-seed.ts`) is the same three arms in
 * TypeScript, and `auto-reply-by-us-parity.test.ts` asserts the two agree row
 * by row over a fixture table of header shapes. Neither is the definition; the pair is, and the
 * test is what makes that true rather than claimed.
 *
 * Three arms, matching the TS one for one:
 *
 *   · `auto-submitted` present with any value that is not `no` — RFC 3834's marker. Presence
 *     alone is the wrong test: `Auto-Submitted: no` is how a human-written message says so.
 *   · `precedence` matching `bulk`/`autoreply`/`auto_reply`/`junk`/`list`.
 *   · `x-auto-response-suppress` present at all (Exchange's marker; any value means the sender is
 *     a machine asking not to be answered).
 *
 * ── THE TWO PLACES A NAIVE TRANSLATION DIVERGES FROM THE TS ─────────────────────────────────
 *
 *   1. NON-STRING MEMBERS. The TS filters the array to strings before testing
 *      (`v.filter((x) => typeof x === "string")`), so `["auto-submitted": [5]]` is NOT machine-
 *      sent. A text-flattening element reader would render that `5` as `'5'`, which is not `no`,
 *      and the arm would fire. Hence the seam's element relation plus its explicit `isString` —
 *      the filter, not a coincidence.
 *   2. THE TRIM. The TS is `!/^no$/i.test(v.trim())`. Stripping SPACES only would diverge on a
 *      tab-padded ` no`, so the set trimmed is {@link SQL_TRIM_BLANK} — the ASCII whitespace set
 *      `String.prototype.trim` strips, which is what the parity test pins.
 *
 * NAMED RESIDUAL, not parity: `trim()` also strips Unicode whitespace (U+00A0 and friends) and
 * this set does not, so `Auto-Submitted: <NBSP>no<NBSP>` is `no` to the TS and a marker to the
 * SQL. No mail system produces that shape; it is written down here and pinned as a known
 * divergence in the parity test rather than left as a silent hole in a claim of agreement.
 *
 * A JSON value that is not an array — or a key that is absent — yields the empty array, which is
 * the TS's `[]` for the same two cases.
 *
 * ── AND WHY THERE IS NO REGULAR EXPRESSION LEFT ─────────────────────────────────────────────
 *
 * This was `!~*` and `~*` — Postgres regex operators the device store has no equivalent for at
 * all, so a DTO read there answered a syntax error rather than a wrong flag. Both are rewritten
 * to the SAME question in constructs both stores have, and the pair is pinned value by value:
 * `^[[:space:]]*no[[:space:]]*$` is `lower(trim(v)) = 'no'`, and the `bulk|auto_?reply|junk|list`
 * alternation is five substring searches through the seam's `strpos` — where `auto_?reply` is the
 * two literals it can match, because `_` is a LIKE wildcard and `autoxreply` must stay out.
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
