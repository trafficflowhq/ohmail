import { evaluateRules, type EvaluateRulesInput, type Rule } from "../../src/rules.js";
import type { NormalizedMessage } from "../../src/types.js";

/**
 * THE CONSENT-GATE INPUT CONTRACT, PINNED WHERE THE COMPILER CAN SEE IT.
 *
 * This file contains no test and no meaningful runtime behaviour. It is a set of assertions that
 * only exist as types, and the thing that runs them is `tsc`:
 * the package's contract tsconfig is a project that compiles this directory and nothing
 * else, the root `tsconfig.json` references it so `pnpm typecheck` builds it, and
 * the rules contract test invokes the same build so a failure arrives with a
 * test name attached.
 *
 * ── WHY A COMPILER AND NOT AN ASSERTION ────────────────────────────────────────────────────
 *
 * Two fields here are load-bearing and NEITHER can be observed at runtime:
 *
 *  · `EvaluateRulesInput.auth` is REQUIRED and the evaluator does not read it. Nothing about the
 *    return value changes if it is dropped, so no `expect` can notice; the field exists so that
 *    slice 3's real DKIM verdict has a named home at every call site, and so that no call site
 *    can be silently on the wrong side of an authentication branch. **A default would select a
 *    branch invisibly — the shape of a bug that has already shipped in this repository once**
 *    (the project's design notes, "What NOT to do").
 *  · `Rule.effect` is REQUIRED because "deny beats allow" must be a modelled property of a rule
 *    and not a `destination === "ohmail/Screened"` string test inside the evaluator. Make it
 *    optional and every hand-built `Rule` silently becomes an `allow`, which is precisely how
 *    a review finding (a broad allow beating the user's sender-specific "no") comes back.
 *
 * CLAUDE.md: **no test file anywhere is typechecked**, so a `@ts-expect-error` written in
 * `rules.test.ts` would be inert. That is what this project is for.
 */

