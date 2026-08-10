import { parseMessageIds } from "./threading.js";
import type { NormalizedMessage, Destination } from "./types.js";

export type RuleKind = "sender" | "domain" | "header";

/**
 * WHAT A RULE SAYS ABOUT THE CONSENT GATE — modelled, not inferred at the point of use.
 *
 * `deny` is the user holding a sender AT the gate (`ohmail/Screener`), putting them behind it
 * (`ohmail/Screened`), or quarantining them. `allow` is the user letting them through to a real
 * folder. The distinction only ever decides a TIE between two rules of equal numeric priority —
 * see {@link compareRules} — and it exists as a field because a review found precisely
 * that a broad `allow` could beat the user's sender-specific "no" on nothing but array position.
 *
 * ── WHY IT IS ON THE TYPE AND NOT A `destination === "ohmail/Screened"` TEST INSIDE THE
 *    EVALUATOR ────────────────────────────────────────────────────────────────────────────────
 *
 * A folder name is a routing target; whether the user was saying yes or no is a separate claim
 * about their intent, and the evaluator must not be the place those two are conflated. Today the
 * two happen to be a total function of each other ({@link effectForDestination}) because the only
 * writers — `screener-service.ts` `decide`, `rules-service.ts` create, `learning-service.ts`,
 * `hey-migration.ts` — can express intent no other way: `rules` has no `effect` column. So the
 * mapping is applied ONCE, at the adapter boundary (`drizzle-repo.ts#listRules`), and
 * {@link evaluateRules} reads the field. When an `effect` column lands, the mapper is the only
 * line that changes and no consent logic moves.
 */
export type RuleEffect = "allow" | "deny";

/**
 * The authentication evidence the caller holds about the CLAIMED author of this message.
 *
 * ── DEMOTE-ONLY: THE UNION IS NOW FOUR MEMBERS, AND ONE OF THEM IS
 *    READ ──────────────────────────────────────────────────────────────────────────────────
 *
 * Exactly one member changes a routing answer: `"fail"`. Everything else — including both
 * shapes of "I have no evidence" — routes a message EXACTLY as it routed before this rule
 * existed. That asymmetry is the whole design and it is not stylistic:
 *
 *  · **Absent evidence must never select the destructive branch.** The worker's kickstart
 *    re-route pass only reroutes a Screener row when {@link evaluateRules} does *not* answer
 *    Screener. Gate the known-sender match on a POSITIVE verdict and every row of a
 *    large backlog answers Screener, `continue` fires, nothing reroutes, and the measured
 *    empty-Ohbox condition returns (most rows screened, `ohmail/Receipts` = 0). So there is no
 *    `if (auth !== "pass") screen` in this file and there must never be one.
 *    **Authentication may DEMOTE a message it has evidence against. It may never be REQUIRED
 *    before an identity the user has already consented to is honoured.**
 *  · The field stays required so that every call site NAMES its evidence in a diff. A default
 *    would select a branch silently, which is the shape of a bug that has already shipped in this
 *    repository once.
 *
 * The members, and why two of them mean "no evidence" rather than one:
 *
 *  · `"unauthenticated"` — the caller DID NOT LOOK. Every earlier call site states this
 *    (`pipeline.ts`, `kickstart.ts`, `sensitive-rescreen.ts`), and it is what the column's
 *    `NULL` resolves to. Permissive.
 *  · `"unavailable"` — the caller LOOKED and found nothing it is entitled to believe: no
 *    `Authentication-Results` at all, or one that no trusted position wrote. Permissive, and
 *    distinguishable from the above only so that a stored verdict says which of the two happened.
 *  · `"pass"` — a trusted position reported an ALIGNED pass. **Routing does not read this**, by
 *    the rule above; it exists to be persisted and shown.
 *  · `"fail"` — a trusted position reported an explicit failure for the claimed author. This is
 *    evidence AGAINST the sender, not the absence of evidence for them, so it is the one member
 *    that moves a message — and it moves it in one direction only, towards the Screener.
 *
 * A verdict is only ever produced by {@link authVerdictFromHeaders}, which reads
 * `Authentication-Results` **only** from an authserv-id the account's own provider is known to
 * sign with. `"aligned"`, `"signed_unaligned"` and `"unsigned"` are deliberately still NOT
 * members: those are the vocabulary of the offline DKIM check
 * (`verifyAlignedDkim`), which is not implemented here.
 *
 * A compile-time fixture pins the field as required, and it has a tsconfig of its own whose only
 * job is to compile that claim — a type-level guard sitting in a `test/` directory is not compiled
 * by anything in this repository, so it would silently not guard.
 */
export type AuthVerdict = "unauthenticated" | "unavailable" | "pass" | "fail";

export interface Rule {
  id: string;
  kind: RuleKind;
  match: string;            // sender: full address; domain: 'example.com'; header: header name
  destination: Destination;
  /** Whether this rule lets the sender THROUGH the gate or holds them at it. See {@link RuleEffect}. */
  effect: RuleEffect;
  priority: number;
  /**
   * Where the rule came from — and, since the `people_only` demotion, which HALF of consent it
   * records. Consent has two axes: ADMISSION (this sender is past the Screener gate) and PLACEMENT
   * (which allow-side pile their mail lands in).
   *
   *  · `seeded-from-sent` — the onboarding seed: the user wrote to this address, so the rule
   *    records the ADMISSION they gave by writing to a *person*. Its `destination: "INBOX"` was a
   *    bulk default WE chose (`consent-seed.ts#confirmSeed`), never a placement the user decided —
   *    so under `people_only` an automated-shaped message from a seeded sender may be demoted to
   *    Reads/Receipts. Admission is honoured; the placement we inferred is refined.
   *  · `promoted` — a Screener decision the user pressed. Admission is explicit; the pile it named
   *    is also demotable-past, because the button admits a *sender* and the same header refinement
   *    applies (the ruling groups it with `seeded-from-sent`).
   *  · `manual` and `migrated` — a rule the user AUTHORED (here, or elsewhere and imported). Both
   *    axes are the user's own decision, so the demotion never touches them: a `manual`
   *    sender→INBOX rule is absolute, and writing one is how the "keep in my Ohbox" affordance ends
   *    the demotion for a sender for good.
   */
  provenance: "manual" | "migrated" | "promoted" | "seeded-from-sent";
  enabled: boolean;
}

/**
 * Everything one routing decision is allowed to see, in ONE object.
 *
 * Positional arguments were how `auth` could be added invisibly at some call sites and not
 * others; a named required field cannot be forgotten and cannot be defaulted.
 */
/**
 * HOW HARD TO KEEP THE OHBOX RELEVANT — the per-account posture that turns the bulk-mail demotion
 * on. It is about RELEVANCE, not humans-versus-machines: the Ohbox is for real people AND for
 * genuinely relevant service mail (a receipt belongs in Receipts, a security alert can stay in the
 * Ohbox), and only the obvious irrelevant bulk is filed out. Two states, and the delicate one is
 * what it does NOT touch:
 *
 *  · `people_and_replied` — today's behaviour, and the day-one/absent-config value. A sender the
 *    account has ever admitted (a seeded/promoted allow rule) delivers ALL of their mail to the
 *    Ohbox, promotional bulk included. NULL `account_settings.ohbox_policy` resolves here, so
 *    shipping this demotes nobody until they choose otherwise. (The two literals are internal
 *    identifiers; the user-facing name is framed around relevance, never "only real people".)
 *  · `people_only` — the RELEVANCE-FOCUSED posture: obvious BULK mail (a newsletter/promotion, by
 *    its List-* / Feedback-ID markers) from an INFERRED-admission sender (`seeded-from-sent` or
 *    `promoted`) is filed to its right pile — Reads, or Receipts on a money subject — instead of
 *    the Ohbox. A relevant service message with no bulk markers is LEFT in place (the AI and the
 *    bar judge the ambiguous middle). It never touches a `manual`/`migrated` rule (a placement the
 *    USER decided), never a deny, and never pulls a stranger through the gate. See
 *    {@link evaluateRules} and {@link headerHeuristic}.
 */
export type OhboxPolicy = "people_only" | "people_and_replied";

/** The migration-safe value: absent config, and byte-identical to the pre-slice router. */
export const DEFAULT_OHBOX_POLICY: OhboxPolicy = "people_and_replied";

/**
 * Resolve a stored `account_settings.ohbox_policy` (or a failed/absent read) to the posture the
 * engine runs on. NULL, `undefined`, and any value outside the union all resolve to
 * {@link DEFAULT_OHBOX_POLICY} — absent-config-selects-safe, an allowlist and never a negation. In
 * core rather than in a service so the worker's resolution and the API's read cannot drift.
 */
export function resolveOhboxPolicy(raw: string | null | undefined): OhboxPolicy {
  return raw === "people_only" || raw === "people_and_replied" ? raw : DEFAULT_OHBOX_POLICY;
}

