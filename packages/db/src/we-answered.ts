import { sql, type SQL } from "drizzle-orm";
import { messageBodies, messages } from "./schema-mail.js";
import { autoReplyByUsWhere } from "./auto-reply-by-us.js";
import type { Dialect } from "./dialect/index.js";

/**
 * DID THE PERSON ANSWER THIS SENDER — the one predicate, stated once in SQL.
 *
 * `ohbox-tidy`, `rule-retro` and `screener-auto` each spelled it and each asked thread
 * MEMBERSHIP: any own-address message anywhere in the thread. So a colleague who joined a
 * conversation we were part of was excluded from all three for ever, by a reply that was never to
 * them. Three conjuncts: our own outbound in this thread; not the away responder's, which is a
 * machine and not them; and ADDRESSED to this message's sender, which has its own three arms at
 * the site below — each keeps protection somebody would otherwise lose.
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
  /* THE THREE ARMS OF "ADDRESSED TO THEM", in the order they appear below. Their address in our
     To/Cc. Our reply NAMING a message they wrote, because a person answering a list writes to the
     list and not to the author. And a Sent row whose recipients were never recorded — the columns
     predate the ingest writing them and `sender-name-backfill` is what fills them — where UNKNOWN
     keeps the exclusion rather than reading as "addressed to somebody else" on every account whose
     backfill has not run. These passes MOVE mail; the permissive reading is the recoverable one. */
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
