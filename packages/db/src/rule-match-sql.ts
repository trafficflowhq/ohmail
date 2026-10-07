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
 * `@trafficflow/core/rule-order#SHARED_PROVIDER_DOMAINS`, copied for {@link ruleMatchKey}'s reason:
 * domains where anyone can register an address. `rule-match-sql.test.ts` holds the two equal.
 */
export const SHARED_PROVIDER_DOMAINS: readonly string[] = [
  "gmail.com", "googlemail.com",
  "outlook.com", "outlook.de", "outlook.fr", "outlook.it", "outlook.es", "outlook.at", "outlook.be",
  "hotmail.com", "hotmail.co.uk", "hotmail.de", "hotmail.fr", "hotmail.it", "hotmail.es", "hotmail.ch",
  "live.com", "live.co.uk", "live.de", "live.fr", "live.it", "live.nl", "live.at", "live.be", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.de", "yahoo.fr", "yahoo.it", "yahoo.es", "yahoo.ca",
  "yahoo.com.au", "ymail.com", "rocketmail.com",
  "gmx.net", "gmx.de", "gmx.ch", "gmx.at", "gmx.com", "gmx.fr", "gmx.co.uk",
  "fastmail.com", "fastmail.fm", "ik.me", "ikmail.com",
  "bluewin.ch", "sunrise.ch", "hispeed.ch", "swissonline.ch", "vtxmail.ch", "bluemail.ch",
  "web.de", "t-online.de", "freenet.de", "mail.com", "posteo.de", "mailbox.org",
  "proton.me", "protonmail.com", "pm.me", "tuta.io", "tuta.com", "tutanota.com", "tutanota.de",
  "zoho.com", "laposte.net", "free.fr", "orange.fr", "wanadoo.fr", "aon.at", "a1.net",
  "vodafonemail.de", "online.de", "arcor.de", "yandex.com", "yandex.ru", "mail.ru", "aol.com",
];
const SHARED = new Set(SHARED_PROVIDER_DOMAINS);

/** The twin of core's `sharedProviderAllowRefusal`: an allow rule for everyone at a shared provider. */
export function sharedProviderAllowRefusal(
  r: { kind: string; match: string; destination: string },
): "shared_provider_domain" | null {
  if (r.kind !== "domain" || !SHARED.has(ruleMatchKey(r.match))) return null;
  return HOLDING.has(r.destination) ? null : "shared_provider_domain";
}

/** Thrown by a rules write door asked for a rule {@link sharedProviderAllowRefusal} refuses. */
export class SharedProviderDomainError extends Error {
  constructor(readonly domain: string) {
    super(`a domain rule letting everyone at ${domain} through is refused — decide per address`);
    this.name = "SharedProviderDomainError";
  }
}

/** The three folders a rule holds mail back in — `effectForDestination`'s deny side. */
const HOLDING = new Set(["ohmail/Screener", "ohmail/Screened", "ohmail/Quarantine"]);

/**
 * Does this `sender`/`domain` rule NAME the author — its key equal to the address, or to the
 * address's domain through {@link Dialect.domainOf}. `sender` is lower-cased by the caller. Any
 * other kind names nobody, and an ALLOW domain rule on a shared provider names nobody either: the
 * router's `namesAuthor` declines it, so every SQL reader declines it too. `destination` is REQUIRED.
 */
export function ruleNamesSenderSql(
  d: Dialect, rule: { kind: SQL | AnyColumn; match: SQL | AnyColumn; destination: SQL | AnyColumn }, sender: SQL,
): SQL {
  const key = ruleMatchKeySql(rule.match);
  const shared = sql.join(SHARED_PROVIDER_DOMAINS.map((x) => sql`${x}`), sql`, `);
  const holding = sql.join([...HOLDING].map((x) => sql`${x}`), sql`, `);
  return sql`((${rule.kind} = 'sender' and ${key} = ${sender})
    or (${rule.kind} = 'domain' and ${key} = ${d.domainOf(sender)}
      and not (${key} in (${shared}) and ${rule.destination} not in (${holding}))))`;
}
