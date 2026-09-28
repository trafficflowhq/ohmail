import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Dialect } from "./dialect/index.js";

/**
 * A RULE'S `match` IN SQL, keyed as `ruleMatchKey` keys it: spaces trimmed (`trim` strips spaces
 * only, on both stores), then lower case. `rules.match` has no trim constraint, so a padded row
 * exists, and every SQL reader must name the principal the router names. The one spelling:
 * `test/rule-match-key-census.test.ts` refuses a `lower(…match)` or `trim(…match)` anywhere else.
 */
export function ruleMatchKeySql(match: SQL | AnyColumn): SQL {
  return sql`trim(lower(${match}))`;
}

/**
 * Does this `sender`/`domain` rule NAME the author — its key equal to the address, or to the
 * address's domain through {@link Dialect.domainOf}. `sender` is lower-cased by the caller. Any
 * other kind names nobody.
 */
export function ruleNamesSenderSql(
  d: Dialect, rule: { kind: SQL | AnyColumn; match: SQL | AnyColumn }, sender: SQL,
): SQL {
  const key = ruleMatchKeySql(rule.match);
  return sql`((${rule.kind} = 'sender' and ${key} = ${sender})
    or (${rule.kind} = 'domain' and ${key} = ${d.domainOf(sender)}))`;
}
