/**
 * THE ORDER OVER RULES — one comparator for every door that decides between two rules: the
 * router's `winningRule` and `standingRule` (`rules.ts`) and the client engine's consent index.
 * Two orders were how one sender's rule twins were filed by the server one way and presented by
 * the clients another. Import-free, so a browser, a phone bundle and a Node consumer all load it
 * from source; `listRules` states the same order in SQL and the two must agree literally. The
 * claim lives here too ({@link placingRule}): the router and every client ask it, never a copy.
 */

/** Whether a rule lets the sender through the gate or holds them at it. */
export type RuleEffect = "allow" | "deny";

/**
 * What the order reads. The enum-shaped fields are `string`: they reach every caller through an
 * unvalidated cast (`text` columns, a mirror row), and an unknown value ranks LAST, never NaN.
 */
export interface OrderedRule {
  id: string;
  priority: number;
  effect: string;
  kind: string;
  provenance: string;
  subjectContains?: string | null;
  bodyContains?: string | null;
}

/**
 * A destination's side of the gate — the one mapping, for a caller holding a destination and no
 * `effect`. A string outside the three holding folders is no assertion of denial, so it allows:
 * never a new reason for a rule to win a tie. `rules.ts` types it on `Destination`.
 */
export function effectForDestination(destination: string): RuleEffect {
  switch (destination) {
    case "ohmail/Screener":
    case "ohmail/Screened":
    case "ohmail/Quarantine":
      return "deny";
    default:
      return "allow";
  }
}

/**
 * A sender/domain rule's `match` as every reader compares it: the queue SQL's `trim(lower(match))`,
 * which strips SPACES only on both stores. `rules.match` has no trim constraint, so a padded row
 * exists; the router, the client cutline and the SQL must name one principal for it.
 */
export function ruleMatchKey(match: string): string {
  let a = 0;
  let b = match.length;
  while (a < b && match.charCodeAt(a) === 32) a++;
  while (b > a && match.charCodeAt(b - 1) === 32) b--;
  return match.slice(a, b).toLowerCase();
}

/**
 * SHARED MAIL PROVIDERS — domains where anyone can register an address, so the domain says nothing
 * about who wrote. One set, two readers: the identity fact's ownership (`sender-check.ts#owns`, a
 * shared domain owns no brand) and an ALLOW domain rule, which admits nobody on one. Exact
 * registrable domains, never a pattern: `namesAuthor` compares exact domains. Seven of these are
 * also a brand's own (bluewin.ch, sunrise.ch, t-online.de, orange.fr, a1.net, outlook.com,
 * icloud.com); the brands test pins that overlap by name. `@trafficflow/db` holds a pinned copy.
 */
export const SHARED_PROVIDER_DOMAINS: ReadonlySet<string> = new Set([
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
]);

/** Is `domain` (a registrable domain, any case) one where anyone can register an address? */
export function isSharedProviderDomain(domain: string): boolean {
  return SHARED_PROVIDER_DOMAINS.has(domain.trim().toLowerCase());
}

/** Among rules of one kind, deny outranks allow: the user's "no" never loses a tie. */
const EFFECT_RANK: Readonly<Record<string, number>> = { deny: 0, allow: 1 };
/** Specificity: one mailbox, then a set of them, then a statement about a message. */
const KIND_RANK: Readonly<Record<string, number>> = { sender: 0, domain: 1, header: 2 };
/** What the user typed, then imported, then decided in the Screener, then the onboarding seed. */
const PROVENANCE_RANK: Readonly<Record<string, number>> = {
  manual: 0, migrated: 1, promoted: 2, "seeded-from-sent": 3,
};

/** Unknown ranks last, and an inherited key (`constructor`) is unknown. */
function rank(table: Readonly<Record<string, number>>, value: string): number {
  return Object.prototype.hasOwnProperty.call(table, value) ? table[value]! : Number.MAX_SAFE_INTEGER;
}

/**
 * THE ONE PRIORITY BOUND: a rule's priority is an integer in 0..RULE_PRIORITY_MAX at every door
 * that stores or carries one — `RulesService`, the organizer's request drain (`request-apply.ts`,
 * which holds a pinned copy) and the profile import. A value past it that one door admitted and
 * another refused made the drain drop a whole rule request.
 */
export const RULE_PRIORITY_MAX = 1000;

/**
 * The ceilings on a rule's subject and body terms, mirroring the `rules_subject_contains_nonempty`
 * and `rules_body_contains_nonempty` CHECKs (mail 0050, 0052). `RulesService` turns a violation
 * into a 400 and the profile import skips the rule; both read these, so the two doors agree.
 */
