import { parseMessageIds } from "./threading.js";
import type { NormalizedMessage, Destination } from "./types.js";

export type RuleKind = "sender" | "domain" | "header";

/**
 * What a rule says about the consent gate — modelled, not inferred at the point of use. `deny` is
 * the user holding a sender at the gate, putting them behind it, or quarantining them; `allow`
 * lets them through. The distinction only decides a TIE between rules of equal priority ({@link
 * compareRules}), and it is a field because a broad `allow` once beat the user's sender-specific
 * "no" on nothing but array position. On the type and not a destination test in the evaluator: a
 * folder name is a routing target and intent is a separate claim. Today the two are a total
 * function of each other ({@link effectForDestination}), mapped ONCE at the adapter boundary;
 * when an `effect` column lands, the mapper is the only line that changes.
 */
export type RuleEffect = "allow" | "deny";

/**
 * The authentication evidence about the CLAIMED author. Demote-only: exactly one member changes
 * routing — `"fail"`. Absent evidence must never select the destructive branch: gating the
 * known-sender match on a positive verdict makes every row of a large backlog answer Screener —
 * so there is no `auth !== "pass"` here and there must never be one. Authentication may DEMOTE on
 * evidence against; it may never be REQUIRED before a consented identity is honoured. Members:
 * `"unauthenticated"` — the caller did not look (NULL resolves here); `"unavailable"` — looked,
 * found nothing it may believe; `"pass"` — persisted and shown, never read by routing; `"fail"` —
 * evidence AGAINST, toward the Screener only. A compile-time fixture pins the field required.
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
   * records: ADMISSION (past the gate) and PLACEMENT (which pile). `seeded-from-sent` — the
   * onboarding seed: the user wrote to this address, so admission is theirs, and `destination:
   * "INBOX"` was a bulk default WE chose — under `people_only` an automated-shaped message may be
   * demoted to Reads/Receipts; admission honoured, the inferred placement refined. `promoted` — a
   * Screener press: explicit admission, demotable placement, grouped with the seed by the ruling.
   * `manual` and `migrated` — the user AUTHORED the rule, both axes theirs, and the demotion
   * never touches them: a `manual` sender→INBOX rule is absolute.
   */
  provenance: "manual" | "migrated" | "promoted" | "seeded-from-sent";
  enabled: boolean;
  /**
   * A second term, and it is a CONJUNCTION — `null` for every rule without one: from this address
   * AND with this in the subject. It may only ever NARROW: {@link matches} reads it as an extra
   * term for EVERY kind, so no value can admit a sender the bare rule would refuse — and a
   * `domain`/`header` row carrying a term (representable, since `kind` arrives through an `as`
   * cast) is honoured rather than ignored, the fail-closed reading. `null` and `""` both mean no
   * term; the database forbids the second (mail 0050), and this still handles it — a CHECK
   * constrains rows, not values from elsewhere. REQUIRED on the type: a `?` would let a future
   * producer drop the term silently.
   */
  subjectContains: string | null;
  /**
   * A third term, same contract as {@link subjectContains} one field deeper (mail 0052). Some
   * senders write the SAME subject on every message and put the distinguishing text in the body;
   * this is the identical conjunction against the canonical plain text. Everything
   * `subjectContains` documents holds verbatim: an extra term for every kind, only narrowing,
   * applied even on kinds `RulesService` refuses to write it for, `null` and `""` both absent,
   * REQUIRED on the type. The haystack is {@link NormalizedMessage.textBody} — the byte-identical
   * string `message_bodies.text` stores, so arrival and the retro passes consult the SAME text; a
   * body not on disk reads as `""`, satisfying no term: fail-closed.
   */
  bodyContains: string | null;
}

/**
 * Everything one routing decision is allowed to see, in ONE object.
 *
 * Positional arguments were how `auth` could be added invisibly at some call sites and not
 * others; a named required field cannot be forgotten and cannot be defaulted.
 */
