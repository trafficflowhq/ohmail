import { sql, type SQL } from "drizzle-orm";

/**
 * `@trafficflow/core/sender-headers#SCREENING_AUTH_VERDICTS`, RE-DECLARED: this package does not
 * import core. `screener-press-moves-one-rule.test.ts` (services) pins the two equal, and the census
 * `test/auth-verdict-one-definition.test.ts` refuses a second spelling of the gate's question.
 * It imports nothing from this package, so `screener-apply.ts` and `own-mail.ts` reach it with no cycle.
 */
export const GATE_SCREENING_AUTH_VERDICTS: readonly string[] = ["fail"];

/** Does the gate screen on this stored verdict — the form for a row already read. */
export function storedAuthScreens(auth: string | null | undefined): boolean {
  return auth != null && GATE_SCREENING_AUTH_VERDICTS.includes(auth);
}

/** …and over a stored `auth_verdict` column. NULL (a row older than the column) is not screened. */
export function authScreensSql(auth: SQL): SQL {
  return sql`(coalesce(${auth}, '') in (${sql.join(GATE_SCREENING_AUTH_VERDICTS.map((v) => sql`${v}`), sql`, `)}))`;
}

/**
 * A letter its provider did not confirm: any stored verdict but `pass`, NULL included. Never the
 * gate's question, which only demotes; asked by an automatic act before it decides for a person.
 */
export function unconfirmedSql(auth: SQL): SQL {
  return sql`(coalesce(${auth}, '') <> 'pass')`;
}
