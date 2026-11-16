/**
 * WHICH RELATIONS AN ACCOUNT'S INDEX-DRIVEN READS NAME: the row lock's views or the tables.
 *
 * Under the lock a read keeps its index only through leakproof operators, so the search's words,
 * trigrams and lower-cased senders read the account's views (`ohmail.messages`,
 * `ohmail.message_search`, `ohmail.message_search_words`), which answer the bound account's rows to
 * the two runtime logins alone. Every other role reads nothing through them: the migrator, a
 * superuser and a role that bypasses read the tables, and a store without the views (a self-hosted
 * server, a device's store) has only the tables. So the answer is the views exactly where the
 * handle's role is one of the two logins and it may read the three (USAGE on their schema, SELECT on
 * each), and the tables for every other handle. A read through a view keeps its own account
 * condition: the view is the second lock, not the first. A read by id, and every write, stays on
 * the table.
 *
 * THE ANSWER'S SHAPE AND HOW ITS RELATIONS ARE NAMED, AND NOTHING ELSE: no statement, no import,
 * nothing done when it loads, so every store may load it (a device's engine among them). The
 * package's root exports the shape and the tables' answer, which is all a store without the lock
 * reads. The views' answer, and the one catalog read that says which of the two a pool handle
 * reads, are the hosted database's (`row-security/account-road.ts`), exported from
 * `@trafficflow/db/cloud` and never from the root. A shared read is handed its answer by the host
 * that made its pool. The names are held to the lock's list by `account-rows.test.ts`.
 */
export interface AccountRelations {
  /** `views`: the account's views of the row lock; `tables`: the tables themselves. */
  readonly through: "views" | "tables";
  /** The letters: `ohmail.messages`, or `public.messages`. */
  readonly messages: string;
  /** The search documents: `ohmail.message_search`, or `public.message_search`. */
  readonly messageSearch: string;
  /** The search documents as the word reads key them: `ohmail.message_search_words`, or `public.message_search`. */
  readonly messageSearchWords: string;
}

/** The tables: every handle but a runtime login's over the readable views. */
export const ACCOUNT_TABLES: AccountRelations = {
  through: "tables", messages: "public.messages", messageSearch: "public.message_search", messageSearchWords: "public.message_search",
};

/**
 * The views' answer, named in the lock's schema `schema`. A function, called once by the hosted half
 * (`ACCOUNT_VIEW_RELATIONS`): a bundle in which nothing calls it carries none of it.
 */
export function accountViewRelations(schema: string): AccountRelations {
  return {
    through: "views", messages: `${schema}.messages`, messageSearch: `${schema}.message_search`,
    messageSearchWords: `${schema}.message_search_words`,
  };
}