/**
 * How hard to keep the Ohbox relevant — the per-account posture that turns the bulk-mail demotion
 * on. About RELEVANCE, not humans-versus-machines: the Ohbox is for real people AND genuinely
 * relevant service mail; only obvious irrelevant bulk is filed out. `people_and_replied` —
 * today's behaviour and the absent-config value: an admitted sender delivers ALL their mail to
 * the Ohbox; NULL resolves here, so shipping this demotes nobody until they choose. `people_only`
 * — obvious BULK (by List-* or Feedback-ID markers) from an INFERRED-admission sender is filed
 * to its right pile; a relevant service message with no bulk markers is left in place. It never
 * touches a `manual`/`migrated` rule, never a deny, and never pulls a stranger through the gate.
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

/**
 * How recently a sender must have written to still be worth a decision, in days. A default, not a
 * constant — an account may carry its own `account_settings.dormancy_days`, and every reader
 * takes the window as an argument. Stated here, in core, because THREE independent consumers need
 * the same number and two cannot import each other: the cutline (which re-exports this), the
 * client engine's own copy (a separate package, pinned equal by `consent-cutline.pg.test.ts`),
 * and the worker. A number written out three times will eventually be three different numbers.
 */
export const DEFAULT_DORMANCY_DAYS = 60;

/**
 * Resolve a stored `screening_baseline_at` + `dormancy_days` into the instant the router treats
 * as the edge of the backlog, or `undefined` for no cutoff (mail 0056). `undefined` means the
 * gate behaves as before the baseline existed, and it is what a NULL baseline, an absent row and
 * an unparseable value all produce. The last is deliberate: an `Invalid` Date makes every
 * comparison false — the same routing as no cutoff, reached silently; answering `undefined` makes
 * the two the same thing on purpose. In core, next to {@link resolveOhboxPolicy}: the arithmetic
 * belongs on one side of the seam — `PlanDeps.screeningCutoff` takes a resolved instant so the
 * engine never repeats it.
 */
/**
 * Screening scope — `account_settings.screening_scope` (mail 0083). `'window'` is the product
 * default; `'all_time'` is a MODE and not a window value, which is why it needed a column:
 * `dormancy_days` is bounded 1-365 at the write site and NULL means the default, so no number in
 * that column spells "no cutoff". Beside {@link DEFAULT_DORMANCY_DAYS} for that constant's
 * reason: the rule has three implementations, and a mode written out three times will eventually
 * be three different modes.
 */
export type ScreeningScope = "window" | "all_time";

export function resolveScreeningCutoff(
  baselineAt: Date | null | undefined, dormancyDays: number | null | undefined,
  scope?: ScreeningScope | string | null,
): Date | undefined {
  /**
   * "All time" is no cutoff, and it is the first test for a reason (mail 0083): the person asked
   * for everything to be screened, so nothing is backlog — the mode selects the behaviour the
   * absent-baseline case already has, on purpose instead of by accident, and needs no new branch
   * downstream. ABOVE the baseline test, so `all_time` wins even for an account that HAS a
   * baseline — the other order would make the mode silently inert for every account that has ever
   * screened anything. Anything not exactly `'all_time'` reads as the window: a bad stored value
   * must fail toward the default, because screening everything is a lot of moved mail to undo by
   * hand.
   */
  if (scope === "all_time") return undefined;
  if (!(baselineAt instanceof Date)) return undefined;
  const base = baselineAt.getTime();
  if (!Number.isFinite(base)) return undefined;
  const days = typeof dormancyDays === "number" && Number.isFinite(dormancyDays) && dormancyDays > 0
    ? dormancyDays
    : DEFAULT_DORMANCY_DAYS;
  return new Date(base - days * 24 * 60 * 60 * 1000);
}

/**
 * WHAT A SCREENER HOLD ASKS OF A MESSAGE — the one predicate every writer of a hold consults.
 *
 * The router has no notion of age, so the gate's own verdict has to be subordinated to the
 * backlog cutoff before a hold is written. That test lived inline in `planChange` while there
 * was one writer; `sensitive-rescreen.ts` is a second, it re-evaluates already-filed mail into
 * the gate, and it had no cutoff at all. A cutoff enforced at one of two doors is not a cutoff.
 */
export interface ScreenerAdmission {
  /**
   * The server's own receive clock. NULL ⇒ NOT old ⇒ ADMITTED: a message whose receive time the
   * server did not vouch for is unknown, not ancient, and the safe answer for an unknown is the
   * gate. The sender's `Date:` header is never an input here: it is written by the SENDER.
   */
  arrivedAt: Date | null;
  /** The resolved backlog edge ({@link resolveScreeningCutoff}). `undefined` ⇒ no cutoff. */
  cutoff: Date | undefined;
  /** `evaluateRules`' verdict source: only the GATE's own `"screener"` is subordinated. */
  source: RuleDecision["source"];
  /** `auth === "fail"` — a statement about THIS message that an old date must never excuse. */
  authFailed: boolean;
}

