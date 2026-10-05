import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Dialect } from "./dialect/index.js";

/**
 * `@trafficflow/core/rule-order#ruleMatchKey`, copied: this package does not import core. A rule's
 * `match` as {@link ruleMatchKeySql} compares it, SPACES only. On this leaf so the learning door
 * keys a sender without importing the decision that imports it. `rule-match-key-twin.test.ts`
 * holds the two equal; `test/rule-match-key-census.test.ts` admits this one copy by name.
 */
export function ruleMatchKey(match: string): string {
  let a = 0;
  let b = match.length;
  while (a < b && match.charCodeAt(a) === 32) a++;
  while (b > a && match.charCodeAt(b - 1) === 32) b--;
  return match.slice(a, b).toLowerCase();
}

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