export interface EvaluateRulesInput {
  msg: NormalizedMessage;
  rules: readonly Rule[];
  /** `contacts` for the account, lowercased (`drizzle-repo.ts#knownSenders`). */
  knownSenders: ReadonlySet<string>;
  /**
   * REQUIRED. Read for exactly one value — `"fail"` — and for nothing else.
   * See {@link AuthVerdict} before touching this, and never turn it into a precondition.
   */
  auth: AuthVerdict;
  /**
   * REQUIRED, on the same discipline as `auth`: no default here, so every call site NAMES the
   * posture in its diff and none can be silently on the wrong side of the demotion branch. The
   * OUTERMOST dep (worker config, `PlanDeps`) is where the optionality lives and where NULL is
   * resolved to {@link DEFAULT_OHBOX_POLICY}. The risk this closes is `rule-retro.ts`: its backlog
   * pass is the thing that actually empties the Ohbox, and a missing field there would run
   * it under the lenient policy — the `dormancy_days`/`trustedAuthservIds` zero-writer trap.
   */
  ohboxPolicy: OhboxPolicy;
}

export interface RuleDecision {
  destination: Destination | null;               // null = unclear (hand to AI later)
  matchedRuleId: string | null;
  /**
   * `"policy"` is the automated-mail demotion of an INFERRED-admission allow rule under
   * `people_only`: the placement was OURS to refine, not the user's, so it is NOT a `"rule"`
   * decision and it does NOT carry the overridden rule as `matchedRuleId` (recording it would
   * teach the learning path a placement consent the user never gave — the same reason the
   * `auth === "fail"` demotion drops it). The overridden rule travels as {@link overriddenRuleId}
   * instead, so the client can render the "keep in my Ohbox" affordance without the learning reads
   * ever seeing it as consent.
   */
  source: "rule" | "header" | "screener" | "unclear" | "policy";
  /**
   * The allow rule a `source: "policy"` demotion moved this message past. `null` for every other
   * source. Present so the affordance can name the sender and so a routing-decision row can record
   * WHAT was overridden without recording it as the decision itself.
   */
  overriddenRuleId?: string | null;
}

/**
 * The one place a folder is read as an expression of yes/no. Exhaustive over {@link Destination}:
 * a seventh folder is a compile error here until somebody decides which side of the gate it is on.
 *
 * The `default` arm is reachable at RUNTIME even though it is unreachable to the type checker —
 * `drizzle-repo.ts#listRules` casts `rules.destination` (a bare `text` column) to `Destination`
 * without validating it. A string that is not one of the six is not a positive assertion of
 * denial, so it gets no deny precedence: exactly the pre-slice behaviour, and never a *new*
 * reason for a rule to win a tie.
 */