/**
 * May this message be HELD at the consent gate? `false` means the caller leaves it where the
 * mailbox already has it — pre-baseline backlog is not a question anybody asked.
 */
export function screenerAdmits(input: ScreenerAdmission): boolean {
  if (input.cutoff === undefined) return true;
  if (input.source !== "screener") return true;
  if (input.authFailed) return true;
  if (input.arrivedAt === null) return true;
  return input.arrivedAt.getTime() >= input.cutoff.getTime();
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

/**
 * The total order over rules. The reported defect was "equal priorities fall back to array
 * position"; the real one is worse: `listRules` had no `ORDER BY`, so the array position was
 * PostgreSQL's PHYSICAL ROW ORDER, which moves under UPDATE and VACUUM — the same message routed
 * differently on different days with no rule change, and PGlite (stable insertion order) could
 * never show it. The order below is total: for any two rules with distinct ids it returns
 * non-zero, and it reads nothing a sender controls. `listRules` sorts in SQL too — the same
 * order, mirrored — because a total order over a nondeterministic input is correct but
 * unauditable: `psql` must be able to show the winner first.
 */

/** deny outranks allow at equal priority — the user's explicit "no" is never lost to a tie. */
const EFFECT_RANK: Readonly<Record<RuleEffect, number>> = { deny: 0, allow: 1 };
/**
 * Specificity. `sender` names one mailbox, `domain` names a set of them, and `header` names no
 * principal at all — it is a statement about a message, so it is the least specific claim
 * anybody can make about a sender and it sorts last.
 */
const KIND_RANK: Readonly<Record<RuleKind, number>> = { sender: 0, domain: 1, header: 2 };
/**
 * Specificity within one kind: a rule carrying a subject term outranks one that does not.
 * Directly BELOW `kind`, because it refines a claim about the same principal — a term-carrying
 * `domain` rule still loses to any `sender` rule. Without it, the ordinary case is a coin toss: a
 * broad rule and its narrow twin tie on everything and fall through to two random UUIDs — half
 * the accounts see the new rule work. The direction makes the pair COMPOSABLE: the narrow rule
 * takes the mail it names, the broad rule keeps the rest. `listRules` states this clause in SQL
 * in the same position, and the pg test sorts the adapter's output with {@link compareRules} and
 * requires nothing to move.
 */
const subjectRank = (r: Rule): number => (subjectTermOf(r) === null ? 1 : 0);
/**
 * The same specificity clause for the BODY term (mail 0052), ranked directly BELOW the subject
 * clause: a body-carrying rule outranks a bare one for {@link subjectRank}'s reasons — without it
 * the broad-plus-narrow pair is a UUID coin toss. The subject clause coming first is a decision,
 * not an accident: ties break the same way on every machine and in SQL, and a rule carrying BOTH
 * terms outranks either single-term rule. No claim that a subject term is semantically more
 * specific — the claim is that the two statements of this order (the SQL `ORDER BY` and this
 * comparator) must agree literally, and an order must pick a direction.
 */
const bodyRank = (r: Rule): number => (bodyTermOf(r) === null ? 1 : 0);
/**
 * What the user typed beats what we imported for them, which beats what we learned.
 * `seeded-from-sent` sorts LAST, below `promoted`, and the tie it breaks is real: a user screens
 * a sender the onboarding seed already wrote a rule for — both allow, both `sender`, both default
 * priority, so the winner would fall through to two random UUIDs, the nondeterminism this
 * comparator exists to end. The decision taken deliberately, one sender at a time, outranks the
 * one inferred in bulk. `listRules` states the same order in SQL, and the two must agree
 * literally: a value falling into the SQL `else` arm gets rank 2 there while the absent-key path
 * here ranks it last, and server and client would order the same two rules differently.
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
 * header → with a subject term over without one → with a body term over without one → manual over
 * migrated over promoted → `id`.
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

  // Below `kind` and above `provenance`: it refines a claim about the same principal, so it must
  // not reach across kinds, and it must outrank provenance — the pair this exists for is two
  // `manual` rules for one address, where provenance separates nothing.
  const subject = subjectRank(a) - subjectRank(b);
  if (subject !== 0) return subject;

  // Directly below the subject clause and above `provenance`, for the subject clause's reasons:
  // a body term refines a claim about the same principal (mail 0052). See `bodyRank` for why the
  // subject clause ranks first.
  const body = bodyRank(a) - bodyRank(b);
  if (body !== 0) return body;

  const provenance = rank(PROVENANCE_RANK, a.provenance) - rank(PROVENANCE_RANK, b.provenance);
  if (provenance !== 0) return provenance;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function domainOf(addr: string): string {
  const i = addr.indexOf("@");
  return i >= 0 ? addr.slice(i + 1) : "";
}

/**
 * The whitespace a subject term is trimmed of — deliberately NOT what `trim()` strips. Six
 * characters, because the SQL side can express exactly those: the CHECK and the `ORDER BY` both
 * read `[^ \t\n\r\f\v]`, so a term is "blank" in Postgres precisely when it is blank under this
 * class. `trim()` strips more — U+00A0, the Unicode separators — so a term of a single
 * non-breaking space would rank SPECIFIC in SQL and read ABSENT here: the narrow rule winning the
 * tie and then matching every subject, the one failure this column must be incapable of. Verified
 * equal against real Postgres over all six (`rules-subject.pg.test.ts`). Anchored at both ends: a
 * trim, not a strip — interior whitespace is part of the term.
 */
const SUBJECT_TERM_TRIM = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

/**
 * The rule's subject term, case-folded and trimmed — or `null` when it does not carry one. THE
 * one place "does this rule have a subject term?" is answered: {@link matches} and {@link
 * subjectRank} both consult it and must agree, or the narrow rule wins the tie and then declines
 * to fire — which files nothing anywhere and looks like the column is being ignored. `null`, `""`
 * and a blank string all answer `null`. The database forbids the last two, and this still handles
 * them: a CHECK constrains rows the migration reached, not a value handed in by a fixture, a
 * mirror row or an older client's echo — and a blank term read as a substring test would pass on
 * almost every subject.
 */
function subjectTermOf(r: Rule): string | null {
  const raw = r.subjectContains;
  if (typeof raw !== "string") return null;
  const term = raw.replace(SUBJECT_TERM_TRIM, "").toLowerCase();
  return term.length === 0 ? null : term;
}

/**
 * Does the message's subject satisfy the rule's subject term? `true` when there is no term — the
 * term is a CONJUNCTION and an absent conjunct is satisfied, so every rule written before mail
 * 0050 keeps its exact pre-column behaviour. Case-folded substring, and deliberately nothing
 * cleverer: no regex (a user-supplied pattern is a ReDoS on the ingest path, and nobody typing
 * `[NinjaFirewall]` means a character class), no unicode normalisation, no whitespace collapsing.
 * `subject` is `string` — `mime.ts` writes `""` for an absent header — so an absent subject
 * satisfies no term, the fail-closed direction for a narrowing conjunct.
 */
function subjectSatisfies(r: Rule, msg: NormalizedMessage): boolean {
  const term = subjectTermOf(r);
  if (term === null) return true;
  return msg.subject.toLowerCase().includes(term);
}

/**
 * The rule's BODY term, case-folded and trimmed — `subjectTermOf`'s contract applied to
 * `bodyContains` (mail 0052), and the one place "does this rule have a body term?" is answered:
 * {@link matches} and {@link bodyRank} must agree, or the narrow rule wins its tie and declines
 * to fire. The trim class is {@link SUBJECT_TERM_TRIM} — the SAME six characters, shared
 * deliberately: both columns' CHECKs state the identical class in SQL, and one definition of
 * "blank" is the point of the constraint. `null`, `""` and a blank string all answer `null` even
 * though the database forbids the last two: a CHECK constrains rows, not values a fixture hands
 * this function.
 */
function bodyTermOf(r: Rule): string | null {
  const raw = r.bodyContains;
  if (typeof raw !== "string") return null;
  const term = raw.replace(SUBJECT_TERM_TRIM, "").toLowerCase();
  return term.length === 0 ? null : term;
}

/**
 * Does the message's text satisfy the rule's body term? `true` when there is no term — an absent
 * conjunct is satisfied, so a rule with no body term keeps its behaviour. Case-folded substring over
 * {@link NormalizedMessage.textBody}, nothing cleverer: no regex (a ReDoS on the ingest path), no
 * normalisation. `textBody` is the byte-identical string `message_bodies.text` stores, so the
 * retro passes consult the same haystack; `""` satisfies no term — fail-closed. The fold
 * allocates a lowercased copy of the body per carrying rule, accepted knowingly: bodies are
 * capped upstream, accounts hold few body-carrying rules, and a shared fold cache would be a
 * place for the term and the haystack to disagree.
 */
function bodySatisfies(r: Rule, msg: NormalizedMessage): boolean {
  const term = bodyTermOf(r);
  if (term === null) return true;
  return msg.textBody.toLowerCase().includes(term);
}

/**
 * Does this rule fire on this message? `author === null` means the claimed author is absent,
 * unparseable or ambiguous, and then NO sender or domain rule may fire: matching against a
 * guessed author would let a malformed `From` inherit a decision the user made about somebody
 * else. A `header` rule still fires — it names a header, not a principal. `hasOwnProperty` rather
 * than `Boolean(msg.headers[name])`: the map comes back through `JSON.parse` and inherits from
 * `Object.prototype`, so a rule whose `match` is `constructor` matched EVERY message under the
 * old test. The subject term is checked FIRST and for every kind — an `AND` that can only make
 * this return `false` where it used to return `true`, and impossible for a new kind to forget.
 */
function matches(r: Rule, msg: NormalizedMessage, author: string | null): boolean {
  // Placed above the switch rather than inside the `sender` arm: a conjunct that lives in one arm is
  // a conjunct the next arm can be written without, and the failure that produces is a rule whose
  // stored term does nothing — indistinguishable from the column not shipping.
  if (!subjectSatisfies(r, msg)) return false;
  // The body term (mail 0052): the same conjunct one field deeper, in the same position and for
  // the same reasons. An `AND`, so it can only ever turn a `true` into a `false`.
  if (!bodySatisfies(r, msg)) return false;
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

/**
 * The author address — a POSITIVE predicate. The old gate was `if (from &&
 * !knownSenders.has(from))`: a message with no `From`, or one mailparser could not resolve,
 * leaves `msg.from.address` as the EMPTY STRING, so the guard was false on truthiness alone and
 * the function answered `unclear` — a stranger past the consent gate with no trusted address to
 * spoof and no user action. The replacement is positive: an address either passes {@link
 * isSingleUsableAddress} and is present in `contacts`, or the message is screened. No value of
 * `msg.from.address` satisfies it by being empty.
 */

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
 * Does the RAW header claim more than one author? Asked of the header because `mime.ts` keeps
 * `parsed.from.value[0]` and silently drops the rest, so `From: a@x.com, b@y.com` reaches us
 * looking exactly like `From: a@x.com`. Two `From:` LINES are the same question with a worse
 * answer: the two hops that wrote them disagree about who sent this. `undefined` (no `from` key
 * at all) is NOT ambiguity: absence of a `From` already produces an empty `msg.from.address`,
 * which {@link isSingleUsableAddress} refuses — treating an absent map ENTRY as ambiguous would
 * screen every known sender in any caller whose header map is incomplete, the one regression this
 * must not cause.
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
  return autoReplySuppression(msg.headers, msg.from.address) !== null;
}

/**
 * Why an automatic reply must not be sent to this message's author — or `null`. `machineSent`
 * under a name that says what it decides: the same three tests, one implementation — an
 * auto-reply to a list reaches every subscriber, and one to another responder is an unbounded
 * loop. A REASON, not a boolean: the caller must report which guard held — a suppression nobody
 * can attribute is indistinguishable from a pass that never ran. `list_mail` — {@link
 * isBulkSend}, any one marker, broader than RFC 3834's minimum on purpose; `auto_submitted` — the
 * loop stop (`Auto-Submitted: no` does NOT count); `service_sender` — `no-reply@` and the rest.
 * This knows nothing about a database; the suppressions that need one are the caller's.
 */
export type AutoReplySuppression = "list_mail" | "auto_submitted" | "service_sender";

export function autoReplySuppression(
  headers: Readonly<Record<string, unknown>>, fromAddress: string,
): AutoReplySuppression | null {
  if (isBulkSend(headers)) return "list_mail";
  if (headerValues(headers, "auto-submitted")?.some((v) => !/^no$/i.test(v.trim())) ?? false) {
    return "auto_submitted";
  }
  if (isServiceSender(fromAddress)) return "service_sender";
  return null;
}

/**
 * The bulk-send half of the machine-sent test — a newsletter, a list, or an ESP campaign. Every
 * header here is set by a MACHINE: `List-Unsubscribe`/`List-Unsubscribe-Post`, `List-Id` (a
 * personal message never carries it), `Feedback-ID` (the most common bulk marker on the measured
 * Ohbox mail, and the one the heuristic did not look at), `Precedence: bulk`. Read through {@link
 * headerValues}: a bare `h["list-id"]` is a truthy INHERITED value on a `JSON.parse`d map. Like
 * everything in {@link headerHeuristic}, it REFINES placement and never establishes consent —
 * reachable only past the gate, demoting only to a visible, reversible pile.
 */
function isBulkSend(headers: Readonly<Record<string, unknown>>): boolean {
  if (headerValues(headers, LIST_UNSUBSCRIBE_HEADER) !== null) return true;
  if (headerValues(headers, LIST_UNSUBSCRIBE_POST_HEADER) !== null) return true;
  if (headerValues(headers, "list-id") !== null) return true;
  if (headerValues(headers, "feedback-id") !== null) return true;
  return headerValues(headers, "precedence")?.some((v) => /bulk/i.test(v)) ?? false;
}

/**
 * The strong-bulk floor — a STRICTER conjunction than {@link isBulkSend}, for the migration
 * backfill and nothing else. `isBulkSend` fires on any one marker, correct where it refines a
 * sender already past the gate; {@link migrationBulkPlacement} reaches mail the legacy migration
 * filed under a blanket default, neither contact nor ruled — and there one marker is too weak: a
 * Google security notice carries a `Feedback-ID` and no `List-Unsubscribe`, exactly the relevant
 * alert that must stay. The floor is a CONJUNCTION: `List-Unsubscribe` REQUIRED, AND at least one
 * corroborating list/ESP marker. `Feedback-ID` alone is deliberately not enough — the count
 * landing below the raw population IS the safety margin. Do NOT loosen this to an OR.
 */
function hasStrongBulkFloor(headers: Readonly<Record<string, unknown>>): boolean {
  if (headerValues(headers, LIST_UNSUBSCRIBE_HEADER) === null) return false;
  if (headerValues(headers, "list-id") !== null) return true;
  if (headerValues(headers, LIST_UNSUBSCRIBE_POST_HEADER) !== null) return true;
  if (headerValues(headers, "feedback-id") !== null) return true;
  return headerValues(headers, "precedence")?.some((v) => /bulk/i.test(v)) ?? false;
}

/**
 * The migration backfill's placement for a strong-bulk message — Reads, or Receipts on a money
 * subject — or `null` to KEEP the message where it is. One router, not two: it composes {@link
 * headerHeuristic}'s Receipts-before-Reads ordering, gated on {@link hasStrongBulkFloor}, reusing
 * {@link isMoneySubject} — the logic lives in THIS file once, and the worker backfill must never
 * re-encode it. Not reachable from {@link evaluateRules}: the backfill's population is the one
 * the heuristic must never see, since running it before the gate is the pre-gate consent bypass.
 * A MIGRATION decision: it only demotes mail already admitted, establishes no consent, writes no
 * rule. Sensitivity is the CALLER's exclusion.
 */
export function migrationBulkPlacement(msg: NormalizedMessage): Destination | null {
  if (!hasStrongBulkFloor(msg.headers)) return null;
  return isMoneySubject(msg.subject) ? "ohmail/Receipts" : "ohmail/Reads";
}

/**
 * Is the claimed author a service mailbox rather than a person? `no-reply@`, `notifications@`,
 * `bounce@`, `postmaster@` and the auto-responder locals — punctuation stripped, the same
 * normalisation `consent-seed.ts#isRobotAddress` uses. A "machine-generated" signal, NOT a
 * "demote this" signal: it feeds only {@link machineSent}, whose sole consumer is the Receipts
 * conjunction — a `no-reply@` sender delivers relevant transactional mail as often as marketing,
 * and burying that is the failure this slice must avoid. The list stays tight — human-ambiguous
 * roles (`info@`, `support@`, `hello@`) are NOT here: a false machine verdict would file a real
 * receipt from a person who wrote one by hand.
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

/**
 * Reading headers safely — the one accessor everything below uses. `mime.ts` builds its map on
 * `Object.create(null)`, but that guarantee does not survive a database round trip:
 * `drizzle-repo.ts` rebuilds `message_bodies.headers` with `JSON.parse`, which inherits from
 * `Object.prototype`, and the unsubscribe service reads exactly that persisted map. So
 * `h["constructor"]` is a FUNCTION on a round-tripped map — a bare index would make every message
 * in the database look like it carried a `List-Unsubscribe-Post`. Every read goes through here,
 * and the type is `string[] | null` so "absent" is a value a caller has to handle rather than a
 * truthiness accident.
 */

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

/**
 * `Authentication-Results` — trusted position only, demote-only. The header is worth nothing
 * because it is present: anyone can put one in the mail they send; RFC 8601 §5 says consume only
 * what your own boundary added. `trustedAuthservIds` comes from the CALLER, empty by default — an
 * empty set answers `"unavailable"` and demotes nothing; only the FIRST header whose authserv-id
 * is in the set is read; `"fail"` only on DKIM or DMARC, never SPF, which fails on every ordinary
 * forward. Not DKIM verification: we believe our own provider's report, which is why the
 * allowlist is required. Residual: forging our provider's authserv-id on a message it adds no
 * header to is believed — under demote-only that buys nothing.
 */

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
 * Parse one `method[/version]=result [ptype.property=value]*` part. `null` for anything not that
 * shape — a trailing empty segment, a bare comment, a `none` line with no `=`. An unparseable
 * clause contributes no evidence; it never contributes a failure, because "I could not read this"
 * is not "the sender failed". RFC 8601 CFWS is normalised FIRST — comments dropped, whitespace
 * collapsed around every `=` — so a valid result written `dkim = fail` or `dkim (ok)= fail` is
 * not silently discarded.
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
 * Is a DKIM signing domain aligned with the claimed author's domain? Deliberately RELAXED, not a
 * Public-Suffix-List check: any exact match or suffix relationship counts, so it OVER-declares
 * alignment across boundaries a real PSL would separate. Consulted in both directions: promoting
 * an aligned pass to `"pass"` (never read by routing — harmless), and gating an aligned fail to
 * `"fail"`, which DOES demote — the over-declared direction could demote a message whose
 * signature merely shares a suffix. Bounded: strictly less demotion than the unconditional fail
 * it replaces; an unrelated ESP signature is correctly not-aligned; a demote routes to the
 * recoverable Screener; the path is inert until an authserv-id is trusted.
 */
function dkimAligned(signing: string, authorDomain: string): boolean {
  const d = domainPart(signing);
  const a = authorDomain;
  if (d === "" || a === "") return false;
  return d === a || a.endsWith(`.${d}`) || d.endsWith(`.${a}`);
}

/**
 * No trust decision exists for this mailbox — the state of every mailbox at an unlisted provider,
 * and the day-one state of every producer. A named symbol rather than an anonymous `new Set()`:
 * it is the ONE thing to grep for to enumerate every path currently blind ({@link
 * authVerdictFromHeaders} answers `"unavailable"` for everything when the set is empty), and an
 * empty set is a CONFIGURATION state, not a defect — the production population is
 * `providerAuthservIds`, keyed on the IMAP host, and every unlisted host resolves to THIS symbol,
 * because for a server nobody vouches for the honest trust decision is still "nobody".
 * `Set<never>` so `.add()` does not typecheck.
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

/**
 * RFC 8058 one-click unsubscribe — the header half. Four refusals: a `mailto:` unsubscribe is
 * NEVER used — acting on one sends mail on the user's behalf to a third party, which this product
 * does not do; refused in the parser, and the acting service has no mail port anyway. `https:`
 * only — RFC 8058 §3.1, and a one-click POST over `http:` puts the token on the wire in clear.
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` must be present — without it the URI is an
 * ordinary link meant for a human. Nothing is read from the BODY, structurally: this takes the
 * header map and has no body. Ambiguity is refused: two `List-Unsubscribe` lines mean two hops
 * disagree, and picking one is guessing with the user's subscription.
 */

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
 * The first `https:` unsubscribe URI a message publishes, or `null` — the link behind
 * `not_one_click`: a page the SENDER offers for a person to open in their OWN browser.
 * Deliberately NOT {@link oneClickUnsubscribeUri}, which additionally requires
 * `List-Unsubscribe-Post` and is a POST target this server acts on — never handed to the client.
 * A surface offers this as a plain outbound link when one-click is not available, so the reader
 * can still leave the list; the same {@link isOneClickUri} https-only, no-userinfo filter
 * applies, so a `mailto:` or a userinfo-bearing URL is never returned.
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
 * The deterministic header layer — Receipts, then Reads. IT REFINES PLACEMENT, NEVER ESTABLISHES
 * CONSENT: every signal is sender-chosen, and this once ran BEFORE the gate — an unknown sender
 * wrote `Precedence: bulk` and landed in `ohmail/Reads`, a remote one-message defeat of the
 * consent boundary. Never move this call above the gate. The order inside is also correctness: a
 * receipt routinely carries a `List-Unsubscribe` footer, so whichever branch is tested FIRST wins
 * — receipts second meant `ohmail/Receipts` = 0, measured; a test pins the ordering. Both signals
 * required: machine-sent alone is most of the world's mail; a money subject alone is a colleague
 * writing "invoice question". What the conjunction misses stays `unclear`.
 */
/**
 * A bounce of the reader's own mail, and the backscatter that impersonates one. A report from
 * `MAILER-DAEMON@their-host` is a first-contact sender, so the gate holds the one message that
 * says "your mail did not arrive". The obvious fix is a bypass: `report-type=delivery-status` is
 * a string anybody can type, and backscatter is real — a spammer forges YOUR address, a real MTA
 * rejects, and its genuine report satisfies every property of "shape". So the verdict is shape
 * AND own-send evidence, and this answers only the pure half: the caller matches the quoted
 * Message-IDs against its own rows (backscatter's misses) and `X-Failed-Recipients` against known
 * correspondents. Neither means the Screener, one press away.
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
  // And then the raw bytes, which is the only place the quoted headers exist. RFC 3462 puts the
  // original in a `message/rfc822-headers` (or `message/rfc822`) part, and the parser does NOT
  // flatten those into `textBody` — measured: a Gmail-shaped three-part report normalises to a
  // `textBody` holding only the human-readable paragraph, so a scan of the parsed message finds
  // nothing and the corroboration never fires — the silent-degrade version of this feature: shape
  // recognised, evidence unreachable, every real bounce held at the gate exactly as before.
  // OPTIONAL, so a caller with only the parsed form still gets the structured ids; bounded by
  // {@link DSN_BODY_SCAN_LIMIT} — these are a stranger's bytes feeding an `IN (…)` on the ingest
  // path.
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
 * The rules whose PLACEMENT the `people_only` demotion may refine — an ALLOWLIST, never
 * `provenance !== "manual"`. `provenance` reaches us through an unvalidated `as` cast off a bare
 * `text` column, so a value outside the union IS representable. A negation would make that
 * garbage DEMOTABLE — exactly the wrong direction, because the failure is a real person's rule
 * being overridden. An allowlist makes garbage EXEMPT: an unknown provenance falls through to the
 * rule's own destination, failing toward the user. `migrated` and `manual` are both absent, and
 * that absence is the whole ruling.
 */
const DEMOTABLE_PROVENANCE: ReadonlySet<Rule["provenance"]> = new Set(["seeded-from-sent", "promoted"]);

/**
 * The `people_only` placement refinement, or `null` to leave the winner's destination alone.
 * Reached ONLY inside the winning-allow branch, after the deny and `auth === "fail"` checks, so
 * it can never weaken a denial, screen a message, or run for an unadmitted sender. Five refusals:
 * the posture is `people_only`; the rule places into the Ohbox; the provenance is INFERRED
 * admission; the message is automated-shaped — {@link headerHeuristic} answers Reads/Receipts,
 * otherwise the sender is writing personally; the answer carries `source: "policy"` with
 * `overriddenRuleId`, NOT `matchedRuleId`. The heuristic only returns Reads or Receipts, so a
 * demotion is always one of those — never the Screener; a test mutates this and must go red.
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
 * The consent gate, in the only order that is correct. Four steps: (1) the user's own rules,
 * resolved by a TOTAL order — a user decision outranks anything we infer, including the gate; (2)
 * a POSITIVE authenticated-known check, not `if (from && …)`; (3) fail closed to
 * `ohmail/Screener` for an unknown, absent, unparseable or ambiguous sender; (4) THEN {@link
 * headerHeuristic}, refinement only. `"fail"` — the only thing `input.auth` does — screens a
 * message otherwise allowed: a DENY rule is never weakened, nothing is ever REQUIRED.
 * `matchedRuleId` is `null` on the demotion: recording the rule would teach the learning path a
 * false consent signal. One refinement: {@link policyDemotion}, between allow-side piles only.
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