/** Invariant type equality — distinguishes `any`, and does not accept a mere subtype. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

/** The keys of `T` that a caller cannot omit. */
type RequiredKeys<T> = { [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? never : K }[keyof T];

/**
 * ONE — the input's shape, exactly. A fifth field fails here; so does deleting one. Stated as the
 * whole key set rather than as "auth exists", because the failure mode being guarded is somebody
 * removing an unread field as dead code.
 */
export type EvaluateRulesInputKeysArePinned = Expect<
  Equal<
    keyof EvaluateRulesInput,
    "msg" | "rules" | "knownSenders" | "auth" | "ohboxPolicy" | "ownAddresses" | "identity" | "ownedUnconfirmed"
  >
>;

/**
 * TWO — `auth` is REQUIRED, not optional-with-a-default. `Partial<…>` would satisfy assertion ONE
 * and defeat the entire point, so requiredness is asserted separately.
 */
export type AuthIsRequired = Expect<
  Equal<Extract<RequiredKeys<EvaluateRulesInput>, "auth">, "auth">
>;

/**
 * TWO-BIS — and so is `ohboxPolicy`, on exactly the same discipline as `auth`: the evaluator DOES
 * read it, but a default at the call site would put a caller silently on the wrong side of the
 * `people_only` demotion. The `rule-retro`/`sensitive-rescreen` passes name it LENIENT out loud;
 * the worker resolves NULL config to the default at the OUTERMOST dep, never here.
 */
export type OhboxPolicyIsRequired = Expect<
  Equal<Extract<RequiredKeys<EvaluateRulesInput>, "ohboxPolicy">, "ohboxPolicy">
>;

/**
 * TWO-TER — and so is `ownAddresses`: an empty default would hold the account's own mail at the
 * gate without a word, and the re-deciding passes are exactly where a missing field hides.
 */
export type OwnAddressesIsRequired = Expect<
  Equal<Extract<RequiredKeys<EvaluateRulesInput>, "ownAddresses">, "ownAddresses">
>;

/**
 * TWO-QUATER — `ownedUnconfirmed` is the one OPTIONAL field, on purpose: an arrival door's fact (the
 * ingest and the gap catch-up's screen pass it), which a re-evaluation pass never computes, so its
 * absence must read as no hold there rather than be a value every walk has to invent.
 */
export type OwnedUnconfirmedIsOptional = Expect<
  Equal<Extract<RequiredKeys<EvaluateRulesInput>, "ownedUnconfirmed">, never>
>;

/** THREE — and so is `Rule.effect`. */
/** The identity fact is REQUIRED on `auth`'s discipline: a pass states `null`, never omits it. */
export type IdentityIsRequired = Expect<
  Equal<Extract<RequiredKeys<EvaluateRulesInput>, "identity">, "identity">
>;

export type RuleEffectIsRequired = Expect<
  Equal<Extract<RequiredKeys<Rule>, "effect">, "effect">
>;

/**
 * THREE-BIS — and so is `Rule.subjectContains`, the rule's second term (mail 0050).
 *
 * `null` is a value here, not an absence, and the difference is the feature. `drizzle-repo`'s
 * `listRules` is the only production producer; a `?` on the field would let a future one drop the
 * term, and the resulting rule matches the SENDER'S WHOLE MAIL while its row and the surface that
 * wrote it both say it is narrow. That failure is silent — nothing throws, the rule still files
 * mail — so it has to be caught at compile time or not at all.
 *
 * This is the file where a claim like that can be compiled: a type-level guard in an ordinary
 * `test/` directory is not compiled by anything in this repository, which is why
 * `tsconfig.contract.json` exists.
 */
export type RuleSubjectContainsIsRequired = Expect<
  Equal<Extract<RequiredKeys<Rule>, "subjectContains">, "subjectContains">
>;

/**
 * THREE-TER — and `Rule.bodyContains` (mail 0052), on THREE-BIS's argument verbatim: a producer
 * that drops the third term ships a rule matching the sender's whole mail while its row says it
 * is narrow, silently, so the field is required and this is where that requirement is compiled.
 */
export type RuleBodyContainsIsRequired = Expect<
  Equal<Extract<RequiredKeys<Rule>, "bodyContains">, "bodyContains">
>;

const MESSAGE: NormalizedMessage = {
  canonical: { messageIdHeader: null, bodyHash: "x" },
  subject: "s", from: { name: null, address: "someone@example.com" }, to: [], cc: [],
  date: null, headers: {}, textBody: "", htmlBody: null, hasAttachments: false, attachments: [],
};

const ALLOW_RULE: Rule = {
  id: "r", kind: "sender", match: "someone@example.com", destination: "INBOX",
  effect: "allow", priority: 0, provenance: "manual", enabled: true,
  // `null`, spelled out — the ordinary one-term rule. Written rather than omitted because the
  // assertion above requires the field, so this literal is the thing that would stop compiling if
  // anybody relaxed it. `bodyContains` on the same terms (mail 0052).
  subjectContains: null,
  bodyContains: null,
};

/**
 * FOUR — the call written out, without `auth`.
 *
 * Stated twice on purpose. `@ts-expect-error` is satisfied by ANY error on the next line, so on
 * its own it can be kept green by a typo; the `Equal<…, "auth">` above it cannot. If the field is
 * made optional the directive becomes "Unused '@ts-expect-error' directive" (TS2578) and
 * assertion TWO fails in the same build.
 */
// @ts-expect-error — `auth` is required: a routing decision must name the evidence it had.
export const callWithoutAuth = evaluateRules({
  msg: MESSAGE, rules: [ALLOW_RULE], knownSenders: { addresses: new Set<string>(), inferred: new Set<string>(), lists: new Map() }, ohboxPolicy: "people_and_replied", ownAddresses: new Set<string>(), identity: null,
});

/** FOUR-BIS — and the same for `ohboxPolicy`: omitting it must not compile either. */
// @ts-expect-error — `ohboxPolicy` is required: no call site may default the demotion posture.
export const callWithoutOhboxPolicy = evaluateRules({
  msg: MESSAGE, rules: [ALLOW_RULE], knownSenders: { addresses: new Set<string>(), inferred: new Set<string>(), lists: new Map() }, auth: "unauthenticated", ownAddresses: new Set<string>(), identity: null,
});

/** FOUR-TER — and for `ownAddresses`. */
// @ts-expect-error — `ownAddresses` is required: every caller names the own set it read.
export const callWithoutOwnAddresses = evaluateRules({
  msg: MESSAGE, rules: [ALLOW_RULE], knownSenders: { addresses: new Set<string>(), inferred: new Set<string>(), lists: new Map() }, auth: "unauthenticated", ohboxPolicy: "people_and_replied", identity: null,
});

/** FOUR-QUATER — and for `identity`: a pass that cannot compute the fact must say so with `null`. */
// @ts-expect-error — `identity` is required: the identity fact is an input, never a default.
export const callWithoutIdentity = evaluateRules({
  msg: MESSAGE, rules: [ALLOW_RULE], knownSenders: { addresses: new Set<string>(), inferred: new Set<string>(), lists: new Map() }, auth: "unauthenticated", ohboxPolicy: "people_and_replied", ownAddresses: new Set<string>(),
});

/**
 * FOUR-QUINQUIES — and for `knownSenders.lists` (mail 0150). The directive sits on the property:
 * a nested missing member is reported there, not at the call.
 */
export const callWithoutLists = evaluateRules({
  msg: MESSAGE, rules: [ALLOW_RULE], auth: "unauthenticated", ohboxPolicy: "people_and_replied", ownAddresses: new Set<string>(), identity: null,
  // @ts-expect-error — `lists` is required: an absent map would read every list address as a person.
  knownSenders: { addresses: new Set<string>(), inferred: new Set<string>() },
});

/** FIVE — a `Rule` without `effect` is not a `Rule`. */
// @ts-expect-error — `effect` is required: deny/allow is modelled, never inferred at use.
export const ruleWithoutEffect: Rule = {
  id: "r", kind: "sender", match: "someone@example.com", destination: "ohmail/Screened",
  priority: 0, provenance: "manual", enabled: true,
};

/**
 * SIX — the only verdict slice 1 can state. Slice 3 widens `AuthVerdict`; until it does, a call
 * inventing a verdict must not compile, because a verdict nothing computes is a claim nothing
 * backs.
 *
 * The directive sits on the `auth` property rather than above the call: `@ts-expect-error`
 * suppresses errors on the IMMEDIATELY following line only, and TS2322 for a bad property value
 * is reported at that property, not at the call.
 */
export const callWithAFutureVerdict = evaluateRules({
  msg: MESSAGE, rules: [ALLOW_RULE], knownSenders: { addresses: new Set<string>(), inferred: new Set<string>(), lists: new Map() }, ohboxPolicy: "people_and_replied", ownAddresses: new Set<string>(),
  // @ts-expect-error — `"aligned"` is slice 3's vocabulary; no DKIM check stands behind it yet.
  auth: "aligned", identity: null,
});

/**
 * SEVEN — the shape a real caller is written against still compiles. Without this the four
 * refusals above could be satisfied by a contract nothing can use.
 */
export const permittedCall = evaluateRules({
  msg: MESSAGE,
  rules: [ALLOW_RULE],
  knownSenders: { addresses: new Set(["someone@example.com"]), inferred: new Set<string>(), lists: new Map() },
  auth: "unauthenticated",
  ohboxPolicy: "people_only",
  ownAddresses: new Set(["me@example.com"]), identity: null,
});
