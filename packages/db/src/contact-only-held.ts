import { sql, type SQL } from "drizzle-orm";
import type { Dialect } from "./dialect/index.js";
import { autoReplyByUsWhere } from "./auto-reply-by-us.js";
import { ruleNamesSenderSql } from "./rule-match-sql.js";
import { contacts, messages } from "./schema-mail.js";

/**
 * HELD MAIL FROM A SENDER WHO IS ONLY A CONTACT — the one spelling, for the one-time repair
 * (`apps/worker/src/gate-release.ts`) and the held-release offer (`held-release-service.ts`). No
 * enabled sender/domain rule names the author (a DENY one excludes too: that mail is the
 * Screened-out tab's), a `contacts` row does, and the account did not reply in the thread from its
 * own addresses. The caller brings the gate predicate over `messages` and `folder_state`.
 */
export function contactOnlyHeldWhere(d: Dialect, o: { ownAddresses: readonly string[] }): SQL[] {
  const filters: SQL[] = [
    sql`not exists (
      select 1 from rules rg
       where rg.account_id = ${messages.accountId}
         and rg.enabled
         and rg.kind in ('sender', 'domain')
         and ${ruleNamesSenderSql(d, { kind: sql`rg.kind`, match: sql`rg.match`, destination: sql`rg.destination` }, sql`lower(${messages.fromAddress})`)}
    )`,
    sql`exists (
      select 1 from ${contacts} cg
       where cg.account_id = ${messages.accountId}
         and lower(cg.address) = lower(${messages.fromAddress})
    )`,
  ];
  if (o.ownAddresses.length > 0) {
    // The fifth exclusion, guarded on a non-empty list (`in ()` is a syntax error) and skipped for
    // a NULL `thread_id`; an automatic reply is the one thing here that looks like the person's
    // action and is not.
    filters.push(sql`not exists (
      select 1 from ${messages} sent
       where sent.account_id = ${messages.accountId}
         and sent.thread_id = ${messages.threadId}
         and ${messages.threadId} is not null
         and lower(sent.from_address) in ${sql`(${sql.join(o.ownAddresses.map((a) => sql`${a}`), sql`, `)})`}
         and not ${autoReplyByUsWhere(d, {
           accountId: sql`sent.account_id`,
           id: sql`sent.id`,
           fromAddress: sql`sent.from_address`,
           messageIdHeader: sql`sent.message_id_header`,
         })}
    )`);
  }
  return filters;
}