export function effectForDestination(destination: Destination): RuleEffect {
  switch (destination) {
    case "ohmail/Screener":
    case "ohmail/Screened":
    case "ohmail/Quarantine":
      return "deny";
    case "INBOX":
    case "ohmail/Reads":
    case "ohmail/Receipts":
      return "allow";
    default: {
      const exhaustive: never = destination;
      void exhaustive;
      return "allow";
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE TOTAL ORDER OVER RULES
   ══════════════════════════════════════════════════════════════════════════════════════════

   The reported defect was "equal priorities fall back to array position". The real one is worse:
   `drizzle-repo.ts#listRules` had **no `ORDER BY`**, so the array position was PostgreSQL's
   PHYSICAL ROW ORDER — which moves under UPDATE and VACUUM. The same message routed differently
   on different days with no rule change, and PGlite (stable insertion order) could never show it.

   So the order below is total: for any two rules with distinct ids it returns non-zero, and it
   reads nothing that a sender controls. `listRules` also sorts in SQL now — the same order,
   mirrored — because a total order in TypeScript over a nondeterministic input is correct but
   unauditable: `psql` must be able to show the winner first.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** deny outranks allow at equal priority — the user's explicit "no" is never lost to a tie. */
const EFFECT_RANK: Readonly<Record<RuleEffect, number>> = { deny: 0, allow: 1 };
/**
 * Specificity. `sender` names one mailbox, `domain` names a set of them, and `header` names no
 * principal at all — it is a statement about a message, so it is the least specific claim
 * anybody can make about a sender and it sorts last.
 */
const KIND_RANK: Readonly<Record<RuleKind, number>> = { sender: 0, domain: 1, header: 2 };
/**
 * What the user typed beats what we imported for them, which beats what we learned.
 *
 * `seeded-from-sent` sorts LAST, below `promoted`, and the tie it breaks is a real one: a user
 * screens a sender the onboarding seed already wrote a rule for. Both rules allow, both are
 * `kind: "sender"`, both sit at the default priority — so at equal provenance rank the winner
 * would fall through to comparing two random UUIDs, which is precisely the nondeterminism this
 * comparator exists to end. The decision taken deliberately, one sender at a time, outranks the
 * one inferred in bulk from the Sent folder.
 *
 * `drizzle-repo.ts#listRules` states this same order in SQL. The two must agree literally: a
 * value left to fall into the SQL `else` arm gets rank 2 there while this table's absent-key
 * path ranks it last, and the server and the client would then order the same two rules
 * differently.
 */
const PROVENANCE_RANK: Readonly<Record<Rule["provenance"], number>> = {
  manual: 0, migrated: 1, promoted: 2, "seeded-from-sent": 3,
};

/**
 * Rank an enum-shaped column that reached us through an unvalidated cast.
 *
 * `kind`, `provenance` and `effect` are `text` in Postgres and `as`-cast in the adapter, so a
 * value outside the union is representable. A missing table entry would otherwise yield
 * `undefined`, and `undefined - undefined` is `NaN` — a comparator that returns `NaN` is not an
 * order at all, which is the exact class of bug this function exists to end. Unknown ranks LAST:
 * it loses every tie rather than winning one.
 */
function rank<K extends string>(table: Readonly<Record<K, number>>, value: string): number {
  return (table as Readonly<Record<string, number | undefined>>)[value] ?? Number.MAX_SAFE_INTEGER;
}

/** `priority` is `integer NOT NULL`, but a non-finite value here would poison the comparator. */
function finitePriority(p: number): number {
  return Number.isFinite(p) ? p : 0;
}

/**
 * Ascending = wins. Priority (numeric, user-facing) → deny over allow → sender over domain over
 * header → manual over migrated over promoted → `id`.
 *
 * `id` is the final NON-SEMANTIC tie-break and is compared with `<`/`>` rather than
 * `localeCompare`: a locale-dependent collation is not a stable order across two machines.
 */
export function compareRules(a: Rule, b: Rule): number {
  const priority = finitePriority(b.priority) - finitePriority(a.priority);
  if (priority !== 0) return priority;

  const effect = rank(EFFECT_RANK, a.effect) - rank(EFFECT_RANK, b.effect);
  if (effect !== 0) return effect;

  const kind = rank(KIND_RANK, a.kind) - rank(KIND_RANK, b.kind);
  if (kind !== 0) return kind;

  const provenance = rank(PROVENANCE_RANK, a.provenance) - rank(PROVENANCE_RANK, b.provenance);
  if (provenance !== 0) return provenance;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function domainOf(addr: string): string {
  const i = addr.indexOf("@");
  return i >= 0 ? addr.slice(i + 1) : "";
}

/**
 * Does this rule fire on this message?
 *
 * `author === null` means the claimed author is absent, unparseable, or ambiguous
 * ({@link authorAddress}), and then NO sender or domain rule may fire: matching a rule against a
 * guessed author would let a malformed `From` inherit a decision the user made about somebody
 * else. A `header` rule still fires, because it names a header rather than a principal.
 *
 * `hasOwnProperty` rather than `Boolean(msg.headers[name])`: `message_bodies.headers` comes back
 * through `JSON.parse` and therefore inherits from `Object.prototype`, so a rule
 * whose `match` is `constructor` or `toString` matched EVERY message under the old test.
 */
function matches(r: Rule, msg: NormalizedMessage, author: string | null): boolean {
  switch (r.kind) {
    case "sender":
      return author !== null && r.match.toLowerCase() === author;
    case "domain":
      return author !== null && r.match.toLowerCase() === domainOf(author);
    case "header": {
      const name = r.match.toLowerCase();
      return name.length > 0
        && Object.prototype.hasOwnProperty.call(msg.headers, name)
        && (msg.headers[name]?.length ?? 0) > 0;
    }
    default:
      return false;
  }
}

/**
 * The MINIMUM under {@link compareRules} among the enabled rules that fire — not "the first hit
 * in a pre-sorted array", so nothing about the input order can be load-bearing.
 */
function winningRule(
  rules: readonly Rule[], msg: NormalizedMessage, author: string | null,
): Rule | null {
  let winner: Rule | null = null;
  for (const r of rules) {
    if (!r.enabled) continue;
    if (!matches(r, msg, author)) continue;
    if (winner === null || compareRules(r, winner) < 0) winner = r;
  }
  return winner;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE AUTHOR ADDRESS — A POSITIVE PREDICATE
   ══════════════════════════════════════════════════════════════════════════════════════════

   The old gate was `if (from && !knownSenders.has(from))`. A message with no `From`, or one whose
   `From` mailparser could not resolve to a mailbox, leaves `msg.from.address` as the EMPTY STRING
   (`mime.ts:381`, `toAddr`), so the guard was false **on truthiness alone** and the function
   answered `unclear` — a stranger past the consent gate with no trusted address to spoof and no
   user action at all.

   The replacement is positive: an address either passes {@link isSingleUsableAddress} and is
   present in `contacts`, or the message is screened. There is no value of `msg.from.address` that
   satisfies it by being empty.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The RFC 5322 specials that SEPARATE or QUOTE addresses, and therefore cannot appear in a bare
 * `addr-spec`. If one is here, what we hold is not one mailbox — it is a fragment of a header we
 * failed to parse.
 *
 * Domain literals (`user@[192.0.2.1]`) are deliberately NOT rejected: brackets are legal there.
 * Neither are `-`, `+`, `_`, `.` or `'` — `first-name+tag@example.com` and `o'brien@example.com`
 * are ordinary mail, and screening a real contact is the one failure mode this change must not
 * introduce.
 */
const NOT_IN_ADDRESS = /[,;:<>()"]/;

/**
 * Whitespace, a control character (U+0000–U+001F), DEL, or a backslash. Written as code points rather than as a
 * character class because a unicode escape in this file has been mangled into a LITERAL NUL
 * byte in source once already — and `mime.ts#scrubNul` exists because a literal NUL genuinely
 * arrives on the wire, so the two failures would have looked identical.
 */
function hasSpaceControlOrBackslash(addr: string): boolean {
  for (let i = 0; i < addr.length; i++) {
    const code = addr.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/** Exactly one mailbox, with a local part and a domain. `""` can never satisfy this. */
function isSingleUsableAddress(addr: string): boolean {
  const at = addr.indexOf("@");
  if (at <= 0) return false;                        // no `@`, or no local part
  if (at !== addr.lastIndexOf("@")) return false;   // two `@` — not one addr-spec
  if (at === addr.length - 1) return false;         // no domain
  if (hasSpaceControlOrBackslash(addr)) return false;
  return !NOT_IN_ADDRESS.test(addr);
}

/**
 * Count the commas that SEPARATE mailboxes, ignoring the ones inside a quoted display name, a
 * routing/angle-addr, or a parenthesised comment.
 *
 * The naive version of this check is a consent regression, not a hardening: `From: "Doe, John"
 * <john@x.com>` is ordinary mail from one person, and counting its comma would put a known
 * correspondent in the Screener.
 */
function countMailboxSeparators(value: string): number {
  let commas = 0;
  let angle = 0;
  let paren = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) {
      if (c === "\\") { i++; continue; }            // an escaped char inside a quoted-string
      if (c === "\"") quoted = false;
      continue;
    }
    switch (c) {
      case "\"": quoted = true; break;
      case "<": angle++; break;
      case ">": if (angle > 0) angle--; break;
      case "(": paren++; break;
      case ")": if (paren > 0) paren--; break;
      case ",": if (angle === 0 && paren === 0) commas++; break;
      default: break;
    }
  }
  return commas;
}

/**
 * Does the RAW header claim more than one author?
 *
 * This has to be asked of the header because `mime.ts:363` keeps `parsed.from.value[0]` and
 * silently drops the rest, so `From: a@x.com, b@y.com` reaches us looking exactly like
 * `From: a@x.com`. Two `From:` LINES are the same question with a worse answer: the two hops that
 * wrote them disagree about who sent this.
 *
 * `undefined` (no `from` key in the map at all) is NOT treated as ambiguity. Absence of a `From`
 * header already produces an empty `msg.from.address`, which {@link isSingleUsableAddress}
 * refuses; treating an absent map ENTRY as ambiguous instead would screen every known sender in
 * any caller whose header map is incomplete — the one regression this must not cause.
 */
function claimsMultipleAuthors(raw: string[] | undefined): boolean {
  if (raw === undefined || raw.length === 0) return false;
  if (raw.length > 1) return true;
  const value = raw[0];
  return value === undefined ? false : countMailboxSeparators(value) > 0;
}

/**
 * The single, unambiguous, syntactically usable author address — or `null` for every shape the
 * gate must fail closed on: absent `From`, an empty group (`From: undisclosed-recipients:;`),
 * unparseable syntax, and two or more author mailboxes.
 */
function authorAddress(msg: NormalizedMessage): string | null {
  const claimed = msg.from.address;
  if (!isSingleUsableAddress(claimed)) return null;
  if (claimsMultipleAuthors(msg.headers["from"])) return null;
  return claimed;
}

/**
 * The gate, as a positive statement: this account has an author address it recognises.
 *
 * Both halves are required and neither is a truthiness test. `contacts.address` is `NOT NULL` but
 * not non-empty, so a `""` row would otherwise be a permanent skeleton key for every malformed
 * `From` — `authorAddress` is what makes that unreachable.
 */
function isKnownAuthor(author: string | null, knownSenders: ReadonlySet<string>): boolean {
  return author !== null && knownSenders.has(author);
}

/**
 * The MACHINE half of the receipts test: this mail was generated, not typed.
 *
 * `Auto-Submitted` is RFC 3834, and the RFC gives `no` an explicit meaning — "a human wrote
 * this" — so presence alone is the wrong test and `Auto-Submitted: no` must NOT count.
 *
 * The bulk half is now {@link isBulkSend} rather than `Precedence: bulk` alone, so a Feedback-ID /
 * List-Id / one-click campaign that also carries a money subject files under Receipts before the
 * Reads branch below can claim it — the same Receipts-before-Reads ordering the older signals had.
 */
function machineSent(msg: NormalizedMessage): boolean {
  if (isBulkSend(msg.headers)) return true;
  if (headerValues(msg.headers, "auto-submitted")?.some((v) => !/^no$/i.test(v.trim())) ?? false) return true;
  return isServiceSender(msg.from.address);
}

/**
 * The BULK-SEND half of the machine-sent test — a newsletter, a mailing list, or an ESP campaign,
 * as opposed to one person writing to another. Every header here is set by a MACHINE and never by
 * a client composing a personal message, and until this the router keyed only on the first two:
 *
 *  · `List-Unsubscribe` / `List-Unsubscribe-Post` — RFC 2369 / RFC 8058, a list offering a way out.
 *  · `List-Id` — RFC 2919 list membership; a personal message never carries it.
 *  · `Feedback-ID` — an ESP's per-campaign feedback-loop tag. The single most common bulk marker on
 *    the measured Ohbox mail, and the one the heuristic did not look at.
 *  · `Precedence: bulk` — the oldest of the family.
 *
 * Read through {@link headerValues} for the reason the whole file reads headers that way: a bare
 * `h["list-id"]` is a truthy INHERITED value on a `JSON.parse`d map (see the accessor's note).
 *
 * Like everything in {@link headerHeuristic}, it REFINES placement and never establishes consent —
 * it is reachable only for a sender already past the gate, and it only ever demotes to a visible,
 * reversible pile. It can never pull an unknown sender through the Screener.
 */
function isBulkSend(headers: Readonly<Record<string, unknown>>): boolean {
  if (headerValues(headers, LIST_UNSUBSCRIBE_HEADER) !== null) return true;
  if (headerValues(headers, LIST_UNSUBSCRIBE_POST_HEADER) !== null) return true;
  if (headerValues(headers, "list-id") !== null) return true;
  if (headerValues(headers, "feedback-id") !== null) return true;
  return headerValues(headers, "precedence")?.some((v) => /bulk/i.test(v)) ?? false;
}

/**
 * THE STRONG-BULK FLOOR — a STRICTER conjunction than {@link isBulkSend}, for the migration
 * backfill and for nothing else.
 *
 * `isBulkSend` fires on ANY one marker, and that is correct where it is used: {@link headerHeuristic}
 * only ever consults it to refine the placement of a sender ALREADY past the consent gate (a contact,
 * or an inferred-admission allow rule). {@link migrationBulkPlacement} reaches a THIRD population —
 * mail the legacy migration filed into the Ohbox under a blanket default, whose sender is NEITHER a
 * contact NOR carries a rule — and for that population one marker is too weak to demote on: a Google
 * account/security notice carries a `Feedback-ID` and no `List-Unsubscribe`, and that is exactly the
 * "genuinely relevant service alert" that must stay in the Ohbox.
 *
 * So the floor is a CONJUNCTION:
 *  · `List-Unsubscribe` REQUIRED — the sender's own declaration that the mail is optional. A security
 *    alert / OTP / account action does not carry it; a newsletter does.
 *  · AND at least one corroborating list/ESP marker: `List-Id`, `List-Unsubscribe-Post`, `Feedback-ID`,
 *    or `Precedence: bulk`.
 *
 * `Feedback-ID` ALONE is deliberately not enough — see above. This makes the backfill's plan count
 * land BELOW the raw `List-Unsubscribe` population on purpose: the shortfall IS the safety margin, and
 * it is the relevant-service-alert class. Do NOT "fix" the shortfall by loosening this to an OR.
 */
function hasStrongBulkFloor(headers: Readonly<Record<string, unknown>>): boolean {
  if (headerValues(headers, LIST_UNSUBSCRIBE_HEADER) === null) return false;
  if (headerValues(headers, "list-id") !== null) return true;
  if (headerValues(headers, LIST_UNSUBSCRIBE_POST_HEADER) !== null) return true;
  if (headerValues(headers, "feedback-id") !== null) return true;
  return headerValues(headers, "precedence")?.some((v) => /bulk/i.test(v)) ?? false;
}

/**
 * THE MIGRATION BACKFILL'S PLACEMENT for a strong-bulk message — Reads, or Receipts on a money
 * subject — or `null` to KEEP the message where it is.
 *
 * ── ONE ROUTER, NOT TWO ─────────────────────────────────────────────────────────────────────
 *
 * It composes {@link headerHeuristic}'s Receipts-before-Reads ordering, but gated on
 * {@link hasStrongBulkFloor} rather than the bare {@link isBulkSend}, and it reuses {@link isMoneySubject}
 * for the split. The marker/ordering logic therefore lives in THIS file exactly once; the worker
 * backfill (`ohbox-tidy.ts`) must never re-encode it. The floor guarantees `List-Unsubscribe` is
 * present ⇒ {@link isBulkSend} ⇒ {@link machineSent}, so the Receipts branch of the heuristic reduces
 * here to a money subject.
 *
 * ── WHY IT IS NOT REACHABLE FROM {@link evaluateRules} ──────────────────────────────────────
 *
 * The backfill applies this to a sender who is NOT a contact and carries NO rule — the population
 * {@link headerHeuristic} must never see, because running the heuristic before the gate is the
 * pre-gate consent bypass {@link evaluateRules} exists to forbid ("Never move this call above the
 * gate"). This helper is a MIGRATION decision, not a live routing one: it only ever DEMOTES mail that
 * the legacy migration ALREADY admitted to the Ohbox, moving it to a visible, reversible pile. It
 * establishes no consent, writes no rule, and never pulls a stranger through the Screener. Sensitivity
 * is the CALLER's exclusion (jurisdiction is `sensitive-rescreen.ts`); this helper does not read it.
 */
export function migrationBulkPlacement(msg: NormalizedMessage): Destination | null {
  if (!hasStrongBulkFloor(msg.headers)) return null;
  return isMoneySubject(msg.subject) ? "ohmail/Receipts" : "ohmail/Reads";
}

/**
 * Is the CLAIMED author a service mailbox rather than a person? `no-reply@`, `notifications@`,
 * `mailer@`, `newsletter@`, `bounce@`, `postmaster@`, and the auto-responder locals — punctuation
 * stripped, so `no-reply`/`no_reply`/`noreply` are one entry, the same normalisation
 * `consent-seed.ts#isRobotAddress` uses for the same family.
 *
 * ── IT IS A "MACHINE-GENERATED" SIGNAL, NOT A "DEMOTE THIS" SIGNAL. ──────────────────────────
 *
 * This feeds ONLY {@link machineSent}, whose sole consumer is the Receipts conjunction
 * (machine-sent AND a money subject ⇒ Receipts). It does NOT route anything to Reads on its own —
 * a `no-reply@`/`notifications@` sender delivers relevant transactional mail (a security alert, an
 * account action) as often as marketing, and burying that out of the Ohbox is the failure this
 * whole slice must avoid. Obvious bulk is caught by {@link isBulkSend}; the ambiguous middle is
 * left `unclear` for the AI and the account's bar to judge for relevance.
 *
 * The list is still deliberately tight — human-ambiguous roles a small business answers itself
 * (`info@`, `support@`, `contact@`, `sales@`, `hello@`, `team@`) are NOT here — because a false
 * "machine" verdict on a personal `noreply-ish` address would file a real receipt for a person who
 * wrote one by hand.
 */
const SERVICE_LOCAL_PREFIXES = [
  "noreply", "donotreply", "notification", "mailer", "postmaster",
  "newsletter", "bounce", "autoreply", "automailer",
] as const;

function isServiceSender(addr: string): boolean {
  const at = addr.indexOf("@");
  if (at <= 0) return false;
  const local = addr.slice(0, at).replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (local.length === 0) return false;
  return SERVICE_LOCAL_PREFIXES.some((p) => local.startsWith(p));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   READING HEADERS SAFELY — THE ONE ACCESSOR EVERYTHING BELOW USES
   ══════════════════════════════════════════════════════════════════════════════════════════

   `mime.ts` builds its header map on `Object.create(null)`, but that guarantee **does not
   survive a database round trip**: `drizzle-repo.ts` rebuilds `message_bodies.headers` with
   `JSON.parse`, which inherits from `Object.prototype`, and the unsubscribe
   service reads exactly that persisted map. So `h["constructor"]` is a FUNCTION on a round-
   tripped map and `h["toString"]?.length` is a number — a bare index would make every message
   in the database look like it carried a `List-Unsubscribe-Post`.

   Every read below goes through here, and the type is `string[] | null` so that "absent" is a
   value a caller has to handle rather than a truthiness accident.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** Own-property header values, or `null` when the header is genuinely absent. */
function headerValues(
  headers: Readonly<Record<string, unknown>>, name: string,
): string[] | null {
  if (!Object.prototype.hasOwnProperty.call(headers, name)) return null;
  const raw = (headers as Record<string, unknown>)[name];
  if (!Array.isArray(raw)) return null;
  const out = raw.filter((v): v is string => typeof v === "string");
  return out.length === 0 ? null : out;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   `Authentication-Results` — TRUSTED POSITION ONLY (demote-only)
   ══════════════════════════════════════════════════════════════════════════════════════════

   **An `Authentication-Results` header is worth nothing because it is present.** It is an
   ordinary header: anyone who knows the user's address can put one in the message they send,
   claiming whatever they like. RFC 8601 §5 is explicit that a receiver must consume only the
   ones its own trusted boundary added, and must strip pre-existing ones bearing its own
   authserv-id on the way in.

   We cannot verify that stripping happened, so the rule here is the strictest one available
   without a cryptographic check of our own:

     · `trustedAuthservIds` is supplied by the CALLER and is EMPTY by default. An empty set
       means every message answers {@link AuthVerdict} `"unavailable"` and nothing is demoted —
       so wiring this up on a deployment that has not named its provider changes no routing at
       all. That is the intended migration path, not a stub.
     · Among the `Authentication-Results` headers, the FIRST one (top of the message, i.e. the
       most recently prepended) whose authserv-id is in that set is the only one read. Not the
       first header found: a message that carries only a sender's own forged header must reach
       the same answer as a message that carries none.
     · A verdict is only ever `"fail"` on a DKIM or DMARC failure — never on SPF. SPF fails on
       every ordinary forward and on most mailing lists, and demoting a real correspondent's
       forwarded mail to the Screener is precisely the regression this must not cause.
       DMARC is aligned by definition and DKIM survives forwarding, so those two are the ones
       whose failure says something about the CLAIMED AUTHOR.

   What this is NOT: it is not DKIM verification. We are believing our own provider's report of
   somebody else's cryptography. That is a real trust dependency, and it is why the allowlist —
   the thing that decides whose report we believe — is required rather than defaulted.

   RESIDUAL, stated so nobody has to rediscover it: a sender who forges our provider's exact
   authserv-id **on a message our provider adds no header to** is believed. Under demote-only
   that buys an attacker nothing — a forged `"pass"` is not read by {@link evaluateRules} at
   all, and a forged `"fail"` only demotes the attacker's own message. It would buy them
   something the moment anybody makes a positive verdict a precondition, which is the third
   reason this file refuses to.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const AUTH_RESULTS_HEADER = "authentication-results";

/**
 * Split an `Authentication-Results` value on the `;` that separate its parts, ignoring the ones
 * inside a quoted string (`reason="rejected; see policy"`) or a parenthesised comment.
 *
 * The naive `value.split(";")` truncates a method's properties at the first quoted semicolon and
 * silently turns a `dmarc=fail` into an unparsed fragment — a failure that reads as "no evidence"
 * and therefore fails OPEN.
 */
function splitAuthResultParts(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let paren = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) {
      if (c === "\\") { i++; continue; }
      if (c === "\"") quoted = false;
      continue;
    }
    if (c === "\"") { quoted = true; continue; }
    if (c === "(") { paren++; continue; }
    if (c === ")") { if (paren > 0) paren--; continue; }
    if (c === ";" && paren === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

/**
 * The `authserv-id` an `Authentication-Results` value opens with, lowercased — or `""`.
 *
 * The first part is `authserv-id [ CFWS ] [ version ]`. Take the first whitespace-delimited
 * token and drop a trailing dot (a FQDN written absolutely) so `mx.google.com.` and
 * `mx.google.com` are one identity rather than two.
 */
function authservIdOf(part: string): string {
  const token = part.trim().split(/\s+/)[0] ?? "";
  return token.toLowerCase().replace(/\.$/, "");
}

/** One `method=result` clause with the properties that came after it. */
interface AuthMethodResult {
  method: string;
  result: string;
  /** `header.d`, `header.i`, `header.from`, … lowercased keys, raw values. */
  props: Record<string, string>;
}

/**
 * Drop the RFC 5322 `(parenthesised comments)` an Authentication-Results part may carry, replacing
 * each with a single space. A comment is RFC 8601 CFWS — semantically whitespace — and never
 * carries an auth property, so removing it is lossless for this parser AND collapses a comment that
 * sits as CFWS around an `=` (`dkim (ok)= pass`) down to the whitespace case that
 * {@link collapseWsAroundEq} then absorbs. Comments nest; text inside a quoted string is copied
 * verbatim (a `(` there is a literal, not a comment opener).
 */
function stripAuthComments(part: string): string {
  const out: string[] = [];
  let quoted = false;
  let paren = 0;
  for (let i = 0; i < part.length; i++) {
    const c = part[i]!;
    if (quoted) {
      out.push(c);
      if (c === "\\" && i + 1 < part.length) { out.push(part[++i]!); continue; }
      if (c === "\"") quoted = false;
      continue;
    }
    if (paren > 0) {
      if (c === "\\") { i++; continue; }
      if (c === "(") paren++;
      else if (c === ")") paren--;
      continue;
    }
    if (c === "\"") { quoted = true; out.push(c); continue; }
    if (c === "(") { paren++; out.push(" "); continue; }
    out.push(c);
  }
  return out.join("");
}

/**
 * Collapse folding whitespace on either side of every top-level `=`, so an RFC 8601
 * `method [CFWS] "=" [CFWS] result` — and each `ptype.property [CFWS] "=" [CFWS] pvalue` after it —
 * survives the whitespace tokeniser in {@link parseAuthMethodResult}. Without this, `dkim = fail`
 * splits into `["dkim", "=", "fail"]`: the head token carries no `=`, the whole clause is dropped,
 * and the drop reads as "no evidence" — the parser fails OPEN on the very failures it exists to
 * read. Text inside a quoted string is copied verbatim, so whitespace around an `=` in a
 * quoted pvalue is preserved.
 */
function collapseWsAroundEq(part: string): string {
  const out: string[] = [];
  let quoted = false;
  for (let i = 0; i < part.length; i++) {
    const c = part[i]!;
    if (quoted) {
      out.push(c);
      if (c === "\\" && i + 1 < part.length) { out.push(part[++i]!); continue; }
      if (c === "\"") quoted = false;
      continue;
    }
    if (c === "\"") { quoted = true; out.push(c); continue; }
    if (c === "=") {
      while (out.length > 0 && /\s/.test(out[out.length - 1]!)) out.pop();
      out.push("=");
      while (i + 1 < part.length && /\s/.test(part[i + 1]!)) i++;
      continue;
    }
    out.push(c);
  }
  return out.join("");
}

/**
 * Parse one `method[/version]=result [ptype.property=value]*` part.
 *
 * Returns `null` for anything that is not that shape — a trailing empty segment, a bare comment,
 * a `none` line with no `=`. An unparseable clause contributes no evidence; it never contributes
 * a failure, because "I could not read this" is not "the sender failed".
 *
 * RFC 8601 CFWS (comments and folding whitespace) is normalised away FIRST — comments dropped, then
 * whitespace collapsed around every `=` — so a valid result written `dkim = fail` or
 * `dkim (ok)= fail` is not silently discarded.
 */
function parseAuthMethodResult(part: string): AuthMethodResult | null {
  const tokens = collapseWsAroundEq(stripAuthComments(part)).trim().split(/\s+/).filter((t) => t.length > 0);
  const head = tokens[0];
  if (head === undefined) return null;
  const eq = head.indexOf("=");
  if (eq <= 0) return null;
  const method = head.slice(0, eq).split("/")[0]!.toLowerCase();
  const result = head.slice(eq + 1).toLowerCase();
  if (method.length === 0 || result.length === 0) return null;

  const props: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const t of tokens.slice(1)) {
    const i = t.indexOf("=");
    if (i <= 0) continue;
    props[t.slice(0, i).toLowerCase()] = t.slice(i + 1);
  }
  return { method, result, props };
}

/** The domain half of an address, or of a bare domain. Lowercased, no trailing dot, no `@`. */
function domainPart(value: string): string {
  const at = value.lastIndexOf("@");
  return (at >= 0 ? value.slice(at + 1) : value).trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Is a DKIM signing domain aligned with the claimed author's domain?
 *
 * Deliberately RELAXED and deliberately not a Public-Suffix-List check: `tldts` is not a dependency
 * of this package. It treats any exact match or parent/child suffix relationship as aligned, so it
 * OVER-declares alignment only across a domain boundary a real PSL check would separate — most
 * notably a bare public suffix (`co.uk`) as `header.d`.
 *
 * {@link authVerdictFromHeaders} consults this in both directions now:
 *  · to promote an aligned dkim=pass to {@link AuthVerdict} `"pass"`, which {@link evaluateRules}
 *    never reads — over-declaring alignment there is harmless, the original reason an approximation
 *    was acceptable;
 *  · to gate an aligned dkim=fail to `"fail"`, which DOES demote. Here the over-declared
 *    direction could in principle demote a message whose signature merely shares a suffix with the
 *    author. That residual is bounded and acceptable because: it is strictly LESS demotion than the
 *    unconditional fail it replaces; the case this gate targets — an unrelated third-party ESP/list
 *    signature with no suffix relationship at all — is correctly judged not-aligned and does not
 *    demote; a demote only routes to the recoverable Screener; and the whole path is inert until an
 *    authserv-id is trusted. A real PSL check is the follow-up if Axis C is ever run hot.
 */
function dkimAligned(signing: string, authorDomain: string): boolean {
  const d = domainPart(signing);
  const a = authorDomain;
  if (d === "" || a === "") return false;
  return d === a || a.endsWith(`.${d}`) || d.endsWith(`.${a}`);
}

/**
 * NO DEPLOYMENT TRUST DECISION HAS BEEN MADE — the day-one state of every producer.
 *
 * A named symbol rather than an anonymous `new Set()` at each call site, for two reasons that
 * are both about the next reader:
 *
 *  · It is the ONE thing to grep for to enumerate every path that is currently blind
 *    ({@link authVerdictFromHeaders} answers `"unavailable"` for every message when the set is
 *    empty, so a producer holding this is exactly as permissive as the `"unauthenticated"`
 *    literal it replaced — see {@link AuthVerdict}). "Which paths are wired but unconfigured"
 *    is then a question with a mechanical answer.
 *  · An empty set is a CONFIGURATION state, not a defect, and naming it says so. Filling it in
 *    is a deployment decision — which authserv-id the account's own provider signs
 *    `Authentication-Results` with — that nobody can default for a host
 *    (`packages/api/src/routes/shared.ts#unsubscribes` already states this for the one
 *    pre-existing consumer).
 *
 * `Set<never>` and not `Set<string>` so a `.add()` on it does not typecheck. It is frozen at
 * the type level rather than by `Object.freeze` because `ReadonlySet` is what every consumer
 * takes and a runtime freeze would be a claim no consumer can violate anyway.
 */
export const NO_TRUSTED_AUTHSERV_IDS: ReadonlySet<string> = new Set<never>();

/**
 * The verdict for the CLAIMED author of a message, from its own provider's report.
 *
 * `headers` is the lowercased name → raw values map (`mime.ts`, or `message_bodies.headers`
 * after a `JSON.parse` round trip — see {@link headerValues}). `fromAddress` is the claimed
 * author. `trustedAuthservIds` is the set of authserv-ids the ACCOUNT'S OWN provider signs
 * with, lowercased; **an empty set answers `"unavailable"` for every message** — see
 * {@link NO_TRUSTED_AUTHSERV_IDS}.
 */
export function authVerdictFromHeaders(
  headers: Readonly<Record<string, unknown>>,
  fromAddress: string,
  trustedAuthservIds: ReadonlySet<string>,
): AuthVerdict {
  if (trustedAuthservIds.size === 0) return "unavailable";

  const values = headerValues(headers, AUTH_RESULTS_HEADER);
  if (values === null) return "unavailable";

  // The topmost header from a position we are entitled to believe. Scanning rather than taking
  // index 0 is the difference between "the trusted last hop" and "whatever is on top", and a
  // sender-inserted header must be indistinguishable from no header at all.
  let trusted: string[] | null = null;
  for (const value of values) {
    const parts = splitAuthResultParts(value);
    const head = parts[0];
    if (head === undefined) continue;
    if (!trustedAuthservIds.has(authservIdOf(head))) continue;
    trusted = parts.slice(1);
    break;
  }
  if (trusted === null) return "unavailable";

  const authorDomain = domainPart(fromAddress);
  const results: AuthMethodResult[] = [];
  for (const part of trusted) {
    const r = parseAuthMethodResult(part);
    if (r !== null) results.push(r);
  }

  // DMARC first, and both directions: it is aligned by definition, so it is the only verdict
  // that speaks about the claimed author without a second alignment judgement of ours.
  const dmarc = results.filter((r) => r.method === "dmarc");
  if (dmarc.some((r) => r.result === "fail")) return "fail";
  if (dmarc.some((r) => r.result === "pass")) return "pass";

  // Only an ALIGNED dkim signature speaks about the CLAIMED author, in BOTH directions.
  //  · An aligned pass outranks a broken third-party signature on the same message: a mailing list
  //    that re-signs and breaks the original is the common shape, and treating that as a failure
  //    would screen mail the user asked for.
  //  · An UNALIGNED fail — the third-party ESP or list signature that broke in transit, `header.d`
  //    belonging to someone other than the author — says NOTHING about this author. It must not
  //    demote and must not override an allow. Before this gate every dkim=fail demoted, so an
  //    unaligned third-party failure screened genuine mail and beat the user's own allow rule.
  // Only a fail on a signature aligned with the From domain is evidence against the claimed author.
  const dkim = results.filter((r) => r.method === "dkim");
  const dkimSigner = (r: AuthMethodResult): string => r.props["header.d"] ?? r.props["header.i"] ?? "";
  if (dkim.some((r) => r.result === "pass" && dkimAligned(dkimSigner(r), authorDomain))) return "pass";
  if (dkim.some((r) => r.result === "fail" && dkimAligned(dkimSigner(r), authorDomain))) return "fail";

  // Everything else — `none`, `neutral`, `softfail`, `policy`, `temperror`, `permerror`, an spf
  // failure on its own, a header we could not parse — is the ABSENCE of evidence, and absence
  // never selects the destructive branch.
  return "unavailable";
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   RFC 8058 ONE-CLICK UNSUBSCRIBE — THE HEADER HALF
   ══════════════════════════════════════════════════════════════════════════════════════════

   Four refusals, and each one is a deliberate constraint rather than a nicety:

     · **A `mailto:` unsubscribe is NEVER used.** Acting on one means sending mail on the user's
       behalf to a third party, which this product does not do under any circumstances. It is not
       "supported later" — it is refused, and the refusal is here, in the parser, so that no
       caller can be handed one by accident. The service that acts on the result has no mail port
       at all, so even a defeated parser could not send.
     · **`https:` only.** RFC 8058 §3.1 requires it, and a one-click POST over `http:` puts the
       user's subscription token on the wire in clear.
     · **`List-Unsubscribe-Post: List-Unsubscribe=One-Click` must be present.** Without it the
       `List-Unsubscribe` URI is an ordinary link meant for a human to click and confirm; POSTing
       to it is not what the sender advertised, and one-click is the only shape whose semantics
       RFC 8058 actually pins down.
     · **Nothing is read from the message BODY, ever.** This function takes the header map and
       has no access to a body, which is the structural form of that rule.

   Ambiguity is refused rather than resolved. Two `List-Unsubscribe` lines mean two hops disagree
   about where this list lives, and picking one is guessing with the user's subscription.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const LIST_UNSUBSCRIBE_HEADER = "list-unsubscribe";
const LIST_UNSUBSCRIBE_POST_HEADER = "list-unsubscribe-post";

/** The one value RFC 8058 §3.1 defines, compared with all whitespace removed (folding). */
const ONE_CLICK_POST_TOKEN = "list-unsubscribe=one-click";

/**
 * A ceiling on the URI we are willing to carry. Not a security boundary — the SSRF gate and the
 * fetch port are — just a refusal to hand a megabyte of sender-chosen text to `new URL`.
 */
export const MAX_UNSUBSCRIBE_URI_CHARS = 2048;

/** The `<...>` URIs of an RFC 2369 list header, in order. A bare unbracketed URI is not one. */
function angleUris(value: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < value.length) {
    const lt = value.indexOf("<", i);
    if (lt < 0) break;
    const gt = value.indexOf(">", lt + 1);
    if (gt < 0) break;
    out.push(value.slice(lt + 1, gt).trim());
    i = gt + 1;
  }
  return out;
}

/** An `https:` URI we are willing to POST to. `mailto:` and `http:` are both refused here. */
function isOneClickUri(uri: string): boolean {
  if (uri.length === 0 || uri.length > MAX_UNSUBSCRIBE_URI_CHARS) return false;
  if (hasSpaceControlOrBackslash(uri)) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  // `https://real.example@attacker.example/` — userinfo is how a URL is made to read as one host
  // and connect to another. The SSRF gate refuses it too; refusing it here means it never even
  // reaches a decision about whether to act.
  return u.username === "" && u.password === "";
}

/**
 * The RFC 8058 one-click URI for this message, or `null` — which means **do not offer, do not
 * act, and send nothing**.
 *
 * `null` covers every refusal above and is deliberately not distinguished here; the service that
 * needs to tell a user *why* re-asks with {@link unsubscribeHeaderState}.
 */
export function oneClickUnsubscribeUri(headers: Readonly<Record<string, unknown>>): string | null {
  const post = headerValues(headers, LIST_UNSUBSCRIBE_POST_HEADER);
  if (post === null || post.length !== 1) return null;
  if (post[0]!.replace(/\s+/g, "").toLowerCase() !== ONE_CLICK_POST_TOKEN) return null;

  const list = headerValues(headers, LIST_UNSUBSCRIBE_HEADER);
  if (list === null || list.length !== 1) return null;

  for (const uri of angleUris(list[0]!)) {
    if (isOneClickUri(uri)) return uri;
  }
  return null;
}

/**
 * Why {@link oneClickUnsubscribeUri} answered what it answered — for a message a user is
 * looking at, so the interface can say "this sender offers no way out" instead of going quiet.
 *
 * `"mailto_only"` means the header offered no `https:` URI we may act on — in practice a
 * `mailto:`, and it is a distinct state on purpose: it is the case where the sender DID publish
 * an unsubscribe route and we are refusing it on the user's behalf, which is the one refusal
 * that owes the user an explanation.
 */
export type UnsubscribeHeaderState =
  | "one_click"
  | "no_header"
  | "mailto_only"
  | "not_one_click";

/** The state, computed from the same header map and the same refusals. */
export function unsubscribeHeaderState(
  headers: Readonly<Record<string, unknown>>,
): UnsubscribeHeaderState {
  const list = headerValues(headers, LIST_UNSUBSCRIBE_HEADER);
  if (list === null) return "no_header";
  if (oneClickUnsubscribeUri(headers) !== null) return "one_click";

  const uris = list.length === 1 ? angleUris(list[0]!) : list.flatMap(angleUris);
  const httpsOffered = uris.some((u) => isOneClickUri(u));
  return httpsOffered ? "not_one_click" : "mailto_only";
}

/**
 * The first `https:` unsubscribe URI a message publishes, or `null`.
 *
 * This is the link behind {@link UnsubscribeHeaderState}'s `not_one_click`: a page the SENDER
 * offers for a person to open in their OWN browser. It is deliberately NOT
 * {@link oneClickUnsubscribeUri}, which additionally requires `List-Unsubscribe-Post` and is a
 * POST target this server acts on — never something handed to the client. A surface offers this
 * as a plain outbound link when one-click is not on offer, so the reader can still leave the
 * list; the same {@link isOneClickUri} https-only, no-userinfo filter applies, so a `mailto:` or
 * a userinfo-bearing URL is never returned.
 */
export function httpsUnsubscribeUri(headers: Readonly<Record<string, unknown>>): string | null {
  const list = headerValues(headers, LIST_UNSUBSCRIBE_HEADER);
  if (list === null) return null;
  const uris = list.length === 1 ? angleUris(list[0]!) : list.flatMap(angleUris);
  return uris.find((u) => isOneClickUri(u)) ?? null;
}

/**
 * Money words that stand ALONE. A personal note does not carry these in its subject line —
 * "I've attached the invoice" is a sentence in a body, and the body is not read here.
 */
const MONEY_WORD = /\b(receipts?|invoices?|statements?|refunds?)\b/i;
/**
 * …and the two that do NOT stand alone. "Order now and save 50%" and "Payment plans available"
 * are marketing, and the machine half of the test says nothing about which of the two a bulk
 * message is — every newsletter on the planet sets `Precedence: bulk`. So `order` and `payment`
 * need a transactional companion before they mean money.
 */
const ORDER_WORD = /\b(orders?|payments?)\b/i;
const TRANSACTIONAL_WORD =
  /\b(confirm\w*|receiv\w+|complet\w+|placed|shipped|dispatched|summary|processed|successful|failed|declined|due)\b|#\s*\d/i;

function isMoneySubject(subject: string): boolean {
  return MONEY_WORD.test(subject) || (ORDER_WORD.test(subject) && TRANSACTIONAL_WORD.test(subject));
}

/**
 * The deterministic header layer — Receipts, then Reads.
 *
 * ── IT REFINES PLACEMENT. IT NEVER ESTABLISHES CONSENT. ─────────────────────────────────────
 *
 * Every signal in here is chosen by the SENDER: the bulk/list headers {@link isBulkSend} reads
 * (`List-Unsubscribe`, `List-Unsubscribe-Post`, `List-Id`, `Feedback-ID`, `Precedence: bulk`),
 * `Auto-Submitted`, the subject line, and a service-shaped local part ({@link isServiceSender}).
 * A review found that this function ran BEFORE the Screener gate, so an unknown sender wrote
 * `Precedence: bulk` and landed in `ohmail/Reads` — a remote, unauthenticated, one-message defeat
 * of the consent boundary needing no knowledge of the user's contacts and no action by the user.
 * It is now reachable only for a sender the account already knows. **Never move this call above the
 * gate in {@link evaluateRules}.**
 *
 * ── THE ORDER INSIDE IT IS ALSO CORRECTNESS, AND IT IS THE OTHER THING TO NOT "TIDY" ────────
 *
 * A receipt routinely carries a `List-Unsubscribe` footer: the same ESP sends a shop's order
 * confirmations and its marketing, and the compliance header goes on both. So the Reads branch
 * matches nearly every receipt, and whichever branch is tested FIRST wins the message. Put the
 * receipts test second and `ohmail/Receipts` stays empty forever while every order confirmation
 * files itself under newsletters — which is exactly what was measured: the seeded receipts all
 * filed under newsletters, `ohmail/Receipts` = 0.
 *
 * A test pins the ordering with a receipt that carries `List-Unsubscribe`: swapping these two
 * blocks turns it red.
 *
 * ── AND WHY BOTH SIGNALS ARE REQUIRED ───────────────────────────────────────────────────────
 *
 * Machine-sent alone is most of the world's mail. A money subject alone is a colleague writing
 * "invoice question". Only the conjunction is evidence, and everything the conjunction misses
 * stays `unclear` for the AI layer to propose on later (rules first, ~80%, not 100%).
 */
/**
 * ═══ A BOUNCE OF THE READER'S OWN MAIL, AND THE BACKSCATTER THAT IMPERSONATES ONE ═════════
 *
 * ── THE FAILURE ─────────────────────────────────────────────────────────────────────────
 *
 * You send a message; the recipient's server refuses it; the delivery report comes back from
 * `MAILER-DAEMON@their-host`, whom you have never corresponded with. `evaluateRules` sees a
 * first-contact sender and does exactly what the consent gate is for: it files the report in
 * `ohmail/Screener` and waits for you to decide about the daemon. So the one message that says
 * "the mail you sent did not arrive" is the one message held back from you — and held back at
 * precisely the moment it is most actionable, because a bounce is only useful before you have
 * assumed the mail landed.
 *
 * ── AND WHY THE OBVIOUS FIX IS A CONSENT-GATE BYPASS ────────────────────────────────────
 *
 * "File anything that looks like a delivery report into the Ohbox" is one line, and it hands
 * every spammer on earth a way past the gate: `Content-Type: multipart/report;
 * report-type=delivery-status` is a string anybody can type. This module already carries a
 * scar of that exact shape — `pipeline.ts` records `sensitivity.sensitive ? "INBOX" : …` as a
 * remote, unauthenticated, one-message defeat of the consent boundary — and the rule it
 * learned is the rule here: **a signal the SENDER chooses may refine placement and may never
 * establish consent.** Shape is chosen by the sender. Shape alone can therefore prove nothing.
 *
 * That is also the whole of BACKSCATTER, which is not a hypothetical: a spammer forges YOUR
 * address as the envelope sender, some real MTA rejects the mail, and its genuine, correctly
 * formed delivery report arrives in your mailbox. It has the right Content-Type, it comes from
 * a real daemon, and it carries a real `X-Failed-Recipients`. Every property of "shape" is
 * satisfied by mail you had nothing to do with.
 *
 * ── SO THE VERDICT IS SHAPE **AND** OWN-SEND EVIDENCE, AND OWN-SEND MEANS A LOOKUP ──────
 *
 * This function answers the half that is pure — is this DSN-shaped, and what does it claim
 * about the original message — and it deliberately does NOT answer "is that original ours".
 * Both of the answers to that require data this module does not have and must not fetch:
 *
 *  · {@link DsnEvidence.originalMessageIds} — the Message-IDs the report quotes. The caller
 *    matches them against the account's own `messages.message_id_header`
 *    (`messages_account_message_id_header_idx`, mail 0026 — the index already exists, so this
 *    slice adds no migration). A backscatter report quotes the SPAMMER's Message-ID, which the
 *    account has never held, so the lookup misses and the message takes the ordinary path.
 *  · {@link DsnEvidence.failedRecipients} — the addresses `X-Failed-Recipients` names. The
 *    caller checks them against the account's known correspondents. The header on its own is
 *    NOT evidence and must never be treated as any: it is a string the sender writes, so
 *    accepting its mere presence would reinstate the bypass this docblock exists to refuse.
 *    What makes it evidence is that the failed recipient is somebody this account actually
 *    corresponds with — a fact about our data, which a stranger cannot forge into existence.
 *
 * Neither answer available ⇒ ordinary path, which for a stranger's daemon is the Screener. The
 * report is not deleted, not quarantined and not hidden; it waits, exactly like any other
 * first-contact sender, and the user can admit it in one press. Failing toward the gate is the
 * correct direction for a signal that cannot be corroborated.
 *
 * ── THE RESIDUAL, NAMED ────────────────────────────────────────────────────────────────
 *
 * A genuine bounce for a brand-new recipient — first mail to an address that is not yet a
 * contact — whose report also quotes no Message-ID this account holds, still lands in the
 * Screener. That is a miss, and it is the direction to miss in: one extra press versus a
 * standing hole in the consent gate.
 */
export interface DsnEvidence {
  /**
   * The Message-IDs this report quotes as the ORIGINAL message, best-effort, in the order the
   * caller should probe them: the report's own `In-Reply-To`/`References` first (structured,
   * and what a well-behaved DSN sets), then whatever the quoted headers in the body yield.
   *
   * Bounded — see {@link MAX_DSN_MESSAGE_IDS} and {@link DSN_BODY_SCAN_LIMIT}. An unbounded
   * scan over a body a stranger controls is a way to make one `IN (…)` lookup arbitrarily
   * large, on the ingest hot path, for free.
   */
  originalMessageIds: string[];
  /**
   * The addresses `X-Failed-Recipients` names, lower-cased. EMPTY when the header is absent or
   * carries nothing address-shaped.
   *
   * Deliberately the ADDRESSES and not a boolean. A boolean would be the presence of a header
   * a stranger writes, which is worth nothing; these are values the caller can check against
   * the account's own correspondents, which is worth everything. Returning the wrong shape here
   * is how the bypass gets reintroduced by somebody being helpful.
   */
  failedRecipients: string[];
}

/** How many quoted Message-IDs one report may contribute to the lookup. */
const MAX_DSN_MESSAGE_IDS = 10;
/** How much of a report body is scanned for the quoted original headers. */
const DSN_BODY_SCAN_LIMIT = 8_000;

/** `multipart/report` carrying a delivery-status part — the RFC 3462 shape. */
const DELIVERY_REPORT_CONTENT_TYPE = /multipart\/report/i;
const DELIVERY_STATUS_REPORT_TYPE = /report-type\s*=\s*"?delivery-status"?/i;
/** The two local-parts every MTA on earth bounces from (RFC 5321 §4.5.1 names `postmaster`). */
const DAEMON_LOCAL_PARTS = /^(mailer-daemon|postmaster)$/i;
/** `<...>` with an `@` in it, which is all a Message-ID is guaranteed to be. */
const MESSAGE_ID_TOKEN = /<[^<>@\s]+@[^<>@\s]+>/g;

/**
 * Is this message DSN-SHAPED, and what does it claim? `null` when it is not a delivery report.
 *
 * Pure and read-only — see the docblock above for why the OWN-SEND half is the caller's job and
 * why this function returning a verdict rather than evidence would be the bug.
 */
export function dsnVerdict(msg: NormalizedMessage, raw?: Uint8Array): DsnEvidence | null {
  const contentType = (msg.headers["content-type"] ?? []).join(" ");
  const shaped =
    (DELIVERY_REPORT_CONTENT_TYPE.test(contentType) && DELIVERY_STATUS_REPORT_TYPE.test(contentType)) ||
    DAEMON_LOCAL_PARTS.test(msg.from.address.split("@")[0] ?? "");
  if (!shaped) return null;

  // STRUCTURED FIRST. A DSN that sets `In-Reply-To` to the original's Message-ID has told us
  // outright; the scans below are the fallback for the many that do not.
  //
  // `parseMessageIds` and NOT a second regex of our own, because these strings are about to be
  // compared against `messages.message_id_header` and that function IS the definition of how
  // that column is written — bracket-free, lower-cased, over-long tokens dropped. A local
  // normaliser here would agree with it right up to the first id with an unusual shape, and
  // then miss silently, which on this path looks exactly like "the account never sent that".
  const ids: string[] = [];
  const push = (...values: string[]): void => {
    for (const id of parseMessageIds(values)) {
      if (ids.length >= MAX_DSN_MESSAGE_IDS) return;
      if (!ids.includes(id)) ids.push(id);
    }
  };
  push(...(msg.headers["in-reply-to"] ?? []), ...(msg.headers["references"] ?? []));
  // Then the human-readable part, which is where several MTAs restate the original's id.
  push(...(msg.textBody.slice(0, DSN_BODY_SCAN_LIMIT).match(MESSAGE_ID_TOKEN) ?? []));
  // ── AND THEN THE RAW BYTES, WHICH IS THE ONLY PLACE THE QUOTED HEADERS EXIST ──────────
  //
  // RFC 3462 puts the original in a `message/rfc822-headers` (or `message/rfc822`) part, and
  // the parser does NOT flatten those into `textBody` — measured, not assumed: a Gmail-shaped
  // three-part report normalises to a `textBody` holding only the human-readable paragraph, so
  // a scan of the parsed message finds nothing and the corroboration never fires. That is the
  // silent-degrade version of this feature: shape recognised, evidence unreachable, every real
  // bounce held at the gate exactly as before.
  //
  // OPTIONAL, so a caller that has only the parsed form still gets the structured ids. Bounded
  // by the same {@link DSN_BODY_SCAN_LIMIT} for the same reason — these are a stranger's bytes
  // and they feed an `IN (…)` on the ingest path.
  if (raw) push(...(decodeAscii(raw.subarray(0, DSN_BODY_SCAN_LIMIT)).match(MESSAGE_ID_TOKEN) ?? []));

  // THE REPORT'S OWN ID IS NOT A CLAIM ABOUT AN ORIGINAL. It sits in the raw bytes above and
  // would otherwise consume one of the ten lookup slots on a value that can never match — and,
  // worse, would make a self-referential report look like corroboration the moment the report
  // itself had been ingested.
  const self = msg.canonical.messageIdHeader;
  const originalMessageIds = self ? ids.filter((id) => id !== self) : ids;

  const failedRecipients = (msg.headers["x-failed-recipients"] ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim().replace(/^<|>$/g, "").toLowerCase())
    .filter((v) => v.includes("@") && !v.includes(" "));

  return { originalMessageIds, failedRecipients };
}

/** Latin-1 is enough: a Message-ID is ASCII by RFC, and this only ever feeds a `<...@...>` match. */
function decodeAscii(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function headerHeuristic(msg: NormalizedMessage): RuleDecision | null {
  if (machineSent(msg) && isMoneySubject(msg.subject)) {
    return { destination: "ohmail/Receipts", matchedRuleId: null, source: "header" };
  }
  // BULK MARKERS ONLY route to Reads — the obvious promotional/newsletter shape. A service-shaped
  // sender ({@link isServiceSender}) is NOT enough on its own: `no-reply@`/`notifications@` carries
  // marketing AND genuinely relevant transactional mail (a security alert, an account action), and
  // demoting the latter out of the Ohbox is exactly the "buries mail I need to see" failure. So
  // service-sender feeds only the machine-sent test above (a receipt is machine-sent AND money);
  // an automated message with no bulk marker and no money subject stays `unclear`, for the AI and
  // the account's Ohbox bar to weigh for RELEVANCE — the judgement header shape cannot make.
  if (isBulkSend(msg.headers)) {
    return { destination: "ohmail/Reads", matchedRuleId: null, source: "header" };
  }
  return null;
}

/**
 * The rules whose PLACEMENT the `people_only` demotion is allowed to refine — an ALLOWLIST, and
 * never `provenance !== "manual"`.
 *
 * `provenance` reaches us through an unvalidated `as` cast off a bare `text` column
 * ({@link rank}'s note), so a value outside the union IS representable. A negation would make that
 * garbage DEMOTABLE — exactly the wrong direction, because the failure it produces is a real
 * person's rule being overridden. An allowlist makes garbage EXEMPT: an unknown provenance falls
 * through to the rule's own destination, which is failing toward the user. `migrated` (a rule the
 * user authored elsewhere) and `manual` are both absent, and that absence is the whole ruling.
 */
const DEMOTABLE_PROVENANCE: ReadonlySet<Rule["provenance"]> = new Set(["seeded-from-sent", "promoted"]);

/**
 * The `people_only` placement refinement, or `null` to leave the winning rule's destination alone.
 *
 * Reached ONLY from inside {@link evaluateRules}' winning-allow branch, after the deny and
 * `auth === "fail"` checks, so it can never weaken a denial, screen a message, or run for a
 * sender who is not already admitted. Five conditions, each a refusal to over-reach:
 *
 *  1. the posture is `people_only` (the switch — absent/`people_and_replied` demotes nobody);
 *  2. the rule places into the Ohbox (`destination === "INBOX"`) — a rule that already names Reads
 *     or Receipts is a placement we must not reshuffle;
 *  3. the rule's provenance is INFERRED admission ({@link DEMOTABLE_PROVENANCE}) — never a rule the
 *     user authored;
 *  4. the message is automated-shaped — {@link headerHeuristic} answers Reads/Receipts. If it does
 *     not, the sender is writing personally and the rule's Ohbox placement is exactly right;
 *  5. the answer is that Reads/Receipts destination, carried as `source: "policy"` with the
 *     overridden rule as {@link RuleDecision.overriddenRuleId}, NOT as `matchedRuleId`.
 *
 * {@link headerHeuristic} only ever returns Reads or Receipts, so a demotion output is always one
 * of those two — never the Screener, never Quarantine, never a promotion. A test mutates this to
 * return the Screener and must go red.
 */
function policyDemotion(
  msg: NormalizedMessage, winner: Rule, policy: OhboxPolicy,
): RuleDecision | null {
  if (policy !== "people_only") return null;
  if (winner.destination !== "INBOX") return null;
  if (!DEMOTABLE_PROVENANCE.has(winner.provenance)) return null;
  const heur = headerHeuristic(msg);
  if (!heur) return null;
  return { destination: heur.destination, matchedRuleId: null, source: "policy", overriddenRuleId: winner.id };
}

/**
 * ── THE CONSENT GATE, IN THE ONLY ORDER THAT IS CORRECT ─────────────────────────────────────
 *
 * ohmail's founding premise is that an unknown sender waits in `ohmail/Screener` until the human
 * decides. Four steps, and three of them are a fix for a confirmed bypass:
 *
 *  1. **The user's own rules**, resolved by a TOTAL order ({@link compareRules}). A decision the
 *     user made outranks anything we infer, including the gate itself — that is what "the user
 *     always wins" means, and it is how a sender they already screened stays screened.
 *  2. **A positive authenticated-known check** ({@link isKnownAuthor}). Not `if (from && …)`.
 *  3. **Fail closed to `ohmail/Screener`** for an unknown sender, an absent `From`, an
 *     unparseable `From`, an empty group, and two or more author mailboxes.
 *  4. **THEN** {@link headerHeuristic}, which may only refine placement for a sender that is
 *     already past the gate.
 *
 * Steps 3 and 4 were once in the opposite order — a critical bypass; step 2 was a truthiness
 * test — a further one.
 *
 * ── AND ONE DEMOTION, WHICH IS THE ONLY THING `input.auth` DOES ──────────────────────────────
 *
 * `auth === "fail"` — and no other value — sends a message to `ohmail/Screener` that would
 * otherwise have been allowed through. It is a DEMOTION in every case:
 *
 *  · A DENY rule is never weakened by it. `ohmail/Quarantine` is stricter than the Screener, so
 *    "demoting" a quarantined message to the Screener would be a promotion wearing the wrong
 *    name. Either signal of denial — the modelled `Rule.effect` or
 *    {@link effectForDestination} — is enough to keep the rule's own answer.
 *  · An unknown sender is already screened, so the branch is unreachable for them.
 *  · Nothing is ever REQUIRED. There is no `auth !== "pass"` here, and there must never be:
 *    every earlier caller states `"unauthenticated"`, so on the day this shipped it changed no
 *    routing anywhere, and the large-backlog case in {@link AuthVerdict} is why that
 *    property has to survive every later edit.
 *
 * `matchedRuleId` is `null` on the demotion even when a rule matched: that rule did not decide
 * where this message went, and recording it as though it had would teach the learning path a
 * consent signal the user never gave.
 *
 * ── AND ONE PLACEMENT REFINEMENT, WHICH IS THE ONLY THING `input.ohboxPolicy` DOES ───────────
 *
 * Under `people_only`, an automated-shaped message from an INFERRED-admission allow rule
 * (`seeded-from-sent`/`promoted`) whose destination is the Ohbox is demoted to Reads/Receipts
 * ({@link policyDemotion}). It runs AFTER the deny and auth-fail checks and only inside the
 * winning-allow branch, so it never weakens a denial and never crosses the consent gate — it moves
 * a *consented* sender's mail between allow-side piles and nothing else. A `manual`/`migrated` rule
 * is exempt (the user authored the placement), and the demotion carries `source: "policy"` with
 * `overriddenRuleId`, never `matchedRuleId`, for the learning-path reason above. Sensitivity
 * promotion sits ABOVE this in `pipeline.ts` and is untouched — an OTP from a seeded sender still
 * reaches the Ohbox.
 */
export function evaluateRules(input: EvaluateRulesInput): RuleDecision {
  const { msg, rules, knownSenders, auth, ohboxPolicy } = input;

  const author = authorAddress(msg);
  const screened: RuleDecision = { destination: "ohmail/Screener", matchedRuleId: null, source: "screener" };

  const winner = winningRule(rules, msg, author);
  if (winner) {
    const denies = winner.effect === "deny" || effectForDestination(winner.destination) === "deny";
    if (denies) return { destination: winner.destination, matchedRuleId: winner.id, source: "rule" };
    if (auth === "fail") return screened;
    const demoted = policyDemotion(msg, winner, ohboxPolicy);
    if (demoted) return demoted;
    return { destination: winner.destination, matchedRuleId: winner.id, source: "rule" };
  }

  if (!isKnownAuthor(author, knownSenders)) return screened;
  if (auth === "fail") return screened;

  const heur = headerHeuristic(msg);
  if (heur) return heur;

  return { destination: null, matchedRuleId: null, source: "unclear" };
}