export const MAX_SUBJECT_CONTAINS_CHARS = 200;
export const MAX_BODY_CONTAINS_CHARS = 200;

/** `priority` is `integer NOT NULL`, but a non-finite value would poison the comparator. */
function finitePriority(p: number): number {
  return Number.isFinite(p) ? p : 0;
}

/**
 * THE PRIORITY AN ADDRESS RULE IS WRITTEN AT so no rule on its domain filing elsewhere outranks it:
 * the lowest value at or above `held` that meets every such rule's priority (at equal priority the
 * address wins by kind). `null` when that value would pass {@link RULE_PRIORITY_MAX}: every door
 * refuses it, so the lift declines and the domain rule keeps deciding. Destinations are compared as
 * given — the caller hands them in one spelling. Asked by the engine's write and by the decide.
 */
export function addressPriorityOver(
  domainRules: readonly { priority: number; destination: string }[], destination: string, held: number,
): number | null {
  let need = finitePriority(held);
  for (const r of domainRules) {
    if (r.destination !== destination) need = Math.max(need, finitePriority(r.priority));
  }
  return need > RULE_PRIORITY_MAX ? null : need;
}

/**
 * The whitespace a term is trimmed of — the six characters the SQL CHECK and `ORDER BY` can
 * express (`[^ \t\n\r\f\v]`), deliberately not what `trim()` strips: a term of one U+00A0 would
 * rank specific in SQL and read absent here. Verified against Postgres in `rules-subject.pg`.
 */
const SUBJECT_TERM_TRIM = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

function termOf(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const term = raw.replace(SUBJECT_TERM_TRIM, "").toLowerCase();
  return term.length === 0 ? null : term;
}

/**
 * The rule's subject term, case-folded and trimmed, or `null` — THE one answer to "does this rule
 * carry a subject term?". The router's `matches` and this order both ask it; if they disagreed the
 * narrow rule would win its tie and then decline to fire. `null`, `""` and blank all answer `null`.
 */
export function subjectTermOf(r: Pick<OrderedRule, "subjectContains">): string | null {
  return termOf(r.subjectContains);
}

/** The same question for the body term (mail 0052), with the same trim. */
export function bodyTermOf(r: Pick<OrderedRule, "bodyContains">): string | null {
  return termOf(r.bodyContains);
}

/**
 * Does `subject` satisfy the rule's subject term? Case-folded substring and nothing cleverer: no
 * regex (a user-supplied pattern is a ReDoS on the ingest path), no normalisation. An absent term
 * is satisfied, `""` satisfies no term. Module-private: {@link ruleClaims} is the only door.
 */
function subjectTermSatisfied(r: Pick<OrderedRule, "subjectContains">, subject: string): boolean {
  const term = subjectTermOf(r);
  return term === null || subject.toLowerCase().includes(term);
}

/** The body twin, over `message_bodies.text`; `""` satisfies no term. Module-private too. */
function bodyTermSatisfied(r: Pick<OrderedRule, "bodyContains">, text: string): boolean {
  const term = bodyTermOf(r);
  return term === null || text.toLowerCase().includes(term);
}

/** A rule as the claim reads it: the order's fields plus who or what it names. */
export interface ClaimingRule extends OrderedRule {
  kind: string;
  match: string;
  enabled?: boolean;
}

/**
 * What one message offers a rule. `text` is `message_bodies.text`, the router's haystack; `null`
 * where the caller does not hold it (a client). `headers` likewise: `null` on a client. The server
 * always passes both, so it never meets `unknown`.
 */
export interface PlacementInputs {
  author: string | null;
  subject: string;
  text: string | null;
  headers: Readonly<Record<string, readonly string[] | undefined>> | null;
}

/** A rule's answer about one message: it claims it, it does not, or what decides is not held. */
export type RuleClaim = "claims" | "declines" | "unknown";

function domainOf(addr: string): string {
  const i = addr.indexOf("@");
  return i >= 0 ? addr.slice(i + 1) : "";
}

/**
 * Does this rule name this PERSON? The ONE spelling of the sender/domain claim, for the router's
 * placement and its standing decision alike. `author === null` (absent, unparseable or ambiguous
 * `From`) names nobody: a guessed author never inherits a decision made about somebody else. A
 * `header` rule names a header, not a principal.
 */
export function namesAuthor(r: Pick<ClaimingRule, "kind" | "match">, author: string | null): boolean {
  if (author === null) return false;
  if (r.kind === "sender") return ruleMatchKey(r.match) === author;
  if (r.kind === "domain") return ruleMatchKey(r.match) === domainOf(author);
  return false;
}

