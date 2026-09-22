import { sql, type SQL } from "drizzle-orm";
import { messageBodies, messages } from "./schema-mail.js";
import { autoReplyByUsWhere } from "./auto-reply-by-us.js";
import type { Dialect } from "./dialect/index.js";

/**
 * DID THE PERSON ANSWER THIS SENDER — the one predicate, stated once in SQL.
 *
 * `ohbox-tidy`, `rule-retro` and `screener-auto` each leave a message alone when the person has
 * already dealt with it, and each carried its own spelling of "we replied". All three asked
 * thread MEMBERSHIP: any message of ours anywhere in the thread. A thread the account was copied
 * on and never answered satisfied that — we wrote to Alice, Alice's colleague joined and wrote
 * in, and their mail was excluded from every pass for ever by a reply that was never to them.
 * `sender-headers.ts#counterpartyEvidence` already carries the rule this asks: our own message
 * contributes its RECIPIENTS as evidence about who we write to, never the thread it sits in.
 *
 * Three conjuncts, each excluding a shape that is not the person answering: our own outbound in
 * the thread; not the away responder's reply, which is a machine and not them (that arm was
 * missing from `screener-auto` entirely); and ADDRESSED to this message's sender.
 *
 * "Addressed to them" has THREE admitting arms, and dropping any one of them takes protection
 * off a reply somebody really wrote:
 *
 *  · their address is in our `To` or `Cc`;
 *  · our reply's `In-Reply-To`/`References` names a message in this thread THEY wrote. A person
 *    answering a list thread writes to the list, not to the author, so the recipient arm alone
 *    would stop protecting every sender on every list conversation they take part in. The
 *    reference headers survive whoever the reply was addressed to — and they are OUR OWN
 *    writing about our own act, not a stranger's claim, which is what makes them admissible
 *    here at all (`sender-headers.ts` carries that rule);
 *  · we recorded no recipients at all. `to_addresses`/`cc_addresses` were columns before any
 *    ingest wrote them (`sender-name-backfill.ts`), so an older Sent row can hold `[]` — which
 *    means "we never recorded who this was addressed to", not "it was addressed to somebody
 *    else". Reading the two as one would drop the protection off a genuine reply on every
 *    account whose backfill has not run, and these passes MOVE mail. Unknown keeps the exclusion.
 */
export function weAnsweredThisSenderWhere(d: Dialect, row: {
  /** The candidate's `account_id` — scopes the thread and the own-address lookup. */
  accountId: SQL;
  /** The candidate's `thread_id`. A NULL thread has nobody in it: the predicate is false. */
  threadId: SQL;
  /** The candidate's `from_address` — the person this asks whether we answered. */
  fromAddress: SQL;
  /**
   * Every address this account sends from, lower-cased. Read once by the caller rather than
   * sub-selected, so the candidate query stays one indexable statement — the reason each pass
   * loads it at the top of its own walk. EMPTY answers FALSE: an account we cannot name has
   * written nothing, and that is the same admitting direction the absent clause used to take.
   */
  ownAddresses: readonly string[];
}): SQL {
  if (row.ownAddresses.length === 0) return sql`false`;
  const own = sql`(${sql.join(row.ownAddresses.map((a) => sql`${a}`), sql`, `)})`;
  const to = d.jsonArrayElements(sql`sent.to_addresses`, "wa_to");
  const cc = d.jsonArrayElements(sql`sent.cc_addresses`, "wa_cc");
  const empty = d.castJsonb(sql`'[]'`);
  return sql`exists (
    select 1 from ${messages} sent
     where sent.account_id = ${row.accountId}
       and sent.thread_id = ${row.threadId}
       and ${row.threadId} is not null
       and lower(sent.from_address) in ${own}
       and not ${autoReplyByUsWhere(d, {
         accountId: sql`sent.account_id`,
         id: sql`sent.id`,
         fromAddress: sql`sent.from_address`,
         messageIdHeader: sql`sent.message_id_header`,
       })}
       and (
         exists (
           select 1 from ${to.from}
            where lower(${to.value}->>'address') = lower(${row.fromAddress})
         )
         or exists (
           select 1 from ${cc.from}
            where lower(${cc.value}->>'address') = lower(${row.fromAddress})
         )
         or ${answersAMessageOfTheirsWhere(d, {
           accountId: row.accountId, threadId: row.threadId, fromAddress: row.fromAddress,
         })}
         or (sent.to_addresses = ${empty} and sent.cc_addresses = ${empty})
       )
  )`;
}

/**
 * Does the reply we sent NAME a message this sender wrote — `In-Reply-To`/`References` against
 * the `message_id_header` of a message of theirs in the same thread.
 *
 * The candidate itself is one such message, so its own id is covered without a second arm. Ingest
 * strips the RFC 5322 angle brackets from `message_id_header` and the reference headers keep
 * them, so the needle puts them back: a bare containment test would match any id this one is a
 * suffix of. No regex — the device store has none, which is the rule `auto-reply-by-us.ts` states.
 */
function answersAMessageOfTheirsWhere(d: Dialect, row: {
  accountId: SQL; threadId: SQL; fromAddress: SQL;
}): SQL {
  const refs = (name: string) => d.jsonArrayElements(
    sql`case when ${d.jsonIsArray(d.jsonGet(sql`mb.headers`, name))}
              then ${d.jsonGet(sql`mb.headers`, name)} else ${d.castJsonb(sql`'[]'`)} end`,
    // One alias for both: each sits in its own `exists`, which is where it resolves.
    "wa_h",
  );
  const namesOneOfTheirs = (h: ReturnType<Dialect["jsonArrayElements"]>): SQL => sql`
    exists (select 1 from ${h.from}
             where ${h.isString}
               and exists (
                 select 1 from ${messages} theirs
                  where theirs.account_id = ${row.accountId}
                    and theirs.thread_id = ${row.threadId}
                    and theirs.message_id_header is not null
                    and theirs.message_id_header <> ''
                    and lower(theirs.from_address) = lower(${row.fromAddress})
                    and ${d.strpos(h.text, sql`'<' || theirs.message_id_header || '>'`)} > 0
               ))`;
  return sql`exists (
    select 1 from ${messageBodies} mb
     where mb.message_id = sent.id
       and (${namesOneOfTheirs(refs("in-reply-to"))} or ${namesOneOfTheirs(refs("references"))})
  )`;
}