/**
 * THE ONE CLAIM: does `r` file this message? The principal (author or header), then the subject
 * term, then the body term — conjuncts, so a term only ever turns a claim into a decline. A header
 * rule without the headers, or a body term without the text, answers `unknown`, never a guess.
 * `hasOwnProperty`: the header map comes back through `JSON.parse`, and `constructor` is no header.
 */
export function ruleClaims(r: ClaimingRule, m: PlacementInputs): RuleClaim {
  let principal: RuleClaim;
  if (r.kind === "sender" || r.kind === "domain") {
    principal = namesAuthor(r, m.author) ? "claims" : "declines";
  } else if (r.kind === "header") {
    const name = r.match.toLowerCase();
    if (name.length === 0) principal = "declines";
    else if (m.headers === null) principal = "unknown";
    else {
      principal = Object.prototype.hasOwnProperty.call(m.headers, name) && (m.headers[name]?.length ?? 0) > 0
        ? "claims" : "declines";
    }
  } else {
    principal = "declines";
  }
  if (principal === "declines" || !subjectTermSatisfied(r, m.subject)) return "declines";
  if (bodyTermOf(r) !== null) {
    if (m.text === null) return "unknown";
    if (!bodyTermSatisfied(r, m.text)) return "declines";
  }
  return principal;
}

/**
 * THE RULE THIS MESSAGE IS FILED BY — the minimum under {@link compareRules} among the enabled
 * rules that claim it. `undecided` is the best rule answering `unknown` when it would outrank that
 * winner: the placement is then not knowable here, and a caller projects nothing on it.
 */
export function placingRule<R extends ClaimingRule>(
  rules: readonly R[], m: PlacementInputs,
): { rule: R | null; undecided: R | null } {
  let rule: R | null = null;
  let unknown: R | null = null;
  for (const r of rules) {
    if (r.enabled === false) continue;
    const claim = ruleClaims(r, m);
    if (claim === "claims") { if (rule === null || compareRules(r, rule) < 0) rule = r; }
    else if (claim === "unknown") { if (unknown === null || compareRules(r, unknown) < 0) unknown = r; }
  }
  const undecided = unknown !== null && (rule === null || compareRules(unknown, rule) < 0) ? unknown : null;
  return { rule, undecided };
}

/**
 * THE ACTING TWIN of rows under one key: a rule that is on before one that is paused — the router
 * never runs a paused rule (`placingRule` skips it) — then {@link compareRules}. The Rules page
 * picks the row it shows by this, and the organizer's `findRulesByKey` states it in SQL; the
 * parity test holds the two to one order.
 */
export function compareTwins(a: OrderedRule & { enabled?: boolean }, b: OrderedRule & { enabled?: boolean }): number {
  const on = (b.enabled === false ? 0 : 1) - (a.enabled === false ? 0 : 1);
  return on !== 0 ? on : compareRules(a, b);
}

/** A rule carrying the term outranks one without, within one kind: 0 wins. */
const subjectRank = (r: OrderedRule): number => (subjectTermOf(r) === null ? 1 : 0);
const bodyRank = (r: OrderedRule): number => (bodyTermOf(r) === null ? 1 : 0);

/**
 * Ascending = wins. Priority (higher first) → how narrowly the rule names the sender: address over
 * domain over header → deny over allow → with a subject term → with a body term → manual, migrated,
 * promoted, seeded → `id`. The kind before the effect: a person allowed by name is never screened
 * out by a rule on their domain; the effect before the terms: a term never overturns a screen-out.
 * No instant is read: twins that tie on everything fall to the id, compared with `<` (one order).
 */
export function compareRules(a: OrderedRule, b: OrderedRule): number {
  const priority = finitePriority(b.priority) - finitePriority(a.priority);
  if (priority !== 0) return priority;
  const kind = rank(KIND_RANK, a.kind) - rank(KIND_RANK, b.kind);
  if (kind !== 0) return kind;
  const effect = rank(EFFECT_RANK, a.effect) - rank(EFFECT_RANK, b.effect);
  if (effect !== 0) return effect;
  // Below the effect, above `provenance`: a term refines a claim about the same principal, and the
  // pair it exists for is two `manual` rules for one address, where provenance separates nothing.
  const subject = subjectRank(a) - subjectRank(b);
  if (subject !== 0) return subject;
  const body = bodyRank(a) - bodyRank(b);
  if (body !== 0) return body;
  const provenance = rank(PROVENANCE_RANK, a.provenance) - rank(PROVENANCE_RANK, b.provenance);
  if (provenance !== 0) return provenance;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
